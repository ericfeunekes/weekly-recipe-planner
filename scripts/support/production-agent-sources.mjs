import { chmod, cp, lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

const PRIVATE_DIRECTORY_MODE = 0o700;

export function productionAgentPaths(home = process.env.HOME ?? homedir()) {
  const canonicalHome = resolve(home);
  const deployRoot = join(canonicalHome, "meal-planner");
  const foodRoot = join(canonicalHome, "ai notes", "personal", "food");
  return Object.freeze({
    agents: join(deployRoot, "agent", "AGENTS.md"),
    config: join(deployRoot, "agent", "config.toml"),
    skills: join(deployRoot, "agent", ".agents", "skills"),
    agentsTarget: join(deployRoot, "app", "deployment", "codex", "AGENTS.md"),
    configTarget: join(deployRoot, "app", "deployment", "codex", "config.toml"),
    skillsTarget: join(deployRoot, "app", ".agents", "skills"),
    recipes: join(deployRoot, "agent", "recipes"),
    vaultFoodRoot: foodRoot,
    vaultSkills: join(foodRoot, ".agents", "skills"),
    vaultRecipes: join(foodRoot, "recipes"),
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
  await validateProductionCodexSources(home);
  await Promise.all([
    requireExactLink("Production skills", paths.skills, paths.skillsTarget),
    requireExactLink("Production recipes", paths.recipes, paths.vaultRecipes),
  ]);
  await validateProductionFoodSources(home);
  return paths;
}

/** Validate the deployment-owned files copied into the persistent dev home. */
export async function validateProductionCodexSources(home) {
  const paths = productionAgentPaths(home);
  await Promise.all([
    requireExactLink("Production AGENTS.md", paths.agents, paths.agentsTarget),
    requireExactLink("Production config.toml", paths.config, paths.configTarget),
  ]);
  return paths;
}

async function replaceLink(path, target) {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await symlink(target, temporary, "dir");
  await rename(temporary, path);
}

/** Link the selected app and retained agent paths to the Obsidian food roots. */
export async function linkProductionFoodSources(home, { appRoot } = {}) {
  const paths = productionAgentPaths(home);
  await Promise.all([
    requireDirectory("Vault food skills", paths.vaultSkills),
    requireDirectory("Vault recipes", paths.vaultRecipes),
  ]);
  if (appRoot !== undefined) {
    await replaceLink(join(resolve(appRoot), ".agents", "skills"), paths.vaultSkills);
  }
  await Promise.all([
    replaceLink(paths.skills, paths.skillsTarget),
    replaceLink(paths.recipes, paths.vaultRecipes),
  ]);
  return paths;
}

export async function validateProductionFoodSources(home, {
  appRoot,
  includeRetainedRecipes = appRoot === undefined,
} = {}) {
  const paths = productionAgentPaths(home);
  const selectedApp = appRoot === undefined ? dirname(dirname(paths.skillsTarget)) : resolve(appRoot);
  await Promise.all([
    requireDirectory("Vault food skills", paths.vaultSkills),
    requireDirectory("Vault recipes", paths.vaultRecipes),
    requireExactLink("Selected application food skills", join(selectedApp, ".agents", "skills"), paths.vaultSkills),
    ...(includeRetainedRecipes
      ? [requireExactLink("Production recipes", paths.recipes, paths.vaultRecipes)]
      : []),
  ]);
  return paths;
}

async function requireDirectory(label, path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new TypeError(`${label} must be a directory: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new TypeError(`${label} must be owned by the current user: ${path}`);
  }
}

async function requireRegularDirectoryTree(label, root) {
  await requireDirectory(label, root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await requireRegularDirectoryTree(label, path);
    } else if (!entry.isFile()) {
      throw new TypeError(`${label} cannot contain symbolic links or special files: ${path}`);
    }
  }
}

async function makeRegularDirectoryTreeReadOnly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await makeRegularDirectoryTreeReadOnly(path);
      await chmod(path, 0o500);
    } else if (entry.isFile()) {
      await chmod(path, 0o400);
    } else {
      throw new TypeError(`Captured food sources cannot contain symbolic links or special files: ${path}`);
    }
  }
  await chmod(root, 0o500);
}

async function makeDirectoryTreeWritable(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await makeDirectoryTreeWritable(path);
      await chmod(path, PRIVATE_DIRECTORY_MODE);
    } else if (entry.isFile()) {
      await chmod(path, 0o600);
    }
  }
  await chmod(root, PRIVATE_DIRECTORY_MODE);
}

/**
 * Copy exactly the food sources used by an isolated development or QA run.
 * The returned CWD deliberately holds only the captured skills link; Codex's
 * persistent auth/history/config remains in the retained development home.
 */
export async function captureFoodSourceSnapshot({ home, destinationRoot }) {
  const paths = productionAgentPaths(home);
  const snapshotRoot = resolve(destinationRoot);
  const foodRoot = join(snapshotRoot, "food");
  const temporaryFoodRoot = join(snapshotRoot, `.food.${randomUUID()}.tmp`);
  const skills = join(foodRoot, "skills");
  const recipes = join(foodRoot, "recipes");
  const appRoot = join(snapshotRoot, "codex-cwd");
  await Promise.all([
    requireRegularDirectoryTree("Vault food skills", paths.vaultSkills),
    requireRegularDirectoryTree("Vault recipes", paths.vaultRecipes),
  ]);
  await mkdir(snapshotRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    await lstat(foodRoot);
    throw new TypeError(`Food snapshot destination already exists: ${foodRoot}`);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  try {
    await mkdir(temporaryFoodRoot, { mode: PRIVATE_DIRECTORY_MODE });
    await Promise.all([
      cp(paths.vaultSkills, join(temporaryFoodRoot, "skills"), { recursive: true, errorOnExist: true }),
      cp(paths.vaultRecipes, join(temporaryFoodRoot, "recipes"), { recursive: true, errorOnExist: true }),
    ]);
    await Promise.all([
      makeRegularDirectoryTreeReadOnly(join(temporaryFoodRoot, "skills")),
      makeRegularDirectoryTreeReadOnly(join(temporaryFoodRoot, "recipes")),
    ]);
    await rename(temporaryFoodRoot, foodRoot);
  } catch (error) {
    await rm(temporaryFoodRoot, { recursive: true, force: true });
    throw error;
  }
  await mkdir(join(appRoot, ".agents"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await symlink(skills, join(appRoot, ".agents", "skills"), "dir");
  return Object.freeze({ appRoot, recipeRoot: recipes, snapshotRoot });
}

/** Remove only a run-local food snapshot, restoring permissions for cleanup. */
export async function discardFoodSourceSnapshot({ snapshotRoot }) {
  const root = resolve(snapshotRoot);
  const foodRoot = join(root, "food");
  try {
    await makeDirectoryTreeWritable(foodRoot);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await Promise.all([
    rm(foodRoot, { recursive: true, force: true }),
    rm(join(root, "codex-cwd"), { recursive: true, force: true }),
  ]);
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
