import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv from "ajv";

import {
  DYNAMIC_TERMINAL_EVENTS,
  DYNAMIC_TERMINAL_STATES,
  EMBEDDED_PLANNER_INSTRUCTIONS,
  NORMAL_MODEL_VISIBLE_TOOLS,
  RECOVERY_MODEL_VISIBLE_TOOLS,
  DynamicPlannerSessionError,
  createRestrictedDynamicPlannerSession,
  decideDynamicTerminalTransition,
} from "../server/runtime/codex-follow-up/dynamic-session.ts";
import {
  materializeResearchRecipeCandidate,
} from "../lib/sourced-recipe-contract.ts";
import { createCodexSchemaDocuments } from "./support/fixtures/codex-runtime/schema-fixtures.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fakeAppServer = join(
  testDirectory,
  "support",
  "fixtures",
  "codex-runtime",
  "fake-embedded-app-server.mjs",
);

function executionFor(scenario) {
  return {
    async spawnAppServer() {
      return spawn(process.execPath, [fakeAppServer, scenario], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  };
}

test("trusted planner instructions map sourced candidates to the exact replacement command", () => {
  assert.match(EMBEDDED_PLANNER_INSTRUCTIONS, /replaceMealRecipeFromSource/);
  assert.match(EMBEDDED_PLANNER_INSTRUCTIONS, /setMealRecipe/);
  assert.match(EMBEDDED_PLANNER_INSTRUCTIONS, /exact candidate source/);
  assert.match(EMBEDDED_PLANNER_INSTRUCTIONS, /candidate remains untrusted data/);
  for (const command of [
    "removePrepReference",
    "setInstructionStepComplete",
    "updateInstructionStepNote",
    "resetInstructionTimer",
  ]) {
    assert.match(EMBEDDED_PLANNER_INSTRUCTIONS, new RegExp(command));
  }
  assert.match(EMBEDDED_PLANNER_INSTRUCTIONS, /separate earlier planner\.apply/);
});

test("a returned child protocol failure is never respawned or replayed", async () => {
  const execution = executionFor("identity-mismatch");
  let spawns = 0;
  let failures = 0;
  const session = createRestrictedDynamicPlannerSession({
    async spawnAppServer(options) {
      spawns += 1;
      return execution.spawnAppServer(options);
    },
  }, process.cwd());

  await assert.rejects(session.run({
    mode: "normal",
    prompt: "Fail after the child has started without replaying the model turn.",
    timeoutMs: 2_000,
    callbackTimeoutMs: 500,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool(call) { return success(call.appServerCallId); },
      async completeTurn() { return false; },
      async failTurn() {
        failures += 1;
        return true;
      },
    },
  }));
  assert.equal(spawns, 1);
  assert.equal(failures, 1);
});

function success(callId, data = {
  kind: "workspace",
  activeWeekId: "2026-07-06",
  weeks: [],
}) {
  return {
    schemaVersion: 1,
    ok: true,
    callId,
    plannerVersion: 3,
    syncRevision: 5,
    serverTime: 1,
    data,
  };
}

function failure(callId, code, message = "The callback was rejected.") {
  return {
    schemaVersion: 1,
    ok: false,
    callId,
    plannerVersion: 3,
    syncRevision: 5,
    serverTime: 1,
    error: {
      code,
      message,
      retry: "new_foreground_turn",
    },
  };
}

test("terminal lifecycle accepts only the five explicit ownership transitions", () => {
  const accepted = new Map([
    ["open:begin_complete", "completing"],
    ["open:begin_failure", "failing"],
    ["completing:complete_succeeded", "settled"],
    ["completing:complete_failed", "failing"],
    ["failing:failure_settled", "settled"],
  ]);
  for (const state of DYNAMIC_TERMINAL_STATES) {
    for (const event of DYNAMIC_TERMINAL_EVENTS) {
      const decision = decideDynamicTerminalTransition(state, event);
      const expected = accepted.get(`${state}:${event}`);
      assert.equal(decision.accepted, expected !== undefined, `${state}:${event}`);
      assert.equal(decision.next, expected ?? state, `${state}:${event}`);
    }
  }
});

test("near-limit Unicode candidate is a dedicated byte-complete user input item", async () => {
  const candidate = materializeResearchRecipeCandidate({
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/unicode",
    },
    title: "Unicode stew",
    steps: Array.from({ length: 16 }, () => ({
      inputs: [],
      instruction: "é".repeat(900),
    })),
  }, {
    createId: () => "research-candidate-unicode",
  }, {
    now: () => 1_750_000_000_000,
  });
  const candidateJson = JSON.stringify(candidate);
  assert.equal(Buffer.byteLength(candidateJson, "utf8") > 28_000, true);
  let completions = 0;
  const result = await createRestrictedDynamicPlannerSession(
    executionFor("research-candidate-input"),
    process.cwd(),
  ).run({
    mode: "normal",
    prompt: "Use the separate candidate item without copying it into this context item.",
    researchCandidateJson: candidateJson,
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool() { throw new Error("no planner call expected"); },
      async completeTurn(_identity, reply) {
        completions += 1;
        assert.equal(reply, "Received the dedicated bounded research candidate.");
        return true;
      },
      async failTurn() { return true; },
    },
  });
  assert.equal(result.reply, "Received the dedicated bounded research candidate.");
  assert.equal(completions, 1);
});

test("generated-schema-compatible callbacks wait for binding and live duplicates single-flight", async () => {
  const documents = createCodexSchemaDocuments();
  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  const validateCall = ajv.compile(documents["DynamicToolCallParams.json"]);
  const validateResponse = ajv.compile(documents["DynamicToolCallResponse.json"]);
  let bound = false;
  let dispatches = 0;
  let completions = 0;
  const events = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("normal-duplicates"),
    process.cwd(),
  );
  const result = await session.run({
    mode: "normal",
    prompt: "Read the current workspace and reply.",
    timeoutMs: 5_000,
    callbackTimeoutMs: 1_000,
    host: {
      async bindAppServerTurn(identity) {
        events.push("bind-start");
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.deepEqual(identity, {
          appServerThreadId: "thread-embedded",
          appServerTurnId: "turn-embedded",
        });
        bound = true;
        events.push("bind-committed");
        return true;
      },
      async dispatchPlannerTool(call) {
        assert.equal(bound, true, "callback dispatch waits for durable binding");
        assert.equal(validateCall({
          arguments: call.arguments,
          callId: call.appServerCallId,
          namespace: call.namespace,
          threadId: call.appServerThreadId,
          tool: call.tool,
          turnId: call.appServerTurnId,
        }), true, ajv.errorsText(validateCall.errors));
        dispatches += 1;
        events.push("dispatch");
        await new Promise((resolve) => setTimeout(resolve, 30));
        const envelope = success(call.appServerCallId);
        assert.equal(validateResponse({
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(envelope) }],
        }), true, ajv.errorsText(validateResponse.errors));
        return envelope;
      },
      async completeTurn(identity, reply) {
        assert.equal(bound, true);
        assert.equal(reply, "All exact duplicate callbacks joined one host call.");
        completions += 1;
        events.push("complete-committed");
        return true;
      },
      async failTurn() {
        events.push("failed");
        return false;
      },
    },
  });

  assert.equal(dispatches, 1, "five concurrent exact callbacks share one owner promise");
  assert.equal(completions, 1);
  assert.deepEqual(result.modelVisibleTools, NORMAL_MODEL_VISIBLE_TOOLS);
  assert.deepEqual(events.slice(0, 3), ["bind-start", "bind-committed", "dispatch"]);
  assert.equal(result.observedNotifications.includes("thread/started"), true);
  assert.equal(result.observedNotifications.includes("turn/started"), true);
  assert.equal(result.observedNotifications.includes("item/started"), true);
  assert.equal(result.observedNotifications.includes("item/completed"), true);
  assert.equal(result.observedNotifications.includes("turn/completed"), true);
});

test("recovery starts with no planner namespace and only commits reply-only output", async () => {
  let dispatches = 0;
  const session = createRestrictedDynamicPlannerSession(executionFor("recovery"), process.cwd());
  const result = await session.run({
    mode: "recovery",
    prompt: "Recover a reply from durable outcomes.",
    timeoutMs: 5_000,
    host: {
      async bindAppServerTurn() {
        return true;
      },
      async dispatchPlannerTool() {
        dispatches += 1;
        return success("forbidden");
      },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "Recovered from durable planner outcomes.");
        return true;
      },
      async failTurn() {
        return false;
      },
    },
  });
  assert.equal(dispatches, 0);
  assert.deepEqual(result.modelVisibleTools, RECOVERY_MODEL_VISIBLE_TOOLS);
});

test("thread-scoped notifications do not require a turn identity", async () => {
  const result = await createRestrictedDynamicPlannerSession(
    executionFor("thread-scoped-notification"),
    process.cwd(),
  ).run({
    mode: "normal",
    prompt: "Ignore valid thread-scoped status and complete.",
    timeoutMs: 5_000,
    host: {
      async bindAppServerTurn() { return true; },
      async dispatchPlannerTool() { throw new Error("no planner call expected"); },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "Ignored the valid thread-scoped notification.");
        return true;
      },
      async failTurn() { return false; },
    },
  });
  assert.equal(result.observedNotifications.includes("thread/settings/updated"), true);
});

test("app-server spawn rejection fences the already-durable turn exactly once", async () => {
  let failures = 0;
  const session = createRestrictedDynamicPlannerSession({
    identity: executionFor("recovery").identity,
    async spawnAppServer() {
      throw new Error("host process table refused the spawn");
    },
  }, process.cwd());

  await assert.rejects(session.run({
    mode: "normal",
    prompt: "The durable turn exists before the child is started.",
    timeoutMs: 2_000,
    host: {
      async bindAppServerTurn() {
        throw new Error("spawn rejection must precede binding");
      },
      async dispatchPlannerTool() {
        throw new Error("spawn rejection must precede dispatch");
      },
      async completeTurn() {
        throw new Error("spawn rejection must precede completion");
      },
      async failTurn(identity, failureValue) {
        failures += 1;
        assert.equal(identity, null);
        assert.deepEqual(failureValue, {
          code: "PROTOCOL_ERROR",
          detail: "Codex app-server could not be started.",
        });
        return true;
      },
    },
  }), (error) =>
    error instanceof DynamicPlannerSessionError &&
    error.code === "TURN_FAILED" &&
    error.message === "Codex app-server could not be started."
  );
  assert.equal(failures, 1);
});

test("unknown server requests fail closed through the durable host before session exit", async () => {
  const events = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("unknown-request"),
    process.cwd(),
  );
  await assert.rejects(
    session.run({
      mode: "normal",
      prompt: "Do not accept unknown capabilities.",
      timeoutMs: 5_000,
      host: {
        async bindAppServerTurn() {
          events.push("bound");
          return true;
        },
        async dispatchPlannerTool() {
          throw new Error("must not dispatch");
        },
        async completeTurn() {
          return false;
        },
        async failTurn(_identity, failure) {
          events.push(`fenced:${failure.code}`);
          return true;
        },
      },
    }),
    (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
  );
  assert.deepEqual(events, ["bound", "fenced:PROTOCOL_ERROR"]);
});

test("a coalesced turn response binds durably before its queued forbidden request fences", async () => {
  const events = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("coalesced-turn-response-forbidden-request"),
    process.cwd(),
  );
  await assert.rejects(
    session.run({
      mode: "normal",
      prompt: "Bind the returned turn before rejecting the adjacent forbidden request.",
      timeoutMs: 2_000,
      callbackTimeoutMs: 500,
      host: {
        async bindAppServerTurn(identity) {
          events.push("bind-committed");
          assert.deepEqual(identity, {
            appServerThreadId: "thread-embedded",
            appServerTurnId: "turn-embedded",
          });
          return true;
        },
        async dispatchPlannerTool() {
          events.push("unexpected-dispatch");
          throw new Error("a forbidden request cannot dispatch a planner effect");
        },
        async completeTurn() {
          events.push("unexpected-complete");
          return false;
        },
        async failTurn(identity, failureValue) {
          events.push(`fenced:${failureValue.code}`);
          assert.deepEqual(identity, {
            appServerThreadId: "thread-embedded",
            appServerTurnId: "turn-embedded",
          });
          return true;
        },
      },
    }),
    (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
  );
  assert.deepEqual(events, ["bind-committed", "fenced:PROTOCOL_ERROR"]);
});

test("callback timeout fences the host and never produces a terminal reply", async () => {
  const events = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("callback-timeout"),
    process.cwd(),
  );
  await assert.rejects(
    session.run({
      mode: "normal",
      prompt: "Exercise callback timeout.",
      timeoutMs: 5_000,
      callbackTimeoutMs: 25,
      host: {
        async bindAppServerTurn() {
          events.push("bound");
          return true;
        },
        async dispatchPlannerTool() {
          events.push("dispatch-started");
          return new Promise(() => undefined);
        },
        async completeTurn() {
          events.push("unexpected-complete");
          return false;
        },
        async failTurn(_identity, failure) {
          events.push(`fenced:${failure.code}`);
          return true;
        },
      },
    }),
    (error) => error instanceof DynamicPlannerSessionError && error.code === "SESSION_TIMEOUT",
  );
  assert.deepEqual(events, ["bound", "dispatch-started", "fenced:CALL_TIMED_OUT"]);
});

test("a durable completion exception transitions to one host failure without hanging", {
  timeout: 3_000,
}, async () => {
  let dispatches = 0;
  let completions = 0;
  let failures = 0;
  const session = createRestrictedDynamicPlannerSession(
    executionFor("normal-duplicates"),
    process.cwd(),
  );
  await assert.rejects(
    session.run({
      mode: "normal",
      prompt: "Exercise a completion persistence exception.",
      timeoutMs: 2_000,
      host: {
        async bindAppServerTurn() {
          return true;
        },
        async dispatchPlannerTool(call) {
          dispatches += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return success(call.appServerCallId);
        },
        async completeTurn() {
          completions += 1;
          throw new Error("completion transaction failed");
        },
        async failTurn(_identity, failure) {
          failures += 1;
          assert.equal(failure.code, "TURN_FAILED");
          return true;
        },
      },
    }),
    (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
  );
  assert.equal(dispatches, 1);
  assert.equal(completions, 1);
  assert.equal(failures, 1);
});

test("an unknown request aborts an outstanding client RPC only after one host fence", {
  timeout: 3_000,
}, async () => {
  const events = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("unknown-before-thread-response"),
    process.cwd(),
  );
  await assert.rejects(
    session.run({
      mode: "normal",
      prompt: "Reject the pre-response request.",
      timeoutMs: 2_000,
      host: {
        async bindAppServerTurn() {
          events.push("unexpected-bind");
          return true;
        },
        async dispatchPlannerTool() {
          throw new Error("must not dispatch");
        },
        async completeTurn() {
          return false;
        },
        async failTurn(identity, failure) {
          assert.equal(identity, null);
          events.push(`fenced:${failure.code}`);
          return true;
        },
      },
    }),
    (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
  );
  assert.deepEqual(events, ["fenced:PROTOCOL_ERROR"]);
});

for (const [scenario, label] of [
  ["notification-flood", "notification count"],
  ["message-flood", "aggregate agent messages"],
]) {
  test(`the ${label} bound fails the session through one durable fence`, {
    timeout: 3_000,
  }, async () => {
    let failures = 0;
    const session = createRestrictedDynamicPlannerSession(executionFor(scenario), process.cwd());
    await assert.rejects(
      session.run({
        mode: "normal",
        prompt: `Exercise ${label}.`,
        timeoutMs: 2_000,
        host: {
          async bindAppServerTurn() {
            return true;
          },
          async dispatchPlannerTool() {
            throw new Error("must not dispatch");
          },
          async completeTurn() {
            return false;
          },
          async failTurn(_identity, failure) {
            failures += 1;
            assert.equal(failure.code === "CALL_CANCELLED" || failure.code === "PROTOCOL_ERROR", true);
            return true;
          },
        },
      }),
      (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
    );
    assert.equal(failures, 1);
  });
}

test("duplicate callback owner rejection fans out to one dispatch and one terminal failure", {
  timeout: 3_000,
}, async () => {
  let dispatches = 0;
  let failures = 0;
  const session = createRestrictedDynamicPlannerSession(
    executionFor("normal-duplicates"),
    process.cwd(),
  );
  await assert.rejects(
    session.run({
      mode: "normal",
      prompt: "Reject the one duplicate-call owner.",
      timeoutMs: 2_000,
      host: {
        async bindAppServerTurn() {
          return true;
        },
        async dispatchPlannerTool() {
          dispatches += 1;
          throw new Error("durable dispatcher rejected the owner");
        },
        async completeTurn() {
          return false;
        },
        async failTurn(_identity, failure) {
          failures += 1;
          assert.equal(failure.code, "PROTOCOL_ERROR");
          return true;
        },
      },
    }),
    (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
  );
  assert.equal(dispatches, 1);
  assert.equal(failures, 1);
});

test("wire call B consumes the authoritative id returned by call A", async () => {
  const calls = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("dependent-calls"),
    process.cwd(),
  );
  const result = await session.run({
    mode: "normal",
    prompt: "Use a dependent read.",
    timeoutMs: 3_000,
    callbackTimeoutMs: 500,
    host: {
      async bindAppServerTurn() {
        return true;
      },
      async dispatchPlannerTool(call) {
        calls.push(structuredClone(call));
        if (call.appServerCallId === "call-a") {
          return success(call.appServerCallId, {
            kind: "workspace",
            activeWeekId: "host-returned-week-id",
            weeks: [],
          });
        }
        assert.equal(call.appServerCallId, "call-b");
        assert.deepEqual(call.arguments, {
          query: { kind: "week", weekId: "host-returned-week-id" },
        });
        return success(call.appServerCallId, {
          kind: "week",
          week: { id: "host-returned-week-id" },
        });
      },
      async completeTurn(_identity, reply) {
        assert.equal(reply, "Dependent call used host-returned-week-id.");
        return true;
      },
      async failTurn() {
        return false;
      },
    },
  });
  assert.equal(result.reply, "Dependent call used host-returned-week-id.");
  assert.deepEqual(calls.map((call) => call.appServerCallId), ["call-a", "call-b"]);
});

for (const scenario of [
  "policy-cwd",
  "policy-approval",
  "policy-profile",
  "policy-sandbox",
  "policy-network",
]) {
  test(`thread policy readback rejects ${scenario}`, async () => {
    let failures = 0;
    const session = createRestrictedDynamicPlannerSession(executionFor(scenario), process.cwd());
    await assert.rejects(
      session.run({
        mode: "normal",
        prompt: "Reject changed effective policy.",
        timeoutMs: 2_000,
        host: {
          async bindAppServerTurn() {
            throw new Error("policy mismatch must precede binding");
          },
          async dispatchPlannerTool() {
            throw new Error("policy mismatch must precede dispatch");
          },
          async completeTurn() {
            return false;
          },
          async failTurn(identity, failureValue) {
            failures += 1;
            assert.equal(identity, null);
            assert.equal(failureValue.code, "PROTOCOL_ERROR");
            return true;
          },
        },
      }),
      (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
    );
    assert.equal(failures, 1);
  });
}

for (const [scenario, expectedDetail] of [
  ["identity-free-message", /omitted its bound identity/],
  ["partial-turn-notification", /supplied only part of its turn identity/],
  ["identity-mismatch", /does not match the bound app-server turn/],
  ["oversized-stdout", /oversized stdout line/],
  ["oversized-stderr", /oversized stderr line/],
]) {
  test(`${scenario} fails closed through one sanitized durable fence`, async () => {
    const failures = [];
    const session = createRestrictedDynamicPlannerSession(executionFor(scenario), process.cwd());
    await assert.rejects(
      session.run({
        mode: "normal",
        prompt: "Exercise a protocol boundary.",
        timeoutMs: 3_000,
        host: {
          async bindAppServerTurn() {
            return true;
          },
          async dispatchPlannerTool() {
            return success("unexpected");
          },
          async completeTurn() {
            return false;
          },
          async failTurn(_identity, failureValue) {
            failures.push(failureValue);
            return true;
          },
        },
      }),
      (error) => error instanceof DynamicPlannerSessionError && error.code === "TURN_FAILED",
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0].detail, expectedDetail);
  });
}

test("hostile child JSON-RPC prose is never copied into durable failure detail", async () => {
  const failures = [];
  const session = createRestrictedDynamicPlannerSession(
    executionFor("hostile-rpc-error"),
    process.cwd(),
  );
  await assert.rejects(session.run({
    mode: "normal",
    prompt: "Reject hostile child prose.",
    timeoutMs: 2_000,
    host: {
      async bindAppServerTurn() {
        return true;
      },
      async dispatchPlannerTool() {
        return success("unexpected");
      },
      async completeTurn() {
        return false;
      },
      async failTurn(_identity, failureValue) {
        failures.push(failureValue);
        return true;
      },
    },
  }));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].detail.includes("SECRET_CHILD_PROSE"), false);
  assert.equal(failures[0].detail, "Codex app-server rejected thread/start.");
});

test("binding and terminal host callbacks each have a local deadline", async () => {
  for (const [scenario, host] of [
    ["normal-duplicates", {
      bindAppServerTurn: () => new Promise(() => undefined),
      dispatchPlannerTool: async (call) => success(call.appServerCallId),
      completeTurn: async () => true,
    }],
    ["normal-duplicates", {
      bindAppServerTurn: async () => true,
      dispatchPlannerTool: async (call) => success(call.appServerCallId),
      completeTurn: () => new Promise(() => undefined),
    }],
  ]) {
    let failures = 0;
    const session = createRestrictedDynamicPlannerSession(executionFor(scenario), process.cwd());
    await assert.rejects(session.run({
      mode: "normal",
      prompt: "Bound every host callback.",
      timeoutMs: 1_000,
      callbackTimeoutMs: 30,
      host: {
        ...host,
        async failTurn(_identity, failureValue) {
          failures += 1;
          assert.equal(failureValue.code, "CALL_TIMED_OUT");
          return true;
        },
      },
    }), (error) => error instanceof DynamicPlannerSessionError && error.code === "SESSION_TIMEOUT");
    assert.equal(failures, 1);
  }
});

test("terminal race, changed identity, process exit, and cancellation each settle once", async () => {
  const cases = [
    { scenario: "callback-terminal-race", expected: "PROTOCOL_ERROR" },
    { scenario: "changed-identity", expected: "DUPLICATE_MISMATCH" },
    { scenario: "early-exit", expected: "PROTOCOL_ERROR" },
  ];
  for (const { scenario, expected } of cases) {
    let failures = 0;
    let dispatches = 0;
    const session = createRestrictedDynamicPlannerSession(executionFor(scenario), process.cwd());
    await assert.rejects(session.run({
      mode: "normal",
      prompt: "Exercise terminal ownership.",
      timeoutMs: 2_000,
      callbackTimeoutMs: 250,
      host: {
        async bindAppServerTurn() {
          return true;
        },
        async dispatchPlannerTool(call) {
          dispatches += 1;
          if (scenario === "changed-identity" && dispatches === 2) {
            return failure(call.appServerCallId, "DUPLICATE_MISMATCH");
          }
          if (scenario === "callback-terminal-race") {
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return success(call.appServerCallId);
        },
        async completeTurn() {
          throw new Error("terminal race must not complete");
        },
        async failTurn(_identity, failureValue) {
          failures += 1;
          assert.equal(failureValue.code, expected);
          return true;
        },
      },
    }));
    assert.equal(failures, 1, scenario);
  }

  const controller = new AbortController();
  let boundResolve;
  const bound = new Promise((resolve) => {
    boundResolve = resolve;
  });
  let cancellationFailures = 0;
  const cancelled = createRestrictedDynamicPlannerSession(executionFor("hang"), process.cwd()).run({
    mode: "normal",
    prompt: "Wait until cancelled.",
    timeoutMs: 2_000,
    signal: controller.signal,
    host: {
      async bindAppServerTurn() {
        boundResolve();
        return true;
      },
      async dispatchPlannerTool() {
        return success("unexpected");
      },
      async completeTurn() {
        return false;
      },
      async failTurn(_identity, failureValue) {
        cancellationFailures += 1;
        assert.equal(failureValue.code, "CALL_CANCELLED");
        return true;
      },
    },
  });
  await bound;
  controller.abort();
  await assert.rejects(cancelled);
  assert.equal(cancellationFailures, 1);
});

test("a callback result resolving after timeout cannot produce a late response or completion", async () => {
  let resolveDispatch;
  const dispatch = new Promise((resolve) => {
    resolveDispatch = resolve;
  });
  let failures = 0;
  let completions = 0;
  const session = createRestrictedDynamicPlannerSession(
    executionFor("callback-timeout"),
    process.cwd(),
  );
  await assert.rejects(session.run({
    mode: "normal",
    prompt: "Fence a late callback result.",
    timeoutMs: 1_000,
    callbackTimeoutMs: 25,
    host: {
      async bindAppServerTurn() {
        return true;
      },
      async dispatchPlannerTool() {
        return dispatch;
      },
      async completeTurn() {
        completions += 1;
        return true;
      },
      async failTurn() {
        failures += 1;
        return true;
      },
    },
  }));
  resolveDispatch(success("same-call"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(failures, 1);
  assert.equal(completions, 0);
});
