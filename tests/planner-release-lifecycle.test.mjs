import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_LIFECYCLE_EVENTS,
  RELEASE_LIFECYCLE_STATES,
  derivePlannerReleaseLayout,
  ensurePrivateDirectory,
  planReleaseLifecycleTransition,
} from "../scripts/support/planner-release-contract.mjs";
import {
  ReleaseFaultInjector,
  createReleaseJournal,
  publishInitialReleaseJournal,
  planReleaseIntentRecovery,
  readReleaseJournal,
  recoverRecordedReleaseEffect,
  runRecordedReleaseEffect,
  verifyCompletedRecordedReleaseEffect,
} from "../scripts/support/planner-release-transaction.mjs";

const activationId = "33333333-3333-4333-8333-333333333333";

const matrix = {
  staged: {
    begin: ["transition", "preparing"],
    abort: ["transition", "restoring"],
    rollback: ["transition", "restoring"],
  },
  preparing: {
    begin: ["idempotent", "preparing"],
    park_previous: ["transition", "previous_pair_parked"],
    abort: ["transition", "restoring"],
    rollback: ["transition", "restoring"],
  },
  previous_pair_parked: {
    park_previous: ["idempotent", "previous_pair_parked"],
    select_app: ["transition", "candidate_app_selected"],
    abort: ["transition", "restoring"],
    rollback: ["transition", "restoring"],
  },
  candidate_app_selected: {
    select_app: ["idempotent", "candidate_app_selected"],
    select_data: ["transition", "candidate_pair_selected"],
    abort: ["transition", "restoring"],
    rollback: ["transition", "restoring"],
  },
  candidate_pair_selected: {
    select_data: ["idempotent", "candidate_pair_selected"],
    publish_current: ["transition", "committed"],
    abort: ["transition", "restoring"],
    rollback: ["transition", "restoring"],
  },
  committed: {
    publish_current: ["idempotent", "committed"],
    abort: ["transition", "restoring"],
    rollback: ["transition", "restoring"],
  },
  restoring: {
    abort: ["idempotent", "restoring"],
    rollback: ["idempotent", "restoring"],
    restore_app: ["transition", "previous_app_restored"],
  },
  previous_app_restored: {
    abort: ["idempotent", "previous_app_restored"],
    rollback: ["idempotent", "previous_app_restored"],
    restore_app: ["idempotent", "previous_app_restored"],
    restore_data: ["transition", "previous_pair_restored"],
  },
  previous_pair_restored: {
    abort: ["idempotent", "previous_pair_restored"],
    rollback: ["idempotent", "previous_pair_restored"],
    restore_app: ["idempotent", "previous_pair_restored"],
    restore_data: ["idempotent", "previous_pair_restored"],
    publish_rollback: ["transition", "rolled_back"],
  },
  rolled_back: {
    abort: ["idempotent", "rolled_back"],
    rollback: ["idempotent", "rolled_back"],
    restore_app: ["idempotent", "rolled_back"],
    restore_data: ["idempotent", "rolled_back"],
    publish_rollback: ["idempotent", "rolled_back"],
  },
  intervention_required: {},
};

test("reduced release lifecycle exhaustively matches the accepted state/event matrix", () => {
  for (const state of RELEASE_LIFECYCLE_STATES) {
    for (const event of RELEASE_LIFECYCLE_EVENTS) {
      const guards = {
        hashChainValid: true,
        rollbackGuardPasses: true,
      };
      const result = planReleaseLifecycleTransition(state, event, guards);
      if (event === "ambiguous") {
        const expected = state === "intervention_required"
          ? ["idempotent", "intervention_required"]
          : ["intervention", "intervention_required"];
        assert.deepEqual([result.outcome, result.nextState], expected, `${state}/${event}`);
        continue;
      }
      const expected = matrix[state][event] ?? ["reject", state];
      assert.deepEqual([result.outcome, result.nextState], expected, `${state}/${event}`);
    }
  }
});

test("commit and post-commit rollback remain closed until their exact guards pass", () => {
  assert.deepEqual(
    planReleaseLifecycleTransition("candidate_pair_selected", "publish_current"),
    {
      state: "candidate_pair_selected",
      event: "publish_current",
      outcome: "reject",
      nextState: "candidate_pair_selected",
      reason: "full_hash_chain_required",
    },
  );
  assert.equal(
    planReleaseLifecycleTransition("candidate_pair_selected", "publish_current", {
      hashChainValid: true,
    }).nextState,
    "committed",
  );
  assert.equal(
    planReleaseLifecycleTransition("committed", "rollback").outcome,
    "reject",
  );
  assert.equal(
    planReleaseLifecycleTransition("committed", "rollback", {
      rollbackGuardPasses: true,
    }).nextState,
    "restoring",
  );
});

test("intent recovery direction is determined by the durable restoring transition", () => {
  const intent = {
    sequence: 1,
    kind: "intent",
    effectId: "1:adopt_authenticated_agent",
    effect: "adopt_authenticated_agent",
  };
  assert.equal(planReleaseIntentRecovery({
    state: "candidate_app_selected",
    entries: [intent],
  }).action, "recover_forward");
  assert.equal(planReleaseIntentRecovery({
    state: "restoring",
    entries: [intent, {
      sequence: 2,
      kind: "transition",
      fromState: "candidate_app_selected",
      toState: "restoring",
    }],
  }).action, "settle_failed_forward");
  assert.equal(planReleaseIntentRecovery({
    state: "restoring",
    entries: [{
      sequence: 1,
      kind: "transition",
      fromState: "candidate_app_selected",
      toState: "restoring",
    }, { ...intent, sequence: 2, effectId: "2:restore_previous_app" }],
  }).action, "recover_compensation");
});

test("intent recovery rejects ambiguous compensation direction", () => {
  const journal = {
    state: "restoring",
    entries: [{
      sequence: 1,
      kind: "intent",
      effectId: "1:selection",
      effect: "selection",
    }],
  };
  assert.throws(
    () => planReleaseIntentRecovery(journal),
    /one durable compensation transition/,
  );
  assert.throws(
    () => planReleaseIntentRecovery({
      ...journal,
      entries: [...journal.entries, {
        sequence: 2,
        kind: "transition",
        fromState: "committed",
        toState: "restoring",
      }],
    }),
    /Post-commit rollback cannot inherit/,
  );
});

async function journalFixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planner-release-journal-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = derivePlannerReleaseLayout(home, activationId);
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.releasesRoot);
  await ensurePrivateDirectory(layout.transactionRoot);
  const journal = createReleaseJournal(activationId, {
    clock: () => new Date("2026-07-11T12:00:00.000Z"),
  });
  await publishInitialReleaseJournal(layout.journalPath, journal);
  return { layout, journal };
}

function statefulEffect(state, name = "selection") {
  const expected = {
    pre: { selected: false, identity: "old" },
    post: { selected: true, identity: "candidate" },
  };
  return {
    name,
    expected,
    replay: {
      schemaVersion: 1,
      kind: "activation-port",
      operation: name,
      fixture: "stateful-effect",
    },
    async inspect() {
      const identity = structuredClone(state.identity);
      if (JSON.stringify(identity) === JSON.stringify(expected.pre)) {
        return { classification: "pre", identity };
      }
      if (JSON.stringify(identity) === JSON.stringify(expected.post)) {
        return { classification: "post", identity };
      }
      return { classification: "neither", identity };
    },
    async perform() {
      state.identity = structuredClone(expected.post);
      state.performs += 1;
    },
  };
}

test("recovery replays an intent that is still exact pre-state", async (t) => {
  const { layout, journal } = await journalFixture(t);
  const state = { identity: { selected: false, identity: "old" }, performs: 0 };
  const fault = new ReleaseFaultInjector("after_intent:selection");
  await assert.rejects(runRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal,
    effect: statefulEffect(state),
    faultInjector: fault,
  }), /Injected release fault/);
  assert.equal(state.performs, 0);

  const interrupted = await readReleaseJournal(layout.journalPath, activationId);
  const recovered = await recoverRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal: interrupted,
    createEffect: async () => statefulEffect(state),
  });
  assert.equal(recovered.replayed, true);
  assert.equal(state.performs, 1);
  assert.deepEqual(state.identity, { selected: true, identity: "candidate" });
  assert.equal(recovered.journal.entries.at(-1).kind, "completed");
});

test("recovery records completion without replay when the durable post-state already exists", async (t) => {
  const { layout, journal } = await journalFixture(t);
  const state = { identity: { selected: false, identity: "old" }, performs: 0 };
  const fault = new ReleaseFaultInjector("after_effect:selection");
  await assert.rejects(runRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal,
    effect: statefulEffect(state),
    faultInjector: fault,
  }), /Injected release fault/);
  assert.equal(state.performs, 1);
  const recovered = await recoverRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal: await readReleaseJournal(layout.journalPath, activationId),
    createEffect: async () => statefulEffect(state),
  });
  assert.equal(recovered.replayed, false);
  assert.equal(state.performs, 1);
});

test("recovery moves neither-pre-nor-post effects to intervention instead of guessing", async (t) => {
  const { layout, journal } = await journalFixture(t);
  const state = { identity: { selected: false, identity: "old" }, performs: 0 };
  await assert.rejects(runRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal,
    effect: statefulEffect(state),
    faultInjector: new ReleaseFaultInjector("after_intent:selection"),
  }));
  state.identity = { selected: true, identity: "unknown" };
  await assert.rejects(recoverRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal: await readReleaseJournal(layout.journalPath, activationId),
    createEffect: async () => statefulEffect(state),
  }), /neither exact pre-state nor post-state/);
  assert.equal((await readReleaseJournal(layout.journalPath)).state, "intervention_required");
});

test("a completed effect is not trusted by name after its exact post-state drifts", async (t) => {
  const { layout, journal } = await journalFixture(t);
  const state = { identity: { selected: false, identity: "old" }, performs: 0 };
  await runRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal,
    effect: statefulEffect(state),
  });
  state.identity = { selected: false, identity: "old" };
  const completed = await readReleaseJournal(layout.journalPath, activationId);
  await assert.rejects(verifyCompletedRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal: completed,
    effect: statefulEffect(state),
  }), /no longer has its exact post-state/);
  assert.equal((await readReleaseJournal(layout.journalPath)).state, "intervention_required");
});

test("durable effect replay descriptors reject credential-bearing payload keys", async (t) => {
  const { layout, journal } = await journalFixture(t);
  const state = { identity: { selected: false, identity: "old" }, performs: 0 };
  const effect = statefulEffect(state);
  effect.replay = {
    schemaVersion: 1,
    kind: "activation-port",
    operation: "selection",
    refreshToken: "must-not-enter-the-journal",
  };
  await assert.rejects(runRecordedReleaseEffect({
    journalPath: layout.journalPath,
    journal,
    effect,
  }), /forbidden credential material/);
});
