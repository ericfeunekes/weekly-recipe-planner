import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startPlannerRuntime } from "../server/runtime/planner-runtime.ts";
import { closeHttpServer } from "../server/http/server.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

const ALLOWED_ORIGIN = "http://localhost:3001";

function createConfig(dataDirectory, overrides = {}) {
  return {
    mode: "api",
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    databasePath: join(dataDirectory, "planner.sqlite"),
    webOrigin: new URL("http://127.0.0.1:3001"),
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    ...overrides,
  };
}

function createCodex({ available = false, authenticated = null } = {}) {
  return {
    async complete() {
      throw new Error("The deterministic runtime test must not call Codex.");
    },
    async readStatus() {
      return {
        available,
        authenticated,
        detail: available ? "available" : "unavailable",
      };
    },
  };
}

function runtimeBaseUrl(runtime) {
  const address = runtime.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("composed authority bootstraps once and survives a real process restart", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-runtime-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let sequence = 0;
  const sharedOptions = {
    config: createConfig(dataDirectory),
    codexAdapter: createCodex(),
    clock: { now: () => Date.UTC(2026, 6, 6, 12) },
    idFactory: { createId: (prefix) => `${prefix}-${++sequence}` },
    webProbe: async () => true,
  };

  const first = await startPlannerRuntime(sharedOptions);
  const firstUrl = runtimeBaseUrl(first);
  const initialHealth = await (await fetch(`${firstUrl}/api/health`)).json();
  assert.equal(initialHealth.status, "degraded");
  assert.equal(initialHealth.application.initialized, false);
  assert.equal(initialHealth.store.quickCheck, "ok");
  assert.equal(initialHealth.codex.status, "unavailable");

  const bootstrap = await fetch(`${firstUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ requestId: "bootstrap-seed", mode: "seed" }),
  });
  assert.equal(bootstrap.status, 201);
  const seeded = await bootstrap.json();
  assert.equal(seeded.imported, false);
  assert.equal(seeded.workspace.initialized, true);
  assert.equal(seeded.workspace.state.activeWeekId, "2026-07-06");
  assert.equal(
    (await (await fetch(`${firstUrl}/api/health`)).json()).application.initialized,
    true,
  );
  await first.close();

  const restarted = await startPlannerRuntime(sharedOptions);
  t.after(() => restarted.close());
  assert.equal(restarted.interruptedTurns, 0);
  const readback = await (await fetch(`${runtimeBaseUrl(restarted)}/api/workspace`)).json();
  assert.equal(readback.initialized, true);
  assert.equal(readback.state.activeWeekId, "2026-07-06");
  assert.equal(readback.plannerVersion, 0);
});

test("front-controller health fails when the internal web process is unavailable", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-front-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let codexClosed = false;
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory, {
      mode: "front",
      webOrigin: new URL("http://127.0.0.1:3002"),
    }),
    codexAdapter: createCodex({ available: true, authenticated: true }),
    closeCodex: () => {
      codexClosed = true;
    },
    webProbe: async () => false,
  });
  t.after(() => runtime.close());

  const response = await fetch(`${runtimeBaseUrl(runtime)}/api/health`);
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.status, "unavailable");
  assert.equal(health.web.status, "unavailable");
  assert.equal(health.store.status, "ready");

  await runtime.close();
  assert.equal(codexClosed, true);
});

test("API-mode health observes the development web process", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-api-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let webReady = true;
  let probedOrigin;
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory),
    codexAdapter: createCodex({ available: true, authenticated: true }),
    webProbe: async (origin) => {
      probedOrigin = origin.href;
      return webReady;
    },
  });
  t.after(() => runtime.close());
  const baseUrl = runtimeBaseUrl(runtime);

  const ready = await fetch(`${baseUrl}/api/health`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, "ready");
  assert.equal(probedOrigin, "http://127.0.0.1:3001/");
  webReady = false;
  const unavailable = await fetch(`${baseUrl}/api/health`);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).web.status, "unavailable");
  const firstClose = runtime.close();
  const repeatedClose = runtime.close();
  assert.equal(firstClose, repeatedClose);
  await firstClose;
});

test("default web readiness probe follows a real development listener", async (t) => {
  const web = createServer((_request, response) => response.end("web ready"));
  await new Promise((resolve, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeHttpServer(web));
  const webAddress = web.address();
  assert.equal(typeof webAddress, "object");
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-real-web-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory, {
      webOrigin: new URL(`http://127.0.0.1:${webAddress.port}`),
    }),
    codexAdapter: createCodex({ available: true, authenticated: true }),
  });
  t.after(() => runtime.close());
  const healthUrl = `${runtimeBaseUrl(runtime)}/api/health`;

  assert.equal((await fetch(healthUrl)).status, 200);
  await closeHttpServer(web);
  const unavailable = await fetch(healthUrl);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).web.status, "unavailable");
});

test("startup failure closes every acquired resource and preserves the primary error", async (t) => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeHttpServer(blocker));
  const address = blocker.address();
  assert.equal(typeof address, "object");
  const store = openPlannerStore({ filename: ":memory:" });
  let closeCodexCalls = 0;

  await assert.rejects(
    startPlannerRuntime({
      config: createConfig("unused", { port: address.port }),
      store,
      codexAdapter: createCodex(),
      closeCodex() {
        closeCodexCalls += 1;
        throw new Error("secondary cleanup failure");
      },
      webProbe: async () => true,
    }),
    (error) => error.code === "EADDRINUSE",
  );
  assert.equal(closeCodexCalls, 1);
  assert.throws(() => store.checkIntegrity());
});

test("household and chat planner receipts cannot collide while a model turn is running", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-chat-receipt-race-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const model = deferred();
  const codexAdapter = {
    complete: () => model.promise,
    readStatus: async () => ({
      available: true,
      authenticated: true,
      detail: "ready",
    }),
  };
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory),
    codexAdapter,
    clock: { now: () => Date.UTC(2026, 6, 6, 12) },
    idFactory: (() => {
      let sequence = 0;
      return { createId: (prefix) => `${prefix}-${++sequence}` };
    })(),
    webProbe: async () => true,
  });
  t.after(() => runtime.close());
  const baseUrl = runtimeBaseUrl(runtime);
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ requestId: "bootstrap-race", mode: "seed" }),
  });
  const seeded = await bootstrap.json();
  const week = seeded.workspace.state.weeks[0];
  const meal = week.data.meals[0];
  const step = meal.instructions[0];
  const chatResponse = fetch(`${baseUrl}/api/chat/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({
      requestId: "chat-race",
      basePlannerVersion: 0,
      message: "Complete the first step.",
      context: {
        view: "prep",
        weekId: week.id,
        mealId: meal.id,
        stepId: step.id,
      },
    }),
  });

  let runningTurn;
  for (let attempt = 0; attempt < 50 && !runningTurn; attempt += 1) {
    const workspace = await (await fetch(`${baseUrl}/api/workspace`)).json();
    runningTurn = workspace.chatTurns.find((turn) => turn.status === "running");
    if (!runningTurn) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(runningTurn);
  const collidingRequestId = `chat-command:${runningTurn.turnId}`;
  const household = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({
      requestId: collidingRequestId,
      basePlannerVersion: 0,
      command: {
        type: "setInstructionStepComplete",
        weekId: week.id,
        stepId: step.id,
        complete: false,
      },
    }),
  });
  assert.equal(household.status, 422);
  assert.equal((await household.json()).decision.status, "domain_rejected");

  model.resolve({
    reply: "The prep step is complete.",
    command: {
      type: "setInstructionStepComplete",
      weekId: week.id,
      stepId: step.id,
      complete: true,
    },
  });
  const terminal = await (await chatResponse).json();
  assert.equal(terminal.decision.turn.status, "completed");
  assert.equal(terminal.decision.turn.mutationOutcome, "applied");
  assert.equal(terminal.workspace.plannerVersion, 1);
  assert.equal(
    terminal.workspace.state.weeks[0].data.meals[0].instructions[0].complete,
    true,
  );
  const receipts = runtime.store.database
    .prepare(
      "SELECT operation_kind FROM command_receipts WHERE request_id = ? ORDER BY operation_kind",
    )
    .all(collidingRequestId)
    .map((row) => row.operation_kind);
  assert.deepEqual(receipts, ["planner_chat_command", "planner_command"]);
});
