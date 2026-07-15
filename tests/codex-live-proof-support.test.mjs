import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  collectCandidateSourceManifest,
  collectDedicatedRuntimeRetention,
  createHostOnlyGlobalClientRunner,
  parseSupportedGlobalClientOutput,
  readObservedCapabilityProjection,
  snapshotNormalCodexState,
} from "../scripts/support/codex-live-proof.mjs";

const coordinates = Object.freeze({
  canonicalPath: "/tmp/fake-codex",
  version: "fake-codex compatible",
  sha256: "a".repeat(64),
  schemaFingerprint: "b".repeat(64),
  userConfigSha256: "c".repeat(64),
  systemConfigSha256: "d".repeat(64),
  systemConfigPathCount: 1,
  instructionSha256: "e".repeat(64),
  accountKind: "chatgpt",
});

test("normal Codex snapshot binds auth, config, session, and plugin state without paths or content", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planner-normal-codex-proof-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codex = join(home, ".codex");
  await Promise.all([
    mkdir(join(codex, "sessions"), { recursive: true }),
    mkdir(join(codex, "plugins"), { recursive: true }),
    mkdir(join(codex, "sqlite"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(codex, "auth.json"), "credential-sentinel\n", { mode: 0o600 }),
    writeFile(join(codex, "config.toml"), "model = 'sentinel'\n", { mode: 0o600 }),
    writeFile(join(codex, "AGENTS.md"), "ambient-instructions\n", { mode: 0o600 }),
    writeFile(join(codex, "session_index.jsonl"), "ambient-index\n", { mode: 0o600 }),
    writeFile(join(codex, "sessions", "session.jsonl"), "session-sentinel\n", { mode: 0o600 }),
    writeFile(join(codex, "sessions", "stable.jsonl"), "original-same-size\n", { mode: 0o600 }),
    writeFile(join(codex, "plugins", "plugin.json"), "plugin-sentinel\n", { mode: 0o600 }),
    writeFile(join(codex, "sqlite", "state_5.sqlite"), "sqlite-state-sentinel\n", { mode: 0o600 }),
    writeFile(join(codex, "logs_2.sqlite"), "sqlite-log-sentinel\n", { mode: 0o600 }),
    writeFile(join(codex, ".codex-global-state.json"), "current-global-state\n", { mode: 0o600 }),
    writeFile(join(codex, "..codex-global-state.fixture"), "global-state-sentinel\n", { mode: 0o600 }),
  ]);
  const largeRootLog = await open(join(codex, "logs_2.sqlite"), "r+");
  await largeRootLog.truncate(600 * 1_024 * 1_024);
  await largeRootLog.close();
  const before = await snapshotNormalCodexState(home);
  const serialized = JSON.stringify(before);
  for (const forbidden of ["credential-sentinel", "session-sentinel", "plugin.json", "auth.json"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(Object.keys(before.categories).sort(), [
    "ambient",
    "auth",
    "config",
    "plugins",
    "runtime_databases",
    "runtime_state",
    "sessions",
  ]);
  const stablePath = join(codex, "sessions", "stable.jsonl");
  const stableMetadata = await stat(stablePath);
  const replacementPath = join(codex, "sessions", "replacement.jsonl");
  await writeFile(replacementPath, "replaced-same-size\n", { mode: 0o600 });
  await utimes(replacementPath, stableMetadata.atime, stableMetadata.mtime);
  await rename(replacementPath, stablePath);
  const sameSizeReplacement = await snapshotNormalCodexState(home);
  assert.notEqual(sameSizeReplacement.identitySha256, before.identitySha256);
  await writeFile(join(codex, "sessions", "session.jsonl"), "changed-session\n", { mode: 0o600 });
  const after = await snapshotNormalCodexState(home);
  assert.notEqual(after.identitySha256, sameSizeReplacement.identitySha256);
  await writeFile(join(codex, "sqlite", "state_5.sqlite"), "changed-sqlite-state\n", { mode: 0o600 });
  const sqliteChanged = await snapshotNormalCodexState(home);
  assert.notEqual(sqliteChanged.identitySha256, after.identitySha256);
  await writeFile(join(codex, "logs_2.sqlite"), "changed-root-log\n", { mode: 0o600 });
  const rootLogChanged = await snapshotNormalCodexState(home);
  assert.notEqual(rootLogChanged.identitySha256, sqliteChanged.identitySha256);
  await writeFile(join(codex, ".codex-global-state.json"), "changed-global-state\n", { mode: 0o600 });
  assert.notEqual(
    (await snapshotNormalCodexState(home)).identitySha256,
    rootLogChanged.identitySha256,
  );
  const globalStateChanged = await snapshotNormalCodexState(home);
  await writeFile(join(codex, "AGENTS.md"), "changed-instructions\n", { mode: 0o600 });
  const ambientChanged = await snapshotNormalCodexState(home);
  assert.notEqual(ambientChanged.identitySha256, globalStateChanged.identitySha256);
  await writeFile(join(codex, "session_index.jsonl"), "changed-index\n", { mode: 0o600 });
  const indexChanged = await snapshotNormalCodexState(home);
  assert.notEqual(indexChanged.identitySha256, ambientChanged.identitySha256);
  await mkdir(join(codex, "unexpected-empty-directory"));
  const emptyDirectoryChanged = await snapshotNormalCodexState(home);
  assert.notEqual(emptyDirectoryChanged.identitySha256, indexChanged.identitySha256);
  assert.equal(emptyDirectoryChanged.directories.count, indexChanged.directories.count + 1);
  const transientPath = join(codex, "transient-directory");
  await mkdir(transientPath);
  await rm(transientPath, { recursive: true });
  const transientChanged = await snapshotNormalCodexState(home);
  assert.notEqual(transientChanged.identitySha256, emptyDirectoryChanged.identitySha256);
  assert.equal(transientChanged.directories.count, emptyDirectoryChanged.directories.count);
});

test("dedicated retention inventory proves ephemeral rows empty and records bounded log counts", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planner-dedicated-retention-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const authPath = join(home, "auth.json");
  await writeFile(authPath, "fixture-credential-bytes\n", { mode: 0o600 });
  const statePath = join(home, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE threads (id TEXT);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT);
    CREATE TABLE agent_jobs (id TEXT);
    CREATE TABLE agent_job_items (id TEXT);
  `);
  state.close();
  const logs = new DatabaseSync(join(home, "logs_2.sqlite"));
  logs.exec("CREATE TABLE logs (id INTEGER); INSERT INTO logs VALUES (1);");
  logs.close();

  const sourceEntriesBefore = (await readdir(home)).sort();
  const retention = await collectDedicatedRuntimeRetention(home);
  assert.deepEqual((await readdir(home)).sort(), sourceEntriesBefore);
  assert.deepEqual(retention.ephemeralCounts, {
    threads: 0,
    thread_dynamic_tools: 0,
    agent_jobs: 0,
    agent_job_items: 0,
  });
  assert.equal(retention.logRows, 1);
  assert.deepEqual(retention.credentials, {
    present: true,
    kind: "file",
    ownerUid: process.getuid(),
    mode: 0o600,
    linkCount: 1,
    contentHashed: false,
  });
  assert.equal(Object.hasOwn(retention.classes, "auth"), false);
  assert.equal(JSON.stringify(retention).includes("state_5.sqlite"), false);
  assert.equal(JSON.stringify(retention).includes("fixture-credential-bytes"), false);

  await writeFile(authPath, "different fixture credential bytes with a different size\n", {
    mode: 0o600,
  });
  const afterCredentialChange = await collectDedicatedRuntimeRetention(home);
  assert.deepEqual(afterCredentialChange.classes, retention.classes);
  assert.equal(afterCredentialChange.files, retention.files);
  assert.equal(afterCredentialChange.bytes, retention.bytes);
  assert.deepEqual(afterCredentialChange.credentials, retention.credentials);

  await chmod(authPath, 0o644);
  await assert.rejects(
    collectDedicatedRuntimeRetention(home),
    /private metadata-only file/,
  );
  await chmod(authPath, 0o600);

  const reopened = new DatabaseSync(statePath);
  reopened.exec("INSERT INTO threads VALUES ('forbidden-thread')");
  reopened.close();
  await assert.rejects(
    collectDedicatedRuntimeRetention(home),
    /persisted forbidden thread\/tool\/job rows/,
  );
});

test("capability projection is bound to the same activation coordinates", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "planner-capability-projection-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const evidenceDirectory = join(home, ".planner-runtime", "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, "compatibility-v1.json"), JSON.stringify({
    contractVersion: 1,
    evaluatedAt: "2026-07-11T00:00:00.000Z",
    disposition: "compatible",
    active: false,
    executable: {
      canonicalPath: coordinates.canonicalPath,
      version: coordinates.version,
      sha256: coordinates.sha256,
    },
    schemaFingerprint: coordinates.schemaFingerprint,
    rawSchemaBundleSha256: "f".repeat(64),
    capability: {
      researchWebSearchMode: "live",
      researchTools: ["update_plan", "web_search"],
      plannerTools: ["update_plan", "planner"],
      plannerNamespaceMembers: ["read", "preview", "apply"],
      forbiddenHits: [],
      unexpectedRpcMethods: [],
      dependentResultObserved: true,
      outboundPolicyRejected: true,
      permissionProfile: ":read-only",
      effectiveSandbox: "read-only-network-disabled",
    },
    deploymentReadback: {
      authenticated: true,
      accountKind: "chatgpt",
      configSourceHashes: {
        "user:0": coordinates.userConfigSha256,
        "system:0": coordinates.systemConfigSha256,
      },
      systemConfigPaths: ["/etc/codex/config.toml"],
      instructionSourceHashes: { "dedicated:0": coordinates.instructionSha256 },
      mcpServerNames: [],
      appNames: [],
      pluginNames: [],
    },
  }), { mode: 0o600 });
  const projection = await readObservedCapabilityProjection(home, coordinates);
  assert.equal(projection.researchWebSearchMode, "live");
  assert.deepEqual(projection.plannerNamespaceMembers, ["read", "preview", "apply"]);
  await assert.rejects(
    readObservedCapabilityProjection(home, { ...coordinates, sha256: "0".repeat(64) }),
    /not bound and closed/,
  );
});

test("candidate manifest covers every source root and excludes only generated or runtime roots", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-candidate-manifest-")));
  const dependencyRoot = await realpath(await mkdtemp(join(tmpdir(), "planner-dependencies-")));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(dependencyRoot, { recursive: true, force: true }),
  ]));
  await Promise.all([
    mkdir(join(root, ".openai"), { recursive: true }),
    mkdir(join(root, "public"), { recursive: true }),
    mkdir(join(root, "worker"), { recursive: true }),
    mkdir(join(root, "outputs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, ".openai", "hosting.json"), "{\"main\":\"worker/index.ts\"}\n"),
    writeFile(join(root, "public", "og.png"), "image-source\n"),
    writeFile(join(root, "worker", "index.ts"), "export default {};\n"),
    writeFile(join(root, "outputs", "runtime-proof.json"), "ignored-runtime-output\n"),
    writeFile(join(dependencyRoot, "private"), "ignored-dependency\n"),
  ]);
  await symlink(dependencyRoot, join(root, "node_modules"));

  const before = await collectCandidateSourceManifest(root);
  await writeFile(join(root, "worker", "index.ts"), "export default { changed: true };\n");
  const workerChanged = await collectCandidateSourceManifest(root);
  assert.notEqual(workerChanged.sha256, before.sha256);
  await writeFile(join(root, "outputs", "runtime-proof.json"), "changed-runtime-output\n");
  assert.deepEqual(await collectCandidateSourceManifest(root), workerChanged);
  await writeFile(join(dependencyRoot, "private"), "changed-dependency\n");
  assert.deepEqual(await collectCandidateSourceManifest(root), workerChanged);
});

test("candidate manifest covers the complete local source surface and supported client output is closed", async () => {
  const manifest = await collectCandidateSourceManifest();
  assert.ok(manifest.files > 100);
  assert.ok(manifest.bytes > 1_000);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseSupportedGlobalClientOutput("health", {
    code: 0,
    signal: null,
    stdout: JSON.stringify({ contractVersion: 1, status: "ready", serverTime: 1 }),
    stderr: "",
  }), { contractVersion: 1, status: "ready", serverTime: 1 });
  assert.throws(() => parseSupportedGlobalClientOutput("health", {
    code: 0,
    signal: null,
    stdout: "{}",
    stderr: "",
  }), /invalid contract/);
});

test("host-only Global UDS client runner keeps the production grammar closed", async () => {
  const runner = createHostOnlyGlobalClientRunner("/tmp/private/global-codex.sock");
  await assert.rejects(() => runner("unknown", null), /Unsupported Global UDS/u);
  await assert.rejects(() => runner("health", "{}"), /do not accept input/u);
  await assert.rejects(() => runner("apply", "not-json"), /not valid JSON/u);
  await assert.rejects(() => runner("apply", "{}"), /contract version 1/u);
});
