import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { get as getHttp } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isProductionHealthReady } from "./production-readiness.mjs";

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function run(command, args, { stdio = "ignore" } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun(code ?? 1));
  });
}

function freshJson(url, timeoutMs) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = getHttp(url, {
      agent: false,
      headers: { Connection: "close", "User-Agent": "weekly-recipe-planner-health" },
      timeout: timeoutMs,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => {
        try {
          resolveRequest({ status: response.statusCode ?? 0, body: JSON.parse(body) });
        } catch (error) {
          rejectRequest(error);
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("fresh HTTP probe timed out")));
    request.once("error", rejectRequest);
  });
}

function isLoopbackPortQuiet(port, timeoutMs) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(false);
    });
    socket.once("timeout", () => socket.destroy(new Error("loopback port probe timed out")));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        resolveProbe(true);
      } else {
        rejectProbe(error);
      }
    });
  });
}

function isUnixSocketQuiet(path, timeoutMs) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection(path);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(false);
    });
    socket.once("timeout", () => socket.destroy(new Error("runtime-owner socket probe timed out")));
    socket.once("error", (error) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        resolveProbe(true);
      } else {
        rejectProbe(error);
      }
    });
  });
}

export function productionServicePaths({
  home = process.env.HOME ?? homedir(),
  label = "com.ericfeunekes.meal-planner",
} = {}) {
  const canonicalHome = resolve(home);
  const deployRoot = join(canonicalHome, "meal-planner");
  const domain = `gui/${process.getuid?.()}`;
  return Object.freeze({
    home: canonicalHome,
    label,
    domain,
    target: `${domain}/${label}`,
    deployRoot,
    appRoot: join(deployRoot, "app"),
    dataRoot: join(deployRoot, "data"),
    agentRoot: join(deployRoot, "agent"),
    plistPath: join(canonicalHome, "Library", "LaunchAgents", `${label}.plist`),
    logPath: join(deployRoot, "planner.log"),
  });
}

export function renderProductionServicePlist({
  paths,
  node = process.execPath,
  port = Number(process.env.PLANNER_PORT ?? 8642),
  privateWebPort = Number(process.env.PLANNER_PRIVATE_WEB_PORT ?? 3002),
  tailnetOrigin = process.env.PLANNER_TAILNET_ORIGIN ?? "https://robie-imac.tailae8a7b.ts.net",
} = {}) {
  if (!paths || !Number.isInteger(port) || port < 1024 || port > 65_535 ||
      !Number.isInteger(privateWebPort) || privateWebPort < 1024 || privateWebPort > 65_535 ||
      privateWebPort === port) {
    throw new TypeError("Production service rendering requires paths and distinct valid non-privileged public and private ports.");
  }
  const environment = {
    HOME: paths.home,
    PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    PLANNER_HOST: "127.0.0.1",
    PLANNER_PORT: String(port),
    PLANNER_PRIVATE_WEB_PORT: String(privateWebPort),
    PLANNER_PUBLIC_BASE_PATH: "/recipe-planner/",
    PLANNER_ALLOWED_ORIGINS: `${tailnetOrigin},${tailnetOrigin}:${port}`,
    PLANNER_DATA_DIR: paths.dataRoot,
    PLANNER_CODEX_HOME: paths.agentRoot,
    PLANNER_CODEX_CWD: paths.appRoot,
  };
  const variables = Object.entries(environment).map(([key, value]) =>
    `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(paths.label)}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>scripts/start.mjs</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(paths.appRoot)}</string>
  <key>EnvironmentVariables</key><dict>${variables}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(paths.logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(paths.logPath)}</string>
</dict></plist>\n`;
}

export function createProductionService(options = {}) {
  const paths = options.paths ?? productionServicePaths(options);
  const port = options.port ?? Number(process.env.PLANNER_PORT ?? 8642);
  const privateWebPort = options.privateWebPort ?? Number(process.env.PLANNER_PRIVATE_WEB_PORT ?? 3002);
  const node = options.node ?? process.execPath;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const runCommand = options.runCommand ?? run;
  const readJson = options.readJson ?? freshJson;
  let lastReadinessFailure = "not probed";

  async function isLoaded() {
    return (await runCommand("launchctl", ["print", paths.target])) === 0;
  }

  async function isPortQuiet() { return isLoopbackPortQuiet(port, probeTimeoutMs); }
  async function isRuntimeOwnerQuiet() {
    return isUnixSocketQuiet(join(paths.dataRoot, ".runtime-owner", "runtime-owner.sock"), probeTimeoutMs);
  }

  async function waitUntil(predicate, message, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(pollIntervalMs);
    }
    throw new Error(typeof message === "function" ? message() : message);
  }

  async function writePlist() {
    await mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, renderProductionServicePlist({ paths, node, port, privateWebPort, tailnetOrigin: options.tailnetOrigin }), { mode: 0o600 });
  }
  async function probeReadiness() {
    if (!(await isLoaded())) return false;
      try {
        const [health, workspace, codexThreads] = await Promise.all([
          readJson(`http://127.0.0.1:${port}/recipe-planner/api/health`, probeTimeoutMs),
          readJson(`http://127.0.0.1:${port}/recipe-planner/api/workspace`, probeTimeoutMs),
          readJson(`http://127.0.0.1:${port}/recipe-planner/api/codex/threads`, probeTimeoutMs),
        ]);
        const ready = health.status >= 200 && health.status < 300 &&
          workspace.status >= 200 && workspace.status < 300 &&
          codexThreads.status >= 200 && codexThreads.status < 300 &&
          isProductionHealthReady(health.body);
        lastReadinessFailure = JSON.stringify({
          healthStatus: health.status,
          workspaceStatus: workspace.status,
          codexThreadsStatus: codexThreads.status,
          codexThreadsBody: codexThreads.body,
        });
        return ready;
      } catch (error) {
        lastReadinessFailure = error instanceof Error ? error.message : String(error);
        return false;
      }
  }

  return Object.freeze({
    paths,
    writePlist,
    isLoaded,
    isPortQuiet,
    isRuntimeOwnerQuiet,
    bootout: () => runCommand("launchctl", ["bootout", paths.target], { stdio: "inherit" }),
    waitForAbsent: (timeoutMs = 15_000) => waitUntil(
      async () => !(await isLoaded()) && await isPortQuiet() && await isRuntimeOwnerQuiet(),
      "Existing planner LaunchAgent, loopback port, or runtime-owner socket did not become quiet in time.",
      timeoutMs,
    ),
    bootstrap: async () => {
      await writePlist();
      const exitCode = await runCommand("launchctl", ["bootstrap", paths.domain, paths.plistPath], { stdio: "inherit" });
      if (exitCode !== 0) throw new Error(`launchctl bootstrap failed (${exitCode}).`);
    },
    probeReadiness,
    waitForReady: (timeoutMs = 60_000) => waitUntil(
      probeReadiness,
      () => `Planner did not become healthy on fresh connections. Last probe: ${lastReadinessFailure}`,
      timeoutMs,
    ),
  });
}
