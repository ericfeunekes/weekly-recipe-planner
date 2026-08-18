import assert from "node:assert/strict";
import test from "node:test";

import { createCoreIngredientCatalogue, findIngredientCandidates, ingredientCandidateDigest } from "../lib/ingredient-catalogue.ts";

test("core catalogue supplies practical labels, vocabulary, and shopping sections", () => {
  const catalogue = createCoreIngredientCatalogue();
  assert.ok(catalogue.concepts.length >= 24);
  assert.ok(catalogue.concepts.every((concept) => concept.preferredLabel && concept.defaultSection && Array.isArray(concept.vocabulary)));
});

test("candidate results preserve order and explain exact and conservative similar matches", () => {
  const results = findIngredientCandidates(createCoreIngredientCatalogue(), [
    { correlationId: "a", amount: "2", ingredient: "scallions" },
    { correlationId: "b", amount: "1", ingredient: "red onion" },
    { correlationId: "c", amount: "1", ingredient: "red pepper" },
  ]);
  assert.deepEqual(results.map((result) => result.correlationId), ["a", "b", "c"]);
  assert.equal(results[0].candidates[0].conceptId, "green-onion");
  assert.equal(results[0].candidates[0].kind, "exact");
  assert.equal(results[1].candidates.some((candidate) => candidate.conceptId === "yellow-onion"), false);
  assert.equal(results[2].candidates.some((candidate) => candidate.conceptId === "red-onion"), false);
});

test("candidate matching explains ambiguity and abstains for unrelated food", () => {
  const catalogue = createCoreIngredientCatalogue();
  const [ambiguous, absent] = findIngredientCandidates(catalogue, [
    { correlationId: "chicken", amount: "1", ingredient: "chicken" },
    { correlationId: "fruit", amount: "1", ingredient: "dragon fruit" },
  ]);
  assert.ok(ambiguous.candidates.length >= 2);
  assert.ok(ambiguous.candidates.every(({ kind, reasons }) => kind === "similar" && reasons.length >= 1));
  assert.deepEqual(absent.candidates, []);
});

test("ordered candidate digest changes with order or literal input", () => {
  const a = { correlationId: "a", amount: "1", ingredient: "rice" };
  const b = { correlationId: "b", amount: "2", ingredient: "salt" };
  assert.notEqual(ingredientCandidateDigest([a, b]), ingredientCandidateDigest([b, a]));
  assert.notEqual(ingredientCandidateDigest([a]), ingredientCandidateDigest([{ ...a, amount: "2" }]));
});
