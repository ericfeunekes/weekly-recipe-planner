import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  assertDisposableProfile,
  assertCandidateEvidence,
  candidateIdentitySummary,
  copyCandidate,
  installedPlaywrightExecutablePath,
  parseProbeArguments,
  readCandidateGitIdentity,
} from "../scripts/probe-release-lifecycle.mjs";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";
import {
  createDisposableReleaseDatabase,
  readDisposableReleaseDatabaseContract,
} from "../server/store/disposable-release-fixture.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";
import { validateHouseholdState } from "../lib/household-domain.ts";

test("release-lifecycle QA profile refuses household-shaped targets", () => {
  const household = process.env.HOME;
  assert.throws(() => assertDisposableProfile({ home: household, label: "com.ericfeunekes.meal-planner.qa.test", database: `${household}/meal-planner/data/planner.sqlite` }), /household HOME/u);
  assert.throws(() => assertDisposableProfile({ home: "/private/tmp/probe-home", label: "com.ericfeunekes.meal-planner", database: "/private/tmp/probe-home/meal-planner/data/planner.sqlite" }), /household|non-disposable/u);
});

test("release-lifecycle QA profile permits only its generated database location", () => {
  assert.doesNotThrow(() => assertDisposableProfile({ home: "/private/tmp/probe-home", label: "com.ericfeunekes.meal-planner.qa.test", database: "/private/tmp/probe-home/meal-planner/data/planner.sqlite" }));
  assert.throws(() => assertDisposableProfile({ home: "/private/tmp/probe-home", label: "com.ericfeunekes.meal-planner.qa.test", database: "/private/tmp/other.sqlite" }), /database/u);
});

test("release-lifecycle CLI accepts only one documented proof mode", () => {
  assert.deepEqual(parseProbeArguments([]), { realLaunchd: false, publicCommandRc: false });
  assert.deepEqual(parseProbeArguments(["--real-launchd"]), { realLaunchd: true, publicCommandRc: false });
  assert.deepEqual(parseProbeArguments(["--public-command-rc"]), { realLaunchd: false, publicCommandRc: true });
  assert.throws(() => parseProbeArguments(["--unknown"]), /Usage/u);
  assert.throws(() => parseProbeArguments(["--real-launchd", "--public-command-rc"]), /Usage/u);
});

test("release-lifecycle launches the exact installed browser across disposable HOME", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "planner-release-browser-home-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const executablePath = await installedPlaywrightExecutablePath();
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "const { chromium } = await import('@playwright/test'); const browser = await chromium.launch({ headless: true, executablePath: process.env.PLANNER_PROBE_PLAYWRIGHT_EXECUTABLE_PATH }); await browser.close();",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: temporary,
      PLANNER_PROBE_PLAYWRIGHT_EXECUTABLE_PATH: executablePath,
    },
    stdio: "inherit",
  });
  assert.equal(await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  }), 0);
});

test("disposable release database contains one bounded active-week dinner", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "planner-release-dinner-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const database = join(temporary, "planner.sqlite");
  createDisposableReleaseDatabase(database);
  const contract = readDisposableReleaseDatabaseContract(database);
  const state = JSON.parse(contract.workspace.state_json);
  assert.equal(state.activeWeekId, "2026-07-20");
  assert.deepEqual(state.weeks[0].data.meals.map(({ id }) => id), ["release-dinner"]);
  assert.equal(state.weeks[0].data.meals[0].instructions.length, 1);
  assert.equal(state.weeks[0].data.meals[0].ingredients.length, 1);
  assert.deepEqual(validateHouseholdState(state), { ok: true });
});

test("disposable release database is already canonical when the production store opens it", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "planner-release-canonical-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const database = join(temporary, "planner.sqlite");
  createDisposableReleaseDatabase(database);
  const before = readDisposableReleaseDatabaseContract(database);

  const store = openPlannerStore({ filename: database });
  store.close();

  assert.deepEqual(readDisposableReleaseDatabaseContract(database), before);
});

test("release candidate evidence identifies the pinned clean clone", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "planner-candidate-identity-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const candidate = join(temporary, "candidate");

  await copyCandidate(candidate);
  const identity = await readCandidateGitIdentity(candidate);

  assert.match(identity.commit, /^[0-9a-f]{40}$/u);
  assert.equal(identity.clean, true);
  assert.equal(identity.headEqualsMain, true);
  assert.deepEqual(candidateIdentitySummary(identity), [
    `- candidate commit: ${identity.commit}`,
    "- candidate clean HEAD equals local main: PASS",
  ]);
  const summary = join(temporary, "summary.md");
  await writeFile(summary, `${candidateIdentitySummary(identity).join("\n")}\n`);
  await assertCandidateEvidence(summary, candidate, identity);
});

test("release probe Codex fixture serves the empty native thread catalogue", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const child = spawn(fixture.launcherPath, ["app-server", "--listen", "stdio://"], {
    env: { HOME: fixture.normalHome, CODEX_HOME: fixture.codexHome },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const response = new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line))));
  child.stdin.write(`${JSON.stringify({ id: 1, method: "thread/list", params: {} })}\n`);
  assert.deepEqual(await response, { id: 1, result: { data: [], nextCursor: null } });
});
