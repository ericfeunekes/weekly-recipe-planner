import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexThreadClientError,
  archiveCodexThread,
  interruptCodexTurn,
  listCodexInteractions,
  listCodexThreads,
  newCodexThread,
  readCodexThread,
  respondToCodexInteraction,
  selectCodexThread,
  sendCodexTurn,
  waitForCodexEvents,
} from "../app/codex-thread-api.ts";

const SUMMARY = {
  id: "thread-1",
  title: "Dinner planning",
  preview: "Plan dinner for Friday.",
  status: { state: "idle", waitingFor: null },
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
  recencyAtMs: 2_000,
};
const LIST_RESPONSE = {
  threads: [SUMMARY],
  nextCursor: null,
  selection: { threadId: "thread-1", revision: 4 },
  connectionEpoch: "epoch",
  activityRevision: 8,
};
const THREAD_RESPONSE = {
  thread: {
    ...SUMMARY,
    threadKind: "conversation",
    parentThreadId: null,
    turns: [],
    workers: [],
    historyTruncated: false,
  },
  selection: LIST_RESPONSE.selection,
  interactions: [],
  connectionEpoch: "epoch",
  activityRevision: 8,
};
const THREAD_MUTATION_RESPONSE = {
  thread: SUMMARY,
  selection: LIST_RESPONSE.selection,
  connectionEpoch: "epoch",
  activityRevision: 9,
};
const TURN_MUTATION_RESPONSE = {
  threadId: "thread-1",
  turnId: "turn-1",
  connectionEpoch: "epoch",
  activityRevision: 10,
};
const INTERACTION_MUTATION_RESPONSE = {
  interactionId: "interaction-1",
  status: "resolved",
  connectionEpoch: "epoch",
  activityRevision: 11,
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("browser client exposes all ten routes with full queries, typed bodies, and exact success statuses", async () => {
  const requests = [];
  await withFetch(async (path, init) => {
    requests.push({
      path,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");

    if (path.startsWith("/api/codex/threads?")) return jsonResponse(LIST_RESPONSE, 200);
    if (path.startsWith("/api/codex/thread?")) return jsonResponse(THREAD_RESPONSE, 200);
    if (path.startsWith("/api/codex/interactions?")) {
      return jsonResponse({ interactions: [], connectionEpoch: "epoch", activityRevision: 8 }, 200);
    }
    if (path.startsWith("/api/codex/events?")) {
      return jsonResponse({
        changed: true,
        connectionEpoch: "epoch",
        revision: 12,
        resyncRequired: false,
        reasons: ["thread"],
      }, 200);
    }
    if (path === "/api/codex/threads/new") return jsonResponse(THREAD_MUTATION_RESPONSE, 201);
    if (path === "/api/codex/turns/send") return jsonResponse(TURN_MUTATION_RESPONSE, 202);
    if (path === "/api/codex/turns/interrupt") return jsonResponse(TURN_MUTATION_RESPONSE, 200);
    if (path === "/api/codex/interactions/respond") {
      return jsonResponse(INTERACTION_MUTATION_RESPONSE, 200);
    }
    return jsonResponse(THREAD_MUTATION_RESPONSE, 200);
  }, async () => {
    await listCodexThreads({
      archived: false,
      cursor: "next-page",
      limit: 25,
      search: "pasta night",
    });
    await readCodexThread("thread-1");
    await listCodexInteractions({ threadId: "thread-1" });
    await newCodexThread({ requestId: "request-new", expectedSelectionRevision: 4 });
    await selectCodexThread({
      requestId: "request-select",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
    });
    await archiveCodexThread({
      requestId: "request-archive",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
    });
    await sendCodexTurn({
      requestId: "request-send",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
      clientUserMessageId: "message-1",
      message: "Hello",
    });
    await interruptCodexTurn({
      requestId: "request-interrupt",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
      turnId: "turn-1",
    });
    await respondToCodexInteraction({
      requestId: "request-respond",
      threadId: "thread-1",
      expectedSelectionRevision: 4,
      interactionId: "interaction-1",
      response: {
        kind: "answers",
        answers: [{ questionId: "question-1", answers: ["Yes"] }],
      },
    });
    await waitForCodexEvents({
      connectionEpoch: "epoch",
      afterRevision: 11,
      waitMs: 100,
      threadId: "thread-1",
    });
  });

  assert.deepEqual(requests.map(({ path, method }) => ({ path, method })), [
    {
      path: "/api/codex/threads?archived=false&cursor=next-page&limit=25&search=pasta+night",
      method: "GET",
    },
    { path: "/api/codex/thread?threadId=thread-1", method: "GET" },
    { path: "/api/codex/interactions?threadId=thread-1", method: "GET" },
    { path: "/api/codex/threads/new", method: "POST" },
    { path: "/api/codex/threads/select", method: "POST" },
    { path: "/api/codex/threads/archive", method: "POST" },
    { path: "/api/codex/turns/send", method: "POST" },
    { path: "/api/codex/turns/interrupt", method: "POST" },
    { path: "/api/codex/interactions/respond", method: "POST" },
    {
      path: "/api/codex/events?connectionEpoch=epoch&afterRevision=11&waitMs=100&threadId=thread-1",
      method: "GET",
    },
  ]);
  assert.deepEqual(requests[6].body, {
    requestId: "request-send",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    clientUserMessageId: "message-1",
    message: "Hello",
  });
  assert.deepEqual(requests[8].body, {
    requestId: "request-respond",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    interactionId: "interaction-1",
    response: {
      kind: "answers",
      answers: [{ questionId: "question-1", answers: ["Yes"] }],
    },
  });
});

test("browser client rejects malformed nested success DTOs and a valid DTO at the wrong 2xx status", async () => {
  await withFetch(
    async () => jsonResponse({
      ...LIST_RESPONSE,
      threads: [{
        ...SUMMARY,
        status: { ...SUMMARY.status, nativeFlags: ["waitingOnApproval"] },
      }],
    }, 200),
    async () => {
      await assert.rejects(listCodexThreads(), (error) => {
        assert.ok(error instanceof CodexThreadClientError);
        assert.equal(error.status, 200);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );

  await withFetch(
    async () => jsonResponse(THREAD_MUTATION_RESPONSE, 200),
    async () => {
      await assert.rejects(
        newCodexThread({ requestId: "request-new", expectedSelectionRevision: 4 }),
        (error) => {
          assert.ok(error instanceof CodexThreadClientError);
          assert.equal(error.status, 200);
          assert.equal(error.code, "INVALID_RESPONSE");
          return true;
        },
      );
    },
  );
});

test("browser client accepts only exact failure envelopes", async () => {
  await withFetch(
    async () => jsonResponse({
      error: { code: "SELECTION_CONFLICT", message: "Selection changed." },
    }, 409),
    async () => {
      await assert.rejects(listCodexThreads(), (error) => {
        assert.ok(error instanceof CodexThreadClientError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "SELECTION_CONFLICT");
        assert.equal(error.message, "Selection changed.");
        return true;
      });
    },
  );

  await withFetch(
    async () => jsonResponse({
      error: { code: "SELECTION_CONFLICT", message: "Selection changed.", nativeError: {} },
    }, 409),
    async () => {
      await assert.rejects(listCodexThreads(), (error) => {
        assert.ok(error instanceof CodexThreadClientError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );
});

test("browser client distinguishes unreadable and network responses while preserving AbortError", async () => {
  await withFetch(
    async () => new Response("not json", { status: 200 }),
    async () => {
      await assert.rejects(listCodexThreads(), (error) => {
        assert.ok(error instanceof CodexThreadClientError);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );

  await withFetch(
    async () => {
      throw new Error("connection refused");
    },
    async () => {
      await assert.rejects(listCodexThreads(), (error) => {
        assert.ok(error instanceof CodexThreadClientError);
        assert.equal(error.status, 0);
        assert.equal(error.code, "NETWORK_ERROR");
        return true;
      });
    },
  );

  const fetchAbort = new DOMException("The request was aborted.", "AbortError");
  await withFetch(
    async () => {
      throw fetchAbort;
    },
    async () => {
      await assert.rejects(listCodexThreads(), (error) => error === fetchAbort);
    },
  );

  const bodyAbort = new DOMException("The body was aborted.", "AbortError");
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw bodyAbort;
      },
    }),
    async () => {
      await assert.rejects(listCodexThreads(), (error) => error === bodyAbort);
    },
  );
});
