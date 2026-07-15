import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGlobalCodexBatchRequest,
  isGlobalCodexResponse,
} from "../../lib/global-codex-contract.ts";
import { createGlobalCodexClientForHostTesting } from "../planner-global-client.ts";
import { readBoundedFile } from "../../server/runtime/codex-follow-up/resource-policy.ts";
import { inspectCodexRetentionDatabase } from "../../server/store/codex-retention-reader.ts";
import {
  ACTIVATION_COORDINATE_KEYS,
  activationCoordinatesEqual,
} from "./codex-release-candidate-contract.mjs";
import {
  isReleaseSourceRelativePathIncluded,
} from "./planner-release-source.mjs";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const MAX_TREE_FILES = 10_000;
const MAX_TREE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const MAX_NORMAL_STATE_LOGICAL_BYTES = 64 * 1_024 * 1_024 * 1_024;
const MAX_NORMAL_STATE_FILES = 100_000;
const MAX_NORMAL_STATE_DEPTH = 32;
const MAX_FILE_BYTES = 512 * 1_024 * 1_024;
const MAX_DEPTH = 16;
const COMPATIBILITY_EVIDENCE_BYTES = 2 * 1_024 * 1_024;
const EMPTY_EPHEMERAL_TABLES = Object.freeze([
  "threads",
  "thread_dynamic_tools",
  "agent_jobs",
  "agent_job_items",
]);
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function pathContains(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

async function hashFileBounded(path, expectedSize) {
  if (expectedSize > MAX_FILE_BYTES) {
    throw new Error("A Codex inventory file exceeded its byte budget.");
  }
  const hash = createHash("sha256");
  let consumed = 0;
  for await (const chunk of createReadStream(path)) {
    consumed += chunk.length;
    if (consumed > MAX_FILE_BYTES || consumed > expectedSize) {
      throw new Error("A Codex inventory file changed or exceeded its byte budget while hashing.");
    }
    hash.update(chunk);
  }
  if (consumed !== expectedSize) {
    throw new Error("A Codex inventory file changed while hashing.");
  }
  return hash.digest("hex");
}

function normalStateCategory(relativePath) {
  const parts = relativePath.split("/");
  const base = parts.at(-1);
  if (relativePath === "auth.json") return "auth";
  if (base === "config.toml" || base?.endsWith(".config.toml")) return "config";
  if (/^\.\.?codex-global-state/u.test(relativePath)) return "runtime_state";
  if (parts[0] === "sqlite") return "runtime_databases";
  if (["log", "logs"].includes(parts[0])) return "runtime_logs";
  if (/^(?:state|logs|memories|goals)(?:_[0-9]+)?\.sqlite(?:[-.].*)?$/u.test(base ?? "")) {
    return "runtime_databases";
  }
  if (
    ["sessions", "archived_sessions"].includes(parts[0]) ||
    base === "history.jsonl"
  ) return "sessions";
  if (["plugins", "marketplaces"].includes(parts[0])) return "plugins";
  return "ambient";
}

function dedicatedFileClass(relativePath) {
  const base = relativePath.split("/").at(-1) ?? "";
  if (relativePath === "auth.json") return "auth";
  if (relativePath === "config.toml" || relativePath === "AGENTS.md") return "configuration";
  if (relativePath.startsWith(".planner-runtime/evidence/")) return "compatibility_evidence";
  if (relativePath.startsWith(".planner-runtime/schema/")) return "schema_cache";
  if (relativePath.startsWith(".planner-runtime/execution-snapshots/")) {
    return "execution_snapshot";
  }
  if (/^state(?:_[0-9]+)?\.sqlite$/u.test(base)) return "state_sqlite";
  if (/^logs(?:_[0-9]+)?\.sqlite$/u.test(base)) return "log_sqlite";
  if (/\.sqlite-(?:wal|shm)$/u.test(base)) return "sqlite_sidecar";
  if (/\.log$/u.test(base) || relativePath.startsWith("log/")) return "runtime_log";
  return "other";
}

async function inventoryTree(
  root,
  selectCategory,
  relativePrefix = "",
  shouldDescend = () => true,
  options = {},
) {
  const hashFileContents = options.hashFileContents !== false;
  const shouldHashFileContents = options.shouldHashFileContents ?? (() => true);
  const allowSpecialFiles = options.allowSpecialFiles === true;
  const includeDirectories = options.includeDirectories === true;
  const maxLogicalBytes = options.maxLogicalBytes ?? MAX_TREE_BYTES;
  const maxFiles = options.maxFiles ?? MAX_TREE_FILES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || await realpath(root) !== root) {
    throw new Error("A Codex inventory root must be a real canonical directory.");
  }
  const entries = [];
  const pending = [{ path: root, depth: 0 }];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > maxDepth) throw new Error("A Codex inventory exceeded its depth budget.");
    const children = await readdir(current.path, { withFileTypes: true });
    for (const child of children) {
      const path = join(current.path, child.name);
      const localRelativePath = relative(root, path).split(sep).join("/");
      const relativePath = relativePrefix
        ? `${relativePrefix}/${localRelativePath}`
        : localRelativePath;
      if (!shouldDescend(relativePath)) continue;
      if (!pathContains(root, path)) throw new Error("A Codex inventory path escaped its root.");
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (includeDirectories) {
          const category = selectCategory(relativePath);
          if (category !== null) {
            if (entries.length >= maxFiles) {
              throw new Error("A Codex inventory exceeded its file budget.");
            }
            entries.push({
              category,
              relativePathSha256: sha256(relativePath),
              device: metadata.dev.toString(),
              inode: metadata.ino.toString(),
              size: Number(metadata.size),
              mode: Number(metadata.mode & BigInt(0o777)),
              ownerUid: Number(metadata.uid),
              linkCount: Number(metadata.nlink),
              modifiedNanoseconds: metadata.mtimeNs.toString(),
              changedNanoseconds: metadata.ctimeNs.toString(),
              kind: "directory",
              contentSha256: null,
              absolutePath: path,
            });
          }
        }
        pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      const category = selectCategory(relativePath);
      if (category === null) continue;
      if (entries.length >= maxFiles) throw new Error("A Codex inventory exceeded its file budget.");
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size)) throw new Error("A Codex inventory file size is invalid.");
      totalBytes += size;
      if (totalBytes > maxLogicalBytes) throw new Error("A Codex inventory exceeded its byte budget.");
      const common = {
        category,
        relativePathSha256: sha256(relativePath),
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        size,
        mode: Number(metadata.mode & BigInt(0o777)),
        ownerUid: Number(metadata.uid),
        linkCount: Number(metadata.nlink),
        modifiedNanoseconds: metadata.mtimeNs.toString(),
        changedNanoseconds: metadata.ctimeNs.toString(),
      };
      if (metadata.isSymbolicLink()) {
        entries.push({
          ...common,
          kind: "symlink",
          contentSha256: hashFileContents && shouldHashFileContents(relativePath, category)
            ? sha256(await readlink(path))
            : null,
          absolutePath: path,
        });
      } else if (metadata.isFile()) {
        entries.push({
          ...common,
          kind: "file",
          contentSha256: hashFileContents && shouldHashFileContents(relativePath, category)
            ? await hashFileBounded(path, size)
            : null,
          absolutePath: path,
        });
      } else if (allowSpecialFiles) {
        const kind = metadata.isSocket()
          ? "socket"
          : metadata.isFIFO()
            ? "fifo"
            : metadata.isCharacterDevice()
              ? "character_device"
              : metadata.isBlockDevice()
                ? "block_device"
                : "special";
        entries.push({
          ...common,
          kind,
          contentSha256: null,
          absolutePath: path,
        });
      } else {
        throw new Error("A Codex inventory contains an unsupported file type.");
      }
    }
  }
  return entries.sort((left, right) =>
    left.relativePathSha256.localeCompare(right.relativePathSha256));
}

function projectInventory(entries) {
  const categories = {};
  for (const entry of entries) {
    const category = categories[entry.category] ??= { files: 0, bytes: 0, rows: [] };
    category.files += 1;
    category.bytes += entry.size;
    category.rows.push({
      path: entry.relativePathSha256,
      kind: entry.kind,
      device: entry.device,
      inode: entry.inode,
      size: entry.size,
      mode: entry.mode,
      ownerUid: entry.ownerUid,
      linkCount: entry.linkCount,
      modified: entry.modifiedNanoseconds,
      changed: entry.changedNanoseconds,
      content: entry.contentSha256,
    });
  }
  return Object.fromEntries(Object.entries(categories).sort().map(([name, category]) => [
    name,
    Object.freeze({
      files: category.files,
      bytes: category.bytes,
      identitySha256: sha256(canonicalJson(category.rows)),
    }),
  ]));
}

export async function snapshotNormalCodexState(normalHome) {
  const root = resolve(normalHome, ".codex");
  const entries = await inventoryTree(
    root,
    normalStateCategory,
    "",
    () => true,
    {
      hashFileContents: false,
      allowSpecialFiles: true,
      includeDirectories: true,
      maxLogicalBytes: MAX_NORMAL_STATE_LOGICAL_BYTES,
      maxFiles: MAX_NORMAL_STATE_FILES,
      maxDepth: MAX_NORMAL_STATE_DEPTH,
    },
  );
  const fileEntries = entries.filter((entry) => entry.kind !== "directory");
  const directoryEntries = entries.filter((entry) => entry.kind === "directory");
  const categories = projectInventory(fileEntries);
  const rootMetadata = await lstat(root, { bigint: true });
  const directoryRows = [{
    path: sha256(""),
    device: rootMetadata.dev.toString(),
    inode: rootMetadata.ino.toString(),
    mode: Number(rootMetadata.mode & BigInt(0o777)),
    modified: rootMetadata.mtimeNs.toString(),
    changed: rootMetadata.ctimeNs.toString(),
  }, ...directoryEntries.map((entry) => ({
    path: entry.relativePathSha256,
    device: entry.device,
    inode: entry.inode,
    mode: entry.mode,
    modified: entry.modifiedNanoseconds,
    changed: entry.changedNanoseconds,
  }))];
  const directories = Object.freeze({
    count: directoryRows.length,
    identitySha256: sha256(canonicalJson(directoryRows)),
  });
  return Object.freeze({
    files: fileEntries.length,
    bytes: fileEntries.reduce((sum, entry) => sum + entry.size, 0),
    directories,
    categories,
    identitySha256: sha256(canonicalJson({ categories, directories })),
  });
}

async function inspectRetentionDatabase(entry) {
  if (entry.kind !== "file" || !["state_sqlite", "log_sqlite"].includes(entry.category)) {
    return null;
  }
  return inspectCodexRetentionDatabase(
    entry.absolutePath,
    entry.relativePathSha256,
    entry.category,
  );
}

export async function collectDedicatedRuntimeRetention(codexHome) {
  const inventoryOptions = {
    shouldHashFileContents: (_relativePath, category) => category !== "auth",
  };
  const entries = await inventoryTree(
    resolve(codexHome),
    dedicatedFileClass,
    "",
    () => true,
    inventoryOptions,
  );
  const databases = (await Promise.all(entries.map(inspectRetentionDatabase))).filter(Boolean);
  const finalEntries = await inventoryTree(
    resolve(codexHome),
    dedicatedFileClass,
    "",
    () => true,
    inventoryOptions,
  );
  const retainedEntries = entries.filter((entry) => entry.category !== "auth");
  const finalRetainedEntries = finalEntries.filter((entry) => entry.category !== "auth");
  if (
    sha256(canonicalJson(projectInventory(retainedEntries))) !==
    sha256(canonicalJson(projectInventory(finalRetainedEntries)))
  ) {
    throw new Error("Codex retention inspection changed the dedicated runtime surface.");
  }
  const observedTables = new Set(databases.flatMap((database) => Object.keys(database.counts)));
  for (const table of ["threads", "thread_dynamic_tools", "agent_jobs"]) {
    if (!observedTables.has(table)) {
      throw new Error(`Dedicated Codex retention inventory omitted ${table}.`);
    }
  }
  const ephemeralCounts = Object.fromEntries(EMPTY_EPHEMERAL_TABLES.map((table) => [
    table,
    databases.reduce((sum, database) => sum + (database.counts[table] ?? 0), 0),
  ]));
  if (Object.values(ephemeralCounts).some((count) => count !== 0)) {
    throw new Error("Ephemeral embedded Codex work persisted forbidden thread/tool/job rows.");
  }
  const initialCredentialEntries = entries.filter((entry) => entry.category === "auth");
  const credentialEntries = finalEntries.filter((entry) => entry.category === "auth");
  const initialCredential = initialCredentialEntries[0];
  const credential = credentialEntries[0];
  if (
    initialCredentialEntries.length !== 1 ||
    credentialEntries.length !== 1 ||
    initialCredential.kind !== "file" ||
    initialCredential.mode !== 0o600 ||
    initialCredential.linkCount !== 1 ||
    initialCredential.ownerUid !== process.getuid?.() ||
    initialCredential.contentSha256 !== null ||
    credential.kind !== "file" ||
    credential.mode !== 0o600 ||
    credential.linkCount !== 1 ||
    credential.ownerUid !== process.getuid?.() ||
    credential.contentSha256 !== null
  ) {
    throw new Error("Dedicated credentials must remain one private metadata-only file.");
  }
  if (
    initialCredential.kind !== credential.kind ||
    initialCredential.mode !== credential.mode ||
    initialCredential.linkCount !== credential.linkCount ||
    initialCredential.ownerUid !== credential.ownerUid
  ) {
    throw new Error("Dedicated credential safety metadata changed during retention inspection.");
  }
  const classes = projectInventory(finalRetainedEntries);
  return Object.freeze({
    files: finalRetainedEntries.length,
    bytes: finalRetainedEntries.reduce((sum, entry) => sum + entry.size, 0),
    classes,
    credentials: Object.freeze({
      present: true,
      kind: "file",
      ownerUid: credential.ownerUid,
      mode: credential.mode,
      linkCount: credential.linkCount,
      contentHashed: false,
    }),
    databaseTables: databases,
    ephemeralCounts,
    logRows: databases.reduce((sum, database) => sum + (database.counts.logs ?? 0), 0),
  });
}

export async function collectCandidateSourceManifest(root = packageRoot) {
  const canonicalRoot = await realpath(resolve(root));
  const entries = await inventoryTree(
    canonicalRoot,
    () => "candidate_source",
    "",
    isReleaseSourceRelativePathIncluded,
  );
  if (entries.some((entry) => entry.kind !== "file")) {
    throw new Error("A release-candidate source file has an unsafe type.");
  }
  const rows = entries.sort((left, right) =>
    left.relativePathSha256.localeCompare(right.relativePathSha256)).map((entry) => ({
      path: entry.relativePathSha256,
      kind: entry.kind,
      size: entry.size,
      mode: entry.mode,
      content: entry.contentSha256,
    }));
  return Object.freeze({
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.size, 0),
    sha256: sha256(canonicalJson(rows)),
  });
}

function oneHash(record, prefix) {
  const matches = Object.entries(record ?? {}).filter(([key, value]) =>
    key.startsWith(prefix) && typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  return matches.length === 1 ? matches[0][1] : null;
}

export async function readObservedCapabilityProjection(codexHome, coordinates) {
  const path = join(codexHome, ".planner-runtime", "evidence", "compatibility-v1.json");
  const evidence = JSON.parse((await readBoundedFile(
    path,
    COMPATIBILITY_EVIDENCE_BYTES,
    "Codex compatibility evidence",
  )).toString("utf8"));
  const capability = evidence.capability;
  const readback = evidence.deploymentReadback;
  const evidenceCoordinates = Object.freeze({
    canonicalPath: evidence.executable?.canonicalPath,
    version: evidence.executable?.version,
    sha256: evidence.executable?.sha256,
    schemaFingerprint: evidence.schemaFingerprint,
    userConfigSha256: oneHash(readback?.configSourceHashes, "user:"),
    systemConfigSha256: oneHash(readback?.configSourceHashes, "system:"),
    systemConfigPathCount: readback?.systemConfigPaths?.length,
    instructionSha256: oneHash(readback?.instructionSourceHashes, "dedicated:"),
    accountKind: readback?.accountKind,
  });
  if (
    evidence.contractVersion !== 1 || evidence.disposition !== "compatible" ||
    evidence.active !== false || !activationCoordinatesEqual(coordinates, evidenceCoordinates) ||
    capability?.researchWebSearchMode !== "live" ||
    JSON.stringify(capability?.researchTools) !== JSON.stringify(["update_plan", "web_search"]) ||
    JSON.stringify(capability?.plannerTools) !== JSON.stringify(["update_plan", "planner"]) ||
    JSON.stringify(capability?.plannerNamespaceMembers) !== JSON.stringify(["read", "preview", "apply"]) ||
    JSON.stringify(capability?.forbiddenHits) !== "[]" ||
    JSON.stringify(capability?.unexpectedRpcMethods) !== "[]" ||
    capability?.dependentResultObserved !== true || capability?.outboundPolicyRejected !== true ||
    capability?.permissionProfile !== ":read-only" ||
    capability?.effectiveSandbox !== "read-only-network-disabled" ||
    readback?.authenticated !== true ||
    JSON.stringify(readback?.mcpServerNames) !== "[]" ||
    JSON.stringify(readback?.appNames) !== "[]" ||
    JSON.stringify(readback?.pluginNames) !== "[]" ||
    !/^[a-f0-9]{64}$/u.test(evidence.rawSchemaBundleSha256)
  ) {
    throw new Error("The release-candidate capability evidence is not bound and closed.");
  }
  return Object.freeze({
    evaluatedAt: evidence.evaluatedAt,
    rawSchemaBundleSha256: evidence.rawSchemaBundleSha256,
    researchWebSearchMode: capability.researchWebSearchMode,
    researchTools: capability.researchTools,
    plannerTools: capability.plannerTools,
    plannerNamespaceMembers: capability.plannerNamespaceMembers,
    forbiddenHits: capability.forbiddenHits,
    unexpectedRpcMethods: capability.unexpectedRpcMethods,
    dependentResultObserved: true,
    outboundPolicyRejected: true,
    permissionProfile: capability.permissionProfile,
    effectiveSandbox: capability.effectiveSandbox,
    emptyAmbientSurfaces: true,
  });
}

export function parseSupportedGlobalClientOutput(command, result) {
  if (result.code !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`The supported Global UDS client failed for ${command}.`);
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("The supported Global UDS client returned invalid JSON.");
  }
  if (!isGlobalCodexResponse(value)) {
    throw new Error("The supported Global UDS client returned an invalid contract.");
  }
  return value;
}

export function createHostOnlyGlobalClientRunner(socketPath) {
  const client = createGlobalCodexClientForHostTesting(socketPath);
  return async (command, input) => {
    if (!["health", "workspace", "apply"].includes(command)) {
      throw new TypeError("Unsupported Global UDS client command.");
    }
    let batch = null;
    if (command === "apply") {
      let parsed;
      try {
        parsed = JSON.parse(input ?? "");
      } catch {
        throw new TypeError("Planner batch input is not valid JSON.");
      }
      if (!isGlobalCodexBatchRequest(parsed)) {
        throw new TypeError("Planner batch input does not match contract version 1.");
      }
      batch = parsed;
    } else if (input !== null) {
      throw new TypeError("Read-only Global UDS commands do not accept input.");
    }
    return client.invoke(command, batch);
  };
}

export async function readIncompatibleEvidenceProjection(fixture, status) {
  const evidence = JSON.parse((await readBoundedFile(
    join(fixture.codexHome, ".planner-runtime", "evidence", "compatibility-v1.json"),
    COMPATIBILITY_EVIDENCE_BYTES,
    "Incompatible Codex evidence",
  )).toString("utf8"));
  if (
    status.state !== "incompatible" || status.protocolCompatible !== false ||
    evidence?.contractVersion !== 1 || evidence.disposition !== "incompatible" ||
    !evidence.executable || evidence.executable.canonicalPath !== fixture.launcherTargetPath ||
    typeof evidence.executable.version !== "string" ||
    !/^[a-f0-9]{64}$/u.test(evidence.executable.sha256) ||
    typeof evidence.detail !== "string" || evidence.detail.length === 0 || evidence.detail.length > 512
  ) {
    throw new Error("The exact-path incompatible Codex evidence is invalid.");
  }
  return Object.freeze({
    updaterLauncherPathSha256: sha256(fixture.launcherPath),
    canonicalTargetPathSha256: sha256(evidence.executable.canonicalPath),
    dedicatedHomePathSha256: sha256(fixture.codexHome),
    fixedCwdPathSha256: sha256(fixture.appCwd),
    plannerDataPathSha256: sha256(fixture.plannerDataDirectory),
    targetVersion: evidence.executable.version,
    targetSha256: evidence.executable.sha256,
    schemaFingerprint: evidence.schemaFingerprint,
    configSha256: await hashFileBounded(
      join(fixture.codexHome, "config.toml"),
      Number((await lstat(join(fixture.codexHome, "config.toml"))).size),
    ),
    instructionSha256: await hashFileBounded(
      join(fixture.codexHome, "AGENTS.md"),
      Number((await lstat(join(fixture.codexHome, "AGENTS.md"))).size),
    ),
    reason: evidence.detail,
  });
}

export function activationCoordinatesProjection(value) {
  return Object.freeze(Object.fromEntries(
    ACTIVATION_COORDINATE_KEYS.map((key) => [key, value[key]]),
  ));
}
