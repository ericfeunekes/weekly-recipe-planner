#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const pending = new Map();
let nextRequestId = 0;
let sessionKind = null;
let threadId = null;
let turnId = null;

const hangMarkerPath = process.env.PLANNER_E2E_HANG_MARKER;
const conflictStartedMarkerPath = process.env.PLANNER_E2E_CONFLICT_STARTED_MARKER;
const conflictReleaseMarkerPath = process.env.PLANNER_E2E_CONFLICT_RELEASE_MARKER;
const overlapStartedMarkerPath = process.env.PLANNER_E2E_OVERLAP_STARTED_MARKER;
const overlapReleaseMarkerPath = process.env.PLANNER_E2E_OVERLAP_RELEASE_MARKER;
const researchStartedMarkerPath = process.env.PLANNER_E2E_RESEARCH_STARTED_MARKER;
const researchReleaseMarkerPath = process.env.PLANNER_E2E_RESEARCH_RELEASE_MARKER;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function taggedJson(prompt, tag) {
  const match = prompt.match(new RegExp(`<${tag}>\\n(.*)\\n</${tag}>`));
  if (!match) throw new Error(`Deterministic app-server prompt is missing ${tag}.`);
  return JSON.parse(match[1]);
}

function addIsoDays(value, days) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function pathExists(path) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(path) {
  if (!path) throw new Error("Deterministic app-server marker path is missing.");
  await writeFile(path, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
}

async function waitForPath(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for deterministic marker ${path}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function emitTurnStarted() {
  send({ method: "thread/started", params: { thread: { id: threadId } } });
  send({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId, status: "inProgress", items: [] },
    },
  });
}

function complete(output) {
  const item = {
    id: `${turnId}-message`,
    type: "agentMessage",
    phase: "final_answer",
    text: JSON.stringify(output),
  };
  send({
    method: "item/completed",
    params: { completedAtMs: Date.now(), item, threadId, turnId },
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, status: "completed", items: [item] },
    },
  });
}

function failTurn(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  send({
    method: "error",
    params: { threadId, turnId },
  });
}

function plannerCall(tool, argumentsValue) {
  const requestId = `fixture-request-${++nextRequestId}`;
  const callId = `fixture-call-${nextRequestId}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { callId, resolve, reject });
    send({
      id: requestId,
      method: "item/tool/call",
      params: {
        arguments: argumentsValue,
        callId,
        namespace: "planner",
        threadId,
        tool,
        turnId,
      },
    });
  });
}

async function readWorkspace() {
  return plannerCall("read", { query: { kind: "workspace" } });
}

async function applyCommand(basePlannerVersion, command, readback) {
  return plannerCall("apply", {
    basePlannerVersion,
    operations: [{ command }],
    readback,
  });
}

function parseResearchCandidate(input) {
  const framed = input?.[1]?.text;
  if (typeof framed !== "string") return null;
  const newline = framed.indexOf("\n");
  if (newline < 0 || !framed.startsWith("UNTRUSTED_RESEARCH_CANDIDATE_JSON_UTF8_BYTES=")) {
    return null;
  }
  return JSON.parse(framed.slice(newline + 1));
}

async function executePlannerTurn(params) {
  const prompt = params.input?.[0]?.text;
  if (typeof prompt !== "string") throw new Error("Planner turn prompt is missing.");
  if (sessionKind === "recovery") {
    complete({ reply: "I recovered the interrupted household request." });
    return;
  }

  const context = taggedJson(prompt, "canonical_planner_context");
  const request = taggedJson(prompt, "foreground_user_request");
  const selectedMeal = context.selectedWeek?.data?.meals?.find(
    (meal) => meal.id === context.selectedMealId,
  );
  const selectedLeftover = context.selectedWeek?.data?.leftovers?.find(
    (leftover) => leftover.id === context.selectedLeftoverId,
  );
  const waitThroughRestart = typeof request === "string" && /wait through restart/i.test(request);
  if (waitThroughRestart) {
    if (!(await pathExists(hangMarkerPath))) {
      await writeMarker(hangMarkerPath);
      return;
    }
    complete({ reply: "I recovered the interrupted household request." });
    return;
  }

  const candidate = parseResearchCandidate(params.input);
  if (candidate) {
    const targetMeal = selectedMeal ?? context.selectedWeek?.data?.meals?.[0];
    if (!targetMeal) throw new Error("Sourced recipe fixture requires a selected meal.");
    const workspace = await readWorkspace();
    const replacement = {
      type: "replaceMealRecipeFromSource",
      weekId: context.selectedWeek.id,
      mealId: targetMeal.id,
      recipe: {
        title: candidate.title,
        ...(candidate.yieldText === undefined ? {} : { yieldText: candidate.yieldText }),
        source: candidate.source,
        steps: candidate.steps,
      },
    };
    const applied = await applyCommand(workspace.plannerVersion, replacement, {
      kind: "meal",
      weekId: context.selectedWeek.id,
      mealId: targetMeal.id,
    });
    if (!applied.ok) throw new Error(`Sourced recipe fixture apply failed: ${applied.error.code}.`);
    complete({ reply: "I replaced this dinner with a sourced recipe." });
    return;
  }

  const completeStep = typeof request === "string" &&
    /complete|check off|done/i.test(request) &&
    typeof context.selectedStepId === "string";
  const createNextWeek = typeof request === "string" &&
    /create next week/i.test(request) &&
    typeof context.selectedWeek?.id === "string";
  const createFirstWeek = typeof request === "string" &&
    /create (?:the )?first (?:shared )?week/i.test(request) &&
    context.selectedWeek === null;
  const conflictRequested = typeof request === "string" &&
    /propose conflicting meal change/i.test(request);
  const conflictRequest = conflictRequested && typeof selectedMeal?.id === "string";
  const heldConflictRequest = request === "Propose conflicting meal change after a pause.";
  const heldOverlapRequest = request === "Propose conflicting meal change during retry isolation.";
  const failureAfterEffect = typeof request === "string" &&
    /save one planner change then interrupt the reply/i.test(request);

  if ((heldConflictRequest || heldOverlapRequest) && !conflictRequest) {
    const startedMarker = heldConflictRequest
      ? conflictStartedMarkerPath
      : overlapStartedMarkerPath;
    const releaseMarker = heldConflictRequest
      ? conflictReleaseMarkerPath
      : overlapReleaseMarkerPath;
    await writeMarker(startedMarker);
    await waitForPath(releaseMarker);
    complete({ reply: "I can see the shared household plan." });
    return;
  }

  if (completeStep || createFirstWeek || createNextWeek || conflictRequest || failureAfterEffect) {
    const workspace = await readWorkspace();

    if (heldConflictRequest) {
      await writeMarker(conflictStartedMarkerPath);
      await waitForPath(conflictReleaseMarkerPath);
    } else if (heldOverlapRequest) {
      await writeMarker(overlapStartedMarkerPath);
      await waitForPath(overlapReleaseMarkerPath);
    }

    const command = completeStep
      ? {
          type: "setInstructionStepComplete",
          weekId: context.selectedWeek.id,
          stepId: context.selectedStepId,
          complete: true,
        }
      : createFirstWeek
        ? {
            type: "createWeekPlan",
            weekStartDate: "2026-07-06",
            plan: { meals: [], groceries: [], weekLesson: "" },
          }
        : createNextWeek
        ? {
            type: "createWeekPlan",
            weekStartDate: addIsoDays(context.selectedWeek.id, 7),
            plan: { meals: [], groceries: [], weekLesson: "" },
          }
        : failureAfterEffect
          ? {
              type: "addGroceryItem",
              weekId: context.selectedWeek.id,
              item: {
                section: "Produce",
                item: "Recovery proof parsley",
                detail: "1 bunch",
                farmBox: false,
              },
            }
          : {
              type: "updateMealStatus",
              weekId: context.selectedWeek.id,
              mealId: selectedMeal.id,
              status: "cooking",
            };
    const readback = command.type === "createWeekPlan"
      ? { kind: "workspace" }
      : { kind: "week", weekId: context.selectedWeek.id };
    const applied = await applyCommand(workspace.plannerVersion, command, readback);

    if (failureAfterEffect) {
      if (!applied.ok) throw new Error(`Recovery fixture apply failed: ${applied.error.code}.`);
      process.exit(23);
      return;
    }
    if (conflictRequest && !applied.ok && applied.error.code === "VERSION_CONFLICT") {
      complete({
        reply: "The shared plan changed first. Review it, then ask ChatGPT again. ChatGPT replied, but its planner change was not applied because the plan changed.",
      });
      return;
    }
    if (!applied.ok) throw new Error(`Deterministic planner apply failed: ${applied.error.code}.`);
    complete({
      reply: completeStep
        ? "I marked that shared recipe step complete."
        : createFirstWeek
          ? "I created the first shared week."
          : createNextWeek
          ? "I created a planned week for the next Monday."
          : "I proposed the requested meal change.",
    });
    return;
  }

  const tonightContextRequest = typeof request === "string" && /tonight context/i.test(request);
  complete({
    reply: tonightContextRequest && typeof selectedLeftover?.label === "string"
      ? `Tonight is ${selectedLeftover.label} leftovers.`
      : tonightContextRequest && typeof selectedMeal?.title === "string"
        ? `Tonight is ${selectedMeal.title}.`
        : "I can see the shared household plan.",
  });
}

async function executeResearchTurn() {
  if (Boolean(researchStartedMarkerPath) !== Boolean(researchReleaseMarkerPath)) {
    throw new Error("Deterministic research barriers must provide both marker paths.");
  }
  if (researchStartedMarkerPath) {
    await writeMarker(researchStartedMarkerPath);
    await waitForPath(researchReleaseMarkerPath);
  }
  send({
    method: "item/completed",
    params: {
      completedAtMs: Date.now(),
      item: {
        id: "e2e-research-web-search",
        type: "webSearch",
        query: "deterministic fixture query",
        action: { type: "search", query: "deterministic fixture query" },
      },
      threadId,
      turnId,
    },
  });
  complete({
    source: {
      kind: "web",
      identity: "Deterministic Test Kitchen",
      url: "https://example.com/recipes/lemon-lentil-soup",
    },
    title: "Lemon lentil soup",
    yieldText: "4 bowls",
    steps: [{
      inputs: [
        { amount: "1 cup", ingredient: "red lentils" },
        { amount: "1", ingredient: "lemon" },
      ],
      instruction: "Simmer the lentils, then finish with lemon.",
      timerDurationSeconds: 1_200,
    }],
  });
}

function handleRequest(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "weekly-planner-e2e-fixture" } });
    return;
  }
  if (message.method === "thread/start") {
    sessionKind = message.params?.config?.web_search === "live"
      ? "research"
      : message.params?.dynamicTools?.length === 0
        ? "recovery"
        : "planner";
    threadId = sessionKind === "research" ? "e2e-research-thread" : "e2e-planner-thread";
    send({
      id: message.id,
      result: {
        thread: { id: threadId },
        cwd: process.cwd(),
        approvalPolicy: "never",
        activePermissionProfile: { id: ":read-only", extends: null },
        sandbox: { type: "readOnly", networkAccess: false },
        instructionSources: [],
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    turnId = sessionKind === "research" ? "e2e-research-turn" : "e2e-planner-turn";
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    emitTurnStarted();
    setImmediate(() => {
      const work = sessionKind === "research"
        ? Promise.resolve().then(executeResearchTurn)
        : executePlannerTurn(message.params);
      void work.catch(failTurn);
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "Unsupported fixture method." } });
}

function handleResponse(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) {
    entry.reject(new Error("Planner host rejected the deterministic callback."));
    return;
  }
  try {
    const response = message.result;
    if (!response || !Array.isArray(response.contentItems) || response.contentItems.length !== 1) {
      throw new Error("Planner host returned a malformed callback response.");
    }
    const envelope = JSON.parse(response.contentItems[0].text);
    if (envelope.callId !== entry.callId || envelope.ok !== response.success) {
      throw new Error("Planner host callback identity changed.");
    }
    entry.resolve(envelope);
  } catch (error) {
    entry.reject(error);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method) {
    handleRequest(message);
    return;
  }
  handleResponse(message);
});
lines.on("close", () => process.exit(0));
