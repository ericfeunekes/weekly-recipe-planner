import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RECOVERABLE_EVENTS,
  migrateChatMessages,
  migrateEventHistory,
} from "../lib/planner-history.ts";
import { migrateStoredPlannerData } from "../lib/planner-persistence.ts";

function seededPlanner() {
  return {
    meals: [
      {
        id: "meal-thu",
        dayIndex: 3,
        title: "Miso salmon",
        subtitle: "Rice bowl",
        venue: "Home",
        status: "planned",
        protein: "salmon",
        prepNote: "Cook rice",
        leftoverNote: "Reserve two portions",
        notes: "Keep cucumber crisp.",
        ingredients: ["2 cups jasmine rice"],
        instructions: [
          {
            id: "meal-thu-rice",
            inputs: [
              { amount: "2 cups", ingredient: "jasmine rice" },
              { amount: "3 cups", ingredient: "water" },
            ],
            instruction: "Cook the rice until tender.",
            complete: false,
            timerDurationSeconds: 18 * 60,
          },
        ],
      },
    ],
    prep: [
      {
        id: "prep-rice",
        stepId: "meal-thu-rice",
        due: "Sun, Jul 5",
        position: 0,
      },
    ],
    groceries: [
      {
        id: "grocery-rice",
        section: "Pantry",
        item: "Jasmine rice",
        detail: "2 cups",
        checked: false,
        farmBox: false,
      },
    ],
    leftovers: [
      {
        id: "leftover-seed",
        sourceMealId: "meal-thu",
        label: "Seeded salmon",
        portions: 2,
        state: "available",
      },
    ],
    farmBoxReconciled: true,
    weekArchived: false,
    draftReady: true,
    feedback: { "meal-thu": "repeat" },
    weekLesson: "Keep one flexible dinner.",
  };
}

test("migrates V1 event attribution and its nested planner snapshot", () => {
  const legacyBefore = {
    meals: [{ id: "meal-thu", instructions: ["Cook the rice."] }],
    prep: [{ id: "prep-rice", due: "Sat, Jul 11", complete: true }],
  };

  const events = migrateEventHistory(
    [
      {
        id: "event-1",
        actor: "You",
        command: "completePrepTask",
        summary: "Finished rice",
        target: "prep-rice",
        changes: ["Marked complete", 42],
        before: legacyBefore,
        time: "Yesterday, 4:30 p.m.",
      },
    ],
    (snapshot) => migrateStoredPlannerData(snapshot, seededPlanner()),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "Household");
  assert.deepEqual(events[0].changes, ["Marked complete"]);
  assert.equal(events[0].before.meals[0].instructions[0].instruction, "Cook the rice until tender.");
  assert.equal(events[0].before.meals[0].instructions[0].complete, true);
  assert.equal(events[0].before.prep[0].stepId, "meal-thu-rice");
  assert.equal(events[0].before.prep[0].due, "Sat, Jul 11");
});

test("preserves Codex attribution and discards malformed history entries", () => {
  const events = migrateEventHistory(
    [
      {
        id: "event-2",
        actor: "Codex",
        command: "setPrepPlan",
        summary: "Built prep plan",
        target: "prep-plan",
        changes: [],
        time: "Today, 10:00 a.m.",
      },
      { id: "missing-required-fields" },
      null,
    ],
    () => seededPlanner(),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "Codex");
  assert.equal(events[0].before, undefined);
});

test("drops dangling or duplicate prep references while normalizing stored order", () => {
  const migrated = migrateStoredPlannerData(
    {
      meals: seededPlanner().meals,
      prep: [
        { id: "dangling", stepId: "missing-step", due: "Sun, Jul 5", position: 0 },
        { id: "kept", stepId: "meal-thu-rice", due: "Sat, Jul 11", position: 4 },
        { id: "duplicate", stepId: "meal-thu-rice", due: "Sun, Jul 12", position: 9 },
      ],
    },
    seededPlanner(),
  );

  assert.deepEqual(migrated.prep, [
    { id: "kept", stepId: "meal-thu-rice", due: "Sat, Jul 11", position: 0 },
  ]);
});

test("falls back safely from malformed parseable planner collections and fields", () => {
  const seeded = seededPlanner();
  const stored = JSON.parse(
    JSON.stringify({
      unexpectedTopLevel: "must not survive",
      meals: [
        {
          id: "meal-thu",
          dayIndex: "Thursday",
          title: "",
          subtitle: 42,
          venue: null,
          status: "burned",
          protein: "beef",
          prepNote: [],
          leftoverNote: {},
          notes: "Use the stored note.",
          ingredients: ["rice", 2],
          instructions: [
            {
              id: "bad-step",
              inputs: [null],
              instruction: "Unsafe stored step",
              complete: false,
            },
          ],
          unexpectedMealField: "must not survive",
        },
      ],
      prep: "not-an-array",
      groceries: [null],
      leftovers: [{ id: "missing-required-fields" }],
      farmBoxReconciled: "yes",
      weekArchived: 1,
      draftReady: null,
      feedback: { "meal-thu": "favorite" },
      weekLesson: { text: "bad shape" },
    }),
  );

  const migrated = migrateStoredPlannerData(stored, seeded);

  assert.equal(migrated.meals[0].dayIndex, seeded.meals[0].dayIndex);
  assert.equal(migrated.meals[0].title, seeded.meals[0].title);
  assert.equal(migrated.meals[0].notes, "Use the stored note.");
  assert.deepEqual(migrated.meals[0].ingredients, seeded.meals[0].ingredients);
  assert.deepEqual(migrated.meals[0].instructions, seeded.meals[0].instructions);
  assert.deepEqual(migrated.prep, seeded.prep);
  assert.deepEqual(migrated.groceries, seeded.groceries);
  assert.deepEqual(migrated.leftovers, seeded.leftovers);
  assert.equal(migrated.groceries[0].item.toUpperCase(), "JASMINE RICE");
  assert.equal(migrated.leftovers[0].portions + 1, 3);
  assert.equal(migrated.farmBoxReconciled, seeded.farmBoxReconciled);
  assert.equal(migrated.weekArchived, seeded.weekArchived);
  assert.equal(migrated.draftReady, seeded.draftReady);
  assert.deepEqual(migrated.feedback, seeded.feedback);
  assert.equal(migrated.weekLesson, seeded.weekLesson);
  assert.equal(Object.hasOwn(migrated, "unexpectedTopLevel"), false);
  assert.equal(Object.hasOwn(migrated.meals[0], "unexpectedMealField"), false);
});

test("preserves dynamic leftovers and migrates legacy meal assignment links", () => {
  const seeded = seededPlanner();
  const migrated = migrateStoredPlannerData(
    {
      meals: [{ id: "meal-thu", leftoverId: "leftover-created" }],
      leftovers: [
        seeded.leftovers[0],
        {
          id: "leftover-created",
          sourceMealId: "meal-thu",
          label: "Miso salmon bowl",
          portions: 3,
          state: "assigned",
          quality: "good",
          unexpectedField: "must not survive",
        },
      ],
    },
    seeded,
  );

  assert.deepEqual(migrated.leftovers[1], {
    id: "leftover-created",
    sourceMealId: "meal-thu",
    label: "Miso salmon bowl",
    portions: 3,
    state: "assigned",
    assignedDayIndex: 3,
    quality: "good",
  });
  assert.equal(Object.hasOwn(migrated.meals[0], "leftoverId"), false);
  assert.equal(Object.hasOwn(migrated.leftovers[1], "unexpectedField"), false);
});

test("normalizes event timestamps and retains only the newest recoverable history", () => {
  const baseTime = Date.UTC(2026, 6, 9, 16, 0, 0);
  const storedEvents = Array.from({ length: MAX_RECOVERABLE_EVENTS + 5 }, (_, index) => {
    const occurredAt = baseTime - index * 60_000;
    return {
      id: `event-${occurredAt}-test`,
      actor: "Household",
      command: "updateMealStatus",
      summary: `Updated meal ${index}`,
      target: "meal-thu",
      changes: ["Status changed"],
      occurredAt: new Date(occurredAt).toISOString(),
      before: seededPlanner(),
    };
  });

  const events = migrateEventHistory(
    storedEvents,
    (snapshot) => migrateStoredPlannerData(snapshot, seededPlanner()),
    { nowMs: baseTime },
  );

  assert.equal(events.length, MAX_RECOVERABLE_EVENTS);
  assert.equal(events[0].id, `event-${baseTime}-test`);
  assert.equal(
    events.at(-1).id,
    `event-${baseTime - (MAX_RECOVERABLE_EVENTS - 1) * 60_000}-test`,
  );
  assert.equal(events[0].occurredAt, baseTime);
  assert.ok(events.every((event) => event.before?.meals[0].id === "meal-thu"));
});

test("accepts ISO timestamps and migrates legacy relative display times", () => {
  const nowMs = new Date(2026, 6, 9, 12, 0, 0).getTime();
  const expectedYesterday = new Date(nowMs);
  expectedYesterday.setDate(expectedYesterday.getDate() - 1);
  expectedYesterday.setHours(16, 30, 0, 0);

  const events = migrateEventHistory(
    [
      {
        id: "legacy-event",
        actor: "Household",
        command: "captureWeekLesson",
        summary: "Saved a lesson",
        target: "week-lesson",
        changes: [],
        time: "Yesterday, 4:30 p.m.",
      },
      {
        id: "iso-event",
        actor: "Codex",
        command: "createWeekPlan",
        summary: "Created a plan",
        target: "week-plan",
        changes: [],
        occurredAt: "2026-07-09T10:15:00.000Z",
      },
    ],
    () => seededPlanner(),
    { nowMs },
  );

  assert.equal(events[0].occurredAt, expectedYesterday.getTime());
  assert.equal(events[1].occurredAt, Date.parse("2026-07-09T10:15:00.000Z"));
  assert.match(events[0].time, /^Yesterday, /);
  assert.equal(typeof events[1].time, "string");
});

test("reconstructs valid chat messages and falls back on malformed collections", () => {
  const fallback = [
    {
      id: "fallback-message",
      role: "assistant",
      text: "Ready when you are.",
    },
  ];
  const migrated = migrateChatMessages([
    {
      id: "message-1",
      role: "user",
      text: "Move salmon to Saturday.",
      context: "Weekly plan",
      changes: ["Salmon moved"],
      unexpectedField: "must not survive",
    },
  ]);

  assert.deepEqual(migrated, [
    {
      id: "message-1",
      role: "user",
      text: "Move salmon to Saturday.",
      context: "Weekly plan",
      changes: ["Salmon moved"],
    },
  ]);
  assert.deepEqual(
    migrateChatMessages([{ id: "bad", role: "system", text: "Unsafe" }], fallback),
    fallback,
  );
});
