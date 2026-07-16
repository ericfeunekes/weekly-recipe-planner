import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGlobalCodexIngress,
  createGlobalCodexIngressForTests,
  createGlobalCodexPlannerPort,
  createGlobalCodexRouter,
} from "./global-ingress/index.ts";
import { readRuntimeConfig } from "./runtime/config.ts";
import { createFailSoftManagedCodexFollowUpRuntime } from "./runtime/codex-follow-up/index.ts";
import {
  startPlannerRuntime,
  type PlannerRuntime,
  type PlannerRuntimeOptions,
} from "./runtime/planner-runtime.ts";
import {
  acquireRuntimeOwnershipLease,
  assertInheritedRuntimeOwnershipLease,
  RuntimeOwnershipError,
  runtimeOwnershipSocketPathForDataDirectory,
} from "../scripts/support/runtime-ownership.mjs";
import { assertInstalledReleaseStartable } from "../scripts/support/planner-release-contract.mjs";

type RuntimeOwnershipLease = Awaited<
  ReturnType<typeof acquireRuntimeOwnershipLease>
>;

type ConfiguredPlannerRuntimeOverrides = Pick<
  PlannerRuntimeOptions,
  "failureInjector" | "webProbe" | "shutdownGracePeriodMs"
> & {
  /** Host-only QA/release seam. Serialized or environment-derived leases are invalid. */
  runtimeOwnershipLease?: RuntimeOwnershipLease;
  /** Host-only QA/release seam. Production and spawned clients never receive this path. */
  globalCodexParentDirectory?: string;
};

export async function assertInstalledRuntimeSelection(
  environment: NodeJS.ProcessEnv,
  dependencies: {
    assertStartable?: typeof assertInstalledReleaseStartable;
  } = {},
): Promise<void> {
  if (environment.PLANNER_INSTALLED_RUNTIME === undefined) return;
  if (environment.PLANNER_INSTALLED_RUNTIME !== "1") {
    throw new TypeError("PLANNER_INSTALLED_RUNTIME must be 1 when present.");
  }
  const home = environment.HOME;
  const expectedActivationId = environment.PLANNER_EXPECTED_ACTIVATION_ID;
  const expectedOperatorSha256 = environment.PLANNER_EXPECTED_OPERATOR_SHA256;
  const expectedActivationSha256 = environment.PLANNER_EXPECTED_ACTIVATION_SHA256;
  if (
    home === undefined ||
    expectedActivationId === undefined ||
    expectedOperatorSha256 === undefined ||
    expectedActivationSha256 === undefined
  ) {
    throw new TypeError("Installed runtime selection identities are incomplete.");
  }
  const startable = await (
    dependencies.assertStartable ?? assertInstalledReleaseStartable
  )(home);
  if (
    startable.current.activationId !== expectedActivationId ||
    startable.current.operatorSha256 !== expectedOperatorSha256 ||
    startable.current.activationSha256 !== expectedActivationSha256
  ) {
    throw new Error(
      "The installed release selection changed before writer admission.",
    );
  }
}

export async function startConfiguredPlannerRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: ConfiguredPlannerRuntimeOverrides = {},
): Promise<PlannerRuntime> {
  const config = readRuntimeConfig(environment);
  const ownershipSocketPath = environment.PLANNER_RUNTIME_OWNER_SOCKET ??
    runtimeOwnershipSocketPathForDataDirectory(config.dataDirectory);
  const inheritedOwnershipLease = overrides.runtimeOwnershipLease;
  const globalCodexParentDirectory = overrides.globalCodexParentDirectory;
  if (
    globalCodexParentDirectory !== undefined &&
    (!isAbsolute(globalCodexParentDirectory) || globalCodexParentDirectory.includes("\u0000"))
  ) {
    throw new TypeError("The host-only Global Codex parent directory must be absolute.");
  }
  const ownershipLease = inheritedOwnershipLease === undefined
    ? await acquireRuntimeOwnershipLease({ socketPath: ownershipSocketPath })
    : await assertInheritedRuntimeOwnershipLease(inheritedOwnershipLease, {
        socketPath: ownershipSocketPath,
      });
  const closeOwnershipLease = inheritedOwnershipLease === undefined;
  try {
    await assertInstalledRuntimeSelection(environment);
    const codexRuntime = createFailSoftManagedCodexFollowUpRuntime(
      config.codexFollowUp,
      { sourceEnvironment: environment },
    );
    const runtimeOverrides: ConfiguredPlannerRuntimeOverrides = {
      ...(overrides.failureInjector === undefined
        ? {}
        : { failureInjector: overrides.failureInjector }),
      ...(overrides.webProbe === undefined ? {} : { webProbe: overrides.webProbe }),
      ...(overrides.shutdownGracePeriodMs === undefined
        ? {}
        : { shutdownGracePeriodMs: overrides.shutdownGracePeriodMs }),
    };
    const runtime = await startPlannerRuntime({
      config,
      codexRuntime,
      codexFixedCwd: config.codexFollowUp.ok
        ? config.codexFollowUp.deployment.appCwd
        : null,
      // This path has acquired or revalidated the host-only runtime owner lease.
      recoverCodexAdmissionsAfterOwnership: true,
      globalCodexIngressFactory: async (planner) =>
        globalCodexParentDirectory === undefined
          ? createGlobalCodexIngress(
              createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
            )
          : createGlobalCodexIngressForTests(
              createGlobalCodexRouter(createGlobalCodexPlannerPort(planner)),
              globalCodexParentDirectory,
            ),
      ...runtimeOverrides,
    });
    // SQLite establishes PLANNER_DATA_DIR before deployment validation
    // canonicalizes all three disjoint roots. Evaluation remains fail-soft and
    // starts before the configured runtime is returned to any caller.
    void codexRuntime.evaluate();

    if (!closeOwnershipLease) return runtime;
    let closePromise: Promise<void> | null = null;
    return {
      ...runtime,
      close() {
        if (closePromise !== null) return closePromise;
        closePromise = (async () => {
          let closeError: unknown;
          try {
            await runtime.close();
          } catch (error) {
            closeError = error;
          }
          try {
            await ownershipLease.close();
          } catch (error) {
            closeError ??= error;
          }
          if (closeError !== undefined) throw closeError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (closeOwnershipLease) {
      await ownershipLease.close().catch(() => undefined);
    }
    throw error;
  }
}

function publicUrl(runtime: PlannerRuntime) {
  const address = runtime.server.address();
  if (!address || typeof address === "string") return "the configured loopback socket";
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function main() {
  const runtime = await startConfiguredPlannerRuntime();
  console.log(`Weekly Recipe Planner authority listening at ${publicUrl(runtime)}.`);

  let shuttingDown = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void runtime.close()
        .catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        })
        .finally(() => {
          for (const [registeredSignal, registeredHandler] of signalHandlers) {
            process.off(registeredSignal, registeredHandler);
          }
        });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof RuntimeOwnershipError ? 3 : 1;
  });
}
