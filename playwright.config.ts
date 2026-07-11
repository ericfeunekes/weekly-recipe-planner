import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineConfig } from "@playwright/test";

const apiPort = 8877;
const controlPort = 8878;
const webPort = 3101;
const webOrigin = `http://127.0.0.1:${webPort}`;
const dataDirectory = join(
  tmpdir(),
  `weekly-recipe-planner-e2e-${process.pid}`,
);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "outputs/playwright/test-results",
  reporter: [["list"]],
  use: {
    baseURL: webOrigin,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --experimental-strip-types tests/support/e2e-runtime.mjs",
      port: apiPort,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        PLANNER_E2E_API_PORT: String(apiPort),
        PLANNER_E2E_CONTROL_PORT: String(controlPort),
        PLANNER_E2E_DATA_DIR: dataDirectory,
        PLANNER_E2E_WEB_ORIGIN: webOrigin,
      },
    },
    {
      command: "npx vinext dev --hostname 127.0.0.1 --port 3101",
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        PLANNER_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        PLANNER_WEB_PORT: String(webPort),
      },
    },
  ],
});
