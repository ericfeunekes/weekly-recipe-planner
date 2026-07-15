import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createRestrictedDynamicPlannerSession } from "../../server/runtime/codex-follow-up/dynamic-session.ts";
import { createRestrictedResearchSession } from "../../server/runtime/codex-follow-up/research-session.ts";
import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";
import { materializeResearchRecipeCandidate } from "../../lib/sourced-recipe-contract.ts";

const browserOrigin = "http://localhost:3001";
const fakeAppServerPath = fileURLToPath(
  new URL("../support/fixtures/codex-runtime/fake-e2e-app-server.mjs", import.meta.url),
);

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

function baseUrl(runtime) {
  const address = runtime.server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

function compatibleRuntime(environment = {}) {
  const children = new Set();
  let closed = false;
  const status = Object.freeze({
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
    cacheHit: false,
    evidence: null,
    detail: "Generated-protocol integration fixture is compatible.",
  });
  return {
    evaluate: async () => status,
    readStatus: () => status,
    async spawnAppServer({ signal } = {}) {
      if (closed) throw new Error("Fixture runtime is closed.");
      if (signal?.aborted) throw signal.reason ?? new Error("Fixture spawn aborted.");
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
      if (closed) return;
      closed = true;
      await Promise.all([...children].map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("close", resolve);
        child.kill("SIGTERM");
      })));
    },
  };
}

function unavailableRuntime(counter) {
  const status = Object.freeze({
    state: "unavailable",
    authenticated: null,
    protocolCompatible: null,
    cacheHit: false,
    evidence: null,
    detail: "Codex is deliberately unavailable.",
  });
  return {
    evaluate: async () => status,
    readStatus: () => status,
    async spawnAppServer() {
      counter.spawns += 1;
      throw new Error("Unavailable runtime must never be invoked.");
    },
    async close() {},
  };
}

async function bootstrap(url, requestId) {
  const response = await fetch(`${url}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: browserOrigin },
    body: JSON.stringify({ requestId, mode: "seed" }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function submitChat(url, body) {
  const response = await fetch(`${url}/api/chat/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: browserOrigin },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("generated-protocol fixture performs a dynamic effect without a listener", async (t) => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "planner-dynamic-protocol-"));
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const hangMarker = join(fixtureDirectory, "restart.marker");
  const execution = compatibleRuntime({ PLANNER_E2E_HANG_MARKER: hangMarker });
  t.after(() => execution.close());
  const research = await createRestrictedResearchSession(execution, process.cwd()).run({
    prompt: "Find one bounded sourced recipe for a deterministic test dinner.",
    timeoutMs: 5_000,
  });
  assert.equal(research.draft.title, "Lemon lentil soup");
  assert.equal(research.draft.yieldText, "4 bowls");
  assert.deepEqual(research.draft.source, {
    kind: "web",
    identity: "Deterministic Test Kitchen",
    url: "https://example.com/recipes/lemon-lentil-soup",
  });
  const session = createRestrictedDynamicPlannerSession(execution, process.cwd());
  const calls = [];
  const prompt = [
    "<canonical_planner_context>",
    JSON.stringify({
      view: "week",
      householdTimeZone: "America/Halifax",
      activeWeekId: "2026-07-06",
      selectedWeek: {
        id: "2026-07-06",
        data: { meals: [], leftovers: [] },
      },
      selectedMealId: null,
      selectedStepId: null,
      selectedLeftoverId: null,
    }),
    "</canonical_planner_context>",
    "<foreground_user_request>",
    JSON.stringify("Create next week"),
    "</foreground_user_request>",
  ].join("\n");
  const result = await session.run({
    mode: "normal",
    prompt,
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn(identity) {
        assert.deepEqual(identity, {
          appServerThreadId: "e2e-planner-thread",
          appServerTurnId: "e2e-planner-turn",
        });
        return true;
      },
      async dispatchPlannerTool(call) {
        calls.push(call);
        const common = {
          schemaVersion: 1,
          ok: true,
          callId: call.appServerCallId,
          plannerVersion: call.tool === "apply" ? 1 : 0,
          syncRevision: call.tool === "apply" ? 1 : 0,
          serverTime: 1,
        };
        if (call.tool === "read") {
          return {
            ...common,
            data: {
              kind: "workspace",
              activeWeekId: "2026-07-06",
              weeks: [{
                id: "2026-07-06",
                weekStartDate: "2026-07-06",
                status: "active",
              }],
            },
          };
        }
        assert.equal(call.tool, "apply");
        assert.deepEqual(call.arguments.operations, [{
          command: {
            type: "createWeekPlan",
            weekStartDate: "2026-07-13",
            plan: { meals: [], groceries: [], weekLesson: "" },
          },
        }]);
        return {
          ...common,
          data: {
            status: "accepted",
            eventId: "event-1",
            readback: {
              kind: "workspace",
              activeWeekId: "2026-07-06",
              weeks: [],
            },
          },
        };
      },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "I created a planned week for the next Monday.");
        return true;
      },
      async failTurn() {
        return false;
      },
    },
  });
  assert.equal(result.reply, "I created a planned week for the next Monday.");
  assert.deepEqual(calls.map((call) => call.tool), ["read", "apply"]);

  const candidate = materializeResearchRecipeCandidate(
    research.draft,
    { createId: () => "e2e-candidate" },
    { now: () => 1_750_000_000_000 },
  );
  const sourcedCalls = [];
  const sourced = await session.run({
    mode: "normal",
    prompt: [
      "<canonical_planner_context>",
      JSON.stringify({
        view: "tonight",
        householdTimeZone: "America/Halifax",
        activeWeekId: "2026-07-06",
        selectedWeek: {
          id: "2026-07-06",
          data: { meals: [{ id: "meal-1" }], leftovers: [] },
        },
        selectedMealId: "meal-1",
        selectedStepId: null,
        selectedLeftoverId: null,
      }),
      "</canonical_planner_context>",
      "<foreground_user_request>",
      JSON.stringify("Find and use a sourced lentil recipe for this dinner."),
      "</foreground_user_request>",
    ].join("\n"),
    researchCandidateJson: JSON.stringify(candidate),
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool(call) {
        sourcedCalls.push(call);
        const envelope = {
          schemaVersion: 1,
          ok: true,
          callId: call.appServerCallId,
          plannerVersion: call.tool === "apply" ? 2 : 1,
          syncRevision: call.tool === "apply" ? 2 : 1,
          serverTime: 2,
        };
        if (call.tool === "read") {
          return {
            ...envelope,
            data: {
              kind: "workspace",
              activeWeekId: "2026-07-06",
              weeks: [],
            },
          };
        }
        assert.equal(call.tool, "apply");
        const command = call.arguments.operations[0].command;
        assert.equal(command.type, "replaceMealRecipeFromSource");
        assert.equal(command.mealId, "meal-1");
        assert.deepEqual(command.recipe.source, candidate.source);
        assert.equal(command.recipe.yieldText, "4 bowls");
        return {
          ...envelope,
          data: {
            status: "accepted",
            eventId: "event-source",
            readback: { kind: "meal", meal: { id: "meal-1" } },
          },
        };
      },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "I replaced this dinner with a sourced recipe.");
        return true;
      },
      async failTurn() { return false; },
    },
  });
  assert.equal(sourced.reply, "I replaced this dinner with a sourced recipe.");
  assert.deepEqual(sourcedCalls.map((call) => call.tool), ["read", "apply"]);

  const recovery = await session.run({
    mode: "recovery",
    prompt: "Recover a reply from one durable planner effect.",
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool() {
        throw new Error("Recovery must not expose planner tools.");
      },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "I recovered the interrupted household request.");
        return true;
      },
      async failTurn() { return false; },
    },
  });
  assert.equal(recovery.reply, "I recovered the interrupted household request.");

  await writeFile(hangMarker, "prior-authority\n");
  const restartedNoEffect = await session.run({
    mode: "normal",
    prompt: [
      "<canonical_planner_context>",
      JSON.stringify({
        view: "week",
        householdTimeZone: "America/Halifax",
        activeWeekId: "2026-07-06",
        selectedWeek: { id: "2026-07-06", data: { meals: [], leftovers: [] } },
        selectedMealId: null,
        selectedStepId: null,
        selectedLeftoverId: null,
      }),
      "</canonical_planner_context>",
      "<foreground_user_request>",
      JSON.stringify("Wait through restart once."),
      "</foreground_user_request>",
    ].join("\n"),
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool() {
        throw new Error("A no-effect restart retry must not call planner tools.");
      },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "I recovered the interrupted household request.");
        return true;
      },
      async failTurn() { return false; },
    },
  });
  assert.equal(restartedNoEffect.reply, "I recovered the interrupted household request.");

  let fencedAfterEffect = false;
  const effectCalls = [];
  await assert.rejects(session.run({
    mode: "normal",
    prompt: [
      "<canonical_planner_context>",
      JSON.stringify({
        view: "tonight",
        householdTimeZone: "America/Halifax",
        activeWeekId: "2026-07-06",
        selectedWeek: { id: "2026-07-06", data: { meals: [], leftovers: [] } },
        selectedMealId: null,
        selectedStepId: null,
        selectedLeftoverId: null,
      }),
      "</canonical_planner_context>",
      "<foreground_user_request>",
      JSON.stringify("Save one planner change then interrupt the reply."),
      "</foreground_user_request>",
    ].join("\n"),
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool(call) {
        effectCalls.push(call);
        return {
          schemaVersion: 1,
          ok: true,
          callId: call.appServerCallId,
          plannerVersion: call.tool === "apply" ? 1 : 0,
          syncRevision: call.tool === "apply" ? 1 : 0,
          serverTime: 3,
          data: call.tool === "read"
            ? { kind: "workspace", activeWeekId: "2026-07-06", weeks: [] }
            : { status: "accepted", eventId: "effect-event", readback: { kind: "workspace", activeWeekId: "2026-07-06", weeks: [] } },
        };
      },
      async completeTurn() { return false; },
      async failTurn() {
        fencedAfterEffect = true;
        return true;
      },
    },
  }));
  assert.equal(fencedAfterEffect, true);
  assert.deepEqual(effectCalls.map((call) => call.tool), ["read", "apply"]);
});

test("real HTTP composition applies a dynamic effect and preserves it across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-dynamic-cutover-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await startPlannerRuntime({
    config: config(directory),
    codexRuntime: compatibleRuntime(),
    codexFixedCwd: process.cwd(),
    webProbe: async () => true,
  });
  let firstClosed = false;
  t.after(async () => {
    if (!firstClosed) await first.close();
  });
  const firstUrl = baseUrl(first);
  const seeded = await bootstrap(firstUrl, "cutover-bootstrap");
  const weekId = seeded.workspace.state.activeWeekId;
  assert.equal(typeof weekId, "string");

  const healthResponse = await fetch(`${firstUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "ready");
  assert.deepEqual(health.codex, {
    status: "ready",
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
  });
  assert.equal(health.application.initialized, true);
  assert.equal(health.store.quickCheck, "ok");

  const submitted = await submitChat(firstUrl, {
    requestId: "cutover-create-next-week",
    basePlannerVersion: seeded.workspace.plannerVersion,
    message: "Create next week",
    context: { view: "week", weekId },
    intent: { kind: "planner", archiveContextWeek: false },
  });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.body.decision.status, "accepted");
  assert.equal(submitted.body.decision.turn.status, "completed");
  assert.equal(submitted.body.decision.turn.acceptedEffectCount, 1);
  assert.equal(submitted.body.decision.turn.terminalOutcome, "completed_with_effects");
  assert.equal(submitted.body.decision.turn.proposedCommand, null);
  assert.equal(submitted.body.workspace.state.weeks.length, 2);
  assert.equal(
    submitted.body.workspace.transcriptEntries.at(-1).text,
    "I created a planned week for the next Monday.",
  );

  await first.close();
  firstClosed = true;
  const restarted = await startPlannerRuntime({
    config: config(directory),
    codexRuntime: compatibleRuntime(),
    codexFixedCwd: process.cwd(),
    webProbe: async () => true,
  });
  t.after(() => restarted.close());
  assert.equal(restarted.interruptedTurns, 0);
  const readbackResponse = await fetch(`${baseUrl(restarted)}/api/workspace`);
  assert.equal(readbackResponse.status, 200);
  const readback = await readbackResponse.json();
  assert.equal(readback.state.weeks.length, 2);
  assert.equal(readback.chatTurns.at(-1).acceptedEffectCount, 1);
  assert.equal(readback.chatTurns.at(-1).terminalOutcome, "completed_with_effects");
  assert.equal(
    readback.transcriptEntries.filter((entry) =>
      entry.text === "I created a planned week for the next Monday."
    ).length,
    1,
  );
});

test("unavailable managed runtime returns a stored denial without spawning or falling back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-dynamic-unavailable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const counter = { spawns: 0 };
  const runtime = await startPlannerRuntime({
    config: config(directory),
    codexRuntime: unavailableRuntime(counter),
    codexFixedCwd: process.cwd(),
    webProbe: async () => true,
  });
  t.after(() => runtime.close());
  const url = baseUrl(runtime);
  const seeded = await bootstrap(url, "unavailable-bootstrap");
  const denied = await submitChat(url, {
    requestId: "unavailable-chat",
    basePlannerVersion: seeded.workspace.plannerVersion,
    message: "Create next week",
    context: { view: "week", weekId: seeded.workspace.state.activeWeekId },
    intent: { kind: "planner", archiveContextWeek: false },
  });
  assert.equal(denied.status, 503);
  assert.deepEqual(denied.body.decision, {
    status: "codex_unavailable",
    message: "Embedded Codex is unavailable.",
  });
  assert.equal(counter.spawns, 0);
  assert.equal(denied.body.workspace.transcriptEntries.length, 0);
  assert.equal(denied.body.workspace.chatTurns.length, 0);
  assert.equal(denied.body.workspace.plannerVersion, seeded.workspace.plannerVersion);

  const replayed = await submitChat(url, {
    requestId: "unavailable-chat",
    basePlannerVersion: seeded.workspace.plannerVersion,
    message: "Create next week",
    context: { view: "week", weekId: seeded.workspace.state.activeWeekId },
    intent: { kind: "planner", archiveContextWeek: false },
  });
  assert.equal(replayed.status, 503);
  assert.deepEqual(replayed.body.decision, denied.body.decision);
  assert.equal(counter.spawns, 0);
});
