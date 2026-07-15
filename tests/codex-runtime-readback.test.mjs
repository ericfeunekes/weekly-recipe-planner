import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { readActualCodexDeployment } from "../server/runtime/codex-follow-up/capability-probe.ts";
import {
  buildCodexFollowUpChildEnvironment,
  parseCodexFollowUpConfig,
  validateCodexFollowUpDeployment,
} from "../server/runtime/codex-follow-up/deployment.ts";
import { captureCodexExecutableIdentity } from "../server/runtime/codex-follow-up/launcher.ts";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";

async function readbackFixture(t, variant = "compatible-a") {
  const fixture = await createCodexRuntimeFixture({ variant });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const parsed = parseCodexFollowUpConfig(fixture.environment, fixture.plannerDataDirectory);
  assert.equal(parsed.ok, true);
  const validated = await validateCodexFollowUpDeployment(parsed.deployment);
  assert.equal(validated.ok, true);
  const environment = buildCodexFollowUpChildEnvironment(validated.deployment, fixture.environment);
  const identity = await captureCodexExecutableIdentity(fixture.launcherPath, {
    cwd: fixture.appCwd,
    env: environment,
    timeoutMs: 10_000,
  });
  return readActualCodexDeployment(identity, validated.deployment, {
    sourceEnvironment: fixture.environment,
    timeoutMs: 10_000,
  });
}

test("deployment readback accepts only the dedicated user layer and absent system layer", async (t) => {
  const evidence = await readbackFixture(t);
  assert.deepEqual(Object.keys(evidence.configSourceHashes), ["user:0", "system:1"]);
  assert.equal(evidence.systemConfigPaths.length, 1);
  assert.equal(evidence.instructionSourceHashes["dedicated:0"]?.length, 64);
});

for (const [variant, pattern] of [
  ["config-missing-config", /required config or origins/],
  ["config-missing-origins", /required config or origins/],
  ["config-wrong-shape", /required config or origins/],
  ["origins-wrong-shape", /required config or origins/],
  ["missing-system-layer", /omitted the empty system config layer/],
  ["system-file-wrong-shape", /malformed or duplicate file source/],
  ["system-file-relative", /malformed or duplicate file source/],
  ["system-file-existing", /names an existing file/],
  ["system-config-active", /contains active configuration/],
  ["duplicate-system-layer", /malformed or duplicate file source/],
  ["missing-account-field", /malformed response/],
  ["skill-directory-readback", /non-file or non-canonical skill/],
  ["pagination-malformed-cursor", /malformed cursor/],
  ["pagination-empty-cursor", /malformed cursor/],
  ["pagination-repeated-cursor", /repeated a pagination cursor/],
  ["pagination-too-many-pages", /exceeded its page budget/],
  ["pagination-too-many-rows", /exceeded its row budget/],
  ["rpc-unknown-notification", /undeclared notification/],
  ["rpc-unknown-response-id", /unknown JSON-RPC response id/],
  ["rpc-null-method", /malformed JSON-RPC method/],
  ["rpc-malformed-request-id", /malformed JSON-RPC id/],
  ["rpc-error-notification", /terminal error notification/],
  ["rpc-malformed-error-envelope", /malformed JSON-RPC error envelope/],
  ["rpc-oversized-frame", /oversized(?: unterminated)? JSONL frame/],
  ["rpc-frame-flood", /frame-count budget/],
  ["rpc-queue-flood", /queued-notification budget/],
  ["shutdown-late-notification", /undeclared notification hostile\/late/],
  ["shutdown-late-server-request", /server request during shutdown/],
]) {
  test(`deployment readback fails closed for ${variant}`, async (t) => {
    await assert.rejects(readbackFixture(t, variant), pattern);
  });
}
