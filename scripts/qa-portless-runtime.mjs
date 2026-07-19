import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentCodexHome } from "./support/codex-dev-home.mjs";

import { acquirePlannerStoreWriteReservation } from "../server/store/sqlite-store.ts";

const READY_TIMEOUT_MS = 30_000;

function requireAssignedPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Portless must assign PORT as an integer from 1 to 65535.");
  }
  return port;
}

function requirePortlessOrigin(value) {
  const origin = new URL(value ?? "");
  if (
    origin.protocol !== "http:" ||
    !origin.hostname.endsWith(".localhost") ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new TypeError("QA_ORIGIN must be an exact Portless .localhost HTTP origin.");
  }
  return origin.origin;
}

async function snapshotData(source, destination) {
  try {
    const sourceMetadata = await stat(source);
    if (!sourceMetadata.isFile()) {
      throw new TypeError("QA_DATA_SOURCE must identify a SQLite database file.");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const reservation = acquirePlannerStoreWriteReservation({ filename: source });
  try {
    reservation.createVerifiedSnapshot(destination);
  } finally {
    reservation.close();
  }
  return true;
}

async function snapshotRuntime(sourceRoot, destinationRoot) {
  // A Vinext server indexes static assets at startup. Keeping the QA server in
  // the checkout lets a subsequent build replace those assets underneath its
  // in-memory manifest, which leaves the browser with stale script URLs. Copy
  // the built application into the private QA root, but share installed
  // dependencies read-only through a symlink so the snapshot stays lightweight.
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    filter(source) {
      const name = source.split("/").at(-1);
      return ![".git", ".next", ".planner-data", "coverage", "node_modules", "outputs"].includes(name);
    },
  });
  await symlink(
    join(sourceRoot, "node_modules"),
    join(destinationRoot, "node_modules"),
    "dir",
  );
}

async function waitForHealth(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
      await response.body.cancel();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`QA deployment did not become ready (${lastError}).`);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    throw new Error("Could not reserve a private QA web port.");
  }
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function main() {
  const assignedPort = requireAssignedPort(process.env.PORT);
  const publicOrigin = requirePortlessOrigin(process.env.QA_ORIGIN);
  const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const source = resolve(sourceRoot, process.env.QA_DATA_SOURCE ?? ".planner-data/planner.sqlite");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "weekly-recipe-planner-qa-")),
  );
  const runtimeDirectory = join(root, "app");
  const dataDirectory = join(root, "data");
  const databasePath = join(dataDirectory, "planner.sqlite");
  let privateWebPort = await reserveLoopbackPort();
  while (privateWebPort === assignedPort) privateWebPort = await reserveLoopbackPort();
  await mkdir(dataDirectory, { mode: 0o700 });

  let child;
  let childExit;
  const relaySignal = (signal) => {
    if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once("SIGINT", () => relaySignal("SIGINT"));
  process.once("SIGTERM", () => relaySignal("SIGTERM"));

  try {
    await snapshotRuntime(sourceRoot, runtimeDirectory);
    // QA owns an isolated planner snapshot, but its Codex rail must connect to
    // the same shared development home and fixed application cwd as `make dev`.
    // Pointing it at the ephemeral runtime copy creates a second Codex context
    // and invalidates the shared native session between QA deployments.
    const development = await prepareDevelopmentCodexHome();
    const hasSnapshot = await snapshotData(source, databasePath);
    if (!hasSnapshot) {
      console.warn(`QA_DATA_SOURCE was not found; starting an empty QA workspace: ${source}`);
    }

    child = spawn(process.execPath, ["scripts/start.mjs"], {
      cwd: runtimeDirectory,
      env: {
        ...process.env,
        PLANNER_PORT: String(assignedPort),
        PLANNER_PRIVATE_WEB_PORT: String(privateWebPort),
        PLANNER_DATA_DIR: dataDirectory,
        PLANNER_RUNTIME_OWNER_SOCKET: join(root, "runtime-owner.sock"),
        PLANNER_ALLOWED_ORIGINS: publicOrigin,
        PLANNER_CODEX_HOME: development.codexHome,
        PLANNER_CODEX_CWD: development.appRoot,
        // QA has an isolated planner database, but it must exercise the same
        // embedded Codex mutation path as the app it verifies. The global
        // ingress stays disabled because its shared socket is not part of this
        // snapshot runtime.
        PLANNER_DISABLE_GLOBAL_CODEX: "1",
      },
      stdio: "inherit",
    });
    childExit = waitForExit(child);
    await waitForHealth(assignedPort);
    console.log(`QA deployment ready at ${publicOrigin} (snapshot: ${hasSnapshot ? "yes" : "empty"}).`);
    const result = await childExit;
    if (result.signal !== null || result.code !== 0) {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await childExit?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
