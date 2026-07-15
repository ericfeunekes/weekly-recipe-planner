import assert from "node:assert/strict";
import { createServer, request as requestHttp } from "node:http";
import test from "node:test";

import { householdDomain } from "../lib/household-domain.ts";
import {
  DIAGNOSTIC_EXPORT_FILENAME,
  DIAGNOSTIC_EXPORT_FORMAT_VERSION,
  DIAGNOSTIC_EXPORT_KIND,
  DIAGNOSTIC_EXPORT_WARNING,
} from "../lib/planner-api-contract.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { createApplicationRouter } from "../server/http/application-router.ts";
import { createFrontController } from "../server/http/front-controller.ts";
import {
  closeHttpServer,
  listenHttpServer,
} from "../server/http/server.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

const WORKSPACE = {
  initialized: true,
  schemaVersion: 2,
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
      kind: DIAGNOSTIC_EXPORT_KIND,
      formatVersion: DIAGNOSTIC_EXPORT_FORMAT_VERSION,
      restorable: false,
      warning: DIAGNOSTIC_EXPORT_WARNING,
      schemaVersion: 2,
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
    async retry(request) {
      calls.push(["chat-retry", request]);
      return {
        decision: {
          status: "domain_rejected",
          message: "Only failed or interrupted chat turns can be retried.",
        },
        workspace: WORKSPACE,
      };
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
        codex: {
          status: "unavailable",
          state: "unavailable",
          authenticated: null,
          protocolCompatible: null,
        },
        globalCodex: {
          status: "unavailable",
          reason: "Global Codex ingress is not configured.",
        },
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

async function startRealSourcedApplication(t) {
  const store = openPlannerStore({ filename: ":memory:" });
  t.after(() => store.close());
  let id = 0;
  let now = 1_800_000_000_000;
  const seed = {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-07-06",
    weeks: [{
      id: "2026-07-06",
      weekStartDate: "2026-07-06",
      status: "active",
      data: {
        meals: [{
          id: "meal-1",
          date: "2026-07-07",
          slot: "dinner",
          title: "Placeholder",
          subtitle: "Keep subtitle",
          venue: "Home",
          status: "planned",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "Keep note",
          ingredients: [],
          instructions: [],
        }],
        prep: [], groceries: [], leftovers: [], farmBoxReconciled: false,
        feedback: {}, weekLesson: "",
      },
    }],
  };
  const planner = createPlannerApplicationService({
    store,
    domain: householdDomain,
    seedFactory: () => structuredClone(seed),
    transformLegacyV2: () => ({ state: structuredClone(seed), transcriptEntries: [], discardedEventCount: 0 }),
    clock: { now: () => now++ },
    idFactory: { createId: (prefix) => `${prefix}-${++id}` },
  });
  planner.bootstrap({ requestId: "bootstrap-source-http", mode: "seed" });
  const handler = createApplicationRouter({
    planner,
    chat: {
      submit: async () => { throw new Error("chat outside sourced ingress proof"); },
      retry: async () => { throw new Error("chat outside sourced ingress proof"); },
      interruptRunningTurns: () => 0,
    },
    readHealth: () => ({
      status: "ready",
      web: { status: "ready" },
      application: { status: "ready", initialized: true },
      store: { status: "ready", quickCheck: "ok" },
      codex: {
        status: "unavailable",
        state: "unavailable",
        authenticated: null,
        protocolCompatible: null,
      },
      globalCodex: { status: "unavailable", reason: "not configured" },
    }),
  }, {
    allowedOrigins: new Set(["http://localhost:3001"]),
    allowOriginlessMutations: false,
  });
  const server = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, planner, store };
}

function sourcedHttpCommand() {
  return {
    type: "replaceMealRecipeFromSource",
    weekId: "2026-07-06",
    mealId: "meal-1",
    recipe: {
      title: "HTTP lentil soup",
      yieldText: "4 bowls",
      source: {
        kind: "web",
        identity: "Example Kitchen",
        url: "https://example.com/recipes/lentil-soup",
        retrievedAt: 1_750_000_000_000,
      },
      steps: [{
        inputs: [{ amount: "1 cup", ingredient: "lentils" }],
        instruction: "Simmer until tender.",
      }],
    },
  };
}

function rawHttpRequest(options, body = "") {
  return new Promise((resolve, reject) => {
    const request = requestHttp(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
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

test("diagnostic export is explicitly non-restorable and bootstrap rejects it without a call", async (t) => {
  const { baseUrl, calls } = await startApplication(t);
  const response = await fetch(`${baseUrl}/api/export`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    `attachment; filename="${DIAGNOSTIC_EXPORT_FILENAME}"`,
  );
  assert.equal(response.headers.get("x-meal-planner-export-kind"), DIAGNOSTIC_EXPORT_KIND);
  assert.equal(
    response.headers.get("x-meal-planner-export-version"),
    String(DIAGNOSTIC_EXPORT_FORMAT_VERSION),
  );
  assert.equal(response.headers.get("x-meal-planner-export-restorable"), "false");
  const diagnostic = await response.json();
  assert.equal(diagnostic.kind, DIAGNOSTIC_EXPORT_KIND);
  assert.equal(diagnostic.formatVersion, DIAGNOSTIC_EXPORT_FORMAT_VERSION);
  assert.equal(diagnostic.restorable, false);
  assert.equal(diagnostic.warning, DIAGNOSTIC_EXPORT_WARNING);

  const rejected = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
    body: JSON.stringify(diagnostic),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    error: { code: "INVALID_REQUEST", message: DIAGNOSTIC_EXPORT_WARNING },
  });
  assert.deepEqual(calls, []);
});

test("large diagnostic exports remain downloadable but cannot cross the bootstrap body limit", async (t) => {
  const { dependencies, calls } = createDependencies();
  const baseExport = dependencies.planner.exportWorkspace();
  dependencies.planner.exportWorkspace = () => ({
    ...baseExport,
    events: Array.from({ length: 2_200 }, (_, index) => ({
      sequence: index + 1,
      eventId: `event-${index}`,
      summary: "diagnostic event".padEnd(160, "x"),
    })),
  });
  const handler = createApplicationRouter(dependencies, {
    allowedOrigins: new Set(["http://localhost:3001"]),
    allowOriginlessMutations: false,
  });
  const server = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/export`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(Buffer.byteLength(body) > 256 * 1024);
  assert.equal(JSON.parse(body).restorable, false);

  const rejected = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
    body,
  });
  assert.equal(rejected.status, 413);
  assert.match((await rejected.json()).error.message, /too large/i);
  assert.deepEqual(calls, []);
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

test("household HTTP sourced replacement reaches shared reducer without embedded admission", async (t) => {
  const { baseUrl, store } = await startRealSourcedApplication(t);
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:3001" };
  const request = {
    requestId: "source-http-1",
    basePlannerVersion: 0,
    command: sourcedHttpCommand(),
  };
  const accepted = await fetch(`${baseUrl}/api/commands`, {
    method: "POST", headers, body: JSON.stringify(request),
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.decision.status, "accepted");
  const meal = acceptedBody.workspace.state.weeks[0].data.meals[0];
  assert.equal(meal.title, "HTTP lentil soup");
  assert.equal(meal.subtitle, "Keep subtitle");
  assert.deepEqual(meal.sourceRecipe, sourcedHttpCommand().recipe.source);
  assert.deepEqual(meal.ingredients, ["1 cup lentils"]);

  const replay = await fetch(`${baseUrl}/api/commands`, {
    method: "POST", headers, body: JSON.stringify(request),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).decision, acceptedBody.decision);
  const changed = structuredClone(request);
  changed.command.recipe.title = "Changed reuse";
  assert.equal((await fetch(`${baseUrl}/api/commands`, {
    method: "POST", headers, body: JSON.stringify(changed),
  })).status, 409);
  const stale = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, requestId: "source-http-stale" }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).decision.status, "version_conflict");
  const forbidden = structuredClone(request);
  forbidden.requestId = "source-http-forbidden";
  forbidden.basePlannerVersion = 1;
  forbidden.command.recipe.candidateId = "forbidden";
  assert.equal((await fetch(`${baseUrl}/api/commands`, {
    method: "POST", headers, body: JSON.stringify(forbidden),
  })).status, 400);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'planner_command'",
  ).get().count, 2);
});

test("IPv6 loopback browser origins can mutate through the configured authority", async (t) => {
  const { dependencies, calls } = createDependencies();
  const handler = createApplicationRouter(dependencies, {
    allowedOrigins: new Set(["http://[::1]:3001"]),
    allowOriginlessMutations: false,
  });
  const server = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  assert.equal(typeof address, "object");
  const body = JSON.stringify({
    requestId: "ipv6-request",
    basePlannerVersion: 2,
    command: {
      type: "captureWeekLesson",
      weekId: "2026-07-06",
      weekLesson: "Keep prep short.",
    },
  });
  const response = await rawHttpRequest({
    hostname: "127.0.0.1",
    port: address.port,
    path: "/api/commands",
    method: "POST",
    headers: {
      Host: "[::1]:3001",
      Origin: "http://[::1]:3001",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).decision.status, "accepted");
  assert.equal(calls.length, 1);
});

test("an explicitly configured Tailnet HTTPS host and origin can mutate", async (t) => {
  const tailnetOrigin = "https://robie-imac.tailae8a7b.ts.net:8642";
  const { dependencies, calls } = createDependencies();
  const handler = createApplicationRouter(dependencies, {
    allowedOrigins: new Set([tailnetOrigin]),
    allowOriginlessMutations: false,
  });
  const server = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  assert.equal(typeof address, "object");
  const body = JSON.stringify({
    requestId: "tailnet-request",
    basePlannerVersion: 2,
    command: {
      type: "captureWeekLesson",
      weekId: "2026-07-06",
      weekLesson: "Prep sauces separately.",
    },
  });
  const response = await rawHttpRequest({
    hostname: "127.0.0.1",
    port: address.port,
    path: "/api/commands",
    method: "POST",
    headers: {
      Host: "robie-imac.tailae8a7b.ts.net:8642",
      Origin: tailnetOrigin,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).decision.status, "accepted");
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
      intent: { kind: "planner", archiveContextWeek: false },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).decision.turn.status, "running");
  assert.equal(calls[0][0], "chat");
  assert.deepEqual(calls[0][1].intent, {
    kind: "planner",
    archiveContextWeek: false,
  });
});

test("chat submit rejects missing, mixed, extra, and unknown intent without calling chat", async (t) => {
  const { baseUrl, calls } = await startApplication(t);
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:3001" };
  const base = {
    requestId: "chat-intent-invalid",
    basePlannerVersion: 2,
    message: "Plan dinner.",
    context: { view: "week", weekId: "2026-07-06" },
  };
  for (const [label, body] of [
    ["missing", base],
    ["mixed", { ...base, intent: { kind: "sourced_recipe", archiveContextWeek: false } }],
    ["extra", { ...base, intent: { kind: "planner", archiveContextWeek: false, target: "week-x" } }],
    ["unknown", { ...base, intent: { kind: "other" } }],
    ["raw grant", {
      ...base,
      intent: { kind: "planner", archiveContextWeek: false },
      foregroundAuthority: [{ commandType: "archiveWeek", target: "week-x" }],
    }],
  ]) {
    const response = await fetch(`${baseUrl}/api/chat/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, label);
  }
  assert.deepEqual(calls, []);
});

test("undo and chat lifecycle rejections preserve their durable conflict status", async (t) => {
  const { baseUrl, calls } = await startApplication(t);
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:3001" };
  const undo = await fetch(`${baseUrl}/api/undo`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: "undo-ineligible",
      basePlannerVersion: 2,
      targetEventId: "event-older",
    }),
  });
  assert.equal(undo.status, 409);
  assert.equal((await undo.json()).decision.status, "domain_rejected");

  const retry = await fetch(`${baseUrl}/api/chat/retry`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: "retry-ineligible",
      basePlannerVersion: 2,
      turnId: "turn-completed",
    }),
  });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).decision.status, "domain_rejected");
  assert.deepEqual(calls.map(([kind]) => kind), ["undo", "chat-retry"]);
});

test("service failures retain field errors and authoritative workspace readback", async (t) => {
  const { dependencies } = createDependencies();
  dependencies.planner.bootstrap = () => {
    throw Object.assign(new Error("Legacy prep date is invalid."), {
      code: "INVALID_REQUEST",
      httpStatus: 422,
      fieldErrors: { "data.prep[0].due": "Use a known v2 prep date." },
      workspace: { initialized: false, schemaVersion: 2 },
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
    workspace: { initialized: false, schemaVersion: 2 },
  });
});

test("front controller keeps API local and proxies the web surface", async (t) => {
  let upstreamRequestHeaders;
  const upstream = createServer((request, response) => {
    upstreamRequestHeaders = request.headers;
    response.writeHead(200, {
      "Content-Type": "text/plain",
      Connection: "x-upstream-hop",
      "X-Upstream-Hop": "must-not-forward",
    });
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

  const web = await rawHttpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/",
      headers: {
        Connection: "x-client-hop",
        "X-Client-Hop": "must-not-forward",
      },
    });
  assert.equal(web.text, "web surface");
  assert.equal(upstreamRequestHeaders["x-client-hop"], undefined);
  assert.equal(web.headers["x-upstream-hop"], undefined);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), {
    surface: "api",
  });
});
