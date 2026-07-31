import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = "/private/tmp/weekly-recipe-planner-promotion.";
const stderrEvidenceLimit = 32 * 1024;
const deployCandidateExpression = [
  'import("./scripts/direct-deploy.mjs")',
  '.then(({ deployProductionCandidate }) =>',
  'deployProductionCandidate({ root: process.cwd(), environment: process.env }))',
].join("");

export function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ["inherit", "inherit", "pipe"] });
    let stderr = Buffer.alloc(0);
    child.stderr.on("data", (chunk) => {
      if (!process.stderr.write(chunk)) {
        child.stderr.pause();
        process.stderr.once("drain", () => child.stderr.resume());
      }
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > stderrEvidenceLimit) stderr = stderr.subarray(stderr.length - stderrEvidenceLimit);
    });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error([
        `${command} ${args.join(" ")} failed (${code}).`,
        stderr.toString("utf8").trim(),
      ].filter(Boolean).join("\n"))));
  });
}

export function releaseCommandSteps(mode, directory, environment = process.env, {
  includeLifecycleProbe = true,
} = {}) {
  const mountedEnvironment = {
    ...environment,
    PLANNER_PUBLIC_BASE_PATH: "/recipe-planner/",
  };
  if (mode === "recover") {
    return [{
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "scripts/recover-deployment.mjs",
      ],
      options: { cwd: directory, env: mountedEnvironment },
    }];
  }
  if (mode !== "promote") throw new TypeError(`Unsupported release command mode: ${mode}`);
  const steps = [
    { command: "npm", args: ["ci"], options: { cwd: directory, env: environment } },
    { command: "npm", args: ["test"], options: { cwd: directory, env: mountedEnvironment } },
    { command: "npm", args: ["run", "lint"], options: { cwd: directory, env: environment } },
  ];
  if (includeLifecycleProbe) {
    steps.push({
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "scripts/probe-release-lifecycle.mjs",
      ],
      options: { cwd: directory, env: mountedEnvironment },
    });
  }
  steps.push(
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
  );
  return steps;
}

export async function runDetachedMainRelease(mode, {
  execute = run,
  environment = process.env,
  repositoryDirectory = process.cwd(),
  includeLifecycleProbe = true,
} = {}) {
  const promotionDirectory = await mkdtemp(prefix);
  await rmdir(promotionDirectory);
  let releaseError = null;
  try {
    await execute("git", ["worktree", "add", "--detach", promotionDirectory, "refs/heads/main"], { cwd: repositoryDirectory });
    for (const step of releaseCommandSteps(mode, promotionDirectory, environment, { includeLifecycleProbe })) {
      await execute(step.command, step.args, step.options);
    }
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    try {
      await execute("git", ["worktree", "remove", "--force", promotionDirectory], { cwd: repositoryDirectory });
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
