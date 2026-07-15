import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  assertReleaseArtifact,
  createReleaseArtifact,
  isActivationId,
} from "./planner-release-contract.mjs";
import {
  assertAuthLifecycleReleaseArtifact,
} from "./codex-auth-lifecycle.mjs";
import {
  assertReleaseCandidateEvidenceProjection,
} from "./planner-release-evidence-contract.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;

export const RELEASE_CANDIDATE_BINDING_KEYS = Object.freeze([
  "activationId",
  "stageSha256",
  "installedSha256",
  "authLifecycleSha256",
]);

export const ACTIVATION_COORDINATE_KEYS = Object.freeze([
  "canonicalPath",
  "version",
  "sha256",
  "schemaFingerprint",
  "userConfigSha256",
  "systemConfigSha256",
  "systemConfigPathCount",
  "instructionSha256",
  "accountKind",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isReleaseCandidateBinding(value) {
  return isRecord(value) && exactKeys(value, RELEASE_CANDIDATE_BINDING_KEYS) &&
    isActivationId(value.activationId) &&
    RELEASE_CANDIDATE_BINDING_KEYS.slice(1).every((key) => SHA256.test(value[key]));
}

export function releaseCandidateBindingFromArtifacts(
  stageArtifact,
  installedArtifact,
  authLifecycleArtifact,
) {
  const stage = assertReleaseArtifact(stageArtifact, { artifactType: "stage" });
  const installed = assertReleaseArtifact(installedArtifact, {
    artifactType: "installed",
    activationId: stage.activationId,
    predecessorSha256: stage.sha256,
  });
  if (!SHA256.test(installed.projection.operatorSha256)) {
    throw new TypeError("The installed artifact omitted its operator identity.");
  }
  const auth = assertAuthLifecycleReleaseArtifact({
    stageArtifact: stage,
    installedArtifact: installed,
    artifact: authLifecycleArtifact,
  });
  return Object.freeze({
    activationId: stage.activationId,
    stageSha256: stage.sha256,
    installedSha256: installed.sha256,
    authLifecycleSha256: auth.sha256,
  });
}

export function createReleaseCandidateReleaseArtifact({
  stageArtifact,
  installedArtifact,
  authLifecycleArtifact,
  projection,
}) {
  const binding = releaseCandidateBindingFromArtifacts(
    stageArtifact,
    installedArtifact,
    authLifecycleArtifact,
  );
  assertEligibleReleaseCandidateArtifact(projection);
  if (
    !isReleaseCandidateBinding(projection.releaseBinding) ||
    !RELEASE_CANDIDATE_BINDING_KEYS.every(
      (key) => projection.releaseBinding[key] === binding[key],
    )
  ) {
    throw new TypeError("The release-candidate projection changed its stage/install/auth binding.");
  }
  if (
    !SHA256.test(projection.operatorSha256) ||
    projection.operatorSha256 !== installedArtifact.projection.operatorSha256 ||
    projection.operatorSha256 !== authLifecycleArtifact.projection.operatorSha256
  ) {
    throw new TypeError("The release-candidate projection changed its installed operator identity.");
  }
  assertReleaseCandidateChainProjection({
    stageArtifact,
    authLifecycleArtifact,
    projection,
  });
  return createBoundReleaseCandidateArtifact(projection);
}

export function createBoundReleaseCandidateArtifact(projection) {
  assertEligibleReleaseCandidateArtifact(projection);
  const binding = projection.releaseBinding;
  if (!isReleaseCandidateBinding(binding) || !SHA256.test(projection.operatorSha256)) {
    throw new TypeError("A bound release-candidate projection requires release and operator identities.");
  }
  return createReleaseArtifact({
    artifactType: "release-candidate",
    activationId: binding.activationId,
    predecessorSha256: binding.authLifecycleSha256,
    projection,
  });
}

export function releaseCandidateProjectionFromArtifact(value) {
  if (value?.artifactType !== "release-candidate") {
    return assertEligibleReleaseCandidateArtifact(value);
  }
  const envelope = assertReleaseArtifact(value, { artifactType: "release-candidate" });
  const projection = assertEligibleReleaseCandidateArtifact(envelope.projection);
  if (
    projection.releaseBinding?.activationId !== envelope.activationId ||
    projection.releaseBinding?.authLifecycleSha256 !== envelope.predecessorSha256
  ) {
    throw new Error("The release-candidate envelope changed its auth lifecycle binding.");
  }
  return projection;
}

function assertReleaseCandidateChainProjection({
  stageArtifact,
  authLifecycleArtifact,
  projection,
}) {
  const auth = authLifecycleArtifact.projection;
  const coordinates = projection.activationCoordinates;
  const runtime = auth.runtimeIdentity;
  if (
    canonicalJson(projection.candidateSourceManifest) !==
      canonicalJson(stageArtifact.projection.candidateSource) ||
    sha256(coordinates.canonicalPath) !== runtime.canonicalTargetPathSha256 ||
    coordinates.version !== runtime.executableVersion ||
    coordinates.sha256 !== runtime.executableSha256 ||
    coordinates.schemaFingerprint !== runtime.schemaFingerprint ||
    coordinates.userConfigSha256 !== runtime.userConfigSha256 ||
    coordinates.systemConfigSha256 !== runtime.systemConfigSha256 ||
    coordinates.instructionSha256 !== runtime.instructionSha256 ||
    coordinates.accountKind !== auth.account.kind ||
    projection.capabilityEvidence.rawSchemaBundleSha256 !==
      auth.schemaBinding.rawSchemaBundleSha256
  ) {
    throw new TypeError(
      "The release-candidate evidence changed its staged source or authenticated runtime binding.",
    );
  }
}

export function assertReleaseCandidateReleaseArtifact({
  stageArtifact,
  installedArtifact,
  authLifecycleArtifact,
  artifact,
}) {
  const binding = releaseCandidateBindingFromArtifacts(
    stageArtifact,
    installedArtifact,
    authLifecycleArtifact,
  );
  const value = assertReleaseArtifact(artifact, {
    artifactType: "release-candidate",
    activationId: binding.activationId,
    predecessorSha256: binding.authLifecycleSha256,
    operatorSha256: installedArtifact.projection.operatorSha256,
  });
  assertReleaseCandidateEvidenceProjection(value.projection, { bound: true });
  if (
    !RELEASE_CANDIDATE_BINDING_KEYS.every(
      (key) => value.projection.releaseBinding[key] === binding[key],
    )
  ) {
    throw new TypeError("The durable release candidate changed its release binding.");
  }
  assertReleaseCandidateChainProjection({
    stageArtifact,
    authLifecycleArtifact,
    projection: value.projection,
  });
  return value;
}

export function isActivationCoordinates(value) {
  return isRecord(value) && exactKeys(value, ACTIVATION_COORDINATE_KEYS) &&
    typeof value.canonicalPath === "string" && isAbsolute(value.canonicalPath) &&
    typeof value.version === "string" && value.version.length > 0 && value.version.length <= 256 &&
    SHA256.test(value.sha256) &&
    SHA256.test(value.schemaFingerprint) &&
    SHA256.test(value.userConfigSha256) &&
    SHA256.test(value.systemConfigSha256) &&
    Number.isSafeInteger(value.systemConfigPathCount) && value.systemConfigPathCount >= 0 &&
    SHA256.test(value.instructionSha256) &&
    typeof value.accountKind === "string" && value.accountKind.length > 0 &&
    value.accountKind.length <= 128;
}

export function activationCoordinatesFromStatus(status) {
  if (
    status?.state !== "compatible" ||
    status.authenticated !== true ||
    status.protocolCompatible !== true ||
    !isActivationCoordinates(status.evidence)
  ) {
    throw new Error("The embedded Codex runtime is not authenticated and compatible for activation.");
  }
  return Object.freeze(Object.fromEntries(
    ACTIVATION_COORDINATE_KEYS.map((key) => [key, status.evidence[key]]),
  ));
}

export function activationCoordinatesEqual(left, right) {
  return isActivationCoordinates(left) && isActivationCoordinates(right) &&
    ACTIVATION_COORDINATE_KEYS.every((key) => left[key] === right[key]);
}

export function assertEligibleReleaseCandidateArtifact(artifact) {
  const bound = Object.hasOwn(artifact ?? {}, "releaseBinding") ||
    Object.hasOwn(artifact ?? {}, "operatorSha256");
  return assertReleaseCandidateEvidenceProjection(artifact, { bound });
}
