import assert from "node:assert/strict";
import test from "node:test";

const { nextCodexMessageScrollTop, shouldScrollToLatestCodexMessage } = await import("../app/codex-thread-scroll.ts");

test("aligns a newly added message with the top of the transcript viewport", () => {
  assert.equal(nextCodexMessageScrollTop({
    currentScrollTop: 240,
    scrollHeight: 2_000,
    viewportHeight: 500,
    viewportTop: 100,
    messageTop: 540,
  }), 680);
});

test("never scrolls above the start or beyond the transcript end", () => {
  assert.equal(nextCodexMessageScrollTop({
    currentScrollTop: 60,
    scrollHeight: 2_000,
    viewportHeight: 500,
    viewportTop: 100,
    messageTop: 0,
  }), 0);
  assert.equal(nextCodexMessageScrollTop({
    currentScrollTop: 1_400,
    scrollHeight: 2_000,
    viewportHeight: 500,
    viewportTop: 100,
    messageTop: 700,
  }), 1_500);
});

test("scrolls only for a new message in the already-visible task", () => {
  assert.equal(shouldScrollToLatestCodexMessage(null, { threadId: "task-a", latestMessageId: "assistant-1" }), false);
  assert.equal(shouldScrollToLatestCodexMessage(
    { threadId: "task-a", latestMessageId: "assistant-1" },
    { threadId: "task-a", latestMessageId: "assistant-1" },
  ), false);
  assert.equal(shouldScrollToLatestCodexMessage(
    { threadId: "task-a", latestMessageId: "assistant-1" },
    { threadId: "task-a", latestMessageId: "assistant-2" },
  ), true);
  assert.equal(shouldScrollToLatestCodexMessage(
    { threadId: "task-a", latestMessageId: "assistant-1" },
    { threadId: "task-b", latestMessageId: "assistant-2" },
  ), false);
});
