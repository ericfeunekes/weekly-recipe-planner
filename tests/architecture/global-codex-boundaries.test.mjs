import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("global Codex ingress has no store, browser-router, embedded, TCP, or identity-spoof dependency", () => {
  const router = source("server/global-ingress/router.ts");
  const plannerPort = source("server/global-ingress/planner-port.ts");
  const client = source("scripts/planner-global-client.ts");
  const combinedServer = `${router}\n${plannerPort}`;

  assert.doesNotMatch(combinedServer, /node:sqlite|sqlite-store|DatabaseSync|\.prepare\(|\bSELECT\b|\bINSERT\b/iu);
  assert.doesNotMatch(combinedServer, /application-router|front-controller|InitializedWorkspaceResponse/iu);
  assert.doesNotMatch(combinedServer, /codex-follow-up|embedded-execution|app-server/iu);
  assert.doesNotMatch(client, /node:sqlite|DatabaseSync|\.prepare\(|\bSELECT\b|\bINSERT\b/iu);
  assert.doesNotMatch(client, /\bhostname\b|\bhost\s*:|\bport\s*:|127\.0\.0\.1|localhost:\d|--socket|--target|--endpoint/u);
  assert.doesNotMatch(client, /actorClass|actorSource|admission|transcript|chatTurn|databasePath/iu);
  assert.match(client, /invokeAtSocket\(command, batch, GLOBAL_CODEX_SOCKET_PATH\)/u);
  assert.match(client, /createGlobalCodexClientForHostTesting/u);
  assert.doesNotMatch(client, /PLANNER_GLOBAL_CODEX_(?:SOCKET|PATH)|process\.env\.[A-Z_]*GLOBAL/u);
  assert.match(plannerPort, /operationKind:\s*"global_codex_apply_planner_batch_v1"/u);
  assert.match(plannerPort, /provenance:\s*GLOBAL_CODEX_PROVENANCE/u);
});

test("the route table is closed to exactly three route constants", () => {
  const contract = source("lib/global-codex-contract.ts");
  assert.match(contract, /health:\s*"\/v1\/health"/u);
  assert.match(contract, /workspace:\s*"\/v1\/workspace"/u);
  assert.match(contract, /batches:\s*"\/v1\/planner\/batches"/u);
  assert.equal((contract.match(/"\/v1\//gu) ?? []).length, 3);
});

test("production composition starts global ingress downstream of planner without browser readiness coupling", () => {
  const entrypoint = source("server/index.ts");
  const runtime = source("server/runtime/planner-runtime.ts");
  const apiContract = source("lib/planner-api-contract.ts");
  const packageJson = source("package.json");

  assert.match(entrypoint, /createGlobalCodexIngress\([\s\S]*createGlobalCodexRouter\(createGlobalCodexPlannerPort\(planner\)\)/u);
  assert.match(entrypoint, /globalCodexParentDirectory[\s\S]*createGlobalCodexIngressForTests/u);
  assert.doesNotMatch(entrypoint, /PLANNER_GLOBAL_CODEX_(?:SOCKET|PATH)/u);
  assert.ok(runtime.indexOf("createPlannerApplicationService") < runtime.indexOf("globalCodexIngressFactory(planner)"));
  assert.match(runtime, /const coreReady = storeReady && applicationReady && webReady/u);
  assert.doesNotMatch(runtime.match(/const coreReady[^;]+/u)?.[0] ?? "", /globalCodex/u);
  assert.match(apiContract, /globalCodex: GlobalCodexHealth/u);
  assert.match(packageJson, /"planner:global": "node --disable-warning=ExperimentalWarning --experimental-strip-types scripts\/planner-global-client\.ts"/u);
});
