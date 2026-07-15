import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { superviseProcesses } from "./process-supervisor.mjs";
import { createInstalledProcessSpecifications } from "./runtime-processes.mjs";
import {
  assertInstalledReleaseStartable,
  assertPrivateDirectory,
  assertRealCanonicalPath,
  ensurePrivateDirectory,
} from "./support/planner-release-contract.mjs";

const DEFAULT_DEPENDENCIES = Object.freeze({
  assertInstalledReleaseStartable,
  assertPrivateDirectory,
  assertRealCanonicalPath,
  ensurePrivateDirectory,
  realpath,
  superviseProcesses,
});

const OPERATOR_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "PLANNER_HOST",
  "PLANNER_PORT",
  "PLANNER_ALLOWED_ORIGINS",
]);

export function sanitizeInstalledOperatorEnvironment(environment, home) {
  const sanitized = { HOME: home };
  for (const key of OPERATOR_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && key !== "HOME") sanitized[key] = value;
  }
  return sanitized;
}

function runBoundOperator(entrypoint, environment) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd: dirname(dirname(entrypoint)),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectExit);
    child.once("close", (code) => {
      resolveExit(typeof code === "number" ? code : 1);
    });
  });
}

/**
 * Resolve and verify the selected installed pair before constructing either
 * child. The authority child still acquires and retains the writer lease; an
 * environment flag can select its socket path but can never inherit a lease.
 */
export async function prepareInstalledRuntimeLaunch(
  environment = process.env,
  dependencies = {},
) {
  const ports = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const home = environment.HOME ?? homedir();
  const startable = await ports.assertInstalledReleaseStartable(home);
  const { layout } = startable;
  await Promise.all([
    ports.assertRealCanonicalPath(layout.appRoot, "directory"),
    ports.assertPrivateDirectory(layout.agentRoot, {
      label: "Installed planner agent root",
    }),
    ports.assertRealCanonicalPath(layout.dataRoot, "directory"),
    ports.assertPrivateDirectory(layout.runRoot, {
      label: "Installed planner run root",
    }),
  ]);
  const logDirectory = join(layout.runRoot, "logs");
  await ports.ensurePrivateDirectory(logDirectory, {
    label: "Installed planner log root",
  });

  const specifications = createInstalledProcessSpecifications(
    {
      appDirectory: layout.appRoot,
      agentDirectory: layout.agentRoot,
      dataDirectory: layout.dataRoot,
      runDirectory: layout.runRoot,
      activationId: startable.current.activationId,
      operatorSha256: startable.current.operatorSha256,
      activationSha256: startable.current.activationSha256,
    },
    environment,
  );
  return Object.freeze({
    ...startable,
    logDirectory,
    specifications,
  });
}

export async function startInstalledRuntime(
  environment = process.env,
  dependencies = {},
) {
  const ports = {
    ...DEFAULT_DEPENDENCIES,
    runBoundOperator,
    ...dependencies,
  };
  const home = environment.HOME ?? homedir();
  const startable = await ports.assertInstalledReleaseStartable(home);
  const operatorEntrypoint = join(
    startable.operatorPath,
    "scripts",
    "start-installed.mjs",
  );
  await ports.assertRealCanonicalPath(operatorEntrypoint, "file");
  const currentEntrypoint = await ports.realpath(fileURLToPath(import.meta.url));
  if (currentEntrypoint !== operatorEntrypoint) {
    return ports.runBoundOperator(
      operatorEntrypoint,
      sanitizeInstalledOperatorEnvironment(environment, home),
    );
  }

  const launch = await prepareInstalledRuntimeLaunch(environment, {
    ...ports,
    assertInstalledReleaseStartable: async () => startable,
  });
  return ports.superviseProcesses(launch.specifications);
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    process.exitCode = await startInstalledRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = Number.isSafeInteger(error?.exitCode)
      ? error.exitCode
      : 1;
  }
}
