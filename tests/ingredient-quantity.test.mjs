import assert from "node:assert/strict";
import test from "node:test";

import { formatIngredientQuantity, sumIngredientQuantities } from "../lib/ingredient-quantity.ts";

test("ingredient quantity sums exact integer, decimal, and fractional compatible amounts", () => {
  const rice = sumIngredientQuantities(["1 cup", "1/2 cup"]);
  assert.equal(rice.ok, true);
  assert.equal(rice.ok && rice.display, "1 1/2 cups");

  const decimal = sumIngredientQuantities(["0.25 L", "0.75 L"]);
  assert.equal(decimal.ok, true);
  assert.equal(decimal.ok && decimal.display, "1 L");

  const converted = sumIngredientQuantities(["500 g", "0.5 kg"]);
  assert.equal(converted.ok, true);
  assert.equal(converted.ok && converted.display, "1000 g");
});

test("ingredient quantity supports a deliberately small compatible-unit table", () => {
  const volume = sumIngredientQuantities(["1 tbsp", "1 tsp"]);
  assert.equal(volume.ok, true);
  assert.equal(volume.ok && volume.display, "20 mL");

  const mass = sumIngredientQuantities(["1 kg", "500 g"]);
  assert.equal(mass.ok, true);
  assert.equal(mass.ok && mass.display, "1500 g");

  const fluidOunces = sumIngredientQuantities(["1 fl oz", "2 fl oz"]);
  assert.equal(fluidOunces.ok, true);
  assert.equal(fluidOunces.ok && fluidOunces.display, "3 fl oz");
});

test("ingredient quantity abstains instead of throwing on unsafe input or arithmetic", () => {
  const huge = "9".repeat(300);
  assert.doesNotThrow(() => sumIngredientQuantities([`${huge} cups`, "1 cup"]));
  assert.deepEqual(sumIngredientQuantities([`${huge} cups`, "1 cup"]), { ok: false, reason: "unparseable" });
  assert.deepEqual(sumIngredientQuantities([`${Number.MAX_SAFE_INTEGER} kg`, `${Number.MAX_SAFE_INTEGER} kg`]), {
    ok: false,
    reason: "overflow",
  });
});

test("ingredient quantity abstains from incompatible, missing, modified, and raw/cooked literals", () => {
  for (const [amounts, reason] of [
    [["1 cup", "100 g"], "incompatible-unit"],
    [["1", "1 cup"], "missing-unit"],
    [["1 bunch", "1 cup"], "unparseable"],
    [["1 cup cooked", "1 cup"], "unparseable"],
    [["1-2 cups", "1 cup"], "unparseable"],
  ]) {
    assert.deepEqual(sumIngredientQuantities(amounts), { ok: false, reason });
  }
});

test("ingredient quantity formats deterministic Canadian-English mixed fractions", () => {
  assert.equal(
    formatIngredientQuantity({ numerator: 3, denominator: 2 }, "cup"),
    "1 1/2 cups",
  );
  assert.equal(
    formatIngredientQuantity({ numerator: 1, denominator: 1 }, "tbsp"),
    "1 tbsp",
  );
});
