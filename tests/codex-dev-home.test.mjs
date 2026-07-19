import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepareDevelopmentCodexHome } from "../scripts/support/codex-dev-home.mjs";
import {
  productionAgentPaths,
  validateProductionAgentSources,
} from "../scripts/support/production-agent-sources.mjs";

async function createProductionAgentFixture() {
  const home = await mkdtemp(join(tmpdir(), "planner-agent-sources-"));
  const paths = productionAgentPaths(home);
  await mkdir(join(home, "meal-planner", "agent", ".agents"), { recursive: true });
  await mkdir(paths.skillsTarget, { recursive: true });
  await mkdir(dirname(paths.agentsTarget), { recursive: true });
  await writeFile(paths.config, "config-v1\n");
  await writeFile(paths.agentsTarget, "agents-v1\n");
  await writeFile(join(paths.skillsTarget, "SKILL.md"), "skill-v1\n");
  await symlink(paths.agentsTarget, paths.agents);
  await symlink(paths.skillsTarget, paths.skills);
  return { home, paths };
}

test("development Codex home copies resolved production instructions and skills", async (t) => {
  const fixture = await createProductionAgentFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const development = await prepareDevelopmentCodexHome({ home: fixture.home });
  const developmentAgents = join(development.codexHome, "AGENTS.md");
  const developmentSkills = join(development.codexHome, ".agents", "skills");

  assert.equal((await lstat(developmentAgents)).isSymbolicLink(), false);
  assert.equal((await lstat(developmentSkills)).isSymbolicLink(), false);
  assert.equal(await readFile(developmentAgents, "utf8"), "agents-v1\n");
  assert.equal(await readFile(join(developmentSkills, "SKILL.md"), "utf8"), "skill-v1\n");

  await writeFile(developmentAgents, "local-only\n");
  await writeFile(join(developmentSkills, "SKILL.md"), "local-skill\n");
  assert.equal(await readFile(fixture.paths.agentsTarget, "utf8"), "agents-v1\n");
  assert.equal(await readFile(join(fixture.paths.skillsTarget, "SKILL.md"), "utf8"), "skill-v1\n");

  await writeFile(fixture.paths.agentsTarget, "agents-v2\n");
  await writeFile(join(fixture.paths.skillsTarget, "SKILL.md"), "skill-v2\n");
  await prepareDevelopmentCodexHome({ home: fixture.home });
  assert.equal(await readFile(developmentAgents, "utf8"), "agents-v2\n");
  assert.equal(await readFile(join(developmentSkills, "SKILL.md"), "utf8"), "skill-v2\n");
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
