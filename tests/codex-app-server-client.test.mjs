import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AppServerClient,
  AppServerClientError,
  AppServerRequestError,
} from "../server/codex/app-server-client.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fakeAppServer = join(
  testDirectory,
  "support",
  "fixtures",
  "codex-runtime",
  "fake-native-app-server.mjs",
);

function spawnFake() {
  return spawn(process.execPath, [fakeAppServer], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture event.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("long-lived client multiplexes the exact native lifecycle without jsonrpc envelopes", async (t) => {
  const notifications = [];
  const client = new AppServerClient(spawnFake(), {
    requestTimeoutMs: 1_000,
    onNotification: (message) => notifications.push(message),
  });
  t.after(() => client.close());

  assert.deepEqual(await client.request("initialize", {
    clientInfo: { name: "planner", version: "1" },
  }), { userAgent: "fake-native-app-server" });
  client.notifyInitialized();

  const started = await client.request("thread/start", { ephemeral: false });
  const threadId = started.thread.id;
  const completionOrder = [];
  const slowList = client.request("thread/list", { searchTerm: "slow" })
    .then((value) => {
      completionOrder.push("list");
      return value;
    });
  const read = client.request("thread/read", { threadId, includeTurns: true })
    .then((value) => {
      completionOrder.push("read");
      return value;
    });
  assert.equal((await read).thread.id, threadId);
  assert.equal((await slowList).data[0].id, threadId);
  assert.deepEqual(completionOrder, ["read", "list"]);

  assert.equal((await client.request("thread/resume", { threadId })).thread.id, threadId);
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Plan dinner." }],
  });
  assert.deepEqual(await client.request("turn/steer", {
    threadId,
    expectedTurnId: turn.turn.id,
    input: [{ type: "text", text: "Use Tuesday instead." }],
  }), { turnId: turn.turn.id });
  assert.deepEqual(await client.request("turn/interrupt", {
    threadId,
    turnId: turn.turn.id,
  }), {});
  assert.deepEqual(await client.request("thread/archive", { threadId }), {});

  const stats = await client.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.initializedNotified, true);
  assert.equal(stats.protocolViolation, false);
  assert.deepEqual(stats.requestCounts, {
    initialize: 1,
    "thread/start": 1,
    "thread/list": 2,
    "thread/read": 1,
    "thread/resume": 1,
    "turn/start": 1,
    "turn/steer": 1,
    "turn/interrupt": 1,
    "thread/archive": 1,
  });
  assert.equal(notifications.some((message) => message.method === "thread/started"), true);
  assert.equal(notifications.some((message) => message.method === "turn/started"), true);
  assert.equal(notifications.some((message) => message.method === "turn/steered"), true);
  assert.equal(notifications.some((message) => message.method === "turn/completed"), true);

  await assert.rejects(
    client.request("account/read", {}),
    (error) => error instanceof AppServerClientError && error.code === "PROTOCOL_ERROR",
  );
});

test("server requests are callbacks and responses stay on the same process", async (t) => {
  const notifications = [];
  const serverRequests = [];
  let client;
  client = new AppServerClient(spawnFake(), {
    requestTimeoutMs: 1_000,
    onNotification(message) {
      notifications.push(message);
    },
    onServerRequest(message) {
      serverRequests.push(message);
      client.respond(message.id, {
        answers: { choice: { answers: ["Soup"] } },
      });
    },
  });
  t.after(() => client.close());

  await client.request("initialize", {});
  client.notifyInitialized();
  const started = await client.request("thread/start", { ephemeral: false });
  await client.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "Please ask me which dinner." }],
  });
  await waitFor(() => notifications.some((message) =>
    message.method === "fixture/serverResponse"));

  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].method, "item/tool/requestUserInput");
  const response = notifications.find((message) => message.method === "fixture/serverResponse");
  assert.deepEqual(response.params.result, {
    answers: { choice: { answers: ["Soup"] } },
  });
});

test("typed app-server errors preserve code, message, data, and leave the transport usable", async (t) => {
  const client = new AppServerClient(spawnFake(), { requestTimeoutMs: 1_000 });
  t.after(() => client.close());
  await client.request("initialize", {});

  await assert.rejects(
    client.request("thread/read", { threadId: "missing-native-thread" }),
    (error) => error instanceof AppServerRequestError &&
      error.method === "thread/read" &&
      error.response.code === -32600 &&
      error.response.message === "thread not found: missing-native-thread" &&
      error.response.data?.kind === "missing_thread",
  );
  const stats = await client.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/read"], 1);
});

test("a timed out request retires the ambiguous process and rejects sibling work", async (t) => {
  const failures = [];
  const client = new AppServerClient(spawnFake(), {
    requestTimeoutMs: 1_000,
    onFailure: (error) => failures.push(error),
  });
  t.after(() => client.close());
  await client.request("initialize", {});

  const timedOut = client.request("thread/read", { threadId: "never" }, 25);
  const sibling = client.request("thread/list", { searchTerm: "slow" });
  const settled = await Promise.allSettled([timedOut, sibling]);
  assert.equal(settled.every((result) => result.status === "rejected" &&
    result.reason instanceof AppServerClientError &&
    result.reason.code === "REQUEST_TIMEOUT"), true);
  assert.equal(client.failure?.code, "REQUEST_TIMEOUT");
  assert.equal(failures.length, 1);
  await assert.rejects(
    client.request("thread/list", { searchTerm: "__stats__" }),
    (error) => error instanceof AppServerClientError && error.code === "REQUEST_TIMEOUT",
  );
});

test("process failure rejects every multiplexed request once", async (t) => {
  const failures = [];
  const client = new AppServerClient(spawnFake(), {
    requestTimeoutMs: 1_000,
    onFailure: (error) => failures.push(error),
  });
  t.after(() => client.close());
  await client.request("initialize", {});

  const pending = [
    client.request("thread/list", { searchTerm: "slow" }),
    client.request("thread/read", { threadId: "crash" }),
  ];
  const results = await Promise.allSettled(pending);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(results.every((result) =>
    result.reason instanceof AppServerClientError && result.reason.code === "TRANSPORT_ERROR"), true);
  assert.equal(failures.length, 1);
});

test("oversized inbound frames fail the process and reject the owning request", async (t) => {
  const client = new AppServerClient(spawnFake(), { requestTimeoutMs: 1_000 });
  t.after(() => client.close());
  await client.request("initialize", {});

  await assert.rejects(
    client.request("thread/read", { threadId: "oversized" }),
    (error) => error instanceof AppServerClientError &&
      error.code === "PROTOCOL_ERROR" && /oversized stdout line/.test(error.message),
  );
});

test("closing the client rejects pending work and is idempotent", async () => {
  const client = new AppServerClient(spawnFake(), { requestTimeoutMs: 1_000 });
  await client.request("initialize", {});
  const pending = client.request("thread/read", { threadId: "never" });
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof AppServerClientError && error.code === "CLIENT_CLOSED",
  );

  await client.close();
  await rejected;
  await client.close();
});
