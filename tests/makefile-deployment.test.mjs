import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const activationId = "11111111-1111-4111-8111-111111111111";
const baselineManifest = JSON.parse(await readFile(
  join(root, "deployment", "release", "first-install-baseline.json"),
  "utf8",
));
const baselineCommit = baselineManifest.baselineCommit;

function runMake(args, environment = {}) {
  const childEnvironment = { ...process.env, ...environment };
  for (const key of [
    "ACTIVATION_ID",
    "AGENT_SOURCE",
    "BASELINE_COMMIT",
    "CANDIDATE_SOURCE",
    "DATA_LOSS_AUTHORIZATION",
    "DATA_SOURCE",
    "GNUMAKEFLAGS",
    "MAKEFLAGS",
    "MAKELEVEL",
    "MAKEOVERRIDES",
    "MFLAGS",
    "SUPERSEDE_PENDING",
    "TX",
    "PLANNER_ALLOWED_ORIGINS",
    "PLANNER_PORT",
    "QA_DATA_SOURCE",
    "QA_NAME",
    "QA_NPM_COMMAND",
    "QA_PORTLESS_PORT",
    "QA_STATE_DIR",
  ]) {
    delete childEnvironment[key];
  }
  return spawnSync("make", ["--no-print-directory", ...args], {
    cwd: root,
    encoding: "utf8",
    env: childEnvironment,
  });
}

async function makeNpmRecorder() {
  const directory = await mkdtemp(join(tmpdir(), "planner-make-test-"));
  const executable = join(directory, "npm-recorder");
  const capture = join(directory, "arguments.txt");
  await writeFile(
    executable,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$MAKE_CAPTURE\"\n",
  );
  await chmod(executable, 0o700);
  return {
    capture,
    directory,
    environment: { MAKE_CAPTURE: capture, NPM: executable },
  };
}

test("deployment make help exposes the guarded release workflow", () => {
  const result = runMake(["help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy-setup DATA_SOURCE=/);
  assert.match(result.stdout, /deploy-activate ACTIVATION_ID=/);
  assert.match(result.stdout, /deploy-recover ACTIVATION_ID=/);
  assert.match(result.stdout, /deploy-rollback ACTIVATION_ID=/);
  assert.match(result.stdout, /deploy-start/);
  assert.match(result.stdout, /deploy-service-install/);
  assert.match(result.stdout, /deploy-service-uninstall/);
  assert.match(result.stdout, /qa-local/);
  assert.match(result.stdout, /qa-deploy/);
  assert.match(result.stdout, /qa-status/);
  assert.match(result.stdout, /qa-stop/);
  assert.match(result.stdout, /produces no release evidence/);
  assert.doesNotMatch(result.stdout, /deploy-qa/);
});

test("service Make targets invoke the dedicated lifecycle manager", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));
  const expected = new Map([
    ["deploy-service-install", "install"],
    ["deploy-service-restart", "restart"],
    ["deploy-service-start", "start"],
    ["deploy-service-status", "status"],
    ["deploy-service-stop", "stop"],
    ["deploy-service-uninstall", "uninstall"],
  ]);
  for (const [target, command] of expected) {
    const result = runMake([target], {
      ...recorder.environment,
      NODE: recorder.environment.NPM,
    });
    assert.equal(result.status, 0, `${target}: ${result.stderr}`);
    assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
      "--disable-warning=ExperimentalWarning",
      "scripts/planner-service.mjs",
      command,
    ]);
  }
});

test("the Makefile exposes no standalone release-QA lifecycle", async () => {
  const source = await readFile(join(root, "Makefile"), "utf8");
  assert.doesNotMatch(source, /(?:^|\s)deploy-qa(?:\s|:|\\)/mu);
  assert.match(source, /^qa-local:/mu);
});

test("qa-local is explicitly the mutable-checkout installed harness", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));
  const result = runMake(["qa-local"], recorder.environment);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "run",
    "test:e2e:installed",
  ]);
});

test("qa-deploy builds before handing off to the managed Portless lifecycle", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));
  const dataSource = join(recorder.directory, "planner.sqlite");
  await writeFile(dataSource, "fixture");

  const result = runMake([
    "qa-deploy",
    "QA_NAME=planner-qa",
    "QA_PORTLESS_PORT=1357",
    `QA_DATA_SOURCE=${dataSource}`,
  ], {
    ...recorder.environment,
    NODE: recorder.environment.NPM,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "--disable-warning=ExperimentalWarning",
    "scripts/qa-deployment-manager.mjs",
    "start",
  ]);
  const manager = await readFile(join(root, "scripts", "qa-deployment-manager.mjs"), "utf8");
  assert.match(manager, /portless[\s\S]*"run"[\s\S]*"--name"/);
  assert.match(manager, /QA_ORIGIN: paths\.url/);
});

test("QA status and stop targets use the managed lifecycle", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));
  for (const command of ["status", "stop"]) {
    const result = runMake([`qa-${command}`], {
      ...recorder.environment,
      NODE: recorder.environment.NPM,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
      "--disable-warning=ExperimentalWarning",
      "scripts/qa-deployment-manager.mjs",
      command,
    ]);
  }
});

test("deployment make targets fail before invoking npm when required inputs are absent", () => {
  const stage = runMake(["deploy-stage"]);
  const activate = runMake(["deploy-activate"]);

  assert.equal(stage.status, 2);
  assert.match(stage.stderr, /DATA_SOURCE is required/);
  assert.equal(activate.status, 2);
  assert.match(activate.stderr, /ACTIVATION_ID \(or TX\) is required/);
});

test("deploy-setup forwards the explicit authority and release-managed baseline", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));
  const dataSource = join(recorder.directory, "planner.sqlite");
  await writeFile(dataSource, "fixture");

  const result = runMake([
    "deploy-setup",
    `DATA_SOURCE=${dataSource}`,
  ], recorder.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "run",
    "planner:release",
    "--",
    "stage",
    "--candidate-source",
    root,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    dataSource,
  ]);
});

test("deploy-setup conditionally forwards a normalized first-install agent source", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));
  const dataSource = join(recorder.directory, "planner.sqlite");
  const agentSource = join(recorder.directory, "superseded-agent");
  await writeFile(dataSource, "fixture");

  const result = runMake([
    "deploy-setup",
    `DATA_SOURCE=${dataSource}`,
    `AGENT_SOURCE=${agentSource}`,
  ], recorder.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "run",
    "planner:release",
    "--",
    "stage",
    "--candidate-source",
    root,
    "--baseline-commit",
    baselineCommit,
    "--data-source",
    dataSource,
    "--agent-source",
    agentSource,
  ]);

  const relative = runMake([
    "deploy-setup",
    `DATA_SOURCE=${dataSource}`,
    "AGENT_SOURCE=relative",
  ], recorder.environment);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /AGENT_SOURCE must be an absolute path/);
});

test("activation and rollback targets retain explicit safety flags", async (context) => {
  const recorder = await makeNpmRecorder();
  context.after(() => rm(recorder.directory, { recursive: true, force: true }));

  const activation = runMake([
    "deploy-activate-uninitialized",
    `ACTIVATION_ID=${activationId}`,
  ], recorder.environment);
  assert.equal(activation.status, 0, activation.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "run",
    "planner:release",
    "--",
    "activate",
    "--transaction",
    activationId,
    "--authorized",
    "--confirm-uninitialized-authority",
  ]);

  const supersededActivationId = "22222222-2222-4222-8222-222222222222";
  const supersession = runMake([
    "deploy-activate",
    `ACTIVATION_ID=${activationId}`,
    `SUPERSEDE_PENDING=${supersededActivationId}`,
  ], recorder.environment);
  assert.equal(supersession.status, 0, supersession.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "run",
    "planner:release",
    "--",
    "activate",
    "--transaction",
    activationId,
    "--authorized",
    "--supersede-pending",
    supersededActivationId,
  ]);

  const authorization = `${activationId}:${"b".repeat(64)}:${"c".repeat(64)}`;
  const rollback = runMake([
    "deploy-rollback",
    `TX=${activationId}`,
    `DATA_LOSS_AUTHORIZATION=${authorization}`,
  ], recorder.environment);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.deepEqual((await readFile(recorder.capture, "utf8")).trim().split("\n"), [
    "run",
    "planner:release",
    "--",
    "rollback",
    "--transaction",
    activationId,
    "--authorize-data-loss",
    authorization,
  ]);
});
