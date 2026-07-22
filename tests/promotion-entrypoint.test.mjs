import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseCommandSteps,
  runDetachedMainRelease,
} from "../scripts/promote.mjs";

test("promotion gates the detached main candidate before private deployment", () => {
  const steps = releaseCommandSteps("promote", "/tmp/candidate", { PATH: "/bin" });
  assert.deepEqual(
    steps.map(({ command, args }) => [command, ...args]),
    [
      ["npm", "ci"],
      ["npm", "test"],
      ["npm", "run", "lint"],
      [
        process.execPath,
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        steps[3].args.at(-1),
      ],
    ],
  );
  assert.equal(steps[1].options.env.PLANNER_PUBLIC_BASE_PATH, "/recipe-planner/");
  assert.equal(steps[3].options.env.PLANNER_PUBLIC_BASE_PATH, "/recipe-planner/");
  assert.match(steps[3].args.at(-1), /deployProductionCandidate/u);
});

test("recovery obtains detached-main code but cannot run candidate gates or deployment", () => {
  const steps = releaseCommandSteps("recover", "/tmp/candidate", { PATH: "/bin" });
  assert.deepEqual(
    steps.map(({ command, args }) => [command, ...args]),
    [[
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "scripts/recover-deployment.mjs",
    ]],
  );
});

test("a failed promotion gate prevents deployment and still removes the detached worktree", async () => {
  const calls = [];
  await assert.rejects(
    runDetachedMainRelease("promote", {
      execute: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "npm" && args[0] === "test") throw new Error("gate failed");
      },
    }),
    /gate failed/u,
  );
  assert.equal(
    calls.some((call) => call[0] === process.execPath && call.some((argument) => /deployProductionCandidate/u.test(argument))),
    false,
  );
  assert.deepEqual(calls.at(-1).slice(0, 4), ["git", "worktree", "remove", "--force"]);
});

test("the private deployment adapter is import-only", async () => {
  const imported = await import("../scripts/direct-deploy.mjs");
  assert.equal(typeof imported.deployProductionCandidate, "function");
});
