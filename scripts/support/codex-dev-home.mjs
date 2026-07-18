import { copyFile, chmod, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

async function copyPrivateFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await copyFile(source, temporary);
  await chmod(temporary, PRIVATE_FILE_MODE);
  const handle = await open(temporary, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, destination);
}

/**
 * Materialize the one shared development Codex home from the current worktree.
 * Native auth/history remains in this home; release-owned config/instructions
 * are refreshed every time a worktree runtime starts.
 */
export async function prepareDevelopmentCodexHome({
  appRoot = process.cwd(),
  home = process.env.HOME ?? homedir(),
} = {}) {
  const canonicalAppRoot = resolve(appRoot);
  const developmentRoot = join(resolve(home), "meal-planner-dev");
  const devHome = join(developmentRoot, "agent");
  const devAppCwd = join(developmentRoot, "app");
  await mkdir(devHome, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(devHome, PRIVATE_DIRECTORY_MODE);
  // Codex validates that its fixed cwd cannot contribute configuration or
  // instructions. Keep one persistent empty cwd next to the shared dev home;
  // using the checkout itself makes its repository AGENTS.md an undeclared
  // capability source and leaves both dev and QA unavailable.
  await mkdir(devAppCwd, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(devAppCwd, PRIVATE_DIRECTORY_MODE);
  await Promise.all([
    copyPrivateFile(join(canonicalAppRoot, "deployment", "codex", "config.toml"), join(devHome, "config.toml")),
    copyPrivateFile(join(canonicalAppRoot, "deployment", "codex", "AGENTS.md"), join(devHome, "AGENTS.md")),
  ]);
  return Object.freeze({ appRoot: devAppCwd, codexHome: devHome });
}
