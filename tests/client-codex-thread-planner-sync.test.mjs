import assert from "node:assert/strict";
import test from "node:test";

const {
  completedPlannerApplyActivityKeys,
  hasNewCompletedPlannerApply,
} = await import("../app/codex-thread-planner-sync.ts");

function thread(items) {
  return {
    id: "thread-1",
    title: "Task",
    preview: "Task preview",
    status: { state: "idle", waitingFor: null },
    createdAtMs: null,
    updatedAtMs: null,
    recencyAtMs: null,
    threadKind: "conversation",
    parentThreadId: null,
    historyTruncated: false,
    workers: [],
    turns: [{
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      startedAtMs: null,
      completedAtMs: null,
      durationMs: null,
      errorMessage: null,
      items,
    }],
  };
}

test("refreshes the workspace only after a completed native planner apply", () => {
  const applying = thread([
    { kind: "activity", id: "apply", category: "tool", label: "Updating the planner", detail: null, status: "running" },
    { kind: "activity", id: "preview", category: "tool", label: "Checking planner changes", detail: null, status: "completed" },
  ]);
  assert.deepEqual(completedPlannerApplyActivityKeys(applying), []);

  const completed = thread([
    { kind: "activity", id: "apply", category: "tool", label: "Updating the planner", detail: null, status: "completed" },
  ]);
  const keys = completedPlannerApplyActivityKeys(completed);
  assert.deepEqual(keys, ["turn-1:apply"]);
  assert.equal(hasNewCompletedPlannerApply(new Set(), keys), true);
  assert.equal(hasNewCompletedPlannerApply(new Set(keys), keys), false);
});
