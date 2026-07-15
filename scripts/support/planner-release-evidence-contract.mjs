const SHA256 = /^[a-f0-9]{64}$/u;
const ACTIVATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

const AUTH_READINESS_KEYS = Object.freeze([
  "outcome",
  "operatorSha256",
  "releaseInputs",
  "runtimeIdentity",
  "deploymentReadback",
  "environment",
  "readiness",
  "account",
]);
const AUTH_SCHEMA_BINDING_KEYS = Object.freeze([
  "rawSchemaBundleSha256",
  "compatibilitySchemaFingerprint",
  "authSchemaFingerprint",
  "notificationOptOutMethodCount",
  "contractKind",
]);
const RELEASE_BINDING_KEYS = Object.freeze([
  "activationId",
  "stageSha256",
  "installedSha256",
  "authLifecycleSha256",
]);
const RETENTION_CLASSES = new Set([
  "configuration",
  "compatibility_evidence",
  "schema_cache",
  "execution_snapshot",
  "state_sqlite",
  "log_sqlite",
  "sqlite_sidecar",
  "runtime_log",
  "other",
]);
const RETENTION_TABLES = new Set([
  "threads",
  "thread_dynamic_tools",
  "agent_jobs",
  "agent_job_items",
  "logs",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function sha(value) {
  return typeof value === "string" && SHA256.test(value);
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function timestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactStrings(value, expected) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function validReleaseInputs(value) {
  return exactKeys(value, ["activationId", "stageSha256", "installedSha256"]) &&
    ACTIVATION_ID.test(value.activationId) && sha(value.stageSha256) && sha(value.installedSha256);
}

function validRuntimeIdentity(value) {
  const keys = [
    "canonicalTargetPathSha256",
    "executableVersion",
    "executableSha256",
    "schemaFingerprint",
    "userConfigSha256",
    "systemConfigSha256",
    "instructionSha256",
  ];
  return exactKeys(value, keys) &&
    sha(value.canonicalTargetPathSha256) &&
    typeof value.executableVersion === "string" && value.executableVersion.length > 0 &&
    value.executableVersion.length <= 256 &&
    keys.slice(2).every((key) => sha(value[key]));
}

function validDeploymentReadback(value) {
  return exactKeys(value, [
    "identitySha256",
    "standaloneSkillReadbackCompleted",
    "standaloneSkillCount",
    "standaloneSkillIdentitySha256",
    "emptyAmbientCapabilitySurfaces",
  ]) && sha(value.identitySha256) &&
    value.standaloneSkillReadbackCompleted === true &&
    nonnegative(value.standaloneSkillCount) &&
    sha(value.standaloneSkillIdentitySha256) &&
    value.emptyAmbientCapabilitySurfaces === true;
}

function validAuthEnvironment(value) {
  return exactKeys(value, [
    "authReadbackProcessCount",
    "realHomeRetained",
    "dedicatedHomeReadbackCount",
    "canonicalApplicationRootRetained",
    "notificationOptOutMethodCount",
    "notificationOptOutMethodsSha256",
  ]) && value.authReadbackProcessCount === 1 && value.realHomeRetained === true &&
    value.dedicatedHomeReadbackCount === 1 &&
    value.canonicalApplicationRootRetained === true &&
    nonnegative(value.notificationOptOutMethodCount) &&
    sha(value.notificationOptOutMethodsSha256);
}

function validReadiness(value) {
  return exactKeys(value, [
    "existingDedicatedCredentialsReused",
    "freshProcessReadback",
    "proactiveRefreshReadback",
    "credentialMutationRequestsAllowed",
  ]) && value.existingDedicatedCredentialsReused === true &&
    value.freshProcessReadback === true && value.proactiveRefreshReadback === true &&
    value.credentialMutationRequestsAllowed === false;
}

function validAccount(value) {
  return exactKeys(value, ["kind"]) && value.kind === "chatgpt";
}

function validSchemaBinding(value, projection) {
  return exactKeys(value, AUTH_SCHEMA_BINDING_KEYS) &&
    sha(value.rawSchemaBundleSha256) && sha(value.compatibilitySchemaFingerprint) &&
    sha(value.authSchemaFingerprint) && nonnegative(value.notificationOptOutMethodCount) &&
    value.contractKind === "authenticatedReadback" &&
    value.notificationOptOutMethodCount === projection.environment.notificationOptOutMethodCount &&
    value.compatibilitySchemaFingerprint === projection.runtimeIdentity.schemaFingerprint;
}

export function assertProductionAuthReadinessProjection(value, options = {}) {
  const keys = options.durable === true
    ? [...AUTH_READINESS_KEYS, "schemaBinding"]
    : AUTH_READINESS_KEYS;
  if (
    !exactKeys(value, keys) || value.outcome !== "authenticated" ||
    !sha(value.operatorSha256) || !validReleaseInputs(value.releaseInputs) ||
    !validRuntimeIdentity(value.runtimeIdentity) ||
    !validDeploymentReadback(value.deploymentReadback) ||
    !validAuthEnvironment(value.environment) || !validReadiness(value.readiness) ||
    !validAccount(value.account) ||
    (options.durable === true && !validSchemaBinding(value.schemaBinding, value))
  ) {
    throw new TypeError("The production auth readiness projection has an invalid exact contract.");
  }
  return value;
}

function validActivationCoordinates(value) {
  return exactKeys(value, [
    "canonicalPath",
    "version",
    "sha256",
    "schemaFingerprint",
    "userConfigSha256",
    "systemConfigSha256",
    "systemConfigPathCount",
    "instructionSha256",
    "accountKind",
  ]) && typeof value.canonicalPath === "string" && value.canonicalPath.startsWith("/") &&
    typeof value.version === "string" && value.version.length > 0 && value.version.length <= 256 &&
    sha(value.sha256) && sha(value.schemaFingerprint) && sha(value.userConfigSha256) &&
    sha(value.systemConfigSha256) && nonnegative(value.systemConfigPathCount) &&
    sha(value.instructionSha256) && value.accountKind === "chatgpt";
}

function validSourceManifest(value) {
  return exactKeys(value, ["files", "bytes", "sha256"]) &&
    positive(value.files) && positive(value.bytes) && sha(value.sha256);
}

function validCapabilityEvidence(value) {
  return exactKeys(value, [
    "evaluatedAt",
    "rawSchemaBundleSha256",
    "researchWebSearchMode",
    "researchTools",
    "plannerTools",
    "plannerNamespaceMembers",
    "forbiddenHits",
    "unexpectedRpcMethods",
    "dependentResultObserved",
    "outboundPolicyRejected",
    "permissionProfile",
    "effectiveSandbox",
    "emptyAmbientSurfaces",
  ]) && timestamp(value.evaluatedAt) && sha(value.rawSchemaBundleSha256) &&
    value.researchWebSearchMode === "live" &&
    exactStrings(value.researchTools, ["update_plan", "web_search"]) &&
    exactStrings(value.plannerTools, ["update_plan", "planner"]) &&
    exactStrings(value.plannerNamespaceMembers, ["read", "preview", "apply"]) &&
    exactStrings(value.forbiddenHits, []) && exactStrings(value.unexpectedRpcMethods, []) &&
    value.dependentResultObserved === true && value.outboundPolicyRejected === true &&
    value.permissionProfile === ":read-only" &&
    value.effectiveSandbox === "read-only-network-disabled" &&
    value.emptyAmbientSurfaces === true;
}

function validTurnScenario(value, keys, outcome, minimumEffects) {
  return exactKeys(value, keys) && sha(value.turnIdSha256) &&
    Number.isSafeInteger(value.acceptedEffectCount) &&
    value.acceptedEffectCount >= minimumEffects && value.outcome === outcome;
}

function validObservedWebSearch(value, durableTurnIdSha256) {
  return exactKeys(value, [
    "operation",
    "status",
    "durableTurnIdSha256",
    "researchThreadIdSha256",
    "researchTurnIdSha256",
    "operationIdSha256",
  ]) && value.operation === "web_search" && value.status === "completed" &&
    value.durableTurnIdSha256 === durableTurnIdSha256 &&
    sha(value.researchThreadIdSha256) && sha(value.researchTurnIdSha256) &&
    sha(value.operationIdSha256);
}

function validIncompatibleTarget(value) {
  const keys = [
    "updaterLauncherPathSha256",
    "canonicalTargetPathSha256",
    "dedicatedHomePathSha256",
    "fixedCwdPathSha256",
    "plannerDataPathSha256",
    "targetVersion",
    "targetSha256",
    "schemaFingerprint",
    "configSha256",
    "instructionSha256",
    "reason",
  ];
  return exactKeys(value, keys) && keys.slice(0, 5).every((key) => sha(value[key])) &&
    typeof value.targetVersion === "string" && value.targetVersion.length > 0 &&
    value.targetVersion.length <= 256 &&
    ["targetSha256", "schemaFingerprint", "configSha256", "instructionSha256"]
      .every((key) => sha(value[key])) &&
    typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 512;
}

function validScenarios(value) {
  const dependent = value?.dependentPlanner;
  const sourced = value?.sourcedRecipe;
  const failed = value?.failureAfterEffect;
  const recovery = value?.recoveryOnly;
  const global = value?.globalUds;
  const incompatible = value?.incompatibleIndependence;
  return exactKeys(value, [
    "dependentPlanner",
    "sourcedRecipe",
    "failureAfterEffect",
    "recoveryOnly",
    "secondClientReadback",
    "globalUds",
    "incompatibleIndependence",
  ]) && validTurnScenario(
    dependent,
    ["turnIdSha256", "acceptedEffectCount", "outcome"],
    "completed_with_effects",
    2,
  ) && validTurnScenario(
    sourced,
    [
      "turnIdSha256",
      "acceptedEffectCount",
      "outcome",
      "sourceKind",
      "sourceUrlSha256",
      "observedWebSearch",
    ],
    "completed_with_effects",
    1,
  ) && sourced.sourceKind === "web" && sha(sourced.sourceUrlSha256) &&
    validObservedWebSearch(sourced.observedWebSearch, sourced.turnIdSha256) &&
    validTurnScenario(
      failed,
      ["turnIdSha256", "acceptedEffectCount", "outcome"],
      "failed_after_effect",
      1,
    ) && failed.acceptedEffectCount === 1 &&
    validTurnScenario(
      recovery,
      ["turnIdSha256", "acceptedEffectCount", "outcome", "plannerVersionUnchanged"],
      "recovery_completed",
      0,
    ) && recovery.acceptedEffectCount === 0 && recovery.plannerVersionUnchanged === true &&
    value.secondClientReadback === true &&
    exactKeys(global, [
      "supportedClient",
      "applyAccepted",
      "exactReplay",
      "changedPayloadRejected",
      "browserReadback",
    ]) && Object.values(global).every((entry) => entry === true) &&
    exactKeys(incompatible, [
      "codexState",
      "plannerReady",
      "storeReady",
      "globalCodexReady",
      "supportedGlobalClient",
      "globalApplyAccepted",
      "browserReadback",
      "target",
    ]) && incompatible.codexState === "incompatible" &&
    [
      "plannerReady",
      "storeReady",
      "globalCodexReady",
      "supportedGlobalClient",
      "globalApplyAccepted",
      "browserReadback",
    ].every((key) => incompatible[key] === true) && validIncompatibleTarget(incompatible.target);
}

function validInventoryCategory(value) {
  return exactKeys(value, ["files", "bytes", "identitySha256"]) &&
    nonnegative(value.files) && nonnegative(value.bytes) && sha(value.identitySha256);
}

function validCredentialRetention(value) {
  return exactKeys(value, [
    "present",
    "kind",
    "ownerUid",
    "mode",
    "linkCount",
    "contentHashed",
  ]) && value.present === true && value.kind === "file" && nonnegative(value.ownerUid) &&
    value.mode === 0o600 && value.linkCount === 1 && value.contentHashed === false;
}

function validRetention(value) {
  if (!exactKeys(value, [
    "files",
    "bytes",
    "classes",
    "credentials",
    "databaseTables",
    "ephemeralCounts",
    "logRows",
  ]) || !positive(value.files) || !positive(value.bytes) ||
      !isRecord(value.classes) || Object.keys(value.classes).length === 0 ||
      Object.keys(value.classes).some((key) => !RETENTION_CLASSES.has(key)) ||
      Object.values(value.classes).some((entry) => !validInventoryCategory(entry)) ||
      !validCredentialRetention(value.credentials) ||
      !Array.isArray(value.databaseTables) || value.databaseTables.length === 0 ||
      !exactKeys(value.ephemeralCounts, [
        "threads",
        "thread_dynamic_tools",
        "agent_jobs",
        "agent_job_items",
      ]) || Object.values(value.ephemeralCounts).some((count) => count !== 0) ||
      !nonnegative(value.logRows)) return false;
  const classValues = Object.values(value.classes);
  if (
    value.files !== classValues.reduce((sum, entry) => sum + entry.files, 0) ||
    value.bytes !== classValues.reduce((sum, entry) => sum + entry.bytes, 0)
  ) return false;
  const observed = new Set();
  let logs = 0;
  for (const database of value.databaseTables) {
    if (
      !exactKeys(database, ["pathSha256", "class", "counts"]) ||
      !sha(database.pathSha256) || !["state_sqlite", "log_sqlite"].includes(database.class) ||
      !isRecord(database.counts) || Object.keys(database.counts).some(
        (key) => !RETENTION_TABLES.has(key),
      ) || Object.values(database.counts).some((count) => !nonnegative(count))
    ) return false;
    Object.keys(database.counts).forEach((key) => observed.add(key));
    logs += database.counts.logs ?? 0;
  }
  return ["threads", "thread_dynamic_tools", "agent_jobs"].every((key) => observed.has(key)) &&
    logs === value.logRows;
}

function validReleaseBinding(value) {
  return exactKeys(value, RELEASE_BINDING_KEYS) && ACTIVATION_ID.test(value.activationId) &&
    RELEASE_BINDING_KEYS.slice(1).every((key) => sha(value[key]));
}

export function assertReleaseCandidateEvidenceProjection(value, options = {}) {
  const baseKeys = [
    "schemaVersion",
    "completedAt",
    "disposition",
    "scenario",
    "authenticationMutationPerformedByProbe",
    "activationCoordinates",
    "activationCoordinatesRecheckedEqual",
    "candidateSourceManifest",
    "capabilityEvidence",
    "scenarios",
    "dedicatedRuntimeRetention",
  ];
  const keys = options.bound === true
    ? [...baseKeys, "releaseBinding", "operatorSha256"]
    : baseKeys;
  if (
    !exactKeys(value, keys) || value.schemaVersion !== 1 || !timestamp(value.completedAt) ||
    value.disposition !== "compatible_authenticated_release_candidate" ||
    value.scenario !== "all" || value.authenticationMutationPerformedByProbe !== false ||
    value.activationCoordinatesRecheckedEqual !== true ||
    !validActivationCoordinates(value.activationCoordinates) ||
    !validSourceManifest(value.candidateSourceManifest) ||
    !validCapabilityEvidence(value.capabilityEvidence) || !validScenarios(value.scenarios) ||
    !validRetention(value.dedicatedRuntimeRetention) ||
    (options.bound === true && (!validReleaseBinding(value.releaseBinding) || !sha(value.operatorSha256)))
  ) {
    throw new TypeError("The release-candidate evidence has an invalid exact contract.");
  }
  return value;
}

export function assertDurableReleaseEvidenceProjection(artifactType, projection) {
  if (artifactType === "auth-lifecycle") {
    return assertProductionAuthReadinessProjection(projection, { durable: true });
  }
  if (artifactType === "release-candidate") {
    return assertReleaseCandidateEvidenceProjection(projection, { bound: true });
  }
  return projection;
}
