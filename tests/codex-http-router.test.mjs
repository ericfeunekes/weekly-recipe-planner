import assert from "node:assert/strict";
import { request as requestHttp } from "node:http";
import test from "node:test";

import { projectCodexThread } from "../server/codex/activity-projection.ts";
import { createCodexRouter } from "../server/http/codex-router.ts";
import { closeHttpServer, listenHttpServer } from "../server/http/server.ts";

const SELECTION = { threadId: "thread-1", revision: 4 };
const STATUS = { state: "idle", waitingFor: null };
const THREAD_SUMMARY = {
  id: "thread-1",
  title: "Weekly dinner",
  preview: "Plan this week",
  status: STATUS,
  createdAtMs: 10,
  updatedAtMs: 20,
  recencyAtMs: 20,
};
const THREAD_VIEW = {
  ...THREAD_SUMMARY,
  threadKind: "conversation",
  parentThreadId: null,
  turns: [],
  workers: [],
  historyTruncated: false,
};
const CONNECTION = {
  connectionEpoch: "epoch-1",
  activityRevision: 7,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createService(overrides = {}) {
  const calls = [];
  const service = {
    listThreads(request) {
      calls.push(["listThreads", request]);
      return { threads: [THREAD_SUMMARY], nextCursor: null, selection: SELECTION, ...CONNECTION };
    },
    readThread(request) {
      calls.push(["readThread", request]);
      return { thread: THREAD_VIEW, selection: SELECTION, interactions: [], ...CONNECTION };
    },
    newThread(request) {
      calls.push(["newThread", request]);
      return { thread: THREAD_SUMMARY, selection: SELECTION, ...CONNECTION };
    },
    selectThread(request) {
      calls.push(["selectThread", request]);
      return { thread: THREAD_SUMMARY, selection: SELECTION, ...CONNECTION };
    },
    archiveThread(request) {
      calls.push(["archiveThread", request]);
      return { thread: null, selection: { threadId: null, revision: 5 }, ...CONNECTION };
    },
    sendTurn(request) {
      calls.push(["sendTurn", request]);
      return { threadId: request.threadId, turnId: "turn-1", ...CONNECTION };
    },
    interruptTurn(request) {
      calls.push(["interruptTurn", request]);
      return { threadId: request.threadId, turnId: request.turnId, ...CONNECTION };
    },
    listInteractions(request) {
      calls.push(["listInteractions", request]);
      return { interactions: [], ...CONNECTION };
    },
    respondInteraction(request) {
      calls.push(["respondInteraction", request]);
      return {
        interactionId: request.interactionId,
        status: "resolved",
        ...CONNECTION,
      };
    },
    waitForEvents(request, context) {
      calls.push(["waitForEvents", request, context]);
      return {
        changed: true,
        connectionEpoch: "epoch-1",
        revision: 8,
        resyncRequired: false,
        reasons: ["thread"],
      };
    },
    ...overrides,
  };
  return { service, calls };
}

async function startRouter(t, {
  serviceOverrides = {},
  options = {},
  unknownStatus = 418,
} = {}) {
  const { service, calls } = createService(serviceOverrides);
  const router = createCodexRouter(service, options);
  const server = await listenHttpServer({
    port: 0,
    handler: async (request, response) => {
      const handled = await router(request, response);
      if (!handled) {
        response.statusCode = unknownStatus;
        response.end("not-codex");
      }
    },
  });
  t.after(() => closeHttpServer(server));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls, server };
}

function httpRequest(baseUrl, path, {
  method = "GET",
  headers = {},
  body,
} = {}) {
  return new Promise((resolve, reject) => {
    const request = requestHttp(new URL(path, baseUrl), { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Some composability assertions intentionally use a non-JSON sentinel.
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text,
          json,
        });
      });
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function jsonRequest(baseUrl, path, body, options = {}) {
  return httpRequest(baseUrl, path, {
    method: "POST",
    ...options,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

test("Codex router parses every GET endpoint into its exact service request", async (t) => {
  const { baseUrl, calls } = await startRouter(t, {
    options: { now: () => 1_800_000_000_000 },
  });

  const list = await httpRequest(
    baseUrl,
    "/api/codex/threads?archived=false&cursor=cursor-1&limit=25&search=dinner",
  );
  assert.equal(list.status, 200);
  assert.equal(list.headers["cache-control"], "no-store");
  assert.equal(list.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(list.headers["x-content-type-options"], "nosniff");
  assert.equal(list.headers.date, new Date(1_800_000_000_000).toUTCString());
  assert.deepEqual(list.json.threads, [THREAD_SUMMARY]);

  assert.equal((await httpRequest(baseUrl, "/api/codex/thread?threadId=thread-1")).status, 200);
  assert.equal((await httpRequest(
    baseUrl,
    "/api/codex/interactions?threadId=thread-1",
  )).status, 200);
  assert.equal((await httpRequest(
    baseUrl,
    "/api/codex/events?connectionEpoch=epoch-1&afterRevision=7&waitMs=25000&threadId=thread-1",
  )).status, 200);
  assert.equal((await httpRequest(baseUrl, "/api/codex/events?afterRevision=0")).status, 200);

  assert.deepEqual(calls.map(([method, request]) => [method, request]), [
    ["listThreads", { archived: false, cursor: "cursor-1", limit: 25, search: "dinner" }],
    ["readThread", { threadId: "thread-1" }],
    ["listInteractions", { threadId: "thread-1" }],
    ["waitForEvents", {
      connectionEpoch: "epoch-1",
      afterRevision: 7,
      waitMs: 25_000,
      threadId: "thread-1",
    }],
    ["waitForEvents", { connectionEpoch: null, afterRevision: 0 }],
  ]);
  assert.equal(calls[3][2].signal instanceof AbortSignal, true);
});

test("Codex thread reads never expose native web-search queries over HTTP", async (t) => {
  const queryCanary = "CANARY_PRIVATE_HTTP_WEB_SEARCH_QUERY";
  const projectedThread = projectCodexThread({
    id: "thread-1",
    name: "Weekly dinner",
    preview: "Plan this week",
    createdAt: 10,
    updatedAt: 20,
    status: { type: "idle" },
    parentThreadId: null,
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [{
        id: "web-1",
        type: "webSearch",
        query: queryCanary,
        action: { type: "openPage", url: "https://private.example/canary" },
      }],
    }],
  });
  assert.notEqual(projectedThread, null);
  const { baseUrl } = await startRouter(t, {
    serviceOverrides: {
      readThread() {
        return {
          thread: projectedThread,
          selection: SELECTION,
          interactions: [],
          ...CONNECTION,
        };
      },
    },
  });

  const response = await httpRequest(baseUrl, "/api/codex/thread?threadId=thread-1");
  assert.equal(response.status, 200);
  assert.equal(response.json.thread.turns[0].items[0].label, "Opening a source");
  assert.equal(response.json.thread.turns[0].items[0].detail, null);
  assert.equal(response.text.includes(queryCanary), false);
  assert.equal(response.text.includes("private.example/canary"), false);
});

test("Codex router validates and delegates every mutation endpoint", async (t) => {
  const { baseUrl, calls } = await startRouter(t, {
    options: {
      allowedOrigins: new Set(["http://localhost:3001"]),
      allowOriginlessMutations: false,
    },
  });
  const headers = { origin: "http://localhost:3001", "sec-fetch-site": "same-site" };
  const requests = [
    ["/api/codex/threads/new", {
      requestId: "request-new",
      expectedSelectionRevision: 4,
    }, 201],
    ["/api/codex/threads/select", {
      requestId: "request-select",
      threadId: null,
      expectedSelectionRevision: 4,
    }, 200],
    ["/api/codex/threads/archive", {
      requestId: "request-archive",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
    }, 200],
    ["/api/codex/turns/send", {
      requestId: "request-send",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
      clientUserMessageId: "message-1",
      message: "  Keep this exact message  ",
    }, 202],
    ["/api/codex/turns/interrupt", {
      requestId: "request-interrupt",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
      turnId: "turn-1",
    }, 200],
    ["/api/codex/interactions/respond", {
      requestId: "request-answer",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
      interactionId: "interaction-1",
      response: {
        kind: "answers",
        answers: [{ questionId: "question-1", answers: ["Option A"] }],
      },
    }, 200],
  ];

  for (const [path, body, status] of requests) {
    const response = await jsonRequest(baseUrl, path, body, { headers });
    assert.equal(response.status, status, `${path}: ${response.text}`);
  }

  assert.deepEqual(calls.map(([method]) => method), [
    "newThread",
    "selectThread",
    "archiveThread",
    "sendTurn",
    "interruptTurn",
    "respondInteraction",
  ]);
  assert.equal(calls[3][1].message, "  Keep this exact message  ");
});

test("Codex router rejects unknown, duplicate, noncanonical, and out-of-contract query values", async (t) => {
  const { baseUrl, calls } = await startRouter(t);
  const paths = [
    "/api/codex/threads?unknown=1",
    "/api/codex/threads?limit=1&limit=2",
    "/api/codex/threads?archived=1",
    "/api/codex/threads?limit=01",
    "/api/codex/threads?limit=101",
    "/api/codex/thread",
    "/api/codex/thread?threadId=",
    "/api/codex/interactions?threadId=one&threadId=two",
    "/api/codex/events",
    "/api/codex/events?afterRevision=01",
    "/api/codex/events?afterRevision=-1",
    "/api/codex/events?afterRevision=0&waitMs=30001",
    "/api/codex/events?afterRevision=0&connectionEpoch=",
    "/api/codex/events?afterRevision=0&extra=1",
  ];
  for (const path of paths) {
    const response = await httpRequest(baseUrl, path);
    assert.equal(response.status, 400, `${path}: ${response.text}`);
    assert.equal(response.json.error.code, "INVALID_REQUEST");
  }
  assert.deepEqual(calls, []);
});

test("Codex router rejects malformed and oversized JSON before service admission", async (t) => {
  const { baseUrl, calls } = await startRouter(t);

  const missingType = await httpRequest(baseUrl, "/api/codex/threads/new", {
    method: "POST",
    body: "{}",
  });
  assert.equal(missingType.status, 415);

  const wrongType = await httpRequest(baseUrl, "/api/codex/threads/new", {
    method: "POST",
    headers: { "content-type": "application/jsonp" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const invalidJson = await httpRequest(baseUrl, "/api/codex/threads/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);

  const primitive = await jsonRequest(baseUrl, "/api/codex/threads/new", []);
  assert.equal(primitive.status, 400);

  const unknownKey = await jsonRequest(baseUrl, "/api/codex/threads/new", {
    requestId: "request-1",
    expectedSelectionRevision: 0,
    extra: true,
  });
  assert.equal(unknownKey.status, 400);

  const wrongTypeBody = await jsonRequest(baseUrl, "/api/codex/turns/send", {
    requestId: "request-1",
    threadId: "thread-1",
    expectedSelectionRevision: "0",
    clientUserMessageId: "message-1",
    message: "hello",
  });
  assert.equal(wrongTypeBody.status, 400);

  const queryOnMutation = await jsonRequest(baseUrl, "/api/codex/threads/new?extra=1", {
    requestId: "request-1",
    expectedSelectionRevision: 0,
  });
  assert.equal(queryOnMutation.status, 400);

  const oversizedBody = JSON.stringify({ value: "x".repeat(256 * 1024) });
  const oversized = await httpRequest(baseUrl, "/api/codex/threads/new", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(oversizedBody)),
    },
    body: oversizedBody,
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, "INVALID_REQUEST");

  const oversizedChunked = await httpRequest(baseUrl, "/api/codex/threads/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBody,
  });
  assert.equal(oversizedChunked.status, 413);
  assert.equal(oversizedChunked.json.error.code, "INVALID_REQUEST");
  assert.deepEqual(calls, []);
});

test("Codex router enforces Host, allowed Origin, and fetch-site mutation policy", async (t) => {
  const allowedOrigin = "https://planner.example";
  const { baseUrl, calls } = await startRouter(t, {
    options: {
      allowedOrigins: new Set([allowedOrigin]),
      allowOriginlessMutations: false,
    },
  });
  const body = { requestId: "request-new", expectedSelectionRevision: 0 };

  const invalidHost = await httpRequest(baseUrl, "/api/codex/threads", {
    headers: { host: "attacker.example" },
  });
  assert.equal(invalidHost.status, 400);

  const allowedProxyHost = await httpRequest(baseUrl, "/api/codex/threads", {
    headers: { host: "planner.example" },
  });
  assert.equal(allowedProxyHost.status, 200);

  assert.equal((await jsonRequest(baseUrl, "/api/codex/threads/new", body)).status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/codex/threads/new", body, {
    headers: { origin: "https://attacker.example", "sec-fetch-site": "same-site" },
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/codex/threads/new", body, {
    headers: { origin: allowedOrigin, "sec-fetch-site": "cross-site" },
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/codex/threads/new", body, {
    headers: { origin: allowedOrigin, "sec-fetch-site": "same-origin" },
  })).status, 201);

  assert.deepEqual(calls.map(([method]) => method), ["listThreads", "newThread"]);
});

test("Codex router maps closed service errors and hides unexpected failures", async (t) => {
  const cases = [
    ["INVALID_REQUEST", 400],
    ["NOT_FOUND", 404],
    ["REQUEST_ID_REUSE", 409],
    ["SELECTION_CONFLICT", 409],
    ["TURN_CONFLICT", 409],
    ["INTERACTION_STALE", 409],
    ["CODEX_UNAVAILABLE", 503],
    ["CODEX_INCOMPATIBLE", 503],
    ["INTERNAL_ERROR", 500],
  ];
  let thrown = { code: "NOT_FOUND", message: "Thread is gone." };
  const { baseUrl } = await startRouter(t, {
    serviceOverrides: {
      listThreads() {
        throw thrown;
      },
    },
  });

  for (const [code, status] of cases) {
    thrown = { code, message: `mapped ${code}` };
    const response = await httpRequest(baseUrl, "/api/codex/threads");
    assert.equal(response.status, status);
    assert.deepEqual(response.json, { error: { code, message: `mapped ${code}` } });
  }

  thrown = { code: "NOT_FOUND", message: "Gone with explicit status.", httpStatus: 410 };
  const explicit = await httpRequest(baseUrl, "/api/codex/threads");
  assert.equal(explicit.status, 410);

  thrown = new Error("secret filesystem detail");
  const unexpected = await httpRequest(baseUrl, "/api/codex/threads");
  assert.equal(unexpected.status, 500);
  assert.deepEqual(unexpected.json, {
    error: {
      code: "INTERNAL_ERROR",
      message: "The Codex thread service failed unexpectedly.",
    },
  });
  assert.doesNotMatch(unexpected.text, /secret filesystem/u);
});

test("Codex router aborts bounded event waits when the HTTP client disconnects", async (t) => {
  const entered = deferred();
  const aborted = deferred();
  const { baseUrl } = await startRouter(t, {
    serviceOverrides: {
      waitForEvents(_request, { signal }) {
        entered.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.resolve(signal);
            reject(new DOMException("Client disconnected.", "AbortError"));
          }, { once: true });
        });
      },
    },
  });

  const clientRequest = requestHttp(new URL("/api/codex/events?afterRevision=0", baseUrl));
  clientRequest.once("error", () => {});
  clientRequest.end();
  const enteredSignal = await entered.promise;
  clientRequest.destroy();
  const abortedSignal = await aborted.promise;
  assert.equal(enteredSignal, abortedSignal);
  assert.equal(abortedSignal.aborted, true);
});

test("Codex router returns false without touching unknown routes", async (t) => {
  const { baseUrl, calls } = await startRouter(t);
  const response = await httpRequest(baseUrl, "/api/not-codex", {
    headers: { host: "attacker.example" },
  });
  assert.equal(response.status, 418);
  assert.equal(response.text, "not-codex");
  assert.deepEqual(calls, []);
});

test("Codex router rejects method mismatches without reading a request body", async (t) => {
  const { baseUrl, calls } = await startRouter(t);
  const response = await httpRequest(baseUrl, "/api/codex/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET");
  assert.deepEqual(calls, []);
});
