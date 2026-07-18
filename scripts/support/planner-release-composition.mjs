import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  PlannerReleaseError,
  PlannerReleaseInterventionError,
  PlannerReleaseOwnershipError,
  canonicalReleaseJson,
  createReleaseArtifact,
  ensurePrivateDirectory,
  publishReleaseArtifact,
  readPrivateJson,
  readReleaseArtifact,
  readReleasePointer,
  sha256Bytes,
  writePrivateImmutableJson,
} from "./planner-release-contract.mjs";
import {
  copyReleaseTree,
  freezeReleaseTree,
  inspectReleaseTreeIdentity,
  inventoryReleaseTree,
  normalizeNpmDependencyGraph,
  runReleaseCommand,
  syncReleaseTree,
} from "./planner-release-transaction.mjs";
import {
  authReleaseInputsFromArtifacts,
  authRuntimeIdentityFromActivationCoordinates,
  createAuthLifecycleReleaseArtifact,
} from "./codex-auth-lifecycle.mjs";
import {
  runCodexAuthReadiness,
} from "./codex-auth-readiness.mjs";
import {
  loadAndValidateCodexAuthReadinessSchemaBundle,
} from "./codex-auth-schema.mjs";
import {
  createReleaseCandidateReleaseArtifact,
  releaseCandidateBindingFromArtifacts,
  releaseCandidateProjectionFromArtifact,
} from "./codex-release-candidate-contract.mjs";
import {
  NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
  assertProductionAuthReadinessProjection,
} from "./planner-release-evidence-contract.mjs";
import { acquireRuntimeOwnershipLease } from "./runtime-ownership.mjs";
import { verifyQaEvidenceManifest } from "./planner-qa-evidence.mjs";
import { releaseSourceExclusionSet } from "./planner-release-source.mjs";
import {
  createAuthenticatedAgentAdoptionEffect,
  createAuthenticatedAgentRestoreCoordinator,
  inspectPlannerReleaseAgentSource,
} from "./planner-agent-adoption.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const FROZEN_RELEASE_DIRECTORY_MODE = 0o500;
const DEFAULT_LEGACY_HTTP_PORT = 3000;
const DATA_PREPARATION_RECEIPT = "data-preparation.json";
const PREVIOUS_PAIR_RECEIPT = "previous-pair.json";
const CANDIDATE_APP_RECEIPT = "candidate-app.json";
const SUPERSEDED_AGENT_DIRECTORY = "superseded-agent";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left, right) {
  return canonicalReleaseJson(left) === canonicalReleaseJson(right);
}

async function assertCandidateSourceManifest(context, root, label) {
  const expected = context.stage?.projection?.candidateSource;
  if (!isRecord(expected)) {
    throw new PlannerReleaseError(`${label} requires the staged candidate source manifest.`);
  }
  const observed = await inventoryReleaseTree(root);
  if (!same(observed, expected)) {
    throw new PlannerReleaseError(`${label} changed after the exact Node preflight.`);
  }
  return observed;
}

function pathInsideOrEqual(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function releaseEntryExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function currentReleaseOwnerUid() {
  if (typeof process.getuid !== "function") {
    throw new PlannerReleaseError("The local release operator requires POSIX ownership readback.");
  }
  return process.getuid();
}

function frozenReleaseTreeSecurityIdentity() {
  return Object.freeze({
    exists: true,
    kind: "directory",
    rootMode: FROZEN_RELEASE_DIRECTORY_MODE,
    ownerUid: currentReleaseOwnerUid(),
  });
}

async function inspectReleaseOwnedTreeSecurity(root, label, allowedRootModes) {
  const ownerUid = currentReleaseOwnerUid();
  const pending = [root];
  let rootMode = null;
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new PlannerReleaseInterventionError(`${label} acquired a symbolic link.`);
    }
    if (metadata.uid !== ownerUid) {
      throw new PlannerReleaseInterventionError(`${label} is not owned by the release operator user.`);
    }
    if (current === root) {
      if (!metadata.isDirectory()) {
        throw new PlannerReleaseInterventionError(`${label} is not a real directory.`);
      }
      rootMode = metadata.mode & 0o777;
      if (!allowedRootModes.has(rootMode)) {
        throw new PlannerReleaseInterventionError(
          `${label} has mode ${rootMode.toString(8)} outside its recorded release state.`,
        );
      }
    }
    if (metadata.isDirectory()) {
      for (const child of await readdir(current)) pending.push(join(current, child));
    } else if (!metadata.isFile()) {
      throw new PlannerReleaseInterventionError(`${label} acquired an unexpected special file.`);
    }
  }
  return Object.freeze({ exists: true, kind: "directory", rootMode, ownerUid });
}

async function inspectFrozenReleaseTreeSecurity(root, label) {
  return inspectReleaseOwnedTreeSecurity(
    root,
    label,
    new Set([FROZEN_RELEASE_DIRECTORY_MODE]),
  );
}

async function refreezeReleaseTreeAfterError(root, label, error) {
  try {
    await freezeReleaseTree(root);
    await inspectFrozenReleaseTreeSecurity(root, label);
  } catch (freezeError) {
    throw new PlannerReleaseInterventionError(
      `${label} failed and could not be returned to its recorded read-only state.`,
      { cause: new AggregateError([error, freezeError]) },
    );
  }
  throw error;
}

async function sha256File(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PlannerReleaseError(`Release identity requires a real file: ${path}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectPrivateAgentFile(path, label, { includeSha256 = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PlannerReleaseError(`${label} is missing from the dedicated Codex home.`);
    }
    throw error;
  }
  const ownerUid = currentReleaseOwnerUid();
  const mode = metadata.mode & 0o777;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== ownerUid ||
    mode !== PRIVATE_FILE_MODE ||
    metadata.nlink !== 1
  ) {
    throw new PlannerReleaseInterventionError(
      `${label} must be one current-user-owned mode-0600 non-linked regular file.`,
    );
  }
  return Object.freeze({
    present: true,
    kind: "file",
    ownerUid,
    mode,
    linkCount: metadata.nlink,
    ...(includeSha256 ? { sha256: await sha256File(path) } : {}),
  });
}

async function inspectDedicatedAgentReadiness(layout, installed) {
  let rootMetadata;
  let canonicalRoot;
  try {
    [rootMetadata, canonicalRoot] = await Promise.all([
      lstat(layout.agentRoot),
      realpath(layout.agentRoot),
    ]);
  } catch (error) {
    throw new PlannerReleaseError("The dedicated Codex home is unavailable at activation.", {
      cause: error,
    });
  }
  const ownerUid = currentReleaseOwnerUid();
  const rootMode = rootMetadata.mode & 0o777;
  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    canonicalRoot !== layout.agentRoot ||
    rootMetadata.uid !== ownerUid ||
    rootMode !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new PlannerReleaseInterventionError(
      "The dedicated Codex home is not one private canonical current-user directory.",
    );
  }
  const [credentials, config, instructions] = await Promise.all([
    inspectPrivateAgentFile(join(layout.agentRoot, "auth.json"), "Dedicated credentials"),
    inspectPrivateAgentFile(layout.agentConfigPath, "Dedicated config", { includeSha256: true }),
    inspectPrivateAgentFile(layout.agentInstructionsPath, "Dedicated instructions", {
      includeSha256: true,
    }),
  ]);
  if (config.sha256 !== installed.configSha256 || instructions.sha256 !== installed.instructionSha256) {
    throw new PlannerReleaseError(
      "The dedicated Codex configuration changed after installed verification.",
    );
  }
  return Object.freeze({
    exists: true,
    kind: "dedicated-codex-home",
    ownerUid,
    rootMode,
    credentials,
    config,
    instructions,
  });
}

async function assertStageRuntimeIdentity(context, dependencies, phase) {
  const expected = Object.freeze({
    node: context.stage.projection.preflight.node,
    npm: context.stage.projection.preflight.npm,
  });
  const inspect = dependencies.inspectStageRuntimeIdentity ?? (async () => {
    const runCommand = dependencies.runCommand ?? runReleaseCommand;
    const environment = dependencies.environment ?? process.env;
    const nodeExecutable = await realpath(expected.node.executable);
    const npmExecutable = await realpath(expected.npm.executable);
    const npmCli = await realpath(expected.npm.cli);
    const [nodeVersion, npmVersion, nodeSha256, npmCliSha256] = await Promise.all([
      runCommand(nodeExecutable, ["--version"], {
        env: environment,
        requireEmptyStderr: true,
      }),
      runCommand(npmExecutable, [npmCli, "--version"], {
        env: { ...environment, PATH: `${dirname(nodeExecutable)}:${environment.PATH ?? ""}` },
        requireEmptyStderr: true,
      }),
      sha256File(nodeExecutable),
      sha256File(npmCli),
    ]);
    return Object.freeze({
      node: Object.freeze({
        ...expected.node,
        executable: nodeExecutable,
        version: nodeVersion.stdout.trim(),
        sha256: nodeSha256,
      }),
      npm: Object.freeze({
        ...expected.npm,
        executable: npmExecutable,
        cli: npmCli,
        version: npmVersion.stdout.trim(),
        cliSha256: npmCliSha256,
      }),
    });
  });
  const observed = await inspect({ context, expected, phase });
  if (!same(observed?.node, expected.node) || !same(observed?.npm, expected.npm)) {
    throw new PlannerReleaseError(
      `The exact Node/npm runtime changed ${phase}.`,
    );
  }
  return expected;
}

async function makeTreeWritable(root) {
  if (!await pathExists(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new PlannerReleaseInterventionError(
        "A release-owned tree acquired an unexpected symbolic link.",
      );
    }
    if (metadata.isDirectory()) {
      await chmod(current, 0o700);
      for (const child of await readdir(current)) pending.push(join(current, child));
    } else if (metadata.isFile()) {
      await chmod(current, (metadata.mode & 0o111) === 0 ? 0o600 : 0o700);
    } else {
      throw new PlannerReleaseInterventionError(
        "A release-owned tree acquired an unexpected special file.",
      );
    }
  }
}

async function removeReleaseOwnedTree(path) {
  if (!await pathExists(path)) return;
  await makeTreeWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function renameExclusive(source, destination, label) {
  const [sourceExists, destinationExists] = await Promise.all([
    pathExists(source),
    pathExists(destination),
  ]);
  if (sourceExists && destinationExists) {
    throw new PlannerReleaseInterventionError(
      `${label} found both its source and destination and cannot choose one authority.`,
    );
  }
  if (sourceExists) {
    await rename(source, destination);
    return true;
  }
  return false;
}

async function renameFrozenReleaseTreeExclusive(
  source,
  destination,
  label,
  { recovery = false, sourceRootModes = null } = {},
) {
  const [sourceExists, destinationExists] = await Promise.all([
    releaseEntryExists(source),
    releaseEntryExists(destination),
  ]);
  if (sourceExists && destinationExists) {
    throw new PlannerReleaseInterventionError(
      `${label} found both its source and destination and cannot choose one authority.`,
    );
  }
  if (!sourceExists && !destinationExists) return false;
  if (!sourceExists) {
    await inspectReleaseOwnedTreeSecurity(
      destination,
      `${label} destination`,
      new Set([
        FROZEN_RELEASE_DIRECTORY_MODE,
        ...(recovery ? [PRIVATE_DIRECTORY_MODE] : []),
      ]),
    );
    try {
      await freezeReleaseTree(destination);
      await inspectFrozenReleaseTreeSecurity(destination, `${label} destination`);
    } catch (error) {
      await refreezeReleaseTreeAfterError(destination, `${label} destination`, error);
    }
    return false;
  }
  await inspectReleaseOwnedTreeSecurity(
    source,
    `${label} source`,
    sourceRootModes ?? new Set([
        FROZEN_RELEASE_DIRECTORY_MODE,
        ...(recovery ? [PRIVATE_DIRECTORY_MODE] : []),
      ]),
  );
  let authoritativeRoot = source;
  try {
    await chmod(source, PRIVATE_DIRECTORY_MODE);
    await rename(source, destination);
    authoritativeRoot = destination;
    await freezeReleaseTree(destination);
    await inspectFrozenReleaseTreeSecurity(destination, `${label} destination`);
  } catch (error) {
    await refreezeReleaseTreeAfterError(
      authoritativeRoot,
      `${label} ${authoritativeRoot === source ? "source" : "destination"}`,
      error,
    );
  }
  return true;
}

async function importCandidateModule(root, relativePath) {
  const modulePath = join(root, relativePath);
  if (!pathInsideOrEqual(root, modulePath)) {
    throw new PlannerReleaseError("A candidate module path escaped its frozen source root.");
  }
  return import(pathToFileURL(modulePath).href);
}

async function loadPlannerStoreModule(root) {
  const storeExports = await importCandidateModule(root, "server/store/sqlite-store.ts");
  for (const name of [
    "inspectVerifiedPlannerSnapshot",
    "acquirePlannerStoreWriteReservation",
    "openPlannerStore",
  ]) {
    if (typeof storeExports[name] !== "function") {
      throw new PlannerReleaseError(`The selected candidate store omits ${name}.`);
    }
  }
  return storeExports;
}

function assertPlannerSnapshotProjection(value, label) {
  if (
    !isRecord(value) || value.quickCheck !== "ok" ||
    !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 ||
    typeof value.initialized !== "boolean" ||
    (value.initialized && (
      !Number.isSafeInteger(value.workspaceSchemaVersion) ||
      value.workspaceSchemaVersion < 1 ||
      !Number.isSafeInteger(value.plannerVersion) ||
      value.plannerVersion < 0
    ))
  ) {
    throw new PlannerReleaseError(`${label} is not a verified planner snapshot projection.`);
  }
  return value;
}

export async function inspectPlannerReleaseDataSource(candidateSource, filename) {
  const store = await loadPlannerStoreModule(candidateSource);
  const projection = assertPlannerSnapshotProjection(
    store.inspectVerifiedPlannerSnapshot(filename),
    "The explicit planner data source",
  );
  return Object.freeze({
    sha256: projection.sha256,
    quickCheck: projection.quickCheck,
    schemaVersion: projection.schemaVersion,
    initialized: projection.initialized,
    workspaceSchemaVersion: projection.workspaceSchemaVersion,
    plannerVersion: projection.plannerVersion,
  });
}

function compareStagedDataSource(stage, current) {
  const staged = stage.projection.dataSource;
  const keys = [
    "sha256",
    "quickCheck",
    "schemaVersion",
    "initialized",
    "workspaceSchemaVersion",
    "plannerVersion",
  ];
  if (keys.some((key) => staged[key] !== current[key])) {
    throw new PlannerReleaseOwnershipError(
      "The explicit planner data source changed after stage; create a new transaction.",
    );
  }
}

function probeUnavailable(options) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection(options);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe();
    };
    socket.once("connect", () => finish(new PlannerReleaseOwnershipError(
      `A legacy planner endpoint is still accepting connections (${options.path ?? `${options.host}:${options.port}`}).`,
    )));
    socket.once("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error?.code)) finish();
      else finish(new PlannerReleaseOwnershipError(
        "A legacy planner endpoint could not be classified as stopped.",
        { cause: error },
      ));
    });
    socket.setTimeout(1_000, () => finish(new PlannerReleaseOwnershipError(
      "A legacy planner endpoint probe was indeterminate.",
    )));
  });
}

async function assertLegacyRuntimeStopped(layout, environment) {
  const configuredPort = Number(environment.PLANNER_LEGACY_HTTP_PORT ?? DEFAULT_LEGACY_HTTP_PORT);
  if (!Number.isSafeInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    throw new PlannerReleaseError("PLANNER_LEGACY_HTTP_PORT is invalid.");
  }
  await probeUnavailable({ host: "127.0.0.1", port: configuredPort });
  await probeUnavailable({ path: layout.globalCodexSocketPath });
}

async function normalizeMigratedCandidate(storeModule, candidateFilename, normalizedFilename) {
  const opened = storeModule.openPlannerStore({ filename: candidateFilename });
  try {
    const workspace = opened.readWorkspace();
    if (!isRecord(workspace) || typeof workspace.initialized !== "boolean") {
      throw new PlannerReleaseError(
        "Candidate store migration returned an invalid household initialization projection.",
      );
    }
  } finally {
    opened.close();
  }
  const reservation = storeModule.acquirePlannerStoreWriteReservation({
    filename: candidateFilename,
  });
  try {
    const normalized = reservation.createVerifiedSnapshot(normalizedFilename);
    await rm(candidateFilename, { force: true });
    await rename(normalizedFilename, candidateFilename);
    return Object.freeze({ ...normalized, filename: candidateFilename });
  } finally {
    reservation.close();
  }
}

async function readDataPreparationReceipt(context, storeModule) {
  const receiptPath = join(context.layout.transactionRoot, DATA_PREPARATION_RECEIPT);
  if (!await pathExists(receiptPath)) return null;
  const receipt = await readPrivateJson(receiptPath, { label: "Data preparation receipt" });
  if (
    receipt.schemaVersion !== 1 || receipt.activationId !== context.activationId ||
    !isRecord(receipt.rollback) || !isRecord(receipt.candidate)
  ) {
    throw new PlannerReleaseInterventionError("The data preparation receipt is malformed.");
  }
  const observedRollback = assertPlannerSnapshotProjection(
    storeModule.inspectVerifiedPlannerSnapshot(join(context.layout.rollbackDataRoot, "planner.sqlite")),
    "Rollback planner data",
  );
  const candidatePaths = [
    join(context.layout.candidateDataRoot, "planner.sqlite"),
    join(context.layout.dataRoot, "planner.sqlite"),
    join(
      context.layout.supersededDataRoot,
      `precommit-${context.activationId}`,
      "planner.sqlite",
    ),
  ];
  let observedCandidate = null;
  for (const path of candidatePaths) {
    try {
      const inspected = assertPlannerSnapshotProjection(
        storeModule.inspectVerifiedPlannerSnapshot(path),
        "Candidate planner data",
      );
      if (inspected.sha256 === receipt.candidate.sha256) {
        observedCandidate = inspected;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const snapshotFacts = (value) => ({
    byteLength: value.byteLength,
    sha256: value.sha256,
    quickCheck: value.quickCheck,
    schemaVersion: value.schemaVersion,
    initialized: value.initialized,
    workspaceSchemaVersion: value.workspaceSchemaVersion,
    plannerVersion: value.plannerVersion,
  });
  if (
    observedCandidate === null ||
    !same(snapshotFacts(receipt.rollback), snapshotFacts(observedRollback)) ||
    !same(snapshotFacts(receipt.candidate), snapshotFacts(observedCandidate))
  ) {
    throw new PlannerReleaseInterventionError(
      "Prepared planner data changed after its immutable receipt.",
    );
  }
  return Object.freeze({
    receipt,
    receiptPath,
    rollback: receipt.rollback,
    candidate: receipt.candidate,
  });
}

async function preparePlannerData(context, storeModule, reservation) {
  const existing = await readDataPreparationReceipt(context, storeModule);
  if (existing !== null) return existing;
  await mkdir(context.layout.rollbackDataRoot, { mode: PRIVATE_DIRECTORY_MODE }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const rollbackFilename = join(context.layout.rollbackDataRoot, "planner.sqlite");
  const candidateFilename = join(context.layout.candidateDataRoot, "planner.sqlite");
  const normalizedCandidateFilename = join(
    context.layout.candidateDataRoot,
    `.normalized-${randomUUID()}.sqlite`,
  );
  let rollback;
  try {
    rollback = assertPlannerSnapshotProjection(
      storeModule.inspectVerifiedPlannerSnapshot(rollbackFilename),
      "Rollback planner data",
    );
  } catch (error) {
    if (await pathExists(rollbackFilename)) {
      await rm(rollbackFilename, { force: true });
    } else if (error?.code !== "ENOENT") {
      throw error;
    }
    rollback = assertPlannerSnapshotProjection(
      reservation.createVerifiedSnapshot(rollbackFilename),
      "Rollback planner data",
    );
  }
  await removeReleaseOwnedTree(context.layout.candidateDataRoot);
  await mkdir(context.layout.candidateDataRoot, { mode: PRIVATE_DIRECTORY_MODE });
  await copyFile(rollbackFilename, candidateFilename, 1);
  const copied = storeModule.inspectVerifiedPlannerSnapshot(candidateFilename);
  if (copied.sha256 !== rollback.sha256) {
    throw new PlannerReleaseError("Candidate planner data did not derive from the one rollback snapshot.");
  }
  const candidate = assertPlannerSnapshotProjection(
    await normalizeMigratedCandidate(
      storeModule,
      candidateFilename,
      normalizedCandidateFilename,
    ),
    "Migrated candidate planner data",
  );
  const receipt = Object.freeze({
    schemaVersion: 1,
    activationId: context.activationId,
    rollback,
    candidate,
  });
  const receiptPath = join(context.layout.transactionRoot, DATA_PREPARATION_RECEIPT);
  await writePrivateImmutableJson(receiptPath, receipt);
  await syncReleaseTree(context.layout.rollbackDataRoot);
  await syncReleaseTree(context.layout.candidateDataRoot);
  return Object.freeze({ receipt, receiptPath, rollback, candidate });
}

export async function drainLegacyPlannerRuntime(context, dependencies = {}) {
  const stage = context.stage ?? await readReleaseArtifact(context.layout.stagePath, {
    artifactType: "stage",
    activationId: context.activationId,
  });
  const releaseContext = {
    ...context,
    home: context.home ?? context.layout.home,
    stage,
  };
  const environment = dependencies.environment ?? process.env;
  await assertLegacyRuntimeStopped(releaseContext.layout, environment);
  if (dependencies.loadPlannerStoreModule === undefined) {
    await assertCandidateSourceManifest(
      releaseContext,
      releaseContext.layout.candidateSourceRoot,
      "The staged candidate source used for planner-data preparation",
    );
  }
  const storeModule = await (dependencies.loadPlannerStoreModule ?? loadPlannerStoreModule)(
    releaseContext.layout.candidateSourceRoot,
  );
  const sourceProjection = assertPlannerSnapshotProjection(
    storeModule.inspectVerifiedPlannerSnapshot(stage.projection.dataSource.canonicalPath),
    "The explicit planner data source",
  );
  compareStagedDataSource(stage, sourceProjection);
  const reservation = storeModule.acquirePlannerStoreWriteReservation({
    filename: stage.projection.dataSource.canonicalPath,
  });
  try {
    await assertLegacyRuntimeStopped(releaseContext.layout, environment);
    let prepared = null;
    return Object.freeze({
      storeModule,
      reservation,
      get prepared() {
        return prepared;
      },
      get rollback() {
        return prepared?.rollback ?? null;
      },
      get candidate() {
        return prepared?.candidate ?? null;
      },
      async prepare() {
        prepared ??= await preparePlannerData(releaseContext, storeModule, reservation);
        return prepared;
      },
      async readPrepared() {
        prepared ??= await readDataPreparationReceipt(releaseContext, storeModule);
        return prepared;
      },
      async close() {
        reservation.close();
      },
    });
  } catch (error) {
    reservation.close();
    throw error;
  }
}

function installedEnvironment(environment, context) {
  return {
    HOME: context.home,
    PATH: environment.PATH,
    TMPDIR: environment.TMPDIR,
    LANG: environment.LANG,
    LC_ALL: environment.LC_ALL,
    SSL_CERT_FILE: environment.SSL_CERT_FILE,
    SSL_CERT_DIR: environment.SSL_CERT_DIR,
    HTTP_PROXY: environment.HTTP_PROXY,
    HTTPS_PROXY: environment.HTTPS_PROXY,
    NO_PROXY: environment.NO_PROXY,
    npm_config_cache: context.layout.npmCacheRoot,
    npm_config_audit: "false",
    npm_config_fund: "false",
    WRANGLER_LOG_PATH: join(context.layout.qaRoot, "canonical-build-wrangler.log"),
  };
}

function scrubUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function scanGeneratedText(root, callback) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const child of await readdir(current, { withFileTypes: true })) {
      const path = join(current, child.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new PlannerReleaseError("Installed build output contains a symbolic link.");
      }
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new PlannerReleaseError("Installed build output contains a special file.");
      }
      if (metadata.size > 16 * 1024 * 1024) continue;
      const bytes = await readFile(path);
      if (bytes.includes(0)) continue;
      callback(path, bytes.toString("utf8"));
    }
  }
}

export async function assertCanonicalInstalledBuildReferences({
  generatedRoot,
  canonicalAppRoot,
  forbiddenRoots,
}) {
  const canonical = await realpath(canonicalAppRoot);
  const forbidden = [...new Set(forbiddenRoots.filter(
    (entry) => typeof entry === "string" && isAbsolute(entry) && !pathInsideOrEqual(canonical, entry),
  ))];
  await scanGeneratedText(generatedRoot, (path, text) => {
    const leaked = forbidden.find((root) => text.includes(root));
    if (leaked !== undefined) {
      throw new PlannerReleaseError(
        `Installed build output ${relative(canonical, path)} references a noncanonical build root.`,
      );
    }
    for (const match of text.matchAll(/\/(?:Users|home|private|tmp)\/[^\s"'`(){}<>]+/gu)) {
      const candidate = match[0].replace(/[),.;:]+$/u, "");
      if (!pathInsideOrEqual(canonical, candidate)) {
        throw new PlannerReleaseError(
          `Installed build output ${relative(canonical, path)} contains an absolute path outside the canonical app.`,
        );
      }
    }
  });
  return true;
}

async function materializeCanonicalApp(context, sourceRoot, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? runReleaseCommand;
  const environment = scrubUndefined(installedEnvironment(
    dependencies.environment ?? process.env,
    context,
  ));
  await assertStageRuntimeIdentity(context, dependencies, "before canonical installation");
  await ensurePrivateDirectory(context.layout.qaRoot);
  const copiedManifest = await copyReleaseTree(sourceRoot, context.layout.appRoot);
  if (!same(copiedManifest, context.stage.projection.candidateSource)) {
    throw new PlannerReleaseError(
      "The canonical application source changed after the exact Node preflight.",
    );
  }
  const node = context.stage.projection.preflight.node.executable;
  const npmCli = context.stage.projection.preflight.npm.cli;
  const npmEnvironment = {
    ...environment,
    PATH: `${dirname(node)}:${environment.PATH ?? ""}`,
  };
  const runNpm = (args) => runCommand(node, [npmCli, ...args], {
    cwd: context.layout.appRoot,
    env: npmEnvironment,
    requireEmptyStderr: true,
  });
  await runNpm([
    "ci",
    "--cache",
    context.layout.npmCacheRoot,
  ]);
  const typescript = join(context.layout.appRoot, "node_modules", "typescript", "bin", "tsc");
  if (await pathExists(typescript)) {
    await runCommand(node, [typescript, "--noEmit", "--incremental", "false"], {
      cwd: context.layout.appRoot,
      env: environment,
    });
  } else {
    await runNpm(["run", "typecheck"]);
  }
  await Promise.all([
    rm(join(context.layout.appRoot, ".vinext"), { recursive: true, force: true }),
    rm(join(context.layout.appRoot, "dist"), { recursive: true, force: true }),
  ]);
  const vinext = join(context.layout.appRoot, "node_modules", "vinext", "dist", "cli.js");
  if (await pathExists(vinext)) {
    await runCommand(node, [vinext, "build"], {
      cwd: context.layout.appRoot,
      env: environment,
    });
  } else {
    await runNpm(["run", "build"]);
  }
  await assertCanonicalInstalledBuildReferences({
    generatedRoot: join(context.layout.appRoot, "dist"),
    canonicalAppRoot: context.layout.appRoot,
    forbiddenRoots: [
      context.layout.transactionRoot,
      context.layout.candidateSourceRoot,
      context.layout.baselineSourceRoot,
      dependencies.originalCandidateSource,
    ],
  });
  const dependencyGraphResult = await runNpm(["ls", "--all", "--json"]);
  const dependencyGraphSha256 = sha256Bytes(canonicalReleaseJson(
    normalizeNpmDependencyGraph(JSON.parse(dependencyGraphResult.stdout)),
  ));
  if (
    dependencyGraphSha256 !==
      context.stage.projection.preflight.candidate.dependencyGraphSha256
  ) {
    throw new PlannerReleaseError(
      "The canonical npm dependency graph changed after the exact Node preflight.",
    );
  }
  await syncReleaseTree(context.layout.appRoot);
  const manifest = await inventoryReleaseTree(context.layout.appRoot, {
    excludedRootNames: releaseSourceExclusionSet(),
  });
  if (!same(manifest, context.stage.projection.candidateSource)) {
    throw new PlannerReleaseError(
      "The canonical application source changed while the installed build ran.",
    );
  }
  await assertStageRuntimeIdentity(context, dependencies, "during canonical installation");
  await freezeReleaseTree(context.layout.appRoot);
  return Object.freeze({ manifest, dependencyGraphSha256 });
}

async function copyDeploymentFile(source, destination) {
  await ensurePrivateDirectory(dirname(destination));
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await copyFile(source, temporary, 1);
  await chmod(temporary, PRIVATE_FILE_MODE);
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  const directory = await open(dirname(destination), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function installDeploymentConfiguration(context) {
  await ensurePrivateDirectory(context.layout.agentRoot);
  const sourceConfig = join(context.layout.appRoot, "deployment", "codex", "config.toml");
  const sourceInstructions = join(context.layout.appRoot, "deployment", "codex", "AGENTS.md");
  await Promise.all([
    copyDeploymentFile(sourceConfig, context.layout.agentConfigPath),
    copyDeploymentFile(sourceInstructions, context.layout.agentInstructionsPath),
  ]);
  const [configSha256, instructionSha256] = await Promise.all([
    sha256File(context.layout.agentConfigPath),
    sha256File(context.layout.agentInstructionsPath),
  ]);
  if (
    configSha256 !== context.stage.projection.configSha256 ||
    instructionSha256 !== context.stage.projection.instructionSha256
  ) {
    throw new PlannerReleaseError("Installed Codex deployment inputs changed from stage.");
  }
  return Object.freeze({ configSha256, instructionSha256 });
}

function activationReplay(operation, projection = {}) {
  return Object.freeze({
    schemaVersion: 1,
    kind: "activation-port",
    operation,
    ...projection,
  });
}

function semanticEffect({ name, pre, post, inspect, perform, replay = activationReplay(name) }) {
  return Object.freeze({
    name,
    expected: Object.freeze({ pre, post }),
    replay,
    async inspect() {
      const classification = await inspect();
      if (classification === "pre") return { classification, identity: pre };
      if (classification === "post") return { classification, identity: post };
      return { classification: "neither", identity: { state: "neither" } };
    },
    perform,
  });
}

async function tryReadCurrent(layout) {
  try {
    return await readReleasePointer(layout.currentPath, { pointerType: "current" });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function tryReadReceipt(path, label) {
  try {
    return await readPrivateJson(path, { label });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function verifiedTreeMatches(path, expected) {
  return same(await inspectReleaseTreeIdentity(path), expected);
}

async function verifiedFrozenTreeMatches(path, expected, label) {
  if (!await verifiedTreeMatches(path, expected)) return false;
  if (expected.exists) await inspectFrozenReleaseTreeSecurity(path, label);
  return true;
}

function hasUnresolvedIntent(context, effectName) {
  const completed = new Set(context.journal.entries
    .filter((entry) => entry.kind === "completed")
    .map((entry) => entry.effectId));
  return context.journal.entries.some((entry) =>
    entry.kind === "intent" && entry.effect === effectName && !completed.has(entry.effectId));
}

async function requirePreparedPlannerData(drain) {
  const prepared = drain.prepared ?? await drain.readPrepared();
  if (prepared === null) {
    throw new PlannerReleaseError("The durable planner-data preparation receipt is missing.");
  }
  return prepared;
}

async function createPrepareDataEffect(context) {
  const receiptPath = join(context.layout.transactionRoot, DATA_PREPARATION_RECEIPT);
  const pre = Object.freeze({ activationId: context.activationId, state: "data_unprepared" });
  const post = Object.freeze({ activationId: context.activationId, state: "data_prepared" });
  return semanticEffect({
    name: "prepare_data",
    pre,
    post,
    replay: activationReplay("prepare_data", { receiptPath }),
    async inspect() {
      const prepared = await context.drain.readPrepared();
      if (prepared !== null) return "post";
      const interrupted = await pathExists(context.layout.rollbackDataRoot) ||
        await pathExists(context.layout.candidateDataRoot);
      if (!interrupted || context.recoveryIntent?.effect === "prepare_data") return "pre";
      return "neither";
    },
    async perform() {
      await context.drain.prepare();
    },
  });
}

async function createPreviousPairEffect(context, previous) {
  const receiptPath = join(context.layout.transactionRoot, PREVIOUS_PAIR_RECEIPT);
  const firstInstall = previous.firstInstall === true;
  const recovering = context.recoveryIntent !== null && context.recoveryIntent !== undefined;
  const frozenAppSecurity = frozenReleaseTreeSecurityIdentity();
  const absentAppSecurity = Object.freeze({ exists: false });
  const pre = Object.freeze({
    activationId: context.activationId,
    firstInstall,
    state: "previous_pair_selected",
    selectedAppRootSecurity: firstInstall ? absentAppSecurity : frozenAppSecurity,
    previousApp: previous.app,
    previousData: previous.data,
  });
  const post = Object.freeze({
    activationId: context.activationId,
    firstInstall,
    state: "previous_pair_parked",
    parkedAppRootSecurity: firstInstall ? absentAppSecurity : frozenAppSecurity,
    previousApp: previous.app,
    previousData: previous.data,
  });
  const validateReceipt = async (receipt) => {
    if (
      receipt?.schemaVersion !== 1 || receipt.activationId !== context.activationId ||
      receipt.firstInstall !== firstInstall || !isRecord(receipt.app) || !isRecord(receipt.data) ||
      !same(receipt.app, previous.app) || !same(receipt.data, previous.data) ||
      !same(
        receipt.appRootSecurity,
        firstInstall ? absentAppSecurity : frozenAppSecurity,
      )
    ) return false;
    if (!firstInstall) {
      await inspectFrozenReleaseTreeSecurity(
        context.layout.parkedCurrentAppRoot,
        "Parked previous application",
      );
    }
    return await verifiedTreeMatches(context.layout.parkedCurrentAppRoot, receipt.app) &&
      await verifiedTreeMatches(context.layout.parkedCurrentDataRoot, receipt.data);
  };
  return semanticEffect({
    name: "park_previous",
    pre,
    post,
    replay: activationReplay("park_previous", {
      receiptPath,
      selectedApp: context.layout.appRoot,
      selectedData: context.layout.dataRoot,
      parkedApp: context.layout.parkedCurrentAppRoot,
      parkedData: context.layout.parkedCurrentDataRoot,
      previousApp: previous.app,
      previousData: previous.data,
    }),
    async inspect() {
      const receipt = await tryReadReceipt(receiptPath, "Previous pair receipt");
      if (receipt !== null) return await validateReceipt(receipt) ? "post" : "neither";
      const unresolved = hasUnresolvedIntent(context, "park_previous");
      if (unresolved) return "pre";
      const [app, data, parkedApp, parkedData] = await Promise.all([
        inspectReleaseTreeIdentity(context.layout.appRoot),
        inspectReleaseTreeIdentity(context.layout.dataRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentAppRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentDataRoot),
      ]);
      if (parkedApp.exists || parkedData.exists) return "neither";
      if (firstInstall) return !app.exists && !data.exists ? "pre" : "neither";
      await inspectFrozenReleaseTreeSecurity(
        context.layout.appRoot,
        "Selected previous application",
      );
      return same(app, previous.app) && same(data, previous.data) ? "pre" : "neither";
    },
    async perform() {
      if (!firstInstall) {
        await renameFrozenReleaseTreeExclusive(
          context.layout.appRoot,
          context.layout.parkedCurrentAppRoot,
          "Previous application parking",
          { recovery: recovering },
        );
        await renameExclusive(
          context.layout.dataRoot,
          context.layout.parkedCurrentDataRoot,
          "Previous planner-data parking",
        );
        await ensurePrivateDirectory(context.layout.priorAgentConfigRoot);
        for (const [source, name] of [
          [context.layout.agentConfigPath, "config.toml"],
          [context.layout.agentInstructionsPath, "AGENTS.md"],
        ]) {
          const destination = join(context.layout.priorAgentConfigRoot, name);
          await renameExclusive(source, destination, `Previous Codex ${name} parking`);
        }
      }
      const [app, data] = await Promise.all([
        inspectReleaseTreeIdentity(context.layout.parkedCurrentAppRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentDataRoot),
      ]);
      if (!same(app, previous.app) || !same(data, previous.data)) {
        throw new PlannerReleaseInterventionError(
          "The parked previous app/data pair changed from its durable release identity.",
        );
      }
      const appRootSecurity = firstInstall
        ? absentAppSecurity
        : await inspectFrozenReleaseTreeSecurity(
            context.layout.parkedCurrentAppRoot,
            "Parked previous application",
          );
      const receipt = Object.freeze({
        schemaVersion: 1,
        activationId: context.activationId,
        firstInstall,
        inactiveCodex: firstInstall,
        externalAuthorityUntouched: firstInstall,
        app,
        data,
        appRootSecurity,
      });
      await writePrivateImmutableJson(receiptPath, receipt);
    },
  });
}

async function createCandidateAppEffect(context, dependencies) {
  const receiptPath = join(context.layout.transactionRoot, CANDIDATE_APP_RECEIPT);
  const frozenAppSecurity = frozenReleaseTreeSecurityIdentity();
  const pre = Object.freeze({
    activationId: context.activationId,
    state: "candidate_app_unselected",
    appRootSecurity: Object.freeze({ exists: false }),
  });
  const post = Object.freeze({
    activationId: context.activationId,
    state: "candidate_app_selected",
    appRootSecurity: frozenAppSecurity,
  });
  const validateReceipt = async (receipt) => {
    if (
      receipt?.schemaVersion !== 1 || receipt.activationId !== context.activationId ||
      !isRecord(receipt.app) || !isRecord(receipt.deployment) ||
      !same(receipt.appRootSecurity, frozenAppSecurity)
    ) return false;
    if (!await verifiedTreeMatches(context.layout.appRoot, receipt.app)) return false;
    await inspectFrozenReleaseTreeSecurity(
      context.layout.appRoot,
      "Selected candidate application",
    );
    const [configSha256, instructionSha256] = await Promise.all([
      sha256File(context.layout.agentConfigPath),
      sha256File(context.layout.agentInstructionsPath),
    ]);
    return receipt.deployment.configSha256 === configSha256 &&
      receipt.deployment.instructionSha256 === instructionSha256;
  };
  return semanticEffect({
    name: "select_candidate_app",
    pre,
    post,
    async inspect() {
      const receipt = await tryReadReceipt(receiptPath, "Candidate app receipt");
      if (receipt !== null) return await validateReceipt(receipt) ? "post" : "neither";
      const [app, configPresent, instructionsPresent] = await Promise.all([
        inspectReleaseTreeIdentity(context.layout.appRoot),
        pathExists(context.layout.agentConfigPath),
        pathExists(context.layout.agentInstructionsPath),
      ]);
      return !app.exists && !configPresent && !instructionsPresent ? "pre" : "neither";
    },
    async perform() {
      await removeReleaseOwnedTree(context.layout.appRoot);
      const build = await materializeCanonicalApp(
        context,
        context.layout.candidateSourceRoot,
        dependencies,
      );
      const deployment = await installDeploymentConfiguration(context);
      const app = await inspectReleaseTreeIdentity(context.layout.appRoot);
      const appRootSecurity = await inspectFrozenReleaseTreeSecurity(
        context.layout.appRoot,
        "Selected candidate application",
      );
      await writePrivateImmutableJson(receiptPath, Object.freeze({
        schemaVersion: 1,
        activationId: context.activationId,
        app,
        appRootSecurity,
        build,
        deployment,
      }));
    },
  });
}

async function createRenameDirectoryEffect(
  name,
  source,
  destination,
  recoveryIntent = null,
) {
  let contract;
  if (recoveryIntent === null) {
    const sourceIdentity = await inspectReleaseTreeIdentity(source);
    if (!sourceIdentity.exists) throw new PlannerReleaseError(`${name} source does not exist.`);
    contract = {
      pre: Object.freeze({ source: sourceIdentity, destination: { exists: false } }),
      post: Object.freeze({ source: { exists: false }, destination: sourceIdentity }),
      replay: activationReplay(name, { source, destination }),
    };
  } else {
    contract = effectContractFromIntent(recoveryIntent, null);
    if (
      contract.replay.kind !== "activation-port" ||
      contract.replay.operation !== name ||
      contract.replay.source !== source ||
      contract.replay.destination !== destination
    ) {
      throw new PlannerReleaseInterventionError(
        `${name} recovery intent changed its durable rename coordinates.`,
      );
    }
  }
  const { pre, post, replay } = contract;
  return Object.freeze({
    name,
    expected: Object.freeze({ pre, post }),
    replay,
    async inspect() {
      const identity = {
        source: await inspectReleaseTreeIdentity(source),
        destination: await inspectReleaseTreeIdentity(destination),
      };
      if (same(identity, pre)) return { classification: "pre", identity };
      if (same(identity, post)) return { classification: "post", identity };
      return { classification: "neither", identity };
    },
    async perform() {
      await rename(source, destination);
    },
  });
}

async function readInstalledProjection(context) {
  const receipt = await readPrivateJson(
    join(context.layout.transactionRoot, CANDIDATE_APP_RECEIPT),
    { label: "Candidate app receipt" },
  );
  const app = await inspectReleaseTreeIdentity(context.layout.appRoot);
  const appRootSecurity = await inspectFrozenReleaseTreeSecurity(
    context.layout.appRoot,
    "Canonical installed application",
  );
  if (
    !same(app, receipt.app) ||
    !same(appRootSecurity, receipt.appRootSecurity)
  ) {
    throw new PlannerReleaseError("The canonical installed application changed before its receipt.");
  }
  return Object.freeze({
    canonicalApp: app,
    canonicalAppRootSecurity: appRootSecurity,
    sourceSha256: context.stage.projection.candidateSource.sha256,
    lockSha256: context.stage.projection.locks.candidateSha256,
    dependencyGraphSha256: receipt.build.dependencyGraphSha256,
    configSha256: receipt.deployment.configSha256,
    instructionSha256: receipt.deployment.instructionSha256,
    node: context.stage.projection.preflight.node,
    npm: context.stage.projection.preflight.npm,
  });
}

async function dynamicCodexPreAuthReadback(context, dependencies) {
  if (typeof dependencies.readCodexPreAuth === "function") {
    return dependencies.readCodexPreAuth(context);
  }
  const [deploymentModule, launcherModule, compatibilityModule, probeModule] = await Promise.all([
    importCandidateModule(context.layout.appRoot, "server/runtime/codex-follow-up/deployment.ts"),
    importCandidateModule(context.layout.appRoot, "server/runtime/codex-follow-up/launcher.ts"),
    importCandidateModule(context.layout.appRoot, "server/runtime/codex-follow-up/compatibility.ts"),
    importCandidateModule(context.layout.appRoot, "server/runtime/codex-follow-up/capability-probe.ts"),
  ]);
  const environment = {
    ...(dependencies.environment ?? process.env),
    HOME: context.home,
    PLANNER_CODEX_HOME: context.layout.agentRoot,
    PLANNER_CODEX_CWD: context.layout.appRoot,
    PLANNER_DATA_DIR: context.layout.dataRoot,
  };
  const parsed = deploymentModule.parseCodexFollowUpConfig(environment, context.layout.dataRoot);
  if (!parsed.ok) throw new PlannerReleaseError(parsed.status.detail);
  const validated = await deploymentModule.validateCodexFollowUpDeployment(parsed.deployment);
  if (!validated.ok) throw new PlannerReleaseError(validated.detail);
  const childEnvironment = deploymentModule.buildCodexFollowUpChildEnvironment(
    validated.deployment,
    environment,
  );
  const identity = await launcherModule.captureCodexExecutableIdentity(
    validated.deployment.launcherPath,
    { cwd: context.layout.appRoot, env: childEnvironment },
  );
  const schema = await compatibilityModule.generateAndEvaluateCodexSchema(
    identity,
    validated.deployment,
    childEnvironment,
  );
  const authSchema = await (
    dependencies.loadAuthReadinessSchemaBundle ?? loadAndValidateCodexAuthReadinessSchemaBundle
  )(schema.directory);
  const capability = await probeModule.runDisposableCapabilityProbe(
    identity,
    validated.deployment,
    { sourceEnvironment: environment },
  );
  if (!capability) throw new PlannerReleaseError("Codex pre-auth capability proof was empty.");
  const deploymentReadback = await probeModule.readActualCodexDeployment(
    identity,
    validated.deployment,
    { sourceEnvironment: environment },
  );
  const oneHash = (hashes, prefix) => {
    const matches = Object.entries(hashes).filter(([key]) => key.startsWith(prefix));
    if (matches.length !== 1 || !SHA256.test(matches[0][1])) {
      throw new PlannerReleaseError(`Codex readback omitted ${prefix} provenance.`);
    }
    return matches[0][1];
  };
  const activationCoordinates = Object.freeze({
    canonicalPath: identity.canonicalPath,
    version: identity.version,
    sha256: identity.sha256,
    schemaFingerprint: schema.fingerprint,
    userConfigSha256: oneHash(deploymentReadback.configSourceHashes, "user:"),
    systemConfigSha256: oneHash(deploymentReadback.configSourceHashes, "system:"),
    systemConfigPathCount: deploymentReadback.systemConfigPaths.length,
    instructionSha256: oneHash(deploymentReadback.instructionSourceHashes, "dedicated:"),
    accountKind: deploymentReadback.accountKind,
  });
  const executionProvider = launcherModule.createCompatibleCodexExecution(
    identity,
    validated.deployment,
    childEnvironment,
    Object.freeze({
      userConfigSha256: activationCoordinates.userConfigSha256,
      instructionSha256: activationCoordinates.instructionSha256,
      systemConfigPaths: Object.freeze([...deploymentReadback.systemConfigPaths]),
    }),
  );
  return Object.freeze({
    executionProvider,
    activationCoordinates,
    deploymentReadback,
    rawSchemaBundleSha256: schema.rawBundleSha256,
    compatibilitySchemaFingerprint: schema.fingerprint,
    authSchemaFingerprint: authSchema.authSchemaFingerprint,
    authNotificationOptOutMethods: authSchema.notificationOptOutMethods,
  });
}

async function runProductionAuthReadiness(context, dependencies) {
  const preAuth = await dynamicCodexPreAuthReadback(context, dependencies);
  const projection = await (dependencies.runAuthReadiness ?? runCodexAuthReadiness)({
    executionProvider: preAuth.executionProvider,
    normalHome: context.home,
    codexHome: context.layout.agentRoot,
    appCwd: context.layout.appRoot,
    notificationOptOutMethods: preAuth.authNotificationOptOutMethods,
    releaseInputs: authReleaseInputsFromArtifacts(context.stage, context.installed),
    operatorSha256: context.operatorSha256,
    runtimeIdentity: authRuntimeIdentityFromActivationCoordinates(
      preAuth.activationCoordinates,
    ),
    deploymentReadback: preAuth.deploymentReadback,
  }, dependencies.authDependencies);
  return Object.freeze(assertProductionAuthReadinessProjection({
    ...projection,
    schemaBinding: Object.freeze({
      rawSchemaBundleSha256: preAuth.rawSchemaBundleSha256,
      compatibilitySchemaFingerprint: preAuth.compatibilitySchemaFingerprint,
      authSchemaFingerprint: preAuth.authSchemaFingerprint,
      notificationOptOutMethodCount: preAuth.authNotificationOptOutMethods.length,
      contractKind: "authenticatedReadback",
    }),
  }, { durable: true }));
}

async function runProductionReleaseCandidate(context, dependencies) {
  if (typeof dependencies.runReleaseCandidate === "function") {
    return dependencies.runReleaseCandidate(context);
  }
  const smoke = await importCandidateModule(
    context.layout.appRoot,
    "scripts/smoke-live-chat.mjs",
  );
  const releaseBinding = releaseCandidateBindingFromArtifacts(
    context.stage,
    context.installed,
    context.authLifecycle,
  );
  if (typeof smoke.runNativeCodexReleaseSmoke !== "function") {
    throw new PlannerReleaseError("The installed candidate omitted the native Codex release smoke.");
  }
  const artifact = await smoke.runNativeCodexReleaseSmoke([
    "--authorized",
    "--scenario",
    "all",
    "--output",
    context.layout.releaseCandidatePath,
  ], {
    ...(dependencies.environment ?? process.env),
    HOME: context.home,
    PLANNER_CODEX_HOME: context.layout.agentRoot,
    PLANNER_CODEX_CWD: context.layout.appRoot,
    PLANNER_DATA_DIR: context.layout.dataRoot,
    TMPDIR: context.layout.qaRoot,
  }, {
    releaseBinding,
    operatorSha256: context.operatorSha256,
    collectSourceManifest: async () => context.stage.projection.candidateSource,
  });
  return releaseCandidateProjectionFromArtifact(artifact);
}

async function runProductionInstalledQa(context, dependencies) {
  if (typeof dependencies.runInstalledQa === "function") {
    return dependencies.runInstalledQa(context);
  }
  await assertStageRuntimeIdentity(context, dependencies, "before installed QA");
  const qa = await import("./planner-installed-qa.mjs");
  return qa.runInstalledPlannerQa({
    canonicalAppRoot: context.layout.appRoot,
    candidateDataPath: join(context.layout.dataRoot, "planner.sqlite"),
    qaRoot: context.layout.qaRoot,
    expectedInstalledIdentity: context.installed.projection.canonicalApp,
    runtimeOwnershipLease: context.lease,
    runtimeOwnershipSocketPath: context.layout.runtimeOwnerSocketPath,
    forbiddenAssetRoots: [
      context.layout.transactionRoot,
      context.layout.candidateSourceRoot,
      context.layout.baselineSourceRoot,
    ],
    activationId: context.activationId,
    nodeExecutable: context.stage.projection.preflight.node.executable,
    releaseEvidenceBinding: Object.freeze({
      activationId: context.activationId,
      stageSha256: context.stage.sha256,
      installedSha256: context.installed.sha256,
      releaseCandidateSha256: context.releaseCandidate.sha256,
      releaseCandidateEvidenceSchemaVersion: NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
      nodeFloor: context.stage.projection.preflight.node,
    }),
    environment: dependencies.environment ?? process.env,
  }, dependencies.installedQaDependencies);
}

async function verifyProductionCodexActivation(context, dependencies) {
  if (typeof dependencies.verifyCodexActivation === "function") {
    const result = await dependencies.verifyCodexActivation(context);
    if (result?.matched !== true) {
      throw new PlannerReleaseError("The post-QA Codex activation verifier did not match.");
    }
    return result;
  }
  const verifier = await importCandidateModule(
    context.layout.appRoot,
    "scripts/verify-codex-activation.mjs",
  );
  const releaseBinding = releaseCandidateBindingFromArtifacts(
    context.stage,
    context.installed,
    context.authLifecycle,
  );
  const result = await verifier.verifyCodexActivation([
    "--artifact",
    context.layout.releaseCandidatePath,
  ], {
    ...(dependencies.environment ?? process.env),
    HOME: context.home,
    PLANNER_CODEX_HOME: context.layout.agentRoot,
    PLANNER_CODEX_CWD: context.layout.appRoot,
    PLANNER_DATA_DIR: context.layout.dataRoot,
    TMPDIR: context.layout.qaRoot,
  }, {
    releaseBinding,
    operatorSha256: context.operatorSha256,
    collectSourceManifest: async () => context.stage.projection.candidateSource,
  });
  if (result?.matched !== true) {
    throw new PlannerReleaseError("The post-QA Codex activation verifier did not match.");
  }
  return result;
}

function withOperatorProjection(projection, operatorSha256) {
  if (!isRecord(projection)) {
    throw new PlannerReleaseError("A release proof returned a non-object projection.");
  }
  if (
    Object.hasOwn(projection, "operatorSha256") &&
    projection.operatorSha256 !== operatorSha256
  ) {
    throw new PlannerReleaseError("A release proof changed its installed operator identity.");
  }
  return Object.freeze({ ...projection, operatorSha256 });
}

async function readOptionalReleaseArtifact(path, expected) {
  try {
    return await readReleaseArtifact(path, expected);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function createProofArtifactEffect({
  context,
  artifactType,
  effectName,
  predecessorSha256,
  performProof,
}) {
  const paths = {
    "auth-lifecycle": context.layout.authLifecyclePath,
    "release-candidate": context.layout.releaseCandidatePath,
    qa: context.layout.qaPath,
  };
  const path = paths[artifactType];
  const expectedArtifact = {
    artifactType,
    activationId: context.activationId,
    predecessorSha256,
    operatorSha256: context.operatorSha256,
  };
  const pre = Object.freeze({ artifactType, sha256: null });
  const post = Object.freeze({ artifactType, predecessorSha256 });
  return semanticEffect({
    name: effectName,
    pre,
    post,
    replay: activationReplay(effectName, {
      receiptPath: path,
      artifactType,
      predecessorSha256,
      operatorSha256: context.operatorSha256,
    }),
    async inspect() {
      try {
        const artifact = await readReleaseArtifact(path, expectedArtifact);
        return artifact.sha256 ? "post" : "neither";
      } catch (error) {
        if (error?.code === "ENOENT") return "pre";
        return "neither";
      }
    },
    async perform() {
      const result = await performProof();
      const existing = await readOptionalReleaseArtifact(path, expectedArtifact);
      if (existing !== null) return;
      const projection = result?.artifactType === artifactType
        ? result.projection
        : result;
      const boundProjection = withOperatorProjection(projection, context.operatorSha256);
      const artifact = artifactType === "auth-lifecycle"
        ? createAuthLifecycleReleaseArtifact({
            stageArtifact: context.stage,
            installedArtifact: context.installed,
            projection: boundProjection,
          })
        : artifactType === "release-candidate"
          ? createReleaseCandidateReleaseArtifact({
              stageArtifact: context.stage,
              installedArtifact: context.installed,
              authLifecycleArtifact: context.authLifecycle,
              projection: boundProjection,
            })
          : createReleaseArtifact({
              artifactType,
              activationId: context.activationId,
              predecessorSha256,
              projection: boundProjection,
            });
      await publishReleaseArtifact(path, artifact);
    },
  });
}

async function readProofArtifact(context, artifactType, predecessorSha256) {
  const path = artifactType === "installed"
    ? context.layout.installedPath
    : artifactType === "auth-lifecycle"
      ? context.layout.authLifecyclePath
      : context.layout.releaseCandidatePath;
  return readReleaseArtifact(path, {
    artifactType,
    activationId: context.activationId,
    predecessorSha256,
    ...(artifactType === "installed" ? {} : { operatorSha256: context.operatorSha256 }),
  });
}

function previousProjectionFromCurrent(current, activation, app, data, firstInstall) {
  return Object.freeze({
    firstInstall,
    current: current === null ? null : {
      activationId: current.activationId,
      operatorSha256: current.operatorSha256,
      activationSha256: current.activationSha256,
    },
    activationSha256: activation?.sha256 ?? null,
    app,
    data,
    inactiveCodex: firstInstall,
  });
}

async function readPreviousProjection(context) {
  await requirePreparedPlannerData(context.drain);
  const current = await tryReadCurrent(context.layout);
  if (current === null) {
    const absent = { exists: false };
    const [app, data, agent] = await Promise.all([
      inspectReleaseTreeIdentity(context.layout.appRoot),
      inspectReleaseTreeIdentity(context.layout.dataRoot),
      inspectReleaseTreeIdentity(context.layout.agentRoot),
    ]);
    if (app.exists || data.exists || agent.exists) {
      throw new PlannerReleaseInterventionError(
        "First install found an unbound canonical app, data, or agent root.",
      );
    }
    return previousProjectionFromCurrent(null, null, absent, absent, true);
  }
  const previousLayout = {
    ...context.layout,
    activationPath: join(
      context.layout.releasesRoot,
      current.activationId,
      "activation.json",
    ),
  };
  const activation = await readReleaseArtifact(previousLayout.activationPath, {
    artifactType: "activation",
    activationId: current.activationId,
    operatorSha256: current.operatorSha256,
  });
  if (activation.sha256 !== current.activationSha256) {
    throw new PlannerReleaseInterventionError("The selected previous activation pointer drifted.");
  }
  const [app, data] = await Promise.all([
    inspectReleaseTreeIdentity(context.layout.appRoot),
    inspectReleaseTreeIdentity(context.layout.dataRoot),
  ]);
  const selectedDatabasePath = join(context.layout.dataRoot, "planner.sqlite");
  if (
    !same(app, activation.projection.app) ||
    context.stage.projection.dataSource.canonicalPath !== selectedDatabasePath ||
    !data.exists
  ) {
    throw new PlannerReleaseInterventionError("The selected previous app/data pair drifted.");
  }
  return previousProjectionFromCurrent(current, activation, app, data, false);
}

async function createPrecommitRestoreAppEffect(context, options = {}) {
  const supersededApp = join(context.layout.transactionRoot, "superseded-app");
  const supersededAgent = join(context.layout.transactionRoot, SUPERSEDED_AGENT_DIRECTORY);
  const firstInstallMarker = join(
    context.layout.transactionRoot,
    "first-install-app-unselected.json",
  );
  const firstInstall = context.previous.projection.firstInstall === true;
  const recovering = context.recoveryIntent !== null && context.recoveryIntent !== undefined;
  const agentRestore = firstInstall
    ? await createAuthenticatedAgentRestoreCoordinator(context, {
        checkpoint: options.agentAdoptionCheckpoint,
      })
    : null;
  const frozenAppSecurity = frozenReleaseTreeSecurityIdentity();
  const absent = Object.freeze({ exists: false });
  let contract;
  if (recovering) {
    contract = effectContractFromIntent(context.recoveryIntent, null);
  } else {
    const candidateReceipt = await tryReadReceipt(
      join(context.layout.transactionRoot, CANDIDATE_APP_RECEIPT),
      "Candidate app receipt",
    );
    const [candidateApp, parkedPreviousApp] = await Promise.all([
      inspectReleaseTreeIdentity(context.layout.appRoot),
      inspectReleaseTreeIdentity(context.layout.parkedCurrentAppRoot),
    ]);
    const previousApp = firstInstall ? absent : context.previous.projection.app;
    if (
      (candidateReceipt !== null && !same(candidateReceipt.app, candidateApp)) ||
      !same(parkedPreviousApp, previousApp)
    ) {
      throw new PlannerReleaseInterventionError(
        "Pre-commit restoration could not bind the exact candidate/previous application pair.",
      );
    }
    const selectedAppRootSecurity = candidateApp.exists
      ? await inspectReleaseOwnedTreeSecurity(
          context.layout.appRoot,
          "Selected candidate application",
          new Set([FROZEN_RELEASE_DIRECTORY_MODE, PRIVATE_DIRECTORY_MODE]),
        )
      : absent;
    const parkedAppRootSecurity = previousApp.exists
      ? await inspectFrozenReleaseTreeSecurity(
          context.layout.parkedCurrentAppRoot,
          "Parked previous application",
        )
      : absent;
    contract = {
      pre: {
        state: "candidate_or_empty_app",
        firstInstall,
        selectedCandidateApp: candidateApp,
        parkedPreviousApp: previousApp,
        selectedAppRootSecurity,
        parkedAppRootSecurity,
        ...(agentRestore === null ? {} : { agentAdoption: agentRestore.pre }),
      },
      post: {
        state: "previous_app_restored",
        firstInstall,
        restoredPreviousApp: previousApp,
        retainedCandidateApp: candidateApp,
        restoredAppRootSecurity: parkedAppRootSecurity,
        retainedAppRootSecurity: candidateApp.exists ? frozenAppSecurity : absent,
        ...(agentRestore === null ? {} : { agentAdoption: agentRestore.post }),
      },
      replay: activationReplay("restore_previous_app", {
        parkedApp: context.layout.parkedCurrentAppRoot,
        selectedApp: context.layout.appRoot,
        supersededApp,
        firstInstallMarker,
        firstInstall,
        selectedCandidateApp: candidateApp,
        parkedPreviousApp: previousApp,
        ...(agentRestore === null ? {} : { agentAdoption: agentRestore.replay }),
      }),
    };
  }
  const candidateApp = contract.pre.selectedCandidateApp;
  const previousApp = contract.pre.parkedPreviousApp;
  if (
    !isRecord(candidateApp) || !isRecord(previousApp) ||
    !same(contract.post.restoredPreviousApp, previousApp) ||
    !same(contract.post.retainedCandidateApp, candidateApp)
  ) {
    throw new PlannerReleaseInterventionError(
      "The durable pre-commit app restoration intent changed its exact pair identities.",
    );
  }
  if (
    agentRestore !== null &&
    (
      !same(contract.pre.agentAdoption, agentRestore.pre) ||
      !same(contract.post.agentAdoption, agentRestore.post) ||
      !same(contract.replay.agentAdoption, agentRestore.replay)
    )
  ) {
    throw new PlannerReleaseInterventionError(
      "The durable pre-commit restoration intent changed agent-adoption lineage.",
    );
  }
  const candidateSourceModes = new Set([
    contract.pre.selectedAppRootSecurity?.rootMode ?? FROZEN_RELEASE_DIRECTORY_MODE,
    ...(recovering ? [PRIVATE_DIRECTORY_MODE] : []),
  ]);
  return semanticEffect({
    name: "restore_previous_app",
    ...contract,
    async inspect() {
      const [selected, parked, retained, markerExists, agentExists] = await Promise.all([
        inspectReleaseTreeIdentity(context.layout.appRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentAppRoot),
        inspectReleaseTreeIdentity(supersededApp),
        pathExists(firstInstallMarker),
        pathExists(context.layout.agentRoot),
      ]);
      const exactPre = same(selected, candidateApp) && same(parked, previousApp) &&
        same(retained, absent);
      const exactPost = same(selected, previousApp) && same(parked, absent) &&
        same(retained, candidateApp);
      const agentState = agentRestore === null ? null : await agentRestore.inspect();
      if (
        exactPost &&
        (!firstInstall || (markerExists && !agentExists && agentState === "post"))
      ) {
        await Promise.all([
          verifiedFrozenTreeMatches(
            context.layout.appRoot,
            previousApp,
            "Restored previous application",
          ),
          verifiedFrozenTreeMatches(
            supersededApp,
            candidateApp,
            "Retained candidate application",
          ),
        ]);
        return "post";
      }
      if (exactPre && (!firstInstall || agentState === "pre")) return "pre";
      const exactPartial = same(selected, absent) && same(parked, previousApp) &&
        same(retained, candidateApp);
      if (!recovering) return "neither";
      if (firstInstall) {
        return agentState === "post" && (exactPre || exactPartial) ? "pre" : "neither";
      }
      return exactPartial ? "pre" : "neither";
    },
    async perform() {
      if (firstInstall) await agentRestore.perform();
      await renameFrozenReleaseTreeExclusive(
        context.layout.appRoot,
        supersededApp,
        "Candidate application retention during compensation",
        { recovery: recovering, sourceRootModes: candidateSourceModes },
      );
      await renameFrozenReleaseTreeExclusive(
        context.layout.parkedCurrentAppRoot,
        context.layout.appRoot,
        "Previous application restoration during compensation",
        { recovery: recovering },
      );
      if (firstInstall) {
        if (!await pathExists(firstInstallMarker)) {
          await writePrivateImmutableJson(firstInstallMarker, {
            schemaVersion: 1,
            activationId: context.activationId,
            authenticatedAgentSourceRestored: true,
            candidateAgentDeploymentRetained: await pathExists(supersededAgent),
          });
        }
      } else {
        for (const [name, destination] of [
          ["config.toml", context.layout.agentConfigPath],
          ["AGENTS.md", context.layout.agentInstructionsPath],
        ]) {
          const source = join(context.layout.priorAgentConfigRoot, name);
          if (await pathExists(source)) await rename(source, destination);
        }
      }
    },
  });
}

function createPrecommitRestoreDataEffect(context) {
  const supersededData = join(
    context.layout.supersededDataRoot,
    `precommit-${context.activationId}`,
  );
  return semanticEffect({
    name: "restore_previous_data",
    pre: { state: "candidate_or_unselected_data" },
    post: { state: "previous_data_restored" },
    replay: activationReplay("restore_previous_data", {
      parkedData: context.layout.parkedCurrentDataRoot,
      selectedData: context.layout.dataRoot,
      candidateData: context.layout.candidateDataRoot,
      supersededData,
    }),
    async inspect() {
      if (context.previous.projection.firstInstall === true) {
        const [selected, prepared, retained] = await Promise.all([
          pathExists(context.layout.dataRoot),
          pathExists(context.layout.candidateDataRoot),
          pathExists(supersededData),
        ]);
        if ((selected || prepared) && !retained) return "pre";
        if (!selected && !prepared && retained) return "post";
        return "neither";
      }
      if (await pathExists(context.layout.parkedCurrentDataRoot)) return "pre";
      return await pathExists(context.layout.dataRoot) ? "post" : "neither";
    },
    async perform() {
      await ensurePrivateDirectory(context.layout.supersededDataRoot);
      const candidatePath = await pathExists(context.layout.dataRoot)
        ? context.layout.dataRoot
        : context.layout.candidateDataRoot;
      await renameExclusive(
        candidatePath,
        supersededData,
        "Candidate planner-data retention during compensation",
      );
      await renameExclusive(
        context.layout.parkedCurrentDataRoot,
        context.layout.dataRoot,
        "Previous planner-data restoration during compensation",
      );
    },
  });
}

export async function createProductionActivationPort(baseContext, dependencies = {}) {
  const context = {
    ...baseContext,
    drain: baseContext.drain,
  };
  if (!context.drain?.storeModule || typeof context.drain.prepare !== "function") {
    throw new PlannerReleaseError("Activation composition requires the held planner-data drain.");
  }
  let previousProjection = null;
  return Object.freeze({
    async createPrepareDataEffect(effectContext) {
      return createPrepareDataEffect(effectContext);
    },
    async previousActivationProjection() {
      previousProjection ??= await readPreviousProjection(context);
      return previousProjection;
    },
    async createParkPreviousEffect(effectContext) {
      previousProjection ??= effectContext.previous?.projection ?? await readPreviousProjection(context);
      return createPreviousPairEffect(effectContext, previousProjection);
    },
    async createSelectAppEffect(effectContext) {
      return createCandidateAppEffect(effectContext, dependencies);
    },
    async createAdoptAgentEffect(effectContext) {
      return createAuthenticatedAgentAdoptionEffect(effectContext, {
        checkpoint: dependencies.agentAdoptionCheckpoint,
      });
    },
    async installedProjection(effectContext) {
      return readInstalledProjection(effectContext);
    },
    async createSelectDataEffect(effectContext) {
      return createRenameDirectoryEffect(
        "select_candidate_data",
        effectContext.layout.candidateDataRoot,
        effectContext.layout.dataRoot,
        effectContext.recoveryIntent,
      );
    },
    async createAuthLifecycleEffect(effectContext) {
      const installed = effectContext.installed ?? await readProofArtifact(
        effectContext,
        "installed",
        effectContext.stage.sha256,
      );
      return createProofArtifactEffect({
        context: { ...effectContext, installed },
        artifactType: "auth-lifecycle",
        effectName: "produce_auth_lifecycle",
        predecessorSha256: installed.sha256,
        performProof: () => runProductionAuthReadiness(
          { ...effectContext, installed },
          dependencies,
        ),
      });
    },
    async createReleaseCandidateEffect(effectContext) {
      const installed = effectContext.installed ?? await readProofArtifact(
        effectContext,
        "installed",
        effectContext.stage.sha256,
      );
      const authLifecycle = effectContext.authLifecycle ?? await readProofArtifact(
        effectContext,
        "auth-lifecycle",
        installed.sha256,
      );
      return createProofArtifactEffect({
        context: { ...effectContext, installed, authLifecycle },
        artifactType: "release-candidate",
        effectName: "produce_release_candidate",
        predecessorSha256: authLifecycle.sha256,
        performProof: () => runProductionReleaseCandidate(
          { ...effectContext, installed, authLifecycle },
          dependencies,
        ),
      });
    },
    async createQaEffect(effectContext) {
      const installed = effectContext.installed ?? await readProofArtifact(
        effectContext,
        "installed",
        effectContext.stage.sha256,
      );
      const authLifecycle = effectContext.authLifecycle ?? await readProofArtifact(
        effectContext,
        "auth-lifecycle",
        installed.sha256,
      );
      const releaseCandidate = effectContext.releaseCandidate ?? await readProofArtifact(
        effectContext,
        "release-candidate",
        authLifecycle.sha256,
      );
      return createProofArtifactEffect({
        context: { ...effectContext, installed, authLifecycle, releaseCandidate },
        artifactType: "qa",
        effectName: "produce_qa",
        predecessorSha256: releaseCandidate.sha256,
        performProof: () => runProductionInstalledQa(
          { ...effectContext, installed, authLifecycle, releaseCandidate },
          dependencies,
        ),
      });
    },
    async activationProjection(effectContext) {
      const installed = await readInstalledProjection(effectContext);
      const [app, selectedData, agent] = await Promise.all([
        inspectReleaseTreeIdentity(effectContext.layout.appRoot),
        context.drain.storeModule.inspectVerifiedPlannerSnapshot(
          join(effectContext.layout.dataRoot, "planner.sqlite"),
        ),
        inspectDedicatedAgentReadiness(effectContext.layout, installed),
      ]);
      if (!same(app, installed.canonicalApp)) {
        throw new PlannerReleaseError("The installed application changed before activation.");
      }
      const activationSnapshot = await freshSelectedDataSnapshot(
        effectContext,
        context.drain.storeModule,
        "activation-store-snapshot",
      );
      if (
        activationSnapshot.schemaVersion !== selectedData.schemaVersion ||
        activationSnapshot.workspaceSchemaVersion !== selectedData.workspaceSchemaVersion ||
        activationSnapshot.plannerVersion !== selectedData.plannerVersion
      ) {
        throw new PlannerReleaseError(
          "The closed activation snapshot changed the selected planner identity.",
        );
      }
      const prepared = await requirePreparedPlannerData(context.drain);
      const releaseEvidence = effectContext.qa?.projection?.releaseEvidence;
      if (
        !isRecord(releaseEvidence) ||
        releaseEvidence.relativePath !== "installed-release/evidence/manifest.json" ||
        !SHA256.test(releaseEvidence.sha256)
      ) {
        throw new PlannerReleaseError("Activation requires candidate-bound QA evidence.");
      }
      const evidenceManifestPath = join(
        context.layout.qaRoot,
        ...releaseEvidence.relativePath.split("/"),
      );
      if (!pathInsideOrEqual(context.layout.qaRoot, evidenceManifestPath)) {
        throw new PlannerReleaseError("The QA evidence manifest escaped the release QA root.");
      }
      const evidenceRoot = dirname(evidenceManifestPath);
      await (dependencies.verifyQaEvidenceManifest ?? verifyQaEvidenceManifest)({
        evidenceRoot,
        manifestPath: evidenceManifestPath,
        activationId: context.activationId,
        releaseBinding: {
          activationId: context.activationId,
          stageSha256: context.stage.sha256,
          installedSha256: effectContext.installed.sha256,
          releaseCandidateSha256: effectContext.releaseCandidate.sha256,
          releaseCandidateEvidenceSchemaVersion: NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
          nodeFloor: context.stage.projection.preflight.node,
        },
        expectedSha256: releaseEvidence.sha256,
      });
      await assertStageRuntimeIdentity(
        context,
        dependencies,
        "during installed QA and activation verification",
      );
      await verifyProductionCodexActivation(effectContext, dependencies);
      return Object.freeze({
        app,
        agent,
        selectedDataSha256: selectedData.sha256,
        activationSnapshotSha256: activationSnapshot.sha256,
        selectedDataSchemaVersion: selectedData.schemaVersion,
        selectedPlannerVersion: selectedData.plannerVersion,
        rollbackDataSha256: prepared.rollback.sha256,
        configSha256: installed.configSha256,
        instructionSha256: installed.instructionSha256,
        codexActivationVerifiedAfterQa: true,
        qaEvidenceVerifiedAfterQa: true,
      });
    },
    async createRestoreAppEffect(effectContext) {
      return createPrecommitRestoreAppEffect(effectContext, dependencies);
    },
    async createRestoreDataEffect(effectContext) {
      return createPrecommitRestoreDataEffect(effectContext);
    },
    async rollbackProjection(effectContext) {
      const prepared = await requirePreparedPlannerData(context.drain);
      return Object.freeze({
        precommitCompensation: true,
        firstInstall: effectContext.previous.projection.firstInstall === true,
        rollbackDataSha256: prepared.rollback.sha256,
        candidateDataSha256: prepared.candidate.sha256,
        newerDataRetained: true,
        restoredInactiveCodex: effectContext.previous.projection.firstInstall === true,
      });
    },
  });
}

async function freshSelectedDataSnapshot(context, storeModule, rootName = null) {
  const root = join(
    context.layout.transactionRoot,
    rootName ?? `rollback-guard-${randomUUID()}`,
  );
  if (rootName !== null) await removeReleaseOwnedTree(root);
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  const snapshotPath = join(root, "planner.sqlite");
  const reservation = storeModule.acquirePlannerStoreWriteReservation({
    filename: join(context.layout.dataRoot, "planner.sqlite"),
  });
  try {
    return reservation.createVerifiedSnapshot(snapshotPath);
  } finally {
    reservation.close();
  }
}

function effectContractFromIntent(intent, fallback) {
  if (intent === null || intent === undefined) return fallback;
  if (
    !isRecord(intent.expected) || !isRecord(intent.replay) ||
    !Object.hasOwn(intent.expected, "pre") || !Object.hasOwn(intent.expected, "post")
  ) {
    throw new PlannerReleaseInterventionError(
      "A rollback recovery intent omitted its durable effect contract.",
    );
  }
  return {
    pre: intent.expected.pre,
    post: intent.expected.post,
    replay: intent.replay,
  };
}

async function createRestorePairEffects(context, dependencies = {}, options = {}) {
  const storeModule = await (dependencies.loadPlannerStoreModule ?? loadPlannerStoreModule)(
    context.layout.appRoot,
  );
  const persistedGuard = options.guard ?? context.guard ?? null;
  const firstInstall = context.previous.projection.firstInstall === true;
  const recoveringMovedData = !firstInstall &&
    options.dataIntent !== null && options.dataIntent !== undefined;
  const fresh = recoveringMovedData
    ? { sha256: persistedGuard?.currentStoreSha256 }
    : await freshSelectedDataSnapshot(context, storeModule);
  const restoreStore = recoveringMovedData
    ? { sha256: persistedGuard?.restoreStoreSha256 }
    : firstInstall
      ? fresh
      : storeModule.inspectVerifiedPlannerSnapshot(
          join(context.layout.parkedCurrentDataRoot, "planner.sqlite"),
        );
  const calculatedAutomatic = firstInstall ||
    fresh.sha256 === context.activation.projection.activationSnapshotSha256;
  if (
    persistedGuard !== null && !recoveringMovedData &&
    (
      persistedGuard.currentStoreSha256 !== fresh.sha256 ||
      persistedGuard.restoreStoreSha256 !== restoreStore.sha256 ||
      persistedGuard.automatic !== calculatedAutomatic
    )
  ) {
    throw new PlannerReleaseError(
      "The selected whole-store identity changed after rollback authorization.",
    );
  }
  const automatic = persistedGuard?.automatic ?? (
    firstInstall ||
    fresh.sha256 === context.activation.projection.activationSnapshotSha256
  );
  const supersededData = join(context.layout.supersededDataRoot, fresh.sha256);
  const supersededApp = join(context.layout.transactionRoot, "superseded-app");
  const frozenAppSecurity = frozenReleaseTreeSecurityIdentity();
  const absentApp = Object.freeze({ exists: false });
  const selectedCandidateApp = context.activation.projection.app;
  if (firstInstall) {
    const deactivationMarker = join(
      context.layout.transactionRoot,
      "first-install-codex-deactivated.json",
    );
    const retainedDataMarker = join(
      context.layout.transactionRoot,
      "first-install-data-retained.json",
    );
    const retainedAgent = join(
      context.layout.transactionRoot,
      "superseded-agent-postcommit",
    );
    const appContract = effectContractFromIntent(options.appIntent, {
      pre: {
        state: "authenticated_candidate_active",
        selectedCandidateApp,
        selectedAppRootSecurity: frozenAppSecurity,
      },
      post: {
        state: "candidate_app_codex_inactive",
        retainedCandidateApp: selectedCandidateApp,
        retainedAppRootSecurity: frozenAppSecurity,
      },
      replay: activationReplay("restore_previous_app", {
        deactivationMarker,
        retainedAgent,
        selectedApp: context.layout.appRoot,
      }),
    });
    const restoreApp = semanticEffect({
      name: "restore_previous_app",
      ...appContract,
      async inspect() {
        if (await pathExists(deactivationMarker)) {
          const [appExists, agentExists, retainedAgentExists] = await Promise.all([
            pathExists(context.layout.appRoot),
            pathExists(context.layout.agentRoot),
            pathExists(retainedAgent),
          ]);
          if (appExists && !agentExists && retainedAgentExists) {
            if (!await verifiedFrozenTreeMatches(
              context.layout.appRoot,
              selectedCandidateApp,
              "Retained first-install candidate application",
            )) return "neither";
            return "post";
          }
          return "neither";
        }
        if (!await pathExists(context.layout.appRoot)) return "neither";
        if (!await verifiedFrozenTreeMatches(
          context.layout.appRoot,
          selectedCandidateApp,
          "Selected first-install candidate application",
        )) return "neither";
        return "pre";
      },
      async perform() {
        await renameExclusive(
          context.layout.agentRoot,
          retainedAgent,
          "Authenticated Codex-home retention during first-install rollback",
        );
        await writePrivateImmutableJson(deactivationMarker, {
          schemaVersion: 1,
          activationId: context.activationId,
          candidateAppRetained: true,
          authenticatedAgentRetained: true,
          embeddedCodexInactive: true,
        });
      },
    });
    const dataContract = effectContractFromIntent(options.dataIntent, {
      pre: { state: "candidate_data_active" },
      post: { state: "candidate_data_retained" },
      replay: activationReplay("restore_previous_data", {
        retainedDataMarker,
        selectedData: context.layout.dataRoot,
      }),
    });
    const restoreData = semanticEffect({
      name: "restore_previous_data",
      ...dataContract,
      async inspect() {
        if (await pathExists(retainedDataMarker)) {
          return await pathExists(context.layout.dataRoot) ? "post" : "neither";
        }
        return await pathExists(context.layout.dataRoot) ? "pre" : "neither";
      },
      async perform() {
        await writePrivateImmutableJson(retainedDataMarker, {
          schemaVersion: 1,
          activationId: context.activationId,
          candidateDataRetained: true,
          selectedDataSha256: fresh.sha256,
        });
      },
    });
    return Object.freeze({
      guard: Object.freeze({
        allowed: true,
        automatic,
        currentStoreSha256: fresh.sha256,
        restoreStoreSha256: fresh.sha256,
      }),
      restoreApp,
      restoreData,
      firstInstall: true,
    });
  }
  const appContract = effectContractFromIntent(options.appIntent, {
    pre: {
      state: "candidate_app_selected",
      selectedCandidateApp,
      parkedPreviousApp: context.previous.projection.app,
      selectedAppRootSecurity: frozenAppSecurity,
      parkedAppRootSecurity: frozenAppSecurity,
    },
    post: {
      state: "previous_app_restored",
      restoredPreviousApp: context.previous.projection.app,
      retainedCandidateApp: selectedCandidateApp,
      restoredAppRootSecurity: frozenAppSecurity,
      supersededAppRootSecurity: frozenAppSecurity,
    },
    replay: activationReplay("restore_previous_app", {
      selectedApp: context.layout.appRoot,
      parkedApp: context.layout.parkedCurrentAppRoot,
      supersededApp,
      selectedCandidateApp,
      parkedPreviousApp: context.previous.projection.app,
    }),
  });
  const boundCandidateApp = appContract.pre.selectedCandidateApp;
  const boundPreviousApp = appContract.pre.parkedPreviousApp;
  if (
    !isRecord(boundCandidateApp) || !isRecord(boundPreviousApp) ||
    !same(appContract.post.restoredPreviousApp, boundPreviousApp) ||
    !same(appContract.post.retainedCandidateApp, boundCandidateApp)
  ) {
    throw new PlannerReleaseInterventionError(
      "The durable rollback app restoration intent changed its exact pair identities.",
    );
  }
  const restoreApp = semanticEffect({
    name: "restore_previous_app",
    ...appContract,
    async inspect() {
      const [selected, parked, retained] = await Promise.all([
        inspectReleaseTreeIdentity(context.layout.appRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentAppRoot),
        inspectReleaseTreeIdentity(supersededApp),
      ]);
      const exactPre = same(selected, boundCandidateApp) &&
        same(parked, boundPreviousApp) && same(retained, absentApp);
      const exactPost = same(selected, boundPreviousApp) &&
        same(parked, absentApp) && same(retained, boundCandidateApp);
      if (exactPost) {
        const [restoredMatches, retainedMatches] = await Promise.all([
          verifiedFrozenTreeMatches(
            context.layout.appRoot,
            boundPreviousApp,
            "Restored previous application",
          ),
          verifiedFrozenTreeMatches(
            supersededApp,
            boundCandidateApp,
            "Retained superseded application",
          ),
        ]);
        return restoredMatches && retainedMatches ? "post" : "neither";
      }
      if (exactPre) return "pre";
      const exactPartial = same(selected, absentApp) &&
        same(parked, boundPreviousApp) && same(retained, boundCandidateApp);
      return options.appIntent !== null && options.appIntent !== undefined && exactPartial
        ? "pre"
        : "neither";
    },
    async perform() {
      await renameFrozenReleaseTreeExclusive(
        context.layout.appRoot,
        supersededApp,
        "Candidate application retention during rollback",
        { recovery: options.appIntent !== null && options.appIntent !== undefined },
      );
      await renameFrozenReleaseTreeExclusive(
        context.layout.parkedCurrentAppRoot,
        context.layout.appRoot,
        "Previous application restoration during rollback",
        { recovery: options.appIntent !== null && options.appIntent !== undefined },
      );
      for (const [name, destination] of [
        ["config.toml", context.layout.agentConfigPath],
        ["AGENTS.md", context.layout.agentInstructionsPath],
      ]) {
        const source = join(context.layout.priorAgentConfigRoot, name);
        if (await pathExists(source)) await rename(source, destination);
      }
    },
  });
  const absentData = Object.freeze({ exists: false });
  const initialDataIdentities = options.dataIntent === null || options.dataIntent === undefined
    ? await Promise.all([
        inspectReleaseTreeIdentity(context.layout.dataRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentDataRoot),
        inspectReleaseTreeIdentity(supersededData),
      ])
    : null;
  const dataContract = effectContractFromIntent(options.dataIntent, {
    pre: {
      state: "candidate_data_selected",
      selectedData: initialDataIdentities?.[0],
      parkedData: initialDataIdentities?.[1],
      supersededData: initialDataIdentities?.[2],
    },
    post: {
      state: "previous_data_restored",
      selectedData: initialDataIdentities?.[1],
      parkedData: absentData,
      supersededData: initialDataIdentities?.[0],
    },
    replay: activationReplay("restore_previous_data", {
      selectedData: context.layout.dataRoot,
      parkedData: context.layout.parkedCurrentDataRoot,
      supersededData,
      currentStoreSha256: fresh.sha256,
      restoreStoreSha256: restoreStore.sha256,
    }),
  });
  const boundSelectedData = dataContract.pre.selectedData;
  const boundParkedData = dataContract.pre.parkedData;
  if (
    !isRecord(boundSelectedData) || !isRecord(boundParkedData) ||
    !same(dataContract.pre.supersededData, absentData) ||
    !same(dataContract.post.selectedData, boundParkedData) ||
    !same(dataContract.post.parkedData, absentData) ||
    !same(dataContract.post.supersededData, boundSelectedData) ||
    dataContract.replay.currentStoreSha256 !== fresh.sha256 ||
    dataContract.replay.restoreStoreSha256 !== restoreStore.sha256
  ) {
    throw new PlannerReleaseInterventionError(
      "The durable rollback data restoration intent changed its exact store identities.",
    );
  }
  const restoreData = semanticEffect({
    name: "restore_previous_data",
    ...dataContract,
    async inspect() {
      const [selected, parked, retained] = await Promise.all([
        inspectReleaseTreeIdentity(context.layout.dataRoot),
        inspectReleaseTreeIdentity(context.layout.parkedCurrentDataRoot),
        inspectReleaseTreeIdentity(supersededData),
      ]);
      const exactPre = same(selected, boundSelectedData) &&
        same(parked, boundParkedData) && same(retained, absentData);
      const exactPost = same(selected, boundParkedData) &&
        same(parked, absentData) && same(retained, boundSelectedData);
      if (exactPost) return "post";
      if (exactPre) return "pre";
      const exactPartial = same(selected, absentData) &&
        same(parked, boundParkedData) && same(retained, boundSelectedData);
      return options.dataIntent !== null && options.dataIntent !== undefined && exactPartial
        ? "pre"
        : "neither";
    },
    async perform() {
      await ensurePrivateDirectory(context.layout.supersededDataRoot);
      await renameExclusive(
        context.layout.dataRoot,
        supersededData,
        "Candidate planner-data retention during rollback",
      );
      await renameExclusive(
        context.layout.parkedCurrentDataRoot,
        context.layout.dataRoot,
        "Previous planner-data restoration during rollback",
      );
    },
  });
  return Object.freeze({
    guard: Object.freeze({
      allowed: true,
      automatic,
      currentStoreSha256: fresh.sha256,
      restoreStoreSha256: restoreStore.sha256,
    }),
    restoreApp,
    restoreData,
  });
}

export async function createProductionRollbackPort(context, dependencies = {}) {
  let evaluatedGuard = null;
  return Object.freeze({
    async evaluateRollbackGuard() {
      if (evaluatedGuard !== null) return evaluatedGuard;
      evaluatedGuard = (await createRestorePairEffects(context, dependencies)).guard;
      return evaluatedGuard;
    },
    async createRestoreAppEffect(effectContext) {
      const effects = await createRestorePairEffects(
        effectContext,
        dependencies,
        {
          guard: effectContext.guard,
          appIntent: effectContext.recoveryIntent,
        },
      );
      return effects.restoreApp;
    },
    async createRestoreDataEffect(effectContext) {
      const effects = await createRestorePairEffects(
        effectContext,
        dependencies,
        {
          guard: effectContext.guard,
          dataIntent: effectContext.recoveryIntent,
        },
      );
      return effects.restoreData;
    },
    async rollbackProjection(effectContext) {
      const guard = effectContext.guard ?? evaluatedGuard;
      if (guard === null) {
        throw new PlannerReleaseError("Rollback projection omitted its persisted store guard.");
      }
      const firstInstall = context.previous.projection.firstInstall === true;
      return Object.freeze({
        automatic: guard.automatic,
        currentStoreSha256: guard.currentStoreSha256,
        restoreStoreSha256: guard.restoreStoreSha256,
        newerDataRetained: true,
        restoredInactiveCodex: firstInstall,
        firstInstallCandidatePairRetained: firstInstall,
      });
    },
  });
}

export async function acquirePlannerReleaseOwnership({ layout }) {
  return acquireRuntimeOwnershipLease({ socketPath: layout.runtimeOwnerSocketPath });
}

export function createPlannerReleaseCompositionDependencies({
  environment = process.env,
  candidateSource = null,
  overrides = {},
} = {}) {
  const home = environment.HOME ?? homedir();
  return Object.freeze({
    home,
    environment,
    inspectDataSource: (filename, stagedCandidateSource = candidateSource) => {
      if (typeof stagedCandidateSource !== "string") {
        throw new PlannerReleaseError(
          "Planner data inspection requires the staged candidate source.",
        );
      }
      return inspectPlannerReleaseDataSource(stagedCandidateSource, filename);
    },
    inspectAgentSource: ({ sourcePath, layout }) =>
      inspectPlannerReleaseAgentSource({ sourcePath, layout }),
    acquireOwnerLease: acquirePlannerReleaseOwnership,
    drainLegacy: (context) => drainLegacyPlannerRuntime(context, {
      environment,
      ...overrides,
    }),
    createActivationPort: (context) => createProductionActivationPort(context, {
      environment,
      ...overrides,
    }),
    createRollbackPort: (context) => createProductionRollbackPort(context, {
      environment,
      ...overrides,
    }),
    ...overrides.releaseDependencies,
  });
}
