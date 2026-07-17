import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const READY_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 150;

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function requireQaName(value) {
  if (typeof value !== "string" || !/^[a-z0-9-]+$/u.test(value)) {
    throw new TypeError("QA_NAME must contain only lowercase letters, digits, and hyphens.");
  }
  return value;
}

function requirePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("QA_PORTLESS_PORT must be an integer from 1 through 65535.");
  }
  return port;
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${name} must be an absolute normalized path.`);
  }
  return value;
}

function configuredPaths(environment = process.env) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const name = requireQaName(environment.QA_NAME ?? "weekly-recipe-planner-qa");
  const port = requirePort(environment.QA_PORTLESS_PORT ?? "1355");
  const dataSource = requireAbsolutePath(
    environment.QA_DATA_SOURCE ?? join(root, ".planner-data", "planner.sqlite"),
    "QA_DATA_SOURCE",
  );
  const stateDirectory = requireAbsolutePath(
    environment.QA_STATE_DIR ?? join(root, ".planner-qa"),
    "QA_STATE_DIR",
  );
  return Object.freeze({
    dataSource,
    logPath: join(stateDirectory, "qa.log"),
    name,
    port,
    root,
    stateDirectory,
    statePath: join(stateDirectory, "deployment.json"),
    url: `http://${name}.localhost:${port}`,
  });
}

async function ensureStateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !Number.isSafeInteger(uid) ||
    metadata.uid !== uid
  ) {
    throw new Error("QA_STATE_DIR must be a current-user-owned real directory.");
  }
  await chmod(directory, 0o700);
}

function parseState(value) {
  const parsed = JSON.parse(value);
  if (
    typeof parsed !== "object" || parsed === null ||
    !Number.isSafeInteger(parsed.pid) || parsed.pid <= 1 ||
    typeof parsed.url !== "string" || typeof parsed.startedAt !== "string"
  ) {
    throw new Error("The QA deployment state file is malformed.");
  }
  return parsed;
}

async function readState(paths) {
  try {
    const metadata = await lstat(paths.statePath);
    const uid = process.getuid?.();
    if (
      !metadata.isFile() || metadata.isSymbolicLink() ||
      !Number.isSafeInteger(uid) || metadata.uid !== uid ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("The QA deployment state file has unsafe ownership or permissions.");
    }
    return parseState(await readFile(paths.statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(paths, state) {
  const temporaryPath = join(
    paths.stateDirectory,
    `deployment-${process.pid}-${Date.now()}.json.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, paths.statePath);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function managedProcessIsCurrent(paths, pid) {
  const child = spawn("/bin/ps", ["-o", "command=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  let output = "";
  for await (const chunk of child.stdout) output += chunk;
  const result = await exited;
  if (result !== 0) return false;
  return output.includes(join(paths.root, "node_modules", ".bin", "portless"));
}

async function terminateProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stop(paths, { quiet = false } = {}) {
  await ensureStateDirectory(paths.stateDirectory);
  const state = await readState(paths);
  if (state === null) {
    if (!quiet) console.log("QA deployment is not running.");
    return false;
  }
  if (processIsAlive(state.pid)) {
    if (!(await managedProcessIsCurrent(paths, state.pid))) {
      throw new Error("The tracked QA PID no longer belongs to this deployment; refusing to stop it.");
    }
    await terminateProcessGroup(state.pid);
  }
  await Promise.all([
    unlink(paths.statePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    rm(paths.logPath, { force: true }),
  ]);
  if (!quiet) console.log(`Stopped QA deployment at ${state.url}.`);
  return true;
}

async function readHealth(url) {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (
      body?.application?.status !== "ready" ||
      body?.store?.status !== "ready"
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

async function waitForReady(paths, pid) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      throw new Error("The QA deployment exited before becoming ready.");
    }
    const health = await readHealth(paths.url);
    if (health !== null) return health;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${paths.url} to become ready.`);
}

async function start(paths, environment = process.env) {
  await ensureStateDirectory(paths.stateDirectory);
  await stop(paths, { quiet: true });
  const log = await open(paths.logPath, "w", 0o600);
  const portless = join(paths.root, "node_modules", ".bin", "portless");
  const npm = environment.QA_NPM_COMMAND ?? "npm";
  let child;
  try {
    child = spawn(process.execPath, [
      portless,
      "run",
      "--name",
      paths.name,
      npm,
      "run",
      "qa:serve",
    ], {
      cwd: paths.root,
      detached: true,
      env: {
        ...environment,
        QA_DATA_SOURCE: paths.dataSource,
        QA_ORIGIN: paths.url,
        PORTLESS_HTTPS: "0",
        PORTLESS_PORT: String(paths.port),
      },
      stdio: ["ignore", log.fd, log.fd],
    });
  } finally {
    await log.close();
  }
  child.unref();
  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    url: paths.url,
  };
  await writeState(paths, state);
  try {
    const health = await waitForReady(paths, state.pid);
    console.log(
      `QA deployment ready at ${paths.url} (pid ${state.pid}; ${health.status}).`,
    );
  } catch (error) {
    await stop(paths, { quiet: true });
    throw error;
  }
}

async function status(paths) {
  await ensureStateDirectory(paths.stateDirectory);
  const state = await readState(paths);
  if (state === null || !processIsAlive(state.pid)) {
    if (state !== null) await unlink(paths.statePath);
    console.log("QA deployment is not running.");
    return false;
  }
  if (!(await managedProcessIsCurrent(paths, state.pid))) {
    throw new Error("The tracked QA PID no longer belongs to this deployment; refusing to inspect it.");
  }
  const health = await readHealth(state.url);
  console.log(
    health === null
      ? `QA deployment process ${state.pid} is running, but ${state.url} is not ready.`
      : `QA deployment ready at ${state.url} (pid ${state.pid}; ${health.status}).`,
  );
  return health !== null;
}

const command = process.argv[2];
const paths = configuredPaths();
if (command === "start") await start(paths);
else if (command === "stop") await stop(paths);
else if (command === "status") process.exitCode = (await status(paths)) ? 0 : 1;
else throw new Error("Usage: qa-deployment-manager.mjs <start|stop|status>");
