import { spawn } from "node:child_process";
import { cp, lstat, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { shouldStageApplicationPath } from "./support/deployment-staging-filter.mjs";
import {
  reconcileProductionAgentConfig,
  validateProductionAgentSources,
} from "./support/production-agent-sources.mjs";
import { assertProductionDataCompatible } from "./support/production-data-compatibility.mjs";
import { cleanupLegacyApplicationBackups } from "./support/production-legacy-cleanup.mjs";
import {
  assertDisposableReleaseProbeProfile,
  waitForDisposableReleaseProbeBarrier,
} from "./support/production-release-probe-hooks.mjs";
import {
  createProductionReleaseLifecycle,
  productionReleasePaths,
} from "./support/production-release.mjs";
import {
  createProductionService,
  productionServicePaths,
} from "./support/production-service.mjs";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(" ")} failed (${code}).`)));
  });
}

async function disposableRenameFaultFilesystem({ environment, home, label, paths }) {
  const fault = environment.PLANNER_PROBE_FAIL_NEXT_RENAME;
  if (!fault) return undefined;
  const ordinal = Number(fault);
  await assertDisposableReleaseProbeProfile({ home, label, paths });
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 3) {
    throw new Error("PLANNER_PROBE_FAIL_NEXT_RENAME is limited to the generated disposable release-lifecycle profile.");
  }
  let remaining = ordinal;
  return {
    async rename(from, to) {
      remaining -= 1;
      if (remaining === 0) throw new Error(`Disposable release probe injected rename ${ordinal} failure: ${from} -> ${to}`);
      return rename(from, to);
    },
  };
}

async function disposableReadinessTimeout({ environment, home, label, paths }) {
  const id = environment.PLANNER_PROBE_FAIL_NEXT_READINESS;
  if (!id) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error("PLANNER_PROBE_FAIL_NEXT_READINESS is invalid.");
  }
  await assertDisposableReleaseProbeProfile({ home, label, paths });
  return 10_000;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Internal adapter imported only by the detached-main promotion entrypoint. */
export async function deployProductionCandidate({
  environment = process.env,
  root = process.cwd(),
} = {}) {
  const home = resolve(environment.HOME ?? homedir());
  const candidateRoot = resolve(root);
  const label = environment.PLANNER_LAUNCHD_LABEL ?? "com.ericfeunekes.meal-planner";
  const port = Number(environment.PLANNER_PORT ?? 8642);
  const privateWebPort = Number(environment.PLANNER_PRIVATE_WEB_PORT ?? 3002);
  const releasePaths = productionReleasePaths(home);
  const servicePaths = productionServicePaths({ home, label });

  if (!(await exists(join(candidateRoot, "dist")))) {
    throw new Error("Build output is missing; promotion gates must build the mounted candidate first.");
  }
  if (!(await exists(releasePaths.data))) {
    throw new Error("Production planner data is missing.");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new TypeError("PLANNER_PORT is invalid.");
  }
  if (!Number.isInteger(privateWebPort) || privateWebPort < 1024 || privateWebPort > 65_535 || privateWebPort === port) {
    throw new TypeError("PLANNER_PRIVATE_WEB_PORT is invalid or conflicts with PLANNER_PORT.");
  }
  if (servicePaths.deployRoot !== releasePaths.deployRoot || servicePaths.appRoot !== releasePaths.app) {
    throw new TypeError("Production release and service paths disagree.");
  }

  await mkdir(servicePaths.agentRoot, { recursive: true, mode: 0o700 });
  const readinessTimeoutMs = await disposableReadinessTimeout({
    environment,
    home,
    label,
    paths: releasePaths,
  });
  const productionService = createProductionService({
    paths: servicePaths,
    port,
    privateWebPort,
    tailnetOrigin: environment.PLANNER_TAILNET_ORIGIN,
  });
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
      await productionService.waitForReady(readinessTimeoutMs);
    },
    ready() {
      return productionService.probeReadiness();
    },
  };

  const lifecycle = createProductionReleaseLifecycle({
    home,
    paths: releasePaths,
    service,
    async prepareCandidate(paths) {
      await cp(candidateRoot, paths.staging, {
        recursive: true,
        filter(source) {
          return shouldStageApplicationPath(source, candidateRoot);
        },
      });
      if (!(await exists(join(paths.staging, "package.json")))) {
        throw new Error("Staged application is missing package.json.");
      }
      await run("npm", ["ci"], { cwd: paths.staging, env: environment });
    },
    compatibilityPreflight(paths) {
      return assertProductionDataCompatible(paths.data);
    },
    cleanupLegacyResidue: cleanupLegacyApplicationBackups,
    filesystem: await disposableRenameFaultFilesystem({ environment, home, label, paths: releasePaths }),
    async reconcile() {
      await reconcileProductionAgentConfig(home);
      await validateProductionAgentSources(home);
      await productionService.writePlist();
    },
  });

  await waitForDisposableReleaseProbeBarrier({
    id: environment.PLANNER_PROBE_PROMOTION_BARRIER,
    operation: "promotion",
    home,
    label,
    paths: releasePaths,
  });
  await lifecycle.promote();
  console.log("Planner promotion selected a ready candidate; app.previous remains recoverable.");
}
