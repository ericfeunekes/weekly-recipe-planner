import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import {
  buildCanonicalPlannerPrompt,
  resolveCanonicalContext,
} from "../server/chat/prompt.ts";

const NOW = Date.parse("2026-07-10T12:00:00-03:00");

function workspaceWithLeftover() {
  let id = 0;
  const commandContext = {
    now: NOW,
    createId(prefix) {
      id += 1;
      return `${prefix}-${id}`;
    },
  };
  let state = createCanonicalSeed(commandContext);
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  assert.ok(week);
  const sourceMeal = week.data.meals[0];
  const result = householdDomain.execute(
    state,
    {
      type: "updateMealStatus",
      weekId: week.id,
      mealId: sourceMeal.id,
      status: "cooked",
    },
    commandContext,
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  state = result.state;
  const leftoverId = result.createdIds.leftoverId;
  assert.ok(leftoverId);
  return {
    leftoverId,
    workspace: {
      initialized: true,
      schemaVersion: 1,
      plannerVersion: 1,
      syncRevision: 1,
      state,
      events: [],
      transcriptEntries: [],
      chatTurns: [],
    },
  };
}

test("canonical chat context resolves an exact leftover reference", () => {
  const { leftoverId, workspace } = workspaceWithLeftover();
  const weekId = workspace.state.activeWeekId;
  assert.ok(weekId);
  const context = { view: "tonight", weekId, leftoverId };

  const resolved = resolveCanonicalContext(workspace, context);
  assert.ok(resolved);
  assert.equal(resolved.selectedMealId, null);
  assert.equal(resolved.selectedStepId, null);
  assert.equal(resolved.selectedLeftoverId, leftoverId);

  assert.equal(
    resolveCanonicalContext(workspace, {
      view: "tonight",
      weekId,
      leftoverId: "missing-leftover",
    }),
    null,
  );

  const prompt = buildCanonicalPlannerPrompt({
    workspace,
    context,
    transcriptEntries: [],
    userEntryId: "entry-1",
    userText: "What should I serve with these leftovers?",
  });
  const match = prompt.match(
    /<canonical_planner_context>\n(.+)\n<\/canonical_planner_context>/,
  );
  assert.ok(match);
  const canonical = JSON.parse(match[1]);
  assert.equal(canonical.selectedLeftoverId, leftoverId);
  assert.equal(canonical.selectedMealId, null);
  assert.equal(canonical.selectedStepId, null);
});
