import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("production exposes native Codex threads without composing the historical chat service", async () => {
  const [router, runtime, composition] = await Promise.all([
    source("server/http/application-router.ts"),
    source("server/runtime/planner-runtime.ts"),
    source("server/index.ts"),
  ]);
  assert.doesNotMatch(router, /embedded-service|planner-chat-contract|ChatApplicationService|\/api\/chat|\/api\/transcript|planner\/apply/);
  assert.doesNotMatch(runtime, /create(?:Managed)?EmbeddedChatApplicationService|from "\.\.\/chat|chatDependencies/);
  assert.match(runtime, /createNativeCodexThreadService/);
  assert.match(composition, /createFailSoftManagedCodexFollowUpRuntime/);
  assert.doesNotMatch(`${runtime}\n${composition}`, /CodexPlannerAdapter|createChatApplicationService|createInactiveEmbedded|legacy fallback/i);
});
