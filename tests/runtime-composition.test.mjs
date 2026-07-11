import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startPlannerRuntime } from "../server/runtime/planner-runtime.ts";

const ALLOWED_ORIGIN = "http://localhost:3001";

function createConfig(dataDirectory, overrides = {}) {
  return {
    mode: "api",
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    databasePath: join(dataDirectory, "planner.sqlite"),
    webOrigin: null,
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    ...overrides,
  };
}

function createCodex({ available = false, authenticated = null } = {}) {
  return {
    async complete() {
      throw new Error("The deterministic runtime test must not call Codex.");
    },
    async readStatus() {
      return {
        available,
        authenticated,
        detail: available ? "available" : "unavailable",
      };
    },
  };
}

function runtimeBaseUrl(runtime) {
  const address = runtime.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

test("composed authority bootstraps once and survives a real process restart", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-runtime-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let sequence = 0;
  const sharedOptions = {
    config: createConfig(dataDirectory),
    codexAdapter: createCodex(),
    clock: { now: () => Date.UTC(2026, 6, 6, 12) },
    idFactory: { createId: (prefix) => `${prefix}-${++sequence}` },
  };

  const first = await startPlannerRuntime(sharedOptions);
  const firstUrl = runtimeBaseUrl(first);
  const initialHealth = await (await fetch(`${firstUrl}/api/health`)).json();
  assert.equal(initialHealth.status, "degraded");
  assert.equal(initialHealth.application.initialized, false);
  assert.equal(initialHealth.store.quickCheck, "ok");
  assert.equal(initialHealth.codex.status, "unavailable");

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
  assert.equal(restarted.interruptedTurns, 0);
  const readback = await (await fetch(`${runtimeBaseUrl(restarted)}/api/workspace`)).json();
  assert.equal(readback.initialized, true);
  assert.equal(readback.state.activeWeekId, "2026-07-06");
  assert.equal(readback.plannerVersion, 0);
});

test("front-controller health fails when the internal web process is unavailable", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planner-front-health-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let codexClosed = false;
  const runtime = await startPlannerRuntime({
    config: createConfig(dataDirectory, {
      mode: "front",
      webOrigin: new URL("http://127.0.0.1:3002"),
    }),
    codexAdapter: createCodex({ available: true, authenticated: true }),
    closeCodex: () => {
      codexClosed = true;
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

  await runtime.close();
  assert.equal(codexClosed, true);
});
