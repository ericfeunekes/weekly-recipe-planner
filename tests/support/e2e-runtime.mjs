import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import { createCanonicalSeed } from "../../lib/household-bootstrap.ts";
import { validateHouseholdState } from "../../lib/household-domain.ts";
import {
  createGlobalCodexIngressForTests,
  createGlobalCodexPlannerPort,
  createGlobalCodexRouter,
} from "../../server/global-ingress/index.ts";
import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";
import { openPlannerStore } from "../../server/store/sqlite-store.ts";
import { assertInheritedRuntimeOwnershipLease } from "../../scripts/support/runtime-ownership.mjs";

const E2E_PREP_NOW = Date.parse("2026-07-05T12:00:00-03:00");
const E2E_DINNER_NOW = Date.parse("2026-07-07T18:00:00-03:00");

export const E2E_FIXTURE_IDS = Object.freeze(["D4", "D7"]);

export function normalizeE2eFixture(value = "D4") {
  if (!E2E_FIXTURE_IDS.includes(value)) {
    throw new TypeError(`Unsupported E2E fixture: ${String(value)}.`);
  }
  return value;
}

export function createE2eFixtureSeed(fixture, context) {
  const selected = normalizeE2eFixture(fixture);
  const state = selected === "D4"
    ? createCanonicalSeed(context)
    : {
        householdTimeZone: "America/Halifax",
        activeWeekId: null,
        weeks: [],
      };
  const validation = validateHouseholdState(state);
  if (!validation.ok) {
    throw new Error(`E2E fixture ${selected} is invalid: ${JSON.stringify(validation.issues)}`);
  }
  return state;
}

const configuredFixture = normalizeE2eFixture(
  process.env.PLANNER_E2E_FIXTURE ?? "D4",
);

const dataDirectory = resolve(
  process.env.PLANNER_E2E_DATA_DIR ?? ".planner-e2e-data",
);
const apiPort = Number(process.env.PLANNER_E2E_API_PORT ?? 8877);
const controlPort = Number(process.env.PLANNER_E2E_CONTROL_PORT ?? 8878);
const webOrigin = new URL(
  process.env.PLANNER_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3101",
);
const hangMarkerPath = resolve(dataDirectory, ".wait-through-restart");
const conflictStartedMarkerPath = resolve(dataDirectory, ".held-conflict-started");
const conflictReleaseMarkerPath = resolve(dataDirectory, ".held-conflict-release");
const overlapStartedMarkerPath = resolve(dataDirectory, ".held-overlap-started");
const overlapReleaseMarkerPath = resolve(dataDirectory, ".held-overlap-release");
const researchStartedMarkerPath = resolve(dataDirectory, ".held-research-started");
const researchReleaseMarkerPath = resolve(dataDirectory, ".held-research-release");
const modulePath = fileURLToPath(import.meta.url);
const fakeAppServerPath = fileURLToPath(
  new URL("./fixtures/codex-runtime/fake-e2e-app-server.mjs", import.meta.url),
);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const DETERMINISTIC_CODEX_STATES = Object.freeze([
  "checking",
  "compatible",
  "unauthenticated",
  "incompatible",
  "unavailable",
]);

function deterministicCodexStatus(state) {
  if (!DETERMINISTIC_CODEX_STATES.includes(state)) {
    throw new TypeError(`Unsupported deterministic Codex state: ${state}`);
  }
  const ready = state === "compatible";
  return Object.freeze({
    state,
    authenticated: ready ? true : state === "unauthenticated" ? false : null,
    protocolCompatible: ready || state === "unauthenticated"
      ? true
      : state === "incompatible"
        ? false
        : null,
    cacheHit: false,
    evidence: ready ? Object.freeze({
      canonicalPath: fakeAppServerPath,
      version: "e2e-fixture",
      sha256: "0".repeat(64),
      schemaFingerprint: "1".repeat(64),
      userConfigSha256: null,
      systemConfigSha256: null,
      systemConfigPathCount: 0,
      instructionSha256: null,
      accountKind: "chatgpt",
    }) : null,
    detail: `Deterministic generated-protocol E2E fixture is ${state}.`,
  });
}

export function createDeterministicCodexRuntime(initialState = "compatible", options = {}) {
  const markers = {
    hang: options.hangMarkerPath ?? hangMarkerPath,
    conflictStarted: options.conflictStartedMarkerPath ?? conflictStartedMarkerPath,
    conflictRelease: options.conflictReleaseMarkerPath ?? conflictReleaseMarkerPath,
    overlapStarted: options.overlapStartedMarkerPath ?? overlapStartedMarkerPath,
    overlapRelease: options.overlapReleaseMarkerPath ?? overlapReleaseMarkerPath,
    researchStarted: options.researchStartedMarkerPath ?? researchStartedMarkerPath,
    researchRelease: options.researchReleaseMarkerPath ?? researchReleaseMarkerPath,
  };
  const children = new Set();
  let closed = false;
  let status = deterministicCodexStatus(initialState);
  return {
    async evaluate() {
      return status;
    },
    readStatus() {
      return status;
    },
    setState(state) {
      status = deterministicCodexStatus(state);
    },
    async spawnAppServer({ signal } = {}) {
      if (closed) throw new Error("Deterministic Codex runtime is closed.");
      if (signal?.aborted) throw signal.reason ?? new Error("Deterministic Codex spawn aborted.");
      const child = spawn(process.execPath, [fakeAppServerPath], {
        cwd: options.fixedCwd ?? process.cwd(),
        env: {
          PATH: process.env.PATH,
          PLANNER_E2E_HANG_MARKER: markers.hang,
          PLANNER_E2E_CONFLICT_STARTED_MARKER: markers.conflictStarted,
          PLANNER_E2E_CONFLICT_RELEASE_MARKER: markers.conflictRelease,
          PLANNER_E2E_OVERLAP_STARTED_MARKER: markers.overlapStarted,
          PLANNER_E2E_OVERLAP_RELEASE_MARKER: markers.overlapRelease,
          PLANNER_E2E_RESEARCH_STARTED_MARKER: markers.researchStarted,
          PLANNER_E2E_RESEARCH_RELEASE_MARKER: markers.researchRelease,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderrBytes = 0;
      const stderrLimit = 64 * 1024;
      child.stderr.on("data", (chunk) => {
        if (stderrBytes >= stderrLimit) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = stderrLimit - stderrBytes;
        const bounded = bytes.subarray(0, remaining);
        stderrBytes += bounded.byteLength;
        process.stderr.write(`[deterministic-codex] ${bounded.toString("utf8")}`);
      });
      children.add(child);
      const onAbort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
        children.delete(child);
      });
      return child;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...children].map((child) => new Promise((resolveClose) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveClose();
          return;
        }
        const forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        child.once("close", () => {
          clearTimeout(forceTimer);
          resolveClose();
        });
        child.kill("SIGTERM");
      })));
    },
  };
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path.`);
  }
  return value;
}

function requirePort(value, label, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new TypeError(
      `${label} must be an integer from ${minimum} to 65535.`,
    );
  }
  return value;
}

function loopbackOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

function installedMarkerPaths(root) {
  return Object.freeze({
    hangMarkerPath: join(root, ".wait-through-restart"),
    conflictStartedMarkerPath: join(root, ".held-conflict-started"),
    conflictReleaseMarkerPath: join(root, ".held-conflict-release"),
    overlapStartedMarkerPath: join(root, ".held-overlap-started"),
    overlapReleaseMarkerPath: join(root, ".held-overlap-release"),
    researchStartedMarkerPath: join(root, ".held-research-started"),
    researchReleaseMarkerPath: join(root, ".held-research-release"),
  });
}

/**
 * Host-only installed QA controller. The authority remains in this process so
 * the exact activation-owned lease object can be checked on every restart.
 * The lease is never serialized into a child environment or control request.
 */
export async function createInProcessInstalledE2eController(options, dependencies = {}) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Installed E2E controller options are required.");
  }
  const appRoot = requireAbsolutePath(options.appRoot, "appRoot");
  const dataDirectory = requireAbsolutePath(options.dataDirectory, "dataDirectory");
  const runtimeOwnershipSocketPath = requireAbsolutePath(
    options.runtimeOwnershipSocketPath,
    "runtimeOwnershipSocketPath",
  );
  const globalCodexParentDirectory = requireAbsolutePath(
    options.globalCodexParentDirectory,
    "globalCodexParentDirectory",
  );
  const markerRoot = requireAbsolutePath(
    options.markerRoot ?? dataDirectory,
    "markerRoot",
  );
  let publicPort = requirePort(options.publicPort, "publicPort", { allowZero: true });
  const requestedControlPort = options.controlPort ?? 0;
  if (!Number.isInteger(requestedControlPort) || requestedControlPort < 0 || requestedControlPort > 65_535) {
    throw new TypeError("controlPort must be an integer from 0 to 65535.");
  }
  if (options.runtimeOwnershipLease === null || typeof options.runtimeOwnershipLease !== "object") {
    throw new TypeError("runtimeOwnershipLease must be the activation-owned lease object.");
  }
  const seedFixture = normalizeE2eFixture(options.seedFixture ?? "D4");
  const webOrigin = new URL(options.webOrigin);
  if (
    webOrigin.protocol !== "http:" ||
    webOrigin.hostname !== "127.0.0.1" ||
    webOrigin.pathname !== "/" ||
    webOrigin.search || webOrigin.hash || webOrigin.username || webOrigin.password
  ) {
    throw new TypeError("webOrigin must be a bare 127.0.0.1 HTTP origin.");
  }
  const markers = installedMarkerPaths(markerRoot);
  const assertLease = dependencies.assertInheritedRuntimeOwnershipLease ??
    assertInheritedRuntimeOwnershipLease;
  const startRuntime = dependencies.startPlannerRuntime ?? startPlannerRuntime;
  const createCodexRuntime = dependencies.createCodexRuntime ??
    ((state) => createDeterministicCodexRuntime(state, {
      ...markers,
      fixedCwd: appRoot,
    }));
  const createGlobalIngress = dependencies.createGlobalCodexIngress ??
    ((planner) => createGlobalCodexIngressForTests(
      createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
      globalCodexParentDirectory,
    ));

  await Promise.all([
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(globalCodexParentDirectory, { recursive: true, mode: 0o700 }),
    mkdir(markerRoot, { recursive: true, mode: 0o700 }),
  ]);

  let runtime = null;
  let activeCodexRuntime = null;
  let controlServer = null;
  let transitionInFlight = null;
  let closed = false;
  let currentTime = Number(options.initialNow ?? E2E_PREP_NOW);
  let codexState = options.initialCodexState ?? "compatible";
  let seedId = 0;
  let authorityGeneration = 0;
  let crashRestartInProgress = false;
  let crashTerminalRollbackCount = 0;
  let lastRestartProof = null;
  let leaseValidationCount = 0;
  const failureInjector = Object.freeze({
    hit(point) {
      if (crashRestartInProgress && point === "after_chat_terminal_write") {
        crashTerminalRollbackCount += 1;
        throw new Error("Installed QA crash restart rolled back graceful terminalization.");
      }
    },
  });
  if (!Number.isFinite(currentTime)) throw new TypeError("initialNow must be finite.");
  if (!DETERMINISTIC_CODEX_STATES.includes(codexState)) {
    throw new TypeError("initialCodexState is unsupported.");
  }
  let apiOrigin = null;
  const allowedOrigins = new Set([webOrigin.origin]);

  const startAuthority = async () => {
    if (closed) throw new Error("The installed E2E controller is closed.");
    if (runtime !== null) throw new Error("The installed authority is already running.");
    await assertLease(options.runtimeOwnershipLease, {
      socketPath: runtimeOwnershipSocketPath,
    });
    leaseValidationCount += 1;
    const codexRuntime = await createCodexRuntime(codexState, {
      appRoot,
      dataDirectory,
      markerRoot,
      markers,
    });
    runtime = await startRuntime({
      config: {
        mode: "front",
        host: "127.0.0.1",
        port: publicPort,
        dataDirectory,
        databasePath: join(dataDirectory, "planner.sqlite"),
        webOrigin,
        allowedOrigins,
        codexFollowUp: { ok: false, error: "Injected installed-QA runtime." },
      },
      codexRuntime,
      codexFixedCwd: appRoot,
      clock: { now: () => currentTime },
      seedFactory: () => createE2eFixtureSeed(seedFixture, {
        now: E2E_DINNER_NOW,
        createId(prefix) {
          seedId += 1;
          return `e2e-${prefix}-${seedId}`;
        },
      }),
      globalCodexIngressFactory: createGlobalIngress,
      failureInjector,
      shutdownGracePeriodMs: 250,
    });
    activeCodexRuntime = codexRuntime;
    const address = runtime.server.address();
    if (address === null || typeof address === "string") {
      await runtime.close();
      runtime = null;
      activeCodexRuntime = null;
      throw new Error("Installed QA authority did not expose its loopback port.");
    }
    const startedOrigin = loopbackOrigin(address.port);
    if (apiOrigin !== null && startedOrigin !== apiOrigin) {
      await runtime.close();
      runtime = null;
      activeCodexRuntime = null;
      throw new Error("Installed QA authority rebound a different public port.");
    }
    publicPort = address.port;
    apiOrigin = startedOrigin;
    allowedOrigins.add(apiOrigin);
    authorityGeneration += 1;
  };

  const stopAuthority = async () => {
    const active = runtime;
    runtime = null;
    activeCodexRuntime = null;
    await active?.close();
    return active;
  };

  const replaceAuthority = async ({ reset = false, crash = false } = {}) => {
    transitionInFlight ??= (async () => {
      const generationBefore = authorityGeneration;
      const leaseValidationBefore = leaseValidationCount;
      const runningTurn = crash
        ? runtime?.store.readAllChatTurns().find((turn) => turn.status === "running") ?? null
        : null;
      if (crash && runningTurn === null) {
        throw new Error("Installed QA crash restart requires one durable running turn.");
      }
      crashTerminalRollbackCount = 0;
      crashRestartInProgress = crash;
      let closedRuntime;
      try {
        closedRuntime = await stopAuthority();
      } finally {
        crashRestartInProgress = false;
      }
      if (closedRuntime !== null && closedRuntime !== undefined) {
        if (closedRuntime.server.listening) {
          throw new Error("Installed QA authority listener remained open during restart.");
        }
        let closedStoreRejected = false;
        try {
          closedRuntime.store.readWorkspace();
        } catch {
          closedStoreRejected = true;
        }
        if (!closedStoreRejected) {
          throw new Error("Installed QA authority store remained usable during restart.");
        }
      }
      let listenerClosed = false;
      try {
        await fetch(`${apiOrigin}/api/health`, { signal: AbortSignal.timeout(500) });
      } catch {
        listenerClosed = true;
      }
      if (!listenerClosed) {
        throw new Error("Installed QA authority listener accepted traffic between generations.");
      }
      let durableRunningBeforeStartup = false;
      if (crash && runningTurn !== null) {
        if (crashTerminalRollbackCount !== 1) {
          throw new Error("Installed QA crash terminal rollback did not fire exactly once.");
        }
        const auditStore = openPlannerStore({
          filename: join(dataDirectory, "planner.sqlite"),
        });
        try {
          durableRunningBeforeStartup = auditStore.readAllChatTurns().some(
            (turn) => turn.turnId === runningTurn.turnId && turn.status === "running",
          );
        } finally {
          auditStore.close();
        }
        if (!durableRunningBeforeStartup) {
          throw new Error("Installed QA crash restart lost the durable running turn before startup.");
        }
      }
      if (reset) {
        currentTime = E2E_PREP_NOW;
        codexState = "compatible";
        seedId = 0;
        await rm(dataDirectory, { recursive: true, force: true });
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        await Promise.all(Object.values(markers).map((path) =>
          rm(path, { force: true })));
      }
      await startAuthority();
      const startupInterrupted = crash && runningTurn !== null
        ? runtime.store.readAllChatTurns().some(
            (turn) => turn.turnId === runningTurn.turnId && turn.status === "interrupted",
          )
        : false;
      if (crash && !startupInterrupted) {
        throw new Error("Installed QA startup did not interrupt the durable running turn.");
      }
      if (leaseValidationCount !== leaseValidationBefore + 1) {
        throw new Error("Installed QA restart did not revalidate the inherited lease exactly once.");
      }
      lastRestartProof = Object.freeze({
        mode: crash ? "crash" : reset ? "reset" : "graceful",
        authorityGenerationAdvanced: authorityGeneration > generationBefore,
        sameProcessLeaseRetained: true,
        listenerClosed,
        storeClosed: true,
        terminalRollbackCount: crashTerminalRollbackCount,
        durableRunningBeforeStartup,
        startupInterrupted,
      });
    })().finally(() => {
      transitionInFlight = null;
    });
    return transitionInFlight;
  };

  const sendJson = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  controlServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, {
          ready: runtime !== null,
          authorityPid: runtime === null ? null : process.pid,
          authorityGeneration,
          lastRestartProof,
          hangMarkerExists: await pathExists(markers.hangMarkerPath),
          conflictTurnStarted: await pathExists(markers.conflictStartedMarkerPath),
          conflictTurnReleased: await pathExists(markers.conflictReleaseMarkerPath),
          overlapTurnStarted: await pathExists(markers.overlapStartedMarkerPath),
          overlapTurnReleased: await pathExists(markers.overlapReleaseMarkerPath),
          researchTurnStarted: await pathExists(markers.researchStartedMarkerPath),
          researchTurnReleased: await pathExists(markers.researchReleaseMarkerPath),
          currentTime,
          codexState,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/clock") {
        const nextTime = Number(url.searchParams.get("now"));
        if (!Number.isFinite(nextTime)) {
          sendJson(response, 400, { error: "A finite now timestamp is required." });
          return;
        }
        currentTime = nextTime;
        sendJson(response, 200, { currentTime });
        return;
      }
      if (request.method === "POST" && url.pathname === "/codex-state") {
        const nextState = url.searchParams.get("state");
        if (!DETERMINISTIC_CODEX_STATES.includes(nextState)) {
          sendJson(response, 400, { error: "A supported Codex state is required." });
          return;
        }
        codexState = nextState;
        activeCodexRuntime?.setState?.(nextState);
        sendJson(response, 200, { codexState });
        return;
      }
      const releaseMarker = async (path, body) => {
        await writeFile(path, `${Date.now()}\n`, { encoding: "utf8" });
        sendJson(response, 200, body);
      };
      if (request.method === "POST" && url.pathname === "/release-conflict") {
        await releaseMarker(markers.conflictReleaseMarkerPath, { released: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/release-overlap") {
        await releaseMarker(markers.overlapReleaseMarkerPath, { released: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/release-research") {
        await releaseMarker(markers.researchReleaseMarkerPath, { released: true });
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/restart" || url.pathname === "/reset")
      ) {
        await replaceAuthority({
          reset: url.pathname === "/reset",
          crash: url.pathname === "/restart",
        });
        sendJson(
          response,
          200,
          url.pathname === "/reset" ? { reset: true } : { restarted: true },
        );
        return;
      }
      response.writeHead(404).end();
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  try {
    await startAuthority();
    await listen(controlServer, requestedControlPort);
  } catch (error) {
    await stopAuthority().catch(() => undefined);
    await closeServer(controlServer).catch(() => undefined);
    throw error;
  }
  const address = controlServer.address();
  if (address === null || typeof address === "string") {
    await stopAuthority();
    await closeServer(controlServer);
    throw new Error("The installed QA control listener did not expose a loopback port.");
  }
  const controlOrigin = loopbackOrigin(address.port);

  return Object.freeze({
    apiOrigin,
    controlOrigin,
    globalCodexSocketPath: join(globalCodexParentDirectory, "run", "global-codex.sock"),
    async restart() {
      await replaceAuthority();
    },
    async reset() {
      await replaceAuthority({ reset: true });
    },
    async close() {
      if (closed) return;
      closed = true;
      await transitionInFlight;
      let closeError;
      try {
        await closeServer(controlServer);
      } catch (error) {
        closeError = error;
      }
      try {
        await stopAuthority();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) throw closeError;
    },
  });
}

function runtimeConfig() {
  const mode = process.env.PLANNER_E2E_RUNTIME_MODE === "front" ? "front" : "api";
  const browserOrigin = `http://127.0.0.1:${apiPort}`;
  return {
    mode,
    host: "127.0.0.1",
    port: apiPort,
    dataDirectory,
    databasePath: resolve(dataDirectory, "planner.sqlite"),
    webOrigin,
    allowedOrigins: new Set([
      webOrigin.origin,
      `http://localhost:${webOrigin.port}`,
      ...(mode === "front"
        ? [browserOrigin, `http://localhost:${apiPort}`]
        : []),
    ]),
  };
}

async function runAuthorityChild() {
  let currentTime = Number(process.env.PLANNER_E2E_NOW ?? E2E_PREP_NOW);
  if (!Number.isFinite(currentTime)) {
    throw new Error("PLANNER_E2E_NOW must be an epoch timestamp.");
  }
  let seedId = 0;
  const codexRuntime = createDeterministicCodexRuntime(
    process.env.PLANNER_E2E_CODEX_STATE ?? "compatible",
  );
  process.on("message", (message) => {
    if (message?.type === "set-clock" && Number.isFinite(message.now)) {
      currentTime = message.now;
      process.send?.({ type: "clock-set", requestId: message.requestId, now: currentTime });
      return;
    }
    if (message?.type === "set-codex-state" &&
        DETERMINISTIC_CODEX_STATES.includes(message.state)) {
      codexRuntime.setState(message.state);
      process.send?.({
        type: "codex-state-set",
        requestId: message.requestId,
        state: message.state,
      });
    }
  });
  const runtime = await startPlannerRuntime({
    config: runtimeConfig(),
    codexRuntime,
    codexFixedCwd: process.cwd(),
    // The harness owns one authority child at a time and deliberately exercises restart recovery.
    recoverCodexAdmissionsAfterOwnership: true,
    clock: { now: () => currentTime },
    seedFactory: () => createE2eFixtureSeed(configuredFixture, {
      now: E2E_DINNER_NOW,
      createId(prefix) {
        seedId += 1;
        return `e2e-${prefix}-${seedId}`;
      },
    }),
    shutdownGracePeriodMs: 250,
  });
  console.log(`Deterministic planner authority listening on 127.0.0.1:${apiPort}.`);
  process.send?.({ type: "ready", pid: process.pid });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.close();
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void stop());
  }
  process.on("disconnect", () => void stop());
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function runControlProcess() {
  await rm(dataDirectory, { recursive: true, force: true });

  let authorityChild = null;
  let expectedAuthorityExit = null;
  let authorityReady = false;
  let restartInFlight = null;
  let stopping = false;
  let currentTime = E2E_PREP_NOW;
  let clockRequestId = 0;
  let codexState = "compatible";
  let codexRequestId = 0;
  let controlServer = null;

  const startAuthorityChild = async () => {
    const child = spawn(process.execPath, [...process.execArgv, modulePath], {
      env: {
        ...process.env,
        PLANNER_E2E_CHILD_MODE: "authority",
        PLANNER_E2E_NOW: String(currentTime),
        PLANNER_E2E_CODEX_STATE: codexState,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    authorityChild = child;
    authorityReady = false;
    child.on("exit", (code, signal) => {
      if (authorityChild !== child) return;
      const expectedExit = stopping || expectedAuthorityExit === child;
      if (expectedAuthorityExit === child) expectedAuthorityExit = null;
      authorityChild = null;
      authorityReady = false;
      if (!expectedExit) {
        console.error(`Deterministic planner authority exited unexpectedly (${signal ?? code}).`);
        void stop(1);
      }
    });

    await new Promise((resolveReady, rejectReady) => {
      const onMessage = (message) => {
        if (message?.type !== "ready") return;
        cleanup();
        authorityReady = true;
        resolveReady();
      };
      const onExit = (code, signal) => {
        cleanup();
        rejectReady(new Error(
          `Planner authority exited before ready (${signal ?? code}).`,
        ));
      };
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  };

  const stopAuthorityChild = async ({ crash = false } = {}) => {
    const child = authorityChild;
    authorityReady = false;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    expectedAuthorityExit = child;
    await new Promise((resolveExit) => {
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        resolveExit();
      });
      child.kill(crash ? "SIGKILL" : "SIGTERM");
    });
  };

  const setAuthorityClock = async (nextTime) => {
    const child = authorityChild;
    if (!authorityReady || !child?.connected) {
      throw new Error("Planner authority is not ready for a clock update.");
    }
    const requestId = ++clockRequestId;
    await new Promise((resolveClock, rejectClock) => {
      const timeout = setTimeout(() => {
        cleanup();
        rejectClock(new Error("Planner authority clock update timed out."));
      }, 2_000);
      const onMessage = (message) => {
        if (message?.type !== "clock-set" || message.requestId !== requestId) return;
        cleanup();
        resolveClock();
      };
      const onExit = () => {
        cleanup();
        rejectClock(new Error("Planner authority exited during a clock update."));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ type: "set-clock", requestId, now: nextTime });
    });
    currentTime = nextTime;
  };

  const setAuthorityCodexState = async (nextState) => {
    const child = authorityChild;
    if (!authorityReady || !child?.connected) {
      throw new Error("Planner authority is not ready for a Codex state update.");
    }
    if (!DETERMINISTIC_CODEX_STATES.includes(nextState)) {
      throw new TypeError("A supported deterministic Codex state is required.");
    }
    const requestId = ++codexRequestId;
    await new Promise((resolveState, rejectState) => {
      const timeout = setTimeout(() => {
        cleanup();
        rejectState(new Error("Planner authority Codex state update timed out."));
      }, 2_000);
      const onMessage = (message) => {
        if (message?.type !== "codex-state-set" || message.requestId !== requestId) return;
        cleanup();
        resolveState();
      };
      const onExit = () => {
        cleanup();
        rejectState(new Error("Planner authority exited during a Codex state update."));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ type: "set-codex-state", requestId, state: nextState });
    });
    codexState = nextState;
  };

  const stop = async (requestedExitCode = 0) => {
    if (stopping) return;
    stopping = true;
    let exitCode = requestedExitCode;
    try {
      await closeServer(controlServer);
      await stopAuthorityChild();
      await rm(dataDirectory, { recursive: true, force: true });
    } catch (error) {
      exitCode = 1;
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(exitCode);
  };

  await startAuthorityChild();

  controlServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ready: authorityReady,
          authorityPid: authorityReady ? authorityChild?.pid ?? null : null,
          hangMarkerExists: await pathExists(hangMarkerPath),
          conflictTurnStarted: await pathExists(conflictStartedMarkerPath),
          conflictTurnReleased: await pathExists(conflictReleaseMarkerPath),
          overlapTurnStarted: await pathExists(overlapStartedMarkerPath),
          overlapTurnReleased: await pathExists(overlapReleaseMarkerPath),
          researchTurnStarted: await pathExists(researchStartedMarkerPath),
          researchTurnReleased: await pathExists(researchReleaseMarkerPath),
          currentTime,
          codexState,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/clock") {
        const nextTime = Number(url.searchParams.get("now"));
        if (!Number.isFinite(nextTime)) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "A finite now timestamp is required." }));
          return;
        }
        await setAuthorityClock(nextTime);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ currentTime }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/codex-state") {
        const nextState = url.searchParams.get("state");
        if (!DETERMINISTIC_CODEX_STATES.includes(nextState)) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "A supported Codex state is required." }));
          return;
        }
        await setAuthorityCodexState(nextState);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ codexState }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/release-conflict") {
        await writeFile(conflictReleaseMarkerPath, `${Date.now()}\n`, { encoding: "utf8" });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ released: true }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/release-overlap") {
        await writeFile(overlapReleaseMarkerPath, `${Date.now()}\n`, { encoding: "utf8" });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ released: true }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/release-research") {
        await writeFile(researchReleaseMarkerPath, `${Date.now()}\n`, { encoding: "utf8" });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ released: true }));
        return;
      }
      if (
        request.method !== "POST" ||
        (url.pathname !== "/restart" && url.pathname !== "/reset")
      ) {
        response.writeHead(404).end();
        return;
      }
      try {
        const reset = url.pathname === "/reset";
        restartInFlight ??= (async () => {
          await stopAuthorityChild({ crash: !reset });
          if (reset) {
            currentTime = E2E_PREP_NOW;
            codexState = "compatible";
            await rm(dataDirectory, { recursive: true, force: true });
          }
          await startAuthorityChild();
        })().finally(() => {
          restartInFlight = null;
        });
        await restartInFlight;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(reset ? { reset: true } : { restarted: true }));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })().catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      if (!response.writableEnded) {
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  });

  try {
    await listen(controlServer, controlPort);
  } catch (error) {
    stopping = true;
    await stopAuthorityChild();
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void stop());
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === modulePath;

if (isEntrypoint) {
  if (process.env.PLANNER_E2E_CHILD_MODE === "authority") {
    await runAuthorityChild();
  } else {
    await runControlProcess();
  }
}
