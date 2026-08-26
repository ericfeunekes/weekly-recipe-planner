import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { e2eArtifactWatch } from "../scripts/e2e-artifact-watch.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
test("ordinary development keeps its watcher unchanged", () => {
  assert.equal(e2eArtifactWatch({}), undefined);
});

test("Seatbelt development retains polling without E2E artifact ignores", () => {
  assert.deepEqual(e2eArtifactWatch({ CODEX_SANDBOX: "seatbelt" }), {
    useFsEvents: false,
    usePolling: true,
  });
});

test("E2E outside Seatbelt adds only artifact ignores", () => {
  assert.deepEqual(e2eArtifactWatch({
    PLANNER_E2E_OUTPUT_DIR: "outputs/playwright/test-results",
  }, (path) => resolve(root, path)), {
    ignored: [
      `${resolve(root, "outputs/playwright/test-results")}/**`,
    ],
  });
});

test("E2E Seatbelt watcher retains polling and ignores only each effective artifact path", () => {
  const outputDirectory = ".scratch/e2e-output";
  const wranglerLogPath = ".scratch/e2e-log/wrangler.log";
  const evidenceDirectory = ".scratch/e2e-evidence";
  const watch = e2eArtifactWatch({
    CODEX_SANDBOX: "seatbelt",
    PLANNER_E2E_OUTPUT_DIR: outputDirectory,
    PLANNER_E2E_WRANGLER_LOG_PATH: wranglerLogPath,
    PLANNER_E2E_EVIDENCE_DIR: evidenceDirectory,
  }, (path) => resolve(root, path));

  assert.deepEqual(watch, {
    useFsEvents: false,
    usePolling: true,
    ignored: [
      `${resolve(root, outputDirectory)}/**`,
      resolve(root, wranglerLogPath),
      `${resolve(root, evidenceDirectory)}/**`,
    ],
  });
});


test("E2E watcher escapes configured glob characters", () => {
  const watch = e2eArtifactWatch({
    PLANNER_E2E_OUTPUT_DIR: ".scratch/qa[1]",
    PLANNER_E2E_WRANGLER_LOG_PATH: ".scratch/log[1].log",
  }, (path) => resolve(root, path));
  assert.deepEqual(watch.ignored, [
    `${resolve(root, ".scratch/qa[1]").replace("[", "\\[").replace("]", "\\]")}/**`,
    resolve(root, ".scratch/log[1].log").replace("[", "\\[").replace("]", "\\]"),
  ]);
});
