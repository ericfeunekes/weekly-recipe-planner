import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  access,
  chmod,
  copyFile,
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
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import {
  createActivationId,
  createReleaseArtifact,
  createReleasePointer,
  deriveInstalledOperatorPath,
  derivePlannerReleaseLayout,
  publishReleaseArtifact,
  publishReleasePointer,
  readReleaseArtifact,
  readReleasePointer,
} from "../../scripts/support/planner-release-contract.mjs";
import { createCodexRuntimeFixture } from "../../scripts/support/codex-runtime-fixture.mjs";
import {
  RELEASE_OPERATOR_CORE_FILES,
  appendReleaseJournalEntry,
  createReleaseJournal,
  inspectReleaseTreeIdentity,
  publishInitialReleaseJournal,
  readReleaseJournal,
  replaceReleaseJournal,
  transitionReleaseJournal,
} from "../../scripts/support/planner-release-transaction.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(new URL("../../", import.meta.url).pathname);
const harnessPath = join(packageRoot, "tests", "support", "planner-release-fixture-runner.mjs");
const fakeAuthPath = join(
  packageRoot,
  "tests",
  "support",
  "fixtures",
  "codex-runtime",
  "fake-auth-app-server.mjs",
);

const FIXTURE_STORE_MODULE = String.raw`
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CURRENT_SCHEMA_VERSION = 2;

function sha256File(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function readSchemaVersion(database) {
  return Number(database.prepare("SELECT version FROM schema_version").get().version);
}

function readWorkspaceRow(database) {
  return database.prepare(
    "SELECT schema_version, planner_version, state_json FROM workspace WHERE id = 'household'",
  ).get() ?? null;
}

export function inspectVerifiedPlannerSnapshot(filename) {
  const canonical = realpathSync(resolve(filename));
  const database = new DatabaseSync(canonical, { readOnly: true });
  let schemaVersion;
  let workspace;
  try {
    const quick = database.prepare("PRAGMA quick_check").get();
    if (quick.quick_check !== "ok") throw new Error("fixture SQLite quick_check failed");
    schemaVersion = readSchemaVersion(database);
    workspace = readWorkspaceRow(database);
  } finally {
    database.close();
  }
  const metadata = statSync(canonical);
  return Object.freeze({
    filename: canonical,
    byteLength: metadata.size,
    sha256: sha256File(canonical),
    quickCheck: "ok",
    schemaVersion,
    initialized: workspace !== null,
    workspaceSchemaVersion: workspace === null ? null : Number(workspace.schema_version),
    plannerVersion: workspace === null ? null : Number(workspace.planner_version),
  });
}

export function acquirePlannerStoreWriteReservation({ filename, busyTimeoutMs = 0 }) {
  const canonical = realpathSync(resolve(filename));
  const database = new DatabaseSync(canonical);
  let active = false;
  try {
    database.exec("PRAGMA busy_timeout = " + busyTimeoutMs);
    database.exec("BEGIN IMMEDIATE");
    active = true;
  } catch (error) {
    database.close();
    throw error;
  }
  return Object.freeze({
    filename: canonical,
    createVerifiedSnapshot(destinationFilename) {
      if (!active) throw new Error("fixture reservation is closed");
      const destination = resolve(destinationFilename);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      for (const path of [destination, destination + "-wal", destination + "-shm"]) {
        if (existsSync(path)) rmSync(path, { force: true });
      }
      const reader = new DatabaseSync(canonical, { readOnly: true });
      try {
        reader.prepare("VACUUM INTO ?").run(destination);
      } finally {
        reader.close();
      }
      return inspectVerifiedPlannerSnapshot(destination);
    },
    close() {
      if (!active) return;
      active = false;
      database.exec("ROLLBACK");
      database.close();
    },
  });
}

export function openPlannerStore({ filename }) {
  const resolved = resolve(filename);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(resolved);
  database.exec("PRAGMA journal_mode = DELETE");
  const startingVersion = readSchemaVersion(database);
  if (startingVersion === 1) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("UPDATE schema_version SET version = 2");
      database.exec("UPDATE workspace SET schema_version = 2");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } else if (startingVersion !== CURRENT_SCHEMA_VERSION) {
    database.close();
    throw new Error("fixture store has an unsupported schema");
  }
  return Object.freeze({
    database,
    readWorkspace() {
      const row = readWorkspaceRow(database);
      return row === null
        ? { initialized: false }
        : {
            initialized: true,
            schemaVersion: Number(row.schema_version),
            plannerVersion: Number(row.planner_version),
            state: JSON.parse(row.state_json),
          };
    },
    close() {
      database.close();
    },
  });
}
`;

async function writeFixtureFile(root, relativePath, content) {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, content, { mode: 0o600 });
}

const DYNAMIC_PREAUTH_MODULES = Object.freeze([
  "lib/household-command-contract.ts",
  "lib/household-contract.ts",
  "lib/household-domain.ts",
  "lib/planner-api-contract.ts",
  "lib/planner-operation-contract.ts",
  "lib/planner-tool-contract.ts",
  "lib/sourced-recipe-contract.ts",
  "server/runtime/codex-follow-up/deployment.ts",
  "server/runtime/codex-follow-up/launcher.ts",
  "server/runtime/codex-follow-up/compatibility.ts",
  "server/runtime/codex-follow-up/capability-probe.ts",
]);

async function createCandidateRepository(root, { dynamicPreAuth = false } = {}) {
  const candidateRoot = await realpath(root);
  const candidateFiles = new Set([
    ...RELEASE_OPERATOR_CORE_FILES,
    ...(dynamicPreAuth ? DYNAMIC_PREAUTH_MODULES : []),
  ]);
  for (const relativePath of candidateFiles) {
    const destination = join(candidateRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(packageRoot, relativePath), destination);
  }
  await writeFixtureFile(
    candidateRoot,
    "package.json",
    `${JSON.stringify({
      name: "planner-release-composition-fixture",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        build: "node scripts/build.mjs",
        lint: "node --check scripts/build.mjs && node --check scripts/noop.mjs && node --experimental-strip-types --check server/store/sqlite-store.ts",
        typecheck: "node scripts/noop.mjs",
        test: "node scripts/noop.mjs",
      },
    }, null, 2)}\n`,
  );
  await writeFixtureFile(
    candidateRoot,
    "package-lock.json",
    `${JSON.stringify({
      name: "planner-release-composition-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "planner-release-composition-fixture",
          version: "1.0.0",
        },
      },
    }, null, 2)}\n`,
  );
  await writeFixtureFile(
    candidateRoot,
    "scripts/build.mjs",
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('dist', { recursive: true });",
      "await writeFile('dist/build.json', JSON.stringify({ cwd: process.cwd() }));",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(candidateRoot, "scripts/noop.mjs", "process.exitCode = 0;\n");
  await writeFixtureFile(
    candidateRoot,
    "server/store/sqlite-store.ts",
    FIXTURE_STORE_MODULE,
  );
  await writeFixtureFile(
    candidateRoot,
    "deployment/codex/config.toml",
    [
      'forced_login_method = "chatgpt"',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    candidateRoot,
    "deployment/codex/AGENTS.md",
    "# Fixture embedded planner\nUse planner tools only.\n",
  );

  await execFileAsync("git", ["init", "--quiet"], { cwd: candidateRoot });
  await execFileAsync("git", ["config", "user.name", "Planner Release Fixture"], {
    cwd: candidateRoot,
  });
  await execFileAsync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: candidateRoot,
  });
  await execFileAsync("git", ["add", "."], { cwd: candidateRoot });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: candidateRoot,
  });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: candidateRoot,
  });
  const baselineCommit = stdout.trim();
  await writeFixtureFile(
    candidateRoot,
    "deployment/release/first-install-baseline.json",
    `${JSON.stringify({ schemaVersion: 1, baselineCommit }, null, 2)}\n`,
  );
  return Object.freeze({ candidateRoot, baselineCommit });
}

function createPlannerData(filename) {
  const database = new DatabaseSync(filename);
  try {
    database.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
      CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        planner_version INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );
      INSERT INTO workspace (id, schema_version, planner_version, state_json)
      VALUES ('household', 1, 7, '{"activeWeekId":"2026-07-06"}');
    `);
  } finally {
    database.close();
  }
}

async function reserveUnusedPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

function runFixtureCommand(args, environment, timeoutMs = 180_000) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      harnessPath,
      ...args,
    ], {
      cwd: packageRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveChild({ exitCode, signal, stdout, stderr });
    });
  });
}

function runInstalledOperatorCommand(operatorRoot, args, environment, timeoutMs = 180_000) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      join(operatorRoot, "scripts", "planner-release.mjs"),
      ...args,
    ], {
      cwd: operatorRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveChild({ exitCode, signal, stdout, stderr });
    });
  });
}

function lastJsonLine(output) {
  const lines = output.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1));
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

async function removeFixtureTree(root) {
  if (!await pathExists(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await chmod(current, 0o700);
      for (const child of await readdir(current)) pending.push(join(current, child));
    } else if (metadata.isFile()) {
      await chmod(current, 0o600);
    }
  }
  await rm(root, { recursive: true, force: true });
}

async function createRetainedAgentSource(home, { fixtureVariant = null } = {}) {
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [layout.root, layout.releasesRoot, layout.transactionRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  await publishInitialReleaseJournal(
    layout.journalPath,
    createReleaseJournal(activationId),
  );
  let journal = await readReleaseJournal(layout.journalPath, activationId);
  for (const event of [
    "begin",
    "park_previous",
    "select_app",
    "select_data",
    "abort",
    "restore_app",
    "restore_data",
    "publish_rollback",
  ]) {
    journal = await transitionReleaseJournal(
      layout.journalPath,
      journal,
      event,
      event === "publish_rollback" ? { hashChainValid: true } : {},
    );
  }
  const source = join(layout.transactionRoot, "superseded-agent");
  await mkdir(source, { mode: 0o700 });
  await Promise.all([
    writeFile(join(source, "auth.json"), "fixture-auth-sentinel\n", { mode: 0o600 }),
    writeFile(join(source, "config.toml"), "# retained config\n", { mode: 0o600 }),
    writeFile(join(source, "AGENTS.md"), "# Retained instructions\n", { mode: 0o600 }),
    ...(fixtureVariant === null
      ? []
      : [writeFile(join(source, ".fixture-variant"), `${fixtureVariant}\n`, { mode: 0o600 })]),
  ]);
  return source;
}

async function createReleaseE2eFixture(
  t,
  prefix = "planner-release-real-e2e-",
  { dynamicPreAuth = false } = {},
) {
  const runtime = dynamicPreAuth
    ? await createCodexRuntimeFixture({ authenticated: true, variant: "compatible-a" })
    : null;
  const root = runtime?.root ?? await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => removeFixtureTree(root));
  const home = runtime?.normalHome ?? join(root, "home");
  const candidateDirectory = join(root, "candidate");
  if (runtime === null) await mkdir(home, { mode: 0o700 });
  else await rm(runtime.codexHome, { recursive: true, force: true });
  await mkdir(candidateDirectory, { mode: 0o700 });
  const { candidateRoot, baselineCommit } = await createCandidateRepository(
    candidateDirectory,
    { dynamicPreAuth },
  );
  const dataSource = join(root, "planner.sqlite");
  createPlannerData(dataSource);
  const agentSource = await createRetainedAgentSource(home, {
    fixtureVariant: dynamicPreAuth ? "compatible-a" : null,
  });
  const invocationLog = join(root, "operator-invocations.jsonl");
  const exactNode = await execFileAsync("mise", [
    "exec",
    "-C",
    "/private/tmp",
    "node@22.15.0",
    "--",
    "node",
    "-p",
    "process.execPath",
  ], { env: process.env });
  const fixtureBin = join(root, "fixture-bin");
  await mkdir(fixtureBin, { mode: 0o700 });
  const forbiddenMise = join(fixtureBin, "mise");
  await writeFile(forbiddenMise, [
    "#!/bin/sh",
    "echo 'stage ignored PLANNER_NODE_FLOOR_EXECUTABLE' >&2",
    "exit 97",
    "",
  ].join("\n"), { mode: 0o700 });
  const environment = {
    ...process.env,
    ...(runtime?.environment ?? {}),
    HOME: home,
    PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
    PLANNER_LEGACY_HTTP_PORT: String(await reserveUnusedPort()),
    PLANNER_RELEASE_FIXTURE_ENTRY_ROOT: candidateRoot,
    PLANNER_RELEASE_FIXTURE_HARNESS: harnessPath,
    PLANNER_RELEASE_FIXTURE_FAKE_AUTH: fakeAuthPath,
    PLANNER_RELEASE_FIXTURE_INVOCATIONS: invocationLog,
    PLANNER_NODE_FLOOR_EXECUTABLE: (await realpath(exactNode.stdout.trim())),
    ...(dynamicPreAuth ? { PLANNER_RELEASE_FIXTURE_DYNAMIC_PREAUTH: "1" } : {}),
  };
  return Object.freeze({
    root,
    home,
    candidateRoot,
    baselineCommit,
    dataSource,
    agentSource,
    invocationLog,
    environment,
  });
}

async function stageFixtureRelease(fixture, dataSource = fixture.dataSource) {
  const args = [
    "stage",
    "--candidate-source",
    fixture.candidateRoot,
    "--baseline-commit",
    fixture.baselineCommit,
    "--data-source",
    dataSource,
  ];
  const rootLayout = derivePlannerReleaseLayout(fixture.home);
  if (!await pathExists(rootLayout.currentPath)) {
    args.push("--agent-source", fixture.agentSource);
  }
  const staged = await runFixtureCommand(args, fixture.environment);
  assert.equal(staged.signal, null, staged.stderr);
  assert.equal(staged.exitCode, 0, staged.stderr);
  const output = lastJsonLine(staged.stdout);
  const layout = derivePlannerReleaseLayout(fixture.home, output.activationId);
  const stage = await readReleaseArtifact(layout.stagePath, {
    artifactType: "stage",
    activationId: output.activationId,
  });
  assert.equal(stage.projection.preflight.candidate.lint, true);
  assert.equal(stage.projection.preflight.baseline.lint, false);
  if (stage.projection.agentSource !== null) {
    const durableReleaseState = await Promise.all([
      readFile(layout.stagePath, "utf8"),
      readFile(layout.journalPath, "utf8"),
    ]).then((values) => values.join("\n"));
    const credentialSentinel = "fixture-auth-sentinel\n";
    assert.equal(durableReleaseState.includes(credentialSentinel.trim()), false);
    assert.equal(
      durableReleaseState.includes(
        createHash("sha256").update(credentialSentinel).digest("hex"),
      ),
      false,
    );
  }
  return Object.freeze({
    ...output,
    layout,
  });
}

async function publishLegacyPreAdoptionPending(home) {
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  await mkdir(layout.transactionRoot, { recursive: true, mode: 0o700 });
  const operatorSha256 = "a".repeat(64);
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      operatorSource: { files: 1, bytes: 1, sha256: operatorSha256 },
      dataSource: { canonicalPath: "/fixture/legacy-source.sqlite", initialized: true },
      firstInstall: true,
      agentSource: null,
    },
  });
  await publishReleaseArtifact(layout.stagePath, stage);
  let journal = createReleaseJournal(activationId);
  await publishInitialReleaseJournal(layout.journalPath, journal);
  let next = appendReleaseJournalEntry(journal, {
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
  const predecessor = createReleasePointer({
    pointerType: "pending",
    generation: 1,
    activationId: createActivationId(),
    operatorSha256,
    updatedAt: "2026-07-13T11:59:59.000Z",
  });
  await publishReleasePointer(layout.pendingPath, predecessor, 0);
  const pending = createReleasePointer({
    pointerType: "pending",
    generation: 2,
    activationId,
    operatorSha256,
    updatedAt: "2026-07-13T12:00:01.000Z",
  });
  const effectId = "3:publish_pending";
  const migrationId = createActivationId();
  next = appendReleaseJournalEntry(journal, {
    at: "2026-07-13T12:00:02.000Z",
    kind: "intent",
    effectId,
    effect: "publish_pending",
    expected: { pre: predecessor, post: pending },
    replay: {
      schemaVersion: 1,
      kind: "pointer-publication",
      path: layout.pendingPath,
      pointer: pending,
      expectedPre: predecessor,
    },
    reconciledFrom: {
      migrationId,
      receiptPath: join(layout.releasesRoot, "legacy-authority", "handoff-intent.json"),
      receiptSha256: "b".repeat(64),
      effectOccurredAt: "2026-07-13T12:00:01.000Z",
    },
  });
  await replaceReleaseJournal(layout.journalPath, journal, next);
  journal = next;
  await publishReleasePointer(layout.pendingPath, pending, predecessor.generation);
  next = appendReleaseJournalEntry(journal, {
    at: "2026-07-13T12:00:03.000Z",
    kind: "completed",
    effectId,
    effect: "publish_pending",
    observed: pending,
    reconciledFrom: {
      migrationId,
      receiptPath: join(layout.releasesRoot, "legacy-authority", "handoff-complete.json"),
      receiptSha256: "c".repeat(64),
      effectOccurredAt: "2026-07-13T12:00:01.000Z",
    },
  });
  await replaceReleaseJournal(layout.journalPath, journal, next);
  return Object.freeze({ activationId, layout, stage, journal: next, pending, predecessor });
}

async function readJsonTextRecursively(root) {
  const pending = [root];
  const bodies = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        bodies.push(await readFile(path, "utf8"));
      }
    }
  }
  return bodies.join("\n");
}

test("installed replacement operator retires an exact pre-adoption pending without a pointer gap", {
  timeout: 240_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t, "planner-release-supersession-e2e-");
  const staged = await stageFixtureRelease(fixture);
  const superseded = await publishLegacyPreAdoptionPending(fixture.home);
  const activated = await runFixtureCommand([
    "activate",
    "--transaction",
    staged.activationId,
    "--authorized",
    "--supersede-pending",
    superseded.activationId,
  ], fixture.environment);

  assert.equal(activated.signal, null, activated.stderr);
  assert.equal(activated.exitCode, 0, activated.stderr);
  assert.deepEqual(lastJsonLine(activated.stdout), {
    activationId: staged.activationId,
    state: "committed",
  });
  const current = await readReleasePointer(staged.layout.currentPath, {
    pointerType: "current",
  });
  assert.equal(current.activationId, staged.activationId);
  await assert.rejects(readReleasePointer(staged.layout.pendingPath), /ENOENT/u);

  const retiredJournal = await readReleaseJournal(
    superseded.layout.journalPath,
    superseded.activationId,
  );
  assert.equal(retiredJournal.state, "intervention_required");
  assert.equal(retiredJournal.entries.at(-1).replacementActivationId, staged.activationId);
  assert.equal(retiredJournal.entries.at(-1).replacementStageSha256,
    (await readReleaseArtifact(staged.layout.stagePath, {
      artifactType: "stage",
      activationId: staged.activationId,
    })).sha256);
  const replacementJournal = await readReleaseJournal(
    staged.layout.journalPath,
    staged.activationId,
  );
  const checkpoint = replacementJournal.entries.find(
    (entry) => entry.kind === "checkpoint" && entry.name === "pending_supersession",
  );
  assert.equal(checkpoint.projection.supersededPointer.sha256, superseded.pending.sha256);
  assert.equal(checkpoint.projection.replacementPointer.generation, 3);
  assert.equal(replacementJournal.entries.some((entry) =>
    entry.kind === "completed" && entry.effect === "retire_superseded_pending"), true);
  assert.equal(replacementJournal.entries.some((entry) =>
    entry.kind === "completed" && entry.effect === "replace_pending"), true);
  assert.equal(await pathExists(fixture.agentSource), false);
  assert.equal(await pathExists(join(staged.layout.agentRoot, "auth.json")), true);

  const invocations = (await readFile(fixture.invocationLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const boundActivation = invocations.filter((entry) =>
    entry.command === "activate" && entry.operatorSha256 !== null);
  assert.equal(boundActivation.length, 1);
  assert.equal(boundActivation[0].pendingSupersessionCheckpointAtStart, false);
  assert.equal(
    boundActivation[0].entryRoot,
    join(staged.layout.operatorRoot, boundActivation[0].operatorSha256),
  );
});

test("first install adopts retained credentials before default dynamic auth readiness", {
  timeout: 300_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(
    t,
    "planner-release-dynamic-auth-e2e-",
    { dynamicPreAuth: true },
  );
  const staged = await stageFixtureRelease(fixture);
  const activated = await runFixtureCommand([
    "activate",
    "--transaction",
    staged.activationId,
    "--authorized",
  ], fixture.environment);

  assert.equal(activated.signal, null, activated.stderr);
  assert.equal(activated.exitCode, 0, activated.stderr);
  assert.deepEqual(lastJsonLine(activated.stdout), {
    activationId: staged.activationId,
    state: "committed",
  });
  const journal = await readReleaseJournal(staged.layout.journalPath, staged.activationId);
  const adoptionIndex = journal.entries.findIndex((entry) =>
    entry.kind === "completed" && entry.effect === "adopt_authenticated_agent");
  const authIndex = journal.entries.findIndex((entry) =>
    entry.kind === "completed" && entry.effect === "produce_auth_lifecycle");
  assert.equal(adoptionIndex >= 0 && authIndex > adoptionIndex, true);
  assert.equal(await pathExists(fixture.agentSource), false);
  assert.equal(
    await readFile(join(staged.layout.agentRoot, "auth.json"), "utf8"),
    "fixture-auth-sentinel\n",
  );
  assert.equal(
    await readFile(join(staged.layout.agentRoot, "config.toml"), "utf8"),
    await readFile(join(fixture.candidateRoot, "deployment/codex/config.toml"), "utf8"),
  );
  assert.equal(
    await readFile(join(staged.layout.agentRoot, "AGENTS.md"), "utf8"),
    await readFile(join(fixture.candidateRoot, "deployment/codex/AGENTS.md"), "utf8"),
  );

  const current = await readReleasePointer(staged.layout.currentPath, {
    pointerType: "current",
  });
  assert.equal(current.activationId, staged.activationId);
  const activation = await readReleaseArtifact(staged.layout.activationPath, {
    artifactType: "activation",
    activationId: staged.activationId,
    operatorSha256: current.operatorSha256,
  });
  assert.equal(current.activationSha256, activation.sha256);
  const auth = await readReleaseArtifact(staged.layout.authLifecyclePath, {
    artifactType: "auth-lifecycle",
    activationId: staged.activationId,
    operatorSha256: current.operatorSha256,
  });
  assert.equal(auth.projection.outcome, "authenticated");
  assert.equal(auth.projection.environment.authReadbackProcessCount, 1);
  assert.equal(auth.projection.environment.dedicatedHomeReadbackCount, 1);
  assert.deepEqual(auth.projection.account, { kind: "chatgpt" });
  assert.deepEqual(auth.projection.readiness, {
    existingDedicatedCredentialsReused: true,
    freshProcessReadback: true,
    proactiveRefreshReadback: true,
    credentialMutationRequestsAllowed: false,
  });
  assert.equal(auth.projection.runtimeIdentity.executableVersion, "fake-codex compatible-a");
  assert.equal(auth.projection.schemaBinding.contractKind, "authenticatedReadback");
  for (const key of [
    "rawSchemaBundleSha256",
    "compatibilitySchemaFingerprint",
    "authSchemaFingerprint",
  ]) {
    assert.match(auth.projection.schemaBinding[key], /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(auth.projection.schemaBinding[key], /^([a-f0-9])\1{63}$/u);
  }

  const protocol = (await readFile(
    join(staged.layout.agentRoot, ".fixture-invocations.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.authOperator === true);
  assert.deepEqual(protocol.map((entry) => entry.event), [
    "auth-initialize",
    "auth-account-read",
  ]);
  assert.equal(protocol[1].refreshToken, true);

  const credentialSentinel = "fixture-auth-sentinel\n";
  const durableText = await readJsonTextRecursively(staged.layout.releasesRoot);
  const commandText = `${activated.stdout}\n${activated.stderr}`;
  for (const secret of [
    credentialSentinel.trim(),
    createHash("sha256").update(credentialSentinel).digest("hex"),
    "must-not-leak",
  ]) {
    assert.equal(durableText.includes(secret), false);
    assert.equal(commandText.includes(secret), false);
  }
});

test("first-install auth-readback failure restores the exact retained agent home", {
  timeout: 240_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t, "planner-release-auth-compensation-e2e-");
  const staged = await stageFixtureRelease(fixture);
  const failed = await runFixtureCommand([
    "activate",
    "--transaction",
    staged.activationId,
    "--authorized",
  ], {
    ...fixture.environment,
    PLANNER_RELEASE_FIXTURE_AUTH_VARIANT: "refresh-failure",
  });

  assert.equal(failed.signal, null, failed.stderr);
  assert.equal(failed.exitCode, 5, failed.stderr);
  assert.deepEqual(lastJsonLine(failed.stdout), {
    activationId: staged.activationId,
    state: "rolled_back",
    failure: {
      effect: "produce_auth_lifecycle",
      code: "AUTH_PROTOCOL",
    },
  });
  assert.equal(
    (await readReleaseJournal(staged.layout.journalPath, staged.activationId)).state,
    "rolled_back",
  );
  assert.equal(await pathExists(staged.layout.agentRoot), false);
  assert.equal(
    await readFile(join(fixture.agentSource, "auth.json"), "utf8"),
    "{}\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "config.toml"), "utf8"),
    "# retained config\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "AGENTS.md"), "utf8"),
    "# Retained instructions\n",
  );
  assert.equal(
    await pathExists(join(fixture.agentSource, ".fake-auth-state.json")),
    true,
  );
  const retainedCandidate = join(staged.layout.transactionRoot, "superseded-agent");
  assert.equal(
    await readFile(join(retainedCandidate, "config.toml"), "utf8"),
    [
      'forced_login_method = "chatgpt"',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
    ].join("\n"),
  );
  assert.equal(
    await readFile(join(retainedCandidate, "AGENTS.md"), "utf8"),
    "# Fixture embedded planner\nUse planner tools only.\n",
  );
  assert.equal(await pathExists(staged.layout.currentPath), false);
});

test("first-install adoption failure compensates its abandoned partial move", {
  timeout: 240_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t, "planner-release-adoption-compensation-e2e-");
  const staged = await stageFixtureRelease(fixture);
  const failed = await runFixtureCommand([
    "activate",
    "--transaction",
    staged.activationId,
    "--authorized",
  ], {
    ...fixture.environment,
    PLANNER_RELEASE_FIXTURE_AGENT_ADOPTION_FAILURE_POINT: "agent_selected",
  });

  assert.equal(failed.signal, null, failed.stderr);
  assert.equal(failed.exitCode, 5, failed.stderr);
  assert.deepEqual(lastJsonLine(failed.stdout), {
    activationId: staged.activationId,
    state: "rolled_back",
    failure: {
      effect: "adopt_authenticated_agent",
      code: "ACTIVATION_FAILED",
    },
  });
  const journal = await readReleaseJournal(staged.layout.journalPath, staged.activationId);
  assert.equal(journal.state, "rolled_back");
  assert.equal(journal.entries.some((entry) =>
    entry.kind === "abandoned" && entry.effect === "adopt_authenticated_agent"), true);
  assert.equal(await pathExists(staged.layout.agentRoot), false);
  assert.equal(
    await readFile(join(fixture.agentSource, "auth.json"), "utf8"),
    "fixture-auth-sentinel\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "config.toml"), "utf8"),
    "# retained config\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "AGENTS.md"), "utf8"),
    "# Retained instructions\n",
  );
  const retainedCandidate = join(staged.layout.transactionRoot, "superseded-agent");
  assert.equal(await pathExists(join(retainedCandidate, "config.toml")), true);
  assert.equal(await pathExists(join(retainedCandidate, "AGENTS.md")), true);
  assert.equal(await pathExists(staged.layout.currentPath), false);
});

test("first-install pre-intent adoption failure compensates without inventing an adoption intent", {
  timeout: 240_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t, "planner-preintent-e2e-");
  const staged = await stageFixtureRelease(fixture);
  const failed = await runFixtureCommand([
    "activate",
    "--transaction",
    staged.activationId,
    "--authorized",
  ], {
    ...fixture.environment,
    PLANNER_RELEASE_FIXTURE_THROW_POINT: "before_intent:adopt_authenticated_agent",
  });

  assert.equal(failed.signal, null, failed.stderr);
  assert.equal(failed.exitCode, 5, failed.stderr);
  assert.deepEqual(lastJsonLine(failed.stdout), {
    activationId: staged.activationId,
    state: "rolled_back",
    failure: {
      effect: "activation",
      code: "ACTIVATION_FAILED",
    },
  });
  const journal = await readReleaseJournal(staged.layout.journalPath, staged.activationId);
  assert.equal(journal.state, "rolled_back");
  assert.equal(journal.entries.some((entry) =>
    entry.kind === "intent" && entry.effect === "adopt_authenticated_agent"), false);
  assert.equal(await pathExists(staged.layout.agentRoot), false);
  assert.equal(
    await readFile(join(fixture.agentSource, "auth.json"), "utf8"),
    "fixture-auth-sentinel\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "config.toml"), "utf8"),
    "# retained config\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "AGENTS.md"), "utf8"),
    "# Retained instructions\n",
  );
  const retainedCandidate = join(staged.layout.transactionRoot, "superseded-agent");
  assert.equal(await pathExists(join(retainedCandidate, "config.toml")), true);
  assert.equal(await pathExists(join(retainedCandidate, "AGENTS.md")), true);
  assert.equal(await pathExists(staged.layout.currentPath), false);
});

test("first-install pre-effect candidate selection resumes its exact zero-adoption compensation", {
  timeout: 240_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t, "planner-preselect-compensation-e2e-");
  const staged = await stageFixtureRelease(fixture);
  const interrupted = await runFixtureCommand([
    "activate",
    "--transaction",
    staged.activationId,
    "--authorized",
  ], {
    ...fixture.environment,
    PLANNER_RELEASE_FIXTURE_THROW_POINT: "after_intent:select_candidate_app",
    PLANNER_RELEASE_FIXTURE_AGENT_ADOPTION_FAILURE_POINT: "candidate_unmaterialized_marked",
  });

  assert.equal(interrupted.signal, null, interrupted.stderr);
  assert.notEqual(interrupted.exitCode, 0, interrupted.stderr);
  assert.match(interrupted.stderr, /candidate_unmaterialized_marked/u);
  let journal = await readReleaseJournal(staged.layout.journalPath, staged.activationId);
  assert.equal(journal.state, "restoring");
  const selectIntents = journal.entries.filter((entry) =>
    entry.kind === "intent" && entry.effect === "select_candidate_app");
  assert.equal(selectIntents.length, 1);
  assert.equal(journal.entries.filter((entry) =>
    entry.kind === "abandoned" && entry.effectId === selectIntents[0].effectId &&
    entry.reason === "precommit_compensation").length, 1);
  assert.equal(journal.entries.some((entry) =>
    entry.kind === "intent" && entry.effect === "adopt_authenticated_agent"), false);
  const restoreIntents = journal.entries.filter((entry) =>
    entry.kind === "intent" && entry.effect === "restore_previous_app");
  assert.equal(restoreIntents.length, 1);
  assert.equal(journal.entries.some((entry) =>
    ["completed", "abandoned"].includes(entry.kind) &&
    entry.effectId === restoreIntents[0].effectId), false);

  const recovered = await runFixtureCommand([
    "recover",
    "--transaction",
    staged.activationId,
  ], fixture.environment);
  assert.equal(recovered.signal, null, recovered.stderr);
  assert.equal(recovered.exitCode, 5, recovered.stderr);
  assert.deepEqual(lastJsonLine(recovered.stdout), {
    activationId: staged.activationId,
    state: "rolled_back",
    recovered: true,
  });

  journal = await readReleaseJournal(staged.layout.journalPath, staged.activationId);
  assert.equal(journal.state, "rolled_back");
  assert.equal(journal.entries.filter((entry) =>
    entry.kind === "intent" && entry.effect === "select_candidate_app").length, 1);
  assert.equal(journal.entries.filter((entry) =>
    entry.kind === "intent" && entry.effect === "restore_previous_app").length, 1);
  assert.equal(journal.entries.filter((entry) =>
    entry.kind === "completed" && entry.effectId === restoreIntents[0].effectId).length, 1);
  assert.equal(journal.entries.some((entry) =>
    entry.kind === "intent" && entry.effect === "adopt_authenticated_agent"), false);
  for (const path of [
    staged.layout.appRoot,
    staged.layout.dataRoot,
    staged.layout.agentRoot,
    staged.layout.currentPath,
    staged.layout.pendingPath,
    join(staged.layout.transactionRoot, "candidate-agent-home"),
    join(staged.layout.transactionRoot, "superseded-agent"),
    join(staged.layout.transactionRoot, "superseded-app"),
  ]) {
    assert.equal(await pathExists(path), false, path);
  }
  assert.equal(
    await readFile(join(fixture.agentSource, "auth.json"), "utf8"),
    "fixture-auth-sentinel\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "config.toml"), "utf8"),
    "# retained config\n",
  );
  assert.equal(
    await readFile(join(fixture.agentSource, "AGENTS.md"), "utf8"),
    "# Retained instructions\n",
  );
});

test("production composition survives installed-operator crash recovery and first-install rollback", {
  timeout: 240_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t);
  const staged = await stageFixtureRelease(fixture);
  const { activationId, layout } = staged;
  assert.equal(staged.stageReceipt, layout.stagePath);

  const crashed = await runFixtureCommand([
    "activate",
    "--transaction",
    activationId,
    "--authorized",
  ], {
    ...fixture.environment,
    PLANNER_RELEASE_FIXTURE_CRASH_POINT: "after_effect:select_candidate_data",
  });
  assert.equal(crashed.signal, null, crashed.stderr);
  assert.equal(crashed.exitCode, 91, crashed.stderr);
  assert.equal((await readReleaseJournal(layout.journalPath, activationId)).state,
    "candidate_app_selected");

  const recovered = await runFixtureCommand([
    "recover",
    "--transaction",
    activationId,
  ], fixture.environment);
  assert.equal(recovered.signal, null, recovered.stderr);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.deepEqual(lastJsonLine(recovered.stdout), {
    activationId,
    state: "committed",
    recovered: true,
  });
  const currentBeforeRollback = await readReleasePointer(layout.currentPath, {
    pointerType: "current",
  });
  assert.equal(currentBeforeRollback.activationId, activationId);
  assert.equal(currentBeforeRollback.rollbackSha256, null);
  const activation = await readReleaseArtifact(layout.activationPath, {
    artifactType: "activation",
    activationId,
    operatorSha256: currentBeforeRollback.operatorSha256,
  });
  assert.equal(activation.projection.selectedDataSchemaVersion, 2);
  assert.equal(activation.projection.selectedPlannerVersion, 7);
  assert.equal(activation.projection.qaEvidenceVerifiedAfterQa, true);
  assert.equal(activation.projection.codexActivationVerifiedAfterQa, true);
  const qa = await readReleaseArtifact(layout.qaPath, {
    artifactType: "qa",
    activationId,
  });
  assert.deepEqual(qa.projection.releaseEvidence, {
    relativePath: "installed-release/evidence/manifest.json",
    sha256: "7".repeat(64),
  });

  const selectedAfterCommit = new DatabaseSync(join(layout.dataRoot, "planner.sqlite"));
  try {
    selectedAfterCommit.exec(
      "UPDATE workspace SET planner_version = planner_version + 1 WHERE id = 'household'",
    );
  } finally {
    selectedAfterCommit.close();
  }

  const rolledBack = await runFixtureCommand([
    "rollback",
    "--transaction",
    activationId,
  ], fixture.environment);
  assert.equal(rolledBack.signal, null, rolledBack.stderr);
  assert.equal(rolledBack.exitCode, 5, rolledBack.stderr);
  assert.deepEqual(lastJsonLine(rolledBack.stdout), {
    activationId,
    state: "rolled_back",
  });
  const rollback = await readReleaseArtifact(layout.rollbackPath, {
    artifactType: "rollback",
    activationId,
    predecessorSha256: activation.sha256,
    operatorSha256: currentBeforeRollback.operatorSha256,
  });
  assert.equal(rollback.projection.automatic, true);
  assert.equal(rollback.projection.firstInstallCandidatePairRetained, true);
  assert.equal(rollback.projection.restoredInactiveCodex, true);
  const currentAfterRollback = await readReleasePointer(layout.currentPath, {
    pointerType: "current",
  });
  assert.equal(currentAfterRollback.activationId, activationId);
  assert.equal(currentAfterRollback.activationSha256, activation.sha256);
  assert.equal(currentAfterRollback.rollbackSha256, rollback.sha256);
  assert.equal(await pathExists(join(layout.appRoot, "dist", "build.json")), true);
  assert.equal(await pathExists(join(layout.dataRoot, "planner.sqlite")), true);
  assert.equal(await pathExists(join(layout.agentRoot, ".fake-auth-state.json")), false);
  assert.equal(await pathExists(join(
    layout.transactionRoot,
    "superseded-agent-postcommit",
    ".fake-auth-state.json",
  )), true);
  assert.equal((await readReleaseJournal(layout.journalPath, activationId)).state, "rolled_back");

  const retainedDatabase = new DatabaseSync(
    join(layout.dataRoot, "planner.sqlite"),
    { readOnly: true },
  );
  try {
    assert.equal(retainedDatabase.prepare(
      "SELECT planner_version FROM workspace WHERE id = 'household'",
    ).get().planner_version, 8);
  } finally {
    retainedDatabase.close();
  }

  const sourceDatabase = new DatabaseSync(fixture.dataSource, { readOnly: true });
  try {
    assert.equal(sourceDatabase.prepare("SELECT version FROM schema_version").get().version, 1);
    assert.equal(sourceDatabase.prepare(
      "SELECT schema_version FROM workspace WHERE id = 'household'",
    ).get().schema_version, 1);
  } finally {
    sourceDatabase.close();
  }

  const invocations = (await readFile(fixture.invocationLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  const bound = invocations.filter((entry) => entry.operatorSha256 !== null);
  assert.deepEqual(bound.map((entry) => entry.command), ["activate", "recover", "rollback"]);
  assert.equal(new Set(bound.map((entry) => entry.pid)).size, 3);
  assert.equal(bound.every((entry) =>
    entry.entryRoot === join(layout.operatorRoot, entry.operatorSha256)), true);
});

test("a later release refuses post-commit writes without exact authorization and retains them on rollback", {
  timeout: 300_000,
}, async (t) => {
  const fixture = await createReleaseE2eFixture(t, "planner-release-guard-e2e-");
  const first = await stageFixtureRelease(fixture);
  const firstActivation = await runFixtureCommand([
    "activate",
    "--transaction",
    first.activationId,
    "--authorized",
  ], fixture.environment);
  assert.equal(firstActivation.signal, null, firstActivation.stderr);
  assert.equal(firstActivation.exitCode, 0, firstActivation.stderr);
  assert.deepEqual(lastJsonLine(firstActivation.stdout), {
    activationId: first.activationId,
    state: "committed",
  });
  const firstCurrent = await readReleasePointer(first.layout.currentPath, {
    pointerType: "current",
  });
  const firstReceipt = await readReleaseArtifact(first.layout.activationPath, {
    artifactType: "activation",
    activationId: first.activationId,
    operatorSha256: firstCurrent.operatorSha256,
  });

  const second = await stageFixtureRelease(
    fixture,
    join(first.layout.dataRoot, "planner.sqlite"),
  );
  const secondActivation = await runFixtureCommand([
    "activate",
    "--transaction",
    second.activationId,
    "--authorized",
  ], fixture.environment);
  assert.equal(secondActivation.signal, null, secondActivation.stderr);
  assert.equal(secondActivation.exitCode, 0, secondActivation.stderr);
  assert.deepEqual(lastJsonLine(secondActivation.stdout), {
    activationId: second.activationId,
    state: "committed",
  });
  const secondCurrent = await readReleasePointer(second.layout.currentPath, {
    pointerType: "current",
  });
  const secondReceipt = await readReleaseArtifact(second.layout.activationPath, {
    artifactType: "activation",
    activationId: second.activationId,
    operatorSha256: secondCurrent.operatorSha256,
  });
  for (const [label, path] of [
    ["selected candidate", second.layout.appRoot],
    ["parked previous", second.layout.parkedCurrentAppRoot],
  ]) {
    const metadata = await lstat(path);
    assert.equal(metadata.isSymbolicLink(), false, `${label} app root became a link`);
    assert.equal(metadata.isDirectory(), true, `${label} app root is not a directory`);
    assert.equal(metadata.mode & 0o777, 0o500, `${label} app root is not frozen`);
    assert.equal(metadata.uid, process.getuid(), `${label} app root changed ownership`);
  }

  const selected = new DatabaseSync(join(second.layout.dataRoot, "planner.sqlite"));
  try {
    selected.exec(
      "UPDATE workspace SET planner_version = planner_version + 1 WHERE id = 'household'",
    );
  } finally {
    selected.close();
  }

  const operatorRoot = deriveInstalledOperatorPath(
    second.layout,
    secondCurrent.operatorSha256,
  );
  const refused = await runInstalledOperatorCommand(operatorRoot, [
    "rollback",
    "--transaction",
    second.activationId,
  ], fixture.environment);
  assert.equal(refused.signal, null, refused.stderr);
  assert.equal(refused.exitCode, 2, refused.stderr);
  const authorizationMatch = refused.stderr.match(
    /--authorize-data-loss ([a-f0-9-]+:[a-f0-9]{64}:[a-f0-9]{64})\./u,
  );
  assert.notEqual(authorizationMatch, null, refused.stderr);
  const authorization = authorizationMatch[1];
  assert.equal(authorization.startsWith(`${second.activationId}:`), true);
  assert.equal(
    (await readReleasePointer(second.layout.currentPath, { pointerType: "current" })).sha256,
    secondCurrent.sha256,
  );

  const authorized = await runInstalledOperatorCommand(operatorRoot, [
    "rollback",
    "--transaction",
    second.activationId,
    "--authorize-data-loss",
    authorization,
  ], fixture.environment);
  assert.equal(authorized.signal, null, authorized.stderr);
  assert.equal(authorized.exitCode, 5, authorized.stderr);
  assert.deepEqual(lastJsonLine(authorized.stdout), {
    activationId: second.activationId,
    state: "rolled_back",
  });
  const rollback = await readReleaseArtifact(second.layout.rollbackPath, {
    artifactType: "rollback",
    activationId: second.activationId,
    predecessorSha256: secondReceipt.sha256,
    operatorSha256: secondCurrent.operatorSha256,
  });
  assert.equal(rollback.projection.automatic, false);
  assert.equal(rollback.projection.newerDataRetained, true);
  const restoredCurrent = await readReleasePointer(second.layout.currentPath, {
    pointerType: "current",
  });
  assert.equal(restoredCurrent.activationId, first.activationId);
  assert.equal(restoredCurrent.activationSha256, firstReceipt.sha256);
  assert.equal(restoredCurrent.rollbackSha256, rollback.sha256);
  assert.deepEqual(
    await inspectReleaseTreeIdentity(second.layout.appRoot),
    firstReceipt.projection.app,
  );
  const restoredAppMetadata = await lstat(second.layout.appRoot);
  assert.equal(restoredAppMetadata.mode & 0o777, 0o500);
  assert.equal(restoredAppMetadata.uid, process.getuid());

  const restored = new DatabaseSync(
    join(second.layout.dataRoot, "planner.sqlite"),
    { readOnly: true },
  );
  try {
    assert.equal(restored.prepare(
      "SELECT planner_version FROM workspace WHERE id = 'household'",
    ).get().planner_version, 7);
  } finally {
    restored.close();
  }
  const retained = new DatabaseSync(join(
    second.layout.supersededDataRoot,
    rollback.projection.currentStoreSha256,
    "planner.sqlite",
  ), { readOnly: true });
  try {
    assert.equal(retained.prepare(
      "SELECT planner_version FROM workspace WHERE id = 'household'",
    ).get().planner_version, 8);
  } finally {
    retained.close();
  }
});
