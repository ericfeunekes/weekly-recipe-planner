import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  CODEX_FOLLOW_UP_RESOURCE_POLICY,
  CodexResourceLimitError,
  inventoryBoundedTree,
} from "../../server/runtime/codex-follow-up/resource-policy.ts";

export const CODEX_AUTH_SCHEMA_CONTRACT_VERSION = 1;
export const CODEX_AUTH_READINESS_SCHEMA_CONTRACT_VERSION = 1;
export const CODEX_AUTH_SELECTED_LOGIN_TYPE = "chatgptDeviceCode";
export const CODEX_AUTH_READINESS_SCHEMA_FILES = Object.freeze([
  "v1/InitializeParams.json",
  "ServerNotification.json",
  "v2/GetAccountParams.json",
  "v2/GetAccountResponse.json",
]);
export const CODEX_AUTH_SCHEMA_FILES = Object.freeze([
  "v1/InitializeParams.json",
  "ServerNotification.json",
  "v2/GetAccountParams.json",
  "v2/GetAccountResponse.json",
  "v2/LoginAccountParams.json",
  "v2/LoginAccountResponse.json",
  "v2/CancelLoginAccountParams.json",
  "v2/CancelLoginAccountResponse.json",
  "v2/LogoutAccountResponse.json",
  "v2/AccountLoginCompletedNotification.json",
]);

const NON_SEMANTIC_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
]);
const SET_LIKE_SCHEMA_ARRAY_KEYS = new Set([
  "allOf",
  "anyOf",
  "enum",
  "oneOf",
  "required",
  "type",
]);
const SELECTED_LOGIN_CREDENTIAL_FIELDS = Object.freeze([
  "accessToken",
  "apiKey",
  "chatgptAccountId",
  "chatgptPlanType",
  "refreshToken",
]);
const SUPPORTED_PLAN_TYPES = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const AUTH_LOGIN_COMPLETED_NOTIFICATION = "account/login/completed";
const MAX_SERVER_NOTIFICATION_METHODS = 256;
const MAX_SERVER_NOTIFICATION_METHOD_BYTES = 64 * 1_024;

export class CodexAuthSchemaError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CodexAuthSchemaError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function normalizeSchemaValue(value, parentKey = "") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Auth schema contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeSchemaValue(entry));
    if (SET_LIKE_SCHEMA_ARRAY_KEYS.has(parentKey)) {
      return normalized.sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right))
      );
    }
    return normalized;
  }
  if (!isRecord(value)) throw new TypeError("Auth schema contains a non-JSON value.");
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (NON_SEMANTIC_SCHEMA_KEYS.has(key)) continue;
    normalized[key] = normalizeSchemaValue(value[key], key);
  }
  return normalized;
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hasRequired(schema, name) {
  return isRecord(schema) && Array.isArray(schema.required) && schema.required.includes(name);
}

function propertySchema(schema, name) {
  return isRecord(schema) && isRecord(schema.properties) && isRecord(schema.properties[name])
    ? schema.properties[name]
    : null;
}

function schemaTypes(schema) {
  if (!isRecord(schema)) return [];
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type) && schema.type.every((entry) => typeof entry === "string")
    ? [...schema.type]
    : [];
}

function hasExactTypes(schema, expected) {
  return canonicalJson([...schemaTypes(schema)].sort()) === canonicalJson([...expected].sort());
}

function schemaHasOnlySemanticKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value)
    .filter((key) => !NON_SEMANTIC_SCHEMA_KEYS.has(key))
    .sort();
  return canonicalJson(actual) === canonicalJson([...expected].sort());
}

function taggedVariants(document, tag) {
  const variants = isRecord(document) && Array.isArray(document.oneOf)
    ? document.oneOf
    : [];
  return variants.filter((variant) => {
    const discriminator = propertySchema(variant, "type");
    return discriminator !== null && Array.isArray(discriminator.enum) &&
      discriminator.enum.includes(tag);
  });
}

function requireObjectSchema(failures, file, schema) {
  if (!isRecord(schema) || !hasExactTypes(schema, ["object"])) {
    failures.push(`${file}: expected an object schema`);
    return false;
  }
  return true;
}

function validateAccountReadSchemas(documents, failures) {
  const paramsFile = "v2/GetAccountParams.json";
  const params = documents[paramsFile];
  if (requireObjectSchema(failures, paramsFile, params)) {
    const refreshToken = propertySchema(params, "refreshToken");
    if (refreshToken === null || !hasExactTypes(refreshToken, ["boolean"])) {
      failures.push(`${paramsFile}: refreshToken must be boolean`);
    }
  }

  const responseFile = "v2/GetAccountResponse.json";
  const response = documents[responseFile];
  if (!requireObjectSchema(failures, responseFile, response)) return;
  if (!hasRequired(response, "requiresOpenaiAuth")) {
    failures.push(`${responseFile}: requiresOpenaiAuth must be required`);
  }
  const requiresOpenaiAuth = propertySchema(response, "requiresOpenaiAuth");
  if (requiresOpenaiAuth === null || !hasExactTypes(requiresOpenaiAuth, ["boolean"])) {
    failures.push(`${responseFile}: requiresOpenaiAuth must be boolean`);
  }
  const accountProjection = propertySchema(response, "account");
  if (accountProjection === null) {
    failures.push(`${responseFile}: account projection is missing`);
  } else {
    const accountAlternatives = Array.isArray(accountProjection.anyOf)
      ? accountProjection.anyOf
      : [];
    const allowsAccount = accountAlternatives.some((variant) =>
      isRecord(variant) && variant.$ref === "#/definitions/Account"
    );
    const allowsUnavailable = accountAlternatives.some((variant) =>
      isRecord(variant) && hasExactTypes(variant, ["null"])
    );
    if (!allowsAccount || !allowsUnavailable) {
      failures.push(`${responseFile}: account must allow Account or null readback`);
    }
  }
  const accountDefinition = isRecord(response.definitions) && isRecord(response.definitions.Account)
    ? response.definitions.Account
    : null;
  const chatgptVariants = taggedVariants(accountDefinition, "chatgpt");
  if (chatgptVariants.length !== 1) {
    failures.push(`${responseFile}: expected exactly one ChatGPT account variant`);
  } else {
    const account = chatgptVariants[0];
    for (const name of ["type", "email", "planType"]) {
      if (!hasRequired(account, name)) {
        failures.push(`${responseFile}: ChatGPT account must require ${name}`);
      }
    }
    const email = propertySchema(account, "email");
    if (email === null || !hasExactTypes(email, ["string", "null"])) {
      failures.push(`${responseFile}: ChatGPT email must be nullable string`);
    }
    const accountPlanType = propertySchema(account, "planType");
    if (accountPlanType === null || accountPlanType.$ref !== "#/definitions/PlanType") {
      failures.push(`${responseFile}: ChatGPT planType is missing`);
    }
  }
  const planType = isRecord(response.definitions) && isRecord(response.definitions.PlanType)
    ? response.definitions.PlanType
    : null;
  const planValues = planType !== null && Array.isArray(planType.enum) ? planType.enum : [];
  if (
    !hasExactTypes(planType, ["string"]) ||
    planValues.length === 0 ||
    planValues.some((value) => typeof value !== "string" || !SUPPORTED_PLAN_TYPES.has(value))
  ) {
    failures.push(`${responseFile}: ChatGPT planType values exceed the supported readback contract`);
  }
}

function validateAccountReadinessSchemas(documents, failures) {
  const paramsFile = "v2/GetAccountParams.json";
  const params = documents[paramsFile];
  if (requireObjectSchema(failures, paramsFile, params)) {
    const refreshToken = propertySchema(params, "refreshToken");
    if (refreshToken === null || !hasExactTypes(refreshToken, ["boolean"])) {
      failures.push(`${paramsFile}: refreshToken must be boolean`);
    }
  }

  const responseFile = "v2/GetAccountResponse.json";
  const response = documents[responseFile];
  if (!requireObjectSchema(failures, responseFile, response)) return;
  if (!hasRequired(response, "requiresOpenaiAuth")) {
    failures.push(`${responseFile}: requiresOpenaiAuth must be required`);
  }
  const requiresOpenaiAuth = propertySchema(response, "requiresOpenaiAuth");
  if (requiresOpenaiAuth === null || !hasExactTypes(requiresOpenaiAuth, ["boolean"])) {
    failures.push(`${responseFile}: requiresOpenaiAuth must be boolean`);
  }
  const accountProjection = propertySchema(response, "account");
  const accountAlternatives = Array.isArray(accountProjection?.anyOf)
    ? accountProjection.anyOf
    : [];
  const allowsAccount = accountAlternatives.some((variant) =>
    isRecord(variant) && variant.$ref === "#/definitions/Account"
  );
  const allowsUnavailable = accountAlternatives.some((variant) =>
    isRecord(variant) && hasExactTypes(variant, ["null"])
  );
  if (!allowsAccount || !allowsUnavailable) {
    failures.push(`${responseFile}: account must allow Account or null readback`);
  }
  const accountDefinition = isRecord(response.definitions) && isRecord(response.definitions.Account)
    ? response.definitions.Account
    : null;
  const chatgptVariants = taggedVariants(accountDefinition, "chatgpt");
  if (chatgptVariants.length !== 1) {
    failures.push(`${responseFile}: expected exactly one ChatGPT account discriminator`);
    return;
  }
  const type = propertySchema(chatgptVariants[0], "type");
  if (
    type === null ||
    !hasExactTypes(type, ["string"]) ||
    !Array.isArray(type.enum) ||
    canonicalJson(type.enum) !== canonicalJson(["chatgpt"])
  ) {
    failures.push(`${responseFile}: ChatGPT account discriminator must be exactly chatgpt`);
  }
}

function validateLoginSchemas(documents, failures) {
  const paramsFile = "v2/LoginAccountParams.json";
  const params = documents[paramsFile];
  const selectedParams = taggedVariants(params, CODEX_AUTH_SELECTED_LOGIN_TYPE);
  if (selectedParams.length !== 1) {
    failures.push(`${paramsFile}: expected exactly one ${CODEX_AUTH_SELECTED_LOGIN_TYPE} variant`);
  } else {
    const selected = selectedParams[0];
    if (!hasExactTypes(selected, ["object"]) || !hasRequired(selected, "type")) {
      failures.push(`${paramsFile}: selected device-code input must require an object type discriminator`);
    }
    const discriminator = propertySchema(selected, "type");
    if (
      discriminator === null ||
      !hasExactTypes(discriminator, ["string"]) ||
      canonicalJson(discriminator.enum) !== canonicalJson([CODEX_AUTH_SELECTED_LOGIN_TYPE])
    ) {
      failures.push(`${paramsFile}: selected device-code discriminator is not closed`);
    }
    for (const field of SELECTED_LOGIN_CREDENTIAL_FIELDS) {
      if (hasRequired(selected, field) || propertySchema(selected, field) !== null) {
        failures.push(`${paramsFile}: selected device-code input exposes credential field ${field}`);
      }
    }
  }

  const responseFile = "v2/LoginAccountResponse.json";
  const response = documents[responseFile];
  const selectedResponse = taggedVariants(response, CODEX_AUTH_SELECTED_LOGIN_TYPE);
  if (selectedResponse.length !== 1) {
    failures.push(`${responseFile}: expected exactly one ${CODEX_AUTH_SELECTED_LOGIN_TYPE} variant`);
    return;
  }
  const selected = selectedResponse[0];
  if (!hasExactTypes(selected, ["object"])) {
    failures.push(`${responseFile}: selected device-code response must be an object`);
  }
  for (const name of ["type", "loginId", "userCode", "verificationUrl"]) {
    if (!hasRequired(selected, name)) {
      failures.push(`${responseFile}: selected device-code response must require ${name}`);
    }
    const property = propertySchema(selected, name);
    if (property === null || !hasExactTypes(property, ["string"])) {
      failures.push(`${responseFile}: selected device-code response ${name} must be string`);
    }
  }
  const discriminator = propertySchema(selected, "type");
  if (
    discriminator === null ||
    !hasExactTypes(discriminator, ["string"]) ||
    canonicalJson(discriminator.enum) !== canonicalJson([CODEX_AUTH_SELECTED_LOGIN_TYPE])
  ) {
    failures.push(`${responseFile}: selected device-code response discriminator is not closed`);
  }
}

function validateCancelAndLogoutSchemas(documents, failures) {
  const paramsFile = "v2/CancelLoginAccountParams.json";
  const params = documents[paramsFile];
  if (requireObjectSchema(failures, paramsFile, params)) {
    if (!hasRequired(params, "loginId")) {
      failures.push(`${paramsFile}: loginId must be required`);
    }
    const loginId = propertySchema(params, "loginId");
    if (loginId === null || !hasExactTypes(loginId, ["string"])) {
      failures.push(`${paramsFile}: loginId must be string`);
    }
  }

  const responseFile = "v2/CancelLoginAccountResponse.json";
  const response = documents[responseFile];
  if (requireObjectSchema(failures, responseFile, response)) {
    const statusProperty = propertySchema(response, "status");
    if (
      !hasRequired(response, "status") ||
      statusProperty === null ||
      statusProperty.$ref !== "#/definitions/CancelLoginAccountStatus"
    ) {
      failures.push(`${responseFile}: status must be required`);
    }
    const status = isRecord(response.definitions) &&
        isRecord(response.definitions.CancelLoginAccountStatus)
      ? response.definitions.CancelLoginAccountStatus
      : null;
    if (
      status === null ||
      !hasExactTypes(status, ["string"]) ||
      canonicalJson([...(status.enum ?? [])].sort()) !== canonicalJson(["canceled", "notFound"])
    ) {
      failures.push(`${responseFile}: status must be exactly canceled or notFound`);
    }
  }

  requireObjectSchema(
    failures,
    "v2/LogoutAccountResponse.json",
    documents["v2/LogoutAccountResponse.json"],
  );
}

function validateLoginNotificationSchema(documents, failures) {
  const file = "v2/AccountLoginCompletedNotification.json";
  const notification = documents[file];
  if (!requireObjectSchema(failures, file, notification)) return;
  if (!hasRequired(notification, "success")) {
    failures.push(`${file}: success must be required`);
  }
  const success = propertySchema(notification, "success");
  if (success === null || !hasExactTypes(success, ["boolean"])) {
    failures.push(`${file}: success must be boolean`);
  }
  for (const name of ["loginId", "error"]) {
    const property = propertySchema(notification, name);
    if (property === null || !hasExactTypes(property, ["string", "null"])) {
      failures.push(`${file}: ${name} must be nullable string`);
    }
  }
}

function boundedNotificationMethod(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function notificationMethodsFromSchema(document, failures, options = {}) {
  const file = "ServerNotification.json";
  if (!isRecord(document) || !Array.isArray(document.oneOf)) {
    failures.push(`${file}: expected a nonempty notification union`);
    return [];
  }
  if (document.oneOf.length === 0) {
    if (options.allowEmpty === true) return [];
    failures.push(`${file}: expected a nonempty notification union`);
    return [];
  }
  if (document.oneOf.length > MAX_SERVER_NOTIFICATION_METHODS) {
    failures.push(`${file}: notification method count exceeds the auth bound`);
    return [];
  }
  const methods = [];
  const definitions = isRecord(document.definitions) ? document.definitions : {};
  for (const [index, variant] of document.oneOf.entries()) {
    if (!isRecord(variant) || !hasExactTypes(variant, ["object"]) ||
        !hasRequired(variant, "method") || !hasRequired(variant, "params")) {
      failures.push(`${file}: notification variant ${index} is not a required method/params object`);
      continue;
    }
    const method = propertySchema(variant, "method");
    const params = propertySchema(variant, "params");
    const values = method !== null && hasExactTypes(method, ["string"]) && Array.isArray(method.enum)
      ? method.enum
      : [];
    if (values.length !== 1 || !boundedNotificationMethod(values[0])) {
      failures.push(`${file}: notification variant ${index} must select one bounded method`);
      continue;
    }
    if (
      params === null || typeof params.$ref !== "string" ||
      !params.$ref.startsWith("#/definitions/") ||
      !Object.hasOwn(definitions, params.$ref.slice("#/definitions/".length))
    ) {
      failures.push(`${file}: notification ${values[0]} must use one local params definition`);
      continue;
    }
    methods.push(values[0]);
  }
  const unique = [...new Set(methods)].sort();
  if (unique.length !== methods.length) {
    failures.push(`${file}: notification methods must be unique`);
  }
  if (
    options.requireLoginCompleted !== false &&
    methods.filter((method) => method === AUTH_LOGIN_COMPLETED_NOTIFICATION).length !== 1
  ) {
    failures.push(`${file}: expected exactly one ${AUTH_LOGIN_COMPLETED_NOTIFICATION} method`);
  }
  if (Buffer.byteLength(JSON.stringify(unique), "utf8") > MAX_SERVER_NOTIFICATION_METHOD_BYTES) {
    failures.push(`${file}: notification methods exceed the serialized auth bound`);
  }
  return unique;
}

function validateInitializeNotificationOptOutSchema(documents, failures) {
  const file = "v1/InitializeParams.json";
  const document = documents[file];
  const capabilitiesProperty = propertySchema(document, "capabilities");
  const capabilityVariants = Array.isArray(capabilitiesProperty?.anyOf)
    ? capabilitiesProperty.anyOf
    : [];
  const directlyReferencesCapabilities =
    capabilitiesProperty?.$ref === "#/definitions/InitializeCapabilities" &&
    schemaHasOnlySemanticKeys(capabilitiesProperty, ["$ref"]);
  const nullableReference = isRecord(capabilitiesProperty) &&
    !Object.hasOwn(capabilitiesProperty, "$ref") &&
    capabilityVariants.length === 2 &&
    capabilityVariants.some((variant) =>
      isRecord(variant) && variant.$ref === "#/definitions/InitializeCapabilities" &&
      schemaHasOnlySemanticKeys(variant, ["$ref"])
    ) &&
    capabilityVariants.some((variant) =>
      isRecord(variant) && hasExactTypes(variant, ["null"]) &&
      schemaHasOnlySemanticKeys(variant, ["type"])
    );
  if (!directlyReferencesCapabilities && !nullableReference) {
    failures.push(`${file}: capabilities must reference InitializeCapabilities`);
  }
  const capabilities = isRecord(document?.definitions) &&
    isRecord(document.definitions.InitializeCapabilities)
    ? document.definitions.InitializeCapabilities
    : null;
  const optOut = propertySchema(capabilities, "optOutNotificationMethods");
  if (optOut === null || !hasExactTypes(optOut, ["array", "null"])) {
    failures.push(`${file}: optOutNotificationMethods must be nullable array`);
    return;
  }
  if (!isRecord(optOut.items) || !hasExactTypes(optOut.items, ["string"])) {
    failures.push(`${file}: optOutNotificationMethods items must be strings`);
  }
}

export function deriveCodexAuthNotificationOptOutMethods(documents) {
  const failures = [];
  validateInitializeNotificationOptOutSchema(documents, failures);
  const methods = notificationMethodsFromSchema(documents?.["ServerNotification.json"], failures);
  if (failures.length > 0) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_INCOMPATIBLE",
      `Generated Codex notification schema is incompatible: ${failures.join("; ")}`,
    );
  }
  return Object.freeze(methods.filter((method) => method !== AUTH_LOGIN_COMPLETED_NOTIFICATION));
}

export function deriveCodexAuthReadinessNotificationOptOutMethods(documents) {
  const failures = [];
  validateInitializeNotificationOptOutSchema(documents, failures);
  const methods = notificationMethodsFromSchema(
    documents?.["ServerNotification.json"],
    failures,
    { allowEmpty: true, requireLoginCompleted: false },
  );
  if (failures.length > 0) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_INCOMPATIBLE",
      `Generated Codex readiness notification schema is incompatible: ${failures.join("; ")}`,
    );
  }
  return Object.freeze(methods);
}

export function validateCodexAuthReadinessSchemaDocuments(documents) {
  const failures = [];
  if (!isRecord(documents)) return Object.freeze(["Auth readiness schema document map is missing"]);
  for (const file of CODEX_AUTH_READINESS_SCHEMA_FILES) {
    if (!Object.hasOwn(documents, file)) failures.push(`${file}: missing file`);
  }
  validateAccountReadinessSchemas(documents, failures);
  validateInitializeNotificationOptOutSchema(documents, failures);
  notificationMethodsFromSchema(
    documents["ServerNotification.json"],
    failures,
    { allowEmpty: true, requireLoginCompleted: false },
  );
  return Object.freeze(failures);
}

export function semanticCodexAuthReadinessSchemaProjection(documents) {
  if (!isRecord(documents)) throw new TypeError("Auth readiness schema documents are required.");
  for (const file of CODEX_AUTH_READINESS_SCHEMA_FILES) {
    if (!Object.hasOwn(documents, file)) {
      throw new CodexAuthSchemaError(
        "AUTH_SCHEMA_INCOMPATIBLE",
        `Generated Codex auth readiness schema is missing ${file}.`,
      );
    }
  }
  const response = documents["v2/GetAccountResponse.json"];
  const accountDefinition = isRecord(response.definitions) && isRecord(response.definitions.Account)
    ? response.definitions.Account
    : null;
  const chatgpt = taggedVariants(accountDefinition, "chatgpt")[0];
  return deepFreeze(normalizeSchemaValue({
    initialize: documents["v1/InitializeParams.json"],
    serverNotifications: documents["ServerNotification.json"],
    accountRead: {
      refreshToken: propertySchema(documents["v2/GetAccountParams.json"], "refreshToken"),
      requiresOpenaiAuth: propertySchema(response, "requiresOpenaiAuth"),
      account: {
        allowsNull: true,
        chatgptType: propertySchema(chatgpt, "type"),
      },
    },
  }));
}

export function fingerprintCodexAuthReadinessSchemaDocuments(documents) {
  const projection = semanticCodexAuthReadinessSchemaProjection(documents);
  return createHash("sha256").update(canonicalJson(normalizeSchemaValue({
    contractVersion: CODEX_AUTH_READINESS_SCHEMA_CONTRACT_VERSION,
    projection,
  }))).digest("hex");
}

export function validateCodexAuthSchemaDocuments(documents) {
  const failures = [];
  if (!isRecord(documents)) return Object.freeze(["Auth schema document map is missing"]);
  for (const file of CODEX_AUTH_SCHEMA_FILES) {
    if (!Object.hasOwn(documents, file)) failures.push(`${file}: missing file`);
  }
  validateAccountReadSchemas(documents, failures);
  validateLoginSchemas(documents, failures);
  validateCancelAndLogoutSchemas(documents, failures);
  validateLoginNotificationSchema(documents, failures);
  validateInitializeNotificationOptOutSchema(documents, failures);
  notificationMethodsFromSchema(documents["ServerNotification.json"], failures);
  return Object.freeze(failures);
}

export function semanticCodexAuthSchemaProjection(documents) {
  if (!isRecord(documents)) throw new TypeError("Auth schema documents are required.");
  const files = {};
  for (const file of CODEX_AUTH_SCHEMA_FILES) {
    if (!Object.hasOwn(documents, file)) {
      throw new CodexAuthSchemaError(
        "AUTH_SCHEMA_INCOMPATIBLE",
        `Generated Codex auth schema is missing ${file}.`,
      );
    }
    files[file] = normalizeSchemaValue(documents[file]);
  }
  return deepFreeze({ files });
}

export function fingerprintCodexAuthSchemaDocuments(documents) {
  const projection = semanticCodexAuthSchemaProjection(documents);
  return createHash("sha256").update(canonicalJson(normalizeSchemaValue({
    contractVersion: CODEX_AUTH_SCHEMA_CONTRACT_VERSION,
    selectedLoginType: CODEX_AUTH_SELECTED_LOGIN_TYPE,
    selectedLoginCredentialFieldsRejected: SELECTED_LOGIN_CREDENTIAL_FIELDS,
    projection,
  }))).digest("hex");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readStableSchemaFile(path, file) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new CodexResourceLimitError(`Generated auth schema ${file} must be a regular file.`);
    }
    if (before.size > BigInt(CODEX_FOLLOW_UP_RESOURCE_POLICY.schema.maxFileBytes)) {
      throw new CodexResourceLimitError(`Generated auth schema ${file} exceeds its byte budget.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new CodexAuthSchemaError(
        "AUTH_SCHEMA_CHANGED",
        `Generated auth schema ${file} changed while it was read.`,
      );
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof CodexAuthSchemaError || error instanceof CodexResourceLimitError) {
      throw error;
    }
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_PARSE",
      `Could not read generated auth schema ${file}.`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateCanonicalSchemaRoot(directory) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_PATH",
      "Generated Codex auth schema root must be an absolute canonical path.",
    );
  }
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  } catch (error) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_PATH",
      "Generated Codex auth schema root is unavailable.",
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== directory) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_PATH",
      "Generated Codex auth schema root must be a real canonical directory.",
    );
  }
}

export async function loadAndValidateCodexAuthSchemaBundle(schemaDirectory) {
  await validateCanonicalSchemaRoot(schemaDirectory);
  let inventory;
  try {
    inventory = await inventoryBoundedTree(
      schemaDirectory,
      CODEX_FOLLOW_UP_RESOURCE_POLICY.schema,
      "Generated Codex auth schema bundle",
    );
  } catch (error) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_RESOURCE",
      "Generated Codex auth schema bundle failed its bounded symlink-safe inventory.",
      { cause: error },
    );
  }
  const inventoryFiles = new Map(inventory.files.map((file) => [file.relativePath, file]));
  const documents = {};
  for (const file of CODEX_AUTH_SCHEMA_FILES) {
    const entry = inventoryFiles.get(file);
    if (!entry || entry.kind !== "file") {
      throw new CodexAuthSchemaError(
        "AUTH_SCHEMA_INCOMPATIBLE",
        `Generated Codex auth schema is missing regular file ${file}.`,
      );
    }
    documents[file] = await readStableSchemaFile(join(schemaDirectory, file), file);
  }
  const failures = validateCodexAuthSchemaDocuments(documents);
  if (failures.length > 0) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_INCOMPATIBLE",
      `Generated Codex auth schema is incompatible: ${failures.join("; ")}`,
    );
  }
  const projection = semanticCodexAuthSchemaProjection(documents);
  const notificationOptOutMethods = deriveCodexAuthNotificationOptOutMethods(documents);
  return deepFreeze({
    contractVersion: CODEX_AUTH_SCHEMA_CONTRACT_VERSION,
    selectedLoginType: CODEX_AUTH_SELECTED_LOGIN_TYPE,
    authSchemaFingerprint: fingerprintCodexAuthSchemaDocuments(documents),
    notificationOptOutMethods,
    projection,
  });
}

export async function loadAndValidateCodexAuthReadinessSchemaBundle(schemaDirectory) {
  await validateCanonicalSchemaRoot(schemaDirectory);
  let inventory;
  try {
    inventory = await inventoryBoundedTree(
      schemaDirectory,
      CODEX_FOLLOW_UP_RESOURCE_POLICY.schema,
      "Generated Codex auth readiness schema bundle",
    );
  } catch (error) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_RESOURCE",
      "Generated Codex auth readiness schema bundle failed its bounded symlink-safe inventory.",
      { cause: error },
    );
  }
  const inventoryFiles = new Map(inventory.files.map((file) => [file.relativePath, file]));
  const documents = {};
  for (const file of CODEX_AUTH_READINESS_SCHEMA_FILES) {
    const entry = inventoryFiles.get(file);
    if (!entry || entry.kind !== "file") {
      throw new CodexAuthSchemaError(
        "AUTH_SCHEMA_INCOMPATIBLE",
        `Generated Codex auth readiness schema is missing regular file ${file}.`,
      );
    }
    documents[file] = await readStableSchemaFile(join(schemaDirectory, file), file);
  }
  const failures = validateCodexAuthReadinessSchemaDocuments(documents);
  if (failures.length > 0) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_INCOMPATIBLE",
      `Generated Codex auth readiness schema is incompatible: ${failures.join("; ")}`,
    );
  }
  const projection = semanticCodexAuthReadinessSchemaProjection(documents);
  const notificationOptOutMethods = deriveCodexAuthReadinessNotificationOptOutMethods(documents);
  return deepFreeze({
    contractVersion: CODEX_AUTH_READINESS_SCHEMA_CONTRACT_VERSION,
    authSchemaFingerprint: fingerprintCodexAuthReadinessSchemaDocuments(documents),
    notificationOptOutMethods,
    projection,
  });
}

export function assertCodexAuthSchemaFingerprint(value, expected) {
  const actual = typeof value === "string" ? value : value?.authSchemaFingerprint;
  if (!SHA256.test(actual) || !SHA256.test(expected) || actual !== expected) {
    throw new CodexAuthSchemaError(
      "AUTH_SCHEMA_FINGERPRINT",
      "The validated Codex auth schema fingerprint changed.",
    );
  }
  return actual;
}
