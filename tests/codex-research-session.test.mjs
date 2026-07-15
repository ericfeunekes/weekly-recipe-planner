import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import {
  RESEARCH_MODEL_VISIBLE_TOOLS,
  ResearchSessionError,
  createRestrictedResearchSession,
} from "../server/runtime/codex-follow-up/research-session.ts";

const FIXTURE = resolve(
  "tests/support/fixtures/codex-runtime/fake-research-app-server.mjs",
);
const CWD = resolve(".");

function execution(scenario) {
  return {
    spawnAppServer({ signal } = {}) {
      return Promise.resolve(spawn(process.execPath, [FIXTURE, scenario], {
        cwd: CWD,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      }));
    },
  };
}

test("research uses one live-search-only profile and normalizes strict provider output", async () => {
  const result = await createRestrictedResearchSession(execution("normal"), CWD).run({
    prompt: "Find a lentil soup recipe.",
  });
  assert.equal(result.appServerThreadId, "research-thread");
  assert.equal(result.appServerTurnId, "research-turn");
  assert.deepEqual(result.observedWebSearchOperation, {
    operation: "web_search",
    status: "completed",
    appServerItemId: "research-web-search",
  });
  assert.deepEqual(result.modelVisibleTools, RESEARCH_MODEL_VISIBLE_TOOLS);
  assert.deepEqual(result.draft, {
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/lentil-soup",
    },
    title: "Lentil soup",
    steps: [{
      inputs: [{ amount: "1 cup", ingredient: "lentils" }],
      instruction: "Simmer until tender.",
      timerDurationSeconds: 900,
    }],
  });
});

for (const [scenario, pattern] of [
  ["hostile-field", /provider recipe contract/i],
  ["oversize", /provider recipe contract/i],
  ["unknown-request", /outside live hosted search/i],
  ["protocol-error", /identity changed/i],
  ["partial-turn-notification", /complete turn identity/i],
  ["missing-completed-at", /integer completion time/i],
  ["invalid-completed-at", /integer completion time/i],
  ["no-search", /did not observe a completed hosted web search/i],
]) {
  test(`research fails closed for ${scenario}`, async () => {
    await assert.rejects(
      createRestrictedResearchSession(execution(scenario), CWD).run({
        prompt: "Find a recipe.",
      }),
      (error) => error instanceof ResearchSessionError && pattern.test(error.message),
    );
  });
}

test("research cancellation closes the isolated process without planner callbacks", async () => {
  const controller = new AbortController();
  const result = createRestrictedResearchSession(execution("hang"), CWD).run({
    prompt: "Find a recipe.",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    result,
    (error) => error instanceof ResearchSessionError && error.code === "SESSION_CANCELLED",
  );
});
