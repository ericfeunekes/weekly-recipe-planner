import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Historical feasibility proof only. Production activation is covered by the
// readback-only tests in integration/codex-auth-production-composition.test.mjs.

import {
  CODEX_AUTH_CLIENT_NOTIFICATIONS,
  CODEX_AUTH_REQUEST_METHODS,
  CODEX_AUTH_SERVER_NOTIFICATIONS,
  assertCodexAuthRequest,
  authReleaseInputsFromArtifacts,
  createCodexAuthInitializeParams,
  createAuthLifecycleReleaseArtifact,
  runCodexAuthLifecycle,
  snapshotStableNormalCodexInputs,
  validateDeploymentReadback,
} from "../scripts/support/codex-auth-lifecycle.mjs";
import {
  GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
} from "./support/fixtures/codex-runtime/auth-schema-fixtures.mjs";
import {
  createActivationId,
  createReleaseArtifact,
} from "../scripts/support/planner-release-contract.mjs";
import { CodexLauncherError } from "../server/runtime/codex-follow-up/launcher.ts";

const fakeAuthAppServer = fileURLToPath(new URL(
  "support/fixtures/codex-runtime/fake-auth-app-server.mjs",
  import.meta.url,
));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeIdentity(fixture) {
  return {
    canonicalTargetPathSha256: sha256(fixture.canonicalPath),
    executableVersion: "codex-fixture 1",
    executableSha256: "2".repeat(64),
    schemaFingerprint: "3".repeat(64),
    userConfigSha256: "4".repeat(64),
    systemConfigSha256: "5".repeat(64),
    instructionSha256: "6".repeat(64),
  };
}

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
    skillNames: ["fixture-skill"],
    mcpServerNames: [],
    appNames: [],
    pluginNames: [],
    runtimeFiles: ["AGENTS.md", "config.toml"],
  };
}

test("deployment readback identity ignores unrecognized raw fields instead of hashing them", () => {
  const baseline = validateDeploymentReadback(deploymentReadback());
  const extended = validateDeploymentReadback({
    ...deploymentReadback(),
    refreshToken: "private-fixture-value",
  });
  assert.deepEqual(extended, baseline);
  assert.equal(JSON.stringify(extended).includes("private-fixture-value"), false);
  assert.equal(JSON.stringify(extended).includes("refreshToken"), false);
});

async function createFixture(t, { initialAuthenticated = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-auth-lifecycle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normalHome = join(root, "home");
  const codexHome = join(root, "agent");
  const appCwd = join(root, "app");
  await Promise.all([
    mkdir(join(normalHome, ".codex", "plugins", "fixture"), { recursive: true }),
    mkdir(join(normalHome, ".agents", "skills", "fixture-skill"), { recursive: true }),
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(appCwd),
  ]);
  await Promise.all([
    writeFile(join(normalHome, ".codex", "auth.json"), "normal-private-auth\n", { mode: 0o600 }),
    writeFile(join(normalHome, ".codex", "config.toml"), "model = \"normal\"\n", { mode: 0o600 }),
    writeFile(join(normalHome, ".codex", "AGENTS.md"), "# Normal\n", { mode: 0o600 }),
    writeFile(join(normalHome, ".codex", "plugins", "fixture", "manifest.json"), "{}\n", { mode: 0o600 }),
    writeFile(join(normalHome, ".agents", "skills", "fixture-skill", "SKILL.md"), "# Fixture\n", { mode: 0o600 }),
    writeFile(join(codexHome, "config.toml"), "approval_policy = \"never\"\n", { mode: 0o600 }),
    writeFile(join(codexHome, "AGENTS.md"), "# Dedicated\n", { mode: 0o600 }),
  ]);

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
    launcherPath: join(normalHome, ".local", "bin", "codex"),
    canonicalPath: join(normalHome, ".local", "lib", "codex-fixture"),
    initialAuthenticated,
    operatorSha256,
    stageArtifact,
    installedArtifact,
    releaseInputs: authReleaseInputsFromArtifacts(stageArtifact, installedArtifact),
  };
}

function fakeExecutionProvider(
  fixture,
  variant = "compatible",
  { identity = {}, rejectBeforeSpawn = null } = {},
) {
  let spawnAttempts = 0;
  return Object.freeze({
    identity: Object.freeze({
      launcherPath: fixture.launcherPath,
      canonicalPath: fixture.canonicalPath,
      device: "fixture-device",
      inode: "fixture-inode",
      size: "fixture-size",
      mtimeNanoseconds: "fixture-mtime",
      ctimeNanoseconds: "fixture-ctime",
      sha256: "2".repeat(64),
      version: "codex-fixture 1",
      ...identity,
    }),
    get spawnAttempts() {
      return spawnAttempts;
    },
    async spawnAppServer(options = {}) {
      assert.deepEqual(Object.keys(options), ["signal"]);
      spawnAttempts += 1;
      if (spawnAttempts === rejectBeforeSpawn) {
        throw new CodexLauncherError(
          "IDENTITY_CHANGED",
          `Updater drift before spawn ${spawnAttempts}.`,
        );
      }
      return spawn(process.execPath, [fakeAuthAppServer], {
        cwd: fixture.appCwd,
        env: {
          HOME: fixture.normalHome,
          CODEX_HOME: fixture.codexHome,
          FAKE_CODEX_AUTH_VARIANT: variant,
          FAKE_CODEX_AUTH_INITIAL: fixture.initialAuthenticated
            ? "authenticated"
            : "unauthenticated",
        },
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });
}

function fakeDependencies(fixture) {
  return {
    readOsHome: () => fixture.normalHome,
  };
}

function lifecycleOptions(fixture, onDeviceCode, variant = "compatible") {
  return {
    executionProvider: fakeExecutionProvider(fixture, variant),
    normalHome: fixture.normalHome,
    codexHome: fixture.codexHome,
    appCwd: fixture.appCwd,
    onDeviceCode,
    notificationOptOutMethods: GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
    requestTimeoutMs: 2_000,
    loginTimeoutMs: 2_000,
    releaseInputs: fixture.releaseInputs,
    operatorSha256: fixture.operatorSha256,
    runtimeIdentity: runtimeIdentity(fixture),
    deploymentReadback: deploymentReadback(),
  };
}

async function invocationLog(fixture) {
  const text = await readFile(join(fixture.codexHome, ".fake-auth-invocations.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("auth client method and notification allowlists are exact", () => {
  assert.deepEqual(CODEX_AUTH_REQUEST_METHODS, [
    "initialize",
    "account/read",
    "account/login/start",
    "account/login/cancel",
    "account/logout",
  ]);
  assert.deepEqual(CODEX_AUTH_CLIENT_NOTIFICATIONS, ["initialized"]);
  assert.deepEqual(CODEX_AUTH_SERVER_NOTIFICATIONS, ["account/login/completed"]);
  assert.deepEqual(
    createCodexAuthInitializeParams(GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS)
      .capabilities.optOutNotificationMethods,
    GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
  );
  assert.deepEqual(
    createCodexAuthInitializeParams([]).capabilities.optOutNotificationMethods,
    [],
  );
  assert.throws(
    () => assertCodexAuthRequest("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: "private",
      chatgptAccountId: "private",
    }),
    /restricted to provider-native device code/,
  );
  assert.throws(
    () => assertCodexAuthRequest("account/login/start", { type: "apiKey", apiKey: "" }),
    /restricted to provider-native device code/,
  );
  assert.throws(
    () => assertCodexAuthRequest("account/read", { refreshToken: false, extra: null }),
    /closed auth client contract/,
  );
  assert.throws(
    () => assertCodexAuthRequest("account/logout", null),
    /must omit params/,
  );
});

test("provider-native lifecycle refreshes, restarts, logs out, and leaves the final fresh login", async (t) => {
  const fixture = await createFixture(t);
  const devicePrompts = [];
  const projection = await runCodexAuthLifecycle(
    lifecycleOptions(fixture, async (prompt) => devicePrompts.push(prompt)),
    fakeDependencies(fixture),
  );

  assert.equal(projection.outcome, "authenticated");
  assert.deepEqual(projection.releaseInputs, fixture.releaseInputs);
  assert.deepEqual(projection.account, { kind: "chatgpt", planClass: "pro" });
  assert.equal(projection.environment.processCount, 2);
  assert.equal(projection.environment.dedicatedHomeReadbackCount, 2);
  assert.equal(projection.lifecycle.initialAuthenticated, true);
  assert.equal(projection.lifecycle.preexistingLogoutProved, true);
  assert.equal(projection.lifecycle.freshProcessReadback, true);
  assert.equal(projection.normalStableInputs.unchanged, true);
  assert.equal(devicePrompts.length, 2);
  assert.deepEqual(devicePrompts.map((prompt) => prompt.attempt), [1, 2]);

  const serialized = JSON.stringify(projection);
  for (const secret of [
    fixture.normalHome,
    "private-person@example.test",
    "PRIVATE-CODE-1",
    "PRIVATE-CODE-2",
    "https://device.example.test/verify/private-path",
    "normal-private-auth",
  ]) {
    assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
  }

  const log = await invocationLog(fixture);
  const requests = log.filter((entry) => entry.direction === "request");
  const processIds = new Set(requests.map((entry) => entry.pid));
  assert.equal(processIds.size, 2);
  assert.deepEqual(
    requests.filter((entry) => entry.method === "account/login/start")
      .map((entry) => entry.params),
    [{ type: "chatgptDeviceCode" }, { type: "chatgptDeviceCode" }],
  );
  assert.equal(
    requests.filter((entry) =>
      entry.method === "account/read" && entry.params.refreshToken === true).length,
    3,
  );
  assert.equal(requests.filter((entry) => entry.method === "account/logout").length, 2);
  assert.equal(log.every((entry) => entry.secretSentinelPresent === false), true);
  assert.equal(log.every((entry) => entry.home === fixture.normalHome), true);
  assert.equal(log.every((entry) => entry.codexHome === fixture.codexHome), true);

  assert.throws(
    () => createAuthLifecycleReleaseArtifact({
      stageArtifact: fixture.stageArtifact,
      installedArtifact: fixture.installedArtifact,
      projection,
    }),
    /invalid exact contract/,
  );
});

test("schema-derived opt-outs suppress ambient remote-control status", async (t) => {
  const fixture = await createFixture(t, { initialAuthenticated: false });
  const projection = await runCodexAuthLifecycle(
    lifecycleOptions(fixture, async () => undefined, "remote-control-status"),
    fakeDependencies(fixture),
  );
  assert.equal(projection.outcome, "authenticated");
  assert.equal(
    projection.environment.notificationOptOutMethodCount,
    GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS.length,
  );
  const initializations = (await invocationLog(fixture)).filter(
    (entry) => entry.direction === "request" && entry.method === "initialize",
  );
  assert.equal(initializations.length, 2);
  assert.equal(initializations.every((entry) =>
    JSON.stringify(entry.params.capabilities.optOutNotificationMethods) ===
      JSON.stringify(GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS)), true);

  const missingOptOut = lifecycleOptions(
    fixture,
    async () => undefined,
    "remote-control-status",
  );
  await assert.rejects(
    runCodexAuthLifecycle({
      ...missingOptOut,
      notificationOptOutMethods:
        GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS.filter(
          (method) => method !== "remoteControl/status/changed",
        ),
    }, fakeDependencies(fixture)),
    /outside the auth allowlist/,
  );
});

test("auth lifecycle binds the execution provider to the accepted executable identity", async (t) => {
  const fixture = await createFixture(t, { initialAuthenticated: false });
  for (const identity of [
    { canonicalPath: join(fixture.normalHome, ".local", "lib", "different-codex") },
    { version: "codex-fixture changed" },
    { sha256: "a".repeat(64) },
  ]) {
    const provider = fakeExecutionProvider(fixture, "compatible", { identity });
    const options = lifecycleOptions(fixture, async () => undefined);
    options.executionProvider = provider;
    await assert.rejects(
      runCodexAuthLifecycle(options, fakeDependencies(fixture)),
      /does not match the accepted runtime identity/,
    );
    assert.equal(provider.spawnAttempts, 0);
  }
});

test("updater drift before either provider spawn fails closed without a projection", async (t) => {
  for (const ordinal of [1, 2]) {
    await t.test(`spawn ${ordinal}`, async (subtest) => {
      const fixture = await createFixture(subtest, { initialAuthenticated: false });
      const provider = fakeExecutionProvider(fixture, "compatible", {
        rejectBeforeSpawn: ordinal,
      });
      const options = lifecycleOptions(fixture, async () => undefined);
      options.executionProvider = provider;
      let projection = null;
      let observed;
      try {
        projection = await runCodexAuthLifecycle(options, fakeDependencies(fixture));
      } catch (error) {
        observed = error;
      }
      assert.equal(projection, null);
      assert.ok(observed instanceof CodexLauncherError);
      assert.equal(observed.code, "IDENTITY_CHANGED");
      assert.equal(provider.spawnAttempts, ordinal);
    });
  }
});

test("a bounded device wait attempts provider-native cancellation", async (t) => {
  const fixture = await createFixture(t, { initialAuthenticated: false });
  const options = lifecycleOptions(fixture, async () => undefined, "stalled-login");
  options.loginTimeoutMs = 30;
  await assert.rejects(
    runCodexAuthLifecycle(options, fakeDependencies(fixture)),
    /Timed out waiting for device-code completion/,
  );
  const requests = (await invocationLog(fixture)).filter((entry) => entry.direction === "request");
  assert.equal(requests.some((entry) => entry.method === "account/login/cancel"), true);
});

test("the operator handoff is bounded and sanitizes callback failures", async (t) => {
  const timeoutFixture = await createFixture(t, { initialAuthenticated: false });
  const timeoutOptions = lifecycleOptions(
    timeoutFixture,
    () => new Promise(() => undefined),
    "stalled-login",
  );
  timeoutOptions.handoffTimeoutMs = 30;
  await assert.rejects(
    runCodexAuthLifecycle(
      timeoutOptions,
      fakeDependencies(timeoutFixture),
    ),
    /Timed out presenting the device-code handoff/,
  );
  const timeoutRequests = (await invocationLog(timeoutFixture)).filter(
    (entry) => entry.direction === "request",
  );
  assert.equal(timeoutRequests.some((entry) => entry.method === "account/login/cancel"), true);

  const failureFixture = await createFixture(t, { initialAuthenticated: false });
  let observed;
  try {
    await runCodexAuthLifecycle(
      lifecycleOptions(failureFixture, async () => {
        throw new Error("PRIVATE-CODE-1 https://device.example.test/verify/private-path");
      }, "stalled-login"),
      fakeDependencies(failureFixture),
    );
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof Error);
  assert.match(observed.message, /could not be presented/);
  assert.doesNotMatch(observed.message, /PRIVATE-CODE|device\.example/);
});

test("forbidden server requests receive a JSON-RPC rejection before shutdown", async (t) => {
  const fixture = await createFixture(t, { initialAuthenticated: false });
  await assert.rejects(
    runCodexAuthLifecycle(
      lifecycleOptions(fixture, async () => undefined, "server-request"),
      fakeDependencies(fixture),
    ),
    /forbidden server request/,
  );
  const log = await invocationLog(fixture);
  assert.equal(log.some((entry) => entry.direction === "server-request-rejection"), true);
});

for (const [variant, pattern] of [
  ["wrong-codex-home", /dedicated CODEX_HOME/],
  ["refresh-failure", /rejected account\/read/],
  ["mismatched-login-id", /different login request/],
  ["unknown-notification", /outside the auth allowlist/],
  ["server-request", /forbidden server request/],
  ["api-key-account", /supported ChatGPT account/],
  ["sticky-logout", /remained available after logout/],
  ["restart-loses-auth", /fresh app-server process/],
]) {
  test(`auth lifecycle fails closed for ${variant}`, async (t) => {
    const fixture = await createFixture(t);
    await assert.rejects(
      runCodexAuthLifecycle(
        lifecycleOptions(fixture, async () => undefined, variant),
        fakeDependencies(fixture),
      ),
      pattern,
    );
  });
}

test("provider errors cannot leak through operator diagnostics", async (t) => {
  const fixture = await createFixture(t, { initialAuthenticated: false });
  let observed;
  try {
    await runCodexAuthLifecycle(
      lifecycleOptions(fixture, async () => undefined, "login-failed"),
      fakeDependencies(fixture),
    );
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof Error);
  assert.match(observed.message, /did not complete successfully/);
  assert.doesNotMatch(observed.message, /private-provider-error|DO-NOT-LEAK/);
});

test("normal-home proof ignores volatile runtime files but detects stable-input metadata drift", async (t) => {
  const fixture = await createFixture(t);
  const sessions = join(fixture.normalHome, ".codex", "sessions");
  await mkdir(sessions);
  const volatile = join(sessions, "rollout.jsonl");
  const state = join(fixture.normalHome, ".codex", "state.sqlite");
  await writeFile(volatile, "first\n");
  await writeFile(state, "first\n");
  const before = await snapshotStableNormalCodexInputs(fixture.normalHome);
  await appendFile(volatile, "second\n");
  await appendFile(state, "second\n");
  const afterVolatile = await snapshotStableNormalCodexInputs(fixture.normalHome);
  assert.equal(afterVolatile.identitySha256, before.identitySha256);

  await appendFile(join(fixture.normalHome, ".codex", "config.toml"), "# stable drift\n");
  const afterStable = await snapshotStableNormalCodexInputs(fixture.normalHome);
  assert.notEqual(afterStable.identitySha256, before.identitySha256);
  assert.equal(JSON.stringify(afterStable).includes(fixture.normalHome), false);
});
