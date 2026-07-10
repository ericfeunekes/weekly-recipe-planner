import { spawn } from "node:child_process";

export async function superviseProcesses(
  specifications,
  { spawnImpl = spawn, signals = ["SIGINT", "SIGTERM"] } = {},
) {
  if (!Array.isArray(specifications) || specifications.length === 0) {
    throw new TypeError("At least one process specification is required.");
  }
  const children = specifications.map(({ command, args = [], options = {} }) =>
    spawnImpl(command, args, { stdio: "inherit", ...options }),
  );
  let stopping = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const stop = (signal = "SIGTERM", exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
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
    child.once("exit", (code, signal) => {
      if (!stopping) stop("SIGTERM", code ?? (signal ? 1 : 0));
    });
  }

  const exitCode = await exitPromise;
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", resolve);
        }),
    ),
  );
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  return exitCode;
}

