import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

export function selectTestConcurrency(available = availableParallelism()) {
  if (!Number.isSafeInteger(available) || available < 1) {
    throw new TypeError("Available test parallelism must be a positive integer.");
  }
  return Math.min(4, Math.max(1, available - 1));
}

export async function runNodeTests() {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "--test",
    `--test-concurrency=${selectTestConcurrency()}`,
    "tests/**/*.test.mjs",
  ], {
    stdio: "inherit",
    env: { ...process.env, PLANNER_PUBLIC_BASE_PATH: "/recipe-planner/" },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`Node test runner exited from signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runNodeTests();
}
