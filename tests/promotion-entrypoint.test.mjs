import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseCommandSteps,
  run,
  runDetachedMainRelease,
} from "../scripts/promote.mjs";

test("promotion command failures retain the child stderr reason", async () => {
  const delayedDiagnostic = "setTimeout(() => { process.stderr.write('RuntimeOwnershipError: owns the runtime writer lease'); }, 50)";
  const failingParent = `require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(delayedDiagnostic)}], { stdio: ['ignore', 'ignore', 'inherit'] }); process.exit(23)`;
  await assert.rejects(
    run(process.execPath, ["--eval", failingParent]),
    /RuntimeOwnershipError: owns the runtime writer lease/u,
  );
});

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
        "scripts/probe-release-lifecycle.mjs",
      ],
      [
        process.execPath,
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        steps[4].args.at(-1),
      ],
    ],
  );
  assert.equal(steps[1].options.env.PLANNER_PUBLIC_BASE_PATH, "/recipe-planner/");
  assert.equal(steps[3].options.env.PLANNER_PUBLIC_BASE_PATH, "/recipe-planner/");
  assert.equal(steps[4].options.env.PLANNER_PUBLIC_BASE_PATH, "/recipe-planner/");
  assert.match(steps[4].args.at(-1), /deployProductionCandidate/u);
  assert.equal(steps.filter(({ args }) => args.includes("scripts/probe-release-lifecycle.mjs")).length, 1);
});

test("nested promotions use the same runner without recursively invoking the lifecycle probe", () => {
  const steps = releaseCommandSteps("promote", "/tmp/candidate", { PATH: "/bin" }, { includeLifecycleProbe: false });
  assert.equal(steps.some(({ args }) => args.includes("scripts/probe-release-lifecycle.mjs")), false);
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
  assert.equal(steps[0].options.env.PLANNER_PUBLIC_BASE_PATH, "/recipe-planner/");
});

test("a failed promotion gate prevents deployment and still removes the detached worktree", async () => {
  const calls = [];
  await assert.rejects(
    runDetachedMainRelease("promote", {
      execute: async (command, args, options) => {
        calls.push([command, ...args, options?.cwd]);
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

test("the callable runner owns its requested repository while preserving the cwd default", async () => {
  const calls = [];
  await runDetachedMainRelease("recover", {
    repositoryDirectory: "/tmp/pinned-clone",
    execute: async (command, args, options) => { calls.push([command, ...args, options?.cwd]); },
  });
  assert.equal(calls[0].at(-1), "/tmp/pinned-clone");
  assert.equal(calls.at(-1).at(-1), "/tmp/pinned-clone");
});

test("the private deployment adapter is import-only", async () => {
  const imported = await import("../scripts/direct-deploy.mjs");
  assert.equal(typeof imported.deployProductionCandidate, "function");
});
