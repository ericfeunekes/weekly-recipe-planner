import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { superviseProcesses } from "../scripts/process-supervisor.mjs";
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

  assert.throws(() => readRuntimeConfig({ PLANNER_HOST: "0.0.0.0" }));
  assert.throws(() =>
    readRuntimeConfig({
      PLANNER_ALLOWED_ORIGINS: "https://remote.example",
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
      queueMicrotask(() => child.emit("exit", null, signal));
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
  children[0].emit("exit", 7, null);
  assert.equal(await supervised, 7);
  assert.equal(children[1].killed, true);
});
