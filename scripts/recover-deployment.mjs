import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  reconcileProductionAgentConfig,
  validateProductionAgentSources,
} from "./support/production-agent-sources.mjs";
import { cleanupLegacyApplicationBackups } from "./support/production-legacy-cleanup.mjs";
import { waitForDisposableReleaseProbeBarrier } from "./support/production-release-probe-hooks.mjs";
import {
  createProductionReleaseLifecycle,
  productionReleasePaths,
} from "./support/production-release.mjs";
import {
  createProductionService,
  productionServicePaths,
} from "./support/production-service.mjs";
import { acquireRuntimeOwnershipLease } from "./support/runtime-ownership.mjs";

const home = resolve(process.env.HOME ?? homedir());
const label = process.env.PLANNER_LAUNCHD_LABEL ?? "com.ericfeunekes.meal-planner";
const port = Number(process.env.PLANNER_PORT ?? 8642);
const releasePaths = productionReleasePaths(home);
const servicePaths = productionServicePaths({ home, label });

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new TypeError("PLANNER_PORT is invalid.");
}
if (servicePaths.deployRoot !== releasePaths.deployRoot || servicePaths.appRoot !== releasePaths.app) {
  throw new TypeError("Production release and service paths disagree.");
}

await mkdir(servicePaths.agentRoot, { recursive: true, mode: 0o700 });
const recoveryProbe = await waitForDisposableReleaseProbeBarrier({
  id: process.env.PLANNER_PROBE_RECOVERY_BARRIER,
  operation: "recovery",
  home,
  label,
  paths: releasePaths,
});
const productionService = createProductionService({ paths: servicePaths, port });
const service = {
  async quiesce() {
    await productionService.bootout().catch(() => undefined);
    await productionService.waitForAbsent().catch(() => undefined);
    const [loaded, portQuiet, runtimeOwnerQuiet] = await Promise.all([
      productionService.isLoaded().catch(() => true),
      productionService.isPortQuiet().catch(() => false),
      productionService.isRuntimeOwnerQuiet().catch(() => false),
    ]);
    return { unloaded: !loaded, portQuiet: portQuiet && runtimeOwnerQuiet };
  },
  async bootstrap() {
    await productionService.bootstrap();
    await productionService.waitForReady();
  },
  ready() {
    return productionService.probeReadiness();
  },
};

const lifecycle = createProductionReleaseLifecycle({
  home,
  paths: releasePaths,
  service,
  async acquireLease(options) {
    const lease = await acquireRuntimeOwnershipLease(options);
    // The generated disposable two-party probe holds its winner long enough
    // for the other shipped command to attempt the same real Unix lease.
    if (recoveryProbe) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    return lease;
  },
  cleanupLegacyResidue: cleanupLegacyApplicationBackups,
  async reconcile() {
    await reconcileProductionAgentConfig(home);
    await validateProductionAgentSources(home);
    await productionService.writePlist();
  },
});

const result = await lifecycle.recover();
console.log(result.changed
  ? "Planner recovery restored the immediately previous app and proved readiness."
  : "Planner recovery kept the ready selected app.");
