import { join } from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const DEVELOPMENT_API_PORT = 8788;
const DEVELOPMENT_WEB_PORT = 3001;
const PRODUCTION_PUBLIC_PORT = 3000;
const PRODUCTION_WEB_PORT = 3002;
const VINEXT_CLI = "node_modules/vinext/dist/cli.js";

function origin(host, port) {
  return `http://${host}:${port}`;
}

function configuredPort(value, fallback, name) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

function processOptions(environment, workingDirectory) {
  return {
    env: environment,
    ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
  };
}

function authorityProcess(environment, overrides, workingDirectory) {
  return {
    command: process.execPath,
    args: [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "server/index.ts",
    ],
    options: processOptions(
      { ...environment, ...overrides },
      workingDirectory,
    ),
  };
}

function vinextProcess(environment, command, port, workingDirectory) {
  return {
    command: process.execPath,
    args: [
      VINEXT_CLI,
      command,
      "--hostname",
      LOOPBACK_HOST,
      "--port",
      String(port),
    ],
    options: processOptions(
      {
        ...environment,
        PLANNER_WEB_PORT: String(port),
        WRANGLER_LOG_PATH:
          environment.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
      },
      workingDirectory,
    ),
  };
}

export function createDevelopmentProcessSpecifications(
  environment = process.env,
) {
  const apiOrigin = origin(LOOPBACK_HOST, DEVELOPMENT_API_PORT);
  const webOrigin = origin(LOOPBACK_HOST, DEVELOPMENT_WEB_PORT);
  const web = vinextProcess(environment, "dev", DEVELOPMENT_WEB_PORT);
  web.options.env.PLANNER_API_ORIGIN = apiOrigin;

  return [
    authorityProcess(environment, {
      PLANNER_MODE: "api",
      PLANNER_HOST: LOOPBACK_HOST,
      PLANNER_PORT: String(DEVELOPMENT_API_PORT),
      PLANNER_WEB_ORIGIN: webOrigin,
    }),
    web,
  ];
}

export function createProductionProcessSpecifications(
  environment = process.env,
  { workingDirectory } = {},
) {
  // Portless assigns PORT to its child. Explicit planner configuration keeps
  // precedence so installed releases retain their fixed public listener.
  const publicPort = environment.PLANNER_PORT ?? environment.PORT ?? String(PRODUCTION_PUBLIC_PORT);
  const publicHost = environment.PLANNER_HOST ?? LOOPBACK_HOST;
  const privateWebPort = configuredPort(
    environment.PLANNER_PRIVATE_WEB_PORT,
    PRODUCTION_WEB_PORT,
    "PLANNER_PRIVATE_WEB_PORT",
  );
  const webOrigin = origin(LOOPBACK_HOST, privateWebPort);

  return [
    vinextProcess(
      environment,
      "start",
      privateWebPort,
      workingDirectory,
    ),
    authorityProcess(environment, {
      PLANNER_MODE: "front",
      PLANNER_HOST: publicHost,
      PLANNER_PORT: publicPort,
      PLANNER_WEB_ORIGIN: webOrigin,
    }, workingDirectory),
  ];
}

export function createInstalledProcessSpecifications(
  {
    appDirectory,
    agentDirectory,
    dataDirectory,
    runDirectory,
    activationId,
    operatorSha256,
    activationSha256,
  },
  environment = process.env,
) {
  if (
    [activationId, operatorSha256, activationSha256].some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    throw new TypeError("Installed process specifications require bound release identities.");
  }
  const installedEnvironment = {
    ...environment,
    PLANNER_CODEX_HOME: agentDirectory,
    PLANNER_CODEX_CWD: appDirectory,
    PLANNER_DATA_DIR: dataDirectory,
    PLANNER_RUNTIME_OWNER_SOCKET: join(runDirectory, "runtime-owner.sock"),
    PLANNER_INSTALLED_RUNTIME: "1",
    PLANNER_EXPECTED_ACTIVATION_ID: activationId,
    PLANNER_EXPECTED_OPERATOR_SHA256: operatorSha256,
    PLANNER_EXPECTED_ACTIVATION_SHA256: activationSha256,
    WRANGLER_LOG_PATH: join(runDirectory, "logs", "wrangler.log"),
  };
  return createProductionProcessSpecifications(installedEnvironment, {
    workingDirectory: appDirectory,
  });
}
