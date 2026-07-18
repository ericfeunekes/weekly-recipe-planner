import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";

const prefix = "/private/tmp/weekly-recipe-planner-promotion.";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(" ")} failed (${code}).`)));
  });
}

const promotionDirectory = await mkdtemp(prefix);
await rmdir(promotionDirectory);
let deployError = null;
try {
  await run("git", ["worktree", "add", "--detach", promotionDirectory, "refs/heads/main"]);
  await run("make", ["--no-print-directory", "-C", promotionDirectory, "deploy"]);
} catch (error) {
  deployError = error;
  throw error;
} finally {
  try {
    await run("git", ["worktree", "remove", "--force", promotionDirectory]);
  } catch (cleanupError) {
    if (!deployError) throw cleanupError;
  }
}
