import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepareDevelopmentCodexHome } from "../scripts/support/codex-dev-home.mjs";
import {
  captureFoodSourceSnapshot,
  discardFoodSourceSnapshot,
  linkProductionFoodSources,
  productionAgentPaths,
  validateProductionAgentSources,
  validateProductionFoodSources,
} from "../scripts/support/production-agent-sources.mjs";

async function createProductionAgentFixture() {
  const home = await mkdtemp(join(tmpdir(), "planner-agent-sources-"));
  const paths = productionAgentPaths(home);
  await mkdir(join(home, "meal-planner", "agent", ".agents"), { recursive: true });
  await mkdir(join(home, "meal-planner", "app"), { recursive: true });
  await mkdir(dirname(paths.agentsTarget), { recursive: true });
  await mkdir(paths.vaultSkills, { recursive: true });
  await mkdir(paths.vaultRecipes, { recursive: true });
  await writeFile(paths.configTarget, "config-v1\n");
  await writeFile(paths.agentsTarget, "agents-v1\n");
  await writeFile(join(paths.vaultSkills, "SKILL.md"), "skill-v1\n");
  await writeFile(join(paths.vaultRecipes, "recipe.md"), "recipe-v1\n");
  await symlink(paths.agentsTarget, paths.agents);
  await symlink(paths.configTarget, paths.config);
  await linkProductionFoodSources(home, { appRoot: join(home, "meal-planner", "app") });
  return { home, paths };
}

test("development Codex home copies resolved instructions but retains no food sources", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const development = await prepareDevelopmentCodexHome({ home: fixture.home });
  const developmentAgents = join(development.codexHome, "AGENTS.md");

  assert.equal((await lstat(developmentAgents)).isSymbolicLink(), false);
  assert.equal(await readFile(developmentAgents, "utf8"), "agents-v1\n");
  assert.equal(await readFile(join(development.codexHome, "config.toml"), "utf8"), "config-v1\n");
  await assert.rejects(lstat(join(development.codexHome, ".agents", "skills")), { code: "ENOENT" });

  await writeFile(developmentAgents, "local-only\n");
  assert.equal(await readFile(fixture.paths.agentsTarget, "utf8"), "agents-v1\n");

  await writeFile(fixture.paths.agentsTarget, "agents-v2\n");
  await writeFile(fixture.paths.configTarget, "config-v2\n");
  await writeFile(join(development.codexHome, "auth.json"), "auth-sentinel\n");
  await prepareDevelopmentCodexHome({ home: fixture.home });
  assert.equal(await readFile(developmentAgents, "utf8"), "agents-v2\n");
  assert.equal(await readFile(join(development.codexHome, "config.toml"), "utf8"), "config-v2\n");
  assert.equal(await readFile(join(development.codexHome, "auth.json"), "utf8"), "auth-sentinel\n");
});

test("development Codex home does not require production food links", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  await rm(fixture.paths.skills);
  await rm(fixture.paths.recipes);
  await rm(fixture.paths.skillsTarget, { recursive: true });

  const development = await prepareDevelopmentCodexHome({ home: fixture.home });
  assert.equal(await readFile(join(development.codexHome, "AGENTS.md"), "utf8"), "agents-v1\n");
});

test("development setup removes the retired persistent food-skill copy", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const staleSkill = join(fixture.home, "meal-planner-dev", "agent", ".agents", "skills", "SKILL.md");
  await mkdir(dirname(staleSkill), { recursive: true });
  await writeFile(staleSkill, "stale\n");

  const development = await prepareDevelopmentCodexHome({ home: fixture.home });
  await assert.rejects(lstat(join(development.codexHome, ".agents", "skills")), { code: "ENOENT" });
});

test("food snapshot is isolated and exposes skills only from its fresh Codex cwd", async (t) => {
  const fixture = await createProductionAgentFixture();
  const runRoot = join(fixture.home, "qa-run");
  t.after(async () => {
    await discardFoodSourceSnapshot({ snapshotRoot: runRoot });
    await rm(fixture.home, { recursive: true, force: true });
  });

  const snapshot = await captureFoodSourceSnapshot({ home: fixture.home, destinationRoot: runRoot });
  assert.equal(await readlink(join(snapshot.appRoot, ".agents", "skills")), join(runRoot, "food", "skills"));
  assert.equal(await readFile(join(snapshot.recipeRoot, "recipe.md"), "utf8"), "recipe-v1\n");
  assert.equal((await lstat(join(snapshot.recipeRoot, "recipe.md"))).mode & 0o777, 0o400);
  await assert.rejects(writeFile(join(snapshot.recipeRoot, "recipe.md"), "changed\n"), { code: "EACCES" });
  await writeFile(join(fixture.paths.vaultRecipes, "recipe.md"), "recipe-v2\n");
  assert.equal(await readFile(join(snapshot.recipeRoot, "recipe.md"), "utf8"), "recipe-v1\n");
});

test("production agent source validation rejects files and retargeted links", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  await rm(fixture.paths.agents);
  await writeFile(fixture.paths.agents, "not-a-link\n");
  await assert.rejects(
    validateProductionAgentSources(fixture.home),
    /must remain a production symbolic link/,
  );

  await rm(fixture.paths.agents);
  await symlink(fixture.paths.agentsTarget, fixture.paths.agents);
  await rm(fixture.paths.skills);
  await symlink(join(fixture.home, "unexpected-skills"), fixture.paths.skills);
  await assert.rejects(
    validateProductionAgentSources(fixture.home),
    /points at an unexpected target/,
  );
});

test("food validation rejects a selected application link that is retargeted", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  await rm(fixture.paths.skillsTarget);
  await symlink(join(fixture.home, "unexpected-skills"), fixture.paths.skillsTarget);
  await assert.rejects(validateProductionFoodSources(fixture.home), /unexpected target/);
});

test("production config is atomically reconciled to the selected app", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const { reconcileProductionAgentConfig } = await import("../scripts/support/production-agent-sources.mjs");

  await rm(fixture.paths.config);
  await writeFile(fixture.paths.config, "stale retained config\n");
  await reconcileProductionAgentConfig(fixture.home);

  assert.equal((await lstat(fixture.paths.config)).isSymbolicLink(), true);
  assert.equal(await readFile(fixture.paths.config, "utf8"), "config-v1\n");
  await validateProductionAgentSources(fixture.home);
});
