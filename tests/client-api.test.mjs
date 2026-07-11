import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PlannerApiError,
  applyPlannerCommand,
  bootstrapWorkspace,
  exportWorkspace,
  isAbortError,
  readLegacyImport,
  readHistoryPage,
  readWorkspace,
  retryChatTurn,
  shouldAcceptWorkspace,
  submitChatTurn,
  undoLatest,
} from "../app/planner-api.ts";

function initializedWorkspace(syncRevision = 3, plannerVersion = 2) {
  return {
    initialized: true,
    schemaVersion: 1,
    plannerVersion,
    syncRevision,
    state: {
      householdTimeZone: "America/Halifax",
      activeWeekId: null,
      weeks: [],
    },
    events: [],
    transcriptEntries: [],
    chatTurns: [],
  };
}

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("workspace reads send the prior ETag and handle an empty 304", async () => {
  await withFetch(async (path, init) => {
    assert.equal(path, "/api/workspace");
    assert.equal(init.headers["If-None-Match"], '"workspace-8"');
    return new Response(null, {
      status: 304,
      headers: { ETag: '"workspace-8"', Date: "Fri, 10 Jul 2026 16:00:00 GMT" },
    });
  }, async () => {
    const result = await readWorkspace({ etag: '"workspace-8"' });
    assert.deepEqual(result, {
      kind: "not_modified",
      etag: '"workspace-8"',
      serverDate: Date.parse("Fri, 10 Jul 2026 16:00:00 GMT"),
    });
  });
});

test("workspace reads return the server revision and response metadata", async () => {
  const workspace = initializedWorkspace(9, 7);
  await withFetch(async () => new Response(JSON.stringify(workspace), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"workspace-9"' },
  }), async () => {
    const result = await readWorkspace();
    assert.equal(result.kind, "workspace");
    assert.equal(result.workspace.syncRevision, 9);
    assert.equal(result.etag, '"workspace-9"');
  });
});

test("aborted conditional reads stay neutral instead of becoming offline errors", async () => {
  const aborted = new DOMException("Superseded", "AbortError");
  await withFetch(async () => { throw aborted; }, async () => {
    await assert.rejects(readWorkspace(), (error) => {
      assert.equal(error, aborted);
      assert.equal(isAbortError(error), true);
      assert.equal(error instanceof PlannerApiError, false);
      return true;
    });
  });
});

test("expected command conflicts are decision responses, not transport errors", async () => {
  const workspace = initializedWorkspace(10, 8);
  await withFetch(async (path, init) => {
    assert.equal(path, "/api/commands");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "same-origin");
    return new Response(JSON.stringify({
      decision: { status: "version_conflict", expectedVersion: 7, actualVersion: 8 },
      workspace,
    }), { status: 409, headers: { "Content-Type": "application/json" } });
  }, async () => {
    const result = await applyPlannerCommand({
      requestId: "request-1",
      basePlannerVersion: 7,
      command: { type: "activateWeek", weekId: "2026-07-06" },
    });
    assert.equal(result.decision.status, "version_conflict");
    assert.equal(result.workspace.syncRevision, 10);
  });
});

test("ambiguous POST transport failures replay the exact request ID once", async () => {
  const workspace = initializedWorkspace(11, 9);
  const requests = [];
  await withFetch(async (_path, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) throw new TypeError("response disappeared after commit");
    return new Response(JSON.stringify({
      decision: { status: "accepted", eventId: "event-1", resultVersion: 9 },
      workspace,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, async () => {
    const result = await applyPlannerCommand({
      requestId: "stable-request-id",
      basePlannerVersion: 8,
      command: { type: "activateWeek", weekId: "2026-07-06" },
    });
    assert.equal(result.decision.status, "accepted");
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1].requestId, "stable-request-id");
});

test("ambiguous POST envelopes replay only for the original request ID", async (t) => {
  const workspace = initializedWorkspace(11, 9);
  const commandResponse = {
    decision: { status: "accepted", eventId: "event-1", plannerVersion: 9 },
    workspace,
  };
  const chatResponse = {
    decision: { status: "context_stale", expectedVersion: 8, actualVersion: 9 },
    workspace,
  };
  const cases = [
    {
      name: "planner command",
      path: "/api/commands",
      first: {
        requestId: "command-original",
        basePlannerVersion: 8,
        command: { type: "activateWeek", weekId: "2026-07-06" },
      },
      run: applyPlannerCommand,
      response: commandResponse,
    },
    {
      name: "undo",
      path: "/api/undo",
      first: {
        requestId: "undo-original",
        basePlannerVersion: 8,
        targetEventId: "event-before-undo",
      },
      run: undoLatest,
      response: commandResponse,
    },
    {
      name: "bootstrap",
      path: "/api/bootstrap",
      first: { requestId: "bootstrap-original", mode: "seed" },
      run: bootstrapWorkspace,
      response: { imported: false, workspace },
    },
    {
      name: "chat submit",
      path: "/api/chat/submit",
      first: {
        requestId: "chat-submit-original",
        basePlannerVersion: 8,
        message: "Move dinner to Tuesday",
        context: { view: "week", weekId: "2026-07-06" },
      },
      run: submitChatTurn,
      response: chatResponse,
    },
    {
      name: "chat retry",
      path: "/api/chat/retry",
      first: {
        requestId: "chat-retry-original",
        basePlannerVersion: 8,
        turnId: "turn-1",
      },
      run: retryChatTurn,
      response: chatResponse,
    },
  ];

  for (const operation of cases) {
    await t.test(operation.name, async () => {
      const requests = [];
      const semanticFields = Object.fromEntries(
        Object.entries(operation.first).filter(([key]) => key !== "requestId"),
      );
      const refreshedFields = "basePlannerVersion" in semanticFields
        ? { ...semanticFields, basePlannerVersion: semanticFields.basePlannerVersion + 1 }
        : semanticFields;
      const laterRetry = { ...refreshedFields, requestId: operation.first.requestId };
      const deliberateOperation = { ...refreshedFields, requestId: `${operation.name}-deliberate-id` };
      await withFetch(async (path, init) => {
        requests.push({ path, rawBody: init.body, body: JSON.parse(init.body) });
        if (requests.length <= 2) throw new TypeError("response disappeared after commit");
        return new Response(JSON.stringify(operation.response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }, async () => {
        await assert.rejects(
          operation.run(operation.first),
          (error) => error instanceof PlannerApiError && error.code === "NETWORK_ERROR",
        );

        await operation.run(deliberateOperation);
        await operation.run(laterRetry);
      });

      assert.equal(requests.length, 4);
      assert.ok(requests.every((request) => request.path === operation.path));
      assert.equal(requests[0].rawBody, JSON.stringify(operation.first));
      assert.equal(requests[1].rawBody, requests[0].rawBody);
      assert.equal(requests[2].body.requestId, `${operation.name}-deliberate-id`);
      assert.equal(requests[2].rawBody, JSON.stringify(deliberateOperation));
      assert.equal(requests[3].rawBody, requests[0].rawBody);
      assert.equal(requests[3].body.requestId, operation.first.requestId);
    });
  }
});

test("ambiguous planner retries cannot drift with canonical add-step or prep state", async (t) => {
  const workspace = initializedWorkspace(11, 9);
  const cases = [
    {
      name: "add step position",
      first: {
        requestId: "add-step-stable",
        basePlannerVersion: 8,
        command: {
          type: "addInstructionStep",
          weekId: "2026-07-06",
          mealId: "meal-1",
          position: 2,
          step: { inputs: [], instruction: "Rest before serving." },
        },
      },
      reconstructed: {
        requestId: "add-step-stable",
        basePlannerVersion: 9,
        command: {
          type: "addInstructionStep",
          weekId: "2026-07-06",
          mealId: "meal-1",
          position: 3,
          step: { inputs: [], instruction: "Rest before serving." },
        },
      },
    },
    {
      name: "prep plan append",
      first: {
        requestId: "prep-plan-stable",
        basePlannerVersion: 8,
        command: {
          type: "setPrepPlan",
          weekId: "2026-07-06",
          entries: [{ stepId: "step-1", prepDate: "2026-07-05" }],
        },
      },
      reconstructed: {
        requestId: "prep-plan-stable",
        basePlannerVersion: 9,
        command: {
          type: "setPrepPlan",
          weekId: "2026-07-06",
          entries: [
            { stepId: "step-1", prepDate: "2026-07-05" },
            { stepId: "step-1", prepDate: "2026-07-05" },
          ],
        },
      },
    },
  ];

  for (const operation of cases) {
    await t.test(operation.name, async () => {
      const requests = [];
      await withFetch(async (_path, init) => {
        requests.push(JSON.parse(init.body));
        if (requests.length <= 2) throw new TypeError("response disappeared after commit");
        return new Response(JSON.stringify({
          decision: { status: "accepted", eventId: "event-1", plannerVersion: 9 },
          workspace,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }, async () => {
        await assert.rejects(
          applyPlannerCommand(operation.first),
          (error) => error instanceof PlannerApiError && error.code === "NETWORK_ERROR",
        );
        await applyPlannerCommand(operation.reconstructed);
      });

      assert.equal(requests.length, 3);
      assert.deepEqual(requests[1], operation.first);
      assert.deepEqual(requests[2], operation.first);
    });
  }
});

test("bootstrap failures expose their authoritative workspace", async () => {
  const workspace = initializedWorkspace(4, 1);
  await withFetch(async () => new Response(JSON.stringify({
    error: { code: "ALREADY_INITIALIZED", message: "Already initialized." },
    workspace,
  }), { status: 409, headers: { "Content-Type": "application/json" } }), async () => {
    await assert.rejects(
      bootstrapWorkspace({ requestId: "request-2", mode: "seed" }),
      (error) => {
        assert.ok(error instanceof PlannerApiError);
        assert.equal(error.code, "ALREADY_INITIALIZED");
        assert.equal(error.workspace.syncRevision, 4);
        return true;
      },
    );
  });
});

test("legacy import accepts only the exact v2 envelope", () => {
  const payload = { data: { meals: [] }, events: [], chatMessages: [] };
  assert.deepEqual(
    readLegacyImport({ getItem: () => JSON.stringify(payload) }),
    { present: true, payload, error: null },
  );
  const extra = readLegacyImport({ getItem: () => JSON.stringify({ ...payload, extra: true }) });
  assert.equal(extra.present, true);
  assert.equal(extra.payload, null);
  assert.match(extra.error, /not a recognized v2 export/);
  const damaged = readLegacyImport({ getItem: () => "{" });
  assert.equal(damaged.payload, null);
  assert.match(damaged.error, /damaged/);
  assert.deepEqual(readLegacyImport({ getItem: () => null }), {
    present: false,
    payload: null,
    error: null,
  });
});

test("older initialized workspaces cannot replace the latest read model", () => {
  assert.equal(shouldAcceptWorkspace(initializedWorkspace(12), initializedWorkspace(11)), false);
  assert.equal(shouldAcceptWorkspace(initializedWorkspace(12), initializedWorkspace(12)), true);
  assert.equal(shouldAcceptWorkspace({ initialized: false, schemaVersion: 1 }, initializedWorkspace(1)), true);
  assert.equal(shouldAcceptWorkspace(initializedWorkspace(12), { initialized: false, schemaVersion: 1 }), false);
});

test("history paging uses the canonical exclusive cursor query", async () => {
  await withFetch(async (path) => {
    assert.equal(path, "/api/history?beforeSequence=40&limit=25");
    return new Response(JSON.stringify({ order: "newest_first", items: [], nextBeforeSequence: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    const page = await readHistoryPage({ beforeSequence: 40, limit: 25 });
    assert.equal(page.order, "newest_first");
  });
});

test("workspace export accepts the canonical export envelope", async () => {
  const workspace = initializedWorkspace(14, 9);
  const envelope = {
    schemaVersion: workspace.schemaVersion,
    exportedAt: 1_783_700_000_000,
    plannerVersion: workspace.plannerVersion,
    syncRevision: workspace.syncRevision,
    state: workspace.state,
    events: workspace.events,
    transcriptEntries: workspace.transcriptEntries,
    chatTurns: workspace.chatTurns,
  };
  await withFetch(async (path) => {
    assert.equal(path, "/api/export");
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    assert.deepEqual(await exportWorkspace(), envelope);
  });
});

test("client authority source has no browser writes or legacy reducers", async () => {
  const source = await readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage\.setItem/);
  assert.doesNotMatch(source, /planner-domain|planner-history|planner-persistence|buildChatPlannerState/);
  assert.match(source, /setInterval\([^]*2_000/);
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /removeItem\(LEGACY_V2_STORAGE_KEY\)/);
  assert.match(source, /aria-modal="true"/);
  const readOnlyLine = source.match(/const isReadOnly = [^;]+;/)?.[0] ?? "";
  assert.match(readOnlyLine, /plannerPending/);
  assert.doesNotMatch(readOnlyLine, /chatPending/);
  assert.match(source, /ChatGPT working · planner available/);
});
