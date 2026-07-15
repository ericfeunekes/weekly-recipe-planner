import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  readdir,
  rename,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  PlannerReleaseError,
  PlannerReleaseInputError,
  PlannerReleaseInterventionError,
  RELEASE_JOURNAL_BYTES_LIMIT,
  assertReleaseJournalEnvelope,
  canonicalReleaseJson,
  isActivationId,
  readPrivateJson,
  writePrivateImmutableJson,
} from "./planner-release-contract.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ADOPTABLE_AGENT_DIRECTORIES = new Set([
  "superseded-agent",
  "superseded-agent-postcommit",
]);
const DEPLOYMENT_FILES = Object.freeze([
  Object.freeze({ name: "config.toml", parkedName: "adopted-agent-config.toml" }),
  Object.freeze({ name: "AGENTS.md", parkedName: "adopted-agent-AGENTS.md" }),
]);
const UNMATERIALIZED_AGENT_MARKER = "agent-candidate-unmaterialized.json";
const SHA256 = /^[a-f0-9]{64}$/u;

function same(left, right) {
  return canonicalReleaseJson(left) === canonicalReleaseJson(right);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validMetadata(value, { file = false, content = false } = {}) {
  const keys = ["device", "inode", "ownerUid", "mode", "linkCount"];
  if (content) keys.unshift("exists");
  if (content) keys.push("size", "sha256");
  return exactKeys(value, keys) &&
    (!content || value.exists === true) &&
    /^\d+$/u.test(value.device) && /^\d+$/u.test(value.inode) &&
    Number.isSafeInteger(value.ownerUid) && value.ownerUid >= 0 &&
    value.mode === (file ? PRIVATE_FILE_MODE : PRIVATE_DIRECTORY_MODE) &&
    Number.isSafeInteger(value.linkCount) && value.linkCount >= 1 &&
    (!file || value.linkCount === 1) &&
    (!content || (
      Number.isSafeInteger(value.size) && value.size >= 0 && SHA256.test(value.sha256)
    ));
}

function validSourceDeployment(value) {
  if (!exactKeys(value, ["files"]) || !exactKeys(value.files, DEPLOYMENT_FILES.map(
    (entry) => entry.name,
  ))) return false;
  return DEPLOYMENT_FILES.every((entry) => validMetadata(
    value.files[entry.name],
    { file: true, content: true },
  ));
}

export function assertPlannerReleaseAgentSourceProjection(value, layout) {
  const keys = [
    "sourcePath",
    "sourceActivationId",
    "sourceDirectoryName",
    "sourceJournalSha256",
    "root",
    "credentialFile",
    "sourceDeployment",
  ];
  if (
    !exactKeys(value, keys) ||
    !isActivationId(value.sourceActivationId) ||
    !ADOPTABLE_AGENT_DIRECTORIES.has(value.sourceDirectoryName) ||
    !SHA256.test(value.sourceJournalSha256) ||
    !validMetadata(value.root) ||
    !validMetadata(value.credentialFile, { file: true }) ||
    !validSourceDeployment(value.sourceDeployment) ||
    !isRecord(layout) ||
    value.sourceActivationId === layout.activationId ||
    value.sourcePath !== join(
      layout.releasesRoot,
      value.sourceActivationId,
      value.sourceDirectoryName,
    )
  ) {
    throw new PlannerReleaseInputError(
      "The authenticated agent-source projection has an invalid exact contract.",
    );
  }
  return value;
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new PlannerReleaseError("Agent-home adoption requires a POSIX current-user identity.");
  }
  return process.getuid();
}

function metadataProjection(metadata) {
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    ownerUid: metadata.uid,
    mode: metadata.mode & 0o777,
    linkCount: metadata.nlink,
  });
}

async function inspectRootMetadata(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false });
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PlannerReleaseInterventionError(`${label} must be one real directory.`);
  }
  return Object.freeze({ exists: true, ...metadataProjection(metadata) });
}

async function inspectPrivateFile(path, label, { includeContentHash = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false });
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PlannerReleaseInterventionError(`${label} must be one real regular file.`);
  }
  const projection = {
    exists: true,
    ...metadataProjection(metadata),
  };
  if (includeContentHash) {
    projection.size = metadata.size;
    projection.sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return Object.freeze(projection);
}

async function inspectAgentIdentity(path, label) {
  const root = await inspectRootMetadata(path, label);
  if (!root.exists) return Object.freeze({ exists: false });
  const credentialFile = await inspectPrivateFile(
    join(path, "auth.json"),
    `${label} credential file`,
  );
  if (!credentialFile.exists) {
    throw new PlannerReleaseInterventionError(`${label} has no dedicated credential file.`);
  }
  return Object.freeze({ exists: true, root, credentialFile });
}

function assertPrivateAgentIdentity(identity, label) {
  const uid = currentUid();
  if (
    identity?.exists !== true ||
    identity.root?.ownerUid !== uid ||
    identity.root?.mode !== PRIVATE_DIRECTORY_MODE ||
    identity.credentialFile?.ownerUid !== uid ||
    identity.credentialFile?.mode !== PRIVATE_FILE_MODE ||
    identity.credentialFile?.linkCount !== 1
  ) {
    throw new PlannerReleaseInterventionError(
      `${label} must be current-user-owned mode-0700 with one mode-0600 non-linked credential file.`,
    );
  }
  return identity;
}

function safeAgentProjection(identity) {
  return Object.freeze({
    root: Object.freeze({
      device: identity.root.device,
      inode: identity.root.inode,
      ownerUid: identity.root.ownerUid,
      mode: identity.root.mode,
      linkCount: identity.root.linkCount,
    }),
    credentialFile: Object.freeze({
      device: identity.credentialFile.device,
      inode: identity.credentialFile.inode,
      ownerUid: identity.credentialFile.ownerUid,
      mode: identity.credentialFile.mode,
      linkCount: identity.credentialFile.linkCount,
    }),
  });
}

function pathInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

export async function inspectPlannerReleaseAgentSource({ sourcePath, layout }) {
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) {
    throw new PlannerReleaseInputError("The dedicated agent source must be an absolute path.");
  }
  const canonical = await realpath(sourcePath).catch((error) => {
    throw new PlannerReleaseInputError("The dedicated agent source is unavailable.", { cause: error });
  });
  if (canonical !== sourcePath || !pathInside(layout.releasesRoot, canonical)) {
    throw new PlannerReleaseInputError(
      "The dedicated agent source must be one real retained release directory.",
    );
  }
  const parts = relative(layout.releasesRoot, canonical).split(sep);
  if (
    parts.length !== 2 ||
    !isActivationId(parts[0]) ||
    parts[0] === layout.activationId ||
    !ADOPTABLE_AGENT_DIRECTORIES.has(parts[1])
  ) {
    throw new PlannerReleaseInputError(
      "The dedicated agent source must be releases/<terminal-id>/superseded-agent.",
    );
  }
  const journal = assertReleaseJournalEnvelope(await readPrivateJson(
    join(layout.releasesRoot, parts[0], "journal.json"),
    { label: "Retained agent release journal", byteLimit: RELEASE_JOURNAL_BYTES_LIMIT },
  ), { activationId: parts[0] });
  if (journal.state !== "rolled_back") {
    throw new PlannerReleaseInputError(
      "The dedicated agent source must belong to a rolled-back retained release.",
    );
  }
  const identity = assertPrivateAgentIdentity(
    await inspectAgentIdentity(canonical, "Dedicated agent source"),
    "Dedicated agent source",
  );
  const plannerRoot = await inspectRootMetadata(layout.root, "Planner deployment root");
  if (!plannerRoot.exists || plannerRoot.device !== identity.root.device) {
    throw new PlannerReleaseInputError(
      "The dedicated agent source must share the planner deployment filesystem.",
    );
  }
  const files = {};
  for (const entry of DEPLOYMENT_FILES) {
    files[entry.name] = await inspectDeploymentFile(
      join(canonical, entry.name),
      `Retained dedicated agent ${entry.name}`,
    );
    if (!files[entry.name].exists) {
      throw new PlannerReleaseInputError(
        `The retained dedicated agent home is missing ${entry.name}.`,
      );
    }
  }
  return Object.freeze(assertPlannerReleaseAgentSourceProjection({
    sourcePath: canonical,
    sourceActivationId: parts[0],
    sourceDirectoryName: parts[1],
    sourceJournalSha256: journal.sha256,
    ...safeAgentProjection(identity),
    sourceDeployment: Object.freeze({ files: Object.freeze(files) }),
  }, layout));
}

async function inspectDeploymentFile(path, label) {
  const projection = await inspectPrivateFile(path, label, { includeContentHash: true });
  if (!projection.exists) return projection;
  if (
    projection.ownerUid !== currentUid() ||
    projection.mode !== PRIVATE_FILE_MODE ||
    projection.linkCount !== 1
  ) {
    throw new PlannerReleaseInterventionError(
      `${label} must be one current-user-owned mode-0600 non-linked file.`,
    );
  }
  return projection;
}

async function inspectDeploymentRoot(path, label) {
  const root = await inspectRootMetadata(path, label);
  if (!root.exists) return Object.freeze({ exists: false });
  const names = (await readdir(path)).sort();
  const expected = DEPLOYMENT_FILES.map((entry) => entry.name).sort();
  if (!same(names, expected)) {
    throw new PlannerReleaseInterventionError(`${label} has an unexpected file set.`);
  }
  const files = {};
  for (const entry of DEPLOYMENT_FILES) {
    files[entry.name] = await inspectDeploymentFile(join(path, entry.name), `${label} ${entry.name}`);
  }
  return Object.freeze({ exists: true, root, files: Object.freeze(files) });
}

function expectedAgentIdentity(agentSource) {
  return Object.freeze({
    exists: true,
    root: Object.freeze({ exists: true, ...agentSource.root }),
    credentialFile: Object.freeze({ exists: true, ...agentSource.credentialFile }),
  });
}

function sameAgentLineage(observed, expected) {
  if (observed?.exists !== true || expected?.exists !== true) return false;
  const stableRoot = (value) => {
    const root = { ...value };
    delete root.linkCount;
    return root;
  };
  return same(stableRoot(observed.root), stableRoot(expected.root)) &&
    same(observed.credentialFile, expected.credentialFile);
}

async function fileLocationState({
  canonicalPath,
  candidatePath,
  parkedPath,
  original,
  candidate,
}) {
  const [canonical, staged, parked] = await Promise.all([
    inspectDeploymentFile(canonicalPath, `Canonical ${basename(canonicalPath)}`),
    inspectDeploymentFile(candidatePath, `Candidate ${basename(candidatePath)}`),
    inspectDeploymentFile(parkedPath, `Parked ${basename(canonicalPath)}`),
  ]);
  const absent = Object.freeze({ exists: false });
  if (same(canonical, original) && same(staged, candidate) && same(parked, absent)) return 0;
  if (same(canonical, absent) && same(staged, candidate) && same(parked, original)) return 1;
  if (same(canonical, candidate) && same(staged, absent) && same(parked, original)) return 2;
  return -1;
}

async function durableRename(source, destination) {
  await rename(source, destination);
  const parents = [...new Set([dirname(source), dirname(destination)])];
  for (const parent of parents) {
    const handle = await open(parent, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function checkpoint(callback, name) {
  if (typeof callback === "function") await callback(name);
}

function adoptionCoordinates(context) {
  return Object.freeze({
    sourcePath: context.stage.projection.agentSource.sourcePath,
    canonicalPath: context.layout.agentRoot,
    candidatePath: join(context.layout.transactionRoot, "candidate-agent-home"),
    parkedConfigPath: join(context.layout.transactionRoot, "adopted-agent-config.toml"),
    parkedInstructionsPath: join(context.layout.transactionRoot, "adopted-agent-AGENTS.md"),
    retainedCandidatePath: join(context.layout.transactionRoot, "superseded-agent"),
  });
}

function validateReplay(replay, coordinates, operation) {
  if (
    replay?.schemaVersion !== 1 ||
    replay.kind !== "activation-port" ||
    replay.operation !== operation ||
    Object.entries(coordinates).some(([key, value]) => replay[key] !== value)
  ) {
    throw new PlannerReleaseInterventionError(
      `The ${operation} replay coordinates changed from their durable intent.`,
    );
  }
}

function intentContract(intent) {
  if (
    intent?.expected?.pre === undefined ||
    intent?.expected?.post === undefined ||
    intent?.replay === undefined
  ) {
    throw new PlannerReleaseInterventionError("The agent-adoption intent is incomplete.");
  }
  return Object.freeze({
    pre: intent.expected.pre,
    post: intent.expected.post,
    replay: intent.replay,
  });
}

async function adoptionStage({ coordinates, contract }) {
  const absent = Object.freeze({ exists: false });
  const expectedSource = contract.pre.agentSource;
  const expectedCandidate = contract.pre.candidateDeployment;
  const [source, canonicalRoot, candidateRoot, retainedRoot] = await Promise.all([
    inspectAgentIdentity(coordinates.sourcePath, "Retained dedicated agent source"),
    inspectRootMetadata(coordinates.canonicalPath, "Canonical dedicated agent home"),
    inspectRootMetadata(coordinates.candidatePath, "Candidate agent deployment"),
    inspectRootMetadata(coordinates.retainedCandidatePath, "Retained candidate agent deployment"),
  ]);
  const parkedAbsent = await Promise.all([
    inspectDeploymentFile(coordinates.parkedConfigPath, "Parked adopted config"),
    inspectDeploymentFile(coordinates.parkedInstructionsPath, "Parked adopted instructions"),
  ]).then((values) => values.every((value) => same(value, absent)));

  if (same(source, expectedSource) && canonicalRoot.exists && !candidateRoot.exists &&
      !retainedRoot.exists && parkedAbsent) {
    const canonicalDeployment = await inspectDeploymentRoot(
      coordinates.canonicalPath,
      "Canonical candidate agent deployment",
    );
    if (same(canonicalDeployment, expectedCandidate)) return "initial";
  }
  if (same(source, expectedSource) && !canonicalRoot.exists && candidateRoot.exists &&
      !retainedRoot.exists && parkedAbsent) {
    const candidateDeployment = await inspectDeploymentRoot(
      coordinates.candidatePath,
      "Staged candidate agent deployment",
    );
    if (same(candidateDeployment, expectedCandidate)) return "candidate_parked";
  }
  if (!source.exists && canonicalRoot.exists && candidateRoot.exists && !retainedRoot.exists) {
    const canonicalAgent = await inspectAgentIdentity(
      coordinates.canonicalPath,
      "Adopted canonical agent home",
    );
    if (!sameAgentLineage(canonicalAgent, expectedSource)) return "neither";
    const stages = [];
    for (const entry of DEPLOYMENT_FILES) {
      stages.push(await fileLocationState({
        canonicalPath: join(coordinates.canonicalPath, entry.name),
        candidatePath: join(coordinates.candidatePath, entry.name),
        parkedPath: coordinates[entry.name === "config.toml"
          ? "parkedConfigPath"
          : "parkedInstructionsPath"],
        original: contract.pre.sourceDeployment.files[entry.name],
        candidate: expectedCandidate.files[entry.name],
      }));
    }
    const [config, instructions] = stages;
    const allowed = (
      (config === 0 && instructions === 0) ||
      (config === 1 && instructions === 0) ||
      (config === 2 && instructions === 0) ||
      (config === 2 && instructions === 1) ||
      (config === 2 && instructions === 2)
    );
    if (!allowed) return "neither";
    return config === 2 && instructions === 2 ? "adopted" : `files_${config}_${instructions}`;
  }
  return "neither";
}

export async function createAuthenticatedAgentAdoptionEffect(context, options = {}) {
  const coordinates = adoptionCoordinates(context);
  let contract;
  if (context.recoveryIntent) {
    contract = intentContract(context.recoveryIntent);
    validateReplay(contract.replay, coordinates, "adopt_authenticated_agent");
  } else {
    const stagedSource = assertPlannerReleaseAgentSourceProjection(
      context.stage?.projection?.agentSource,
      context.layout,
    );
    const observedSource = assertPrivateAgentIdentity(
      await inspectAgentIdentity(coordinates.sourcePath, "Retained dedicated agent source"),
      "Retained dedicated agent source",
    );
    const expectedSource = expectedAgentIdentity(stagedSource);
    if (!same(observedSource, expectedSource)) {
      throw new PlannerReleaseInterventionError(
        "The retained dedicated agent home changed after staging.",
      );
    }
    const candidateDeployment = await inspectDeploymentRoot(
      coordinates.canonicalPath,
      "Canonical candidate agent deployment",
    );
    const sourceFiles = {};
    for (const entry of DEPLOYMENT_FILES) {
      sourceFiles[entry.name] = await inspectDeploymentFile(
        join(coordinates.sourcePath, entry.name),
        `Retained dedicated agent ${entry.name}`,
      );
      if (!sourceFiles[entry.name].exists) {
        throw new PlannerReleaseInterventionError(
          `The retained dedicated agent home is missing ${entry.name}.`,
        );
      }
    }
    const sourceDeployment = Object.freeze({ files: Object.freeze(sourceFiles) });
    if (!same(sourceDeployment, stagedSource.sourceDeployment)) {
      throw new PlannerReleaseInterventionError(
        "The retained dedicated agent deployment changed after staging.",
      );
    }
    contract = Object.freeze({
      pre: Object.freeze({
        state: "retained_agent_unselected",
        agentSource: expectedSource,
        sourceDeployment: stagedSource.sourceDeployment,
        candidateDeployment,
      }),
      post: Object.freeze({
        state: "authenticated_agent_selected",
        agentSource: expectedSource,
        sourceDeployment: stagedSource.sourceDeployment,
        candidateDeployment,
      }),
      replay: Object.freeze({
        schemaVersion: 1,
        kind: "activation-port",
        operation: "adopt_authenticated_agent",
        ...coordinates,
      }),
    });
  }
  return Object.freeze({
    name: "adopt_authenticated_agent",
    expected: Object.freeze({ pre: contract.pre, post: contract.post }),
    replay: contract.replay,
    async inspect() {
      const stage = await adoptionStage({ coordinates, contract });
      if (stage === "adopted") return { classification: "post", identity: contract.post };
      if (stage !== "neither") return { classification: "pre", identity: contract.pre };
      return { classification: "neither", identity: { state: "neither" } };
    },
    async perform() {
      let stage = await adoptionStage({ coordinates, contract });
      if (stage === "initial") {
        await durableRename(coordinates.canonicalPath, coordinates.candidatePath);
        await checkpoint(options.checkpoint, "candidate_parked");
        stage = "candidate_parked";
      }
      if (stage === "candidate_parked") {
        await durableRename(coordinates.sourcePath, coordinates.canonicalPath);
        await checkpoint(options.checkpoint, "agent_selected");
      }
      for (const entry of DEPLOYMENT_FILES) {
        const parkedPath = coordinates[entry.name === "config.toml"
          ? "parkedConfigPath"
          : "parkedInstructionsPath"];
        const state = await fileLocationState({
          canonicalPath: join(coordinates.canonicalPath, entry.name),
          candidatePath: join(coordinates.candidatePath, entry.name),
          parkedPath,
          original: contract.pre.sourceDeployment.files[entry.name],
          candidate: contract.pre.candidateDeployment.files[entry.name],
        });
        if (state === 0) {
          await durableRename(join(coordinates.canonicalPath, entry.name), parkedPath);
          await checkpoint(options.checkpoint, `${entry.name}:original_parked`);
        }
        const nextState = await fileLocationState({
          canonicalPath: join(coordinates.canonicalPath, entry.name),
          candidatePath: join(coordinates.candidatePath, entry.name),
          parkedPath,
          original: contract.pre.sourceDeployment.files[entry.name],
          candidate: contract.pre.candidateDeployment.files[entry.name],
        });
        if (nextState === 1) {
          await durableRename(
            join(coordinates.candidatePath, entry.name),
            join(coordinates.canonicalPath, entry.name),
          );
          await checkpoint(options.checkpoint, `${entry.name}:candidate_selected`);
        } else if (nextState !== 2) {
          throw new PlannerReleaseInterventionError(
            `Agent-home adoption cannot resume the ${entry.name} swap.`,
          );
        }
      }
    },
  });
}

function findAdoptionIntent(journal) {
  const intents = journal.entries.filter(
    (entry) => entry.kind === "intent" && entry.effect === "adopt_authenticated_agent",
  );
  if (intents.length !== 1) return null;
  const resolutions = journal.entries.filter(
    (entry) => ["completed", "abandoned"].includes(entry.kind) &&
      entry.effectId === intents[0].effectId,
  );
  return resolutions.length === 1 ? intents[0] : null;
}

function candidateAppWasMaterialized(journal) {
  const intents = journal.entries.filter(
    (entry) => entry.kind === "intent" && entry.effect === "select_candidate_app",
  );
  if (intents.length > 1) {
    throw new PlannerReleaseInterventionError(
      "First-install compensation found multiple candidate-app selection intents.",
    );
  }
  if (intents.length === 0) return false;
  const intent = intents[0];
  const resolutions = journal.entries.filter(
    (entry) => ["completed", "abandoned"].includes(entry.kind) &&
      entry.effectId === intent.effectId,
  );
  if (resolutions.length !== 1) {
    throw new PlannerReleaseInterventionError(
      "First-install compensation found an unresolved candidate-app selection lineage.",
    );
  }
  const resolution = resolutions[0];
  if (resolution.kind === "completed" && same(resolution.observed, intent.expected?.post)) {
    return true;
  }
  if (resolution.kind === "abandoned" && same(resolution.observed, intent.expected?.pre)) {
    return false;
  }
  throw new PlannerReleaseInterventionError(
    "First-install compensation found an invalid candidate-app selection resolution.",
  );
}

async function inspectUnmaterializedAgentMarker(path, activationId) {
  const metadata = await inspectPrivateFile(path, "Unmaterialized candidate agent marker");
  if (!metadata.exists) return false;
  if (
    metadata.ownerUid !== currentUid() || metadata.mode !== PRIVATE_FILE_MODE ||
    metadata.linkCount !== 1
  ) {
    throw new PlannerReleaseInterventionError(
      "The unmaterialized candidate agent marker must be one current-user-owned mode-0600 file.",
    );
  }
  const value = await readPrivateJson(path, {
    label: "Unmaterialized candidate agent marker",
    byteLimit: RELEASE_JOURNAL_BYTES_LIMIT,
  });
  if (
    !exactKeys(value, ["schemaVersion", "activationId", "state"]) ||
    value.schemaVersion !== 1 || value.activationId !== activationId ||
    value.state !== "candidate_agent_unmaterialized"
  ) {
    throw new PlannerReleaseInterventionError(
      "The unmaterialized candidate agent marker changed identity.",
    );
  }
  return true;
}

function validateCompensationReplay(replay, coordinates, variant) {
  if (
    !exactKeys(replay, [
      "schemaVersion",
      "kind",
      "variant",
      ...Object.keys(coordinates),
    ]) ||
    replay.schemaVersion !== 1 ||
    replay.kind !== "agent-adoption-compensation" ||
    replay.variant !== variant ||
    Object.entries(coordinates).some(([key, value]) => replay[key] !== value)
  ) {
    throw new PlannerReleaseInterventionError(
      "The agent-adoption compensation replay coordinates changed.",
    );
  }
}

async function createUnstartedRestoreContract(context, coordinates) {
  const recoveryIntent = context.recoveryIntent ?? null;
  if (recoveryIntent !== null) {
    const pre = recoveryIntent.expected?.pre?.agentAdoption;
    const post = recoveryIntent.expected?.post?.agentAdoption;
    const replay = recoveryIntent.replay?.agentAdoption;
    const variant = replay?.variant;
    const replayCoordinates = variant === "unmaterialized_candidate"
      ? Object.freeze({
          ...coordinates,
          markerPath: join(context.layout.transactionRoot, UNMATERIALIZED_AGENT_MARKER),
        })
      : coordinates;
    if (!["unadopted_candidate", "unmaterialized_candidate"].includes(variant)) {
      throw new PlannerReleaseInterventionError(
        "The unstarted agent-adoption compensation variant changed.",
      );
    }
    validateCompensationReplay(replay, replayCoordinates, variant);
    const validStates = variant === "unmaterialized_candidate"
      ? pre?.state === "candidate_agent_unmaterialized" &&
        post?.state === "unmaterialized_agent_compensated" &&
        same(pre?.candidateDeployment, { exists: false })
      : pre?.state === "authenticated_agent_unselected" &&
        post?.state === "authenticated_agent_restored";
    if (
      !validStates || !same(pre.agentSource, post.agentSource) ||
      !same(pre.sourceDeployment, post.sourceDeployment) ||
      !same(pre.candidateDeployment, post.candidateDeployment)
    ) {
      throw new PlannerReleaseInterventionError(
        "The unstarted agent-adoption compensation contract changed.",
      );
    }
    return Object.freeze({
      contract: Object.freeze({ pre, post, replay }),
      pre,
      post,
      variant,
      coordinates: replayCoordinates,
    });
  }

  const stagedSource = assertPlannerReleaseAgentSourceProjection(
    context.stage?.projection?.agentSource,
    context.layout,
  );
  const expectedSource = expectedAgentIdentity(stagedSource);
  const observedSource = assertPrivateAgentIdentity(
    await inspectAgentIdentity(coordinates.sourcePath, "Retained dedicated agent source"),
    "Retained dedicated agent source",
  );
  if (!same(observedSource, expectedSource)) {
    throw new PlannerReleaseInterventionError(
      "The retained dedicated agent credential lineage changed before compensation.",
    );
  }
  const candidateDeployment = await inspectDeploymentRoot(
    coordinates.canonicalPath,
    "Canonical candidate agent deployment",
  );
  const materialized = candidateAppWasMaterialized(context.journal);
  if (candidateDeployment.exists !== materialized) {
    throw new PlannerReleaseInterventionError(
      "The candidate agent deployment does not match the durable candidate-app selection lineage.",
    );
  }
  if (!materialized) {
    const replayCoordinates = Object.freeze({
      ...coordinates,
      markerPath: join(context.layout.transactionRoot, UNMATERIALIZED_AGENT_MARKER),
    });
    const pre = Object.freeze({
      state: "candidate_agent_unmaterialized",
      agentSource: expectedSource,
      sourceDeployment: stagedSource.sourceDeployment,
      candidateDeployment,
    });
    const post = Object.freeze({
      ...pre,
      state: "unmaterialized_agent_compensated",
    });
    return Object.freeze({
      contract: Object.freeze({ pre, post }),
      pre,
      post,
      variant: "unmaterialized_candidate",
      coordinates: replayCoordinates,
    });
  }
  const pre = Object.freeze({
    state: "authenticated_agent_unselected",
    agentSource: expectedSource,
    sourceDeployment: stagedSource.sourceDeployment,
    candidateDeployment,
  });
  const post = Object.freeze({
    ...pre,
    state: "authenticated_agent_restored",
  });
  return Object.freeze({
    contract: Object.freeze({ pre, post }),
    pre,
    post,
    variant: "unadopted_candidate",
    coordinates,
  });
}

export async function createAuthenticatedAgentRestoreCoordinator(context, options = {}) {
  const adoptionIntents = context.journal.entries.filter(
    (entry) => entry.kind === "intent" && entry.effect === "adopt_authenticated_agent",
  );
  const adoptionIntent = findAdoptionIntent(context.journal);
  if (adoptionIntent === null && adoptionIntents.length !== 0) {
    throw new PlannerReleaseInterventionError(
      "First-install compensation found an ambiguous agent-adoption intent history.",
    );
  }
  const adoptionPaths = adoptionCoordinates(context);
  const unstarted = adoptionIntent === null
    ? await createUnstartedRestoreContract(context, adoptionPaths)
    : null;
  const coordinates = unstarted?.coordinates ?? adoptionPaths;
  const contract = adoptionIntent === null ? unstarted.contract : intentContract(adoptionIntent);
  if (adoptionIntent !== null) {
    validateReplay(contract.replay, coordinates, "adopt_authenticated_agent");
  }
  const absent = Object.freeze({ exists: false });
  const pre = unstarted?.pre ?? Object.freeze({
      state: "authenticated_agent_selected",
      agentSource: contract.pre.agentSource,
      sourceDeployment: contract.pre.sourceDeployment,
      candidateDeployment: contract.pre.candidateDeployment,
    });
  const post = unstarted?.post ?? Object.freeze({
      state: "authenticated_agent_restored",
      agentSource: contract.pre.agentSource,
      sourceDeployment: contract.pre.sourceDeployment,
      candidateDeployment: contract.pre.candidateDeployment,
    });

  async function reverseStage() {
    if (unstarted?.variant === "unmaterialized_candidate") {
      const [source, canonicalRoot, candidateRoot, retainedRoot, marker] = await Promise.all([
        inspectAgentIdentity(coordinates.sourcePath, "Retained dedicated agent source"),
        inspectRootMetadata(coordinates.canonicalPath, "Canonical dedicated agent home"),
        inspectRootMetadata(coordinates.candidatePath, "Candidate agent deployment"),
        inspectRootMetadata(
          coordinates.retainedCandidatePath,
          "Retained candidate agent deployment",
        ),
        inspectUnmaterializedAgentMarker(coordinates.markerPath, context.activationId),
      ]);
      const parkedAbsent = await Promise.all([
        inspectDeploymentFile(coordinates.parkedConfigPath, "Parked adopted config"),
        inspectDeploymentFile(coordinates.parkedInstructionsPath, "Parked adopted instructions"),
      ]).then((values) => values.every((value) => same(value, absent)));
      const sourceFiles = {};
      for (const entry of DEPLOYMENT_FILES) {
        sourceFiles[entry.name] = await inspectDeploymentFile(
          join(coordinates.sourcePath, entry.name),
          `Retained dedicated agent ${entry.name}`,
        );
      }
      const sourceDeployment = Object.freeze({ files: Object.freeze(sourceFiles) });
      if (
        !same(source, contract.pre.agentSource) ||
        !same(sourceDeployment, contract.pre.sourceDeployment) ||
        canonicalRoot.exists || candidateRoot.exists || retainedRoot.exists || !parkedAbsent
      ) return "neither:unmaterialized_candidate";
      return marker ? "restored" : "unmaterialized";
    }
    const forward = await adoptionStage({ coordinates, contract });
    if (forward === "adopted") return "initial";
    if (forward === "initial") return "unstarted";
    const [source, canonicalRoot, candidateRoot, retainedRoot] = await Promise.all([
      inspectAgentIdentity(coordinates.sourcePath, "Restored dedicated agent source"),
      inspectRootMetadata(coordinates.canonicalPath, "Canonical dedicated agent home"),
      inspectRootMetadata(coordinates.candidatePath, "Candidate agent deployment"),
      inspectRootMetadata(coordinates.retainedCandidatePath, "Retained candidate agent deployment"),
    ]);
    const expectedSource = contract.pre.agentSource;
    if (!source.exists && canonicalRoot.exists && candidateRoot.exists && !retainedRoot.exists) {
      const canonicalAgent = await inspectAgentIdentity(
        coordinates.canonicalPath,
        "Canonical adopted agent home",
      );
      if (!sameAgentLineage(canonicalAgent, expectedSource)) return "neither:canonical_agent";
      const stages = [];
      for (const entry of DEPLOYMENT_FILES) {
        stages.push(await fileLocationState({
          canonicalPath: join(coordinates.canonicalPath, entry.name),
          candidatePath: join(coordinates.candidatePath, entry.name),
          parkedPath: coordinates[entry.name === "config.toml"
            ? "parkedConfigPath"
            : "parkedInstructionsPath"],
          original: contract.pre.sourceDeployment.files[entry.name],
          candidate: contract.pre.candidateDeployment.files[entry.name],
        }));
      }
      const [config, instructions] = stages;
      const allowed = (
        (config === 2 && instructions === 2) ||
        (config === 2 && instructions === 1) ||
        (config === 2 && instructions === 0) ||
        (config === 1 && instructions === 0) ||
        (config === 0 && instructions === 0)
      );
      return allowed ? `files_${config}_${instructions}` : `neither:files_${config}_${instructions}`;
    }
    if (sameAgentLineage(source, expectedSource) && !canonicalRoot.exists && candidateRoot.exists &&
        !retainedRoot.exists) {
      const candidate = await inspectDeploymentRoot(
        coordinates.candidatePath,
        "Restored candidate agent deployment",
      );
      return same(candidate, contract.pre.candidateDeployment)
        ? "source_restored"
        : "neither:source_candidate";
    }
    if (sameAgentLineage(source, expectedSource) && !canonicalRoot.exists && !candidateRoot.exists &&
        retainedRoot.exists) {
      const retained = await inspectDeploymentRoot(
        coordinates.retainedCandidatePath,
        "Retained candidate agent deployment",
      );
      const parked = await Promise.all([
        inspectDeploymentFile(coordinates.parkedConfigPath, "Parked adopted config"),
        inspectDeploymentFile(coordinates.parkedInstructionsPath, "Parked adopted instructions"),
      ]);
      return same(retained, contract.pre.candidateDeployment) &&
        parked.every((value) => same(value, absent))
        ? "restored"
        : "neither:retained_candidate";
    }
    return "neither:roots";
  }

  return Object.freeze({
    pre,
    post,
    replay: Object.freeze({
      schemaVersion: 1,
      kind: "agent-adoption-compensation",
      variant: adoptionIntent === null ? unstarted.variant : "adopted_agent",
      ...coordinates,
    }),
    async inspect() {
      const stage = await reverseStage();
      if (stage === "restored") return "post";
      return stage.startsWith("neither") ? "neither" : "pre";
    },
    async perform() {
      let stage = await reverseStage();
      if (stage === "unmaterialized") {
        await writePrivateImmutableJson(coordinates.markerPath, {
          schemaVersion: 1,
          activationId: context.activationId,
          state: "candidate_agent_unmaterialized",
        });
        await checkpoint(options.checkpoint, "candidate_unmaterialized_marked");
        stage = await reverseStage();
      }
      if (stage === "unstarted") {
        await durableRename(coordinates.canonicalPath, coordinates.retainedCandidatePath);
        await checkpoint(options.checkpoint, "candidate_retained_unstarted");
        stage = "restored";
      }
      if (stage === "initial" || stage.startsWith("files_")) {
        for (const entry of [...DEPLOYMENT_FILES].reverse()) {
          const parkedPath = coordinates[entry.name === "config.toml"
            ? "parkedConfigPath"
            : "parkedInstructionsPath"];
          let state = await fileLocationState({
            canonicalPath: join(coordinates.canonicalPath, entry.name),
            candidatePath: join(coordinates.candidatePath, entry.name),
            parkedPath,
            original: contract.pre.sourceDeployment.files[entry.name],
            candidate: contract.pre.candidateDeployment.files[entry.name],
          });
          if (state === 2) {
            await durableRename(
              join(coordinates.canonicalPath, entry.name),
              join(coordinates.candidatePath, entry.name),
            );
            await checkpoint(options.checkpoint, `${entry.name}:candidate_restored`);
            state = 1;
          }
          if (state === 1) {
            await durableRename(parkedPath, join(coordinates.canonicalPath, entry.name));
            await checkpoint(options.checkpoint, `${entry.name}:original_restored`);
          } else if (state !== 0) {
            throw new PlannerReleaseInterventionError(
              `Agent-home restoration cannot resume the ${entry.name} swap.`,
            );
          }
        }
        stage = await reverseStage();
      }
      if (stage === "files_0_0") {
        await durableRename(coordinates.canonicalPath, coordinates.sourcePath);
        await checkpoint(options.checkpoint, "source_restored");
        stage = "source_restored";
      }
      if (stage === "source_restored") {
        await durableRename(coordinates.candidatePath, coordinates.retainedCandidatePath);
        await checkpoint(options.checkpoint, "candidate_retained");
        stage = "restored";
      }
      if (stage !== "restored") {
        throw new PlannerReleaseInterventionError(
          `Agent-home restoration did not reach its exact retained state (${stage}).`,
        );
      }
    },
  });
}
