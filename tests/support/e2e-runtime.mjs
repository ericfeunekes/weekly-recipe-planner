import { spawn } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createCanonicalSeed } from "../../lib/household-bootstrap.ts";
import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";

const E2E_PREP_NOW = Date.parse("2026-07-05T12:00:00-03:00");
const E2E_DINNER_NOW = Date.parse("2026-07-07T18:00:00-03:00");

function taggedJson(prompt, tag) {
  const match = prompt.match(new RegExp(`<${tag}>\\n(.*)\\n</${tag}>`));
  if (!match) throw new Error(`Deterministic Codex fixture is missing ${tag}.`);
  return JSON.parse(match[1]);
}

function addIsoDays(value, days) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixtureInterruptedError() {
  return Object.assign(new Error("Fixture turn interrupted."), {
    code: "CODEX_ABORTED",
  });
}

function waitForDelay(signal, delayMs) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(fixtureInterruptedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(fixtureInterruptedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitUntilAborted(signal) {
  return new Promise((_, rejectWait) => {
    if (signal.aborted) {
      rejectWait(fixtureInterruptedError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => rejectWait(fixtureInterruptedError()),
      { once: true },
    );
  });
}

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
const modulePath = fileURLToPath(import.meta.url);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path, signal, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for deterministic fixture marker ${path}.`);
    }
    await waitForDelay(signal, 25);
  }
}

function createDeterministicCodexAdapter() {
  return {
    async readStatus() {
      return { available: true, authenticated: true, detail: "deterministic fixture" };
    },
    async complete({ prompt, signal }) {
      const context = taggedJson(prompt, "canonical_planner_context");
      const request = taggedJson(prompt, "foreground_user_request");
      const waitThroughRestart =
        typeof request === "string" && /wait through restart/i.test(request);
      const recoveringInterruptedRequest = waitThroughRestart && await pathExists(hangMarkerPath);
      const tonightContextRequest =
        typeof request === "string" && /tonight context/i.test(request);
      const conflictRequest =
        typeof request === "string" && /propose conflicting meal change/i.test(request);
      const heldConflictRequest =
        request === "Propose conflicting meal change after a pause.";
      const heldOverlapRequest =
        request === "Propose conflicting meal change during retry isolation.";
      const selectedMeal = context.selectedWeek?.data?.meals?.find(
        (meal) => meal.id === context.selectedMealId,
      );
      const selectedLeftover = context.selectedWeek?.data?.leftovers?.find(
        (leftover) => leftover.id === context.selectedLeftoverId,
      );

      if (waitThroughRestart && !recoveringInterruptedRequest) {
        await writeFile(hangMarkerPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
        await waitUntilAborted(signal);
      }

      if (heldConflictRequest) {
        await writeFile(conflictStartedMarkerPath, `${process.pid}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await waitForPath(conflictReleaseMarkerPath, signal);
      }

      if (heldOverlapRequest) {
        await writeFile(overlapStartedMarkerPath, `${process.pid}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await waitForPath(overlapReleaseMarkerPath, signal);
      }

      await waitForDelay(
        signal,
        conflictRequest && !heldConflictRequest && !heldOverlapRequest ? 1_000 : 250,
      );
      const completeStep =
        typeof request === "string" &&
        /complete|check off|done/i.test(request) &&
        typeof context.selectedStepId === "string";
      const createNextWeek =
        typeof request === "string" &&
        /create next week/i.test(request) &&
        typeof context.selectedWeek?.id === "string";
      const selectedMealId = selectedMeal?.id;
      return {
        reply: recoveringInterruptedRequest
          ? "I recovered the interrupted household request."
          : tonightContextRequest && typeof selectedLeftover?.label === "string"
            ? `Tonight is ${selectedLeftover.label} leftovers.`
          : tonightContextRequest && typeof selectedMeal?.title === "string"
            ? `Tonight is ${selectedMeal.title}.`
            : conflictRequest && typeof selectedMealId === "string"
              ? "I proposed the requested meal change."
          : createNextWeek
            ? "I created a planned week for the next Monday."
            : completeStep
              ? "I marked that shared recipe step complete."
              : "I can see the shared household plan.",
        command: conflictRequest && typeof selectedMealId === "string"
          ? {
              type: "updateMealStatus",
              weekId: context.selectedWeek.id,
              mealId: selectedMealId,
              status: "cooking",
            }
          : createNextWeek
          ? {
              type: "createWeekPlan",
              weekStartDate: addIsoDays(context.selectedWeek.id, 7),
              plan: { meals: [], groceries: [], weekLesson: "" },
            }
          : completeStep
            ? {
                type: "setInstructionStepComplete",
                weekId: context.selectedWeek.id,
                stepId: context.selectedStepId,
                complete: true,
              }
            : null,
      };
    },
  };
}

function runtimeConfig() {
  return {
    mode: "api",
    host: "127.0.0.1",
    port: apiPort,
    dataDirectory,
    databasePath: resolve(dataDirectory, "planner.sqlite"),
    webOrigin,
    allowedOrigins: new Set([
      webOrigin.origin,
      `http://localhost:${webOrigin.port}`,
    ]),
  };
}

async function runAuthorityChild() {
  let currentTime = Number(process.env.PLANNER_E2E_NOW ?? E2E_PREP_NOW);
  if (!Number.isFinite(currentTime)) {
    throw new Error("PLANNER_E2E_NOW must be an epoch timestamp.");
  }
  let seedId = 0;
  process.on("message", (message) => {
    if (message?.type !== "set-clock" || !Number.isFinite(message.now)) return;
    currentTime = message.now;
    process.send?.({ type: "clock-set", requestId: message.requestId, now: currentTime });
  });
  const runtime = await startPlannerRuntime({
    config: runtimeConfig(),
    codexAdapter: createDeterministicCodexAdapter(),
    clock: { now: () => currentTime },
    seedFactory: () => createCanonicalSeed({
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
  let controlServer = null;

  const startAuthorityChild = async () => {
    const child = spawn(process.execPath, [...process.execArgv, modulePath], {
      env: {
        ...process.env,
        PLANNER_E2E_CHILD_MODE: "authority",
        PLANNER_E2E_NOW: String(currentTime),
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
          currentTime,
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
      if (request.method !== "POST" || url.pathname !== "/restart") {
        response.writeHead(404).end();
        return;
      }
      try {
        restartInFlight ??= (async () => {
          await stopAuthorityChild({ crash: true });
          await startAuthorityChild();
        })().finally(() => {
          restartInFlight = null;
        });
        await restartInFlight;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ restarted: true }));
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

if (process.env.PLANNER_E2E_CHILD_MODE === "authority") {
  await runAuthorityChild();
} else {
  await runControlProcess();
}
