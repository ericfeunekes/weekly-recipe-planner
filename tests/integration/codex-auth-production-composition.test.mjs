import assert from "node:assert/strict";
import {
  access,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  createProductionActivationPort,
} from "../../scripts/support/planner-release-composition.mjs";
import {
  loadAndValidateCodexAuthReadinessSchemaBundle,
} from "../../scripts/support/codex-auth-schema.mjs";
import {
  createActivationId,
  createReleaseArtifact,
  derivePlannerReleaseLayout,
  ensurePrivateDirectory,
  readReleaseArtifact,
} from "../../scripts/support/planner-release-contract.mjs";
import { createCodexRuntimeFixture } from "../../scripts/support/codex-runtime-fixture.mjs";
import {
  GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
} from "../support/fixtures/codex-runtime/auth-schema-fixtures.mjs";

const packageRoot = resolve(new URL("../../", import.meta.url).pathname);
const AUTH_NOTIFICATION_OPT_OUT_METHODS = Object.freeze([
  ...GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
  "account/login/completed",
].sort());

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createFixture(t, {
  authenticated = true,
  variant = "compatible-a",
  afterPreAuthBeforeFirstChild,
} = {}) {
  const runtime = await createCodexRuntimeFixture({ authenticated, variant });
  t.after(() => rm(runtime.root, { recursive: true, force: true }));

  const activationId = createActivationId();
  const derivedLayout = derivePlannerReleaseLayout(runtime.normalHome, activationId);
  for (const path of [
    derivedLayout.root,
    derivedLayout.releasesRoot,
    derivedLayout.transactionRoot,
  ]) {
    await ensurePrivateDirectory(path);
  }
  const layout = Object.freeze({
    ...derivedLayout,
    appRoot: packageRoot,
    agentRoot: runtime.codexHome,
    dataRoot: runtime.plannerDataDirectory,
  });
  const operatorSha256 = "c".repeat(64);
  const stage = createReleaseArtifact({
    artifactType: "stage",
    activationId,
    projection: { fixture: "production-auth-composition" },
  });
  const installed = createReleaseArtifact({
    artifactType: "installed",
    activationId,
    predecessorSha256: stage.sha256,
    projection: { operatorSha256 },
  });
  const context = {
    home: runtime.normalHome,
    activationId,
    layout,
    stage,
    installed,
    operatorSha256,
    drain: {
      storeModule: {},
      async prepare() {},
    },
  };
  const generatedSchemaDirectories = [];
  const port = await createProductionActivationPort(context, {
    environment: runtime.environment,
    async loadAuthReadinessSchemaBundle(schemaDirectory) {
      generatedSchemaDirectories.push(schemaDirectory);
      await access(join(schemaDirectory, "v1", "InitializeParams.json"));
      return loadAndValidateCodexAuthReadinessSchemaBundle(schemaDirectory);
    },
    authDependencies: {
      async readOsHome() {
        await afterPreAuthBeforeFirstChild?.();
        return runtime.normalHome;
      },
    },
  });

  return {
    runtime,
    context,
    layout,
    stage,
    installed,
    operatorSha256,
    port,
    generatedSchemaDirectories,
    async swapUpdaterTarget() {
      const accepted = await readFile(runtime.launcherTargetPath, "utf8");
      const marker = 'const bakedFixtureVariant = "compatible-a";';
      assert.match(accepted, /const bakedFixtureVariant = "compatible-a";/);
      const replacement = join(dirname(runtime.launcherTargetPath), "codex-fixture-b.mjs");
      await writeFile(
        replacement,
        accepted.replace(marker, 'const bakedFixtureVariant = "compatible-b";'),
        { mode: 0o700 },
      );
      await rename(replacement, runtime.launcherTargetPath);
    },
    async driftDeploymentProvenance(source) {
      if (source === "absent system config") {
        const path = join(dirname(runtime.codexHome), "absent-system-config.toml");
        assert.equal(await pathExists(path), false);
        await writeFile(path, "# became present after pre-auth\n", { mode: 0o600 });
        return;
      }
      const path = join(
        runtime.codexHome,
        source === "config.toml" ? "config.toml" : "AGENTS.md",
      );
      const accepted = await readFile(path, "utf8");
      await writeFile(
        path,
        `${accepted}\n# changed after pre-auth\n`,
        { mode: 0o600 },
      );
    },
  };
}

function authInitializations(invocations) {
  return invocations.filter((entry) => entry.event === "auth-initialize");
}

function assertAcceptedPrivateAuthSnapshots(fixture, projection, starts, expectedCount) {
  assert.equal(starts.length, expectedCount);
  assert.equal(new Set(starts.map((entry) => entry.pid)).size, expectedCount);
  const expectedPath = join(
    fixture.runtime.codexHome,
    ".planner-runtime",
    "execution-snapshots",
    projection.runtimeIdentity.executableSha256,
    "codex.mjs",
  );
  assert.equal(starts.every((entry) => entry.executablePath === expectedPath), true);
  assert.equal(starts.every((entry) => entry.executableMode === 0o700), true);
  assert.equal(starts.every((entry) => entry.executableUid === process.getuid()), true);
  assert.equal(starts.every((entry) => entry.bakedFixtureVariant === "compatible-a"), true);
}

function assertOnlyAcceptedPrivateAuthStarts(starts, expectedCount) {
  assert.equal(starts.length, expectedCount);
  assert.equal(new Set(starts.map((entry) => entry.pid)).size, expectedCount);
  assert.equal(
    starts.every((entry) =>
      /\/execution-snapshots\/[a-f0-9]{64}\/codex\.mjs$/u.test(entry.executablePath)),
    true,
  );
  assert.equal(starts.every((entry) => entry.executableMode === 0o700), true);
  assert.equal(starts.every((entry) => entry.executableUid === process.getuid()), true);
}

async function assertRejectedAuthEffect({
  fixture,
  errorCode,
  expectedStarts,
  expectedProtocolEvents,
}) {
  const effect = await fixture.port.createAuthLifecycleEffect(fixture.context);

  await assert.rejects(
    effect.perform(),
    (error) => error?.code === errorCode,
  );

  assert.equal((await effect.inspect()).classification, "pre");
  assert.equal(await pathExists(fixture.layout.authLifecyclePath), false);
  const invocations = await fixture.runtime.invocations();
  assertOnlyAcceptedPrivateAuthStarts(
    authInitializations(invocations),
    expectedStarts,
  );
  if (expectedProtocolEvents !== undefined) {
    assert.deepEqual(
      invocations.filter((entry) => entry.event.startsWith("auth-"))
        .filter((entry) => entry.authOperator === true)
        .map((entry) => ({ event: entry.event, refreshToken: entry.refreshToken })),
      expectedProtocolEvents,
    );
  }
}

test("production auth readiness reuses credentials through one fresh auth-readback app-server", async (t) => {
  const fixture = await createFixture(t);
  const effect = await fixture.port.createAuthLifecycleEffect(fixture.context);

  assert.equal((await effect.inspect()).classification, "pre");
  await effect.perform();
  assert.equal((await effect.inspect()).classification, "post");

  const artifact = await readReleaseArtifact(fixture.layout.authLifecyclePath, {
    artifactType: "auth-lifecycle",
    activationId: fixture.context.activationId,
    predecessorSha256: fixture.installed.sha256,
    operatorSha256: fixture.operatorSha256,
  });
  assert.equal(artifact.projection.outcome, "authenticated");
  assert.equal(artifact.projection.environment.authReadbackProcessCount, 1);
  assert.equal(Object.hasOwn(artifact.projection.environment, "processCount"), false);
  assert.equal(artifact.projection.environment.dedicatedHomeReadbackCount, 1);
  assert.deepEqual(artifact.projection.account, { kind: "chatgpt" });
  assert.deepEqual(artifact.projection.readiness, {
    existingDedicatedCredentialsReused: true,
    freshProcessReadback: true,
    proactiveRefreshReadback: true,
    credentialMutationRequestsAllowed: false,
  });
  assert.equal(artifact.projection.runtimeIdentity.executableVersion, "fake-codex compatible-a");
  assert.match(artifact.projection.schemaBinding.authSchemaFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(artifact.projection.schemaBinding.contractKind, "authenticatedReadback");
  assert.equal(Object.hasOwn(artifact.projection.schemaBinding, "selectedLoginType"), false);
  assert.equal(
    artifact.projection.environment.notificationOptOutMethodCount,
    AUTH_NOTIFICATION_OPT_OUT_METHODS.length,
  );
  assert.equal(fixture.generatedSchemaDirectories.length, 1);
  assertAcceptedPrivateAuthSnapshots(
    fixture,
    artifact.projection,
    authInitializations(await fixture.runtime.invocations()),
    1,
  );
  const protocolEvents = (await fixture.runtime.invocations())
    .filter((entry) => entry.event.startsWith("auth-") && entry.authOperator === true);
  assert.deepEqual(protocolEvents.map((entry) => entry.event), [
    "auth-initialize",
    "auth-account-read",
  ]);
  assert.equal(protocolEvents[1].refreshToken, true);
});

test("production auth readiness fails closed when dedicated credentials are unavailable", async (t) => {
  const fixture = await createFixture(t, { authenticated: false });
  await assertRejectedAuthEffect({
    fixture,
    errorCode: "AUTH_REQUIRED",
    expectedStarts: 1,
    expectedProtocolEvents: [
      { event: "auth-initialize", refreshToken: undefined },
      { event: "auth-account-read", refreshToken: true },
    ],
  });
});

test("production auth readiness rejects a non-ChatGPT credential mode", async (t) => {
  const fixture = await createFixture(t, { variant: "auth-api-key" });
  await assertRejectedAuthEffect({
    fixture,
    errorCode: "READBACK_PROVENANCE",
    expectedStarts: 0,
  });
});

test("production auth readiness suppresses its artifact when the updater swaps before the child", async (t) => {
  let fixture;
  fixture = await createFixture(t, {
    afterPreAuthBeforeFirstChild: async () => fixture.swapUpdaterTarget(),
  });

  await assertRejectedAuthEffect({
    fixture,
    errorCode: "IDENTITY_CHANGED",
    expectedStarts: 0,
  });
});

test("production auth readiness rejects deployment provenance drift before the child", async (t) => {
  const sources = ["config.toml", "AGENTS.md", "absent system config"];

  for (const source of sources) {
    await t.test(source, async (subtest) => {
      let fixture;
      fixture = await createFixture(subtest, {
        afterPreAuthBeforeFirstChild: async () => fixture.driftDeploymentProvenance(source),
      });

      await assertRejectedAuthEffect({
        fixture,
        errorCode: "PROVENANCE_CHANGED",
        expectedStarts: 0,
      });
    });
  }
});

test("production auth readiness rejects every server notification", async (t) => {
  const fixture = await createFixture(t, { variant: "auth-unexpected-notification" });
  await assertRejectedAuthEffect({
    fixture,
    errorCode: "AUTH_PROTOCOL",
    expectedStarts: 1,
  });
});

test("production auth readiness rejects a notification emitted while the fresh process closes", async (t) => {
  const fixture = await createFixture(t, { variant: "auth-late-notification" });
  await assertRejectedAuthEffect({
    fixture,
    errorCode: "AUTH_PROTOCOL",
    expectedStarts: 1,
  });
});
