import assert from "node:assert/strict";
import test from "node:test";

import { CodexThreadClientError } from "../app/codex-thread-api.ts";
import { createCodexThreadSource } from "../app/codex-thread-source.ts";

function summary(id, status = { state: "idle", waitingFor: null }) {
  return {
    id,
    title: `Task ${id}`,
    preview: `Preview ${id}`,
    status,
    createdAtMs: 1,
    updatedAtMs: 2,
    recencyAtMs: 2,
  };
}

function thread(id, options = {}) {
  return {
    ...summary(id, options.status),
    threadKind: options.threadKind ?? "conversation",
    parentThreadId: options.parentThreadId ?? null,
    turns: options.turns ?? [],
    workers: options.workers ?? [],
    historyTruncated: false,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listResponse({
  threads = [],
  threadId = null,
  revision = 0,
  activityRevision = 0,
  connectionEpoch = "epoch-1",
} = {}) {
  return {
    threads,
    nextCursor: null,
    selection: { threadId, revision },
    connectionEpoch,
    activityRevision,
  };
}

function readResponse(id, options = {}) {
  return {
    thread: thread(id, options),
    selection: { threadId: options.selectedId ?? id, revision: options.revision ?? 1 },
    interactions: [],
    connectionEpoch: options.connectionEpoch ?? "epoch-1",
    activityRevision: options.activityRevision ?? 1,
  };
}

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("a cleared restart state sends through one fresh root without a premature read", async () => {
  const calls = [];
  let materialized = false;
  await withFetch(async (path, init = {}) => {
    calls.push({
      path: String(path),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (path === "/api/codex/threads" && calls.length === 1) {
      return json(listResponse({ revision: 2, activityRevision: 1 }));
    }
    if (path === "/api/codex/threads/new") {
      return json({
        thread: summary("blank-root"),
        selection: { threadId: "blank-root", revision: 3 },
        connectionEpoch: "epoch-1",
        activityRevision: 1,
      }, 201);
    }
    if (path === "/api/codex/turns/send") {
      materialized = true;
      return json({
        threadId: "blank-root",
        turnId: "turn-1",
        connectionEpoch: "epoch-1",
        activityRevision: 2,
      }, 202);
    }
    if (path === "/api/codex/threads" && materialized) {
      return json(listResponse({
        threads: [summary("blank-root")],
        threadId: "blank-root",
        revision: 3,
        activityRevision: 2,
      }));
    }
    if (String(path).startsWith("/api/codex/thread?")) {
      return json(readResponse("blank-root", { revision: 3, activityRevision: 2 }));
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    assert.equal((await source.load()).status, "empty");
    const sent = await source.send("Make a plan");
    assert.equal(sent.status, "ready");
    assert.equal(sent.thread?.id, "blank-root");
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path.split("?", 1)[0]}`), [
    "GET /api/codex/threads",
    "POST /api/codex/threads/new",
    "POST /api/codex/turns/send",
    "GET /api/codex/threads",
    "GET /api/codex/thread",
  ]);
  assert.equal(calls[1].body.expectedSelectionRevision, 2);
  assert.equal(calls[2].body.expectedSelectionRevision, 3);
  assert.equal(calls[2].body.threadId, "blank-root");
});

test("a client reload within the same app-server keeps a blank root directly sendable", async () => {
  const calls = [];
  let materialized = false;
  await withFetch(async (path) => {
    calls.push(String(path).split("?", 1)[0]);
    if (path === "/api/codex/threads") {
      return json(listResponse({
        threads: [summary(
          "restored-blank-root",
          materialized
            ? { state: "idle", waitingFor: null }
            : { state: "not_loaded", waitingFor: null },
        )],
        threadId: "restored-blank-root",
        revision: 7,
        activityRevision: materialized ? 9 : 8,
      }));
    }
    if (path === "/api/codex/turns/send") {
      materialized = true;
      return json({
        threadId: "restored-blank-root",
        turnId: "turn-restored",
        connectionEpoch: "epoch-1",
        activityRevision: 9,
      }, 202);
    }
    if (String(path).startsWith("/api/codex/thread?")) {
      assert.equal(materialized, true, "thread history is unavailable before the first send");
      return json(readResponse("restored-blank-root", {
        revision: 7,
        activityRevision: 9,
      }));
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    const restored = await source.load();
    assert.equal(restored.status, "selected_unmaterialized");
    const sent = await source.send("Materialize after client reload");
    assert.equal(sent.status, "ready");
  });
  assert.deepEqual(calls, [
    "/api/codex/threads",
    "/api/codex/turns/send",
    "/api/codex/threads",
    "/api/codex/thread",
  ]);
});

test("a server-declared ambiguous send replays the byte-identical admission and fences a different message", async () => {
  const bodies = [];
  let sendAttempts = 0;
  let listReads = 0;
  await withFetch(async (path, init = {}) => {
    if (path === "/api/codex/threads") {
      listReads += 1;
      return json(listResponse({
        threads: [summary("root-1")],
        threadId: "root-1",
        revision: 4,
        activityRevision: listReads,
      }));
    }
    if (String(path).startsWith("/api/codex/thread?")) {
      return json(readResponse("root-1", { revision: 4, activityRevision: listReads }));
    }
    if (path === "/api/codex/turns/send") {
      sendAttempts += 1;
      bodies.push(init.body);
      if (sendAttempts === 1) {
        return json({
          error: {
            code: "CODEX_UNAVAILABLE",
            message: "Codex accepted the message but history is still converging.",
          },
        }, 503);
      }
      return json({
        threadId: "root-1",
        turnId: "turn-1",
        connectionEpoch: "epoch-1",
        activityRevision: 8,
      }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    await source.load();
    await assert.rejects(
      source.send("Same logical message"),
      (error) => error instanceof CodexThreadClientError && error.code === "CODEX_UNAVAILABLE",
    );
    await assert.rejects(
      source.send("Conflicting logical message"),
      (error) => error instanceof CodexThreadClientError && error.code === "TURN_CONFLICT",
    );
    const replayed = await source.send("Same logical message");
    assert.equal(replayed.status, "ready");
  });

  assert.equal(sendAttempts, 2);
  assert.equal(bodies[0], bodies[1]);
  const first = JSON.parse(bodies[0]);
  const second = JSON.parse(bodies[1]);
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.clientUserMessageId, second.clientUserMessageId);
});

test("an accepted mutation with mismatched response identity retains its exact replay identity", async () => {
  const bodies = [];
  let sendAttempts = 0;
  await withFetch(async (path, init = {}) => {
    if (path === "/api/codex/threads") {
      return json(listResponse({
        threads: [summary("root-1")],
        threadId: "root-1",
        revision: 4,
        activityRevision: 4,
      }));
    }
    if (String(path).startsWith("/api/codex/thread?")) {
      return json(readResponse("root-1", { revision: 4, activityRevision: 4 }));
    }
    if (path === "/api/codex/turns/send") {
      sendAttempts += 1;
      bodies.push(init.body);
      return json({
        threadId: sendAttempts === 1 ? "wrong-root" : "root-1",
        turnId: "turn-1",
        connectionEpoch: "epoch-1",
        activityRevision: 5,
      }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    await source.load();
    await assert.rejects(
      source.send("Do not cross-bind this response"),
      (error) => error instanceof CodexThreadClientError && error.code === "INVALID_RESPONSE",
    );
    assert.equal(source.getSnapshot().thread?.id, "root-1");
    assert.equal(source.getSnapshot().selection.threadId, "root-1");
    const replayed = await source.send("Do not cross-bind this response");
    assert.equal(replayed.status, "ready");
  });
  assert.equal(sendAttempts, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("an ambiguous new-task admission survives navigation and cannot overwrite the newer selection", async () => {
  const newBodies = [];
  let newAttempts = 0;
  let selected = false;
  await withFetch(async (path, init = {}) => {
    if (path === "/api/codex/threads") {
      return json(selected
        ? listResponse({
            threads: [summary("existing-root")],
            threadId: "existing-root",
            revision: 2,
            activityRevision: 2,
          })
        : listResponse());
    }
    if (String(path).includes("threadId=existing-root")) {
      return json(readResponse("existing-root", { revision: 2, activityRevision: 2 }));
    }
    if (path === "/api/codex/threads/new") {
      newAttempts += 1;
      newBodies.push(init.body);
      if (newAttempts === 1) throw new TypeError("new response lost");
      return json({
        thread: summary("created-root"),
        selection: { threadId: "existing-root", revision: 2 },
        connectionEpoch: "epoch-1",
        activityRevision: 3,
      }, 201);
    }
    if (path === "/api/codex/threads/select") {
      selected = true;
      return json({
        thread: summary("existing-root"),
        selection: { threadId: "existing-root", revision: 2 },
        connectionEpoch: "epoch-1",
        activityRevision: 2,
      });
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    await source.load();
    await assert.rejects(
      source.newThread(),
      (error) => error instanceof CodexThreadClientError && error.code === "NETWORK_ERROR",
    );
    const navigated = await source.select("existing-root");
    assert.equal(navigated.thread?.id, "existing-root");
    const replay = await source.newThread();
    assert.equal(replay.thread?.id, "existing-root");
    assert.equal(replay.selection.threadId, "existing-root");
  });
  assert.equal(newAttempts, 2);
  assert.equal(newBodies[0], newBodies[1]);
});

test("the source-owned subscription advances quiet cursors, rearms, and aborts without fallback load", async () => {
  const afterRevisions = [];
  let listReads = 0;
  let eventReads = 0;
  let resolveChanged;
  let resolveRearmed;
  const changed = new Promise((resolve) => {
    resolveChanged = resolve;
  });
  const rearmed = new Promise((resolve) => {
    resolveRearmed = resolve;
  });

  await withFetch(async (path, init = {}) => {
    if (path === "/api/codex/threads") {
      listReads += 1;
      return json(listResponse({ activityRevision: listReads === 1 ? 0 : 3 }));
    }
    if (String(path).startsWith("/api/codex/events?")) {
      const url = new URL(String(path), "http://planner.test");
      afterRevisions.push(Number(url.searchParams.get("afterRevision")));
      eventReads += 1;
      if (eventReads <= 2) {
        return json({
          changed: false,
          connectionEpoch: "epoch-1",
          revision: eventReads,
          resyncRequired: false,
          reasons: [],
        });
      }
      if (eventReads === 3) {
        return json({
          changed: true,
          connectionEpoch: "epoch-1",
          revision: 3,
          resyncRequired: false,
          reasons: ["thread"],
        });
      }
      resolveRearmed();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    const unsubscribe = source.subscribe(() => {
      if (source.getSnapshot().activityRevision === 3) resolveChanged();
    });
    await source.start();
    await changed;
    await rearmed;
    source.stop();
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.deepEqual(afterRevisions.slice(0, 4), [0, 1, 2, 3]);
  assert.equal(listReads, 2, "abort must not trigger a fallback catalogue load");
});

test("a live source recovers across poll failure, unavailable load, and a fresh epoch without replaying mutation", async () => {
  const eventRequests = [];
  let listReads = 0;
  let sendCalls = 0;
  let resolveInitialPoll;
  let resolveInitialFailure;
  let resolveUnavailable;
  let resolveRecoveredPoll;
  let resolveRecoveredQuiet;
  let resolveSecondFailure;
  const initialPoll = new Promise((resolve) => {
    resolveInitialPoll = resolve;
  });
  const unavailable = new Promise((resolve) => {
    resolveUnavailable = resolve;
  });
  const recoveredPoll = new Promise((resolve) => {
    resolveRecoveredPoll = resolve;
  });
  const secondFailure = new Promise((resolve) => {
    resolveSecondFailure = resolve;
  });

  await withFetch(async (path) => {
    if (path === "/api/codex/threads") {
      listReads += 1;
      if (listReads === 3) {
        return json({
          error: { code: "CODEX_UNAVAILABLE", message: "Recovery load unavailable." },
        }, 503);
      }
      const recovered = listReads >= 4;
      return json(listResponse({
        threads: [summary("recovery-root")],
        threadId: "recovery-root",
        revision: 4,
        activityRevision: recovered ? 7 : listReads === 2 ? 2 : 1,
        connectionEpoch: recovered ? "epoch-2" : "epoch-1",
      }));
    }
    if (String(path).startsWith("/api/codex/thread?")) {
      const recovered = listReads >= 4;
      return json(readResponse("recovery-root", {
        revision: 4,
        activityRevision: recovered ? 7 : listReads === 2 ? 2 : 1,
        connectionEpoch: recovered ? "epoch-2" : "epoch-1",
      }));
    }
    if (path === "/api/codex/turns/send") {
      sendCalls += 1;
      return json({
        threadId: "recovery-root",
        turnId: "recovery-turn",
        connectionEpoch: "epoch-1",
        activityRevision: 2,
      }, 202);
    }
    if (String(path).startsWith("/api/codex/events?")) {
      const url = new URL(String(path), "http://planner.test");
      eventRequests.push({
        epoch: url.searchParams.get("connectionEpoch"),
        revision: Number(url.searchParams.get("afterRevision")),
      });
      if (eventRequests.length === 1) {
        resolveInitialPoll();
        return new Promise((resolve) => {
          resolveInitialFailure = () => resolve(json({
            error: { code: "CODEX_UNAVAILABLE", message: "Poll connection failed." },
          }, 503));
        });
      }
      if (eventRequests.length === 2) {
        resolveRecoveredPoll();
        return new Promise((resolve) => {
          resolveRecoveredQuiet = () => resolve(json({
            changed: false,
            connectionEpoch: "epoch-2",
            revision: 8,
            resyncRequired: false,
            reasons: [],
          }));
        });
      }
      resolveSecondFailure();
      return json({
        error: { code: "CODEX_UNAVAILABLE", message: "Second poll failed." },
      }, 503);
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    const unsubscribe = source.subscribe(() => {
      const snapshot = source.getSnapshot();
      if (snapshot.status === "runtime_unavailable") resolveUnavailable();
    });
    const started = await source.start();
    assert.equal(started.status, "ready");
    await initialPoll;

    const sent = await source.send("Apply this exactly once before recovery");
    assert.equal(sent.status, "ready");
    assert.equal(sendCalls, 1);
    resolveInitialFailure();

    await unavailable;
    assert.equal(source.getSnapshot().status, "runtime_unavailable");
    await recoveredPoll;
    assert.equal(source.getSnapshot().status, "ready");
    assert.equal(source.getSnapshot().connectionEpoch, "epoch-2");
    assert.equal(source.getSnapshot().activityRevision, 7);
    assert.equal(sendCalls, 1);
    resolveRecoveredQuiet();

    await secondFailure;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const readsBeforeStop = listReads;
    const snapshotBeforeStop = source.getSnapshot();
    source.stop();
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(listReads, readsBeforeStop, "stop must cancel recovery backoff before another load");
    assert.deepEqual(source.getSnapshot(), snapshotBeforeStop, "stop must prevent a late recovery commit");
    assert.equal(sendCalls, 1);
  });

  assert.deepEqual(eventRequests.slice(0, 3), [
    { epoch: "epoch-1", revision: 1 },
    { epoch: "epoch-2", revision: 7 },
    { epoch: "epoch-2", revision: 8 },
  ]);
  assert.equal(listReads, 4);
});

test("a stopped lifecycle generation cannot commit its late initial load", async () => {
  let resolveList;
  let resolveEntered;
  const entered = new Promise((resolve) => {
    resolveEntered = resolve;
  });
  await withFetch(async (path) => {
    assert.equal(path, "/api/codex/threads");
    resolveEntered();
    return new Promise((resolve) => {
      resolveList = () => resolve(json(listResponse({ activityRevision: 9 })));
    });
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    const starting = source.start();
    await entered;
    source.stop();
    resolveList();
    const result = await starting;
    assert.equal(result.status, "loading");
    assert.equal(source.getSnapshot().status, "loading");
    assert.equal(notifications, 0);
  });
});

test("a list/read selection race cannot commit the wrong task", async () => {
  let listReads = 0;
  await withFetch(async (path) => {
    if (path === "/api/codex/threads") {
      listReads += 1;
      const id = listReads === 1 ? "root-old" : "root-new";
      const revision = listReads === 1 ? 1 : 2;
      return json(listResponse({
        threads: [summary(id)],
        threadId: id,
        revision,
        activityRevision: revision,
      }));
    }
    if (String(path).includes("threadId=root-old")) {
      return json(readResponse("root-old", {
        selectedId: "root-new",
        revision: 2,
        activityRevision: 2,
      }));
    }
    if (String(path).includes("threadId=root-new")) {
      return json(readResponse("root-new", { revision: 2, activityRevision: 2 }));
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    const snapshot = await source.load();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.selection.threadId, "root-new");
    assert.equal(snapshot.thread?.id, "root-new");
  });
  assert.equal(listReads, 2);
});

test("worker reads are typed, read-only, and cannot change the selected root", async () => {
  await withFetch(async (path) => {
    if (path === "/api/codex/threads") {
      return json(listResponse({
        threads: [summary("root-1")],
        threadId: "root-1",
        revision: 5,
        activityRevision: 5,
      }));
    }
    if (String(path).includes("threadId=root-1")) {
      return json(readResponse("root-1", { revision: 5, activityRevision: 5 }));
    }
    if (String(path).includes("threadId=worker-1")) {
      return json(readResponse("worker-1", {
        threadKind: "worker",
        parentThreadId: "root-1",
        selectedId: "root-1",
        revision: 5,
        activityRevision: 6,
      }));
    }
    throw new Error(`Unexpected request ${path}`);
  }, async () => {
    const source = createCodexThreadSource({ search: "", development: false });
    await source.load();
    const worker = await source.readWorker("worker-1");
    assert.equal(worker.thread.threadKind, "worker");
    assert.deepEqual(source.getSnapshot().selection, { threadId: "root-1", revision: 5 });
    assert.equal(source.getSnapshot().thread?.id, "root-1");
  });
});
