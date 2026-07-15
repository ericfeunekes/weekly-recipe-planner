import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineConfig } from "@playwright/test";

const installedProduction = process.env.PLANNER_E2E_WEB_MODE === "installed-production";
const externalServers = process.env.PLANNER_E2E_EXTERNAL_SERVERS === "1";
if (installedProduction && !externalServers) {
  throw new Error(
    "Installed-production Playwright must be launched by the installed QA runner.",
  );
}
const apiOrigin = process.env.PLANNER_E2E_BASE_URL ?? "http://127.0.0.1:8877";
const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";
const webOrigin = process.env.PLANNER_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3101";
const apiPort = Number(new URL(apiOrigin).port);
const controlPort = Number(new URL(controlOrigin).port);
const webPort = Number(new URL(webOrigin).port);
const browserOrigin = installedProduction ? apiOrigin : webOrigin;
const dataDirectory = join(
  tmpdir(),
  `weekly-recipe-planner-e2e-${process.pid}`,
);
const outputDirectory = process.env.PLANNER_E2E_OUTPUT_DIR ??
  "outputs/playwright/test-results";
const wranglerLogPath = process.env.PLANNER_E2E_WRANGLER_LOG_PATH ??
  join(outputDirectory, "wrangler.log");

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: installedProduction ? undefined : [
    "**/installed-selected-clone.spec.ts",
    "**/installed-visual-qa.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: outputDirectory,
  reporter: [["list"]],
  use: {
    baseURL: browserOrigin,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: externalServers ? undefined : [
    {
      command: "node --disable-warning=ExperimentalWarning --experimental-strip-types tests/support/e2e-runtime.mjs",
      port: apiPort,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        PLANNER_E2E_API_PORT: String(apiPort),
        PLANNER_E2E_CONTROL_PORT: String(controlPort),
        PLANNER_E2E_DATA_DIR: dataDirectory,
        PLANNER_E2E_WEB_ORIGIN: webOrigin,
        PLANNER_E2E_RUNTIME_MODE: "api",
      },
    },
    {
      command: `node node_modules/vinext/dist/cli.js dev --hostname 127.0.0.1 --port ${webPort}`,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        PLANNER_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        PLANNER_WEB_PORT: String(webPort),
        WRANGLER_LOG_PATH: wranglerLogPath,
      },
    },
  ],
});
