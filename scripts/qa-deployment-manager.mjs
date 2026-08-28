import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const READY_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 150;
const PUBLIC_BASE_PATH = "/recipe-planner/";

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

function requireTimeout(value, name = "QA_READY_TIMEOUT_MS") {
  if (value === undefined) return READY_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) throw new TypeError(`${name} must be a positive integer.`);
  return timeout;
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

export function parseState(value) {
  const parsed = JSON.parse(value);
  if (
    typeof parsed !== "object" || parsed === null ||
    !Number.isSafeInteger(parsed.pid) || parsed.pid <= 1 || typeof parsed.startedAt !== "string"
  ) {
    throw new Error("The QA deployment state file is malformed.");
  }
  if (parsed.url === undefined) return parsed;
  if (typeof parsed.url !== "string") throw new Error("The QA deployment state file is malformed.");
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

function handoffPath(paths) {
  return join(paths.stateDirectory, `effective-origin-${randomUUID()}.txt`);
}

function requireRequestedOrigin(value, name) {
  const origin = new URL(value);
  const hostname = origin.hostname;
  const requestedHostname = `${name}.localhost`;
  if (
    origin.protocol !== "http:" ||
    (hostname !== requestedHostname && !hostname.endsWith(`.${requestedHostname}`)) ||
    origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password
  ) {
    throw new TypeError("The Portless handoff origin does not match the requested HTTP .localhost QA name.");
  }
  return origin.origin;
}

export async function readOriginHandoff(paths, path) {
  if (resolve(path) !== path || relative(paths.stateDirectory, path).startsWith("..")) {
    throw new Error("The QA origin handoff path must stay inside QA_STATE_DIR.");
  }
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    !Number.isSafeInteger(uid) || metadata.uid !== uid || (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("The QA origin handoff file has unsafe ownership or permissions.");
  }
  const value = await readFile(path, "utf8");
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new Error("The QA origin handoff file is malformed.");
  }
  return requireRequestedOrigin(value.trim(), paths.name);
}

async function waitForOriginHandoff(paths, pid, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) throw new Error("The QA deployment exited before reporting its effective origin.");
    try {
      return await readOriginHandoff(paths, path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the QA deployment effective-origin handoff.");
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

async function readPs(argumentsList) {
  const child = spawn("/bin/ps", argumentsList, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  let output = "";
  for await (const chunk of child.stdout) output += chunk;
  const result = await exited;
  return result === 0 ? output : null;
}

async function managedProcessIsCurrent(paths, pid) {
  const output = await readPs(["-o", "command=", "-p", String(pid)]);
  if (output === null) return false;
  return output.includes(join(paths.root, "node_modules", ".bin", "portless"));
}

export function processGroupHasLiveMember(statuses) {
  return statuses.some((status) => !status.startsWith("Z"));
}

async function processGroupHasLiveMemberAfterEperm(pid, error) {
  try {
    const output = await readPs(["-axo", "pgid=,stat="]);
    if (output === null) throw error;
    const statuses = output
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter(([group]) => group === String(pid))
      .map(([, status]) => status);
    return processGroupHasLiveMember(statuses);
  } catch { throw error; }
}

export async function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") {
      return processGroupHasLiveMemberAfterEperm(pid, error);
    }
    throw error;
  }
}

async function terminateProcessGroup(pid, timeoutMs = STOP_TIMEOUT_MS) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    if (error?.code === "EPERM" && !(await processGroupHasLiveMemberAfterEperm(pid, error))) return;
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processGroupIsAlive(pid))) return;
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "EPERM" && !(await processGroupHasLiveMemberAfterEperm(pid, error))) return;
    if (error?.code !== "ESRCH") throw error;
  }
  const killDeadline = Date.now() + timeoutMs;
  while (Date.now() < killDeadline) {
    if (!(await processGroupIsAlive(pid))) return;
    await sleep(POLL_INTERVAL_MS);
  }
  if (await processGroupIsAlive(pid)) throw new Error("The QA deployment process group did not stop.");
}

export async function stop(paths, { quiet = false, timeoutMs, expectedPid, beforeCleanup } = {}) {
  await ensureStateDirectory(paths.stateDirectory);
  const state = await readState(paths);
  if (state === null) {
    if (!quiet) console.log("QA deployment is not running.");
    return false;
  }
  if (expectedPid !== undefined && state.pid !== expectedPid) return false;
  if (processIsAlive(state.pid)) {
    if (!(await managedProcessIsCurrent(paths, state.pid))) {
      throw new Error("The tracked QA PID no longer belongs to this deployment; refusing to stop it.");
    }
    await terminateProcessGroup(state.pid, timeoutMs);
  }
  await beforeCleanup?.();
  const current = await readState(paths);
  if (current === null || current.pid !== state.pid) return false;
  await Promise.all([
    unlink(paths.statePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    rm(paths.logPath, { force: true }),
  ]);
  if (!quiet) console.log(state.url ? `Stopped QA deployment at ${state.url}.` : "Stopped starting QA deployment.");
  return true;
}

async function readHealth(url) {
  try {
    const response = await fetch(`${url}${PUBLIC_BASE_PATH}api/health`, {
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

async function waitForReady(url, pid) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      throw new Error("The QA deployment exited before becoming ready.");
    }
    const health = await readHealth(url);
    if (health !== null) return health;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${url} to become ready.`);
}

export async function start(paths, environment = process.env) {
  await ensureStateDirectory(paths.stateDirectory);
  await stop(paths, { quiet: true });
  const log = await open(paths.logPath, "w", 0o600);
  const portless = join(paths.root, "node_modules", ".bin", "portless");
  const npm = environment.QA_NPM_COMMAND ?? "npm";
  const originHandoff = handoffPath(paths);
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
        QA_EFFECTIVE_ORIGIN_HANDOFF: originHandoff,
        QA_STATE_DIR: paths.stateDirectory,
        PLANNER_PUBLIC_BASE_PATH: PUBLIC_BASE_PATH,
        PORTLESS_HTTPS: "0",
        PORTLESS_PORT: String(paths.port),
      },
      stdio: ["ignore", log.fd, log.fd],
    });
  } finally {
    await log.close();
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    await unlink(originHandoff).catch(() => undefined);
    throw new Error("Could not start the QA deployment process.");
  }
  child.unref();
  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeState(paths, state);
  } catch (error) {
    await terminateProcessGroup(state.pid);
    await Promise.all([unlink(originHandoff).catch(() => undefined), rm(paths.logPath, { force: true })]);
    throw error;
  }
  try {
    const url = await waitForOriginHandoff(paths, state.pid, originHandoff, requireTimeout(environment.QA_READY_TIMEOUT_MS));
    await unlink(originHandoff);
    const readyState = { ...state, url };
    await writeState(paths, readyState);
    const health = await waitForReady(url, state.pid);
    console.log(
      `QA deployment ready at ${url} (pid ${state.pid}; ${health.status}).`,
    );
  } catch (error) {
    await stop(paths, { quiet: true, expectedPid: state.pid, timeoutMs: requireTimeout(environment.QA_STOP_TIMEOUT_MS, "QA_STOP_TIMEOUT_MS") });
    await unlink(originHandoff).catch(() => undefined);
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
  if (!state.url) {
    console.log(`QA deployment process ${state.pid} is starting.`);
    return false;
  }
  const health = await readHealth(state.url);
  console.log(
    health === null
      ? `QA deployment process ${state.pid} is running, but ${state.url} is not ready.`
      : `QA deployment ready at ${state.url} (pid ${state.pid}; ${health.status}).`,
  );
  return health !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const paths = configuredPaths();
  if (command === "start") await start(paths);
  else if (command === "stop") await stop(paths);
  else if (command === "status") process.exitCode = (await status(paths)) ? 0 : 1;
  else throw new Error("Usage: qa-deployment-manager.mjs <start|stop|status>");
}
