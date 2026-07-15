import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activationCoordinatesFromStatus,
  parseActivationVerificationArguments,
  verifyCodexActivation,
} from "../scripts/verify-codex-activation.mjs";
import {
  assertEligibleReleaseCandidateArtifact,
  createReleaseCandidateReleaseArtifact,
  releaseCandidateBindingFromArtifacts,
} from "../scripts/support/codex-release-candidate-contract.mjs";
import {
  createActivationId,
  createReleaseArtifact,
} from "../scripts/support/planner-release-contract.mjs";
import {
  createProductionAuthArtifact,
} from "./support/release-evidence-fixtures.mjs";

const coordinates = Object.freeze({
  canonicalPath: "/tmp/fake-codex",
  version: "codex-dynamic",
  sha256: "a".repeat(64),
  schemaFingerprint: "b".repeat(64),
  userConfigSha256: "c".repeat(64),
  systemConfigSha256: "d".repeat(64),
  systemConfigPathCount: 1,
  instructionSha256: "e".repeat(64),
  accountKind: "chatgpt",
});
const sourceManifest = Object.freeze({
  files: 42,
  bytes: 4_200,
  sha256: "f".repeat(64),
});

function status(evidence = coordinates) {
  return {
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
    cacheHit: false,
    evidence,
    detail: "ready",
  };
}

function completeArtifact(value = coordinates) {
  return {
    schemaVersion: 1,
    completedAt: "2026-07-11T00:00:00.000Z",
    disposition: "compatible_authenticated_release_candidate",
    scenario: "all",
    authenticationMutationPerformedByProbe: false,
    activationCoordinates: value,
    activationCoordinatesRecheckedEqual: true,
    candidateSourceManifest: sourceManifest,
    capabilityEvidence: {
      evaluatedAt: "2026-07-11T00:00:00.000Z",
      rawSchemaBundleSha256: "7".repeat(64),
      researchWebSearchMode: "live",
      researchTools: ["update_plan", "web_search"],
      plannerTools: ["update_plan", "planner"],
      plannerNamespaceMembers: ["read", "preview", "apply"],
      forbiddenHits: [],
      unexpectedRpcMethods: [],
      dependentResultObserved: true,
      outboundPolicyRejected: true,
      permissionProfile: ":read-only",
      effectiveSandbox: "read-only-network-disabled",
      emptyAmbientSurfaces: true,
    },
    scenarios: {
      dependentPlanner: {
        turnIdSha256: "1".repeat(64),
        acceptedEffectCount: 2,
        outcome: "completed_with_effects",
      },
      sourcedRecipe: {
        turnIdSha256: "2".repeat(64),
        acceptedEffectCount: 1,
        outcome: "completed_with_effects",
        sourceKind: "web",
        sourceUrlSha256: "3".repeat(64),
        observedWebSearch: {
          operation: "web_search",
          status: "completed",
          durableTurnIdSha256: "2".repeat(64),
          researchThreadIdSha256: "a".repeat(64),
          researchTurnIdSha256: "b".repeat(64),
          operationIdSha256: "c".repeat(64),
        },
      },
      failureAfterEffect: {
        turnIdSha256: "4".repeat(64),
        acceptedEffectCount: 1,
        outcome: "failed_after_effect",
      },
      recoveryOnly: {
        turnIdSha256: "5".repeat(64),
        acceptedEffectCount: 0,
        outcome: "recovery_completed",
        plannerVersionUnchanged: true,
      },
      secondClientReadback: true,
      globalUds: {
        supportedClient: true,
        applyAccepted: true,
        exactReplay: true,
        changedPayloadRejected: true,
        browserReadback: true,
      },
      incompatibleIndependence: {
        codexState: "incompatible",
        plannerReady: true,
        storeReady: true,
        globalCodexReady: true,
        supportedGlobalClient: true,
        globalApplyAccepted: true,
        browserReadback: true,
        target: {
          updaterLauncherPathSha256: "1".repeat(64),
          canonicalTargetPathSha256: "2".repeat(64),
          dedicatedHomePathSha256: "3".repeat(64),
          fixedCwdPathSha256: "4".repeat(64),
          plannerDataPathSha256: "5".repeat(64),
          targetVersion: "fake-incompatible",
          targetSha256: "8".repeat(64),
          schemaFingerprint: "6".repeat(64),
          configSha256: "a".repeat(64),
          instructionSha256: "b".repeat(64),
          reason: "intentional incompatible fixture",
        },
      },
    },
    dedicatedRuntimeRetention: {
      files: 1,
      bytes: 100,
      credentials: {
        present: true,
        kind: "file",
        ownerUid: process.getuid(),
        mode: 0o600,
        linkCount: 1,
        contentHashed: false,
      },
      classes: {
        state_sqlite: {
          files: 1,
          bytes: 100,
          identitySha256: "c".repeat(64),
        },
      },
      databaseTables: [{
        pathSha256: "d".repeat(64),
        class: "state_sqlite",
        counts: {
          threads: 0,
          thread_dynamic_tools: 0,
          agent_jobs: 0,
          agent_job_items: 0,
          logs: 0,
        },
      }],
      ephemeralCounts: {
        threads: 0,
        thread_dynamic_tools: 0,
        agent_jobs: 0,
        agent_job_items: 0,
      },
      logRows: 0,
    },
  };
}

async function artifact(t, value = coordinates, mutate = (candidate) => candidate) {
  const root = await mkdtemp(join(tmpdir(), "planner-activation-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "release-candidate.json");
  await writeFile(path, `${JSON.stringify(mutate(completeArtifact(value)))}\n`, { mode: 0o600 });
  return path;
}

test("activation verifier has one explicit artifact argument", () => {
  assert.throws(() => parseActivationVerificationArguments([]), /--artifact/);
  assert.throws(() => parseActivationVerificationArguments(["--artifact", "a", "extra"]), /Usage/);
  assert.match(parseActivationVerificationArguments(["--artifact", "a"]).artifact, /\/a$/);
});

test("activation coordinates require every authenticated runtime identity field", () => {
  assert.deepEqual(activationCoordinatesFromStatus(status()), coordinates);
  assert.throws(
    () => activationCoordinatesFromStatus(status({ ...coordinates, accountKind: null })),
    /not authenticated and compatible/,
  );
});

test("activation verifier performs one fresh evaluation and closes the runtime", async (t) => {
  const path = await artifact(t);
  let evaluations = 0;
  let closes = 0;
  let temporaryDataRoot = null;
  const result = await verifyCodexActivation(["--artifact", path], {}, {
    readConfig: (environment) => {
      temporaryDataRoot = environment.PLANNER_DATA_DIR;
      return { codexFollowUp: { ok: false } };
    },
    createRuntime: () => ({
      async evaluate() {
        evaluations += 1;
        return status();
      },
      async close() {
        closes += 1;
      },
    }),
    collectSourceManifest: async () => sourceManifest,
  });
  assert.deepEqual(result, { matched: true });
  assert.equal(evaluations, 1);
  assert.equal(closes, 1);
  assert.equal(typeof temporaryDataRoot, "string");
  assert.equal(temporaryDataRoot.startsWith(await realpath(tmpdir())), true);
  await assert.rejects(lstat(temporaryDataRoot), { code: "ENOENT" });
});

test("activation verifier rejects drift and non-private evidence", async (t) => {
  const path = await artifact(t);
  const dependencies = {
    readConfig: () => ({ codexFollowUp: { ok: false } }),
    createRuntime: () => ({
      async evaluate() {
        return status({ ...coordinates, sha256: "f".repeat(64) });
      },
      async close() {},
    }),
    collectSourceManifest: async () => sourceManifest,
  };
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, dependencies),
    /coordinates changed/,
  );
  await chmod(path, 0o644);
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, dependencies),
    /mode 0600/,
  );
});

test("activation verifier rejects partial RC evidence and post-smoke source drift", async (t) => {
  const partial = await artifact(t, coordinates, (candidate) => {
    delete candidate.scenarios.globalUds;
    return candidate;
  });
  await assert.rejects(
    verifyCodexActivation(["--artifact", partial], {}, {
      readConfig: () => ({ codexFollowUp: { ok: false } }),
      createRuntime: () => ({ evaluate: async () => status(), close: async () => undefined }),
      collectSourceManifest: async () => sourceManifest,
    }),
    /invalid exact contract/,
  );

  const full = await artifact(t);
  await assert.rejects(
    verifyCodexActivation(["--artifact", full], {}, {
      readConfig: () => ({ codexFollowUp: { ok: false } }),
      createRuntime: () => ({ evaluate: async () => status(), close: async () => undefined }),
      collectSourceManifest: async () => ({ ...sourceManifest, sha256: "7".repeat(64) }),
    }),
    /source changed/,
  );
});

test("release-mode verifier binds the canonical stage/install/auth artifact chain", async (t) => {
  const activationId = createActivationId();
  const operatorSha256 = "0".repeat(64);
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      sourceSha256: "1".repeat(64),
      candidateSource: sourceManifest,
    },
  });
  const installed = createReleaseArtifact({
    artifactType: "installed",
    activationId,
    predecessorSha256: stage.sha256,
    projection: { appSha256: "2".repeat(64), operatorSha256 },
  });
  const auth = createProductionAuthArtifact({
    stageArtifact: stage,
    installedArtifact: installed,
    coordinates,
  });
  const releaseBinding = releaseCandidateBindingFromArtifacts(stage, installed, auth);
  const projection = { ...completeArtifact(), releaseBinding, operatorSha256 };
  projection.capabilityEvidence.rawSchemaBundleSha256 =
    auth.projection.schemaBinding.rawSchemaBundleSha256;
  const envelope = createReleaseCandidateReleaseArtifact({
    stageArtifact: stage,
    installedArtifact: installed,
    authLifecycleArtifact: auth,
    projection,
  });
  const root = await mkdtemp(join(tmpdir(), "planner-activation-release-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "release-candidate.json");
  await writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  const dependencies = {
    releaseBinding,
    operatorSha256,
    readConfig: () => ({ codexFollowUp: { ok: false } }),
    createRuntime: () => ({ evaluate: async () => status(), close: async () => undefined }),
    collectSourceManifest: async () => sourceManifest,
  };
  assert.deepEqual(
    await verifyCodexActivation(["--artifact", path], {}, dependencies),
    { matched: true },
  );
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, {
      ...dependencies,
      releaseBinding: undefined,
      operatorSha256: undefined,
    }),
    /binding was not injected/,
  );
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, {
      ...dependencies,
      releaseBinding: { ...releaseBinding, installedSha256: "f".repeat(64) },
    }),
    /binding was not injected or changed/,
  );
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, {
      ...dependencies,
      operatorSha256: "f".repeat(64),
    }),
    /operator identity was not injected or changed/,
  );
});

test("activation eligibility rejects omitted and nonnumeric scenario or retention counts", () => {
  const mutations = [
    (candidate) => { delete candidate.scenarios.dependentPlanner; },
    (candidate) => { candidate.scenarios.dependentPlanner.acceptedEffectCount = "2"; },
    (candidate) => { candidate.scenarios.sourcedRecipe.acceptedEffectCount = undefined; },
    (candidate) => { delete candidate.scenarios.sourcedRecipe.observedWebSearch; },
    (candidate) => {
      candidate.scenarios.sourcedRecipe.observedWebSearch.durableTurnIdSha256 = "f".repeat(64);
    },
    (candidate) => { candidate.dedicatedRuntimeRetention.ephemeralCounts = {}; },
    (candidate) => { delete candidate.dedicatedRuntimeRetention.ephemeralCounts.agent_jobs; },
    (candidate) => { candidate.dedicatedRuntimeRetention.ephemeralCounts.threads = "0"; },
    (candidate) => { candidate.releaseBinding = { activationId: "not-an-id" }; },
  ];
  for (const mutate of mutations) {
    const candidate = completeArtifact();
    mutate(candidate);
    assert.throws(
      () => assertEligibleReleaseCandidateArtifact(candidate),
      /invalid exact contract/,
    );
  }
});
