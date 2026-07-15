import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PlannerReleaseError,
  PlannerReleaseInputError,
  PlannerReleaseInterventionError,
  PlannerReleaseOwnershipError,
  RELEASE_ARTIFACT_BYTES_LIMIT,
  RELEASE_CONTRACT_VERSION,
  RELEASE_JOURNAL_BYTES_LIMIT,
  RELEASE_TERMINAL_STATES,
  applyReleaseLifecycleTransition,
  assertBoundedReleaseJson,
  assertPrivateDirectory,
  assertRealCanonicalPath,
  assertReleaseArtifact,
  assertReleaseArtifactChain,
  assertReleaseJournalEnvelope,
  canonicalReleaseJson,
  createActivationId,
  createReleaseArtifact,
  createReleasePointer,
  deriveInstalledOperatorPath,
  derivePlannerReleaseLayout,
  isActivationId,
  isSha256,
  inventoryReleaseTree,
  publishReleaseArtifact,
  publishReleasePointer,
  readPrivateJson,
  readReleaseArtifact,
  readReleasePointer,
  sha256ReleaseJson,
  writePrivateAtomicJson,
} from "./planner-release-contract.mjs";
import {
  releaseSourceExclusionSet,
} from "./planner-release-source.mjs";
import {
  assertPlannerReleaseAgentSourceProjection,
} from "./planner-agent-adoption.mjs";

export { RELEASE_SOURCE_EXCLUDED_ROOTS } from "./planner-release-source.mjs";
export { inventoryReleaseTree } from "./planner-release-contract.mjs";

const MAX_TREE_DEPTH = 32;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_STDOUT = 16 * 1024 * 1024;
const MAX_COMMAND_STDERR = 1024 * 1024;
const NODE_FLOOR_OPTIONS = "--disable-warning=ExperimentalWarning";
const ZERO_SHA256 = "0".repeat(64);
export const REQUIRED_NODE_FLOOR_VERSION = "v22.15.0";
const ACTIVATION_FAILURE_EFFECT = /^[a-z][a-z0-9_]{0,63}$/u;
const ACTIVATION_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const COMPENSATED_ACTIVATION_FAILURE_CODES = Object.freeze([
  "ACTIVATION_FAILED",
  "AUTH_ACCOUNT_MODE",
  "AUTH_CANCELLED",
  "AUTH_DEPLOYMENT",
  "AUTH_FINAL_READBACK",
  "AUTH_LOGIN_FAILED",
  "AUTH_LOGOUT_FAILED",
  "AUTH_NORMAL_STATE",
  "AUTH_OPERATOR_HANDOFF",
  "AUTH_PROTOCOL",
  "AUTH_REQUIRED",
  "AUTH_RESTART_READBACK",
  "AUTH_SCHEMA_CHANGED",
  "AUTH_SCHEMA_FINGERPRINT",
  "AUTH_SCHEMA_INCOMPATIBLE",
  "AUTH_SCHEMA_PARSE",
  "AUTH_SCHEMA_PATH",
  "AUTH_SCHEMA_RESOURCE",
  "AUTH_TIMEOUT",
  "IDENTITY_CHANGED",
  "INVALID_EXECUTABLE",
  "PROCESS_FAILED",
  "PROCESS_OUTPUT_LIMIT",
  "PROCESS_TIMEOUT",
  "PROBE_CAPABILITY",
  "PROBE_PROTOCOL",
  "PROBE_TIMEOUT",
  "PROVENANCE_CHANGED",
  "READBACK_PROVENANCE",
  "RESOURCE_LIMIT",
  "SCHEMA_GENERATION",
  "SCHEMA_INCOMPATIBLE",
  "SCHEMA_PARSE",
]);
const COMPENSATED_ACTIVATION_FAILURE_CODE_SET = new Set(
  COMPENSATED_ACTIVATION_FAILURE_CODES,
);
const RELEASE_EFFECT_REPLAY_VERSION = 1;
const FIRST_INSTALL_BASELINE_MANIFEST_RELATIVE_PATH =
  "deployment/release/first-install-baseline.json";
const FIRST_INSTALL_BASELINE_MANIFEST_BYTES_LIMIT = 4 * 1024;
const UNINITIALIZED_AUTHORITY_CONFIRMATION_CHECKPOINT =
  "uninitialized_authority_confirmation";
const PENDING_SUPERSESSION_CHECKPOINT = "pending_supersession";
const REPLAY_CREDENTIAL_KEYS = new Set([
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

export const RELEASE_OPERATOR_CORE_FILES = Object.freeze([
  "package.json",
  "scripts/planner-release.mjs",
  "scripts/support/codex-auth-lifecycle.mjs",
  "scripts/support/codex-auth-readiness.mjs",
  "scripts/support/codex-auth-schema.mjs",
  "scripts/support/codex-release-candidate-contract.mjs",
  "scripts/support/planner-agent-adoption.mjs",
  "scripts/support/planner-installed-qa.mjs",
  "scripts/support/planner-qa-evidence.mjs",
  "scripts/support/planner-release-composition.mjs",
  "scripts/support/planner-release-contract.mjs",
  "scripts/support/planner-release-evidence-contract.mjs",
  "scripts/support/planner-release-source.mjs",
  "scripts/support/planner-release-transaction.mjs",
  "scripts/support/runtime-ownership.mjs",
  "server/runtime/codex-follow-up/resource-policy.ts",
]);

export const RELEASE_OPERATOR_OPTIONAL_FILES = Object.freeze([
  "scripts/start-installed.mjs",
  "scripts/runtime-processes.mjs",
  "scripts/process-supervisor.mjs",
  "scripts/support/runtime-ownership.mjs",
]);

const SOURCE_EXCLUSIONS = releaseSourceExclusionSet();

function nowIso(clock = Date) {
  const value = typeof clock === "function" ? clock() : clock.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PlannerReleaseError("Release clock returned an invalid time.");
  return date.toISOString();
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSecretFreeReplay(value, path = "replay") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFreeReplay(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (REPLAY_CREDENTIAL_KEYS.has(normalized)) {
      throw new PlannerReleaseInputError(
        `A durable release replay descriptor contains forbidden credential material at ${path}.${key}.`,
      );
    }
    assertSecretFreeReplay(entry, `${path}.${key}`);
  }
}

function assertReplayDescriptor(replay) {
  if (
    !isPlainRecord(replay) ||
    replay.schemaVersion !== RELEASE_EFFECT_REPLAY_VERSION ||
    typeof replay.kind !== "string" || replay.kind.length === 0
  ) {
    throw new PlannerReleaseInputError("A durable release effect requires a versioned replay descriptor.");
  }
  assertSecretFreeReplay(replay);
  assertBoundedReleaseJson(replay, RELEASE_ARTIFACT_BYTES_LIMIT);
  return replay;
}

function replayDescriptor(kind, projection = {}) {
  return Object.freeze(assertReplayDescriptor({
    schemaVersion: RELEASE_EFFECT_REPLAY_VERSION,
    kind,
    ...projection,
  }));
}

function identityEqual(left, right) {
  return canonicalReleaseJson(left) === canonicalReleaseJson(right);
}

function pathInsideOrEqual(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
  );
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncRegularFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncReleaseTree(root) {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PlannerReleaseError("A release sync root must be a real directory.");
  }
  const directories = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      const path = join(current, child.name);
      const childMetadata = await lstat(path);
      if (childMetadata.isSymbolicLink()) {
        throw new PlannerReleaseError("Release sync rejects symbolic links.");
      }
      if (childMetadata.isDirectory()) pending.push(path);
      else if (childMetadata.isFile()) await syncRegularFile(path);
      else throw new PlannerReleaseError("Release sync rejects special files.");
    }
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

async function hashFile(path, expectedSize) {
  if (expectedSize > MAX_FILE_BYTES) {
    throw new PlannerReleaseError("A release source file exceeded its byte limit.");
  }
  const hash = createHash("sha256");
  let consumed = 0;
  for await (const chunk of createReadStream(path)) {
    consumed += chunk.length;
    if (consumed > expectedSize || consumed > MAX_FILE_BYTES) {
      throw new PlannerReleaseError("A release source file changed while it was hashed.");
    }
    hash.update(chunk);
  }
  if (consumed !== expectedSize) {
    throw new PlannerReleaseError("A release source file changed while it was hashed.");
  }
  return hash.digest("hex");
}

function normalizedExecutableMode(mode) {
  return (mode & 0o111) === 0 ? 0o444 : 0o555;
}

export async function copyReleaseTree(sourceRoot, destinationRoot, options = {}) {
  const source = await realpath(sourceRoot);
  if (source !== sourceRoot) throw new PlannerReleaseError("A release copy source must be canonical.");
  await mkdir(destinationRoot, { mode: 0o700 });
  await assertPrivateDirectory(destinationRoot);
  const exclusions = options.excludedRootNames ?? new Set();
  const pending = [{ source, destination: destinationRoot, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > (options.maxDepth ?? MAX_TREE_DEPTH)) {
      throw new PlannerReleaseError("A release copy exceeded its depth limit.");
    }
    const children = (await readdir(current.source, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (current.source === source && exclusions.has(child.name)) continue;
      const sourcePath = join(current.source, child.name);
      const destinationPath = join(current.destination, child.name);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) throw new PlannerReleaseError("Release copy rejects symbolic links.");
      if (metadata.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        pending.push({ source: sourcePath, destination: destinationPath, depth: current.depth + 1 });
      } else if (metadata.isFile()) {
        if (metadata.size > MAX_FILE_BYTES) throw new PlannerReleaseError("Release copy file is too large.");
        await copyFile(sourcePath, destinationPath, 1);
        await chmod(destinationPath, normalizedExecutableMode(metadata.mode) | 0o200);
      } else {
        throw new PlannerReleaseError("Release copy rejects special files.");
      }
    }
  }
  const [sourceManifest, destinationManifest] = await Promise.all([
    inventoryReleaseTree(source, { excludedRootNames: exclusions }),
    inventoryReleaseTree(destinationRoot),
  ]);
  if (!identityEqual(sourceManifest, destinationManifest)) {
    throw new PlannerReleaseError("A release source copy did not preserve the source manifest.");
  }
  return destinationManifest;
}

export async function freezeReleaseTree(root) {
  const pending = [root];
  const directories = [];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    for (const child of await readdir(current, { withFileTypes: true })) {
      const path = join(current, child.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new PlannerReleaseError("Release freeze rejects symbolic links.");
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) await chmod(path, normalizedExecutableMode(metadata.mode));
      else throw new PlannerReleaseError("Release freeze rejects special files.");
    }
  }
  for (const directory of directories.reverse()) await chmod(directory, 0o500);
}

export async function inspectReleaseTreeIdentity(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new PlannerReleaseError("Release tree identity rejects links.");
    if (metadata.isFile()) {
      return Object.freeze({ exists: true, kind: "file", sha256: await hashFile(path, metadata.size) });
    }
    if (!metadata.isDirectory()) throw new PlannerReleaseError("Release tree identity rejects special files.");
    return Object.freeze({ exists: true, kind: "directory", ...(await inventoryReleaseTree(path)) });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false });
    throw error;
  }
}

export function createReleaseJournal(activationId, options = {}) {
  if (!isActivationId(activationId)) throw new PlannerReleaseInputError("A release journal requires an activation ID.");
  const body = {
    schemaVersion: RELEASE_CONTRACT_VERSION,
    activationId,
    generation: 1,
    state: "staged",
    entries: [{
      sequence: 1,
      at: nowIso(options.clock),
      kind: "created",
      state: "staged",
    }],
  };
  const journal = Object.freeze({ ...body, sha256: sha256ReleaseJson(body) });
  return assertReleaseJournal(journal);
}

function assertJournalEntry(entry, index) {
  if (!isPlainRecord(entry) || entry.sequence !== index + 1 || !Number.isFinite(Date.parse(entry.at))) {
    throw new PlannerReleaseError("A release journal entry has an invalid sequence or timestamp.");
  }
  if (!["created", "transition", "intent", "completed", "abandoned", "checkpoint", "recovery"].includes(entry.kind)) {
    throw new PlannerReleaseError("A release journal entry has an unsupported kind.");
  }
  if (entry.kind === "intent") {
    if (
      typeof entry.effectId !== "string" || entry.effectId.length === 0 ||
      typeof entry.effect !== "string" || entry.effect.length === 0 ||
      !isPlainRecord(entry.expected) ||
      !Object.hasOwn(entry.expected, "pre") ||
      !Object.hasOwn(entry.expected, "post")
    ) {
      throw new PlannerReleaseError("A release intent has an invalid exact effect identity.");
    }
    assertReplayDescriptor(entry.replay);
  }
  if (
    (entry.kind === "completed" || entry.kind === "abandoned") &&
    (typeof entry.effectId !== "string" || typeof entry.effect !== "string")
  ) {
    throw new PlannerReleaseError("A release effect resolution has an invalid identity.");
  }
  assertBoundedReleaseJson(entry, RELEASE_ARTIFACT_BYTES_LIMIT);
}

export function assertReleaseJournal(value, expected = {}) {
  assertReleaseJournalEnvelope(value, expected);
  value.entries.forEach(assertJournalEntry);
  return value;
}

export function appendReleaseJournalEntry(journal, entry, state = journal.state) {
  assertReleaseJournal(journal);
  const sequence = journal.entries.length + 1;
  const normalized = Object.freeze({ sequence, ...entry });
  assertJournalEntry(normalized, sequence - 1);
  const body = {
    schemaVersion: RELEASE_CONTRACT_VERSION,
    activationId: journal.activationId,
    generation: journal.generation + 1,
    state,
    entries: [...journal.entries, normalized],
  };
  return assertReleaseJournal(Object.freeze({ ...body, sha256: sha256ReleaseJson(body) }));
}

export async function publishInitialReleaseJournal(path, journal) {
  assertReleaseJournal(journal);
  if (journal.generation !== 1) throw new PlannerReleaseInputError("An initial release journal must be generation 1.");
  return writePrivateAtomicJson(path, journal, {
    expectedGeneration: 0,
    byteLimit: RELEASE_JOURNAL_BYTES_LIMIT,
  });
}

export async function replaceReleaseJournal(path, previous, next) {
  assertReleaseJournal(previous);
  assertReleaseJournal(next, { activationId: previous.activationId });
  if (next.generation !== previous.generation + 1) {
    throw new PlannerReleaseInputError("A release journal update must advance one generation.");
  }
  return writePrivateAtomicJson(path, next, {
    expectedGeneration: previous.generation,
    byteLimit: RELEASE_JOURNAL_BYTES_LIMIT,
  });
}

export async function readReleaseJournal(path, activationId = undefined) {
  return assertReleaseJournal(await readPrivateJson(path, {
    label: "Release journal",
    byteLimit: RELEASE_JOURNAL_BYTES_LIMIT,
  }), { activationId });
}

export async function transitionReleaseJournal(path, journal, event, guards = {}, options = {}) {
  const transition = applyReleaseLifecycleTransition(journal.state, event, guards);
  const next = appendReleaseJournalEntry(journal, {
    at: nowIso(options.clock),
    kind: "transition",
    event,
    fromState: journal.state,
    toState: transition.nextState,
    outcome: transition.outcome,
    reason: transition.reason,
  }, transition.nextState);
  await replaceReleaseJournal(path, journal, next);
  return next;
}

async function recordReleaseCheckpoint(path, journal, name, projection, options = {}) {
  assertBoundedReleaseJson(projection, RELEASE_ARTIFACT_BYTES_LIMIT);
  const existing = journal.entries.find(
    (entry) => entry.kind === "checkpoint" && entry.name === name,
  );
  if (existing !== undefined) {
    if (!identityEqual(existing.projection, projection)) {
      throw new PlannerReleaseInterventionError(
        `Release checkpoint ${name} changed its durable identity.`,
      );
    }
    return journal;
  }
  const next = appendReleaseJournalEntry(journal, {
    at: nowIso(options.clock),
    kind: "checkpoint",
    name,
    projection,
  });
  await replaceReleaseJournal(path, journal, next);
  return next;
}

function readReleaseCheckpoint(journal, name) {
  return journal.entries.find(
    (entry) => entry.kind === "checkpoint" && entry.name === name,
  )?.projection ?? null;
}

export class ReleaseFaultInjector {
  #point;
  #fired = false;

  constructor(point = null) {
    this.#point = point;
  }

  hit(point) {
    if (this.#point !== point) return;
    this.#point = null;
    this.#fired = true;
    throw new PlannerReleaseError(`Injected release fault at ${point}.`);
  }

  get fired() {
    return this.#fired;
  }
}

function faultHit(injector, point) {
  injector?.hit?.(point);
}

function unresolvedIntent(journal) {
  const resolved = new Set(
    journal.entries
      .filter((entry) => entry.kind === "completed" || entry.kind === "abandoned")
      .map((entry) => entry.effectId),
  );
  const intents = journal.entries.filter((entry) => entry.kind === "intent" && !resolved.has(entry.effectId));
  if (intents.length > 1) {
    throw new PlannerReleaseInterventionError("The release journal contains multiple unresolved effects.");
  }
  return intents[0] ?? null;
}

export function planReleaseIntentRecovery(journal) {
  const intent = unresolvedIntent(journal);
  if (intent === null) return Object.freeze({ action: "continue", intent: null });
  const restoringTransitions = journal.entries.filter(
    (entry) => entry.kind === "transition" && entry.toState === "restoring",
  );
  const restoringStates = new Set([
    "restoring",
    "previous_app_restored",
    "previous_pair_restored",
  ]);
  if (!restoringStates.has(journal.state)) {
    return Object.freeze({ action: "recover_forward", intent });
  }
  if (restoringTransitions.length !== 1) {
    throw new PlannerReleaseInterventionError(
      "A restoring release journal must have one durable compensation transition.",
    );
  }
  const transition = restoringTransitions[0];
  if (transition.fromState === "committed") {
    throw new PlannerReleaseInterventionError(
      "Post-commit rollback cannot inherit an unresolved pre-rollback effect.",
    );
  }
  if (intent.sequence < transition.sequence) {
    if (journal.state !== "restoring") {
      throw new PlannerReleaseInterventionError(
        "A failed forward effect remained unresolved after application restoration began.",
      );
    }
    return Object.freeze({ action: "settle_failed_forward", intent });
  }
  return Object.freeze({ action: "recover_compensation", intent });
}

function compensatedActivationFailure(journal, error, originatingEffect = null) {
  const abandoned = journal.entries.findLast?.((entry) => entry.kind === "abandoned") ??
    [...journal.entries].reverse().find((entry) => entry.kind === "abandoned");
  const candidateEffect = originatingEffect ?? abandoned?.effect;
  const effect = typeof candidateEffect === "string" &&
      ACTIVATION_FAILURE_EFFECT.test(candidateEffect)
    ? candidateEffect
    : "activation";
  let candidateCode;
  try {
    candidateCode = error !== null && typeof error === "object" ? error.code : undefined;
  } catch {
    candidateCode = undefined;
  }
  const code = typeof candidateCode === "string" &&
      ACTIVATION_FAILURE_CODE.test(candidateCode) &&
      COMPENSATED_ACTIVATION_FAILURE_CODE_SET.has(candidateCode)
    ? candidateCode
    : "ACTIVATION_FAILED";
  return Object.freeze({ effect, code });
}

function assertEffect(effect) {
  if (
    !isPlainRecord(effect) || typeof effect.name !== "string" || effect.name.length === 0 ||
    !isPlainRecord(effect.expected) ||
    !Object.hasOwn(effect.expected, "pre") || !Object.hasOwn(effect.expected, "post") ||
    !isPlainRecord(effect.replay) ||
    typeof effect.inspect !== "function" || typeof effect.perform !== "function"
  ) {
    throw new PlannerReleaseInputError("A durable release effect has an invalid port contract.");
  }
  assertBoundedReleaseJson(effect.expected, RELEASE_ARTIFACT_BYTES_LIMIT);
  assertReplayDescriptor(effect.replay);
  return effect;
}

async function inspectEffect(effect) {
  const result = await effect.inspect();
  if (!isPlainRecord(result) || !["pre", "post", "neither"].includes(result.classification)) {
    throw new PlannerReleaseInterventionError(`Release effect ${effect.name} returned an invalid classification.`);
  }
  if (result.classification === "pre" && !identityEqual(result.identity, effect.expected.pre)) {
    throw new PlannerReleaseInterventionError(`Release effect ${effect.name} pre-state identity drifted.`);
  }
  if (result.classification === "post" && !identityEqual(result.identity, effect.expected.post)) {
    throw new PlannerReleaseInterventionError(`Release effect ${effect.name} post-state identity drifted.`);
  }
  return result;
}

async function markIntervention(path, journal, effectName, options = {}) {
  let next = appendReleaseJournalEntry(journal, {
    at: nowIso(options.clock),
    kind: "recovery",
    effect: effectName,
    classification: "neither",
    disposition: "intervention_required",
  });
  await replaceReleaseJournal(path, journal, next);
  next = await transitionReleaseJournal(path, next, "ambiguous", {}, options);
  return next;
}

export async function runRecordedReleaseEffect({
  journalPath,
  journal,
  effect,
  faultInjector = null,
  clock = Date,
}) {
  assertEffect(effect);
  if (unresolvedIntent(journal) !== null) {
    throw new PlannerReleaseInterventionError("A new release effect cannot start while another intent is unresolved.");
  }
  const initial = await inspectEffect(effect);
  if (initial.classification !== "pre") {
    if (initial.classification === "neither") await markIntervention(journalPath, journal, effect.name, { clock });
    throw new PlannerReleaseInterventionError(`Release effect ${effect.name} did not begin in its exact pre-state.`);
  }
  faultHit(faultInjector, `before_intent:${effect.name}`);
  const effectId = `${journal.entries.length + 1}:${effect.name}`;
  let current = appendReleaseJournalEntry(journal, {
    at: nowIso(clock),
    kind: "intent",
    effectId,
    effect: effect.name,
    expected: effect.expected,
    replay: effect.replay,
  });
  await replaceReleaseJournal(journalPath, journal, current);
  faultHit(faultInjector, `after_intent:${effect.name}`);
  await effect.perform();
  faultHit(faultInjector, `after_effect:${effect.name}`);
  const observed = await inspectEffect(effect);
  if (observed.classification !== "post") {
    current = await markIntervention(journalPath, current, effect.name, { clock });
    throw new PlannerReleaseInterventionError(`Release effect ${effect.name} did not reach its exact post-state.`);
  }
  const completed = appendReleaseJournalEntry(current, {
    at: nowIso(clock),
    kind: "completed",
    effectId,
    effect: effect.name,
    observed: observed.identity,
  });
  await replaceReleaseJournal(journalPath, current, completed);
  faultHit(faultInjector, `after_completed:${effect.name}`);
  return completed;
}

export async function recoverRecordedReleaseEffect({
  journalPath,
  journal,
  createEffect,
  faultInjector = null,
  clock = Date,
}) {
  const intent = unresolvedIntent(journal);
  if (intent === null) return Object.freeze({ journal, recovered: false, replayed: false });
  const effect = assertEffect(await createEffect(intent));
  if (
    effect.name !== intent.effect ||
    !identityEqual(effect.expected, intent.expected) ||
    !identityEqual(effect.replay, intent.replay)
  ) {
    await markIntervention(journalPath, journal, intent.effect, { clock });
    throw new PlannerReleaseInterventionError("Recovered release effect does not match its durable intent.");
  }
  let observed = await inspectEffect(effect);
  let replayed = false;
  if (observed.classification === "neither") {
    await markIntervention(journalPath, journal, effect.name, { clock });
    throw new PlannerReleaseInterventionError(`Release effect ${effect.name} is neither exact pre-state nor post-state.`);
  }
  if (observed.classification === "pre") {
    faultHit(faultInjector, `before_replay:${effect.name}`);
    await effect.perform();
    replayed = true;
    faultHit(faultInjector, `after_replay:${effect.name}`);
    observed = await inspectEffect(effect);
    if (observed.classification !== "post") {
      await markIntervention(journalPath, journal, effect.name, { clock });
      throw new PlannerReleaseInterventionError(`Replayed release effect ${effect.name} did not reach post-state.`);
    }
  }
  const completed = appendReleaseJournalEntry(journal, {
    at: nowIso(clock),
    kind: "completed",
    effectId: intent.effectId,
    effect: effect.name,
    observed: observed.identity,
  });
  await replaceReleaseJournal(journalPath, journal, completed);
  return Object.freeze({ journal: completed, recovered: true, replayed });
}

export async function createRenameReleaseEffect({ name, source, destination, expectedIdentity = undefined }) {
  if (dirname(source) === dirname(destination) && source === destination) {
    throw new PlannerReleaseInputError("A release rename effect requires distinct paths.");
  }
  const sourceIdentity = expectedIdentity ?? await inspectReleaseTreeIdentity(source);
  if (sourceIdentity.exists !== true) throw new PlannerReleaseInputError("A release rename source must exist.");
  const expected = {
    pre: { source: sourceIdentity, destination: { exists: false } },
    post: { source: { exists: false }, destination: sourceIdentity },
  };
  const inspect = async () => {
    const identity = {
      source: await inspectReleaseTreeIdentity(source),
      destination: await inspectReleaseTreeIdentity(destination),
    };
    if (identityEqual(identity, expected.pre)) return { classification: "pre", identity };
    if (identityEqual(identity, expected.post)) return { classification: "post", identity };
    return { classification: "neither", identity };
  };
  return Object.freeze({
    name,
    expected,
    replay: replayDescriptor("tree-rename", { source, destination }),
    inspect,
    async perform() {
      await rename(source, destination);
      await syncDirectory(dirname(source));
      if (dirname(destination) !== dirname(source)) await syncDirectory(dirname(destination));
    },
  });
}

function collectBounded(stream, byteLimit, label) {
  return new Promise((resolveCollect, reject) => {
    const chunks = [];
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > byteLimit) {
        reject(new PlannerReleaseError(`${label} exceeded its byte limit.`));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolveCollect(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function runReleaseCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  const stdoutPromise = collectBounded(child.stdout, options.stdoutLimit ?? MAX_COMMAND_STDOUT, "Command stdout");
  const stderrPromise = collectBounded(child.stderr, options.stderrLimit ?? MAX_COMMAND_STDERR, "Command stderr");
  const result = await new Promise((resolveChild, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (result.code !== 0 || result.signal !== null) {
    const stderrSummary = stderr.trim().slice(0, 512);
    const stdoutSummary = options.failureStdoutSummary === true
      ? stdout.trim().slice(-4_096)
      : "";
    const summary = [stderrSummary, stdoutSummary].filter(Boolean).join("\n") ||
      `exit ${result.code ?? "unknown"}`;
    throw new PlannerReleaseError(`${command} failed: ${summary}`);
  }
  if (options.requireEmptyStderr === true && stderr.length !== 0) {
    throw new PlannerReleaseError(
      `${command} wrote unexpected stderr: ${stderr.trim().slice(0, 512)}`,
    );
  }
  return Object.freeze({ ...result, stdout, stderr });
}

function tarString(buffer, start, length) {
  const bytes = buffer.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul === -1 ? bytes.length : nul).toString("utf8");
}

function tarOctal(buffer, start, length) {
  const value = tarString(buffer, start, length).trim().replaceAll("\0", "");
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) throw new PlannerReleaseError("A Git archive contains an invalid tar integer.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlannerReleaseError("A Git archive tar integer exceeded the supported range.");
  }
  return parsed;
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const result = await handle.read(buffer, consumed, length - consumed, position + consumed);
    if (result.bytesRead === 0) throw new PlannerReleaseError("A Git archive ended unexpectedly.");
    consumed += result.bytesRead;
  }
  return buffer;
}

function parsePax(payload) {
  const values = {};
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) throw new PlannerReleaseError("A Git archive contains malformed pax metadata.");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      throw new PlannerReleaseError("A Git archive contains malformed pax record length.");
    }
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || offset + length > payload.length || length > 64 * 1024) {
      throw new PlannerReleaseError("A Git archive pax record exceeded its bound.");
    }
    const record = payload.subarray(space + 1, offset + length - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (separator !== -1) values[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return values;
}

function safeArchivePath(root, archivePath) {
  if (
    typeof archivePath !== "string" || archivePath.length === 0 || archivePath.includes("\0") ||
    archivePath.startsWith("/") || archivePath.includes("\\")
  ) {
    throw new PlannerReleaseError("A Git archive contains an unsafe path.");
  }
  const segments = archivePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new PlannerReleaseError("A Git archive path escaped its destination.");
  }
  const destination = join(root, ...segments);
  if (!pathInsideOrEqual(root, destination) || destination === root) {
    throw new PlannerReleaseError("A Git archive path escaped its destination.");
  }
  return destination;
}

export async function extractGitArchiveSafely(archivePath, destinationRoot) {
  await mkdir(destinationRoot, { mode: 0o700 });
  const handle = await open(archivePath, "r");
  let position = 0;
  let nextPath = null;
  let zeroBlocks = 0;
  try {
    const archiveMetadata = await handle.stat();
    while (position + 512 <= archiveMetadata.size) {
      const header = await readExactly(handle, 512, position);
      position += 512;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break;
        continue;
      }
      zeroBlocks = 0;
      const storedChecksum = tarOctal(header, 148, 8);
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      const computedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
      if (storedChecksum !== computedChecksum) {
        throw new PlannerReleaseError("A Git archive tar header failed its checksum.");
      }
      const prefix = tarString(header, 345, 155);
      const headerName = tarString(header, 0, 100);
      const rawPath = prefix ? `${prefix}/${headerName}` : headerName;
      const mode = tarOctal(header, 100, 8);
      const size = tarOctal(header, 124, 12);
      if (size > MAX_FILE_BYTES) throw new PlannerReleaseError("A Git archive entry exceeded its byte limit.");
      const type = String.fromCharCode(header[156] || 0);
      const payloadPosition = position;
      const alignedSize = Math.ceil(size / 512) * 512;
      if (payloadPosition + alignedSize > archiveMetadata.size) {
        throw new PlannerReleaseError("A Git archive entry exceeded the archive bounds.");
      }

      if (type === "x" || type === "g" || type === "L") {
        const payload = await readExactly(handle, size, payloadPosition);
        if (type === "x") nextPath = parsePax(payload).path ?? nextPath;
        if (type === "L") nextPath = payload.subarray(0, Math.max(0, payload.length - 1)).toString("utf8");
        position += alignedSize;
        continue;
      }
      const path = safeArchivePath(destinationRoot, nextPath ?? rawPath);
      nextPath = null;
      if (type === "5") {
        await mkdir(path, { recursive: true, mode: 0o700 });
      } else if (type === "0" || type === "\0") {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const output = await open(path, "wx", normalizedExecutableMode(mode) | 0o200);
        try {
          let copied = 0;
          while (copied < size) {
            const length = Math.min(1024 * 1024, size - copied);
            const chunk = await readExactly(handle, length, payloadPosition + copied);
            await output.write(chunk);
            copied += length;
          }
          await output.sync();
        } finally {
          await output.close();
        }
      } else {
        throw new PlannerReleaseError("A Git archive contains a link or unsupported entry type.");
      }
      position += alignedSize;
    }
  } finally {
    await handle.close();
  }
  await syncReleaseTree(destinationRoot);
  return inventoryReleaseTree(destinationRoot);
}

async function resolveExecutable(name, environment) {
  const pathEntries = (environment.PATH ?? "").split(":").filter(Boolean);
  for (const directory of pathEntries) {
    const candidate = join(directory, name);
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile()) return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new PlannerReleaseError(`Unable to resolve required executable ${name}.`);
}

function normalizeDependency(name, value) {
  if (!isPlainRecord(value)) return { name, version: null, dependencies: {} };
  const dependencies = {};
  for (const childName of Object.keys(value.dependencies ?? {}).sort()) {
    dependencies[childName] = normalizeDependency(childName, value.dependencies[childName]);
  }
  return {
    name,
    version: typeof value.version === "string" ? value.version : null,
    dependencies,
  };
}

export function normalizeNpmDependencyGraph(value) {
  if (!isPlainRecord(value)) throw new PlannerReleaseError("npm ls did not return a JSON object.");
  return normalizeDependency(typeof value.name === "string" ? value.name : "root", value);
}

async function hashRequiredFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
    throw new PlannerReleaseError(`${label} must be a bounded regular file.`);
  }
  return hashFile(path, metadata.size);
}

async function copyOperatorBundle(candidateSourceRoot, operatorSourceRoot, options = {}) {
  await mkdir(operatorSourceRoot, { mode: 0o700 });
  const relativePaths = new Set(options.coreFiles ?? RELEASE_OPERATOR_CORE_FILES);
  for (const optional of options.optionalFiles ?? RELEASE_OPERATOR_OPTIONAL_FILES) {
    try {
      const metadata = await lstat(join(candidateSourceRoot, optional));
      if (metadata.isFile() && !metadata.isSymbolicLink()) relativePaths.add(optional);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const relativePath of relativePaths) {
    if (isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new PlannerReleaseInputError("An operator bundle path must be a safe source-relative path.");
    }
    const source = join(candidateSourceRoot, relativePath);
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
      throw new PlannerReleaseError(`Required release operator file is not regular: ${relativePath}`);
    }
    const destination = join(operatorSourceRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, 1);
    await chmod(destination, normalizedExecutableMode(sourceMetadata.mode) | 0o200);
  }
  return inventoryReleaseTree(operatorSourceRoot);
}

async function runNpmProofCopy({
  sourceRoot,
  proofRoot,
  node,
  npmCli,
  npmCacheRoot,
  environment,
  runCommand,
  runTests,
}) {
  await copyReleaseTree(sourceRoot, proofRoot);
  const npmEnvironment = {
    ...environment,
    PATH: `${dirname(node)}:${environment.PATH ?? ""}`,
    NODE_OPTIONS: NODE_FLOOR_OPTIONS,
    npm_config_cache: npmCacheRoot,
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const runNpm = (args, options = {}) => runCommand(node, [npmCli, ...args], {
    ...options,
    cwd: proofRoot,
    env: npmEnvironment,
    requireEmptyStderr: true,
  });
  await runNpm(["ci", "--cache", npmCacheRoot]);
  const graphResult = await runNpm(["ls", "--all", "--json"]);
  const dependencyGraph = normalizeNpmDependencyGraph(JSON.parse(graphResult.stdout));
  if (runTests) await runNpm(["run", "lint"]);
  await runNpm(["run", "build"]);
  if (runTests) {
    await runNpm(["test"], {
      failureStdoutSummary: true,
    });
  }
  return Object.freeze({
    cleanInstall: true,
    build: true,
    lint: runTests,
    mergeSuite: runTests,
    dependencyGraphSha256: sha256ReleaseJson(dependencyGraph),
  });
}

async function inspectExactNodeFloor(environment, runCommand) {
  let executable = environment.PLANNER_NODE_FLOOR_EXECUTABLE;
  if (typeof executable === "string" && executable.length > 0) {
    if (!isAbsolute(executable)) {
      throw new PlannerReleaseError("PLANNER_NODE_FLOOR_EXECUTABLE must be absolute.");
    }
    executable = await realpath(executable);
  } else {
    const mise = await resolveExecutable("mise", environment);
    const resolved = await runCommand(mise, [
      "exec",
      "-C",
      "/private/tmp",
      "node@22.15.0",
      "--",
      "node",
      "-p",
      "process.execPath",
    ], { env: environment });
    executable = await realpath(resolved.stdout.trim());
  }
  const versionResult = await runCommand(executable, ["--version"], {
    env: environment,
    requireEmptyStderr: true,
  });
  const version = versionResult.stdout.trim();
  if (version !== REQUIRED_NODE_FLOOR_VERSION) {
    throw new PlannerReleaseError(
      `Stage requires exact Node ${REQUIRED_NODE_FLOOR_VERSION}; resolved ${version || "unknown"}.`,
    );
  }
  const npmCli = join(
    dirname(dirname(executable)),
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  await assertRealCanonicalPath(npmCli, "file");
  const npmVersionResult = await runCommand(executable, [npmCli, "--version"], {
    env: { ...environment, PATH: `${dirname(executable)}:${environment.PATH ?? ""}` },
    requireEmptyStderr: true,
  });
  return Object.freeze({
    executable,
    version,
    sha256: await hashRequiredFile(executable, "Exact Node floor executable"),
    npmCli,
    npmVersion: npmVersionResult.stdout.trim(),
    npmCliSha256: await hashRequiredFile(npmCli, "Exact Node floor npm CLI"),
  });
}

function sameNodeFloor(left, right) {
  return left.executable === right.executable &&
    left.version === right.version &&
    left.sha256 === right.sha256 &&
    left.npmCli === right.npmCli &&
    left.npmVersion === right.npmVersion &&
    left.npmCliSha256 === right.npmCliSha256;
}

function assertResolvedNodeFloor(value) {
  if (
    !isPlainRecord(value) ||
    typeof value.executable !== "string" || !isAbsolute(value.executable) ||
    value.version !== REQUIRED_NODE_FLOOR_VERSION || !isSha256(value.sha256) ||
    typeof value.npmCli !== "string" || !isAbsolute(value.npmCli) ||
    typeof value.npmVersion !== "string" || value.npmVersion.length === 0 ||
    !isSha256(value.npmCliSha256)
  ) {
    throw new PlannerReleaseError(
      `Stage requires a verified exact ${REQUIRED_NODE_FLOOR_VERSION} runtime and npm CLI.`,
    );
  }
  return value;
}

export async function runDefaultStagePreflight(context) {
  const runCommand = context.runCommand ?? runReleaseCommand;
  const environment = context.environment ?? process.env;
  const inspectNodeFloor = context.inspectNodeFloor ?? inspectExactNodeFloor;
  const nodeFloorBefore = assertResolvedNodeFloor(
    await inspectNodeFloor(environment, runCommand),
  );
  const proofCandidate = join(context.layout.transactionRoot, ".proof-candidate");
  const proofBaseline = join(context.layout.transactionRoot, ".proof-baseline");
  try {
    const baseline = await runNpmProofCopy({
      sourceRoot: context.layout.baselineSourceRoot,
      proofRoot: proofBaseline,
      node: nodeFloorBefore.executable,
      npmCli: nodeFloorBefore.npmCli,
      npmCacheRoot: context.layout.npmCacheRoot,
      environment,
      runCommand,
      runTests: false,
    });
    const candidate = await runNpmProofCopy({
      sourceRoot: context.layout.candidateSourceRoot,
      proofRoot: proofCandidate,
      node: nodeFloorBefore.executable,
      npmCli: nodeFloorBefore.npmCli,
      npmCacheRoot: context.layout.npmCacheRoot,
      environment,
      runCommand,
      runTests: true,
    });
    const nodeFloorAfter = assertResolvedNodeFloor(
      await inspectNodeFloor(environment, runCommand),
    );
    if (!sameNodeFloor(nodeFloorBefore, nodeFloorAfter)) {
      throw new PlannerReleaseError("The exact Node floor runtime changed during the stage suite.");
    }
    return Object.freeze({
      node: {
        executable: nodeFloorBefore.executable,
        version: nodeFloorBefore.version,
        sha256: nodeFloorBefore.sha256,
        exactFloorVerified: true,
        recheckedAfterSuite: true,
      },
      npm: {
        executable: nodeFloorBefore.executable,
        cli: nodeFloorBefore.npmCli,
        version: nodeFloorBefore.npmVersion,
        cliSha256: nodeFloorBefore.npmCliSha256,
      },
      candidate,
      baseline,
    });
  } finally {
    await Promise.all([
      rm(proofCandidate, { recursive: true, force: true }),
      rm(proofBaseline, { recursive: true, force: true }),
    ]);
  }
}

async function createPrivateReleaseHierarchy(home) {
  await assertRealCanonicalPath(home, "directory");
  const layout = derivePlannerReleaseLayout(home);
  for (const path of [
    layout.root,
    layout.cacheRoot,
    layout.npmCacheRoot,
    layout.releasesRoot,
    layout.operatorRoot,
  ]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await assertPrivateDirectory(path);
  }
  return layout;
}

async function createTransactionRoot(home, activationId) {
  await createPrivateReleaseHierarchy(home);
  const layout = derivePlannerReleaseLayout(home, activationId);
  await mkdir(layout.transactionRoot, { mode: 0o700 });
  await assertPrivateDirectory(layout.transactionRoot);
  return layout;
}

async function inspectDataSourceIdentity(path, dependencies = {}, candidateSourceRoot = null) {
  await assertRealCanonicalPath(path, "file");
  const metadata = await lstat(path, { bigint: true });
  const projection = dependencies.inspectDataSource === undefined
    ? { initialized: metadata.size > 0n }
    : await dependencies.inspectDataSource(path, candidateSourceRoot);
  if (!isPlainRecord(projection) || typeof projection.initialized !== "boolean") {
    throw new PlannerReleaseError("The data-source inspector returned an invalid projection.");
  }
  return Object.freeze({
    canonicalPath: path,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    initialized: projection.initialized,
    ...projection,
  });
}

function assertFirstInstallBaselineManifest(value) {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    typeof value.baselineCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.baselineCommit)
  ) {
    throw new PlannerReleaseInputError(
      "The release-managed first-install baseline manifest is invalid.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    baselineCommit: value.baselineCommit,
  });
}

async function readFirstInstallBaselineManifest(candidateRoot) {
  const path = join(candidateRoot, FIRST_INSTALL_BASELINE_MANIFEST_RELATIVE_PATH);
  await assertRealCanonicalPath(path, "file");
  const metadata = await lstat(path);
  if (metadata.size < 1 || metadata.size > FIRST_INSTALL_BASELINE_MANIFEST_BYTES_LIMIT) {
    throw new PlannerReleaseInputError(
      "The release-managed first-install baseline manifest exceeded its byte limit.",
    );
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PlannerReleaseInputError(
      "The release-managed first-install baseline manifest is not valid JSON.",
      { cause: error },
    );
  }
  return Object.freeze({
    ...assertFirstInstallBaselineManifest(value),
    relativePath: FIRST_INSTALL_BASELINE_MANIFEST_RELATIVE_PATH,
    sha256: await hashRequiredFile(path, "Release-managed first-install baseline manifest"),
  });
}

function assertStagePreflight(value) {
  if (
    !isPlainRecord(value) || !isPlainRecord(value.node) || !isPlainRecord(value.npm) ||
    !isPlainRecord(value.candidate) || !isPlainRecord(value.baseline) ||
    typeof value.node.executable !== "string" || !isAbsolute(value.node.executable) ||
    value.node.version !== REQUIRED_NODE_FLOOR_VERSION ||
    !isSha256(value.node.sha256) || value.node.exactFloorVerified !== true ||
    value.node.recheckedAfterSuite !== true ||
    typeof value.npm.executable !== "string" || !isAbsolute(value.npm.executable) ||
    value.npm.executable !== value.node.executable ||
    typeof value.npm.cli !== "string" || !isAbsolute(value.npm.cli) ||
    typeof value.npm.version !== "string" || !isSha256(value.npm.cliSha256) ||
    value.candidate.cleanInstall !== true || value.candidate.build !== true ||
    value.candidate.lint !== true || value.candidate.mergeSuite !== true ||
    !isSha256(value.candidate.dependencyGraphSha256) ||
    value.baseline.cleanInstall !== true || value.baseline.build !== true ||
    value.baseline.lint !== false || value.baseline.mergeSuite !== false ||
    !isSha256(value.baseline.dependencyGraphSha256)
  ) {
    throw new PlannerReleaseError(
      "The stage preflight did not prove the closed install/build/lint/test contract.",
    );
  }
  return value;
}

async function defaultExtractBaseline({ candidateSource, baselineCommit, destination, runCommand }) {
  const archivePath = join(dirname(destination), `.baseline-${randomUUID()}.tar`);
  try {
    await runCommand("git", [
      "-C",
      candidateSource,
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      baselineCommit,
    ]);
    return await extractGitArchiveSafely(archivePath, destination);
  } finally {
    await rm(archivePath, { force: true });
  }
}

export async function stageReleaseTransaction(input, dependencies = {}) {
  const activationId = (dependencies.createActivationId ?? createActivationId)();
  if (!isActivationId(activationId)) throw new PlannerReleaseError("The release ID generator returned an invalid ID.");
  const home = dependencies.home ?? process.env.HOME;
  if (typeof home !== "string") throw new PlannerReleaseInputError("The release operator requires HOME.");
  const layout = await createTransactionRoot(home, activationId);
  const runCommand = dependencies.runCommand ?? runReleaseCommand;
  let completed = false;
  try {
    await Promise.all([
      assertRealCanonicalPath(input.candidateSource, "directory"),
      assertRealCanonicalPath(input.dataSource, "file"),
    ]);
    if (!/^[a-f0-9]{40}$/u.test(input.baselineCommit)) {
      throw new PlannerReleaseInputError("Stage requires an exact lowercase 40-hex baseline commit.");
    }
    const [currentBeforeStage, baselinePolicy] = await Promise.all([
      tryReadPointer(layout.currentPath, "current"),
      readFirstInstallBaselineManifest(input.candidateSource),
    ]);
    const firstInstall = currentBeforeStage === null;
    if (firstInstall && input.baselineCommit !== baselinePolicy.baselineCommit) {
      throw new PlannerReleaseInputError(
        `First-install stage requires release-managed baseline ${baselinePolicy.baselineCommit}.`,
      );
    }
    const agentSourcePath = input.agentSource ?? null;
    if (firstInstall && agentSourcePath === null) {
      throw new PlannerReleaseInputError(
        "First-install stage requires --agent-source for the authenticated dedicated agent home.",
      );
    }
    if (!firstInstall && agentSourcePath !== null) {
      throw new PlannerReleaseInputError("Update stage rejects --agent-source.");
    }
    if (firstInstall && typeof dependencies.inspectAgentSource !== "function") {
      throw new PlannerReleaseError(
        "First-install stage requires the integrated authenticated agent-source inspector.",
      );
    }
    const agentSource = firstInstall
      ? await dependencies.inspectAgentSource({ sourcePath: agentSourcePath, layout })
      : null;
    if (agentSource !== null) {
      assertPlannerReleaseAgentSourceProjection(agentSource, layout);
      assertBoundedReleaseJson(agentSource, RELEASE_ARTIFACT_BYTES_LIMIT);
    }
    const gitRootResult = await runCommand("git", ["-C", input.candidateSource, "rev-parse", "--show-toplevel"]);
    const gitRoot = await realpath(gitRootResult.stdout.trim());
    if (gitRoot !== input.candidateSource) {
      throw new PlannerReleaseInputError("--candidate-source must be the real root of its Git repository.");
    }
    const commitResult = await runCommand("git", [
      "-C",
      gitRoot,
      "rev-parse",
      "--verify",
      `${input.baselineCommit}^{commit}`,
    ]);
    if (commitResult.stdout.trim() !== input.baselineCommit) {
      throw new PlannerReleaseInputError("The baseline commit did not resolve to the supplied exact commit.");
    }

    const candidateManifest = await copyReleaseTree(
      gitRoot,
      layout.candidateSourceRoot,
      { excludedRootNames: SOURCE_EXCLUSIONS },
    );
    const copiedBaselinePolicy = await readFirstInstallBaselineManifest(
      layout.candidateSourceRoot,
    );
    if (!identityEqual(copiedBaselinePolicy, baselinePolicy)) {
      throw new PlannerReleaseError(
        "The release-managed first-install baseline manifest changed during staging.",
      );
    }
    const baselineManifest = await (dependencies.extractBaseline ?? defaultExtractBaseline)({
      candidateSource: gitRoot,
      baselineCommit: input.baselineCommit,
      destination: layout.baselineSourceRoot,
      runCommand,
    });
    const verifiedBaselineManifest = await inventoryReleaseTree(layout.baselineSourceRoot);
    if (!identityEqual(baselineManifest, verifiedBaselineManifest)) {
      throw new PlannerReleaseError("The extracted baseline manifest changed before staging.");
    }
    const operatorManifest = await copyOperatorBundle(
      layout.candidateSourceRoot,
      layout.operatorSourceRoot,
      dependencies.operatorBundle,
    );
    const dataSource = await inspectDataSourceIdentity(
      input.dataSource,
      dependencies,
      layout.candidateSourceRoot,
    );
    const preflight = assertStagePreflight(await (
      dependencies.runStagePreflight ?? runDefaultStagePreflight
    )({
      layout,
      candidateManifest,
      baselineManifest: verifiedBaselineManifest,
      environment: dependencies.environment ?? process.env,
      runCommand,
    }));

    const candidateLockSha256 = await hashRequiredFile(
      join(layout.candidateSourceRoot, "package-lock.json"),
      "Candidate package lock",
    );
    const baselineLockSha256 = await hashRequiredFile(
      join(layout.baselineSourceRoot, "package-lock.json"),
      "Baseline package lock",
    );
    const configPath = join(layout.candidateSourceRoot, "deployment", "codex", "config.toml");
    const instructionPath = join(layout.candidateSourceRoot, "deployment", "codex", "AGENTS.md");
    const configSha256 = dependencies.hashDeploymentInputs === false
      ? ZERO_SHA256
      : await hashRequiredFile(configPath, "Release-managed Codex config");
    const instructionSha256 = dependencies.hashDeploymentInputs === false
      ? ZERO_SHA256
      : await hashRequiredFile(instructionPath, "Release-managed Codex instructions");

    await Promise.all([
      syncReleaseTree(layout.candidateSourceRoot),
      syncReleaseTree(layout.baselineSourceRoot),
      syncReleaseTree(layout.operatorSourceRoot),
    ]);
    await Promise.all([
      freezeReleaseTree(layout.candidateSourceRoot),
      freezeReleaseTree(layout.baselineSourceRoot),
      freezeReleaseTree(layout.operatorSourceRoot),
    ]);

    const stage = createReleaseArtifact({
      artifactType: "stage",
      activationId,
      predecessorSha256: null,
      projection: {
        baselineCommit: input.baselineCommit,
        firstInstall,
        firstInstallBaseline: baselinePolicy,
        candidateSource: candidateManifest,
        baselineSource: verifiedBaselineManifest,
        operatorSource: operatorManifest,
        dataSource,
        agentSource,
        locks: {
          candidateSha256: candidateLockSha256,
          baselineSha256: baselineLockSha256,
        },
        preflight,
        configSha256,
        instructionSha256,
      },
    });
    await publishReleaseArtifact(layout.stagePath, stage);
    const journal = createReleaseJournal(activationId, { clock: dependencies.clock });
    await publishInitialReleaseJournal(layout.journalPath, journal);
    await syncDirectory(layout.transactionRoot);
    completed = true;
    return Object.freeze({ activationId, stagePath: layout.stagePath, stage, journal, layout });
  } finally {
    if (!completed && dependencies.preserveFailedStage !== true) {
      await rm(layout.transactionRoot, { recursive: true, force: true });
      await syncDirectory(layout.releasesRoot).catch(() => undefined);
    }
  }
}

async function copyBoundOperator(layout, stage) {
  const operatorSha256 = stage.projection.operatorSource.sha256;
  if (!isSha256(operatorSha256)) {
    throw new PlannerReleaseError("The stage artifact does not bind an operator source manifest.");
  }
  const destination = deriveInstalledOperatorPath(layout, operatorSha256);
  const expectedIdentity = {
    exists: true,
    kind: "directory",
    ...stage.projection.operatorSource,
  };
  const expected = {
    pre: { exists: false },
    post: expectedIdentity,
  };
  return Object.freeze({
    name: "install_operator",
    expected,
    replay: replayDescriptor("operator-install", { operatorSha256 }),
    async inspect() {
      const observed = await inspectReleaseTreeIdentity(destination);
      if (identityEqual(observed, expected.pre)) return { classification: "pre", identity: observed };
      if (identityEqual(observed, expected.post)) return { classification: "post", identity: observed };
      return { classification: "neither", identity: observed };
    },
    async perform() {
      const temporary = join(layout.operatorRoot, `.${operatorSha256}.${randomUUID()}.tmp`);
      try {
        await copyReleaseTree(layout.operatorSourceRoot, temporary);
        await syncReleaseTree(temporary);
        await freezeReleaseTree(temporary);
        const copied = await inspectReleaseTreeIdentity(temporary);
        if (!identityEqual(copied, expectedIdentity)) {
          throw new PlannerReleaseError("The installed operator copy changed identity.");
        }
        await rename(temporary, destination);
        await syncDirectory(layout.operatorRoot);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}

async function installOrReuseBoundOperator(context) {
  const effect = await copyBoundOperator(context.layout, context.stage);
  const recordedReuse = readReleaseCheckpoint(context.journal, "operator_reuse");
  if (recordedReuse !== null) {
    const observed = await inspectEffect(effect);
    if (
      observed.classification !== "post" ||
      recordedReuse.operatorSha256 !== context.stage.projection.operatorSource.sha256 ||
      !identityEqual(recordedReuse.identity, observed.identity)
    ) {
      throw new PlannerReleaseInterventionError(
        "The recorded release-operator reuse no longer has its exact identity.",
      );
    }
    return;
  }
  const pendingIntent = unresolvedIntent(context.journal);
  const completed = completedEffect(context.journal, effect.name);
  if (pendingIntent !== null || completed !== null) {
    await runOrVerifyEffect(context, effect);
    return;
  }
  const observed = await inspectEffect(effect);
  if (observed.classification !== "post") {
    await runOrVerifyEffect(context, effect);
    return;
  }
  context.journal = await recordReleaseCheckpoint(
    context.layout.journalPath,
    context.journal,
    "operator_reuse",
    Object.freeze({
      operatorSha256: context.stage.projection.operatorSource.sha256,
      identity: observed.identity,
    }),
    { clock: context.clock },
  );
}

async function tryReadPointer(path, pointerType) {
  try {
    return await readReleasePointer(path, { pointerType });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function tryReadArtifact(path, expected) {
  try {
    return await readReleaseArtifact(path, expected);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function createPendingPointerEffect(layout, pointer, expectedPre, name = "publish_pending") {
  const expected = {
    pre: expectedPre,
    post: pointer,
  };
  return Object.freeze({
    name,
    expected,
    replay: replayDescriptor("pointer-publication", {
      path: layout.pendingPath,
      pointer,
      expectedPre,
    }),
    async inspect() {
      const current = await tryReadPointer(layout.pendingPath, "pending");
      const identity = current ?? { exists: false };
      if (identityEqual(identity, expected.post)) return { classification: "post", identity };
      if (identityEqual(identity, expected.pre)) return { classification: "pre", identity };
      return { classification: "neither", identity };
    },
    perform: () => publishReleasePointer(layout.pendingPath, pointer, expectedPre.generation ?? 0),
  });
}

function releaseJournalIdentity(journal) {
  return Object.freeze({
    activationId: journal.activationId,
    generation: journal.generation,
    state: journal.state,
    sha256: journal.sha256,
  });
}

function createPendingSupersessionJournalEffect(context, intent) {
  const { replay } = intent;
  const supersededLayout = derivePlannerReleaseLayout(
    context.home,
    replay.supersededActivationId,
  );
  if (
    replay?.schemaVersion !== 1 ||
    replay.kind !== "pending-supersession-journal" ||
    replay.replacementActivationId !== context.activationId ||
    replay.replacementStageSha256 !== context.stage.sha256 ||
    replay.supersededJournalPath !== supersededLayout.journalPath ||
    replay.preJournal?.activationId !== replay.supersededActivationId ||
    replay.postJournal?.activationId !== replay.supersededActivationId
  ) {
    throw new PlannerReleaseInterventionError(
      "The pending-supersession journal replay coordinates changed.",
    );
  }
  assertReleaseJournal(replay.preJournal, {
    activationId: replay.supersededActivationId,
  });
  assertReleaseJournal(replay.postJournal, {
    activationId: replay.supersededActivationId,
  });
  if (
    replay.preJournal.state !== "staged" ||
    replay.postJournal.state !== "intervention_required" ||
    replay.postJournal.generation !== replay.preJournal.generation + 1 ||
    !identityEqual(intent.expected, {
      pre: releaseJournalIdentity(replay.preJournal),
      post: releaseJournalIdentity(replay.postJournal),
    })
  ) {
    throw new PlannerReleaseInterventionError(
      "The pending-supersession journal replay changed its exact transition.",
    );
  }
  const finalEntry = replay.postJournal.entries.at(-1);
  if (
    finalEntry?.kind !== "transition" ||
    finalEntry.event !== "ambiguous" ||
    finalEntry.fromState !== "staged" ||
    finalEntry.toState !== "intervention_required" ||
    finalEntry.outcome !== "intervention" ||
    finalEntry.reason !== "ambiguous_effect_identity" ||
    finalEntry.replacementActivationId !== context.activationId ||
    finalEntry.replacementStageSha256 !== context.stage.sha256
  ) {
    throw new PlannerReleaseInterventionError(
      "The pending-supersession journal replay omitted its replacement binding.",
    );
  }
  return Object.freeze({
    name: "retire_superseded_pending",
    expected: intent.expected,
    replay,
    async inspect() {
      const observed = releaseJournalIdentity(await readReleaseJournal(
        replay.supersededJournalPath,
        replay.supersededActivationId,
      ));
      if (identityEqual(observed, intent.expected.pre)) {
        return { classification: "pre", identity: observed };
      }
      if (identityEqual(observed, intent.expected.post)) {
        return { classification: "post", identity: observed };
      }
      return { classification: "neither", identity: observed };
    },
    perform: () => replaceReleaseJournal(
      replay.supersededJournalPath,
      replay.preJournal,
      replay.postJournal,
    ),
  });
}

function createCurrentPointerEffect(layout, name, pointer, expectedPre) {
  const expected = { pre: expectedPre, post: pointer };
  return Object.freeze({
    name,
    expected,
    replay: replayDescriptor("pointer-publication", {
      path: layout.currentPath,
      pointer,
      expectedPre,
    }),
    async inspect() {
      const current = await tryReadPointer(layout.currentPath, "current");
      const identity = current ?? { exists: false };
      if (identityEqual(identity, expected.post)) return { classification: "post", identity };
      if (identityEqual(identity, expected.pre)) return { classification: "pre", identity };
      return { classification: "neither", identity };
    },
    perform: () => publishReleasePointer(layout.currentPath, pointer, expectedPre.generation ?? 0),
  });
}

function createRemovePendingEffect(layout, pointer, name = "remove_pending") {
  const expected = { pre: pointer, post: { exists: false } };
  return Object.freeze({
    name,
    expected,
    replay: replayDescriptor("pointer-removal", {
      path: layout.pendingPath,
      pointer,
    }),
    async inspect() {
      const current = await tryReadPointer(layout.pendingPath, "pending");
      const identity = current ?? { exists: false };
      if (identityEqual(identity, expected.pre)) return { classification: "pre", identity };
      if (identityEqual(identity, expected.post)) return { classification: "post", identity };
      return { classification: "neither", identity };
    },
    async perform() {
      await unlink(layout.pendingPath);
      await syncDirectory(layout.releasesRoot);
    },
  });
}

function createRemoveCurrentEffect(layout, pointer, name = "remove_current") {
  const expected = { pre: pointer, post: { exists: false } };
  return Object.freeze({
    name,
    expected,
    replay: replayDescriptor("current-removal", {
      path: layout.currentPath,
      pointer,
    }),
    async inspect() {
      const current = await tryReadPointer(layout.currentPath, "current");
      const identity = current ?? { exists: false };
      if (identityEqual(identity, expected.pre)) return { classification: "pre", identity };
      if (identityEqual(identity, expected.post)) return { classification: "post", identity };
      return { classification: "neither", identity };
    },
    async perform() {
      await unlink(layout.currentPath);
      await syncDirectory(layout.releasesRoot);
    },
  });
}

function createArtifactPublicationEffect(path, artifact) {
  assertReleaseArtifact(artifact);
  const expected = {
    pre: { exists: false },
    post: { exists: true, artifactType: artifact.artifactType, sha256: artifact.sha256 },
  };
  return Object.freeze({
    name: `publish_artifact_${artifact.artifactType.replaceAll("-", "_")}`,
    expected,
    replay: replayDescriptor("artifact-publication", { path, artifact }),
    async inspect() {
      const existing = await tryReadArtifact(path, {
        artifactType: artifact.artifactType,
        activationId: artifact.activationId,
        predecessorSha256: artifact.predecessorSha256,
      });
      const identity = existing === null
        ? { exists: false }
        : { exists: true, artifactType: existing.artifactType, sha256: existing.sha256 };
      if (identityEqual(identity, expected.pre)) return { classification: "pre", identity };
      if (identityEqual(identity, expected.post)) return { classification: "post", identity };
      return { classification: "neither", identity };
    },
    perform: () => publishReleaseArtifact(path, artifact),
  });
}

function effectIntent(journal, effectName) {
  const intents = journal.entries.filter(
    (entry) => entry.kind === "intent" && entry.effect === effectName,
  );
  if (intents.length > 1) {
    throw new PlannerReleaseInterventionError(
      `Release effect ${effectName} has more than one durable intent.`,
    );
  }
  return intents[0] ?? null;
}

function completedEffect(journal, effectName) {
  const intent = effectIntent(journal, effectName);
  if (intent === null) return null;
  return journal.entries.find(
    (entry) => entry.kind === "completed" && entry.effectId === intent.effectId,
  ) ?? null;
}

function assertEffectMatchesIntent(effect, intent) {
  if (
    intent === null || effect.name !== intent.effect ||
    !identityEqual(effect.expected, intent.expected) ||
    !identityEqual(effect.replay, intent.replay)
  ) {
    throw new PlannerReleaseInterventionError(
      `Release effect ${effect.name} no longer matches its durable intent.`,
    );
  }
}

async function verifyCompletedReleaseEffect(context, effect) {
  const intent = effectIntent(context.journal, effect.name);
  const completed = completedEffect(context.journal, effect.name);
  if (completed === null) return false;
  assertEffectMatchesIntent(effect, intent);
  const observed = await inspectEffect(effect);
  if (observed.classification !== "post") {
    context.journal = await markIntervention(
      context.layout.journalPath,
      context.journal,
      effect.name,
      { clock: context.clock },
    );
    throw new PlannerReleaseInterventionError(
      `Completed release effect ${effect.name} no longer has its exact post-state.`,
    );
  }
  if (!identityEqual(completed.observed, observed.identity)) {
    context.journal = await markIntervention(
      context.layout.journalPath,
      context.journal,
      effect.name,
      { clock: context.clock },
    );
    throw new PlannerReleaseInterventionError(
      `Completed release effect ${effect.name} changed its observed identity.`,
    );
  }
  return true;
}

export async function verifyCompletedRecordedReleaseEffect({
  journalPath,
  journal,
  effect,
  clock = Date,
}) {
  const context = {
    journal,
    layout: { journalPath },
    clock,
  };
  return verifyCompletedReleaseEffect(context, assertEffect(effect));
}

async function runOrVerifyEffect(context, effect) {
  assertEffect(effect);
  if (await verifyCompletedReleaseEffect(context, effect)) return context.journal;
  const pendingIntent = unresolvedIntent(context.journal);
  if (pendingIntent !== null) {
    if (pendingIntent.effect !== effect.name) {
      throw new PlannerReleaseInterventionError(
        `Release effect ${effect.name} cannot run while ${pendingIntent.effect} is unresolved.`,
      );
    }
    const recovered = await recoverRecordedReleaseEffect({
      journalPath: context.layout.journalPath,
      journal: context.journal,
      createEffect: async () => effect,
      faultInjector: context.faultInjector,
      clock: context.clock,
    });
    context.journal = recovered.journal;
  }
  if (await verifyCompletedReleaseEffect(context, effect)) return context.journal;
  context.journal = await runRecordedReleaseEffect({
    journalPath: context.layout.journalPath,
    journal: context.journal,
    effect,
    faultInjector: context.faultInjector,
    clock: context.clock,
  });
  return context.journal;
}

async function publishReceipt(context, path, artifact) {
  await runOrVerifyEffect(context, createArtifactPublicationEffect(path, artifact));
  return artifact;
}

async function readOrPublishDerivedReceipt(context, path, expected, createArtifactValue) {
  const existing = await tryReadArtifact(path, expected);
  if (existing !== null) {
    await runOrVerifyEffect(context, createArtifactPublicationEffect(path, existing));
    return existing;
  }
  return publishReceipt(context, path, await createArtifactValue());
}

async function runProofArtifactEffect({
  context,
  port,
  factoryName,
  effectName,
  operation,
  path,
  expected,
  proofContext,
}) {
  const effect = assertActivationPortEffect(
    await port[factoryName](Object.freeze({
      ...proofContext,
      recoveryIntent: effectIntent(context.journal, effectName),
    })),
    effectName,
    operation,
  );
  await runOrVerifyEffect(context, effect);
  return readReleaseArtifact(path, expected);
}

function withOperatorProjection(projection, operatorSha256) {
  if (!isPlainRecord(projection)) {
    throw new PlannerReleaseError("A release activation port returned a non-object projection.");
  }
  if (
    Object.hasOwn(projection, "operatorSha256") &&
    projection.operatorSha256 !== operatorSha256
  ) {
    throw new PlannerReleaseError("A release activation projection changed operator identity.");
  }
  return Object.freeze({ ...projection, operatorSha256 });
}

function assertActivationPort(port) {
  const functions = [
    "createPrepareDataEffect",
    "previousActivationProjection",
    "createParkPreviousEffect",
    "createSelectAppEffect",
    "installedProjection",
    "createAdoptAgentEffect",
    "createSelectDataEffect",
    "createAuthLifecycleEffect",
    "createReleaseCandidateEffect",
    "createQaEffect",
    "activationProjection",
    "createRestoreAppEffect",
    "createRestoreDataEffect",
    "rollbackProjection",
  ];
  if (!isPlainRecord(port) || functions.some((name) => typeof port[name] !== "function")) {
    throw new PlannerReleaseError("The release activation dependency port is incomplete.");
  }
  return port;
}

function assertActivationPortEffect(effect, name, operation) {
  const checked = assertEffect(effect);
  if (
    checked.name !== name ||
    checked.replay.kind !== "activation-port" ||
    checked.replay.operation !== operation
  ) {
    throw new PlannerReleaseError(
      `Activation effect ${operation} does not have its stable name and replay identity.`,
    );
  }
  return checked;
}

function installedOperatorIdentityForModule(layout) {
  const modulePath = fileURLToPath(import.meta.url);
  if (!pathInsideOrEqual(layout.operatorRoot, modulePath)) return null;
  const fromOperator = relative(layout.operatorRoot, modulePath).split(sep);
  return isSha256(fromOperator[0]) ? fromOperator[0] : null;
}

async function ensureBoundOperatorExecution(
  context,
  dependencies,
  operatorSha256,
  request,
) {
  const executingOperatorSha256 = dependencies.operatorExecutionSha256 ??
    installedOperatorIdentityForModule(context.layout);
  if (executingOperatorSha256 === operatorSha256) return null;
  if (typeof dependencies.reexecuteInstalledOperator !== "function") {
    throw new PlannerReleaseError(
      `${request.command} must re-execute through its content-addressed release operator.`,
    );
  }
  return dependencies.reexecuteInstalledOperator({
    operatorPath: deriveInstalledOperatorPath(context.layout, operatorSha256),
    activationId: context.activationId,
    ...request,
  });
}

function assertPendingSupersessionCheckpoint(context, projection) {
  const versionOneKeys = [
    "replacementPointer",
    "replacementStageSha256",
    "schemaVersion",
    "supersededJournalSha256",
    "supersededPointer",
    "supersededStageSha256",
  ];
  const versionTwoKeys = [
    "classification",
    "replacementDataSource",
    ...versionOneKeys,
    "supersededDataSource",
  ].sort();
  const projectionKeys = isPlainRecord(projection)
    ? Object.keys(projection).sort()
    : [];
  const validVersionedShape = projection?.schemaVersion === 1
    ? identityEqual(projectionKeys, versionOneKeys)
    : projection?.schemaVersion === 2 && identityEqual(projectionKeys, versionTwoKeys);
  if (
    !isPlainRecord(projection) ||
    !validVersionedShape ||
    !isSha256(projection.supersededStageSha256) ||
    !isSha256(projection.supersededJournalSha256) ||
    projection.replacementStageSha256 !== context.stage.sha256
  ) {
    throw new PlannerReleaseInterventionError(
      "The pending-supersession checkpoint has an invalid exact contract.",
    );
  }
  if (projection.schemaVersion === 2) {
    const validClassification = [
      "historical_pre_adoption",
      "staged_source_drift",
    ].includes(projection.classification);
    if (
      !validClassification ||
      !isPlainRecord(projection.supersededDataSource) ||
      !isPlainRecord(projection.replacementDataSource) ||
      !identityEqual(
        projection.replacementDataSource,
        context.stage.projection.dataSource,
      ) ||
      (
        projection.classification === "staged_source_drift" &&
        identityEqual(
          projection.supersededDataSource,
          projection.replacementDataSource,
        )
      )
    ) {
      throw new PlannerReleaseInterventionError(
        "The pending-supersession checkpoint has an invalid recovery classification.",
      );
    }
  }
  let supersededPointer;
  let replacementPointer;
  try {
    supersededPointer = createReleasePointer(projection.supersededPointer);
    replacementPointer = createReleasePointer(projection.replacementPointer);
  } catch (error) {
    throw new PlannerReleaseInterventionError(
      "The pending-supersession checkpoint contains an invalid pointer.",
      { cause: error },
    );
  }
  if (
    !identityEqual(supersededPointer, projection.supersededPointer) ||
    !identityEqual(replacementPointer, projection.replacementPointer) ||
    supersededPointer.pointerType !== "pending" ||
    replacementPointer.pointerType !== "pending" ||
    supersededPointer.activationId === context.activationId ||
    replacementPointer.activationId !== context.activationId ||
    replacementPointer.operatorSha256 !== context.stage.projection.operatorSource.sha256 ||
    replacementPointer.generation !== supersededPointer.generation + 1
  ) {
    throw new PlannerReleaseInterventionError(
      "The pending-supersession checkpoint changed its pointer lineage.",
    );
  }
  return projection;
}

async function inspectIneligibleSupersededPending(context, pending) {
  const supersededLayout = derivePlannerReleaseLayout(context.home, pending.activationId);
  const [stage, journal] = await Promise.all([
    readReleaseArtifact(supersededLayout.stagePath, {
      artifactType: "stage",
      activationId: pending.activationId,
    }),
    readReleaseJournal(supersededLayout.journalPath, pending.activationId),
  ]);
  const created = journal.entries[0];
  const pendingIntent = journal.entries.at(-2);
  const pendingCompletion = journal.entries.at(-1);
  const operatorEntries = journal.entries.slice(1, -2);
  let expectedPre;
  try {
    expectedPre = pendingIntent?.expected?.pre?.exists === false
      ? pendingIntent.expected.pre
      : createReleasePointer(pendingIntent?.expected?.pre);
  } catch {
    expectedPre = null;
  }
  const validExpectedPre = expectedPre !== null && (
    identityEqual(expectedPre, { exists: false })
      ? pending.generation === 1
      : (
          expectedPre.pointerType === "pending" &&
          expectedPre.generation === pending.generation - 1 &&
          expectedPre.activationId !== pending.activationId
        )
  );
  const expectedOperatorIdentity = Object.freeze({
    exists: true,
    kind: "directory",
    ...stage.projection.operatorSource,
  });
  const [operatorEntry, operatorCompletion] = operatorEntries;
  const reusedOperator = operatorEntries.length === 1 &&
    operatorEntry?.kind === "checkpoint" &&
    operatorEntry.name === "operator_reuse" &&
    operatorEntry.projection?.operatorSha256 === pending.operatorSha256 &&
    identityEqual(operatorEntry.projection?.identity, expectedOperatorIdentity);
  const installedOperator = operatorEntries.length === 2 &&
    operatorEntry?.kind === "intent" &&
    operatorEntry.effect === "install_operator" &&
    identityEqual(operatorEntry.expected?.pre, { exists: false }) &&
    identityEqual(operatorEntry.expected?.post, expectedOperatorIdentity) &&
    operatorEntry.replay?.schemaVersion === RELEASE_EFFECT_REPLAY_VERSION &&
    operatorEntry.replay?.kind === "operator-install" &&
    operatorEntry.replay?.operatorSha256 === pending.operatorSha256 &&
    operatorCompletion?.kind === "completed" &&
    operatorCompletion.effect === "install_operator" &&
    operatorCompletion.effectId === operatorEntry.effectId &&
    identityEqual(operatorCompletion.observed, expectedOperatorIdentity);
  const firstInstall = stage.projection.firstInstall;
  const agentSource = stage.projection.agentSource ?? null;
  const historicalPreAdoption = firstInstall === true && agentSource === null;
  const stagedUpdate = firstInstall === false && agentSource === null;
  if (
    journal.state !== "staged" ||
    created?.kind !== "created" ||
    created.state !== "staged" ||
    (!reusedOperator && !installedOperator) ||
    pendingIntent?.kind !== "intent" ||
    pendingIntent.effect !== "publish_pending" ||
    pendingCompletion?.kind !== "completed" ||
    pendingCompletion.effect !== "publish_pending" ||
    pendingCompletion.effectId !== pendingIntent.effectId ||
    !validExpectedPre ||
    !identityEqual(pendingIntent.expected?.post, pending) ||
    pendingIntent.replay?.schemaVersion !== RELEASE_EFFECT_REPLAY_VERSION ||
    pendingIntent.replay?.kind !== "pointer-publication" ||
    pendingIntent.replay?.path !== context.layout.pendingPath ||
    !identityEqual(pendingIntent.replay?.pointer, pending) ||
    !identityEqual(pendingIntent.replay?.expectedPre, expectedPre) ||
    !identityEqual(pendingCompletion.observed, pending) ||
    (!historicalPreAdoption && !stagedUpdate) ||
    stage.projection.dataSource?.initialized !== true ||
    stage.projection.operatorSource?.sha256 !== pending.operatorSha256
  ) {
    throw new PlannerReleaseOwnershipError(
      "Only an exact initialized staged pending transaction with no release effects may be superseded.",
    );
  }
  return Object.freeze({
    stage,
    journal,
    classification: historicalPreAdoption
      ? "historical_pre_adoption"
      : "staged_source_drift",
  });
}

function assertReplacementSupersessionEligibility(
  context,
  { operatorRequired = true } = {},
) {
  const [created, operatorEntry, operatorCompletion] = context.journal.entries;
  const expectedOperatorIdentity = Object.freeze({
    exists: true,
    kind: "directory",
    ...context.stage.projection.operatorSource,
  });
  const reused = operatorEntry?.kind === "checkpoint" &&
    operatorEntry.name === "operator_reuse" &&
    operatorEntry.projection?.operatorSha256 ===
      context.stage.projection.operatorSource.sha256 &&
    identityEqual(operatorEntry.projection?.identity, expectedOperatorIdentity) &&
    context.journal.entries.length === 2;
  const installed = operatorEntry?.kind === "intent" &&
    operatorEntry.effect === "install_operator" &&
    operatorCompletion?.kind === "completed" &&
    operatorCompletion.effect === "install_operator" &&
    operatorCompletion.effectId === operatorEntry.effectId &&
    context.journal.entries.length === 3;
  const installPending = operatorEntry?.kind === "intent" &&
    operatorEntry.effect === "install_operator" &&
    context.journal.entries.length === 2;
  const operatorAbsent = context.journal.entries.length === 1;
  const validOperatorHistory = reused || installed || (
    operatorRequired === false && (installPending || operatorAbsent)
  );
  if (
    context.journal.state !== "staged" ||
    created?.kind !== "created" ||
    created.state !== "staged" ||
    !validOperatorHistory ||
    (
      context.stage.projection.firstInstall === true
        ? !isPlainRecord(context.stage.projection.agentSource)
        : (
            context.stage.projection.firstInstall !== false ||
            (context.stage.projection.agentSource ?? null) !== null
          )
    ) ||
    context.stage.projection.dataSource?.initialized !== true
  ) {
    throw new PlannerReleaseOwnershipError(
      "Pending supersession requires a newly staged initialized replacement with a valid agent-source contract.",
    );
  }
}

async function preparePendingSupersession(
  context,
  requestedActivationId,
  existingPending,
  dependencies,
) {
  const recorded = readReleaseCheckpoint(context.journal, PENDING_SUPERSESSION_CHECKPOINT);
  if (recorded !== null) {
    const projection = assertPendingSupersessionCheckpoint(context, recorded);
    if (
      requestedActivationId !== null &&
      requestedActivationId !== projection.supersededPointer.activationId
    ) {
      throw new PlannerReleaseOwnershipError(
        "The requested pending supersession changed from its durable checkpoint.",
      );
    }
    if (
      existingPending === null ||
      (
        !identityEqual(existingPending, projection.supersededPointer) &&
        !identityEqual(existingPending, projection.replacementPointer)
      )
    ) {
      throw new PlannerReleaseInterventionError(
        "The pending pointer changed outside its durable supersession lineage.",
      );
    }
    return projection;
  }
  if (requestedActivationId === null) return null;
  assertReplacementSupersessionEligibility(context);
  if (
    existingPending === null ||
    existingPending.activationId !== requestedActivationId ||
    requestedActivationId === context.activationId
  ) {
    throw new PlannerReleaseOwnershipError(
      "--supersede-pending must name the exact currently pending transaction.",
    );
  }
  const superseded = await inspectIneligibleSupersededPending(context, existingPending);
  if (
    superseded.stage.projection.firstInstall !==
      context.stage.projection.firstInstall
  ) {
    throw new PlannerReleaseOwnershipError(
      "Pending supersession requires the old and replacement transactions to use the same installation mode.",
    );
  }
  if (superseded.classification === "staged_source_drift") {
    const supersededDataSource = superseded.stage.projection.dataSource;
    const replacementDataSource = context.stage.projection.dataSource;
    const sameAuthority = ["canonicalPath", "device", "inode"].every(
      (key) => supersededDataSource?.[key] === replacementDataSource?.[key],
    );
    if (!sameAuthority) {
      throw new PlannerReleaseOwnershipError(
        "Source-drift supersession requires the same canonical database identity.",
      );
    }
    if (identityEqual(supersededDataSource, replacementDataSource)) {
      throw new PlannerReleaseOwnershipError(
        "Source-drift supersession requires a changed staged database identity.",
      );
    }
    if (typeof dependencies.inspectDataSource !== "function") {
      throw new PlannerReleaseInterventionError(
        "Source-drift supersession requires the production data-source inspector.",
      );
    }
    const liveDataSource = await inspectDataSourceIdentity(
      replacementDataSource.canonicalPath,
      dependencies,
      context.layout.candidateSourceRoot,
    );
    if (!identityEqual(liveDataSource, replacementDataSource)) {
      throw new PlannerReleaseOwnershipError(
        "The stopped database no longer matches the replacement transaction.",
      );
    }
  }
  const projection = Object.freeze({
    schemaVersion: 2,
    classification: superseded.classification,
    supersededDataSource: superseded.stage.projection.dataSource,
    replacementDataSource: context.stage.projection.dataSource,
    supersededPointer: existingPending,
    supersededStageSha256: superseded.stage.sha256,
    supersededJournalSha256: superseded.journal.sha256,
    replacementStageSha256: context.stage.sha256,
    replacementPointer: createReleasePointer({
      pointerType: "pending",
      generation: existingPending.generation + 1,
      activationId: context.activationId,
      operatorSha256: context.stage.projection.operatorSource.sha256,
      updatedAt: nowIso(context.clock),
    }),
  });
  context.journal = await recordReleaseCheckpoint(
    context.layout.journalPath,
    context.journal,
    PENDING_SUPERSESSION_CHECKPOINT,
    projection,
    { clock: context.clock },
  );
  return projection;
}

async function createRetireSupersededPendingEffect(context, supersession) {
  const existingIntent = effectIntent(context.journal, "retire_superseded_pending");
  if (existingIntent !== null) {
    return createPendingSupersessionJournalEffect(context, existingIntent);
  }
  const supersededLayout = derivePlannerReleaseLayout(
    context.home,
    supersession.supersededPointer.activationId,
  );
  const [stage, preJournal] = await Promise.all([
    readReleaseArtifact(supersededLayout.stagePath, {
      artifactType: "stage",
      activationId: supersession.supersededPointer.activationId,
    }),
    readReleaseJournal(
      supersededLayout.journalPath,
      supersession.supersededPointer.activationId,
    ),
  ]);
  if (
    stage.sha256 !== supersession.supersededStageSha256 ||
    preJournal.sha256 !== supersession.supersededJournalSha256 ||
    preJournal.state !== "staged"
  ) {
    throw new PlannerReleaseInterventionError(
      "The superseded pending transaction changed after its replacement checkpoint.",
    );
  }
  const retirement = applyReleaseLifecycleTransition(preJournal.state, "ambiguous");
  const postJournal = appendReleaseJournalEntry(preJournal, {
    at: nowIso(context.clock),
    kind: "transition",
    event: "ambiguous",
    fromState: preJournal.state,
    toState: retirement.nextState,
    outcome: retirement.outcome,
    reason: retirement.reason,
    replacementActivationId: context.activationId,
    replacementStageSha256: context.stage.sha256,
  }, retirement.nextState);
  const expected = Object.freeze({
    pre: releaseJournalIdentity(preJournal),
    post: releaseJournalIdentity(postJournal),
  });
  const replay = replayDescriptor("pending-supersession-journal", {
    supersededActivationId: supersession.supersededPointer.activationId,
    supersededJournalPath: supersededLayout.journalPath,
    replacementActivationId: context.activationId,
    replacementStageSha256: context.stage.sha256,
    preJournal,
    postJournal,
  });
  return createPendingSupersessionJournalEffect(context, {
    effect: "retire_superseded_pending",
    expected,
    replay,
  });
}

async function executePendingSupersession(context, supersession) {
  await runOrVerifyEffect(
    context,
    await createRetireSupersededPendingEffect(context, supersession),
  );
  const existingIntent = effectIntent(context.journal, "replace_pending");
  const replacePending = existingIntent === null
    ? createPendingPointerEffect(
        context.layout,
        supersession.replacementPointer,
        supersession.supersededPointer,
        "replace_pending",
      )
    : await createInternalEffectFromIntent(context, existingIntent);
  if (replacePending === null) {
    throw new PlannerReleaseInterventionError(
      "The durable replacement-pending intent has no exact replay factory.",
    );
  }
  await runOrVerifyEffect(context, replacePending);
  return supersession.replacementPointer;
}

async function ensureActivationOperatorHandoff(context, dependencies, options = {}) {
  const operatorSha256 = context.stage.projection.operatorSource.sha256;
  const recordedSupersession = readReleaseCheckpoint(
    context.journal,
    PENDING_SUPERSESSION_CHECKPOINT,
  );
  const requestedSupersession = options.supersedePending ?? null;
  if (recordedSupersession === null && requestedSupersession !== null) {
    assertReplacementSupersessionEligibility(context, { operatorRequired: false });
  }
  await installOrReuseBoundOperator(context);
  const handoffSupersession = recordedSupersession === null
    ? requestedSupersession
    : assertPendingSupersessionCheckpoint(context, recordedSupersession)
      .supersededPointer.activationId;
  if (
    requestedSupersession !== null &&
    requestedSupersession !== handoffSupersession
  ) {
    throw new PlannerReleaseOwnershipError(
      "The requested pending supersession changed from its durable checkpoint.",
    );
  }
  return ensureBoundOperatorExecution(context, dependencies, operatorSha256, {
    command: "activate",
    authorized: true,
    ...(handoffSupersession === null
      ? {}
      : { supersedePending: handoffSupersession }),
  });
}

async function ensureOperatorAndPending(context, dependencies, options = {}) {
  const operatorSha256 = context.stage.projection.operatorSource.sha256;
  const recordedSupersession = options.allowRecordedSupersession === true
    ? readReleaseCheckpoint(context.journal, PENDING_SUPERSESSION_CHECKPOINT)
    : null;
  const requestedSupersession = options.supersedePending ?? null;
  if (recordedSupersession === null && requestedSupersession !== null) {
    assertReplacementSupersessionEligibility(context, { operatorRequired: false });
  }
  await installOrReuseBoundOperator(context);
  let existingPending = await tryReadPointer(context.layout.pendingPath, "pending");
  if (recordedSupersession !== null || requestedSupersession !== null) {
    const handoffSupersession = recordedSupersession === null
      ? requestedSupersession
      : assertPendingSupersessionCheckpoint(context, recordedSupersession)
        .supersededPointer.activationId;
    if (
      requestedSupersession !== null &&
      requestedSupersession !== handoffSupersession
    ) {
      throw new PlannerReleaseOwnershipError(
        "The requested pending supersession changed from its durable checkpoint.",
      );
    }
    const operatorHandoff = await ensureBoundOperatorExecution(
      context,
      dependencies,
      operatorSha256,
      {
        command: "activate",
        authorized: true,
        supersedePending: handoffSupersession,
      },
    );
    if (operatorHandoff !== null) return operatorHandoff;
  }
  const supersession = options.allowRecordedSupersession === true
      ? await preparePendingSupersession(
        context,
        requestedSupersession,
        existingPending,
        dependencies,
      )
    : null;
  if (supersession !== null) {
    context.pending = await executePendingSupersession(context, supersession);
    context.operatorSha256 = operatorSha256;
    return null;
  }
  const unresolved = unresolvedIntent(context.journal);
  if (unresolved?.replay?.kind === "pointer-publication" &&
      unresolved.replay.path === context.layout.pendingPath) {
    await recoverKnownIntent(context);
  }
  existingPending = await tryReadPointer(context.layout.pendingPath, "pending");
  if (existingPending !== null && existingPending.activationId !== context.activationId) {
    throw new PlannerReleaseOwnershipError(
      `Another release transaction is pending: ${existingPending.activationId}.`,
    );
  }
  const pendingIntent = effectIntent(context.journal, "publish_pending");
  let pending;
  if (pendingIntent !== null) {
    const effect = await createInternalEffectFromIntent(context, pendingIntent);
    if (effect === null) {
      throw new PlannerReleaseInterventionError(
        "The durable pending-pointer intent has no exact replay factory.",
      );
    }
    await runOrVerifyEffect(context, effect);
    pending = pendingIntent.replay.pointer;
  } else {
    pending = existingPending ?? createReleasePointer({
      pointerType: "pending",
      generation: 1,
      activationId: context.activationId,
      operatorSha256,
      updatedAt: nowIso(context.clock),
    });
    const pendingPre = existingPending ?? { exists: false };
    await runOrVerifyEffect(
      context,
      createPendingPointerEffect(context.layout, pending, pendingPre),
    );
  }
  context.pending = pending;
  context.operatorSha256 = operatorSha256;

  return ensureBoundOperatorExecution(context, dependencies, operatorSha256, {
    command: "activate",
    authorized: true,
  });
}

async function readActivationContext(activationId, dependencies = {}) {
  if (!isActivationId(activationId)) throw new PlannerReleaseInputError("Activation requires a canonical ID.");
  const home = dependencies.home ?? process.env.HOME;
  if (typeof home !== "string") throw new PlannerReleaseInputError("The release operator requires HOME.");
  const layout = derivePlannerReleaseLayout(home, activationId);
  await Promise.all([
    assertPrivateDirectory(layout.root),
    assertPrivateDirectory(layout.releasesRoot),
    assertPrivateDirectory(layout.transactionRoot),
  ]);
  const [stage, journal] = await Promise.all([
    readReleaseArtifact(layout.stagePath, { artifactType: "stage", activationId }),
    readReleaseJournal(layout.journalPath, activationId),
  ]);
  if (stage.projection.firstInstall === true) {
    try {
      assertPlannerReleaseAgentSourceProjection(stage.projection.agentSource, layout);
    } catch (error) {
      throw new PlannerReleaseOwnershipError(
        "First-install activation rejects a pre-adoption stage without one exact authenticated agent source.",
        { cause: error },
      );
    }
  } else if (
    stage.projection.firstInstall !== false ||
    (stage.projection.agentSource ?? null) !== null
  ) {
    throw new PlannerReleaseOwnershipError(
      "Activation rejects a stage with an invalid first-install agent-source contract.",
    );
  }
  return {
    activationId,
    home,
    layout,
    stage,
    journal,
    clock: dependencies.clock ?? Date,
    faultInjector: dependencies.faultInjector ?? null,
    operatorSha256: stage.projection.operatorSource.sha256,
  };
}

async function ensureUninitializedAuthorityConfirmation(context, input) {
  const initialized = context.stage.projection.dataSource?.initialized;
  if (typeof initialized !== "boolean") {
    throw new PlannerReleaseError(
      "The stage artifact does not bind an initialized authority decision.",
    );
  }
  const existing = readReleaseCheckpoint(
    context.journal,
    UNINITIALIZED_AUTHORITY_CONFIRMATION_CHECKPOINT,
  );
  if (initialized) {
    if (input.confirmUninitializedAuthority === true) {
      throw new PlannerReleaseInputError(
        "--confirm-uninitialized-authority is invalid for an initialized planner authority.",
      );
    }
    if (existing !== null) {
      throw new PlannerReleaseInterventionError(
        "An initialized stage contains an impossible uninitialized-authority confirmation.",
      );
    }
    return;
  }
  const projection = Object.freeze({
    confirmed: true,
    initialized: false,
    stageSha256: context.stage.sha256,
  });
  if (existing !== null) {
    if (!identityEqual(existing, projection)) {
      throw new PlannerReleaseInterventionError(
        "The uninitialized-authority confirmation changed its durable identity.",
      );
    }
    return;
  }
  if (input.confirmUninitializedAuthority !== true) {
    throw new PlannerReleaseInputError(
      "Activation of an uninitialized planner authority requires --confirm-uninitialized-authority.",
    );
  }
  context.journal = await recordReleaseCheckpoint(
    context.layout.journalPath,
    context.journal,
    UNINITIALIZED_AUTHORITY_CONFIRMATION_CHECKPOINT,
    projection,
    { clock: context.clock },
  );
}

function releaseArtifactPath(layout, artifactType) {
  const paths = {
    installed: layout.installedPath,
    "auth-lifecycle": layout.authLifecyclePath,
    "release-candidate": layout.releaseCandidatePath,
    qa: layout.qaPath,
    activation: layout.activationPath,
    "previous-activation": layout.previousActivationPath,
    rollback: layout.rollbackPath,
  };
  return paths[artifactType] ?? null;
}

async function createInternalEffectFromIntent(context, intent) {
  const replay = assertReplayDescriptor(intent.replay);
  switch (replay.kind) {
    case "operator-install": {
      if (replay.operatorSha256 !== context.operatorSha256) return null;
      return copyBoundOperator(context.layout, context.stage);
    }
    case "artifact-publication": {
      if (
        !isPlainRecord(replay.artifact) ||
        replay.path !== releaseArtifactPath(context.layout, replay.artifact.artifactType)
      ) return null;
      return createArtifactPublicationEffect(
        replay.path,
        assertReleaseArtifact(replay.artifact),
      );
    }
    case "pointer-publication": {
      if (!isPlainRecord(replay.pointer) || !isPlainRecord(replay.expectedPre)) return null;
      if (replay.path === context.layout.pendingPath && replay.pointer.pointerType === "pending") {
        return createPendingPointerEffect(
          context.layout,
          replay.pointer,
          replay.expectedPre,
          intent.effect,
        );
      }
      if (replay.path === context.layout.currentPath && replay.pointer.pointerType === "current") {
        return createCurrentPointerEffect(
          context.layout,
          intent.effect,
          replay.pointer,
          replay.expectedPre,
        );
      }
      return null;
    }
    case "pointer-removal": {
      if (
        replay.path !== context.layout.pendingPath ||
        replay.pointer?.pointerType !== "pending"
      ) return null;
      return createRemovePendingEffect(context.layout, replay.pointer, intent.effect);
    }
    case "current-removal": {
      if (
        replay.path !== context.layout.currentPath ||
        replay.pointer?.pointerType !== "current"
      ) return null;
      return createRemoveCurrentEffect(context.layout, replay.pointer, intent.effect);
    }
    case "pending-supersession-journal":
      return createPendingSupersessionJournalEffect(context, intent);
    case "tree-rename":
      return createRenameReleaseEffect({
        name: intent.effect,
        source: replay.source,
        destination: replay.destination,
        expectedIdentity: intent.expected?.pre?.source,
      });
    default:
      return null;
  }
}

const ACTIVATION_EFFECT_FACTORIES = Object.freeze({
  prepare_data: ["createPrepareDataEffect", "prepare_data"],
  park_previous: ["createParkPreviousEffect", "park_previous"],
  select_candidate_app: ["createSelectAppEffect", "select_candidate_app"],
  adopt_authenticated_agent: ["createAdoptAgentEffect", "adopt_authenticated_agent"],
  select_candidate_data: ["createSelectDataEffect", "select_candidate_data"],
  produce_auth_lifecycle: ["createAuthLifecycleEffect", "produce_auth_lifecycle"],
  produce_release_candidate: ["createReleaseCandidateEffect", "produce_release_candidate"],
  produce_qa: ["createQaEffect", "produce_qa"],
  restore_previous_app: ["createRestoreAppEffect", "restore_previous_app"],
  restore_previous_data: ["createRestoreDataEffect", "restore_previous_data"],
});

async function hydrateActivationRecoveryContext(context) {
  const entries = await Promise.all([
    ["previous", context.layout.previousActivationPath, "previous-activation"],
    ["installed", context.layout.installedPath, "installed"],
    ["authLifecycle", context.layout.authLifecyclePath, "auth-lifecycle"],
    ["releaseCandidate", context.layout.releaseCandidatePath, "release-candidate"],
    ["qa", context.layout.qaPath, "qa"],
    ["activation", context.layout.activationPath, "activation"],
    ["rollback", context.layout.rollbackPath, "rollback"],
  ].map(async ([key, path, artifactType]) => [
    key,
    await tryReadArtifact(path, {
      artifactType,
      activationId: context.activationId,
    }),
  ]));
  return Object.fromEntries(entries.filter(([, value]) => value !== null));
}

async function createActivationEffectFromIntent(context, port, intent) {
  const internal = await createInternalEffectFromIntent(context, intent);
  if (internal !== null) return internal;
  if (intent.replay?.kind !== "activation-port") return null;
  const factory = ACTIVATION_EFFECT_FACTORIES[intent.replay.operation];
  if (factory === undefined || typeof port?.[factory[0]] !== "function") return null;
  const receipts = await hydrateActivationRecoveryContext(context);
  return assertActivationPortEffect(
    await port[factory[0]](Object.freeze({
      ...context,
      ...receipts,
      recoveryIntent: intent,
    })),
    intent.effect,
    factory[1],
  );
}

async function recoverKnownIntent(context, port = null) {
  const intent = unresolvedIntent(context.journal);
  if (intent === null) return false;
  const effect = await createActivationEffectFromIntent(context, port, intent);
  if (effect === null) {
    await markIntervention(context.layout.journalPath, context.journal, intent.effect, {
      clock: context.clock,
    });
    throw new PlannerReleaseInterventionError(`No recovery factory exists for effect ${intent.effect}.`);
  }
  const result = await recoverRecordedReleaseEffect({
    journalPath: context.layout.journalPath,
    journal: context.journal,
    createEffect: async () => effect,
    faultInjector: context.faultInjector,
    clock: context.clock,
  });
  context.journal = result.journal;
  return true;
}

async function settleIntentForCompensation(context, port) {
  const intent = unresolvedIntent(context.journal);
  if (intent === null) return null;
  const recovery = planReleaseIntentRecovery(context.journal);
  if (
    recovery.action !== "settle_failed_forward" ||
    recovery.intent.effectId !== intent.effectId
  ) {
    throw new PlannerReleaseInterventionError(
      "Only a pre-compensation forward intent may be settled without replay.",
    );
  }
  const effect = await createActivationEffectFromIntent(context, port, intent);
  if (effect === null) {
    context.journal = await markIntervention(
      context.layout.journalPath,
      context.journal,
      intent.effect,
      { clock: context.clock },
    );
    throw new PlannerReleaseInterventionError(
      `No compensation recovery factory exists for effect ${intent.effect}.`,
    );
  }
  assertEffectMatchesIntent(effect, intent);
  const observed = await inspectEffect(effect);
  if (observed.classification === "neither") {
    context.journal = await markIntervention(
      context.layout.journalPath,
      context.journal,
      intent.effect,
      { clock: context.clock },
    );
    throw new PlannerReleaseInterventionError(
      `Failed release effect ${intent.effect} is neither exact pre-state nor post-state.`,
    );
  }
  const resolution = appendReleaseJournalEntry(context.journal, {
    at: nowIso(context.clock),
    kind: observed.classification === "post" ? "completed" : "abandoned",
    effectId: intent.effectId,
    effect: intent.effect,
    observed: observed.identity,
    ...(observed.classification === "pre" ? { reason: "precommit_compensation" } : {}),
  });
  await replaceReleaseJournal(context.layout.journalPath, context.journal, resolution);
  context.journal = resolution;
  return observed.classification;
}

async function buildActivationPort(context, dependencies) {
  if (typeof dependencies.createActivationPort !== "function") {
    throw new PlannerReleaseError("Activation requires the integrated release activation port.");
  }
  return assertActivationPort(await dependencies.createActivationPort(Object.freeze({ ...context })));
}

async function advanceActivationLifecycle(context, event, eligibleStates, guards = {}) {
  if (!eligibleStates.includes(context.journal.state)) return context.journal;
  context.journal = await transitionReleaseJournal(
    context.layout.journalPath,
    context.journal,
    event,
    guards,
    { clock: context.clock },
  );
  return context.journal;
}

const PRECOMMIT_COMPENSATION_STATES = Object.freeze([
  "previous_pair_parked",
  "candidate_app_selected",
  "candidate_pair_selected",
  "restoring",
  "previous_app_restored",
  "previous_pair_restored",
]);

async function readLatestPreparedArtifact(context) {
  for (const [path, artifactType] of [
    [context.layout.activationPath, "activation"],
    [context.layout.qaPath, "qa"],
    [context.layout.releaseCandidatePath, "release-candidate"],
    [context.layout.authLifecyclePath, "auth-lifecycle"],
    [context.layout.installedPath, "installed"],
    [context.layout.previousActivationPath, "previous-activation"],
  ]) {
    const artifact = await tryReadArtifact(path, {
      artifactType,
      activationId: context.activationId,
    });
    if (artifact !== null) return artifact;
  }
  return context.stage;
}

function previousCurrentIdentity(previous) {
  const value = previous.projection.current;
  if (value === null) return null;
  if (
    !isPlainRecord(value) ||
    !isActivationId(value.activationId) ||
    !isSha256(value.operatorSha256) ||
    !isSha256(value.activationSha256)
  ) {
    throw new PlannerReleaseError(
      "The previous activation receipt has an invalid current-pointer identity.",
    );
  }
  return value;
}

async function publishRestoredCurrent(context, previous, rollback, options = {}) {
  const publicationIntent = effectIntent(context.journal, "publish_rollback");
  if (publicationIntent !== null) {
    const effect = await createInternalEffectFromIntent(context, publicationIntent);
    if (effect === null) {
      throw new PlannerReleaseInterventionError(
        "The rollback-pointer intent has no exact replay factory.",
      );
    }
    await runOrVerifyEffect(context, effect);
    return publicationIntent.replay.pointer;
  }
  const removalIntent = effectIntent(context.journal, "remove_first_install_current");
  if (removalIntent !== null) {
    const effect = await createInternalEffectFromIntent(context, removalIntent);
    if (effect === null) {
      throw new PlannerReleaseInterventionError(
        "The first-install current removal has no exact replay factory.",
      );
    }
    await runOrVerifyEffect(context, effect);
    return null;
  }
  const previousIdentity = previousCurrentIdentity(previous);
  const existingCurrent = await tryReadPointer(context.layout.currentPath, "current");
  if (previousIdentity === null) {
    if (options.retainCurrentForFirstInstall === true) {
      if (existingCurrent === null || existingCurrent.activationId !== context.activationId) {
        throw new PlannerReleaseInterventionError(
          "First-install fail-soft rollback requires the exact committed current pointer.",
        );
      }
      const retainedCurrent = createReleasePointer({
        pointerType: "current",
        generation: existingCurrent.generation + 1,
        activationId: existingCurrent.activationId,
        operatorSha256: existingCurrent.operatorSha256,
        activationSha256: existingCurrent.activationSha256,
        rollbackSha256: rollback.sha256,
        updatedAt: nowIso(context.clock),
      });
      await runOrVerifyEffect(
        context,
        createCurrentPointerEffect(
          context.layout,
          "publish_rollback",
          retainedCurrent,
          existingCurrent,
        ),
      );
      return retainedCurrent;
    }
    if (existingCurrent !== null) {
      await runOrVerifyEffect(
        context,
        createRemoveCurrentEffect(context.layout, existingCurrent, "remove_first_install_current"),
      );
    }
    return null;
  }
  const restoredCurrent = createReleasePointer({
    pointerType: "current",
    generation: (existingCurrent?.generation ?? 0) + 1,
    activationId: previousIdentity.activationId,
    operatorSha256: previousIdentity.operatorSha256,
    activationSha256: previousIdentity.activationSha256,
    rollbackSha256: rollback.sha256,
    updatedAt: nowIso(context.clock),
  });
  await runOrVerifyEffect(
    context,
    createCurrentPointerEffect(
      context.layout,
      "publish_rollback",
      restoredCurrent,
      existingCurrent ?? { exists: false },
    ),
  );
  return restoredCurrent;
}

async function resumePrecommitCompensation(context, port, options = {}) {
  let preparingParkReachedPost = false;
  if (options.settleFailureIntent === true && context.journal.state === "preparing") {
    const intent = unresolvedIntent(context.journal);
    if (intent?.effect === "park_previous") {
      const effect = await createActivationEffectFromIntent(context, port, intent);
      if (effect === null) {
        throw new PlannerReleaseInterventionError(
          "The failed previous-pair selection has no exact recovery factory.",
        );
      }
      assertEffectMatchesIntent(effect, intent);
      const observed = await inspectEffect(effect);
      if (observed.classification === "pre") return null;
      if (observed.classification === "neither") {
        context.journal = await markIntervention(
          context.layout.journalPath,
          context.journal,
          intent.effect,
          { clock: context.clock },
        );
        throw new PlannerReleaseInterventionError(
          "The failed previous-pair selection is neither exact pre-state nor post-state.",
        );
      }
      preparingParkReachedPost = true;
    }
  }
  if (preparingParkReachedPost) {
    await advanceActivationLifecycle(context, "abort", ["preparing"]);
  }
  if (!PRECOMMIT_COMPENSATION_STATES.includes(context.journal.state)) {
    throw new PlannerReleaseError(
      `Pre-commit compensation cannot resume from ${context.journal.state}.`,
    );
  }
  await advanceActivationLifecycle(context, "abort", [
    "previous_pair_parked",
    "candidate_app_selected",
    "candidate_pair_selected",
  ]);
  faultHit(context.faultInjector, "after_compensation_started");
  const recovery = planReleaseIntentRecovery(context.journal);
  if (recovery.action === "settle_failed_forward") {
    await settleIntentForCompensation(context, port);
    faultHit(context.faultInjector, "after_compensation_intent_settled");
  } else if (recovery.action === "recover_compensation") {
    await recoverKnownIntent(context, port);
  } else if (recovery.action !== "continue") {
    throw new PlannerReleaseInterventionError(
      `Pre-commit compensation received invalid recovery action ${recovery.action}.`,
    );
  }
  const previous = await readReleaseArtifact(context.layout.previousActivationPath, {
    artifactType: "previous-activation",
    activationId: context.activationId,
    operatorSha256: context.operatorSha256,
  });
  const restoreContext = Object.freeze({
    ...context,
    previous,
    precommitCompensation: true,
  });
  const restoreApp = assertActivationPortEffect(
    await port.createRestoreAppEffect(Object.freeze({
      ...restoreContext,
      recoveryIntent: effectIntent(context.journal, "restore_previous_app"),
    })),
    "restore_previous_app",
    "restore_previous_app",
  );
  await runOrVerifyEffect(context, restoreApp);
  await advanceActivationLifecycle(
    context,
    "restore_app",
    ["restoring", "previous_app_restored"],
  );

  const restoreData = assertActivationPortEffect(
    await port.createRestoreDataEffect(Object.freeze({
      ...restoreContext,
      journal: context.journal,
      recoveryIntent: effectIntent(context.journal, "restore_previous_data"),
    })),
    "restore_previous_data",
    "restore_previous_data",
  );
  await runOrVerifyEffect(context, restoreData);
  await advanceActivationLifecycle(
    context,
    "restore_data",
    ["previous_app_restored", "previous_pair_restored"],
  );

  const latestPrepared = await readLatestPreparedArtifact(context);
  const rollback = await readOrPublishDerivedReceipt(
    context,
    context.layout.rollbackPath,
    { artifactType: "rollback", activationId: context.activationId },
    async () => createReleaseArtifact({
      artifactType: "rollback",
      activationId: context.activationId,
      predecessorSha256: latestPrepared.sha256,
      projection: withOperatorProjection(
        await port.rollbackProjection(Object.freeze({
          ...context,
          previous,
          precommitCompensation: true,
        })),
        context.operatorSha256,
      ),
    }),
  );
  const current = await publishRestoredCurrent(context, previous, rollback);
  await advanceActivationLifecycle(
    context,
    "publish_rollback",
    ["previous_pair_restored", "rolled_back"],
  );
  if (context.pending === undefined) {
    context.pending = effectIntent(context.journal, "publish_pending")?.replay?.pointer ??
      await readReleasePointer(context.layout.pendingPath, {
        pointerType: "pending",
        activationId: context.activationId,
      });
  }
  await runOrVerifyEffect(
    context,
    createRemovePendingEffect(context.layout, context.pending, "remove_rollback_pending"),
  );
  return Object.freeze({
    activationId: context.activationId,
    state: context.journal.state,
    current,
    rollback,
  });
}

async function finalizePublishedCommit(context) {
  context.journal = await readReleaseJournal(
    context.layout.journalPath,
    context.activationId,
  );
  const intent = effectIntent(context.journal, "publish_current");
  if (intent === null) return null;
  const effect = await createInternalEffectFromIntent(context, intent);
  if (effect === null) {
    throw new PlannerReleaseInterventionError(
      "The current-pointer commit intent has no exact replay factory.",
    );
  }
  const unresolved = unresolvedIntent(context.journal);
  if (unresolved?.effectId === intent.effectId) {
    const observed = await inspectEffect(effect);
    if (observed.classification === "pre") return null;
    if (observed.classification === "neither") {
      context.journal = await markIntervention(
        context.layout.journalPath,
        context.journal,
        intent.effect,
        { clock: context.clock },
      );
      throw new PlannerReleaseInterventionError(
        "The current-pointer commit is neither exact pre-state nor post-state.",
      );
    }
    const recovered = await recoverRecordedReleaseEffect({
      journalPath: context.layout.journalPath,
      journal: context.journal,
      createEffect: async () => effect,
      clock: context.clock,
    });
    context.journal = recovered.journal;
  } else {
    await verifyCompletedReleaseEffect(context, effect);
  }
  await advanceActivationLifecycle(
    context,
    "publish_current",
    ["candidate_pair_selected", "committed"],
    { hashChainValid: true },
  );
  const pendingIntent = effectIntent(context.journal, "publish_pending");
  const pending = context.pending ?? pendingIntent?.replay?.pointer;
  if (pending === undefined) {
    throw new PlannerReleaseInterventionError(
      "A committed release cannot reconstruct its pending pointer for cleanup.",
    );
  }
  context.pending = pending;
  await runOrVerifyEffect(
    context,
    createRemovePendingEffect(context.layout, pending),
  );
  const activation = await readReleaseArtifact(context.layout.activationPath, {
    artifactType: "activation",
    activationId: context.activationId,
    operatorSha256: context.operatorSha256,
  });
  return Object.freeze({
    activationId: context.activationId,
    state: context.journal.state,
    current: intent.replay.pointer,
    activation,
  });
}

export async function activateReleaseTransaction(input, dependencies = {}) {
  if (input.authorized !== true) throw new PlannerReleaseInputError("Activation requires explicit --authorized consent.");
  const context = await readActivationContext(input.transaction, dependencies);
  await ensureUninitializedAuthorityConfirmation(context, input);
  const operatorHandoff = await ensureActivationOperatorHandoff(
    context,
    dependencies,
    { supersedePending: input.supersedePending ?? null },
  );
  if (operatorHandoff !== null) return Object.freeze({ handedOff: true, result: operatorHandoff });

  const acquireOwnerLease = dependencies.acquireOwnerLease;
  if (typeof acquireOwnerLease !== "function") {
    throw new PlannerReleaseError("Activation requires the integrated runtime ownership lease port.");
  }
  const lease = await acquireOwnerLease({
    layout: context.layout,
    activationId: context.activationId,
    purpose: "release",
  });
  if (!lease || typeof lease.close !== "function") {
    throw new PlannerReleaseOwnershipError("The runtime ownership port did not return a closeable lease.");
  }
  let drain = null;
  try {
    if (typeof dependencies.drainLegacy === "function") {
      drain = await dependencies.drainLegacy({
        layout: context.layout,
        activationId: context.activationId,
        dataSource: context.stage.projection.dataSource,
        lease,
      });
    }
    const pendingHandoff = await ensureOperatorAndPending(context, dependencies, {
      allowRecordedSupersession: true,
      supersedePending: input.supersedePending ?? null,
    });
    if (pendingHandoff !== null) {
      throw new PlannerReleaseInterventionError(
        "The bound release operator changed after runtime ownership was acquired.",
      );
    }
    const port = await buildActivationPort({ ...context, lease, drain }, dependencies);
    context.port = port;
    await recoverKnownIntent(context, port);
    await advanceActivationLifecycle(context, "begin", ["staged", "preparing"]);

    const prepareData = assertActivationPortEffect(
      await port.createPrepareDataEffect(Object.freeze({
        ...context,
        lease,
        drain,
        recoveryIntent: effectIntent(context.journal, "prepare_data"),
      })),
      "prepare_data",
      "prepare_data",
    );
    await runOrVerifyEffect(context, prepareData);

    const previous = await readOrPublishDerivedReceipt(
      context,
      context.layout.previousActivationPath,
      {
        artifactType: "previous-activation",
        activationId: context.activationId,
        predecessorSha256: context.stage.sha256,
      },
      async () => createReleaseArtifact({
        artifactType: "previous-activation",
        activationId: context.activationId,
        predecessorSha256: context.stage.sha256,
        projection: withOperatorProjection(
          await port.previousActivationProjection(Object.freeze({ ...context, lease, drain })),
          context.operatorSha256,
        ),
      }),
    );

    const parkEffect = assertActivationPortEffect(
      await port.createParkPreviousEffect(
        Object.freeze({
          ...context,
          lease,
          drain,
          previous,
          recoveryIntent: effectIntent(context.journal, "park_previous"),
        }),
      ),
      "park_previous",
      "park_previous",
    );
    await runOrVerifyEffect(context, parkEffect);
    await advanceActivationLifecycle(
      context,
      "park_previous",
      ["preparing", "previous_pair_parked"],
    );

    const selectAppEffect = assertActivationPortEffect(
      await port.createSelectAppEffect(
        Object.freeze({
          ...context,
          lease,
          drain,
          previous,
          recoveryIntent: effectIntent(context.journal, "select_candidate_app"),
        }),
      ),
      "select_candidate_app",
      "select_candidate_app",
    );
    await runOrVerifyEffect(context, selectAppEffect);
    const installed = await readOrPublishDerivedReceipt(
      context,
      context.layout.installedPath,
      {
        artifactType: "installed",
        activationId: context.activationId,
        predecessorSha256: context.stage.sha256,
      },
      async () => createReleaseArtifact({
        artifactType: "installed",
        activationId: context.activationId,
        predecessorSha256: context.stage.sha256,
        projection: withOperatorProjection(
          await port.installedProjection(Object.freeze({
            ...context,
            lease,
            drain,
            previous,
          })),
          context.operatorSha256,
        ),
      }),
    );
    await advanceActivationLifecycle(
      context,
      "select_app",
      ["previous_pair_parked", "candidate_app_selected"],
    );

    if ((context.stage.projection.agentSource ?? null) !== null) {
      const adoptAgentEffect = assertActivationPortEffect(
        await port.createAdoptAgentEffect(
          Object.freeze({
            ...context,
            lease,
            drain,
            previous,
            installed,
            recoveryIntent: effectIntent(context.journal, "adopt_authenticated_agent"),
          }),
        ),
        "adopt_authenticated_agent",
        "adopt_authenticated_agent",
      );
      await runOrVerifyEffect(context, adoptAgentEffect);
    }

    const selectDataEffect = assertActivationPortEffect(
      await port.createSelectDataEffect(
        Object.freeze({
          ...context,
          lease,
          drain,
          previous,
          installed,
          recoveryIntent: effectIntent(context.journal, "select_candidate_data"),
        }),
      ),
      "select_candidate_data",
      "select_candidate_data",
    );
    await runOrVerifyEffect(context, selectDataEffect);
    await advanceActivationLifecycle(
      context,
      "select_data",
      ["candidate_app_selected", "candidate_pair_selected"],
    );

    const authLifecycle = await runProofArtifactEffect({
      context,
      port,
      factoryName: "createAuthLifecycleEffect",
      effectName: "produce_auth_lifecycle",
      operation: "produce_auth_lifecycle",
      path: context.layout.authLifecyclePath,
      expected: {
        artifactType: "auth-lifecycle",
        activationId: context.activationId,
        predecessorSha256: installed.sha256,
        operatorSha256: context.operatorSha256,
      },
      proofContext: { ...context, lease, drain, previous, installed },
    });
    const releaseCandidate = await runProofArtifactEffect({
      context,
      port,
      factoryName: "createReleaseCandidateEffect",
      effectName: "produce_release_candidate",
      operation: "produce_release_candidate",
      path: context.layout.releaseCandidatePath,
      expected: {
        artifactType: "release-candidate",
        activationId: context.activationId,
        predecessorSha256: authLifecycle.sha256,
        operatorSha256: context.operatorSha256,
      },
      proofContext: { ...context, lease, drain, previous, installed, authLifecycle },
    });
    const qa = await runProofArtifactEffect({
      context,
      port,
      factoryName: "createQaEffect",
      effectName: "produce_qa",
      operation: "produce_qa",
      path: context.layout.qaPath,
      expected: {
        artifactType: "qa",
        activationId: context.activationId,
        predecessorSha256: releaseCandidate.sha256,
        operatorSha256: context.operatorSha256,
      },
      proofContext: {
        ...context,
        lease,
        drain,
        previous,
        installed,
        authLifecycle,
        releaseCandidate,
      },
    });
    const activation = await readOrPublishDerivedReceipt(
      context,
      context.layout.activationPath,
      {
        artifactType: "activation",
        activationId: context.activationId,
        predecessorSha256: qa.sha256,
        operatorSha256: context.operatorSha256,
      },
      async () => createReleaseArtifact({
        artifactType: "activation",
        activationId: context.activationId,
        predecessorSha256: qa.sha256,
        projection: withOperatorProjection(
          await port.activationProjection(Object.freeze({
            ...context,
            lease,
            drain,
            previous,
            installed,
            authLifecycle,
            releaseCandidate,
            qa,
          })),
          context.operatorSha256,
        ),
      }),
    );
    assertReleaseArtifactChain(
      [context.stage, installed, authLifecycle, releaseCandidate, qa, activation],
      { activationId: context.activationId, operatorSha256: context.operatorSha256 },
    );

    const existingCurrent = await tryReadPointer(context.layout.currentPath, "current");
    const currentPre = existingCurrent ?? { exists: false };
    const current = createReleasePointer({
      pointerType: "current",
      generation: (existingCurrent?.generation ?? 0) + 1,
      activationId: context.activationId,
      operatorSha256: context.operatorSha256,
      activationSha256: activation.sha256,
      rollbackSha256: null,
      updatedAt: nowIso(context.clock),
    });
    await runOrVerifyEffect(
      context,
      createCurrentPointerEffect(context.layout, "publish_current", current, currentPre),
    );
    await advanceActivationLifecycle(
      context,
      "publish_current",
      ["candidate_pair_selected", "committed"],
      { hashChainValid: true },
    );
    await runOrVerifyEffect(context, createRemovePendingEffect(context.layout, context.pending));
    return Object.freeze({
      activationId: context.activationId,
      state: context.journal.state,
      current,
      activation,
    });
  } catch (error) {
    context.journal = await readReleaseJournal(
      context.layout.journalPath,
      context.activationId,
    ).catch(() => context.journal);
    const originatingEffect = unresolvedIntent(context.journal)?.effect ?? null;
    if (context.journal.state === "intervention_required") throw error;
    const committed = await finalizePublishedCommit(context);
    if (committed !== null) return committed;
    if (
      context.port !== undefined &&
      (PRECOMMIT_COMPENSATION_STATES.includes(context.journal.state) ||
        (context.journal.state === "preparing" &&
          effectIntent(context.journal, "park_previous") !== null))
    ) {
      const compensated = await resumePrecommitCompensation(
        context,
        context.port,
        { settleFailureIntent: true },
      );
      if (compensated?.state === "rolled_back") {
        return Object.freeze({
          ...compensated,
          failure: compensatedActivationFailure(
            context.journal,
            error,
            originatingEffect,
          ),
        });
      }
    }
    if (error instanceof PlannerReleaseInterventionError) throw error;
    if (typeof dependencies.onActivationFailure === "function") {
      await dependencies.onActivationFailure({ context, lease, drain, error });
    }
    throw error;
  } finally {
    await drain?.close?.().catch(() => undefined);
    await lease.close().catch(() => undefined);
  }
}

export async function readReleaseTransactionStatus(input, dependencies = {}) {
  const home = dependencies.home ?? process.env.HOME;
  if (typeof home !== "string") throw new PlannerReleaseInputError("Status requires HOME.");
  if (input.transaction !== null && input.transaction !== undefined) {
    const layout = derivePlannerReleaseLayout(home, input.transaction);
    const journal = await readReleaseJournal(layout.journalPath, input.transaction);
    return Object.freeze({
      activationId: input.transaction,
      state: journal.state,
      generation: journal.generation,
      terminal: RELEASE_TERMINAL_STATES.includes(journal.state),
      journalPath: layout.journalPath,
    });
  }
  const layout = derivePlannerReleaseLayout(home);
  const [pending, current] = await Promise.all([
    tryReadPointer(layout.pendingPath, "pending"),
    tryReadPointer(layout.currentPath, "current"),
  ]);
  return Object.freeze({ pending, current });
}

function assertRollbackPort(port) {
  const functions = [
    "evaluateRollbackGuard",
    "createRestoreAppEffect",
    "createRestoreDataEffect",
    "rollbackProjection",
  ];
  if (!isPlainRecord(port) || functions.some((name) => typeof port[name] !== "function")) {
    throw new PlannerReleaseError("The release rollback dependency port is incomplete.");
  }
  return port;
}

function assertRollbackGuard(value, authorization, activationId) {
  if (
    !isPlainRecord(value) || typeof value.allowed !== "boolean" ||
    !isSha256(value.currentStoreSha256) || !isSha256(value.restoreStoreSha256) ||
    typeof value.automatic !== "boolean"
  ) {
    throw new PlannerReleaseError("The rollback guard returned an invalid exact store identity result.");
  }
  if (!value.allowed) {
    throw new PlannerReleaseError("Rollback is blocked because the selected whole-store identity changed.");
  }
  if (!value.automatic) {
    if (
      authorization === null || authorization === undefined ||
      authorization.activationId !== activationId ||
      authorization.currentStoreSha256 !== value.currentStoreSha256 ||
      authorization.restoreStoreSha256 !== value.restoreStoreSha256
    ) {
      throw new PlannerReleaseInputError(
        "Destructive rollback requires " +
          `--authorize-data-loss ${activationId}:${value.currentStoreSha256}:${value.restoreStoreSha256}.`,
      );
    }
  }
  return value;
}

function readLatestRollbackGuard(journal) {
  return [...journal.entries].reverse().find((entry) =>
    entry.kind === "checkpoint" &&
    (entry.name === "rollback_guard" || entry.name.startsWith("rollback_guard:")))
    ?.projection ?? null;
}

function sameRollbackGuardIdentity(left, right) {
  return left !== null && right !== null &&
    left.allowed === right.allowed &&
    left.automatic === right.automatic &&
    left.currentStoreSha256 === right.currentStoreSha256 &&
    left.restoreStoreSha256 === right.restoreStoreSha256;
}

async function createRollbackContext(input, dependencies) {
  const context = await readActivationContext(input.transaction, dependencies);
  const observedCurrent = await readReleasePointer(context.layout.currentPath, {
    pointerType: "current",
  });
  let current = observedCurrent;
  if (observedCurrent.activationId !== context.activationId) {
    const publicationIntent = effectIntent(context.journal, "publish_rollback");
    if (
      publicationIntent?.replay?.kind !== "pointer-publication" ||
      publicationIntent.replay.path !== context.layout.currentPath ||
      !identityEqual(publicationIntent.replay.pointer, observedCurrent) ||
      publicationIntent.expected?.pre?.activationId !== context.activationId
    ) {
      throw new PlannerReleaseInputError(
        "Rollback accepts only current.json or the exact post-state of its recorded rollback publication.",
      );
    }
    current = publicationIntent.expected.pre;
  }
  const [activation, previous] = await Promise.all([
    readReleaseArtifact(context.layout.activationPath, {
      artifactType: "activation",
      activationId: context.activationId,
      operatorSha256: current.operatorSha256,
    }),
    readReleaseArtifact(context.layout.previousActivationPath, {
      artifactType: "previous-activation",
      activationId: context.activationId,
      operatorSha256: current.operatorSha256,
    }),
  ]);
  if (activation.sha256 !== current.activationSha256) {
    throw new PlannerReleaseError("Rollback current.json does not bind the selected activation receipt.");
  }
  return { ...context, current, observedCurrent, activation, previous };
}

export async function rollbackReleaseTransaction(input, dependencies = {}) {
  const context = await createRollbackContext(input, dependencies);
  const operatorHandoff = await ensureBoundOperatorExecution(
    context,
    dependencies,
    context.current.operatorSha256,
    {
      command: "rollback",
      authorizeDataLoss: input.authorizeDataLoss ?? null,
    },
  );
  if (operatorHandoff !== null) {
    return Object.freeze({ handedOff: true, result: operatorHandoff });
  }
  if (context.journal.state === "intervention_required") {
    throw new PlannerReleaseInterventionError("Rollback is blocked by an intervention-required journal.");
  }
  if (typeof dependencies.acquireOwnerLease !== "function") {
    throw new PlannerReleaseError("Rollback requires the integrated runtime ownership lease port.");
  }
  const lease = await dependencies.acquireOwnerLease({
    layout: context.layout,
    activationId: context.activationId,
    purpose: "rollback",
  });
  if (!lease || typeof lease.close !== "function") {
    throw new PlannerReleaseOwnershipError("Rollback did not acquire a closeable writer lease.");
  }
  try {
    if (typeof dependencies.createRollbackPort !== "function") {
      throw new PlannerReleaseError("Rollback requires the integrated release rollback port.");
    }
    const port = assertRollbackPort(await dependencies.createRollbackPort(
      Object.freeze({ ...context, lease }),
    ));
    const persistedGuard = readLatestRollbackGuard(context.journal);
    if (persistedGuard !== null && persistedGuard.authorizationSatisfied !== true) {
      throw new PlannerReleaseInterventionError(
        "The durable rollback guard does not prove prior authorization.",
      );
    }
    let guard;
    if (effectIntent(context.journal, "restore_previous_data") !== null) {
      if (persistedGuard === null) {
        throw new PlannerReleaseInterventionError(
          "A durable data-restore intent has no authorized rollback guard.",
        );
      }
      guard = assertRollbackGuard(
        persistedGuard,
        persistedGuard.automatic
          ? null
          : {
              activationId: context.activationId,
              currentStoreSha256: persistedGuard.currentStoreSha256,
              restoreStoreSha256: persistedGuard.restoreStoreSha256,
            },
        context.activationId,
      );
    } else {
      const observedGuard = await port.evaluateRollbackGuard(
        Object.freeze({ ...context, lease }),
      );
      const priorAuthorization = sameRollbackGuardIdentity(observedGuard, persistedGuard) &&
          persistedGuard.authorizationSatisfied === true && !persistedGuard.automatic
        ? {
            activationId: context.activationId,
            currentStoreSha256: persistedGuard.currentStoreSha256,
            restoreStoreSha256: persistedGuard.restoreStoreSha256,
          }
        : null;
      const evaluatedGuard = assertRollbackGuard(
        observedGuard,
        priorAuthorization ?? input.authorizeDataLoss ?? null,
        context.activationId,
      );
      guard = Object.freeze({ ...evaluatedGuard, authorizationSatisfied: true });
      if (!sameRollbackGuardIdentity(guard, persistedGuard)) {
        const checkpointName = persistedGuard === null
          ? "rollback_guard"
          : `rollback_guard:${guard.currentStoreSha256}:${guard.restoreStoreSha256}`;
        context.journal = await recordReleaseCheckpoint(
          context.layout.journalPath,
          context.journal,
          checkpointName,
          guard,
          { clock: context.clock },
        );
      }
    }
    context.guard = guard;
    await recoverKnownIntent(context, port);
    const existingPending = await tryReadPointer(context.layout.pendingPath, "pending");
    if (existingPending !== null && existingPending.activationId !== context.activationId) {
      throw new PlannerReleaseOwnershipError("Another transaction is pending during rollback.");
    }
    const pending = existingPending ?? createReleasePointer({
      pointerType: "pending",
      generation: 1,
      activationId: context.activationId,
      operatorSha256: context.current.operatorSha256,
      updatedAt: nowIso(context.clock),
    });
    await runOrVerifyEffect(
      context,
      createPendingPointerEffect(
        context.layout,
        pending,
        existingPending ?? { exists: false },
        "publish_rollback_pending",
      ),
    );
    context.pending = pending;
    await advanceActivationLifecycle(
      context,
      "rollback",
      ["committed", "restoring"],
      { rollbackGuardPasses: true },
    );

    const restoreApp = assertActivationPortEffect(
      await port.createRestoreAppEffect(Object.freeze({
        ...context,
        lease,
        guard,
        recoveryIntent: effectIntent(context.journal, "restore_previous_app"),
      })),
      "restore_previous_app",
      "restore_previous_app",
    );
    await runOrVerifyEffect(context, restoreApp);
    await advanceActivationLifecycle(
      context,
      "restore_app",
      ["restoring", "previous_app_restored"],
    );

    const restoreData = assertActivationPortEffect(
      await port.createRestoreDataEffect(Object.freeze({
        ...context,
        lease,
        guard,
        recoveryIntent: effectIntent(context.journal, "restore_previous_data"),
      })),
      "restore_previous_data",
      "restore_previous_data",
    );
    await runOrVerifyEffect(context, restoreData);
    await advanceActivationLifecycle(
      context,
      "restore_data",
      ["previous_app_restored", "previous_pair_restored"],
    );

    const rollback = await readOrPublishDerivedReceipt(
      context,
      context.layout.rollbackPath,
      {
        artifactType: "rollback",
        activationId: context.activationId,
        predecessorSha256: context.activation.sha256,
        operatorSha256: context.current.operatorSha256,
      },
      async () => createReleaseArtifact({
        artifactType: "rollback",
        activationId: context.activationId,
        predecessorSha256: context.activation.sha256,
        projection: withOperatorProjection(
          await port.rollbackProjection(Object.freeze({ ...context, lease, guard })),
          context.current.operatorSha256,
        ),
      }),
    );
    const restoredCurrent = await publishRestoredCurrent(
      context,
      context.previous,
      rollback,
      { retainCurrentForFirstInstall: true },
    );
    await advanceActivationLifecycle(
      context,
      "publish_rollback",
      ["previous_pair_restored", "rolled_back"],
    );
    await runOrVerifyEffect(
      context,
      createRemovePendingEffect(context.layout, pending, "remove_rollback_pending"),
    );
    return Object.freeze({
      activationId: context.activationId,
      state: context.journal.state,
      current: restoredCurrent,
      rollback,
    });
  } finally {
    await lease.close().catch(() => undefined);
  }
}

async function recoverPrecommitCompensation(input, dependencies, pending) {
  const context = await readActivationContext(input.transaction, dependencies);
  context.pending = pending;
  const operatorHandoff = await ensureOperatorAndPending(context, dependencies);
  if (operatorHandoff !== null) {
    return Object.freeze({ handedOff: true, result: operatorHandoff });
  }
  if (typeof dependencies.acquireOwnerLease !== "function") {
    throw new PlannerReleaseError(
      "Compensation recovery requires the integrated runtime ownership lease port.",
    );
  }
  const lease = await dependencies.acquireOwnerLease({
    layout: context.layout,
    activationId: context.activationId,
    purpose: "release-recovery",
  });
  if (!lease || typeof lease.close !== "function") {
    throw new PlannerReleaseOwnershipError(
      "Compensation recovery did not acquire a closeable writer lease.",
    );
  }
  let drain = null;
  try {
    if (typeof dependencies.drainLegacy === "function") {
      drain = await dependencies.drainLegacy({
        layout: context.layout,
        activationId: context.activationId,
        dataSource: context.stage.projection.dataSource,
        lease,
        recovering: true,
      });
    }
    const port = await buildActivationPort({ ...context, lease, drain }, dependencies);
    context.port = port;
    return await resumePrecommitCompensation(context, port);
  } finally {
    await drain?.close?.().catch(() => undefined);
    await lease.close().catch(() => undefined);
  }
}

function isPostCommitRollbackJournal(journal) {
  return journal.entries.some(
    (entry) => entry.kind === "transition" &&
      entry.fromState === "committed" &&
      entry.toState === "restoring" &&
      entry.reason === "rollback_guard_passed",
  );
}

export async function recoverReleaseTransaction(input, dependencies = {}) {
  const home = dependencies.home ?? process.env.HOME;
  if (typeof home !== "string") throw new PlannerReleaseInputError("Recovery requires HOME.");
  const base = derivePlannerReleaseLayout(home);
  let pending = await tryReadPointer(base.pendingPath, "pending");
  const layout = derivePlannerReleaseLayout(home, input.transaction);
  const journal = await readReleaseJournal(layout.journalPath, input.transaction);
  const handoffContext = await readActivationContext(input.transaction, dependencies);
  const recordedSupersession = readReleaseCheckpoint(
    journal,
    PENDING_SUPERSESSION_CHECKPOINT,
  );
  const supersession = recordedSupersession === null
    ? null
    : assertPendingSupersessionCheckpoint(handoffContext, recordedSupersession);
  if (pending === null) {
    const recordedPending = effectIntent(journal, "publish_pending")?.replay?.pointer ??
      effectIntent(journal, "replace_pending")?.replay?.pointer;
    if (
      !RELEASE_TERMINAL_STATES.includes(journal.state) ||
      recordedPending?.activationId !== input.transaction
    ) {
      throw new PlannerReleaseOwnershipError(
        "Recovery requires the exact pending transaction unless terminal cleanup already removed it.",
      );
    }
    pending = recordedPending;
  } else if (
    pending.activationId !== input.transaction &&
    (
      supersession === null ||
      !identityEqual(pending, supersession.supersededPointer)
    )
  ) {
    throw new PlannerReleaseOwnershipError("Recovery transaction does not match pending.json.");
  }
  if (journal.state === "intervention_required") {
    throw new PlannerReleaseInterventionError("Recovery requires manual intervention for this transaction.");
  }
  const recoveryHandoff = await ensureBoundOperatorExecution(
    handoffContext,
    dependencies,
    handoffContext.stage.projection.operatorSource.sha256,
    { command: "recover" },
  );
  if (recoveryHandoff !== null) {
    return Object.freeze({ handedOff: true, result: recoveryHandoff });
  }
  if (journal.state === "committed" || journal.state === "rolled_back") {
    const context = handoffContext;
    context.pending = pending;
    await runOrVerifyEffect(
      context,
      createRemovePendingEffect(
        layout,
        pending,
        journal.state === "committed" ? "remove_pending" : "remove_rollback_pending",
      ),
    );
    return Object.freeze({
      activationId: input.transaction,
      state: journal.state,
      recovered: true,
    });
  }
  if (["restoring", "previous_app_restored", "previous_pair_restored"].includes(journal.state)) {
    if (isPostCommitRollbackJournal(journal)) {
      return rollbackReleaseTransaction({
        transaction: input.transaction,
        authorizeDataLoss: dependencies.recoveryDataLossAuthorization ?? null,
      }, dependencies);
    }
    return recoverPrecommitCompensation(input, dependencies, pending);
  }
  return activateReleaseTransaction({
    transaction: input.transaction,
    authorized: true,
    supersedePending: supersession?.supersededPointer.activationId ?? null,
  }, dependencies);
}
