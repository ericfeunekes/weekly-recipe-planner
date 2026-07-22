import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { renameSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { generateAndEvaluateCodexSchema } from "../server/runtime/codex-follow-up/compatibility.ts";
import {
  buildCodexFollowUpChildEnvironment,
  parseCodexFollowUpConfig,
  validateCodexFollowUpDeployment,
} from "../server/runtime/codex-follow-up/deployment.ts";
import {
  captureCodexExecutableIdentity,
  CodexLauncherError,
  createCompatibleCodexExecution,
  runAcceptedCodexProcess,
} from "../server/runtime/codex-follow-up/launcher.ts";
import { sha256BoundedFile } from "../server/runtime/codex-follow-up/resource-policy.ts";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";

async function acceptedFixture(t) {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const parsed = parseCodexFollowUpConfig(fixture.environment, fixture.plannerDataDirectory);
  assert.equal(parsed.ok, true);
  const validated = await validateCodexFollowUpDeployment(parsed.deployment);
  assert.equal(validated.ok, true);
  const environment = buildCodexFollowUpChildEnvironment(validated.deployment, fixture.environment);
  const identity = await captureCodexExecutableIdentity(fixture.launcherPath, {
    cwd: fixture.appCwd,
    env: environment,
    timeoutMs: 10_000,
  });
  return { fixture, deployment: validated.deployment, environment, identity };
}

async function acceptedProvenance(fixture) {
  return {
    userConfigSha256: await sha256BoundedFile(
      join(fixture.codexHome, "config.toml"),
      2 * 1024 * 1024,
      "test config",
    ),
    instructionSha256: await sha256BoundedFile(
      join(fixture.codexHome, "AGENTS.md"),
      2 * 1024 * 1024,
      "test instructions",
    ),
    systemConfigPaths: [join(fixture.root, "absent-system-config.toml")],
  };
}

test("captures exact canonical updater target identity and runs schema generation as a real subprocess", async (t) => {
  const { fixture, deployment, environment, identity } = await acceptedFixture(t);
  assert.equal(identity.launcherPath, fixture.launcherPath);
  assert.equal(identity.canonicalPath, fixture.launcherTargetPath);
  assert.equal(identity.version, "fake-codex compatible-a");
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  assert.ok(identity.device);
  assert.ok(identity.inode);
  assert.ok(identity.mtimeNanoseconds);
  assert.ok(identity.ctimeNanoseconds);

  const schema = await generateAndEvaluateCodexSchema(identity, deployment, environment);
  assert.match(schema.rawBundleSha256, /^[a-f0-9]{64}$/);
  assert.match(schema.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(schema.directory.startsWith(deployment.schemaCacheDirectory));

  const invocations = await fixture.invocations();
  const generate = invocations.find((entry) => entry.args.includes("generate-json-schema"));
  assert.ok(generate);
  assert.equal(generate.cwd, fixture.appCwd);
  assert.equal(generate.environmentKeys.includes("PLANNER_SECRET_SENTINEL"), false);
  assert.equal(generate.environmentKeys.includes("OPENAI_API_KEY"), false);
  const forwardedKeys = generate.environmentKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING");
  assert.deepEqual(
    forwardedKeys.sort(),
    Object.keys(environment).sort(),
  );
});

test("pre-spawn revalidation rejects an updater swap and never falls back", async (t) => {
  const { fixture, environment, identity } = await acceptedFixture(t);
  await appendFile(fixture.launcherPath, "\n// updater target changed\n");

  await assert.rejects(
    runAcceptedCodexProcess(identity, ["--version"], {
      cwd: fixture.appCwd,
      env: environment,
    }),
    (error) => error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED",
  );
  const invocations = await fixture.invocations();
  assert.equal(
    invocations.filter((entry) => entry.args[0] === "--version").length,
    1,
    "the accepted capture may run, but no command may run after the swap",
  );
});

test("pre-spawn revalidation rejects an in-place same-size change with restored mtime", async (t) => {
  const { fixture, environment } = await acceptedFixture(t);
  const fixedTime = new Date("2026-01-02T03:04:05.000Z");
  await utimes(fixture.launcherTargetPath, fixedTime, fixedTime);
  const identity = await captureCodexExecutableIdentity(fixture.launcherPath, {
    cwd: fixture.appCwd,
    env: environment,
    timeoutMs: 10_000,
  });
  const before = await readFile(fixture.launcherTargetPath, "utf8");
  const changed = before.replace("compatible-a", "compatible-b");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
  await writeFile(fixture.launcherTargetPath, changed);
  await utimes(fixture.launcherTargetPath, fixedTime, fixedTime);
  const metadata = await stat(fixture.launcherTargetPath, { bigint: true });
  assert.equal(metadata.mtimeNs.toString(), identity.mtimeNanoseconds);
  assert.notEqual(metadata.ctimeNs.toString(), identity.ctimeNanoseconds);

  await assert.rejects(
    runAcceptedCodexProcess(identity, ["--version"], {
      cwd: fixture.appCwd,
      env: environment,
    }),
    (error) => error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED",
  );
});

test("schema generation preserves updater identity changes for readiness reevaluation", async (t) => {
  const { fixture, deployment, environment, identity } = await acceptedFixture(t);
  await appendFile(fixture.launcherPath, "\n// updater target changed before schema generation\n");

  await assert.rejects(
    generateAndEvaluateCodexSchema(identity, deployment, environment),
    (error) => error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED",
  );
});

test("the reusable production capability exposes only a fixed app-server spawn", async (t) => {
  const { fixture, deployment, environment, identity } = await acceptedFixture(t);
  const execution = createCompatibleCodexExecution(
    identity,
    deployment,
    environment,
    await acceptedProvenance(fixture),
  );
  assert.deepEqual(Object.keys(execution).sort(), ["identity", "spawnAppServer"]);

  const child = await execution.spawnAppServer();
  const initialized = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("\n")) resolve(output);
    });
    child.once("error", reject);
  });
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "fixture", version: "1" } },
  })}\n`);
  await initialized;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));

  const invocations = await fixture.invocations();
  const appServer = invocations.findLast((entry) => entry.args[0] === "app-server");
  assert.deepEqual(appServer.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(appServer.cwd, fixture.appCwd);
  assert.deepEqual(
    appServer.environmentKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort(),
    Object.keys(environment).sort(),
  );
});

test("app-server spawn executes a verified private snapshot across a final-path replacement race", async (t) => {
  const { fixture, deployment, environment, identity } = await acceptedFixture(t);
  const replacement = `${fixture.launcherTargetPath}.replacement`;
  await writeFile(
    replacement,
    `#!${process.execPath}\nprocess.exit(91);\n`,
    { mode: 0o700 },
  );
  let replaced = false;
  const execution = createCompatibleCodexExecution(
    identity,
    deployment,
    environment,
    await acceptedProvenance(fixture),
    {
      spawn(command, args, options) {
        if (!replaced && args?.[0] === "app-server") {
          replaced = true;
          renameSync(replacement, fixture.launcherTargetPath);
        }
        return spawnProcess(command, args, options);
      },
    },
  );

  const child = await execution.spawnAppServer();
  const initialized = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("\n")) resolve(output);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (!output.includes("\n")) reject(new Error(`snapshot child closed with ${code}`));
    });
  });
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "fixture", version: "1" } },
  })}\n`);
  await initialized;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(replaced, true);
  await assert.rejects(
    execution.spawnAppServer(),
    (error) => error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED",
  );
});

test("private executable snapshots retain only the three newest accepted identities", async (t) => {
  const { fixture, environment } = await acceptedFixture(t);
  for (let index = 0; index < 3; index += 1) {
    await appendFile(fixture.launcherTargetPath, `\n// compatible updater ${index}\n`);
    await captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: environment,
      timeoutMs: 10_000,
    });
  }
  const snapshotRoot = join(fixture.codexHome, ".planner-runtime", "execution-snapshots");
  const retained = (await readdir(snapshotRoot)).filter((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.equal(retained.length, 3);
  assert.deepEqual(
    (await readdir(snapshotRoot)).filter((name) => name.startsWith(".prepare-")),
    [],
  );
});

test("production spawn accepts only the fixed release-owned config and instruction links", async (t) => {
  const { fixture, deployment, environment, identity } = await acceptedFixture(t);
  const releaseSources = join(fixture.appCwd, "deployment", "codex");
  await mkdir(releaseSources, { recursive: true });
  for (const name of ["config.toml", "AGENTS.md"]) {
    const dedicated = join(fixture.codexHome, name);
    const releaseOwned = join(releaseSources, name);
    renameSync(dedicated, releaseOwned);
    await symlink(releaseOwned, dedicated);
  }
  const execution = createCompatibleCodexExecution(
    identity,
    deployment,
    environment,
    await acceptedProvenance(fixture),
  );
  const child = await execution.spawnAppServer();
  child.kill();
});

for (const [label, mutate] of [
  ["dedicated config content", (fixture) => appendFile(join(fixture.codexHome, "config.toml"), "# drift\n")],
  ["dedicated instructions", (fixture) => appendFile(join(fixture.codexHome, "AGENTS.md"), "# drift\n")],
  ["previously absent system config", (fixture) => writeFile(
    join(fixture.root, "absent-system-config.toml"),
    "model = \"inherited\"\n",
  )],
  ["new project capability source", (fixture) => writeFile(
    join(fixture.appCwd, "AGENTS.md"),
    "# unexpected project instructions\n",
  )],
]) {
  test(`production spawn rejects changed ${label} before launching app-server`, async (t) => {
    const { fixture, deployment, environment, identity } = await acceptedFixture(t);
    const execution = createCompatibleCodexExecution(
      identity,
      deployment,
      environment,
      await acceptedProvenance(fixture),
    );
    await mutate(fixture);
    await assert.rejects(
      execution.spawnAppServer(),
      (error) => error instanceof CodexLauncherError && error.code === "PROVENANCE_CHANGED",
    );
    const invocations = await fixture.invocations();
    assert.equal(invocations.some((entry) => entry.args[0] === "app-server"), false);
  });
}

test("malformed process output and early exit fail closed", async (t) => {
  const { fixture, environment } = await acceptedFixture(t);
  const versionRecord = await readFile(`${fixture.codexHome}/.fixture-variant`, "utf8");
  assert.match(versionRecord, /compatible-a/);
  await writeFile(`${fixture.codexHome}/.fixture-variant`, "early-exit\n");

  await assert.rejects(
    captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: environment,
    }),
    (error) => error instanceof CodexLauncherError && error.code === "PROCESS_FAILED",
  );
});

test("executable identity rejects updater artifacts above the fixed byte budget before hashing", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const handle = await open(fixture.launcherTargetPath, "r+");
  await handle.truncate((512 * 1024 * 1024) + 1);
  await handle.close();
  await assert.rejects(
    captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: fixture.environment,
    }),
    (error) => error instanceof CodexLauncherError && error.code === "INVALID_EXECUTABLE",
  );
});

test("executable identity rejects group/world-writable updater targets", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await chmod(fixture.launcherTargetPath, 0o777);
  await assert.rejects(
    captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: fixture.environment,
    }),
    (error) => error instanceof CodexLauncherError && error.code === "INVALID_EXECUTABLE",
  );
});

test("executable identity rejects a writable updater target directory", async (t) => {
  const fixture = await createCodexRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await chmod(dirname(fixture.launcherTargetPath), 0o777);
  await assert.rejects(
    captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: fixture.environment,
    }),
    (error) => error instanceof CodexLauncherError && error.code === "INVALID_EXECUTABLE",
  );
});

test("schema generation removes interrupted work and retains only three completed bundles", async (t) => {
  const { fixture, deployment, environment } = await acceptedFixture(t);
  const stale = `${deployment.schemaCacheDirectory}/.generate-stale`;
  const active = `${deployment.schemaCacheDirectory}/.generate-active`;
  await mkdir(stale);
  await mkdir(active);
  await writeFile(`${stale}/partial.json`, "{}\n");
  const old = new Date(Date.now() - (10 * 60_000));
  await utimes(stale, old, old);

  for (const variant of ["compatible-a", "compatible-docs", "compatible-b", "compatible-c"]) {
    await writeFile(`${fixture.codexHome}/.fixture-variant`, `${variant}\n`);
    const identity = await captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: environment,
    });
    await generateAndEvaluateCodexSchema(identity, deployment, environment);
  }

  const entries = await readdir(deployment.schemaCacheDirectory);
  assert.equal(entries.includes(".generate-stale"), false);
  assert.equal(entries.includes(".generate-active"), true);
  assert.equal(entries.filter((name) => /^[a-f0-9]{64}$/u.test(name)).length, 3);
});

test("schema generation rejects a poisoned hash-named retained bundle", async (t) => {
  const { deployment, environment, identity } = await acceptedFixture(t);
  const schema = await generateAndEvaluateCodexSchema(identity, deployment, environment);
  await writeFile(`${schema.directory}/unexpected.json`, "{}\n");
  await assert.rejects(
    generateAndEvaluateCodexSchema(identity, deployment, environment),
    /schema generation failed/i,
  );
});

test("schema pruning preserves the bundle referenced by accepted evidence", async (t) => {
  const { fixture, deployment, environment } = await acceptedFixture(t);
  const firstIdentity = await captureCodexExecutableIdentity(fixture.launcherPath, {
    cwd: fixture.appCwd,
    env: environment,
    timeoutMs: 10_000,
  });
  const first = await generateAndEvaluateCodexSchema(firstIdentity, deployment, environment);
  await writeFile(
    `${deployment.evidenceDirectory}/last-accepted-v1.json`,
    `${JSON.stringify({ rawSchemaBundleSha256: first.rawBundleSha256 })}\n`,
  );

  for (const variant of ["compatible-docs", "compatible-b", "compatible-c"]) {
    await writeFile(`${fixture.codexHome}/.fixture-variant`, `${variant}\n`);
    const identity = await captureCodexExecutableIdentity(fixture.launcherPath, {
      cwd: fixture.appCwd,
      env: environment,
      timeoutMs: 10_000,
    });
    await generateAndEvaluateCodexSchema(identity, deployment, environment);
  }

  const bundles = (await readdir(deployment.schemaCacheDirectory))
    .filter((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.equal(bundles.length, 3);
  assert.equal(bundles.includes(first.rawBundleSha256), true);
});

test("schema generation rejects a generated file above the fixed byte budget", async (t) => {
  const { fixture, deployment, environment } = await acceptedFixture(t);
  await writeFile(`${deployment.codexHome}/.fixture-variant`, "oversize-schema\n");
  const identity = await captureCodexExecutableIdentity(fixture.launcherPath, {
    cwd: fixture.appCwd,
    env: environment,
  });
  await assert.rejects(
    generateAndEvaluateCodexSchema(identity, deployment, environment),
    /byte budget|schema generation failed/i,
  );
});

test("schema generation rejects an overfull cache root before launching Codex", async (t) => {
  const { fixture, deployment, environment, identity } = await acceptedFixture(t);
  await Promise.all(Array.from({ length: 129 }, (_, index) =>
    mkdir(`${deployment.schemaCacheDirectory}/entry-${index}`)));
  await assert.rejects(
    generateAndEvaluateCodexSchema(identity, deployment, environment),
    /root-entry budget/,
  );
  const invocations = await fixture.invocations();
  assert.equal(invocations.some((entry) => entry.args.includes("generate-json-schema")), false);
});
