import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_EVENT_WAIT_MS_MAX,
  CODEX_MESSAGE_MAX_LENGTH,
  CODEX_THREAD_API_ROUTES,
  CODEX_THREAD_LIST_LIMIT_MAX,
  isCodexArchiveThreadRequest,
  isCodexEventsRequest,
  isCodexInteractionListRequest,
  isCodexInterruptTurnRequest,
  isCodexNewThreadRequest,
  isCodexRespondInteractionRequest,
  isCodexSelectThreadRequest,
  isCodexSendTurnRequest,
  isCodexThreadListRequest,
  isCodexThreadReadRequest,
} from "../lib/codex-thread-contract.ts";

test("Codex wrapper routes are distinct static same-origin API paths", () => {
  assert.deepEqual(CODEX_THREAD_API_ROUTES, {
    threadsList: { method: "GET", path: "/api/codex/threads" },
    threadRead: { method: "GET", path: "/api/codex/thread" },
    threadNew: { method: "POST", path: "/api/codex/threads/new" },
    threadSelect: { method: "POST", path: "/api/codex/threads/select" },
    threadArchive: { method: "POST", path: "/api/codex/threads/archive" },
    turnSend: { method: "POST", path: "/api/codex/turns/send" },
    turnInterrupt: { method: "POST", path: "/api/codex/turns/interrupt" },
    interactionsList: { method: "GET", path: "/api/codex/interactions" },
    interactionRespond: { method: "POST", path: "/api/codex/interactions/respond" },
    events: { method: "GET", path: "/api/codex/events" },
  });
  assert.equal(
    new Set(Object.values(CODEX_THREAD_API_ROUTES).map(({ method, path }) => `${method} ${path}`)).size,
    Object.keys(CODEX_THREAD_API_ROUTES).length,
  );
});

test("thread list and read requests enforce exact keys and bounds", () => {
  assert.equal(isCodexThreadListRequest({}), true);
  assert.equal(isCodexThreadListRequest({
    archived: false,
    cursor: "next-page",
    limit: CODEX_THREAD_LIST_LIMIT_MAX,
    search: "pasta",
  }), true);
  assert.equal(isCodexThreadListRequest({ limit: 0 }), false);
  assert.equal(isCodexThreadListRequest({ limit: CODEX_THREAD_LIST_LIMIT_MAX + 1 }), false);
  assert.equal(isCodexThreadListRequest({ cursor: "" }), false);
  assert.equal(isCodexThreadListRequest({ hidden: true }), false);

  assert.equal(isCodexThreadReadRequest({ threadId: "thread-1" }), true);
  assert.equal(isCodexThreadReadRequest({ threadId: "" }), false);
  assert.equal(isCodexThreadReadRequest({ threadId: "thread-1", includeTurns: true }), false);
});

test("thread lifecycle mutation requests reject stale-shape and extra-field variants", () => {
  assert.equal(isCodexNewThreadRequest({
    requestId: "new-1",
    expectedSelectionRevision: 0,
  }), true);
  assert.equal(isCodexNewThreadRequest({
    requestId: "new-1",
    expectedSelectionRevision: -1,
  }), false);

  assert.equal(isCodexSelectThreadRequest({
    requestId: "select-1",
    threadId: "thread-1",
    expectedSelectionRevision: 2,
  }), true);
  assert.equal(isCodexSelectThreadRequest({
    requestId: "clear-1",
    threadId: null,
    expectedSelectionRevision: 2,
  }), true);
  assert.equal(isCodexSelectThreadRequest({
    requestId: "select-1",
    threadId: "thread-1",
    expectedSelectionRevision: 2,
    force: true,
  }), false);

  assert.equal(isCodexArchiveThreadRequest({
    requestId: "archive-1",
    threadId: "thread-1",
    expectedSelectionRevision: 3,
  }), true);
  assert.equal(isCodexArchiveThreadRequest({
    requestId: "archive-1",
    threadId: "thread-1",
  }), false);
});

test("send leaves native start-versus-steer selection to the backend", () => {
  const start = {
    requestId: "send-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    clientUserMessageId: "client-message-1",
    message: "Plan dinner for Friday.",
  };
  assert.equal(isCodexSendTurnRequest(start), true);
  assert.equal(isCodexSendTurnRequest({ ...start, expectedTurnId: "turn-active" }), false);
  assert.equal(isCodexSendTurnRequest({ ...start, message: "" }), false);
  assert.equal(isCodexSendTurnRequest({ ...start, requestId: "send\0hidden" }), false);
  assert.equal(isCodexSendTurnRequest({ ...start, message: "x".repeat(CODEX_MESSAGE_MAX_LENGTH + 1) }), false);
  assert.equal(isCodexSendTurnRequest({ ...start, cwd: "/private/path" }), false);

  assert.equal(isCodexInterruptTurnRequest({
    requestId: "interrupt-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    turnId: "turn-1",
  }), true);
  assert.equal(isCodexInterruptTurnRequest({
    requestId: "interrupt-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    turnId: null,
  }), false);
  assert.equal(isCodexInterruptTurnRequest({
    requestId: "interrupt-1",
    threadId: "thread-1",
    turnId: "turn-1",
  }), false);
});

test("interaction responses accept bounded user answers and never approval decisions", () => {
  assert.equal(isCodexInteractionListRequest({}), true);
  assert.equal(isCodexInteractionListRequest({ threadId: "thread-1" }), true);
  assert.equal(isCodexInteractionListRequest({ includeRaw: true }), false);

  assert.equal(isCodexRespondInteractionRequest({
    requestId: "answer-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    interactionId: "interaction-1",
    response: {
      kind: "answers",
      answers: [{ questionId: "meal", answers: ["Tacos"] }],
    },
  }), true);
  assert.equal(isCodexRespondInteractionRequest({
    requestId: "approval-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    interactionId: "interaction-2",
    response: { kind: "decision", decision: "decline" },
  }), false);
  assert.equal(isCodexRespondInteractionRequest({
    requestId: "answer-many-values",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    interactionId: "interaction-1",
    response: {
      kind: "answers",
      answers: [{ questionId: "meal", answers: ["Tacos", "Soup"] }],
    },
  }), false);
  assert.equal(isCodexRespondInteractionRequest({
    requestId: "answer-without-selection",
    interactionId: "interaction-1",
    response: {
      kind: "answers",
      answers: [{ questionId: "meal", answers: ["Tacos"] }],
    },
  }), false);
  assert.equal(isCodexRespondInteractionRequest({
    requestId: "answer-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    interactionId: "interaction-1",
    response: {
      kind: "answers",
      answers: [
        { questionId: "meal", answers: ["Tacos"] },
        { questionId: "meal", answers: ["Soup"] },
      ],
    },
  }), false);
  assert.equal(isCodexRespondInteractionRequest({
    requestId: "answer-1",
    threadId: "thread-1",
    expectedSelectionRevision: 4,
    interactionId: "interaction-1",
    response: {
      kind: "answers",
      answers: [{ questionId: "meal", answers: ["Tacos"], secret: "raw" }],
    },
  }), false);
});

test("event long-poll requests use a bounded revision cursor and wait", () => {
  assert.equal(isCodexEventsRequest({ connectionEpoch: null, afterRevision: 0 }), true);
  assert.equal(isCodexEventsRequest({
    connectionEpoch: "connection-1",
    afterRevision: 10,
    waitMs: CODEX_EVENT_WAIT_MS_MAX,
    threadId: "thread-1",
  }), true);
  assert.equal(isCodexEventsRequest({ connectionEpoch: "connection-1", afterRevision: -1 }), false);
  assert.equal(isCodexEventsRequest({
    connectionEpoch: "connection-1",
    afterRevision: 10,
    waitMs: CODEX_EVENT_WAIT_MS_MAX + 1,
  }), false);
  assert.equal(isCodexEventsRequest({ afterRevision: 10 }), false);
  assert.equal(isCodexEventsRequest({
    connectionEpoch: "connection-1",
    afterRevision: 10,
    rawFrames: true,
  }), false);
});
