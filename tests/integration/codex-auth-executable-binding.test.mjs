import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Historical two-process credential-lifecycle binding proof. It is retained as
// feasibility evidence and is not the production activation contract.

import {
  CodexAuthLifecycleError,
  authReleaseInputsFromArtifacts,
  authRuntimeIdentityFromActivationCoordinates,
  createAuthLifecycleReleaseArtifact,
  runCodexAuthLifecycle,
} from "../../scripts/support/codex-auth-lifecycle.mjs";
import {
  createActivationId,
  createReleaseArtifact,
} from "../../scripts/support/planner-release-contract.mjs";
import {
  buildCodexFollowUpChildEnvironment,
  parseCodexFollowUpConfig,
  validateCodexFollowUpDeployment,
} from "../../server/runtime/codex-follow-up/deployment.ts";
import {
  CodexLauncherError,
  captureCodexExecutableIdentity,
  createCompatibleCodexExecution,
} from "../../server/runtime/codex-follow-up/launcher.ts";
import { sha256BoundedFile } from "../../server/runtime/codex-follow-up/resource-policy.ts";
import {
  GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
} from "../support/fixtures/codex-runtime/auth-schema-fixtures.mjs";

const fixtureSourcePath = fileURLToPath(new URL(
  "../support/fixtures/codex-runtime/fake-auth-codex-executable.mjs",
  import.meta.url,
));

function deploymentReadback() {
  return {
    authenticated: false,
    accountKind: null,
    permissionProfile: ":read-only",
    effectiveSandbox: "read-only-network-disabled",
    configSourceHashes: {
      "user:0": "7".repeat(64),
      "system:1": "8".repeat(64),
    },
    systemConfigPaths: ["/fixture/absent-system-config.toml"],
    instructionSourceHashes: { "dedicated:0": "9".repeat(64) },
    skillNames: [],
    mcpServerNames: [],
    appNames: [],
    pluginNames: [],
    runtimeFiles: ["AGENTS.md", "config.toml"],
  };
}

async function executableBytes(identity) {
  const source = await readFile(fixtureSourcePath, "utf8");
  return source
    .replace("#!/usr/bin/env node", `#!${process.execPath}`)
    .replace(
      'const bakedExecutableIdentity = "A";',
      `const bakedExecutableIdentity = ${JSON.stringify(identity)};`,
    );
}

async function createFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-auth-executable-binding-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normalHome = join(root, "home");
  const codexHome = join(root, "agent");
  const appCwd = join(root, "app");
  const plannerDataDirectory = join(root, "data");
  const launcherPath = join(normalHome, ".local", "bin", "codex");
  const launcherTargetPath = join(normalHome, ".local", "lib", "codex-auth-fixture.mjs");
  const replacementPath = join(dirname(launcherTargetPath), "codex-auth-fixture-b.mjs");
  const systemConfigPath = join(root, "absent-system-config.toml");

  await Promise.all([
    mkdir(dirname(launcherPath), { recursive: true }),
    mkdir(dirname(launcherTargetPath), { recursive: true }),
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(appCwd),
    mkdir(plannerDataDirectory),
  ]);
  await Promise.all([
    writeFile(launcherTargetPath, await executableBytes("A"), { mode: 0o700 }),
    writeFile(replacementPath, await executableBytes("B"), { mode: 0o700 }),
    writeFile(join(codexHome, "config.toml"), [
      'model = "fake"',
      'forced_login_method = "chatgpt"',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
    ].join("\n"), { mode: 0o600 }),
    writeFile(join(codexHome, "AGENTS.md"), "# Dedicated auth fixture\n", { mode: 0o600 }),
  ]);
  await Promise.all([
    chmod(launcherTargetPath, 0o700),
    chmod(replacementPath, 0o700),
    symlink(launcherTargetPath, launcherPath),
  ]);

  const sourceEnvironment = {
    HOME: normalHome,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    PLANNER_CODEX_HOME: codexHome,
    PLANNER_CODEX_CWD: appCwd,
    PLANNER_DATA_DIR: plannerDataDirectory,
    PLANNER_SECRET_SENTINEL: "must-not-reach-child",
  };
  const parsed = parseCodexFollowUpConfig(sourceEnvironment, plannerDataDirectory);
  assert.equal(parsed.ok, true);
  const validated = await validateCodexFollowUpDeployment(parsed.deployment);
  assert.equal(validated.ok, true);
  const childEnvironment = buildCodexFollowUpChildEnvironment(
    validated.deployment,
    sourceEnvironment,
  );
  const identity = await captureCodexExecutableIdentity(launcherPath, {
    cwd: appCwd,
    env: childEnvironment,
    timeoutMs: 10_000,
  });
  const userConfigSha256 = await sha256BoundedFile(
    join(codexHome, "config.toml"),
    2 * 1024 * 1024,
    "test config",
  );
  const instructionSha256 = await sha256BoundedFile(
    join(codexHome, "AGENTS.md"),
    2 * 1024 * 1024,
    "test instructions",
  );
  const executionProvider = createCompatibleCodexExecution(
    identity,
    validated.deployment,
    childEnvironment,
    { userConfigSha256, instructionSha256, systemConfigPaths: [systemConfigPath] },
  );
  const runtimeIdentity = authRuntimeIdentityFromActivationCoordinates({
    canonicalPath: identity.canonicalPath,
    version: identity.version,
    sha256: identity.sha256,
    schemaFingerprint: "3".repeat(64),
    userConfigSha256,
    systemConfigSha256: "5".repeat(64),
    instructionSha256,
  });
  const activationId = createActivationId();
  const operatorSha256 = "c".repeat(64);
  const stageArtifact = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: { candidateSourceSha256: "a".repeat(64) },
  });
  const installedArtifact = createReleaseArtifact({
    artifactType: "installed",
    activationId,
    predecessorSha256: stageArtifact.sha256,
    projection: { canonicalAppSha256: "b".repeat(64), operatorSha256 },
  });

  return {
    root,
    normalHome,
    codexHome,
    appCwd,
    launcherTargetPath,
    replacementPath,
    executionProvider,
    identity,
    runtimeIdentity,
    operatorSha256,
    stageArtifact,
    installedArtifact,
    releaseInputs: authReleaseInputsFromArtifacts(stageArtifact, installedArtifact),
    async swapToB() {
      await rename(replacementPath, launcherTargetPath);
    },
    async invocations() {
      try {
        return (await readFile(
          join(codexHome, ".fake-auth-executable-invocations.jsonl"),
          "utf8",
        )).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

function lifecycleOptions(fixture, onDeviceCode, overrides = {}) {
  return {
    executionProvider: fixture.executionProvider,
    normalHome: fixture.normalHome,
    codexHome: fixture.codexHome,
    appCwd: fixture.appCwd,
    onDeviceCode,
    notificationOptOutMethods: GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
    requestTimeoutMs: 2_000,
    handoffTimeoutMs: 2_000,
    loginTimeoutMs: 2_000,
    releaseInputs: fixture.releaseInputs,
    operatorSha256: fixture.operatorSha256,
    runtimeIdentity: fixture.runtimeIdentity,
    deploymentReadback: deploymentReadback(),
    ...overrides,
  };
}

function lifecycleDependencies(fixture) {
  return { readOsHome: () => fixture.normalHome };
}

function appServerStarts(invocations) {
  return invocations.filter((entry) => entry.direction === "app-server-start");
}

test("auth lifecycle executes two accepted-A snapshots and attests the accepted runtime", async (t) => {
  const fixture = await createFixture(t);
  const prompts = [];
  const projection = await runCodexAuthLifecycle(
    lifecycleOptions(fixture, async (prompt) => prompts.push(prompt.attempt)),
    lifecycleDependencies(fixture),
  );

  assert.equal(projection.outcome, "authenticated");
  assert.deepEqual(projection.runtimeIdentity, fixture.runtimeIdentity);
  assert.equal(projection.runtimeIdentity.executableVersion, "fake-auth-codex A");
  assert.equal(projection.runtimeIdentity.executableSha256, fixture.identity.sha256);
  assert.deepEqual(prompts, [1, 2]);

  const starts = appServerStarts(await fixture.invocations());
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map((entry) => entry.pid)).size, 2);
  assert.equal(starts.every((entry) => entry.bakedExecutableIdentity === "A"), true);
  assert.equal(starts.every((entry) => entry.args.join(" ") === "app-server --listen stdio://"), true);
  assert.equal(starts.every((entry) => entry.executablePath.includes(
    `/execution-snapshots/${fixture.identity.sha256}/codex.mjs`,
  )), true);

  assert.throws(
    () => createAuthLifecycleReleaseArtifact({
      stageArtifact: fixture.stageArtifact,
      installedArtifact: fixture.installedArtifact,
      projection,
    }),
    /invalid exact contract/,
  );
});

test("an updater swap before child one rejects before any device prompt", async (t) => {
  const fixture = await createFixture(t);
  await fixture.swapToB();
  const prompts = [];

  await assert.rejects(
    runCodexAuthLifecycle(
      lifecycleOptions(fixture, async (prompt) => prompts.push(prompt)),
      lifecycleDependencies(fixture),
    ),
    (error) => error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED",
  );

  assert.deepEqual(prompts, []);
  assert.deepEqual(appServerStarts(await fixture.invocations()), []);
});

test("an A-to-B updater swap during the first handoff finishes snapshot A then rejects child two", async (t) => {
  const fixture = await createFixture(t);
  const prompts = [];
  let projection;

  await assert.rejects(
    (async () => {
      projection = await runCodexAuthLifecycle(
        lifecycleOptions(fixture, async (prompt) => {
          prompts.push(prompt.attempt);
          if (prompt.attempt === 1) await fixture.swapToB();
        }),
        lifecycleDependencies(fixture),
      );
    })(),
    (error) => error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED",
  );

  assert.equal(projection, undefined);
  assert.deepEqual(prompts, [1]);
  const invocations = await fixture.invocations();
  const starts = appServerStarts(invocations);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].bakedExecutableIdentity, "A");
  assert.equal(
    invocations.some((entry) => entry.bakedExecutableIdentity === "B"),
    false,
  );
  assert.equal(
    invocations.some((entry) =>
      entry.direction === "request" &&
      entry.method === "account/read" &&
      entry.params?.refreshToken === true),
    true,
    "the first accepted snapshot must finish its authenticated refresh readback",
  );
});

test("provider and runtime identity mismatch rejects before the provider can spawn", async (t) => {
  const fixture = await createFixture(t);
  let spawnCount = 0;
  const observedProvider = {
    identity: fixture.executionProvider.identity,
    async spawnAppServer(options) {
      spawnCount += 1;
      return fixture.executionProvider.spawnAppServer(options);
    },
  };
  const mismatchedRuntimeIdentity = {
    ...fixture.runtimeIdentity,
    executableSha256: fixture.runtimeIdentity.executableSha256 === "f".repeat(64)
      ? "e".repeat(64)
      : "f".repeat(64),
  };

  await assert.rejects(
    runCodexAuthLifecycle(
      lifecycleOptions(fixture, async () => undefined, {
        executionProvider: observedProvider,
        runtimeIdentity: mismatchedRuntimeIdentity,
      }),
      lifecycleDependencies(fixture),
    ),
    (error) => error instanceof CodexAuthLifecycleError && error.code === "AUTH_DEPLOYMENT",
  );

  assert.equal(spawnCount, 0);
  assert.deepEqual(appServerStarts(await fixture.invocations()), []);
});
