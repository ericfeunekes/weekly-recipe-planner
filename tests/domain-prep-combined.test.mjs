import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { addIsoDateDays, householdDomain } from "../lib/household-domain.ts";

const NOW = Date.parse("2026-07-10T12:00:00-03:00");

function createContext() {
  const counts = new Map();
  return {
    now: NOW,
    createId(prefix) {
      const count = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, count);
      return `${prefix}-${count}`;
    },
  };
}

function accepted(result) {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  return result;
}

function activeWeek(state) {
  return state.weeks.find((week) => week.id === state.activeWeekId);
}

test("combined Prep entries replace direct references across dates and expand in place", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  let week = activeWeek(state);
  const [firstStep, secondStep] = week.data.meals[0].instructions;
  const earlierDate = addIsoDateDays(week.id, -2);

  state = accepted(householdDomain.execute(state, {
    type: "addPrepStepsToDate",
    weekId: week.id,
    prepDate: earlierDate,
    stepIds: [firstStep.id],
    targetPosition: 0,
  }, context)).state;
  state = accepted(householdDomain.execute(state, {
    type: "addPrepStepsToDate",
    weekId: week.id,
    prepDate: week.id,
    stepIds: [secondStep.id],
    targetPosition: 0,
  }, context)).state;

  const combined = accepted(householdDomain.execute(state, {
    type: "combinePrepStepsOnDate",
    weekId: week.id,
    prepDate: earlierDate,
    sourceStepIds: [firstStep.id, secondStep.id],
    instruction: "Prepare the shared rice batch.",
    targetPosition: 1,
  }, context));
  state = combined.state;
  week = activeWeek(state);
  const combinedSession = week.data.prepSessions.find((session) => session.steps.some((entry) => entry.id === combined.createdIds.combinedPrepEntryId));
  assert.ok(combinedSession);
  const combinedEntry = combinedSession.steps.find((entry) => entry.id === combined.createdIds.combinedPrepEntryId);
  assert.deepEqual(combinedEntry, {
    id: combined.createdIds.combinedPrepEntryId,
    kind: "combined",
    sources: [firstStep, secondStep].map((step) => ({
      stepId: step.id,
      ingredientIds: [...new Set(step.inputs.map((input) => input.ingredientId))],
    })),
    instruction: "Prepare the shared rice batch.",
    complete: false,
    needsReview: false,
  });
  assert.equal(
    week.data.prepSessions.some((session) => session.steps.some((entry) => "stepId" in entry && [firstStep.id, secondStep.id].includes(entry.stepId))),
    false,
    "all direct references for combined sources are removed across dates",
  );

  const directConflict = householdDomain.execute(state, {
    type: "addPrepStepsToDate",
    weekId: week.id,
    prepDate: week.id,
    stepIds: [firstStep.id],
    targetPosition: 0,
  }, context);
  assert.equal(directConflict.ok, false);
  assert.match(directConflict.message, /already owns/i);

  state = accepted(householdDomain.execute(state, {
    type: "expandCombinedPrepStep",
    weekId: week.id,
    entryId: combined.createdIds.combinedPrepEntryId,
    discardFulfillment: false,
  }, context)).state;
  const expandedSession = activeWeek(state).data.prepSessions.find((session) => session.prepDate === earlierDate);
  const expandedEntries = expandedSession.steps.filter((entry) => "stepId" in entry && [firstStep.id, secondStep.id].includes(entry.stepId));
  assert.deepEqual(expandedEntries.map((entry) => entry.stepId), [firstStep.id, secondStep.id]);
});

test("completed combined Prep work requires explicit discard and source edits require review", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  let week = activeWeek(state);
  const [firstStep, secondStep] = week.data.meals[0].instructions;
  const prepDate = addIsoDateDays(week.id, -1);
  const combined = accepted(householdDomain.execute(state, {
    type: "combinePrepStepsOnDate",
    weekId: week.id,
    prepDate,
    sourceStepIds: [firstStep.id, secondStep.id],
    instruction: "Prepare the shared batch.",
    targetPosition: 0,
  }, context));
  state = combined.state;
  const entryId = combined.createdIds.combinedPrepEntryId;

  state = accepted(householdDomain.execute(state, {
    type: "setCombinedPrepStepComplete",
    weekId: week.id,
    entryId,
    complete: true,
  }, context)).state;
  const blockedEdit = householdDomain.execute(state, {
    type: "updateCombinedPrepStep",
    weekId: week.id,
    entryId,
    instruction: "Prepare the revised batch.",
  }, context);
  assert.equal(blockedEdit.ok, false);
  assert.match(blockedEdit.message, /discarding/i);
  const blockedRemove = householdDomain.execute(state, {
    type: "removePrepStepsFromDate",
    weekId: week.id,
    prepDate,
    entryIds: [entryId],
  }, context);
  assert.equal(blockedRemove.ok, false);

  state = accepted(householdDomain.execute(state, {
    type: "updateCombinedPrepStep",
    weekId: week.id,
    entryId,
    instruction: "Prepare the revised batch.",
    discardFulfillment: true,
  }, context)).state;
  let entry = activeWeek(state).data.prepSessions[0].steps[0];
  assert.equal(entry.complete, false);
  assert.equal(entry.needsReview, false);

  const currentFirst = activeWeek(state).data.meals[0].instructions.find((step) => step.id === firstStep.id);
  state = accepted(householdDomain.execute(state, {
    type: "updateInstructionStep",
    weekId: week.id,
    stepId: firstStep.id,
    changes: {
      inputs: currentFirst.inputs.map((input) => ({ amount: `${input.amount} extra`, ingredient: input.ingredient })),
      instruction: currentFirst.instruction,
      timerDurationSeconds: currentFirst.timerDurationSeconds ?? null,
    },
  }, context)).state;
  entry = activeWeek(state).data.prepSessions[0].steps[0];
  assert.equal(entry.complete, false);
  assert.equal(entry.needsReview, true);
  const blockedComplete = householdDomain.execute(state, {
    type: "setCombinedPrepStepComplete",
    weekId: week.id,
    entryId,
    complete: true,
  }, context);
  assert.equal(blockedComplete.ok, false);
  assert.match(blockedComplete.message, /review/i);

  state = accepted(householdDomain.execute(state, {
    type: "updateCombinedPrepStep",
    weekId: week.id,
    entryId,
    instruction: "Prepare the revised batch after reviewing sources.",
  }, context)).state;
  assert.equal(activeWeek(state).data.prepSessions[0].steps[0].needsReview, false);
});
