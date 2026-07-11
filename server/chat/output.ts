import {
  HOUSEHOLD_COMMAND_SCHEMA,
  isHouseholdCommand,
} from "../../lib/household-command-contract.ts";

export const MAX_ASSISTANT_REPLY_LENGTH = 4_000;

export const HOUSEHOLD_CHAT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "command"],
  properties: {
    reply: {
      type: "string",
      minLength: 1,
      maxLength: MAX_ASSISTANT_REPLY_LENGTH,
    },
    command: {
      anyOf: [HOUSEHOLD_COMMAND_SCHEMA, { type: "null" }],
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: string[]) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function withoutNullFields(
  value: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const normalized = { ...value };
  for (const field of fields) {
    if (normalized[field] === null) delete normalized[field];
  }
  return normalized;
}

function normalizeStepPlan(value: unknown): unknown {
  return isRecord(value)
    ? withoutNullFields(value, ["timerDurationSeconds", "note"])
    : value;
}

function normalizeGroceryPlan(value: unknown): unknown {
  return isRecord(value) ? withoutNullFields(value, ["checked"]) : value;
}

function normalizeMealPlan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = withoutNullFields(value, ["status"]);
  if (Array.isArray(normalized.instructions)) {
    normalized.instructions = normalized.instructions.map(normalizeStepPlan);
  }
  return normalized;
}

function normalizeHouseholdCommand(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.type === "addInstructionStep") {
    return { ...value, step: normalizeStepPlan(value.step) };
  }
  if (value.type === "addGroceryItem") {
    return { ...value, item: normalizeGroceryPlan(value.item) };
  }
  if (value.type === "reconcileGroceries" && Array.isArray(value.items)) {
    return {
      ...value,
      items: value.items.map((item) =>
        isRecord(item) ? withoutNullFields(item, ["id"]) : item,
      ),
    };
  }
  if (value.type === "createWeekPlan" && isRecord(value.plan)) {
    const plan = withoutNullFields(value.plan, ["weekLesson"]);
    if (Array.isArray(plan.meals)) {
      plan.meals = plan.meals.map(normalizeMealPlan);
    }
    if (Array.isArray(plan.groceries)) {
      plan.groceries = plan.groceries.map(normalizeGroceryPlan);
    }
    return { ...value, plan };
  }
  return value;
}

function unwrapJsonFence(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export function parseHouseholdAssistantOutput(text: unknown) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Codex completed without a structured response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(text));
  } catch {
    throw new Error("Codex returned invalid JSON.");
  }

  if (!hasExactKeys(parsed, ["reply", "command"]) || !isRecord(parsed)) {
    throw new Error("Codex response must contain only reply and command.");
  }
  if (
    typeof parsed.reply !== "string" ||
    parsed.reply.trim().length === 0 ||
    parsed.reply.length > MAX_ASSISTANT_REPLY_LENGTH
  ) {
    throw new Error("Codex response reply is missing or too long.");
  }
  const command =
    parsed.command === null ? null : normalizeHouseholdCommand(parsed.command);
  if (command !== null && !isHouseholdCommand(command)) {
    throw new Error("Codex returned a malformed household planner command.");
  }

  return { reply: parsed.reply.trim(), command };
}
