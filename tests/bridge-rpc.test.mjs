import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../bridge/app-server-client.mjs";

function createFakeSpawn() {
  const calls = [];
  let spawnCount = 0;

  function spawnImpl() {
    spawnCount += 1;
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
        queueMicrotask(() => respond(child, request));
      }
    });
    return child;
  }

  function write(child, message) {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function respond(child, request) {
    if (request.method === "initialize") {
      write(child, { id: request.id, result: { userAgent: "fake-codex" } });
    } else if (request.method === "account/read") {
      write(child, {
        id: request.id,
        result: { account: { type: "chatgpt", planType: "plus" } },
      });
    } else if (request.method === "thread/start") {
      write(child, { id: request.id, result: { thread: { id: "thread-rpc" } } });
    } else if (request.method === "turn/start") {
      write(child, {
        id: request.id,
        result: { turn: { id: "turn-rpc", status: "inProgress", items: [] } },
      });
      write(child, {
        id: "server-request-1",
        method: "item/tool/requestUserInput",
        params: { threadId: "thread-rpc", turnId: "turn-rpc", questions: [] },
      });
      child.stdout.write("null\n");
      write(child, {
        method: "item/completed",
        params: {
          threadId: "thread-rpc",
          turnId: "turn-rpc",
          completedAtMs: Date.now(),
          item: {
            id: "message-rpc",
            type: "agentMessage",
            phase: "final_answer",
            text: '{"reply":"Dinner is ready.","command":null}',
          },
        },
      });
      write(child, {
        method: "turn/completed",
        params: {
          threadId: "thread-rpc",
          turn: { id: "turn-rpc", status: "completed", items: [] },
        },
      });
    }
  }

  return { spawnImpl, calls, get spawnCount() { return spawnCount; } };
}

test("app-server client performs JSONL handshake once and resolves a completed turn", async (t) => {
  const fake = createFakeSpawn();
  const client = new CodexAppServerClient({
    spawnImpl: fake.spawnImpl,
    requestTimeoutMs: 1_000,
  });
  t.after(() => client.close());

  const account = await client.getAccount();
  assert.deepEqual(account, { type: "chatgpt", planType: "plus" });
  const thread = await client.startThread({ ephemeral: true });
  assert.equal(thread.thread.id, "thread-rpc");
  const result = await client.runTurn(
    { threadId: "thread-rpc", input: [{ type: "text", text: "What is dinner?" }] },
    { timeoutMs: 1_000 },
  );

  assert.equal(fake.spawnCount, 1);
  assert.equal(fake.calls[0].method, "initialize");
  assert.deepEqual(fake.calls[1], { method: "initialized" });
  assert.equal(fake.calls[2].method, "account/read");
  assert.equal(fake.calls[3].method, "thread/start");
  assert.equal(fake.calls[4].method, "turn/start");
  assert.equal(result.text, '{"reply":"Dinner is ready.","command":null}');
  assert.equal(result.turn.status, "completed");
  assert.ok(
    fake.calls.some(
      (message) => message.id === "server-request-1" && message.error?.code === -32601,
    ),
  );
});

test("concurrent callers wait for the initialized handshake", async (t) => {
  const calls = [];
  let initialized = false;

  const client = new CodexAppServerClient({
    requestTimeoutMs: 1_000,
    spawnImpl() {
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
          if (request.method === "initialize") {
            setTimeout(() => {
              child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
            }, 10);
          } else if (request.method === "initialized") {
            initialized = true;
          } else if (request.method === "account/read") {
            const response = initialized
              ? { id: request.id, result: { account: { type: "chatgpt" } } }
              : { id: request.id, error: { code: -32002, message: "Not initialized" } };
            child.stdout.write(`${JSON.stringify(response)}\n`);
          }
        }
      });
      return child;
    },
  });
  t.after(() => client.close());

  const accounts = await Promise.all([client.getAccount(), client.getAccount()]);
  assert.deepEqual(accounts, [{ type: "chatgpt" }, { type: "chatgpt" }]);
  assert.deepEqual(
    calls.map((message) => message.method).slice(0, 4),
    ["initialize", "initialized", "account/read", "account/read"],
  );
});

test("turn timeout interrupts Codex and ignores late completion events", async (t) => {
  const calls = [];
  let child;
  const client = new CodexAppServerClient({
    requestTimeoutMs: 100,
    spawnImpl() {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => true;
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
          if (request.method === "initialize") {
            child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          } else if (request.method === "turn/start") {
            child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-late" } } })}\n`);
          } else if (request.method === "turn/interrupt") {
            child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
            setTimeout(() => {
              child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-late", status: "interrupted" } } })}\n`);
            }, 5);
          }
        }
      });
      return child;
    },
  });
  t.after(() => client.close());

  await assert.rejects(
    client.runTurn(
      { threadId: "thread-late", input: [{ type: "text", text: "Wait" }] },
      { timeoutMs: 15 },
    ),
    (error) => error.code === "CODEX_TIMEOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((request) => request.method === "turn/interrupt"));
  assert.equal(client.turnRecords.size, 0);
  assert.equal(client.ignoredTurnIds.size, 0);
});

test("stdin EPIPE transitions the client to unavailable instead of crashing", async () => {
  let child;
  const client = new CodexAppServerClient({
    requestTimeoutMs: 1_000,
    spawnImpl() {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => true;
      let input = "";
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        input += chunk;
        const lines = input.split("\n");
        input = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const request = JSON.parse(line);
          if (request.method === "initialize") {
            child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          } else if (request.method === "account/read") {
            queueMicrotask(() => {
              const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
              child.stdin.emit("error", error);
            });
          }
        }
      });
      return child;
    },
  });

  await assert.rejects(client.getAccount(), (error) => error.code === "CODEX_UNAVAILABLE");
});
