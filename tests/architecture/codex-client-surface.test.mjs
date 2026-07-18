import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("the live planner composes the native Codex rail instead of the legacy chat panel", async () => {
  const [planner, rail, sourceAdapter, fixture, railStyles] = await Promise.all([
    source("app/planner-client.tsx"),
    source("app/codex-thread-rail.tsx"),
    source("app/codex-thread-source.ts"),
    source("app/codex-thread-fixture.ts"),
    source("app/codex-thread-rail.module.css"),
  ]);
  assert.match(planner, /<CodexThreadRail/);
  assert.doesNotMatch(planner, /<ChatPanel/);
  assert.doesNotMatch(rail, /Research recipe|ChatGPT task|archiveContextWeek|microphone/i);
  assert.match(sourceAdapter, /listCodexThreads/);
  assert.match(sourceAdapter, /status: "empty"/);
  assert.match(sourceAdapter, /status: "selected_unavailable"/);
  assert.match(sourceAdapter, /status: "runtime_unavailable"/);
  assert.match(sourceAdapter, /"selected_unmaterialized"/);
  for (const capability of [
    "list(request?",
    "archive(threadId",
    "interrupt(turnId",
    "refreshInteractions(request?",
    "readWorker(workerThreadId",
    "subscribe(listener",
    "getSnapshot()",
    "start()",
    "stop()",
  ]) {
    assert.equal(sourceAdapter.includes(capability), true, capability);
  }
  assert.doesNotMatch(sourceAdapter, /localStorage|sessionStorage|authority-operation-journal/);
  assert.match(rail, /source\.subscribe\(sync\)/);
  assert.match(rail, /source\.start\(\)/);
  assert.match(rail, /props\.source\.list\(/);
  assert.match(rail, /props\.source\.archive\(/);
  assert.match(rail, /source\.select\(/);
  assert.match(rail, /source\.readWorker\(/);
  assert.doesNotMatch(rail, /item\.kind !== "worker"\)\s*return null/);
  assert.doesNotMatch(rail, /source\.waitForChange/);
  assert.match(sourceAdapter, /if \(!development\) return null/);
  assert.match(fixture, /Preview does not send messages/);
  assert.match(fixture, /Preview does not submit answers/);
  assert.match(rail, /event\.key !== "Enter" \|\| event\.shiftKey/);
  assert.match(rail, /onKeyDown=\{handleComposerKeyDown\}/);
  assert.doesNotMatch(rail, /Start a task with a message\./);
  assert.doesNotMatch(rail, /question\.allowOther/);
  assert.match(rail, /interaction\.kind === "approval"/);
  assert.match(rail, /Approval rejected/);
  assert.match(railStyles, /\.body \{[\s\S]*?flex: 1 1 auto/);
  assert.match(railStyles, /\.composerActions \{[\s\S]*?position: absolute/);
  assert.match(railStyles, /\.composer button \{[\s\S]*?width: 2\.75rem;[\s\S]*?height: 2\.75rem/);
  assert.match(railStyles, /\.threadChoice \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?white-space: normal/);
  assert.match(railStyles, /\.options button \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-wrap: anywhere;[\s\S]*?white-space: normal/);
});
