import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PlannerReleaseInputError,
  assertInstalledReleaseStartable,
  readReleaseArtifact,
} from "./support/planner-release-contract.mjs";

export const PLANNER_SERVICE_LABEL = "com.ericfeunekes.meal-planner";
export const PLANNER_SERVICE_DEFAULT_PORT = 8642;
const SERVICE_COMMANDS = new Set([
  "install",
  "restart",
  "start",
  "status",
  "stop",
  "uninstall",
]);
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_INTERVAL_MS = 250;
const DEFAULT_UNLOAD_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MANAGED_PLIST_MARKER = "<!-- Managed by Weekly Recipe Planner. -->";

const DEFAULT_DEPENDENCIES = Object.freeze({
  assertInstalledReleaseStartable,
  fetch,
  getUid: () => process.getuid?.(),
  listenerBelongsToSupervisor,
  resolveBoundNode,
  runCommand,
  sleep: (milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }),
});

function requireNormalizedHome(home) {
  if (typeof home !== "string" || !isAbsolute(home) || resolve(home) !== home) {
    throw new PlannerReleaseInputError("HOME must be an absolute normalized path.");
  }
  return home;
}

function parsePort(value) {
  const port = value === undefined || value === ""
    ? PLANNER_SERVICE_DEFAULT_PORT
    : Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new PlannerReleaseInputError(
      "PLANNER_PORT must be an integer from 1024 through 65535.",
    );
  }
  return port;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function resolveBoundNode(startable, home) {
  const stage = await readReleaseArtifact(startable.layout.stagePath, {
    activationId: startable.current.activationId,
    artifactType: "stage",
  });
  const expected = stage?.projection?.preflight?.node;
  if (
    typeof expected?.executable !== "string" ||
    typeof expected?.sha256 !== "string" ||
    expected.version !== "v22.15.0" ||
    expected.exactFloorVerified !== true ||
    expected.recheckedAfterSuite !== true
  ) {
    throw new PlannerReleaseInputError(
      "The selected release does not bind the required Node 22.15 runtime.",
    );
  }
  const [canonical, metadata, observedSha256] = await Promise.all([
    realpath(expected.executable),
    stat(expected.executable),
    sha256File(expected.executable),
  ]);
  if (
    canonical !== expected.executable ||
    !metadata.isFile() ||
    (metadata.mode & 0o022) !== 0 ||
    observedSha256 !== expected.sha256
  ) {
    throw new PlannerReleaseInputError(
      "The selected release Node executable changed after activation.",
    );
  }
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new PlannerReleaseInputError("A numeric current-user ID is required.");
  }
  const snapshotRoot = join(
    home,
    "meal-planner",
    "releases",
    "service-runtime",
    expected.sha256,
  );
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(snapshotRoot);
  if (
    !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== uid
  ) {
    throw new PlannerReleaseInputError(
      "The planner service runtime snapshot root is not a current-user-owned real directory.",
    );
  }
  const snapshotPath = join(snapshotRoot, "node");
  const temporaryPath = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(expected.executable, temporaryPath, constants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o500);
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, snapshotPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const [snapshotCanonical, snapshotMetadata, snapshotSha256] = await Promise.all([
    realpath(snapshotPath),
    stat(snapshotPath),
    sha256File(snapshotPath),
  ]);
  if (
    snapshotCanonical !== snapshotPath ||
    !snapshotMetadata.isFile() ||
    snapshotMetadata.uid !== uid ||
    (snapshotMetadata.mode & 0o277) !== 0 ||
    snapshotSha256 !== expected.sha256
  ) {
    throw new PlannerReleaseInputError(
      "The planner service Node runtime snapshot failed integrity validation.",
    );
  }
  return snapshotPath;
}

export function derivePlannerServiceLayout(home) {
  const canonicalHome = requireNormalizedHome(home);
  const runRoot = join(canonicalHome, "meal-planner", "run");
  return Object.freeze({
    home: canonicalHome,
    launchAgentsRoot: join(canonicalHome, "Library", "LaunchAgents"),
    plistPath: join(
      canonicalHome,
      "Library",
      "LaunchAgents",
      `${PLANNER_SERVICE_LABEL}.plist`,
    ),
    logRoot: join(runRoot, "logs"),
    stdoutPath: join(runRoot, "logs", "service.log"),
  });
}

export function createPlannerLaunchAgentPlist({
  home,
  nodeExecutable,
  operatorPath,
  port,
  allowedOrigins,
  stdoutPath,
}) {
  const entrypoint = join(operatorPath, "scripts", "start-installed.mjs");
  const path = `${dirname(nodeExecutable)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const variables = [
    ["HOME", home],
    ["PATH", path],
    ["PLANNER_HOST", "127.0.0.1"],
    ["PLANNER_PORT", String(port)],
    ["PLANNER_ALLOWED_ORIGINS", allowedOrigins],
  ];
  const environmentXml = variables.map(([key, value]) => [
    `    <key>${xml(key)}</key>`,
    `    <string>${xml(value)}</string>`,
  ].join("\n")).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    MANAGED_PLIST_MARKER,
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(PLANNER_SERVICE_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(nodeExecutable)}</string>`,
    "    <string>--disable-warning=ExperimentalWarning</string>",
    `    <string>${xml(entrypoint)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(operatorPath)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environmentXml,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(stdoutPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function writeManagedPlist(path, contents, uid) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid) {
      throw new PlannerReleaseInputError(
        "The existing planner service plist is not a current-user-owned regular file.",
      );
    }
    if (!(await readFile(path, "utf8")).includes(MANAGED_PLIST_MARKER)) {
      throw new PlannerReleaseInputError(
        "The existing planner service plist is not managed by this application.",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

async function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        rejectCommand(new Error(`${command} output exceeded the service-manager limit.`));
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      resolveCommand(Object.freeze({
        code: typeof code === "number" ? code : 1,
        stderr,
        stdout,
      }));
    });
  });
}

async function requireCommandSuccess(ports, command, args, label) {
  const result = await ports.runCommand(command, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

async function listenerBelongsToSupervisor(supervisorPid, port) {
  const listeners = await runCommand("/usr/sbin/lsof", [
    "-nP",
    "-t",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
  ]);
  if (listeners.code !== 0) return false;
  const listenerPids = [...new Set(listeners.stdout
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number))];
  if (
    listenerPids.length === 0 ||
    listenerPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  ) return false;

  for (const listenerPid of listenerPids) {
    let pid = listenerPid;
    let matched = false;
    for (let depth = 0; depth < 32 && pid > 1; depth += 1) {
      if (pid === supervisorPid) {
        matched = true;
        break;
      }
      const parent = await runCommand("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
      if (parent.code !== 0) break;
      pid = Number(parent.stdout.trim());
      if (!Number.isSafeInteger(pid)) break;
    }
    if (!matched) return false;
  }
  return true;
}

async function inspectLoaded(ports, domainTarget) {
  const result = await ports.runCommand("launchctl", ["print", domainTarget]);
  if (result.code === 0) return Object.freeze({ loaded: true, result });
  if (/could not find service|not found|service not found/iu.test(
    `${result.stderr}\n${result.stdout}`,
  )) {
    return Object.freeze({ loaded: false, result });
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  throw new Error(`Planner service inspection failed: ${detail}`);
}

function loadedPid(state) {
  const match = /^\s*pid\s*=\s*(\d+)\s*$/mu.exec(state.result.stdout);
  const pid = match === null ? null : Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Planner service launchd state did not expose a valid process ID.");
  }
  return pid;
}

async function assertManagedPlist(path, uid) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid) {
    throw new PlannerReleaseInputError(
      "The planner service plist is not a current-user-owned regular file.",
    );
  }
  if (!(await readFile(path, "utf8")).includes(MANAGED_PLIST_MARKER)) {
    throw new PlannerReleaseInputError(
      "The planner service plist is not managed by this application.",
    );
  }
}

async function bootoutIfLoaded(ports, domainTarget) {
  const state = await inspectLoaded(ports, domainTarget);
  if (!state.loaded) return false;
  await requireCommandSuccess(
    ports,
    "launchctl",
    ["bootout", domainTarget],
    "Planner service stop",
  );
  const deadline = Date.now() + DEFAULT_UNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const settled = await inspectLoaded(ports, domainTarget);
    if (!settled.loaded) return true;
    await ports.sleep(100);
  }
  throw new Error("Planner service did not finish unloading from launchd.");
}

function isReadyHealth(value) {
  return value?.web?.status === "ready" &&
    value?.application?.status === "ready" &&
    value?.store?.status === "ready" &&
    value?.store?.quickCheck === "ok";
}

async function waitForHealth(ports, port, domainTarget, options = {}) {
  const timeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  do {
    try {
      const launchdState = await inspectLoaded(ports, domainTarget);
      if (!launchdState.loaded) {
        lastFailure = "the launchd job is not loaded";
        if (Date.now() < deadline) await ports.sleep(intervalMs);
        continue;
      }
      const supervisorPid = loadedPid(launchdState);
      const response = await ports.fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, timeoutMs))),
      });
      const health = await response.json();
      if (
        response.status === 200 && isReadyHealth(health) &&
        await ports.listenerBelongsToSupervisor(supervisorPid, port)
      ) {
        const workspace = await ports.fetch(`http://127.0.0.1:${port}/api/workspace`, {
          signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, timeoutMs))),
        });
        if (workspace.status !== 200) {
          lastFailure = `workspace returned HTTP ${workspace.status}`;
        } else {
          await workspace.json();
          return health;
        }
      } else {
        lastFailure = `HTTP ${response.status} without a listener owned by the selected launchd job`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() < deadline) await ports.sleep(intervalMs);
  } while (Date.now() < deadline);
  throw new Error(`Planner service did not become ready: ${lastFailure}`);
}

function serviceContext(environment, ports) {
  const home = requireNormalizedHome(environment.HOME ?? homedir());
  const uid = ports.getUid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new PlannerReleaseInputError("A numeric current-user ID is required.");
  }
  const port = parsePort(environment.PLANNER_PORT);
  const allowedOrigins = environment.PLANNER_ALLOWED_ORIGINS ?? [
    `http://127.0.0.1:${port}`,
    `https://robie-imac.tailae8a7b.ts.net:${port}`,
  ].join(",");
  if (
    allowedOrigins.length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(allowedOrigins)
  ) {
    throw new PlannerReleaseInputError("PLANNER_ALLOWED_ORIGINS must be non-empty.");
  }
  const layout = derivePlannerServiceLayout(home);
  const domain = `gui/${uid}`;
  return Object.freeze({
    allowedOrigins,
    domain,
    domainTarget: `${domain}/${PLANNER_SERVICE_LABEL}`,
    home,
    layout,
    port,
    uid,
  });
}

async function install(context, ports, options) {
  const startable = await ports.assertInstalledReleaseStartable(context.home);
  const nodeExecutable = await ports.resolveBoundNode(startable, context.home);
  await Promise.all([
    mkdir(context.layout.launchAgentsRoot, { recursive: true }),
    mkdir(context.layout.logRoot, { recursive: true, mode: 0o700 }),
  ]);
  const [launchAgentsMetadata, logMetadata] = await Promise.all([
    lstat(context.layout.launchAgentsRoot),
    lstat(context.layout.logRoot),
  ]);
  if (
    !launchAgentsMetadata.isDirectory() || launchAgentsMetadata.isSymbolicLink() ||
    launchAgentsMetadata.uid !== context.uid ||
    !logMetadata.isDirectory() || logMetadata.isSymbolicLink() ||
    logMetadata.uid !== context.uid
  ) {
    throw new PlannerReleaseInputError(
      "Planner service directories must be current-user-owned real directories.",
    );
  }
  const plist = createPlannerLaunchAgentPlist({
    allowedOrigins: context.allowedOrigins,
    home: context.home,
    nodeExecutable,
    operatorPath: startable.operatorPath,
    port: context.port,
    stdoutPath: context.layout.stdoutPath,
  });
  await writeManagedPlist(context.layout.plistPath, plist, context.uid);
  await bootoutIfLoaded(ports, context.domainTarget);
  await requireCommandSuccess(
    ports,
    "launchctl",
    ["enable", context.domainTarget],
    "Planner service enable",
  );
  await requireCommandSuccess(
    ports,
    "launchctl",
    ["bootstrap", context.domain, context.layout.plistPath],
    "Planner service install",
  );
  const health = await waitForHealth(
    ports,
    context.port,
    context.domainTarget,
    options,
  );
  return Object.freeze({
    activationId: startable.current.activationId,
    health,
    operatorSha256: startable.current.operatorSha256,
    plistPath: context.layout.plistPath,
    status: "running",
  });
}

async function start(context, ports, options) {
  await assertManagedPlist(context.layout.plistPath, context.uid);
  await ports.assertInstalledReleaseStartable(context.home);
  await requireCommandSuccess(
    ports,
    "launchctl",
    ["enable", context.domainTarget],
    "Planner service enable",
  );
  const state = await inspectLoaded(ports, context.domainTarget);
  if (state.loaded) {
    await requireCommandSuccess(
      ports,
      "launchctl",
      ["kickstart", "-k", context.domainTarget],
      "Planner service start",
    );
  } else {
    await requireCommandSuccess(
      ports,
      "launchctl",
      ["bootstrap", context.domain, context.layout.plistPath],
      "Planner service start",
    );
  }
  const health = await waitForHealth(
    ports,
    context.port,
    context.domainTarget,
    options,
  );
  return Object.freeze({ health, plistPath: context.layout.plistPath, status: "running" });
}

async function status(context, ports) {
  const state = await inspectLoaded(ports, context.domainTarget);
  if (!state.loaded) {
    return Object.freeze({
      healthy: false,
      loaded: false,
      plistPath: context.layout.plistPath,
      status: "stopped",
    });
  }
  try {
    await ports.assertInstalledReleaseStartable(context.home);
    const health = await waitForHealth(ports, context.port, context.domainTarget, {
      healthIntervalMs: 100,
      healthTimeoutMs: 1_000,
    });
    return Object.freeze({
      health,
      healthy: true,
      loaded: true,
      plistPath: context.layout.plistPath,
      status: "running",
    });
  } catch (error) {
    return Object.freeze({
      detail: error instanceof Error ? error.message : String(error),
      healthy: false,
      loaded: true,
      plistPath: context.layout.plistPath,
      status: "unhealthy",
    });
  }
}

async function uninstall(context, ports) {
  await bootoutIfLoaded(ports, context.domainTarget);
  try {
    await assertManagedPlist(context.layout.plistPath, context.uid);
    await unlink(context.layout.plistPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ plistPath: context.layout.plistPath, status: "uninstalled" });
}

export async function runPlannerServiceCommand(
  command,
  environment = process.env,
  dependencies = {},
  options = {},
) {
  if (!SERVICE_COMMANDS.has(command)) {
    throw new PlannerReleaseInputError(
      "Service command must be install, restart, start, status, stop, or uninstall.",
    );
  }
  const ports = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const context = serviceContext(environment, ports);
  if (command === "install" || command === "restart") {
    return install(context, ports, options);
  }
  if (command === "start") return start(context, ports, options);
  if (command === "status") return status(context, ports);
  if (command === "stop") {
    const stopped = await bootoutIfLoaded(ports, context.domainTarget);
    return Object.freeze({
      plistPath: context.layout.plistPath,
      status: stopped ? "stopped" : "already-stopped",
    });
  }
  return uninstall(context, ports);
}

const isEntrypoint = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    if (process.argv.length !== 3) {
      throw new PlannerReleaseInputError("Usage: planner-service.mjs <command>.");
    }
    const result = await runPlannerServiceCommand(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (process.argv[2] === "status" && result.healthy !== true) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
