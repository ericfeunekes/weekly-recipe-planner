import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release-owned source-recipe skill withholds the unavailable workflow before web content", async () => {
  const skill = await readFile(
    new URL("../.agents/skills/recipe-discovery-import/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /source-faithful recipe import is unavailable/i);
  assert.match(skill, /do not[\s\S]*search[\s\S]*retrieve[\s\S]*external recipe\s+content/i);
  assert.match(skill, /do not call `planner\.preview` or `planner\.apply`/i);
  assert.match(skill, /informational source[\s\S]*not an attestation of source fidelity/i);
  assert.doesNotMatch(skill, /import the title|import that component|before any import applies/i);
});
