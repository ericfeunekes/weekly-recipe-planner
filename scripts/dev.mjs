import { superviseProcesses } from "./process-supervisor.mjs";
import { createDevelopmentProcessSpecifications } from "./runtime-processes.mjs";

process.exitCode = await superviseProcesses(
  createDevelopmentProcessSpecifications(),
);
