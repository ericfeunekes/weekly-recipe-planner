import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PlannerReleaseInterventionError,
  createReleasePointer,
  createReleaseArtifact,
  deriveInstalledOperatorPath,
  derivePlannerReleaseLayout,
  ensurePrivateDirectory,
  publishReleaseArtifact,
  publishReleasePointer,
  readReleasePointer,
} from "../../scripts/support/planner-release-contract.mjs";
import {
  RELEASE_OPERATOR_CORE_FILES,
  ReleaseFaultInjector,
  activateReleaseTransaction,
  appendReleaseJournalEntry,
  copyReleaseTree,
  createReleaseJournal,
  freezeReleaseTree,
  inspectReleaseTreeIdentity,
  inventoryReleaseTree,
  publishInitialReleaseJournal,
  readReleaseJournal,
  recoverReleaseTransaction,
  replaceReleaseJournal,
  rollbackReleaseTransaction,
  transitionReleaseJournal,
} from "../../scripts/support/planner-release-transaction.mjs";
import {
  createProductionAuthArtifact,
  createProductionReleaseCandidateArtifact,
} from "../support/release-evidence-fixtures.mjs";

const activationId = "44444444-4444-4444-8444-444444444444";
const previousActivationId = "55555555-5555-4555-8555-555555555555";
const supersededActivationId = "66666666-6666-4666-8666-666666666666";
const reconciledPredecessorActivationId = "77777777-7777-4777-8777-777777777777";

async function makeRemovable(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await makeRemovable(join(path, child));
  } else if (!metadata.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stagedAgentSource(layout) {
  const metadata = (mode, content = false) => ({
    device: "1",
    inode: content ? "3" : "2",
    ownerUid: process.getuid(),
    mode,
    linkCount: 1,
    ...(content ? { size: 1, sha256: "7".repeat(64) } : {}),
    ...(content ? { exists: true } : {}),
  });
  return {
    sourcePath: join(
      layout.releasesRoot,
      previousActivationId,
      "superseded-agent",
    ),
    sourceActivationId: previousActivationId,
    sourceDirectoryName: "superseded-agent",
    sourceJournalSha256: "6".repeat(64),
    root: metadata(0o700),
    credentialFile: metadata(0o600),
    sourceDeployment: {
      files: {
        "config.toml": metadata(0o600, true),
        "AGENTS.md": metadata(0o600, true),
      },
    },
  };
}

async function compositeEffect(name, prePaths, postPaths, perform, recoveryIntent = null) {
  const identity = async (paths) => Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [key, await inspectReleaseTreeIdentity(path)]),
  ));
  const expected = recoveryIntent?.expected ?? {
    pre: await identity(prePaths),
    post: await identity(postPaths),
  };
  // Callers describe post paths before the mutation. Replace those observed
  // identities with the exact identities the rename will preserve.
  for (const [postKey, sourceKey] of Object.entries(
    recoveryIntent === null ? perform.postIdentityFrom ?? {} : {},
  )) {
    expected.post[postKey] = expected.pre[sourceKey];
  }
  return {
    name,
    expected,
    replay: recoveryIntent?.replay ?? {
      schemaVersion: 1,
      kind: "activation-port",
      operation: name,
      paths: Object.keys(prePaths).sort(),
    },
    async inspect() {
      const observed = await identity(prePaths);
      if (same(observed, expected.pre)) return { classification: "pre", identity: observed };
      if (same(observed, expected.post)) return { classification: "post", identity: observed };
      return { classification: "neither", identity: observed };
    },
    perform,
  };
}

function proofArtifactEffect(name, operation, path, artifact, recoveryIntent = null) {
  const expected = recoveryIntent?.expected ?? {
    pre: { exists: false },
    post: {
      exists: true,
      artifactType: artifact.artifactType,
      sha256: artifact.sha256,
    },
  };
  return {
    name,
    expected,
    replay: recoveryIntent?.replay ?? {
      schemaVersion: 1,
      kind: "activation-port",
      operation,
      path,
      artifactType: artifact.artifactType,
      artifactSha256: artifact.sha256,
    },
    async inspect() {
      let existing = null;
      try {
        existing = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const identity = existing === null
        ? { exists: false }
        : {
            exists: true,
            artifactType: existing.artifactType,
            sha256: existing.sha256,
          };
      if (same(identity, expected.pre)) return { classification: "pre", identity };
      if (same(identity, expected.post)) return { classification: "post", identity };
      return { classification: "neither", identity };
    },
    perform: () => publishReleaseArtifact(path, artifact),
  };
}

function memoryEffect(state, name, recoveryIntent = null) {
  const expected = recoveryIntent?.expected ?? {
    pre: { complete: false },
    post: { complete: true },
  };
  return {
    name,
    expected,
    replay: recoveryIntent?.replay ?? {
      schemaVersion: 1,
      kind: "activation-port",
      operation: name,
      fixture: name,
    },
    async inspect() {
      const identity = { complete: state.complete };
      if (same(identity, expected.pre)) return { classification: "pre", identity };
      if (same(identity, expected.post)) return { classification: "post", identity };
      return { classification: "neither", identity };
    },
    async perform() {
      state.complete = true;
    },
  };
}

async function setupTransaction(t, options = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planner-local-release-")));
  t.after(async () => {
    await makeRemovable(home);
    await rm(home, { recursive: true, force: true });
  });
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [layout.root, layout.releasesRoot, layout.operatorRoot, layout.transactionRoot]) {
    await ensurePrivateDirectory(path);
  }
  await mkdir(layout.operatorSourceRoot, { mode: 0o700 });
  for (const relativePath of RELEASE_OPERATOR_CORE_FILES) {
    const path = join(layout.operatorSourceRoot, relativePath);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, `// ${relativePath}\n`);
  }
  const operatorSource = await inventoryReleaseTree(layout.operatorSourceRoot);
  await freezeReleaseTree(layout.operatorSourceRoot);
  const sourceDataPath = join(home, "source.sqlite");
  await writeFile(sourceDataPath, "replacement-data\n");
  const sourceMetadata = await lstat(sourceDataPath, { bigint: true });
  const dataSource = {
    canonicalPath: sourceDataPath,
    device: sourceMetadata.dev.toString(),
    inode: sourceMetadata.ino.toString(),
    size: sourceMetadata.size.toString(),
    initialized: options.initialized ?? true,
    sha256: "b".repeat(64),
    quickCheck: "ok",
    schemaVersion: 5,
    workspaceSchemaVersion: 5,
    plannerVersion: 16,
  };
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      operatorSource,
      dataSource,
      firstInstall: options.firstInstall === true,
      candidateSource: {
        files: 1,
        bytes: 1,
        sha256: "5".repeat(64),
      },
      agentSource: options.firstInstall === true
        ? stagedAgentSource(layout)
        : null,
    },
  });
  await publishReleaseArtifact(layout.stagePath, stage);
  await publishInitialReleaseJournal(layout.journalPath, createReleaseJournal(activationId));

  await Promise.all([
    mkdir(layout.appRoot, { mode: 0o700 }),
    mkdir(layout.dataRoot, { mode: 0o700 }),
    mkdir(layout.candidateDataRoot, { mode: 0o700 }),
  ]);
  const preparedApp = join(layout.transactionRoot, "prepared-candidate-app");
  await mkdir(preparedApp, { mode: 0o700 });
  await Promise.all([
    writeFile(join(layout.appRoot, "family.txt"), "previous-app\n"),
    writeFile(join(layout.dataRoot, "planner.sqlite"), "previous-data\n"),
    writeFile(join(preparedApp, "family.txt"), "candidate-app\n"),
    writeFile(join(layout.candidateDataRoot, "planner.sqlite"), "candidate-data\n"),
  ]);

  const parkPaths = {
    app: layout.appRoot,
    parkedApp: layout.parkedCurrentAppRoot,
    data: layout.dataRoot,
    parkedData: layout.parkedCurrentDataRoot,
  };
  const park = async () => {
    await rename(layout.appRoot, layout.parkedCurrentAppRoot);
    await rename(layout.dataRoot, layout.parkedCurrentDataRoot);
  };
  park.postIdentityFrom = { parkedApp: "app", parkedData: "data" };
  const parkEffect = await compositeEffect("park_previous", parkPaths, parkPaths, park);
  parkEffect.expected.post.app = { exists: false };
  parkEffect.expected.post.data = { exists: false };

  const selectAppPaths = { preparedApp, app: layout.appRoot };
  const selectApp = async () => rename(preparedApp, layout.appRoot);
  selectApp.postIdentityFrom = { app: "preparedApp" };
  const selectAppEffect = await compositeEffect(
    "select_candidate_app",
    selectAppPaths,
    selectAppPaths,
    selectApp,
  );
  selectAppEffect.expected.pre.app = { exists: false };
  selectAppEffect.expected.post.preparedApp = { exists: false };

  const selectDataPaths = { candidateData: layout.candidateDataRoot, data: layout.dataRoot };
  const selectData = async () => rename(layout.candidateDataRoot, layout.dataRoot);
  selectData.postIdentityFrom = { data: "candidateData" };
  const selectDataEffect = await compositeEffect(
    "select_candidate_data",
    selectDataPaths,
    selectDataPaths,
    selectData,
  );
  selectDataEffect.expected.pre.data = { exists: false };
  selectDataEffect.expected.post.candidateData = { exists: false };

  const previousCurrent = options.firstInstall === true
    ? null
    : {
        activationId: previousActivationId,
        operatorSha256: "9".repeat(64),
        activationSha256: "8".repeat(64),
      };
  const prepareState = { complete: false };
  const adoptAgentState = { complete: false };
  const compensatedApp = join(layout.transactionRoot, "compensated-candidate-app");
  const compensatedData = join(layout.transactionRoot, "compensated-candidate-data");
  const createRestoreEffect = async (kind, recoveryIntent = null) => {
    const app = kind === "app";
    const paths = app
      ? { selected: layout.appRoot, parked: layout.parkedCurrentAppRoot, retained: compensatedApp }
      : { selected: layout.dataRoot, parked: layout.parkedCurrentDataRoot, retained: compensatedData };
    const perform = async () => {
      if ((await inspectReleaseTreeIdentity(paths.selected)).exists) {
        await rename(paths.selected, paths.retained);
      }
      if ((await inspectReleaseTreeIdentity(paths.parked)).exists) {
        await rename(paths.parked, paths.selected);
      }
    };
    perform.postIdentityFrom = { retained: "selected", selected: "parked" };
    const name = app ? "restore_previous_app" : "restore_previous_data";
    const effect = await compositeEffect(name, paths, paths, perform, recoveryIntent);
    if (recoveryIntent === null) effect.expected.post.parked = { exists: false };
    return effect;
  };
  const createActivationPort = async () => ({
    createPrepareDataEffect: async (context) => memoryEffect(
      prepareState,
      "prepare_data",
      context.recoveryIntent ?? null,
    ),
    previousActivationProjection: async () => ({
      current: previousCurrent,
      appSha256: parkEffect.expected.pre.app.sha256,
      dataSha256: parkEffect.expected.pre.data.sha256,
    }),
    createParkPreviousEffect: async () => parkEffect,
    createSelectAppEffect: async () => selectAppEffect,
    installedProjection: async () => ({
      canonicalAppSha256: selectAppEffect.expected.post.app.sha256,
      sourceSha256: "1".repeat(64),
    }),
    createAdoptAgentEffect: async (context) => memoryEffect(
      adoptAgentState,
      "adopt_authenticated_agent",
      context.recoveryIntent ?? null,
    ),
    createSelectDataEffect: async () => selectDataEffect,
    createAuthLifecycleEffect: async (context) => {
      const artifact = createProductionAuthArtifact({
        stageArtifact: context.stage,
        installedArtifact: context.installed,
      });
      return proofArtifactEffect(
        "produce_auth_lifecycle",
        "produce_auth_lifecycle",
        layout.authLifecyclePath,
        artifact,
        context.recoveryIntent ?? null,
      );
    },
    createReleaseCandidateEffect: async (context) => {
      const artifact = createProductionReleaseCandidateArtifact({
        stageArtifact: context.stage,
        installedArtifact: context.installed,
        authLifecycleArtifact: context.authLifecycle,
      });
      return proofArtifactEffect(
        "produce_release_candidate",
        "produce_release_candidate",
        layout.releaseCandidatePath,
        artifact,
        context.recoveryIntent ?? null,
      );
    },
    createQaEffect: async (context) => {
      const artifact = createReleaseArtifact({
        artifactType: "qa",
        activationId,
        predecessorSha256: context.releaseCandidate.sha256,
        projection: {
          operatorSha256: operatorSource.sha256,
          installedUnchanged: true,
          productionStart: true,
        },
      });
      return proofArtifactEffect(
        "produce_qa",
        "produce_qa",
        layout.qaPath,
        artifact,
        context.recoveryIntent ?? null,
      );
    },
    activationProjection: async () => ({
      appSha256: selectAppEffect.expected.post.app.sha256,
      dataSha256: selectDataEffect.expected.post.data.sha256,
    }),
    createRestoreAppEffect: async (context) => createRestoreEffect(
      "app",
      context.recoveryIntent ?? null,
    ),
    createRestoreDataEffect: async (context) => createRestoreEffect(
      "data",
      context.recoveryIntent ?? null,
    ),
    rollbackProjection: async (context) => ({
      automatic: true,
      precommitCompensation: context.precommitCompensation === true,
    }),
  });
  return {
    home,
    layout,
    stage,
    operatorSha256: operatorSource.sha256,
    effects: { parkEffect, selectAppEffect, selectDataEffect, adoptAgentState },
    previousCurrent,
    createActivationPort,
  };
}

async function publishLegacyPreAdoptionPending(fixture, options = {}) {
  const layout = derivePlannerReleaseLayout(fixture.home, supersededActivationId);
  await ensurePrivateDirectory(layout.transactionRoot);
  const operatorSha256 = "a".repeat(64);
  const firstInstall = options.firstInstall ?? true;
  const dataSource = options.dataSource ?? (firstInstall
    ? { canonicalPath: "/tmp/source.sqlite", initialized: true }
    : options.noDataDrift === true
      ? fixture.stage.projection.dataSource
      : {
          ...fixture.stage.projection.dataSource,
          size: "1",
          sha256: "a".repeat(64),
        });
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId: supersededActivationId,
    projection: {
      operatorSource: { files: 1, bytes: 1, sha256: operatorSha256 },
      dataSource,
      firstInstall,
      agentSource: options.modernAgentSource === true
        ? stagedAgentSource(layout)
        : null,
    },
  });
  await publishReleaseArtifact(layout.stagePath, stage);
  let journal = createReleaseJournal(supersededActivationId);
  await publishInitialReleaseJournal(layout.journalPath, journal);
  let next;
  if (options.operatorInstalled === true) {
    const operatorIdentity = {
      exists: true,
      kind: "directory",
      ...stage.projection.operatorSource,
    };
    next = appendReleaseJournalEntry(journal, {
      at: "2026-07-13T12:00:00.000Z",
      kind: "intent",
      effectId: "2:install_operator",
      effect: "install_operator",
      expected: { pre: { exists: false }, post: operatorIdentity },
      replay: {
        schemaVersion: 1,
        kind: "operator-install",
        operatorSha256,
      },
    });
    await replaceReleaseJournal(layout.journalPath, journal, next);
    journal = next;
    next = appendReleaseJournalEntry(journal, {
      at: "2026-07-13T12:00:00.500Z",
      kind: "completed",
      effectId: "2:install_operator",
      effect: "install_operator",
      observed: operatorIdentity,
    });
    await replaceReleaseJournal(layout.journalPath, journal, next);
    journal = next;
  } else if (options.omitOperatorReuse !== true) {
    next = appendReleaseJournalEntry(journal, {
      at: "2026-07-13T12:00:00.000Z",
      kind: "checkpoint",
      name: "operator_reuse",
      projection: {
        operatorSha256,
        identity: {
          exists: true,
          kind: "directory",
          ...stage.projection.operatorSource,
        },
      },
    });
    await replaceReleaseJournal(layout.journalPath, journal, next);
    journal = next;
  }
  if (options.extraHistory === true) {
    next = appendReleaseJournalEntry(journal, {
      at: "2026-07-13T12:00:00.750Z",
      kind: "checkpoint",
      name: "unexpected_preselection_history",
      projection: { unexpected: true },
    });
    await replaceReleaseJournal(layout.journalPath, journal, next);
    journal = next;
  }
  const predecessor = createReleasePointer({
    pointerType: "pending",
    generation: 1,
    activationId: reconciledPredecessorActivationId,
    operatorSha256,
    updatedAt: "2026-07-13T11:59:59.000Z",
  });
  await publishReleasePointer(layout.pendingPath, predecessor, 0);
  const pending = createReleasePointer({
    pointerType: "pending",
    generation: 2,
    activationId: supersededActivationId,
    operatorSha256,
    updatedAt: "2026-07-13T12:00:01.000Z",
  });
  const effectId = `${journal.entries.length + 1}:publish_pending`;
  const intent = {
    at: "2026-07-13T12:00:02.000Z",
    kind: "intent",
    effectId,
    effect: "publish_pending",
    expected: {
      pre: predecessor,
      post: options.wrongExpectedPost === true ? predecessor : pending,
    },
    replay: {
      schemaVersion: 1,
      kind: "pointer-publication",
      path: layout.pendingPath,
      pointer: pending,
      expectedPre: options.wrongReplayExpectedPre === true
        ? { exists: false }
        : predecessor,
    },
  };
  const completion = {
    at: "2026-07-13T12:00:03.000Z",
    kind: "completed",
    effectId,
    effect: "publish_pending",
    observed: options.wrongCompletedObserved === true ? predecessor : pending,
  };
  const firstEntry = options.completionBeforeIntent === true ? completion : intent;
  const secondEntry = options.completionBeforeIntent === true ? intent : completion;
  next = appendReleaseJournalEntry(journal, firstEntry);
  await replaceReleaseJournal(layout.journalPath, journal, next);
  journal = next;
  await publishReleasePointer(layout.pendingPath, pending, predecessor.generation);
  next = appendReleaseJournalEntry(journal, secondEntry);
  await replaceReleaseJournal(layout.journalPath, journal, next);
  return Object.freeze({ layout, stage, journal: next, pending, predecessor });
}

function inspectFixtureDataSource(fixture) {
  const value = fixture.stage.projection.dataSource;
  return {
    initialized: value.initialized,
    sha256: value.sha256,
    quickCheck: value.quickCheck,
    schemaVersion: value.schemaVersion,
    workspaceSchemaVersion: value.workspaceSchemaVersion,
    plannerVersion: value.plannerVersion,
  };
}

test("pre-adoption first-install stages reject activation and recovery before handoff", async (t) => {
  const fixture = await setupTransaction(t, { firstInstall: true });
  await publishLegacyPreAdoptionPending(fixture);
  let handoffs = 0;
  let leaseAttempts = 0;
  const dependencies = {
    home: fixture.home,
    reexecuteInstalledOperator: async () => {
      handoffs += 1;
      return { exitCode: 0 };
    },
    acquireOwnerLease: async () => {
      leaseAttempts += 1;
      return { async close() {} };
    },
  };

  await assert.rejects(activateReleaseTransaction({
    transaction: supersededActivationId,
    authorized: true,
  }, dependencies), /pre-adoption stage/);
  await assert.rejects(recoverReleaseTransaction({
    transaction: supersededActivationId,
  }, dependencies), /pre-adoption stage/);
  assert.equal(handoffs, 0);
  assert.equal(leaseAttempts, 0);
});

test("an exact ineligible pending transaction is retired by its replacement activation", async (t) => {
  const fixture = await setupTransaction(t, { firstInstall: true });
  const superseded = await publishLegacyPreAdoptionPending(fixture);
  const result = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    inspectDataSource: async () => inspectFixtureDataSource(fixture),
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  });

  assert.equal(result.state, "committed");
  await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
  const retiredJournal = await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  );
  assert.equal(retiredJournal.state, "intervention_required");
  assert.deepEqual(retiredJournal.entries.at(-1), {
    sequence: retiredJournal.entries.length,
    at: retiredJournal.entries.at(-1).at,
    kind: "transition",
    event: "ambiguous",
    fromState: "staged",
    toState: "intervention_required",
    outcome: "intervention",
    reason: "ambiguous_effect_identity",
    replacementActivationId: activationId,
    replacementStageSha256: fixture.stage.sha256,
  });
  const replacementJournal = await readReleaseJournal(
    fixture.layout.journalPath,
    activationId,
  );
  const checkpoint = replacementJournal.entries.find(
    (entry) => entry.kind === "checkpoint" && entry.name === "pending_supersession",
  );
  assert.equal(checkpoint.projection.supersededPointer.sha256, superseded.pending.sha256);
  assert.equal(checkpoint.projection.replacementPointer.generation, 3);
  assert.equal(checkpoint.projection.replacementPointer.activationId, activationId);
  assert.equal(replacementJournal.entries.some((entry) =>
    entry.kind === "completed" && entry.effect === "retire_superseded_pending"), true);
  assert.equal(replacementJournal.entries.some((entry) =>
    entry.kind === "completed" && entry.effect === "replace_pending"), true);
});

test("an exact update pending transaction is retired by a matching update replacement", async (t) => {
  const fixture = await setupTransaction(t);
  const superseded = await publishLegacyPreAdoptionPending(fixture, {
    firstInstall: false,
  });
  const oldJournalBeforeHandoff = await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  );
  const pendingBeforeHandoff = await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  });
  let handoff = null;
  let leaseAttempts = 0;
  const delegated = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, {
    home: fixture.home,
    reexecuteInstalledOperator: async (request) => {
      handoff = request;
      return { exitCode: 0 };
    },
    acquireOwnerLease: async () => {
      leaseAttempts += 1;
      return { async close() {} };
    },
  });
  assert.equal(delegated.handedOff, true);
  assert.equal(handoff.command, "activate");
  assert.equal(handoff.supersedePending, supersededActivationId);
  assert.equal(leaseAttempts, 0);
  assert.equal((await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  )).sha256, oldJournalBeforeHandoff.sha256);
  assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  }), pendingBeforeHandoff);

  const result = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    inspectDataSource: async () => inspectFixtureDataSource(fixture),
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  });

  assert.equal(result.state, "committed");
  await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
  assert.equal((await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  )).state, "intervention_required");
  const replacementJournal = await readReleaseJournal(
    fixture.layout.journalPath,
    activationId,
  );
  const checkpoint = replacementJournal.entries.find(
    (entry) => entry.kind === "checkpoint" && entry.name === "pending_supersession",
  );
  assert.equal(checkpoint.projection.classification, "staged_source_drift");
  assert.deepEqual(
    checkpoint.projection.replacementDataSource,
    fixture.stage.projection.dataSource,
  );
  assert.equal(
    checkpoint.projection.supersededDataSource.sha256,
    "a".repeat(64),
  );
  assert.equal(replacementJournal.entries.some((entry) =>
    entry.kind === "completed" && entry.effect === "replace_pending"), true);
});

test("pending supersession rejects an installation-mode mismatch before old-state mutation", async (t) => {
  const fixture = await setupTransaction(t);
  const superseded = await publishLegacyPreAdoptionPending(fixture);
  const oldJournalBefore = await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  );
  const pendingBefore = await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  });

  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  }), /same installation mode/u);

  assert.equal((await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  )).sha256, oldJournalBefore.sha256);
  assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  }), pendingBefore);
});

test("update pending supersession recovers after replacing the pending pointer", async (t) => {
  const fixture = await setupTransaction(t);
  await publishLegacyPreAdoptionPending(fixture, { firstInstall: false });
  const faultInjector = new ReleaseFaultInjector("after_effect:replace_pending");
  const dependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    inspectDataSource: async () => inspectFixtureDataSource(fixture),
    faultInjector,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  };

  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, dependencies), /Injected release fault/);

  const recovered = await recoverReleaseTransaction({
    transaction: activationId,
  }, dependencies);
  assert.equal(recovered.state, "committed");
  assert.equal(faultInjector.fired, true);
  await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
  assert.equal((await readReleaseJournal(
    derivePlannerReleaseLayout(fixture.home, supersededActivationId).journalPath,
    supersededActivationId,
  )).state, "intervention_required");
});

test("source-drift supersession accepts a completed operator-install history", async (t) => {
  const fixture = await setupTransaction(t);
  await publishLegacyPreAdoptionPending(fixture, {
    firstInstall: false,
    operatorInstalled: true,
  });
  const result = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    inspectDataSource: async () => inspectFixtureDataSource(fixture),
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  });

  assert.equal(result.state, "committed");
  assert.equal((await readReleaseJournal(
    derivePlannerReleaseLayout(fixture.home, supersededActivationId).journalPath,
    supersededActivationId,
  )).state, "intervention_required");
});

test("source-drift supersession rejects an unchanged database identity", async (t) => {
  const fixture = await setupTransaction(t);
  const superseded = await publishLegacyPreAdoptionPending(fixture, {
    firstInstall: false,
    noDataDrift: true,
  });
  const oldJournalBefore = await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  );
  const pendingBefore = await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  });

  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    inspectDataSource: async () => inspectFixtureDataSource(fixture),
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  }), /changed staged database identity/u);

  assert.equal((await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  )).sha256, oldJournalBefore.sha256);
  assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  }), pendingBefore);
});

test("source-drift supersession rejects authority and live-identity mismatches without mutation", async (t) => {
  const fixture = await setupTransaction(t);
  const replacementDataSource = fixture.stage.projection.dataSource;
  const cases = [
    ["canonical path", { canonicalPath: `${replacementDataSource.canonicalPath}.other` }, null],
    ["device", { device: "999999" }, null],
    ["inode", { inode: "999999" }, null],
    ["live identity", {}, { sha256: "c".repeat(64) }],
  ];
  for (const [name, oldOverride, liveOverride] of cases) {
    await t.test(name, async (subtest) => {
      const isolated = await setupTransaction(subtest);
      const oldDataSource = {
        ...isolated.stage.projection.dataSource,
        size: "1",
        sha256: "a".repeat(64),
        ...oldOverride,
      };
      const superseded = await publishLegacyPreAdoptionPending(isolated, {
        firstInstall: false,
        dataSource: oldDataSource,
      });
      const oldJournalBefore = await readReleaseJournal(
        superseded.layout.journalPath,
        supersededActivationId,
      );
      const pendingBefore = await readReleasePointer(isolated.layout.pendingPath, {
        pointerType: "pending",
      });
      const liveProjection = {
        ...inspectFixtureDataSource(isolated),
        ...(liveOverride ?? {}),
      };

      await assert.rejects(activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
        supersedePending: supersededActivationId,
      }, {
        home: isolated.home,
        operatorExecutionSha256: isolated.operatorSha256,
        inspectDataSource: async () => liveProjection,
        acquireOwnerLease: async () => ({ async close() {} }),
        drainLegacy: async () => ({ async close() {} }),
        createActivationPort: isolated.createActivationPort,
      }), /same canonical database identity|stopped database no longer matches/u);

      assert.equal((await readReleaseJournal(
        superseded.layout.journalPath,
        supersededActivationId,
      )).sha256, oldJournalBefore.sha256);
      assert.deepEqual(await readReleasePointer(isolated.layout.pendingPath, {
        pointerType: "pending",
      }), pendingBefore);
    });
  }
});

test("source-drift recovery revalidates the reserved database before old-state mutation", async (t) => {
  const fixture = await setupTransaction(t);
  const superseded = await publishLegacyPreAdoptionPending(fixture, {
    firstInstall: false,
  });
  const oldJournalBefore = await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  );
  const pendingBefore = await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  });
  let liveProjection = inspectFixtureDataSource(fixture);
  let reservationHeld = false;
  const faultInjector = new ReleaseFaultInjector(
    "before_intent:retire_superseded_pending",
  );
  const dependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    inspectDataSource: async () => liveProjection,
    faultInjector,
    acquireOwnerLease: async () => ({ async close() {} }),
    drainLegacy: async () => {
      if (liveProjection.sha256 !== fixture.stage.projection.dataSource.sha256) {
        throw new Error("reserved source drift");
      }
      reservationHeld = true;
      return {
        async close() {
          reservationHeld = false;
        },
      };
    },
    createActivationPort: fixture.createActivationPort,
  };

  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    supersedePending: supersededActivationId,
  }, dependencies), /Injected release fault/);
  assert.equal(reservationHeld, false);
  const replacementAfterFault = await readReleaseJournal(
    fixture.layout.journalPath,
    activationId,
  );
  assert.equal(replacementAfterFault.entries.some((entry) =>
    entry.kind === "checkpoint" && entry.name === "pending_supersession"), true);
  assert.equal((await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  )).sha256, oldJournalBefore.sha256);
  assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  }), pendingBefore);

  liveProjection = { ...liveProjection, sha256: "c".repeat(64) };
  await assert.rejects(recoverReleaseTransaction({
    transaction: activationId,
  }, dependencies), /reserved source drift/);
  assert.equal((await readReleaseJournal(
    superseded.layout.journalPath,
    supersededActivationId,
  )).sha256, oldJournalBefore.sha256);
  assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
    pointerType: "pending",
  }), pendingBefore);
});

test("pending supersession rejects non-fresh replacement journals before old-state mutation", async (t) => {
  for (const scenario of ["intervention state", "unrelated staged history"]) {
    await t.test(scenario, async (subtest) => {
      const fixture = await setupTransaction(subtest, { firstInstall: true });
      const superseded = await publishLegacyPreAdoptionPending(fixture);
      let replacement = await readReleaseJournal(
        fixture.layout.journalPath,
        activationId,
      );
      if (scenario === "intervention state") {
        replacement = await transitionReleaseJournal(
          fixture.layout.journalPath,
          replacement,
          "ambiguous",
        );
      } else {
        const changed = appendReleaseJournalEntry(replacement, {
          at: "2026-07-13T12:00:04.000Z",
          kind: "checkpoint",
          name: "unrelated_fixture_history",
          projection: { fixture: true },
        });
        await replaceReleaseJournal(fixture.layout.journalPath, replacement, changed);
        replacement = changed;
      }
      const oldJournalBefore = await readReleaseJournal(
        superseded.layout.journalPath,
        supersededActivationId,
      );
      const pendingBefore = await readReleasePointer(fixture.layout.pendingPath, {
        pointerType: "pending",
      });
      let leaseAttempts = 0;

      await assert.rejects(activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
        supersedePending: supersededActivationId,
      }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        acquireOwnerLease: async () => {
          leaseAttempts += 1;
          return { async close() {} };
        },
        createActivationPort: fixture.createActivationPort,
      }), /newly staged initialized replacement/u);

      assert.equal(leaseAttempts, 0);
      assert.equal((await readReleaseJournal(
        superseded.layout.journalPath,
        supersededActivationId,
      )).sha256, oldJournalBefore.sha256);
      assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
        pointerType: "pending",
      }), pendingBefore);
      assert.equal((await readReleaseJournal(
        fixture.layout.journalPath,
        activationId,
      )).sha256, replacement.sha256);
    });
  }
});

test("pending supersession rejects malformed reconciled publish histories", async (t) => {
  const cases = [
    ["missing operator reuse", { omitOperatorReuse: true }],
    ["completion before intent", { completionBeforeIntent: true }],
    ["mismatched replay pre-state", { wrongReplayExpectedPre: true }],
    ["mismatched expected post-state", { wrongExpectedPost: true }],
    ["mismatched completed observation", { wrongCompletedObserved: true }],
    ["unexpected preselection history", { extraHistory: true }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await setupTransaction(subtest, { firstInstall: true });
      const superseded = await publishLegacyPreAdoptionPending(fixture, options);
      const oldJournalBefore = await readReleaseJournal(
        superseded.layout.journalPath,
        supersededActivationId,
      );
      const pendingBefore = await readReleasePointer(fixture.layout.pendingPath, {
        pointerType: "pending",
      });

      await assert.rejects(activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
        supersedePending: supersededActivationId,
      }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort: fixture.createActivationPort,
      }), /exact initialized staged pending transaction/u);

      assert.equal((await readReleaseJournal(
        superseded.layout.journalPath,
        supersededActivationId,
      )).sha256, oldJournalBefore.sha256);
      assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
        pointerType: "pending",
      }), pendingBefore);
    });
  }
});

test("pending supersession recovers on either side of its pointer CAS", async (t) => {
  for (const point of [
    "after_intent:retire_superseded_pending",
    "after_effect:retire_superseded_pending",
    "after_intent:replace_pending",
    "after_effect:replace_pending",
  ]) {
    await t.test(point, async (subtest) => {
      const fixture = await setupTransaction(subtest, { firstInstall: true });
      await publishLegacyPreAdoptionPending(fixture);
      const faultInjector = new ReleaseFaultInjector(point);
      const dependencies = {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        faultInjector,
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort: fixture.createActivationPort,
      };
      await assert.rejects(activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
        supersedePending: supersededActivationId,
      }, dependencies), /Injected release fault/);

      const pendingBeforeStaleAttempt = await readReleasePointer(
        fixture.layout.pendingPath,
        { pointerType: "pending" },
      );
      const oldJournalBeforeStaleAttempt = await readReleaseJournal(
        derivePlannerReleaseLayout(fixture.home, supersededActivationId).journalPath,
        supersededActivationId,
      );
      let staleHandoffs = 0;
      let staleLeaseAttempts = 0;
      const staleDependencies = {
        home: fixture.home,
        reexecuteInstalledOperator: async () => {
          staleHandoffs += 1;
          return { exitCode: 0 };
        },
        acquireOwnerLease: async () => {
          staleLeaseAttempts += 1;
          return { async close() {} };
        },
      };
      await assert.rejects(activateReleaseTransaction({
        transaction: supersededActivationId,
        authorized: true,
      }, staleDependencies), /pre-adoption stage/u);
      await assert.rejects(recoverReleaseTransaction({
        transaction: supersededActivationId,
      }, staleDependencies), /pre-adoption stage/u);
      assert.equal(staleHandoffs, 0);
      assert.equal(staleLeaseAttempts, 0);
      assert.deepEqual(await readReleasePointer(fixture.layout.pendingPath, {
        pointerType: "pending",
      }), pendingBeforeStaleAttempt);
      assert.equal((await readReleaseJournal(
        derivePlannerReleaseLayout(fixture.home, supersededActivationId).journalPath,
        supersededActivationId,
      )).sha256, oldJournalBeforeStaleAttempt.sha256);

      const recovered = await recoverReleaseTransaction({
        transaction: activationId,
      }, dependencies);
      assert.equal(recovered.state, "committed");
      assert.equal(faultInjector.fired, true);
      await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
      assert.equal((await readReleaseJournal(
        derivePlannerReleaseLayout(fixture.home, supersededActivationId).journalPath,
        supersededActivationId,
      )).state, "intervention_required");
    });
  }
});

test("uninitialized-authority confirmation is closed, durable, and precedes release effects", async (t) => {
  const missing = await setupTransaction(t, { initialized: false, firstInstall: true });
  let missingLeaseAttempts = 0;
  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: false,
  }, {
    home: missing.home,
    operatorExecutionSha256: missing.operatorSha256,
    acquireOwnerLease: async () => {
      missingLeaseAttempts += 1;
      return { async close() {} };
    },
    createActivationPort: missing.createActivationPort,
  }), /requires --confirm-uninitialized-authority/);
  assert.equal(missingLeaseAttempts, 0);
  assert.deepEqual(
    (await readReleaseJournal(missing.layout.journalPath, activationId)).entries.map((entry) => entry.kind),
    ["created"],
  );

  const unnecessary = await setupTransaction(t);
  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: true,
  }, {
    home: unnecessary.home,
    operatorExecutionSha256: unnecessary.operatorSha256,
  }), /invalid for an initialized planner authority/);

  const confirmed = await setupTransaction(t, { initialized: false, firstInstall: true });
  let handoff = null;
  const delegated = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: true,
  }, {
    home: confirmed.home,
    reexecuteInstalledOperator: async (request) => {
      handoff = request;
      return { exitCode: 0 };
    },
  });
  assert.equal(delegated.handedOff, true);
  assert.equal(handoff.command, "activate");
  assert.equal(Object.hasOwn(handoff, "confirmUninitializedAuthority"), false);
  const journalAfterHandoff = await readReleaseJournal(
    confirmed.layout.journalPath,
    activationId,
  );
  const confirmationIndex = journalAfterHandoff.entries.findIndex(
    (entry) => entry.kind === "checkpoint" &&
      entry.name === "uninitialized_authority_confirmation",
  );
  const firstEffectIndex = journalAfterHandoff.entries.findIndex((entry) => entry.kind === "intent");
  assert.ok(confirmationIndex > 0);
  assert.ok(firstEffectIndex > confirmationIndex);

  const activated = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: false,
  }, {
    home: confirmed.home,
    operatorExecutionSha256: confirmed.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: confirmed.createActivationPort,
  });
  assert.equal(activated.state, "committed");
  assert.equal(confirmed.effects.adoptAgentState.complete, true);
  const completedEffects = (await readReleaseJournal(
    confirmed.layout.journalPath,
    activationId,
  )).entries
    .filter((entry) => entry.kind === "completed")
    .map((entry) => entry.effect);
  assert.ok(
    completedEffects.indexOf("select_candidate_app") <
      completedEffects.indexOf("publish_artifact_installed"),
  );
  assert.ok(
    completedEffects.indexOf("publish_artifact_installed") <
      completedEffects.indexOf("adopt_authenticated_agent"),
  );
  assert.ok(
    completedEffects.indexOf("adopt_authenticated_agent") <
      completedEffects.indexOf("select_candidate_data"),
  );
  assert.equal(
    (await readReleaseJournal(confirmed.layout.journalPath, activationId)).entries.filter(
      (entry) => entry.kind === "checkpoint" &&
        entry.name === "uninitialized_authority_confirmation",
    ).length,
    1,
  );
});

test("a later transaction explicitly reuses an exact content-addressed operator", async (t) => {
  const fixture = await setupTransaction(t);
  const installedOperator = deriveInstalledOperatorPath(
    fixture.layout,
    fixture.operatorSha256,
  );
  await copyReleaseTree(fixture.layout.operatorSourceRoot, installedOperator);
  await freezeReleaseTree(installedOperator);

  const activated = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  });
  assert.equal(activated.state, "committed");
  const journal = await readReleaseJournal(fixture.layout.journalPath, activationId);
  const reuse = journal.entries.find(
    (entry) => entry.kind === "checkpoint" && entry.name === "operator_reuse",
  );
  assert.equal(reuse.projection.operatorSha256, fixture.operatorSha256);
  assert.equal(reuse.projection.identity.sha256, fixture.operatorSha256);
  assert.equal(
    journal.entries.some((entry) => entry.kind === "intent" && entry.effect === "install_operator"),
    false,
  );
});

test("a pre-mutation park failure preserves the original error without fake compensation", async (t) => {
  const fixture = await setupTransaction(t);
  const failure = new Error("park failed before mutation");
  const failingPort = async () => {
    const port = await fixture.createActivationPort();
    return {
      ...port,
      async createParkPreviousEffect() {
        return {
          ...fixture.effects.parkEffect,
          async perform() {
            throw failure;
          },
        };
      },
    };
  };
  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: failingPort,
  }), (error) => error === failure);
  const journal = await readReleaseJournal(fixture.layout.journalPath, activationId);
  assert.equal(journal.state, "preparing");
  assert.equal(
    journal.entries.some((entry) => entry.kind === "abandoned" && entry.effect === "park_previous"),
    false,
  );
  assert.equal(
    journal.entries.filter((entry) => entry.kind === "intent" && entry.effect === "park_previous")
      .length,
    1,
  );
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"), "previous-app\n");
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"), "previous-data\n");
});

test("an ordinary after-selection failure compensates the exact previous pair before returning", async (t) => {
  const fixture = await setupTransaction(t);
  let leaseCloses = 0;
  const dependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    faultInjector: new ReleaseFaultInjector("after_effect:select_candidate_app"),
    acquireOwnerLease: async () => ({ async close() { leaseCloses += 1; } }),
    createActivationPort: fixture.createActivationPort,
  };
  const result = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, dependencies);
  assert.equal(result.state, "rolled_back");
  assert.equal(leaseCloses, 1);
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"), "previous-app\n");
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"), "previous-data\n");
  const current = await readReleasePointer(fixture.layout.currentPath, { pointerType: "current" });
  assert.equal(current.activationId, previousActivationId);
  assert.equal(current.rollbackSha256, result.rollback.sha256);
  await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
  const journal = await readReleaseJournal(fixture.layout.journalPath);
  assert.equal(journal.state, "rolled_back");
  assert.equal(
    journal.entries.filter((entry) => entry.kind === "completed" && entry.effect === "select_candidate_app").length,
    1,
  );
});

test("compensated activation returns only the abandoned effect and a bounded error code", async (t) => {
  for (const [label, suppliedCode, expectedCode] of [
    ["valid code", "AUTH_PROTOCOL", "AUTH_PROTOCOL"],
    ["missing code", undefined, "ACTIVATION_FAILED"],
    ["invalid code", "private-code", "ACTIVATION_FAILED"],
    ["uppercase secret code", "DEVICECODEABC123", "ACTIVATION_FAILED"],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = await setupTransaction(subtest);
      const privateMessage = "private-provider-message-and-device-code-DO-NOT-LEAK";
      const createActivationPort = async (context) => {
        const port = await fixture.createActivationPort(context);
        return {
          ...port,
          async createAuthLifecycleEffect(effectContext) {
            const effect = await port.createAuthLifecycleEffect(effectContext);
            return {
              ...effect,
              async perform() {
                const failure = new Error(privateMessage);
                if (suppliedCode !== undefined) failure.code = suppliedCode;
                throw failure;
              },
            };
          },
        };
      };

      const result = await activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
      }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort,
      });
      assert.equal(result.state, "rolled_back");
      assert.deepEqual(result.failure, {
        effect: "produce_auth_lifecycle",
        code: expectedCode,
      });
      assert.equal(Object.isFrozen(result.failure), true);
      assert.equal(
        await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"),
        "previous-app\n",
      );
      assert.equal(
        await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"),
        "previous-data\n",
      );

      const journalText = await readFile(fixture.layout.journalPath, "utf8");
      const rollbackText = await readFile(fixture.layout.rollbackPath, "utf8");
      for (const durableText of [journalText, rollbackText]) {
        assert.equal(durableText.includes(privateMessage), false);
        assert.equal(durableText.includes(expectedCode), false);
        assert.equal(durableText.includes('"failure"'), false);
      }
      const journal = JSON.parse(journalText);
      assert.equal(
        journal.entries.findLast((entry) => entry.kind === "abandoned").effect,
        "produce_auth_lifecycle",
      );
    });
  }
});

test("selected-phase ordinary failures all converge on the same compensated terminal pair", async (t) => {
  const faultPoints = [
    "after_effect:park_previous",
    "after_effect:publish_artifact_installed",
    "after_effect:select_candidate_data",
    "after_effect:produce_auth_lifecycle",
    "after_effect:produce_release_candidate",
    "after_effect:produce_qa",
    "after_effect:publish_artifact_activation",
    "after_intent:publish_current",
  ];
  for (const point of faultPoints) {
    await t.test(point, async (subtest) => {
      const fixture = await setupTransaction(subtest);
      const result = await activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
      }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        faultInjector: new ReleaseFaultInjector(point),
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort: fixture.createActivationPort,
      });
      assert.equal(result.state, "rolled_back");
      assert.deepEqual(result.failure, {
        effect: point.split(":")[1],
        code: "ACTIVATION_FAILED",
      });
      assert.equal(
        await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"),
        "previous-app\n",
      );
      assert.equal(
        await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"),
        "previous-data\n",
      );
      assert.equal((await readReleaseJournal(fixture.layout.journalPath)).state, "rolled_back");
      await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
    });
  }
});

test("a current-pointer post-state wins as the sole commit even if journaling is interrupted", async (t) => {
  for (const point of ["after_effect:publish_current", "after_completed:publish_current"]) {
    await t.test(point, async (subtest) => {
      const fixture = await setupTransaction(subtest);
      const result = await activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
      }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        faultInjector: new ReleaseFaultInjector(point),
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort: fixture.createActivationPort,
      });
      assert.equal(result.state, "committed");
      assert.equal(
        (await readReleasePointer(fixture.layout.currentPath, { pointerType: "current" })).activationId,
        activationId,
      );
      assert.equal(
        await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"),
        "candidate-data\n",
      );
      await assert.rejects(readReleasePointer(fixture.layout.pendingPath), /ENOENT/);
      let handoffRequest = null;
      const sourceRecovery = await recoverReleaseTransaction(
        { transaction: activationId },
        {
          home: fixture.home,
          reexecuteInstalledOperator: async (request) => {
            handoffRequest = request;
            return { exitCode: 0 };
          },
        },
      );
      assert.equal(sourceRecovery.handedOff, true);
      assert.equal(handoffRequest.command, "recover");
      assert.equal(handoffRequest.activationId, activationId);
      const terminalRecovery = await recoverReleaseTransaction(
        { transaction: activationId },
        {
          home: fixture.home,
          operatorExecutionSha256: fixture.operatorSha256,
          acquireOwnerLease: async () => ({ async close() {} }),
          createActivationPort: fixture.createActivationPort,
        },
      );
      assert.equal(terminalRecovery.state, "committed");
    });
  }
});

test("public recovery resumes a crashed pre-commit compensation without rerunning QA", async (t) => {
  const fixture = await setupTransaction(t);
  let qaPerformCount = 0;
  const failingPort = async (context) => {
    const port = await fixture.createActivationPort(context);
    return {
      ...port,
      async createQaEffect(effectContext) {
        const effect = await port.createQaEffect(effectContext);
        return {
          ...effect,
          async perform() {
            qaPerformCount += 1;
            throw new Error("ordinary installed QA failure");
          },
        };
      },
    };
  };
  const dependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    faultInjector: new ReleaseFaultInjector("after_effect:restore_previous_app"),
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: failingPort,
  };
  await assert.rejects(activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, dependencies), /Injected release fault at after_effect:restore_previous_app/);
  assert.equal(qaPerformCount, 1);
  assert.equal((await readReleaseJournal(fixture.layout.journalPath)).state, "restoring");

  let recoveryHandoff = null;
  const delegated = await recoverReleaseTransaction({ transaction: activationId }, {
    home: fixture.home,
    reexecuteInstalledOperator: async (request) => {
      recoveryHandoff = request;
      return { exitCode: 0 };
    },
  });
  assert.equal(delegated.handedOff, true);
  assert.equal(recoveryHandoff.command, "recover");
  assert.equal((await readReleaseJournal(fixture.layout.journalPath)).state, "restoring");

  const recovered = await recoverReleaseTransaction({ transaction: activationId }, {
    ...dependencies,
    faultInjector: null,
    createActivationPort: fixture.createActivationPort,
  });
  assert.equal(recovered.state, "rolled_back");
  assert.equal(qaPerformCount, 1, "recovery consumes the abandoned QA intent instead of rerunning it");
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"), "previous-app\n");
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"), "previous-data\n");
});

test("compensation-direction crashes recover without duplicating the failed intent", async (t) => {
  for (const point of [
    "after_compensation_started",
    "after_compensation_intent_settled",
  ]) {
    await t.test(point, async (subtest) => {
      const fixture = await setupTransaction(subtest);
      let qaPerformCount = 0;
      const failingPort = async (context) => {
        const port = await fixture.createActivationPort(context);
        return {
          ...port,
          async createQaEffect(effectContext) {
            const effect = await port.createQaEffect(effectContext);
            return {
              ...effect,
              async perform() {
                qaPerformCount += 1;
                throw new Error("ordinary installed QA failure");
              },
            };
          },
        };
      };
      await assert.rejects(activateReleaseTransaction({
        transaction: activationId,
        authorized: true,
      }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        faultInjector: new ReleaseFaultInjector(point),
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort: failingPort,
      }), new RegExp(`Injected release fault at ${point}`));

      const interrupted = await readReleaseJournal(fixture.layout.journalPath);
      assert.equal(interrupted.state, "restoring");
      assert.equal(interrupted.entries.filter(
        (entry) => entry.kind === "intent" && entry.effect === "produce_qa",
      ).length, 1);

      const recovered = await recoverReleaseTransaction({ transaction: activationId }, {
        home: fixture.home,
        operatorExecutionSha256: fixture.operatorSha256,
        acquireOwnerLease: async () => ({ async close() {} }),
        createActivationPort: fixture.createActivationPort,
      });
      assert.equal(recovered.state, "rolled_back");
      assert.equal(qaPerformCount, 1);
      const terminal = await readReleaseJournal(fixture.layout.journalPath);
      assert.equal(terminal.entries.filter(
        (entry) => entry.kind === "intent" && entry.effect === "produce_qa",
      ).length, 1);
    });
  }
});

test("first-install compensation restores the inactive pair without inventing current.json", async (t) => {
  const fixture = await setupTransaction(t, { firstInstall: true });
  const result = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    faultInjector: new ReleaseFaultInjector("after_effect:produce_auth_lifecycle"),
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  });
  assert.equal(result.state, "rolled_back");
  assert.equal(result.current, null);
  await assert.rejects(readReleasePointer(fixture.layout.currentPath), /ENOENT/);
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"), "previous-app\n");
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"), "previous-data\n");
});

test("first-install adoption creation failure compensates without fabricating an adoption intent", async (t) => {
  const fixture = await setupTransaction(t, { firstInstall: true });
  const result = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: async (context) => {
      const port = await fixture.createActivationPort(context);
      return {
        ...port,
        async createAdoptAgentEffect() {
          throw new PlannerReleaseInterventionError(
            "The retained dedicated agent deployment changed after staging.",
          );
        },
      };
    },
  });
  assert.equal(result.state, "rolled_back");
  const journal = await readReleaseJournal(fixture.layout.journalPath);
  assert.equal(journal.entries.some(
    (entry) => entry.kind === "intent" && entry.effect === "adopt_authenticated_agent",
  ), false);
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"),
    "previous-app\n");
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"),
    "previous-data\n");
  await assert.rejects(readReleasePointer(fixture.layout.currentPath), /ENOENT/);
});

test("first-install post-commit rollback retains app/data/current and records fail-soft deactivation", async (t) => {
  const fixture = await setupTransaction(t, { firstInstall: true });
  const dependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  };
  const activated = await activateReleaseTransaction({
    transaction: activationId,
    authorized: true,
  }, dependencies);
  assert.equal(activated.state, "committed");
  const appBefore = await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8");
  const dataBefore = await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8");
  const appDeactivated = { complete: false };
  const dataRetained = { complete: false };
  const rolledBack = await rollbackReleaseTransaction({
    transaction: activationId,
    authorizeDataLoss: null,
  }, {
    ...dependencies,
    createRollbackPort: async () => ({
      evaluateRollbackGuard: async () => ({
        allowed: true,
        automatic: true,
        currentStoreSha256: "6".repeat(64),
        restoreStoreSha256: "7".repeat(64),
      }),
      createRestoreAppEffect: async (context) => memoryEffect(
        appDeactivated,
        "restore_previous_app",
        context.recoveryIntent ?? null,
      ),
      createRestoreDataEffect: async (context) => memoryEffect(
        dataRetained,
        "restore_previous_data",
        context.recoveryIntent ?? null,
      ),
      rollbackProjection: async () => ({ firstInstallFailSoft: true }),
    }),
  });
  assert.equal(rolledBack.state, "rolled_back");
  assert.equal(rolledBack.current.activationId, activationId);
  assert.equal(rolledBack.current.rollbackSha256, rolledBack.rollback.sha256);
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"), appBefore);
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"), dataBefore);
});

test("guarded rollback restores the previous pair, retains newer data, then publishes rollback current", async (t) => {
  const fixture = await setupTransaction(t);
  const activationDependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  };
  await activateReleaseTransaction({ transaction: activationId, authorized: true }, activationDependencies);

  const supersededApp = join(fixture.layout.transactionRoot, "superseded-app");
  const supersededData = join(fixture.layout.supersededDataRoot, "candidate-store");
  await mkdir(fixture.layout.supersededDataRoot, { mode: 0o700 });
  const restoreAppPaths = {
    app: fixture.layout.appRoot,
    parkedApp: fixture.layout.parkedCurrentAppRoot,
    supersededApp,
  };
  const restoreApp = async () => {
    await rename(fixture.layout.appRoot, supersededApp);
    await rename(fixture.layout.parkedCurrentAppRoot, fixture.layout.appRoot);
  };
  restoreApp.postIdentityFrom = { supersededApp: "app", app: "parkedApp" };
  const restoreAppEffect = await compositeEffect(
    "restore_previous_app",
    restoreAppPaths,
    restoreAppPaths,
    restoreApp,
  );
  restoreAppEffect.expected.post.parkedApp = { exists: false };

  const restoreDataPaths = {
    data: fixture.layout.dataRoot,
    parkedData: fixture.layout.parkedCurrentDataRoot,
    supersededData,
  };
  const restoreData = async () => {
    await rename(fixture.layout.dataRoot, supersededData);
    await rename(fixture.layout.parkedCurrentDataRoot, fixture.layout.dataRoot);
  };
  restoreData.postIdentityFrom = { supersededData: "data", data: "parkedData" };
  const restoreDataEffect = await compositeEffect(
    "restore_previous_data",
    restoreDataPaths,
    restoreDataPaths,
    restoreData,
  );
  restoreDataEffect.expected.post.parkedData = { exists: false };

  const exactAuthorization =
    `${activationId}:${"6".repeat(64)}:${"7".repeat(64)}`;
  await assert.rejects(rollbackReleaseTransaction({
    transaction: activationId,
    authorizeDataLoss: null,
  }, {
    ...activationDependencies,
    createRollbackPort: async () => ({
      evaluateRollbackGuard: async () => ({
        allowed: true,
        automatic: false,
        currentStoreSha256: "6".repeat(64),
        restoreStoreSha256: "7".repeat(64),
      }),
      createRestoreAppEffect: async () => restoreAppEffect,
      createRestoreDataEffect: async () => restoreDataEffect,
      rollbackProjection: async () => ({}),
    }),
  }), new RegExp(`--authorize-data-loss ${exactAuthorization.replaceAll(":", "\\:")}`));

  const result = await rollbackReleaseTransaction({
    transaction: activationId,
    authorizeDataLoss: null,
  }, {
    ...activationDependencies,
    createRollbackPort: async () => ({
      evaluateRollbackGuard: async () => ({
        allowed: true,
        automatic: true,
        currentStoreSha256: "6".repeat(64),
        restoreStoreSha256: "7".repeat(64),
      }),
      createRestoreAppEffect: async () => restoreAppEffect,
      createRestoreDataEffect: async () => restoreDataEffect,
      rollbackProjection: async () => ({
        automatic: true,
        currentStoreSha256: "6".repeat(64),
        restoreStoreSha256: "7".repeat(64),
      }),
    }),
  });
  assert.equal(result.state, "rolled_back");
  assert.equal(await readFile(join(fixture.layout.appRoot, "family.txt"), "utf8"), "previous-app\n");
  assert.equal(await readFile(join(fixture.layout.dataRoot, "planner.sqlite"), "utf8"), "previous-data\n");
  assert.equal(await readFile(join(supersededData, "planner.sqlite"), "utf8"), "candidate-data\n");
  const current = await readReleasePointer(fixture.layout.currentPath, { pointerType: "current" });
  assert.equal(current.activationId, previousActivationId);
  assert.equal(current.rollbackSha256, result.rollback.sha256);
  assert.equal((await readReleaseJournal(fixture.layout.journalPath)).state, "rolled_back");
});

test("rollback recovery reauthorizes a store changed after its durable guard", async (t) => {
  const fixture = await setupTransaction(t);
  const activationDependencies = {
    home: fixture.home,
    operatorExecutionSha256: fixture.operatorSha256,
    acquireOwnerLease: async () => ({ async close() {} }),
    createActivationPort: fixture.createActivationPort,
  };
  await activateReleaseTransaction(
    { transaction: activationId, authorized: true },
    activationDependencies,
  );

  let currentStoreSha256 = "6".repeat(64);
  const restoreStoreSha256 = "7".repeat(64);
  let guardEvaluations = 0;
  const appState = { complete: false };
  const dataState = { complete: false };
  const createRollbackPort = async () => ({
    async evaluateRollbackGuard() {
      guardEvaluations += 1;
      return {
        allowed: true,
        automatic: false,
        currentStoreSha256,
        restoreStoreSha256,
      };
    },
    createRestoreAppEffect: async (context) => memoryEffect(
      appState,
      "restore_previous_app",
      context.recoveryIntent ?? null,
    ),
    createRestoreDataEffect: async (context) => memoryEffect(
      dataState,
      "restore_previous_data",
      context.recoveryIntent ?? null,
    ),
    rollbackProjection: async (context) => ({
      currentStoreSha256: context.guard.currentStoreSha256,
      restoreStoreSha256: context.guard.restoreStoreSha256,
    }),
  });
  const authorization = () => ({
    activationId,
    currentStoreSha256,
    restoreStoreSha256,
  });

  await assert.rejects(
    rollbackReleaseTransaction({
      transaction: activationId,
      authorizeDataLoss: authorization(),
    }, {
      ...activationDependencies,
      createRollbackPort,
      faultInjector: new ReleaseFaultInjector("before_intent:publish_rollback_pending"),
    }),
    /Injected release fault/,
  );
  currentStoreSha256 = "8".repeat(64);
  await assert.rejects(
    rollbackReleaseTransaction({
      transaction: activationId,
      authorizeDataLoss: null,
    }, {
      ...activationDependencies,
      createRollbackPort,
    }),
    new RegExp(
      `--authorize-data-loss ${activationId}:${currentStoreSha256}:${restoreStoreSha256}`,
    ),
  );
  const result = await rollbackReleaseTransaction({
    transaction: activationId,
    authorizeDataLoss: authorization(),
  }, {
    ...activationDependencies,
    createRollbackPort,
  });
  assert.equal(result.state, "rolled_back");
  assert.equal(guardEvaluations, 3);
  assert.equal(result.rollback.projection.currentStoreSha256, currentStoreSha256);
});
