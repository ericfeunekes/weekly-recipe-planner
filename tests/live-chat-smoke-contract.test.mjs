import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createLiveSmokeGlobalEndpoint,
  createLiveChatFailureReceipt,
  createLiveSmokeRoot,
  deriveNativeObservationEvidence,
  liveChatFailureArtifactPath,
  parseLiveChatSmokeArguments,
  writePrivateLiveChatArtifact,
} from "../scripts/smoke-live-chat.mjs";
import { createGlobalCodexIngressForTests } from "../server/global-ingress/index.ts";
import { acquireRuntimeOwnershipLease } from "../scripts/support/runtime-ownership.mjs";

test("live smoke canonicalizes its configured disposable root", async (t) => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "planner-live-smoke-root-")));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const target = join(fixture, "target");
  const alias = join(fixture, "alias");
  await mkdir(target);
  await symlink(target, alias, "dir");

  const root = await createLiveSmokeRoot({ TMPDIR: alias });
  assert.equal(root, await realpath(root));
  assert.equal(dirname(root), target);
});

test("live smoke allocates Global UDS paths below the macOS byte limit", async (t) => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "planner-live-smoke-uds-")));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const longTempRoot = join(fixture, "x".repeat(120));
  const fallbackTempRoot = join(fixture, "short");
  await Promise.all([mkdir(longTempRoot), mkdir(fallbackTempRoot)]);

  const endpoint = await createLiveSmokeGlobalEndpoint("release", {
    tempDirectory: longTempRoot,
    fallbackTempDirectory: fallbackTempRoot,
  });
  t.after(() => endpoint.close());

  assert.equal(Buffer.byteLength(endpoint.socketPath, "utf8") <= 103, true);
  assert.equal(Buffer.byteLength(endpoint.runtimeOwnerSocketPath, "utf8") <= 103, true);
  assert.equal(endpoint.parentDirectory.startsWith(await realpath(fallbackTempRoot)), true);
  assert.equal((await stat(endpoint.parentDirectory)).mode & 0o777, 0o700);

  const ingress = await createGlobalCodexIngressForTests(
    (_request, response) => response.writeHead(204).end(),
    endpoint.parentDirectory,
  );
  t.after(() => ingress.close());
  assert.deepEqual(ingress.readStatus(), { status: "ready" });

  const lease = await acquireRuntimeOwnershipLease({
    socketPath: endpoint.runtimeOwnerSocketPath,
  });
  t.after(() => lease.close());
  assert.equal((await stat(lease.socketPath)).isSocket(), true);
});

test("authenticated native Codex smoke grammar is closed and explicit", () => {
  assert.throws(() => parseLiveChatSmokeArguments([]), /--authorized/);
  assert.throws(
    () => parseLiveChatSmokeArguments(["--authorized", "--scenario", "all"]),
    /--output/,
  );
  assert.throws(
    () => parseLiveChatSmokeArguments([
      "--authorized", "--scenario", "planner", "--output", "proof.json",
    ]),
    /--scenario all/,
  );
  assert.throws(
    () => parseLiveChatSmokeArguments([
      "--authorized", "--scenario", "all", "--output", "proof.json", "extra",
    ]),
    /Unsupported/,
  );
  assert.throws(
    () => parseLiveChatSmokeArguments([
      "--authorized", "--scenario", "all", "--output", "proof.json",
    ]),
    /outputs\/qa/,
  );
  const parsed = parseLiveChatSmokeArguments([
    "--authorized",
    "--scenario",
    "all",
    "--output",
    "outputs/qa/run-id/codex-follow-up/release-candidate.json",
  ]);
  assert.equal(parsed.authorized, true);
  assert.equal(parsed.scenario, "all");
  assert.equal(parsed.output.endsWith("release-candidate.json"), true);

  const releaseOutput = "/tmp/home/meal-planner/releases/activation/release-candidate.json";
  const releaseParsed = parseLiveChatSmokeArguments([
    "--authorized",
    "--scenario",
    "all",
    "--output",
    releaseOutput,
  ], {
    isOutputAllowed: (path) => path === releaseOutput,
    outputError: "derived receipt only",
  });
  assert.equal(releaseParsed.output, releaseOutput);
  assert.throws(
    () => parseLiveChatSmokeArguments([
      "--authorized",
      "--scenario",
      "all",
      "--output",
      "/tmp/wrong.json",
    ], {
      isOutputAllowed: (path) => path === releaseOutput,
      outputError: "derived receipt only",
    }),
    /derived receipt only/,
  );
});

test("native Codex smoke evidence is private, bounded, and refuses overwrite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-live-smoke-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "proof.json");
  await writePrivateLiveChatArtifact(output, { disposition: "test" });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { disposition: "test" });
  await assert.rejects(
    writePrivateLiveChatArtifact(output, { disposition: "overwrite" }),
    /EEXIST/,
  );
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
  await assert.rejects(
    writePrivateLiveChatArtifact(join(root, "too-large.json"), {
      value: "x".repeat(70 * 1_024),
    }),
    /byte limit/,
  );
});

test("native Codex smoke failure receipts are private and do not retain exception text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-live-smoke-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "release-candidate.json");
  const failurePath = liveChatFailureArtifactPath(output);
  const receipt = createLiveChatFailureReceipt({
    phase: "native_release_scenarios",
    error: new Error("token=should-not-be-persisted"),
  });
  await writePrivateLiveChatArtifact(failurePath, receipt);
  assert.equal((await stat(failurePath)).mode & 0o777, 0o600);
  const payload = await readFile(failurePath, "utf8");
  assert.doesNotMatch(payload, /should-not-be-persisted/);
  assert.deepEqual(JSON.parse(payload), {
    schemaVersion: 1,
    artifactType: "release-candidate-failure",
    failedAt: receipt.failedAt,
    phase: "native_release_scenarios",
    errorFingerprintSha256: receipt.errorFingerprintSha256,
  });
  assert.equal(liveChatFailureArtifactPath(output), failurePath);
});

test("native release observation evidence requires an assistant response and completed worker readback", () => {
  const observed = {
    assistantMessage: { kind: "message", role: "assistant" },
    workerSummary: { threadId: "worker-1", status: "completed" },
    workerReadback: {
      thread: {
        id: "worker-1",
        threadKind: "worker",
        parentThreadId: "parent-1",
      },
    },
    parentThreadId: "parent-1",
  };
  assert.deepEqual(deriveNativeObservationEvidence(observed), {
    assistantMessageObserved: true,
    worker: {
      childReadback: true,
      workerCompleted: true,
    },
  });

  for (const mutate of [
    (value) => { delete value.assistantMessage; },
    (value) => { value.workerSummary.status = "failed"; },
    (value) => { value.workerReadback.thread.parentThreadId = "other-parent"; },
  ]) {
    const changed = structuredClone(observed);
    mutate(changed);
    assert.throws(
      () => deriveNativeObservationEvidence(changed),
      /omitted its assistant response or completed worker readback/,
    );
  }
});

test("release smoke uses native thread HTTP and the final configured runtime", async () => {
  const source = await readFile(new URL("../scripts/smoke-live-chat.mjs", import.meta.url), "utf8");
  assert.match(source, /startConfiguredPlannerRuntime/);
  assert.match(source, /activationCoordinatesFromStatus\(await runtime\.evaluate\(\)\)/);
  assert.doesNotMatch(source, /activationCoordinatesFromStatus\(runtime\.readCodexStatus\(\)\)/);
  assert.match(source, /createCodexRuntimeFixture/);
  assert.match(source, /status\.state !== "incompatible"/);
  assert.match(source, /createHostOnlyGlobalClientRunner/);
  assert.match(source, /globalCodexParentDirectory/);
  assert.match(source, /createLiveSmokeGlobalEndpoint\("live"\)/);
  assert.match(source, /createLiveSmokeGlobalEndpoint\("incompatible"\)/);
  assert.match(source, /MACOS_UNIX_SOCKET_PATH_BYTES/);
  assert.match(source, /PLANNER_RUNTIME_OWNER_SOCKET/);
  assert.doesNotMatch(source, /PLANNER_GLOBAL_CODEX_(?:SOCKET|PATH)/u);
  assert.match(source, /readObservedCapabilityProjection/);
  assert.match(source, /runNativeReleaseScenarios/);
  assert.match(source, /CODEX_THREAD_API_ROUTES\.threadNew/);
  assert.match(source, /CODEX_THREAD_API_ROUTES\.turnSend/);
  assert.match(source, /CODEX_THREAD_API_ROUTES\.threadArchive/);
  assert.match(source, /collectNativeReleaseRuntimeRetention/);
  assert.match(source, /native_codex_authenticated_release_candidate/);
  assert.match(source, /schemaVersion: NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION/);
  assert.doesNotMatch(source, /researchEvidenceObserver|researchKind|sourced_recipe/);
  assert.doesNotMatch(source, /snapshotStableNormalCodexInputs|normalCodexState|normalAuthUnchanged/);
  assert.match(source, /isReleaseCandidateBinding/);
  assert.match(source, /releaseBinding/);
  assert.match(source, /createBoundReleaseCandidateArtifact/);
  assert.match(source, /derived release-candidate receipt path/);
  assert.match(source, /collectCandidateSourceManifest/);
  assert.match(source, /assertEligibleReleaseCandidateArtifact/);
  assert.doesNotMatch(source, /bridge\/app-server-client|createCodexPlannerAdapter|startPlannerRuntime/);
});
