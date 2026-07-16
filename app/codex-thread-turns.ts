import type { CodexThreadView } from "../lib/codex-thread-contract.ts";

export function selectInterruptibleTurnId(thread: CodexThreadView | null): string | null {
  if (thread?.threadKind !== "conversation" || thread.status.state !== "active") return null;
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    if (thread.turns[index]?.status === "in_progress") return thread.turns[index].id;
  }
  return null;
}
