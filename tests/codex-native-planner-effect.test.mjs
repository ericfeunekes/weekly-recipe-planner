import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { PLANNER_TOOL_NAMESPACE } from "../lib/planner-tool-contract.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { createNativePlannerEffectHost } from "../server/codex/planner-effect-host.ts";
import { createSqliteCodexThreadStore } from "../server/store/codex-thread-store.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function initializedWorkspace() {
  let id = 0;
  const state = createCanonicalSeed({
    now: Date.UTC(2026, 6, 15, 12),
    createId: (prefix) => `${prefix}-seed-${id += 1}`,
  });
  return {
    initialized: true,
    schemaVersion: 8,
    plannerVersion: 0,
    syncRevision: 1,
    state,
    events: [],
    transcriptEntries: [],
    chatTurns: [],
  };
}

function fakePlanner() {
  let workspace = initializedWorkspace();
  const calls = { preview: 0, apply: 0 };
  const applyOperations = (_request, context) => {
    calls.apply += 1;
    assert.equal(context.operationKind, "native_codex_apply_planner_operations_v1");
    assert.deepEqual(context.provenance, {
      actorClass: "codex",
      actorSource: "embedded",
      admission: "app_server_dynamic_v1",
    });
    workspace = {
      ...workspace,
      plannerVersion: workspace.plannerVersion + 1,
      syncRevision: workspace.syncRevision + 1,
    };
    return {
      decision: {
        status: "accepted",
        eventId: "event-native",
        plannerVersion: workspace.plannerVersion,
      },
      workspace,
    };
  };
  return {
    calls,
    advanceWorkspace() {
      workspace = {
        ...workspace,
        plannerVersion: workspace.plannerVersion + 1,
        syncRevision: workspace.syncRevision + 1,
      };
    },
    readWorkspace: () => workspace,
    readEventPage: () => ({ order: "newest_first", items: [], nextBeforeSequence: null }),
    readTranscriptPage: () => ({ order: "newest_first", items: [], nextBeforeSequence: null }),
    applyCommand: () => { throw new Error("unused"); },
    previewOperations: (request) => {
      calls.preview += 1;
      return {
        decision: {
          status: "previewed",
          plannerVersion: workspace.plannerVersion,
          outcomes: request.operations.map((_, operationIndex) => ({
            operationIndex,
            summary: "Preview",
            target: "week",
            changes: ["One change"],
          })),
        },
      };
    },
    applyOperations,
    applyPlannerOperations: (_transaction, request, context) =>
      applyOperations(request, context),
    undoLatest: () => { throw new Error("unused"); },
    bootstrap: () => { throw new Error("unused"); },
    exportWorkspace: () => { throw new Error("unused"); },
  };
}

function realPlanner(sqlite, {
  failureInjector = { hit() {} },
  bootstrap = true,
} = {}) {
  let id = 0;
  let now = Date.UTC(2026, 6, 15, 12);
  const context = () => ({
    now,
    createId: (prefix) => `${prefix}-native-${id += 1}`,
  });
  const planner = createPlannerApplicationService({
    store: sqlite,
    domain: householdDomain,
    seedFactory: () => createCanonicalSeed(context()),
    transformLegacyV2: () => { throw new Error("unused"); },
    clock: { now: () => now += 1 },
    idFactory: { createId: (prefix) => `${prefix}-native-${id += 1}` },
    failureInjector,
  });
  if (bootstrap) planner.bootstrap({ requestId: "bootstrap-native", mode: "seed" });
  return planner;
}

function callback(tool, args, overrides = {}) {
  return {
    threadId: overrides.threadId ?? "thread-root",
    turnId: overrides.turnId ?? "turn-1",
    callId: overrides.callId ?? `call-${tool}`,
    namespace: PLANNER_TOOL_NAMESPACE,
    tool,
    arguments: args,
  };
}

function decode(response) {
  assert.equal(response.contentItems.length, 1);
  assert.equal(response.contentItems[0].type, "inputText");
  return JSON.parse(response.contentItems[0].text);
}

test("native planner host reads and replays the exact result", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: (threadId, turnId) =>
      threadId === "thread-root" && turnId === "turn-1",
    now: () => 100,
  });
  const params = callback("read", { query: { kind: "workspace" } });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.deepEqual(replay, first);
  assert.equal(first.ok, true);
  assert.equal(first.data.kind, "workspace");
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls",
  ).get().count, 1);
  sqlite.close();
});

test("native planner host applies through the shared service once and replays", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 200,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Keep it simple." } }],
    readback: { kind: "week", weekId },
  });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "accepted");
  assert.deepEqual(replay, first);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  assert.equal(sqlite.readAllChatTurns().length, 0);
  assert.equal(planner.readTranscriptPage({ limit: 20 }).items.length, 0);
  const row = sqlite.database.prepare(
    "SELECT operation_kind, request_id, event_id FROM codex_native_tool_calls",
  ).get();
  assert.equal(row.operation_kind, "native_codex_apply_planner_operations_v1");
  assert.match(row.request_id, /^native-codex:[a-f0-9]{64}$/u);
  assert.match(row.event_id, /^event-native-/u);
  sqlite.close();
});

test("accepted native apply falls back to canonical workspace readback and settles", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const store = createSqliteCodexThreadStore(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 250,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Fallback." } }],
    readback: { kind: "week", weekId: "missing-week" },
  }, { callId: "call-fallback" });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "accepted");
  assert.equal(first.data.readback.kind, "workspace");
  assert.deepEqual(replay, first);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  assert.equal(store.readPlannerToolCalls("thread-root", "turn-1")[0].status, "succeeded");
  sqlite.close();
});

test("native host canonicalization rejects changed arguments before a second effect", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 260,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const base = {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "First." } }],
    readback: { kind: "workspace" },
  };
  assert.equal(decode(await host.handle(callback("apply", base, {
    callId: "call-changed",
  }))).ok, true);
  const changed = decode(await host.handle(callback("apply", {
    ...base,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Changed." } }],
  }, { callId: "call-changed" })));
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "DUPLICATE_MISMATCH");
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  sqlite.close();
});

test("preview version conflict reports the current authoritative envelope", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  planner.previewOperations = () => {
    planner.calls.preview += 1;
    planner.advanceWorkspace();
    return {
      decision: { status: "version_conflict", expectedVersion: 0, actualVersion: 1 },
    };
  };
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 270,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const conflict = decode(await host.handle(callback("preview", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Race." } }],
  }, { callId: "call-preview-race" })));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "VERSION_CONFLICT");
  assert.equal(conflict.plannerVersion, 1);
  assert.equal(conflict.syncRevision, 2);
  sqlite.close();
});

test("native planner host recovers a reserved apply with the same deterministic request identity", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(sqlite);
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 300,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Recover safely." } }],
    readback: { kind: "workspace" },
  }, { callId: "call-recovery" });

  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const { createHash } = await import("node:crypto");
  const argumentHash = createHash("sha256").update(canonical(params.arguments)).digest("hex");
  const callbackIdentityHash = createHash("sha256").update([
    params.threadId,
    params.turnId,
    params.callId,
    params.namespace,
    params.tool,
    argumentHash,
  ].join("\0")).digest("hex");
  assert.equal(store.reservePlannerToolCall({
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    callbackIdentityHash,
    tool: params.tool,
    argumentHash,
  }, 250).status, "reserved");

  const recovered = decode(await host.handle(params));
  assert.equal(recovered.ok, true);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  assert.equal(store.readPlannerToolCalls(params.threadId, params.turnId)[0].status, "succeeded");
  sqlite.close();
});

test("native apply and its callback fence roll back together and recover after a file-backed reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-native-effect-crash-"));
  const filename = join(directory, "planner.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  let armed = false;
  let failed = false;
  let sqlite = openPlannerStore({ filename });
  let planner = realPlanner(sqlite, {
    failureInjector: {
      hit(point) {
        if (armed && !failed && point === "after_planner_mutation") {
          failed = true;
          throw new Error("crash-after-planner-mutation");
        }
      },
    },
  });
  let store = createSqliteCodexThreadStore(sqlite);
  let host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 350,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{
      command: {
        type: "captureWeekLesson",
        weekId,
        weekLesson: "Recover the atomic callback.",
      },
    }],
    readback: { kind: "week", weekId },
  }, { callId: "call-file-backed-crash" });

  armed = true;
  await assert.rejects(host.handle(params), /crash-after-planner-mutation/u);
  assert.equal(failed, true);
  assert.equal(planner.readWorkspace().plannerVersion, 0);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM planner_events",
  ).get().count, 0);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM command_receipts WHERE operation_kind = 'native_codex_apply_planner_operations_v1'",
  ).get().count, 0);
  assert.equal(store.readPlannerToolCalls(params.threadId, params.turnId)[0].status, "running");
  sqlite.close();

  sqlite = openPlannerStore({ filename });
  planner = realPlanner(sqlite, { bootstrap: false });
  store = createSqliteCodexThreadStore(sqlite);
  host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 351,
  });
  const recovered = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.equal(recovered.ok, true);
  assert.deepEqual(replay, recovered);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM planner_events",
  ).get().count, 1);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM command_receipts WHERE operation_kind = 'native_codex_apply_planner_operations_v1'",
  ).get().count, 1);
  assert.equal(store.readPlannerToolCalls(params.threadId, params.turnId)[0].status, "succeeded");
  sqlite.close();
});

test("native planner host rejects explicit archive authority and ineligible callers", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: (threadId, turnId) =>
      threadId === "thread-root" && turnId === "turn-1",
    now: () => 400,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const denied = decode(await host.handle(callback("preview", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "archiveWeek", weekId } }],
  })));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "NOT_AUTHORIZED");
  assert.equal(planner.calls.preview, 0);
  const applyDenied = decode(await host.handle(callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "archiveWeek", weekId } }],
    readback: { kind: "workspace" },
  }, { callId: "call-archive-apply" })));
  assert.equal(applyDenied.ok, false);
  assert.equal(applyDenied.error.code, "NOT_AUTHORIZED");
  assert.equal(planner.calls.apply, 0);
  await assert.rejects(
    host.handle(callback("read", { query: { kind: "workspace" } }, {
      threadId: "thread-foreign",
      callId: "call-foreign",
    })),
    /ineligible native turn/u,
  );
  await assert.rejects(
    host.handle(callback("read", { query: { kind: "workspace" } }, {
      turnId: "turn-stale",
      callId: "call-stale-turn",
    })),
    /ineligible native turn/u,
  );
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls WHERE call_id = 'call-stale-turn'",
  ).get().count, 0);
  sqlite.close();
});
