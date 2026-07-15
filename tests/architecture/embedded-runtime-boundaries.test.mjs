import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("dynamic runtime owns transport only and cannot reach planner persistence or raw process spawn", async () => {
  const dynamicSession = await source("server/runtime/codex-follow-up/dynamic-session.ts");
  assert.doesNotMatch(dynamicSession, /server\/store|sqlite-store|node:sqlite|openPlannerStore/);
  assert.doesNotMatch(dynamicSession, /import \{[^}]*\bspawn\b|\bspawn\(/s);
  assert.match(dynamicSession, /CodexAppServerExecutionProvider/);
  assert.equal((dynamicSession.match(/\.spawnAppServer\(/g) ?? []).length, 1);
  assert.doesNotMatch(dynamicSession, /CodexAppServerClient|bridge\/app-server-client/);
});

test("chat-owned embedded dispatcher uses the one Phase2 kernel without importing SQLite", async () => {
  const embedded = await source("server/chat/embedded-service.ts");
  assert.doesNotMatch(embedded, /sqlite-store|node:sqlite|openPlannerStore/);
  assert.equal((embedded.match(/\.applyPlannerOperations\(/g) ?? []).length, 1);
  assert.match(embedded, /operationKind: EMBEDDED_OPERATION_KIND/);
  assert.match(embedded, /requestId = `embedded-tool:\$\{this\.#householdTurnId\}:\$\{identity\.toolCallId\}`/);
});

test("production exposes one managed dynamic chat path and no legacy selector", async () => {
  const [router, runtime, composition, chatIndex] = await Promise.all([
    source("server/http/application-router.ts"),
    source("server/runtime/planner-runtime.ts"),
    source("server/index.ts"),
    source("server/chat/index.ts"),
  ]);
  assert.doesNotMatch(router, /embedded-service|InactiveEmbeddedChatHarness|planner\/apply/);
  assert.match(runtime, /createManagedEmbeddedChatApplicationService/);
  assert.match(composition, /createFailSoftManagedCodexFollowUpRuntime/);
  assert.doesNotMatch(`${runtime}\n${composition}\n${chatIndex}`, /CodexPlannerAdapter|createChatApplicationService|createInactiveEmbedded|legacy fallback/i);
});

test("research and planner sessions cannot co-expose live search and planner tools", async () => {
  const [researchSession, dynamicSession] = await Promise.all([
    source("server/runtime/codex-follow-up/research-session.ts"),
    source("server/runtime/codex-follow-up/dynamic-session.ts"),
  ]);
  assert.match(researchSession, /RESEARCH_MODEL_VISIBLE_TOOLS = Object\.freeze\(\[\s*"update_plan",\s*"web_search",?\s*\]\)/);
  assert.match(researchSession, /dynamicTools: \[\]/);
  assert.match(researchSession, /web_search: "live"/);
  assert.doesNotMatch(researchSession, /PLANNER_DYNAMIC_TOOL_NAMESPACE|planner-tool-contract/);

  assert.match(
    dynamicSession,
    /dynamicTools: mode === "normal" \? \[PLANNER_DYNAMIC_TOOL_NAMESPACE\] : \[\]/,
  );
  assert.match(dynamicSession, /web_search: "disabled"/);
  assert.doesNotMatch(dynamicSession, /RESEARCH_MODEL_VISIBLE_TOOLS|web_search: "live"/);
});

test("the full research candidate travels only as a dedicated untrusted user input item", async () => {
  const [dynamicSession, embeddedService, researchSession] = await Promise.all([
    source("server/runtime/codex-follow-up/dynamic-session.ts"),
    source("server/chat/embedded-service.ts"),
    source("server/runtime/codex-follow-up/research-session.ts"),
  ]);
  assert.doesNotMatch(`${dynamicSession}\n${embeddedService}\n${researchSession}`, /additionalContext/);

  const lockedParams = dynamicSession.slice(
    dynamicSession.indexOf("function lockedThreadParams"),
    dynamicSession.indexOf("export class RestrictedDynamicPlannerSession"),
  );
  assert.notEqual(lockedParams.length, 0);
  assert.doesNotMatch(lockedParams, /candidate|researchCandidate/);
  assert.match(lockedParams, /baseInstructions: mode === "normal"/);
  assert.match(lockedParams, /developerInstructions: mode === "normal"/);
  assert.match(
    dynamicSession,
    /input: \[\s*\{ type: "text", text: request\.prompt, text_elements: \[\] \},\s*\.\.\.\(researchCandidateInput === null\s*\? \[\]\s*: \[\{ type: "text", text: researchCandidateInput, text_elements: \[\] \}\]\),\s*\]/,
  );
  assert.match(
    embeddedService,
    /researchCandidateJson: JSON\.stringify\(plannerPrepared\.candidate\)/,
  );
  const plannerPrompt = embeddedService.slice(
    embeddedService.indexOf("export function buildEmbeddedPlannerPrompt"),
    embeddedService.indexOf("export function buildEmbeddedResearchPrompt"),
  );
  assert.notEqual(plannerPrompt.length, 0);
  assert.doesNotMatch(plannerPrompt, /candidate|researchCandidate/);
});

test("recovery has an empty dynamic manifest while normal uses exactly the planner namespace", async () => {
  const dynamicSession = await source("server/runtime/codex-follow-up/dynamic-session.ts");
  assert.match(
    dynamicSession,
    /dynamicTools: mode === "normal" \? \[PLANNER_DYNAMIC_TOOL_NAMESPACE\] : \[\]/,
  );
  assert.match(dynamicSession, /RECOVERY_MODEL_VISIBLE_TOOLS = Object\.freeze\(\["update_plan"\]\)/);
  assert.match(dynamicSession, /NORMAL_MODEL_VISIBLE_TOOLS = Object\.freeze\(\["update_plan", "planner"\]\)/);
});

test("the dynamic terminal owner is an explicit state machine and the runtime permission profile is unambiguous", async () => {
  const dynamicSession = await source("server/runtime/codex-follow-up/dynamic-session.ts");
  assert.match(dynamicSession, /decideDynamicTerminalTransition/);
  assert.doesNotMatch(dynamicSession, /terminalStarted/);
  assert.match(dynamicSession, /let terminalState: DynamicTerminalState = "open"/);
  assert.equal((dynamicSession.match(/terminalState\s*=(?!=)/g) ?? []).length, 1);
  assert.match(dynamicSession, /permissions: ":read-only"/);
  assert.doesNotMatch(dynamicSession, /sandbox: "read-only"/);
});

test("planner call persistence exposes one per-call completion mutation path", async () => {
  const [ports, store] = await Promise.all([
    source("server/application/ports.ts"),
    source("server/store/sqlite-store.ts"),
  ]);
  assert.equal((ports.match(/completePlannerToolCall\(/g) ?? []).length, 1);
  assert.equal((store.match(/\n  completePlannerToolCall\(/g) ?? []).length, 1);
  assert.equal((store.match(/UPDATE planner_tool_calls/g) ?? []).length, 1);
  assert.doesNotMatch(ports, /abandonRunningPlannerToolCalls/);
  assert.doesNotMatch(store, /abandonRunningPlannerToolCalls/);
});

test("the sole embedded chat service delegates durable submit and retry to one coordinator", async () => {
  const [embeddedService, lifecycle] = await Promise.all([
    source("server/chat/embedded-service.ts"),
    source("server/chat/lifecycle.ts"),
  ]);
  assert.match(embeddedService, /new DurableChatLifecycleCoordinator\(options\)/);
  assert.doesNotMatch(embeddedService, /#guardSubmit|#guardRetry|#resolveReceipt|#storeAccepted/);
  assert.equal((lifecycle.match(/\.insertRunningTurn\(/g) ?? []).length, 2);
  assert.equal((lifecycle.match(/\.interruptRunningTurns\(/g) ?? []).length, 1);
  assert.match(embeddedService, /priorTurn\.mode === "recovery"/);
  assert.match(
    embeddedService,
    /priorTurn\.recoveryOfTurnId \?\? priorTurn\.turnId/,
  );
});
