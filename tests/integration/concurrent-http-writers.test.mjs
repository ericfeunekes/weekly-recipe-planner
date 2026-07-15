import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";

const browserOrigin = "http://localhost:3001";
const codexRuntime = {
  async evaluate() {
    return this.readStatus();
  },
  readStatus() {
    return {
      state: "unavailable",
      authenticated: null,
      protocolCompatible: null,
      cacheHit: false,
      evidence: null,
      detail: "not used",
    };
  },
  async spawnAppServer() {
    throw new Error("Codex is outside this writer-race fixture.");
  },
  async close() {},
};

test("simultaneous HTTP writers resolve to one accepted commit and one authoritative conflict", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-http-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await startPlannerRuntime({
    config: {
      mode: "api",
      host: "127.0.0.1",
      port: 0,
      dataDirectory: directory,
      databasePath: join(directory, "planner.sqlite"),
      webOrigin: new URL(browserOrigin),
      allowedOrigins: new Set([browserOrigin]),
    },
    codexRuntime,
    codexFixedCwd: null,
    webProbe: async () => true,
  });
  t.after(() => runtime.close());
  const address = runtime.server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { "Content-Type": "application/json", Origin: browserOrigin };

  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId: "bootstrap-race", mode: "seed" }),
  });
  assert.equal(bootstrap.status, 201);
  const initial = await bootstrap.json();
  const weekId = initial.workspace.state.activeWeekId;
  assert.equal(typeof weekId, "string");

  const send = (requestId, weekLesson) => fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId,
      basePlannerVersion: initial.workspace.plannerVersion,
      command: { type: "captureWeekLesson", weekId, weekLesson },
    }),
  }).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));

  const results = await Promise.all([
    send("writer-a", "Writer A won the shared update."),
    send("writer-b", "Writer B won the shared update."),
  ]);
  assert.deepEqual(
    results.map((result) => result.body.decision.status).sort(),
    ["accepted", "version_conflict"],
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(
    results.some((result) => JSON.stringify(result.body).includes("SQLITE_BUSY")),
    false,
  );

  const accepted = results.find((result) => result.body.decision.status === "accepted");
  const conflicted = results.find((result) => result.body.decision.status === "version_conflict");
  assert.deepEqual(conflicted.body.workspace, accepted.body.workspace);
  assert.equal(accepted.body.workspace.plannerVersion, initial.workspace.plannerVersion + 1);
  assert.equal(accepted.body.workspace.events.length, 1);
  assert.ok([
    "Writer A won the shared update.",
    "Writer B won the shared update.",
  ].includes(accepted.body.workspace.state.weeks[0].data.weekLesson));
});
