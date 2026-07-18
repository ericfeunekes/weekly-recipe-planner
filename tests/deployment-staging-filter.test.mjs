import assert from "node:assert/strict";
import test from "node:test";

import { shouldStageApplicationPath } from "../scripts/support/deployment-staging-filter.mjs";

const root = "/tmp/weekly-recipe-planner-release";

test("application staging excludes all project-local Codex capability sources", () => {
  for (const source of [
    "AGENTS.md",
    "AGENTS.override.md",
    "CLAUDE.md",
    ".codex/config.toml",
    ".claude/CLAUDE.md",
  ]) {
    assert.equal(shouldStageApplicationPath(`${root}/${source}`, root), false, source);
  }
});

test("application staging retains runtime code and release-owned bundles", () => {
  for (const source of [
    "app/planner-client.tsx",
    "server/index.ts",
    "deployment/codex/config.toml",
    ".agents/skills/meal-planning/SKILL.md",
  ]) {
    assert.equal(shouldStageApplicationPath(`${root}/${source}`, root), true, source);
  }
});
