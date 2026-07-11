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
  if (parsed.command !== null && !isHouseholdCommand(parsed.command)) {
    throw new Error("Codex returned a malformed household planner command.");
  }

  return { reply: parsed.reply.trim(), command: parsed.command };
}
