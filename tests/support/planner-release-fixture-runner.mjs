#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  releaseCandidateProjection,
} from "./release-evidence-fixtures.mjs";

const entryRoot = process.env.PLANNER_RELEASE_FIXTURE_ENTRY_ROOT;
const harnessPath = process.env.PLANNER_RELEASE_FIXTURE_HARNESS;
const fakeAuthPath = process.env.PLANNER_RELEASE_FIXTURE_FAKE_AUTH;
if (!entryRoot || !harnessPath || !fakeAuthPath) {
  throw new Error("The release fixture runner is missing its closed test coordinates.");
}

const invocationLog = process.env.PLANNER_RELEASE_FIXTURE_INVOCATIONS;
if (invocationLog) {
  const transactionIndex = process.argv.indexOf("--transaction");
  const activationId = transactionIndex >= 0 ? process.argv[transactionIndex + 1] : null;
  const operatorSha256 = process.env.PLANNER_RELEASE_FIXTURE_OPERATOR_SHA256 ?? null;
  let pendingSupersessionCheckpointAtStart = null;
  if (operatorSha256 !== null && activationId !== null) {
    const journal = JSON.parse(await readFile(join(
      process.env.HOME,
      "meal-planner",
      "releases",
      activationId,
      "journal.json",
    ), "utf8"));
    pendingSupersessionCheckpointAtStart = journal.entries.some((entry) =>
      entry.kind === "checkpoint" && entry.name === "pending_supersession");
  }
  await appendFile(invocationLog, `${JSON.stringify({
    entryRoot,
    pid: process.pid,
    command: process.argv[2] ?? null,
    operatorSha256,
    pendingSupersessionCheckpointAtStart,
  })}\n`, { mode: 0o600 });
}

const [{ runPlannerRelease }, composition, authFixture] = await Promise.all([
  import(pathToFileURL(join(entryRoot, "scripts", "planner-release.mjs")).href),
  import(pathToFileURL(join(
    entryRoot,
    "scripts",
    "support",
    "planner-release-composition.mjs",
  )).href),
  import("./fixtures/codex-runtime/auth-schema-fixtures.mjs"),
]);

const environment = {
  ...process.env,
  HOME: process.env.HOME,
  PLANNER_LEGACY_HTTP_PORT: process.env.PLANNER_LEGACY_HTTP_PORT,
};

function fakePreAuth(context) {
  const authSchemaFingerprint = authFixture.assertGeneratedAuthSchemaFixtureFingerprint(
    authFixture.GENERATED_CODEX_AUTH_SCHEMA_FIXTURE_FINGERPRINT,
  );
  const identity = Object.freeze({
    launcherPath: join(context.home, ".local", "bin", "codex"),
    canonicalPath: join(context.home, ".local", "lib", "codex-fixture"),
    device: "fixture-device",
    inode: "fixture-inode",
    size: "fixture-size",
    mtimeNanoseconds: "fixture-mtime",
    ctimeNanoseconds: "fixture-ctime",
    version: "codex-fixture 1",
    sha256: "1".repeat(64),
  });
  return Object.freeze({
    executionProvider: Object.freeze({
      identity,
      async spawnAppServer(options = {}) {
        return spawn(process.execPath, [fakeAuthPath], {
          cwd: context.layout.appRoot,
          env: {
            HOME: context.home,
            CODEX_HOME: context.layout.agentRoot,
            FAKE_CODEX_AUTH_INITIAL: "authenticated",
            FAKE_CODEX_AUTH_VARIANT:
              process.env.PLANNER_RELEASE_FIXTURE_AUTH_VARIANT ?? "compatible",
          },
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    }),
    activationCoordinates: Object.freeze({
      canonicalPath: identity.canonicalPath,
      version: identity.version,
      sha256: identity.sha256,
      schemaFingerprint: "2".repeat(64),
      userConfigSha256: "3".repeat(64),
      systemConfigSha256: "4".repeat(64),
      systemConfigPathCount: 1,
      instructionSha256: "5".repeat(64),
      accountKind: "chatgpt",
    }),
    deploymentReadback: Object.freeze({
      authenticated: true,
      accountKind: "chatgpt",
      permissionProfile: ":read-only",
      effectiveSandbox: "read-only-network-disabled",
      configSourceHashes: {
        "user:0": "3".repeat(64),
        "system:0": "4".repeat(64),
      },
      systemConfigPaths: [join(context.home, "absent-system-config.toml")],
      instructionSourceHashes: { "dedicated:0": "5".repeat(64) },
      skillNames: [],
      mcpServerNames: [],
      appNames: [],
      pluginNames: [],
      runtimeFiles: ["AGENTS.md", "config.toml"],
    }),
    rawSchemaBundleSha256: "6".repeat(64),
    compatibilitySchemaFingerprint: "2".repeat(64),
    authSchemaFingerprint,
    authNotificationOptOutMethods:
      Object.freeze([
        ...authFixture.GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
        "account/login/completed",
      ].sort()),
  });
}

function spawnInstalledRunner(request) {
  const command = request.command ?? "activate";
  const args = [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    harnessPath,
    command,
    "--transaction",
    request.activationId,
  ];
  if (command === "activate") args.push("--authorized");
  if (command === "activate" && request.supersedePending) {
    args.push("--supersede-pending", request.supersedePending);
  }
  if (command === "rollback" && request.authorizeDataLoss) {
    args.push("--authorize-data-loss", request.authorizeDataLoss.value);
  }
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, args, {
      cwd: request.operatorPath,
      env: {
        ...environment,
        PLANNER_RELEASE_FIXTURE_ENTRY_ROOT: request.operatorPath,
        PLANNER_RELEASE_FIXTURE_OPERATOR_SHA256: basename(request.operatorPath),
      },
      stdio: "inherit",
    });
    child.once("error", rejectChild);
    child.once("close", (code, signal) => {
      resolveChild({ exitCode: signal === null ? code ?? 1 : 1 });
    });
  });
}

const overrides = {
  ...(process.env.PLANNER_RELEASE_FIXTURE_DYNAMIC_PREAUTH === "1"
    ? {}
    : { readCodexPreAuth: fakePreAuth }),
  ...(process.env.PLANNER_RELEASE_FIXTURE_AGENT_ADOPTION_FAILURE_POINT
    ? {
        agentAdoptionCheckpoint(name) {
          if (name === process.env.PLANNER_RELEASE_FIXTURE_AGENT_ADOPTION_FAILURE_POINT) {
            throw new Error(`fixture agent-adoption failure at ${name}`);
          }
        },
      }
    : {}),
  authDependencies: {
    readOsHome: () => environment.HOME,
  },
  runReleaseCandidate: async (context) => {
    const runtime = context.authLifecycle.projection.runtimeIdentity;
    return releaseCandidateProjection({
      stageArtifact: context.stage,
      installedArtifact: context.installed,
      authLifecycleArtifact: context.authLifecycle,
      coordinates: {
        canonicalPath: join(
          context.home,
          ".local",
          "lib",
          process.env.PLANNER_RELEASE_FIXTURE_DYNAMIC_PREAUTH === "1"
            ? "codex-fixture.mjs"
            : "codex-fixture",
        ),
        version: runtime.executableVersion,
        sha256: runtime.executableSha256,
        schemaFingerprint: runtime.schemaFingerprint,
        userConfigSha256: runtime.userConfigSha256,
        systemConfigSha256: runtime.systemConfigSha256,
        systemConfigPathCount: 1,
        instructionSha256: runtime.instructionSha256,
      },
    });
  },
  runInstalledQa: async ({ installed }) => ({
    installedUnchanged: true,
    canonicalAppSha256: installed.projection.canonicalApp.sha256,
    deterministicProvider: true,
    releaseEvidence: {
      relativePath: "installed-release/evidence/manifest.json",
      sha256: "7".repeat(64),
    },
  }),
  verifyQaEvidenceManifest: async () => ({ matched: true }),
  verifyCodexActivation: async () => ({ matched: true }),
  releaseDependencies: {
    ...(process.env.PLANNER_RELEASE_FIXTURE_OPERATOR_SHA256
      ? { operatorExecutionSha256: process.env.PLANNER_RELEASE_FIXTURE_OPERATOR_SHA256 }
      : { reexecuteInstalledOperator: spawnInstalledRunner }),
    ...(process.env.PLANNER_RELEASE_FIXTURE_CRASH_POINT
      ? {
          faultInjector: {
            hit(point) {
              if (point === process.env.PLANNER_RELEASE_FIXTURE_CRASH_POINT) {
                process.exit(91);
              }
            },
          },
        }
      : {}),
    ...(process.env.PLANNER_RELEASE_FIXTURE_THROW_POINT
      ? {
          faultInjector: {
            hit(point) {
              if (point === process.env.PLANNER_RELEASE_FIXTURE_THROW_POINT) {
                throw new Error(`fixture release failure at ${point}`);
              }
            },
          },
        }
      : {}),
  },
};

const candidateSource = process.argv[2] === "stage"
  ? process.argv[process.argv.indexOf("--candidate-source") + 1]
  : null;
const dependencies = composition.createPlannerReleaseCompositionDependencies({
  environment,
  candidateSource,
  overrides,
});
const result = await runPlannerRelease(process.argv.slice(2), environment, dependencies);
if (result.output !== null) process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
