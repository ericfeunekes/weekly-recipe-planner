import { createHash } from "node:crypto";
import { homedir } from "node:os";

import {
  BoundedCodexAuthClient,
  CodexAuthLifecycleError,
  initializeAuthClient,
  normalizeAuthReleaseInputs,
  normalizeCodexAuthNotificationOptOutMethods,
  normalizeRuntimeIdentity,
  validateCanonicalDirectory,
  validateDeploymentReadback,
  validateExecutionProvider,
  validateSha256,
} from "./codex-auth-lifecycle.mjs";
import {
  assertProductionAuthReadinessProjection,
} from "./planner-release-evidence-contract.mjs";

export const CODEX_AUTH_READINESS_REQUEST_METHODS = Object.freeze([
  "initialize",
  "account/read",
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function readReusableChatGptAccount(client, timeoutMs) {
  const result = await client.request("account/read", { refreshToken: true }, timeoutMs);
  if (
    !isRecord(result) ||
    !Object.hasOwn(result, "account") ||
    result.requiresOpenaiAuth !== true
  ) {
    throw new CodexAuthLifecycleError(
      "AUTH_PROTOCOL",
      "account/read returned a malformed readiness response.",
    );
  }
  if (result.account === null) return null;
  if (!isRecord(result.account) || result.account.type !== "chatgpt") {
    throw new CodexAuthLifecycleError(
      "AUTH_ACCOUNT_MODE",
      "The dedicated runtime is not authenticated with ChatGPT.",
    );
  }
  return Object.freeze({ kind: "chatgpt" });
}

/**
 * Production authentication is a read-only readiness gate. It reuses the
 * dedicated file-backed ChatGPT credentials and proves them through exactly
 * one new identity-bound app-server process. Interactive credential lifecycle
 * experiments remain in codex-auth-lifecycle.mjs and are not part of release.
 */
export async function runCodexAuthReadiness(options, dependencies = {}) {
  if (!isRecord(options)) throw new TypeError("Codex auth readiness options are required.");
  const {
    executionProvider,
    normalHome,
    codexHome,
    appCwd,
    signal,
  } = options;
  if (signal?.aborted) {
    throw new CodexAuthLifecycleError("AUTH_CANCELLED", "Codex auth readiness was cancelled.");
  }
  await Promise.all([
    validateCanonicalDirectory(normalHome, "Real OS home"),
    validateCanonicalDirectory(codexHome, "Dedicated CODEX_HOME", true),
    validateCanonicalDirectory(appCwd, "Canonical application root"),
  ]);
  const readOsHome = dependencies.readOsHome ?? homedir;
  if (await readOsHome() !== normalHome) {
    throw new CodexAuthLifecycleError(
      "AUTH_DEPLOYMENT",
      "The requested HOME is not the real OS home.",
    );
  }
  if (normalHome === codexHome || normalHome === appCwd || codexHome === appCwd) {
    throw new CodexAuthLifecycleError(
      "AUTH_DEPLOYMENT",
      "Auth readiness roots must remain separate.",
    );
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new TypeError("The auth readiness request timeout is outside its bound.");
  }
  const releaseInputs = normalizeAuthReleaseInputs(options.releaseInputs);
  const notificationOptOutMethods = normalizeCodexAuthNotificationOptOutMethods(
    options.notificationOptOutMethods,
    { allowLoginCompletionOptOut: true },
  );
  const operatorSha256 = validateSha256(
    options.operatorSha256,
    "The installed release operator identity",
  );
  const runtimeIdentity = normalizeRuntimeIdentity(options.runtimeIdentity);
  validateExecutionProvider(executionProvider, runtimeIdentity);
  const deploymentReadback = validateDeploymentReadback(options.deploymentReadback);

  let client = null;
  let account = null;
  let authReadbackProcessCount = 0;
  let dedicatedHomeReadbackCount = 0;
  let readinessValidated = false;
  try {
    validateExecutionProvider(executionProvider, runtimeIdentity);
    const child = await executionProvider.spawnAppServer({ signal });
    authReadbackProcessCount += 1;
    client = new BoundedCodexAuthClient(child, {
      requestMethods: CODEX_AUTH_READINESS_REQUEST_METHODS,
      allowLoginCompletionOptOut: true,
      acceptLoginCompletionNotifications: false,
    });
    await initializeAuthClient(
      client,
      codexHome,
      requestTimeoutMs,
      notificationOptOutMethods,
      { allowLoginCompletionOptOut: true },
    );
    dedicatedHomeReadbackCount += 1;
    account = await readReusableChatGptAccount(client, requestTimeoutMs);
    if (account === null) {
      throw new CodexAuthLifecycleError(
        "AUTH_REQUIRED",
        "The dedicated runtime has no reusable ChatGPT authentication.",
      );
    }
    if (
      options.deploymentReadback.authenticated !== true ||
      options.deploymentReadback.accountKind !== account.kind
    ) {
      throw new CodexAuthLifecycleError(
        "AUTH_ACCOUNT_MODE",
        "The fresh account readback does not match the accepted dedicated deployment.",
      );
    }
    client.assertHealthy();
    readinessValidated = true;
  } finally {
    const closingClient = client;
    await closingClient?.close().catch(() => undefined);
    if (readinessValidated) closingClient?.assertHealthy();
  }

  if (authReadbackProcessCount !== 1 || dedicatedHomeReadbackCount !== 1) {
    throw new CodexAuthLifecycleError(
      "AUTH_DEPLOYMENT",
      "Auth readiness did not use exactly one initialized app-server process.",
    );
  }

  return assertProductionAuthReadinessProjection(deepFreeze({
    outcome: "authenticated",
    operatorSha256,
    releaseInputs,
    runtimeIdentity,
    deploymentReadback,
    environment: {
      authReadbackProcessCount,
      realHomeRetained: true,
      dedicatedHomeReadbackCount,
      canonicalApplicationRootRetained: true,
      notificationOptOutMethodCount: notificationOptOutMethods.length,
      notificationOptOutMethodsSha256: sha256(canonicalJson(notificationOptOutMethods)),
    },
    readiness: {
      existingDedicatedCredentialsReused: true,
      freshProcessReadback: true,
      proactiveRefreshReadback: true,
      credentialMutationRequestsAllowed: false,
    },
    account,
  }));
}
