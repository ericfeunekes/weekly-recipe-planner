import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { request as playwrightRequest } from "@playwright/test";

import {
  GLOBAL_CODEX_CONTRACT_VERSION,
  GLOBAL_CODEX_ROUTES,
} from "../../lib/global-codex-contract.ts";
import {
  createGlobalCodexIngressForTests,
  createGlobalCodexPlannerPort,
  createGlobalCodexRouter,
} from "../../server/global-ingress/index.ts";
import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";

const browserOrigin = "http://localhost:3001";

function seedState() {
  return {
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
          title: "Race dinner",
          subtitle: "",
          venue: "Home",
          status: "planned",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "",
          ingredients: [],
          instructions: [],
        }],
        prepSessions: [],
        groceries: [],
        leftovers: [],
        feedback: {},
        weekLesson: "Initial lesson",
      },
    }],
  };
}

function lessonCommand(weekLesson) {
  return {
    type: "captureWeekLesson",
    weekId: "2026-07-06",
    weekLesson,
  };
}

function config(directory) {
  return {
    mode: "api",
    host: "127.0.0.1",
    port: 0,
    dataDirectory: directory,
    databasePath: join(directory, "planner.sqlite"),
    webOrigin: new URL(browserOrigin),
    allowedOrigins: new Set([browserOrigin]),
  };
}

function runtimeBaseUrl(runtime) {
  const address = runtime.server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

function unavailableRuntime() {
  const status = Object.freeze({
    state: "unavailable",
    authenticated: null,
    protocolCompatible: null,
    cacheHit: false,
    evidence: null,
    detail: "Codex is deliberately unavailable in this planner-ingress race.",
  });
  return {
    evaluate: async () => status,
    readStatus: () => status,
    async spawnAppServer() {
      throw new Error("The planner-ingress race must not spawn Codex.");
    },
    async close() {},
  };
}

function requestSocket(socketPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = requestHttp({
      socketPath,
      method: "POST",
      path: GLOBAL_CODEX_ROUTES.batches,
      headers: {
        Host: "localhost",
        Connection: "close",
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.once("error", reject);
    request.end(payload);
  });
}

test("two browser contexts and Global UDS contend through real ingress boundaries", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "planner-multi-ingress-race-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const globalParent = join(directory, "global-home", "meal-planner");
  await mkdir(globalParent, { recursive: true, mode: 0o700 });
  let id = 0;
  let now = 1_800_000_000_000;
  const runtime = await startPlannerRuntime({
    config: config(directory),
    codexRuntime: unavailableRuntime(),
    codexFixedCwd: process.cwd(),
    clock: { now: () => now++ },
    idFactory: { createId: (prefix) => `${prefix}-${++id}` },
    seedFactory: seedState,
    webProbe: async () => true,
    globalCodexIngressFactory: async (planner) => createGlobalCodexIngressForTests(
      createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
      globalParent,
    ),
  });
  t.after(() => runtime.close());
  const baseUrl = runtimeBaseUrl(runtime);
  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: browserOrigin },
    body: JSON.stringify({ requestId: "bootstrap-multi-ingress", mode: "seed" }),
  });
  assert.equal(bootstrapResponse.status, 201);
  const seeded = await bootstrapResponse.json();
  const basePlannerVersion = seeded.workspace.plannerVersion;

  const browserA = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { Origin: browserOrigin },
  });
  const browserB = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { Origin: browserOrigin },
  });
  t.after(async () => Promise.all([browserA.dispose(), browserB.dispose()]));

  const globalSocketPath = join(globalParent, "run", "global-codex.sock");
  const [browserAResult, browserBResult, globalResult] = await Promise.all([
    browserA.post("/api/commands", { data: {
      requestId: "browser-a",
      basePlannerVersion,
      command: lessonCommand("Browser A"),
    } }),
    browserB.post("/api/commands", { data: {
      requestId: "browser-b",
      basePlannerVersion,
      command: lessonCommand("Browser B"),
    } }),
    requestSocket(globalSocketPath, {
      contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
      requestId: "d7781402-6bed-47ce-ab52-f54916e3e56c",
      basePlannerVersion,
      operations: [{ command: lessonCommand("Global Codex") }],
    }),
  ]);
  const browserBodies = await Promise.all([browserAResult.json(), browserBResult.json()]);

  const directDecisions = [
    browserBodies[0].decision,
    browserBodies[1].decision,
    globalResult.body.decision,
  ];
  assert.equal(directDecisions.filter((decision) => decision.status === "accepted").length, 1);
  assert.equal(directDecisions.filter((decision) => decision.status === "version_conflict").length, 2);

  const workspaceResponse = await browserA.get("/api/workspace");
  assert.equal(workspaceResponse.status(), 200);
  const workspace = await workspaceResponse.json();
  assert.equal(workspace.plannerVersion, basePlannerVersion + 1);
  assert.equal(workspace.events.length, 1);
  assert.ok(["Browser A", "Browser B", "Global Codex"].includes(
    workspace.state.weeks[0].data.weekLesson,
  ));
  assert.ok([
    "household:browser:same_origin_http_v1",
    "codex:global:same_uid_uds_v1",
  ].includes([
    workspace.events[0].provenance.actorClass,
    workspace.events[0].provenance.actorSource,
    workspace.events[0].provenance.admission,
  ].join(":")));
});
