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
  readCandidateGitIdentity,
} from "../scripts/probe-release-lifecycle.mjs";
import { createCodexRuntimeFixture } from "../scripts/support/codex-runtime-fixture.mjs";

test("release-lifecycle QA profile refuses household-shaped targets", () => {
  const household = process.env.HOME;
  assert.throws(() => assertDisposableProfile({ home: household, label: "com.ericfeunekes.meal-planner.qa.test", database: `${household}/meal-planner/data/planner.sqlite` }), /household HOME/u);
  assert.throws(() => assertDisposableProfile({ home: "/private/tmp/probe-home", label: "com.ericfeunekes.meal-planner", database: "/private/tmp/probe-home/meal-planner/data/planner.sqlite" }), /household|non-disposable/u);
});

test("release-lifecycle QA profile permits only its generated database location", () => {
  assert.doesNotThrow(() => assertDisposableProfile({ home: "/private/tmp/probe-home", label: "com.ericfeunekes.meal-planner.qa.test", database: "/private/tmp/probe-home/meal-planner/data/planner.sqlite" }));
  assert.throws(() => assertDisposableProfile({ home: "/private/tmp/probe-home", label: "com.ericfeunekes.meal-planner.qa.test", database: "/private/tmp/other.sqlite" }), /database/u);
});

test("release candidate evidence identifies the committed copied snapshot", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "planner-candidate-identity-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const candidate = join(temporary, "candidate");

  await copyCandidate(candidate);
  const identity = await readCandidateGitIdentity(candidate);

  assert.match(identity.commit, /^[0-9a-f]{40}$/u);
  assert.match(identity.tree, /^[0-9a-f]{40}$/u);
  assert.deepEqual(candidateIdentitySummary(identity), [
    `- candidate commit: ${identity.commit}`,
    `- candidate tree: ${identity.tree}`,
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
