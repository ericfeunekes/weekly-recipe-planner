import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseProbeArguments,
  runProbe,
  writePrivateProbeArtifact,
} from "../scripts/probe-codex-follow-up.mjs";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";

test("operator arguments require an explicit no-auth artifact target", () => {
  assert.throws(() => parseProbeArguments([]), /--no-auth/);
  assert.throws(() => parseProbeArguments(["--no-auth"]), /--output/);
  assert.throws(() => parseProbeArguments(["--no-auth", "--output", "a", "extra"]), /Unsupported/);
  assert.equal(parseProbeArguments(["--no-auth", "--output", "artifact.json"]).noAuth, true);
});

test("private artifact publication is atomic and never clobbers a concurrent winner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-codex-operator-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "artifact.json");
  const results = await Promise.allSettled([
    writePrivateProbeArtifact(output, { writer: "a" }),
    writePrivateProbeArtifact(output, { writer: "b" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /Refusing to overwrite/);
  assert.match((await readFile(output, "utf8")), /"writer": "[ab]"/);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("supported operator probe writes only a private redacted no-auth artifact", async (t) => {
  const fixture = await createCodexRuntimeFixture({ authenticated: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const output = join(fixture.root, "operator", "current-binary.json");
  const result = await runProbe(["--no-auth", "--output", output], fixture.environment);
  assert.equal(result.output, output);

  const metadata = await stat(output);
  assert.equal(metadata.mode & 0o777, 0o600);
  const text = await readFile(output, "utf8");
  const artifact = JSON.parse(text);
  assert.equal(artifact.disposition, "compatible_inactive_unauthenticated");
  assert.equal(artifact.active, false);
  assert.equal(artifact.authenticated, false);
  assert.equal(artifact.protocolCompatible, true);
  assert.equal(artifact.permissions.profile, ":read-only");
  assert.equal(artifact.permissions.effectiveSandbox, "read-only-network-disabled");
  assert.equal(artifact.manifests.researchWebSearchMode, "live");
  assert.equal(artifact.observed.researchWebSearchMode, "live");
  assert.deepEqual(artifact.observed.forbiddenHits, []);
  assert.equal(artifact.negativeCapabilities.outboundDangerousRpcRejected, true);
  assert.deepEqual(artifact.capabilityReadback.mcpServerNames, []);
  assert.deepEqual(artifact.capabilityReadback.appNames, []);
  assert.deepEqual(artifact.capabilityReadback.pluginNames, []);
  assert.equal(artifact.normalAuthUnchanged, true);
  for (const secret of [
    fixture.environment.PLANNER_SECRET_SENTINEL,
    fixture.environment.OPENAI_API_KEY,
    "auth.json",
  ]) {
    assert.equal(text.includes(secret), false);
  }

  await assert.rejects(
    runProbe(["--no-auth", "--output", output], fixture.environment),
    /Refusing to overwrite/,
  );
});
