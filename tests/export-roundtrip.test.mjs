import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import {
  DIAGNOSTIC_EXPORT_FORMAT_VERSION,
  DIAGNOSTIC_EXPORT_KIND,
  DIAGNOSTIC_EXPORT_WARNING,
  isDiagnosticExportEnvelope,
} from "../lib/planner-api-contract.ts";
import {
  PlannerServiceError,
  createPlannerApplicationService,
} from "../server/application/planner-service.ts";
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

function diagnosticExportFields(envelope) {
  return {
    kind: envelope.kind,
    formatVersion: envelope.formatVersion,
    restorable: envelope.restorable,
    warning: envelope.warning,
    schemaVersion: envelope.schemaVersion,
    plannerVersion: envelope.plannerVersion,
    syncRevision: envelope.syncRevision,
    state: envelope.state,
    events: envelope.events,
    transcriptEntries: envelope.transcriptEntries,
    chatTurns: envelope.chatTurns,
  };
}

test("diagnostic export is stable across reopen but cannot restore a lost database", (t) => {
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
  assert.equal(isDiagnosticExportEnvelope(firstExport), true);
  assert.deepEqual(Object.keys(firstExport).sort(), [
    "chatTurns",
    "events",
    "exportedAt",
    "formatVersion",
    "kind",
    "plannerVersion",
    "restorable",
    "schemaVersion",
    "state",
    "syncRevision",
    "transcriptEntries",
    "warning",
  ]);
  const missingWarning = { ...firstExport };
  delete missingWarning.warning;
  for (const [label, candidate] of [
    ["kind", { ...firstExport, kind: "meal-planner-backup" }],
    ["format version", { ...firstExport, formatVersion: 2 }],
    ["restore claim", { ...firstExport, restorable: true }],
    ["warning", { ...firstExport, warning: "Can restore data." }],
    ["missing field", missingWarning],
    ["extra field", { ...firstExport, restoreMode: "replace" }],
  ]) {
    assert.equal(isDiagnosticExportEnvelope(candidate), false, label);
  }
  assert.deepEqual(diagnosticExportFields(firstExport), {
    kind: DIAGNOSTIC_EXPORT_KIND,
    formatVersion: DIAGNOSTIC_EXPORT_FORMAT_VERSION,
    restorable: false,
    warning: DIAGNOSTIC_EXPORT_WARNING,
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
  assert.deepEqual(diagnosticExportFields(reopenedExport), diagnosticExportFields(firstExport));
  assert.deepEqual(diagnosticExportFields(reopenedExport), {
    kind: DIAGNOSTIC_EXPORT_KIND,
    formatVersion: DIAGNOSTIC_EXPORT_FORMAT_VERSION,
    restorable: false,
    warning: DIAGNOSTIC_EXPORT_WARNING,
    schemaVersion: reopened.schemaVersion,
    plannerVersion: reopened.plannerVersion,
    syncRevision: reopened.syncRevision,
    state: reopened.state,
    events: reopened.events,
    transcriptEntries: reopened.transcriptEntries,
    chatTurns: reopened.chatTurns,
  });
  storeB.close();

  rmSync(filename, { force: true });
  rmSync(`${filename}-wal`, { force: true });
  rmSync(`${filename}-shm`, { force: true });
  const emptyStore = openPlannerStore({ filename });
  const emptyService = createPlannerApplicationService(dependencies(emptyStore));
  const beforeRejectedRestore = emptyService.readWorkspace();
  assert.equal(beforeRejectedRestore.initialized, false);
  assert.throws(
    () => emptyService.bootstrap(firstExport),
    (error) =>
      error instanceof PlannerServiceError &&
      error.code === "INVALID_REQUEST" &&
      error.message === DIAGNOSTIC_EXPORT_WARNING,
  );
  assert.deepEqual(emptyService.readWorkspace(), beforeRejectedRestore);
  assert.equal(
    emptyStore.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
    0,
  );
  emptyStore.close();
});
