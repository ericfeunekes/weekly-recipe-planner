import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApplicationRouter } from "../server/http/application-router.ts";
import { createFrontController } from "../server/http/front-controller.ts";
import {
  closeHttpServer,
  listenHttpServer,
} from "../server/http/server.ts";

const WORKSPACE = {
  initialized: true,
  schemaVersion: 1,
  plannerVersion: 2,
  syncRevision: 3,
  state: {
    householdTimeZone: "America/Halifax",
    activeWeekId: null,
    weeks: [],
  },
  events: [],
  transcriptEntries: [],
  chatTurns: [],
};

function createDependencies() {
  const calls = [];
  const planner = {
    readWorkspace: () => WORKSPACE,
    readEventPage: (request) => ({
      order: "newest_first",
      items: [],
      nextBeforeSequence: null,
      request,
    }),
    readTranscriptPage: () => ({
      order: "newest_first",
      items: [],
      nextBeforeSequence: null,
    }),
    applyCommand(request) {
      calls.push(["command", request]);
      return {
        decision: { status: "accepted", eventId: "event-1", plannerVersion: 3 },
        workspace: { ...WORKSPACE, plannerVersion: 3, syncRevision: 4 },
      };
    },
    undoLatest(request) {
      calls.push(["undo", request]);
      return {
        decision: { status: "domain_rejected", message: "Nothing to undo." },
        workspace: WORKSPACE,
      };
    },
    bootstrap(request) {
      calls.push(["bootstrap", request]);
      return { workspace: WORKSPACE, imported: request.mode === "import-v2" };
    },
    exportWorkspace: () => ({
      schemaVersion: 1,
      exportedAt: 1,
      plannerVersion: 2,
      syncRevision: 3,
      state: WORKSPACE.state,
      events: [],
      transcriptEntries: [],
      chatTurns: [],
    }),
  };
  const chat = {
    async submit(request) {
      calls.push(["chat", request]);
      return {
        decision: {
          status: "accepted",
          turn: {
            turnId: "turn-1",
            requestId: request.requestId,
            turnSequence: 1,
            status: "running",
            userEntryId: "entry-1",
            context: request.context,
            inputPlannerVersion: request.basePlannerVersion,
            replyEntryId: null,
            proposedCommand: null,
            mutationOutcome: null,
            retryOfTurnId: null,
            errorCode: null,
            errorDetail: null,
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
          },
        },
        workspace: { ...WORKSPACE, syncRevision: 4 },
      };
    },
    async retry() {
      throw new Error("not used");
    },
    interruptRunningTurns: () => 0,
  };
  return {
    dependencies: {
      planner,
      chat,
      readHealth: () => ({
        status: "degraded",
        web: { status: "ready" },
        application: { status: "ready", initialized: true },
        store: { status: "ready", quickCheck: "ok" },
        codex: { status: "unavailable", authenticated: null },
      }),
    },
    calls,
  };
}

async function startApplication(t) {
  const { dependencies, calls } = createDependencies();
  const handler = createApplicationRouter(dependencies, {
    allowedOrigins: new Set(["http://localhost:3001"]),
    allowOriginlessMutations: false,
  });
  const server = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls };
}

test("workspace reads use a complete sync-revision ETag and pages normalize cursors", async (t) => {
  const { baseUrl } = await startApplication(t);
  const workspace = await fetch(`${baseUrl}/api/workspace`);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.headers.get("etag"), '"workspace-3"');
  assert.deepEqual(await workspace.json(), WORKSPACE);

  const unchanged = await fetch(`${baseUrl}/api/workspace`, {
    headers: { "If-None-Match": '"workspace-3"' },
  });
  assert.equal(unchanged.status, 304);

  const page = await fetch(`${baseUrl}/api/history?beforeSequence=40`);
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), {
    order: "newest_first",
    items: [],
    nextBeforeSequence: null,
    request: { beforeSequence: 40, limit: 50 },
  });
  assert.equal((await fetch(`${baseUrl}/api/history?limit=101`)).status, 400);
});

test("mutations reject foreign origins and accept only typed command envelopes", async (t) => {
  const { baseUrl, calls } = await startApplication(t);
  const body = JSON.stringify({
    requestId: "request-1",
    basePlannerVersion: 2,
    command: {
      type: "captureWeekLesson",
      weekId: "2026-07-06",
      weekLesson: "Prep sauces separately.",
    },
  });
  const foreign = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.com" },
    body,
  });
  assert.equal(foreign.status, 403);

  const accepted = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
    body,
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).decision.status, "accepted");
  assert.equal(calls.length, 1);

  const spoofed = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
    body: JSON.stringify({ ...JSON.parse(body), actor: "Codex" }),
  });
  assert.equal(spoofed.status, 400);
  assert.equal(calls.length, 1);
});

test("chat accepts structured canonical context and returns its durable running turn", async (t) => {
  const { baseUrl, calls } = await startApplication(t);
  const response = await fetch(`${baseUrl}/api/chat/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
    body: JSON.stringify({
      requestId: "chat-request-1",
      basePlannerVersion: 2,
      message: "What can I prep now?",
      context: { view: "prep", weekId: "2026-07-06" },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).decision.turn.status, "running");
  assert.equal(calls[0][0], "chat");
});

test("service failures retain field errors and authoritative workspace readback", async (t) => {
  const { dependencies } = createDependencies();
  dependencies.planner.bootstrap = () => {
    throw Object.assign(new Error("Legacy prep date is invalid."), {
      code: "INVALID_REQUEST",
      httpStatus: 422,
      fieldErrors: { "data.prep[0].due": "Use a known v2 prep date." },
      workspace: { initialized: false, schemaVersion: 1 },
    });
  };
  const handler = createApplicationRouter(dependencies, {
    allowedOrigins: new Set(["http://localhost:3001"]),
    allowOriginlessMutations: false,
  });
  const server = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
    body: JSON.stringify({
      requestId: "bootstrap-invalid",
      mode: "import-v2",
      payload: { data: {}, events: [], chatMessages: [] },
    }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INVALID_REQUEST",
      message: "Legacy prep date is invalid.",
      fieldErrors: { "data.prep[0].due": "Use a known v2 prep date." },
    },
    workspace: { initialized: false, schemaVersion: 1 },
  });
});

test("front controller keeps API local and proxies the web surface", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("web surface");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeHttpServer(upstream));
  const upstreamAddress = upstream.address();

  const controller = createFrontController({
    apiHandler: (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"surface":"api"}');
    },
    webOrigin: new URL(`http://127.0.0.1:${upstreamAddress.port}`),
  });
  const server = await listenHttpServer({ handler: controller, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal(await (await fetch(`${baseUrl}/`)).text(), "web surface");
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), {
    surface: "api",
  });
});
