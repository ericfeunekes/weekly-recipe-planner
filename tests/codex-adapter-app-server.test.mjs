import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexAppServerClient } from "../bridge/app-server-client.mjs";
import {
  HOUSEHOLD_PLANNER_INSTRUCTIONS,
  createCodexPlannerAdapter,
} from "../server/chat/codex-adapter.ts";

const COMMAND = {
  type: "setInstructionStepComplete",
  weekId: "2026-07-06",
  stepId: "step-1",
  complete: true,
};

class FakeRpc {
  constructor({ account, output, error } = {}) {
    this.account = account ?? { type: "chatgpt", planType: "plus" };
    this.output = output ?? JSON.stringify({ reply: "The step is complete.", command: COMMAND });
    this.error = error;
    this.threadCalls = [];
    this.turnCalls = [];
    this.unsubscribeCalls = [];
  }

  async getAccount() {
    if (this.error) throw this.error;
    return this.account;
  }

  async startThread(params) {
    this.threadCalls.push(params);
    return { thread: { id: "thread-1" } };
  }

  async runTurn(params, options) {
    this.turnCalls.push({ params, options });
    return { text: this.output, turn: { id: "transport-turn", status: "completed" } };
  }

  async unsubscribeThread(threadId) {
    this.unsubscribeCalls.push(threadId);
  }
}

test("adapter uses ChatGPT auth, locked app-server options, and household structured output", async () => {
  const rpc = new FakeRpc();
  const adapter = createCodexPlannerAdapter({
    rpc,
    cwd: "/planner-agent",
    timeoutMs: 2_000,
    model: "test-model",
  });
  const controller = new AbortController();

  assert.deepEqual(await adapter.readStatus(), {
    available: true,
    authenticated: true,
    detail: "Codex is signed in with ChatGPT.",
  });
  assert.deepEqual(
    await adapter.complete({
      turnId: "planner-turn-1",
      prompt: "canonical prompt",
      signal: controller.signal,
    }),
    { reply: "The step is complete.", command: COMMAND },
  );

  assert.deepEqual(rpc.threadCalls[0], {
    cwd: "/planner-agent",
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    developerInstructions: HOUSEHOLD_PLANNER_INSTRUCTIONS,
    model: "test-model",
    serviceName: "weekly_recipe_planner",
  });
  assert.equal(rpc.turnCalls[0].params.input[0].text, "canonical prompt");
  assert.equal(rpc.turnCalls[0].params.outputSchema.additionalProperties, false);
  assert.equal(
    rpc.turnCalls[0].params.outputSchema.properties.command.anyOf[0].anyOf.length > 20,
    true,
  );
  assert.equal(rpc.turnCalls[0].options.signal, controller.signal);
  assert.deepEqual(rpc.unsubscribeCalls, ["thread-1"]);
});

test("adapter reports unavailable auth without affecting planner readiness", async () => {
  const wrongAuth = createCodexPlannerAdapter({
    rpc: new FakeRpc({ account: { type: "apiKey" } }),
  });
  assert.deepEqual(await wrongAuth.readStatus(), {
    available: true,
    authenticated: false,
    detail: "Codex is authenticated, but not with ChatGPT.",
  });
  await assert.rejects(
    wrongAuth.complete({
      turnId: "turn",
      prompt: "prompt",
      signal: new AbortController().signal,
    }),
    (error) => error.code === "CODEX_UNAVAILABLE",
  );

  const stopped = createCodexPlannerAdapter({ rpc: new FakeRpc({ error: new Error("offline") }) });
  assert.deepEqual(await stopped.readStatus(), {
    available: false,
    authenticated: null,
    detail: "offline",
  });
});

test("adapter rejects malformed or legacy planner commands", async () => {
  const rpc = new FakeRpc({
    output: JSON.stringify({
      reply: "Done.",
      command: { type: "toggleInstructionStep", stepId: "step-1" },
    }),
  });
  const adapter = createCodexPlannerAdapter({ rpc });
  await assert.rejects(
    adapter.complete({
      turnId: "turn",
      prompt: "prompt",
      signal: new AbortController().signal,
    }),
    (error) => error.code === "CODEX_PROTOCOL_ERROR",
  );
  assert.deepEqual(rpc.unsubscribeCalls, ["thread-1"]);
});

function createAbortableSpawn() {
  const calls = [];

  function spawnImpl() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    };

    let input = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      input += chunk;
      const lines = input.split("\n");
      input = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line);
        calls.push(request);
        queueMicrotask(() => {
          if (request.method === "initialize") {
            child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          } else if (request.method === "turn/start") {
            child.stdout.write(
              `${JSON.stringify({
                id: request.id,
                result: { turn: { id: "transport-turn", status: "inProgress" } },
              })}\n`,
            );
          } else if (request.method === "turn/interrupt") {
            child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          }
        });
      }
    });
    return child;
  }

  return { spawnImpl, calls };
}

test("AbortSignal interrupts the active app-server transport turn", async (t) => {
  const fake = createAbortableSpawn();
  const client = new CodexAppServerClient({
    spawnImpl: fake.spawnImpl,
    requestTimeoutMs: 1_000,
  });
  t.after(() => client.close());
  const controller = new AbortController();

  const turn = client.runTurn(
    {
      threadId: "thread-1",
      input: [{ type: "text", text: "prompt" }],
    },
    { timeoutMs: 1_000, signal: controller.signal },
  );
  while (!fake.calls.some((call) => call.method === "turn/start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();

  await assert.rejects(turn, (error) => error.code === "CODEX_ABORTED");
  assert.equal(
    fake.calls.some(
      (call) =>
        call.method === "turn/interrupt" &&
        call.params.turnId === "transport-turn" &&
        call.params.threadId === "thread-1",
    ),
    true,
  );
});
