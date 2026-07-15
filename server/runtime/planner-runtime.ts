import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import {
  createCanonicalSeed,
  transformLegacyV2,
} from "../../lib/household-bootstrap.ts";
import {
  householdDomain,
  type HouseholdCommandContext,
  type HouseholdDomainPort,
} from "../../lib/household-domain.ts";
import type {
  GlobalCodexHealth,
  HealthResponse,
  LegacyV2Payload,
  LegacyV2TransformResult,
} from "../../lib/planner-api-contract.ts";
import { createPlannerApplicationService } from "../application/planner-service.ts";
import type {
  ChatApplicationService,
  Clock,
  FailureInjector,
  IdFactory,
} from "../application/ports.ts";
import {
  createEmbeddedChatApplicationService,
  createManagedEmbeddedChatApplicationService,
  type ResearchWebSearchEvidenceObservation,
} from "../chat/index.ts";
import { createNativeCodexSession } from "../codex/native-session.ts";
import { createNativePlannerEffectHost } from "../codex/planner-effect-host.ts";
import {
  createNativeCodexThreadService,
  type NativeCodexThreadService,
} from "../codex/thread-service.ts";
import type { GlobalCodexIngress } from "../global-ingress/index.ts";
import { createApplicationRouter } from "../http/application-router.ts";
import { createFrontController, type HttpHandler } from "../http/front-controller.ts";
import { closeHttpServer, listenHttpServer } from "../http/server.ts";
import { openPlannerStore, type SqlitePlannerStore } from "../store/sqlite-store.ts";
import { createSqliteCodexThreadStore } from "../store/codex-thread-store.ts";
import type { PlannerRuntimeConfig } from "./config.ts";
import type {
  CodexFollowUpRuntime,
  CodexFollowUpStatus,
} from "./codex-follow-up/index.ts";

const NO_FAILURES: FailureInjector = { hit() {} };
const SYSTEM_CLOCK: Clock = { now: () => Date.now() };
const RANDOM_IDS: IdFactory = {
  createId(prefix) {
    return `${prefix}_${randomUUID()}`;
  },
};

type RuntimeGlobalCodexIngress = {
  readStatus(): GlobalCodexHealth;
  close(): Promise<void>;
};

const INACTIVE_GLOBAL_CODEX_INGRESS: RuntimeGlobalCodexIngress = Object.freeze({
  readStatus: (): GlobalCodexHealth => ({
    status: "unavailable",
    reason: "Global Codex ingress is not configured.",
  }),
  close: async () => undefined,
});

export type PlannerRuntimeOptions = {
  config: PlannerRuntimeConfig;
  codexRuntime: CodexFollowUpRuntime;
  codexFixedCwd: string | null;
  globalCodexIngressFactory?: (
    planner: ReturnType<typeof createPlannerApplicationService>,
  ) => Promise<GlobalCodexIngress>;
  clock?: Clock;
  idFactory?: IdFactory;
  failureInjector?: FailureInjector;
  domain?: HouseholdDomainPort;
  store?: SqlitePlannerStore;
  seedFactory?: () => ReturnType<typeof createCanonicalSeed>;
  legacyTransformer?: (payload: LegacyV2Payload) => LegacyV2TransformResult;
  webProbe?: (origin: URL) => Promise<boolean>;
  shutdownGracePeriodMs?: number;
  researchEvidenceObserver?: (observation: ResearchWebSearchEvidenceObservation) => void;
  /**
   * Host-only proof that the caller already owns the exclusive planner runtime
   * lease and may adopt native admissions left by a crashed predecessor.
   */
  recoverCodexAdmissionsAfterOwnership?: boolean;
};

export type PlannerRuntime = {
  server: Server;
  store: SqlitePlannerStore;
  planner: ReturnType<typeof createPlannerApplicationService>;
  chat: ChatApplicationService;
  codexThreads: NativeCodexThreadService | null;
  interruptedTurns: number;
  evaluate(): Promise<CodexFollowUpStatus>;
  readCodexStatus(): CodexFollowUpStatus;
  close(): Promise<void>;
};

function bootstrapContext(clock: Clock, idFactory: IdFactory): HouseholdCommandContext {
  return {
    now: clock.now(),
    createId: (prefix) => idFactory.createId(prefix),
  };
}

async function probeWebOrigin(origin: URL): Promise<boolean> {
  try {
    const response = await fetch(origin, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(1_500),
      headers: { "User-Agent": "weekly-recipe-planner-health" },
    });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

function createHealthReader({
  config,
  store,
  planner,
  codexRuntime,
  globalCodexIngress,
  webProbe,
}: {
  config: PlannerRuntimeConfig;
  store: SqlitePlannerStore;
  planner: ReturnType<typeof createPlannerApplicationService>;
  codexRuntime: Pick<CodexFollowUpRuntime, "readStatus">;
  globalCodexIngress: Pick<RuntimeGlobalCodexIngress, "readStatus">;
  webProbe: (origin: URL) => Promise<boolean>;
}) {
  return async (): Promise<HealthResponse> => {
    let storeReady = false;
    let applicationReady = false;
    let initialized = false;

    try {
      store.checkIntegrity();
      storeReady = true;
    } catch {
      storeReady = false;
    }

    if (storeReady) {
      try {
        const workspace = planner.readWorkspace();
        initialized = workspace.initialized;
        applicationReady = true;
      } catch {
        applicationReady = false;
      }
    }

    const webReady = await webProbe(config.webOrigin).catch(() => false);
    let codex: CodexFollowUpStatus;
    try {
      codex = codexRuntime.readStatus();
    } catch {
      codex = {
        state: "unavailable",
        authenticated: null,
        protocolCompatible: null,
        cacheHit: false,
        evidence: null,
        detail: "Embedded Codex status is unavailable.",
      };
    }
    const codexStatus = codex.state === "compatible" &&
        codex.authenticated === true && codex.protocolCompatible === true
      ? "ready"
      : codex.state === "checking" || codex.state === "unauthenticated"
        ? "degraded"
        : "unavailable";
    const coreReady = storeReady && applicationReady && webReady;
    let globalCodex = INACTIVE_GLOBAL_CODEX_INGRESS.readStatus();
    try {
      globalCodex = globalCodexIngress.readStatus();
    } catch {
      globalCodex = {
        status: "unavailable",
        reason: "Global Codex ingress status is unavailable.",
      };
    }

    return {
      status: !coreReady ? "unavailable" : codexStatus === "ready" ? "ready" : "degraded",
      web: { status: webReady ? "ready" : "unavailable" },
      application: {
        status: applicationReady ? "ready" : "unavailable",
        initialized,
      },
      store: {
        status: storeReady ? "ready" : "unavailable",
        quickCheck: storeReady ? "ok" : "failed",
      },
      codex: {
        status: codexStatus,
        state: codex.state,
        authenticated: codex.authenticated,
        protocolCompatible: codex.protocolCompatible,
      },
      globalCodex,
    };
  };
}

export async function startPlannerRuntime(
  options: PlannerRuntimeOptions,
): Promise<PlannerRuntime> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const idFactory = options.idFactory ?? RANDOM_IDS;
  const failureInjector = options.failureInjector ?? NO_FAILURES;
  const store =
    options.store ?? openPlannerStore({ filename: options.config.databasePath });
  let globalCodexIngress = INACTIVE_GLOBAL_CODEX_INGRESS;
  try {
    const context = () => bootstrapContext(clock, idFactory);
    const planner = createPlannerApplicationService({
      store,
      domain: options.domain ?? householdDomain,
      seedFactory: options.seedFactory ?? (() => createCanonicalSeed(context())),
      transformLegacyV2:
        options.legacyTransformer ??
        ((payload) => transformLegacyV2(payload, context())),
      clock,
      idFactory,
      failureInjector,
    });
    if (options.globalCodexIngressFactory !== undefined) {
      try {
        globalCodexIngress = await options.globalCodexIngressFactory(planner);
      } catch {
        globalCodexIngress = {
          readStatus: () => ({
            status: "unavailable",
            reason: "Global Codex ingress could not start.",
          }),
          close: async () => undefined,
        };
      }
    }
    const chatDependencies = {
      transactionRunner: store,
      persistence: store,
      plannerMutationKernel: planner,
      plannerRead: store,
      clock,
      idFactory,
      failureInjector,
      ...(options.researchEvidenceObserver === undefined
        ? {}
        : { researchEvidenceObserver: options.researchEvidenceObserver }),
      isCodexReady: () => {
        try {
          const status = options.codexRuntime.readStatus();
          return status.state === "compatible" &&
            status.authenticated === true && status.protocolCompatible === true;
        } catch {
          return false;
        }
      },
    };
    const chat = options.codexFixedCwd === null
      ? createEmbeddedChatApplicationService(chatDependencies)
      : createManagedEmbeddedChatApplicationService({
          ...chatDependencies,
          executionProvider: options.codexRuntime,
          fixedCwd: options.codexFixedCwd,
        });
    let nativeSession: ReturnType<typeof createNativeCodexSession> | null = null;
    let codexThreads: NativeCodexThreadService | null = null;
    if (options.codexFixedCwd !== null) {
      const codexStore = createSqliteCodexThreadStore(store);
      const plannerEffectHost = createNativePlannerEffectHost({
        planner,
        store: codexStore,
        isEligibleCall: (threadId, turnId) =>
          nativeSession?.isEligibleRootTurn(threadId, turnId) === true,
        now: () => clock.now(),
      });
      nativeSession = createNativeCodexSession({
        execution: options.codexRuntime,
        fixedCwd: options.codexFixedCwd,
        dispatchPlannerTool: (params) => plannerEffectHost.handle(params),
        now: () => clock.now(),
      });
      codexThreads = createNativeCodexThreadService({
        session: nativeSession,
        store: codexStore,
        now: () => clock.now(),
        recoverAdmissionsOnStartup:
          options.recoverCodexAdmissionsAfterOwnership === true,
      });
    }
    const interruptedTurns = chat.interruptRunningTurns();
    const apiHandler = createApplicationRouter(
      {
        planner,
        chat,
        ...(codexThreads === null ? {} : { codex: codexThreads }),
        readHealth: createHealthReader({
          config: options.config,
          store,
          planner,
          codexRuntime: options.codexRuntime,
          globalCodexIngress,
          webProbe: options.webProbe ?? probeWebOrigin,
        }),
      },
      {
        allowedOrigins: options.config.allowedOrigins,
        allowOriginlessMutations: false,
        now: () => clock.now(),
      },
    );
    const handler: HttpHandler =
      options.config.mode === "front"
        ? createFrontController({
            apiHandler,
            webOrigin: options.config.webOrigin,
          })
        : apiHandler;
    const server = await listenHttpServer({
      handler,
      host: options.config.host,
      port: options.config.port,
    });

    let closePromise: Promise<void> | null = null;
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const serverClose = closeHttpServer(server, {
          gracePeriodMs: options.shutdownGracePeriodMs,
        });
        let closeError: unknown;
        try {
          await codexThreads?.close();
        } catch (error) {
          closeError = error;
        }
        try {
          await options.codexRuntime.close();
        } catch (error) {
          closeError ??= error;
        }
        try {
          await globalCodexIngress.close();
        } catch (error) {
          closeError ??= error;
        }
        try {
          await serverClose;
        } catch (error) {
          closeError ??= error;
        }
        try {
          store.close();
        } catch (error) {
          closeError ??= error;
        }
        if (closeError) throw closeError;
      })();
      return closePromise;
    };

    return {
      server,
      store,
      planner,
      chat,
      codexThreads,
      interruptedTurns,
      evaluate: () => options.codexRuntime.evaluate(),
      readCodexStatus: () => options.codexRuntime.readStatus(),
      close,
    };
  } catch (error) {
    try {
      await options.codexRuntime.close();
    } catch {
      // Startup failure remains the primary diagnostic.
    }
    try {
      await globalCodexIngress.close();
    } catch {
      // Startup failure remains the primary diagnostic.
    }
    try {
      store.close();
    } catch {
      // Startup failure remains the primary diagnostic.
    }
    throw error;
  }
}
