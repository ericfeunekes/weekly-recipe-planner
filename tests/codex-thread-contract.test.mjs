import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_API_ERROR_MESSAGE_MAX_LENGTH,
  CODEX_DISPLAY_TEXT_MAX_LENGTH,
  CODEX_EVENT_WAIT_MS_MAX,
  CODEX_INTERACTIONS_MAX,
  CODEX_INTERACTION_HEADER_MAX_BYTES,
  CODEX_MESSAGE_MAX_LENGTH,
  CODEX_MESSAGE_ATTACHMENTS_MAX,
  CODEX_REASONING_SUMMARIES_MAX,
  CODEX_THREAD_API_ROUTES,
  CODEX_THREAD_LIST_LIMIT_MAX,
  CODEX_THREAD_TURNS_MAX,
  CODEX_TURN_ITEMS_MAX,
  CODEX_WORKERS_PER_ITEM_MAX,
  isCodexActivityItem,
  isCodexApiFailure,
  isCodexArchiveThreadRequest,
  isCodexEventsResponse,
  isCodexEventsRequest,
  isCodexInteraction,
  isCodexInteractionListResponse,
  isCodexInteractionListRequest,
  isCodexInteractionMutationResponse,
  isCodexMessageAttachment,
  isCodexMessageItem,
  isCodexInterruptTurnRequest,
  isCodexNewThreadRequest,
  isCodexPendingUserInputInteraction,
  isCodexReasoningItem,
  isCodexRejectedApprovalInteraction,
  isCodexRespondInteractionRequest,
  isCodexSelectThreadRequest,
  isCodexSendTurnRequest,
  isCodexThreadItemView,
  isCodexThreadListResponse,
  isCodexThreadListRequest,
  isCodexThreadMutationResponse,
  isCodexThreadReadResponse,
  isCodexThreadReadRequest,
  isCodexThreadStatus,
  isCodexThreadSummary,
  isCodexThreadView,
  isCodexTurnMutationResponse,
  isCodexTurnView,
  isCodexWorkerActivityItem,
  isCodexWorkerState,
  isCodexWorkerSummary,
} from "../lib/codex-thread-contract.ts";

const STATUS = { state: "active", waitingFor: "user_input" };
const SUMMARY = {
  id: "thread-1",
  title: "Dinner planning",
  preview: "Plan dinner for Friday.",
  status: STATUS,
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
  recencyAtMs: 2_000,
};
const MESSAGE_ITEM = {
  kind: "message",
  id: "item-message",
  role: "assistant",
  phase: "commentary",
  text: "I am checking the pantry.",
  clientUserMessageId: null,
  attachments: [{ kind: "image", label: "Image" }],
};
const REASONING_ITEM = {
  kind: "reasoning",
  id: "item-reasoning",
  label: "Thinking",
  summaries: ["Comparing two meal options."],
};
const ACTIVITY_ITEM = {
  kind: "activity",
  id: "item-activity",
  category: "plan",
  label: "Making a plan",
  detail: "Use the vegetables already on hand.",
  status: "completed",
};
const WORKER_ITEM = {
  kind: "worker",
  id: "item-worker",
  label: "Starting a background worker",
  operation: "start",
  workerThreadIds: ["worker-1"],
  workerStates: [{ threadId: "worker-1", status: "running" }],
  status: "running",
};
const TURN = {
  id: "turn-1",
  status: "in_progress",
  itemsView: "full",
  startedAtMs: 2_000,
  completedAtMs: null,
  durationMs: 500,
  errorMessage: null,
  items: [MESSAGE_ITEM, REASONING_ITEM, ACTIVITY_ITEM, WORKER_ITEM],
};
const THREAD = {
  ...SUMMARY,
  threadKind: "conversation",
  parentThreadId: null,
  turns: [TURN],
  workers: [{ threadId: "worker-1", label: "Background worker", status: "running" }],
  historyTruncated: false,
};
const USER_INPUT_INTERACTION = {
  id: "interaction-1",
  kind: "user_input",
  threadId: "thread-1",
  title: "Codex needs your input",
  createdAtMs: 2_500,
  turnId: "turn-1",
  itemId: "item-input",
  questions: [{
    id: "meal",
    header: "Friday dinner",
    question: "Which dinner should I add?",
    options: [
      { label: "Tacos", description: "A quick vegetarian taco dinner." },
      { label: "Soup", description: "A make-ahead lentil soup." },
    ],
    allowOther: false,
    responseMode: "listed_option",
  }],
  autoResolveAtMs: null,
};
const APPROVAL_INTERACTION = {
  id: "interaction-2",
  kind: "approval",
  threadId: "thread-1",
  title: "Capability blocked",
  createdAtMs: 2_600,
  turnId: "turn-1",
  itemId: "item-command",
  category: "command",
  summary: "Codex requested a command that the planner does not expose.",
  resolution: "rejected_by_policy",
};

function clone(value) {
  return structuredClone(value);
}

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

test("display DTO validators recurse through every item, attachment, worker, and interaction discriminator", () => {
  assert.equal(isCodexThreadStatus(STATUS), true);
  assert.equal(isCodexThreadStatus({ ...STATUS, waitingFor: "filesystem" }), false);
  assert.equal(isCodexThreadStatus({ ...STATUS, rawStatus: "waitingOnUserInput" }), false);
  assert.equal(isCodexThreadSummary(SUMMARY), true);

  for (const attachment of [
    { kind: "image", label: "Image" },
    { kind: "skill", label: "Planner" },
    { kind: "mention", label: "Recipe note" },
  ]) {
    assert.equal(isCodexMessageAttachment(attachment), true);
  }
  assert.equal(isCodexMessageAttachment({ kind: "path", label: "/private/menu.md" }), false);

  assert.equal(isCodexMessageItem(MESSAGE_ITEM), true);
  assert.equal(isCodexReasoningItem(REASONING_ITEM), true);
  assert.equal(isCodexActivityItem(ACTIVITY_ITEM), true);
  assert.equal(isCodexWorkerState(WORKER_ITEM.workerStates[0]), true);
  assert.equal(isCodexWorkerActivityItem(WORKER_ITEM), true);
  for (const item of [MESSAGE_ITEM, REASONING_ITEM, ACTIVITY_ITEM, WORKER_ITEM]) {
    assert.equal(isCodexThreadItemView(item), true);
  }
  assert.equal(isCodexThreadItemView({ ...ACTIVITY_ITEM, kind: "commandExecution" }), false);
  assert.equal(isCodexMessageItem({ ...MESSAGE_ITEM, text: "x".repeat(CODEX_DISPLAY_TEXT_MAX_LENGTH + 1) }), false);
  assert.equal(isCodexMessageItem({
    ...MESSAGE_ITEM,
    attachments: Array(CODEX_MESSAGE_ATTACHMENTS_MAX + 1).fill(MESSAGE_ITEM.attachments[0]),
  }), false);
  assert.equal(isCodexReasoningItem({
    ...REASONING_ITEM,
    summaries: Array(CODEX_REASONING_SUMMARIES_MAX + 1).fill("summary"),
  }), false);
  assert.equal(isCodexWorkerActivityItem({
    ...WORKER_ITEM,
    workerThreadIds: ["worker-1", "worker-2"],
  }), false);
  assert.equal(isCodexWorkerActivityItem({
    ...WORKER_ITEM,
    workerThreadIds: Array.from(
      { length: CODEX_WORKERS_PER_ITEM_MAX + 1 },
      (_, index) => `worker-${index}`,
    ),
  }), false);

  assert.equal(isCodexTurnView(TURN), true);
  assert.equal(isCodexTurnView({ ...TURN, status: "cancelled" }), false);
  assert.equal(isCodexTurnView({
    ...TURN,
    items: Array(CODEX_TURN_ITEMS_MAX + 1).fill(ACTIVITY_ITEM),
  }), false);
  assert.equal(isCodexWorkerSummary(THREAD.workers[0]), true);
  assert.equal(isCodexThreadView(THREAD), true);
  assert.equal(isCodexThreadView({ ...THREAD, threadKind: "worker", parentThreadId: null }), false);
  assert.equal(isCodexThreadView({
    ...THREAD,
    turns: Array(CODEX_THREAD_TURNS_MAX + 1).fill(TURN),
  }), false);

  assert.equal(isCodexPendingUserInputInteraction(USER_INPUT_INTERACTION), true);
  assert.equal(isCodexRejectedApprovalInteraction(APPROVAL_INTERACTION), true);
  assert.equal(isCodexInteraction(USER_INPUT_INTERACTION), true);
  assert.equal(isCodexInteraction(APPROVAL_INTERACTION), true);
  assert.equal(isCodexInteraction({ ...USER_INPUT_INTERACTION, kind: "secret_input" }), false);
  assert.equal(isCodexPendingUserInputInteraction({
    ...USER_INPUT_INTERACTION,
    questions: [{
      ...USER_INPUT_INTERACTION.questions[0],
      header: "é".repeat(Math.floor(CODEX_INTERACTION_HEADER_MAX_BYTES / 2) + 1),
    }],
  }), false);
  assert.equal(isCodexPendingUserInputInteraction({
    ...USER_INPUT_INTERACTION,
    questions: [{
      ...USER_INPUT_INTERACTION.questions[0],
      allowOther: true,
    }],
  }), false);
  assert.equal(isCodexPendingUserInputInteraction({
    ...USER_INPUT_INTERACTION,
    questions: [{
      ...USER_INPUT_INTERACTION.questions[0],
      options: [
        USER_INPUT_INTERACTION.questions[0].options[0],
        USER_INPUT_INTERACTION.questions[0].options[0],
      ],
    }],
  }), false);
  assert.equal(isCodexRejectedApprovalInteraction({
    ...APPROVAL_INTERACTION,
    decision: "allow",
  }), false);
});

test("all seven success envelopes require exact keys, bounded values, and nested DTO validity", () => {
  const list = {
    threads: [SUMMARY],
    nextCursor: "next-page",
    selection: { threadId: "thread-1", revision: 4 },
    connectionEpoch: "epoch-1",
    activityRevision: 8,
  };
  const read = {
    thread: THREAD,
    selection: list.selection,
    interactions: [USER_INPUT_INTERACTION, APPROVAL_INTERACTION],
    connectionEpoch: "epoch-1",
    activityRevision: 8,
  };
  const interactions = {
    interactions: [USER_INPUT_INTERACTION, APPROVAL_INTERACTION],
    connectionEpoch: "epoch-1",
    activityRevision: 8,
  };
  const threadMutation = {
    thread: SUMMARY,
    selection: list.selection,
    connectionEpoch: "epoch-1",
    activityRevision: 9,
  };
  const turnMutation = {
    threadId: "thread-1",
    turnId: "turn-2",
    connectionEpoch: "epoch-1",
    activityRevision: 10,
  };
  const interactionMutation = {
    interactionId: "interaction-1",
    status: "resolved",
    connectionEpoch: "epoch-1",
    activityRevision: 11,
  };
  const events = {
    changed: true,
    connectionEpoch: "epoch-1",
    revision: 12,
    resyncRequired: false,
    reasons: ["thread", "interaction"],
  };

  const validatorsAndValues = [
    [isCodexThreadListResponse, list],
    [isCodexThreadReadResponse, read],
    [isCodexInteractionListResponse, interactions],
    [isCodexThreadMutationResponse, threadMutation],
    [isCodexTurnMutationResponse, turnMutation],
    [isCodexInteractionMutationResponse, interactionMutation],
    [isCodexEventsResponse, events],
  ];
  for (const [validator, value] of validatorsAndValues) {
    assert.equal(validator(value), true);
    assert.equal(validator({ ...value, nativeFrame: {} }), false);
    const missing = clone(value);
    delete missing.connectionEpoch;
    assert.equal(validator(missing), false);
  }

  assert.equal(isCodexThreadListResponse({
    ...list,
    threads: Array(CODEX_THREAD_LIST_LIMIT_MAX + 1).fill(SUMMARY),
  }), false);
  assert.equal(isCodexThreadReadResponse({
    ...read,
    thread: {
      ...THREAD,
      turns: [{ ...TURN, items: [{ ...MESSAGE_ITEM, rawContent: [] }] }],
    },
  }), false);
  assert.equal(isCodexInteractionListResponse({
    ...interactions,
    interactions: Array(CODEX_INTERACTIONS_MAX + 1).fill(APPROVAL_INTERACTION),
  }), false);
  assert.equal(isCodexThreadMutationResponse({ ...threadMutation, thread: null }), true);
  assert.equal(isCodexTurnMutationResponse({ ...turnMutation, turnId: "" }), false);
  assert.equal(isCodexInteractionMutationResponse({
    ...interactionMutation,
    status: "pending",
  }), false);
  assert.equal(isCodexEventsResponse({ ...events, reasons: ["thread", "thread"] }), false);
  assert.equal(isCodexEventsResponse({ ...events, reasons: ["filesystem"] }), false);
});

test("Codex failure envelopes are closed over error code, message, and exact keys", () => {
  const failure = { error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable." } };
  assert.equal(isCodexApiFailure(failure), true);
  assert.equal(isCodexApiFailure({ ...failure, retryAfterMs: 1_000 }), false);
  assert.equal(isCodexApiFailure({ error: { ...failure.error, cause: "ECONNREFUSED" } }), false);
  assert.equal(isCodexApiFailure({ error: { code: "NETWORK_ERROR", message: "No route." } }), false);
  assert.equal(isCodexApiFailure({ error: { code: "NOT_FOUND", message: "" } }), false);
  assert.equal(isCodexApiFailure({
    error: { code: "INTERNAL_ERROR", message: "x".repeat(CODEX_API_ERROR_MESSAGE_MAX_LENGTH + 1) },
  }), false);
});
