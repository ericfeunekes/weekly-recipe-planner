import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const fakeAppServerPath = fileURLToPath(
  new URL("../support/fixtures/codex-runtime/fake-e2e-app-server.mjs", import.meta.url),
);

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
        prep: [],
        groceries: [],
        leftovers: [],
        farmBoxReconciled: false,
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

function compatibleRuntime(environment) {
  const children = new Set();
  const status = Object.freeze({
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
    cacheHit: false,
    evidence: null,
    detail: "Multi-ingress generated-protocol fixture is compatible.",
  });
  return {
    evaluate: async () => status,
    readStatus: () => status,
    async spawnAppServer({ signal } = {}) {
      const child = spawn(process.execPath, [fakeAppServerPath], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, ...environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const onAbort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
        children.delete(child);
      });
      return child;
    },
    async close() {
      await Promise.all([...children].map((child) => new Promise((resolveClose) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveClose();
          return;
        }
        child.once("close", resolveClose);
        child.kill("SIGTERM");
      })));
    },
  };
}

async function waitForPath(path, timeoutMs = 5_000) {
  const { access } = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`Timed out waiting for embedded ingress marker ${path}.`);
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

test("two browser contexts, embedded Codex, and Global UDS contend through real ingress boundaries", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "planner-multi-ingress-race-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const globalParent = join(directory, "global-home", "meal-planner");
  await mkdir(globalParent, { recursive: true, mode: 0o700 });
  const embeddedStarted = join(directory, "embedded-started");
  const embeddedRelease = join(directory, "embedded-release");
  let id = 0;
  let now = 1_800_000_000_000;
  const runtime = await startPlannerRuntime({
    config: config(directory),
    codexRuntime: compatibleRuntime({
      PLANNER_E2E_CONFLICT_STARTED_MARKER: embeddedStarted,
      PLANNER_E2E_CONFLICT_RELEASE_MARKER: embeddedRelease,
    }),
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

  const embeddedRequest = fetch(`${baseUrl}/api/chat/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: browserOrigin },
    body: JSON.stringify({
      requestId: "embedded-multi-ingress",
      basePlannerVersion,
      message: "Propose conflicting meal change after a pause.",
      context: { view: "week", weekId: "2026-07-06", mealId: "meal-1" },
      intent: { kind: "planner", archiveContextWeek: false },
    }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  await waitForPath(embeddedStarted);

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
  await writeFile(embeddedRelease, "release\n", { flag: "wx" });
  const embedded = await embeddedRequest;
  const browserBodies = await Promise.all([browserAResult.json(), browserBResult.json()]);

  const directDecisions = [
    browserBodies[0].decision,
    browserBodies[1].decision,
    globalResult.body.decision,
  ];
  assert.equal(directDecisions.filter((decision) => decision.status === "accepted").length, 1);
  assert.equal(directDecisions.filter((decision) => decision.status === "version_conflict").length, 2);
  assert.equal(embedded.status, 202);
  assert.equal(embedded.body.decision.status, "accepted");
  assert.equal(embedded.body.decision.turn.status, "completed");
  assert.equal(embedded.body.decision.turn.acceptedEffectCount, 0);
  assert.match(embedded.body.decision.turn.replyEntryId, /^transcript-/);
  assert.match(embedded.body.workspace.transcriptEntries.at(-1).text, /shared plan changed first/i);

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
