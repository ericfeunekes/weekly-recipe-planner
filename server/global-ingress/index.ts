import type { RequestListener } from "node:http";

import {
  startGlobalCodexSocketServer,
  startGlobalCodexSocketServerForTests,
  type GlobalCodexSocketServer,
} from "./socket-server.ts";

export type GlobalCodexIngressStatus =
  | { status: "ready" }
  | { status: "unavailable"; reason: "Global Codex ingress could not start." };

export type GlobalCodexIngress = {
  readStatus(): GlobalCodexIngressStatus;
  close(): Promise<void>;
};

export async function createGlobalCodexIngress(
  handler: RequestListener,
): Promise<GlobalCodexIngress> {
  return createFailSoft(() => startGlobalCodexSocketServer(handler));
}

/** Internal test seam. Production composition must use createGlobalCodexIngress. */
export async function createGlobalCodexIngressForTests(
  handler: RequestListener,
  parentDirectory: string,
): Promise<GlobalCodexIngress> {
  return createFailSoft(() => startGlobalCodexSocketServerForTests(handler, parentDirectory));
}

async function createFailSoft(
  start: () => Promise<GlobalCodexSocketServer>,
): Promise<GlobalCodexIngress> {
  let server: GlobalCodexSocketServer;
  try {
    server = await start();
  } catch {
    return {
      readStatus: () => ({
        status: "unavailable",
        reason: "Global Codex ingress could not start.",
      }),
      close: async () => undefined,
    };
  }
  return {
    readStatus: () => ({ status: "ready" }),
    close: () => server.close(),
  };
}

export { createGlobalCodexPlannerPort, projectPlannerWorkspace } from "./planner-port.ts";
export { createGlobalCodexRouter } from "./router.ts";
