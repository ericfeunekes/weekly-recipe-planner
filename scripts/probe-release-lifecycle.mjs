import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDisposableReleaseDatabase,
  readDisposableReleaseDatabaseContract,
} from "../server/store/disposable-release-fixture.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const householdHome = resolve(process.env.HOME ?? "");
const householdLabel = "com.ericfeunekes.meal-planner";

export function assertDisposableProfile({ home, label, database }) {
  const resolvedHome = resolve(home);
  const resolvedDatabase = resolve(database);
  if (!label || label === householdLabel || !label.startsWith("com.ericfeunekes.meal-planner.qa.")) {
    throw new Error("Release-lifecycle QA refuses the household or non-disposable LaunchAgent label.");
  }
  if (resolvedHome === householdHome || resolvedDatabase.startsWith(`${householdHome}${"/"}`)) {
    throw new Error("Release-lifecycle QA refuses the household HOME or database.");
  }
  if (resolvedDatabase !== join(resolvedHome, "meal-planner", "data", "planner.sqlite")) {
    throw new Error("Release-lifecycle QA database must be the generated HOME planner.sqlite.");
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} ${args.join(" ")} failed (${code}).`)));
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun({ stdout, stderr })
      : rejectRun(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`)));
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function settledDiagnostics(results) {
  return results.map((result, index) => result.status === "fulfilled"
    ? `${index + 1}: fulfilled`
    : `${index + 1}: rejected: ${result.reason?.message ?? result.reason}`).join(" | ");
}

async function databaseProof(database) {
  const [metadata, bytes] = await Promise.all([stat(database), readFile(database)]);
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contract: readDisposableReleaseDatabaseContract(database),
  };
}

async function optionalText(path) {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function slotProof(home) {
  const deployRoot = join(home, "meal-planner");
  return Object.fromEntries(await Promise.all([
    ["app", "app"],
    ["previous", "app.previous"],
    ["staging", ".app-staging"],
    ["retiring", ".app-retiring"],
  ].map(async ([name, directory]) => {
    const path = join(deployRoot, directory);
    try {
      const metadata = await stat(path);
      return [name, { exists: metadata.isDirectory(), marker: await optionalText(join(path, ".release-probe-marker")) }];
    } catch (error) {
      if (error?.code === "ENOENT") return [name, { exists: false, marker: null }];
      throw error;
    }
  })));
}

async function waitForRequired(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fetchRequired(origin); } catch (error) { lastError = error; }
    await delay(250);
  }
  throw lastError ?? new Error("Disposable planner did not become ready.");
}

async function commitFailingBuild(candidate) {
  const packagePath = join(candidate, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts.build = `${process.execPath} -e "process.exit(23)"`;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await run("git", ["add", "package.json"], { cwd: candidate });
  await run("git", ["commit", "-m", "probe: failing pre-disturbance build"], { cwd: candidate });
}

export async function copyCandidate(destination) {
  await cp(root, destination, { recursive: true, filter(source) {
    const name = basename(source);
    return ![".git", "node_modules", ".next", "dist", "outputs", ".planner-data", ".planner-dev", ".planner-qa"].includes(name);
  } });
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: destination });
  await run("git", ["config", "user.email", "release-probe@invalid"], { cwd: destination });
  await run("git", ["config", "user.name", "release lifecycle probe"], { cwd: destination });
  await run("git", ["add", "."], { cwd: destination });
  await run("git", ["commit", "--quiet", "-m", "disposable exact candidate"], { cwd: destination });
}

export async function readCandidateGitIdentity(candidate) {
  const [commit, tree] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], { cwd: candidate }),
    capture("git", ["rev-parse", "HEAD^{tree}"], { cwd: candidate }),
  ]);
  return Object.freeze({ commit: commit.stdout.trim(), tree: tree.stdout.trim() });
}

export function candidateIdentitySummary({ commit, tree }) {
  return [`- candidate commit: ${commit}`, `- candidate tree: ${tree}`];
}

function replaceCandidateIdentitySummary(lines, identity) {
  const first = lines.findIndex((line) => line.startsWith("- candidate commit: "));
  if (first < 0 || !lines[first + 1]?.startsWith("- candidate tree: ")) {
    throw new Error("Release-lifecycle summary lost its candidate identity fields.");
  }
  lines.splice(first, 2, ...candidateIdentitySummary(identity));
}

export async function assertCandidateEvidence(summaryPath, candidate, expectedIdentity) {
  const [summary, actualIdentity] = await Promise.all([
    readFile(summaryPath, "utf8"),
    readCandidateGitIdentity(candidate),
  ]);
  assert.deepEqual(actualIdentity, expectedIdentity, "candidate identity still resolves in the exercised repository");
  for (const line of candidateIdentitySummary(expectedIdentity)) {
    assert.ok(summary.split("\n").includes(line), `persisted summary includes ${line}`);
  }
}

async function installDisposableCodexFixture(candidate, home) {
  const fixtureRoot = join(home, ".local", "share", "release-probe-codex");
  const launcherDirectory = join(home, ".local", "bin");
  const launcherTarget = join(fixtureRoot, "codex.mjs");
  const invocationLog = join(home, ".release-probe-fixture-invocations.jsonl");
  await mkdir(launcherDirectory, { recursive: true, mode: 0o700 });
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  await run(join(root, "node_modules", ".bin", "esbuild"), [
    join(candidate, "tests", "support", "fixtures", "codex-runtime", "fake-codex.mjs"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--define:__RELEASE_PROBE_INVOCATION_LOG__=${JSON.stringify(invocationLog)}`,
    `--outfile=${launcherTarget}`,
  ]);
  await chmod(launcherTarget, 0o700);
  await symlink(launcherTarget, join(launcherDirectory, "codex"));
}

async function fetchRequired(origin) {
  const health = await fetch(`${origin}/recipe-planner/api/health`, { headers: { Connection: "close" } });
  assert.equal(health.status, 200, "mounted health");
  const workspace = await fetch(`${origin}/recipe-planner/api/workspace`, { headers: { Connection: "close" } });
  assert.equal(workspace.status, 200, "mounted workspace");
  const codexThreads = await fetch(`${origin}/recipe-planner/api/codex/threads`, { headers: { Connection: "close" } });
  assert.equal(codexThreads.status, 200, "mounted Codex thread list");
  const page = await fetch(`${origin}/recipe-planner/`, { headers: { Connection: "close" } });
  assert.equal(page.status, 200, "mounted planner page");
  const html = await page.text();
  assert.match(html, /<title>Weekly Recipe Planner<\/title>/u, "planner title metadata");
  assert.match(html, /property="og:title" content="Weekly Recipe Planner"/u, "Open Graph metadata");
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/gu)].map(([, asset]) => asset);
  assert.ok(assets.some((asset) => /\.js(?:\?|$)/u.test(asset)), "planner page links mounted JavaScript");
  assert.ok(assets.some((asset) => /\.css(?:\?|$)/u.test(asset)), "planner page links mounted CSS");
  for (const asset of assets) assert.equal((await fetch(new URL(asset, `${origin}/recipe-planner/`))).status, 200, `mounted asset ${asset}`);
  const favicon = html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/u)?.[1];
  assert.ok(favicon, "planner page links a favicon");
  assert.equal((await fetch(new URL(favicon, `${origin}/recipe-planner/`))).status, 200, "mounted favicon");
  return { health: await health.json(), workspace: await workspace.json() };
}

async function runBrowserJourney(origin, evidenceDirectory) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    const failedResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    // The native Codex event subscription is intentionally long-lived, so this
    // page never reaches Playwright's network-idle heuristic.
    const response = await page.goto(`${origin}/recipe-planner/`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200, "browser mounted planner page");
    assert.equal(await page.title(), "Weekly Recipe Planner");
    await page.getByText("Family dinner planner", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Groceries", exact: true }).click();
    await page.getByRole("heading", { level: 1, name: "Groceries", exact: true }).waitFor({ state: "visible" });
    assert.deepEqual({ consoleErrors, failedResponses }, { consoleErrors: [], failedResponses: [] }, "browser network and console errors");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: join(evidenceDirectory, "mounted-groceries.png"), animations: "disabled" });
  } finally {
    await browser.close();
  }
}

async function writeSummary(directory, lines) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "summary.md"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function main() {
  const realLaunchd = process.argv.includes("--real-launchd");
  const runId = `${Date.now()}-${process.pid}`;
  // Keep both release and runtime Unix socket paths below macOS sockaddr_un's
  // small path limit after /tmp resolves to /private/tmp.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "wrp-release-")));
  const candidate = join(temporary, "candidate");
  const home = join(temporary, "home");
  const port = 20000 + (process.pid % 20000);
  const privateWebPort = port + 1;
  const label = `com.ericfeunekes.meal-planner.qa.${runId}`;
  const database = join(home, "meal-planner", "data", "planner.sqlite");
  assertDisposableProfile({ home, label, database });
  const sourceCommit = (await capture("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const summaryDirectory = join(root, "outputs", "qa", runId);
  const lines = [
    `# Release lifecycle ${realLaunchd ? "launchd QA" : "RC"}`,
    "",
    `- source base commit: ${sourceCommit}`,
    `- command: npm run probe:release-lifecycle${realLaunchd ? " -- --real-launchd" : ""}`,
    `- candidate: ${candidate}`,
    `- label: ${label}`,
    `- home: ${home}`,
    `- database fixture: ${database} (generated schema-v9 disposable SQLite)`,
    "- browser: headless Chromium, 1280x900",
    `- public port: ${port}`,
    `- private web port: ${privateWebPort}`,
  ];
  let fakeState;
  let releaseEnvironment;
  let candidateIdentity;
  try {
    await copyCandidate(candidate);
    candidateIdentity = await readCandidateGitIdentity(candidate);
    lines.push(...candidateIdentitySummary(candidateIdentity));
    await installDisposableCodexFixture(candidate, home);
    await mkdir(join(home, "meal-planner", "data"), { recursive: true, mode: 0o700 });
    createDisposableReleaseDatabase(database);
    const before = readDisposableReleaseDatabaseContract(database);
    await mkdir(join(home, "meal-planner", "agent", ".agents"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "meal-planner", "agent", "auth.json"), "{}\n", { mode: 0o600 });
    await symlink(join(home, "meal-planner", "app", "deployment", "codex", "AGENTS.md"), join(home, "meal-planner", "agent", "AGENTS.md"));
    await symlink(join(home, "meal-planner", "app", ".agents", "skills"), join(home, "meal-planner", "agent", ".agents", "skills"));
    const environment = {
      ...process.env,
      HOME: home,
      PLANNER_LAUNCHD_LABEL: label,
      PLANNER_PORT: String(port),
      PLANNER_PRIVATE_WEB_PORT: String(privateWebPort),
    };
    releaseEnvironment = environment;
    if (!realLaunchd) {
      const bin = join(temporary, "bin"); fakeState = join(temporary, "launchctl.json");
      await mkdir(bin, { recursive: true });
      const wrapper = join(bin, "launchctl");
      await writeFile(wrapper, `#!/bin/sh\nexec \"${process.execPath}\" \"${join(candidate, "scripts/support/probe-release-lifecycle-launchctl.mjs")}\" \"$@\"\n`);
      await chmod(wrapper, 0o700);
      environment.PATH = `${bin}:${environment.PATH}`;
      environment.PLANNER_PROBE_LAUNCHCTL_STATE = fakeState;
      environment.PLANNER_PROBE_LAUNCHCTL_LOG = join(temporary, "launchctl-actions.jsonl");
    }
    const origin = `http://127.0.0.1:${port}`;
    await run("make", ["promote"], { cwd: candidate, env: environment });
    await writeFile(join(home, "meal-planner", "app", ".release-probe-marker"), "first\n", { mode: 0o600 });
    const firstDatabase = await databaseProof(database);
    const firstSlots = await slotProof(home);
    assert.deepEqual(firstSlots, {
      app: { exists: true, marker: "first\n" },
      previous: { exists: false, marker: null },
      staging: { exists: false, marker: null },
      retiring: { exists: false, marker: null },
    });

    if (!realLaunchd) {
      await commitFailingBuild(candidate);
      await assert.rejects(run("make", ["promote"], { cwd: candidate, env: environment }));
      assert.deepEqual(await slotProof(home), firstSlots, "build failure leaves fixed slots unchanged");
      assert.deepEqual(await databaseProof(database), firstDatabase, "build failure leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);
      await run("git", ["revert", "--no-edit", "HEAD"], { cwd: candidate });
      candidateIdentity = await readCandidateGitIdentity(candidate);
      replaceCandidateIdentitySummary(lines, candidateIdentity);

      await assert.rejects(capture("make", ["promote"], {
        cwd: candidate,
        env: { ...environment, PLANNER_PROBE_FAIL_NEXT_BOOTOUT: "partial-unload" },
      }), /Planner service did not become quiescent for promotion/u);
      assert.deepEqual(await slotProof(home), firstSlots, "partial unload failure leaves fixed slots unchanged");
      assert.deepEqual(await databaseProof(database), firstDatabase, "partial unload failure leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);

      await assert.rejects(capture("make", ["promote"], {
        cwd: candidate,
        env: { ...environment, PLANNER_PROBE_FAIL_NEXT_BOOTSTRAP: "activation" },
      }), /launchctl bootstrap failed \(75\)/u);
      assert.deepEqual(await slotProof(home), firstSlots, "failed activation restores the selected app and slots");
      assert.deepEqual(await databaseProof(database), firstDatabase, "failed activation leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);

      await assert.rejects(capture("make", ["promote"], {
        cwd: candidate,
        env: { ...environment, PLANNER_PROBE_FAIL_NEXT_READINESS: "activation" },
      }), /Planner did not become healthy on fresh connections/u);
      assert.deepEqual(await slotProof(home), firstSlots, "unhealthy selected candidate restores the prior fixed slots");
      assert.deepEqual(await databaseProof(database), firstDatabase, "readiness failure leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);
      lines.push(
        "- shipped build-failure non-disturbance: PASS",
        "- shipped partial-unload failure reversal: PASS",
        "- shipped activation-failure reversal: PASS",
        "- shipped unhealthy-candidate readiness reversal: PASS",
      );
    }

    // The second shipped promotion creates the immediate previous slot. The
    // marker distinguishes code-identical candidates without release metadata.
    await run("make", ["promote"], { cwd: candidate, env: environment });
    await writeFile(join(home, "meal-planner", "app", ".release-probe-marker"), "second\n", { mode: 0o600 });
    assert.deepEqual(await slotProof(home), {
      app: { exists: true, marker: "second\n" },
      previous: { exists: true, marker: "first\n" },
      staging: { exists: false, marker: null },
      retiring: { exists: false, marker: null },
    });
    const secondSlots = await slotProof(home);
    const secondDatabase = await databaseProof(database);
    if (!realLaunchd) {
      await assert.rejects(capture("make", ["promote"], {
        cwd: candidate,
        env: { ...environment, PLANNER_PROBE_FAIL_NEXT_RENAME: "2" },
      }), /Disposable release probe injected rename 2 failure/u);
      assert.deepEqual(await slotProof(home), secondSlots, "second promotion rename failure restores exact fixed slots");
      assert.deepEqual(await databaseProof(database), secondDatabase, "second promotion rename failure leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);
      lines.push("- shipped second-rename failure reversal: PASS");
    }
    const visible = await fetchRequired(origin);
    await runBrowserJourney(origin, summaryDirectory);
    lines.push("- promote: PASS", "- mounted browser journey: PASS", `- health: ${JSON.stringify(visible.health)}`, `- workspace: ${JSON.stringify(visible.workspace)}`);

    const target = `gui/${process.getuid()}/${label}`;
    if (realLaunchd) {
      const beforePrint = await capture("launchctl", ["print", target], { env: environment });
      const beforePid = beforePrint.stdout.match(/\bpid = (\d+)/u)?.[1];
      assert.ok(beforePid, "real launchd exposes the supervised process pid");
      await run("launchctl", ["kill", "SIGKILL", target], { env: environment });
      await waitForRequired(origin);
      const afterPrint = await capture("launchctl", ["print", target], { env: environment });
      const afterPid = afterPrint.stdout.match(/\bpid = (\d+)/u)?.[1];
      assert.ok(afterPid && afterPid !== beforePid, "KeepAlive restarted the disposable service");
      lines.push(`- real launchd KeepAlive restart: PASS (${beforePid} -> ${afterPid})`);
      await rename(
        join(home, "meal-planner", "app", "scripts", "start.mjs"),
        join(home, "meal-planner", "app", "scripts", "start.mjs.disabled"),
      );
      await run("launchctl", ["bootout", target], { env: environment });
      await run("make", ["recover"], { cwd: candidate, env: environment });
    } else {
      await run("launchctl", ["bootout", target], { env: environment });
      await run("make", ["recover"], {
        cwd: candidate,
        env: { ...environment, PLANNER_PROBE_FAIL_NEXT_BOOTSTRAP: "recovery" },
      });
    }
    const recoveredSlots = {
      app: { exists: true, marker: "first\n" },
      previous: { exists: true, marker: "second\n" },
      staging: { exists: false, marker: null },
      retiring: { exists: false, marker: null },
    };
    assert.deepEqual(await slotProof(home), recoveredSlots);
    await run("make", ["recover"], { cwd: candidate, env: environment });
    await fetchRequired(origin);

    if (!realLaunchd) {
      await assert.rejects(capture("make", ["promote"], {
        cwd: candidate,
        env: { ...environment, PLANNER_PROBE_FAIL_NEXT_RENAME: "1" },
      }), /Disposable release probe injected rename 1 failure/u);
      assert.deepEqual(await slotProof(home), recoveredSlots, "first promotion rename failure restores exact fixed slots");
      assert.deepEqual(await databaseProof(database), firstDatabase, "first promotion rename failure leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);

      await cp(join(home, "meal-planner", "app"), join(home, "meal-planner", ".app-retiring"), { recursive: true });
      await writeFile(join(home, "meal-planner", "app", ".release-probe-marker"), "candidate\n", { mode: 0o600 });
      await writeFile(join(home, "meal-planner", "app.previous", ".release-probe-marker"), "current\n", { mode: 0o600 });
      await writeFile(join(home, "meal-planner", ".app-retiring", ".release-probe-marker"), "older\n", { mode: 0o600 });
      await run("launchctl", ["bootout", target], { env: environment });
      await run("make", ["recover"], { cwd: candidate, env: environment });
      const interruptedSelectionSlots = {
        app: { exists: true, marker: "current\n" },
        previous: { exists: true, marker: "older\n" },
        staging: { exists: false, marker: null },
        retiring: { exists: false, marker: null },
      };
      assert.deepEqual(await slotProof(home), interruptedSelectionSlots, "recovery reverses a completed but unready candidate selection");
      assert.deepEqual(await databaseProof(database), firstDatabase, "completed-selection interruption leaves SQLite bytes and rows unchanged");
      await waitForRequired(origin);

      const promotionBarrier = `promote-${runId}`;
      const promotionResults = await Promise.allSettled([
        capture("make", ["promote"], {
          cwd: candidate,
          env: { ...environment, PLANNER_PROBE_PROMOTION_BARRIER: promotionBarrier },
        }),
        capture("make", ["promote"], {
          cwd: candidate,
          env: { ...environment, PLANNER_PROBE_PROMOTION_BARRIER: promotionBarrier },
        }),
      ]);
      const promotionWinners = promotionResults.filter((result) => result.status === "fulfilled");
      const promotionLosers = promotionResults.filter((result) => result.status === "rejected");
      const promotionDiagnostics = settledDiagnostics(promotionResults);
      assert.equal(promotionWinners.length, 1, `exactly one concurrent shipped promotion owns the lifecycle lease: ${promotionDiagnostics}`);
      assert.equal(promotionLosers.length, 1, `exactly one concurrent shipped promotion loses the lifecycle lease: ${promotionDiagnostics}`);
      assert.match(
        String(promotionLosers[0].reason?.message),
        /RuntimeOwnershipError|owns the runtime writer lease/u,
        "concurrent promotion loser fails specifically on runtime ownership",
      );
      const promotedSlots = {
        app: { exists: true, marker: null },
        previous: { exists: true, marker: "current\n" },
        staging: { exists: false, marker: null },
        retiring: { exists: false, marker: null },
      };
      assert.deepEqual(await slotProof(home), promotedSlots, "concurrent promotion loser leaves the owner-selected fixed slots intact");
      assert.deepEqual(await databaseProof(database), firstDatabase, "concurrent promotion attempts leave SQLite bytes and rows unchanged");
      await waitForRequired(origin);
      lines.push(
        "- shipped first-rename failure reversal: PASS",
        "- shipped completed-selection interruption recovery: PASS",
        "- competing shipped promotion commands: PASS",
      );

      await run("launchctl", ["bootout", target], { env: environment });
      const recoveryBarrier = `recover-${runId}`;
      const recoveryResults = await Promise.allSettled([
        capture("make", ["recover"], {
          cwd: candidate,
          env: { ...environment, PLANNER_PROBE_RECOVERY_BARRIER: recoveryBarrier },
        }),
        capture("make", ["recover"], {
          cwd: candidate,
          env: { ...environment, PLANNER_PROBE_RECOVERY_BARRIER: recoveryBarrier },
        }),
      ]);
      const recoveryWinners = recoveryResults.filter((result) => result.status === "fulfilled");
      const recoveryLosers = recoveryResults.filter((result) => result.status === "rejected");
      const recoveryDiagnostics = settledDiagnostics(recoveryResults);
      assert.equal(recoveryWinners.length, 1, `exactly one concurrent shipped recovery owns the lifecycle lease: ${recoveryDiagnostics}`);
      assert.equal(recoveryLosers.length, 1, `exactly one concurrent shipped recovery loses the lifecycle lease: ${recoveryDiagnostics}`);
      assert.match(
        String(recoveryLosers[0].reason?.message),
        /RuntimeOwnershipError|owns the runtime writer lease/u,
        "concurrent recovery loser fails specifically on runtime ownership",
      );
      await fetchRequired(origin);
      assert.deepEqual(await slotProof(home), promotedSlots);
      assert.deepEqual(await databaseProof(database), firstDatabase, "concurrent recovery attempts leave SQLite bytes and rows unchanged");
      lines.push("- competing shipped recovery commands: PASS");
    }

    assert.deepEqual(await databaseProof(database), firstDatabase, "deployment leaves SQLite identity, bytes, quick_check, and planner rows unchanged");
    assert.deepEqual(readDisposableReleaseDatabaseContract(database), before, "deployment leaves the schema and household state unchanged");
    lines.push("- forced service failure and distinguishable previous-app recovery: PASS", "- repeated recovery: PASS", "- fixed slots and SQLite non-mutation: PASS");
    await writeSummary(summaryDirectory, [...lines, "- result: PASS"]);
    await assertCandidateEvidence(join(summaryDirectory, "summary.md"), candidate, candidateIdentity);
    console.log([...lines, "- result: PASS"].join("\n"));
  } catch (error) {
    lines.push(`- result: FAIL: ${error.stack ?? error}`);
    for (const diagnostic of [
      join(home, "meal-planner", "planner.log"),
      join(home, "meal-planner", "agent", ".planner-runtime", "evidence", "compatibility-v1.json"),
      join(home, ".release-probe-fixture-invocations.jsonl"),
    ]) {
      try { console.error(`\n--- ${diagnostic} ---\n${await readFile(diagnostic, "utf8")}`); } catch {}
    }
    await writeSummary(summaryDirectory, lines);
    console.error(lines.join("\n"));
    throw error;
  } finally {
    if (releaseEnvironment) {
      try { await run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { env: releaseEnvironment }); } catch {}
    }
    if (fakeState) {
      try { await run("launchctl", ["bootout", "probe"], { env: { ...process.env, PLANNER_PROBE_LAUNCHCTL_STATE: fakeState, PATH: `${join(temporary, "bin")}:${process.env.PATH}` } }); } catch {}
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
