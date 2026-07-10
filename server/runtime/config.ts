import { resolve } from "node:path";

export type RuntimeMode = "api" | "front";

export type PlannerRuntimeConfig = {
  mode: RuntimeMode;
  host: "127.0.0.1" | "::1";
  port: number;
  dataDirectory: string;
  databasePath: string;
  webOrigin: URL | null;
  allowedOrigins: ReadonlySet<string>;
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
  if (mode === "api") return null;
  const origin = new URL(value ?? "http://127.0.0.1:3002");
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)) {
    throw new TypeError("PLANNER_WEB_ORIGIN must be a loopback HTTP origin.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new TypeError("PLANNER_WEB_ORIGIN must contain only an origin.");
  }
  return origin;
}

function parseAllowedOrigins(value: string | undefined, mode: RuntimeMode, port: number) {
  const defaults =
    mode === "api"
      ? ["http://localhost:3001", "http://127.0.0.1:3001"]
      : [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? defaults;
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = new URL(entry);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
      origin.origin !== entry
    ) {
      throw new TypeError("PLANNER_ALLOWED_ORIGINS must contain loopback HTTP origins.");
    }
    origins.add(origin.origin);
  }
  return origins;
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
  return {
    mode,
    host,
    port,
    dataDirectory,
    databasePath: resolve(dataDirectory, "planner.sqlite"),
    webOrigin: parseWebOrigin(environment.PLANNER_WEB_ORIGIN, mode),
    allowedOrigins: parseAllowedOrigins(
      environment.PLANNER_ALLOWED_ORIGINS,
      mode,
      port,
    ),
  };
}

