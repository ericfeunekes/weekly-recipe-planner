import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startPlannerRuntime } from "../server/runtime/planner-runtime.ts";
import { closeHttpServer } from "../server/http/server.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";
import { createSqliteCodexThreadStore } from "../server/store/codex-thread-store.ts";

const ALLOWED_ORIGIN = "http://localhost:3001";

function createConfig(dataDirectory, overrides = {}) {
  return {
    mode: "api",
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    databasePath: join(dataDirectory, "planner.sqlite"),
    webOrigin: new URL("http://127.0.0.1:3001"),
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    ...overrides,
  };
}

function createCodexRuntime({
  state = "unavailable",
  authenticated = null,
  protocolCompatible = null,
  onClose = () => undefined,
  readStatus,
} = {}) {
  const status = {
    state,
    authenticated,
    protocolCompatible,
    cacheHit: false,
    evidence: null,
    detail: state,
  };
  return {
    evaluate: async () => status,
    readStatus: readStatus ?? (() => status),
    async spawnAppServer() {
      throw new Error("The deterministic runtime test must not spawn Codex.");
    },
    async close() {
      await onClose();
    },
  };
}

function runtimeBaseUrl(runtime) {
  const address = runtime.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

function createNativeCodexRuntime(children, options = {}) {
  const status = {
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
    cacheHit: false,
    evidence: null,
    detail: "compatible",
  };
  const fixture = new URL(
    "./support/fixtures/codex-runtime/fake-native-app-server.mjs",
    import.meta.url,
  );
  return {
    evaluate: async () => status,
    readStatus: () => status,
    async spawnAppServer() {
      const child = spawn(process.execPath, [fixture.pathname], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
    async close() {
      await options.onClose?.();
    },
  };
}

test("composed authority bootstraps once and survives a real process restart", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-runtime-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let sequence = 0;
  const sharedOptions = {
    config: createConfig(dataDirectory),
    codexRuntime: createCodexRuntime(),
    codexFixedCwd: null,
    clock: { now: () => Date.UTC(2026, 6, 6, 12) },
    idFactory: { createId: (prefix) => `${prefix}-${++sequence}` },
    webProbe: async () => true,
  };

  const first = await startPlannerRuntime(sharedOptions);
  const firstUrl = runtimeBaseUrl(first);
  const initialHealth = await (await fetch(`${firstUrl}/api/health`)).json();
  assert.equal(initialHealth.status, "degraded");
  assert.equal(initialHealth.application.initialized, false);
  assert.equal(initialHealth.store.quickCheck, "ok");
  assert.deepEqual(initialHealth.codex, {
    status: "unavailable",
    state: "unavailable",
    authenticated: null,
    protocolCompatible: null,
  });
  assert.equal(Object.hasOwn(initialHealth, "codexFollowUp"), false);
  assert.deepEqual(initialHealth.globalCodex, {
    status: "unavailable",
    reason: "Global Codex ingress is not configured.",
  });

  const bootstrap = await fetch(`${firstUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ requestId: "bootstrap-seed", mode: "seed" }),
  });
  assert.equal(bootstrap.status, 201);
  const seeded = await bootstrap.json();
  assert.equal(seeded.imported, false);
  assert.equal(seeded.workspace.initialized, true);
  assert.equal(seeded.workspace.state.activeWeekId, "2026-07-06");
  assert.equal(
    (await (await fetch(`${firstUrl}/api/health`)).json()).application.initialized,
    true,
  );
  await first.close();

  const restarted = await startPlannerRuntime(sharedOptions);
  t.after(() => restarted.close());
  const readback = await (await fetch(`${runtimeBaseUrl(restarted)}/api/workspace`)).json();
  assert.equal(readback.initialized, true);
  assert.equal(readback.state.activeWeekId, "2026-07-06");
  assert.equal(readback.plannerVersion, 0);
});

test("runtime composes the native Codex thread API and owns its app-server lifecycle", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-native-codex-runtime-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const children = [];
  let runtimeClosed = false;
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory),
    codexRuntime: createNativeCodexRuntime(children, {
      onClose: () => {
        runtimeClosed = true;
      },
    }),
    codexFixedCwd: process.cwd(),
    webProbe: async () => true,
  });
  assert.notEqual(runtime.codexThreads, null);
  const baseUrl = runtimeBaseUrl(runtime);

  const created = await fetch(`${baseUrl}/api/codex/threads/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ requestId: "new-native-thread", expectedSelectionRevision: 0 }),
  });
  assert.equal(created.status, 201);
  const creation = await created.json();
  assert.equal(creation.thread.id, creation.selection.threadId);
  assert.equal(creation.selection.revision, 1);
  assert.equal(children.length, 1);

  const history = await (await fetch(`${baseUrl}/api/codex/threads`)).json();
  assert.equal(history.threads.length, 1);
  assert.equal(history.threads[0].id, creation.thread.id);
  const read = await (await fetch(
    `${baseUrl}/api/codex/thread?threadId=${encodeURIComponent(creation.thread.id)}`,
  )).json();
  assert.equal(read.thread.id, creation.thread.id);
  assert.deepEqual(read.interactions, []);

  const firstClose = runtime.close();
  assert.equal(runtime.close(), firstClose);
  await firstClose;
  assert.equal(runtimeClosed, true);
  assert.equal(children[0].exitCode !== null || children[0].signalCode !== null, true);
});

test("direct runtime construction cannot adopt a foreign native admission without owner proof", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-native-owner-proof-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = openPlannerStore({ filename: join(dataDirectory, "planner.sqlite") });
  const codexStore = createSqliteCodexThreadStore(store);
  assert.equal(codexStore.beginThreadStartAdmission({
    requestId: "foreign-runtime-admission",
    ownerId: "foreign-live-runtime",
    payloadHash: "a".repeat(64),
    expectedSelectionRevision: 0,
    newestBeforeCreatedAtSeconds: null,
    newestBeforeRootThreadIds: [],
    createdAt: 1,
  }).status, "started");
  const children = [];
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory),
    store,
    codexRuntime: createNativeCodexRuntime(children),
    codexFixedCwd: process.cwd(),
    webProbe: async () => true,
  });
  t.after(() => runtime.close());

  await assert.rejects(
    runtime.codexThreads.listThreads({}),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /another live planner runtime/iu.test(error.message),
  );
  assert.equal(createSqliteCodexThreadStore(runtime.store)
    .readThreadStartAdmission().ownerId, "foreign-live-runtime");
});

test("front-controller health fails when the internal web process is unavailable", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-front-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let codexClosed = false;
  let globalCodexClosed = false;
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory, {
      mode: "front",
      webOrigin: new URL("http://127.0.0.1:3002"),
    }),
    codexRuntime: createCodexRuntime({
      state: "incompatible",
      authenticated: false,
      protocolCompatible: false,
      onClose: () => {
        codexClosed = true;
      },
    }),
    codexFixedCwd: process.cwd(),
    globalCodexIngressFactory: async (planner) => {
      assert.equal(planner.readWorkspace().initialized, false);
      return {
        readStatus: () => ({ status: "ready" }),
        close: () => {
          globalCodexClosed = true;
        },
      };
    },
    webProbe: async () => false,
  });
  t.after(() => runtime.close());

  const response = await fetch(`${runtimeBaseUrl(runtime)}/api/health`);
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.status, "unavailable");
  assert.equal(health.web.status, "unavailable");
  assert.equal(health.store.status, "ready");
  assert.deepEqual(health.codex, {
    status: "unavailable",
    state: "incompatible",
    authenticated: false,
    protocolCompatible: false,
  });
  assert.deepEqual(health.globalCodex, { status: "ready" });

  await runtime.close();
  assert.equal(codexClosed, true);
  assert.equal(globalCodexClosed, true);
});

test("API-mode health observes the development web process", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-api-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let webReady = true;
  let probedOrigin;
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory),
    codexRuntime: createCodexRuntime({
      state: "compatible",
      authenticated: true,
      protocolCompatible: true,
    }),
    codexFixedCwd: process.cwd(),
    webProbe: async (origin) => {
      probedOrigin = origin.href;
      return webReady;
    },
  });
  t.after(() => runtime.close());
  const baseUrl = runtimeBaseUrl(runtime);

  const ready = await fetch(`${baseUrl}/api/health`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, "ready");
  assert.equal(probedOrigin, "http://127.0.0.1:3001/");
  webReady = false;
  const unavailable = await fetch(`${baseUrl}/api/health`);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).web.status, "unavailable");
  const firstClose = runtime.close();
  const repeatedClose = runtime.close();
  assert.equal(firstClose, repeatedClose);
  await firstClose;
});

test("default web readiness probe follows a real development listener", async (t) => {
  const web = createServer((_request, response) => response.end("web ready"));
  await new Promise((resolve, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeHttpServer(web));
  const webAddress = web.address();
  assert.equal(typeof webAddress, "object");
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-real-web-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory, {
      webOrigin: new URL(`http://127.0.0.1:${webAddress.port}`),
    }),
    codexRuntime: createCodexRuntime({
      state: "compatible",
      authenticated: true,
      protocolCompatible: true,
    }),
    codexFixedCwd: process.cwd(),
  });
  t.after(() => runtime.close());
  const healthUrl = `${runtimeBaseUrl(runtime)}/api/health`;

  assert.equal((await fetch(healthUrl)).status, 200);
  await closeHttpServer(web);
  const unavailable = await fetch(healthUrl);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).web.status, "unavailable");
});

test("startup failure closes every acquired resource and preserves the primary error", async (t) => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeHttpServer(blocker));
  const address = blocker.address();
  assert.equal(typeof address, "object");
  const store = openPlannerStore({ filename: ":memory:" });
  let closeCodexCalls = 0;
  let closeGlobalCodexCalls = 0;

  await assert.rejects(
    startPlannerRuntime({
      config: createConfig("unused", { port: address.port }),
      store,
      codexRuntime: createCodexRuntime({
        readStatus() {
          throw new Error("status read failure");
        },
        onClose() {
          closeCodexCalls += 1;
          throw new Error("Codex cleanup failure");
        },
      }),
      codexFixedCwd: null,
      globalCodexIngressFactory: async () => ({
        readStatus: () => ({ status: "ready" }),
        close() {
          closeGlobalCodexCalls += 1;
          throw new Error("global ingress cleanup failure");
        },
      }),
      webProbe: async () => true,
    }),
    (error) => error.code === "EADDRINUSE",
  );
  assert.equal(closeCodexCalls, 1);
  assert.equal(closeGlobalCodexCalls, 1);
  assert.throws(() => store.checkIntegrity());
});

test("global ingress construction failure is additive and leaves core readiness intact", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-global-fail-soft-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory),
    codexRuntime: createCodexRuntime({
      state: "compatible",
      authenticated: true,
      protocolCompatible: true,
    }),
    codexFixedCwd: process.cwd(),
    globalCodexIngressFactory: async () => {
      throw new Error("fixture bind failure");
    },
    webProbe: async () => true,
  });
  t.after(() => runtime.close());

  const health = await (await fetch(`${runtimeBaseUrl(runtime)}/api/health`)).json();
  assert.equal(health.status, "ready");
  assert.deepEqual(health.globalCodex, {
    status: "unavailable",
    reason: "Global Codex ingress could not start.",
  });
});
