import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { shouldStageApplicationPath } from "./support/deployment-staging-filter.mjs";
import { isProductionHealthReady } from "./support/production-readiness.mjs";

const LABEL = "com.ericfeunekes.meal-planner";
const PORT = Number(process.env.PLANNER_PORT ?? 8642);
const TAILNET_ORIGIN = process.env.PLANNER_TAILNET_ORIGIN
  ?? "https://robie-imac.tailae8a7b.ts.net";
const HOME = resolve(process.env.HOME ?? homedir());
const ROOT = resolve(process.cwd());
const DEPLOY_ROOT = join(HOME, "meal-planner");
const APP_ROOT = join(DEPLOY_ROOT, "app");
const DATA_ROOT = join(DEPLOY_ROOT, "data");
const BACKUP_ROOT = join(DEPLOY_ROOT, "backups");
const PLIST_PATH = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid?.()}`;
const TARGET = `${DOMAIN}/${LABEL}`;
const PROBE_TIMEOUT_MS = 2_000;

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(" ")} failed (${code}).`)));
  });
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForHealthy() {
  const deadline = Date.now() + 60_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const workspace = await fetch(`http://127.0.0.1:${PORT}/api/workspace`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const healthBody = health.ok ? await health.json() : null;
      if (workspace.ok && isProductionHealthReady(healthBody)) return;
      last = `health ${health.status} (${healthBody?.status ?? "invalid"}), workspace ${workspace.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Planner did not become healthy (${last}).`);
}

async function waitForUnloaded() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const loaded = await new Promise((resolveCheck, rejectCheck) => {
      const child = spawn("launchctl", ["print", TARGET], { stdio: "ignore" });
      child.once("error", rejectCheck);
      child.once("exit", (code) => resolveCheck(code === 0));
    });
    if (!loaded) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Existing planner LaunchAgent did not unload in time.");
}

function plist(node) {
  const env = {
    HOME,
    PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    PLANNER_HOST: "127.0.0.1",
    PLANNER_PORT: String(PORT),
    PLANNER_PUBLIC_BASE_PATH: "/recipe-planner/",
    // Tailscale terminates TLS before forwarding to this loopback-only process.
    // The application must still recognize that public same-origin host.
    PLANNER_ALLOWED_ORIGINS: `${TAILNET_ORIGIN},${TAILNET_ORIGIN}:${PORT}`,
    PLANNER_DATA_DIR: DATA_ROOT,
    PLANNER_CODEX_HOME: join(DEPLOY_ROOT, "agent"),
    PLANNER_CODEX_CWD: APP_ROOT,
  };
  const variables = Object.entries(env).map(([key, value]) =>
    `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>scripts/start.mjs</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(APP_ROOT)}</string>
  <key>EnvironmentVariables</key><dict>${variables}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(DEPLOY_ROOT, "planner.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(DEPLOY_ROOT, "planner.log"))}</string>
</dict></plist>\n`;
}

if (!(await exists(join(ROOT, "dist")))) throw new Error("Build output is missing; run npm run build first.");
if (!(await exists(join(DATA_ROOT, "planner.sqlite")))) throw new Error("Production planner data is missing.");
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("PLANNER_PORT is invalid.");

await mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 });
await mkdir(dirname(PLIST_PATH), { recursive: true, mode: 0o700 });
await mkdir(join(DEPLOY_ROOT, "agent"), { recursive: true, mode: 0o700 });
const [dedicatedCodexConfig, dedicatedCodexInstructions] = await Promise.all([
  readFile(join(ROOT, "deployment", "codex", "config.toml"), "utf8"),
  readFile(join(ROOT, "deployment", "codex", "AGENTS.md"), "utf8"),
]);
await writeFile(join(DEPLOY_ROOT, "agent", "config.toml"), dedicatedCodexConfig, { mode: 0o600 });
await writeFile(join(DEPLOY_ROOT, "agent", "AGENTS.md"), dedicatedCodexInstructions, { mode: 0o600 });

const deploymentId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
const backup = join(BACKUP_ROOT, deploymentId);
const staging = join(DEPLOY_ROOT, `.app-staging-${deploymentId}`);
let moved = false;
try {
  await cp(ROOT, staging, {
    recursive: true,
    filter(source) { return shouldStageApplicationPath(source, ROOT); },
  });
  if (!(await exists(join(staging, "package.json")))) {
    throw new Error("Staged application is missing package.json.");
  }
  await run("npm", ["ci"], { cwd: staging });
  await run("launchctl", ["bootout", TARGET]).catch(() => undefined);
  await waitForUnloaded();
  if (await exists(APP_ROOT)) {
    await chmod(APP_ROOT, 0o700);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await rename(APP_ROOT, join(backup, "app"));
    moved = true;
  }
  await rename(staging, APP_ROOT);
  await chmod(APP_ROOT, 0o700);
  await writeFile(PLIST_PATH, plist(process.execPath), { mode: 0o600 });
  await run("launchctl", ["bootstrap", DOMAIN, PLIST_PATH]);
  await waitForHealthy();
  // Readiness probes intentionally keep HTTP connections alive. The
  // LaunchAgent owns the service now, so end this one-shot deploy process
  // explicitly instead of letting those idle client sockets hold it open.
  process.exit(0);
} catch (error) {
  console.error(
    `Planner deployment failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  await run("launchctl", ["bootout", TARGET]).catch(() => undefined);
  await rm(APP_ROOT, { recursive: true, force: true }).catch(() => undefined);
  if (moved) await rename(join(backup, "app"), APP_ROOT).catch(() => undefined);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}
