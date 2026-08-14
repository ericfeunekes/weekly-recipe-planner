import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { superviseProcesses } from "./process-supervisor.mjs";
import { createDevelopmentProcessSpecifications } from "./runtime-processes.mjs";
import { prepareDevelopmentCodexHome } from "./support/codex-dev-home.mjs";
import {
  captureFoodSourceSnapshot,
  discardFoodSourceSnapshot,
} from "./support/production-agent-sources.mjs";

const development = await prepareDevelopmentCodexHome();
await mkdir(".scratch", { recursive: true, mode: 0o700 });
const runRoot = await mkdtemp(join(".scratch", "dev-food-"));
let snapshot;
try {
  snapshot = await captureFoodSourceSnapshot({ destinationRoot: runRoot });
  process.exitCode = await superviseProcesses(
    createDevelopmentProcessSpecifications({
      ...process.env,
      PLANNER_CODEX_HOME: development.codexHome,
      PLANNER_CODEX_CWD: snapshot.appRoot,
      PLANNER_RECIPE_ROOT: snapshot.recipeRoot,
    }),
  );
} finally {
  if (snapshot) await discardFoodSourceSnapshot(snapshot);
  await rm(runRoot, { recursive: true, force: true });
}
