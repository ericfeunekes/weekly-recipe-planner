import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertDurableReleaseEvidenceProjection,
} from "./planner-release-evidence-contract.mjs";

export const RELEASE_CONTRACT_VERSION = 1;
export const RELEASE_ARTIFACT_BYTES_LIMIT = 1024 * 1024;
export const RELEASE_JOURNAL_BYTES_LIMIT = 4 * 1024 * 1024;
const RELEASE_TREE_MAX_FILES = 100_000;
const RELEASE_TREE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const RELEASE_TREE_MAX_DEPTH = 32;

export const RELEASE_EXIT_CODES = Object.freeze({
  ok: 0,
  invalidInput: 2,
  ownershipOrDrain: 3,
  eligibility: 4,
  rolledBack: 5,
  interventionRequired: 6,
});

export const RELEASE_ARTIFACT_CHAIN = Object.freeze([
  "stage",
  "installed",
  "auth-lifecycle",
  "release-candidate",
  "qa",
  "activation",
]);

export const RELEASE_ARTIFACT_TYPES = Object.freeze([
  ...RELEASE_ARTIFACT_CHAIN,
  "previous-activation",
  "rollback",
]);

export const RELEASE_LIFECYCLE_STATES = Object.freeze([
  "staged",
  "preparing",
  "previous_pair_parked",
  "candidate_app_selected",
  "candidate_pair_selected",
  "committed",
  "restoring",
  "previous_app_restored",
  "previous_pair_restored",
  "rolled_back",
  "intervention_required",
]);

export const RELEASE_LIFECYCLE_EVENTS = Object.freeze([
  "begin",
  "park_previous",
  "select_app",
  "select_data",
  "publish_current",
  "abort",
  "rollback",
  "restore_app",
  "restore_data",
  "publish_rollback",
  "ambiguous",
]);

export const RELEASE_TERMINAL_STATES = Object.freeze([
  "committed",
  "rolled_back",
  "intervention_required",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const ACTIVATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const POINTER_TYPES = new Set(["pending", "current"]);
const MAIN_CHAIN_INDEX = new Map(RELEASE_ARTIFACT_CHAIN.map((type, index) => [type, index]));
const CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "authorization",
  "authjson",
  "authdigest",
  "chatgptaccountid",
  "credentialfingerprint",
  "credentialsha256",
  "credentialsize",
  "devicecode",
  "email",
  "idtoken",
  "normalhome",
  "normalhomepath",
  "password",
  "rawauth",
  "rawaccountframe",
  "refreshtoken",
  "secret",
  "token",
  "tokens",
  "usercode",
  "verificationuri",
  "verificationurl",
]);

export class PlannerReleaseError extends Error {
  constructor(message, exitCode = RELEASE_EXIT_CODES.eligibility, options = undefined) {
    super(message, options);
    this.name = "PlannerReleaseError";
    this.exitCode = exitCode;
  }
}

export class PlannerReleaseInputError extends PlannerReleaseError {
  constructor(message, options = undefined) {
    super(message, RELEASE_EXIT_CODES.invalidInput, options);
    this.name = "PlannerReleaseInputError";
  }
}

export class PlannerReleaseOwnershipError extends PlannerReleaseError {
  constructor(message, options = undefined) {
    super(message, RELEASE_EXIT_CODES.ownershipOrDrain, options);
    this.name = "PlannerReleaseOwnershipError";
  }
}

export class PlannerReleaseInterventionError extends PlannerReleaseError {
  constructor(message, options = undefined) {
    super(message, RELEASE_EXIT_CODES.interventionRequired, options);
    this.name = "PlannerReleaseInterventionError";
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlainRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function assertFiniteJsonNumber(value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError("Release JSON numbers must be finite and may not be negative zero.");
  }
}

function canonicalize(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assertFiniteJsonNumber(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Release artifacts accept only plain JSON values.");
  }
  if (ancestors.has(value)) throw new TypeError("Release artifacts may not contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
    }
    if (!isPlainRecord(value)) {
      throw new TypeError("Release artifacts accept only plain JSON objects.");
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      if (value[key] === undefined) {
        throw new TypeError("Release artifact object values may not be undefined.");
      }
      return `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalReleaseJson(value) {
  return canonicalize(value, new Set());
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256ReleaseJson(value) {
  return sha256Bytes(canonicalReleaseJson(value));
}

export function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

export function isActivationId(value) {
  return typeof value === "string" && ACTIVATION_ID.test(value);
}

export function createActivationId() {
  return randomUUID();
}

export function assertBoundedReleaseJson(value, byteLimit = RELEASE_ARTIFACT_BYTES_LIMIT) {
  const canonical = canonicalReleaseJson(value);
  if (Buffer.byteLength(canonical, "utf8") > byteLimit) {
    throw new PlannerReleaseError("A release JSON value exceeded its closed byte limit.");
  }
  return value;
}

function inspectCredentialKeys(value, path = "projection") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectCredentialKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase().replaceAll(/[^a-z0-9]/gu, ""))) {
      throw new PlannerReleaseError(
        `The auth lifecycle projection contains forbidden credential material at ${path}.${key}.`,
      );
    }
    inspectCredentialKeys(entry, `${path}.${key}`);
  }
}

function artifactBody({ artifactType, activationId, predecessorSha256, projection }) {
  return {
    schemaVersion: RELEASE_CONTRACT_VERSION,
    artifactType,
    activationId,
    predecessorSha256,
    projection,
  };
}

export function createReleaseArtifact({
  artifactType,
  activationId,
  predecessorSha256 = null,
  projection,
}) {
  if (!RELEASE_ARTIFACT_TYPES.includes(artifactType)) {
    throw new PlannerReleaseInputError(`Unsupported release artifact type: ${artifactType}`);
  }
  if (!isActivationId(activationId)) {
    throw new PlannerReleaseInputError("A release artifact requires a canonical activation ID.");
  }
  if (artifactType === "stage") {
    if (predecessorSha256 !== null) {
      throw new PlannerReleaseInputError("The stage artifact may not name a predecessor.");
    }
  } else if (!isSha256(predecessorSha256)) {
    throw new PlannerReleaseInputError("A non-stage release artifact requires a SHA-256 predecessor.");
  }
  if (!isPlainRecord(projection)) {
    throw new PlannerReleaseInputError("A release artifact projection must be a plain JSON object.");
  }
  if (artifactType === "auth-lifecycle") inspectCredentialKeys(projection);
  assertDurableReleaseEvidenceProjection(artifactType, projection);
  const body = artifactBody({ artifactType, activationId, predecessorSha256, projection });
  assertBoundedReleaseJson(body);
  const artifact = Object.freeze({ ...body, sha256: sha256ReleaseJson(body) });
  assertBoundedReleaseJson(artifact);
  return artifact;
}

export function assertReleaseArtifact(value, expected = {}) {
  if (!exactKeys(value, [
    "schemaVersion",
    "artifactType",
    "activationId",
    "predecessorSha256",
    "projection",
    "sha256",
  ])) {
    throw new PlannerReleaseError("A release artifact has an invalid exact envelope.");
  }
  if (
    value.schemaVersion !== RELEASE_CONTRACT_VERSION ||
    !RELEASE_ARTIFACT_TYPES.includes(value.artifactType) ||
    !isActivationId(value.activationId) ||
    !isPlainRecord(value.projection) ||
    !isSha256(value.sha256)
  ) {
    throw new PlannerReleaseError("A release artifact has invalid contract fields.");
  }
  if (
    (value.artifactType === "stage" && value.predecessorSha256 !== null) ||
    (value.artifactType !== "stage" && !isSha256(value.predecessorSha256))
  ) {
    throw new PlannerReleaseError("A release artifact has an invalid predecessor identity.");
  }
  if (value.artifactType === "auth-lifecycle") inspectCredentialKeys(value.projection);
  assertDurableReleaseEvidenceProjection(value.artifactType, value.projection);
  const expectedHash = sha256ReleaseJson(artifactBody(value));
  if (value.sha256 !== expectedHash) {
    throw new PlannerReleaseError("A release artifact failed its canonical SHA-256 check.");
  }
  if (expected.artifactType !== undefined && value.artifactType !== expected.artifactType) {
    throw new PlannerReleaseError("A release artifact type does not match the requested contract.");
  }
  if (expected.activationId !== undefined && value.activationId !== expected.activationId) {
    throw new PlannerReleaseError("A release artifact activation ID does not match the transaction.");
  }
  if (
    expected.predecessorSha256 !== undefined &&
    value.predecessorSha256 !== expected.predecessorSha256
  ) {
    throw new PlannerReleaseError("A release artifact predecessor does not match the hash chain.");
  }
  if (
    expected.operatorSha256 !== undefined &&
    value.projection.operatorSha256 !== expected.operatorSha256
  ) {
    throw new PlannerReleaseError("A release artifact does not bind the installed operator identity.");
  }
  assertBoundedReleaseJson(value);
  return value;
}

export function assertReleaseArtifactChain(artifacts, options = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new PlannerReleaseError("A release artifact chain must contain at least one artifact.");
  }
  let previous = null;
  let previousIndex = -1;
  for (const artifact of artifacts) {
    assertReleaseArtifact(artifact, {
      activationId: options.activationId,
      predecessorSha256: previous?.sha256 ?? null,
    });
    const index = MAIN_CHAIN_INDEX.get(artifact.artifactType);
    if (index === undefined || index !== previousIndex + 1) {
      throw new PlannerReleaseError("The release artifact chain is not in canonical order.");
    }
    if (
      options.operatorSha256 !== undefined &&
      artifact.artifactType !== "stage" &&
      artifact.projection.operatorSha256 !== options.operatorSha256
    ) {
      throw new PlannerReleaseError("The release artifact chain changed operator identity.");
    }
    previous = artifact;
    previousIndex = index;
  }
  return artifacts;
}

function pointerBody(value) {
  if (value.pointerType === "pending") {
    return {
      schemaVersion: RELEASE_CONTRACT_VERSION,
      pointerType: "pending",
      generation: value.generation,
      activationId: value.activationId,
      operatorSha256: value.operatorSha256,
      updatedAt: value.updatedAt,
    };
  }
  return {
    schemaVersion: RELEASE_CONTRACT_VERSION,
    pointerType: "current",
    generation: value.generation,
    activationId: value.activationId,
    operatorSha256: value.operatorSha256,
    activationSha256: value.activationSha256,
    rollbackSha256: value.rollbackSha256,
    updatedAt: value.updatedAt,
  };
}

export function createReleasePointer({
  pointerType,
  generation,
  activationId,
  operatorSha256,
  activationSha256 = undefined,
  rollbackSha256 = undefined,
  updatedAt,
}) {
  if (!POINTER_TYPES.has(pointerType)) {
    throw new PlannerReleaseInputError("A release pointer type must be pending or current.");
  }
  const candidate = {
    pointerType,
    generation,
    activationId,
    operatorSha256,
    activationSha256,
    rollbackSha256,
    updatedAt,
  };
  const body = pointerBody(candidate);
  const pointer = Object.freeze({ ...body, sha256: sha256ReleaseJson(body) });
  return assertReleasePointer(pointer, { pointerType });
}

export function assertReleasePointer(value, expected = {}) {
  const pointerType = value?.pointerType;
  const keys = pointerType === "pending"
    ? ["schemaVersion", "pointerType", "generation", "activationId", "operatorSha256", "updatedAt", "sha256"]
    : [
        "schemaVersion",
        "pointerType",
        "generation",
        "activationId",
        "operatorSha256",
        "activationSha256",
        "rollbackSha256",
        "updatedAt",
        "sha256",
      ];
  if (!POINTER_TYPES.has(pointerType) || !exactKeys(value, keys)) {
    throw new PlannerReleaseError("A release pointer has an invalid exact envelope.");
  }
  if (
    value.schemaVersion !== RELEASE_CONTRACT_VERSION ||
    !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    !isActivationId(value.activationId) ||
    !isSha256(value.operatorSha256) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !isSha256(value.sha256)
  ) {
    throw new PlannerReleaseError("A release pointer has invalid contract fields.");
  }
  if (
    pointerType === "current" &&
    (!isSha256(value.activationSha256) ||
      !(value.rollbackSha256 === null || isSha256(value.rollbackSha256)))
  ) {
    throw new PlannerReleaseError("A current release pointer has invalid receipt identities.");
  }
  if (value.sha256 !== sha256ReleaseJson(pointerBody(value))) {
    throw new PlannerReleaseError("A release pointer failed its canonical SHA-256 check.");
  }
  if (expected.pointerType !== undefined && pointerType !== expected.pointerType) {
    throw new PlannerReleaseError("A release pointer type does not match the requested contract.");
  }
  if (expected.activationId !== undefined && value.activationId !== expected.activationId) {
    throw new PlannerReleaseError("A release pointer names a different activation ID.");
  }
  if (expected.operatorSha256 !== undefined && value.operatorSha256 !== expected.operatorSha256) {
    throw new PlannerReleaseError("A release pointer names a different installed operator.");
  }
  return value;
}

function normalizeAbsoluteHome(home) {
  if (typeof home !== "string" || !isAbsolute(home) || resolve(home) !== home) {
    throw new PlannerReleaseInputError("HOME must be an absolute normalized path.");
  }
  return home;
}

export function derivePlannerReleaseLayout(home, activationId = null) {
  const canonicalHome = normalizeAbsoluteHome(home);
  if (activationId !== null && !isActivationId(activationId)) {
    throw new PlannerReleaseInputError("A transaction path requires a canonical activation ID.");
  }
  const root = join(canonicalHome, "meal-planner");
  const cacheRoot = join(root, "cache");
  const releasesRoot = join(root, "releases");
  const transactionRoot = activationId === null ? null : join(releasesRoot, activationId);
  const transactionPath = (name) => transactionRoot === null ? null : join(transactionRoot, name);
  return Object.freeze({
    home: canonicalHome,
    root,
    appRoot: join(root, "app"),
    agentRoot: join(root, "agent"),
    agentConfigPath: join(root, "agent", "config.toml"),
    agentInstructionsPath: join(root, "agent", "AGENTS.md"),
    agentRuntimeRoot: join(root, "agent", ".planner-runtime"),
    dataRoot: join(root, "data"),
    cacheRoot,
    npmCacheRoot: join(cacheRoot, "npm"),
    runRoot: join(root, "run"),
    runtimeOwnerSocketPath: join(root, "run", "runtime-owner.sock"),
    globalCodexSocketPath: join(root, "run", "global-codex.sock"),
    releasesRoot,
    operatorRoot: join(releasesRoot, "operator"),
    currentPath: join(releasesRoot, "current.json"),
    pendingPath: join(releasesRoot, "pending.json"),
    activationId,
    transactionRoot,
    stagePath: transactionPath("stage.json"),
    installedPath: transactionPath("installed.json"),
    authLifecyclePath: transactionPath("auth-lifecycle.json"),
    releaseCandidatePath: transactionPath("release-candidate.json"),
    qaPath: transactionPath("qa.json"),
    activationPath: transactionPath("activation.json"),
    previousActivationPath: transactionPath("previous-activation.json"),
    rollbackPath: transactionPath("rollback.json"),
    journalPath: transactionPath("journal.json"),
    operatorSourceRoot: transactionPath("operator-source"),
    candidateSourceRoot: transactionPath("candidate-source"),
    baselineSourceRoot: transactionPath("baseline-source"),
    rollbackDataRoot: transactionPath("rollback-data"),
    candidateDataRoot: transactionPath("candidate-data"),
    parkedCurrentAppRoot: transactionPath("parked-current-app"),
    parkedCurrentDataRoot: transactionPath("parked-current-data"),
    priorAgentConfigRoot: transactionPath("prior-agent-config"),
    supersededDataRoot: transactionPath("superseded-data"),
    qaRoot: transactionPath("qa"),
  });
}

export function deriveInstalledOperatorPath(layoutOrHome, operatorSha256) {
  if (!isSha256(operatorSha256)) {
    throw new PlannerReleaseInputError("An installed operator path requires a SHA-256 identity.");
  }
  const layout = typeof layoutOrHome === "string"
    ? derivePlannerReleaseLayout(layoutOrHome)
    : layoutOrHome;
  if (!layout || typeof layout.operatorRoot !== "string") {
    throw new PlannerReleaseInputError("An installed operator path requires a release layout.");
  }
  return join(layout.operatorRoot, operatorSha256);
}

export function assertPathInside(root, candidate, label = "release path") {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new PlannerReleaseInputError(`${label} must be absolute.`);
  }
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new PlannerReleaseInputError(`${label} must be a child of its derived root.`);
  }
  return candidate;
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new PlannerReleaseInputError(`${flag} requires one value.`);
  }
  return value;
}

function parseClosedOptions(argv, specification) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const option = specification[flag];
    if (!option) throw new PlannerReleaseInputError(`Unsupported release argument: ${flag}`);
    if (Object.hasOwn(values, option.key)) {
      throw new PlannerReleaseInputError(`${flag} may be supplied only once.`);
    }
    if (option.boolean) {
      values[option.key] = true;
      continue;
    }
    values[option.key] = requiredValue(argv, index, flag);
    index += 1;
  }
  for (const option of Object.values(specification)) {
    if (option.required && !Object.hasOwn(values, option.key)) {
      throw new PlannerReleaseInputError(`The release command requires ${option.flag}.`);
    }
  }
  return values;
}

function validateAbsoluteArgument(value, flag) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new PlannerReleaseInputError(`${flag} requires an absolute normalized path.`);
  }
  return value;
}

export function parseDataLossAuthorization(value) {
  if (typeof value !== "string") {
    throw new PlannerReleaseInputError("The data-loss authorization is invalid.");
  }
  const parts = value.split(":");
  if (parts.length !== 3 || !isActivationId(parts[0]) || !isSha256(parts[1]) || !isSha256(parts[2])) {
    throw new PlannerReleaseInputError(
      "--authorize-data-loss must be <activation-id>:<current-store-sha256>:<restore-store-sha256>.",
    );
  }
  return Object.freeze({
    activationId: parts[0],
    currentStoreSha256: parts[1],
    restoreStoreSha256: parts[2],
    value,
  });
}

export function parsePlannerReleaseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    throw new PlannerReleaseInputError("Usage: planner-release <stage|activate|status|recover|rollback> ...");
  }
  const [command, ...rest] = argv;
  let parsed;
  switch (command) {
    case "stage": {
      parsed = parseClosedOptions(rest, {
        "--candidate-source": { flag: "--candidate-source", key: "candidateSource", required: true },
        "--baseline-commit": { flag: "--baseline-commit", key: "baselineCommit", required: true },
        "--data-source": { flag: "--data-source", key: "dataSource", required: true },
        "--agent-source": { flag: "--agent-source", key: "agentSource", required: false },
      });
      validateAbsoluteArgument(parsed.candidateSource, "--candidate-source");
      validateAbsoluteArgument(parsed.dataSource, "--data-source");
      if (parsed.agentSource !== undefined) {
        validateAbsoluteArgument(parsed.agentSource, "--agent-source");
      }
      if (!COMMIT_SHA.test(parsed.baselineCommit)) {
        throw new PlannerReleaseInputError("--baseline-commit requires one lowercase 40-hex commit.");
      }
      return Object.freeze({ command, ...parsed, agentSource: parsed.agentSource ?? null });
    }
    case "activate": {
      parsed = parseClosedOptions(rest, {
        "--transaction": { flag: "--transaction", key: "transaction", required: true },
        "--authorized": { flag: "--authorized", key: "authorized", required: true, boolean: true },
        "--confirm-uninitialized-authority": {
          flag: "--confirm-uninitialized-authority",
          key: "confirmUninitializedAuthority",
          required: false,
          boolean: true,
        },
        "--supersede-pending": {
          flag: "--supersede-pending",
          key: "supersedePending",
          required: false,
        },
      });
      if (!isActivationId(parsed.transaction)) {
        throw new PlannerReleaseInputError("--transaction requires a canonical activation ID.");
      }
      if (parsed.supersedePending !== undefined && !isActivationId(parsed.supersedePending)) {
        throw new PlannerReleaseInputError(
          "--supersede-pending requires a canonical activation ID.",
        );
      }
      if (parsed.supersedePending === parsed.transaction) {
        throw new PlannerReleaseInputError(
          "--supersede-pending must name a different transaction.",
        );
      }
      return Object.freeze({
        command,
        transaction: parsed.transaction,
        authorized: true,
        confirmUninitializedAuthority: parsed.confirmUninitializedAuthority === true,
        supersedePending: parsed.supersedePending ?? null,
      });
    }
    case "status": {
      parsed = parseClosedOptions(rest, {
        "--transaction": { flag: "--transaction", key: "transaction", required: false },
      });
      if (parsed.transaction !== undefined && !isActivationId(parsed.transaction)) {
        throw new PlannerReleaseInputError("--transaction requires a canonical activation ID.");
      }
      return Object.freeze({ command, transaction: parsed.transaction ?? null });
    }
    case "recover": {
      parsed = parseClosedOptions(rest, {
        "--transaction": { flag: "--transaction", key: "transaction", required: true },
      });
      if (!isActivationId(parsed.transaction)) {
        throw new PlannerReleaseInputError("--transaction requires a canonical activation ID.");
      }
      return Object.freeze({ command, transaction: parsed.transaction });
    }
    case "rollback": {
      parsed = parseClosedOptions(rest, {
        "--transaction": { flag: "--transaction", key: "transaction", required: true },
        "--authorize-data-loss": {
          flag: "--authorize-data-loss",
          key: "authorizeDataLoss",
          required: false,
        },
      });
      if (!isActivationId(parsed.transaction)) {
        throw new PlannerReleaseInputError("--transaction requires a canonical activation ID.");
      }
      const authorization = parsed.authorizeDataLoss === undefined
        ? null
        : parseDataLossAuthorization(parsed.authorizeDataLoss);
      if (authorization !== null && authorization.activationId !== parsed.transaction) {
        throw new PlannerReleaseInputError("The data-loss authorization names a different activation ID.");
      }
      return Object.freeze({ command, transaction: parsed.transaction, authorizeDataLoss: authorization });
    }
    default:
      throw new PlannerReleaseInputError(`Unsupported release command: ${command}`);
  }
}

function transitionResult(state, event, outcome, nextState, reason) {
  return Object.freeze({ state, event, outcome, nextState, reason });
}

export function planReleaseLifecycleTransition(state, event, guards = {}) {
  if (!RELEASE_LIFECYCLE_STATES.includes(state)) {
    throw new PlannerReleaseInputError(`Unsupported release lifecycle state: ${state}`);
  }
  if (!RELEASE_LIFECYCLE_EVENTS.includes(event)) {
    throw new PlannerReleaseInputError(`Unsupported release lifecycle event: ${event}`);
  }
  if (event === "ambiguous") {
    if (state === "intervention_required") {
      return transitionResult(state, event, "idempotent", state, "already_intervention_required");
    }
    return transitionResult(state, event, "intervention", "intervention_required", "ambiguous_effect_identity");
  }
  const rollbackEvent = event === "abort" || event === "rollback";
  const reject = (reason = "event_not_allowed") => transitionResult(state, event, "reject", state, reason);
  const idempotent = (reason = "already_applied") => transitionResult(state, event, "idempotent", state, reason);
  const move = (nextState, reason = "accepted") => transitionResult(state, event, "transition", nextState, reason);

  switch (state) {
    case "staged":
      if (event === "begin") return move("preparing");
      if (rollbackEvent) return move("restoring", "abort_started");
      return reject();
    case "preparing":
      if (event === "begin") return idempotent();
      if (event === "park_previous") return move("previous_pair_parked");
      if (rollbackEvent) return move("restoring", "abort_started");
      return reject();
    case "previous_pair_parked":
      if (event === "park_previous") return idempotent();
      if (event === "select_app") return move("candidate_app_selected");
      if (rollbackEvent) return move("restoring", "abort_started");
      return reject();
    case "candidate_app_selected":
      if (event === "select_app") return idempotent();
      if (event === "select_data") return move("candidate_pair_selected");
      if (rollbackEvent) return move("restoring", "abort_started");
      return reject();
    case "candidate_pair_selected":
      if (event === "select_data") return idempotent();
      if (event === "publish_current") {
        return guards.hashChainValid === true
          ? move("committed", "full_hash_chain_valid")
          : reject("full_hash_chain_required");
      }
      if (rollbackEvent) return move("restoring", "abort_started");
      return reject();
    case "committed":
      if (event === "publish_current") return idempotent();
      if (rollbackEvent) {
        return guards.rollbackGuardPasses === true
          ? move("restoring", "rollback_guard_passed")
          : reject("rollback_guard_required");
      }
      return reject();
    case "restoring":
      if (rollbackEvent) return idempotent();
      if (event === "restore_app") return move("previous_app_restored");
      return reject();
    case "previous_app_restored":
      if (rollbackEvent || event === "restore_app") return idempotent();
      if (event === "restore_data") return move("previous_pair_restored");
      return reject();
    case "previous_pair_restored":
      if (rollbackEvent || event === "restore_app" || event === "restore_data") return idempotent();
      if (event === "publish_rollback") return move("rolled_back");
      return reject();
    case "rolled_back":
      if (
        rollbackEvent || event === "restore_app" || event === "restore_data" ||
        event === "publish_rollback"
      ) return idempotent();
      return reject();
    case "intervention_required":
      return reject("manual_intervention_required");
    default:
      return reject();
  }
}

export function applyReleaseLifecycleTransition(state, event, guards = {}) {
  const result = planReleaseLifecycleTransition(state, event, guards);
  if (result.outcome === "reject") {
    throw new PlannerReleaseError(
      `Release lifecycle rejected ${event} from ${state}: ${result.reason}.`,
    );
  }
  return result;
}

function releaseJournalEnvelopeBody(journal) {
  return {
    schemaVersion: journal.schemaVersion,
    activationId: journal.activationId,
    generation: journal.generation,
    state: journal.state,
    entries: journal.entries,
  };
}

export function assertReleaseJournalEnvelope(value, expected = {}) {
  if (!exactKeys(value, ["schemaVersion", "activationId", "generation", "state", "entries", "sha256"])) {
    throw new PlannerReleaseError("A release journal has an invalid exact envelope.");
  }
  if (
    value.schemaVersion !== RELEASE_CONTRACT_VERSION ||
    !isActivationId(value.activationId) ||
    !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    !RELEASE_LIFECYCLE_STATES.includes(value.state) ||
    !Array.isArray(value.entries) || value.entries.length < 1 ||
    value.generation !== value.entries.length ||
    !isSha256(value.sha256)
  ) {
    throw new PlannerReleaseError("A release journal has invalid contract fields.");
  }
  let derivedState = "staged";
  for (const [index, entry] of value.entries.entries()) {
    if (!isPlainRecord(entry) || entry.sequence !== index + 1 ||
        !Number.isFinite(Date.parse(entry.at)) || typeof entry.kind !== "string") {
      throw new PlannerReleaseError("A release journal entry has an invalid envelope.");
    }
    if (index === 0 &&
        (entry.kind !== "created" || entry.state !== "staged")) {
      throw new PlannerReleaseError("A release journal must begin with the staged creation fact.");
    }
    if (entry.kind === "transition") {
      const planned = planReleaseLifecycleTransition(derivedState, entry.event, {
        hashChainValid: true,
        rollbackGuardPasses: true,
      });
      if (
        entry.fromState !== derivedState || entry.toState !== planned.nextState ||
        entry.outcome !== planned.outcome || entry.reason !== planned.reason
      ) {
        throw new PlannerReleaseError("A release journal transition broke its lifecycle chain.");
      }
      derivedState = entry.toState;
    }
  }
  if (derivedState !== value.state ||
      value.sha256 !== sha256ReleaseJson(releaseJournalEnvelopeBody(value))) {
    throw new PlannerReleaseError("A release journal failed its state or canonical SHA-256 check.");
  }
  if (expected.activationId !== undefined && value.activationId !== expected.activationId) {
    throw new PlannerReleaseError("A release journal names a different activation ID.");
  }
  assertBoundedReleaseJson(value, RELEASE_JOURNAL_BYTES_LIMIT);
  return value;
}

async function assertCurrentUserOwnership(metadata, label) {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new PlannerReleaseError(`${label} must be owned by the current user.`);
  }
}

async function hashReleaseTreeFile(path, expectedSize) {
  const hash = createHash("sha256");
  let consumed = 0;
  for await (const chunk of createReadStream(path)) {
    consumed += chunk.length;
    if (consumed > expectedSize) {
      throw new PlannerReleaseError("A release tree file changed while it was hashed.");
    }
    hash.update(chunk);
  }
  if (consumed !== expectedSize) {
    throw new PlannerReleaseError("A release tree file changed while it was hashed.");
  }
  return hash.digest("hex");
}

export async function inventoryReleaseTree(root, options = {}) {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    throw new PlannerReleaseError("A release inventory root must be canonical.");
  }
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new PlannerReleaseError("A release inventory root must be a real directory.");
  }
  await assertCurrentUserOwnership(rootMetadata, "Release inventory root");
  const exclusions = options.excludedRootNames ?? new Set();
  const rows = [];
  const pending = [{ path: root, depth: 0 }];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > (options.maxDepth ?? RELEASE_TREE_MAX_DEPTH)) {
      throw new PlannerReleaseError("A release inventory exceeded its depth limit.");
    }
    const children = (await readdir(current.path, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (current.path === root && exclusions.has(child.name)) continue;
      const path = join(current.path, child.name);
      const fromRoot = relative(root, path);
      if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) ||
          isAbsolute(fromRoot)) {
        throw new PlannerReleaseError("A release inventory escaped its root.");
      }
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new PlannerReleaseError(`Release source contains a symbolic link: ${child.name}`);
      }
      const relativePath = fromRoot.split(sep).join("/");
      if (metadata.isDirectory()) {
        rows.push({ relativePath, kind: "directory" });
        pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!metadata.isFile()) {
        throw new PlannerReleaseError(`Release source contains a special file: ${relativePath}`);
      }
      files += 1;
      bytes += metadata.size;
      if (files > (options.maxFiles ?? RELEASE_TREE_MAX_FILES) ||
          bytes > (options.maxBytes ?? RELEASE_TREE_MAX_BYTES)) {
        throw new PlannerReleaseError("A release inventory exceeded its file or byte budget.");
      }
      const contentSha256 = await hashReleaseTreeFile(path, metadata.size);
      const after = await lstat(path);
      if (
        after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs ||
        after.ino !== metadata.ino || after.dev !== metadata.dev
      ) {
        throw new PlannerReleaseError(`Release source changed during inventory: ${relativePath}`);
      }
      rows.push({
        relativePath,
        kind: "file",
        bytes: metadata.size,
        executable: (metadata.mode & 0o111) !== 0,
        contentSha256,
      });
    }
  }
  rows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze({ files, bytes, sha256: sha256ReleaseJson(rows) });
}

export async function assertPrivateDirectory(path, options = {}) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PlannerReleaseError(`${options.label ?? "Release directory"} must be a real directory.`);
  }
  await assertCurrentUserOwnership(metadata, options.label ?? "Release directory");
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new PlannerReleaseError(`${options.label ?? "Release directory"} must have mode 0700.`);
  }
  if (await realpath(path) !== path) {
    throw new PlannerReleaseError(`${options.label ?? "Release directory"} must be canonical.`);
  }
  return metadata;
}

export async function assertImmutableReleaseDirectory(path, options = {}) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PlannerReleaseError(
      `${options.label ?? "Immutable release directory"} must be a real directory.`,
    );
  }
  await assertCurrentUserOwnership(metadata, options.label ?? "Immutable release directory");
  if ((metadata.mode & 0o777) !== 0o500) {
    throw new PlannerReleaseError(
      `${options.label ?? "Immutable release directory"} must have mode 0500.`,
    );
  }
  if (await realpath(path) !== path) {
    throw new PlannerReleaseError(
      `${options.label ?? "Immutable release directory"} must be canonical.`,
    );
  }
  return metadata;
}

export async function assertFrozenReleaseTree(path, options = {}) {
  await assertImmutableReleaseDirectory(path, options);
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryMetadata = await lstat(directory);
    await assertCurrentUserOwnership(
      directoryMetadata,
      options.label ?? "Frozen release tree",
    );
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory() ||
        (directoryMetadata.mode & 0o7777) !== 0o500) {
      throw new PlannerReleaseError(
        `${options.label ?? "Frozen release tree"} contains a directory outside mode 0500.`,
      );
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const metadata = await lstat(child);
      await assertCurrentUserOwnership(metadata, options.label ?? "Frozen release tree");
      if (metadata.isSymbolicLink()) {
        throw new PlannerReleaseError(
          `${options.label ?? "Frozen release tree"} contains a symbolic link.`,
        );
      }
      if (metadata.isDirectory()) {
        pending.push(child);
        continue;
      }
      const mode = metadata.mode & 0o7777;
      if (!metadata.isFile() || (mode !== 0o444 && mode !== 0o555)) {
        throw new PlannerReleaseError(
          `${options.label ?? "Frozen release tree"} contains a file outside mode 0444/0555.`,
        );
      }
    }
  }
  return true;
}

export async function ensurePrivateDirectory(path, options = {}) {
  try {
    await mkdir(path, { mode: 0o700, recursive: options.recursive === true });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return assertPrivateDirectory(path, options);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePrivateImmutableJson(path, value, options = {}) {
  assertBoundedReleaseJson(value, options.byteLimit ?? RELEASE_ARTIFACT_BYTES_LIMIT);
  await assertPrivateDirectory(dirname(path));
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const { link } = await import("node:fs/promises");
    try {
      await link(temporary, path);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PlannerReleaseError(`Refusing to overwrite immutable release artifact: ${path}`);
      }
      throw error;
    }
    await unlink(temporary);
    await syncDirectory(dirname(path));
    return value;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function readPrivateJson(path, options = {}) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PlannerReleaseError(`${options.label ?? "Release JSON"} must be a real regular file.`);
  }
  await assertCurrentUserOwnership(metadata, options.label ?? "Release JSON");
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new PlannerReleaseError(`${options.label ?? "Release JSON"} must have mode 0600.`);
  }
  const byteLimit = options.byteLimit ?? RELEASE_ARTIFACT_BYTES_LIMIT;
  if (metadata.size > byteLimit) {
    throw new PlannerReleaseError(`${options.label ?? "Release JSON"} exceeded its byte limit.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PlannerReleaseError(`${options.label ?? "Release JSON"} is not valid JSON.`, undefined, {
      cause: error,
    });
  }
  assertBoundedReleaseJson(parsed, byteLimit);
  return parsed;
}

async function acquireMutableJsonLock(lockPath, targetPath) {
  let database;
  try {
    try {
      const metadata = await lstat(lockPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new PlannerReleaseInterventionError(
          "A mutable release JSON SQLite mutex has an unsafe filesystem identity.",
        );
      }
      await assertCurrentUserOwnership(metadata, "Mutable release JSON SQLite mutex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    database = new DatabaseSync(lockPath);
    await chmod(lockPath, 0o600);
    const metadata = await lstat(lockPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new PlannerReleaseInterventionError(
        "A mutable release JSON SQLite mutex has an unsafe filesystem identity.",
      );
    }
    await assertCurrentUserOwnership(metadata, "Mutable release JSON SQLite mutex");
    database.exec([
      "PRAGMA busy_timeout = 0;",
      "PRAGMA journal_mode = DELETE;",
      "CREATE TABLE IF NOT EXISTS release_mutex (id INTEGER PRIMARY KEY CHECK (id = 1));",
      "BEGIN IMMEDIATE;",
    ].join("\n"));
    return Object.freeze({
      async close() {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // Closing the database still releases the OS lock after a failed rollback.
        }
        database.close();
      },
    });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the lock acquisition error.
    }
    if (error?.code === "ERR_SQLITE_ERROR" && /locked|busy/iu.test(error.message)) {
      throw new PlannerReleaseError(
        `Mutable release JSON has another active writer: ${targetPath}`,
      );
    }
    throw error;
  }
}

export async function writePrivateAtomicJson(path, value, options = {}) {
  const byteLimit = options.byteLimit ?? RELEASE_JOURNAL_BYTES_LIMIT;
  assertBoundedReleaseJson(value, byteLimit);
  await assertPrivateDirectory(dirname(path));
  const lockPath = `${path}.lock.sqlite`;
  const lockHandle = await acquireMutableJsonLock(lockPath, path);
  const expectedGeneration = options.expectedGeneration;
  try {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new PlannerReleaseInputError("Atomic release JSON requires an expected generation.");
    }
    const inspectGeneration = async () => {
      try {
        const current = await readPrivateJson(path, { byteLimit, label: "Mutable release JSON" });
        if (!Number.isSafeInteger(current.generation) || current.generation < 1) {
          throw new PlannerReleaseError("Mutable release JSON has no valid generation.");
        }
        return current.generation;
      } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
      }
    };
    const observed = await inspectGeneration();
    if (observed !== expectedGeneration) {
      throw new PlannerReleaseError(
        `Mutable release JSON generation changed (expected ${expectedGeneration}, observed ${observed}).`,
      );
    }
    if (value.generation !== expectedGeneration + 1) {
      throw new PlannerReleaseInputError("Mutable release JSON must advance generation by exactly one.");
    }
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const rechecked = await inspectGeneration();
      if (rechecked !== expectedGeneration) {
        throw new PlannerReleaseError("Mutable release JSON changed before atomic publication.");
      }
      await rename(temporary, path);
      await syncDirectory(dirname(path));
      return value;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  } finally {
    await lockHandle.close();
  }
}

export async function publishReleasePointer(path, pointer, expectedGeneration) {
  assertReleasePointer(pointer);
  return writePrivateAtomicJson(path, pointer, {
    expectedGeneration,
    byteLimit: RELEASE_ARTIFACT_BYTES_LIMIT,
  });
}

export async function readReleasePointer(path, expected = {}) {
  return assertReleasePointer(
    await readPrivateJson(path, { label: `${expected.pointerType ?? "Release"} pointer` }),
    expected,
  );
}

export async function publishReleaseArtifact(path, artifact) {
  assertReleaseArtifact(artifact);
  return writePrivateImmutableJson(path, artifact);
}

export async function readReleaseArtifact(path, expected = {}) {
  return assertReleaseArtifact(
    await readPrivateJson(path, { label: `${expected.artifactType ?? "Release"} artifact` }),
    expected,
  );
}

export async function inspectPathIdentity(path) {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new PlannerReleaseError("Release identity inspection rejects symbolic links.");
    }
    const kind = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "special";
    if (kind === "special") {
      throw new PlannerReleaseError("Release identity inspection rejects special files.");
    }
    return Object.freeze({
      exists: true,
      kind,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      size: metadata.size.toString(),
      mode: Number(metadata.mode & BigInt(0o777)),
    });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false });
    throw error;
  }
}

export async function assertInstalledReleaseStartable(home) {
  const baseLayout = derivePlannerReleaseLayout(home);
  await Promise.all([
    assertPrivateDirectory(baseLayout.root, { label: "Meal planner root" }),
    assertPrivateDirectory(baseLayout.releasesRoot, { label: "Release root" }),
  ]);
  const current = await readReleasePointer(baseLayout.currentPath, { pointerType: "current" });
  const layout = derivePlannerReleaseLayout(home, current.activationId);
  const activation = await readReleaseArtifact(layout.activationPath, {
    artifactType: "activation",
    activationId: current.activationId,
    operatorSha256: current.operatorSha256,
  });
  if (activation.sha256 !== current.activationSha256) {
    throw new PlannerReleaseError("The current pointer does not bind the installed activation receipt.");
  }
  const operatorPath = deriveInstalledOperatorPath(baseLayout, current.operatorSha256);
  await Promise.all([
    assertFrozenReleaseTree(operatorPath, { label: "Installed release operator" }),
    assertFrozenReleaseTree(layout.appRoot, { label: "Installed planner application" }),
  ]);
  const [operatorManifest, appManifest] = await Promise.all([
    inventoryReleaseTree(operatorPath),
    inventoryReleaseTree(layout.appRoot),
  ]);
  if (operatorManifest.sha256 !== current.operatorSha256) {
    throw new PlannerReleaseError(
      "The installed release operator changed from its content-addressed identity.",
    );
  }
  const observedApp = Object.freeze({ exists: true, kind: "directory", ...appManifest });
  if (!isPlainRecord(activation.projection.app) ||
      canonicalReleaseJson(observedApp) !== canonicalReleaseJson(activation.projection.app)) {
    throw new PlannerReleaseError(
      "The installed planner application changed from its activation identity.",
    );
  }

  let pending = null;
  try {
    pending = await readReleasePointer(baseLayout.pendingPath, { pointerType: "pending" });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (pending !== null) {
    const pendingLayout = derivePlannerReleaseLayout(home, pending.activationId);
    const journal = assertReleaseJournalEnvelope(await readPrivateJson(pendingLayout.journalPath, {
      byteLimit: RELEASE_JOURNAL_BYTES_LIMIT,
      label: "Pending release journal",
    }), { activationId: pending.activationId });
    if (!RELEASE_TERMINAL_STATES.includes(journal.state) || journal.state === "intervention_required") {
      throw new PlannerReleaseError(
        `Installed start is blocked by pending release state ${journal.state ?? "unknown"}.`,
      );
    }
  }
  return Object.freeze({ layout, current, activation, operatorPath });
}

export async function assertRealCanonicalPath(path, kind) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new PlannerReleaseInputError(`The ${kind} path must be absolute and normalized.`);
  }
  const metadata = await stat(path);
  if (kind === "directory" && !metadata.isDirectory()) {
    throw new PlannerReleaseInputError("The requested path is not a directory.");
  }
  if (kind === "file" && !metadata.isFile()) {
    throw new PlannerReleaseInputError("The requested path is not a regular file.");
  }
  if (await realpath(path) !== path) {
    throw new PlannerReleaseInputError("The requested path must be real and canonical.");
  }
  await assertCurrentUserOwnership(metadata, "Release input");
  return path;
}
