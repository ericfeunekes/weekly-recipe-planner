#!/usr/bin/env node

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

const variant = process.env.FAKE_CODEX_AUTH_VARIANT ?? "compatible";
const codexHome = process.env.CODEX_HOME;
const normalHome = process.env.HOME;
if (!codexHome || !normalHome) {
  process.stderr.write("fixture requires HOME and CODEX_HOME\n");
  process.exit(64);
}

const statePath = join(codexHome, ".fake-auth-state.json");
const logPath = join(codexHome, ".fake-auth-invocations.jsonl");
const authPath = join(codexHome, "auth.json");

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      authenticated: process.env.FAKE_CODEX_AUTH_INITIAL === "authenticated",
      loginCount: 0,
      processCount: 0,
      pendingLoginId: null,
      planType: "pro",
    };
  }
}

let state = await readState();
state.processCount += 1;
if (variant === "restart-loses-auth" && state.processCount > 1) state.authenticated = false;
await mkdir(dirname(statePath), { recursive: true });
await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
if (state.authenticated) await writeFile(authPath, "{}\n", { mode: 0o600 });

async function persist() {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  if (state.authenticated) await writeFile(authPath, "{}\n", { mode: 0o600 });
  else await rm(authPath, { force: true });
}

async function record(value) {
  await appendFile(logPath, `${JSON.stringify({
    pid: process.pid,
    processCount: state.processCount,
    home: normalHome,
    codexHome,
    secretSentinelPresent: process.env.PLANNER_SECRET_SENTINEL !== undefined,
    ...value,
  })}\n`, { mode: 0o600 });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendCompletion(loginId) {
  if (variant === "stalled-login") return;
  if (variant === "unknown-notification") {
    send({ method: "account/updated", params: { account: null } });
    return;
  }
  if (variant === "oversized-frame") {
    process.stdout.write(`${"x".repeat(70 * 1_024)}\n`);
    return;
  }
  if (variant === "login-failed") {
    send({
      method: "account/login/completed",
      params: {
        loginId,
        success: false,
        error: "private-provider-error-DO-NOT-LEAK",
      },
    });
    return;
  }
  state.authenticated = true;
  state.pendingLoginId = null;
  void persist().then(() => send({
    method: "account/login/completed",
    params: {
      loginId: variant === "mismatched-login-id" ? `${loginId}-wrong` : loginId,
      success: true,
      error: null,
    },
  }));
}

async function handleRequest(message) {
  const { id, method, params } = message;
  await record({ direction: "request", id, method, params });
  if (method === "initialize") {
    send({
      id,
      result: {
        codexHome: variant === "wrong-codex-home" ? join(codexHome, "wrong") : codexHome,
        platformFamily: "unix",
        platformOs: process.platform,
        userAgent: "fake-codex-auth/1",
      },
    });
    if (
      variant === "remote-control-status" &&
      !params?.capabilities?.optOutNotificationMethods?.includes(
        "remoteControl/status/changed",
      )
    ) {
      send({
        method: "remoteControl/status/changed",
        params: {
          installationId: "fixture-installation",
          serverName: "fixture-server",
          status: "disabled",
        },
      });
    }
    return;
  }
  if (method === "account/read") {
    if (variant === "refresh-failure" && params?.refreshToken === true) {
      send({ id, error: { code: -32000, message: "private-refresh-error-DO-NOT-LEAK" } });
      return;
    }
    if (variant === "malformed-account") {
      send({ id, result: { account: "bad", requiresOpenaiAuth: true } });
      return;
    }
    const account = state.authenticated
      ? variant === "api-key-account"
        ? { type: "apiKey" }
        : {
            type: "chatgpt",
            email: "private-person@example.test",
            planType: state.planType,
          }
      : null;
    send({ id, result: { account, requiresOpenaiAuth: true } });
    return;
  }
  if (method === "account/logout") {
    if (variant !== "sticky-logout") state.authenticated = false;
    state.pendingLoginId = null;
    await persist();
    send({ id, result: {} });
    return;
  }
  if (method === "account/login/start") {
    state.loginCount += 1;
    const loginId = `login-${state.loginCount}`;
    state.pendingLoginId = loginId;
    await persist();
    send({
      id,
      result: {
        type: "chatgptDeviceCode",
        loginId,
        verificationUrl: "https://device.example.test/verify/private-path",
        userCode: `PRIVATE-CODE-${state.loginCount}`,
      },
    });
    if (variant === "server-request") {
      send({ id: `server-${state.loginCount}`, method: "hostile/request", params: {} });
      return;
    }
    setTimeout(() => sendCompletion(loginId), 5).unref?.();
    return;
  }
  if (method === "account/login/cancel") {
    const matched = params?.loginId === state.pendingLoginId;
    if (matched) state.pendingLoginId = null;
    await persist();
    send({ id, result: { status: matched ? "canceled" : "notFound" } });
    return;
  }
  send({ id, error: { code: -32601, message: "unsupported fixture request" } });
}

async function handleNotification(message) {
  await record({ direction: "notification", method: message.method, params: message.params });
  if (message.method !== "initialized") {
    process.stderr.write("unsupported fixture notification\n");
    process.exitCode = 65;
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("invalid fixture JSONL\n");
    process.exitCode = 65;
    break;
  }
  if (Object.hasOwn(message, "id") && typeof message.method === "string") {
    await handleRequest(message);
  } else if (!Object.hasOwn(message, "id") && typeof message.method === "string") {
    await handleNotification(message);
  } else if (Object.hasOwn(message, "id") && message.error) {
    await record({ direction: "server-request-rejection", id: message.id, error: message.error });
  }
}
