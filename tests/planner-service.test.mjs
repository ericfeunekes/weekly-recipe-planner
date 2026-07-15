import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLANNER_SERVICE_LABEL,
  createPlannerLaunchAgentPlist,
  derivePlannerServiceLayout,
  runPlannerServiceCommand,
} from "../scripts/planner-service.mjs";
import {
  createReleaseArtifact,
  publishReleaseArtifact,
} from "../scripts/support/planner-release-contract.mjs";

const SERVICE_ENTRYPOINT = fileURLToPath(
  new URL("../scripts/planner-service.mjs", import.meta.url),
);

function readyHealth() {
  return {
    status: "degraded",
    web: { status: "ready" },
    application: { status: "ready", initialized: true },
    store: { status: "ready", quickCheck: "ok" },
    codex: { status: "unavailable" },
    globalCodex: { status: "ready" },
  };
}

function response(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function fakeLaunchctl(supervisorPid = 4242) {
  const calls = [];
  let loaded = false;
  return {
    calls,
    get loaded() {
      return loaded;
    },
    async runCommand(command, args) {
      calls.push([command, ...args]);
      assert.equal(command, "launchctl");
      if (args[0] === "print") {
        return loaded
          ? { code: 0, stdout: `state = running\npid = ${supervisorPid}\n`, stderr: "" }
          : { code: 3, stdout: "", stderr: "not found" };
      }
      if (args[0] === "bootstrap" || args[0] === "kickstart") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

async function serviceFixture(context, { supervisorPid = 4242 } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "planner service & tests-"));
  const home = join(parent, "family home & kitchen");
  await mkdir(home);
  const operatorPath = join(home, "meal-planner", "releases", "operator", "a".repeat(64));
  await mkdir(operatorPath, { recursive: true });
  const launchctl = fakeLaunchctl(supervisorPid);
  const dependencies = {
    assertInstalledReleaseStartable: async () => ({
      current: {
        activationId: "11111111-1111-4111-8111-111111111111",
        operatorSha256: "a".repeat(64),
      },
      layout: { stagePath: join(home, "stage.json") },
      operatorPath,
    }),
    fetch: async (url) => url.endsWith("/api/health")
      ? response(200, readyHealth())
      : response(200, { serverRevision: 1, workspace: {} }),
    getUid: () => process.getuid(),
    listenerBelongsToSupervisor: async () => true,
    resolveBoundNode: async () => join(home, "runtime & node", "bin", "node"),
    runCommand: launchctl.runCommand,
    sleep: async () => {},
  };
  context.after(() => rm(parent, { recursive: true, force: true }));
  return { dependencies, home, launchctl, operatorPath, parent };
}

function runProcess(command, args, { environment = process.env, timeoutMs = 5_000 } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectProcess(new Error(`${command} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveProcess({ code, stderr, stdout });
    });
  });
}

async function startPlannerHealthServer(context, parent) {
  const serverPath = join(parent, "planner-health-server.mjs");
  await writeFile(serverPath, [
    'import { createServer } from "node:http";',
    `const health = ${JSON.stringify(readyHealth())};`,
    "const server = createServer((request, response) => {",
    '  response.setHeader("content-type", "application/json");',
    '  if (request.url === "/api/health") {',
    "    response.end(JSON.stringify(health));",
    "    return;",
    "  }",
    '  if (request.url === "/api/workspace") {',
    '    response.end(JSON.stringify({ serverRevision: 1, workspace: {} }));',
    "    return;",
    "  }",
    "  response.statusCode = 404;",
    '  response.end(JSON.stringify({ error: "not found" }));',
    "});",
    'server.listen(0, "127.0.0.1", () => {',
    "  process.stdout.write(`${server.address().port}\\n`);",
    "});",
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    "",
  ].join("\n"));
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolvePort, rejectPort) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPort(new Error("The disposable planner health server did not start."));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n", 1)[0];
      if (!/^\d+$/u.test(line)) return;
      clearTimeout(timeout);
      resolvePort(Number(line));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPort(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectPort(new Error(`The disposable planner health server exited ${code}.`));
    });
  });
  context.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await once(child, "exit");
  });
  return port;
}

test("LaunchAgent plist binds the immutable operator and escapes every value", () => {
  const plist = createPlannerLaunchAgentPlist({
    allowedOrigins: "https://planner.invalid/?a=1&b=<two>",
    home: "/Users/family & friends",
    nodeExecutable: "/runtime & tools/bin/node",
    operatorPath: "/Users/family & friends/meal-planner/releases/operator/abc",
    port: 8642,
    stdoutPath: "/Users/family & friends/meal-planner/run/logs/service.log",
  });

  assert.match(plist, new RegExp(`<string>${PLANNER_SERVICE_LABEL}</string>`));
  assert.match(plist, /\/releases\/operator\/abc\/scripts\/start-installed\.mjs/u);
  assert.match(plist, /family &amp; friends/u);
  assert.match(plist, /a=1&amp;b=&lt;two&gt;/u);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u);
  assert.doesNotMatch(plist, /candidate-2026|scripts\/start\.mjs|PLANNER_DATA_DIR|PLANNER_CODEX_HOME/u);
});

test("generated LaunchAgent plist passes the native macOS parser", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "planner-plist-parser-"));
  const plistPath = join(parent, "planner.plist");
  context.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(plistPath, createPlannerLaunchAgentPlist({
    allowedOrigins: "http://127.0.0.1:8642,https://planner.invalid",
    home: "/Users/family",
    nodeExecutable: "/runtime/bin/node",
    operatorPath: "/Users/family/meal-planner/releases/operator/abc",
    port: 8642,
    stdoutPath: "/Users/family/meal-planner/run/logs/service.log",
  }));

  const parsed = await runProcess("/usr/bin/plutil", ["-lint", plistPath]);
  assert.equal(parsed.code, 0, parsed.stderr || parsed.stdout);
  assert.match(parsed.stdout, /OK/u);
});

test("install snapshots and revalidates the exact release-bound Node executable", async (context) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "planner-node-snapshot-")));
  const home = join(parent, "home");
  const activationId = "11111111-1111-4111-8111-111111111111";
  const operatorSha256 = "a".repeat(64);
  const operatorPath = join(home, "meal-planner", "releases", "operator", operatorSha256);
  const nodeExecutable = join(parent, "release-node");
  const stagePath = join(parent, "stage.json");
  await mkdir(operatorPath, { recursive: true });
  await writeFile(nodeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
  await chmod(nodeExecutable, 0o500);
  const nodeSha256 = createHash("sha256")
    .update(await readFile(nodeExecutable))
    .digest("hex");
  await publishReleaseArtifact(stagePath, createReleaseArtifact({
    activationId,
    artifactType: "stage",
    projection: {
      preflight: {
        node: {
          exactFloorVerified: true,
          executable: nodeExecutable,
          recheckedAfterSuite: true,
          sha256: nodeSha256,
          version: "v22.15.0",
        },
      },
    },
  }));
  const launchctl = fakeLaunchctl();
  const dependencies = {
    assertInstalledReleaseStartable: async () => ({
      current: { activationId, operatorSha256 },
      layout: { stagePath },
      operatorPath,
    }),
    fetch: async (url) => url.endsWith("/api/health")
      ? response(200, readyHealth())
      : response(200, { serverRevision: 1, workspace: {} }),
    getUid: () => process.getuid(),
    listenerBelongsToSupervisor: async () => true,
    runCommand: launchctl.runCommand,
    sleep: async () => {},
  };
  context.after(() => rm(parent, { recursive: true, force: true }));

  await runPlannerServiceCommand("install", { HOME: home }, dependencies, {
    healthIntervalMs: 1,
    healthTimeoutMs: 50,
  });

  const snapshotPath = join(
    home,
    "meal-planner",
    "releases",
    "service-runtime",
    nodeSha256,
    "node",
  );
  const snapshotMetadata = await stat(snapshotPath);
  assert.equal(snapshotMetadata.mode & 0o777, 0o500);
  assert.equal(
    createHash("sha256").update(await readFile(snapshotPath)).digest("hex"),
    nodeSha256,
  );
  assert.match(
    await readFile(derivePlannerServiceLayout(home).plistPath, "utf8"),
    new RegExp(snapshotPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );

  await chmod(nodeExecutable, 0o700);
  await writeFile(nodeExecutable, "#!/bin/sh\nexit 1\n");
  await assert.rejects(
    runPlannerServiceCommand("install", { HOME: home }, dependencies),
    /Node executable changed after activation/u,
  );
  assert.equal(
    createHash("sha256").update(await readFile(snapshotPath)).digest("hex"),
    nodeSha256,
  );
});

test("the CLI bounds real child output and parses a normal launchctl miss", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "planner-service-cli-"));
  const home = join(parent, "home");
  const bin = join(parent, "bin");
  const launchctlPath = join(bin, "launchctl");
  await mkdir(home);
  await mkdir(bin);
  context.after(() => rm(parent, { recursive: true, force: true }));
  const environment = {
    HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };

  await writeFile(
    launchctlPath,
    `#!${process.execPath}\nprocess.stdout.write("x".repeat(70 * 1024));\n`,
  );
  await chmod(launchctlPath, 0o700);
  const overflow = await runProcess(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", SERVICE_ENTRYPOINT, "status"],
    { environment },
  );
  assert.equal(overflow.code, 1);
  assert.equal(overflow.stdout, "");
  assert.match(overflow.stderr, /output exceeded the service-manager limit/u);

  await writeFile(
    launchctlPath,
    `#!${process.execPath}\nprocess.stderr.write("service not found\\n");\nprocess.exit(3);\n`,
  );
  const stopped = await runProcess(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", SERVICE_ENTRYPOINT, "status"],
    { environment },
  );
  assert.equal(stopped.code, 1);
  assert.equal(stopped.stderr, "");
  assert.deepEqual(JSON.parse(stopped.stdout), {
    healthy: false,
    loaded: false,
    plistPath: derivePlannerServiceLayout(home).plistPath,
    status: "stopped",
  });
});

test("install verifies a real listener descends from the selected supervisor", async (context) => {
  const fixture = await serviceFixture(context, { supervisorPid: process.pid });
  const port = await startPlannerHealthServer(context, fixture.parent);
  const dependencies = { ...fixture.dependencies };
  delete dependencies.fetch;
  delete dependencies.listenerBelongsToSupervisor;

  const result = await runPlannerServiceCommand(
    "install",
    { HOME: fixture.home, PLANNER_PORT: String(port) },
    dependencies,
    { healthIntervalMs: 5, healthTimeoutMs: 5_000 },
  );
  assert.equal(result.status, "running");
  assert.equal(result.health.store.quickCheck, "ok");
});

test("install is repeatable, selected-release-bound, and health-gated", async (context) => {
  const fixture = await serviceFixture(context);
  const environment = { HOME: fixture.home };
  const layout = derivePlannerServiceLayout(fixture.home);

  const first = await runPlannerServiceCommand(
    "install",
    environment,
    fixture.dependencies,
    { healthIntervalMs: 1, healthTimeoutMs: 50 },
  );
  assert.equal(first.status, "running");
  assert.equal(first.activationId, "11111111-1111-4111-8111-111111111111");
  assert.equal((await stat(layout.plistPath)).mode & 0o777, 0o600);
  const installed = await readFile(layout.plistPath, "utf8");
  assert.match(installed, /runtime &amp; node/u);
  assert.match(installed, new RegExp(fixture.operatorPath.replaceAll("&", "&amp;")));
  assert.deepEqual(fixture.launchctl.calls, [
    ["launchctl", "print", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
    ["launchctl", "enable", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
    ["launchctl", "bootstrap", `gui/${process.getuid()}`, layout.plistPath],
    ["launchctl", "print", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
  ]);

  await runPlannerServiceCommand(
    "install",
    environment,
    fixture.dependencies,
    { healthIntervalMs: 1, healthTimeoutMs: 50 },
  );
  assert.deepEqual(fixture.launchctl.calls.slice(4), [
    ["launchctl", "print", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
    ["launchctl", "bootout", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
    ["launchctl", "print", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
    ["launchctl", "enable", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
    ["launchctl", "bootstrap", `gui/${process.getuid()}`, layout.plistPath],
    ["launchctl", "print", `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`],
  ]);
  assert.equal(await readFile(layout.plistPath, "utf8"), installed);
});

test("start, status, stop, and uninstall are idempotent and preserve planner data", async (context) => {
  const fixture = await serviceFixture(context);
  const environment = { HOME: fixture.home };
  const layout = derivePlannerServiceLayout(fixture.home);
  const sentinels = ["app", "agent", "data", "releases"].map((name) =>
    join(fixture.home, "meal-planner", name, `${name}.sentinel`));
  for (const path of sentinels) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, path);
  }

  await runPlannerServiceCommand("install", environment, fixture.dependencies, {
    healthIntervalMs: 1,
    healthTimeoutMs: 50,
  });
  const status = await runPlannerServiceCommand("status", environment, fixture.dependencies);
  assert.equal(status.status, "running");
  assert.equal(status.healthy, true);

  assert.equal(
    (await runPlannerServiceCommand("stop", environment, fixture.dependencies)).status,
    "stopped",
  );
  assert.equal(
    (await runPlannerServiceCommand("stop", environment, fixture.dependencies)).status,
    "already-stopped",
  );
  await runPlannerServiceCommand("start", environment, fixture.dependencies, {
    healthIntervalMs: 1,
    healthTimeoutMs: 50,
  });
  assert.equal(fixture.launchctl.loaded, true);
  assert.ok(fixture.launchctl.calls.some((call) =>
    call[1] === "enable" && call[2] === `gui/${process.getuid()}/${PLANNER_SERVICE_LABEL}`));

  assert.equal(
    (await runPlannerServiceCommand("uninstall", environment, fixture.dependencies)).status,
    "uninstalled",
  );
  assert.equal(
    (await runPlannerServiceCommand("uninstall", environment, fixture.dependencies)).status,
    "uninstalled",
  );
  await assert.rejects(lstat(layout.plistPath), /ENOENT/u);
  for (const path of sentinels) assert.equal(await readFile(path, "utf8"), path);
});

test("uninstall refuses an unmanaged plist symlink", async (context) => {
  const fixture = await serviceFixture(context);
  const layout = derivePlannerServiceLayout(fixture.home);
  await mkdir(layout.launchAgentsRoot, { recursive: true });
  const foreign = join(fixture.home, "foreign.plist");
  await writeFile(foreign, "foreign");
  await symlink(foreign, layout.plistPath);

  await assert.rejects(
    runPlannerServiceCommand("uninstall", { HOME: fixture.home }, fixture.dependencies),
    /current-user-owned regular file/u,
  );
  assert.equal(await readFile(foreign, "utf8"), "foreign");
});

test("start refuses an unmanaged plist symlink", async (context) => {
  const fixture = await serviceFixture(context);
  const layout = derivePlannerServiceLayout(fixture.home);
  await mkdir(layout.launchAgentsRoot, { recursive: true });
  const foreign = join(fixture.home, "foreign-start.plist");
  await writeFile(foreign, "foreign");
  await symlink(foreign, layout.plistPath);

  await assert.rejects(
    runPlannerServiceCommand("start", { HOME: fixture.home }, fixture.dependencies),
    /current-user-owned regular file/u,
  );
  assert.equal(fixture.launchctl.calls.length, 0);
});

test("install rejects health from a listener outside the launchd job", async (context) => {
  const fixture = await serviceFixture(context);
  const dependencies = {
    ...fixture.dependencies,
    listenerBelongsToSupervisor: async () => false,
    sleep: async () => new Promise((resolveSleep) => setTimeout(resolveSleep, 5)),
  };
  await assert.rejects(
    runPlannerServiceCommand("install", { HOME: fixture.home }, dependencies, {
      healthIntervalMs: 5,
      healthTimeoutMs: 20,
    }),
    /listener owned by the selected launchd job/u,
  );
});

test("health polling follows a KeepAlive supervisor PID change", async (context) => {
  const fixture = await serviceFixture(context);
  let printCount = 0;
  let ownershipChecks = 0;
  const dependencies = {
    ...fixture.dependencies,
    listenerBelongsToSupervisor: async (pid) => {
      ownershipChecks += 1;
      return pid === 4343;
    },
    runCommand: async (command, args) => {
      if (args[0] === "print" && fixture.launchctl.loaded) {
        printCount += 1;
        const pid = printCount === 1 ? 4242 : 4343;
        return { code: 0, stdout: `state = running\npid = ${pid}\n`, stderr: "" };
      }
      return fixture.launchctl.runCommand(command, args);
    },
    sleep: async () => new Promise((resolveSleep) => setTimeout(resolveSleep, 5)),
  };
  const result = await runPlannerServiceCommand(
    "install",
    { HOME: fixture.home },
    dependencies,
    { healthIntervalMs: 5, healthTimeoutMs: 50 },
  );
  assert.equal(result.status, "running");
  assert.equal(ownershipChecks, 2);
});

test("status separates launchd state from application readiness", async (context) => {
  const fixture = await serviceFixture(context);
  const environment = { HOME: fixture.home };
  await runPlannerServiceCommand("install", environment, fixture.dependencies, {
    healthIntervalMs: 1,
    healthTimeoutMs: 50,
  });
  const unhealthyDependencies = {
    ...fixture.dependencies,
    fetch: async () => response(503, { status: "starting" }),
    sleep: async () => new Promise((resolveSleep) => setTimeout(resolveSleep, 50)),
  };
  const status = await runPlannerServiceCommand("status", environment, unhealthyDependencies);
  assert.equal(status.loaded, true);
  assert.equal(status.healthy, false);
  assert.equal(status.status, "unhealthy");
});

test("launchctl inspection failures are not misreported as a stopped service", async (context) => {
  const fixture = await serviceFixture(context);
  const dependencies = {
    ...fixture.dependencies,
    runCommand: async () => ({ code: 77, stderr: "permission denied", stdout: "" }),
  };
  await assert.rejects(
    runPlannerServiceCommand("status", { HOME: fixture.home }, dependencies),
    /inspection failed: permission denied/u,
  );
});
