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
    schemaVersion: 2,
    completedAt: "2026-07-11T00:00:00.000Z",
    disposition: "native_codex_authenticated_release_candidate",
    scenario: "native_threads",
    authenticationMutationPerformedByProbe: false,
    activationCoordinates: value,
    activationCoordinatesRecheckedEqual: true,
    candidateSourceManifest: sourceManifest,
    capabilityEvidence: {
      evaluatedAt: "2026-07-11T00:00:00.000Z",
      rawSchemaBundleSha256: "7".repeat(64),
      threadSource: "weekly_recipe_planner",
      hostedWebSearchMode: "live",
      topLevelTools: [
        "update_plan", "request_user_input", "spawn_agent", "send_message",
        "followup_task", "wait_agent", "interrupt_agent", "list_agents",
        "skills", "planner", "web_search",
      ],
      workerTools: [
        "update_plan", "request_user_input", "spawn_agent", "send_message",
        "followup_task", "wait_agent", "interrupt_agent", "list_agents",
        "skills", "web_search",
      ],
      skillsNamespaceMembers: ["list", "read"],
      plannerNamespaceMembers: ["read", "preview", "apply"],
      standaloneSkillCount: 1,
      standaloneSkillIdentitySha256: "1".repeat(64),
      forbiddenHits: [],
      unexpectedRpcMethods: [],
      plannerReadObserved: true,
      workerWaitCallObserved: true,
      workerWaitResultObserved: true,
      workerResultObserved: true,
      userInputRoundTripObserved: true,
      dependentResultObserved: true,
      outboundPolicyRejected: true,
      approvalPolicy: "never",
      permissionProfile: ":read-only",
      effectiveSandbox: "read-only-network-disabled",
      emptyAmbientSurfaces: true,
    },
    scenarios: {
      nativeHistory: {
        threadSource: "weekly_recipe_planner",
        createdTopLevelThreadCount: 2,
        primaryThreadIdSha256: "1".repeat(64),
        archivedThreadIdSha256: "2".repeat(64),
        paginationObserved: true,
        selectionObserved: true,
        restartReadback: true,
        archivedAbsentFromActive: true,
        archivedPresentInHistory: true,
      },
      nativeTurn: {
        threadIdSha256: "1".repeat(64),
        turnIdSha256: "3".repeat(64),
        clientUserMessageIdSha256: "4".repeat(64),
        exactAdmissionReplay: true,
        changedPayloadRejected: true,
        secondClientReadback: true,
        plannerEffect: {
          operation: "move_grocery_items_to_source",
          plannerVersionDelta: 1,
          itemIdentitySha256: "5".repeat(64),
          source: "farm_box",
          ingredientNameSha256: "6".repeat(64),
          authoritativeReadback: true,
        },
        assistantMessageObserved: true,
      },
      interactions: {
        question: {
          interactionIdSha256: "8".repeat(64),
          threadIdSha256: "1".repeat(64),
          turnIdSha256: "9".repeat(64),
          listedOptionRoundTrip: true,
          resolved: true,
        },
      },
      interrupt: {
        threadIdSha256: "2".repeat(64),
        turnIdSha256: "a".repeat(64),
        readbackStatus: "interrupted",
      },
      legacyConversationAbsent: true,
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
          threads: 2,
          thread_dynamic_tools: 0,
          agent_jobs: 0,
          agent_job_items: 0,
          logs: 0,
        },
      }],
      nativeStateCounts: {
        threads: 2,
        thread_dynamic_tools: 0,
        agent_jobs: 0,
        agent_job_items: 0,
      },
      logRows: 0,
    },
  };
}

function verifierConfig() {
  return {
    codexFollowUp: {
      ok: true,
      deployment: { codexHome: "/tmp/native-codex-release-fixture" },
    },
  };
}

async function currentCapability() {
  return completeArtifact().capabilityEvidence;
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
      return verifierConfig();
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
    readCapabilityProjection: currentCapability,
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
    readConfig: verifierConfig,
    createRuntime: () => ({
      async evaluate() {
        return status({ ...coordinates, sha256: "f".repeat(64) });
      },
      async close() {},
    }),
    readCapabilityProjection: currentCapability,
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
      readConfig: verifierConfig,
      createRuntime: () => ({ evaluate: async () => status(), close: async () => undefined }),
      readCapabilityProjection: currentCapability,
      collectSourceManifest: async () => sourceManifest,
    }),
    /invalid exact contract/,
  );

  const full = await artifact(t);
  await assert.rejects(
    verifyCodexActivation(["--artifact", full], {}, {
      readConfig: verifierConfig,
      createRuntime: () => ({ evaluate: async () => status(), close: async () => undefined }),
      readCapabilityProjection: currentCapability,
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
    readConfig: verifierConfig,
    createRuntime: () => ({ evaluate: async () => status(), close: async () => undefined }),
    readCapabilityProjection: async () => projection.capabilityEvidence,
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
      releaseBinding: { ...releaseBinding, evidenceSchemaVersion: 1 },
    }),
    /binding was not injected or changed/,
  );
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, {
      ...dependencies,
      readCapabilityProjection: async () => ({
        ...projection.capabilityEvidence,
        standaloneSkillIdentitySha256: "f".repeat(64),
      }),
    }),
    /native thread, worker, skill, web, or planner capability changed/,
  );
  await assert.rejects(
    verifyCodexActivation(["--artifact", path], {}, {
      ...dependencies,
      operatorSha256: "f".repeat(64),
    }),
    /operator identity was not injected or changed/,
  );
});

test("activation eligibility rejects old or malformed native scenario and retention evidence", () => {
  const mutations = [
    (candidate) => { candidate.schemaVersion = 1; },
    (candidate) => { delete candidate.scenarios.nativeHistory; },
    (candidate) => { candidate.scenarios.nativeHistory.createdTopLevelThreadCount = "2"; },
    (candidate) => { candidate.scenarios.nativeTurn.assistantMessageObserved = false; },
    (candidate) => { candidate.dedicatedRuntimeRetention.nativeStateCounts = {}; },
    (candidate) => { delete candidate.dedicatedRuntimeRetention.nativeStateCounts.agent_jobs; },
    (candidate) => { candidate.dedicatedRuntimeRetention.nativeStateCounts.threads = 0; },
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
