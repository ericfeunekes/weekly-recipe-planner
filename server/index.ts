import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../bridge/app-server-client.mjs";
import { createCodexPlannerAdapter } from "./chat/index.ts";
import { readRuntimeConfig } from "./runtime/config.ts";
import {
  startPlannerRuntime,
  type PlannerRuntime,
} from "./runtime/planner-runtime.ts";

export async function startConfiguredPlannerRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PlannerRuntime> {
  const config = readRuntimeConfig(environment);
  const cwd = resolve(process.cwd());
  const rpc = new CodexAppServerClient({ cwd });
  const codexAdapter = createCodexPlannerAdapter({ rpc, cwd });
  return startPlannerRuntime({
    config,
    codexAdapter,
    closeCodex: () => rpc.close(),
  });
}

function publicUrl(runtime: PlannerRuntime) {
  const address = runtime.server.address();
  if (!address || typeof address === "string") return "the configured loopback socket";
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function main() {
  const runtime = await startConfiguredPlannerRuntime();
  console.log(`Weekly Recipe Planner authority listening at ${publicUrl(runtime)}.`);
  if (runtime.interruptedTurns > 0) {
    console.log(`Interrupted ${runtime.interruptedTurns} incomplete chat turn(s) from an earlier run.`);
  }

  let shuttingDown = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void runtime.close()
        .catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        })
        .finally(() => {
          for (const [registeredSignal, registeredHandler] of signalHandlers) {
            process.off(registeredSignal, registeredHandler);
          }
        });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
