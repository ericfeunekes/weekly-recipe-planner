import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_LABEL_DEBOUNCE_MS,
  selectCodexActivityLabel,
  shouldFlushCodexActivityLabel,
} from "../app/codex-thread-activity.ts";
import { mergeThreadPages } from "../app/codex-thread-history.ts";
import { selectInterruptibleTurnId } from "../app/codex-thread-turns.ts";
import {
  createCodexThreadSource,
  isDevelopmentCodexPreview,
} from "../app/codex-thread-source.ts";

function thread(items, status = { state: "active", waitingFor: null }) {
  return {
    id: "thread-1",
    title: "Task",
    preview: "Task preview",
    status,
    createdAtMs: null,
    updatedAtMs: null,
    recencyAtMs: null,
    threadKind: "conversation",
    parentThreadId: null,
    historyTruncated: false,
    workers: [],
    turns: [{
      id: "turn-1",
      status: "in_progress",
      itemsView: "full",
      startedAtMs: null,
      completedAtMs: null,
      durationMs: null,
      errorMessage: null,
      items,
    }],
  };
}

function taskSummary(id, title) {
  return {
    id,
    title,
    preview: `${title} preview`,
    status: { state: "idle", waitingFor: null },
    createdAtMs: null,
    updatedAtMs: null,
    recencyAtMs: null,
  };
}

test("paged task history retains prior rows and deduplicates overlap", () => {
  const first = [taskSummary("a", "First"), taskSummary("b", "Second")];
  const second = [taskSummary("b", "Second updated"), taskSummary("c", "Third")];
  const merged = mergeThreadPages(first, second);
  assert.deepEqual(merged.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(merged[1].title, "Second updated");
});

test("activity presentation shows the newest native activity as the single progress line", () => {
  const result = selectCodexActivityLabel(thread([
    { kind: "worker", id: "worker", label: "Worker label", operation: "activity", workerThreadIds: [], workerStates: [], status: "running" },
    { kind: "activity", id: "old", category: "plan", label: "Old label", detail: null, status: "running" },
    { kind: "activity", id: "new", category: "web", label: "New label", detail: "not visible", status: "running" },
  ]));
  assert.equal(result, "New label");
  assert.equal(ACTIVITY_LABEL_DEBOUNCE_MS, 400);
});

test("activity presentation ignores worker labels and flushes user-input or terminal state", () => {
  const workerOnly = thread([
    { kind: "worker", id: "worker", label: "Checking sources", operation: "activity", workerThreadIds: ["child"], workerStates: [], status: "running" },
  ]);
  assert.equal(selectCodexActivityLabel(workerOnly), null);
  assert.equal(shouldFlushCodexActivityLabel({ waitingForUserInput: true, thread: workerOnly }), true);
  const terminal = thread([
    { kind: "activity", id: "done", category: "plan", label: "Done", detail: null, status: "completed" },
  ]);
  assert.equal(shouldFlushCodexActivityLabel({ waitingForUserInput: false, thread: terminal }), true);
});

test("interrupt presentation targets only the newest in-progress conversation turn", () => {
  const active = thread([]);
  active.turns = [
    { ...active.turns[0], id: "older-turn", status: "in_progress" },
    { ...active.turns[0], id: "completed-turn", status: "completed" },
    { ...active.turns[0], id: "newest-turn", status: "in_progress" },
  ];
  assert.equal(selectInterruptibleTurnId(active), "newest-turn");

  const terminal = thread([], { state: "idle", waitingFor: null });
  terminal.turns[0].status = "completed";
  assert.equal(selectInterruptibleTurnId(terminal), null);
  assert.equal(selectInterruptibleTurnId({ ...active, turns: active.turns.map((turn) => ({ ...turn, status: "completed" })) }), null);
  assert.equal(selectInterruptibleTurnId({ ...active, threadKind: "worker" }), null);
  assert.equal(selectInterruptibleTurnId(null), null);
});

test("preview source is explicit development-only and cannot fabricate a sent message or answer", async () => {
  assert.equal(isDevelopmentCodexPreview("?codexPreview=1", true), "default");
  assert.equal(isDevelopmentCodexPreview("?codexPreview=1", false), null);
  const source = createCodexThreadSource({ search: "?codexPreview=1", development: true });
  const before = await source.load();
  assert.equal(before.mode, "preview");
  assert.equal(before.thread?.turns[0]?.items.filter((item) => item.kind === "message").length, 1);
  const approval = before.interactions.find((interaction) => interaction.kind === "approval");
  assert.deepEqual(approval && {
    category: approval.category,
    resolution: approval.resolution,
    hasDecision: "decision" in approval,
  }, { category: "command", resolution: "rejected_by_policy", hasDecision: false });
  await assert.rejects(source.send("Please send this"), /Preview does not send/);
  await assert.rejects(source.answer("fixture-question", { kind: "answers", answers: [] }), /Preview does not submit/);
  const after = await source.load();
  assert.deepEqual(after.thread?.turns, before.thread?.turns);
});

test("preview rail fixture exercises paged history, search, archive, and worker drill-down", async () => {
  const source = createCodexThreadSource({ search: "?codexPreview=1", development: true });
  const initial = await source.load();

  const firstPage = await source.list({ limit: 25 });
  assert.deepEqual(firstPage.threads.map((thread) => thread.title), ["Friday dinner", "Grocery list"]);
  assert.equal(firstPage.nextCursor, "preview:1");
  const secondPage = await source.list({ cursor: firstPage.nextCursor, limit: 25 });
  assert.deepEqual(secondPage.threads.map((thread) => thread.title), ["Grocery list", "Weekend prep"]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(new Set([...firstPage.threads, ...secondPage.threads].map((thread) => thread.id)).size, 3);

  const search = await source.list({ search: "grocery" });
  assert.deepEqual(search.threads.map((thread) => thread.title), ["Grocery list"]);
  const archivedBefore = await source.list({ archived: true });
  assert.deepEqual(archivedBefore.threads.map((thread) => thread.title), ["Archived meal ideas"]);

  const workerId = initial.thread?.workers[0]?.threadId;
  assert.equal(workerId, "worker-friday-options");
  const worker = await source.readWorker(workerId);
  assert.equal(worker.thread.threadKind, "worker");
  assert.equal(worker.thread.parentThreadId, initial.selection.threadId);
  assert.equal(worker.selection.threadId, initial.selection.threadId);
  assert.match(worker.thread.turns[0]?.items[0]?.kind === "message" ? worker.thread.turns[0].items[0].text : "", /Friday slot/);

  await source.archive("grocery-question");
  const activeAfter = await source.list({ search: "grocery" });
  assert.deepEqual(activeAfter.threads, []);
  const archivedAfter = await source.list({ archived: true, search: "grocery" });
  assert.deepEqual(archivedAfter.threads.map((thread) => thread.title), ["Grocery list"]);
});

test("production source ignores preview query and begins as native", () => {
  const source = createCodexThreadSource({ search: "?codexPreview=1", development: false });
  assert.equal(source.mode, "native");
});

function nativeThread() {
  return thread([{
    kind: "message", id: "message-1", role: "user", phase: "commentary", text: "Hello", clientUserMessageId: "client-1", attachments: [],
  }]);
}

function threadSummary(value) {
  const {
    id,
    title,
    preview,
    status,
    createdAtMs,
    updatedAtMs,
    recencyAtMs,
  } = value;
  return { id, title, preview, status, createdAtMs, updatedAtMs, recencyAtMs };
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

test("a healthy empty catalogue creates nothing until the first nonblank native send", async () => {
  const calls = [];
  let listReads = 0;
  const loadedThread = nativeThread();
  await withFetch(async (path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET" });
    if (path === "/api/codex/threads") {
      listReads += 1;
      const selected = listReads > 1;
      return new Response(JSON.stringify({
        threads: selected ? [threadSummary(loadedThread)] : [],
        nextCursor: null,
        selection: { threadId: selected ? "thread-1" : null, revision: selected ? 3 : 2 },
        connectionEpoch: "epoch", activityRevision: listReads,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(path).startsWith("/api/codex/thread?")) {
      return new Response(JSON.stringify({ thread: loadedThread, selection: { threadId: "thread-1", revision: 3 }, interactions: [], connectionEpoch: "epoch", activityRevision: 4 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/api/codex/threads/new") {
      return new Response(JSON.stringify({ thread: threadSummary(loadedThread), selection: { threadId: "thread-1", revision: 3 }, connectionEpoch: "epoch", activityRevision: 2 }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/api/codex/turns/send") {
      return new Response(JSON.stringify({ threadId: "thread-1", turnId: "turn-1", connectionEpoch: "epoch", activityRevision: 5 }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    const empty = await source.load();
    assert.equal(empty.status, "empty");
    assert.deepEqual(calls, [{ path: "/api/codex/threads", method: "GET" }]);
    const sent = await source.send("Hello");
    assert.equal(sent.status, "ready");
  });
  assert.equal(calls.filter((call) => call.path === "/api/codex/threads/new").length, 1);
  assert.equal(calls.filter((call) => call.path === "/api/codex/turns/send").length, 1);
});

test("a missing selected task keeps native history available without cached conversation text", async () => {
  await withFetch(async (path) => {
    if (path === "/api/codex/threads") {
      return new Response(JSON.stringify({
        threads: [{ id: "thread-1", title: "Old task", preview: "Old preview", status: { state: "idle", waitingFor: null }, createdAtMs: null, updatedAtMs: null, recencyAtMs: null }],
        nextCursor: null, selection: { threadId: "thread-1", revision: 8 }, connectionEpoch: "epoch", activityRevision: 9,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Task missing" } }), { status: 404, headers: { "Content-Type": "application/json" } });
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    const snapshot = await source.load();
    assert.equal(snapshot.status, "selected_unavailable");
    assert.equal(snapshot.thread, null);
    assert.equal(snapshot.threads[0].title, "Old task");
  });
});
