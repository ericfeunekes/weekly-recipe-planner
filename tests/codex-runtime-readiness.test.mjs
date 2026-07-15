import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";

import {
  CodexFollowUpRuntimeError,
  createFailSoftManagedCodexFollowUpRuntime,
} from "../server/runtime/codex-follow-up/readiness.ts";
import {
  CodexCompatibilityError,
} from "../server/runtime/codex-follow-up/compatibility.ts";
import {
  CodexCapabilityProbeError,
} from "../server/runtime/codex-follow-up/capability-probe.ts";
import {
  parseCodexFollowUpConfig,
  validateCodexFollowUpDeployment,
} from "../server/runtime/codex-follow-up/deployment.ts";
import { CodexLauncherError } from "../server/runtime/codex-follow-up/launcher.ts";
import { PLANNER_DYNAMIC_TOOL_NAMESPACE } from "../lib/planner-tool-contract.ts";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";
import {
  LEGACY_SIMPLIFIED_PLANNER_NAMESPACE_FIXTURE,
  acceptsOnlyLegacySimplifiedPlannerNamespace,
} from "./support/fixtures/codex-runtime/schema-fixtures.mjs";

function fixtureConfig(fixture) {
  return parseCodexFollowUpConfig(fixture.environment, fixture.plannerDataDirectory);
}

const CONTROL_SHA = "a".repeat(64);
const CONTROL_IDENTITY = Object.freeze({
  launcherPath: "/tmp/codex-managed-test/launcher",
  canonicalPath: "/tmp/codex-managed-test/codex",
  device: "1",
  inode: "2",
  size: "3",
  mtimeNanoseconds: "4",
  ctimeNanoseconds: "5",
  sha256: CONTROL_SHA,
  version: "codex-managed-test",
});
const CONTROL_DEPLOYMENT = Object.freeze({
  codexHome: "/tmp/codex-managed-test/home",
  appCwd: "/tmp/codex-managed-test/app",
  plannerDataDirectory: "/tmp/codex-managed-test/data",
  runtimeDirectory: "/tmp/codex-managed-test/home/.planner-runtime",
  schemaCacheDirectory: "/tmp/codex-managed-test/home/.planner-runtime/schemas",
  evidenceDirectory: "/tmp/codex-managed-test/home/.planner-runtime/evidence",
  launcherPath: CONTROL_IDENTITY.launcherPath,
  normalHome: "/tmp/codex-managed-test/normal-home",
});
const CONTROL_SCHEMA = Object.freeze({
  directory: "/tmp/codex-managed-test/schema",
  rawBundleSha256: "b".repeat(64),
  projection: Object.freeze({}),
  fingerprint: "c".repeat(64),
});
const CONTROL_CAPABILITY = Object.freeze({
  researchWebSearchMode: "live",
  researchTools: ["update_plan", "web_search"],
  plannerTools: ["update_plan", "planner"],
  workerTools: [
    "update_plan", "request_user_input", "spawn_agent", "send_message",
    "followup_task", "wait_agent", "interrupt_agent", "list_agents",
    "skills", "web_search",
  ],
  plannerNamespaceMembers: ["read", "preview", "apply"],
  forbiddenHits: [],
  unexpectedRpcMethods: [],
  plannerReadObserved: true,
  workerWaitCallObserved: true,
  workerWaitResultObserved: true,
  workerResultObserved: true,
  userInputRoundTripObserved: true,
  dependentResultObserved: true,
  outboundPolicyRejected: true,
  approvalPolicy: "never",
  permissionProfile: ":read-only",
  effectiveSandbox: "read-only-network-disabled",
  probeRuntimeFiles: [],
});
const CONTROL_READBACK = Object.freeze({
  authenticated: true,
  accountKind: "chatgpt",
  permissionProfile: ":read-only",
  effectiveSandbox: "read-only-network-disabled",
  configSourceHashes: Object.freeze({
    "user:0": "d".repeat(64),
    "system:0": "e".repeat(64),
  }),
  systemConfigPaths: Object.freeze(["/tmp/codex-managed-test/absent-system.toml"]),
  instructionSourceHashes: Object.freeze({ "dedicated:0": "f".repeat(64) }),
  skillNames: Object.freeze([]),
  mcpServerNames: Object.freeze([]),
  appNames: Object.freeze([]),
  pluginNames: Object.freeze([]),
  runtimeFiles: Object.freeze([]),
});

function createControlledRuntime(executionFactory, options = {}) {
  let captures = 0;
  let executions = 0;
  const runtime = createFailSoftManagedCodexFollowUpRuntime({
    ok: true,
    deployment: CONTROL_DEPLOYMENT,
  }, {
    sourceEnvironment: { HOME: CONTROL_DEPLOYMENT.normalHome },
    evaluationTimeoutMs: options.evaluationTimeoutMs ?? 5_000,
    dependencies: {
      validateDeployment: async () => ({ ok: true, deployment: CONTROL_DEPLOYMENT }),
      captureIdentity: async (...args) => {
        captures += 1;
        await options.onCapture?.(captures, ...args);
        return CONTROL_IDENTITY;
      },
      generateSchema: async (...args) =>
        options.onGenerateSchema?.(captures, ...args) ?? CONTROL_SCHEMA,
      runCapabilityProbe: options.runCapabilityProbe ?? (async () => CONTROL_CAPABILITY),
      readDeployment: async () => CONTROL_READBACK,
      createEvidenceStore: () => ({
        async publishChecking() {},
        async publishFinal() {},
        async readReusablePositive() { return null; },
      }),
      createExecution: (...args) => {
        executions += 1;
        return executionFactory(executions, ...args);
      },
    },
  });
  return {
    runtime,
    captureCount: () => captures,
    executionCount: () => executions,
  };
}

test("capability deadline aborts are unavailable while exact protocol failures stay incompatible", async () => {
  let observedAbort = false;
  const transient = createControlledRuntime(() => ({ close() {} }), {
    evaluationTimeoutMs: 25,
    runCapabilityProbe: async (_identity, _deployment, options) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          observedAbort = true;
          reject(new CodexCapabilityProbeError(
            "PROBE_TIMEOUT",
            "capability probe deadline expired",
          ));
        };
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      }),
  });
  const transientStatus = await transient.runtime.evaluate();
  assert.equal(observedAbort, true);
  assert.equal(transientStatus.state, "unavailable");
  assert.equal(transientStatus.protocolCompatible, null);
  assert.match(transientStatus.detail, /deadline expired|timed out/);
  await transient.runtime.close();

  const protocol = createControlledRuntime(() => ({ close() {} }), {
    runCapabilityProbe: async () => {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "exact provider protocol violation",
      );
    },
  });
  const protocolStatus = await protocol.runtime.evaluate();
  assert.equal(protocolStatus.state, "incompatible");
  assert.equal(protocolStatus.protocolCompatible, false);
  assert.match(protocolStatus.detail, /exact provider protocol violation/);
  await protocol.runtime.close();
});

async function waitUntil(predicate, detail) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(detail);
}

test("managed provider reacquires once after an exact pre-child identity change", async () => {
  let firstSpawns = 0;
  let replacementSpawns = 0;
  const { runtime, executionCount, captureCount } = createControlledRuntime((ordinal) => ({
    identity: CONTROL_IDENTITY,
    async spawnAppServer() {
      if (ordinal === 1) {
        firstSpawns += 1;
        throw new CodexLauncherError("IDENTITY_CHANGED", "updater changed target");
      }
      replacementSpawns += 1;
      return { marker: "replacement-child" };
    },
  }));
  const initialStatus = await runtime.evaluate();
  assert.deepEqual(initialStatus.evidence, {
    canonicalPath: CONTROL_IDENTITY.canonicalPath,
    version: CONTROL_IDENTITY.version,
    sha256: CONTROL_IDENTITY.sha256,
    schemaFingerprint: CONTROL_SCHEMA.fingerprint,
    userConfigSha256: CONTROL_READBACK.configSourceHashes["user:0"],
    systemConfigSha256: CONTROL_READBACK.configSourceHashes["system:0"],
    systemConfigPathCount: 1,
    instructionSha256: CONTROL_READBACK.instructionSourceHashes["dedicated:0"],
    accountKind: "chatgpt",
  });

  const child = await runtime.spawnAppServer();
  assert.equal(child.marker, "replacement-child");
  assert.equal(firstSpawns, 1);
  assert.equal(replacementSpawns, 1);
  assert.equal(executionCount(), 2);
  assert.equal(captureCount(), 2);
  assert.equal(runtime.readStatus().state, "compatible");
  await runtime.close();
});

test("managed provider reacquires once after an exact pre-child provenance change", async () => {
  let spawns = 0;
  const { runtime, executionCount } = createControlledRuntime((ordinal) => ({
    identity: CONTROL_IDENTITY,
    async spawnAppServer() {
      spawns += 1;
      if (ordinal === 1) {
        throw new CodexLauncherError("PROVENANCE_CHANGED", "dedicated config changed");
      }
      return { marker: "accepted-new-provenance" };
    },
  }));
  await runtime.evaluate();

  const child = await runtime.spawnAppServer();
  assert.equal(child.marker, "accepted-new-provenance");
  assert.equal(spawns, 2);
  assert.equal(executionCount(), 2);
  assert.equal(runtime.readStatus().state, "compatible");
  await runtime.close();
});

test("an updater that reevaluates incompatible demotes the runtime without fallback", async () => {
  let oldSpawns = 0;
  const { runtime, executionCount } = createControlledRuntime(() => ({
    identity: CONTROL_IDENTITY,
    async spawnAppServer() {
      oldSpawns += 1;
      throw new CodexLauncherError("IDENTITY_CHANGED", "incompatible updater target");
    },
  }), {
    onGenerateSchema: (ordinal) => {
      if (ordinal === 2) {
        throw new CodexCompatibilityError(
          "SCHEMA_INCOMPATIBLE",
          "The updater target is incompatible.",
        );
      }
      return CONTROL_SCHEMA;
    },
  });
  await runtime.evaluate();

  await assert.rejects(
    runtime.spawnAppServer(),
    (error) => error instanceof CodexFollowUpRuntimeError && error.code === "RUNTIME_NOT_READY",
  );
  assert.equal(oldSpawns, 1);
  assert.equal(executionCount(), 1, "An incompatible evaluation cannot publish execution.");
  assert.equal(runtime.readStatus().state, "incompatible");
  assert.equal(runtime.readStatus().protocolCompatible, false);
  await runtime.close();
});

test("managed provider does not reevaluate or retry an ordinary spawn failure", async () => {
  let spawns = 0;
  const { runtime, executionCount } = createControlledRuntime(() => ({
    identity: CONTROL_IDENTITY,
    async spawnAppServer() {
      spawns += 1;
      throw new CodexLauncherError("PROCESS_FAILED", "ordinary process failure");
    },
  }));
  await runtime.evaluate();

  await assert.rejects(
    runtime.spawnAppServer(),
    (error) => error instanceof CodexLauncherError && error.code === "PROCESS_FAILED",
  );
  assert.equal(spawns, 1);
  assert.equal(executionCount(), 1);
  assert.equal(runtime.readStatus().state, "compatible");
  await runtime.close();
});

test("a second pre-child boundary change is demoted but never spawned a third time", async () => {
  let spawns = 0;
  const { runtime, executionCount } = createControlledRuntime((ordinal) => ({
    identity: CONTROL_IDENTITY,
    async spawnAppServer() {
      spawns += 1;
      if (ordinal === 1) {
        throw new CodexLauncherError("IDENTITY_CHANGED", "first updater change");
      }
      if (ordinal === 2) {
        throw new CodexLauncherError("PROVENANCE_CHANGED", "second updater change");
      }
      return { marker: "must-not-spawn-in-this-call" };
    },
  }));
  await runtime.evaluate();

  await assert.rejects(
    runtime.spawnAppServer(),
    (error) => error instanceof CodexLauncherError && error.code === "PROVENANCE_CHANGED",
  );
  await runtime.evaluate();
  assert.equal(spawns, 2, "The caller gets only one pre-child retry.");
  assert.equal(executionCount(), 3, "The third execution is prepared only for a future caller.");
  assert.equal(runtime.readStatus().state, "compatible");
  await runtime.close();
});

test("concurrent stale callers share reevaluation and cannot invalidate its replacement", async () => {
  let releaseSecondCapture;
  const secondCapture = new Promise((resolve) => {
    releaseSecondCapture = resolve;
  });
  const oldRejectors = [];
  let replacementSpawns = 0;
  const { runtime, executionCount, captureCount } = createControlledRuntime((ordinal) => ({
    identity: CONTROL_IDENTITY,
    spawnAppServer() {
      if (ordinal === 1) {
        return new Promise((_resolve, reject) => oldRejectors.push(reject));
      }
      replacementSpawns += 1;
      return Promise.resolve({ marker: `replacement-${replacementSpawns}` });
    },
  }), {
    onCapture: async (ordinal) => {
      if (ordinal === 2) await secondCapture;
    },
  });
  await runtime.evaluate();
  const first = runtime.spawnAppServer();
  const stale = runtime.spawnAppServer();
  await waitUntil(() => oldRejectors.length === 2, "Both callers did not observe the first execution.");

  oldRejectors[0](new CodexLauncherError("IDENTITY_CHANGED", "first stale caller"));
  await waitUntil(() => captureCount() === 2, "Managed reevaluation did not begin.");
  assert.equal(runtime.readStatus().state, "checking");
  releaseSecondCapture();
  await first;
  assert.equal(runtime.readStatus().state, "compatible");

  oldRejectors[1](new CodexLauncherError("PROVENANCE_CHANGED", "late stale caller"));
  await stale;
  assert.equal(executionCount(), 2, "The stale caller must not start a third evaluation.");
  assert.equal(captureCount(), 2);
  assert.equal(replacementSpawns, 2);
  assert.equal(runtime.readStatus().state, "compatible");
  await runtime.close();
});

test("late stale callers preserve a newer incompatible disposition without reevaluating", async () => {
  const oldRejectors = [];
  const { runtime, captureCount } = createControlledRuntime(() => ({
    identity: CONTROL_IDENTITY,
    spawnAppServer() {
      return new Promise((_resolve, reject) => oldRejectors.push(reject));
    },
  }), {
    onGenerateSchema: (ordinal) => {
      if (ordinal === 2) {
        throw new CodexCompatibilityError(
          "SCHEMA_INCOMPATIBLE",
          "The replacement is incompatible.",
        );
      }
      return CONTROL_SCHEMA;
    },
  });
  await runtime.evaluate();
  const first = runtime.spawnAppServer();
  const stale = runtime.spawnAppServer();
  await waitUntil(() => oldRejectors.length === 2, "Both stale callers did not start.");

  oldRejectors[0](new CodexLauncherError("IDENTITY_CHANGED", "first stale caller"));
  await assert.rejects(first, CodexFollowUpRuntimeError);
  assert.equal(runtime.readStatus().state, "incompatible");
  oldRejectors[1](new CodexLauncherError("IDENTITY_CHANGED", "late stale caller"));
  await assert.rejects(stale, CodexFollowUpRuntimeError);
  assert.equal(captureCount(), 2, "Late stale failure must reuse the completed disposition.");
  assert.equal(runtime.readStatus().state, "incompatible");
  await runtime.close();
});

test("close during evaluation cannot publish a late execution", async () => {
  let observedAbort = false;
  const { runtime, executionCount, captureCount } = createControlledRuntime(() => ({
    identity: CONTROL_IDENTITY,
    async spawnAppServer() {
      return { marker: "must-not-exist" };
    },
  }), {
    onCapture: async (_ordinal, _launcherPath, captureOptions) => new Promise((_resolve, reject) => {
      const fail = () => {
        observedAbort = true;
        reject(captureOptions.signal.reason);
      };
      if (captureOptions.signal.aborted) fail();
      else captureOptions.signal.addEventListener("abort", fail, { once: true });
    }),
  });
  const evaluating = runtime.evaluate();
  await waitUntil(() => captureCount() === 1, "The controlled evaluation did not start.");
  await runtime.close();
  await evaluating;

  assert.equal(observedAbort, true);
  assert.equal(executionCount(), 0);
  assert.equal(runtime.readStatus().state, "unavailable");
  await assert.rejects(
    runtime.spawnAppServer(),
    (error) => error instanceof CodexFollowUpRuntimeError && error.code === "RUNTIME_CLOSED",
  );
});

test("real subprocess readiness proves no-auth capability, actual-home provenance, authentication, and cache reuse", async (t) => {
  const fixture = await createCodexRuntimeFixture({ authenticated: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const config = fixtureConfig(fixture);
  assert.equal(config.ok, true);

  const first = createFailSoftManagedCodexFollowUpRuntime(config, {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 10_000,
  });
  assert.equal(first.readStatus().state, "checking");
  const firstStatus = await first.evaluate();
  assert.equal(firstStatus.state, "compatible");
  assert.equal(Object.hasOwn(firstStatus, "active"), false);
  assert.equal(firstStatus.authenticated, true);
  assert.equal(firstStatus.protocolCompatible, true);
  assert.equal(firstStatus.cacheHit, false);
  assert.ok(firstStatus.evidence.canonicalPath.endsWith("codex-fixture.mjs"));
  assert.match(firstStatus.evidence.userConfigSha256, /^[a-f0-9]{64}$/);
  assert.match(firstStatus.evidence.systemConfigSha256, /^[a-f0-9]{64}$/);
  assert.equal(firstStatus.evidence.systemConfigPathCount, 1);
  assert.match(firstStatus.evidence.instructionSha256, /^[a-f0-9]{64}$/);
  assert.equal(firstStatus.evidence.accountKind, "chatgpt");
  assert.equal(typeof first.spawnAppServer, "function");
  await first.close();
  await first.close();

  const evidence = JSON.parse(await readFile(
    `${fixture.codexHome}/.planner-runtime/evidence/compatibility-v1.json`,
    "utf8",
  ));
  assert.equal(evidence.disposition, "compatible");
  assert.equal(evidence.active, false);
  assert.deepEqual(evidence.capability.researchTools, ["update_plan", "web_search"]);
  assert.deepEqual(evidence.capability.plannerTools, ["update_plan", "planner"]);
  assert.deepEqual(evidence.capability.forbiddenHits, []);
  assert.equal(evidence.deploymentReadback.authenticated, true);
  assert.equal(
    firstStatus.evidence.userConfigSha256,
    Object.entries(evidence.deploymentReadback.configSourceHashes)
      .find(([key]) => key.startsWith("user:"))[1],
  );
  assert.equal(
    firstStatus.evidence.systemConfigSha256,
    Object.entries(evidence.deploymentReadback.configSourceHashes)
      .find(([key]) => key.startsWith("system:"))[1],
  );
  assert.equal(
    firstStatus.evidence.instructionSha256,
    evidence.deploymentReadback.instructionSourceHashes["dedicated:0"],
  );
  assert.deepEqual(evidence.deploymentReadback.mcpServerNames, []);
  assert.deepEqual(evidence.deploymentReadback.appNames, []);
  assert.deepEqual(evidence.deploymentReadback.pluginNames, []);
  assert.equal(JSON.stringify(evidence).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(evidence).includes("OPENAI_API_KEY"), false);

  const second = createFailSoftManagedCodexFollowUpRuntime(config, {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 10_000,
  });
  const secondStatus = await second.evaluate();
  assert.equal(secondStatus.state, "compatible");
  assert.equal(secondStatus.cacheHit, true);
  await second.close();
});

test("capability probe rejects a Codex build that accepts only the obsolete simplified planner schema", async (t) => {
  assert.equal(
    acceptsOnlyLegacySimplifiedPlannerNamespace([
      LEGACY_SIMPLIFIED_PLANNER_NAMESPACE_FIXTURE,
    ]),
    true,
  );
  assert.equal(
    acceptsOnlyLegacySimplifiedPlannerNamespace([PLANNER_DYNAMIC_TOOL_NAMESPACE]),
    false,
  );

  const fixture = await createCodexRuntimeFixture({
    variant: "legacy-simplified-planner-schema-only",
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = createFailSoftManagedCodexFollowUpRuntime(fixtureConfig(fixture), {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 10_000,
  });

  const status = await runtime.evaluate();
  assert.equal(status.state, "incompatible");
  assert.equal(status.protocolCompatible, false);
  assert.match(status.detail, /legacy simplified planner schema/);

  const evidence = await readFile(
    `${fixture.codexHome}/.planner-runtime/evidence/compatibility-v1.json`,
    "utf8",
  );
  assert.doesNotMatch(evidence, /must-not-leak|OPENAI_API_KEY/);
  await runtime.close();
});

test("missing dedicated authentication keeps the managed runtime unavailable without invalidating compatibility", async (t) => {
  const fixture = await createCodexRuntimeFixture({ authenticated: false });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = createFailSoftManagedCodexFollowUpRuntime(fixtureConfig(fixture), {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 10_000,
  });

  const status = await runtime.evaluate();
  assert.equal(status.state, "unauthenticated");
  assert.equal(status.authenticated, false);
  assert.equal(status.protocolCompatible, true);
  assert.equal(status.evidence.accountKind, null);
  assert.match(status.evidence.userConfigSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    runtime.spawnAppServer(),
    (error) => error instanceof CodexFollowUpRuntimeError && error.code === "RUNTIME_NOT_READY",
  );
  assert.match(status.detail, /not authenticated/);
  await runtime.close();
});

test("actual-home readback accepts only canonical normal-home standalone skills", async (t) => {
  const fixture = await createCodexRuntimeFixture({ variant: "user-skill-readback" });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = createFailSoftManagedCodexFollowUpRuntime(fixtureConfig(fixture), {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 10_000,
  });
  const status = await runtime.evaluate();
  assert.equal(status.state, "compatible");
  const evidence = JSON.parse(await readFile(
    `${fixture.codexHome}/.planner-runtime/evidence/compatibility-v1.json`,
    "utf8",
  ));
  assert.deepEqual(evidence.deploymentReadback.skillNames, ["fixture-skill"]);
  await runtime.close();
});

test("required schema drift marks only the managed Codex runtime incompatible", async (t) => {
  const fixture = await createCodexRuntimeFixture({ variant: "incompatible-required" });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = createFailSoftManagedCodexFollowUpRuntime(fixtureConfig(fixture), {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 10_000,
  });

  const status = await runtime.evaluate();
  assert.equal(status.state, "incompatible");
  assert.equal(Object.hasOwn(status, "active"), false);
  assert.equal(status.protocolCompatible, false);
  assert.equal(typeof runtime.spawnAppServer, "function");
  assert.match(status.detail, /required contract|threadId/);
  await runtime.close();
});

for (const [variant, expectedState, pattern] of [
  ["missing-read-only-profile", "incompatible", /read-only profile/],
  ["disallowed-read-only-profile", "incompatible", /disallowed/],
  ["malformed-permission-readback", "incompatible", /omitted data/],
  ["wrong-thread-policy", "incompatible", /read-only, no-network/],
  ["extra-tool", "incompatible", /tools changed|Forbidden/],
  ["wrong-web-flags", "incompatible", /live hosted-search/],
  ["name-only-update-plan", "incompatible", /Native thread tools changed|malformed update_plan/],
  ["other-function-tool", "incompatible", /Native thread tools changed/],
  ["wrong-planner-members", "incompatible", /namespace description or input schemas/],
  ["malformed-planner-member", "incompatible", /namespace description or input schemas/],
  ["stripped-planner-schemas", "incompatible", /namespace description or input schemas/],
  ["broadened-planner-schemas", "incompatible", /namespace description or input schemas/],
  ["stripped-planner-command-union", "incompatible", /namespace description or input schemas/],
  ["parallel-tools", "incompatible", /parallel tool calls/],
  ["extra-provider-call", "incompatible", /exactly eight local provider calls/],
  ["missing-worker-provider-call", "incompatible", /worker never reached the local provider/],
  ["stripped-worker-capability", "incompatible", /Worker tools changed/],
  ["worker-planner-namespace", "incompatible", /Worker tools changed/],
  ["worker-wrong-parent", "incompatible", /bind the spawned worker to its exact parent/],
  ["worker-wait-call-not-returned", "incompatible", /exact bounded wait_agent call/],
  ["worker-wait-result-not-returned", "incompatible", /exact successful wait_agent result/],
  ["worker-report-not-returned", "incompatible", /spawned worker report/],
  ["unexpected-approval-request", "incompatible", /Unexpected app-server methods/],
  ["provider-violation-then-stall", "incompatible", /outside its exact route/],
  ["wrong-terminal-thread", "incompatible", /mismatched or unsuccessful terminal/],
  ["failed-terminal-status", "incompatible", /mismatched or unsuccessful terminal/],
  ["rpc-unknown-notification", "incompatible", /undeclared notification/],
  ["rpc-unknown-response-id", "incompatible", /unknown JSON-RPC response id/],
  ["rpc-null-method", "incompatible", /malformed JSON-RPC method/],
  ["rpc-malformed-request-id", "incompatible", /malformed JSON-RPC id/],
  ["rpc-error-notification", "incompatible", /terminal error notification/],
  ["rpc-malformed-error-envelope", "incompatible", /malformed JSON-RPC error envelope/],
  ["rpc-oversized-frame", "incompatible", /oversized(?: unterminated)? JSONL frame/],
  ["rpc-frame-flood", "incompatible", /frame-count budget/],
  ["rpc-queue-flood", "incompatible", /queued-notification budget/],
  ["malformed-mcp-readback", "unavailable", /omitted data/],
  ["paginated-hidden-mcp", "unavailable", /exposes MCP/],
  ["malformed-app-readback", "unavailable", /omitted data/],
  ["app-surface", "unavailable", /MCP, app, or installed plugin/],
  ["malformed-plugin-readback", "unavailable", /omitted marketplaces/],
  ["extra-instruction-source", "unavailable", /canonical instruction source/],
  ["same-content-instruction-substitute", "unavailable", /canonical instruction source/],
  ["instruction-symlink-escape", "unavailable", /canonical instruction source/],
  ["unknown-config-layer", "unavailable", /undeclared layer type/],
  ["wrong-user-config-path", "unavailable", /not sourced from the dedicated/],
  ["config-missing-config", "unavailable", /required config or origins/],
  ["config-missing-origins", "unavailable", /required config or origins/],
  ["config-wrong-shape", "unavailable", /required config or origins/],
  ["origins-wrong-shape", "unavailable", /required config or origins/],
  ["wrong-effective-login-policy", "unavailable", /force ChatGPT login/],
  ["wrong-user-login-policy", "unavailable", /ChatGPT login with file-backed credentials/],
  ["wrong-credential-store", "unavailable", /ChatGPT login with file-backed credentials/],
  ["missing-system-layer", "unavailable", /omitted the empty system config layer/],
  ["system-file-wrong-shape", "unavailable", /malformed or duplicate file source/],
  ["system-file-relative", "unavailable", /malformed or duplicate file source/],
  ["system-file-existing", "unavailable", /names an existing file/],
  ["system-config-active", "unavailable", /contains active configuration/],
  ["duplicate-system-layer", "unavailable", /malformed or duplicate file source/],
  ["auth-api-key", "unavailable", /non-ChatGPT/],
  ["missing-account-field", "unavailable", /malformed response/],
  ["malformed-account-readback", "unavailable", /malformed response/],
  ["skill-loader-error", "unavailable", /loader errors/],
  ["repo-skill-readback", "unavailable", /malformed skill/],
  ["noncanonical-skill-path", "unavailable", /outside the normal standalone-skill root/],
  ["skill-directory-readback", "unavailable", /non-file or non-canonical skill/],
  ["pagination-malformed-cursor", "unavailable", /malformed cursor/],
  ["pagination-empty-cursor", "unavailable", /malformed cursor/],
  ["pagination-repeated-cursor", "unavailable", /repeated a pagination cursor/],
  ["pagination-too-many-pages", "unavailable", /exceeded its page budget/],
  ["pagination-too-many-rows", "unavailable", /exceeded its row budget/],
  ["plugin-surface", "unavailable", /marketplace surface/],
  ["oversize-provenance", "unavailable", /within budget/],
]) {
  test(`strict external readback fails closed for ${variant}`, async (t) => {
    const fixture = await createCodexRuntimeFixture({ variant });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const runtime = createFailSoftManagedCodexFollowUpRuntime(fixtureConfig(fixture), {
      sourceEnvironment: fixture.environment,
      evaluationTimeoutMs: 10_000,
    });
    const status = await runtime.evaluate();
    assert.equal(status.state, expectedState, JSON.stringify(status));
    assert.match(status.detail, pattern);
    assert.equal(typeof runtime.spawnAppServer, "function");
    await runtime.close();
  });
}

test("invalid configuration and injected construction/evaluation failures are fail soft", async (t) => {
  const invalid = parseCodexFollowUpConfig({
    HOME: "/tmp",
    PLANNER_CODEX_HOME: "relative",
    PLANNER_CODEX_CWD: "/tmp/app",
  }, "/tmp/data");
  const invalidRuntime = createFailSoftManagedCodexFollowUpRuntime(invalid);
  assert.equal((await invalidRuntime.evaluate()).state, "unavailable");

  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const config = fixtureConfig(fixture);
  assert.equal(config.ok, true);
  const validation = await validateCodexFollowUpDeployment(config.deployment);
  assert.equal(validation.ok, true);

  const throwing = createFailSoftManagedCodexFollowUpRuntime(config, {
    sourceEnvironment: fixture.environment,
    dependencies: {
      validateDeployment: async () => {
        throw new Error("injected validation failure");
      },
    },
  });
  const status = await throwing.evaluate();
  assert.equal(status.state, "unavailable");
  assert.match(status.detail, /injected validation failure/);
});

test("the overall evaluation deadline aborts a blocked subprocess boundary fail soft", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const config = fixtureConfig(fixture);
  assert.equal(config.ok, true);
  const validation = await validateCodexFollowUpDeployment(config.deployment);
  assert.equal(validation.ok, true);

  let observedAbort = false;
  const runtime = createFailSoftManagedCodexFollowUpRuntime(config, {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 25,
    dependencies: {
      validateDeployment: async () => validation,
      createEvidenceStore: () => ({
        async publishChecking() {},
        async publishFinal() {},
        async readReusablePositive() { return null; },
      }),
      captureIdentity: async (_launcherPath, options) => new Promise((_resolve, reject) => {
        const rejectForAbort = () => {
          observedAbort = true;
          reject(options.signal?.reason ?? new Error("aborted"));
        };
        if (options.signal?.aborted) rejectForAbort();
        else options.signal?.addEventListener("abort", rejectForAbort, { once: true });
      }),
    },
  });

  const startedAt = Date.now();
  const status = await runtime.evaluate();
  assert.equal(observedAbort, true);
  assert.equal(status.state, "unavailable");
  assert.match(status.detail, /timed out/);
  assert.ok(Date.now() - startedAt < 1_000);
  await runtime.close();
});

test("a deadline during the disposable app-server capability turn is transient", async (t) => {
  const fixture = await createCodexRuntimeFixture({ variant: "capability-hang" });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = createFailSoftManagedCodexFollowUpRuntime(fixtureConfig(fixture), {
    sourceEnvironment: fixture.environment,
    evaluationTimeoutMs: 5_000,
  });

  const status = await runtime.evaluate();
  assert.equal(status.state, "unavailable", JSON.stringify(status));
  assert.equal(status.protocolCompatible, null);
  assert.match(status.detail, /capability observation was aborted/);
  await runtime.close();
});
