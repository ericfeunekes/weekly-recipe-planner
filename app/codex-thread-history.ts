import type { CodexThreadSummary } from "../lib/codex-thread-contract.ts";

export function mergeThreadPages(
  current: CodexThreadSummary[],
  incoming: CodexThreadSummary[],
): CodexThreadSummary[] {
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) merged.set(thread.id, thread);
  return [...merged.values()];
}
