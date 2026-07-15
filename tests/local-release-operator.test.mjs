import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  projectPlannerReleaseCommandOutput,
  runPlannerRelease,
} from "../scripts/planner-release.mjs";
import {
  assertInstalledReleaseStartable,
  assertReleaseArtifact,
  assertReleaseArtifactChain,
  createReleaseArtifact,
  createReleasePointer,
  derivePlannerReleaseLayout,
  ensurePrivateDirectory,
  parsePlannerReleaseArguments,
  publishReleaseArtifact,
  publishReleasePointer,
  readReleasePointer,
} from "../scripts/support/planner-release-contract.mjs";
import {
  RELEASE_OPERATOR_CORE_FILES,
  copyReleaseTree,
  freezeReleaseTree,
  inventoryReleaseTree,
  runDefaultStagePreflight,
  runReleaseCommand,
} from "../scripts/support/planner-release-transaction.mjs";
import {
  createProductionAuthArtifact,
  createProductionReleaseCandidateArtifact,
} from "./support/release-evidence-fixtures.mjs";

const activationId = "11111111-1111-4111-8111-111111111111";
const baselineCommit = "c811adc2b2fd05d5573933e10ca77e60f2d0e7ba";

test("stage test failures retain a bounded stdout tail beside stderr warnings", async () => {
  await assert.rejects(
    runReleaseCommand(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'process.stderr.write("npm warn fixture\\n");',
        'process.stdout.write("discarded-prefix:" + "x".repeat(5_000));',
        'process.stdout.write("\\nTAP_FAILURE_DETAIL\\n");',
        "process.exitCode = 9;",
      ].join(" "),
    ], { failureStdoutSummary: true }),
    (error) => {
      assert.match(error.message, /npm warn fixture/);
      assert.match(error.message, /TAP_FAILURE_DETAIL/);
      assert.doesNotMatch(error.message, /discarded-prefix/);
      assert.ok(error.message.length <= 4_800);
      return true;
    },
  );
});

test("default stage preflight enables bounded diagnostics only for the candidate merge suite", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-stage-preflight-")));
  t.after(async () => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [
    home,
    layout.root,
    layout.cacheRoot,
    layout.npmCacheRoot,
    layout.releasesRoot,
    layout.transactionRoot,
    layout.candidateSourceRoot,
    layout.baselineSourceRoot,
  ]) {
    await ensurePrivateDirectory(path);
  }
  await Promise.all([
    writeFile(join(layout.candidateSourceRoot, "package.json"), '{"name":"candidate"}\n'),
    writeFile(join(layout.baselineSourceRoot, "package.json"), '{"name":"baseline"}\n'),
  ]);
  const calls = [];
  const floor = Object.freeze({
    executable: process.execPath,
    version: "v22.15.0",
    sha256: "a".repeat(64),
    npmCli: "/fixture/npm-cli.js",
    npmVersion: "11.12.1",
    npmCliSha256: "b".repeat(64),
  });
  const preflight = await runDefaultStagePreflight({
    layout,
    environment: process.env,
    inspectNodeFloor: async () => floor,
    async runCommand(_command, args, options = {}) {
      calls.push({ args: [...args], options: { ...options } });
      if (args[1] === "ls") {
        return { stdout: '{"name":"fixture","version":"1.0.0"}\n', stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });

  const mergeSuiteCalls = calls.filter(({ args }) => args[1] === "test");
  assert.equal(mergeSuiteCalls.length, 1);
  assert.equal(mergeSuiteCalls[0].options.failureStdoutSummary, true);
  assert.equal(
    calls.filter(({ args, options }) => args[1] !== "test" && options.failureStdoutSummary === true).length,
    0,
  );
  assert.equal(
    calls.every(({ options }) =>
      options.env?.NODE_OPTIONS === "--disable-warning=ExperimentalWarning"),
    true,
  );
  assert.equal(preflight.candidate.mergeSuite, true);
  assert.equal(preflight.candidate.lint, true);
  assert.equal(preflight.baseline.mergeSuite, false);
  assert.equal(preflight.baseline.lint, false);
  assert.equal(
    calls.filter(({ args }) => args[1] === "run" && args[2] === "lint").length,
    1,
  );

  let inspections = 0;
  await assert.rejects(
    runDefaultStagePreflight({
      layout,
      environment: process.env,
      inspectNodeFloor: async () => ({
        ...floor,
        sha256: (++inspections === 1 ? "a" : "c").repeat(64),
      }),
      async runCommand(_command, args) {
        return args[1] === "ls"
          ? { stdout: '{"name":"fixture","version":"1.0.0"}\n', stderr: "" }
          : { stdout: "", stderr: "" };
      },
    }),
    /runtime changed during the stage suite/,
  );
  for (const version of ["v22.14.0", "v22.16.0", process.version]) {
    if (version === "v22.15.0") continue;
    await assert.rejects(
      runDefaultStagePreflight({
        layout,
        environment: process.env,
        inspectNodeFloor: async () => ({ ...floor, version }),
        runCommand: async () => ({ stdout: "", stderr: "" }),
      }),
      /requires a verified exact v22\.15\.0 runtime/,
    );
  }
});

test("successful release commands can make unexpected stderr fatal", async () => {
  await assert.rejects(
    runReleaseCommand(process.execPath, [
      "--eval",
      'process.stderr.write("unexpected evidence warning\\n")',
    ], { requireEmptyStderr: true }),
    /unexpected stderr/,
  );
});

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

test("planner release grammar is closed and later commands accept only derived transaction IDs", () => {
  assert.deepEqual(parsePlannerReleaseArguments([
    "stage",
    "--candidate-source",
    "/tmp/candidate",
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    "/tmp/planner.sqlite",
    "--agent-source",
    "/tmp/authenticated-agent",
  ]), {
    command: "stage",
    candidateSource: "/tmp/candidate",
    baselineCommit,
    dataSource: "/tmp/planner.sqlite",
    agentSource: "/tmp/authenticated-agent",
  });
  assert.deepEqual(parsePlannerReleaseArguments([
    "activate", "--authorized", "--transaction", activationId,
  ]), {
    command: "activate",
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: false,
    supersedePending: null,
  });
  assert.deepEqual(parsePlannerReleaseArguments([
    "activate",
    "--authorized",
    "--confirm-uninitialized-authority",
    "--transaction",
    activationId,
  ]), {
    command: "activate",
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: true,
    supersedePending: null,
  });
  const supersededActivationId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(parsePlannerReleaseArguments([
    "activate",
    "--authorized",
    "--transaction",
    activationId,
    "--supersede-pending",
    supersededActivationId,
  ]), {
    command: "activate",
    transaction: activationId,
    authorized: true,
    confirmUninitializedAuthority: false,
    supersedePending: supersededActivationId,
  });
  assert.deepEqual(parsePlannerReleaseArguments(["status"]), {
    command: "status",
    transaction: null,
  });
  assert.deepEqual(parsePlannerReleaseArguments([
    "rollback",
    "--transaction",
    activationId,
    "--authorize-data-loss",
    `${activationId}:${"b".repeat(64)}:${"c".repeat(64)}`,
  ]).authorizeDataLoss, {
    activationId,
    currentStoreSha256: "b".repeat(64),
    restoreStoreSha256: "c".repeat(64),
    value: `${activationId}:${"b".repeat(64)}:${"c".repeat(64)}`,
  });

  for (const invalid of [
    [],
    ["stage", "--candidate-source", "relative", "--baseline-commit", baselineCommit, "--data-source", "/tmp/db"],
    ["stage", "--candidate-source", "/tmp/candidate", "--baseline-commit", baselineCommit, "--data-source", "/tmp/db", "--agent-source", "relative"],
    ["activate", "--transaction", activationId],
    ["activate", "--authorized", "--transaction", activationId, "--supersede-pending", "bad"],
    ["activate", "--authorized", "--transaction", activationId, "--supersede-pending", activationId],
    ["recover", "--transaction", activationId, "--data-source", "/tmp/db"],
    ["status", "--transaction", activationId, "--transaction", activationId],
    ["rollback", "--transaction", activationId, "--authorize-data-loss", `${activationId}:bad:bad`],
  ]) {
    assert.throws(() => parsePlannerReleaseArguments(invalid));
  }
});

test("direct activation output retains only the bounded compensated failure classification", () => {
  const failure = Object.freeze({
    effect: "produce_auth_lifecycle",
    code: "AUTH_PROTOCOL",
  });
  const output = projectPlannerReleaseCommandOutput(
    { command: "activate" },
    {
      activationId,
      state: "rolled_back",
      failure,
      message: "private-provider-message-DO-NOT-LEAK",
    },
  );
  assert.deepEqual(output, {
    activationId,
    state: "rolled_back",
    failure,
  });
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.failure), true);
  assert.equal(JSON.stringify(output).includes("private-provider-message"), false);
  assert.deepEqual(projectPlannerReleaseCommandOutput(
    { command: "activate" },
    {
      activationId,
      state: "rolled_back",
      failure: {
        effect: "adopt_authenticated_agent",
        code: "ACTIVATION_FAILED",
      },
    },
  ), {
    activationId,
    state: "rolled_back",
    failure: {
      effect: "adopt_authenticated_agent",
      code: "ACTIVATION_FAILED",
    },
  });

  assert.deepEqual(projectPlannerReleaseCommandOutput(
    { command: "recover" },
    { activationId, state: "rolled_back", failure },
  ), {
    activationId,
    state: "rolled_back",
    recovered: true,
  });
  assert.throws(() => projectPlannerReleaseCommandOutput(
    { command: "activate" },
    {
      activationId,
      state: "rolled_back",
      failure: { effect: "produce_auth_lifecycle", code: "private-code" },
    },
  ), /failure projection is invalid/);
  assert.throws(() => projectPlannerReleaseCommandOutput(
    { command: "activate" },
    {
      activationId,
      state: "rolled_back",
      failure: {
        effect: "produce_auth_lifecycle",
        code: "DEVICECODEABC123",
      },
    },
  ), /failure projection is invalid/);
});

test("release layout is fully HOME-derived and contains no caller-selected receipt path", () => {
  const layout = derivePlannerReleaseLayout("/tmp/private-home", activationId);
  assert.equal(layout.root, "/tmp/private-home/meal-planner");
  assert.equal(layout.appRoot, "/tmp/private-home/meal-planner/app");
  assert.equal(layout.agentRoot, "/tmp/private-home/meal-planner/agent");
  assert.equal(layout.dataRoot, "/tmp/private-home/meal-planner/data");
  assert.equal(layout.runRoot, "/tmp/private-home/meal-planner/run");
  assert.equal(
    layout.stagePath,
    `/tmp/private-home/meal-planner/releases/${activationId}/stage.json`,
  );
  assert.equal(
    layout.operatorSourceRoot,
    `/tmp/private-home/meal-planner/releases/${activationId}/operator-source`,
  );
  assert.throws(() => derivePlannerReleaseLayout("relative", activationId));
  assert.throws(() => derivePlannerReleaseLayout("/tmp/private-home", "../escape"));
});

test("release layouts share one private npm cache outside every activation transaction", () => {
  const first = derivePlannerReleaseLayout(
    "/tmp/private-home",
    "11111111-1111-4111-8111-111111111111",
  );
  const second = derivePlannerReleaseLayout(
    "/tmp/private-home",
    "22222222-2222-4222-8222-222222222222",
  );
  assert.notEqual(first.transactionRoot, second.transactionRoot);
  assert.equal(first.cacheRoot, "/tmp/private-home/meal-planner/cache");
  assert.equal(first.npmCacheRoot, "/tmp/private-home/meal-planner/cache/npm");
  assert.equal(second.npmCacheRoot, first.npmCacheRoot);
  assert.equal(first.npmCacheRoot.startsWith(`${first.transactionRoot}/`), false);
  assert.equal(second.npmCacheRoot.startsWith(`${second.transactionRoot}/`), false);
});

test("immutable receipts form a canonical self-hashed operator-bound chain", () => {
  const operatorSha256 = "d".repeat(64);
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: {
      operatorSource: { sha256: operatorSha256 },
      candidateSource: { files: 1, bytes: 1, sha256: "1".repeat(64) },
    },
  });
  const installed = createReleaseArtifact({
    artifactType: "installed",
    activationId,
    predecessorSha256: stage.sha256,
    projection: { operatorSha256, proof: "installed" },
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
  const qa = createReleaseArtifact({
    artifactType: "qa",
    activationId,
    predecessorSha256: releaseCandidate.sha256,
    projection: { operatorSha256, proof: "qa" },
  });
  const activation = createReleaseArtifact({
    artifactType: "activation",
    activationId,
    predecessorSha256: qa.sha256,
    projection: { operatorSha256, proof: "activation" },
  });
  const artifacts = [stage, installed, auth, releaseCandidate, qa, activation];
  assert.deepEqual(
    assertReleaseArtifactChain(artifacts, { activationId, operatorSha256 }),
    artifacts,
  );
  const tampered = structuredClone(artifacts[4]);
  tampered.projection.proof = "tampered";
  assert.throws(() => assertReleaseArtifact(tampered), /SHA-256/);
  assert.throws(() => createReleaseArtifact({
    artifactType: "auth-lifecycle",
    activationId,
    predecessorSha256: artifacts[1].sha256,
    projection: { operatorSha256, refreshToken: "forbidden" },
  }), /credential material/);
});

test("mutable private pointers are atomic, generation-checked, and reject symlinks", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planner-release-pointer-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = derivePlannerReleaseLayout(home);
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.releasesRoot);
  const first = createReleasePointer({
    pointerType: "pending",
    generation: 1,
    activationId,
    operatorSha256: "e".repeat(64),
    updatedAt: "2026-07-11T12:00:00.000Z",
  });
  await publishReleasePointer(layout.pendingPath, first, 0);
  assert.equal((await stat(layout.pendingPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readReleasePointer(layout.pendingPath, { pointerType: "pending" }), first);
  const second = createReleasePointer({
    ...first,
    generation: 2,
    updatedAt: "2026-07-11T12:01:00.000Z",
  });
  await assert.rejects(publishReleasePointer(layout.pendingPath, second, 0), /generation changed/);
  await publishReleasePointer(layout.pendingPath, second, 1);
  assert.equal((await readReleasePointer(layout.pendingPath)).generation, 2);

  const target = join(layout.releasesRoot, "target.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  const link = join(layout.releasesRoot, "link.json");
  await symlink(target, link);
  await assert.rejects(readReleasePointer(link), /real regular file/);
});

test("concurrent generation-zero pointer publishers have exactly one winner", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-pointer-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensurePrivateDirectory(root);
  const competingId = "22222222-2222-4222-8222-222222222223";
  for (let index = 0; index < 20; index += 1) {
    const path = join(root, `pending-${index}.json`);
    const pointers = [activationId, competingId].map((candidateActivationId) =>
      createReleasePointer({
        pointerType: "pending",
        generation: 1,
        activationId: candidateActivationId,
        operatorSha256: "a".repeat(64),
        updatedAt: "2026-07-12T12:00:00.000Z",
      }));
    const results = await Promise.allSettled(
      pointers.map((pointer) => publishReleasePointer(path, pointer, 0)),
    );
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const selected = await readReleasePointer(path, { pointerType: "pending" });
    assert.equal(
      pointers.some((pointer) => pointer.activationId === selected.activationId),
      true,
    );
  }
});

test("atomic JSON mutex is crash-released by the operating system", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-pointer-crash-lock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensurePrivateDirectory(root);
  const pointer = createReleasePointer({
    pointerType: "pending",
    generation: 1,
    activationId,
    operatorSha256: "a".repeat(64),
    updatedAt: "2026-07-12T12:00:00.000Z",
  });
  const recoveredPath = join(root, "recovered.json");
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--input-type=module",
    "--eval",
    [
      'import { DatabaseSync } from "node:sqlite";',
      "const database = new DatabaseSync(process.env.LOCK_PATH);",
      'database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS release_mutex (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;");',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join(" "),
  ], {
    env: { ...process.env, LOCK_PATH: `${recoveredPath}.lock.sqlite` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("lock child timed out")), 5_000);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`lock child exited ${code}`)));
    child.stdout.on("data", (chunk) => {
      if (!chunk.toString("utf8").includes("ready")) return;
      clearTimeout(timeout);
      resolveReady();
    });
  });
  const childExit = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGKILL");
  await childExit;
  await publishReleasePointer(recoveredPath, pointer, 0);
  assert.equal((await readReleasePointer(recoveredPath)).activationId, activationId);
});

test("installed start validates pending journals and frozen app/operator manifests", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planner-start-gate-")));
  t.after(async () => {
    await makeRemovable(home);
    await rm(home, { recursive: true, force: true });
  });
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [
    layout.root,
    layout.releasesRoot,
    layout.transactionRoot,
    layout.operatorRoot,
    layout.appRoot,
  ]) {
    await ensurePrivateDirectory(path);
  }
  const appFile = join(layout.appRoot, "app.txt");
  await writeFile(appFile, "installed app\n");
  const appManifest = await inventoryReleaseTree(layout.appRoot);

  const operatorStaging = join(layout.operatorRoot, "staging");
  await ensurePrivateDirectory(operatorStaging);
  const operatorFile = join(operatorStaging, "operator.txt");
  const operatorNested = join(operatorStaging, "nested");
  await ensurePrivateDirectory(operatorNested);
  await Promise.all([
    writeFile(operatorFile, "installed operator\n"),
    writeFile(join(operatorNested, "nested.txt"), "nested operator\n"),
  ]);
  const operatorManifest = await inventoryReleaseTree(operatorStaging);
  const operatorPath = join(layout.operatorRoot, operatorManifest.sha256);
  await rename(operatorStaging, operatorPath);
  await Promise.all([
    freezeReleaseTree(layout.appRoot),
    freezeReleaseTree(operatorPath),
  ]);

  const activation = createReleaseArtifact({
    artifactType: "activation",
    activationId,
    predecessorSha256: "b".repeat(64),
    projection: {
      app: { exists: true, kind: "directory", ...appManifest },
      operatorSha256: operatorManifest.sha256,
    },
  });
  await publishReleaseArtifact(layout.activationPath, activation);
  const current = createReleasePointer({
    pointerType: "current",
    generation: 1,
    activationId,
    operatorSha256: operatorManifest.sha256,
    activationSha256: activation.sha256,
    rollbackSha256: null,
    updatedAt: "2026-07-12T12:00:00.000Z",
  });
  await publishReleasePointer(layout.currentPath, current, 0);
  assert.equal((await assertInstalledReleaseStartable(home)).current.sha256, current.sha256);

  await chmod(appFile, 0o644);
  await assert.rejects(assertInstalledReleaseStartable(home), /file outside mode 0444\/0555/);
  await chmod(appFile, 0o444);
  const installedOperatorNested = join(operatorPath, "nested");
  await chmod(installedOperatorNested, 0o700);
  await assert.rejects(assertInstalledReleaseStartable(home), /directory outside mode 0500/);
  await chmod(installedOperatorNested, 0o500);

  const pending = createReleasePointer({
    pointerType: "pending",
    generation: 1,
    activationId,
    operatorSha256: operatorManifest.sha256,
    updatedAt: "2026-07-12T12:01:00.000Z",
  });
  await publishReleasePointer(layout.pendingPath, pending, 0);
  await assert.rejects(
    assertInstalledReleaseStartable(home),
    (error) => error?.code === "ENOENT",
  );
  await writeFile(layout.journalPath, '{"state":"committed"}\n', { mode: 0o600 });
  await assert.rejects(
    assertInstalledReleaseStartable(home),
    /journal has an invalid exact envelope/,
  );
  await Promise.all([rm(layout.pendingPath), rm(layout.journalPath)]);

  await makeRemovable(layout.appRoot);
  await writeFile(appFile, "tampered app\n");
  await freezeReleaseTree(layout.appRoot);
  await assert.rejects(assertInstalledReleaseStartable(home), /application changed/);
  await makeRemovable(layout.appRoot);
  await writeFile(appFile, "installed app\n");
  await freezeReleaseTree(layout.appRoot);

  await makeRemovable(operatorPath);
  await writeFile(join(operatorPath, "operator.txt"), "tampered operator\n");
  await freezeReleaseTree(operatorPath);
  await assert.rejects(assertInstalledReleaseStartable(home), /operator changed/);
});

async function createStageFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-release-stage-")));
  t.after(async () => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const candidate = join(root, "candidate");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(candidate, { mode: 0o700 }),
  ]);
  await Promise.all([
    mkdir(join(candidate, "scripts", "support"), { recursive: true }),
    mkdir(join(candidate, ".git"), { mode: 0o700 }),
    mkdir(join(root, "dependency-target"), { mode: 0o700 }),
    mkdir(join(candidate, "deployment", "release"), { recursive: true }),
  ]);
  await symlink(join(root, "dependency-target"), join(candidate, "node_modules"));
  for (const relativePath of RELEASE_OPERATOR_CORE_FILES) {
    const path = join(candidate, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `// ${relativePath}\n`);
  }
  await Promise.all([
    writeFile(join(candidate, "package.json"), "{\"name\":\"fixture\"}\n"),
    writeFile(join(candidate, "package-lock.json"), "{\"lockfileVersion\":3}\n"),
    writeFile(join(candidate, ".git", "private"), "excluded\n"),
    writeFile(join(root, "dependency-target", "private"), "excluded\n"),
    writeFile(join(candidate, "deployment", "release", "first-install-baseline.json"),
      `${JSON.stringify({ schemaVersion: 1, baselineCommit }, null, 2)}\n`),
  ]);
  const dataSource = join(root, "planner.sqlite");
  const agentSource = join(root, "authenticated-agent");
  await Promise.all([
    writeFile(dataSource, "sqlite-fixture"),
    mkdir(agentSource, { mode: 0o700 }),
  ]);
  return { root, home, candidate, dataSource, agentSource };
}

function retainedAgentProjection(layout) {
  const sourcePath = join(layout.releasesRoot, activationId, "superseded-agent");
  const deploymentFile = (inode) => ({
    exists: true,
    device: "1",
    inode,
    ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
    mode: 0o600,
    linkCount: 1,
    size: 1,
    sha256: "e".repeat(64),
  });
  return {
    sourcePath,
    sourceActivationId: activationId,
    sourceDirectoryName: "superseded-agent",
    sourceJournalSha256: "c".repeat(64),
    root: {
      device: "1",
      inode: "2",
      ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
      mode: 0o700,
      linkCount: 2,
    },
    credentialFile: {
      device: "1",
      inode: "3",
      ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
      mode: 0o600,
      linkCount: 1,
    },
    sourceDeployment: {
      files: {
        "config.toml": deploymentFile("4"),
        "AGENTS.md": deploymentFile("5"),
      },
    },
  };
}

test("stage freezes exact candidate/baseline/operator sources and emits only ID plus derived receipt", async (t) => {
  const fixture = await createStageFixture(t);
  const generatedId = "22222222-2222-4222-8222-222222222222";
  const runCommand = async (_command, args) => {
    if (args.includes("--show-toplevel")) return { stdout: `${fixture.candidate}\n`, stderr: "", code: 0, signal: null };
    if (args.includes("--verify")) return { stdout: `${baselineCommit}\n`, stderr: "", code: 0, signal: null };
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  let inspectedCandidateSource = null;
  const result = await runPlannerRelease([
    "stage",
    "--candidate-source",
    fixture.candidate,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    fixture.dataSource,
    "--agent-source",
    fixture.agentSource,
  ], { HOME: fixture.home }, {
    home: fixture.home,
    createActivationId: () => generatedId,
    runCommand,
    extractBaseline: async ({ destination }) => copyReleaseTree(
      fixture.candidate,
      destination,
      { excludedRootNames: new Set([".git", "node_modules"]) },
    ),
    runStagePreflight: async () => ({
      node: {
        executable: process.execPath,
        version: "v22.15.0",
        sha256: "a".repeat(64),
        exactFloorVerified: true,
        recheckedAfterSuite: true,
      },
      npm: {
        executable: process.execPath,
        cli: "/fixture/npm-cli.js",
        version: "fixture",
        cliSha256: "b".repeat(64),
      },
      candidate: {
        cleanInstall: true,
        build: true,
        lint: true,
        mergeSuite: true,
        dependencyGraphSha256: "1".repeat(64),
      },
      baseline: {
        cleanInstall: true,
        build: true,
        lint: false,
        mergeSuite: false,
        dependencyGraphSha256: "2".repeat(64),
      },
    }),
    hashDeploymentInputs: false,
    inspectDataSource: async (_path, candidateSourceRoot) => {
      inspectedCandidateSource = candidateSourceRoot;
      return { initialized: true, schemaVersion: 4 };
    },
    inspectAgentSource: async ({ layout }) => retainedAgentProjection(layout),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    activationId: generatedId,
    stageReceipt: derivePlannerReleaseLayout(fixture.home, generatedId).stagePath,
  });
  const stage = JSON.parse(await readFile(result.output.stageReceipt, "utf8"));
  assert.equal(stage.artifactType, "stage");
  assert.equal(stage.projection.dataSource.canonicalPath, fixture.dataSource);
  assert.equal(stage.projection.dataSource.schemaVersion, 4);
  assert.equal(stage.projection.firstInstall, true);
  assert.equal(stage.projection.agentSource.sourcePath, join(
    derivePlannerReleaseLayout(fixture.home).releasesRoot,
    activationId,
    "superseded-agent",
  ));
  assert.deepEqual(stage.projection.preflight.node, {
    executable: process.execPath,
    version: "v22.15.0",
    sha256: "a".repeat(64),
    exactFloorVerified: true,
    recheckedAfterSuite: true,
  });
  assert.equal(stage.projection.firstInstallBaseline.baselineCommit, baselineCommit);
  assert.match(stage.projection.firstInstallBaseline.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(stage.projection.operatorSource.files, RELEASE_OPERATOR_CORE_FILES.length);
  const layout = derivePlannerReleaseLayout(fixture.home, generatedId);
  assert.equal(inspectedCandidateSource, layout.candidateSourceRoot);
  assert.equal(
    JSON.parse(await readFile(join(layout.operatorSourceRoot, "package.json"), "utf8")).name,
    "fixture",
  );
  assert.equal((await stat(layout.candidateSourceRoot)).mode & 0o777, 0o500);
  assert.equal((await stat(join(layout.candidateSourceRoot, "package.json"))).mode & 0o777, 0o444);
  assert.equal((await inventoryReleaseTree(layout.candidateSourceRoot)).sha256, stage.projection.candidateSource.sha256);
  await assert.rejects(stat(join(layout.candidateSourceRoot, ".git")), /ENOENT/);
  await assert.rejects(stat(join(layout.candidateSourceRoot, "node_modules")), /ENOENT/);
});

test("failed preflight removes its transaction but retains the private npm cache and logs", async (t) => {
  const fixture = await createStageFixture(t);
  const generatedId = "44444444-4444-4444-8444-444444444444";
  const layout = derivePlannerReleaseLayout(fixture.home, generatedId);
  const runCommand = async (_command, args) => {
    if (args.includes("--show-toplevel")) {
      return { stdout: `${fixture.candidate}\n`, stderr: "", code: 0, signal: null };
    }
    if (args.includes("--verify")) {
      return { stdout: `${baselineCommit}\n`, stderr: "", code: 0, signal: null };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  const markerPath = join(layout.npmCacheRoot, "warmed-content.marker");
  const logPath = join(layout.npmCacheRoot, "_logs", "preflight-debug.log");

  await assert.rejects(runPlannerRelease([
    "stage",
    "--candidate-source",
    fixture.candidate,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    fixture.dataSource,
    "--agent-source",
    fixture.agentSource,
  ], { HOME: fixture.home }, {
    home: fixture.home,
    createActivationId: () => generatedId,
    runCommand,
    extractBaseline: async ({ destination }) => copyReleaseTree(
      fixture.candidate,
      destination,
      { excludedRootNames: new Set([".git", "node_modules"]) },
    ),
    runStagePreflight: async () => {
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(markerPath, "warm\n", { mode: 0o600 }),
        writeFile(logPath, "npm transport exhausted\n", { mode: 0o600 }),
      ]);
      throw new Error("injected npm preflight failure");
    },
    hashDeploymentInputs: false,
    inspectDataSource: async () => ({ initialized: true, schemaVersion: 4 }),
    inspectAgentSource: async ({ layout }) => retainedAgentProjection(layout),
  }), /injected npm preflight failure/);

  await assert.rejects(stat(layout.transactionRoot), /ENOENT/);
  await assert.rejects(stat(layout.stagePath), /ENOENT/);
  assert.equal(await readFile(markerPath, "utf8"), "warm\n");
  assert.equal(await readFile(logPath, "utf8"), "npm transport exhausted\n");
  assert.equal((await stat(layout.root)).mode & 0o777, 0o700);
  assert.equal((await stat(layout.cacheRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(layout.npmCacheRoot)).mode & 0o777, 0o700);
});

test("stage fails closed when the release cache root is a symbolic link", async (t) => {
  const fixture = await createStageFixture(t);
  const generatedId = "55555555-5555-4555-8555-555555555555";
  const layout = derivePlannerReleaseLayout(fixture.home, generatedId);
  const redirectedCache = join(fixture.root, "redirected-cache");
  await Promise.all([
    mkdir(layout.root, { mode: 0o700 }),
    mkdir(redirectedCache, { mode: 0o700 }),
  ]);
  await symlink(redirectedCache, layout.cacheRoot);

  await assert.rejects(runPlannerRelease([
    "stage",
    "--candidate-source",
    fixture.candidate,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    fixture.dataSource,
  ], { HOME: fixture.home }, {
    home: fixture.home,
    createActivationId: () => generatedId,
  }), /Release directory must be a real directory/);
  await assert.rejects(stat(layout.transactionRoot), /ENOENT/);
});

test("first-install stage accepts only the release-managed family baseline", async (t) => {
  for (const rejectedCommit of [
    "217e81306160346fc944712175059bece5da23d0",
    "b".repeat(40),
  ]) {
    await t.test(rejectedCommit, async (subtest) => {
      const fixture = await createStageFixture(subtest);
      await assert.rejects(runPlannerRelease([
        "stage",
        "--candidate-source",
        fixture.candidate,
        "--baseline-commit",
        rejectedCommit,
        "--data-source",
        fixture.dataSource,
      ], { HOME: fixture.home }, {
        home: fixture.home,
        createActivationId: () => "33333333-3333-4333-8333-333333333333",
      }), new RegExp(`release-managed baseline ${baselineCommit}`));
    });
  }
});

test("agent-source staging is mandatory only for first install", async (t) => {
  const missing = await createStageFixture(t);
  await assert.rejects(runPlannerRelease([
    "stage",
    "--candidate-source",
    missing.candidate,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    missing.dataSource,
  ], { HOME: missing.home }, {
    home: missing.home,
    createActivationId: () => "66666666-6666-4666-8666-666666666666",
  }), /requires --agent-source/);

  const update = await createStageFixture(t);
  const updateLayout = derivePlannerReleaseLayout(update.home);
  await mkdir(updateLayout.root, { mode: 0o700 });
  await mkdir(updateLayout.releasesRoot, { mode: 0o700 });
  await publishReleasePointer(updateLayout.currentPath, createReleasePointer({
    pointerType: "current",
    generation: 1,
    activationId,
    operatorSha256: "d".repeat(64),
    activationSha256: "e".repeat(64),
    rollbackSha256: null,
    updatedAt: "2026-07-13T12:00:00.000Z",
  }), 0);
  await assert.rejects(runPlannerRelease([
    "stage",
    "--candidate-source",
    update.candidate,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    update.dataSource,
    "--agent-source",
    update.agentSource,
  ], { HOME: update.home }, {
    home: update.home,
    createActivationId: () => "77777777-7777-4777-8777-777777777777",
  }), /Update stage rejects --agent-source/);
});
