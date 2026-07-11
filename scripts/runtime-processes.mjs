const LOOPBACK_HOST = "127.0.0.1";
const DEVELOPMENT_API_PORT = 8788;
const DEVELOPMENT_WEB_PORT = 3001;
const PRODUCTION_PUBLIC_PORT = 3000;
const PRODUCTION_WEB_PORT = 3002;
const VINEXT_CLI = "node_modules/vinext/dist/cli.js";

function origin(host, port) {
  return `http://${host}:${port}`;
}

function authorityProcess(environment, overrides) {
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", "server/index.ts"],
    options: {
      env: { ...environment, ...overrides },
    },
  };
}

function vinextProcess(environment, command, port) {
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
    options: {
      env: {
        ...environment,
        PLANNER_WEB_PORT: String(port),
        WRANGLER_LOG_PATH:
          environment.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
      },
    },
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
) {
  const publicPort = environment.PLANNER_PORT ?? String(PRODUCTION_PUBLIC_PORT);
  const publicHost = environment.PLANNER_HOST ?? LOOPBACK_HOST;
  const webOrigin = origin(LOOPBACK_HOST, PRODUCTION_WEB_PORT);

  return [
    vinextProcess(environment, "start", PRODUCTION_WEB_PORT),
    authorityProcess(environment, {
      PLANNER_MODE: "front",
      PLANNER_HOST: publicHost,
      PLANNER_PORT: publicPort,
      PLANNER_WEB_ORIGIN: webOrigin,
    }),
  ];
}
