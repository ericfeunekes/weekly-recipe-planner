import { copyFile, chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  validateProductionCodexSources,
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
 * are copied so local testing cannot mutate or replace production links. Food
 * skills and recipes are instead captured into a new per-run CWD by the
 * caller. Promoting local changes back to production remains a manual release.
 */
export async function prepareDevelopmentCodexHome({
  home = process.env.HOME ?? homedir(),
} = {}) {
  const canonicalHome = resolve(home);
  const production = await validateProductionCodexSources(canonicalHome);
  const developmentRoot = join(canonicalHome, "meal-planner-dev");
  const devHome = join(developmentRoot, "agent");
  await mkdir(devHome, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(devHome, PRIVATE_DIRECTORY_MODE);
  // Earlier versions copied food skills into this persistent home. They now
  // arrive only through each run's private CWD snapshot.
  await rm(join(devHome, ".agents", "skills"), { recursive: true, force: true });
  await Promise.all([
    copyPrivateFile(production.config, join(devHome, "config.toml")),
    copyPrivateFile(production.agents, join(devHome, "AGENTS.md")),
  ]);
  return Object.freeze({ codexHome: devHome });
}
