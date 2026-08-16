import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GLOBAL_CODEX_CONTRACT_VERSION,
  GLOBAL_CODEX_ROUTES,
} from "../../lib/global-codex-contract.ts";
import { householdDomain, validateHouseholdState } from "../../lib/household-domain.ts";
import { createCoreIngredientCatalogue } from "../../lib/ingredient-catalogue.ts";
import { isPlannerReadProjection, PLANNER_TOOL_NAMESPACE, projectPlannerRead } from "../../lib/planner-tool-contract.ts";
import {
  createPlannerApplicationService,
  hashCanonicalPayload,
} from "../../server/application/planner-service.ts";
import { createNativePlannerEffectHost } from "../../server/codex/planner-effect-host.ts";
import {
  createGlobalCodexPlannerPort,
  createGlobalCodexRouter,
} from "../../server/global-ingress/index.ts";
import { startGlobalCodexSocketServerForTests } from "../../server/global-ingress/socket-server.ts";
import { createApplicationRouter } from "../../server/http/application-router.ts";
import { closeHttpServer, listenHttpServer } from "../../server/http/server.ts";
import { createSqliteCodexThreadStore } from "../../server/store/codex-thread-store.ts";
import { openPlannerStore } from "../../server/store/sqlite-store.ts";

const ORIGIN = "http://localhost:3001";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function seedState() {
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-08-10",
    weeks: [{
      id: "2026-08-10",
      weekStartDate: "2026-08-10",
      status: "active",
      data: {
        meals: [{
          id: "meal-1",
          date: "2026-08-10",
          slot: "dinner",
          title: "Historical dinner",
          subtitle: "",
          venue: "home",
          status: "planned",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "",
          ingredients: [{ id: "ingredient-scallions", source: "2 scallions, sliced", amount: "2", unit: null, ingredient: "scallions", qualifier: "sliced", conceptId: null, role: "output", canonicalIngredientId: null }],
          instructions: [],
        }],
        prepSessions: [],
        groceries: [],
        leftovers: [],
        feedback: {},
        weekLesson: "",
      },
    }],
    ingredientCatalogue: createCoreIngredientCatalogue(),
  };
}

function historicalCommand() {
  return {
    type: "updateMealSnapshot",
    weekId: "2026-08-10",
    mealId: "meal-1",
    changes: {
      title: "Historical dinner",
      subtitle: "",
      venue: "home",
      prepNote: "",
      leftoverNote: "",
      notes: "",
      ingredients: ["2 red peppers", "2 red peppers"],
      yieldText: null,
    },
  };
}

function requestSocket(socketPath, body = null, path = GLOBAL_CODEX_ROUTES.batches, method = "POST") {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = requestHttp({
      socketPath,
      method,
      path,
      headers: {
        Host: "localhost",
        Connection: "close",
        ...(payload === null ? {} : { "Content-Type": "application/json", "Content-Length": String(payload.length) }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.once("error", reject);
    request.end(payload ?? undefined);
  });
}

function decodeNative(response) {
  assert.equal(response.contentItems.length, 1);
  return JSON.parse(response.contentItems[0].text);
}

test("one historical recipe receipt has identical replay-only semantics across HTTP, embedded Codex, and Global UDS", async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "occurrence-ingress-parity-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  const store = openPlannerStore({ filename });
  t.after(() => store.close());
  let id = 0;
  let now = 1_800_000_000_000;
  const planner = createPlannerApplicationService({
    store,
    domain: householdDomain,
    seedFactory: seedState,
    transformLegacyV2: () => { throw new Error("unused"); },
    clock: { now: () => now++ },
    idFactory: { createId: (prefix) => `${prefix}-${++id}` },
  });
  planner.bootstrap({ requestId: "bootstrap-ingress-parity", mode: "seed" });

  const command = historicalCommand();
  const operations = [{ command }];
  const httpRequest = { requestId: "historical-http-parity", basePlannerVersion: 0, command };
  const globalRequest = {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
    requestId: "7fa69016-df1b-44a9-a415-f0e69e50c03b",
    basePlannerVersion: 0,
    operations,
  };
  const nativeArguments = {
    basePlannerVersion: 0,
    operations,
    readback: { kind: "week", weekId: "2026-08-10" },
  };
  const nativeCall = {
    threadId: "thread-parity",
    turnId: "turn-parity",
    callId: "call-parity",
    namespace: PLANNER_TOOL_NAMESPACE,
    tool: "apply",
    arguments: nativeArguments,
  };
  const argumentHash = sha256(canonicalJson(nativeArguments));
  const nativeRequestId = `native-codex:${sha256([
    nativeCall.threadId,
    nativeCall.turnId,
    nativeCall.callId,
    nativeCall.namespace,
    nativeCall.tool,
    argumentHash,
  ].join("\0"))}`;
  const storedDecision = {
    status: "accepted",
    eventId: "historical-parity-event",
    plannerVersion: 1,
  };
  const expectedDecision = {
    ...storedDecision,
    occurrenceResults: [{ operationIndex: 0, occurrences: [] }],
  };
  const initial = planner.readWorkspace();
  store.transaction((transaction) => {
    assert.ok(store.updateWorkspace(transaction, initial.state, 0, 1));
    store.insertPlannerEvent(transaction, {
      eventId: storedDecision.eventId,
      requestId: "historical-source-request",
      actor: "Household",
      provenance: { actorClass: "household", actorSource: "browser", admission: "same_origin_http_v1" },
      command,
      baseVersion: 0,
      resultVersion: 1,
      summary: "Historical recipe update",
      target: "meal-1",
      changes: [],
      revertsEventId: null,
      chatTurnId: null,
      occurredAt: 1,
    }, initial.state);
    for (const receipt of [
      {
        operationKind: "planner_command",
        requestId: httpRequest.requestId,
        payloadHash: hashCanonicalPayload("planner_command", httpRequest),
      },
      {
        operationKind: "global_codex_apply_planner_batch_v1",
        requestId: globalRequest.requestId,
        payloadHash: hashCanonicalPayload("global_codex_apply_planner_batch_v1", {
          basePlannerVersion: globalRequest.basePlannerVersion,
          operations,
        }),
      },
      {
        operationKind: "native_codex_apply_planner_operations_v1",
        requestId: nativeRequestId,
        payloadHash: hashCanonicalPayload("native_codex_apply_planner_operations_v1", {
          basePlannerVersion: nativeArguments.basePlannerVersion,
          operations,
        }),
      },
    ]) {
      store.insertReceipt(transaction, {
        ...receipt,
        httpStatus: 200,
        decision: { kind: "planner_decision", decision: storedDecision },
        createdAt: 1,
      });
    }
  });
  const before = planner.readWorkspace();

  const handler = createApplicationRouter({
    planner,
    readHealth: () => { throw new Error("unused"); },
  }, { allowedOrigins: new Set([ORIGIN]), allowOriginlessMutations: false });
  const httpServer = await listenHttpServer({ handler, port: 0 });
  t.after(() => closeHttpServer(httpServer));
  const address = httpServer.address();
  assert.equal(typeof address, "object");
  const httpResponse = await fetch(`http://127.0.0.1:${address.port}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(httpRequest),
  });
  assert.equal(httpResponse.status, 200);
  assert.deepEqual((await httpResponse.json()).decision, expectedDecision);

  const globalParent = join(directory, "global-home", "meal-planner");
  mkdirSync(globalParent, { recursive: true, mode: 0o700 });
  const globalServer = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
    globalParent,
  );
  t.after(() => globalServer.close());
  const globalResponse = await requestSocket(
    join(globalParent, "run", "global-codex.sock"),
    globalRequest,
  );
  assert.equal(globalResponse.status, 200);
  assert.deepEqual(globalResponse.body.decision, expectedDecision);

  const nativeHost = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(store),
    isEligibleCall: () => true,
    now: () => now++,
  });
  const nativeResponse = decodeNative(await nativeHost.handle(nativeCall));
  assert.equal(nativeResponse.ok, true);
  assert.deepEqual({
    status: nativeResponse.data.status,
    eventId: nativeResponse.data.eventId,
    occurrenceResults: nativeResponse.data.occurrenceResults,
  }, {
    status: "replayed",
    eventId: storedDecision.eventId,
    occurrenceResults: expectedDecision.occurrenceResults,
  });

  const candidateOperations = [{ command: { type: "previewIngredientCandidates", inputs: [
    { correlationId: "candidate-one", occurrenceId: "ingredient-scallions", mealId: "meal-1", source: "2 scallions, sliced", amount: "2", unit: null, ingredient: "scallions", qualifier: "sliced", conceptId: null, canonicalIngredientId: null },
  ] } }];
  const previewRequest = { basePlannerVersion: before.plannerVersion, operations: candidateOperations };
  const browserPreviewResponse = await fetch(`http://127.0.0.1:${address.port}/api/operations/preview`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(previewRequest),
  });
  assert.equal(browserPreviewResponse.status, 200);
  const browserPreview = (await browserPreviewResponse.json()).decision;
  const globalPreview = await requestSocket(join(globalParent, "run", "global-codex.sock"), {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION, ...previewRequest,
  }, GLOBAL_CODEX_ROUTES.previews);
  assert.equal(globalPreview.status, 200);
  const nativePreview = decodeNative(await nativeHost.handle({
    threadId: "thread-parity", turnId: "turn-preview", callId: "call-preview", namespace: PLANNER_TOOL_NAMESPACE,
    tool: "preview", arguments: previewRequest,
  }));
  assert.equal(nativePreview.ok, true);
  assert.deepEqual(globalPreview.body.decision, browserPreview);
  assert.deepEqual(nativePreview.data, { status: browserPreview.status, outcomes: browserPreview.outcomes });
  assert.equal(browserPreview.outcomes[0].ingredientCandidatePreview.results[0].candidates[0].conceptId, "green-onion");

  const reviewed = browserPreview.outcomes[0].ingredientCandidatePreview;
  const resolutionInput = { correlationId: "candidate-one", occurrenceId: "ingredient-scallions", amount: "2", ingredient: "scallions" };
  const resolutionCommand = {
    type: "applyIngredientResolutionBatch", weekId: "2026-08-10", catalogueRevision: before.state.ingredientCatalogue.revision,
    inputDigest: reviewed.inputDigest, decisions: [{ ...resolutionInput, decision: { kind: "existing", conceptId: "green-onion" } }],
  };
  const [browserRace, globalRace, nativeRace] = await Promise.all([
    fetch(`http://127.0.0.1:${address.port}/api/commands`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ requestId: "catalogue-http-race", basePlannerVersion: before.plannerVersion, command: resolutionCommand }),
    }).then(async (response) => ({ status: response.status, body: await response.json() })),
    requestSocket(join(globalParent, "run", "global-codex.sock"), {
      contractVersion: GLOBAL_CODEX_CONTRACT_VERSION, requestId: "186ce6e0-b9bc-4d30-9924-bb766eabfd42",
      basePlannerVersion: before.plannerVersion, operations: [{ command: resolutionCommand }],
    }),
    nativeHost.handle({
      threadId: "thread-parity", turnId: "turn-catalogue-race", callId: "call-catalogue-race", namespace: PLANNER_TOOL_NAMESPACE,
      tool: "apply", arguments: { basePlannerVersion: before.plannerVersion, operations: [{ command: resolutionCommand }], readback: { kind: "workspace" } },
    }).then(decodeNative),
  ]);
  const raceOutcomes = [browserRace.body.decision.status, globalRace.body.decision.status, nativeRace.ok ? nativeRace.data.status : nativeRace.error.code];
  assert.equal(raceOutcomes.filter((status) => status === "accepted").length, 1, JSON.stringify(raceOutcomes));
  assert.equal(raceOutcomes.filter((status) => status === "version_conflict" || status === "VERSION_CONFLICT").length, 2);

  const afterRace = planner.readWorkspace();
  assert.equal(afterRace.plannerVersion, before.plannerVersion + 1);
  assert.equal(afterRace.state.weeks[0].data.meals[0].ingredients[0].conceptId, "green-onion");
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM planner_events").get().count, 2);

  const beforeLiteral = structuredClone(afterRace.state.weeks[0].data.meals[0].ingredients[0]);
  const renameResponse = await fetch(`http://127.0.0.1:${address.port}/api/commands`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ requestId: "catalogue-rename", basePlannerVersion: afterRace.plannerVersion, command: { type: "renameIngredientConcept", conceptId: "green-onion", preferredLabel: "Spring onion" } }),
  });
  assert.equal(renameResponse.status, 200);
  const renamed = await renameResponse.json();
  assert.equal(renamed.decision.status, "accepted");
  const mergeResponse = await requestSocket(join(globalParent, "run", "global-codex.sock"), {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION, requestId: "51044bb6-8c4a-40f6-a733-ccbffaad5248",
    basePlannerVersion: renamed.workspace.plannerVersion,
    operations: [{ command: { type: "mergeIngredientConcepts", survivorConceptId: "red-onion", mergedConceptIds: ["green-onion"], collisionPolicy: "preferTarget" } }],
  });
  assert.equal(mergeResponse.body.decision.status, "accepted");

  const browserRead = await fetch(`http://127.0.0.1:${address.port}/api/workspace`).then((response) => response.json());
  const globalRead = await requestSocket(join(globalParent, "run", "global-codex.sock"), null, GLOBAL_CODEX_ROUTES.workspace, "GET");
  assert.deepEqual(validateHouseholdState(browserRead.state), { ok: true });
  const expectedNativeRead = projectPlannerRead(browserRead, { kind: "meal", weekId: "2026-08-10", mealId: "meal-1" });
  assert.equal(isPlannerReadProjection(expectedNativeRead), true, JSON.stringify(expectedNativeRead));
  const nativeRead = decodeNative(await nativeHost.handle({
    threadId: "thread-parity", turnId: "turn-catalogue-read", callId: "call-catalogue-read", namespace: PLANNER_TOOL_NAMESPACE,
    tool: "read", arguments: { query: { kind: "meal", weekId: "2026-08-10", mealId: "meal-1" } },
  }));
  assert.equal(nativeRead.ok, true);
  const browserIngredient = browserRead.state.weeks[0].data.meals[0].ingredients[0];
  const globalIngredient = globalRead.body.planner.state.weeks[0].data.meals[0].ingredients[0];
  const nativeIngredient = nativeRead.data.meal.ingredients[0];
  for (const ingredient of [browserIngredient, globalIngredient, nativeIngredient]) {
    assert.deepEqual({ ...ingredient, conceptId: null }, { ...beforeLiteral, conceptId: null });
    assert.equal(ingredient.conceptId, "red-onion");
  }
  const nativeConcepts = [...nativeRead.data.ingredientCatalogue.concepts];
  let nextCatalogueOffset = nativeRead.data.ingredientCatalogue.nextOffset;
  while (nextCatalogueOffset !== null) {
    const page = decodeNative(await nativeHost.handle({
      threadId: "thread-parity", turnId: "turn-catalogue-read", callId: `call-catalogue-page-${nextCatalogueOffset}`, namespace: PLANNER_TOOL_NAMESPACE,
      tool: "read", arguments: { query: { kind: "catalogue", offset: nextCatalogueOffset } },
    }));
    assert.equal(page.ok, true);
    nativeConcepts.push(...page.data.ingredientCatalogue.concepts);
    nextCatalogueOffset = page.data.ingredientCatalogue.nextOffset;
  }
  assert.deepEqual({ revision: nativeRead.data.ingredientCatalogue.revision, concepts: nativeConcepts }, browserRead.state.ingredientCatalogue);
  assert.deepEqual(globalRead.body.planner.state.ingredientCatalogue, browserRead.state.ingredientCatalogue);

  const undoResponse = await fetch(`http://127.0.0.1:${address.port}/api/undo`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ requestId: "undo-catalogue-merge", basePlannerVersion: browserRead.plannerVersion, targetEventId: mergeResponse.body.decision.eventId }),
  });
  assert.equal(undoResponse.status, 200);
  assert.equal((await undoResponse.json()).decision.status, "accepted");
  const reopened = openPlannerStore({ filename });
  const restarted = createPlannerApplicationService({
    store: reopened, domain: householdDomain, seedFactory: seedState, transformLegacyV2: () => { throw new Error("unused"); },
    clock: { now: () => now++ }, idFactory: { createId: (prefix) => `${prefix}-restart-${++id}` },
  });
  const restartedIngredient = restarted.readWorkspace().state.weeks[0].data.meals[0].ingredients[0];
  assert.deepEqual({ ...restartedIngredient, conceptId: null }, { ...beforeLiteral, conceptId: null });
  assert.equal(restartedIngredient.conceptId, "green-onion");
  reopened.close();
});
