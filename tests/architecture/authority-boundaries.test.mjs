import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../../", import.meta.url).pathname);

async function source(path) {
  return readFile(resolve(root, path), "utf8");
}

async function productionFiles(directory) {
  const absolute = resolve(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionFiles(relative(root, path)));
    } else if ([".ts", ".tsx", ".mjs", ".sql"].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

test("the browser has no shared-state authority or alternate chat transport", async () => {
  const [client, api] = await Promise.all([
    source("app/planner-client.tsx"),
    source("app/planner-api.ts"),
  ]);
  const browser = `${client}\n${api}`;

  assert.doesNotMatch(browser, /localStorage\.setItem/);
  assert.doesNotMatch(
    browser,
    /executeDomainCommand|buildChatPlannerState|planner-(?:domain|history|persistence|command-contract)/,
  );
  assert.doesNotMatch(browser, /CODEX_BRIDGE_URL|fetch\([^)]*["']\/chat["']/);
  assert.doesNotMatch(api, /\bactor\s*:/);
  assert.match(api, /PLANNER_API_ROUTES\.commands\.path/);
  assert.match(api, /PLANNER_API_ROUTES\.chatSubmit\.path/);
});

test("obsolete browser authority modules and bridge entrypoint stay retired", async () => {
  for (const path of [
    "bridge/server.mjs",
    "bridge/validation.mjs",
    "lib/planner-chat-context.ts",
    "lib/planner-command-contract.ts",
    "lib/planner-domain.ts",
    "lib/planner-history.ts",
    "lib/planner-persistence.ts",
  ]) {
    await assert.rejects(access(resolve(root, path)), { code: "ENOENT" });
  }
});

test("SQLite statements stay inside the store owner", async () => {
  const files = [
    ...await productionFiles("app"),
    ...await productionFiles("lib"),
    ...await productionFiles("server"),
    ...await productionFiles("bridge"),
    ...await productionFiles("scripts"),
  ];
  const sqlCall = /(?:prepare|exec)\(\s*[`"']\s*(?:SELECT|INSERT|UPDATE|DELETE|PRAGMA|CREATE|DROP|ALTER)\b/i;

  for (const file of files) {
    const path = relative(root, file);
    if (path.startsWith("server/store/")) continue;
    assert.doesNotMatch(await readFile(file, "utf8"), sqlCall, `${path} bypasses the store owner`);
  }
});

test("runtime scripts launch the authority rather than the retired bridge", async () => {
  const [packageSource, dev, start] = await Promise.all([
    source("package.json"),
    source("scripts/dev.mjs"),
    source("scripts/start.mjs"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts.dev, "node scripts/dev.mjs");
  assert.equal(packageJson.scripts.start, "node scripts/start.mjs");
  assert.equal(packageJson.scripts.bridge, undefined);
  assert.doesNotMatch(`${dev}\n${start}`, /bridge\/server|\/chat\b/);
  assert.match(`${dev}\n${start}`, /superviseProcesses/);
});
