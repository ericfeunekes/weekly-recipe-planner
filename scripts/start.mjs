import { superviseProcesses } from "./process-supervisor.mjs";
import { createProductionProcessSpecifications } from "./runtime-processes.mjs";

process.exitCode = await superviseProcesses(
  createProductionProcessSpecifications(),
);
