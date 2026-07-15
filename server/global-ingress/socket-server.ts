import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { createServer, request as requestHttp, type RequestListener, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { GLOBAL_CODEX_ROUTES, GLOBAL_CODEX_SOCKET_PATH } from "../../lib/global-codex-contract.ts";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  type: "directory" | "socket";
};

export type GlobalCodexSocketServer = {
  close(): Promise<void>;
};

type SocketLayout = {
  parentDirectory: string;
  runDirectory: string;
  socketPath: string;
};

function asCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") throw new Error("Unix user identity is unavailable.");
  return BigInt(process.getuid());
}

function permissionMode(mode: bigint): bigint {
  return mode & BigInt(0o777);
}

async function identity(
  path: string,
  expectedType: FileIdentity["type"],
  expectedMode: bigint,
): Promise<FileIdentity> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error("A global ingress path is a symbolic link.");
  const validType = expectedType === "directory" ? stat.isDirectory() : stat.isSocket();
  if (!validType) throw new Error("A global ingress path has an unsafe type.");
  if (stat.uid !== currentUid()) throw new Error("A global ingress path has an unsafe owner.");
  if (permissionMode(stat.mode) !== expectedMode) throw new Error("A global ingress path has unsafe permissions.");
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: permissionMode(stat.mode),
    type: expectedType,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.mode === right.mode && left.type === right.type;
}

async function validateCanonicalDirectory(path: string): Promise<FileIdentity> {
  const checked = await identity(path, "directory", BigInt(0o700));
  if (await realpath(path) !== resolve(path)) throw new Error("A global ingress directory is not canonical.");
  return checked;
}

async function ensureRunDirectory(layout: SocketLayout): Promise<FileIdentity> {
  try {
    await mkdir(layout.runDirectory, { mode: 0o700 });
  } catch (error) {
    if (asCode(error) !== "EEXIST") throw error;
  }
  return validateCanonicalDirectory(layout.runDirectory);
}

function probeSocket(socketPath: string): Promise<"active" | "refused"> {
  return new Promise((resolveProbe, rejectProbe) => {
    let settled = false;
    const settle = (value: "active" | "refused") => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    const request = requestHttp({
      socketPath,
      method: "GET",
      path: GLOBAL_CODEX_ROUTES.health,
      headers: { Host: "localhost", Connection: "close" },
    });
    request.once("socket", (socket) => {
      socket.once("connect", () => {
        settle("active");
        request.destroy();
      });
    });
    request.once("response", (response) => {
      response.resume();
      settle("active");
    });
    request.once("error", (error) => {
      if (settled) return;
      if (asCode(error) === "ECONNREFUSED") {
        settle("refused");
        return;
      }
      settled = true;
      rejectProbe(error);
    });
    request.setTimeout(1_000, () => {
      if (settled) return;
      settled = true;
      request.destroy();
      rejectProbe(new Error("Existing socket probe timed out."));
    });
    request.end();
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (asCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function removeStaleSocket(
  layout: SocketLayout,
  parentBefore: FileIdentity,
  runBefore: FileIdentity,
): Promise<void> {
  const socketBefore = await identity(layout.socketPath, "socket", BigInt(0o600));
  if (await probeSocket(layout.socketPath) !== "refused") {
    throw new Error("Another global ingress server already owns the socket.");
  }
  const [parentAfter, runAfter, socketAfter] = await Promise.all([
    validateCanonicalDirectory(layout.parentDirectory),
    validateCanonicalDirectory(layout.runDirectory),
    identity(layout.socketPath, "socket", BigInt(0o600)),
  ]);
  if (!sameIdentity(parentBefore, parentAfter) || !sameIdentity(runBefore, runAfter) ||
      !sameIdentity(socketBefore, socketAfter)) {
    throw new Error("The stale socket identity changed during admission.");
  }
  await unlink(layout.socketPath);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function rejectMalformedHttp(socket: Duplex): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({
    contractVersion: 1,
    error: {
      code: "invalid_request",
      message: "The HTTP request framing is invalid.",
    },
  });
  socket.end(
    `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
  );
}

async function startAtLayout(
  handler: RequestListener,
  layout: SocketLayout,
): Promise<GlobalCodexSocketServer> {
  if (resolve(layout.runDirectory) !== dirname(resolve(layout.socketPath)) ||
      resolve(layout.parentDirectory) !== dirname(resolve(layout.runDirectory))) {
    throw new Error("The global ingress socket layout is invalid.");
  }
  const parentIdentity = await validateCanonicalDirectory(layout.parentDirectory);
  const runIdentity = await ensureRunDirectory(layout);
  if (await pathExists(layout.socketPath)) {
    await removeStaleSocket(layout, parentIdentity, runIdentity);
  }

  const server = createServer(handler);
  server.on("checkContinue", handler);
  server.on("checkExpectation", handler);
  server.on("upgrade", (_request, socket) => rejectMalformedHttp(socket));
  server.on("connect", (_request, socket) => rejectMalformedHttp(socket));
  server.on("clientError", (_error, socket) => rejectMalformedHttp(socket));
  let socketIdentity: FileIdentity | null = null;
  try {
    await listen(server, layout.socketPath);
    await chmod(layout.socketPath, 0o600);
    socketIdentity = await identity(layout.socketPath, "socket", BigInt(0o600));
    const [parentAfter, runAfter] = await Promise.all([
      validateCanonicalDirectory(layout.parentDirectory),
      validateCanonicalDirectory(layout.runDirectory),
    ]);
    if (!sameIdentity(parentIdentity, parentAfter) || !sameIdentity(runIdentity, runAfter)) {
      throw new Error("The global ingress directory identity changed during bind.");
    }
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if (socketIdentity !== null && await pathExists(layout.socketPath).catch(() => false)) {
      const current = await identity(layout.socketPath, "socket", BigInt(0o600)).catch(() => null);
      if (current !== null && sameIdentity(socketIdentity, current)) {
        await unlink(layout.socketPath).catch(() => undefined);
      }
    }
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return {
    close() {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        let closeError: unknown;
        try {
          await closeServer(server);
        } catch (error) {
          closeError = error;
        }
        if (await pathExists(layout.socketPath).catch(() => false)) {
          const [parentNow, runNow, socketNow] = await Promise.all([
            validateCanonicalDirectory(layout.parentDirectory).catch(() => null),
            validateCanonicalDirectory(layout.runDirectory).catch(() => null),
            identity(layout.socketPath, "socket", BigInt(0o600)).catch(() => null),
          ]);
          if (parentNow !== null && runNow !== null && socketNow !== null &&
              sameIdentity(parentIdentity, parentNow) && sameIdentity(runIdentity, runNow) &&
              socketIdentity !== null && sameIdentity(socketIdentity, socketNow)) {
            await unlink(layout.socketPath).catch((error) => { closeError ??= error; });
          }
        }
        if (closeError !== undefined) throw closeError;
      })();
      return closePromise;
    },
  };
}

export function startGlobalCodexSocketServer(
  handler: RequestListener,
): Promise<GlobalCodexSocketServer> {
  const runDirectory = dirname(GLOBAL_CODEX_SOCKET_PATH);
  return startAtLayout(handler, {
    parentDirectory: dirname(runDirectory),
    runDirectory,
    socketPath: GLOBAL_CODEX_SOCKET_PATH,
  });
}

/** Internal test seam. Production composition must use startGlobalCodexSocketServer. */
export function startGlobalCodexSocketServerForTests(
  handler: RequestListener,
  parentDirectory: string,
): Promise<GlobalCodexSocketServer> {
  const runDirectory = resolve(parentDirectory, "run");
  return startAtLayout(handler, {
    parentDirectory: resolve(parentDirectory),
    runDirectory,
    socketPath: resolve(runDirectory, "global-codex.sock"),
  });
}
