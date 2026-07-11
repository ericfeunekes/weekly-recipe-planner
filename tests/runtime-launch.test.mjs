import assert from "node:assert/strict";
import test from "node:test";

import {
  createDevelopmentProcessSpecifications,
  createProductionProcessSpecifications,
} from "../scripts/runtime-processes.mjs";
import { readRuntimeConfig } from "../server/runtime/config.ts";

test("development launch fixes the API and web processes to the proxy topology", () => {
  const [authority, web] = createDevelopmentProcessSpecifications({
    PLANNER_DATA_DIR: "/tmp/planner-development-data",
    PLANNER_PORT: "9999",
  });
  const config = readRuntimeConfig(authority.options.env);

  assert.equal(authority.command, process.execPath);
  assert.deepEqual(authority.args, [
    "--experimental-strip-types",
    "server/index.ts",
  ]);
  assert.equal(config.mode, "api");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8788);
  assert.equal(config.webOrigin.href, "http://127.0.0.1:3001/");
  assert.equal(config.dataDirectory, "/tmp/planner-development-data");

  assert.equal(web.command, process.execPath);
  assert.deepEqual(web.args, [
    "node_modules/vinext/dist/cli.js",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3001",
  ]);
  assert.equal(web.options.env.PLANNER_WEB_PORT, "3001");
  assert.equal(
    web.options.env.PLANNER_API_ORIGIN,
    "http://127.0.0.1:8788",
  );
});

test("production launch keeps Vinext private and honors public runtime config", () => {
  const [web, authority] = createProductionProcessSpecifications({
    PLANNER_HOST: "::1",
    PLANNER_PORT: "3100",
    PLANNER_DATA_DIR: "/tmp/planner-production-data",
    PLANNER_ALLOWED_ORIGINS: "http://[::1]:3100",
    PLANNER_WEB_ORIGIN: "http://127.0.0.1:9999",
  });
  const config = readRuntimeConfig(authority.options.env);

  assert.deepEqual(web.args, [
    "node_modules/vinext/dist/cli.js",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3002",
  ]);
  assert.equal(web.options.env.PLANNER_WEB_PORT, "3002");
  assert.equal(config.mode, "front");
  assert.equal(config.host, "::1");
  assert.equal(config.port, 3100);
  assert.equal(config.webOrigin.href, "http://127.0.0.1:3002/");
  assert.equal(config.dataDirectory, "/tmp/planner-production-data");
  assert.deepEqual([...config.allowedOrigins], ["http://[::1]:3100"]);
});

test("production launch defaults to one public loopback origin", () => {
  const [, authority] = createProductionProcessSpecifications({});
  const config = readRuntimeConfig(authority.options.env);

  assert.equal(config.mode, "front");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.ok(config.allowedOrigins.has("http://127.0.0.1:3000"));
});
