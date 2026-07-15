import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_FOLLOW_UP_ENVIRONMENT_KEYS,
  buildCodexFollowUpChildEnvironment,
  parseCodexFollowUpConfig,
  validateCodexFollowUpDeployment,
} from "../server/runtime/codex-follow-up/deployment.ts";
import { readRuntimeConfig } from "../server/runtime/config.ts";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";

test("release-managed Codex deployment inputs are loadable and capability-closed", async () => {
  const configPath = new URL("../deployment/codex/config.toml", import.meta.url);
  const instructionsPath = new URL("../deployment/codex/AGENTS.md", import.meta.url);
  const [config, instructions, configStats, instructionStats] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(instructionsPath, "utf8"),
    lstat(configPath),
    lstat(instructionsPath),
  ]);
  assert.equal(configStats.isFile() && !configStats.isSymbolicLink(), true);
  assert.equal(instructionStats.isFile() && !instructionStats.isSymbolicLink(), true);
  assert.ok(config.trim().length > 0);
  assert.ok(instructions.trim().length > 0);
  assert.match(config, /^forced_login_method = "chatgpt"$/mu);
  assert.match(config, /^cli_auth_credentials_store = "file"$/mu);
  assert.match(config, /^approval_policy = "never"$/mu);
  assert.match(config, /^sandbox_mode = "read-only"$/mu);
  assert.match(config, /^web_search = "live"$/mu);
  for (const capability of [
    "apps",
    "browser_use",
    "code_mode",
    "computer_use",
    "enable_mcp_apps",
    "multi_agent",
    "plugins",
    "request_permissions_tool",
    "shell_tool",
    "unified_exec",
  ]) {
    assert.match(config, new RegExp(`^${capability} = false$`, "mu"));
  }
  assert.match(config, /^multi_agent_v2 = true$/mu);
  assert.match(config, /^include_instructions = true$/mu);
  assert.match(config, /^\[tools\.experimental_request_user_input\]\nenabled = true$/mu);
  assert.match(config, /^\[orchestrator\.skills\]\nenabled = true$/mu);
  assert.match(config, /^\[orchestrator\.mcp\]\nenabled = false$/mu);
  assert.match(instructions, /history may contain many top-level threads/iu);
  assert.match(instructions, /selects one at a time/iu);
  assert.match(instructions, /no separate planning and research\s+modes/iu);
  assert.match(instructions, /rejects command, file, permission, and MCP approval requests/u);
  assert.doesNotMatch(config, /^\s*(?:model_provider|base_url|mcp_servers)\s*=/mu);
});

test("follow-up deployment config is nested, absolute, immutable, and fixed to HOME launcher", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const runtime = readRuntimeConfig({
    ...fixture.environment,
    PLANNER_MODE: "api",
  });
  assert.equal(runtime.codexFollowUp.ok, true);
  assert.equal(runtime.codexFollowUp.deployment.codexHome, fixture.codexHome);
  assert.equal(runtime.codexFollowUp.deployment.appCwd, fixture.appCwd);
  assert.equal(runtime.codexFollowUp.deployment.launcherPath, fixture.launcherPath);
  assert.ok(Object.isFrozen(runtime.codexFollowUp.deployment));

  const relative = parseCodexFollowUpConfig({
    HOME: fixture.normalHome,
    PLANNER_CODEX_HOME: "relative/agent",
    PLANNER_CODEX_CWD: fixture.appCwd,
  }, fixture.plannerDataDirectory);
  assert.equal(relative.ok, false);
  assert.match(relative.status.detail, /absolute path/);

  const equal = parseCodexFollowUpConfig({
    HOME: fixture.normalHome,
    PLANNER_CODEX_HOME: fixture.codexHome,
    PLANNER_CODEX_CWD: fixture.codexHome,
  }, fixture.plannerDataDirectory);
  assert.equal(equal.ok, false);
  assert.match(equal.status.detail, /must differ/);
});

test("deployment validation accepts existing private separated roots and creates only owned cache directories", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const parsed = parseCodexFollowUpConfig(fixture.environment, fixture.plannerDataDirectory);
  assert.equal(parsed.ok, true);

  const result = await validateCodexFollowUpDeployment(parsed.deployment);
  assert.equal(result.ok, true);
  assert.equal(result.deployment.codexHome, fixture.codexHome);
  assert.ok(result.deployment.schemaCacheDirectory.startsWith(fixture.codexHome));
  assert.ok(result.deployment.evidenceDirectory.startsWith(fixture.codexHome));
});

test("closed child environment includes only the declared keys and cannot select an external disposable home", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const parsed = parseCodexFollowUpConfig(fixture.environment, fixture.plannerDataDirectory);
  assert.equal(parsed.ok, true);
  const validated = await validateCodexFollowUpDeployment(parsed.deployment);
  assert.equal(validated.ok, true);

  const child = buildCodexFollowUpChildEnvironment(validated.deployment, fixture.environment);
  assert.deepEqual(
    Object.keys(child).sort(),
    CODEX_FOLLOW_UP_ENVIRONMENT_KEYS.filter((key) => child[key] !== undefined).sort(),
  );
  assert.equal(child.HOME, fixture.normalHome);
  assert.equal(child.CODEX_HOME, fixture.codexHome);
  assert.equal(child.PLANNER_SECRET_SENTINEL, undefined);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.PLANNER_DATA_DIR, undefined);

  const probeHome = join(fixture.codexHome, ".planner-runtime", "probe-test");
  const probe = buildCodexFollowUpChildEnvironment(validated.deployment, fixture.environment, {
    codexHome: probeHome,
  });
  assert.equal(probe.CODEX_HOME, probeHome);
  assert.throws(() => buildCodexFollowUpChildEnvironment(
    validated.deployment,
    fixture.environment,
    { codexHome: join(fixture.root, "outside") },
  ), /beneath the validated dedicated home/);
});

test("deployment validation rejects missing, symlinked, non-private, overlapping, and capability-bearing roots", async (t) => {
  const missingFixture = await createCodexRuntimeFixture();
  t.after(() => rm(missingFixture.root, { recursive: true, force: true }));
  const missing = parseCodexFollowUpConfig({
    ...missingFixture.environment,
    PLANNER_CODEX_HOME: join(missingFixture.root, "missing-agent"),
  }, missingFixture.plannerDataDirectory);
  assert.equal(missing.ok, true);
  assert.equal((await validateCodexFollowUpDeployment(missing.deployment)).code, "root_missing");

  const symlinkFixture = await createCodexRuntimeFixture();
  t.after(() => rm(symlinkFixture.root, { recursive: true, force: true }));
  const linkedHome = join(symlinkFixture.root, "linked-agent");
  await symlink(symlinkFixture.codexHome, linkedHome);
  const linked = parseCodexFollowUpConfig({
    ...symlinkFixture.environment,
    PLANNER_CODEX_HOME: linkedHome,
  }, symlinkFixture.plannerDataDirectory);
  assert.equal(linked.ok, true);
  assert.equal((await validateCodexFollowUpDeployment(linked.deployment)).code, "root_symlink");

  const modeFixture = await createCodexRuntimeFixture();
  t.after(() => rm(modeFixture.root, { recursive: true, force: true }));
  await chmod(modeFixture.codexHome, 0o755);
  const mode = parseCodexFollowUpConfig(modeFixture.environment, modeFixture.plannerDataDirectory);
  assert.equal(mode.ok, true);
  assert.equal((await validateCodexFollowUpDeployment(mode.deployment)).code, "codex_home_not_private");

  const overlapFixture = await createCodexRuntimeFixture();
  t.after(() => rm(overlapFixture.root, { recursive: true, force: true }));
  const nestedData = join(overlapFixture.appCwd, "data");
  await mkdir(nestedData);
  const overlap = parseCodexFollowUpConfig(overlapFixture.environment, nestedData);
  assert.equal(overlap.ok, true);
  assert.equal((await validateCodexFollowUpDeployment(overlap.deployment)).code, "root_overlap");

  const dottedNestedApp = join(overlapFixture.codexHome, "..nested-app");
  await mkdir(dottedNestedApp);
  const dottedOverlap = parseCodexFollowUpConfig({
    ...overlapFixture.environment,
    PLANNER_CODEX_CWD: dottedNestedApp,
  }, overlapFixture.plannerDataDirectory);
  assert.equal(dottedOverlap.ok, true);
  assert.equal(
    (await validateCodexFollowUpDeployment(dottedOverlap.deployment)).code,
    "root_overlap",
  );

  const linkedDataFixture = await createCodexRuntimeFixture();
  t.after(() => rm(linkedDataFixture.root, { recursive: true, force: true }));
  const linkedData = join(linkedDataFixture.root, "linked-data");
  await symlink(linkedDataFixture.codexHome, linkedData);
  const linkedDataConfig = parseCodexFollowUpConfig(
    linkedDataFixture.environment,
    linkedData,
  );
  assert.equal(linkedDataConfig.ok, true);
  const linkedDataResult = await validateCodexFollowUpDeployment(
    linkedDataConfig.deployment,
  );
  assert.equal(linkedDataResult.code, "root_symlink");
  assert.match(linkedDataResult.detail, /PLANNER_DATA_DIR/);

  const projectFixture = await createCodexRuntimeFixture();
  t.after(() => rm(projectFixture.root, { recursive: true, force: true }));
  await mkdir(join(projectFixture.appCwd, ".codex"));
  await writeFile(join(projectFixture.appCwd, ".codex", "config.toml"), "[features]\nshell_tool = true\n");
  const project = parseCodexFollowUpConfig(projectFixture.environment, projectFixture.plannerDataDirectory);
  assert.equal(project.ok, true);
  const projectResult = await validateCodexFollowUpDeployment(project.deployment);
  assert.equal(projectResult.code, "project_capability_source");
  assert.match(projectResult.detail, /\.codex\/config\.toml/);
});

test("deployment validation never follows or accepts unsafe runtime cache directories", async (t) => {
  const linkedFixture = await createCodexRuntimeFixture();
  t.after(() => rm(linkedFixture.root, { recursive: true, force: true }));
  const linkedParsed = parseCodexFollowUpConfig(
    linkedFixture.environment,
    linkedFixture.plannerDataDirectory,
  );
  assert.equal(linkedParsed.ok, true);
  const outsideRuntime = join(linkedFixture.root, "outside-runtime");
  await mkdir(outsideRuntime, { mode: 0o700 });
  await symlink(outsideRuntime, linkedParsed.deployment.runtimeDirectory);

  const linkedResult = await validateCodexFollowUpDeployment(linkedParsed.deployment);
  assert.equal(linkedResult.ok, false);
  assert.equal(linkedResult.code, "runtime_directory_failed");
  assert.match(linkedResult.detail, /symbolic link/);
  await assert.rejects(
    stat(join(outsideRuntime, "schema")),
    /ENOENT/,
    "validation must not create cache children through a symlink",
  );

  const modeFixture = await createCodexRuntimeFixture();
  t.after(() => rm(modeFixture.root, { recursive: true, force: true }));
  const modeParsed = parseCodexFollowUpConfig(
    modeFixture.environment,
    modeFixture.plannerDataDirectory,
  );
  assert.equal(modeParsed.ok, true);
  await mkdir(modeParsed.deployment.runtimeDirectory, { mode: 0o755 });
  const modeResult = await validateCodexFollowUpDeployment(modeParsed.deployment);
  assert.equal(modeResult.ok, false);
  assert.equal(modeResult.code, "runtime_directory_failed");
  assert.match(modeResult.detail, /mode 0700/);
});
