#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const bakedExecutableIdentity = "A";
const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
const normalHome = process.env.HOME;

if (!codexHome || !normalHome) {
  process.stderr.write("fixture requires HOME and CODEX_HOME\n");
  process.exit(64);
}

const statePath = join(codexHome, ".fake-auth-executable-state.json");
const logPath = join(codexHome, ".fake-auth-executable-invocations.jsonl");

async function record(value) {
  await appendFile(logPath, `${JSON.stringify({
    bakedExecutableIdentity,
    pid: process.pid,
    ...value,
  })}\n`, { mode: 0o600 });
}

if (args.length === 1 && args[0] === "--version") {
  await record({ direction: "version", args });
  process.stdout.write(`fake-auth-codex ${bakedExecutableIdentity}\n`);
  process.exit(0);
}

if (args[0] !== "app-server" || args[1] !== "--listen" || args[2] !== "stdio://") {
  process.stderr.write(`unsupported fake Codex args: ${JSON.stringify(args)}\n`);
  process.exit(64);
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      authenticated: false,
      loginCount: 0,
      processCount: 0,
      pendingLoginId: null,
      planType: "pro",
    };
  }
}

let state = await readState();
state.processCount += 1;
await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
await record({
  direction: "app-server-start",
  args,
  processCount: state.processCount,
  executablePath: process.argv[1],
  home: normalHome,
  codexHome,
});

async function persist() {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendCompletion(loginId) {
  state.authenticated = true;
  state.pendingLoginId = null;
  void persist().then(() => send({
    method: "account/login/completed",
    params: { loginId, success: true, error: null },
  }));
}

async function handleRequest(message) {
  const { id, method, params } = message;
  await record({ direction: "request", id, method, params });
  if (method === "initialize") {
    send({
      id,
      result: {
        codexHome,
        platformFamily: "unix",
        platformOs: process.platform,
        userAgent: `fake-auth-codex/${bakedExecutableIdentity}`,
      },
    });
    return;
  }
  if (method === "account/read") {
    send({
      id,
      result: {
        account: state.authenticated
          ? { type: "chatgpt", email: "private@example.test", planType: state.planType }
          : null,
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (method === "account/logout") {
    state.authenticated = false;
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
        verificationUrl: "https://device.example.test/private",
        userCode: `PRIVATE-CODE-${state.loginCount}`,
      },
    });
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
    await record({ direction: "server-request-rejection", id: message.id });
  }
}
