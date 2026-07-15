import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { createEmbeddedChatApplicationService } from "../server/chat/embedded-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function dynamicCall(callId, tool, argumentsValue) {
  return {
    appServerThreadId: "planner-thread",
    appServerTurnId: "planner-turn",
    appServerCallId: callId,
    namespace: "planner",
    tool,
    arguments: argumentsValue,
  };
}

function recipeDraft(instruction = "Simmer until tender.") {
  return {
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/lentil-soup",
    },
    title: "Lentil soup",
    yieldText: "4 bowls",
    steps: [{
      inputs: [
        { amount: "1 cup", ingredient: "lentils" },
        { amount: "1 cup", ingredient: "lentils" },
      ],
      instruction,
      timerDurationSeconds: 900,
    }],
  };
}

function replacement(candidate, weekId, mealId) {
  return {
    type: "replaceMealRecipeFromSource",
    weekId,
    mealId,
    recipe: {
      title: candidate.title,
      ...(candidate.yieldText === undefined ? {} : { yieldText: candidate.yieldText }),
      source: candidate.source,
      steps: candidate.steps,
    },
  };
}

function createFixture(t, initialBehavior, draftFactory = () => recipeDraft()) {
  const directory = mkdtempSync(join(tmpdir(), "planner-research-intake-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  let store = openPlannerStore({ filename });
  let closed = false;
  t.after(() => {
    if (!closed) store.close();
  });
  let id = 0;
  let now = Date.parse("2026-07-11T12:00:00-03:00");
  let researchCount = 0;
  const researchEvidenceObservations = [];
  let behavior = initialBehavior;
  let armedFailpoint = null;
  const idFactory = { createId: (prefix) => `${prefix}-${++id}` };
  const clock = { now: () => now++ };
  const failureInjector = {
    hit(point) {
      if (point === armedFailpoint) {
        armedFailpoint = null;
        throw new Error(`failpoint:${point}`);
      }
    },
  };
  const seedFactory = () => {
    const seed = createCanonicalSeed({
      now: clock.now(),
      createId: (prefix) => idFactory.createId(prefix),
    });
    const week = seed.weeks.find((candidate) => candidate.id === seed.activeWeekId);
    const meal = week.data.meals[0];
    week.data.prep = [];
    meal.status = "planned";
    for (const step of meal.instructions) {
      step.complete = false;
      delete step.note;
      delete step.timerStartedAt;
    }
    return seed;
  };

  const researchSession = {
    async run() {
      researchCount += 1;
      return {
        draft: structuredClone(draftFactory(researchCount)),
        appServerThreadId: `research-thread-${researchCount}`,
        appServerTurnId: `research-turn-${researchCount}`,
        observedWebSearchOperation: {
          operation: "web_search",
          status: "completed",
          appServerItemId: `research-web-search-${researchCount}`,
        },
        modelVisibleTools: ["update_plan", "web_search"],
        observedNotifications: [],
      };
    },
  };
  const dynamicSession = {
    async run(request) {
      const identity = {
        appServerThreadId: "planner-thread",
        appServerTurnId: "planner-turn",
      };
      assert.equal(await request.host.bindAppServerTurn(identity), true);
      return behavior(request, identity);
    },
  };

  let planner;
  let harness;
  function compose() {
    planner = createPlannerApplicationService({
      store,
      domain: householdDomain,
      seedFactory,
      transformLegacyV2: () => { throw new Error("legacy import outside fixture"); },
      clock,
      idFactory,
      failureInjector,
    });
    harness = createEmbeddedChatApplicationService({
      transactionRunner: store,
      persistence: store,
      plannerMutationKernel: planner,
      plannerRead: store,
      clock,
      idFactory,
      failureInjector,
      dynamicSession,
      researchSession,
      researchEvidenceObserver: (observation) => researchEvidenceObservations.push(observation),
    });
  }
  compose();
  const seeded = planner.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const week = seeded.workspace.state.weeks.find(
    (candidate) => candidate.id === seeded.workspace.state.activeWeekId,
  );
  const meal = week.data.meals[0];

  return {
    filename,
    week,
    meal,
    get store() { return store; },
    get planner() { return planner; },
    get harness() { return harness; },
    get researchCount() { return researchCount; },
    get researchEvidenceObservations() { return researchEvidenceObservations; },
    setBehavior(next) { behavior = next; },
    arm(point) { armedFailpoint = point; },
    request(requestId = "source-submit") {
      return {
        requestId,
        basePlannerVersion: planner.readWorkspace().plannerVersion,
        message: "Find and use a lentil soup recipe for this dinner.",
        context: { view: "tonight", weekId: week.id, mealId: meal.id },
        intent: { kind: "sourced_recipe" },
      };
    },
    restart() {
      store.close();
      store = openPlannerStore({ filename });
      closed = false;
      compose();
    },
  };
}

async function captureApplicationOutput(work) {
  const limit = 1_048_576;
  const stdout = [];
  const stderr = [];
  const logger = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (target) => function captureWrite(chunk, encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const current = target.reduce((count, entry) => count + Buffer.byteLength(entry), 0);
    if (current < limit) target.push(text.slice(0, limit - current));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };
  process.stdout.write = capture(stdout);
  process.stderr.write = capture(stderr);
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...values) => {
      const text = values.map((value) => typeof value === "string"
        ? value
        : JSON.stringify(value)).join(" ");
      const current = logger.reduce((count, entry) => count + Buffer.byteLength(entry), 0);
      if (current < limit) logger.push(text.slice(0, limit - current));
    };
  }
  try {
    return { result: await work(), stdout, stderr, logger };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    Object.assign(console, originalConsole);
  }
}

function allApplicationTableRows(store) {
  const tables = store.database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  return Object.fromEntries(tables.map((table) => [
    table,
    store.database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all(),
  ]));
}

function downgradeResearchReferenceToLegacy(store, turnId) {
  const row = store.database.prepare(
    "SELECT research_candidate_json FROM chat_turns WHERE turn_id = ?",
  ).get(turnId);
  const reference = JSON.parse(row.research_candidate_json);
  delete reference.digestVersion;
  delete reference.replacementDigest;
  store.database.exec("DROP TRIGGER chat_turn_research_candidate_once");
  store.database.prepare(
    "UPDATE chat_turns SET research_candidate_json = ? WHERE turn_id = ?",
  ).run(JSON.stringify(reference), turnId);
  return reference;
}

test("sourced intake transfers one candidate, admits exact source, and persists only compact intent", async (t) => {
  let fixture;
  let fullCandidateJson;
  let candidateId;
  const acceptedRecipeField = "ACCEPTED_RECIPE_INSTRUCTION_UNIQUE_TO_ALLOWED_PROJECTIONS";
  fixture = createFixture(t, async (request, identity) => {
    assert.equal(request.mode, "normal");
    assert.equal(request.timeoutMs, 180_000);
    assert.equal(typeof request.researchCandidateJson, "string");
    fullCandidateJson = request.researchCandidateJson;
    const candidate = JSON.parse(request.researchCandidateJson);
    candidateId = candidate.candidateId;
    assert.equal(request.prompt.includes(candidate.candidateId), false);
    assert.equal(request.prompt.includes(request.researchCandidateJson), false);
    const command = replacement(candidate, fixture.week.id, fixture.meal.id);
    const preview = await request.host.dispatchPlannerTool(dynamicCall(
      "source-preview",
      "preview",
      { basePlannerVersion: 0, operations: [{ command }] },
    ));
    assert.equal(preview.ok, true);
    const applied = await request.host.dispatchPlannerTool(dynamicCall(
      "source-apply",
      "apply",
      {
        basePlannerVersion: 0,
        operations: [{ command }],
        readback: { kind: "meal", weekId: fixture.week.id, mealId: fixture.meal.id },
      },
    ));
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.data.readback.meal.ingredients, [
      "1 cup lentils",
      "1 cup lentils",
    ]);
    assert.equal(await request.host.completeTurn(identity, "I replaced the dinner recipe."), true);
    return { reply: "I replaced the dinner recipe." };
  }, () => recipeDraft(acceptedRecipeField));

  const captured = await captureApplicationOutput(() =>
    fixture.harness.submit(fixture.request())
  );
  const response = captured.result;
  assert.equal(response.decision.status, "accepted");
  const turn = response.decision.turn;
  assert.equal(turn.status, "completed");
  assert.equal(turn.researchKind, "sourced_recipe");
  assert.deepEqual(turn.foregroundAuthority, []);
  assert.equal(turn.researchCandidate.stepCount, 1);
  assert.equal(turn.researchCandidate.digestVersion, 1);
  assert.match(turn.researchCandidate.replacementDigest, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(turn.researchCandidate, "steps"), false);
  assert.equal(turn.acceptedEffectCount, 1);
  assert.deepEqual(fixture.researchEvidenceObservations, [{
    durableTurnId: turn.turnId,
    appServerThreadId: "research-thread-1",
    appServerTurnId: "research-turn-1",
    appServerItemId: "research-web-search-1",
    operation: "web_search",
    status: "completed",
  }]);

  const exported = fixture.planner.exportWorkspace();
  const acceptedProjection = JSON.stringify({ state: exported.state, events: exported.events });
  assert.equal(acceptedProjection.includes(turn.researchCandidate.candidateId), false);
  assert.equal(acceptedProjection.includes("Lentil soup"), true);
  assert.equal(JSON.stringify(exported.transcriptEntries).includes("Simmer until tender"), false);
  const storedReference = fixture.store.database.prepare(
    "SELECT research_candidate_json FROM chat_turns WHERE turn_id = ?",
  ).get(turn.turnId).research_candidate_json;
  assert.deepEqual(JSON.parse(storedReference), turn.researchCandidate);
  assert.equal(storedReference.includes("steps"), false);
  assert.equal(storedReference.includes("lentils"), false);

  const rows = allApplicationTableRows(fixture.store);
  const candidateIdCells = [];
  const acceptedRecipeCells = [];
  for (const [table, tableRows] of Object.entries(rows)) {
    for (const [rowIndex, row] of tableRows.entries()) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        const projection = `${table}[${rowIndex}].${column}`;
        if (value.includes(candidateId)) candidateIdCells.push(projection);
        if (value.includes(acceptedRecipeField)) acceptedRecipeCells.push(projection);
      }
    }
  }
  assert.deepEqual(candidateIdCells, ["chat_turns[0].research_candidate_json"]);
  assert.equal(JSON.stringify(rows).includes(fullCandidateJson), false);
  assert.equal(acceptedRecipeCells.length > 0, true);
  const allowedAcceptedRecipeColumns = new Set([
    "workspace.state_json",
    "planner_events.command_json",
    "planner_tool_calls.result_envelope_json",
  ]);
  assert.equal(
    acceptedRecipeCells.every((projection) =>
      allowedAcceptedRecipeColumns.has(projection.replace(/\[[0-9]+\]/, ""))
    ),
    true,
    `accepted recipe field escaped accepted state/event/command/readback projections: ${acceptedRecipeCells.join(", ")}`,
  );
  for (const requiredProjection of [
    "workspace.state_json",
    "planner_events.command_json",
    "planner_tool_calls.result_envelope_json",
  ]) {
    assert.equal(
      acceptedRecipeCells.some((projection) =>
        projection.replace(/\[[0-9]+\]/, "") === requiredProjection
      ),
      true,
      `${requiredProjection} should contain the accepted recipe field`,
    );
  }
  const exportedJson = JSON.stringify(exported);
  assert.equal(exportedJson.includes(fullCandidateJson), false);
  assert.equal(JSON.stringify({
    state: exported.state,
    events: exported.events,
    transcriptEntries: exported.transcriptEntries,
  }).includes(candidateId), false);
  assert.equal(JSON.stringify(exported.chatTurns).includes(candidateId), true);
  assert.equal(
    exported.chatTurns.filter((chatTurn) =>
      chatTurn.researchCandidate?.candidateId === candidateId
    ).length,
    1,
  );
  assert.equal(JSON.stringify(exported.transcriptEntries).includes(acceptedRecipeField), false);
  assert.equal(JSON.stringify(exported.state).includes(acceptedRecipeField), true);
  assert.equal(JSON.stringify(exported.events).includes(acceptedRecipeField), true);
  const capturedOutput = JSON.stringify({
    stdout: captured.stdout,
    stderr: captured.stderr,
    logger: captured.logger,
  });
  assert.equal(capturedOutput.includes(candidateId), false);
  assert.equal(capturedOutput.includes(fullCandidateJson), false);
  assert.equal(capturedOutput.includes(acceptedRecipeField), false);
  const forbiddenArtifactKeys = [
    "pageBody", "html", "markdown", "excerpt", "metadata", "attachment",
  ];
  const applicationProjection = `${JSON.stringify(rows)}\n${exportedJson}\n${capturedOutput}`;
  for (const key of forbiddenArtifactKeys) {
    assert.equal(applicationProjection.includes(`"${key}"`), false, key);
  }
  fixture.store.database.exec("PRAGMA wal_checkpoint(FULL)");
  const persistedBytes = [fixture.filename, `${fixture.filename}-wal`]
    .filter(existsSync)
    .map((path) => readFileSync(path).toString("utf8"))
    .join("\n");
  assert.equal(persistedBytes.includes(fullCandidateJson), false);
  for (const key of forbiddenArtifactKeys) {
    assert.equal(persistedBytes.includes(`"${key}"`), false, key);
  }
  // Private Codex runtime logs are intentionally outside this application-containment claim.
});

test("hostile candidate fields never enter application persistence on pre-acceptance failure", async (t) => {
  const sentinel = "PROMPT_INJECTION_SENTINEL_DO_NOT_PERSIST";
  const fixture = createFixture(t, async (request, identity) => {
    const candidate = JSON.parse(request.researchCandidateJson);
    assert.equal(candidate.steps[0].instruction, sentinel);
    await request.host.failTurn(identity, {
      code: "TURN_FAILED",
      detail: "Research candidate was rejected before planner acceptance.",
    });
    throw new Error("fixture ends after durable failure");
  }, () => recipeDraft(sentinel));

  const captured = await captureApplicationOutput(() =>
    fixture.harness.submit(fixture.request("source-hostile"))
  );
  const response = captured.result;
  assert.equal(response.decision.status, "accepted");
  assert.equal(response.decision.turn.status, "failed");
  assert.equal(response.decision.turn.terminalOutcome, "failed_no_effect");
  const textColumns = {
    workspace: fixture.store.database.prepare("SELECT state_json FROM workspace").all(),
    turns: fixture.store.database.prepare(
      "SELECT research_candidate_json, error_code, error_detail FROM chat_turns",
    ).all(),
    transcript: fixture.store.database.prepare("SELECT text FROM transcript_entries").all(),
    receipts: fixture.store.database.prepare("SELECT decision_json FROM command_receipts").all(),
    events: fixture.store.database.prepare("SELECT command_json, changes_json FROM planner_events").all(),
    outcomes: fixture.store.database.prepare(
      "SELECT result_envelope_json FROM planner_tool_calls",
    ).all(),
  };
  assert.equal(JSON.stringify(textColumns).includes(sentinel), false);
  assert.equal(JSON.stringify(allApplicationTableRows(fixture.store)).includes(sentinel), false);
  assert.equal(JSON.stringify(fixture.planner.exportWorkspace()).includes(sentinel), false);
  assert.equal(JSON.stringify({
    stdout: captured.stdout,
    stderr: captured.stderr,
    logger: captured.logger,
  }).includes(sentinel), false);
  fixture.store.database.exec("PRAGMA wal_checkpoint(FULL)");
  const sqliteFiles = [fixture.filename, `${fixture.filename}-wal`]
    .filter(existsSync)
    .map((path) => readFileSync(path).toString("utf8"));
  assert.equal(sqliteFiles.join("\n").includes(sentinel), false);
  assert.equal(fixture.store.readAllEvents().length, 0);
  assert.equal(fixture.store.readInitializedWorkspace().plannerVersion, 0);
});

test("preview and apply reject lost or mismatched candidate binding with zero planner effect", async (t) => {
  let fixture;
  const rejectBothTools = async (request, command, label) => {
    for (const [tool, argumentsValue] of [
      ["preview", { basePlannerVersion: 0, operations: [{ command }] }],
      ["apply", {
        basePlannerVersion: 0,
        operations: [{ command }],
        readback: { kind: "meal", weekId: fixture.week.id, mealId: fixture.meal.id },
      }],
    ]) {
      const result = await request.host.dispatchPlannerTool(dynamicCall(
        `candidate-${tool}-${label}`,
        tool,
        argumentsValue,
      ));
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "NOT_AUTHORIZED");
      assert.equal(result.error.operationIndex, 0);
      assert.equal(result.error.message,
        "Sourced recipe replacement lost its exact research-candidate binding.");
    }
  };
  fixture = createFixture(t, async (request, identity) => {
    const draft = recipeDraft();
    const command = {
      type: "replaceMealRecipeFromSource",
      weekId: fixture.week.id,
      mealId: fixture.meal.id,
      recipe: {
        ...draft,
        source: { ...draft.source, retrievedAt: 1_750_000_000_000 },
      },
    };
    await rejectBothTools(request, command, "lost");
    assert.equal(await request.host.completeTurn(identity, "No recipe was changed."), true);
    return { reply: "No recipe was changed." };
  }, () => ({
    ...recipeDraft(),
    steps: [
      {
        inputs: [
          { amount: "1 cup", ingredient: "lentils" },
          { amount: "2 cups", ingredient: "water" },
        ],
        instruction: "Simmer until tender.",
        timerDurationSeconds: 900,
      },
      {
        inputs: [{ amount: "1 tsp", ingredient: "salt" }],
        instruction: "Season before serving.",
      },
    ],
  }));
  const lost = await fixture.harness.submit(fixture.request("lost-candidate"));
  assert.equal(lost.decision.turn.status, "completed");
  assert.equal(lost.decision.turn.acceptedEffectCount, 0);

  fixture.setBehavior(async (request, identity) => {
    const candidate = JSON.parse(request.researchCandidateJson);
    const exact = replacement(candidate, fixture.week.id, fixture.meal.id);
    const mutations = new Map([
      ["title", (recipe) => { recipe.title = "Altered soup"; }],
      ["yield-value", (recipe) => { recipe.yieldText = "6 bowls"; }],
      ["yield-presence", (recipe) => { delete recipe.yieldText; }],
      ["source-identity", (recipe) => { recipe.source.identity = "Other Kitchen"; }],
      ["source-url", (recipe) => { recipe.source.url = "https://example.com/recipes/other"; }],
      ["source-retrieved", (recipe) => { recipe.source.retrievedAt += 1; }],
      ["step-count", (recipe) => { recipe.steps.pop(); }],
      ["step-order", (recipe) => { recipe.steps.reverse(); }],
      ["input-count", (recipe) => { recipe.steps[0].inputs.pop(); }],
      ["input-order", (recipe) => { recipe.steps[0].inputs.reverse(); }],
      ["amount", (recipe) => { recipe.steps[0].inputs[0].amount = "3 cups"; }],
      ["ingredient", (recipe) => { recipe.steps[0].inputs[0].ingredient = "peas"; }],
      ["instruction", (recipe) => { recipe.steps[0].instruction = "Boil rapidly."; }],
      ["timer-value", (recipe) => { recipe.steps[0].timerDurationSeconds = 901; }],
      ["timer-presence", (recipe) => { delete recipe.steps[0].timerDurationSeconds; }],
    ]);
    for (const [label, mutate] of mutations) {
      const command = structuredClone(exact);
      mutate(command.recipe);
      await rejectBothTools(request, command, label);
    }
    assert.equal(await request.host.completeTurn(identity, "No recipe was changed."), true);
    return { reply: "No recipe was changed." };
  });
  const mismatch = await fixture.harness.submit(
    fixture.request("mismatched-candidate"),
  );
  assert.equal(mismatch.decision.turn.status, "completed");
  assert.equal(mismatch.decision.turn.acceptedEffectCount, 0);
  const hostileCalls = fixture.store.readTransaction((transaction) =>
    fixture.store.readPlannerToolCalls(transaction, mismatch.decision.turn.turnId)
  );
  assert.equal(hostileCalls.length, 30);
  assert.equal(hostileCalls.every((call) =>
    call.status === "rejected" && call.resultEnvelope?.error?.code === "NOT_AUTHORIZED"
  ), true);
  assert.equal(fixture.store.database.prepare(
    "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'embedded_codex_apply_planner_operations_v1'",
  ).get().count, 0);
  const workspace = fixture.planner.readWorkspace();
  assert.equal(workspace.plannerVersion, 0);
  assert.equal(workspace.events.length, 0);
  assert.equal(workspace.state.weeks[0].data.meals[0].title, fixture.meal.title);
});

test("research-session failure retries as fresh sourced research", async (t) => {
  const fixture = createFixture(t, async (request, identity) => {
    assert.equal(await request.host.completeTurn(identity, "Fresh research succeeded."), true);
    return { reply: "Fresh research succeeded." };
  }, (count) => {
    if (count === 1) throw new Error("synthetic research failure");
    return recipeDraft();
  });
  const failed = await fixture.harness.submit(
    fixture.request("research-failure"),
  );
  assert.equal(failed.decision.turn.status, "failed");
  assert.equal(failed.decision.turn.terminalOutcome, "failed_no_effect");
  assert.equal(failed.decision.turn.researchCandidate, null);
  const retried = await fixture.harness.retry({
    requestId: "research-failure-retry",
    basePlannerVersion: 0,
    turnId: failed.decision.turn.turnId,
  });
  assert.equal(retried.decision.turn.status, "completed");
  assert.equal(retried.decision.turn.mode, "normal");
  assert.equal(retried.decision.turn.researchKind, "sourced_recipe");
  assert.notEqual(retried.decision.turn.researchCandidate, null);
  assert.equal(fixture.researchCount, 2);
});

test("crash after compact attachment restarts as no-effect and retry researches fresh", async (t) => {
  const candidateIds = [];
  const fixture = createFixture(t, async (request, identity) => {
    candidateIds.push(JSON.parse(request.researchCandidateJson).candidateId);
    assert.equal(await request.host.completeTurn(identity, "Fresh research completed."), true);
    return { reply: "Fresh research completed." };
  });
  fixture.arm("after_research_candidate_attachment");
  await assert.rejects(
    fixture.harness.submit(fixture.request("source-crash")),
    /after_research_candidate_attachment/,
  );
  const old = fixture.store.readAllChatTurns().at(-1);
  assert.equal(old.status, "running");
  assert.equal(old.researchCandidate !== null, true);
  assert.equal(old.appServerThreadId, null);
  const legacyReference = downgradeResearchReferenceToLegacy(fixture.store, old.turnId);
  assert.equal(Object.hasOwn(legacyReference, "replacementDigest"), false);

  fixture.restart();
  const readableLegacy = fixture.store.readAllChatTurns().find((turn) => turn.turnId === old.turnId);
  assert.equal(readableLegacy.researchCandidate.candidateId, old.researchCandidate.candidateId);
  assert.equal(Object.hasOwn(readableLegacy.researchCandidate, "replacementDigest"), false);
  assert.equal(fixture.harness.interruptRunningTurns(), 1);
  const interrupted = fixture.store.readAllChatTurns().find((turn) => turn.turnId === old.turnId);
  assert.equal(interrupted.terminalOutcome, "interrupted_no_effect");
  const retried = await fixture.harness.retry({
    requestId: "source-crash-retry",
    basePlannerVersion: 0,
    turnId: old.turnId,
  });
  assert.equal(retried.decision.status, "accepted");
  assert.equal(retried.decision.turn.status, "completed");
  assert.equal(retried.decision.turn.mode, "normal");
  assert.equal(retried.decision.turn.researchKind, "sourced_recipe");
  assert.equal(fixture.researchCount, 2);
  candidateIds.unshift(old.researchCandidate.candidateId);
  assert.notEqual(candidateIds[0], retried.decision.turn.researchCandidate.candidateId);
});

test("after-effect retry remains recovery-only and never researches again", async (t) => {
  let fixture;
  fixture = createFixture(t, async (request, identity) => {
    const candidate = JSON.parse(request.researchCandidateJson);
    const applied = await request.host.dispatchPlannerTool(dynamicCall(
      "source-after-effect",
      "apply",
      {
        basePlannerVersion: 0,
        operations: [{ command: replacement(candidate, fixture.week.id, fixture.meal.id) }],
        readback: { kind: "meal", weekId: fixture.week.id, mealId: fixture.meal.id },
      },
    ));
    assert.equal(applied.ok, true);
    await request.host.failTurn(identity, {
      code: "TURN_FAILED",
      detail: "Reply failed after the accepted effect.",
    });
    throw new Error("reply failed");
  });
  const failed = await fixture.harness.submit(fixture.request("source-effect"));
  assert.equal(failed.decision.turn.terminalOutcome, "failed_after_effect");
  assert.equal(fixture.researchCount, 1);
  const legacyReference = downgradeResearchReferenceToLegacy(
    fixture.store,
    failed.decision.turn.turnId,
  );
  assert.equal(Object.hasOwn(legacyReference, "replacementDigest"), false);

  fixture.setBehavior(async (request, identity) => {
    assert.equal(request.mode, "recovery");
    assert.equal(request.researchCandidateJson, undefined);
    await request.host.failTurn(identity, {
      code: "TURN_FAILED",
      detail: "First recovery reply also failed.",
    });
    throw new Error("recovery reply failed");
  });
  const failedRecovery = await fixture.harness.retry({
    requestId: "source-effect-retry",
    basePlannerVersion: 1,
    turnId: failed.decision.turn.turnId,
  });
  assert.equal(failedRecovery.decision.turn.mode, "recovery");
  assert.equal(failedRecovery.decision.turn.researchKind, "none");
  assert.equal(failedRecovery.decision.turn.researchCandidate, null);
  assert.equal(failedRecovery.decision.turn.terminalOutcome, "recovery_failed");
  fixture.setBehavior(async (request, identity) => {
    assert.equal(request.mode, "recovery");
    assert.equal(request.researchCandidateJson, undefined);
    assert.equal(await request.host.completeTurn(identity, "Recovered durable result."), true);
    return { reply: "Recovered durable result." };
  });
  const recovered = await fixture.harness.retry({
    requestId: "source-effect-retry-again",
    basePlannerVersion: 1,
    turnId: failedRecovery.decision.turn.turnId,
  });
  assert.equal(recovered.decision.turn.mode, "recovery");
  assert.equal(recovered.decision.turn.researchKind, "none");
  assert.equal(recovered.decision.turn.researchCandidate, null);
  assert.equal(recovered.decision.turn.terminalOutcome, "recovery_completed");
  assert.equal(fixture.researchCount, 1);
});
