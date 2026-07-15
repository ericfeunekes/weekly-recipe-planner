import { createHash } from "node:crypto";

import {
  createAuthLifecycleReleaseArtifact,
} from "../../scripts/support/codex-auth-lifecycle.mjs";
import {
  createReleaseCandidateReleaseArtifact,
  releaseCandidateBindingFromArtifacts,
} from "../../scripts/support/codex-release-candidate-contract.mjs";

const FIXTURE_TIME = "2026-07-11T00:00:00.000Z";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function productionAuthProjection({
  activationId,
  stageSha256,
  installedSha256,
  operatorSha256,
  coordinates = {},
} = {}) {
  const canonicalPath = coordinates.canonicalPath ?? "/tmp/fake-codex";
  const schemaFingerprint = coordinates.schemaFingerprint ?? "b".repeat(64);
  const notificationOptOutMethodCount = 0;
  return {
    outcome: "authenticated",
    operatorSha256,
    releaseInputs: {
      activationId,
      stageSha256,
      installedSha256,
    },
    runtimeIdentity: {
      canonicalTargetPathSha256: sha256(canonicalPath),
      executableVersion: coordinates.version ?? "codex-fixture",
      executableSha256: coordinates.sha256 ?? "a".repeat(64),
      schemaFingerprint,
      userConfigSha256: coordinates.userConfigSha256 ?? "c".repeat(64),
      systemConfigSha256: coordinates.systemConfigSha256 ?? "d".repeat(64),
      instructionSha256: coordinates.instructionSha256 ?? "e".repeat(64),
    },
    deploymentReadback: {
      identitySha256: "f".repeat(64),
      standaloneSkillReadbackCompleted: true,
      standaloneSkillCount: 1,
      standaloneSkillIdentitySha256: "1".repeat(64),
      emptyAmbientCapabilitySurfaces: true,
    },
    environment: {
      authReadbackProcessCount: 1,
      realHomeRetained: true,
      dedicatedHomeReadbackCount: 1,
      canonicalApplicationRootRetained: true,
      notificationOptOutMethodCount,
      notificationOptOutMethodsSha256: "2".repeat(64),
    },
    readiness: {
      existingDedicatedCredentialsReused: true,
      freshProcessReadback: true,
      proactiveRefreshReadback: true,
      credentialMutationRequestsAllowed: false,
    },
    account: { kind: "chatgpt" },
    schemaBinding: {
      rawSchemaBundleSha256: "3".repeat(64),
      compatibilitySchemaFingerprint: schemaFingerprint,
      authSchemaFingerprint: "4".repeat(64),
      notificationOptOutMethodCount,
      contractKind: "authenticatedReadback",
    },
  };
}

export function releaseCandidateProjection({
  stageArtifact,
  installedArtifact,
  authLifecycleArtifact,
  coordinates = {},
} = {}) {
  const auth = authLifecycleArtifact.projection;
  const canonicalPath = coordinates.canonicalPath ?? "/tmp/fake-codex";
  return {
    schemaVersion: 1,
    completedAt: FIXTURE_TIME,
    disposition: "compatible_authenticated_release_candidate",
    scenario: "all",
    authenticationMutationPerformedByProbe: false,
    activationCoordinates: {
      canonicalPath,
      version: coordinates.version ?? auth.runtimeIdentity.executableVersion,
      sha256: coordinates.sha256 ?? auth.runtimeIdentity.executableSha256,
      schemaFingerprint: coordinates.schemaFingerprint ?? auth.runtimeIdentity.schemaFingerprint,
      userConfigSha256: coordinates.userConfigSha256 ?? auth.runtimeIdentity.userConfigSha256,
      systemConfigSha256: coordinates.systemConfigSha256 ?? auth.runtimeIdentity.systemConfigSha256,
      systemConfigPathCount: coordinates.systemConfigPathCount ?? 1,
      instructionSha256: coordinates.instructionSha256 ?? auth.runtimeIdentity.instructionSha256,
      accountKind: "chatgpt",
    },
    activationCoordinatesRecheckedEqual: true,
    candidateSourceManifest: stageArtifact.projection.candidateSource,
    capabilityEvidence: {
      evaluatedAt: FIXTURE_TIME,
      rawSchemaBundleSha256: auth.schemaBinding.rawSchemaBundleSha256,
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
        turnIdSha256: "5".repeat(64),
        acceptedEffectCount: 2,
        outcome: "completed_with_effects",
      },
      sourcedRecipe: {
        turnIdSha256: "6".repeat(64),
        acceptedEffectCount: 1,
        outcome: "completed_with_effects",
        sourceKind: "web",
        sourceUrlSha256: "7".repeat(64),
        observedWebSearch: {
          operation: "web_search",
          status: "completed",
          durableTurnIdSha256: "6".repeat(64),
          researchThreadIdSha256: "a".repeat(64),
          researchTurnIdSha256: "b".repeat(64),
          operationIdSha256: "c".repeat(64),
        },
      },
      failureAfterEffect: {
        turnIdSha256: "8".repeat(64),
        acceptedEffectCount: 1,
        outcome: "failed_after_effect",
      },
      recoveryOnly: {
        turnIdSha256: "9".repeat(64),
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
          updaterLauncherPathSha256: "a".repeat(64),
          canonicalTargetPathSha256: "b".repeat(64),
          dedicatedHomePathSha256: "c".repeat(64),
          fixedCwdPathSha256: "d".repeat(64),
          plannerDataPathSha256: "e".repeat(64),
          targetVersion: "incompatible-fixture",
          targetSha256: "f".repeat(64),
          schemaFingerprint: "0".repeat(64),
          configSha256: "1".repeat(64),
          instructionSha256: "2".repeat(64),
          reason: "intentional incompatible fixture",
        },
      },
    },
    dedicatedRuntimeRetention: {
      files: 1,
      bytes: 100,
      classes: {
        state_sqlite: {
          files: 1,
          bytes: 100,
          identitySha256: "3".repeat(64),
        },
      },
      credentials: {
        present: true,
        kind: "file",
        ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
        mode: 0o600,
        linkCount: 1,
        contentHashed: false,
      },
      databaseTables: [{
        pathSha256: "4".repeat(64),
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
    releaseBinding: releaseCandidateBindingFromArtifacts(
      stageArtifact,
      installedArtifact,
      authLifecycleArtifact,
    ),
    operatorSha256: installedArtifact.projection.operatorSha256,
  };
}

export function createProductionAuthArtifact({ stageArtifact, installedArtifact, coordinates } = {}) {
  return createAuthLifecycleReleaseArtifact({
    stageArtifact,
    installedArtifact,
    projection: productionAuthProjection({
      activationId: stageArtifact.activationId,
      stageSha256: stageArtifact.sha256,
      installedSha256: installedArtifact.sha256,
      operatorSha256: installedArtifact.projection.operatorSha256,
      coordinates,
    }),
  });
}

export function createProductionReleaseCandidateArtifact({
  stageArtifact,
  installedArtifact,
  authLifecycleArtifact,
  coordinates,
} = {}) {
  return createReleaseCandidateReleaseArtifact({
    stageArtifact,
    installedArtifact,
    authLifecycleArtifact,
    projection: releaseCandidateProjection({
      stageArtifact,
      installedArtifact,
      authLifecycleArtifact,
      coordinates,
    }),
  });
}
