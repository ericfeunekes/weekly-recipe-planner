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
import { householdDomain } from "../../lib/household-domain.ts";
import { PLANNER_TOOL_NAMESPACE } from "../../lib/planner-tool-contract.ts";
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
          ingredients: [],
          instructions: [],
        }],
        prepSessions: [],
        groceries: [],
        leftovers: [],
        feedback: {},
        weekLesson: "",
      },
    }],
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

function requestSocket(socketPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = requestHttp({
      socketPath,
      method: "POST",
      path: GLOBAL_CODEX_ROUTES.batches,
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

function decodeNative(response) {
  assert.equal(response.contentItems.length, 1);
  return JSON.parse(response.contentItems[0].text);
}

test("one historical recipe receipt has identical replay-only semantics across HTTP, embedded Codex, and Global UDS", async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "occurrence-ingress-parity-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openPlannerStore({ filename: join(directory, "planner.sqlite") });
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

  assert.deepEqual(planner.readWorkspace(), before, "all three replays leave the canonical workspace unchanged");
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM planner_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count, 4);
});
