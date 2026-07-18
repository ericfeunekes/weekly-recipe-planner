import { superviseProcesses } from "./process-supervisor.mjs";
import { createDevelopmentProcessSpecifications } from "./runtime-processes.mjs";
import { prepareDevelopmentCodexHome } from "./support/codex-dev-home.mjs";

const development = await prepareDevelopmentCodexHome();
process.exitCode = await superviseProcesses(
  createDevelopmentProcessSpecifications({
    ...process.env,
    PLANNER_CODEX_HOME: development.codexHome,
    PLANNER_CODEX_CWD: development.appRoot,
  }),
);
