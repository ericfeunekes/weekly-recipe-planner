/**
 * Disposable launchctl substitute for the release-lifecycle RC only.  It is
 * selected by the probe's private PATH; production code never imports it.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const statePath = process.env.PLANNER_PROBE_LAUNCHCTL_STATE;
if (!statePath) throw new Error("PLANNER_PROBE_LAUNCHCTL_STATE is required.");

async function state() {
  try { return JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function save(value) { await writeFile(statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
async function record(command, details = {}) {
  const path = process.env.PLANNER_PROBE_LAUNCHCTL_LOG;
  if (path) await appendFile(path, `${JSON.stringify({ command, pid: process.pid, ...details })}\n`, { mode: 0o600 });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function plistValues(source) {
  const values = [...source.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/gu)];
  const read = (key) => values.find(([, name]) => name === key)?.[2];
  const workingDirectory = read("WorkingDirectory");
  const logPath = read("StandardOutPath");
  const node = source.match(/<key>ProgramArguments<\/key><array><string>([^<]+)<\/string><string>([^<]+)<\/string>/u);
  if (!workingDirectory || !logPath || !node) throw new Error("Probe launchctl received an unsupported plist.");
  const environment = Object.fromEntries(
    [...([...(source.match(/<key>EnvironmentVariables<\/key><dict>([\s\S]*?)<\/dict>/u)?.[1] ?? "").matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/gu)])]
      .map(([, key, value]) => [key, value]),
  );
  return { workingDirectory, logPath, node: node[1], script: node[2], environment };
}

const [command, ...args] = process.argv.slice(2);
const current = await state();
await record(command, { args });
if (command === "print") {
  if (current.forceLoaded) process.exit(0);
  if (current.pid && alive(current.pid)) process.exit(0);
  if (current.pid) await rm(statePath, { force: true });
  process.exit(1);
}
if (command === "bootout") {
  const failureId = process.env.PLANNER_PROBE_FAIL_NEXT_BOOTOUT;
  if (failureId) {
    const marker = `${statePath}.bootout-failure-${failureId}`;
    try {
      await writeFile(marker, "consumed\n", { flag: "wx", mode: 0o600 });
      if (current.pid && alive(current.pid)) {
        try { process.kill(-current.pid, "SIGTERM"); } catch { process.kill(current.pid, "SIGTERM"); }
      }
      await save({ ...current, forceLoaded: true });
      await record(command, { injectedFailure: true, failureId, partialEffect: "terminated-process-retained-loaded-state" });
      process.exit(75);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (current.pid && alive(current.pid)) {
    try { process.kill(-current.pid, "SIGTERM"); } catch { process.kill(current.pid, "SIGTERM"); }
  }
  await rm(statePath, { force: true });
  process.exit(0);
}
if (command === "bootstrap") {
  const failureId = process.env.PLANNER_PROBE_FAIL_NEXT_BOOTSTRAP;
  if (failureId) {
    const marker = `${statePath}.bootstrap-failure-${failureId}`;
    try {
      await writeFile(marker, "consumed\n", { flag: "wx", mode: 0o600 });
      await record(command, { injectedFailure: true, failureId });
      process.exit(75);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const plistPath = args.at(-1);
  const plist = plistValues(await readFile(plistPath, "utf8"));
  const readinessFailureId = process.env.PLANNER_PROBE_FAIL_NEXT_READINESS;
  if (readinessFailureId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(readinessFailureId)) {
      throw new Error("PLANNER_PROBE_FAIL_NEXT_READINESS is invalid.");
    }
    const marker = `${statePath}.readiness-failure-${readinessFailureId}`;
    const authPath = join(plist.environment.PLANNER_CODEX_HOME, "auth.json");
    const heldAuthPath = `${authPath}.probe-unready`;
    try {
      await writeFile(marker, "consumed\n", { flag: "wx", mode: 0o600 });
      await rename(authPath, heldAuthPath);
      await record(command, { injectedUnreadyService: true, readinessFailureId });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        await rename(heldAuthPath, authPath);
        await record(command, { restoredAuthentication: true, readinessFailureId });
      } catch (restoreError) {
        if (restoreError?.code !== "ENOENT") throw restoreError;
      }
    }
  }
  const log = openSync(plist.logPath, "a", 0o600);
  const child = spawn(plist.node, [plist.script], {
    cwd: plist.workingDirectory,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ...plist.environment },
  });
  closeSync(log);
  child.unref();
  await save({ ...current, pid: child.pid, target: args[0] });
  process.exit(0);
}
throw new Error(`Unsupported disposable launchctl command: ${command}`);
