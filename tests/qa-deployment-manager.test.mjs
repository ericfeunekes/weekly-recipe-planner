import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseState,
  readOriginHandoff,
  start,
  stop,
} from "../scripts/qa-deployment-manager.mjs";
import {
  requireOriginHandoffPath,
  writeEffectiveOriginHandoff,
} from "../scripts/support/qa-effective-origin-handoff.mjs";

async function waitForFile(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function fakeRoot(source) {
  await mkdir(join(source, "node_modules", ".bin"), { recursive: true });
  const script = join(source, "node_modules", ".bin", "portless");
  await writeFile(script, `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { writeEffectiveOriginHandoff } from ${JSON.stringify(new URL("../scripts/support/qa-effective-origin-handoff.mjs", import.meta.url).href)};
if (process.env.FAKE_CHILD_MARKER) {
  spawn(process.execPath, ["-e", "const {writeFileSync}=require('node:fs'); if(process.env.FAKE_CHILD_IGNORE_TERM)process.on('SIGTERM',()=>{}); writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)", process.env.FAKE_CHILD_MARKER], { stdio: "ignore", env: process.env });
}
if (process.env.FAKE_WRITE_HANDOFF === "1") {
  await writeEffectiveOriginHandoff(process.env.QA_EFFECTIVE_ORIGIN_HANDOFF, process.env.FAKE_ORIGIN);
  const server = createServer((request, response) => {
    if (request.url === "/recipe-planner/api/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ application: { status: "ready" }, store: { status: "ready" } }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(Number(process.env.FAKE_PORT), "127.0.0.1");
}
setInterval(() => {}, 1_000);
`, { mode: 0o700 });
  return script;
}

function pathsFor(root, stateDirectory, name = "qa-test") {
  return {
    root,
    stateDirectory,
    statePath: join(stateDirectory, "deployment.json"),
    logPath: join(stateDirectory, "qa.log"),
    dataSource: join(root, "missing.sqlite"),
    name,
    port: 1437,
  };
}

test("QA deployment accepts a one-shot effective-origin handoff for its requested name", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "planner-qa-handoff-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const handoff = join(stateDirectory, "effective-origin.txt");
  await writeFile(handoff, "http://branch.weekly-recipe-planner-qa.localhost:1355\n", { mode: 0o600 });

  assert.equal(
    await readOriginHandoff({ stateDirectory, name: "weekly-recipe-planner-qa" }, handoff),
    "http://branch.weekly-recipe-planner-qa.localhost:1355",
  );
});

test("QA deployment rejects unsafe or mismatched origin handoffs", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "planner-qa-handoff-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const handoff = join(stateDirectory, "effective-origin.txt");
  await writeFile(handoff, "https://weekly-recipe-planner-qa.localhost\n", { mode: 0o600 });
  await assert.rejects(
    readOriginHandoff({ stateDirectory, name: "weekly-recipe-planner-qa" }, handoff),
    /requested HTTP/u,
  );
  await chmod(handoff, 0o644);
  await assert.rejects(
    readOriginHandoff({ stateDirectory, name: "weekly-recipe-planner-qa" }, handoff),
    /unsafe/u,
  );
  await chmod(handoff, 0o600);
  await writeFile(handoff, "http://wrong-name.localhost:1355\n", { mode: 0o600 });
  await assert.rejects(readOriginHandoff({ stateDirectory, name: "weekly-recipe-planner-qa" }, handoff), /requested HTTP/u);
  await writeFile(handoff, "not a URL\n", { mode: 0o600 });
  await assert.rejects(readOriginHandoff({ stateDirectory, name: "weekly-recipe-planner-qa" }, handoff));
  assert.throws(() => requireOriginHandoffPath(join(stateDirectory, "..", "outside"), stateDirectory), /inside/u);
});

test("effective-origin writer creates exactly one handoff", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "planner-qa-handoff-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const handoff = join(stateDirectory, "effective-origin.txt");
  await writeEffectiveOriginHandoff(handoff, "http://qa-test.localhost:1455");
  await assert.rejects(writeEffectiveOriginHandoff(handoff, "http://qa-test.localhost:1455"), { code: "EEXIST" });
});

test("QA deployment state supports a stoppable starting state", () => {
  assert.deepEqual(
    parseState('{"pid":123,"startedAt":"2026-08-26T00:00:00.000Z"}'),
    { pid: 123, startedAt: "2026-08-26T00:00:00.000Z" },
  );
  assert.throws(
    () => parseState('{"pid":123}'),
    /malformed/u,
  );
});

test("runtime writer hands off an effective origin that manager consumes and deletes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-qa-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeRoot(root);
  const stateDirectory = join(root, "state");
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  const paths = pathsFor(root, stateDirectory);
  const origin = `http://qa-test.localhost:${port}`;
  await start(paths, {
    QA_NPM_COMMAND: "ignored",
    FAKE_WRITE_HANDOFF: "1",
    FAKE_ORIGIN: origin,
    FAKE_PORT: String(port),
  });
  t.after(() => stop(paths, { quiet: true }));
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  assert.equal(state.url, origin);
  const entries = await (await import("node:fs/promises")).readdir(stateDirectory);
  assert.deepEqual(entries.toSorted(), ["deployment.json", "qa.log"]);
});

test("handoff timeout cleans only the provisional candidate and its descendant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-qa-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeRoot(root);
  const stateDirectory = join(root, "state");
  const paths = pathsFor(root, stateDirectory);
  const marker = join(root, "runtime-child.pid");
  const starting = start(paths, { QA_NPM_COMMAND: "ignored", FAKE_CHILD_MARKER: marker, FAKE_CHILD_IGNORE_TERM: "1", QA_READY_TIMEOUT_MS: "1000", QA_STOP_TIMEOUT_MS: "50" });
  starting.catch(() => undefined);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await readFile(paths.statePath, "utf8");
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  const childPid = Number(await waitForFile(marker));
  await assert.rejects(starting, /Timed out waiting/u);
  await assert.rejects(readFile(paths.statePath, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(paths.logPath, "utf8"), { code: "ENOENT" });
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("a failed older start cannot stop its ready successor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-qa-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeRoot(root);
  const paths = pathsFor(root, join(root, "state"));
  const older = start(paths, { QA_NPM_COMMAND: "ignored", QA_READY_TIMEOUT_MS: "1000" });
  older.catch(() => undefined);
  await waitForFile(paths.statePath);
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  const origin = `http://qa-test.localhost:${port}`;
  await start(paths, { QA_NPM_COMMAND: "ignored", FAKE_WRITE_HANDOFF: "1", FAKE_ORIGIN: origin, FAKE_PORT: String(port) });
  t.after(() => stop(paths, { quiet: true }));
  await assert.rejects(older, /exited before reporting/u);
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  assert.equal(state.url, origin);
});

test("cleanup does not delete a successor installed after termination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planner-qa-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeRoot(root);
  const paths = pathsFor(root, join(root, "state"));
  const older = start(paths, { QA_NPM_COMMAND: "ignored", QA_READY_TIMEOUT_MS: "1000" });
  older.catch(() => undefined);
  await waitForFile(paths.statePath);
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  const origin = `http://qa-test.localhost:${port}`;
  await stop(paths, {
    quiet: true,
    beforeCleanup: () => start(paths, { QA_NPM_COMMAND: "ignored", FAKE_WRITE_HANDOFF: "1", FAKE_ORIGIN: origin, FAKE_PORT: String(port) }),
  });
  t.after(() => stop(paths, { quiet: true }));
  await assert.rejects(older, /exited before reporting/u);
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  assert.equal(state.url, origin);
  assert.equal(await readFile(paths.logPath, "utf8").then(() => true), true);
});
