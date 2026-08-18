import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createCoreIngredientCatalogue } from "../../lib/ingredient-catalogue.ts";

import {
  CURRENT_SCHEMA_VERSION,
  PLANNER_SCHEMA_MIGRATIONS,
  assertPlannerSchemaContract,
} from "./schema-contract.ts";

const DISPOSABLE_STATE = Object.freeze({
  householdTimeZone: "America/Halifax",
  activeWeekId: "2026-07-20",
  ingredientCatalogue: createCoreIngredientCatalogue(),
  weeks: [Object.freeze({
    id: "2026-07-20",
    weekStartDate: "2026-07-20",
    status: "active",
    data: Object.freeze({
      meals: [Object.freeze({
        id: "release-dinner",
        date: "2026-07-20",
        slot: "dinner",
        title: "Disposable release dinner",
        subtitle: "Mounted production-profile proof",
        venue: "QA kitchen",
        status: "planned",
        protein: "none",
        prepNote: "",
        leftoverNote: "",
        notes: "Read-only release journey.",
        ingredients: [Object.freeze({
          id: "release-ingredient",
          source: "1 disposable test ingredient",
          amount: "1",
          unit: null,
          ingredient: "disposable test ingredient",
          qualifier: null,
          conceptId: null,
          role: "weekly_requirement",
          canonicalIngredientId: null,
        })],
        instructions: [Object.freeze({
          id: "release-step",
          inputs: [Object.freeze({
            amount: "1",
            ingredient: "disposable test ingredient",
            occurrenceId: "release-ingredient",
          })],
          instruction: "Open this dinner to prove the mounted Day surface.",
          complete: false,
        })],
      })],
      prepSessions: [],
      groceries: [Object.freeze({
        id: "release-grocery",
        mealId: "release-dinner",
        ingredientId: "release-ingredient",
        section: "Pantry",
        coverage: "on_hand",
        checked: false,
      })],
      leftovers: [],
      feedback: {},
      weekLesson: "",
    }),
  })],
});

/** Store-owned fixture support for the disposable release-candidate probe. */
export function createDisposableReleaseDatabase(filename: string): void {
  assertPlannerSchemaContract();
  const database = new DatabaseSync(filename);
  try {
    for (const migration of PLANNER_SCHEMA_MIGRATIONS) {
      database.exec(readFileSync(migration.path, "utf8"));
      database.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, migration.version);
    }
    database.prepare(
      `INSERT INTO workspace
        (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
       VALUES ('household', ?, 0, 1, ?, 1, 1)`,
    ).run(CURRENT_SCHEMA_VERSION, JSON.stringify(DISPOSABLE_STATE));
  } finally {
    database.close();
  }
}

export function readDisposableReleaseDatabaseContract(filename: string): unknown {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      quickCheck: database.prepare("PRAGMA quick_check").all(),
      migrations: database.prepare(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      ).all(),
      workspace: database.prepare(
        `SELECT schema_version, planner_version, sync_revision, state_json,
                created_at, updated_at
         FROM workspace WHERE id = 'household'`,
      ).get(),
    };
  } finally {
    database.close();
  }
}
