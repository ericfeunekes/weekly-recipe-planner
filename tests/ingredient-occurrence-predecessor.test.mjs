import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { INGREDIENT_OCCURRENCE_PREDECESSOR } from "../scripts/probe-ingredient-occurrence-predecessor.mjs";

test("the exact predecessor rejects a schema-10 occurrence store without mutation or artifacts", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "scripts/probe-ingredient-occurrence-predecessor.mjs",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  const proof = JSON.parse(output);
  assert.equal(proof.predecessorCommit, INGREDIENT_OCCURRENCE_PREDECESSOR);
  assert.notEqual(proof.predecessorExitStatus, 0);
  assert.match(proof.databaseSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(proof.artifactInventory.map(({ name }) => name), ["candidate-schema10.sqlite"]);
});
