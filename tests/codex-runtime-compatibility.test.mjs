import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_FOLLOW_UP_RPC_POLICY,
  CODEX_FOLLOW_UP_TOOL_MANIFESTS,
  CodexCompatibilityEvidenceStore,
  createCompatibilityEvidence,
  fingerprintCodexCompatibilityContract,
  semanticSchemaProjection,
  validateRequiredCodexSchema,
} from "../server/runtime/codex-follow-up/compatibility.ts";
import { evaluateObservedCapabilityRequests } from "../server/runtime/codex-follow-up/capability-probe.ts";
import { PLANNER_DYNAMIC_TOOL_NAMESPACE } from "../lib/planner-tool-contract.ts";
import {
  createCodexSchemaDocuments,
  projectDynamicToolSpecsForProvider,
} from "./support/fixtures/codex-runtime/schema-fixtures.mjs";

const identity = Object.freeze({
  launcherPath: "/home/.local/bin/codex",
  canonicalPath: "/home/.codex/releases/current/codex",
  device: "1",
  inode: "2",
  size: "3",
  mtimeNanoseconds: "4",
  ctimeNanoseconds: "5",
  sha256: "a".repeat(64),
  version: "codex-cli fixture",
});

const capability = Object.freeze({
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
  probeRuntimeFiles: ["config.toml"],
});

const readback = Object.freeze({
  authenticated: true,
  accountKind: "chatgpt",
  permissionProfile: ":read-only",
  effectiveSandbox: "read-only-network-disabled",
  configSourceHashes: { "user:0": "b".repeat(64), "system:1": "c".repeat(64) },
  systemConfigPaths: ["/etc/codex/config.toml"],
  instructionSourceHashes: { "dedicated:0": "c".repeat(64) },
  skillNames: [],
  mcpServerNames: [],
  appNames: [],
  pluginNames: [],
  runtimeFiles: ["config.toml", "AGENTS.md"],
});

test("semantic projection ignores documentation and ordering but fingerprints additive protocol drift", () => {
  const a = createCodexSchemaDocuments("compatible-a");
  const docs = createCodexSchemaDocuments("compatible-docs");
  const additive = createCodexSchemaDocuments("compatible-additive");
  assert.deepEqual(validateRequiredCodexSchema(a), []);
  assert.deepEqual(validateRequiredCodexSchema(docs), []);
  assert.deepEqual(validateRequiredCodexSchema(additive), []);

  const fingerprintA = fingerprintCodexCompatibilityContract(semanticSchemaProjection(a));
  const fingerprintDocs = fingerprintCodexCompatibilityContract(semanticSchemaProjection(docs));
  const fingerprintAdditive = fingerprintCodexCompatibilityContract(semanticSchemaProjection(additive));
  assert.equal(fingerprintDocs, fingerprintA);
  assert.notEqual(fingerprintAdditive, fingerprintA);

  const notificationAdditive = createCodexSchemaDocuments("compatible-a");
  notificationAdditive["ServerNotification.json"].definitions.FutureNotification = {
    type: "object",
  };
  notificationAdditive["ServerNotification.json"].oneOf.push({
    type: "object",
    required: ["method", "params"],
    properties: {
      method: { type: "string", enum: ["future/notification"] },
      params: { $ref: "#/definitions/FutureNotification" },
    },
  });
  assert.notEqual(
    fingerprintCodexCompatibilityContract(semanticSchemaProjection(notificationAdditive)),
    fingerprintA,
  );
});

test("required protocol and dynamic response drift fail validation", () => {
  const requiredDrift = createCodexSchemaDocuments("incompatible-required");
  assert.ok(validateRequiredCodexSchema(requiredDrift).some((failure) => failure.includes("threadId")));

  const responseDrift = createCodexSchemaDocuments("compatible-a");
  responseDrift["DynamicToolCallResponse.json"].definitions.DynamicToolCallOutputContentItem.oneOf = [];
  assert.ok(validateRequiredCodexSchema(responseDrift).some((failure) => failure.includes("inputText")));

  const missingNotificationOptOut = createCodexSchemaDocuments("compatible-a");
  delete missingNotificationOptOut["v1/InitializeParams.json"].definitions
    .InitializeCapabilities.properties.optOutNotificationMethods;
  assert.ok(validateRequiredCodexSchema(missingNotificationOptOut).some(
    (failure) => failure.includes("optOutNotificationMethods"),
  ));

  const rewiredNotificationOptOut = createCodexSchemaDocuments("compatible-a");
  rewiredNotificationOptOut["v1/InitializeParams.json"].properties
    .capabilities.anyOf[0].$ref = "#/definitions/UnrelatedCapabilities";
  assert.ok(validateRequiredCodexSchema(rewiredNotificationOptOut).some(
    (failure) => failure.includes("InitializeCapabilities"),
  ));

  const widenedNullableCapability = createCodexSchemaDocuments("compatible-a");
  widenedNullableCapability["v1/InitializeParams.json"].properties
    .capabilities.anyOf[1].$ref = "#/definitions/UnrelatedCapabilities";
  assert.ok(validateRequiredCodexSchema(widenedNullableCapability).some(
    (failure) => failure.includes("InitializeCapabilities"),
  ));
});

test("compatibility contract freezes exact capability manifests and RPC allowlists", () => {
  assert.equal(CODEX_FOLLOW_UP_TOOL_MANIFESTS.researchWebSearchMode, "live");
  assert.deepEqual(CODEX_FOLLOW_UP_TOOL_MANIFESTS.research, ["update_plan", "web_search"]);
  assert.deepEqual(CODEX_FOLLOW_UP_TOOL_MANIFESTS.planner, ["update_plan", "planner"]);
  assert.deepEqual(CODEX_FOLLOW_UP_TOOL_MANIFESTS.plannerNamespace, ["read", "preview", "apply"]);
  assert.deepEqual(CODEX_FOLLOW_UP_RPC_POLICY.serverRequests, ["item/tool/call"]);
  assert.deepEqual(CODEX_FOLLOW_UP_RPC_POLICY.consumedNotifications, [
    "item/completed",
    "turn/completed",
    "error",
  ]);
  assert.equal(CODEX_FOLLOW_UP_RPC_POLICY.ignoredNotifications.includes("warning"), true);
  assert.equal(CODEX_FOLLOW_UP_RPC_POLICY.clientRequests.includes("command/exec"), false);
  assert.equal(CODEX_FOLLOW_UP_RPC_POLICY.clientRequests.includes("mcpServer/tool/call"), false);
});

test("observed capability inspection requires exact ordered arrays and dependent results", () => {
  const [plannerNamespace] = projectDynamicToolSpecsForProvider([
    PLANNER_DYNAMIC_TOOL_NAMESPACE,
  ]);
  const sourceCommandAlternatives = PLANNER_DYNAMIC_TOOL_NAMESPACE.tools
    .find((tool) => tool.name === "preview")
    .inputSchema.properties.operations.items.properties.command.anyOf;
  const sourceCommandTypes = sourceCommandAlternatives.map(
    (alternative) => alternative.properties.type.const,
  );
  for (const toolName of ["preview", "apply"]) {
    const projectedTool = plannerNamespace.tools.find((tool) => tool.name === toolName);
    assert.ok(
      Buffer.byteLength(JSON.stringify(projectedTool.parameters), "utf8") <= 3_750,
      `${toolName} provider schema keeps safety margin below Codex 0.142.5's 4,000-byte compaction limit`,
    );
    const commandAlternatives = projectedTool.parameters.properties.operations.items
      .properties.command.anyOf;
    assert.equal(commandAlternatives.length, sourceCommandAlternatives.length);
    assert.deepEqual(
      commandAlternatives.map((alternative) => alternative.properties.type.enum[0]),
      sourceCommandTypes,
      `${toolName} provider schema preserves every command discriminator`,
    );
  }
  const requests = [
    {
      input: [{ text: "RESEARCH_CONTEXT_PROBE" }],
      tools: [
        { type: "update_plan" },
        { type: "web_search", external_web_access: true },
      ],
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      input: [{ text: `PLANNER_DEPENDENCY_PROBE ${index}` }],
      parallel_tool_calls: false,
      tools: [
        { type: "update_plan" },
        plannerNamespace,
      ],
    })),
  ];
  const result = evaluateObservedCapabilityRequests(requests, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
    probeRuntimeFiles: ["config.toml"],
  });
  assert.equal(result.researchWebSearchMode, "live");
  assert.deepEqual(result.researchTools, ["update_plan", "web_search"]);
  assert.deepEqual(result.plannerTools, ["update_plan", "planner"]);
  assert.deepEqual(result.plannerNamespaceMembers, ["read", "preview", "apply"]);

  const functionProjectedUpdatePlan = structuredClone(requests);
  for (const request of functionProjectedUpdatePlan) {
    request.tools[0] = { type: "function", name: "update_plan" };
  }
  const currentProjection = evaluateObservedCapabilityRequests(functionProjectedUpdatePlan, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  });
  assert.deepEqual(currentProjection.researchTools, ["update_plan", "web_search"]);
  assert.deepEqual(currentProjection.plannerTools, ["update_plan", "planner"]);

  const unrelatedFunction = structuredClone(functionProjectedUpdatePlan);
  unrelatedFunction[0].tools[0] = { type: "function", name: "calendar" };
  assert.throws(() => evaluateObservedCapabilityRequests(unrelatedFunction, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /Research tools changed/);
  assert.throws(() => evaluateObservedCapabilityRequests([
    ...requests,
    { input: [{ text: "UNCLASSIFIED" }], tools: [] },
  ], {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /exactly four local provider calls/);

  const extra = structuredClone(requests);
  extra[1].tools.push({ type: "shell" });
  assert.throws(() => evaluateObservedCapabilityRequests(extra, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /Planner tools changed|Forbidden/);
  assert.throws(() => evaluateObservedCapabilityRequests(requests, {
    dependentResultObserved: false,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /did not consume/);
  assert.throws(() => evaluateObservedCapabilityRequests(requests, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
    unexpectedRpcMethods: ["applyPatchApproval"],
  }), /Unexpected app-server methods/);

  const wrongSearch = structuredClone(requests);
  wrongSearch[0].tools[1].index_gated_web_access = true;
  assert.throws(() => evaluateObservedCapabilityRequests(wrongSearch, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /live hosted-search/);

  const renamedIndexGate = structuredClone(requests);
  renamedIndexGate[0].tools[1].indexed_web_access = true;
  assert.throws(() => evaluateObservedCapabilityRequests(renamedIndexGate, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /live hosted-search/);

  const disabledExternalSearch = structuredClone(requests);
  disabledExternalSearch[0].tools[1].external_web_access = false;
  assert.throws(() => evaluateObservedCapabilityRequests(disabledExternalSearch, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /live hosted-search/);

  const wrongNamespace = structuredClone(requests);
  wrongNamespace[1].tools[1].tools.push({ type: "function", name: "shell" });
  assert.throws(() => evaluateObservedCapabilityRequests(wrongNamespace, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /namespace description or input schemas/);

  const strippedCommandUnion = structuredClone(requests);
  for (const request of strippedCommandUnion.slice(1)) {
    for (const tool of request.tools[1].tools) {
      if (tool.name === "preview" || tool.name === "apply") {
        tool.parameters.properties.operations.items.properties.command = {};
      }
    }
  }
  assert.throws(() => evaluateObservedCapabilityRequests(strippedCommandUnion, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /namespace description or input schemas/);

  const missingCommandAlternative = structuredClone(requests);
  for (const request of missingCommandAlternative.slice(1)) {
    for (const tool of request.tools[1].tools) {
      if (tool.name === "preview" || tool.name === "apply") {
        tool.parameters.properties.operations.items.properties.command.anyOf.pop();
      }
    }
  }
  assert.throws(() => evaluateObservedCapabilityRequests(missingCommandAlternative, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /namespace description or input schemas/);

  const nameOnlyAmbient = structuredClone(requests);
  nameOnlyAmbient[0].tools[0] = { name: "update_plan" };
  assert.throws(() => evaluateObservedCapabilityRequests(nameOnlyAmbient, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /Research tools changed/);

  const malformedNamespaceMember = structuredClone(requests);
  malformedNamespaceMember[1].tools[1].tools[0] = { name: "read" };
  assert.throws(() => evaluateObservedCapabilityRequests(malformedNamespaceMember, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
    outboundPolicyRejected: true,
  }), /namespace description or input schemas/);

  assert.throws(() => evaluateObservedCapabilityRequests(requests, {
    dependentResultObserved: true,
  }), /permission profile/);
  assert.throws(() => evaluateObservedCapabilityRequests(requests, {
    dependentResultObserved: true,
    permissionProfileVerified: true,
  }), /negative control/);
});

test("atomic evidence reuses only exact positive identity plus semantic fingerprint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-codex-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CodexCompatibilityEvidenceStore(root);
  const fingerprint = "d".repeat(64);
  const evidence = createCompatibilityEvidence({
    disposition: "compatible",
    executable: identity,
    schemaFingerprint: fingerprint,
    rawSchemaBundleSha256: "e".repeat(64),
    capability,
    deploymentReadback: readback,
    detail: "compatible",
  });
  await store.publishChecking(identity, fingerprint, "e".repeat(64));
  await store.publishFinal(evidence);

  assert.equal((await store.readReusablePositive(identity, fingerprint))?.disposition, "compatible");
  assert.equal(await store.readReusablePositive({ ...identity, sha256: "f".repeat(64) }, fingerprint), null);
  assert.equal(await store.readReusablePositive(identity, "0".repeat(64)), null);
  const obsoleteCapability = structuredClone(capability);
  delete obsoleteCapability.researchWebSearchMode;
  await writeFile(
    store.lastAcceptedPath,
    `${JSON.stringify({ ...evidence, capability: obsoleteCapability })}\n`,
  );
  assert.equal(await store.readReusablePositive(identity, fingerprint), null);
  await writeFile(
    store.lastAcceptedPath,
    `${JSON.stringify({ ...evidence, capability: {} })}\n`,
  );
  assert.equal(await store.readReusablePositive(identity, fingerprint), null);
  await store.publishFinal(evidence);

  const unavailable = createCompatibilityEvidence({
    disposition: "unavailable",
    executable: identity,
    schemaFingerprint: fingerprint,
    rawSchemaBundleSha256: "e".repeat(64),
    capability: null,
    deploymentReadback: null,
    detail: "transient failure",
  });
  await store.publishFinal(unavailable);
  assert.equal((await store.readReusablePositive(identity, fingerprint))?.disposition, "compatible");
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);

  await writeFile(store.lastAcceptedPath, Buffer.alloc((2 * 1024 * 1024) + 1));
  assert.equal(await store.readReusablePositive(identity, fingerprint), null);
});
