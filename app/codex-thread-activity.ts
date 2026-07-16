import type { CodexThreadView } from "../lib/codex-thread-contract.ts";

export const ACTIVITY_LABEL_DEBOUNCE_MS = 400;

export function selectCodexActivityLabel(thread: CodexThreadView | null): string | null {
  if (!thread) return null;
  const items = thread.turns.flatMap((turn) => turn.items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "activity" && item.status === "running") return item.label;
  }
  return null;
}

export function shouldFlushCodexActivityLabel(options: {
  waitingForUserInput: boolean;
  thread: CodexThreadView | null;
}): boolean {
  if (options.waitingForUserInput || options.thread?.status.state === "error") return true;
  return options.thread?.turns.some((turn) => turn.items.some((item) =>
    item.kind === "activity" &&
      (item.status === "completed" || item.status === "failed" || item.status === "interrupted")
  )) ?? false;
}
