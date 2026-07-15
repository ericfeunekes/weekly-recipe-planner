import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../server/runtime/codex-follow-up/", import.meta.url);
const files = [
  "deployment.ts",
  "launcher.ts",
  "resource-policy.ts",
  "compatibility.ts",
  "capability-probe.ts",
  "readiness.ts",
  "index.ts",
];

async function sources() {
  return Promise.all(files.map(async (file) => ({
    file,
    source: await readFile(new URL(file, root), "utf8"),
  })));
}

test("managed Codex runtime cannot import planner mutation, store, chat, bridge, or browser authority", async () => {
  for (const { file, source } of await sources()) {
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:application\/planner-service|server\/store|\/store\/|sqlite|server\/chat|\/chat\/|bridge|planner-api-contract|browser|playwright)[^"']*["']/,
      `${file} imports an authority outside the managed runtime boundary`,
    );
  }
});

test("public seam exposes status and the fixed app-server lease, not a command or generic RPC runner", async () => {
  const index = await readFile(new URL("index.ts", root), "utf8");
  assert.match(index, /CodexAppServerExecutionProvider/);
  assert.match(index, /CompatibleCodexExecution/);
  assert.doesNotMatch(index, /spawnAcceptedCodexProcess|runAcceptedCodexProcess|JsonlRpcClient/);

  const launcher = await readFile(new URL("launcher.ts", root), "utf8");
  assert.match(launcher, /spawnAppServer/);
  assert.match(launcher, /CODEX_APP_SERVER_ARGUMENTS/);
  assert.doesNotMatch(launcher, /process\.env\.(?:CODEX|PLANNER).*BIN|PLANNER_CODEX_(?:BIN|COMMAND|LAUNCHER)/);
});

test("release authentication consumes the identity-bound app-server capability", async () => {
  const [authLifecycle, authReadiness, releaseComposition] = await Promise.all([
    readFile(new URL("../../scripts/support/codex-auth-lifecycle.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/support/codex-auth-readiness.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/support/planner-release-composition.mjs", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(authLifecycle, /from\s+["']node:child_process["']/);
  assert.doesNotMatch(authLifecycle, /\blauncherPath\b|\bspawnProcess\b/);
  assert.match(authLifecycle, /executionProvider/);
  assert.match(authLifecycle, /executionProvider\.spawnAppServer/);
  assert.doesNotMatch(authReadiness, /account\/login|account\/logout|onDeviceCode/);
  assert.match(authReadiness, /CODEX_AUTH_READINESS_REQUEST_METHODS/);
  assert.match(authReadiness, /"initialize"[\s\S]*"account\/read"/);
  assert.match(authReadiness, /refreshToken: true/);
  assert.match(authReadiness, /acceptLoginCompletionNotifications: false/);
  assert.match(releaseComposition, /createCompatibleCodexExecution/);
  assert.match(releaseComposition, /executionProvider/);
  assert.match(releaseComposition, /runCodexAuthReadiness/);
  assert.doesNotMatch(releaseComposition, /runCodexAuthLifecycle|onDeviceCode|selectedLoginType/);

  const activationProjection = releaseComposition.slice(
    releaseComposition.indexOf("async activationProjection"),
    releaseComposition.indexOf("async createRestoreAppEffect"),
  );
  assert.match(activationProjection, /inspectDedicatedAgentReadiness/);
  assert.doesNotMatch(
    activationProjection,
    /inspectReleaseTreeIdentity\(effectContext\.layout\.agentRoot\)/,
  );
});

test("production launcher is HOME-derived and the subsystem never reads the normal Codex home", async () => {
  const deployment = await readFile(new URL("deployment.ts", root), "utf8");
  assert.match(deployment, /join\(normalHome, "\.local", "bin", "codex"\)/);
  assert.doesNotMatch(deployment, /PLANNER_CODEX_(?:BIN|COMMAND|LAUNCHER)/);
  for (const { file, source } of await sources()) {
    assert.doesNotMatch(source, /(?:~\/\.codex|join\([^\n]*normalHome[^\n]*["']\.codex["'])/, `${file} reads normal ~/.codex`);
  }
});

test("release evidence records dedicated credentials as metadata only", async () => {
  const source = await readFile(
    new URL("../../scripts/support/codex-live-proof.mjs", import.meta.url),
    "utf8",
  );
  const retention = source.slice(
    source.indexOf("export async function collectDedicatedRuntimeRetention"),
    source.indexOf("export async function collectCandidateSourceManifest"),
  );
  assert.match(retention, /category !== "auth"/);
  assert.match(retention, /credential\.contentSha256 !== null/);
  assert.match(retention, /contentHashed: false/);
});

test("capability probe registers the exact production three-tool planner namespace", async () => {
  const probe = await readFile(new URL("capability-probe.ts", root), "utf8");
  assert.match(probe, /PLANNER_DYNAMIC_TOOL_NAMESPACE/);
  assert.match(probe, /dynamicTools: \[PLANNER_DYNAMIC_TOOL_NAMESPACE\]/);
  assert.match(probe, /isPlannerPreviewArguments/);
  assert.match(probe, /isPlannerApplyArguments/);
  assert.doesNotMatch(probe, /PLANNER_PROBE_NAMESPACE/);
  assert.doesNotMatch(probe, /schedule_recipe|create_recipe|plannerService|sqlite/);
  assert.match(probe, /request\("command\/exec"/);
  assert.match(probe, /outside the fixed allowlist/);
  assert.match(probe, /permissions: ":read-only"/);
  assert.doesNotMatch(probe, /sandbox: "read-only"/);
  assert.match(probe, /Object\.hasOwn\(hostedSearch, "index_gated_web_access"\)/);
  assert.match(probe, /Object\.hasOwn\(hostedSearch, "indexed_web_access"\)/);
  assert.match(probe, /plannerNamespace/);
});
