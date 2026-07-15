import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGlobalCodexClientForHostTesting } from "../scripts/planner-global-client.ts";
import { superviseProcesses } from "../scripts/process-supervisor.mjs";
import {
  acquireRuntimeOwnershipLease,
} from "../scripts/support/runtime-ownership.mjs";
import {
  prepareInstalledRuntimeLaunch,
  startInstalledRuntime,
} from "../scripts/start-installed.mjs";
import {
  assertInstalledRuntimeSelection,
  startConfiguredPlannerRuntime,
} from "../server/index.ts";
import { readRuntimeConfig } from "../server/runtime/config.ts";

test("runtime config keeps API and front-controller surfaces on loopback", () => {
  const api = readRuntimeConfig({
    PLANNER_MODE: "api",
    PLANNER_DATA_DIR: "./work/test-data",
  });
  assert.equal(api.host, "127.0.0.1");
  assert.equal(api.port, 8788);
  assert.equal(api.webOrigin.href, "http://127.0.0.1:3001/");
  assert.ok(api.databasePath.endsWith("work/test-data/planner.sqlite"));
  assert.ok(api.allowedOrigins.has("http://localhost:3001"));
  assert.ok(api.allowedOrigins.has("http://[::1]:3001"));

  const front = readRuntimeConfig({
    PLANNER_MODE: "front",
    PLANNER_PORT: "3100",
    PLANNER_WEB_ORIGIN: "http://127.0.0.1:3102",
  });
  assert.equal(front.port, 3100);
  assert.equal(front.webOrigin.href, "http://127.0.0.1:3102/");
  assert.ok(front.allowedOrigins.has("http://localhost:3100"));
  assert.ok(front.allowedOrigins.has("http://[::1]:3100"));

  const tailnet = readRuntimeConfig({
    PLANNER_MODE: "front",
    PLANNER_PORT: "8642",
    PLANNER_WEB_ORIGIN: "http://127.0.0.1:3002",
    PLANNER_ALLOWED_ORIGINS:
      "http://127.0.0.1:8642,https://robie-imac.tailae8a7b.ts.net",
  });
  assert.deepEqual([...tailnet.allowedOrigins], [
    "http://127.0.0.1:8642",
    "https://robie-imac.tailae8a7b.ts.net",
  ]);

  assert.throws(() => readRuntimeConfig({ PLANNER_HOST: "0.0.0.0" }));
  assert.throws(() =>
    readRuntimeConfig({
      PLANNER_ALLOWED_ORIGINS: "https://remote.example",
    }),
  );
  assert.throws(() =>
    readRuntimeConfig({
      PLANNER_ALLOWED_ORIGINS: "https://robie-imac.tailae8a7b.ts.net/path",
    }),
  );
  assert.throws(() =>
    readRuntimeConfig({
      PLANNER_DATA_DIR: "./dist/planner-data",
    }),
  );
  assert.throws(() =>
    readRuntimeConfig({
      PLANNER_MODE: "front",
      PLANNER_PORT: "3100",
      PLANNER_WEB_ORIGIN: "http://localhost:3100",
    }),
    /must not use the application listener port/,
  );
  assert.throws(() =>
    readRuntimeConfig({
      PLANNER_MODE: "api",
      PLANNER_PORT: "8788",
      PLANNER_WEB_ORIGIN: "http://[::1]:8788",
    }),
    /must not use the application listener port/,
  );
});

test("configured QA composition binds Global Codex only at its in-memory private UDS", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-private-global-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDirectory = join(root, "data");
  const globalCodexParentDirectory = join(root, "transaction-private-global");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(dataDirectory, { mode: 0o700 }),
    mkdir(globalCodexParentDirectory, { mode: 0o700 }),
  ]);
  const ownerSocketPath = join(root, "owner", "runtime-owner.sock");
  const ownershipLease = await acquireRuntimeOwnershipLease({
    socketPath: ownerSocketPath,
  });
  t.after(() => ownershipLease.close());

  const reservation = createServer();
  await new Promise((resolveListen, rejectListen) => {
    reservation.once("error", rejectListen);
    reservation.listen(0, "127.0.0.1", resolveListen);
  });
  const address = reservation.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) =>
    reservation.close((error) => error ? rejectClose(error) : resolveClose())
  );

  const runtime = await startConfiguredPlannerRuntime({
    HOME: home,
    PLANNER_MODE: "api",
    PLANNER_HOST: "127.0.0.1",
    PLANNER_PORT: String(port),
    PLANNER_DATA_DIR: dataDirectory,
    PLANNER_WEB_ORIGIN: "http://127.0.0.1:3001",
    PLANNER_ALLOWED_ORIGINS: "http://127.0.0.1:3001",
    PLANNER_RUNTIME_OWNER_SOCKET: ownerSocketPath,
  }, {
    runtimeOwnershipLease: ownershipLease,
    globalCodexParentDirectory,
    webProbe: async () => true,
  });
  t.after(() => runtime.close());
  const privateSocketPath = join(
    globalCodexParentDirectory,
    "run",
    "global-codex.sock",
  );
  const client = createGlobalCodexClientForHostTesting(privateSocketPath);
  const health = await client.invoke("health", null);
  assert.equal(health.status, "ready");
  await assert.rejects(
    access(join(home, "meal-planner", "run", "global-codex.sock")),
    { code: "ENOENT" },
  );
  await runtime.close();
  await assert.rejects(access(privateSocketPath), { code: "ENOENT" });
});

test("installed start validates the committed pair before exposing process specifications", async () => {
  const layout = {
    appRoot: "/Users/planner/meal-planner/app",
    agentRoot: "/Users/planner/meal-planner/agent",
    dataRoot: "/Users/planner/meal-planner/data",
    runRoot: "/Users/planner/meal-planner/run",
  };
  const checked = [];
  const launch = await prepareInstalledRuntimeLaunch(
    { HOME: "/Users/planner", PATH: "/usr/bin:/bin" },
    {
      assertInstalledReleaseStartable: async (home) => {
        assert.equal(home, "/Users/planner");
        return {
          layout,
          current: {
            activationId: "activation",
            operatorSha256: "operator-sha",
            activationSha256: "activation-sha",
          },
          activation: { sha256: "activation-sha" },
          operatorPath: "/Users/planner/meal-planner/releases/operator/hash",
        };
      },
      assertRealCanonicalPath: async (path, kind) => {
        checked.push(["real", path, kind]);
        return path;
      },
      assertPrivateDirectory: async (path) => {
        checked.push(["private", path]);
      },
      ensurePrivateDirectory: async (path) => {
        checked.push(["ensure-private", path]);
      },
    },
  );

  assert.deepEqual(checked, [
    ["real", layout.appRoot, "directory"],
    ["private", layout.agentRoot],
    ["real", layout.dataRoot, "directory"],
    ["private", layout.runRoot],
    ["ensure-private", "/Users/planner/meal-planner/run/logs"],
  ]);
  assert.equal(launch.specifications[0].options.cwd, layout.appRoot);
  assert.equal(
    launch.specifications[1].options.env.PLANNER_RUNTIME_OWNER_SOCKET,
    "/Users/planner/meal-planner/run/runtime-owner.sock",
  );
  assert.equal(
    launch.specifications[1].options.env.PLANNER_EXPECTED_OPERATOR_SHA256,
    "operator-sha",
  );

  await assert.rejects(
    prepareInstalledRuntimeLaunch(
      { HOME: "/Users/planner" },
      {
        assertInstalledReleaseStartable: async () => {
          throw new Error("Installed start is blocked by pending release state preparing.");
        },
      },
    ),
    /blocked by pending release state preparing/u,
  );
});

test("installed start hands off to the hash-bound operator with no ambient authority overrides", async () => {
  const operatorPath = "/Users/planner/meal-planner/releases/operator/abc";
  let handoff = null;
  const exitCode = await startInstalledRuntime(
    {
      HOME: "/Users/planner",
      PATH: "/usr/bin:/bin",
      PLANNER_PORT: "3200",
      PLANNER_DATA_DIR: "/tmp/attacker-data",
      PLANNER_CODEX_HOME: "/tmp/attacker-agent",
      PLANNER_RUNTIME_OWNER_SOCKET: "/tmp/attacker.sock",
      NODE_OPTIONS: "--import=/tmp/attacker.mjs",
    },
    {
      assertInstalledReleaseStartable: async () => ({
        layout: {},
        current: {},
        activation: {},
        operatorPath,
      }),
      assertRealCanonicalPath: async (path, kind) => {
        assert.equal(path, `${operatorPath}/scripts/start-installed.mjs`);
        assert.equal(kind, "file");
      },
      realpath: async () => "/source/scripts/start-installed.mjs",
      runBoundOperator: async (entrypoint, environment) => {
        handoff = { entrypoint, environment };
        return 7;
      },
      superviseProcesses: () => assert.fail("the source projection must not supervise"),
    },
  );

  assert.equal(exitCode, 7);
  assert.deepEqual(handoff, {
    entrypoint: `${operatorPath}/scripts/start-installed.mjs`,
    environment: {
      HOME: "/Users/planner",
      PATH: "/usr/bin:/bin",
      PLANNER_PORT: "3200",
    },
  });
});

test("the installed authority guard rechecks bound release identities and pending state", async () => {
  const environment = {
    HOME: "/Users/planner",
    PLANNER_INSTALLED_RUNTIME: "1",
    PLANNER_EXPECTED_ACTIVATION_ID: "activation-1",
    PLANNER_EXPECTED_OPERATOR_SHA256: "operator-sha",
    PLANNER_EXPECTED_ACTIVATION_SHA256: "activation-sha",
  };
  let checks = 0;
  const assertStartable = async () => {
    checks += 1;
    return {
      current: {
        activationId: "activation-1",
        operatorSha256: "operator-sha",
        activationSha256: "activation-sha",
      },
    };
  };

  await assertInstalledRuntimeSelection(environment, { assertStartable });
  assert.equal(checks, 1);
  await assertInstalledRuntimeSelection({}, {
    assertStartable: async () => assert.fail("ordinary runtime must not read release state"),
  });
  await assert.rejects(
    assertInstalledRuntimeSelection(
      { ...environment, PLANNER_EXPECTED_ACTIVATION_ID: "older-activation" },
      { assertStartable },
    ),
    /selection changed before writer admission/u,
  );
  await assert.rejects(
    assertInstalledRuntimeSelection(environment, {
      assertStartable: async () => {
        throw new Error("Installed start is blocked by pending release state preparing.");
      },
    }),
    /pending release state preparing/u,
  );
});

test("process supervisor stops siblings when one child fails", async () => {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.killed = true;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    children.push(child);
    return child;
  };

  const supervised = superviseProcesses(
    [{ command: "one" }, { command: "two" }],
    { spawnImpl, signals: [] },
  );
  children[0].exitCode = 7;
  children[0].emit("close", 7, null);
  assert.equal(await supervised, 7);
  assert.equal(children[1].killed, true);
});

test("process supervisor treats an unexpected clean child exit as failure", async () => {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    children.push(child);
    return child;
  };
  const supervised = superviseProcesses(
    [{ command: "one" }, { command: "two" }],
    { spawnImpl, signals: [] },
  );

  children[0].emit("close", 0, null);

  assert.equal(await supervised, 1);
  assert.equal(children[1].killed, true);
});

test("process supervisor preserves success for an initiated shutdown", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("close", 0, null));
    return true;
  };
  const supervised = superviseProcesses([{ command: "one" }], {
    spawnImpl: () => child,
    signals: ["planner-test-stop"],
  });

  process.emit("planner-test-stop");

  assert.equal(await supervised, 0);
  assert.deepEqual(signals, ["planner-test-stop"]);
});

test("process supervisor force-stops a child after the shutdown grace period", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => child.emit("close", null, signal));
    }
    return true;
  };
  const supervised = superviseProcesses([{ command: "stubborn" }], {
    spawnImpl: () => child,
    signals: [],
    shutdownGracePeriodMs: 5,
  });

  child.emit("error", new Error("trigger shutdown"));
  assert.equal(await supervised, 1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("process supervisor validates the shutdown bound before spawning", async () => {
  await assert.rejects(
    superviseProcesses([{ command: "unused" }], {
      spawnImpl: () => assert.fail("invalid configuration must not spawn"),
      signals: [],
      shutdownGracePeriodMs: -1,
    }),
    /non-negative integer/,
  );
});
