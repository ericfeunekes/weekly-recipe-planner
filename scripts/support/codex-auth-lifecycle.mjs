import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assertReleaseArtifact,
  createReleaseArtifact,
  isActivationId,
} from "./planner-release-contract.mjs";
import {
  assertProductionAuthReadinessProjection,
} from "./planner-release-evidence-contract.mjs";

// Historical one-time credential-lifecycle feasibility harness. Production
// release activation imports codex-auth-readiness.mjs and never calls this
// module's login, logout, cancellation, or device-code workflow.

export const CODEX_AUTH_REQUEST_METHODS = Object.freeze([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
]);

export const CODEX_AUTH_CLIENT_NOTIFICATIONS = Object.freeze(["initialized"]);
export const CODEX_AUTH_SERVER_NOTIFICATIONS = Object.freeze([
  "account/login/completed",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FRAME_BYTES = 64 * 1_024;
const MAX_STDOUT_BYTES = 1_024 * 1_024;
const MAX_STDERR_BYTES = 16 * 1_024;
const MAX_FRAMES = 128;
const MAX_NOTIFICATIONS = 8;
const MAX_STABLE_FILES = 20_000;
const MAX_STABLE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const MAX_STABLE_DEPTH = 24;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HANDOFF_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;
const AUTH_INITIALIZE_CLIENT_INFO = Object.freeze({
  name: "weekly-recipe-planner-auth-operator",
  title: "Weekly Recipe Planner Auth Operator",
  version: "1",
});
const MAX_NOTIFICATION_OPT_OUT_METHODS = 256;
const MAX_NOTIFICATION_OPT_OUT_BYTES = 64 * 1_024;
const PLAN_CLASSES = new Set([
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
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

function protocolIdentifier(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !value.includes("\u0000") && !value.includes("\n") && !value.includes("\r");
}

export function normalizeCodexAuthNotificationOptOutMethods(value, options = {}) {
  if (!Array.isArray(value) || value.length > MAX_NOTIFICATION_OPT_OUT_METHODS) {
    throw new TypeError("Auth notification opt-outs must be one bounded array.");
  }
  const normalized = value.map((method) => {
    if (!protocolIdentifier(method) || method !== method.trim()) {
      throw new TypeError("Auth notification opt-outs contain an invalid method.");
    }
    return method;
  });
  const sorted = [...new Set(normalized)].sort();
  if (
    sorted.length !== normalized.length ||
    JSON.stringify(sorted) !== JSON.stringify(normalized) ||
    (sorted.includes("account/login/completed") &&
      options.allowLoginCompletionOptOut !== true) ||
    Buffer.byteLength(JSON.stringify(sorted), "utf8") > MAX_NOTIFICATION_OPT_OUT_BYTES
  ) {
    throw new TypeError("Auth notification opt-outs are not unique, sorted, bounded, and disjoint.");
  }
  return Object.freeze(sorted);
}

export function createCodexAuthInitializeParams(notificationOptOutMethods, options = {}) {
  return deepFreeze({
    clientInfo: { ...AUTH_INITIALIZE_CLIENT_INFO },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [
        ...normalizeCodexAuthNotificationOptOutMethods(notificationOptOutMethods, options),
      ],
    },
  });
}

function abortReason() {
  return new CodexAuthLifecycleError("AUTH_CANCELLED", "Codex authentication was cancelled.");
}

function pathWithin(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

export function validateSha256(value, label) {
  if (!SHA256.test(value)) throw new TypeError(`${label} must be one SHA-256 identity.`);
  return value;
}

export class CodexAuthLifecycleError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CodexAuthLifecycleError";
    this.code = code;
  }
}

function protocolError(message, options = {}) {
  return new CodexAuthLifecycleError("AUTH_PROTOCOL", message, options);
}

function timeoutError(message) {
  return new CodexAuthLifecycleError("AUTH_TIMEOUT", message);
}

export function normalizeRuntimeIdentity(value) {
  const keys = [
    "canonicalTargetPathSha256",
    "executableVersion",
    "executableSha256",
    "schemaFingerprint",
    "userConfigSha256",
    "systemConfigSha256",
    "instructionSha256",
  ];
  if (
    !exactKeys(value, keys) ||
    !SHA256.test(value.canonicalTargetPathSha256) ||
    typeof value.executableVersion !== "string" || value.executableVersion.length === 0 ||
    value.executableVersion.length > 256 ||
    !keys.slice(2).every((key) => SHA256.test(value[key]))
  ) {
    throw new TypeError("The auth runtime identity is incomplete or malformed.");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function authRuntimeIdentityFromActivationCoordinates(coordinates) {
  if (
    !isRecord(coordinates) ||
    typeof coordinates.canonicalPath !== "string" ||
    !isAbsolute(coordinates.canonicalPath)
  ) {
    throw new TypeError("Authenticated activation coordinates are required.");
  }
  return normalizeRuntimeIdentity({
    canonicalTargetPathSha256: sha256(coordinates.canonicalPath),
    executableVersion: coordinates.version,
    executableSha256: coordinates.sha256,
    schemaFingerprint: coordinates.schemaFingerprint,
    userConfigSha256: coordinates.userConfigSha256,
    systemConfigSha256: coordinates.systemConfigSha256,
    instructionSha256: coordinates.instructionSha256,
  });
}

export function normalizeAuthReleaseInputs(value) {
  const keys = ["activationId", "stageSha256", "installedSha256"];
  if (
    !exactKeys(value, keys) ||
    !isActivationId(value.activationId) ||
    !SHA256.test(value.stageSha256) ||
    !SHA256.test(value.installedSha256)
  ) {
    throw new TypeError("Auth release inputs must bind one activation, stage, and install.");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function authReleaseInputsFromArtifacts(stageArtifact, installedArtifact) {
  const stage = assertReleaseArtifact(stageArtifact, { artifactType: "stage" });
  const installed = assertReleaseArtifact(installedArtifact, {
    artifactType: "installed",
    activationId: stage.activationId,
    predecessorSha256: stage.sha256,
  });
  return normalizeAuthReleaseInputs({
    activationId: stage.activationId,
    stageSha256: stage.sha256,
    installedSha256: installed.sha256,
  });
}

export function createAuthLifecycleReleaseArtifact({
  stageArtifact,
  installedArtifact,
  projection,
}) {
  const releaseInputs = authReleaseInputsFromArtifacts(stageArtifact, installedArtifact);
  assertProductionAuthReadinessProjection(projection, { durable: true });
  if (canonicalJson(projection.releaseInputs) !== canonicalJson(releaseInputs)) {
    throw new TypeError("The auth lifecycle projection changed its stage/install binding.");
  }
  if (
    !SHA256.test(projection.operatorSha256) ||
    installedArtifact.projection.operatorSha256 !== projection.operatorSha256
  ) {
    throw new TypeError("The auth lifecycle projection changed its installed operator identity.");
  }
  return createReleaseArtifact({
    artifactType: "auth-lifecycle",
    activationId: releaseInputs.activationId,
    predecessorSha256: releaseInputs.installedSha256,
    projection,
  });
}

export function assertAuthLifecycleReleaseArtifact({
  stageArtifact,
  installedArtifact,
  artifact,
}) {
  const releaseInputs = authReleaseInputsFromArtifacts(stageArtifact, installedArtifact);
  const value = assertReleaseArtifact(artifact, {
    artifactType: "auth-lifecycle",
    activationId: releaseInputs.activationId,
    predecessorSha256: releaseInputs.installedSha256,
    operatorSha256: installedArtifact.projection.operatorSha256,
  });
  assertProductionAuthReadinessProjection(value.projection, { durable: true });
  if (canonicalJson(value.projection.releaseInputs) !== canonicalJson(releaseInputs)) {
    throw new TypeError("The durable auth lifecycle changed its stage/install binding.");
  }
  return value;
}

export function validateDeploymentReadback(value) {
  if (
    !isRecord(value) ||
    typeof value.authenticated !== "boolean" ||
    ![null, "chatgpt"].includes(value.accountKind) ||
    value.permissionProfile !== ":read-only" ||
    value.effectiveSandbox !== "read-only-network-disabled" ||
    !isRecord(value.configSourceHashes) ||
    Object.keys(value.configSourceHashes).length < 2 ||
    Object.values(value.configSourceHashes).some((identity) => !SHA256.test(identity)) ||
    !isRecord(value.instructionSourceHashes) ||
    Object.keys(value.instructionSourceHashes).length !== 1 ||
    Object.values(value.instructionSourceHashes).some((identity) => !SHA256.test(identity)) ||
    !Array.isArray(value.systemConfigPaths) ||
    !Array.isArray(value.skillNames) || value.skillNames.some((name) => !protocolIdentifier(name)) ||
    !Array.isArray(value.mcpServerNames) || value.mcpServerNames.length !== 0 ||
    !Array.isArray(value.appNames) || value.appNames.length !== 0 ||
    !Array.isArray(value.pluginNames) || value.pluginNames.length !== 0 ||
    !Array.isArray(value.runtimeFiles)
  ) {
    throw new TypeError("The dedicated deployment readback is incomplete or capability-bearing.");
  }
  const skillNames = [...value.skillNames].sort();
  const safeIdentity = Object.freeze({
    authenticated: value.authenticated,
    accountKind: value.accountKind,
    permissionProfile: value.permissionProfile,
    effectiveSandbox: value.effectiveSandbox,
    configSourceSha256s: Object.freeze(Object.values(value.configSourceHashes).sort()),
    instructionSourceSha256s: Object.freeze(Object.values(value.instructionSourceHashes).sort()),
    systemConfigPathCount: value.systemConfigPaths.length,
    standaloneSkillCount: skillNames.length,
    standaloneSkillIdentitySha256: sha256(canonicalJson(skillNames)),
    mcpServerCount: value.mcpServerNames.length,
    appCount: value.appNames.length,
    pluginCount: value.pluginNames.length,
    runtimeFileCount: value.runtimeFiles.length,
  });
  return Object.freeze({
    identitySha256: sha256(canonicalJson(safeIdentity)),
    standaloneSkillReadbackCompleted: true,
    standaloneSkillCount: skillNames.length,
    standaloneSkillIdentitySha256: safeIdentity.standaloneSkillIdentitySha256,
    emptyAmbientCapabilitySurfaces: true,
  });
}

function selectNormalCodexCategory(relativePath) {
  if (relativePath === "auth.json") return "normal_auth";
  if (relativePath === "config.toml") return "normal_config";
  if (relativePath === "AGENTS.md" || relativePath === "AGENTS.override.md") {
    return "normal_instructions";
  }
  const root = relativePath.split("/")[0];
  if (root === "plugins" || root === "marketplaces") return "normal_plugins";
  if (root === "skills") return "normal_skills";
  return null;
}

function shouldDescendNormalCodex(relativePath) {
  return ["plugins", "marketplaces", "skills"].includes(relativePath.split("/")[0]);
}

async function metadataEntries(root, sourceName, selectCategory, shouldDescend) {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || await realpath(root) !== root) {
    throw new CodexAuthLifecycleError(
      "AUTH_NORMAL_STATE",
      "A normal-home stable-input root is not a real canonical directory.",
    );
  }
  const pending = [{ path: root, depth: 0 }];
  const entries = [];
  let logicalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_STABLE_DEPTH) {
      throw new CodexAuthLifecycleError(
        "AUTH_NORMAL_STATE",
        "Normal-home stable inputs exceeded their depth budget.",
      );
    }
    for (const child of await readdir(current.path, { withFileTypes: true })) {
      const path = join(current.path, child.name);
      if (!pathWithin(root, path)) throw protocolError("A stable-input path escaped its root.");
      const localPath = relative(root, path).split(sep).join("/");
      const category = selectCategory(localPath);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (shouldDescend(localPath)) pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (category === null) continue;
      if (entries.length >= MAX_STABLE_FILES) {
        throw new CodexAuthLifecycleError(
          "AUTH_NORMAL_STATE",
          "Normal-home stable inputs exceeded their file budget.",
        );
      }
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new CodexAuthLifecycleError(
          "AUTH_NORMAL_STATE",
          "Normal-home stable input metadata is invalid.",
        );
      }
      logicalBytes += size;
      if (logicalBytes > MAX_STABLE_BYTES) {
        throw new CodexAuthLifecycleError(
          "AUTH_NORMAL_STATE",
          "Normal-home stable inputs exceeded their byte budget.",
        );
      }
      const kind = metadata.isFile()
        ? "file"
        : metadata.isSymbolicLink()
          ? "symlink"
          : "special";
      entries.push({
        category,
        source: sourceName,
        relativePathSha256: sha256(localPath),
        kind,
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        mode: Number(metadata.mode & BigInt(0o777)),
        size,
        modifiedNanoseconds: metadata.mtimeNs.toString(),
        changedNanoseconds: metadata.ctimeNs.toString(),
      });
    }
  }
  return entries;
}

function projectStableMetadata(entries) {
  const categories = {};
  for (const entry of entries.sort((left, right) =>
    `${left.source}:${left.relativePathSha256}`.localeCompare(
      `${right.source}:${right.relativePathSha256}`,
    ))) {
    const category = categories[entry.category] ??= { files: 0, bytes: 0, rows: [] };
    category.files += 1;
    category.bytes += entry.size;
    category.rows.push({
      source: entry.source,
      path: entry.relativePathSha256,
      kind: entry.kind,
      device: entry.device,
      inode: entry.inode,
      mode: entry.mode,
      size: entry.size,
      modified: entry.modifiedNanoseconds,
      changed: entry.changedNanoseconds,
    });
  }
  const projectedCategories = Object.fromEntries(Object.entries(categories).sort().map(
    ([name, category]) => [name, {
      files: category.files,
      bytes: category.bytes,
      identitySha256: sha256(canonicalJson(category.rows)),
    }],
  ));
  return deepFreeze({
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    categories: projectedCategories,
    identitySha256: sha256(canonicalJson(projectedCategories)),
  });
}

export async function snapshotStableNormalCodexInputs(normalHome) {
  if (!isAbsolute(normalHome) || resolve(normalHome) !== normalHome) {
    throw new TypeError("The normal home must be an absolute canonical path.");
  }
  const entries = await metadataEntries(
    join(normalHome, ".codex"),
    "normal_codex",
    selectNormalCodexCategory,
    shouldDescendNormalCodex,
  );
  entries.push(...await metadataEntries(
    join(normalHome, ".agents", "skills"),
    "standalone_skills",
    () => "standalone_skills",
    () => true,
  ));
  return projectStableMetadata(entries);
}

function validateNotificationParams(params) {
  if (
    !isRecord(params) ||
    typeof params.success !== "boolean" ||
    !(params.loginId === null || params.loginId === undefined || protocolIdentifier(params.loginId)) ||
    !(params.error === null || params.error === undefined || protocolIdentifier(params.error, 1_024))
  ) {
    throw protocolError("Codex app-server emitted a malformed login-completion notification.");
  }
}

export function assertCodexAuthRequest(method, params, options = {}) {
  if (!CODEX_AUTH_REQUEST_METHODS.includes(method)) {
    throw protocolError(`Outbound app-server method ${method} is outside the auth allowlist.`);
  }
  if (method === "initialize") {
    let notificationOptOutMethods;
    try {
      notificationOptOutMethods = normalizeCodexAuthNotificationOptOutMethods(
        params?.capabilities?.optOutNotificationMethods,
        options,
      );
    } catch {
      throw protocolError("initialize notification opt-outs changed from the closed auth contract.");
    }
    if (
      !exactKeys(params, ["clientInfo", "capabilities"]) ||
      !exactKeys(params.clientInfo, ["name", "title", "version"]) ||
      params.clientInfo.name !== AUTH_INITIALIZE_CLIENT_INFO.name ||
      params.clientInfo.title !== AUTH_INITIALIZE_CLIENT_INFO.title ||
      params.clientInfo.version !== AUTH_INITIALIZE_CLIENT_INFO.version ||
      !exactKeys(params.capabilities, ["experimentalApi", "optOutNotificationMethods"]) ||
      params.capabilities.experimentalApi !== true ||
      JSON.stringify(params.capabilities.optOutNotificationMethods) !==
        JSON.stringify(notificationOptOutMethods)
    ) {
      throw protocolError("initialize params changed from the closed auth client contract.");
    }
    return params;
  }
  if (method === "account/read") {
    if (!exactKeys(params, ["refreshToken"]) || typeof params.refreshToken !== "boolean") {
      throw protocolError("account/read params changed from the closed auth client contract.");
    }
    return params;
  }
  if (method === "account/login/start") {
    if (!exactKeys(params, ["type"]) || params.type !== "chatgptDeviceCode") {
      throw protocolError("account/login/start is restricted to provider-native device code.");
    }
    return params;
  }
  if (method === "account/login/cancel") {
    if (!exactKeys(params, ["loginId"]) || !protocolIdentifier(params.loginId)) {
      throw protocolError("account/login/cancel requires one bounded login id.");
    }
    return params;
  }
  if (params !== undefined) throw protocolError("account/logout must omit params.");
  return params;
}

export class BoundedCodexAuthClient {
  #nextId = 1;
  #pending = new Map();
  #notifications = [];
  #waiters = [];
  #stdout = Buffer.alloc(0);
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #frames = 0;
  #closed = false;
  #closing = false;
  #childClosed = false;
  #failure = null;
  #requestMethods;
  #allowLoginCompletionOptOut;
  #acceptLoginCompletionNotifications;

  constructor(child, options = {}) {
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      throw protocolError("Codex app-server did not expose bounded JSONL stdio.");
    }
    const requestMethods = options.requestMethods ?? CODEX_AUTH_REQUEST_METHODS;
    if (
      !Array.isArray(requestMethods) || requestMethods.length === 0 ||
      requestMethods.some((method) => !CODEX_AUTH_REQUEST_METHODS.includes(method)) ||
      new Set(requestMethods).size !== requestMethods.length
    ) {
      throw new TypeError("The Codex auth client request allowlist is invalid.");
    }
    this.#requestMethods = Object.freeze([...requestMethods]);
    this.#allowLoginCompletionOptOut = options.allowLoginCompletionOptOut === true;
    this.#acceptLoginCompletionNotifications =
      options.acceptLoginCompletionNotifications !== false;
    this.child = child;
    child.stdout.on("data", (chunk) => this.#handleStdout(chunk));
    child.stdout.on("error", () => this.#fail(protocolError("Codex app-server stdout failed.")));
    child.stderr.on("data", (chunk) => {
      this.#stderrBytes += Buffer.byteLength(chunk);
      if (this.#stderrBytes > MAX_STDERR_BYTES) {
        this.#fail(protocolError("Codex app-server exceeded its stderr budget."));
      }
    });
    child.stderr.on("error", () => this.#fail(protocolError("Codex app-server stderr failed.")));
    child.stdin.on("error", () => this.#fail(protocolError("Codex app-server stdin failed.")));
    child.once("error", () => this.#fail(protocolError("Codex app-server failed to start.")));
    child.once("close", () => {
      this.#childClosed = true;
      if (!this.#closed && !this.#closing && !this.#failure) {
        this.#fail(protocolError("Codex app-server exited before authentication completed."));
      }
    });
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.#requestMethods.includes(method)) {
      throw protocolError(`Outbound app-server method ${method} is outside this auth client policy.`);
    }
    assertCodexAuthRequest(method, params, {
      allowLoginCompletionOptOut: this.#allowLoginCompletionOptOut,
    });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_LOGIN_TIMEOUT_MS) {
      throw new TypeError("The app-server request timeout is outside its bound.");
    }
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed || this.#closing) {
      return Promise.reject(protocolError("Codex app-server input is closed."));
    }
    const id = this.#nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(timeoutError(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.#write(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  notifyInitialized() {
    this.#write({ method: "initialized", params: {} });
  }

  waitForLoginCompletion(loginId, timeoutMs, signal) {
    if (!protocolIdentifier(loginId)) {
      return Promise.reject(protocolError("The device login id is malformed."));
    }
    return this.#waitForNotification(timeoutMs, signal).then((message) => {
      if (message.method !== "account/login/completed" || message.params.loginId !== loginId) {
        throw protocolError("Codex app-server completed a different login request.");
      }
      if (message.params.success !== true || message.params.error != null) {
        throw new CodexAuthLifecycleError(
          "AUTH_LOGIN_FAILED",
          "Codex device authentication did not complete successfully.",
        );
      }
      return true;
    });
  }

  assertHealthy() {
    if (this.#failure) throw this.#failure;
  }

  async close() {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    this.#rejectOutstanding(protocolError("Codex auth client closed with pending work."));
    try {
      if (!this.#childClosed) {
        const closed = new Promise((resolveClosed) => this.child.once("close", resolveClosed));
        this.child.stdin.end();
        const graceful = await Promise.race([
          closed.then(() => true),
          new Promise((resolveWait) => setTimeout(() => resolveWait(false), 500)),
        ]);
        if (!graceful && !this.#childClosed) {
          this.child.kill("SIGTERM");
          const terminated = await Promise.race([
            closed.then(() => true),
            new Promise((resolveWait) => setTimeout(() => resolveWait(false), 500)),
          ]);
          if (!terminated && !this.#childClosed) this.child.kill("SIGKILL");
        }
      }
    } finally {
      this.#closed = true;
      this.#closing = false;
    }
  }

  #write(message) {
    if (this.#failure) throw this.#failure;
    if (this.#closed || this.#closing || !this.child.stdin.writable) {
      throw protocolError("Codex app-server input is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #writeUnsupportedServerRequest(id) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({
      id,
      error: { code: -32601, message: "Unsupported server request." },
    })}\n`);
  }

  #handleStdout(chunk) {
    if (this.#closed || this.#failure) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#stdoutBytes += incoming.byteLength;
    if (this.#stdoutBytes > MAX_STDOUT_BYTES) {
      this.#fail(protocolError("Codex app-server exceeded its stdout budget."));
      return;
    }
    let buffered = Buffer.concat([this.#stdout, incoming]);
    let newline = buffered.indexOf(0x0a);
    while (newline >= 0) {
      const frame = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (frame.byteLength > MAX_FRAME_BYTES) {
        this.#fail(protocolError("Codex app-server emitted an oversized JSONL frame."));
        return;
      }
      this.#frames += 1;
      if (this.#frames > MAX_FRAMES) {
        this.#fail(protocolError("Codex app-server exceeded its frame-count budget."));
        return;
      }
      const content = frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
      try {
        this.#handleLine(content.toString("utf8"));
      } catch (error) {
        this.#fail(error instanceof Error ? error : protocolError("Auth frame handling failed."));
      }
      if (this.#failure) return;
      newline = buffered.indexOf(0x0a);
    }
    if (buffered.byteLength > MAX_FRAME_BYTES) {
      this.#fail(protocolError("Codex app-server emitted an oversized unterminated frame."));
      return;
    }
    this.#stdout = Buffer.from(buffered);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw protocolError("Codex app-server emitted invalid JSONL.");
    }
    if (!isRecord(message)) throw protocolError("Codex app-server emitted a non-object frame.");
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (hasMethod && typeof message.method !== "string") {
      throw protocolError("Codex app-server emitted a malformed method.");
    }
    if (
      hasId &&
      !(typeof message.id === "string" ||
        (typeof message.id === "number" && Number.isSafeInteger(message.id)))
    ) {
      throw protocolError("Codex app-server emitted a malformed id.");
    }
    if (hasId && hasMethod) {
      this.#writeUnsupportedServerRequest(message.id);
      throw protocolError("Codex app-server attempted a forbidden server request.");
    }
    if (hasId) {
      const pending = this.#pending.get(message.id);
      if (!pending) throw protocolError("Codex app-server returned an unknown response id.");
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (hasResult === hasError) throw protocolError("Codex app-server returned a malformed response.");
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (hasError) {
        pending.reject(protocolError(`Codex app-server rejected ${pending.method}.`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      !hasMethod ||
      !this.#acceptLoginCompletionNotifications ||
      message.method !== "account/login/completed"
    ) {
      throw protocolError("Codex app-server emitted a notification outside the auth allowlist.");
    }
    validateNotificationParams(message.params);
    if (this.#notifications.length + this.#waiters.length >= MAX_NOTIFICATIONS) {
      throw protocolError("Codex app-server exceeded its auth-notification budget.");
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(message);
    } else {
      this.#notifications.push(message);
    }
  }

  #waitForNotification(timeoutMs, signal) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(abortReason());
    const queued = this.#notifications.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolveNotification, rejectNotification) => {
      const removeWaiter = () => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolveNotification);
        if (index >= 0) this.#waiters.splice(index, 1);
      };
      const onAbort = () => {
        removeWaiter();
        clearTimeout(timer);
        rejectNotification(abortReason());
      };
      const timer = setTimeout(() => {
        removeWaiter();
        signal?.removeEventListener("abort", onAbort);
        rejectNotification(timeoutError("Timed out waiting for device-code completion."));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push({
        resolve: resolveNotification,
        reject: rejectNotification,
        timer,
        signal,
        onAbort,
      });
    });
  }

  #fail(error) {
    if (this.#closed || this.#failure) return;
    this.#failure = error;
    this.#rejectOutstanding(error);
  }

  #rejectOutstanding(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    this.#waiters = [];
    this.#notifications = [];
  }
}

function validateAccountReadback(result, unavailable = false) {
  if (
    !isRecord(result) ||
    !Object.hasOwn(result, "account") ||
    result.requiresOpenaiAuth !== true
  ) {
    throw protocolError("account/read returned a malformed response.");
  }
  if (result.account === null) {
    if (!unavailable) return null;
    return null;
  }
  if (unavailable) {
    throw new CodexAuthLifecycleError(
      "AUTH_LOGOUT_FAILED",
      "Dedicated authentication remained available after logout.",
    );
  }
  if (
    !isRecord(result.account) ||
    result.account.type !== "chatgpt" ||
    !PLAN_CLASSES.has(result.account.planType) ||
    !(result.account.email === null || result.account.email === undefined ||
      typeof result.account.email === "string")
  ) {
    throw new CodexAuthLifecycleError(
      "AUTH_ACCOUNT_MODE",
      "The dedicated runtime is not authenticated with a supported ChatGPT account.",
    );
  }
  return Object.freeze({ kind: "chatgpt", planClass: result.account.planType });
}

function sameAccountClass(left, right) {
  return left?.kind === right?.kind && left?.planClass === right?.planClass;
}

function validateDeviceCodeStart(result) {
  if (
    !isRecord(result) ||
    result.type !== "chatgptDeviceCode" ||
    !protocolIdentifier(result.loginId) ||
    !protocolIdentifier(result.userCode, 128) ||
    !protocolIdentifier(result.verificationUrl, 2_048)
  ) {
    throw protocolError("account/login/start returned a malformed device-code response.");
  }
  let verification;
  try {
    verification = new URL(result.verificationUrl);
  } catch {
    throw protocolError("account/login/start returned a malformed verification URL.");
  }
  if (!verification.hostname || !["https:", "http:"].includes(verification.protocol)) {
    throw protocolError("account/login/start returned an unsupported verification URL.");
  }
  return result;
}

export async function initializeAuthClient(
  client,
  codexHome,
  timeoutMs,
  notificationOptOutMethods,
  options = {},
) {
  const result = await client.request(
    "initialize",
    createCodexAuthInitializeParams(notificationOptOutMethods, options),
    timeoutMs,
  );
  if (
    !isRecord(result) ||
    result.codexHome !== codexHome ||
    typeof result.userAgent !== "string" || result.userAgent.length === 0
  ) {
    throw protocolError("initialize did not read back the dedicated CODEX_HOME.");
  }
  client.notifyInitialized();
}

export async function readAccount(client, refreshToken, timeoutMs, unavailable = false) {
  return validateAccountReadback(
    await client.request("account/read", { refreshToken }, timeoutMs),
    unavailable,
  );
}

async function logoutAndProveUnavailable(client, timeoutMs) {
  const response = await client.request("account/logout", undefined, timeoutMs);
  if (!isRecord(response)) throw protocolError("account/logout returned a malformed response.");
  const unavailable = await readAccount(client, false, timeoutMs, true);
  if (unavailable !== null) {
    throw new CodexAuthLifecycleError(
      "AUTH_LOGOUT_FAILED",
      "Dedicated authentication remained available after logout.",
    );
  }
}

async function cancelLogin(client, loginId, timeoutMs) {
  try {
    const result = await client.request(
      "account/login/cancel",
      { loginId },
      Math.min(timeoutMs, DEFAULT_CANCEL_TIMEOUT_MS),
    );
    if (!isRecord(result) || !["canceled", "notFound"].includes(result.status)) {
      throw protocolError("account/login/cancel returned a malformed response.");
    }
  } catch {
    // Cancellation is best effort. The original bounded login failure remains authoritative.
  }
}

async function runDeviceCodeLogin(
  client,
  attempt,
  onDeviceCode,
  requestTimeoutMs,
  handoffTimeoutMs,
  loginTimeoutMs,
  signal,
) {
  const started = validateDeviceCodeStart(await client.request(
    "account/login/start",
    { type: "chatgptDeviceCode" },
    requestTimeoutMs,
  ));
  try {
    await runBoundedDeviceCodeHandoff(onDeviceCode, Object.freeze({
      attempt,
      verificationUrl: started.verificationUrl,
      userCode: started.userCode,
    }), handoffTimeoutMs, signal);
    await client.waitForLoginCompletion(started.loginId, loginTimeoutMs, signal);
  } catch (error) {
    await cancelLogin(client, started.loginId, requestTimeoutMs);
    throw error;
  }
  const account = await readAccount(client, true, requestTimeoutMs);
  if (!account) {
    throw new CodexAuthLifecycleError(
      "AUTH_LOGIN_FAILED",
      "Device authentication completed without an authenticated account readback.",
    );
  }
  return account;
}

function runBoundedDeviceCodeHandoff(callback, prompt, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(abortReason());
  return new Promise((resolveHandoff, rejectHandoff) => {
    let settled = false;
    const finish = (callbackFinish) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callbackFinish();
    };
    const fail = (code, message) => finish(() => rejectHandoff(
      new CodexAuthLifecycleError(code, message),
    ));
    const onAbort = () => fail("AUTH_CANCELLED", "Codex authentication was cancelled.");
    const timer = setTimeout(() => fail(
      "AUTH_TIMEOUT",
      "Timed out presenting the device-code handoff to the operator.",
    ), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => callback(prompt)).then(
      () => finish(resolveHandoff),
      () => fail(
        "AUTH_OPERATOR_HANDOFF",
        "The device-code handoff could not be presented to the operator.",
      ),
    );
  });
}

export async function validateCanonicalDirectory(path, label, privateMode = false) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute canonical path.`);
  }
  let metadata;
  let canonical;
  try {
    metadata = await lstat(path);
    canonical = await realpath(path);
  } catch (error) {
    throw new CodexAuthLifecycleError(
      "AUTH_DEPLOYMENT",
      `${label} is unavailable.`,
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== path) {
    throw new CodexAuthLifecycleError("AUTH_DEPLOYMENT", `${label} is not a real canonical directory.`);
  }
  if (privateMode && (metadata.mode & 0o777) !== 0o700) {
    throw new CodexAuthLifecycleError("AUTH_DEPLOYMENT", `${label} must have mode 0700.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new CodexAuthLifecycleError("AUTH_DEPLOYMENT", `${label} has the wrong owner.`);
  }
}

export function validateExecutionProvider(value, runtimeIdentity) {
  const identity = value?.identity;
  if (
    !isRecord(value) ||
    typeof value.spawnAppServer !== "function" ||
    !isRecord(identity) ||
    typeof identity.canonicalPath !== "string" ||
    !isAbsolute(identity.canonicalPath) ||
    resolve(identity.canonicalPath) !== identity.canonicalPath ||
    typeof identity.version !== "string" ||
    !SHA256.test(identity.sha256 ?? "")
  ) {
    throw new TypeError("An identity-bearing Codex execution provider is required.");
  }
  if (
    sha256(identity.canonicalPath) !== runtimeIdentity.canonicalTargetPathSha256 ||
    identity.version !== runtimeIdentity.executableVersion ||
    identity.sha256 !== runtimeIdentity.executableSha256
  ) {
    throw new CodexAuthLifecycleError(
      "AUTH_DEPLOYMENT",
      "The Codex execution provider does not match the accepted runtime identity.",
    );
  }
  return value;
}

export function assertSecretFreeAuthLifecycleProjection(value) {
  const serialized = JSON.stringify(value);
  for (const forbiddenKey of ["email", "accessToken", "refreshToken", "userCode", "verificationUrl"] ) {
    if (serialized.includes(`"${forbiddenKey}"`)) {
      throw new TypeError("The auth lifecycle projection contains credential-bearing fields.");
    }
  }
  if (!isRecord(value) || value.outcome !== "authenticated") {
    throw new TypeError("The auth lifecycle projection is incomplete.");
  }
  return value;
}

export async function runCodexAuthLifecycle(options, dependencies = {}) {
  if (!isRecord(options)) throw new TypeError("Codex auth lifecycle options are required.");
  const {
    executionProvider,
    normalHome,
    codexHome,
    appCwd,
    onDeviceCode,
    signal,
  } = options;
  if (typeof onDeviceCode !== "function") {
    throw new TypeError("An ephemeral device-code operator callback is required.");
  }
  if (signal?.aborted) throw abortReason();
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
      "Auth lifecycle roots must remain separate.",
    );
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const handoffTimeoutMs = options.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
    requestTimeoutMs > DEFAULT_LOGIN_TIMEOUT_MS ||
    !Number.isSafeInteger(handoffTimeoutMs) || handoffTimeoutMs < 1 ||
    handoffTimeoutMs > DEFAULT_LOGIN_TIMEOUT_MS ||
    !Number.isSafeInteger(loginTimeoutMs) || loginTimeoutMs < 1 ||
    loginTimeoutMs > DEFAULT_LOGIN_TIMEOUT_MS
  ) {
    throw new TypeError("Auth lifecycle timeouts are outside their bounds.");
  }
  const releaseInputs = normalizeAuthReleaseInputs(options.releaseInputs);
  const notificationOptOutMethods = normalizeCodexAuthNotificationOptOutMethods(
    options.notificationOptOutMethods,
  );
  const operatorSha256 = validateSha256(
    options.operatorSha256,
    "The installed release operator identity",
  );
  const runtimeIdentity = normalizeRuntimeIdentity(options.runtimeIdentity);
  validateExecutionProvider(executionProvider, runtimeIdentity);
  const deploymentReadback = validateDeploymentReadback(options.deploymentReadback);
  const normalBefore = await (dependencies.snapshotNormalInputs ??
    snapshotStableNormalCodexInputs)(normalHome);
  let processCount = 0;
  let initializedDedicatedHomeCount = 0;
  let client = null;

  const startClient = async () => {
    if (signal?.aborted) throw abortReason();
    validateExecutionProvider(executionProvider, runtimeIdentity);
    const child = await executionProvider.spawnAppServer({ signal });
    processCount += 1;
    const next = new BoundedCodexAuthClient(child);
    try {
      await initializeAuthClient(
        next,
        codexHome,
        requestTimeoutMs,
        notificationOptOutMethods,
      );
      initializedDedicatedHomeCount += 1;
      return next;
    } catch (error) {
      await next.close().catch(() => undefined);
      throw error;
    }
  };

  let initialAuthenticated = false;
  let preexistingLogoutProved = false;
  let firstAccount;
  let restartAccount;
  let finalAccount;
  try {
    client = await startClient();
    const initial = await readAccount(client, false, requestTimeoutMs);
    initialAuthenticated = initial !== null;
    if (initialAuthenticated) {
      await logoutAndProveUnavailable(client, requestTimeoutMs);
      preexistingLogoutProved = true;
    }
    firstAccount = await runDeviceCodeLogin(
      client,
      1,
      onDeviceCode,
      requestTimeoutMs,
      handoffTimeoutMs,
      loginTimeoutMs,
      signal,
    );
    client.assertHealthy();
    await client.close();
    client = null;

    client = await startClient();
    restartAccount = await readAccount(client, true, requestTimeoutMs);
    if (!restartAccount || !sameAccountClass(firstAccount, restartAccount)) {
      throw new CodexAuthLifecycleError(
        "AUTH_RESTART_READBACK",
        "A fresh app-server process did not retain the authenticated ChatGPT account class.",
      );
    }
    await logoutAndProveUnavailable(client, requestTimeoutMs);
    finalAccount = await runDeviceCodeLogin(
      client,
      2,
      onDeviceCode,
      requestTimeoutMs,
      handoffTimeoutMs,
      loginTimeoutMs,
      signal,
    );
    if (!sameAccountClass(firstAccount, finalAccount)) {
      throw new CodexAuthLifecycleError(
        "AUTH_FINAL_READBACK",
        "The final fresh login changed the authenticated ChatGPT account class.",
      );
    }
    client.assertHealthy();
  } finally {
    await client?.close().catch(() => undefined);
  }

  const normalAfter = await (dependencies.snapshotNormalInputs ??
    snapshotStableNormalCodexInputs)(normalHome);
  if (normalBefore.identitySha256 !== normalAfter.identitySha256) {
    throw new CodexAuthLifecycleError(
      "AUTH_NORMAL_STATE",
      "Stable normal-home Codex inputs changed during dedicated authentication.",
    );
  }
  if (processCount !== 2 || initializedDedicatedHomeCount !== 2) {
    throw new CodexAuthLifecycleError(
      "AUTH_RESTART_READBACK",
      "The auth lifecycle did not use two initialized app-server processes.",
    );
  }

  const projection = deepFreeze({
    outcome: "authenticated",
    operatorSha256,
    releaseInputs,
    runtimeIdentity,
    deploymentReadback,
    environment: {
      processCount,
      realHomeRetained: true,
      dedicatedHomeReadbackCount: initializedDedicatedHomeCount,
      canonicalApplicationRootRetained: true,
      notificationOptOutMethodCount: notificationOptOutMethods.length,
      notificationOptOutMethodsSha256: sha256(canonicalJson(notificationOptOutMethods)),
    },
    lifecycle: {
      initialAuthenticated,
      preexistingLogoutProved: initialAuthenticated ? preexistingLogoutProved : true,
      firstDeviceLoginCompleted: true,
      firstRefreshReadback: true,
      freshProcessReadback: true,
      logoutUnavailableReadback: true,
      secondDeviceLoginCompleted: true,
      finalRefreshReadback: true,
    },
    account: finalAccount,
    normalStableInputs: {
      before: normalBefore,
      after: normalAfter,
      unchanged: true,
    },
  });
  return assertSecretFreeAuthLifecycleProjection(projection);
}
