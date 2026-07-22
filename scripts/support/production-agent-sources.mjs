import { cp, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PRIVATE_DIRECTORY_MODE = 0o700;

export function productionAgentPaths(home) {
  const deployRoot = join(resolve(home), "meal-planner");
  return Object.freeze({
    agents: join(deployRoot, "agent", "AGENTS.md"),
    config: join(deployRoot, "agent", "config.toml"),
    skills: join(deployRoot, "agent", ".agents", "skills"),
    agentsTarget: join(deployRoot, "app", "deployment", "codex", "AGENTS.md"),
    configTarget: join(deployRoot, "app", "deployment", "codex", "config.toml"),
    skillsTarget: join(deployRoot, "app", ".agents", "skills"),
  });
}

async function requireExactLink(label, path, expectedTarget) {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink()) {
    throw new TypeError(`${label} must remain a production symbolic link: ${path}`);
  }
  const linkTarget = await readlink(path);
  const resolvedTarget = isAbsolute(linkTarget)
    ? resolve(linkTarget)
    : resolve(dirname(path), linkTarget);
  if (resolvedTarget !== resolve(expectedTarget)) {
    throw new TypeError(`${label} points at an unexpected target: ${resolvedTarget}`);
  }
}

export async function validateProductionAgentSources(home) {
  const paths = productionAgentPaths(home);
  await Promise.all([
    requireExactLink("Production AGENTS.md", paths.agents, paths.agentsTarget),
    requireExactLink("Production config.toml", paths.config, paths.configTarget),
    requireExactLink("Production skills", paths.skills, paths.skillsTarget),
  ]);
  return paths;
}

/** Repoint the retained config link after `app` has been selected. */
export async function reconcileProductionAgentConfig(home) {
  const paths = productionAgentPaths(home);
  await mkdir(dirname(paths.config), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = join(dirname(paths.config), `.${basename(paths.config)}.${randomUUID()}.tmp`);
  await symlink(paths.configTarget, temporary);
  await rename(temporary, paths.config);
  await requireExactLink("Production config.toml", paths.config, paths.configTarget);
  return paths;
}

export async function copyPrivateDirectory(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await cp(source, temporary, { recursive: true, dereference: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}
