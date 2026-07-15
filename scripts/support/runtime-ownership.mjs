import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_SOCKET_MODE = 0o600;
const LEASE_REGISTRY_KEY = Symbol.for(
  "weekly-recipe-planner.runtime-ownership-leases.v1",
);

function processLeaseRegistry() {
  const processGlobal = globalThis;
  if (processGlobal[LEASE_REGISTRY_KEY] instanceof WeakMap) {
    return processGlobal[LEASE_REGISTRY_KEY];
  }
  const registry = new WeakMap();
  Object.defineProperty(processGlobal, LEASE_REGISTRY_KEY, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

// Operator and selected-app copies can have distinct file URLs in one host
// process. A process-global WeakMap preserves exact-object admission across
// those module projections without creating a serialized token surface.
const LEASE_RECORDS = processLeaseRegistry();

export class RuntimeOwnershipError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RuntimeOwnershipError";
    this.code = code;
  }
}

function errorCode(error) {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new RuntimeOwnershipError(
      "OWNER_PLATFORM_UNSUPPORTED",
      "Runtime ownership requires a Unix user identity.",
    );
  }
  return BigInt(process.getuid());
}

function permissionMode(mode) {
  return mode & BigInt(0o777);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode &&
    left.type === right.type;
}

async function readIdentity(path, expectedType, expectedMode) {
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    throw new RuntimeOwnershipError(
      "OWNER_PATH_UNSAFE",
      "A runtime ownership path could not be inspected safely.",
      { cause: error },
    );
  }
  const validType = expectedType === "directory"
    ? stats.isDirectory()
    : stats.isSocket();
  if (stats.isSymbolicLink() || !validType) {
    throw new RuntimeOwnershipError(
      "OWNER_PATH_UNSAFE",
      "A runtime ownership path has an unsafe type.",
    );
  }
  if (stats.uid !== currentUid()) {
    throw new RuntimeOwnershipError(
      "OWNER_PATH_UNSAFE",
      "A runtime ownership path is not owned by the current user.",
    );
  }
  const mode = permissionMode(stats.mode);
  if (mode !== BigInt(expectedMode)) {
    throw new RuntimeOwnershipError(
      "OWNER_PATH_UNSAFE",
      `A runtime ownership path must have mode ${expectedMode.toString(8)}.`,
    );
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    mode,
    type: expectedType,
  };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const identity = await readIdentity(
    path,
    "directory",
    PRIVATE_DIRECTORY_MODE,
  );
  return { identity, canonicalPath: await realpath(path) };
}

function probeSocket(socketPath, timeoutMs) {
  return new Promise((resolveProbe, rejectProbe) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(result);
    };
    socket.once("connect", () => finish("active"));
    socket.once("error", (error) => {
      if (errorCode(error) === "ECONNREFUSED") {
        finish("refused");
        return;
      }
      finish(undefined, error);
    });
    socket.setTimeout(timeoutMs, () => {
      finish(
        undefined,
        new RuntimeOwnershipError(
          "OWNER_LIVE_OR_INDETERMINATE",
          "The existing runtime owner socket probe timed out.",
        ),
      );
    });
  });
}

function listen(server, socketPath) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function removeStableStaleSocket(socketPath, directoryBefore, timeoutMs) {
  const socketBefore = await readIdentity(
    socketPath,
    "socket",
    PRIVATE_SOCKET_MODE,
  );
  let probe;
  try {
    probe = await probeSocket(socketPath, timeoutMs);
  } catch (error) {
    if (error instanceof RuntimeOwnershipError) throw error;
    throw new RuntimeOwnershipError(
      "OWNER_LIVE_OR_INDETERMINATE",
      "The existing runtime owner socket is live or indeterminate.",
      { cause: error },
    );
  }
  if (probe !== "refused") {
    throw new RuntimeOwnershipError(
      "OWNER_LIVE_OR_INDETERMINATE",
      "Another authority process owns the runtime writer lease.",
    );
  }

  const [directoryAfter, socketAfter] = await Promise.all([
    readIdentity(dirname(socketPath), "directory", PRIVATE_DIRECTORY_MODE),
    readIdentity(socketPath, "socket", PRIVATE_SOCKET_MODE),
  ]);
  if (
    !sameIdentity(directoryBefore, directoryAfter) ||
    !sameIdentity(socketBefore, socketAfter)
  ) {
    throw new RuntimeOwnershipError(
      "OWNER_LIVE_OR_INDETERMINATE",
      "The stale runtime owner socket identity changed during admission.",
    );
  }
  await unlink(socketPath);
}

async function assertRecordHeld(record, expectedSocketPath) {
  if (record.closed || !record.server.listening) {
    throw new RuntimeOwnershipError(
      "OWNER_LEASE_INVALID",
      "The inherited runtime writer lease is no longer held.",
    );
  }
  if (expectedSocketPath !== undefined) {
    const expectedCanonicalPath = resolve(
      await realpath(dirname(expectedSocketPath)),
      basename(expectedSocketPath),
    );
    if (expectedCanonicalPath !== record.socketPath) {
      throw new RuntimeOwnershipError(
        "OWNER_LEASE_INVALID",
        "The inherited runtime writer lease belongs to a different socket.",
      );
    }
  }
  const [directoryNow, socketNow] = await Promise.all([
    readIdentity(dirname(record.socketPath), "directory", PRIVATE_DIRECTORY_MODE),
    readIdentity(record.socketPath, "socket", PRIVATE_SOCKET_MODE),
  ]);
  if (
    !sameIdentity(record.directoryIdentity, directoryNow) ||
    !sameIdentity(record.socketIdentity, socketNow)
  ) {
    throw new RuntimeOwnershipError(
      "OWNER_LEASE_INVALID",
      "The inherited runtime writer lease identity is no longer stable.",
    );
  }
}

export function runtimeOwnershipSocketPathForDataDirectory(dataDirectory) {
  const directory = resolve(dataDirectory);
  return resolve(directory, ".runtime-owner", "runtime-owner.sock");
}

/**
 * Acquire the process-lifetime writer lease. Recovery is permitted only for a
 * same-UID socket whose inode remains stable across an ECONNREFUSED probe.
 */
export async function acquireRuntimeOwnershipLease({
  socketPath,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath
  ) {
    throw new TypeError("socketPath must be an absolute lexical canonical path.");
  }
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1) {
    throw new TypeError("probeTimeoutMs must be a positive safe integer.");
  }

  const requestedDirectoryPath = dirname(socketPath);
  const ensuredDirectory = await ensurePrivateDirectory(requestedDirectoryPath);
  const directoryPath = ensuredDirectory.canonicalPath;
  const canonicalSocketPath = resolve(directoryPath, basename(socketPath));
  const directoryIdentity = ensuredDirectory.identity;
  if (await pathExists(canonicalSocketPath)) {
    await removeStableStaleSocket(
      canonicalSocketPath,
      directoryIdentity,
      probeTimeoutMs,
    );
  }

  const server = createServer((socket) => socket.end());
  let socketIdentity = null;
  try {
    await listen(server, canonicalSocketPath);
    await chmod(canonicalSocketPath, PRIVATE_SOCKET_MODE);
    socketIdentity = await readIdentity(
      canonicalSocketPath,
      "socket",
      PRIVATE_SOCKET_MODE,
    );
    const directoryAfter = await readIdentity(
      directoryPath,
      "directory",
      PRIVATE_DIRECTORY_MODE,
    );
    if (!sameIdentity(directoryIdentity, directoryAfter)) {
      throw new RuntimeOwnershipError(
        "OWNER_LIVE_OR_INDETERMINATE",
        "The runtime ownership directory identity changed during bind.",
      );
    }
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if (errorCode(error) === "EADDRINUSE") {
      throw new RuntimeOwnershipError(
        "OWNER_LIVE_OR_INDETERMINATE",
        "Another authority process owns the runtime writer lease.",
        { cause: error },
      );
    }
    throw error;
  }

  const record = {
    socketPath: canonicalSocketPath,
    server,
    directoryIdentity,
    socketIdentity,
    closed: false,
    closePromise: null,
  };
  const lease = Object.freeze({
    socketPath: canonicalSocketPath,
    close() {
      if (record.closePromise !== null) return record.closePromise;
      record.closePromise = (async () => {
        let closeError;
        try {
          await closeServer(server);
        } catch (error) {
          closeError = error;
        }
        if (await pathExists(canonicalSocketPath).catch(() => false)) {
          const [directoryNow, socketNow] = await Promise.all([
            readIdentity(
              directoryPath,
              "directory",
              PRIVATE_DIRECTORY_MODE,
            ).catch(() => null),
            readIdentity(
              canonicalSocketPath,
              "socket",
              PRIVATE_SOCKET_MODE,
            ).catch(() => null),
          ]);
          if (
            directoryNow !== null &&
            socketNow !== null &&
            sameIdentity(directoryIdentity, directoryNow) &&
            sameIdentity(socketIdentity, socketNow)
          ) {
            await unlink(canonicalSocketPath).catch((error) => {
              closeError ??= error;
            });
          }
        }
        record.closed = true;
        if (closeError !== undefined) throw closeError;
      })();
      return record.closePromise;
    },
  });
  LEASE_RECORDS.set(lease, record);
  return lease;
}

/**
 * Validate an exact in-memory lease object. There is intentionally no token,
 * environment variable, serialized handle, or structural duck-typing path.
 */
export async function assertInheritedRuntimeOwnershipLease(
  lease,
  { socketPath } = {},
) {
  const record = LEASE_RECORDS.get(lease);
  if (record === undefined) {
    throw new RuntimeOwnershipError(
      "OWNER_LEASE_INVALID",
      "The inherited runtime writer lease was not minted in this process.",
    );
  }
  await assertRecordHeld(record, socketPath);
  return lease;
}
