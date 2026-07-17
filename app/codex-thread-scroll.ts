export function nextCodexMessageScrollTop(options: {
  currentScrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportTop: number;
  messageTop: number;
}): number {
  const maximumScrollTop = Math.max(0, options.scrollHeight - options.viewportHeight);
  const desiredScrollTop = options.currentScrollTop + (options.messageTop - options.viewportTop);
  return Math.min(maximumScrollTop, Math.max(0, desiredScrollTop));
}

export type CodexScrollCursor = {
  threadId: string;
  latestMessageId: string | null;
};

/**
 * New messages deserve one deterministic alignment. Hydrating a thread,
 * revisiting a thread, activity updates, and streaming text updates do not.
 */
export function shouldScrollToLatestCodexMessage(
  previous: CodexScrollCursor | null,
  next: CodexScrollCursor,
): boolean {
  if (previous === null || previous.threadId !== next.threadId) return false;
  return next.latestMessageId !== null && previous.latestMessageId !== next.latestMessageId;
}
