import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertCanonicalInstalledBuildReferences,
  createProductionActivationPort,
  createProductionRollbackPort,
  drainLegacyPlannerRuntime,
  inspectPlannerReleaseDataSource,
} from "../scripts/support/planner-release-composition.mjs";
import {
  createActivationId,
  createReleaseArtifact,
  canonicalReleaseJson,
  derivePlannerReleaseLayout,
  ensurePrivateDirectory,
} from "../scripts/support/planner-release-contract.mjs";
import {
  freezeReleaseTree,
  inspectReleaseTreeIdentity,
  inventoryReleaseTree,
  normalizeNpmDependencyGraph,
} from "../scripts/support/planner-release-transaction.mjs";
import {
  acquirePlannerStoreWriteReservation,
  inspectVerifiedPlannerSnapshot,
  openPlannerStore,
} from "../server/store/sqlite-store.ts";

const packageRoot = resolve(new URL("../", import.meta.url).pathname);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function makeRemovable(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await makeRemovable(join(path, child));
  } else if (metadata.isFile()) {
    await chmod(path, 0o600);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plannerState() {
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-07-06",
    weeks: [{
      id: "2026-07-06",
      weekStartDate: "2026-07-06",
      status: "active",
      data: {
        meals: [],
        prepSessions: [],
        groceries: [],
        leftovers: [],
        feedback: {},
        weekLesson: "release-composition",
      },
    }],
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-release-composition-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const sourceRoot = join(root, "source");
  const dataRoot = join(sourceRoot, "data");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
  ]);
  const filename = join(dataRoot, "planner.sqlite");
  const store = openPlannerStore({ filename, busyTimeoutMs: 0 });
  store.database.exec("PRAGMA wal_autocheckpoint = 0");
  store.transaction((transaction) => store.insertWorkspace(transaction, plannerState(), 1));
  const projection = await inspectPlannerReleaseDataSource(packageRoot, filename);
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [layout.root, layout.releasesRoot, layout.transactionRoot, layout.runRoot]) {
    await ensurePrivateDirectory(path);
  }
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      dataSource: {
        canonicalPath: filename,
        device: "fixture",
        inode: "fixture",
        size: "fixture",
        ...projection,
      },
    },
  });
  return { root, home, filename, store, activationId, layout, stage };
}

async function appSelectionFixture(t, failure = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-release-app-select-")));
  t.after(async () => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [
    home,
    layout.root,
    layout.cacheRoot,
    layout.releasesRoot,
    layout.transactionRoot,
    layout.candidateSourceRoot,
    layout.npmCacheRoot,
    layout.qaRoot,
    layout.runRoot,
  ]) {
    await ensurePrivateDirectory(path);
  }
  const config = [
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "",
  ].join("\n");
  const instructions = "# Embedded planner fixture\n";
  const dependencyGraph = { name: "release-app-fixture", version: "1.0.0" };
  const dependencyGraphSha256 = sha256(canonicalReleaseJson(
    normalizeNpmDependencyGraph(dependencyGraph),
  ));
  await Promise.all([
    mkdir(join(layout.candidateSourceRoot, "deployment", "codex"), {
      recursive: true,
      mode: 0o700,
    }),
    writeFile(join(layout.candidateSourceRoot, "package.json"), [
      '{"name":"release-app-fixture","version":"1.0.0","type":"module"}',
      "",
    ].join("\n")),
    writeFile(join(layout.candidateSourceRoot, "package-lock.json"), [
      '{"name":"release-app-fixture","version":"1.0.0","lockfileVersion":3}',
      "",
    ].join("\n")),
  ]);
  await Promise.all([
    writeFile(join(layout.candidateSourceRoot, "deployment", "codex", "config.toml"), config),
    writeFile(
      join(layout.candidateSourceRoot, "deployment", "codex", "AGENTS.md"),
      instructions,
    ),
  ]);
  const candidateSource = await inventoryReleaseTree(layout.candidateSourceRoot);
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      candidateSource,
      locks: { candidateSha256: "2".repeat(64) },
      configSha256: sha256(config),
      instructionSha256: sha256(instructions),
      preflight: {
        node: {
          executable: process.execPath,
          version: "v22.15.0",
          sha256: "3".repeat(64),
          exactFloorVerified: true,
          recheckedAfterSuite: true,
        },
        npm: {
          executable: process.execPath,
          cli: "/fixture/npm-cli.js",
          version: "fixture",
          cliSha256: "4".repeat(64),
        },
        candidate: {
          dependencyGraphSha256,
        },
      },
    },
  });
  const context = {
    home,
    activationId,
    layout,
    stage,
    journal: { entries: [] },
    drain: {
      storeModule: {},
      async prepare() {},
      async readPrepared() { return null; },
    },
  };
  const commands = [];
  const runCommand = async (_command, args, options = {}) => {
    commands.push({ args: [...args], cwd: options.cwd ?? null });
    const npmArgs = args[0] === "/fixture/npm-cli.js" ? args.slice(1) : args;
    if (npmArgs[0] === "ci" && failure === "install") {
      throw new Error("injected clean install failure");
    }
    if (npmArgs[0] === "run" && npmArgs[1] === "build") {
      if (failure === "build") throw new Error("injected canonical build failure");
      await mkdir(join(options.cwd, "dist"), { mode: 0o700 });
      await writeFile(
        join(options.cwd, "dist", "build.json"),
        failure === "leak"
          ? JSON.stringify({ sourceRoot: context.layout.candidateSourceRoot })
          : "{\"built\":true}\n",
      );
      if (failure === "build-source-drift") {
        await writeFile(
          join(options.cwd, "package.json"),
          '{"name":"drifted-during-build","version":"1.0.0","type":"module"}\n',
        );
      }
    }
    if (npmArgs[0] === "ls") {
      return {
        stdout: `${JSON.stringify(
          failure === "dependency-drift"
            ? { ...dependencyGraph, dependencies: { injected: { version: "9.9.9" } } }
            : dependencyGraph,
        )}\n`,
      };
    }
    return { stdout: "", stderr: "", code: 0, signal: null };
  };
  let runtimeInspections = 0;
  const port = await createProductionActivationPort(context, {
    runCommand,
    async inspectStageRuntimeIdentity({ expected }) {
      runtimeInspections += 1;
      return failure === "runtime-drift" && runtimeInspections === 2
        ? {
            ...expected,
            node: { ...expected.node, sha256: "f".repeat(64) },
          }
        : expected;
    },
  });
  return { root, context, port, commands };
}

test("pre-commit compensation uses the activation-bound planner drain", async () => {
  const drain = {
    storeModule: {},
    async prepare() {},
    prepared: {
      rollback: { sha256: "a".repeat(64) },
      candidate: { sha256: "b".repeat(64) },
    },
  };
  const port = await createProductionActivationPort({ drain });

  const projection = await port.rollbackProjection({
    previous: { projection: { firstInstall: true } },
  });

  assert.deepEqual(projection, {
    precommitCompensation: true,
    firstInstall: true,
    rollbackDataSha256: "a".repeat(64),
    candidateDataSha256: "b".repeat(64),
    newerDataRetained: true,
    restoredInactiveCodex: true,
  });
});

test("stage data inspection is store-aware and rejects a non-SQLite nonempty file", async (t) => {
  const value = await fixture(t);
  const projection = await inspectPlannerReleaseDataSource(packageRoot, value.filename);
  assert.deepEqual({
    quickCheck: projection.quickCheck,
    schemaVersion: projection.schemaVersion,
    initialized: projection.initialized,
    workspaceSchemaVersion: projection.workspaceSchemaVersion,
    plannerVersion: projection.plannerVersion,
  }, {
    quickCheck: "ok",
    schemaVersion: 8,
    initialized: true,
    workspaceSchemaVersion: 8,
    plannerVersion: 0,
  });

  const fake = join(value.root, "not-a-database.sqlite");
  await writeFile(fake, "definitely nonempty\n");
  await assert.rejects(
    inspectPlannerReleaseDataSource(packageRoot, fake),
    /SQLite|database|quick_check/i,
  );
  const emptyAuthority = join(value.root, "uninitialized.sqlite");
  const emptyStore = openPlannerStore({ filename: emptyAuthority });
  emptyStore.close();
  const emptyProjection = await inspectPlannerReleaseDataSource(
    packageRoot,
    emptyAuthority,
  );
  assert.equal(emptyProjection.initialized, false);
  assert.equal(emptyProjection.schemaVersion, 8);
  assert.equal(emptyProjection.workspaceSchemaVersion, null);
  assert.equal(emptyProjection.plannerVersion, null);
  value.store.close();
});

test("legacy drain holds one source reservation and derives candidate data from one real VACUUM snapshot", async (t) => {
  const value = await fixture(t);
  let sourceSnapshots = 0;
  const storeModule = {
    inspectVerifiedPlannerSnapshot,
    openPlannerStore,
    acquirePlannerStoreWriteReservation(options) {
      const reservation = acquirePlannerStoreWriteReservation(options);
      if (options.filename !== value.filename) return reservation;
      return Object.freeze({
        ...reservation,
        createVerifiedSnapshot(destination) {
          sourceSnapshots += 1;
          return reservation.createVerifiedSnapshot(destination);
        },
      });
    },
  };
  const unusedPort = 49_987;
  const context = {
    home: value.home,
    activationId: value.activationId,
    layout: value.layout,
    stage: value.stage,
  };
  const dependencies = {
    environment: { PLANNER_LEGACY_HTTP_PORT: String(unusedPort) },
    loadPlannerStoreModule: async () => storeModule,
  };
  const drain = await drainLegacyPlannerRuntime(context, dependencies);
  assert.equal(sourceSnapshots, 0, "the drain may not snapshot before the durable effect intent");
  await drain.prepare();
  assert.equal(sourceSnapshots, 1);
  assert.equal(drain.rollback.quickCheck, "ok");
  assert.equal(drain.rollback.initialized, true);
  assert.equal(drain.candidate.schemaVersion, 8);
  assert.equal(drain.candidate.plannerVersion, 0);
  assert.throws(
    () => value.store.transaction(() => assert.fail("reserved source writer entered")),
    /active writer|busy|locked/i,
  );
  drain.reservation.close();

  const recovered = await drainLegacyPlannerRuntime(context, dependencies);
  await recovered.readPrepared();
  assert.equal(sourceSnapshots, 1, "recovery must reuse the one immutable base snapshot");
  assert.equal(recovered.rollback.sha256, drain.rollback.sha256);
  assert.equal(recovered.candidate.sha256, drain.candidate.sha256);
  await recovered.close();
  value.store.close();
});

test("snapshot failure stops before candidate migration and a retry takes the first verified base", async (t) => {
  const value = await fixture(t);
  let snapshotAttempts = 0;
  let failSnapshot = true;
  const storeModule = {
    inspectVerifiedPlannerSnapshot,
    openPlannerStore,
    acquirePlannerStoreWriteReservation(options) {
      const reservation = acquirePlannerStoreWriteReservation(options);
      if (options.filename !== value.filename) return reservation;
      return Object.freeze({
        ...reservation,
        createVerifiedSnapshot(destination) {
          snapshotAttempts += 1;
          if (failSnapshot) throw new Error("injected base snapshot failure");
          return reservation.createVerifiedSnapshot(destination);
        },
      });
    },
  };
  const context = {
    home: value.home,
    activationId: value.activationId,
    layout: value.layout,
    stage: value.stage,
  };
  const dependencies = {
    environment: { PLANNER_LEGACY_HTTP_PORT: "49986" },
    loadPlannerStoreModule: async () => storeModule,
  };
  const failed = await drainLegacyPlannerRuntime(context, dependencies);
  await assert.rejects(failed.prepare(), /injected base snapshot failure/);
  assert.equal(snapshotAttempts, 1);
  assert.equal(await pathExists(join(value.layout.rollbackDataRoot, "planner.sqlite")), false);
  assert.equal(await pathExists(join(value.layout.candidateDataRoot, "planner.sqlite")), false);
  await failed.close();

  failSnapshot = false;
  const recovered = await drainLegacyPlannerRuntime(context, dependencies);
  await recovered.prepare();
  assert.equal(snapshotAttempts, 2);
  assert.equal(recovered.rollback.quickCheck, "ok");
  assert.equal(recovered.candidate.quickCheck, "ok");
  await recovered.close();
  value.store.close();
});

test("migration failure preserves the one base snapshot and recovery rebuilds only candidate data", async (t) => {
  const value = await fixture(t);
  let sourceSnapshots = 0;
  let failMigration = true;
  const storeModule = {
    inspectVerifiedPlannerSnapshot,
    openPlannerStore(options) {
      if (
        failMigration &&
        options.filename === join(value.layout.candidateDataRoot, "planner.sqlite")
      ) {
        throw new Error("injected candidate migration failure");
      }
      return openPlannerStore(options);
    },
    acquirePlannerStoreWriteReservation(options) {
      const reservation = acquirePlannerStoreWriteReservation(options);
      if (options.filename !== value.filename) return reservation;
      return Object.freeze({
        ...reservation,
        createVerifiedSnapshot(destination) {
          sourceSnapshots += 1;
          return reservation.createVerifiedSnapshot(destination);
        },
      });
    },
  };
  const context = {
    home: value.home,
    activationId: value.activationId,
    layout: value.layout,
    stage: value.stage,
  };
  const dependencies = {
    environment: { PLANNER_LEGACY_HTTP_PORT: "49985" },
    loadPlannerStoreModule: async () => storeModule,
  };
  const failed = await drainLegacyPlannerRuntime(context, dependencies);
  await assert.rejects(failed.prepare(), /injected candidate migration failure/);
  assert.equal(sourceSnapshots, 1);
  assert.equal(await pathExists(join(value.layout.rollbackDataRoot, "planner.sqlite")), true);
  assert.equal(await pathExists(join(value.layout.transactionRoot, "data-preparation.json")), false);
  await failed.close();

  failMigration = false;
  const recovered = await drainLegacyPlannerRuntime(context, dependencies);
  await recovered.prepare();
  assert.equal(sourceSnapshots, 1, "recovery reuses the first verified base snapshot");
  assert.equal(recovered.candidate.schemaVersion, 8);
  assert.equal(recovered.candidate.initialized, true);
  await recovered.close();
  value.store.close();
});

test("canonical install and build failures never publish an installed app receipt", async (t) => {
  for (const [failure, pattern] of [
    ["install", /injected clean install failure/],
    ["build", /injected canonical build failure/],
    ["leak", /references a noncanonical build root/],
    ["build-source-drift", /source changed while the installed build ran/],
    ["runtime-drift", /exact Node\/npm runtime changed during canonical installation/],
    ["dependency-drift", /npm dependency graph changed after the exact Node preflight/],
  ]) {
    await t.test(failure, async (subtest) => {
      const value = await appSelectionFixture(subtest, failure);
      const effect = await value.port.createSelectAppEffect(value.context);
      await assert.rejects(effect.perform(), pattern);
      assert.equal(
        await pathExists(join(value.context.layout.transactionRoot, "candidate-app.json")),
        false,
      );
    });
  }
});

test("canonical install rejects staged source drift before invoking npm", async (t) => {
  const value = await appSelectionFixture(t);
  await writeFile(
    join(value.context.layout.candidateSourceRoot, "package.json"),
    '{"name":"drifted-after-stage","version":"1.0.0","type":"module"}\n',
  );
  const effect = await value.port.createSelectAppEffect(value.context);
  await assert.rejects(
    effect.perform(),
    /source changed after the exact Node preflight/,
  );
  assert.equal(value.commands.length, 0);
  assert.equal(
    await pathExists(join(value.context.layout.transactionRoot, "candidate-app.json")),
    false,
  );
});

test("candidate app inspection rejects partial disk state despite an unresolved intent", async (t) => {
  const value = await appSelectionFixture(t);
  value.context.journal = {
    entries: [{
      kind: "intent",
      effectId: "1:select_candidate_app",
      effect: "select_candidate_app",
    }],
  };
  const effect = await value.port.createSelectAppEffect(value.context);
  await mkdir(value.context.layout.appRoot, { mode: 0o700 });
  await writeFile(join(value.context.layout.appRoot, "partial.txt"), "partial app\n");
  assert.equal((await effect.inspect()).classification, "neither");

  await rm(value.context.layout.appRoot, { recursive: true });
  await ensurePrivateDirectory(value.context.layout.agentRoot);
  await writeFile(value.context.layout.agentConfigPath, "# partial config\n", { mode: 0o600 });
  assert.equal((await effect.inspect()).classification, "neither");
});

test("installed projection rejects canonical app manifest drift after a successful build", async (t) => {
  const value = await appSelectionFixture(t);
  const effect = await value.port.createSelectAppEffect(value.context);
  await effect.perform();
  assert.equal((await effect.inspect()).classification, "post");
  const installed = await value.port.installedProjection(value.context);
  assert.match(installed.canonicalApp.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(value.commands.some(({ args }) => args[1] === "ci"), true);
  assert.equal(value.commands.some(({ args }) => args[1] === "ls"), true);

  const packagePath = join(value.context.layout.appRoot, "package.json");
  await chmod(value.context.layout.appRoot, 0o700);
  await chmod(packagePath, 0o600);
  await writeFile(packagePath, `${await readFile(packagePath, "utf8")} `);
  await chmod(packagePath, 0o444);
  await chmod(value.context.layout.appRoot, 0o500);
  await assert.rejects(
    value.port.installedProjection(value.context),
    /canonical installed application changed/,
  );
});

test("frozen-app partial park and selected-data rename failures recover to exact post-state", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-release-rename-")));
  t.after(async () => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [home, layout.root, layout.releasesRoot, layout.transactionRoot]) {
    await ensurePrivateDirectory(path);
  }
  await Promise.all([
    mkdir(layout.appRoot, { mode: 0o700 }),
    mkdir(layout.dataRoot, { mode: 0o700 }),
    mkdir(layout.candidateDataRoot, { mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(layout.appRoot, "app.txt"), "previous app\n"),
    writeFile(join(layout.dataRoot, "planner.sqlite"), "previous data\n"),
    writeFile(join(layout.candidateDataRoot, "planner.sqlite"), "candidate data\n"),
  ]);
  const [app, data] = await Promise.all([
    inspectReleaseTreeIdentity(layout.appRoot),
    inspectReleaseTreeIdentity(layout.dataRoot),
  ]);
  await chmod(layout.appRoot, 0o500);
  const context = {
    home,
    activationId,
    layout,
    stage: { projection: {} },
    journal: { entries: [] },
    drain: {
      storeModule: {},
      async prepare() {},
      async readPrepared() { return null; },
    },
  };
  const port = await createProductionActivationPort(context);
  const previous = { projection: { firstInstall: false, app, data } };
  const park = await port.createParkPreviousEffect({ ...context, previous });
  assert.equal((await park.inspect()).classification, "pre");
  await chmod(layout.transactionRoot, 0o500);
  await assert.rejects(park.perform(), /permission|EACCES/i);
  assert.equal(await pathExists(layout.appRoot), true);
  assert.equal(await pathExists(layout.parkedCurrentAppRoot), false);
  assert.equal((await lstat(layout.appRoot)).mode & 0o777, 0o500);
  await chmod(layout.transactionRoot, 0o700);
  await mkdir(layout.parkedCurrentDataRoot, { mode: 0o700 });
  await writeFile(join(layout.parkedCurrentDataRoot, "obstruction"), "occupied\n");
  await assert.rejects(park.perform(), /both its source and destination/i);
  assert.equal(await pathExists(layout.appRoot), false);
  assert.equal(await pathExists(layout.parkedCurrentAppRoot), true);
  assert.equal((await lstat(layout.parkedCurrentAppRoot)).mode & 0o777, 0o500);
  assert.equal(await pathExists(layout.dataRoot), true);
  await rm(layout.parkedCurrentDataRoot, { recursive: true });
  const parkedAppFile = join(layout.parkedCurrentAppRoot, "app.txt");
  await chmod(layout.parkedCurrentAppRoot, 0o700);
  await chmod(parkedAppFile, 0o600);
  await writeFile(parkedAppFile, "drifted after partial park\n");
  await chmod(parkedAppFile, 0o444);
  await chmod(layout.parkedCurrentAppRoot, 0o500);
  await assert.rejects(
    park.perform(),
    /changed from its durable release identity/i,
  );
  assert.equal(await pathExists(layout.dataRoot), false);
  assert.equal(await pathExists(layout.parkedCurrentDataRoot), true);
  await chmod(layout.parkedCurrentAppRoot, 0o700);
  await chmod(parkedAppFile, 0o600);
  await writeFile(parkedAppFile, "previous app\n");
  await chmod(parkedAppFile, 0o444);
  await chmod(layout.parkedCurrentAppRoot, 0o500);
  await park.perform();
  assert.equal((await park.inspect()).classification, "post");

  const selectData = await port.createSelectDataEffect({ ...context, previous });
  await mkdir(layout.dataRoot, { mode: 0o700 });
  await writeFile(join(layout.dataRoot, "obstruction"), "occupied\n");
  await assert.rejects(selectData.perform(), /not empty|exist|ENOTEMPTY|EEXIST/i);
  await rm(layout.dataRoot, { recursive: true });
  const recovered = await port.createSelectDataEffect({
    ...context,
    previous,
    recoveryIntent: {
      expected: selectData.expected,
      replay: selectData.replay,
    },
  });
  await recovered.perform();
  assert.equal((await recovered.inspect()).classification, "post");
  assert.equal(
    await readFile(join(layout.dataRoot, "planner.sqlite"), "utf8"),
    "candidate data\n",
  );
});

test("later rollback post-state requires the exact retained candidate application", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-release-retained-app-")));
  t.after(async () => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [home, layout.root, layout.releasesRoot, layout.transactionRoot]) {
    await ensurePrivateDirectory(path);
  }
  await Promise.all([
    mkdir(layout.appRoot, { mode: 0o700 }),
    mkdir(layout.parkedCurrentAppRoot, { mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(layout.appRoot, "app.txt"), "candidate app\n"),
    writeFile(join(layout.parkedCurrentAppRoot, "app.txt"), "previous app\n"),
  ]);
  await Promise.all([
    freezeReleaseTree(layout.appRoot),
    freezeReleaseTree(layout.parkedCurrentAppRoot),
  ]);
  const [candidateApp, previousApp] = await Promise.all([
    inspectReleaseTreeIdentity(layout.appRoot),
    inspectReleaseTreeIdentity(layout.parkedCurrentAppRoot),
  ]);
  const context = {
    home,
    activationId,
    layout,
    activation: {
      projection: {
        app: candidateApp,
        activationSnapshotSha256: "a".repeat(64),
      },
    },
    previous: { projection: { firstInstall: false, app: previousApp } },
  };
  const guard = {
    allowed: true,
    automatic: false,
    currentStoreSha256: "b".repeat(64),
    restoreStoreSha256: "c".repeat(64),
  };
  const port = await createProductionRollbackPort(context, {
    async loadPlannerStoreModule() {
      return {
        acquirePlannerStoreWriteReservation() {
          return {
            createVerifiedSnapshot() {
              return { sha256: guard.currentStoreSha256 };
            },
            close() {},
          };
        },
        inspectVerifiedPlannerSnapshot() {
          return { sha256: guard.restoreStoreSha256 };
        },
      };
    },
  });
  const restore = await port.createRestoreAppEffect({
    ...context,
    guard,
    recoveryIntent: null,
  });
  assert.equal((await restore.inspect()).classification, "pre");
  await restore.perform();
  assert.equal((await restore.inspect()).classification, "post");
  const supersededApp = join(layout.transactionRoot, "superseded-app");
  await makeRemovable(supersededApp);
  await rm(supersededApp, { recursive: true });
  assert.equal((await restore.inspect()).classification, "neither");
});

test("installed build validation accepts its canonical root and rejects staged-root leakage", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-installed-leak-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app");
  const generated = join(app, "dist");
  const staged = join(root, "releases", "candidate-source");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "canonical.css"), `src: url(${app}/font.woff2);\n`);
  assert.equal(await assertCanonicalInstalledBuildReferences({
    generatedRoot: generated,
    canonicalAppRoot: app,
    forbiddenRoots: [staged],
  }), true);
  await writeFile(join(generated, "leaked.css"), `src: url(${staged}/font.woff2);\n`);
  await assert.rejects(
    assertCanonicalInstalledBuildReferences({
      generatedRoot: generated,
      canonicalAppRoot: app,
      forbiddenRoots: [staged],
    }),
    /noncanonical build root|outside the canonical app/,
  );
});
