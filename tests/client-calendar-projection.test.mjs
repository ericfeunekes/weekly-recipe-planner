import assert from "node:assert/strict";
import test from "node:test";

import { isoDateForTimeZone } from "../app/calendar-time.ts";
import { plannerChatContextForView } from "../app/planner-chat-context.ts";
import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { weekContainsDate } from "../lib/household-domain.ts";

const TIME_ZONE = "America/Halifax";

function seededWeek() {
  let sequence = 0;
  const state = createCanonicalSeed({
    now: Date.parse("2026-07-06T12:00:00-03:00"),
    createId(prefix) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
  });
  return structuredClone(state.weeks[0]);
}

test("calendar projection keeps every weekday, prep, dinner, and Tonight chat aligned", () => {
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const expectedDate = `2026-07-${String(6 + dayOffset).padStart(2, "0")}`;
    const today = isoDateForTimeZone(
      Date.parse(`${expectedDate}T15:00:00.000Z`),
      TIME_ZONE,
    );
    const week = seededWeek();
    const meal = week.data.meals[0];
    meal.date = today;
    week.data.meals = [meal];
    week.data.leftovers = [];
    week.data.prep = [{
      id: `prep-${dayOffset}`,
      stepId: meal.instructions[0].id,
      prepDate: today,
      position: 0,
    }];

    assert.equal(today, expectedDate);
    assert.equal(weekContainsDate(week.id, today), true);
    assert.equal(week.data.meals.find((candidate) => candidate.date === today)?.id, meal.id);
    assert.equal(week.data.prep.find((reference) => reference.prepDate === today)?.stepId, meal.instructions[0].id);
    assert.deepEqual(plannerChatContextForView("tonight", week, today), {
      view: "tonight",
      weekId: week.id,
      mealId: meal.id,
    });
  }
});

test("calendar projection respects Halifax week and DST boundaries", () => {
  const cases = [
    ["Sunday before Monday", "2026-07-13T02:59:59.000Z", "2026-07-12"],
    ["Monday boundary", "2026-07-13T03:00:00.000Z", "2026-07-13"],
    ["before spring DST date", "2026-03-08T03:30:00.000Z", "2026-03-07"],
    ["after spring DST date", "2026-03-08T07:30:00.000Z", "2026-03-08"],
    ["before fall DST date", "2026-11-01T02:30:00.000Z", "2026-10-31"],
    ["first fall-back hour", "2026-11-01T04:30:00.000Z", "2026-11-01"],
    ["second fall-back hour", "2026-11-01T05:30:00.000Z", "2026-11-01"],
  ];
  for (const [label, instant, expectedDate] of cases) {
    assert.equal(
      isoDateForTimeZone(Date.parse(instant), TIME_ZONE),
      expectedDate,
      label,
    );
  }

  const week = seededWeek();
  const outsideWeek = isoDateForTimeZone(
    Date.parse("2026-07-13T15:00:00.000Z"),
    TIME_ZONE,
  );
  assert.equal(weekContainsDate(week.id, outsideWeek), false);
  assert.deepEqual(plannerChatContextForView("tonight", week, outsideWeek), {
    view: "tonight",
    weekId: week.id,
  });
});
