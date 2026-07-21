import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../../lib/household-bootstrap.ts";
import { householdDomain } from "../../lib/household-domain.ts";
import {
  GLOBAL_CODEX_CONTRACT_VERSION,
  GLOBAL_CODEX_ROUTES,
} from "../../lib/global-codex-contract.ts";
import { PLANNER_TOOL_NAMESPACE } from "../../lib/planner-tool-contract.ts";
import { createPlannerApplicationService } from "../../server/application/planner-service.ts";
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

const BROWSER_ORIGIN = "http://localhost:3001";
const GLOBAL_REQUEST_ID = "9c45d350-ce7d-4b25-a7fb-9b17cf4b26a0";

function createPlanner(t) {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  t.after(() => sqlite.close());
  let id = 0;
  let now = Date.UTC(2026, 6, 15, 12);
  const context = () => ({
    now,
    createId: (prefix) => `${prefix}-parity-${id += 1}`,
  });
  const planner = createPlannerApplicationService({
    store: sqlite,
    domain: householdDomain,
    seedFactory: () => createCanonicalSeed(context()),
    transformLegacyV2: () => { throw new Error("unused"); },
    clock: { now: () => now += 1 },
    idFactory: { createId: (prefix) => `${prefix}-parity-${id += 1}` },
  });
  planner.bootstrap({ requestId: "bootstrap-prep-parity", mode: "seed" });
  return { planner, sqlite };
}

function combineFixture(planner) {
  const workspace = planner.readWorkspace();
  const week = workspace.state.weeks.find(({ id }) => id === workspace.state.activeWeekId);
  assert.ok(week);
  const [firstStep, secondStep] = week.data.meals[0].instructions;
  return {
    basePlannerVersion: workspace.plannerVersion,
    command: {
      type: "combinePrepStepsOnDate",
      weekId: week.id,
      prepDate: week.id,
      sourceStepIds: [firstStep.id, secondStep.id],
      instruction: "Prepare the shared rice batch.",
      targetPosition: 0,
    },
  };
}

function combinedProjection(workspace) {
  const week = workspace.state.weeks.find(({ id }) => id === workspace.state.activeWeekId);
  const combined = week?.data.prepSessions.flatMap(({ steps }) => steps)
    .find((entry) => entry.kind === "combined");
  assert.ok(combined);
  return {
    plannerVersion: workspace.plannerVersion,
    instruction: combined.instruction,
    sourceStepIds: combined.sources.map(({ stepId }) => stepId),
    sourceIngredientIds: combined.sources.map(({ ingredientIds }) => ingredientIds),
    complete: combined.complete,
    needsReview: combined.needsReview,
    directSourceCount: week.data.prepSessions.flatMap(({ steps }) => steps).filter((entry) =>
      entry.kind !== "combined" && combined.sources.some(({ stepId }) => stepId === entry.stepId)
    ).length,
  };
}

function normalizedPreview(decision) {
  assert.equal(decision.status, "previewed");
  return decision.outcomes.map(({ operationIndex, summary, target, changes }) => ({
    operationIndex,
    summary,
    target,
    changes,
  }));
}

function requestSocket(socketPath, path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = requestHttp({
      socketPath,
      method: "POST",
      path,
      headers: {
        Host: "localhost",
        Connection: "close",
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
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
    request.end(payload);
  });
}

function callback(tool, argumentsValue, callId) {
  return {
    threadId: "thread-prep-parity",
    turnId: "turn-prep-parity",
    callId,
    namespace: PLANNER_TOOL_NAMESPACE,
    tool,
    arguments: argumentsValue,
  };
}

function decodeNative(response) {
  assert.equal(response.contentItems.length, 1);
  return JSON.parse(response.contentItems[0].text);
}

test("combined Prep preview and apply stay equivalent across browser, embedded, and Global ingresses", async (t) => {
  const browser = createPlanner(t);
  const browserFixture = combineFixture(browser.planner);
  const browserHandler = createApplicationRouter({
    planner: browser.planner,
    readHealth: () => { throw new Error("unused"); },
  }, {
    allowedOrigins: new Set([BROWSER_ORIGIN]),
    allowOriginlessMutations: false,
  });
  const browserServer = await listenHttpServer({ handler: browserHandler, port: 0 });
  t.after(() => closeHttpServer(browserServer));
  const browserAddress = browserServer.address();
  assert.equal(typeof browserAddress, "object");
  const browserBaseUrl = `http://127.0.0.1:${browserAddress.port}`;
  const browserHeaders = { "Content-Type": "application/json", Origin: BROWSER_ORIGIN };
  const browserPreviewResponse = await fetch(`${browserBaseUrl}/api/operations/preview`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      basePlannerVersion: browserFixture.basePlannerVersion,
      operations: [{ command: browserFixture.command }],
    }),
  });
  assert.equal(browserPreviewResponse.status, 200);
  const browserPreview = normalizedPreview((await browserPreviewResponse.json()).decision);
  assert.equal(browser.planner.readWorkspace().plannerVersion, browserFixture.basePlannerVersion);
  const browserApplyResponse = await fetch(`${browserBaseUrl}/api/commands`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      requestId: "browser-prep-parity",
      basePlannerVersion: browserFixture.basePlannerVersion,
      command: browserFixture.command,
    }),
  });
  assert.equal(browserApplyResponse.status, 200);
  const browserApplied = await browserApplyResponse.json();
  assert.equal(browserApplied.decision.status, "accepted");

  const embedded = createPlanner(t);
  const embeddedFixture = combineFixture(embedded.planner);
  const embeddedHost = createNativePlannerEffectHost({
    planner: embedded.planner,
    store: createSqliteCodexThreadStore(embedded.sqlite),
    isEligibleCall: () => true,
    now: () => 200,
  });
  const embeddedPreview = decodeNative(await embeddedHost.handle(callback("preview", {
    basePlannerVersion: embeddedFixture.basePlannerVersion,
    operations: [{ command: embeddedFixture.command }],
  }, "call-prep-preview")));
  assert.equal(embeddedPreview.ok, true);
  const embeddedPreviewOutcomes = normalizedPreview({
    status: embeddedPreview.data.status,
    outcomes: embeddedPreview.data.outcomes,
  });
  assert.equal(embedded.planner.readWorkspace().plannerVersion, embeddedFixture.basePlannerVersion);
  const embeddedApplied = decodeNative(await embeddedHost.handle(callback("apply", {
    basePlannerVersion: embeddedFixture.basePlannerVersion,
    operations: [{ command: embeddedFixture.command }],
    readback: { kind: "workspace" },
  }, "call-prep-apply")));
  assert.equal(embeddedApplied.ok, true);
  assert.equal(embeddedApplied.data.status, "accepted");

  const global = createPlanner(t);
  const globalFixture = combineFixture(global.planner);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "prep-global-parity-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const globalParent = join(directory, "meal-planner");
  mkdirSync(globalParent, { mode: 0o700 });
  const globalSocket = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(createGlobalCodexPlannerPort(global.planner)),
    globalParent,
  );
  t.after(() => globalSocket.close());
  const globalSocketPath = join(globalParent, "run", "global-codex.sock");
  const globalOperations = [{ command: globalFixture.command }];
  const globalPreviewResponse = await requestSocket(
    globalSocketPath,
    GLOBAL_CODEX_ROUTES.previews,
    {
      contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
      basePlannerVersion: globalFixture.basePlannerVersion,
      operations: globalOperations,
    },
  );
  assert.equal(globalPreviewResponse.status, 200);
  const globalPreview = normalizedPreview(globalPreviewResponse.body.decision);
  assert.equal(global.planner.readWorkspace().plannerVersion, globalFixture.basePlannerVersion);
  const globalApplyResponse = await requestSocket(
    globalSocketPath,
    GLOBAL_CODEX_ROUTES.batches,
    {
      contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
      requestId: GLOBAL_REQUEST_ID,
      basePlannerVersion: globalFixture.basePlannerVersion,
      operations: globalOperations,
    },
  );
  assert.equal(globalApplyResponse.status, 200);
  assert.equal(globalApplyResponse.body.decision.status, "accepted");

  assert.deepEqual(embeddedPreviewOutcomes, browserPreview);
  assert.deepEqual(globalPreview, browserPreview);
  const browserProjection = combinedProjection(browserApplied.workspace);
  assert.deepEqual(combinedProjection(embedded.planner.readWorkspace()), browserProjection);
  assert.deepEqual(combinedProjection(globalApplyResponse.body.planner), browserProjection);
  assert.equal(browserProjection.directSourceCount, 0);

  const browserBeforeStale = structuredClone(browserApplied.workspace.state);
  const browserStale = await fetch(`${browserBaseUrl}/api/commands`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      requestId: "browser-prep-parity-stale",
      basePlannerVersion: browserFixture.basePlannerVersion,
      command: browserFixture.command,
    }),
  });
  assert.equal(browserStale.status, 409);
  assert.equal((await browserStale.json()).decision.status, "version_conflict");
  assert.deepEqual(browser.planner.readWorkspace().state, browserBeforeStale);

  const embeddedBeforeStale = structuredClone(embedded.planner.readWorkspace().state);
  const embeddedStale = decodeNative(await embeddedHost.handle(callback("apply", {
    basePlannerVersion: embeddedFixture.basePlannerVersion,
    operations: [{ command: embeddedFixture.command }],
    readback: { kind: "workspace" },
  }, "call-prep-apply-stale")));
  assert.equal(embeddedStale.ok, false);
  assert.equal(embeddedStale.error.code, "VERSION_CONFLICT");
  assert.deepEqual(embedded.planner.readWorkspace().state, embeddedBeforeStale);

  const globalBeforeStale = structuredClone(global.planner.readWorkspace().state);
  const globalStale = await requestSocket(globalSocketPath, GLOBAL_CODEX_ROUTES.batches, {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
    requestId: "13ca25ca-7380-456d-af1c-82ccb350c8ab",
    basePlannerVersion: globalFixture.basePlannerVersion,
    operations: globalOperations,
  });
  assert.equal(globalStale.status, 409);
  assert.equal(globalStale.body.decision.status, "version_conflict");
  assert.deepEqual(global.planner.readWorkspace().state, globalBeforeStale);
});
