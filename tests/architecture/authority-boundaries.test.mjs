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

test("ordered planner operations have one kernel and no transport-owned authority", async () => {
  const [service, ports, chat, router, apiContract, commandContract, store] = await Promise.all([
    source("server/application/planner-service.ts"),
    source("server/application/ports.ts"),
    source("server/chat/embedded-service.ts"),
    source("server/http/application-router.ts"),
    source("lib/planner-api-contract.ts"),
    source("lib/household-command-contract.ts"),
    source("server/store/sqlite-store.ts"),
  ]);

  assert.equal((service.match(/\n\s{2}applyPlannerOperations\(/g) ?? []).length, 1);
  assert.equal((service.match(/\n\s{2}previewPlannerOperations\(/g) ?? []).length, 1);
  assert.doesNotMatch(`${service}\n${ports}\n${chat}`, /applyPlannerCommand\s*\(/);
  assert.match(ports, /applyOperations\s*\(/);
  assert.match(ports, /previewOperations\s*\(/);
  assert.doesNotMatch(`${router}\n${apiContract}`, /planner\/batches|batchCommands/);
  assert.doesNotMatch(commandContract, /\b(?:actor|actorSource|admission|requestId)\s*:/);
  assert.doesNotMatch(chat, /server\/store|node:sqlite/);
  assert.doesNotMatch(store, /migrationPath/);
});

test("managed embedded mediation cannot import the store or create a second live route", async () => {
  const runtimeFiles = await productionFiles("server/runtime/codex-follow-up");
  for (const file of runtimeFiles) {
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /(?:from|import\()["'][^"']*(?:server\/)?store\//,
      `${relative(root, file)} imports planner persistence`,
    );
  }
  const [embedded, router, runtime, composition] = await Promise.all([
    source("server/chat/embedded-service.ts"),
    source("server/http/application-router.ts"),
    source("server/runtime/planner-runtime.ts"),
    source("server/index.ts"),
  ]);
  assert.doesNotMatch(embedded, /(?:from|import\()["'][^"']*(?:server\/)?store\//);
  assert.doesNotMatch(`${router}\n${runtime}`, /createInactiveEmbedded|InactiveEmbeddedChatHarness/);
  assert.doesNotMatch(router, /embedded-service|sourced-recipe-intake/);
  assert.match(runtime, /createManagedEmbeddedChatApplicationService/);
  assert.match(composition, /createFailSoftManagedCodexFollowUpRuntime/);
  assert.doesNotMatch(`${runtime}\n${composition}`, /createCodexPlannerAdapter|CodexAppServerClient/);
  assert.doesNotMatch(runtime, /codexFollowUp:\s*\{/);
});

test("durable research handoff stores only the compact reference and no candidate envelope", async () => {
  const [migration, digestMigration, store, ports] = await Promise.all([
    source("server/store/migrations/004-sourced-recipe-intake.sql"),
    source("server/store/migrations/005-research-candidate-digest.sql"),
    source("server/store/sqlite-store.ts"),
    source("server/application/ports.ts"),
  ]);
  const migrations = (await productionFiles("server/store/migrations"));
  const allMigrations = (await Promise.all(migrations.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(allMigrations, /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[^\s(]*candidate/i);
  assert.match(migration, /ADD COLUMN research_candidate_json TEXT/);
  for (const compactKey of ["schemaVersion", "candidateId", "title", "source", "stepCount"]) {
    assert.match(migration, new RegExp(`\\$\\.${compactKey}`));
  }
  for (const bindingKey of ["digestVersion", "replacementDigest"]) {
    assert.match(digestMigration, new RegExp(`\\$\\.${bindingKey}`));
  }
  assert.match(digestMigration, /replacementDigest[^\n]*64|length\([^\n]*replacementDigest[^\n]*\) <> 64/s);
  for (const fullField of ["steps", "inputs", "instruction", "yieldText", "timerDurationSeconds"]) {
    assert.doesNotMatch(`${migration}\n${digestMigration}`, new RegExp(`\\$\\.${fullField}`));
  }
  assert.doesNotMatch(migration, /(?:full|body|envelope|payload|draft|steps)_candidate_json|candidate_(?:full|body|envelope|payload|draft|steps)_json/i);
  assert.doesNotMatch(`${store}\n${ports}`, /\bResearchRecipeCandidate\b/);
  assert.match(`${store}\n${ports}`, /\bResearchCandidateReference\b/);
});

test("legacy chat producers are absent after the single-path cutover", async () => {
  for (const path of [
    "bridge/app-server-client.mjs",
    "bridge/codex-runtime-policy.mjs",
    "server/chat/service.ts",
    "server/chat/codex-adapter.ts",
    "server/chat/output.ts",
    "tests/chat-output-schema.test.mjs",
  ]) {
    await assert.rejects(access(resolve(root, path)), { code: "ENOENT" });
  }
  const [chatIndex, ports] = await Promise.all([
    source("server/chat/index.ts"),
    source("server/application/ports.ts"),
  ]);
  assert.doesNotMatch(`${chatIndex}\n${ports}`, /CodexPlannerAdapter|CodexCompletion/);
  assert.doesNotMatch(`${ports}\n${await source("server/store/sqlite-store.ts")}`, /updateTurnIfRunning|ChatTurnTerminalUpdate/);
  assert.doesNotMatch(await source("lib/household-command-contract.ts"), /LEGACY_HOUSEHOLD_COMMAND|normalizeLegacyHouseholdCommand|isLegacyHouseholdCommand/);
  assert.match(chatIndex, /createManagedEmbeddedChatApplicationService/);
});
