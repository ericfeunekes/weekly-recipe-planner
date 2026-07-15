import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";
import { createDeterministicCodexRuntime } from "../support/e2e-runtime.mjs";

const BROWSER_ORIGIN = "http://localhost:3001";
const REQUEST_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT_MS = 10_000;
const APP_CWD = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function withDeadline(promise, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not complete within ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPath(path, label) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`${label} did not complete within ${REQUEST_TIMEOUT_MS}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function instrumentCodexRuntime(runtime) {
  const stats = { spawnCalls: 0 };
  return {
    stats,
    runtime: {
      evaluate: (...argumentsValue) => runtime.evaluate(...argumentsValue),
      readStatus: (...argumentsValue) => runtime.readStatus(...argumentsValue),
      spawnAppServer: (...argumentsValue) => {
        stats.spawnCalls += 1;
        return runtime.spawnAppServer(...argumentsValue);
      },
      close: (...argumentsValue) => runtime.close(...argumentsValue),
    },
  };
}

async function startListenerRuntime(t, prefix, codexState) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const overlapStartedMarkerPath = join(directory, ".held-overlap-started");
  const overlapReleaseMarkerPath = join(directory, ".held-overlap-release");
  const instrumentedCodex = instrumentCodexRuntime(
    createDeterministicCodexRuntime(codexState, {
      fixedCwd: APP_CWD,
      overlapStartedMarkerPath,
      overlapReleaseMarkerPath,
    }),
  );
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await startPlannerRuntime({
    config: {
      mode: "api",
      host: "127.0.0.1",
      port: 0,
      dataDirectory: directory,
      databasePath: join(directory, "planner.sqlite"),
      webOrigin: new URL(BROWSER_ORIGIN),
      allowedOrigins: new Set([BROWSER_ORIGIN]),
    },
    codexRuntime: instrumentedCodex.runtime,
    codexFixedCwd: APP_CWD,
    webProbe: async () => true,
    shutdownGracePeriodMs: 1_000,
  });
  const address = runtime.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    codexStats: instrumentedCodex.stats,
    waitForCompletionStart: () =>
      waitForPath(overlapStartedMarkerPath, "Codex completion start"),
    releaseCompletion: () =>
      writeFile(overlapReleaseMarkerPath, "release\n", { flag: "wx" }),
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text),
  };
}

function postJson(baseUrl, path, body) {
  return requestJson(baseUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BROWSER_ORIGIN },
    body: JSON.stringify(body),
  });
}

function assertNoSqliteOrServerLeak(...responses) {
  for (const response of responses) {
    assert.notEqual(response.status, 500);
    assert.doesNotMatch(response.text, /SQLITE_BUSY|database is (?:busy|locked)/i);
  }
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test(
  "overlapping listener-backed chat submissions admit one authenticated Codex completion",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await startListenerRuntime(
      t,
      "planner-chat-http-overlap-",
      "compatible",
    );
    const { baseUrl } = fixture;
    const bootstrap = await postJson(baseUrl, "/api/bootstrap", {
      requestId: "bootstrap-chat-overlap",
      mode: "seed",
    });
    assert.equal(bootstrap.status, 201);
    const initial = bootstrap.body.workspace;
    const weekId = initial.state.activeWeekId;
    assert.equal(typeof weekId, "string");

    const winnerRequestId = "chat-overlap-winner";
    const loserRequestId = "chat-overlap-loser";
    const winnerMessage = "Propose conflicting meal change during retry isolation.";
    const loserMessage = "This request must observe the durable busy turn.";
    const submit = (requestId, message) =>
      postJson(baseUrl, "/api/chat/submit", {
        requestId,
        basePlannerVersion: initial.plannerVersion,
        message,
        context: { view: "week", weekId },
        intent: { kind: "planner", archiveContextWeek: false },
      });

    const winnerPromise = submit(winnerRequestId, winnerMessage);
    void winnerPromise.catch(() => {});
    let winnerResponse;
    try {
      const startOutcome = await Promise.race([
        fixture.waitForCompletionStart().then(() => ({ status: "started" })),
        winnerPromise.then((response) => ({ status: "completed_early", response })),
      ]);
      assert.equal(
        startOutcome.status,
        "started",
        `Winning chat completed before the controlled Codex barrier: ${JSON.stringify(
          startOutcome.status === "completed_early"
            ? {
                status: startOutcome.response.status,
                decision: startOutcome.response.body.decision,
              }
            : startOutcome,
        )}`,
      );

      // The winner's listener request remains open at the adapter while this
      // second request traverses the same real HTTP and SQLite boundaries.
      const loserResponse = await submit(loserRequestId, loserMessage);
      assert.equal(loserResponse.status, 409);
      assert.equal(loserResponse.body.decision.status, "turn_busy");
      assert.equal(loserResponse.body.decision.runningTurn.requestId, winnerRequestId);
      assertNoSqliteOrServerLeak(loserResponse);

      const pendingReadback = await requestJson(baseUrl, "/api/workspace");
      assert.equal(pendingReadback.status, 200);
      assert.deepEqual(loserResponse.body.workspace, pendingReadback.body);
      const pendingUserEntries = pendingReadback.body.transcriptEntries.filter(
        (entry) => entry.role === "user",
      );
      assert.equal(pendingUserEntries.length, 1);
      assert.equal(pendingUserEntries[0].text, winnerMessage);
      assert.equal(pendingReadback.body.chatTurns.length, 1);
      assert.equal(pendingReadback.body.chatTurns[0].requestId, winnerRequestId);
      assert.equal(pendingReadback.body.chatTurns[0].status, "running");
      assert.equal(
        pendingUserEntries[0].turnId,
        pendingReadback.body.chatTurns[0].turnId,
      );
      assert.equal(fixture.codexStats.spawnCalls, 1);

      await fixture.releaseCompletion();
      winnerResponse = await withDeadline(winnerPromise, "winning chat HTTP response");
      assert.equal(winnerResponse.status, 202);
      assert.equal(winnerResponse.body.decision.status, "accepted");
      assert.equal(winnerResponse.body.decision.turn.requestId, winnerRequestId);
      assert.equal(winnerResponse.body.decision.turn.status, "completed");
      assertNoSqliteOrServerLeak(winnerResponse);

      const finalReadback = await requestJson(baseUrl, "/api/workspace");
      assert.deepEqual(winnerResponse.body.workspace, finalReadback.body);
      const finalUserEntries = finalReadback.body.transcriptEntries.filter(
        (entry) => entry.role === "user",
      );
      assert.equal(finalUserEntries.length, 1);
      assert.equal(finalUserEntries[0].text, winnerMessage);
      assert.equal(finalReadback.body.chatTurns.length, 1);
      assert.equal(finalReadback.body.chatTurns[0].requestId, winnerRequestId);
      assert.equal(finalReadback.body.chatTurns[0].status, "completed");
      assert.equal(
        finalReadback.body.chatTurns.some((turn) => turn.requestId === loserRequestId),
        false,
      );
      assert.equal(
        finalReadback.body.transcriptEntries.some((entry) => entry.text === loserMessage),
        false,
      );
      assert.equal(fixture.codexStats.spawnCalls, 1);
    } finally {
      await fixture.releaseCompletion().catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      if (!winnerResponse) await winnerPromise.catch(() => {});
    }
  },
);

test(
  "same-version archive and handoff HTTP commands commit one canonical lifecycle",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await startListenerRuntime(
      t,
      "planner-lifecycle-http-race-",
      "unavailable",
    );
    const { baseUrl } = fixture;
    const bootstrap = await postJson(baseUrl, "/api/bootstrap", {
      requestId: "bootstrap-lifecycle-race",
      mode: "seed",
    });
    assert.equal(bootstrap.status, 201);
    const currentWeekId = bootstrap.body.workspace.state.activeWeekId;
    assert.equal(typeof currentWeekId, "string");
    const nextWeekId = addDays(currentWeekId, 7);

    const planned = await postJson(baseUrl, "/api/commands", {
      requestId: "create-planned-week",
      basePlannerVersion: bootstrap.body.workspace.plannerVersion,
      command: {
        type: "createWeekPlan",
        weekStartDate: nextWeekId,
        plan: { meals: [], groceries: [] },
      },
    });
    assert.equal(planned.status, 200);
    assert.equal(planned.body.decision.status, "accepted");
    assert.equal(
      planned.body.workspace.state.weeks.find((week) => week.id === currentWeekId).status,
      "active",
    );
    assert.equal(
      planned.body.workspace.state.weeks.find((week) => week.id === nextWeekId).status,
      "planned",
    );

    const basePlannerVersion = planned.body.workspace.plannerVersion;
    const candidates = [
      {
        requestId: "race-archive-current-week",
        command: { type: "archiveWeek", weekId: currentWeekId },
      },
      {
        requestId: "race-handoff-next-week",
        command: { type: "handoffWeek", currentWeekId, nextWeekId },
      },
    ];
    const results = await withDeadline(
      Promise.all(
        candidates.map(async (candidate) => ({
          ...candidate,
          ...(await postJson(baseUrl, "/api/commands", {
            requestId: candidate.requestId,
            basePlannerVersion,
            command: candidate.command,
          })),
        })),
      ),
      "lifecycle command race",
    );

    assert.deepEqual(
      results.map((result) => result.status).sort((left, right) => left - right),
      [200, 409],
    );
    assert.deepEqual(
      results.map((result) => result.body.decision.status).sort(),
      ["accepted", "version_conflict"],
    );
    assertNoSqliteOrServerLeak(...results);

    const accepted = results.find((result) => result.body.decision.status === "accepted");
    const conflicted = results.find(
      (result) => result.body.decision.status === "version_conflict",
    );
    assert.ok(accepted);
    assert.ok(conflicted);
    assert.equal(conflicted.body.decision.expectedVersion, basePlannerVersion);
    assert.equal(conflicted.body.decision.actualVersion, basePlannerVersion + 1);
    assert.deepEqual(conflicted.body.workspace, accepted.body.workspace);

    const finalReadback = await requestJson(baseUrl, "/api/workspace");
    assert.equal(finalReadback.status, 200);
    assert.deepEqual(finalReadback.body, accepted.body.workspace);
    const state = finalReadback.body.state;
    const activeWeeks = state.weeks.filter((week) => week.status === "active");
    assert.ok(activeWeeks.length <= 1);
    assert.equal(
      state.activeWeekId,
      activeWeeks.length === 0 ? null : activeWeeks[0].id,
    );
    assert.equal(
      state.weeks.find((week) => week.id === currentWeekId).status,
      "archived",
    );
    if (accepted.command.type === "archiveWeek") {
      assert.equal(state.activeWeekId, null);
      assert.equal(
        state.weeks.find((week) => week.id === nextWeekId).status,
        "planned",
      );
    } else {
      assert.equal(state.activeWeekId, nextWeekId);
      assert.equal(
        state.weeks.find((week) => week.id === nextWeekId).status,
        "active",
      );
    }
    assert.equal(
      state.weeks.filter((week) => week.status === "active").length,
      state.activeWeekId === null ? 0 : 1,
    );
    assert.equal(
      finalReadback.body.events.filter((event) => event.requestId === accepted.requestId)
        .length,
      1,
    );
    assert.equal(
      finalReadback.body.events.some((event) => event.requestId === conflicted.requestId),
      false,
    );
    assert.equal(fixture.codexStats.spawnCalls, 0);
  },
);
