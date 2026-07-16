import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexThreadSource } from "../../app/codex-thread-source.ts";
import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";

const ALLOWED_ORIGIN = "http://localhost:3001";
const MESSAGE = "Plan one family dinner without duplicating this request";
const fixturePath = new URL(
  "../support/fixtures/codex-runtime/fake-native-app-server.mjs",
  import.meta.url,
);

function createConfig(dataDirectory) {
  return {
    mode: "api",
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    databasePath: join(dataDirectory, "planner.sqlite"),
    webOrigin: new URL("http://127.0.0.1:3001"),
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
  };
}

function runtimeBaseUrl(runtime) {
  const address = runtime.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

function createNativeRuntime(children, fixedCwd, stateFile) {
  const status = {
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
    cacheHit: false,
    evidence: null,
    detail: "compatible",
  };
  return {
    evaluate: async () => status,
    readStatus: () => status,
    async spawnAppServer() {
      const child = spawn(process.execPath, [fixturePath.pathname], {
        cwd: fixedCwd,
        env: {
          ...process.env,
          FAKE_NATIVE_STATE_FILE: stateFile,
          FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
          FAKE_NATIVE_PRIVACY_CANARY_ITEMS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
    async close() {},
  };
}

async function startRuntime(dataDirectory, stateFile, children) {
  return startPlannerRuntime({
    config: createConfig(dataDirectory),
    codexRuntime: createNativeRuntime(children, dataDirectory, stateFile),
    codexFixedCwd: dataDirectory,
    webProbe: async () => true,
  });
}

function waitForSnapshot(source, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Codex browser source did not converge before its deadline."));
    }, timeoutMs);
    const check = () => {
      const snapshot = source.getSnapshot();
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    unsubscribe = source.subscribe(check);
    check();
  });
}

function userMessages(snapshot) {
  return snapshot.thread?.turns.flatMap((turn) =>
    turn.items.filter((item) => item.kind === "message" && item.role === "user")
  ) ?? [];
}

test("native browser source composes through HTTP, SQLite, and app-server with exact replay", async (t) => {
  const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), "planner-native-browser-")));
  const nativeStateFile = join(dataDirectory, "native-app-server-state.json");
  const children = [];
  const hostFetch = globalThis.fetch;
  const activeOrigin = { value: "" };
  const browserRequests = [];
  let replaceFirstCommittedSendWithUnavailable = true;
  let runtime = null;
  let source = null;

  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(rawUrl, activeOrigin.value);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (method === "POST") {
      headers.set("Origin", ALLOWED_ORIGIN);
      headers.set("Sec-Fetch-Site", "same-site");
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    browserRequests.push({ method, path: url.pathname, body });
    const response = await hostFetch(url, { ...init, headers });
    assert.equal(response.url.startsWith(activeOrigin.value), true);
    if (
      replaceFirstCommittedSendWithUnavailable &&
      method === "POST" &&
      url.pathname === "/api/codex/turns/send"
    ) {
      replaceFirstCommittedSendWithUnavailable = false;
      await response.arrayBuffer();
      return new Response(JSON.stringify({
        error: {
          code: "CODEX_UNAVAILABLE",
          message: "Codex accepted the message but its authoritative history is not ready.",
        },
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return response;
  };

  t.after(async () => {
    source?.stop();
    globalThis.fetch = hostFetch;
    await runtime?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  runtime = await startRuntime(dataDirectory, nativeStateFile, children);
  activeOrigin.value = runtimeBaseUrl(runtime);
  source = createCodexThreadSource({ search: "", development: false });
  assert.equal(source.mode, "native");
  const observedStatuses = [];
  source.subscribe(() => observedStatuses.push(source.getSnapshot().status));

  const initial = await source.start();
  assert.equal(initial.status, "empty");
  assert.deepEqual(initial.threads, []);
  const firstEpoch = initial.connectionEpoch;
  assert.equal(typeof firstEpoch, "string");

  await assert.rejects(
    source.send(MESSAGE),
    (error) => error?.code === "CODEX_UNAVAILABLE",
  );
  assert.equal(observedStatuses.includes("selected_unmaterialized"), true);

  // The rejected browser promise cannot hide the durable effect: the source's
  // real event loop must converge from the server-authored change signal.
  const converged = await waitForSnapshot(
    source,
    (snapshot) => snapshot.status === "ready" && userMessages(snapshot).length === 1,
  );
  assert.equal(converged.thread?.turns.length, 1);
  assert.equal(userMessages(converged)[0].text, MESSAGE);
  const projected = JSON.stringify(converged);
  for (const canary of [
    "RAW_REASONING_PRIVACY_CANARY",
    "PLANNER_ARGUMENT_PRIVACY_CANARY",
    "PLANNER_RESULT_PRIVACY_CANARY",
    "WEB_QUERY_PRIVACY_CANARY",
    "WEB_URL_PRIVACY_CANARY",
    "COMMAND_PRIVACY_CANARY",
    "COMMAND_PATH_PRIVACY_CANARY",
  ]) {
    assert.doesNotMatch(projected, new RegExp(canary, "u"));
  }
  const activityLabels = converged.thread.turns.flatMap((turn) => turn.items)
    .filter((item) => item.kind === "activity")
    .map((item) => item.label);
  assert.deepEqual(activityLabels, [
    "Reading the planner",
    "Opening a source",
    "Restricted activity",
  ]);

  const replayed = await source.send(MESSAGE);
  assert.equal(replayed.status, "ready");
  assert.equal(replayed.threads.length, 1);
  assert.equal(replayed.thread?.turns.length, 1);
  assert.deepEqual(userMessages(replayed).map((item) => item.text), [MESSAGE]);

  const sendRequests = browserRequests.filter((request) =>
    request.method === "POST" && request.path === "/api/codex/turns/send"
  );
  assert.equal(sendRequests.length, 2);
  assert.deepEqual(sendRequests[1].body, sendRequests[0].body);
  assert.equal(browserRequests.filter((request) =>
    request.method === "POST" && request.path === "/api/codex/threads/new"
  ).length, 1);
  assert.equal(browserRequests.some((request) => request.path === "/api/codex/events"), true);
  assert.equal(browserRequests.some((request) => request.path === "/api/codex/thread"), true);

  assert.equal(runtime.store.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'new'",
  ).get().count, 1);
  assert.equal(runtime.store.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 1);
  assert.equal(runtime.store.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);

  const providerState = JSON.parse(await readFile(nativeStateFile, "utf8"));
  assert.equal(providerState.threads.length, 1);
  const providerThread = providerState.threads[0][1];
  assert.equal(providerThread.turns.length, 1);
  assert.equal(providerThread.turns[0].items.filter((item) => item.type === "userMessage").length, 1);

  const selectedThreadId = replayed.selection.threadId;
  source.stop();
  source = null;
  await runtime.close();
  runtime = null;

  runtime = await startRuntime(dataDirectory, nativeStateFile, children);
  activeOrigin.value = runtimeBaseUrl(runtime);
  source = createCodexThreadSource({ search: "", development: false });
  const restarted = await source.start();
  assert.equal(restarted.status, "ready");
  assert.equal(restarted.selection.threadId, selectedThreadId);
  assert.notEqual(restarted.connectionEpoch, firstEpoch);
  assert.equal(restarted.threads.length, 1);
  assert.equal(restarted.thread?.turns.length, 1);
  assert.deepEqual(userMessages(restarted).map((item) => item.text), [MESSAGE]);
  assert.equal(runtime.store.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 1);
  assert.equal(children.length, 2);
});
