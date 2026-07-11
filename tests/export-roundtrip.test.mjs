import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

const NOW = Date.parse("2026-07-07T18:00:00-03:00");

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-export-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "planner.sqlite");
}

function dependencies(store) {
  let id = 0;
  const context = () => ({
    now: NOW,
    createId(prefix) {
      id += 1;
      return `${prefix}-${id}`;
    },
  });
  return {
    store,
    domain: householdDomain,
    seedFactory: () => createCanonicalSeed(context()),
    transformLegacyV2: () => ({
      state: createCanonicalSeed(context()),
      transcriptEntries: [
        {
          role: "user",
          text: "Keep Tuesday dinner simple.",
          context: { view: "week", weekId: "2026-07-06" },
        },
      ],
      discardedEventCount: 0,
    }),
    clock: { now: () => NOW },
    idFactory: { createId: (prefix) => context().createId(prefix) },
    failureInjector: { hit() {} },
  };
}

function durableExportFields(envelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    plannerVersion: envelope.plannerVersion,
    syncRevision: envelope.syncRevision,
    state: envelope.state,
    events: envelope.events,
    transcriptEntries: envelope.transcriptEntries,
    chatTurns: envelope.chatTurns,
  };
}

test("canonical export round-trips through a reopened durable workspace", (t) => {
  const filename = temporaryDatabase(t);
  const storeA = openPlannerStore({ filename });
  const serviceA = createPlannerApplicationService(dependencies(storeA));
  const bootstrapped = serviceA.bootstrap({
    requestId: "bootstrap-export",
    mode: "import-v2",
    payload: { data: {}, events: [], chatMessages: [] },
  });
  const weekId = bootstrapped.workspace.state.activeWeekId;
  assert.ok(weekId);
  const changed = serviceA.applyCommand({
    requestId: "export-change",
    basePlannerVersion: bootstrapped.workspace.plannerVersion,
    command: {
      type: "captureWeekLesson",
      weekId,
      weekLesson: "Pack sauces separately.",
    },
  });
  assert.equal(changed.decision.status, "accepted");

  const beforeClose = serviceA.readWorkspace();
  const firstExport = serviceA.exportWorkspace();
  assert.deepEqual(durableExportFields(firstExport), {
    schemaVersion: beforeClose.schemaVersion,
    plannerVersion: beforeClose.plannerVersion,
    syncRevision: beforeClose.syncRevision,
    state: beforeClose.state,
    events: beforeClose.events,
    transcriptEntries: beforeClose.transcriptEntries,
    chatTurns: beforeClose.chatTurns,
  });
  storeA.close();

  const storeB = openPlannerStore({ filename });
  const serviceB = createPlannerApplicationService(dependencies(storeB));
  const reopened = serviceB.readWorkspace();
  const reopenedExport = serviceB.exportWorkspace();
  assert.deepEqual(durableExportFields(reopenedExport), durableExportFields(firstExport));
  assert.deepEqual(durableExportFields(reopenedExport), {
    schemaVersion: reopened.schemaVersion,
    plannerVersion: reopened.plannerVersion,
    syncRevision: reopened.syncRevision,
    state: reopened.state,
    events: reopened.events,
    transcriptEntries: reopened.transcriptEntries,
    chatTurns: reopened.chatTurns,
  });
  storeB.close();
});
