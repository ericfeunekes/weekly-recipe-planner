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
  HealthResponse,
  LegacyV2Payload,
  LegacyV2TransformResult,
} from "../../lib/planner-api-contract.ts";
import { createPlannerApplicationService } from "../application/planner-service.ts";
import type {
  Clock,
  CodexPlannerAdapter,
  FailureInjector,
  IdFactory,
} from "../application/ports.ts";
import { createChatApplicationService } from "../chat/index.ts";
import { createApplicationRouter } from "../http/application-router.ts";
import { createFrontController, type HttpHandler } from "../http/front-controller.ts";
import { closeHttpServer, listenHttpServer } from "../http/server.ts";
import { openPlannerStore, type SqlitePlannerStore } from "../store/sqlite-store.ts";
import type { PlannerRuntimeConfig } from "./config.ts";

const NO_FAILURES: FailureInjector = { hit() {} };
const SYSTEM_CLOCK: Clock = { now: () => Date.now() };
const RANDOM_IDS: IdFactory = {
  createId(prefix) {
    return `${prefix}_${randomUUID()}`;
  },
};

export type PlannerRuntimeOptions = {
  config: PlannerRuntimeConfig;
  codexAdapter: CodexPlannerAdapter;
  closeCodex?: () => void | Promise<void>;
  clock?: Clock;
  idFactory?: IdFactory;
  failureInjector?: FailureInjector;
  domain?: HouseholdDomainPort;
  store?: SqlitePlannerStore;
  seedFactory?: () => ReturnType<typeof createCanonicalSeed>;
  legacyTransformer?: (payload: LegacyV2Payload) => LegacyV2TransformResult;
  webProbe?: (origin: URL | null) => Promise<boolean>;
};

export type PlannerRuntime = {
  server: Server;
  store: SqlitePlannerStore;
  planner: ReturnType<typeof createPlannerApplicationService>;
  chat: ReturnType<typeof createChatApplicationService>;
  interruptedTurns: number;
  close(): Promise<void>;
};

function bootstrapContext(clock: Clock, idFactory: IdFactory): HouseholdCommandContext {
  return {
    now: clock.now(),
    createId: (prefix) => idFactory.createId(prefix),
  };
}

async function probeWebOrigin(origin: URL | null): Promise<boolean> {
  if (!origin) return true;
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
  codexAdapter,
  webProbe,
}: {
  config: PlannerRuntimeConfig;
  store: SqlitePlannerStore;
  planner: ReturnType<typeof createPlannerApplicationService>;
  codexAdapter: CodexPlannerAdapter;
  webProbe: (origin: URL | null) => Promise<boolean>;
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

    const [webReady, codex] = await Promise.all([
      webProbe(config.webOrigin).catch(() => false),
      codexAdapter.readStatus().catch(() => ({
        available: false,
        authenticated: null,
        detail: "Codex status is unavailable.",
      })),
    ]);
    const codexStatus =
      codex.available && codex.authenticated === true
        ? "ready"
        : codex.available
          ? "degraded"
          : "unavailable";
    const coreReady = storeReady && applicationReady && webReady;

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
        authenticated: codex.authenticated,
      },
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
  const chat = createChatApplicationService({
    transactionRunner: store,
    persistence: store,
    plannerMutationKernel: planner,
    plannerRead: store,
    clock,
    idFactory,
    failureInjector,
    codexAdapter: options.codexAdapter,
  });
  const interruptedTurns = chat.interruptRunningTurns();
  const apiHandler = createApplicationRouter(
    {
      planner,
      chat,
      readHealth: createHealthReader({
        config: options.config,
        store,
        planner,
        codexAdapter: options.codexAdapter,
        webProbe: options.webProbe ?? probeWebOrigin,
      }),
    },
    {
      allowedOrigins: options.config.allowedOrigins,
      allowOriginlessMutations: false,
    },
  );

  let handler: HttpHandler = apiHandler;
  if (options.config.mode === "front") {
    if (!options.config.webOrigin) {
      store.close();
      throw new TypeError("Front-controller mode requires an internal web origin.");
    }
    handler = createFrontController({ apiHandler, webOrigin: options.config.webOrigin });
  }

  let server: Server;
  try {
    server = await listenHttpServer({
      handler,
      host: options.config.host,
      port: options.config.port,
    });
  } catch (error) {
    await options.closeCodex?.();
    store.close();
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const serverClose = closeHttpServer(server);
      let closeError: unknown;
      try {
        await options.closeCodex?.();
      } catch (error) {
        closeError = error;
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

  return { server, store, planner, chat, interruptedTurns, close };
}
