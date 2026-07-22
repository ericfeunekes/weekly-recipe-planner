import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = "/private/tmp/weekly-recipe-planner-promotion.";
const deployCandidateExpression = [
  'import("./scripts/direct-deploy.mjs")',
  '.then(({ deployProductionCandidate }) =>',
  'deployProductionCandidate({ root: process.cwd(), environment: process.env }))',
].join("");

export function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(" ")} failed (${code}).`)));
  });
}

export function releaseCommandSteps(mode, directory, environment = process.env) {
  if (mode === "recover") {
    return [{
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "scripts/recover-deployment.mjs",
      ],
      options: { cwd: directory, env: environment },
    }];
  }
  if (mode !== "promote") throw new TypeError(`Unsupported release command mode: ${mode}`);
  const mountedEnvironment = {
    ...environment,
    PLANNER_PUBLIC_BASE_PATH: "/recipe-planner/",
  };
  return [
    { command: "npm", args: ["ci"], options: { cwd: directory, env: environment } },
    { command: "npm", args: ["test"], options: { cwd: directory, env: mountedEnvironment } },
    { command: "npm", args: ["run", "lint"], options: { cwd: directory, env: environment } },
    {
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        deployCandidateExpression,
      ],
      options: { cwd: directory, env: mountedEnvironment },
    },
  ];
}

export async function runDetachedMainRelease(mode, {
  execute = run,
  environment = process.env,
} = {}) {
  const promotionDirectory = await mkdtemp(prefix);
  await rmdir(promotionDirectory);
  let releaseError = null;
  try {
    await execute("git", ["worktree", "add", "--detach", promotionDirectory, "refs/heads/main"]);
    for (const step of releaseCommandSteps(mode, promotionDirectory, environment)) {
      await execute(step.command, step.args, step.options);
    }
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    try {
      await execute("git", ["worktree", "remove", "--force", promotionDirectory]);
    } catch (cleanupError) {
      if (!releaseError) throw cleanupError;
    }
  }
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const releaseArguments = process.argv.slice(2);
  if (
    releaseArguments.length > 1 ||
    (releaseArguments.length === 1 && releaseArguments[0] !== "--recover")
  ) {
    throw new TypeError("Usage: node scripts/promote.mjs [--recover]");
  }
  const mode = releaseArguments[0] === "--recover" ? "recover" : "promote";
  await runDetachedMainRelease(mode);
}
