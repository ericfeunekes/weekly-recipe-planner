import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportDirectory = dirname(fileURLToPath(import.meta.url));
export const fakeCodexSource = join(
  supportDirectory,
  "..",
  "..",
  "tests",
  "support",
  "fixtures",
  "codex-runtime",
  "fake-codex.mjs",
);
const schemaFixtureSource = join(
  supportDirectory,
  "..",
  "..",
  "tests",
  "support",
  "fixtures",
  "codex-runtime",
  "schema-fixtures.mjs",
);
const authSchemaFixtureSource = join(
  supportDirectory,
  "..",
  "..",
  "tests",
  "support",
  "fixtures",
  "codex-runtime",
  "auth-schema-fixtures.mjs",
);

/**
 * Repo-owned operator/test fixture that preserves the production updater path:
 * $HOME/.local/bin/codex resolves to one current-user-owned target.
 */
export async function createCodexRuntimeFixture({
  authenticated = true,
  variant = "compatible-a",
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-codex-runtime-")));
  const normalHome = join(root, "home");
  const codexHome = join(root, "agent");
  const appCwd = join(root, "app");
  const plannerDataDirectory = join(root, "data");
  const launcherPath = join(normalHome, ".local", "bin", "codex");
  const launcherTargetPath = join(normalHome, ".local", "lib", "codex-fixture.mjs");
  const schemaFixtureTarget = join(dirname(launcherTargetPath), "schema-fixtures.mjs");
  const authSchemaFixtureTarget = join(
    dirname(launcherTargetPath),
    "auth-schema-fixtures.mjs",
  );
  await Promise.all([
    mkdir(dirname(launcherPath), { recursive: true }),
    mkdir(dirname(launcherTargetPath), { recursive: true }),
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(appCwd),
    mkdir(plannerDataDirectory),
  ]);
  if (
    variant === "user-skill-readback" ||
    variant === "noncanonical-skill-path" ||
    variant === "skill-directory-readback"
  ) {
    const skillDirectory = join(normalHome, ".agents", "skills", "fixture-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Fixture skill\n", { mode: 0o600 });
  }
  if (variant === "repo-skill-readback") {
    const skillDirectory = join(appCwd, ".agents", "skills", "release-fixture-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Release fixture skill\n", { mode: 0o600 });
  }
  const fakeSource = await readFile(fakeCodexSource, "utf8");
  await Promise.all([
    cp(schemaFixtureSource, schemaFixtureTarget),
    cp(authSchemaFixtureSource, authSchemaFixtureTarget),
  ]);
  await writeFile(
    launcherTargetPath,
    fakeSource
      .replace("#!/usr/bin/env node", `#!${process.execPath}`)
      .replace(
        'const bakedFixtureVariant = "compatible-a";',
        `const bakedFixtureVariant = ${JSON.stringify(variant)};`,
      )
      .replace(
        'from "./schema-fixtures.mjs";',
        `from ${JSON.stringify(pathToFileURL(schemaFixtureTarget).href)};`,
      )
      .replace(
        'from "./auth-schema-fixtures.mjs";',
        `from ${JSON.stringify(pathToFileURL(authSchemaFixtureTarget).href)};`,
      ),
    { mode: 0o700 },
  );
  await chmod(launcherTargetPath, 0o700);
  await symlink(launcherTargetPath, launcherPath);
  await writeFile(join(codexHome, ".fixture-variant"), `${variant}\n`, { mode: 0o600 });
  await writeFile(
    join(dirname(launcherTargetPath), ".fixture-variant-global"),
    `${variant}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(codexHome, "config.toml"), [
    'model = "fake"',
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[features]',
    'apps = false',
    'plugins = false',
    'multi_agent = false',
    '',
    '[orchestrator.skills]',
    'enabled = false',
    '',
    '[orchestrator.mcp]',
    'enabled = false',
    '',
  ].join("\n"), { mode: 0o600 });
  await writeFile(
    join(codexHome, "AGENTS.md"),
    variant === "oversize-provenance"
      ? `# Embedded planner\n\n${"x".repeat((2 * 1024 * 1024) + 1)}\n`
      : "# Embedded planner\n\nNo live tools in Phase 1.\n",
    { mode: 0o600 },
  );
  if (
    variant === "same-content-instruction-substitute" ||
    variant === "instruction-symlink-escape"
  ) {
    const substitute = variant === "instruction-symlink-escape"
      ? join(root, "outside-agents.md")
      : join(codexHome, "alternate-agents.md");
    await writeFile(substitute, "# Embedded planner\n\nNo live tools in Phase 1.\n", { mode: 0o600 });
    await rm(join(codexHome, "AGENTS.md"));
    await symlink(substitute, join(codexHome, "AGENTS.md"));
  }
  if (authenticated) {
    await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  }

  return {
    root,
    normalHome,
    codexHome,
    appCwd,
    plannerDataDirectory,
    launcherPath,
    launcherTargetPath,
    environment: {
      HOME: normalHome,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      NO_PROXY: "127.0.0.1,localhost",
      PLANNER_CODEX_HOME: codexHome,
      PLANNER_CODEX_CWD: appCwd,
      PLANNER_DATA_DIR: plannerDataDirectory,
      PLANNER_SECRET_SENTINEL: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
    },
    async invocations() {
      try {
        return (await readFile(join(codexHome, ".fixture-invocations.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}
