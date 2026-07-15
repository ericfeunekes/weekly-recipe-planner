import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  createAuthenticatedAgentAdoptionEffect,
  createAuthenticatedAgentRestoreCoordinator,
  inspectPlannerReleaseAgentSource,
} from "../scripts/support/planner-agent-adoption.mjs";
import {
  createActivationId,
  derivePlannerReleaseLayout,
  ensurePrivateDirectory,
} from "../scripts/support/planner-release-contract.mjs";
import {
  createReleaseJournal,
  publishInitialReleaseJournal,
  readReleaseJournal,
  transitionReleaseJournal,
} from "../scripts/support/planner-release-transaction.mjs";

const CREDENTIAL_SENTINEL = "credential-sentinel-never-persist\n";
const OLD_CONFIG = "forced_login_method = \"chatgpt\"\n# old\n";
const OLD_INSTRUCTIONS = "# Old planner instructions\n";
const NEW_CONFIG = "forced_login_method = \"chatgpt\"\n# release\n";
const NEW_INSTRUCTIONS = "# Release planner instructions\n";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function publishRolledBackJournal(layout, activationId) {
  await publishInitialReleaseJournal(
    layout.journalPath,
    createReleaseJournal(activationId),
  );
  // Re-read the published identity so every replace uses the exact previous hash.
  let journal = await readReleaseJournal(layout.journalPath, activationId);
  for (const event of [
    "begin",
    "park_previous",
    "select_app",
    "select_data",
    "abort",
    "restore_app",
    "restore_data",
    "publish_rollback",
  ]) {
    journal = await transitionReleaseJournal(
      layout.journalPath,
      journal,
      event,
      event === "publish_rollback" ? { hashChainValid: true } : {},
    );
  }
  return journal;
}

async function adoptionFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-agent-adoption-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await ensurePrivateDirectory(home);
  const sourceActivationId = createActivationId();
  const sourceLayout = derivePlannerReleaseLayout(home, sourceActivationId);
  const activationId = createActivationId();
  const layout = derivePlannerReleaseLayout(home, activationId);
  for (const path of [
    layout.root,
    layout.releasesRoot,
    sourceLayout.transactionRoot,
    layout.transactionRoot,
  ]) {
    await ensurePrivateDirectory(path);
  }
  await publishRolledBackJournal(sourceLayout, sourceActivationId);
  const sourcePath = join(sourceLayout.transactionRoot, "superseded-agent");
  await mkdir(sourcePath, { mode: 0o700 });
  await Promise.all([
    writeFile(join(sourcePath, "auth.json"), CREDENTIAL_SENTINEL, { mode: 0o600 }),
    writeFile(join(sourcePath, "config.toml"), OLD_CONFIG, { mode: 0o600 }),
    writeFile(join(sourcePath, "AGENTS.md"), OLD_INSTRUCTIONS, { mode: 0o600 }),
    writeFile(join(sourcePath, "state.sqlite"), "state-not-credential\n", { mode: 0o600 }),
  ]);
  await mkdir(layout.agentRoot, { mode: 0o700 });
  await Promise.all([
    writeFile(join(layout.agentRoot, "config.toml"), NEW_CONFIG, { mode: 0o600 }),
    writeFile(join(layout.agentRoot, "AGENTS.md"), NEW_INSTRUCTIONS, { mode: 0o600 }),
  ]);
  const agentSource = await inspectPlannerReleaseAgentSource({ sourcePath, layout });
  const selectedAppPre = { state: "candidate_app_unselected" };
  const selectedAppPost = { state: "candidate_app_selected" };
  const context = {
    activationId,
    layout,
    stage: { projection: { agentSource } },
    journal: {
      entries: [{
        kind: "intent",
        effectId: "1:select_candidate_app",
        effect: "select_candidate_app",
        expected: { pre: selectedAppPre, post: selectedAppPost },
      }, {
        kind: "completed",
        effectId: "1:select_candidate_app",
        effect: "select_candidate_app",
        observed: selectedAppPost,
      }],
    },
  };
  return { root, sourcePath, layout, context, agentSource };
}

test("stage binds only safe dedicated-home metadata and excludes credential fingerprints", async (t) => {
  const value = await adoptionFixture(t);
  assert.equal(value.agentSource.sourcePath, value.sourcePath);
  assert.equal(value.agentSource.sourceDirectoryName, "superseded-agent");
  assert.deepEqual(Object.keys(value.agentSource.credentialFile).sort(), [
    "device",
    "inode",
    "linkCount",
    "mode",
    "ownerUid",
  ]);
  const serialized = JSON.stringify(value.agentSource);
  assert.equal(serialized.includes(CREDENTIAL_SENTINEL.trim()), false);
  assert.equal(
    serialized.includes(createHash("sha256").update(CREDENTIAL_SENTINEL).digest("hex")),
    false,
  );
  assert.equal(Object.hasOwn(value.agentSource.credentialFile, "size"), false);
  assert.equal(Object.hasOwn(value.agentSource.credentialFile, "sha256"), false);
});

test("stage rejects noncanonical and symlink aliases for the retained agent source", async (t) => {
  const value = await adoptionFixture(t);
  const noncanonicalPath = `${value.sourcePath}/../${basename(value.sourcePath)}`;
  await assert.rejects(
    inspectPlannerReleaseAgentSource({
      sourcePath: noncanonicalPath,
      layout: value.layout,
    }),
    /one real retained release directory/,
  );

  const aliasPath = join(dirname(value.sourcePath), "agent-source-alias");
  await symlink(value.sourcePath, aliasPath);
  await assert.rejects(
    inspectPlannerReleaseAgentSource({
      sourcePath: aliasPath,
      layout: value.layout,
    }),
    /one real retained release directory/,
  );
});

test("stage rejects a symlinked credential file", async (t) => {
  const value = await adoptionFixture(t);
  const authPath = join(value.sourcePath, "auth.json");
  await rm(authPath);
  await symlink(join(value.sourcePath, "state.sqlite"), authPath);

  await assert.rejects(
    inspectPlannerReleaseAgentSource({
      sourcePath: value.sourcePath,
      layout: value.layout,
    }),
    /credential file must be one real regular file/,
  );
});

test("stage rejects a hard-linked credential file", async (t) => {
  const value = await adoptionFixture(t);
  await link(
    join(value.sourcePath, "auth.json"),
    join(value.sourcePath, "auth-backup.json"),
  );

  await assert.rejects(
    inspectPlannerReleaseAgentSource({
      sourcePath: value.sourcePath,
      layout: value.layout,
    }),
    /one mode-0600 non-linked credential file/,
  );
});

for (const deploymentFile of ["config.toml", "AGENTS.md"]) {
  test(`stage rejects a retained agent source missing ${deploymentFile}`, async (t) => {
    const value = await adoptionFixture(t);
    await rm(join(value.sourcePath, deploymentFile));
    await assert.rejects(
      inspectPlannerReleaseAgentSource({
        sourcePath: value.sourcePath,
        layout: value.layout,
      }),
      new RegExp(`missing ${deploymentFile.replace(".", "\\.")}`),
    );
  });
}

test("adoption rejects an atomic credential replacement after stage inspection", async (t) => {
  const value = await adoptionFixture(t);
  const replacementPath = join(value.sourcePath, "auth-replacement.json");
  await writeFile(replacementPath, CREDENTIAL_SENTINEL, { mode: 0o600 });
  await rename(replacementPath, join(value.sourcePath, "auth.json"));

  await assert.rejects(
    createAuthenticatedAgentAdoptionEffect(value.context),
    /changed after staging/,
  );
  assert.equal(await exists(value.layout.agentRoot), true);
  assert.equal(await exists(value.sourcePath), true);
});

test("adoption rejects an atomic deployment replacement after stage inspection", async (t) => {
  const value = await adoptionFixture(t);
  const replacementPath = join(value.sourcePath, "config-replacement.toml");
  await writeFile(replacementPath, OLD_CONFIG, { mode: 0o600 });
  await rename(replacementPath, join(value.sourcePath, "config.toml"));

  await assert.rejects(
    createAuthenticatedAgentAdoptionEffect(value.context),
    /deployment changed after staging/,
  );
  assert.equal(await exists(value.layout.agentRoot), true);
  assert.equal(await exists(value.sourcePath), true);
});

const FORWARD_CHECKPOINTS = [
  "candidate_parked",
  "agent_selected",
  "config.toml:original_parked",
  "config.toml:candidate_selected",
  "AGENTS.md:original_parked",
  "AGENTS.md:candidate_selected",
];

for (const crashPoint of FORWARD_CHECKPOINTS) {
  test(`agent adoption resumes after ${crashPoint}`, async (t) => {
    const value = await adoptionFixture(t);
    let crashed = false;
    const effect = await createAuthenticatedAgentAdoptionEffect(value.context, {
      checkpoint(name) {
        if (!crashed && name === crashPoint) {
          crashed = true;
          throw new Error(`crash:${name}`);
        }
      },
    });
    await assert.rejects(effect.perform(), new RegExp(`crash:${crashPoint.replace(".", "\\.")}`));
    const recoveryIntent = {
      expected: effect.expected,
      replay: effect.replay,
    };
    const recovered = await createAuthenticatedAgentAdoptionEffect({
      ...value.context,
      recoveryIntent,
    });
    await recovered.perform();
    assert.equal((await recovered.inspect()).classification, "post");
    assert.equal(await exists(value.sourcePath), false);
    assert.equal(await readFile(join(value.layout.agentRoot, "auth.json"), "utf8"),
      CREDENTIAL_SENTINEL);
    assert.equal(await readFile(join(value.layout.agentRoot, "config.toml"), "utf8"),
      NEW_CONFIG);
    assert.equal(await readFile(join(value.layout.agentRoot, "AGENTS.md"), "utf8"),
      NEW_INSTRUCTIONS);
    assert.deepEqual(
      await readdir(join(value.layout.transactionRoot, "candidate-agent-home")),
      [],
    );
  });
}

for (const crashPoint of FORWARD_CHECKPOINTS) {
  test(`agent compensation reverses abandoned adoption after ${crashPoint}`, async (t) => {
    const value = await adoptionFixture(t);
    const effect = await createAuthenticatedAgentAdoptionEffect(value.context, {
      checkpoint(name) {
        if (name === crashPoint) throw new Error(`failure:${name}`);
      },
    });
    await assert.rejects(
      effect.perform(),
      new RegExp(`failure:${crashPoint.replace(".", "\\.")}`),
    );
    value.context.journal = {
      entries: [
        {
          kind: "intent",
          effectId: "1:adopt_authenticated_agent",
          effect: "adopt_authenticated_agent",
          expected: effect.expected,
          replay: effect.replay,
        },
        {
          kind: "abandoned",
          effectId: "1:adopt_authenticated_agent",
          effect: "adopt_authenticated_agent",
          observed: effect.expected.pre,
        },
      ],
    };

    const coordinator = await createAuthenticatedAgentRestoreCoordinator(value.context);
    await coordinator.perform();
    assert.equal(await coordinator.inspect(), "post");
    assert.equal(await exists(value.layout.agentRoot), false);
    assert.equal(await readFile(join(value.sourcePath, "auth.json"), "utf8"),
      CREDENTIAL_SENTINEL);
    assert.equal(await readFile(join(value.sourcePath, "config.toml"), "utf8"), OLD_CONFIG);
    assert.equal(await readFile(join(value.sourcePath, "AGENTS.md"), "utf8"), OLD_INSTRUCTIONS);
  });
}

test("agent compensation retains an unstarted candidate deployment", async (t) => {
  const value = await adoptionFixture(t);
  const coordinator = await createAuthenticatedAgentRestoreCoordinator(value.context);
  assert.equal(coordinator.replay.variant, "unadopted_candidate");
  assert.equal(await coordinator.inspect(), "pre");
  await coordinator.perform();
  assert.equal(await coordinator.inspect(), "post");
  assert.equal(await exists(value.layout.agentRoot), false);
  assert.equal(await readFile(join(value.sourcePath, "auth.json"), "utf8"),
    CREDENTIAL_SENTINEL);
  const retained = join(value.layout.transactionRoot, "superseded-agent");
  assert.equal(await readFile(join(retained, "config.toml"), "utf8"), NEW_CONFIG);
  assert.equal(await readFile(join(retained, "AGENTS.md"), "utf8"), NEW_INSTRUCTIONS);
});

test("zero-intent agent compensation reconstructs from its outer recovery intent", async (t) => {
  const value = await adoptionFixture(t);
  const coordinator = await createAuthenticatedAgentRestoreCoordinator(value.context);
  const recovered = await createAuthenticatedAgentRestoreCoordinator({
    ...value.context,
    recoveryIntent: {
      expected: {
        pre: { agentAdoption: coordinator.pre },
        post: { agentAdoption: coordinator.post },
      },
      replay: { agentAdoption: coordinator.replay },
    },
  });
  await recovered.perform();
  assert.equal(await recovered.inspect(), "post");
  assert.equal(await exists(value.layout.agentRoot), false);
  assert.equal(await readFile(join(value.sourcePath, "auth.json"), "utf8"),
    CREDENTIAL_SENTINEL);
});

test("agent compensation preserves a candidate deployment that was never materialized", async (t) => {
  const value = await adoptionFixture(t);
  await rm(value.layout.agentRoot, { recursive: true, force: true });
  value.context.journal = { entries: [] };
  const coordinator = await createAuthenticatedAgentRestoreCoordinator(value.context, {
    checkpoint(name) {
      if (name === "candidate_unmaterialized_marked") {
        throw new Error("failure:candidate_unmaterialized_marked");
      }
    },
  });

  assert.equal(coordinator.replay.variant, "unmaterialized_candidate");
  assert.equal(await coordinator.inspect(), "pre");
  await assert.rejects(
    coordinator.perform(),
    /failure:candidate_unmaterialized_marked/,
  );
  assert.equal(await coordinator.inspect(), "post");

  const recovered = await createAuthenticatedAgentRestoreCoordinator({
    ...value.context,
    recoveryIntent: {
      expected: {
        pre: { agentAdoption: coordinator.pre },
        post: { agentAdoption: coordinator.post },
      },
      replay: { agentAdoption: coordinator.replay },
    },
  });
  await recovered.perform();
  assert.equal(await recovered.inspect(), "post");
  assert.equal(await exists(value.layout.agentRoot), false);
  assert.equal(await exists(join(value.layout.transactionRoot, "candidate-agent-home")), false);
  assert.equal(await exists(join(value.layout.transactionRoot, "superseded-agent")), false);
  assert.equal(await readFile(join(value.sourcePath, "auth.json"), "utf8"),
    CREDENTIAL_SENTINEL);
  assert.equal(await readFile(join(value.sourcePath, "config.toml"), "utf8"), OLD_CONFIG);
  assert.equal(await readFile(join(value.sourcePath, "AGENTS.md"), "utf8"), OLD_INSTRUCTIONS);
});

test("agent compensation rejects duplicate adoption intents", async (t) => {
  const value = await adoptionFixture(t);
  const effect = await createAuthenticatedAgentAdoptionEffect(value.context);
  value.context.journal = {
    entries: ["1", "2"].flatMap((id) => [{
      kind: "intent",
      effectId: `${id}:adopt_authenticated_agent`,
      effect: "adopt_authenticated_agent",
      expected: effect.expected,
      replay: effect.replay,
    }, {
      kind: "abandoned",
      effectId: `${id}:adopt_authenticated_agent`,
      effect: "adopt_authenticated_agent",
      observed: effect.expected.pre,
    }]),
  };
  await assert.rejects(
    createAuthenticatedAgentRestoreCoordinator(value.context),
    /ambiguous agent-adoption intent history/,
  );
});

const REVERSE_CHECKPOINTS = [
  "AGENTS.md:candidate_restored",
  "AGENTS.md:original_restored",
  "config.toml:candidate_restored",
  "config.toml:original_restored",
  "source_restored",
  "candidate_retained",
];

for (const crashPoint of REVERSE_CHECKPOINTS) {
  test(`agent compensation restores the retained source after ${crashPoint}`, async (t) => {
    const value = await adoptionFixture(t);
    const effect = await createAuthenticatedAgentAdoptionEffect(value.context);
    await effect.perform();
    value.context.journal = {
      entries: [
        {
          kind: "intent",
          effectId: "1:adopt_authenticated_agent",
          effect: "adopt_authenticated_agent",
          expected: effect.expected,
          replay: effect.replay,
        },
        {
          kind: "completed",
          effectId: "1:adopt_authenticated_agent",
          effect: "adopt_authenticated_agent",
        },
      ],
    };
    let crashed = false;
    const coordinator = await createAuthenticatedAgentRestoreCoordinator(value.context, {
      checkpoint(name) {
        if (!crashed && name === crashPoint) {
          crashed = true;
          throw new Error(`crash:${name}`);
        }
      },
    });
    await assert.rejects(
      coordinator.perform(),
      new RegExp(`crash:${crashPoint.replace(".", "\\.")}`),
    );
    const recovered = await createAuthenticatedAgentRestoreCoordinator(value.context);
    await recovered.perform();
    assert.equal(await recovered.inspect(), "post");
    assert.equal(await exists(value.layout.agentRoot), false);
    assert.equal(await readFile(join(value.sourcePath, "auth.json"), "utf8"),
      CREDENTIAL_SENTINEL);
    assert.equal(await readFile(join(value.sourcePath, "config.toml"), "utf8"), OLD_CONFIG);
    assert.equal(await readFile(join(value.sourcePath, "AGENTS.md"), "utf8"), OLD_INSTRUCTIONS);
    const retained = join(value.layout.transactionRoot, "superseded-agent");
    assert.equal(await readFile(join(retained, "config.toml"), "utf8"), NEW_CONFIG);
    assert.equal(await readFile(join(retained, "AGENTS.md"), "utf8"), NEW_INSTRUCTIONS);
  });
}

test("agent adoption rejects retained-home metadata drift before journaling", async (t) => {
  const value = await adoptionFixture(t);
  await chmod(join(value.sourcePath, "auth.json"), 0o644);
  await assert.rejects(
    createAuthenticatedAgentAdoptionEffect(value.context),
    /changed after staging|mode-0600/,
  );
  assert.equal(await exists(value.layout.agentRoot), true);
  assert.equal(await exists(value.sourcePath), true);
});

test("agent compensation permits runtime files while preserving exact credential lineage", async (t) => {
  const value = await adoptionFixture(t);
  const effect = await createAuthenticatedAgentAdoptionEffect(value.context);
  await effect.perform();
  await writeFile(join(value.layout.agentRoot, ".runtime-state.json"), "{}\n", {
    mode: 0o600,
  });
  value.context.journal = {
    entries: [
      {
        kind: "intent",
        effectId: "1:adopt_authenticated_agent",
        effect: "adopt_authenticated_agent",
        expected: effect.expected,
        replay: effect.replay,
      },
      {
        kind: "completed",
        effectId: "1:adopt_authenticated_agent",
        effect: "adopt_authenticated_agent",
      },
    ],
  };

  const coordinator = await createAuthenticatedAgentRestoreCoordinator(value.context);
  await coordinator.perform();
  assert.equal(await coordinator.inspect(), "post");
  assert.equal(await readFile(join(value.sourcePath, ".runtime-state.json"), "utf8"), "{}\n");
  assert.equal(await readFile(join(value.sourcePath, "auth.json"), "utf8"),
    CREDENTIAL_SENTINEL);
});
