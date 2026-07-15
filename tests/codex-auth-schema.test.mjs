import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_AUTH_SELECTED_LOGIN_TYPE,
  CodexAuthSchemaError,
  assertCodexAuthSchemaFingerprint,
  deriveCodexAuthReadinessNotificationOptOutMethods,
  deriveCodexAuthNotificationOptOutMethods,
  fingerprintCodexAuthReadinessSchemaDocuments,
  fingerprintCodexAuthSchemaDocuments,
  loadAndValidateCodexAuthReadinessSchemaBundle,
  loadAndValidateCodexAuthSchemaBundle,
  validateCodexAuthReadinessSchemaDocuments,
  validateCodexAuthSchemaDocuments,
} from "../scripts/support/codex-auth-schema.mjs";
import {
  GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
  GENERATED_CODEX_AUTH_SCHEMA_FIXTURE_FINGERPRINT,
  assertGeneratedAuthSchemaFixtureFingerprint,
  createGeneratedCodexAuthSchemaDocuments,
  writeGeneratedCodexAuthSchemaFixture,
} from "./support/fixtures/codex-runtime/auth-schema-fixtures.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-codex-auth-schema-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function taggedTypes(document) {
  return document.oneOf.map((variant) => variant.properties.type.enum[0]);
}

test("grounded generated schemas validate the selected device-code path without denying provider alternatives", async (t) => {
  const documents = createGeneratedCodexAuthSchemaDocuments();
  assert.deepEqual(
    taggedTypes(documents["v2/LoginAccountParams.json"]),
    ["apiKey", "chatgpt", "chatgptDeviceCode", "chatgptAuthTokens"],
  );
  assert.deepEqual(validateCodexAuthSchemaDocuments(documents), []);

  const root = await fixture(t);
  await writeGeneratedCodexAuthSchemaFixture(root, documents);
  const loaded = await loadAndValidateCodexAuthSchemaBundle(root);

  assert.equal(loaded.contractVersion, 1);
  assert.equal(loaded.selectedLoginType, CODEX_AUTH_SELECTED_LOGIN_TYPE);
  assert.deepEqual(
    loaded.notificationOptOutMethods,
    GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
  );
  assert.deepEqual(
    deriveCodexAuthNotificationOptOutMethods(documents),
    loaded.notificationOptOutMethods,
  );
  assert.match(loaded.authSchemaFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(
    loaded.authSchemaFingerprint,
    GENERATED_CODEX_AUTH_SCHEMA_FIXTURE_FINGERPRINT,
  );
  assertGeneratedAuthSchemaFixtureFingerprint(loaded);
  assert.equal(
    assertCodexAuthSchemaFingerprint(
      loaded,
      GENERATED_CODEX_AUTH_SCHEMA_FIXTURE_FINGERPRINT,
    ),
    loaded.authSchemaFingerprint,
  );
  assert.throws(
    () => assertCodexAuthSchemaFingerprint(loaded, "0".repeat(64)),
    /fingerprint changed/,
  );
});

test("production readiness validates only reusable ChatGPT readback and opts out every notification", async (t) => {
  const documents = createGeneratedCodexAuthSchemaDocuments();
  assert.deepEqual(validateCodexAuthReadinessSchemaDocuments(documents), []);
  const expectedOptOuts = [
    ...GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
    "account/login/completed",
  ].sort();
  assert.deepEqual(
    deriveCodexAuthReadinessNotificationOptOutMethods(documents),
    expectedOptOuts,
  );

  const root = await fixture(t);
  await writeGeneratedCodexAuthSchemaFixture(root, documents);
  const loaded = await loadAndValidateCodexAuthReadinessSchemaBundle(root);
  assert.equal(loaded.contractVersion, 1);
  assert.deepEqual(loaded.notificationOptOutMethods, expectedOptOuts);
  assert.match(loaded.authSchemaFingerprint, /^[a-f0-9]{64}$/u);

  const loginIndependent = createGeneratedCodexAuthSchemaDocuments();
  for (const file of [
    "v2/LoginAccountParams.json",
    "v2/LoginAccountResponse.json",
    "v2/CancelLoginAccountParams.json",
    "v2/CancelLoginAccountResponse.json",
    "v2/LogoutAccountResponse.json",
    "v2/AccountLoginCompletedNotification.json",
  ]) {
    delete loginIndependent[file];
  }
  assert.deepEqual(validateCodexAuthReadinessSchemaDocuments(loginIndependent), []);
  assert.equal(
    fingerprintCodexAuthReadinessSchemaDocuments(loginIndependent),
    fingerprintCodexAuthReadinessSchemaDocuments(documents),
  );

  const newPlanClass = createGeneratedCodexAuthSchemaDocuments();
  newPlanClass["v2/GetAccountResponse.json"].definitions.PlanType.enum.push("future-plan");
  assert.deepEqual(validateCodexAuthReadinessSchemaDocuments(newPlanClass), []);
  assert.equal(
    fingerprintCodexAuthReadinessSchemaDocuments(newPlanClass),
    fingerprintCodexAuthReadinessSchemaDocuments(documents),
  );

  const noLoginNotification = createGeneratedCodexAuthSchemaDocuments();
  noLoginNotification["ServerNotification.json"].oneOf =
    noLoginNotification["ServerNotification.json"].oneOf.filter(
      (variant) => variant.properties.method.enum[0] !== "account/login/completed",
    );
  delete noLoginNotification["ServerNotification.json"].definitions
    .AccountLoginCompletedNotification;
  assert.deepEqual(validateCodexAuthReadinessSchemaDocuments(noLoginNotification), []);
  assert.deepEqual(
    deriveCodexAuthReadinessNotificationOptOutMethods(noLoginNotification),
    GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS,
  );
});

test("auth fingerprint ignores prose and ordering but records semantic additions", () => {
  const baseline = createGeneratedCodexAuthSchemaDocuments();
  const prose = createGeneratedCodexAuthSchemaDocuments();
  prose["v2/LoginAccountParams.json"].description = "New provider documentation.";
  prose["v2/LoginAccountResponse.json"].oneOf.reverse();
  prose["v2/LoginAccountResponse.json"].oneOf[0].required?.reverse();
  prose["ServerNotification.json"].oneOf.reverse();
  assert.equal(
    fingerprintCodexAuthSchemaDocuments(prose),
    fingerprintCodexAuthSchemaDocuments(baseline),
  );

  const additive = createGeneratedCodexAuthSchemaDocuments();
  const deviceResponse = additive["v2/LoginAccountResponse.json"].oneOf.find(
    (variant) => variant.properties.type.enum.includes("chatgptDeviceCode"),
  );
  deviceResponse.properties.futureProviderField = { type: "string" };
  assert.deepEqual(validateCodexAuthSchemaDocuments(additive), []);
  assert.notEqual(
    fingerprintCodexAuthSchemaDocuments(additive),
    fingerprintCodexAuthSchemaDocuments(baseline),
  );
});

for (const [name, mutate, pattern] of [
  [
    "missing notification opt-out capability",
    (documents) => {
      delete documents["v1/InitializeParams.json"].definitions
        .InitializeCapabilities.properties.optOutNotificationMethods;
    },
    /optOutNotificationMethods must be nullable array/,
  ],
  [
    "rewired notification opt-out capability",
    (documents) => {
      documents["v1/InitializeParams.json"].properties
        .capabilities.anyOf[0].$ref = "#/definitions/UnrelatedCapabilities";
    },
    /capabilities must reference InitializeCapabilities/,
  ],
  [
    "widened nullable notification opt-out capability",
    (documents) => {
      documents["v1/InitializeParams.json"].properties
        .capabilities.anyOf[1].$ref = "#/definitions/UnrelatedCapabilities";
    },
    /capabilities must reference InitializeCapabilities/,
  ],
  [
    "duplicate server notification method",
    (documents) => {
      documents["ServerNotification.json"].oneOf[1].properties.method.enum =
        ["account/login/completed"];
    },
    /notification methods must be unique/,
  ],
  [
    "missing login-completed server notification",
    (documents) => {
      documents["ServerNotification.json"].oneOf =
        documents["ServerNotification.json"].oneOf.filter(
          (variant) => !variant.properties.method.enum.includes("account/login/completed"),
        );
    },
    /expected exactly one account\/login\/completed method/,
  ],
  [
    "nonlocal server notification params",
    (documents) => {
      documents["ServerNotification.json"].oneOf[0].properties.params.$ref =
        "https://example.test/private-schema.json";
    },
    /must use one local params definition/,
  ],
  [
    "excessive server notification count",
    (documents) => {
      const template = documents["ServerNotification.json"].oneOf[1];
      for (let index = documents["ServerNotification.json"].oneOf.length; index <= 256; index += 1) {
        documents["ServerNotification.json"].oneOf.push({
          ...structuredClone(template),
          properties: {
            ...structuredClone(template.properties),
            method: { type: "string", enum: [`fixture/method/${index}`] },
          },
        });
      }
    },
    /notification method count exceeds the auth bound/,
  ],
  [
    "non-boolean proactive refresh",
    (documents) => {
      documents["v2/GetAccountParams.json"].properties.refreshToken.type = "string";
    },
    /refreshToken must be boolean/,
  ],
  [
    "missing selected device-code input",
    (documents) => {
      documents["v2/LoginAccountParams.json"].oneOf =
        documents["v2/LoginAccountParams.json"].oneOf.filter(
          (variant) => !variant.properties.type.enum.includes("chatgptDeviceCode"),
        );
    },
    /expected exactly one chatgptDeviceCode variant/,
  ],
  [
    "credential-bearing selected device-code input",
    (documents) => {
      const selected = documents["v2/LoginAccountParams.json"].oneOf.find(
        (variant) => variant.properties.type.enum.includes("chatgptDeviceCode"),
      );
      selected.required.push("apiKey");
      selected.properties.apiKey = { type: "string" };
    },
    /selected device-code input exposes credential field apiKey/,
  ],
  [
    "incomplete device-code response",
    (documents) => {
      const selected = documents["v2/LoginAccountResponse.json"].oneOf.find(
        (variant) => variant.properties.type.enum.includes("chatgptDeviceCode"),
      );
      selected.required = selected.required.filter((name) => name !== "verificationUrl");
    },
    /must require verificationUrl/,
  ],
  [
    "expanded cancellation response",
    (documents) => {
      documents["v2/CancelLoginAccountResponse.json"].definitions
        .CancelLoginAccountStatus.enum.push("alreadyCompleted");
    },
    /exactly canceled or notFound/,
  ],
  [
    "non-nullable completion identity",
    (documents) => {
      documents["v2/AccountLoginCompletedNotification.json"].properties.loginId.type = "string";
    },
    /loginId must be nullable string/,
  ],
  [
    "unsupported account plan readback",
    (documents) => {
      documents["v2/GetAccountResponse.json"].definitions.PlanType.enum.push("futurePlan");
    },
    /planType values exceed/,
  ],
]) {
  test(`auth schema validation fails closed for ${name}`, () => {
    const documents = createGeneratedCodexAuthSchemaDocuments();
    mutate(documents);
    assert.match(validateCodexAuthSchemaDocuments(documents).join("\n"), pattern);
  });
}

test("a login-only notification union derives an empty valid opt-out list", () => {
  const documents = createGeneratedCodexAuthSchemaDocuments();
  documents["ServerNotification.json"].oneOf =
    documents["ServerNotification.json"].oneOf.filter(
      (variant) => variant.properties.method.enum.includes("account/login/completed"),
    );
  assert.deepEqual(validateCodexAuthSchemaDocuments(documents), []);
  assert.deepEqual(deriveCodexAuthNotificationOptOutMethods(documents), []);
});

test("bundle loading rejects symlinks and oversized required files before parsing", async (t) => {
  const root = await fixture(t);
  await writeGeneratedCodexAuthSchemaFixture(root);
  const outside = join(await fixture(t), "outside.json");
  await writeFile(outside, "{}\n");
  const linkedFile = join(root, "v2", "LoginAccountParams.json");
  await unlink(linkedFile);
  await symlink(outside, linkedFile);
  await assert.rejects(
    loadAndValidateCodexAuthSchemaBundle(root),
    (error) => error instanceof CodexAuthSchemaError && error.code === "AUTH_SCHEMA_RESOURCE",
  );

  const oversizedRoot = await fixture(t);
  await writeGeneratedCodexAuthSchemaFixture(oversizedRoot);
  await writeFile(
    join(oversizedRoot, "v2", "LoginAccountParams.json"),
    Buffer.alloc((2 * 1_024 * 1_024) + 1),
  );
  await assert.rejects(
    loadAndValidateCodexAuthSchemaBundle(oversizedRoot),
    (error) => error instanceof CodexAuthSchemaError && error.code === "AUTH_SCHEMA_RESOURCE",
  );
});

test("bundle loading rejects a symlinked schema root", async (t) => {
  const realRoot = await fixture(t);
  await writeGeneratedCodexAuthSchemaFixture(realRoot);
  const parent = await fixture(t);
  const linkedRoot = join(parent, "schema-link");
  await symlink(realRoot, linkedRoot);
  await assert.rejects(
    loadAndValidateCodexAuthSchemaBundle(linkedRoot),
    (error) => error instanceof CodexAuthSchemaError && error.code === "AUTH_SCHEMA_PATH",
  );
});
