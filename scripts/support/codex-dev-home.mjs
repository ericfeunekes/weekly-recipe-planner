import { copyFile, chmod, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  copyPrivateDirectory,
  validateProductionAgentSources,
} from "./production-agent-sources.mjs";

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
 * Materialize the one shared development Codex home from production sources.
 * Native auth/history remains in this home; release-owned config/instructions
 * and skills are copied so local testing cannot mutate or replace production
 * links. Promoting local changes back to production remains a manual release.
 */
export async function prepareDevelopmentCodexHome({
  home = process.env.HOME ?? homedir(),
} = {}) {
  const canonicalHome = resolve(home);
  const production = await validateProductionAgentSources(canonicalHome);
  const developmentRoot = join(canonicalHome, "meal-planner-dev");
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
    copyPrivateFile(production.config, join(devHome, "config.toml")),
    copyPrivateFile(production.agents, join(devHome, "AGENTS.md")),
    copyPrivateDirectory(production.skills, join(devHome, ".agents", "skills")),
  ]);
  return Object.freeze({ appRoot: devAppCwd, codexHome: devHome });
}
