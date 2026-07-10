import assert from "node:assert/strict";
import test from "node:test";
import { CodexBridgeError } from "../bridge/app-server-client.mjs";
import {
  MEAL_PLANNER_INSTRUCTIONS,
  createBridgeServer,
  isAllowedLocalOrigin,
  startBridge,
} from "../bridge/server.mjs";

class FakeRpc {
  constructor({ account, output, error } = {}) {
    this.account = account ?? {
      type: "chatgpt",
      email: "cook@example.com",
      planType: "plus",
    };
    this.output =
      output ??
      '{"reply":"Sunday prep now starts with the rice.","command":{"type":"setPrepPlan","entries":[{"stepId":"step-rice","due":"Sun, Jul 5"},{"stepId":"step-sauce","due":"Sun, Jul 5"}]}}';
    this.error = error;
    this.threadCalls = [];
    this.turnCalls = [];
    this.unsubscribeCalls = [];
  }

  async getAccount() {
    if (this.error) throw this.error;
    return this.account;
  }

  async startThread(params) {
    this.threadCalls.push(params);
    return { thread: { id: "thread-1" } };
  }

  async runTurn(params, options) {
    this.turnCalls.push({ params, options });
    return { text: this.output, turn: { id: "turn-1", status: "completed" } };
  }

  async unsubscribeThread(threadId) {
    this.unsubscribeCalls.push(threadId);
  }
}

async function withServer(t, rpc) {
  const server = createBridgeServer({ rpc, cwd: "/planner", chatTimeoutMs: 1_234 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("health reports the current ChatGPT-backed Codex account", async (t) => {
  const baseUrl = await withServer(t, new FakeRpc());
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Origin: "http://localhost:3001" },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3001");
  assert.equal(body.ok, true);
  assert.deepEqual(body.auth, {
    authenticated: true,
    mode: "chatgpt",
    planType: "plus",
    message: "Codex is signed in with ChatGPT.",
  });
});

test("chat creates a locked-down ephemeral thread and returns one composite prep command", async (t) => {
  const rpc = new FakeRpc();
  const baseUrl = await withServer(t, rpc);
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:3001",
    },
    body: JSON.stringify({
      message: "Move the rice and sauce into Sunday prep, with the rice first.",
      state: {
        meals: [
          {
            id: "meal-thu",
            title: "Miso salmon",
            dayIndex: 3,
            instructions: [
              { id: "step-rice", instruction: "Cook the rice." },
              { id: "step-sauce", instruction: "Mix the sauce." },
            ],
          },
        ],
        prep: [],
      },
      context: { view: "prep" },
      messages: [{ role: "assistant", text: "Which steps should move to prep?" }],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.reply, "Sunday prep now starts with the rice.");
  assert.deepEqual(body.command, {
    type: "setPrepPlan",
    entries: [
      { stepId: "step-rice", due: "Sun, Jul 5" },
      { stepId: "step-sauce", due: "Sun, Jul 5" },
    ],
  });
  assert.equal(body.auth.mode, "chatgpt");

  assert.equal(rpc.threadCalls.length, 1);
  assert.deepEqual(rpc.threadCalls[0], {
    cwd: "/planner",
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    developerInstructions: MEAL_PLANNER_INSTRUCTIONS,
    model: "gpt-5.4",
    serviceName: "weekly_recipe_planner",
  });

  assert.equal(rpc.turnCalls.length, 1);
  assert.equal(rpc.turnCalls[0].params.threadId, "thread-1");
  assert.equal(rpc.turnCalls[0].params.input[0].type, "text");
  assert.equal(rpc.turnCalls[0].params.effort, "low");
  assert.match(rpc.turnCalls[0].params.input[0].text, /step-rice/);
  assert.match(rpc.turnCalls[0].params.input[0].text, /Which steps should move to prep\?/);
  assert.equal(rpc.turnCalls[0].params.outputSchema.required.includes("command"), true);
  assert.match(MEAL_PLANNER_INSTRUCTIONS, /canonical objects with stable step ids/i);
  assert.match(MEAL_PLANNER_INSTRUCTIONS, /array order is the requested prep order/i);
  assert.deepEqual(rpc.turnCalls[0].options, { timeoutMs: 1_234 });
  assert.deepEqual(rpc.unsubscribeCalls, ["thread-1"]);
});

test("chat refuses missing or non-ChatGPT authentication before starting a thread", async (t) => {
  const rpc = new FakeRpc({ account: { type: "apiKey" } });
  const baseUrl = await withServer(t, rpc);
  const health = await fetch(`${baseUrl}/health`);
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthBody.ok, false);
  assert.equal(healthBody.status, "unauthenticated");

  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What is dinner?", state: {} }),
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.match(body.error, /not with ChatGPT/);
  assert.equal(body.auth.authenticated, false);
  assert.equal(rpc.threadCalls.length, 0);
});

test("unavailable Codex and invalid request bodies return actionable errors", async (t) => {
  const unavailable = new FakeRpc({
    error: new CodexBridgeError("spawn codex ENOENT", { code: "CODEX_UNAVAILABLE" }),
  });
  const unavailableUrl = await withServer(t, unavailable);
  const health = await fetch(`${unavailableUrl}/health`);
  const healthBody = await health.json();
  assert.equal(health.status, 503);
  assert.match(healthBody.auth.message, /codex login status/);

  const rpc = new FakeRpc();
  const baseUrl = await withServer(t, rpc);
  const invalid = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "", state: {} }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /message/);
});

test("CORS permits loopback origins and rejects remote websites", async (t) => {
  assert.equal(isAllowedLocalOrigin("http://localhost:3001"), true);
  assert.equal(isAllowedLocalOrigin("http://127.0.0.1:3001"), true);
  assert.equal(isAllowedLocalOrigin("http://localhost:9999"), false);
  assert.equal(isAllowedLocalOrigin("https://example.com"), false);

  const rpc = new FakeRpc();
  const baseUrl = await withServer(t, rpc);
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /local browser origins/);

  await assert.rejects(
    startBridge({ host: "0.0.0.0", port: 0, rpc: new FakeRpc() }),
    /local machine only/,
  );
});
