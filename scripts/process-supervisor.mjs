import { spawn } from "node:child_process";

export async function superviseProcesses(
  specifications,
  {
    spawnImpl = spawn,
    signals = ["SIGINT", "SIGTERM"],
    shutdownGracePeriodMs = 6_000,
  } = {},
) {
  if (!Array.isArray(specifications) || specifications.length === 0) {
    throw new TypeError("At least one process specification is required.");
  }
  if (
    !Number.isSafeInteger(shutdownGracePeriodMs) ||
    shutdownGracePeriodMs < 0
  ) {
    throw new TypeError(
      "Process shutdown grace period must be a non-negative integer.",
    );
  }
  const children = specifications.map(({ command, args = [], options = {} }) =>
    spawnImpl(command, args, { stdio: "inherit", ...options }),
  );
  let stopping = false;
  let forceTimer;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const completed = new WeakSet();
  const closePromises = children.map(
    (child) =>
      new Promise((resolve) => {
        child.once("close", () => {
          completed.add(child);
          resolve();
        });
      }),
  );

  const stop = (signal = "SIGTERM", exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (!completed.has(child)) child.kill(signal);
    }
    forceTimer = setTimeout(() => {
      for (const child of children) {
        if (!completed.has(child)) child.kill("SIGKILL");
      }
    }, shutdownGracePeriodMs);
    resolveExit(exitCode);
  };
  const signalHandlers = new Map();
  for (const signal of signals) {
    const handler = () => stop(signal, 0);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  for (const child of children) {
    child.once("error", () => stop("SIGTERM", 1));
    child.once("close", (code, signal) => {
      if (!stopping) stop("SIGTERM", code ?? (signal ? 1 : 0));
    });
  }

  const exitCode = await exitPromise;
  await Promise.all(closePromises);
  clearTimeout(forceTimer);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  return exitCode;
}
