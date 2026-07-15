import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  parseCodexFollowUpConfig,
  type FollowUpConfigResult,
} from "./codex-follow-up/deployment.ts";

export type RuntimeMode = "api" | "front";

export type PlannerRuntimeConfig = {
  mode: RuntimeMode;
  host: "127.0.0.1" | "::1";
  port: number;
  dataDirectory: string;
  databasePath: string;
  webOrigin: URL;
  allowedOrigins: ReadonlySet<string>;
  codexFollowUp: FollowUpConfigResult;
};

function parsePort(value: string | undefined, fallback: number, name: string) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

function parseLoopbackHost(value: string | undefined) {
  const host = value ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TypeError("PLANNER_HOST must be a loopback address.");
  }
  return host;
}

function parseMode(value: string | undefined): RuntimeMode {
  if (value === undefined || value === "api") return "api";
  if (value === "front") return "front";
  throw new TypeError("PLANNER_MODE must be api or front.");
}

function parseWebOrigin(value: string | undefined, mode: RuntimeMode) {
  const defaultOrigin =
    mode === "api" ? "http://127.0.0.1:3001" : "http://127.0.0.1:3002";
  const origin = new URL(value ?? defaultOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)) {
    throw new TypeError("PLANNER_WEB_ORIGIN must be a loopback HTTP origin.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new TypeError("PLANNER_WEB_ORIGIN must contain only an origin.");
  }
  return origin;
}

function effectivePort(origin: URL) {
  return origin.port ? Number(origin.port) : 80;
}

function loopbackOrigins(port: number) {
  const suffix = port === 80 ? "" : `:${port}`;
  return [
    `http://localhost${suffix}`,
    `http://127.0.0.1${suffix}`,
    `http://[::1]${suffix}`,
  ];
}

function parseAllowedOrigins(
  value: string | undefined,
  mode: RuntimeMode,
  port: number,
  webOrigin: URL,
) {
  const defaults = loopbackOrigins(
    mode === "api" ? effectivePort(webOrigin) : port,
  );
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? defaults;
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = new URL(entry);
    const loopbackHttp =
      origin.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
    const tailnetHttps =
      origin.protocol === "https:" && origin.hostname.endsWith(".ts.net");
    if (
      (!loopbackHttp && !tailnetHttps) ||
      origin.origin !== entry
    ) {
      throw new TypeError(
        "PLANNER_ALLOWED_ORIGINS must contain loopback HTTP or exact Tailnet HTTPS origins.",
      );
    }
    origins.add(origin.origin);
  }
  return origins;
}

function assertDataDirectoryOutsideBuildOutput(dataDirectory: string) {
  for (const output of [".next", ".vinext", "dist", "out"]) {
    const outputDirectory = resolve(output);
    const pathFromOutput = relative(outputDirectory, dataDirectory);
    if (
      pathFromOutput === "" ||
      (
        pathFromOutput !== ".." &&
        !pathFromOutput.startsWith(`..${sep}`) &&
        !isAbsolute(pathFromOutput)
      )
    ) {
      throw new TypeError("PLANNER_DATA_DIR must be outside build output.");
    }
  }
}

export function readRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PlannerRuntimeConfig {
  const mode = parseMode(environment.PLANNER_MODE);
  const host = parseLoopbackHost(environment.PLANNER_HOST);
  const port = parsePort(
    environment.PLANNER_PORT,
    mode === "api" ? 8788 : 3000,
    "PLANNER_PORT",
  );
  const dataDirectory = resolve(environment.PLANNER_DATA_DIR ?? ".planner-data");
  assertDataDirectoryOutsideBuildOutput(dataDirectory);
  const webOrigin = parseWebOrigin(environment.PLANNER_WEB_ORIGIN, mode);
  if (effectivePort(webOrigin) === port) {
    throw new TypeError(
      "PLANNER_WEB_ORIGIN must not use the application listener port.",
    );
  }
  return {
    mode,
    host,
    port,
    dataDirectory,
    databasePath: resolve(dataDirectory, "planner.sqlite"),
    webOrigin,
    allowedOrigins: parseAllowedOrigins(
      environment.PLANNER_ALLOWED_ORIGINS,
      mode,
      port,
      webOrigin,
    ),
    codexFollowUp: parseCodexFollowUpConfig(environment, dataDirectory),
  };
}
