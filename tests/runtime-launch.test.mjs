import assert from "node:assert/strict";
import test from "node:test";

import {
  createDevelopmentProcessSpecifications,
  createInstalledProcessSpecifications,
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
    "--disable-warning=ExperimentalWarning",
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
  assert.equal(config.publicBasePath, "/");
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

test("production launch uses Portless's assigned port when no planner port is explicit", () => {
  const [, authority] = createProductionProcessSpecifications({
    PORT: "4123",
    PLANNER_ALLOWED_ORIGINS: "http://weekly-recipe-planner-qa.localhost:1355",
  });
  const config = readRuntimeConfig(authority.options.env);

  assert.equal(config.port, 4123);
  assert.ok(config.allowedOrigins.has("http://weekly-recipe-planner-qa.localhost:1355"));
});

test("production launch allows an isolated private web port", () => {
  const [web, authority] = createProductionProcessSpecifications({
    PLANNER_PORT: "4123",
    PLANNER_PRIVATE_WEB_PORT: "4124",
  });
  const config = readRuntimeConfig(authority.options.env);

  assert.equal(web.options.env.PLANNER_WEB_PORT, "4124");
  assert.equal(config.webOrigin.href, "http://127.0.0.1:4124/");
});

test("runtime config retains a mounted public base path for direct public access", () => {
  const config = readRuntimeConfig({
    PLANNER_MODE: "front",
    PLANNER_PUBLIC_BASE_PATH: "/recipe-planner/",
  });
  assert.equal(config.publicBasePath, "/recipe-planner/");
});

test("installed launch fixes both children to the selected app and materializes disjoint roots", () => {
  const [web, authority] = createInstalledProcessSpecifications(
    {
      appDirectory: "/opt/meal-planner/app",
      agentDirectory: "/opt/meal-planner/agent",
      dataDirectory: "/opt/meal-planner/data",
      runDirectory: "/opt/meal-planner/run",
      activationId: "activation-1",
      operatorSha256: "operator-sha",
      activationSha256: "activation-sha",
    },
    {
      HOME: "/Users/planner",
      PATH: "/usr/bin:/bin",
      PLANNER_PORT: "3200",
    },
  );

  assert.equal(web.options.cwd, "/opt/meal-planner/app");
  assert.equal(authority.options.cwd, "/opt/meal-planner/app");
  assert.equal(authority.options.env.HOME, "/Users/planner");
  assert.equal(authority.options.env.PLANNER_CODEX_HOME, "/opt/meal-planner/agent");
  assert.equal(authority.options.env.PLANNER_CODEX_CWD, "/opt/meal-planner/app");
  assert.equal(authority.options.env.PLANNER_DATA_DIR, "/opt/meal-planner/data");
  assert.equal(
    authority.options.env.PLANNER_RUNTIME_OWNER_SOCKET,
    "/opt/meal-planner/run/runtime-owner.sock",
  );
  assert.equal("PLANNER_RUNTIME_OWNER_LEASE" in authority.options.env, false);
  assert.equal("PLANNER_RUNTIME_OWNER_TOKEN" in authority.options.env, false);
  assert.equal(authority.options.env.PLANNER_INSTALLED_RUNTIME, "1");
  assert.equal(authority.options.env.PLANNER_EXPECTED_ACTIVATION_ID, "activation-1");
  assert.equal(authority.options.env.PLANNER_EXPECTED_OPERATOR_SHA256, "operator-sha");
  assert.equal(authority.options.env.PLANNER_EXPECTED_ACTIVATION_SHA256, "activation-sha");
  assert.equal(
    web.options.env.WRANGLER_LOG_PATH,
    "/opt/meal-planner/run/logs/wrangler.log",
  );
  assert.equal(authority.options.env.PLANNER_MODE, "front");
  assert.equal(authority.options.env.PLANNER_PORT, "3200");
});
