import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as requestHttp } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GLOBAL_CODEX_CONTRACT_VERSION,
  GLOBAL_CODEX_REQUEST_MAX_BYTES,
  GLOBAL_CODEX_RESPONSE_MAX_BYTES,
  GLOBAL_CODEX_ROUTES,
  isGlobalCodexBatchRequest,
  isGlobalCodexPreviewRequest,
  isGlobalCodexResponse,
} from "../lib/global-codex-contract.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { createGlobalCodexClientForHostTesting } from "../scripts/planner-global-client.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import {
  createGlobalCodexIngressForTests,
} from "../server/global-ingress/index.ts";
import {
  createGlobalCodexPlannerPort,
  projectPlannerWorkspace,
} from "../server/global-ingress/planner-port.ts";
import { createGlobalCodexRouter } from "../server/global-ingress/router.ts";
import {
  startGlobalCodexSocketServerForTests,
} from "../server/global-ingress/socket-server.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

const REQUEST_ID = "9c45d350-ce7d-4b25-a7fb-9b17cf4b26a0";

function temporaryDirectory(t, prefix = "weekly-global-codex-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return realpathSync(directory);
}

function seedState(lesson = "Initial lesson") {
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-07-06",
    weeks: [{
      id: "2026-07-06",
      weekStartDate: "2026-07-06",
      status: "active",
      data: {
        meals: [{
          id: "meal-1",
          date: "2026-07-07",
          slot: "dinner",
          title: "Placeholder dinner",
          subtitle: "Keep this subtitle",
          venue: "Home",
          status: "planned",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "Keep this note",
          ingredients: [],
          instructions: [],
        }],
        prepSessions: [],
        groceries: [],
        leftovers: [],
        feedback: {},
        weekLesson: lesson,
      },
    }],
  };
}

function createRealPlanner(t) {
  const directory = temporaryDirectory(t, "weekly-global-store-");
  const store = openPlannerStore({ filename: join(directory, "planner.sqlite") });
  t.after(() => store.close());
  let id = 0;
  let now = 1_800_000_000_000;
  const planner = createPlannerApplicationService({
    store,
    domain: householdDomain,
    seedFactory: () => seedState(),
    transformLegacyV2: () => ({ state: seedState(), transcriptEntries: [], discardedEventCount: 0 }),
    clock: { now: () => now++ },
    idFactory: { createId: (prefix) => `${prefix}-${++id}` },
  });
  planner.bootstrap({ requestId: "bootstrap-global", mode: "seed" });
  return { planner, store };
}

function batch(requestId = REQUEST_ID, basePlannerVersion = 0, lesson = "Global lesson") {
  return {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
    requestId,
    basePlannerVersion,
    operations: [{
      command: {
        type: "captureWeekLesson",
        weekId: "2026-07-06",
        weekLesson: lesson,
      },
    }],
  };
}

function preview(basePlannerVersion = 0, lesson = "Global lesson") {
  return {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
    basePlannerVersion,
    operations: [{ command: {
      type: "captureWeekLesson",
      weekId: "2026-07-06",
      weekLesson: lesson,
    } }],
  };
}

function sourcedBatch(
  requestId = "d7781402-6bed-47ce-ab52-f54916e3e56c",
  basePlannerVersion = 1,
) {
  return {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
    requestId,
    basePlannerVersion,
    operations: [{ command: {
      type: "replaceMealRecipeFromSource",
      weekId: "2026-07-06",
      mealId: "meal-1",
      recipe: {
        title: "Sourced lentil soup",
        yieldText: "4 bowls",
        source: {
          kind: "web",
          identity: "Example Kitchen",
          url: "https://example.com/recipes/lentil-soup",
          retrievedAt: 1_750_000_000_000,
        },
        steps: [{
          inputs: [{ amount: "1 cup", ingredient: "lentils" }],
          instruction: "Simmer until tender.",
        }],
      },
    } }],
  };
}

function requestSocket(socketPath, { method = "GET", path, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(body);
    const request = requestHttp({
      socketPath,
      method,
      path,
      headers: {
        Host: "localhost",
        Connection: "close",
        ...(payload === null ? {} : {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(payload ?? undefined);
  });
}

function rawSocketRequest(socketPath, requestText) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks = [];
    socket.once("connect", () => socket.end(requestText));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function closeNetServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listenNetServer(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function createStaleSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs');const net=require('node:net');const p=process.argv[1];net.createServer().listen(p,()=>{fs.chmodSync(p,0o600);console.log('ready')});setInterval(()=>{},1000)",
      socketPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", () => {
      child.kill("SIGKILL");
      child.once("close", () => resolve());
    });
    child.once("close", (code) => {
      if (code !== null && code !== 0) reject(new Error(`stale socket fixture failed: ${stderr}`));
    });
  });
}

function spawnClient({ home, command, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "scripts/planner-global-client.ts",
        command,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

test("the global contract rejects unknown keys, non-UUID IDs, and chat-bearing projections", () => {
  assert.equal(isGlobalCodexBatchRequest(batch()), true);
  assert.equal(isGlobalCodexBatchRequest({ ...batch(), actor: "Codex" }), false);
  assert.equal(isGlobalCodexBatchRequest({ ...batch(), requestId: "not-a-uuid" }), false);
  assert.equal(isGlobalCodexPreviewRequest(preview()), true);
  assert.equal(isGlobalCodexPreviewRequest({ ...preview(), requestId: REQUEST_ID }), false);

  const projected = projectPlannerWorkspace({
    initialized: true,
    schemaVersion: 2,
    plannerVersion: 0,
    syncRevision: 1,
    state: seedState(),
    events: [{
      sequence: 1,
      eventId: "event-1",
      requestId: "request-1",
      actor: "Codex",
      provenance: { actorClass: "codex", actorSource: "embedded", admission: "app_server_dynamic_v1" },
      command: { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Initial lesson" },
      baseVersion: 0,
      resultVersion: 1,
      summary: "summary",
      target: "target",
      changes: ["changed"],
      revertsEventId: null,
      chatTurnId: "secret-chat-turn",
      occurredAt: 1,
    }],
    transcriptEntries: [{ secret: true }],
    chatTurns: [{ secret: true }],
  });
  assert.equal("chatTurnId" in projected.events[0], false);
  assert.equal("transcriptEntries" in projected, false);
  assert.equal("chatTurns" in projected, false);
  assert.equal(isGlobalCodexResponse({ contractVersion: 1, planner: projected }), true);
});

test("real UDS and SQLite preserve apply, replay, conflict, provenance, and planner-only readback", async (t) => {
  const home = temporaryDirectory(t, "weekly-global-home-");
  const parent = join(home, "meal-planner");
  mkdirSync(parent, { mode: 0o700 });
  const { planner, store } = createRealPlanner(t);
  const socket = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(createGlobalCodexPlannerPort(planner), { now: () => 123 }),
    parent,
  );
  t.after(() => socket.close());
  const socketPath = join(parent, "run", "global-codex.sock");
  assert.equal(lstatSync(parent).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(parent, "run")).mode & 0o777, 0o700);
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);

  const health = await requestSocket(socketPath, { path: GLOBAL_CODEX_ROUTES.health });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { contractVersion: 1, status: "ready", serverTime: 123 });
  assert.equal(health.headers["access-control-allow-origin"], undefined);
  const hostOnlyClient = createGlobalCodexClientForHostTesting(socketPath);
  assert.deepEqual(await hostOnlyClient.invoke("health", null), {
    contractVersion: 1,
    status: "ready",
    serverTime: 123,
  });

  const previewed = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.previews,
    body: JSON.stringify(preview()),
  });
  assert.equal(previewed.status, 200);
  assert.equal(JSON.parse(previewed.body).decision.status, "previewed");
  assert.equal(planner.readWorkspace().plannerVersion, 0);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'global_codex_apply_planner_batch_v1'",
  ).get().count, 0);
  assert.equal((await hostOnlyClient.invoke("preview", preview())).decision.status, "previewed");

  const accepted = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(batch()),
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = JSON.parse(accepted.body);
  assert.equal(acceptedBody.decision.status, "accepted");
  assert.equal(acceptedBody.planner.state.weeks[0].data.weekLesson, "Global lesson");
  assert.equal("transcriptEntries" in acceptedBody.planner, false);
  assert.equal("chatTurnId" in acceptedBody.planner.events[0], false);
  assert.deepEqual(acceptedBody.planner.events[0].provenance, {
    actorClass: "codex",
    actorSource: "global",
    admission: "same_uid_uds_v1",
  });

  const sourced = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(sourcedBatch()),
  });
  assert.equal(sourced.status, 200);
  const sourcedBody = JSON.parse(sourced.body);
  assert.equal(sourcedBody.decision.status, "accepted");
  const sourcedMeal = sourcedBody.planner.state.weeks[0].data.meals[0];
  assert.equal(sourcedMeal.title, "Sourced lentil soup");
  assert.equal(sourcedMeal.subtitle, "Keep this subtitle");
  assert.deepEqual(sourcedMeal.sourceRecipe, sourcedBatch().operations[0].command.recipe.source);
  assert.equal(sourcedMeal.ingredients.length, 1);
  assert.deepEqual(
    sourcedMeal.ingredients.map(({ amount, ingredient }) => ({ amount, ingredient })),
    [{ amount: "1 cup", ingredient: "lentils" }],
  );
  assert.match(sourcedMeal.ingredients[0].id, /^ingredient-\d+$/u);
  assert.deepEqual(sourcedBody.planner.events.at(-1).provenance, {
    actorClass: "codex",
    actorSource: "global",
    admission: "same_uid_uds_v1",
  });
  const sourcedReplay = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(sourcedBatch()),
  });
  assert.equal(sourcedReplay.status, 200);
  assert.deepEqual(JSON.parse(sourcedReplay.body).decision, sourcedBody.decision);
  const forbiddenCandidateId = structuredClone(sourcedBatch(
    "55832e49-eb31-471e-8c9f-538951a437c4",
    2,
  ));
  forbiddenCandidateId.operations[0].command.recipe.candidateId = "forbidden";
  const strictRejection = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(forbiddenCandidateId),
  });
  assert.equal(strictRejection.status, 400);

  const replay = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(batch()),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(replay.body).decision, acceptedBody.decision);

  const reused = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(batch(REQUEST_ID, 0, "Changed payload")),
  });
  assert.equal(reused.status, 409);
  assert.equal(JSON.parse(reused.body).error.code, "request_id_reuse");

  const conflict = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(batch("0a00ae10-c72e-4015-adbf-a615b5689fc8", 0, "Stale")),
  });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.body).decision.status, "version_conflict");
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'global_codex_apply_planner_batch_v1'",
  ).get().count, 3);
});

test("spawned supported client uses HOME-derived fixed socket and browser-visible application state", async (t) => {
  const home = temporaryDirectory(t, "weekly-global-client-home-");
  const parent = join(home, "meal-planner");
  mkdirSync(parent, { mode: 0o700 });
  const { planner } = createRealPlanner(t);
  const socket = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
    parent,
  );
  t.after(() => socket.close());

  const result = await spawnClient({ home, command: "apply", input: JSON.stringify(batch()) });
  assert.deepEqual({ code: result.code, signal: result.signal, stderr: result.stderr }, {
    code: 0,
    signal: null,
    stderr: "",
  });
  assert.equal(JSON.parse(result.stdout).decision.status, "accepted");
  assert.equal(planner.readWorkspace().state.weeks[0].data.weekLesson, "Global lesson");
});

test("spawned supported client previews without a request ID or receipt", async (t) => {
  const home = temporaryDirectory(t, "weekly-global-preview-client-home-");
  const parent = join(home, "meal-planner");
  mkdirSync(parent, { mode: 0o700 });
  const { planner, store } = createRealPlanner(t);
  const socket = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
    parent,
  );
  t.after(() => socket.close());

  const result = await spawnClient({ home, command: "preview", input: JSON.stringify(preview()) });
  assert.deepEqual({ code: result.code, signal: result.signal, stderr: result.stderr }, {
    code: 0,
    signal: null,
    stderr: "",
  });
  assert.equal(JSON.parse(result.stdout).decision.status, "previewed");
  assert.equal(planner.readWorkspace().plannerVersion, 0);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'global_codex_apply_planner_batch_v1'",
  ).get().count, 0);
});

test("the host-only client seam is in-memory and rejects non-absolute paths", () => {
  assert.throws(
    () => createGlobalCodexClientForHostTesting("relative/global-codex.sock"),
    /must be absolute/u,
  );
  assert.throws(
    () => createGlobalCodexClientForHostTesting("/tmp/global\u0000-codex.sock"),
    /must be absolute/u,
  );
});

test("socket admission rejects unsafe parents and active peers, then removes only its own socket", async (t) => {
  const unsafe = temporaryDirectory(t, "weekly-global-unsafe-");
  chmodSync(unsafe, 0o755);
  await assert.rejects(
    startGlobalCodexSocketServerForTests((_request, response) => response.end(), unsafe),
    /unsafe permissions/u,
  );

  const unavailable = await createGlobalCodexIngressForTests(
    (_request, response) => response.end(),
    unsafe,
  );
  assert.deepEqual(unavailable.readStatus(), {
    status: "unavailable",
    reason: "Global Codex ingress could not start.",
  });
  await unavailable.close();

  const parent = temporaryDirectory(t, "weekly-global-owned-");
  const first = await startGlobalCodexSocketServerForTests((_request, response) => response.end(), parent);
  const socketPath = join(parent, "run", "global-codex.sock");
  await assert.rejects(
    startGlobalCodexSocketServerForTests((_request, response) => response.end(), parent),
    /already owns/u,
  );
  assert.equal(existsSync(socketPath), true);
  await first.close();
  assert.equal(existsSync(socketPath), false);

  const fileParent = temporaryDirectory(t, "weekly-global-file-");
  mkdirSync(join(fileParent, "run"), { mode: 0o700 });
  writeFileSync(join(fileParent, "run", "global-codex.sock"), "not a socket", { mode: 0o600 });
  await assert.rejects(
    startGlobalCodexSocketServerForTests((_request, response) => response.end(), fileParent),
    /unsafe type/u,
  );

  const realParent = temporaryDirectory(t, "weekly-global-real-");
  const linkedParent = join(temporaryDirectory(t, "weekly-global-link-root-"), "linked");
  symlinkSync(realParent, linkedParent);
  await assert.rejects(
    startGlobalCodexSocketServerForTests((_request, response) => response.end(), linkedParent),
    /symbolic link/u,
  );

  const staleParent = temporaryDirectory(t, "weekly-global-stale-");
  const staleRun = join(staleParent, "run");
  mkdirSync(staleRun, { mode: 0o700 });
  const stalePath = join(staleRun, "global-codex.sock");
  await createStaleSocket(stalePath);
  assert.equal(existsSync(stalePath), true);
  const replacement = await startGlobalCodexSocketServerForTests(
    (_request, response) => response.end("replacement"),
    staleParent,
  );
  assert.equal(lstatSync(stalePath).mode & 0o777, 0o600);
  await replacement.close();
});

test("route table rejects framing, browser metadata, wrong methods, and unknown routes", async (t) => {
  const parent = temporaryDirectory(t, "weekly-global-routes-");
  const { planner } = createRealPlanner(t);
  const socket = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
    parent,
  );
  t.after(() => socket.close());
  const socketPath = join(parent, "run", "global-codex.sock");

  const browser = await requestSocket(socketPath, {
    path: GLOBAL_CODEX_ROUTES.workspace,
    headers: { Origin: "https://example.com" },
  });
  assert.equal(browser.status, 400);
  const wrongMethod = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.workspace,
    body: "{}",
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  const missing = await requestSocket(socketPath, { path: "/v1/nope" });
  assert.equal(missing.status, 404);
  const badType = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: JSON.stringify(batch()),
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(badType.status, 415);

  const duplicatedLength = await rawSocketRequest(
    socketPath,
    `POST ${GLOBAL_CODEX_ROUTES.batches} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
  );
  assert.match(duplicatedLength, /^HTTP\/1\.1 400/u);
  assert.equal(JSON.parse(duplicatedLength.split("\r\n\r\n")[1]).error.code, "invalid_request");

  const http10 = await rawSocketRequest(
    socketPath,
    `GET ${GLOBAL_CODEX_ROUTES.health} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
  );
  assert.match(http10, /^HTTP\/1\.1 400/u);

  const expectation = await rawSocketRequest(
    socketPath,
    `POST ${GLOBAL_CODEX_ROUTES.batches} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n{}`,
  );
  assert.match(expectation, /^HTTP\/1\.1 400/u);
  assert.doesNotMatch(expectation, /100 Continue/u);

  const upgrade = await rawSocketRequest(
    socketPath,
    `GET ${GLOBAL_CODEX_ROUTES.health} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  assert.match(upgrade, /^HTTP\/1\.1 400/u);

  const exactBodyBase = JSON.stringify(batch("9dc0e78e-fe52-4c09-a9b1-114f913e21ab"));
  const exactBody = `${exactBodyBase}${" ".repeat(GLOBAL_CODEX_REQUEST_MAX_BYTES - Buffer.byteLength(exactBodyBase))}`;
  const exact = await requestSocket(socketPath, {
    method: "POST",
    path: GLOBAL_CODEX_ROUTES.batches,
    body: exactBody,
  });
  assert.equal(exact.status, 200);

  const oversized = await rawSocketRequest(
    socketPath,
    `POST ${GLOBAL_CODEX_ROUTES.batches} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${GLOBAL_CODEX_REQUEST_MAX_BYTES + 1}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(oversized, /^HTTP\/1\.1 413/u);
});

test("server and client enforce the exact 64 MiB response bound before parsing", async (t) => {
  const parent = temporaryDirectory(t, "weekly-global-response-");
  const giant = "x".repeat(GLOBAL_CODEX_RESPONSE_MAX_BYTES + 1);
  const validState = seedState();
  const oversizedPort = {
    readPlanner: () => ({
      initialized: true,
      schemaVersion: 2,
      plannerVersion: 0,
      syncRevision: 1,
      state: validState,
      events: [{
        sequence: 1,
        eventId: "event-1",
        requestId: "request-1",
        actor: "Household",
        provenance: { actorClass: "household", actorSource: "browser", admission: "same_origin_http_v1" },
        command: { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "ok" },
        baseVersion: 0,
        resultVersion: 1,
        summary: "summary",
        target: "target",
        changes: [giant],
        revertsEventId: null,
        occurredAt: 1,
      }],
    }),
    applyBatch: () => { throw new Error("not used"); },
  };
  const bounded = await startGlobalCodexSocketServerForTests(
    createGlobalCodexRouter(oversizedPort),
    parent,
  );
  const boundedPath = join(parent, "run", "global-codex.sock");
  const response = await requestSocket(boundedPath, { path: GLOBAL_CODEX_ROUTES.workspace });
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error.code, "planner_unavailable");
  await bounded.close();

  const home = temporaryDirectory(t, "weekly-global-malicious-home-");
  const run = join(home, "meal-planner", "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const maliciousPath = join(run, "global-codex.sock");
  const malicious = createNetServer((socket) => {
    socket.once("data", () => {
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${GLOBAL_CODEX_RESPONSE_MAX_BYTES + 1}\r\nConnection: close\r\n\r\n`);
    });
  });
  await listenNetServer(malicious, maliciousPath);
  const client = await spawnClient({ home, command: "workspace" });
  assert.equal(client.code, 3);
  assert.match(client.stderr, /exceeds 67108864 bytes/u);
  await closeNetServer(malicious);
});
