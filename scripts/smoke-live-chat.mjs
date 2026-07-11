import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServerClient } from "../bridge/app-server-client.mjs";
import { createCodexPlannerAdapter } from "../server/chat/index.ts";
import { startPlannerRuntime } from "../server/runtime/planner-runtime.ts";

const origin = "http://localhost:3001";
const dataDirectory = await mkdtemp(join(tmpdir(), "weekly-planner-live-chat-"));
const rpc = new CodexAppServerClient({ cwd: process.cwd() });
const codexAdapter = createCodexPlannerAdapter({ rpc, cwd: process.cwd() });
let runtime;

try {
  runtime = await startPlannerRuntime({
    config: {
      mode: "api",
      host: "127.0.0.1",
      port: 0,
      dataDirectory,
      databasePath: join(dataDirectory, "planner.sqlite"),
      webOrigin: new URL("http://127.0.0.1:3001"),
      allowedOrigins: new Set([origin]),
    },
    codexAdapter,
    closeCodex: () => rpc.close(),
    webProbe: async () => true,
  });
  const address = runtime.server.address();
  if (!address || typeof address === "string") {
    throw new Error("The disposable planner server did not expose a TCP address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ requestId: randomUUID(), mode: "seed" }),
  });
  if (!bootstrap.ok) {
    throw new Error(`Disposable bootstrap failed with HTTP ${bootstrap.status}.`);
  }
  const seeded = await bootstrap.json();
  const week = seeded.workspace.state.weeks[0];
  const meal = week?.data.meals[0];
  const step = meal?.instructions[0];
  if (!week || !meal || !step) {
    throw new Error("The disposable planner seed has no chat context.");
  }

  const response = await fetch(`${baseUrl}/api/chat/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      requestId: randomUUID(),
      basePlannerVersion: seeded.workspace.plannerVersion,
      message: "Mark this exact instruction step complete in the shared planner.",
      context: {
        view: "tonight",
        weekId: week.id,
        mealId: meal.id,
        stepId: step.id,
      },
    }),
  });
  const result = await response.json();
  if (!response.ok || result.decision?.status !== "accepted") {
    const decision = result.decision?.status ?? result.error?.code ?? "unknown";
    throw new Error(`Live ChatGPT smoke failed with HTTP ${response.status} (${decision}).`);
  }
  const turn = result.decision.turn;
  if (turn.status !== "completed" || turn.mutationOutcome !== "applied") {
    const detail = [turn.errorCode, turn.errorDetail].filter(Boolean).join(": ");
    throw new Error(
      `Live ChatGPT smoke ended ${turn.status}/${turn.mutationOutcome ?? "none"}${detail ? ` (${detail})` : ""}.`,
    );
  }

  const secondClient = await fetch(`${baseUrl}/api/workspace`);
  if (!secondClient.ok) {
    throw new Error(`Second-client workspace read failed with HTTP ${secondClient.status}.`);
  }
  const workspace = await secondClient.json();
  const persistedStep = workspace.state.weeks[0]?.data.meals[0]?.instructions[0];
  const persistedTurn = workspace.chatTurns.find((candidate) => candidate.turnId === turn.turnId);
  const transcript = workspace.transcriptEntries.filter((entry) => entry.turnId === turn.turnId);
  const event = workspace.events.find((candidate) => candidate.chatTurnId === turn.turnId);
  if (!persistedStep?.complete) {
    throw new Error("The Codex command was not visible in second-client planner readback.");
  }
  if (persistedTurn?.status !== "completed" || persistedTurn.mutationOutcome !== "applied") {
    throw new Error("The completed Codex turn was not durable in second-client readback.");
  }
  if (!transcript.some((entry) => entry.role === "user") || !transcript.some((entry) => entry.role === "assistant")) {
    throw new Error("The shared user and assistant transcript entries were not durable.");
  }
  if (event?.actor !== "Codex" || event.command?.type !== "setInstructionStepComplete") {
    throw new Error("The live planner event did not retain Codex actor provenance.");
  }
  console.log("Live ChatGPT smoke passed: authenticated Codex mutation, transcript, event, and second-client readback are durable.");
} finally {
  if (runtime) await runtime.close();
  else rpc.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
