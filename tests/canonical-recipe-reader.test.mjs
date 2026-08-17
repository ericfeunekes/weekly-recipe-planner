import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { isSourcedRecipeReplacement } from "../lib/sourced-recipe-contract.ts";

import {
  CANONICAL_RECIPE_FILE_BYTES_LIMIT,
  CanonicalRecipeReadError,
  readCanonicalRecipe,
} from "../server/codex/canonical-recipe-reader.ts";

const fixtureRoot = join(process.cwd(), "tests/support/fixtures/canonical-recipes");

async function scratchRoot(t) {
  await mkdir(join(process.cwd(), ".scratch"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".scratch/issue26-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("canonical reader preserves the exact current recipe snapshot and pins its revision", async () => {
  const recipe = await readCanonicalRecipe(fixtureRoot, "lemon-pepper-salmon.md");
  assert.equal(isSourcedRecipeReplacement(recipe), true);
  assert.equal(recipe.title, "Lemon Pepper Salmon");
  assert.equal(recipe.yieldText, "4");
  assert.deepEqual(recipe.occurrences, [
    {
      kind: "create", correlationId: "canonical-ingredient-1",
      source: "4 (4-6 ounce) salmon fillets", amount: "4", unit: "fillet",
      ingredient: "salmon", qualifier: "4-6 ounce", conceptId: null, canonicalIngredientId: 1,
    },
    {
      kind: "create", correlationId: "canonical-ingredient-2",
      source: "1 tablespoon minced garlic", amount: "1", unit: "tablespoon",
      ingredient: "garlic", qualifier: "minced", conceptId: null, canonicalIngredientId: 2,
    },
    {
      kind: "create", correlationId: "canonical-ingredient-3",
      source: "Salt to taste", amount: "", unit: null,
      ingredient: "salt", qualifier: "to taste", conceptId: null, canonicalIngredientId: 3,
    },
  ]);
  assert.deepEqual(recipe.steps.map((step) => ({
    refs: step.inputs.map((input) => input.occurrenceCorrelationId),
    instruction: step.instruction,
    timer: step.timerDurationSeconds ?? null,
  })), [
    { refs: [], instruction: "Preheat the oven to 400°F.", timer: null },
    { refs: ["canonical-ingredient-1", "canonical-ingredient-2", "canonical-ingredient-3"], instruction: "Rub the garlic over the salmon.", timer: null },
    { refs: ["canonical-ingredient-1"], instruction: "Bake until the salmon flakes easily.", timer: 900 },
  ]);
  assert.equal(recipe.source.kind, "canonical");
  assert.equal(
    recipe.source.revision,
    createHash("sha256").update(await readFile(join(fixtureRoot, "lemon-pepper-salmon.md"))).digest("hex"),
  );
  assert.equal(recipe.source.identity, "lemon-pepper-salmon");
  assert.equal(recipe.source.path, "lemon-pepper-salmon.md");
  assert.equal(recipe.source.provenance.sourceRef, "https://example.com/lemon-pepper-salmon");
  assert.equal(recipe.source.provenance.sourceLocator, "Recipe card");
  assert.equal(recipe.source.provenance.sourcePath, "retained/lemon-pepper-salmon.txt");
  assert.equal(recipe.source.provenance.sourceStartLine, 4);
  assert.equal(recipe.source.provenance.sourceEndLine, 28);
  assert.equal(recipe.source.provenance.sourceSha256, "a".repeat(64));
  assert.equal(recipe.source.provenance.sourceRetrievedAt, "2026-08-09");
  assert.equal(recipe.source.provenance.fidelityVerdict, "exact");
  assert.equal(recipe.source.provenance.fidelityReview, "reviews/lemon-pepper-salmon.md");
  assert.equal(recipe.source.provenance.adaptedFrom, "family/lemon-salmon");
  assert.equal(recipe.source.timeActiveMinutes, null);
  assert.equal(recipe.source.timeTotalMinutes, 30);
  assert.equal(recipe.source.notes, "- Serve with rice and roasted vegetables.\n- Butter can replace the olive oil.\n");
});

test("canonical reader rejects escape, links, directories, and oversized files at the file boundary", async (t) => {
  const root = await scratchRoot(t);
  const outside = join(root, "..", "issue26-outside.md");
  await writeFile(outside, "outside");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, "linked.md"));
  await mkdir(join(root, "directory.md"));
  await writeFile(join(root, "large.md"), Buffer.alloc(CANONICAL_RECIPE_FILE_BYTES_LIMIT + 1, 65));

  for (const path of ["../issue26-outside.md", outside, "linked.md", "directory.md", "large.md"]) {
    await assert.rejects(
      readCanonicalRecipe(root, path),
      (error) => error instanceof CanonicalRecipeReadError,
      path,
    );
  }
});

test("canonical reader follows only the configured deployed-root link and rejects nested links", async (t) => {
  const scratch = await scratchRoot(t);
  const target = join(scratch, "deployed-recipes");
  const linkedRoot = join(scratch, "recipes");
  const outside = join(scratch, "outside");
  await mkdir(target);
  await mkdir(outside);
  await copyFile(join(fixtureRoot, "lemon-pepper-salmon.md"), join(target, "lemon-pepper-salmon.md"));
  await copyFile(join(fixtureRoot, "lemon-pepper-salmon.md"), join(outside, "outside.md"));
  await symlink(target, linkedRoot);
  await symlink(outside, join(target, "nested"));
  assert.equal((await readCanonicalRecipe(linkedRoot, "lemon-pepper-salmon.md")).source.identity, "lemon-pepper-salmon");
  await assert.rejects(readCanonicalRecipe(linkedRoot, "nested/outside.md"), CanonicalRecipeReadError);
});

test("canonical reader rejects incomplete and legacy recipe schemas instead of translating them", async (t) => {
  const root = await scratchRoot(t);
  const current = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(fixtureRoot, "lemon-pepper-salmon.md"), "utf8"));
  const cases = {
    "incomplete.md": current
      .replace("id: lemon-pepper-salmon", "id: incomplete")
      .replace("fidelity-review: reviews/lemon-pepper-salmon.md", "fidelity-review:"),
    "legacy.md": current
      .replace("id: lemon-pepper-salmon", "id: legacy")
      .replace("  amount: \"4\"\n  unit: fillet\n  ingredient: salmon\n  qualifier: \"4-6 ounce\"", "  quantity: \"4\"\n  ingredient: salmon\n  preparation: \"4-6 ounce\"\n  structure-status: structured"),
    "bad-reference.md": current
      .replace("id: lemon-pepper-salmon", "id: bad-reference")
      .replace("ingredient-ids: [1, 2, 3]", "ingredient-ids: [1, 2, 9]"),
    "deep-yaml.md": current
      .replace("id: lemon-pepper-salmon", "id: deep-yaml")
      .replace("taste-tags: [bright, savory]", `taste-tags: ${"- ".repeat(2_000)}bright`),
    "flow-depth.md": current
      .replace("id: lemon-pepper-salmon", "id: flow-depth")
      .replace("taste-tags: [bright, savory]", `taste-tags: ${"[".repeat(600)}bright${"]".repeat(600)}`),
    "multiline-source.md": current
      .replace("id: lemon-pepper-salmon", "id: multiline-source")
      .replace('source: "4 (4-6 ounce) salmon fillets"', "source: |-\n    first line\n    second line"),
    "incomplete-cookbook.md": current
      .replace("id: lemon-pepper-salmon", "id: incomplete-cookbook")
      .replace("source: web", "source: cookbook")
      .replace('source-ref: "https://example.com/lemon-pepper-salmon"', "source-ref: cookbook-slug")
      .replace('source-locator: "Recipe card"', "source-locator:"),
    "invalid-time-order.md": current
      .replace("id: lemon-pepper-salmon", "id: invalid-time-order")
      .replace("time-active-min:", "time-active-min: 31"),
  };
  for (const [name, content] of Object.entries(cases)) {
    await writeFile(join(root, name), content);
    await assert.rejects(readCanonicalRecipe(root, name), CanonicalRecipeReadError, name);
  }
});

test("canonical timing preserves blank, zero, and independently optional values", async (t) => {
  const root = await scratchRoot(t);
  const current = await readFile(join(fixtureRoot, "lemon-pepper-salmon.md"), "utf8");
  const cases = {
    "both-blank.md": current
      .replace("id: lemon-pepper-salmon", "id: both-blank")
      .replace("time-total-min: 30", "time-total-min:"),
    "zero-active.md": current
      .replace("id: lemon-pepper-salmon", "id: zero-active")
      .replace("time-active-min:", "time-active-min: 0"),
    "active-only.md": current
      .replace("id: lemon-pepper-salmon", "id: active-only")
      .replace("time-active-min:", "time-active-min: 10")
      .replace("time-total-min: 30", "time-total-min:"),
  };
  for (const [name, content] of Object.entries(cases)) await writeFile(join(root, name), content);
  assert.deepEqual(
    await Promise.all(["both-blank.md", "zero-active.md", "active-only.md"].map(async (name) => {
      const recipe = await readCanonicalRecipe(root, name);
      return [recipe.source.timeActiveMinutes, recipe.source.timeTotalMinutes];
    })),
    [[null, null], [0, 30], [10, null]],
  );
});
