import assert from "node:assert/strict";
import test from "node:test";

import { createChatApplicationService } from "../server/chat/service.ts";

const WEEK_ID = "2026-07-06";
const CONTEXT = {
  view: "prep",
  weekId: WEEK_ID,
  mealId: "meal-1",
  stepId: "step-1",
};

function initialWorkspace() {
  return {
    initialized: true,
    schemaVersion: 1,
    plannerVersion: 0,
    syncRevision: 0,
    state: {
      householdTimeZone: "America/Halifax",
      activeWeekId: WEEK_ID,
      weeks: [
        {
          id: WEEK_ID,
          weekStartDate: WEEK_ID,
          status: "active",
          data: {
            meals: [
              {
                id: "meal-1",
                date: "2026-07-07",
                slot: "dinner",
                title: "Rice bowls",
                subtitle: "Tuesday dinner",
                venue: "Home",
                status: "planned",
                protein: "chicken",
                prepNote: "Cook rice Sunday",
                leftoverNote: "Two portions",
                notes: "",
                ingredients: ["1 cup rice"],
                instructions: [
                  {
                    id: "step-1",
                    inputs: [{ amount: "1 cup", ingredient: "rice" }],
                    instruction: "Cook the rice.",
                    complete: false,
                    timerDurationSeconds: 900,
                  },
                ],
              },
            ],
            prep: [
              {
                id: "prep-1",
                stepId: "step-1",
                prepDate: "2026-07-05",
                position: 0,
              },
            ],
            groceries: [],
            leftovers: [],
            farmBoxReconciled: false,
            feedback: {},
            weekLesson: "",
          },
        },
      ],
    },
    events: [],
    transcriptEntries: [],
    chatTurns: [],
  };
}

class FakeRuntime {
  constructor() {
    this.data = {
      workspace: initialWorkspace(),
      receipts: new Map(),
    };
    this.inTransaction = false;
    this.transactionCount = 0;
    this.failpoint = null;
    this.ids = 0;
    this.now = 1_000;
    this.kernelCalls = [];
  }

  transaction(work) {
    assert.equal(this.inTransaction, false, "nested transaction");
    const snapshot = structuredClone(this.data);
    this.inTransaction = true;
    this.transactionCount += 1;
    try {
      return work({});
    } catch (error) {
      this.data = snapshot;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  readWorkspace() {
    return structuredClone(this.data.workspace);
  }

  createId(prefix) {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  hit(point) {
    if (point === this.failpoint) throw new Error(`failpoint:${point}`);
  }

  receiptKey(kind, requestId) {
    return `${kind}:${requestId}`;
  }

  get ports() {
    // The port methods intentionally share this rollback-capable in-memory owner.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      transactionRunner: { transaction: (work) => runtime.transaction(work) },
      plannerRead: { readInitializedWorkspace: () => runtime.readWorkspace() },
      clock: { now: () => runtime.now++ },
      idFactory: { createId: (prefix) => runtime.createId(prefix) },
      failureInjector: { hit: (point) => runtime.hit(point) },
      persistence: {
        findReceipt(_tx, kind, requestId) {
          return structuredClone(
            runtime.data.receipts.get(runtime.receiptKey(kind, requestId)) ?? null,
          );
        },
        insertReceipt(_tx, receipt) {
          const key = runtime.receiptKey(receipt.operationKind, receipt.requestId);
          if (runtime.data.receipts.has(key)) throw new Error("duplicate receipt");
          runtime.data.receipts.set(key, structuredClone(receipt));
        },
        readRunningTurn() {
          return structuredClone(
            runtime.data.workspace.chatTurns.find((turn) => turn.status === "running") ?? null,
          );
        },
        readTurn(_tx, turnId) {
          return structuredClone(
            runtime.data.workspace.chatTurns.find((turn) => turn.turnId === turnId) ?? null,
          );
        },
        readTranscriptEntry(_tx, entryId) {
          return structuredClone(
            runtime.data.workspace.transcriptEntries.find(
              (entry) => entry.entryId === entryId,
            ) ?? null,
          );
        },
        readTranscriptTail(_tx, limit) {
          return structuredClone(runtime.data.workspace.transcriptEntries.slice(-limit));
        },
        insertTranscriptEntry(_tx, entry) {
          const stored = {
            ...structuredClone(entry),
            sequence: runtime.data.workspace.transcriptEntries.length + 1,
          };
          runtime.data.workspace.transcriptEntries.push(stored);
          return structuredClone(stored);
        },
        insertRunningTurn(_tx, turn) {
          const stored = {
            ...structuredClone(turn),
            turnSequence: runtime.data.workspace.chatTurns.length + 1,
          };
          runtime.data.workspace.chatTurns.push(stored);
          return structuredClone(stored);
        },
        updateTurnIfRunning(_tx, turnId, update) {
          const index = runtime.data.workspace.chatTurns.findIndex(
            (turn) => turn.turnId === turnId && turn.status === "running",
          );
          if (index < 0) return false;
          runtime.data.workspace.chatTurns[index] = {
            ...runtime.data.workspace.chatTurns[index],
            ...structuredClone(update),
          };
          return true;
        },
        interruptRunningTurns(_tx, completedAt) {
          let count = 0;
          runtime.data.workspace.chatTurns = runtime.data.workspace.chatTurns.map((turn) => {
            if (turn.status !== "running") return turn;
            count += 1;
            return {
              ...turn,
              status: "interrupted",
              errorCode: "SERVER_RESTARTED",
              errorDetail: "The server restarted during this turn.",
              completedAt,
            };
          });
          return count;
        },
        incrementSyncRevision() {
          runtime.data.workspace.syncRevision += 1;
          return runtime.data.workspace.syncRevision;
        },
      },
      plannerMutationKernel: {
        applyPlannerCommand(_tx, request, actor, options) {
          runtime.kernelCalls.push({ request: structuredClone(request), actor, options });
          const workspace = runtime.data.workspace;
          if (request.basePlannerVersion !== workspace.plannerVersion) {
            return {
              decision: {
                status: "version_conflict",
                expectedVersion: request.basePlannerVersion,
                actualVersion: workspace.plannerVersion,
              },
              workspace: runtime.readWorkspace(),
            };
          }
          workspace.plannerVersion += 1;
          workspace.syncRevision += 1;
          workspace.state.weeks[0].data.meals[0].instructions[0].complete =
            request.command.complete;
          workspace.events.push({
            sequence: workspace.events.length + 1,
            eventId: `event-${workspace.plannerVersion}`,
            requestId: request.requestId,
            actor,
            command: structuredClone(request.command),
            baseVersion: workspace.plannerVersion - 1,
            resultVersion: workspace.plannerVersion,
            summary: "Updated step",
            target: request.command.stepId,
            changes: [],
            revertsEventId: null,
            chatTurnId: options.chatTurnId,
            occurredAt: options.now,
          });
          return {
            decision: {
              status: "accepted",
              eventId: `event-${workspace.plannerVersion}`,
              plannerVersion: workspace.plannerVersion,
            },
            workspace: runtime.readWorkspace(),
          };
        },
      },
    };
  }
}

class FakeAdapter {
  constructor(results = []) {
    this.results = [...results];
    this.calls = [];
    this.status = {
      available: true,
      authenticated: true,
      detail: "ready",
    };
  }

  async readStatus() {
    return this.status;
  }

  complete(request) {
    this.calls.push(request);
    assert.equal(this.runtime?.inTransaction ?? false, false);
    const result = this.results.shift();
    if (result instanceof Error) return Promise.reject(result);
    if (result?.promise) return result.promise;
    return Promise.resolve(
      result ?? { reply: "No planner change is needed.", command: null },
    );
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({ adapter = new FakeAdapter(), modelTimeoutMs = 1_000 } = {}) {
  const runtime = new FakeRuntime();
  adapter.runtime = runtime;
  const service = createChatApplicationService({
    ...runtime.ports,
    codexAdapter: adapter,
    modelTimeoutMs,
  });
  return { runtime, adapter, service };
}

function submitRequest(overrides = {}) {
  return {
    requestId: "request-1",
    basePlannerVersion: 0,
    message: "Move the rice into Sunday prep.",
    context: CONTEXT,
    ...overrides,
  };
}

test("submit persists a shared turn before Codex and builds a bounded canonical prompt", async () => {
  const { runtime, adapter, service } = createHarness();
  for (let index = 0; index < 20; index += 1) {
    runtime.data.workspace.transcriptEntries.push({
      sequence: index + 1,
      entryId: `old-${index}`,
      role: index % 2 ? "user" : "assistant",
      text: `old message ${index}`,
      context: null,
      turnId: null,
      occurredAt: index,
    });
  }

  const result = await service.submit(submitRequest());

  assert.equal(result.decision.status, "accepted");
  assert.equal(result.decision.turn.status, "completed");
  assert.equal(result.decision.turn.mutationOutcome, "no_command");
  assert.equal(adapter.calls.length, 1);
  assert.equal(runtime.data.workspace.transcriptEntries.at(-2).role, "user");
  assert.equal(runtime.data.workspace.transcriptEntries.at(-1).role, "assistant");
  assert.equal(runtime.data.workspace.syncRevision, 2);
  assert.match(adapter.calls[0].prompt, /"selectedWeek"/);
  assert.match(adapter.calls[0].prompt, /Move the rice into Sunday prep/);
  const transcriptJson = adapter.calls[0].prompt.match(
    /<recent_shared_transcript>\n(.*)\n<\/recent_shared_transcript>/,
  )[1];
  assert.ok(JSON.parse(transcriptJson).length <= 12);
  assert.doesNotMatch(adapter.calls[0].prompt, /browserState|arbitraryContext/);
});

test("submit is idempotent, rejects changed reuse, and exposes one shared busy turn", async () => {
  const pending = deferred();
  const adapter = new FakeAdapter([{ promise: pending.promise }]);
  const { runtime, service } = createHarness({ adapter });

  const firstPromise = service.submit(submitRequest());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.data.workspace.chatTurns[0].status, "running");
  assert.equal(runtime.data.workspace.transcriptEntries.length, 1);

  const duplicate = await service.submit(submitRequest());
  assert.equal(duplicate.decision.status, "accepted");
  assert.equal(duplicate.decision.turn.status, "running");
  assert.equal(adapter.calls.length, 1);

  const changedReuse = await service.submit(
    submitRequest({ message: "A different request." }),
  );
  assert.equal(changedReuse.decision.status, "request_id_reuse");

  const busy = await service.submit(
    submitRequest({ requestId: "request-2", message: "Another request." }),
  );
  assert.equal(busy.decision.status, "turn_busy");
  assert.equal(runtime.data.workspace.transcriptEntries.length, 1);

  pending.resolve({ reply: "Done.", command: null });
  const first = await firstPromise;
  assert.equal(first.decision.turn.status, "completed");
});

test("stale context is durably rejected before Codex is called", async () => {
  const { adapter, service } = createHarness();
  const result = await service.submit(submitRequest({ basePlannerVersion: 4 }));
  assert.deepEqual(result.decision, {
    status: "context_stale",
    expectedVersion: 4,
    actualVersion: 0,
  });
  assert.equal(adapter.calls.length, 0);
  const replay = await service.submit(submitRequest({ basePlannerVersion: 4 }));
  assert.deepEqual(replay.decision, result.decision);

  const browserState = await service.submit({
    ...submitRequest({ requestId: "request-with-state" }),
    state: { untrusted: true },
  });
  assert.equal(browserState.decision.status, "domain_rejected");
  assert.equal(adapter.calls.length, 0);
});

test("Codex unavailability is idempotent and does not create planner or transcript state", async () => {
  const adapter = new FakeAdapter();
  adapter.status = {
    available: false,
    authenticated: null,
    detail: "Codex app-server is offline.",
  };
  const { runtime, service } = createHarness({ adapter });

  const result = await service.submit(submitRequest());
  assert.deepEqual(result.decision, {
    status: "codex_unavailable",
    message: "Codex app-server is offline.",
  });
  assert.equal(runtime.data.workspace.chatTurns.length, 0);
  assert.equal(runtime.data.workspace.transcriptEntries.length, 0);
  assert.equal(runtime.data.workspace.plannerVersion, 0);
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual((await service.submit(submitRequest())).decision, result.decision);
});

test("timeout fences a late model result and retry reuses the durable user entry", async () => {
  const late = deferred();
  const adapter = new FakeAdapter([
    { promise: late.promise },
    { reply: "Retry completed.", command: null },
  ]);
  const { runtime, service } = createHarness({ adapter, modelTimeoutMs: 10 });

  const timedOut = await service.submit(submitRequest());
  assert.equal(timedOut.decision.turn.status, "failed");
  assert.equal(timedOut.decision.turn.mutationOutcome, "timed_out");
  assert.equal(runtime.data.workspace.transcriptEntries.length, 1);

  late.resolve({ reply: "Too late.", command: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.data.workspace.transcriptEntries.length, 1);
  assert.equal(runtime.data.workspace.chatTurns[0].status, "failed");

  const retried = await service.retry({
    requestId: "retry-1",
    basePlannerVersion: 0,
    turnId: timedOut.decision.turn.turnId,
  });
  assert.equal(retried.decision.turn.status, "completed");
  assert.equal(retried.decision.turn.retryOfTurnId, timedOut.decision.turn.turnId);
  assert.equal(runtime.data.workspace.chatTurns.length, 2);
  assert.equal(
    runtime.data.workspace.chatTurns[1].userEntryId,
    runtime.data.workspace.chatTurns[0].userEntryId,
  );
  assert.equal(
    runtime.data.workspace.transcriptEntries.filter((entry) => entry.role === "user").length,
    1,
  );
  assert.match(adapter.calls[1].prompt, /Move the rice into Sunday prep/);
});

test("assistant reply and optional planner command commit atomically", async () => {
  const command = {
    type: "setInstructionStepComplete",
    weekId: WEEK_ID,
    stepId: "step-1",
    complete: true,
  };
  const adapter = new FakeAdapter([{ reply: "The rice step is complete.", command }]);
  const { runtime, service } = createHarness({ adapter });

  const result = await service.submit(submitRequest());
  assert.equal(result.decision.turn.mutationOutcome, "applied");
  assert.equal(runtime.data.workspace.plannerVersion, 1);
  assert.equal(
    runtime.data.workspace.state.weeks[0].data.meals[0].instructions[0].complete,
    true,
  );
  assert.equal(runtime.kernelCalls[0].actor, "Codex");
  assert.equal(runtime.kernelCalls[0].request.requestId, `chat-command:${result.decision.turn.turnId}`);
  assert.equal(runtime.data.workspace.events[0].chatTurnId, result.decision.turn.turnId);
});

test("a planner advance during Codex produces a durable version-conflict outcome", async () => {
  const pending = deferred();
  const command = {
    type: "setInstructionStepComplete",
    weekId: WEEK_ID,
    stepId: "step-1",
    complete: true,
  };
  const adapter = new FakeAdapter([{ promise: pending.promise }]);
  const { runtime, service } = createHarness({ adapter });
  const submitted = service.submit(submitRequest());
  await new Promise((resolve) => setImmediate(resolve));
  runtime.data.workspace.plannerVersion = 1;
  pending.resolve({ reply: "I proposed completing the step.", command });

  const result = await submitted;
  assert.equal(result.decision.turn.status, "completed");
  assert.equal(result.decision.turn.mutationOutcome, "version_conflict");
  assert.equal(runtime.data.workspace.events.length, 0);
  assert.equal(runtime.data.workspace.transcriptEntries.at(-1).role, "assistant");
});

test("terminal failpoint rolls back planner, assistant, and turn outcome together", async () => {
  const command = {
    type: "setInstructionStepComplete",
    weekId: WEEK_ID,
    stepId: "step-1",
    complete: true,
  };
  const adapter = new FakeAdapter([{ reply: "Done.", command }]);
  const { runtime, service } = createHarness({ adapter });
  runtime.failpoint = "after_chat_terminal_write";

  await assert.rejects(service.submit(submitRequest()), /after_chat_terminal_write/);
  assert.equal(runtime.data.workspace.plannerVersion, 0);
  assert.equal(runtime.data.workspace.events.length, 0);
  assert.equal(runtime.data.workspace.transcriptEntries.length, 1);
  assert.equal(runtime.data.workspace.chatTurns[0].status, "running");
  assert.equal(
    runtime.data.workspace.state.weeks[0].data.meals[0].instructions[0].complete,
    false,
  );
});

test("post-mutation failpoint also rolls back the entire terminal transaction", async () => {
  const command = {
    type: "setInstructionStepComplete",
    weekId: WEEK_ID,
    stepId: "step-1",
    complete: true,
  };
  const adapter = new FakeAdapter([{ reply: "Done.", command }]);
  const { runtime, service } = createHarness({ adapter });
  runtime.failpoint = "after_planner_mutation";

  await assert.rejects(service.submit(submitRequest()), /after_planner_mutation/);
  assert.equal(runtime.data.workspace.plannerVersion, 0);
  assert.equal(runtime.data.workspace.events.length, 0);
  assert.equal(runtime.data.workspace.transcriptEntries.length, 1);
  assert.equal(runtime.data.workspace.chatTurns[0].status, "running");
});

test("startup interruption releases the shared running slot", async () => {
  const pending = deferred();
  const adapter = new FakeAdapter([{ promise: pending.promise }]);
  const { runtime, service } = createHarness({ adapter });
  void service.submit(submitRequest());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.interruptRunningTurns(5_000), 1);
  assert.equal(runtime.data.workspace.chatTurns[0].status, "interrupted");
  assert.equal(runtime.data.workspace.syncRevision, 2);
  pending.resolve({ reply: "Late.", command: null });
});
