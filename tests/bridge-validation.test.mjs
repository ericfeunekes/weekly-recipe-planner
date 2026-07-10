import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_OUTPUT_SCHEMA,
  DOMAIN_COMMAND_SCHEMA,
  MAX_MESSAGE_LENGTH,
  MAX_PREP_ENTRIES,
  isDomainCommand,
  parseStructuredAssistantOutput,
  validateChatRequest,
} from "../bridge/validation.mjs";
import {
  DOMAIN_COMMAND_SCHEMA as SHARED_DOMAIN_COMMAND_SCHEMA,
  isDomainCommand as sharedIsDomainCommand,
} from "../lib/planner-command-contract.ts";

const validCommands = [
  { type: "moveMeal", mealId: "meal-thu", targetDayIndex: 5 },
  { type: "updateMealStatus", mealId: "meal-thu", status: "cooked" },
  {
    type: "updateMealSnapshot",
    mealId: "meal-thu",
    changes: { title: "Miso salmon", venue: "Home", notes: "Serve with rice." },
  },
  { type: "toggleInstructionStep", stepId: "step-thu-rice" },
  {
    type: "updateInstructionStepNote",
    stepId: "step-thu-rice",
    note: "Use the wide pot.",
  },
  { type: "startInstructionTimer", stepId: "step-thu-rice" },
  { type: "resetInstructionTimer", stepId: "step-thu-rice" },
  {
    type: "setPrepPlan",
    entries: [
      { stepId: "step-thu-rice", due: "Sun, Jul 5" },
      { stepId: "step-fri-sauce", due: "Sun, Jul 5" },
    ],
  },
  { type: "movePrepReference", referenceId: "prep-ref-rice", targetPosition: 1 },
  {
    type: "reschedulePrepReference",
    referenceId: "prep-ref-rice",
    due: "Fri, Jul 10",
  },
  { type: "removePrepReference", referenceId: "prep-ref-rice" },
  { type: "updateGroceryItem", itemId: "grocery-limes" },
  { type: "reconcileGroceries" },
  { type: "captureFeedback", mealId: "meal-thu", value: "repeat" },
  { type: "captureWeekLesson", weekLesson: "Cook one tray early." },
  { type: "captureLeftoverQuality", leftoverId: "left-thu", quality: "good" },
  { type: "assignLeftover", leftoverId: "left-thu", dayIndex: 6 },
  { type: "consumeLeftover", leftoverId: "left-thu" },
  { type: "archiveWeek" },
  { type: "createWeekPlan" },
];

test("validator and output schema cover every current DomainCommand", () => {
  assert.equal(DOMAIN_COMMAND_SCHEMA, SHARED_DOMAIN_COMMAND_SCHEMA);
  assert.equal(isDomainCommand, sharedIsDomainCommand);
  assert.equal(validCommands.length, 20);
  for (const command of validCommands) {
    assert.equal(isDomainCommand(command), true, command.type);
  }
  assert.equal(DOMAIN_COMMAND_SCHEMA.anyOf.length, validCommands.length);
  assert.equal(CHAT_OUTPUT_SCHEMA.properties.command.anyOf[0], DOMAIN_COMMAND_SCHEMA);
  for (const variant of DOMAIN_COMMAND_SCHEMA.anyOf) {
    assert.equal(variant.properties.type.type, "string");
    assert.equal(typeof variant.properties.type.const, "string");
  }

  const variants = Object.fromEntries(
    DOMAIN_COMMAND_SCHEMA.anyOf.map((variant) => [variant.properties.type.const, variant]),
  );
  assert.equal(variants.setPrepPlan.properties.entries.maxItems, MAX_PREP_ENTRIES);
  assert.deepEqual(variants.startInstructionTimer.required, ["type", "stepId"]);
  assert.equal("startedAt" in variants.startInstructionTimer.properties, false);
});

test("DomainCommand validator rejects malformed fields, values, and extras", () => {
  const malformed = [
    null,
    {},
    { type: "notACommand" },
    { type: "moveMeal", mealId: "meal-thu", targetDayIndex: 7 },
    { type: "moveMeal", mealId: "", targetDayIndex: 2 },
    { type: "reconcileGroceries", surprise: true },
    { type: "updateMealStatus", mealId: "meal-thu", status: "burned" },
    {
      type: "updateMealSnapshot",
      mealId: "meal-thu",
      changes: { title: "", venue: "Home", notes: "" },
    },
    { type: "completePrepTask", taskId: "prep-thu" },
    { type: "reschedulePrepTask", taskId: "prep-thu", due: "Fri, Jul 10" },
    { type: "toggleInstructionStep", stepId: 42 },
    {
      type: "updateInstructionStepNote",
      stepId: "step-thu-rice",
      note: "x".repeat(4_001),
    },
    { type: "startInstructionTimer", stepId: "step-thu-rice", startedAt: 1_720_000_000_000 },
    { type: "startInstructionTimer", stepId: "" },
    { type: "moveMeal", mealId: "x".repeat(201), targetDayIndex: 2 },
    {
      type: "updateMealSnapshot",
      mealId: "meal-thu",
      changes: { title: "x".repeat(301), venue: "Home", notes: "" },
    },
    { type: "captureWeekLesson", weekLesson: "x".repeat(4_001) },
    { type: "resetInstructionTimer", stepId: "" },
    { type: "setPrepPlan", entries: "step-thu-rice" },
    {
      type: "setPrepPlan",
      entries: [
        { stepId: "step-thu-rice", due: "Sun, Jul 5" },
        { stepId: "step-thu-rice", due: "Mon, Jul 6" },
      ],
    },
    {
      type: "setPrepPlan",
      entries: Array.from({ length: MAX_PREP_ENTRIES + 1 }, (_, index) => ({
        stepId: `step-${index}`,
        due: "Sun, Jul 5",
      })),
    },
    {
      type: "setPrepPlan",
      entries: [{ stepId: "step-thu-rice", due: "", title: "Rice" }],
    },
    { type: "movePrepReference", referenceId: "prep-ref-rice", targetPosition: 64 },
    { type: "movePrepReference", referenceId: "prep-ref-rice", targetPosition: 1.5 },
    { type: "reschedulePrepReference", referenceId: "prep-ref-rice", due: "" },
    { type: "removePrepReference", referenceId: "" },
    { type: "updateGroceryItem" },
    { type: "captureFeedback", mealId: "meal-thu", value: "love" },
    { type: "captureWeekLesson", weekLesson: [], extra: true },
    { type: "captureLeftoverQuality", leftoverId: "left-thu", quality: "great" },
    { type: "assignLeftover", leftoverId: "left-thu", dayIndex: 1.5 },
    { type: "consumeLeftover", leftoverId: "left-thu", portions: 1 },
    { type: "archiveWeek", force: true },
  ];

  for (const command of malformed) {
    assert.equal(isDomainCommand(command), false, JSON.stringify(command));
  }

  assert.equal(
    isDomainCommand({ type: "updateInstructionStepNote", stepId: "step-1", note: "" }),
    true,
  );
  assert.equal(isDomainCommand({ type: "setPrepPlan", entries: [] }), true);
});

test("chat request validation normalizes recent messages and enforces limits", () => {
  const valid = validateChatRequest({
    message: "  Move salmon to Saturday.  ",
    state: { meals: [] },
    context: { view: "week" },
    messages: [
      { id: "1", role: "assistant", text: "What would you like to change?", changes: [] },
      { id: "2", role: "user", content: "The salmon night." },
    ],
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.message, "Move salmon to Saturday.");
  assert.deepEqual(valid.value.messages, [
    { role: "assistant", text: "What would you like to change?" },
    { role: "user", text: "The salmon night." },
  ]);

  assert.match(validateChatRequest([]).error, /JSON object/);
  assert.match(
    validateChatRequest({ message: "hello", state: {}, extra: true }).error,
    /Unknown request field/,
  );
  assert.match(validateChatRequest({ message: "", state: {} }).error, /message/);
  assert.match(
    validateChatRequest({ message: "x".repeat(MAX_MESSAGE_LENGTH + 1), state: {} }).error,
    /message/,
  );
  assert.match(validateChatRequest({ message: "hello", state: [] }).error, /state/);
});

test("structured output parser accepts valid JSON and rejects unsafe commands", () => {
  assert.deepEqual(
    parseStructuredAssistantOutput(
      '```json\n{"reply":"Prep is ordered.","command":{"type":"setPrepPlan","entries":[{"stepId":"step-rice","due":"Sun, Jul 5"},{"stepId":"step-sauce","due":"Sun, Jul 5"}]}}\n```',
    ),
    {
      reply: "Prep is ordered.",
      command: {
        type: "setPrepPlan",
        entries: [
          { stepId: "step-rice", due: "Sun, Jul 5" },
          { stepId: "step-sauce", due: "Sun, Jul 5" },
        ],
      },
    },
  );
  assert.deepEqual(parseStructuredAssistantOutput('{"reply":"No change.","command":null}'), {
    reply: "No change.",
    command: null,
  });

  assert.throws(
    () =>
      parseStructuredAssistantOutput(
        '{"reply":"Done.","command":{"type":"archiveWeek","force":true}}',
      ),
    /malformed planner command/,
  );
  assert.throws(
    () =>
      parseStructuredAssistantOutput(
        '{"reply":"Done.","command":{"type":"setPrepPlan","entries":[{"stepId":"step-rice","due":"Sun"},{"stepId":"step-rice","due":"Mon"}]}}',
      ),
    /malformed planner command/,
  );
  assert.throws(
    () => parseStructuredAssistantOutput('{"reply":"Done.","command":null,"debug":true}'),
    /only reply and command/,
  );
  assert.throws(
    () =>
      parseStructuredAssistantOutput(
        JSON.stringify({ reply: "x".repeat(MAX_MESSAGE_LENGTH + 1), command: null }),
      ),
    /missing or too long/,
  );
  assert.throws(() => parseStructuredAssistantOutput("not json"), /invalid JSON/);
});
