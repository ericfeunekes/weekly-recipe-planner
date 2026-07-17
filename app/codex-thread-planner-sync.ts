import type { CodexThreadView } from "../lib/codex-thread-contract.ts";

/**
 * The native thread projection keeps planner-tool arguments and results private,
 * but it does expose the completed, human-safe planner.apply activity.  This is
 * the client-side boundary at which the planner canvas must re-read its
 * authoritative workspace.
 */
export function completedPlannerApplyActivityKeys(thread: CodexThreadView): string[] {
  return thread.turns.flatMap((turn) => turn.items.flatMap((item) =>
    item.kind === "activity" &&
    item.category === "tool" &&
    item.label === "Updating the planner" &&
    item.status === "completed"
      ? [`${turn.id}:${item.id}`]
      : [],
  ));
}

export function hasNewCompletedPlannerApply(
  previousKeys: ReadonlySet<string>,
  currentKeys: readonly string[],
): boolean {
  return currentKeys.some((key) => !previousKeys.has(key));
}
