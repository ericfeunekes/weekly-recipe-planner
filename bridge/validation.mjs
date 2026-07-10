import {
  DOMAIN_COMMAND_SCHEMA,
  MAX_PREP_ENTRIES,
  isDomainCommand,
} from "../lib/planner-command-contract.ts";

export { DOMAIN_COMMAND_SCHEMA, MAX_PREP_ENTRIES, isDomainCommand };

export const MAX_BODY_BYTES = 160 * 1024;
export const MAX_MESSAGE_LENGTH = 4_000;
export const MAX_STATE_BYTES = 96 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_RECENT_MESSAGES = 12;

export const CHAT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "command"],
  properties: {
    reply: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
    command: {
      anyOf: [DOMAIN_COMMAND_SCHEMA, { type: "null" }],
    },
  },
};

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value, maxLength, { allowEmpty = true } = {}) {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeRecentMessages(messages) {
  if (messages === undefined) return { ok: true, value: [] };
  if (!Array.isArray(messages)) {
    return { ok: false, error: "messages must be an array when provided." };
  }
  if (messages.length > MAX_RECENT_MESSAGES) {
    return {
      ok: false,
      error: `messages may contain at most ${MAX_RECENT_MESSAGES} recent entries.`,
    };
  }

  const normalized = [];
  for (const entry of messages) {
    if (!isRecord(entry) || (entry.role !== "user" && entry.role !== "assistant")) {
      return { ok: false, error: "Each recent message needs a user or assistant role." };
    }
    const text = typeof entry.text === "string" ? entry.text : entry.content;
    if (!isBoundedString(text, MAX_MESSAGE_LENGTH, { allowEmpty: false })) {
      return {
        ok: false,
        error: `Each recent message must contain 1-${MAX_MESSAGE_LENGTH} characters.`,
      };
    }
    normalized.push({ role: entry.role, text: text.trim() });
  }

  return { ok: true, value: normalized };
}

export function validateChatRequest(value) {
  if (!isRecord(value)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !["message", "state", "context", "messages"].includes(key),
  );
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown request field: ${unknownKeys[0]}.` };
  }
  if (!isBoundedString(value.message, MAX_MESSAGE_LENGTH, { allowEmpty: false })) {
    return { ok: false, error: `message must contain 1-${MAX_MESSAGE_LENGTH} characters.` };
  }
  if (!isRecord(value.state)) {
    return { ok: false, error: "state must be a JSON object." };
  }
  if (jsonByteLength(value.state) > MAX_STATE_BYTES) {
    return { ok: false, error: `state exceeds the ${MAX_STATE_BYTES}-byte limit.` };
  }
  if (value.context !== undefined) {
    const supportedContext =
      typeof value.context === "string" ||
      Array.isArray(value.context) ||
      isRecord(value.context) ||
      value.context === null;
    if (!supportedContext || jsonByteLength(value.context) > MAX_CONTEXT_BYTES) {
      return { ok: false, error: `context must be JSON and at most ${MAX_CONTEXT_BYTES} bytes.` };
    }
  }

  const recent = normalizeRecentMessages(value.messages);
  if (!recent.ok) return recent;

  return {
    ok: true,
    value: {
      message: value.message.trim(),
      state: value.state,
      context: value.context,
      messages: recent.value,
    },
  };
}

function unwrapJsonFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export function parseStructuredAssistantOutput(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Codex completed without a structured response.");
  }

  let parsed;
  try {
    parsed = JSON.parse(unwrapJsonFence(text));
  } catch {
    throw new Error("Codex returned invalid JSON.");
  }

  if (!hasExactKeys(parsed, ["reply", "command"])) {
    throw new Error("Codex response must contain only reply and command.");
  }
  if (!isBoundedString(parsed.reply, MAX_MESSAGE_LENGTH, { allowEmpty: false })) {
    throw new Error("Codex response reply is missing or too long.");
  }
  if (parsed.command !== null && !isDomainCommand(parsed.command)) {
    throw new Error("Codex returned a malformed planner command.");
  }

  return { reply: parsed.reply.trim(), command: parsed.command };
}
