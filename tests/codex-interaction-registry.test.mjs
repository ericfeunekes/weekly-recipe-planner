import assert from "node:assert/strict";
import test from "node:test";

import {
  FORBIDDEN_APPROVAL_METHODS,
  InteractionRegistry,
  InteractionRegistryError,
  handleForbiddenApprovalRequest,
  rejectUnsupportedServerRequest,
} from "../server/codex/interaction-registry.ts";

function request(id = "protocol-request-secret") {
  return {
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{
        id: "dinner",
        header: "Dinner",
        question: "Which dinner should I plan?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Tacos", description: "Plan tacos." },
          { label: "Soup", description: "Plan soup." },
        ],
      }],
    },
  };
}

function recorder() {
  const responses = [];
  const errors = [];
  return {
    responses,
    errors,
    respond(id, result) {
      responses.push({ id, result });
    },
    respondError(id, error) {
      errors.push({ id, error });
    },
  };
}

test("listed-option questions use opaque public ids and answer the protocol request exactly once", () => {
  const port = recorder();
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => "interaction-opaque-1",
    now: () => 1_750_000_000_000,
  });
  const interaction = registry.register(request());

  assert.equal(interaction.id, "interaction-opaque-1");
  assert.equal(interaction.expiresAtMs, null);
  assert.equal(JSON.stringify(interaction).includes("protocol-request-secret"), false);
  assert.equal(Object.hasOwn(interaction.questions[0], "isSecret"), false);
  assert.deepEqual(registry.list(), [interaction]);

  assert.throws(
    () => registry.answer(interaction.id, {}),
    (error) => error instanceof InteractionRegistryError && error.code === "INVALID_ANSWERS",
  );
  assert.equal(registry.list().length, 1, "invalid answers do not consume the request");
  assert.equal(registry.answer(interaction.id, { dinner: ["Soup"] }), true);
  assert.equal(registry.answer(interaction.id, { dinner: ["Tacos"] }), false);
  assert.deepEqual(port.responses, [{
    id: "protocol-request-secret",
    result: { answers: { dinner: { answers: ["Soup"] } } },
  }]);
  assert.deepEqual(port.errors, []);
  assert.deepEqual(registry.list(), []);
  registry.close();
});

test("the host exposes only listed options and rejects free-form answers", () => {
  const port = recorder();
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => "interaction-closed-choice",
  });
  const interaction = registry.register(request("closed-choice-request"));

  assert.throws(
    () => registry.answer(interaction.id, { dinner: ["My password is hunter2"] }),
    (error) => error instanceof InteractionRegistryError && error.code === "INVALID_ANSWERS",
  );
  assert.equal(registry.list().length, 1);
  assert.equal(registry.answer(interaction.id, { dinner: ["Tacos"] }), true);
  registry.close();
});

test("native request resolution clears a pending question without answering it", () => {
  const port = recorder();
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => "interaction-resolved-native",
  });
  const interaction = registry.register(request("7"));

  assert.equal(
    registry.resolveProtocolRequest(7, "thread-1"),
    "unknown",
    "numeric and string protocol request ids remain distinct",
  );
  assert.equal(
    registry.resolveProtocolRequest("7", "thread-other"),
    "thread_mismatch",
  );
  assert.equal(
    registry.resolveProtocolRequest("7", "thread-1"),
    "resolved",
  );
  assert.equal(
    registry.resolveProtocolRequest("7", "thread-1"),
    "unknown",
  );
  assert.equal(registry.answer(interaction.id, { dinner: ["Soup"] }), false);
  assert.equal(
    registry.resolveProtocolRequest("protocol-request-secret", "thread-1"),
    "unknown",
  );
  assert.deepEqual(port.responses, []);
  assert.deepEqual(port.errors, []);
  registry.close();
});

test("native auto-resolution bounds match the provider contract", () => {
  const port = recorder();
  let nextId = 0;
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => `interaction-auto-${++nextId}`,
  });
  const minimum = request("auto-minimum");
  minimum.params.autoResolutionMs = 60_000;
  const maximum = request("auto-maximum");
  maximum.params.autoResolutionMs = 240_000;

  assert.notEqual(registry.register(minimum), null);
  assert.notEqual(registry.register(maximum), null);
  assert.equal(registry.list().length, 2);
  registry.close();
});

test("duplicate pending protocol request ids fail the owning session boundary", () => {
  const port = recorder();
  let nextId = 0;
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => `interaction-duplicate-${++nextId}`,
  });
  registry.register(request(12));
  assert.throws(
    () => registry.register(request(12)),
    (error) => error instanceof InteractionRegistryError &&
      error.code === "INVALID_INTERACTION",
  );
  assert.equal(registry.list().length, 1);
  registry.close();
});

test("secret and malformed questions are rejected before entering public state", () => {
  const port = recorder();
  let nextId = 0;
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => `interaction-${++nextId}`,
  });
  const secret = request("secret-question");
  secret.params.questions[0].isSecret = true;
  const malformed = request("malformed-question");
  malformed.params.unexpected = "not allowed";
  const missingNativeSensitivity = request("missing-native-sensitivity");
  delete missingNativeSensitivity.params.questions[0].isSecret;
  const duplicateOptions = request("duplicate-options");
  duplicateOptions.params.questions[0].options[1].label = "Tacos";
  const shortAutoResolution = request("short-auto-resolution");
  shortAutoResolution.params.autoResolutionMs = 59_999;
  const longAutoResolution = request("long-auto-resolution");
  longAutoResolution.params.autoResolutionMs = 240_001;

  assert.equal(registry.register(secret), null);
  assert.equal(registry.register(malformed), null);
  assert.equal(registry.register(missingNativeSensitivity), null);
  assert.equal(registry.register(duplicateOptions), null);
  assert.equal(registry.register(shortAutoResolution), null);
  assert.equal(registry.register(longAutoResolution), null);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(port.errors.map((entry) => ({ id: entry.id, code: entry.error.code })), [
    { id: "secret-question", code: -32001 },
    { id: "malformed-question", code: -32602 },
    { id: "missing-native-sensitivity", code: -32602 },
    { id: "duplicate-options", code: -32602 },
    { id: "short-auto-resolution", code: -32602 },
    { id: "long-auto-resolution", code: -32602 },
  ]);
  registry.close();
});

test("expiry sends one empty exact-schema answer and makes late UI answers stale", async () => {
  const port = recorder();
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => "interaction-expiring",
  });
  const expiring = request("expiring-request");
  expiring.params.autoResolutionMs = 60_000;
  const interaction = registry.register(expiring);
  assert.equal(registry.expire(interaction.id), true);

  assert.deepEqual(port.responses, [{
    id: "expiring-request",
    result: { answers: {} },
  }]);
  assert.equal(registry.answer(interaction.id, { dinner: ["Soup"] }), false);
  assert.deepEqual(registry.list(), []);
  registry.close();
});

test("a blocking question remains pending until the user or native lifecycle resolves it", async () => {
  const port = recorder();
  const registry = new InteractionRegistry({
    ...port,
    createOpaqueId: () => "interaction-blocking",
  });
  const interaction = registry.register(request("blocking-request"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(registry.list(), [interaction]);
  assert.deepEqual(port.responses, []);
  registry.close();
});

test("forbidden approvals are declined or rejected without registration", () => {
  const port = recorder();
  const registry = new InteractionRegistry({ ...port });
  for (const [index, method] of FORBIDDEN_APPROVAL_METHODS.entries()) {
    const forbidden = { id: `forbidden-${index}`, method, params: {} };
    assert.equal(registry.register(forbidden), null);
    assert.equal(handleForbiddenApprovalRequest(forbidden, port), true);
  }
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(port.responses, [
    { id: "forbidden-0", result: { decision: "decline" } },
    { id: "forbidden-1", result: { decision: "decline" } },
    {
      id: "forbidden-3",
      result: { action: "decline", content: null, _meta: null },
    },
    { id: "forbidden-4", result: { decision: "denied" } },
    { id: "forbidden-5", result: { decision: "denied" } },
  ]);
  assert.deepEqual(port.errors.map((entry) => entry.id), ["forbidden-2"]);

  const unknown = { id: "unknown-1", method: "future/request", params: {} };
  assert.equal(handleForbiddenApprovalRequest(unknown, port), false);
  rejectUnsupportedServerRequest(unknown, port);
  assert.deepEqual(port.errors.at(-1), {
    id: "unknown-1",
    error: {
      code: -32601,
      message: "Unsupported Codex app-server request future/request.",
    },
  });
  registry.close();
});
