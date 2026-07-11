import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { startPlannerRuntime } from "../../server/runtime/planner-runtime.ts";

function taggedJson(prompt, tag) {
  const match = prompt.match(new RegExp(`<${tag}>\\n(.*)\\n</${tag}>`));
  if (!match) throw new Error(`Deterministic Codex fixture is missing ${tag}.`);
  return JSON.parse(match[1]);
}

const dataDirectory = resolve(
  process.env.PLANNER_E2E_DATA_DIR ?? ".planner-e2e-data",
);
const apiPort = Number(process.env.PLANNER_E2E_API_PORT ?? 8877);
const webOrigin = new URL(
  process.env.PLANNER_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3101",
);
await rm(dataDirectory, { recursive: true, force: true });

const codexAdapter = {
  async readStatus() {
    return { available: true, authenticated: true, detail: "deterministic fixture" };
  },
  async complete({ prompt, signal }) {
    await new Promise((resolveDelay, rejectDelay) => {
      const onAbort = () => {
        clearTimeout(timer);
        rejectDelay(Object.assign(new Error("Fixture turn interrupted."), {
          code: "CODEX_ABORTED",
        }));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolveDelay();
      }, 250);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const context = taggedJson(prompt, "canonical_planner_context");
    const request = taggedJson(prompt, "foreground_user_request");
    const completeStep =
      typeof request === "string" &&
      /complete|check off|done/i.test(request) &&
      typeof context.selectedStepId === "string";
    return {
      reply: completeStep
        ? "I marked that shared recipe step complete."
        : "I can see the shared household plan.",
      command: completeStep
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

const runtime = await startPlannerRuntime({
  config: {
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
  },
  codexAdapter,
});
console.log(`Deterministic planner authority listening on 127.0.0.1:${apiPort}.`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  });
}
