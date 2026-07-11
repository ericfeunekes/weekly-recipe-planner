import assert from "node:assert/strict";
import test from "node:test";

import {
  HOUSEHOLD_CHAT_OUTPUT_SCHEMA,
  parseHouseholdAssistantOutput,
} from "../server/chat/output.ts";

function assertStrictObjectSchemas(value, path = "schema") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStrictObjectSchemas(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;

  if (value.type === "object" && value.additionalProperties === false) {
    const properties = Object.keys(value.properties ?? {}).sort();
    const required = [...(value.required ?? [])].sort();
    assert.deepEqual(required, properties, `${path} must require every declared property`);
  }
  for (const [key, child] of Object.entries(value)) {
    assertStrictObjectSchemas(child, `${path}.${key}`);
  }
}

test("Codex output schema satisfies strict required-property rules recursively", () => {
  assertStrictObjectSchemas(HOUSEHOLD_CHAT_OUTPUT_SCHEMA);
});

test("nullable structured-output fields normalize to omitted command optionals", () => {
  const parsed = parseHouseholdAssistantOutput(JSON.stringify({
    reply: "Added the instruction.",
    command: {
      type: "addInstructionStep",
      weekId: "2026-07-06",
      mealId: "meal-1",
      position: 0,
      step: {
        inputs: [{ amount: "1 cup", ingredient: "rice" }],
        instruction: "Rinse the rice.",
        timerDurationSeconds: null,
        note: null,
      },
    },
  }));

  assert.deepEqual(parsed.command, {
    type: "addInstructionStep",
    weekId: "2026-07-06",
    mealId: "meal-1",
    position: 0,
    step: {
      inputs: [{ amount: "1 cup", ingredient: "rice" }],
      instruction: "Rinse the rice.",
    },
  });
});
