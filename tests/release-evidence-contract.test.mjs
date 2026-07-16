import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseArtifact,
  createReleaseArtifact,
  sha256ReleaseJson,
} from "../scripts/support/planner-release-contract.mjs";
import {
  createProductionAuthArtifact,
  createProductionReleaseCandidateArtifact,
} from "./support/release-evidence-fixtures.mjs";

const activationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const forbiddenFields = Object.freeze([
  "credentialSize",
  "credentialSha256",
  "rawAccountFrame",
  "chatgptAccountId",
  "tokens",
  "arbitraryExtra",
]);

function forbiddenValue(field) {
  return field === "credentialSize" ? 42 : "forbidden-fixture";
}

function fixtureChain() {
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      candidateSource: { files: 1, bytes: 1, sha256: "1".repeat(64) },
    },
  });
  const installed = createReleaseArtifact({
    artifactType: "installed",
    activationId,
    predecessorSha256: stage.sha256,
    projection: {
      operatorSha256: "2".repeat(64),
    },
  });
  const auth = createProductionAuthArtifact({
    stageArtifact: stage,
    installedArtifact: installed,
  });
  const releaseCandidate = createProductionReleaseCandidateArtifact({
    stageArtifact: stage,
    installedArtifact: installed,
    authLifecycleArtifact: auth,
  });
  return { stage, installed, auth, releaseCandidate };
}

function rehash(artifact) {
  const body = structuredClone(artifact);
  delete body.sha256;
  return { ...body, sha256: sha256ReleaseJson(body) };
}

test("auth evidence rejects credential aliases even when the envelope is rehashed", () => {
  const { auth } = fixtureChain();
  const insertionPoints = [
    (projection) => projection,
    (projection) => projection.releaseInputs,
    (projection) => projection.runtimeIdentity,
    (projection) => projection.deploymentReadback,
    (projection) => projection.environment,
    (projection) => projection.readiness,
    (projection) => projection.account,
    (projection) => projection.schemaBinding,
  ];
  for (const insertionPoint of insertionPoints) {
    for (const field of forbiddenFields) {
      const changed = structuredClone(auth);
      insertionPoint(changed.projection)[field] = forbiddenValue(field);
      assert.throws(() => createReleaseArtifact({
        artifactType: "auth-lifecycle",
        activationId,
        predecessorSha256: auth.predecessorSha256,
        projection: changed.projection,
      }));
      assert.throws(() => assertReleaseArtifact(rehash(changed)));
    }
  }
});

test("release-candidate evidence rejects unknown and credential-derived projections", () => {
  const { releaseCandidate } = fixtureChain();
  const insertionPoints = [
    (projection) => projection,
    (projection) => projection.activationCoordinates,
    (projection) => projection.candidateSourceManifest,
    (projection) => projection.capabilityEvidence,
    (projection) => projection.releaseBinding,
    (projection) => projection.scenarios,
    (projection) => projection.scenarios.nativeHistory,
    (projection) => projection.scenarios.nativeTurn,
    (projection) => projection.scenarios.nativeTurn.plannerEffect,
    (projection) => projection.scenarios.nativeTurn.hostedWebSearch,
    (projection) => projection.scenarios.nativeTurn.activity,
    (projection) => projection.scenarios.nativeTurn.worker,
    (projection) => projection.scenarios.interactions,
    (projection) => projection.scenarios.interactions.question,
    (projection) => projection.scenarios.interrupt,
    (projection) => projection.scenarios.globalUds,
    (projection) => projection.scenarios.incompatibleIndependence,
    (projection) => projection.scenarios.incompatibleIndependence.target,
    (projection) => projection.dedicatedRuntimeRetention,
    (projection) => projection.dedicatedRuntimeRetention.credentials,
    (projection) => projection.dedicatedRuntimeRetention.classes,
    (projection) => projection.dedicatedRuntimeRetention.classes.state_sqlite,
    (projection) => projection.dedicatedRuntimeRetention.databaseTables[0],
    (projection) => projection.dedicatedRuntimeRetention.databaseTables[0].counts,
    (projection) => projection.dedicatedRuntimeRetention.nativeStateCounts,
  ];
  for (const insertionPoint of insertionPoints) {
    for (const field of forbiddenFields) {
      const changed = structuredClone(releaseCandidate);
      insertionPoint(changed.projection)[field] = forbiddenValue(field);
      assert.throws(() => createReleaseArtifact({
        artifactType: "release-candidate",
        activationId,
        predecessorSha256: releaseCandidate.predecessorSha256,
        projection: changed.projection,
      }), /invalid exact contract/);
      assert.throws(
        () => assertReleaseArtifact(rehash(changed)),
        /invalid exact contract/,
      );
    }
  }
});

test("release-candidate evidence binds one native hosted-search capability surface", () => {
  const { releaseCandidate } = fixtureChain();
  for (const mode of [undefined, "indexed", "disabled"]) {
    const changed = structuredClone(releaseCandidate);
    if (mode === undefined) {
      delete changed.projection.capabilityEvidence.hostedWebSearchMode;
    } else {
      changed.projection.capabilityEvidence.hostedWebSearchMode = mode;
    }
    assert.throws(() => createReleaseArtifact({
      artifactType: "release-candidate",
      activationId,
      predecessorSha256: releaseCandidate.predecessorSha256,
      projection: changed.projection,
    }), /invalid exact contract/);
    assert.throws(() => assertReleaseArtifact(rehash(changed)), /invalid exact contract/);
  }
});

test("release-candidate evidence requires an observed hosted-search operation bound to its turn", () => {
  const { releaseCandidate } = fixtureChain();
  const mutations = [
    (projection) => { delete projection.scenarios.nativeTurn.hostedWebSearch; },
    (projection) => { projection.scenarios.nativeTurn.hostedWebSearch.status = "started"; },
    (projection) => {
      projection.scenarios.nativeTurn.hostedWebSearch.turnIdSha256 = "f".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(releaseCandidate);
    mutate(changed.projection);
    assert.throws(() => createReleaseArtifact({
      artifactType: "release-candidate",
      activationId,
      predecessorSha256: releaseCandidate.predecessorSha256,
      projection: changed.projection,
    }), /invalid exact contract/);
    assert.throws(() => assertReleaseArtifact(rehash(changed)), /invalid exact contract/);
  }
});

test("release-candidate evidence requires one authoritative recipe-derived farm-box move", () => {
  const { releaseCandidate } = fixtureChain();
  const mutations = [
    (projection) => { projection.scenarios.nativeTurn.plannerEffect.plannerVersionDelta = 2; },
    (projection) => { projection.scenarios.nativeTurn.plannerEffect.source = "shop"; },
    (projection) => { projection.scenarios.nativeTurn.plannerEffect.ingredientNameSha256 = "not-a-sha"; },
    (projection) => { projection.scenarios.nativeTurn.plannerEffect.authoritativeReadback = false; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(releaseCandidate);
    mutate(changed.projection);
    assert.throws(() => createReleaseArtifact({
      artifactType: "release-candidate",
      activationId,
      predecessorSha256: releaseCandidate.predecessorSha256,
      projection: changed.projection,
    }), /invalid exact contract/);
  }
});

test("release-candidate evidence requires observed labels and a completed parent worker result", () => {
  const { releaseCandidate } = fixtureChain();
  const mutations = [
    (projection) => { delete projection.scenarios.nativeTurn.activity.humanLabelsObserved; },
    (projection) => { projection.scenarios.nativeTurn.activity.humanLabelsObserved = false; },
    (projection) => { delete projection.scenarios.nativeTurn.worker.parentResultObserved; },
    (projection) => { projection.scenarios.nativeTurn.worker.parentResultObserved = false; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(releaseCandidate);
    mutate(changed.projection);
    assert.throws(() => createReleaseArtifact({
      artifactType: "release-candidate",
      activationId,
      predecessorSha256: releaseCandidate.predecessorSha256,
      projection: changed.projection,
    }), /invalid exact contract/);
  }
});

test("release-candidate evidence cross-binds native root, interaction, worker, and interrupt identities", () => {
  const { releaseCandidate } = fixtureChain();
  const mutations = [
    (projection) => {
      projection.scenarios.nativeHistory.primaryThreadIdSha256 = "f".repeat(64);
    },
    (projection) => {
      projection.scenarios.interactions.question.threadIdSha256 = "f".repeat(64);
    },
    (projection) => {
      projection.scenarios.nativeTurn.worker.workerThreadIdSha256 =
        projection.scenarios.nativeTurn.threadIdSha256;
    },
    (projection) => {
      projection.scenarios.interrupt.threadIdSha256 = "f".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(releaseCandidate);
    mutate(changed.projection);
    assert.throws(() => createReleaseArtifact({
      artifactType: "release-candidate",
      activationId,
      predecessorSha256: releaseCandidate.predecessorSha256,
      projection: changed.projection,
    }), /invalid exact contract/);
    assert.throws(() => assertReleaseArtifact(rehash(changed)), /invalid exact contract/);
  }
});

test("release-candidate evidence does not claim an unobserved approval interaction", () => {
  const { releaseCandidate } = fixtureChain();
  const changed = structuredClone(releaseCandidate);
  changed.projection.scenarios.interactions.approval = {
    policy: "never",
    rejectedByPolicy: true,
    noDecisionSurface: true,
  };
  assert.throws(() => createReleaseArtifact({
    artifactType: "release-candidate",
    activationId,
    predecessorSha256: releaseCandidate.predecessorSha256,
    projection: changed.projection,
  }), /invalid exact contract/);
  assert.throws(() => assertReleaseArtifact(rehash(changed)), /invalid exact contract/);
});

test("self-rehashed evidence rejects unknown outer-envelope fields", () => {
  const { auth, releaseCandidate } = fixtureChain();
  for (const artifact of [auth, releaseCandidate]) {
    for (const field of forbiddenFields) {
      const changed = structuredClone(artifact);
      changed[field] = forbiddenValue(field);
      assert.throws(() => assertReleaseArtifact(rehash(changed)));
    }
  }
});

test("specialized evidence creators reject extensions before publication", () => {
  const { auth, releaseCandidate } = fixtureChain();
  assert.throws(() => createReleaseArtifact({
    artifactType: "auth-lifecycle",
    activationId,
    predecessorSha256: auth.predecessorSha256,
    projection: { ...auth.projection, rawAccountFrame: "forbidden-fixture" },
  }));
  assert.throws(() => createReleaseArtifact({
    artifactType: "release-candidate",
    activationId,
    predecessorSha256: releaseCandidate.predecessorSha256,
    projection: { ...releaseCandidate.projection, credentialSize: 42 },
  }), /invalid exact contract/);
});
