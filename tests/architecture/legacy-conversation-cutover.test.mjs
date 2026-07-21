import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AUTHORITY_OPERATION_KINDS } from "../../app/authority-operation-journal.ts";
import { CODEX_THREAD_API_ROUTES } from "../../lib/codex-thread-contract.ts";
import { PLANNER_API_ROUTES } from "../../lib/planner-api-contract.ts";

async function source(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("production route, client, runtime, and journal surfaces contain no legacy conversation ingress", async () => {
  assert.deepEqual(Object.keys(PLANNER_API_ROUTES).sort(), [
    "bootstrap",
    "commands",
    "export",
    "health",
    "history",
    "preview",
    "undo",
    "workspace",
  ]);
  assert.deepEqual(AUTHORITY_OPERATION_KINDS, ["planner", "bootstrap", "undo"]);
  assert.equal(CODEX_THREAD_API_ROUTES.threadsList.path, "/api/codex/threads");
  assert.equal(CODEX_THREAD_API_ROUTES.turnSend.path, "/api/codex/turns/send");

  const [runtime, router, client, journal, apiContract] = await Promise.all([
    source("server/runtime/planner-runtime.ts"),
    source("server/http/application-router.ts"),
    source("app/planner-api.ts"),
    source("app/authority-operation-journal.ts"),
    source("lib/planner-api-contract.ts"),
  ]);
  const liveSurface = `${runtime}\n${router}\n${client}\n${journal}\n${apiContract}`;
  assert.doesNotMatch(liveSurface, /\/api\/chat\/(?:submit|retry)|\/api\/transcript/);
  assert.doesNotMatch(client, /submitChatTurn|retryChatTurn|readTranscriptPage/);
  assert.doesNotMatch(journal, /chat-submit|chat-retry/);
  assert.doesNotMatch(runtime, /create(?:Managed)?EmbeddedChatApplicationService|from "\.\.\/chat|chatDependencies/);
  assert.doesNotMatch(router, /planner-chat-contract|ChatApplicationService|dependencies\.chat/);
});

test("legacy persistence and import/export compatibility types remain outside live routing", async () => {
  const [apiContract, store] = await Promise.all([
    source("lib/planner-api-contract.ts"),
    source("server/store/sqlite-store.ts"),
  ]);
  assert.match(apiContract, /LegacyV2Payload/);
  assert.match(apiContract, /transcriptEntries: TranscriptEntry\[\]/);
  assert.match(apiContract, /chatTurns: ChatTurn\[\]/);
  assert.match(store, /readTranscriptPage/);
});
