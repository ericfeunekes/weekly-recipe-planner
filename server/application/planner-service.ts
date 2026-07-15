import { createHash } from "node:crypto";

import {
  validateCanonicalHouseholdBatchBase,
  type HouseholdDomainPort,
} from "../../lib/household-domain.ts";
import type { HouseholdPlannerState } from "../../lib/household-contract.ts";
import {
  DIAGNOSTIC_EXPORT_FORMAT_VERSION,
  DIAGNOSTIC_EXPORT_KIND,
  DIAGNOSTIC_EXPORT_WARNING,
  isBootstrapWorkspaceRequest,
  isDiagnosticExportMarker,
  normalizePageRequest,
  type ApiErrorCode,
  type ApplyPlannerCommandRequest,
  type ApplyPlannerCommandResponse,
  type BootstrapWorkspaceRequest,
  type BootstrapWorkspaceResponse,
  type ExportEnvelope,
  type LegacyV2Payload,
  type LegacyV2TransformResult,
  type OperationKind,
  type OperationReceipt,
  type PlannerCommandDecision,
  type PlannerEventPage,
  type TranscriptPage,
  type UndoLatestRequest,
  type WorkspaceResponse,
} from "../../lib/planner-api-contract.ts";
import {
  BROWSER_PROVENANCE,
  GENERATED_AFTER_APPLY,
  isApplyPlannerOperationsRequest,
  isPreviewPlannerOperationsRequest,
  isValidPlannerMutationContext,
  plannerActorForProvenance,
  type ApplyPlannerOperationsRequest,
  type ApplyPlannerOperationsResponse,
  type PlannerMutationContext,
  type PlannerOperationPreview,
  type PlannerOperationsDecision,
  type PreviewPlannerOperationsRequest,
  type PreviewPlannerOperationsResponse,
} from "../../lib/planner-operation-contract.ts";
import type {
  Clock,
  FailureInjector,
  IdFactory,
  PlannerApplicationService,
  PlannerMutationKernel,
} from "./ports.ts";
import {
  PlannerStoreError,
  type SqlitePlannerStore,
  type SqliteTransaction,
} from "../store/sqlite-store.ts";

const NO_FAILURES: FailureInjector = { hit() {} };

export type LegacyV2Transformer = (payload: LegacyV2Payload) => LegacyV2TransformResult;
export type SeedFactory = () => HouseholdPlannerState;

export type CreatePlannerApplicationServiceOptions = {
  store: SqlitePlannerStore;
  domain: HouseholdDomainPort;
  seedFactory: SeedFactory;
  transformLegacyV2: LegacyV2Transformer;
  clock: Clock;
  idFactory: IdFactory;
  failureInjector?: FailureInjector;
};

export class PlannerServiceError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly workspace?: WorkspaceResponse;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    {
      httpStatus = 500,
      workspace,
      fieldErrors,
      cause,
    }: {
      httpStatus?: number;
      workspace?: WorkspaceResponse;
      fieldErrors?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PlannerServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.workspace = workspace;
    this.fieldErrors = fieldErrors;
  }
}

type StoredPlannerDecision = {
  kind: "planner_decision";
  decision: PlannerCommandDecision | PlannerOperationsDecision;
};

type StoredBootstrapDecision =
  | { kind: "bootstrap_accepted"; imported: boolean }
  | { kind: "bootstrap_rejected"; code: "ALREADY_INITIALIZED"; message: string };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalPayloadJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashCanonicalPayload(operationKind: OperationKind, value: unknown): string {
  return createHash("sha256")
    .update(canonicalPayloadJson({ operationKind, value }))
    .digest("hex");
}

function mapStoreError(error: unknown): never {
  if (error instanceof PlannerServiceError) throw error;
  if (error instanceof PlannerStoreError) {
    const code =
      error.code === "NOT_INITIALIZED"
        ? "NOT_INITIALIZED"
        : error.code === "BUSY"
          ? "UNAVAILABLE"
          : "STORE_CORRUPT";
    throw new PlannerServiceError(code, error.message, {
      httpStatus: code === "NOT_INITIALIZED" ? 409 : 503,
      cause: error,
    });
  }
  throw error;
}

function receipt(
  operationKind: OperationKind,
  requestId: string,
  payloadHash: string,
  httpStatus: number,
  decision: StoredPlannerDecision | StoredBootstrapDecision,
  createdAt: number,
): OperationReceipt {
  return { operationKind, requestId, payloadHash, httpStatus, decision, createdAt };
}

function assertReceiptPayload(existing: OperationReceipt, payloadHash: string): void {
  if (existing.payloadHash !== payloadHash) {
    throw new PlannerServiceError(
      "REQUEST_ID_REUSE",
      "The request ID was already used with a different payload.",
      { httpStatus: 409 },
    );
  }
}

function asPlannerOperationsDecision(
  decision: PlannerCommandDecision | PlannerOperationsDecision,
): PlannerOperationsDecision {
  return decision.status === "domain_rejected" && !("operationIndex" in decision)
    ? { ...decision, operationIndex: 0 }
    : decision;
}

function asPlannerCommandDecision(
  decision: PlannerOperationsDecision,
): PlannerCommandDecision {
  return decision.status === "domain_rejected"
    ? { status: "domain_rejected", message: decision.message }
    : decision;
}

function plannerOperationsPayloadForHash(
  request: ApplyPlannerOperationsRequest,
  context: PlannerMutationContext,
): unknown {
  if (context.operationKind === "planner_command" || context.operationKind === "planner_chat_command") {
    return {
      requestId: request.requestId,
      basePlannerVersion: request.basePlannerVersion,
      command: request.operations[0]?.command,
    };
  }
  return {
    basePlannerVersion: request.basePlannerVersion,
    operations: request.operations,
  };
}

function replaceGeneratedIds(text: string, generatedIds: string[]): string {
  return [...generatedIds]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, generatedId) => redacted.split(generatedId).join(GENERATED_AFTER_APPLY),
      text,
    );
}

function validateState(
  domain: HouseholdDomainPort,
  state: HouseholdPlannerState,
  {
    code = "STORE_CORRUPT",
    httpStatus = 503,
  }: { code?: ApiErrorCode; httpStatus?: number } = {},
): void {
  const validation = domain.validateState(state);
  if (!validation.ok) {
    const fieldErrors = Object.fromEntries(
      validation.issues.map((issue) => [issue.path, issue.message]),
    );
    throw new PlannerServiceError(
      code,
      `Household state is invalid: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
      { httpStatus, fieldErrors },
    );
  }
}

function validateCanonicalBatchBase(
  domain: HouseholdDomainPort,
  state: HouseholdPlannerState,
  commands: Parameters<HouseholdDomainPort["validateCanonicalBatchBase"]>[1],
) {
  return typeof domain.validateCanonicalBatchBase === "function"
    ? domain.validateCanonicalBatchBase(state, commands)
    : validateCanonicalHouseholdBatchBase(state, commands);
}

export class PlannerApplicationServiceImpl
  implements
    PlannerApplicationService,
    PlannerMutationKernel<SqliteTransaction>
{
  readonly store: SqlitePlannerStore;
  readonly domain: HouseholdDomainPort;
  readonly seedFactory: SeedFactory;
  readonly transformLegacyV2: LegacyV2Transformer;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly failureInjector: FailureInjector;

  constructor(options: CreatePlannerApplicationServiceOptions) {
    this.store = options.store;
    this.domain = options.domain;
    this.seedFactory = options.seedFactory;
    this.transformLegacyV2 = options.transformLegacyV2;
    this.clock = options.clock;
    this.idFactory = options.idFactory;
    this.failureInjector = options.failureInjector ?? NO_FAILURES;

    const workspace = this.store.readWorkspace();
    if (workspace.initialized) validateState(this.domain, workspace.state);
  }

  readWorkspace(): WorkspaceResponse {
    try {
      const workspace = this.store.readWorkspace();
      if (workspace.initialized) validateState(this.domain, workspace.state);
      return workspace;
    } catch (error) {
      return mapStoreError(error);
    }
  }

  readEventPage(request: Parameters<PlannerApplicationService["readEventPage"]>[0]): PlannerEventPage {
    const normalized = normalizePageRequest(request);
    if (!normalized) {
      throw new PlannerServiceError("INVALID_REQUEST", "History page request is invalid.", {
        httpStatus: 400,
      });
    }
    try {
      return this.store.readTransaction((transaction) => {
        this.store.readInitializedWorkspace(transaction);
        return this.store.readEventPage(normalized, transaction);
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  readTranscriptPage(
    request: Parameters<PlannerApplicationService["readTranscriptPage"]>[0],
  ): TranscriptPage {
    const normalized = normalizePageRequest(request);
    if (!normalized) {
      throw new PlannerServiceError("INVALID_REQUEST", "Transcript page request is invalid.", {
        httpStatus: 400,
      });
    }
    try {
      return this.store.readTransaction((transaction) => {
        this.store.readInitializedWorkspace(transaction);
        return this.store.readTranscriptPage(normalized, transaction);
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  applyCommand(request: ApplyPlannerCommandRequest): ApplyPlannerCommandResponse {
    const response = this.applyOperations(
      {
        requestId: request.requestId,
        basePlannerVersion: request.basePlannerVersion,
        operations: [{ command: request.command }],
      },
      { operationKind: "planner_command", provenance: BROWSER_PROVENANCE },
    );
    return {
      decision: asPlannerCommandDecision(response.decision),
      workspace: response.workspace,
    };
  }

  applyOperations(
    request: ApplyPlannerOperationsRequest,
    context: PlannerMutationContext,
  ): ApplyPlannerOperationsResponse {
    try {
      return this.store.transaction((transaction) => {
        const response = this.applyPlannerOperations(transaction, request, context);
        this.failureInjector.hit("before_commit");
        return response;
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  previewOperations(
    request: PreviewPlannerOperationsRequest,
  ): PreviewPlannerOperationsResponse {
    try {
      return this.store.readTransaction((transaction) =>
        this.previewPlannerOperations(transaction, request),
      );
    } catch (error) {
      return mapStoreError(error);
    }
  }

  previewPlannerOperations(
    transaction: SqliteTransaction,
    request: PreviewPlannerOperationsRequest,
  ): PreviewPlannerOperationsResponse {
    if (!isPreviewPlannerOperationsRequest(request)) {
      throw new PlannerServiceError(
        "INVALID_REQUEST",
        "Planner preview requires one to sixteen valid ordered operations.",
        { httpStatus: 400 },
      );
    }
    const workspace = this.store.readInitializedWorkspace(transaction);
    if (request.basePlannerVersion !== workspace.plannerVersion) {
      return {
        decision: {
          status: "version_conflict" as const,
          expectedVersion: request.basePlannerVersion,
          actualVersion: workspace.plannerVersion,
        },
      };
    }

    const canonicalBase = validateCanonicalBatchBase(
      this.domain,
      workspace.state,
      request.operations.map((operation) => operation.command),
    );
    if (!canonicalBase.ok) {
      return {
        decision: {
          status: "domain_rejected" as const,
          operationIndex: canonicalBase.operationIndex,
          message: canonicalBase.message,
        },
      };
    }

    let candidate = workspace.state;
    let previewId = 0;
    const now = this.clock.now();
    const outcomes: PlannerOperationPreview[] = [];
    const generatedIds = new Set<string>();
    for (let operationIndex = 0; operationIndex < request.operations.length; operationIndex += 1) {
      const result = this.domain.execute(candidate, request.operations[operationIndex].command, {
        now,
        createId: (prefix) => `preview-${prefix}-${++previewId}`,
      });
      if (!result.ok) {
        return {
          decision: {
            status: "domain_rejected" as const,
            operationIndex,
            message: result.message,
          },
        };
      }
      candidate = result.state;
      for (const generatedId of Object.values(result.createdIds)) generatedIds.add(generatedId);
      outcomes.push({
        operationIndex,
        summary: result.summary,
        target: result.target,
        changes: result.changes,
      });
    }

    const allGeneratedIds = [...generatedIds];
    return {
      decision: {
        status: "previewed" as const,
        plannerVersion: workspace.plannerVersion,
        outcomes: outcomes.map((outcome) => ({
          operationIndex: outcome.operationIndex,
          summary: replaceGeneratedIds(outcome.summary, allGeneratedIds),
          target: replaceGeneratedIds(outcome.target, allGeneratedIds),
          changes: outcome.changes.map((change) => replaceGeneratedIds(change, allGeneratedIds)),
        })),
      },
    };
  }

  applyPlannerOperations(
    transaction: SqliteTransaction,
    request: ApplyPlannerOperationsRequest,
    context: PlannerMutationContext,
  ): ApplyPlannerOperationsResponse {
    if (!isApplyPlannerOperationsRequest(request)) {
      throw new PlannerServiceError(
        "INVALID_REQUEST",
        "Planner apply requires one to sixteen valid ordered operations.",
        { httpStatus: 400 },
      );
    }
    if (!isValidPlannerMutationContext(context, request.operations.length)) {
      throw new PlannerServiceError(
        "INVALID_REQUEST",
        "Planner mutation context does not match its trusted operation kind.",
        { httpStatus: 400 },
      );
    }

    const payloadHash = hashCanonicalPayload(
      context.operationKind,
      plannerOperationsPayloadForHash(request, context),
    );
    const existing = this.store.findReceipt(transaction, context.operationKind, request.requestId);
    if (existing) {
      assertReceiptPayload(existing, payloadHash);
      const stored = existing.decision as StoredPlannerDecision;
      if (stored.kind !== "planner_decision") {
        throw new PlannerServiceError("STORE_CORRUPT", "Planner receipt has an invalid decision.", {
          httpStatus: 503,
        });
      }
      return {
        decision: asPlannerOperationsDecision(stored.decision),
        workspace: this.store.readInitializedWorkspace(transaction),
      };
    }

    const workspace = this.store.readInitializedWorkspace(transaction);
    const now = context.now ?? this.clock.now();
    let decision: PlannerOperationsDecision | undefined;
    let httpStatus: number | undefined;

    if (request.basePlannerVersion !== workspace.plannerVersion) {
      decision = {
        status: "version_conflict",
        expectedVersion: request.basePlannerVersion,
        actualVersion: workspace.plannerVersion,
      };
      httpStatus = 409;
    } else {
      const canonicalBase = validateCanonicalBatchBase(
        this.domain,
        workspace.state,
        request.operations.map((operation) => operation.command),
      );
      if (!canonicalBase.ok) {
        decision = {
          status: "domain_rejected",
          operationIndex: canonicalBase.operationIndex,
          message: canonicalBase.message,
        };
        httpStatus = 422;
      } else {
        let candidate = workspace.state;
        const outcomes: PlannerOperationPreview[] = [];
        for (let operationIndex = 0; operationIndex < request.operations.length; operationIndex += 1) {
          const result = this.domain.execute(candidate, request.operations[operationIndex].command, {
            now,
            createId: (prefix) => this.idFactory.createId(prefix),
          });
          if (!result.ok) {
            decision = {
              status: "domain_rejected",
              operationIndex,
              message: result.message,
            };
            httpStatus = 422;
            break;
          }
          candidate = result.state;
          outcomes.push({
            operationIndex,
            summary: result.summary,
            target: result.target,
            changes: result.changes,
          });
        }

        if (outcomes.length === request.operations.length) {
        validateState(this.domain, candidate, {
          code: "INTERNAL_ERROR",
          httpStatus: 500,
        });
        const versions = this.store.updateWorkspace(
          transaction,
          candidate,
          workspace.plannerVersion,
          now,
        );
        if (!versions) {
          throw new PlannerServiceError(
            "VERSION_CONFLICT",
            "Workspace changed before the command could commit.",
            { httpStatus: 409 },
          );
        }
        this.failureInjector.hit("after_workspace_update");

        const eventId = this.idFactory.createId("event");
        const one = outcomes[0];
        const isBatch = request.operations.length > 1;
        this.store.insertPlannerEvent(
          transaction,
          {
            eventId,
            requestId: request.requestId,
            actor: plannerActorForProvenance(context.provenance),
            provenance: context.provenance,
            command: isBatch
              ? { type: "plannerBatch", operations: request.operations }
              : request.operations[0].command,
            baseVersion: workspace.plannerVersion,
            resultVersion: versions.plannerVersion,
            summary: isBatch
              ? `Applied ${request.operations.length} planner operations`
              : one.summary,
            target: isBatch ? "Multiple planner targets" : one.target,
            changes: isBatch
              ? outcomes.flatMap((outcome) =>
                  outcome.changes.map((change) => `${outcome.operationIndex + 1}. ${change}`),
                )
              : one.changes,
            revertsEventId: null,
            chatTurnId: context.chatTurnId ?? null,
            occurredAt: now,
          },
          workspace.state,
        );
        this.failureInjector.hit("after_event_insert");
        decision = {
          status: "accepted",
          eventId,
          plannerVersion: versions.plannerVersion,
        };
        httpStatus = 200;
        }
      }
    }

    if (decision === undefined || httpStatus === undefined) {
      throw new PlannerServiceError(
        "INTERNAL_ERROR",
        "Planner operation evaluation did not reach a terminal decision.",
        { httpStatus: 500 },
      );
    }

    this.store.insertReceipt(
      transaction,
      receipt(
        context.operationKind,
        request.requestId,
        payloadHash,
        httpStatus,
        { kind: "planner_decision", decision },
        now,
      ),
    );
    this.failureInjector.hit("after_receipt_insert");
    if (decision.status === "accepted") this.failureInjector.hit("after_planner_mutation");
    return {
      decision,
      workspace: this.store.readInitializedWorkspace(transaction),
    };
  }

  undoLatest(request: UndoLatestRequest): ApplyPlannerCommandResponse {
    try {
      return this.store.transaction((transaction) => {
        const operationKind = "planner_undo" as const;
        const payloadHash = hashCanonicalPayload(operationKind, request);
        const existing = this.store.findReceipt(transaction, operationKind, request.requestId);
        if (existing) {
          assertReceiptPayload(existing, payloadHash);
          const stored = existing.decision as StoredPlannerDecision;
          if (stored.kind !== "planner_decision") {
            throw new PlannerServiceError("STORE_CORRUPT", "Undo receipt has an invalid decision.", {
              httpStatus: 503,
            });
          }
          return {
            decision: asPlannerCommandDecision(asPlannerOperationsDecision(stored.decision)),
            workspace: this.store.readInitializedWorkspace(transaction),
          };
        }

        const workspace = this.store.readInitializedWorkspace(transaction);
        const now = this.clock.now();
        let decision: PlannerCommandDecision;
        let httpStatus: number;

        if (request.basePlannerVersion !== workspace.plannerVersion) {
          decision = {
            status: "version_conflict",
            expectedVersion: request.basePlannerVersion,
            actualVersion: workspace.plannerVersion,
          };
          httpStatus = 409;
        } else {
          const latest = this.store.readLatestPlannerEvent(transaction);
          const eligible =
            latest !== null &&
            latest.event.eventId === request.targetEventId &&
            latest.event.command.type !== "undoLatest" &&
            latest.event.resultVersion === workspace.plannerVersion &&
            !this.store.hasRevertForEvent(transaction, request.targetEventId);

          if (!eligible || !latest) {
            decision = {
              status: "domain_rejected",
              message: "Only the latest unreverted planner change can be undone.",
            };
            httpStatus = 409;
          } else {
            validateState(this.domain, latest.beforeState);
            const versions = this.store.updateWorkspace(
              transaction,
              latest.beforeState,
              workspace.plannerVersion,
              now,
            );
            if (!versions) {
              throw new PlannerServiceError(
                "VERSION_CONFLICT",
                "Workspace changed before undo could commit.",
                { httpStatus: 409 },
              );
            }
            this.failureInjector.hit("after_workspace_update");
            const eventId = this.idFactory.createId("event");
            this.store.insertPlannerEvent(
              transaction,
              {
                eventId,
                requestId: request.requestId,
                actor: "Household",
                provenance: BROWSER_PROVENANCE,
                command: { type: "undoLatest", targetEventId: request.targetEventId },
                baseVersion: workspace.plannerVersion,
                resultVersion: versions.plannerVersion,
                summary: `Undid: ${latest.event.summary}`,
                target: latest.event.target,
                changes: [`Restored the state before: ${latest.event.summary}`],
                revertsEventId: latest.event.eventId,
                chatTurnId: null,
                occurredAt: now,
              },
              workspace.state,
            );
            this.failureInjector.hit("after_event_insert");
            decision = {
              status: "accepted",
              eventId,
              plannerVersion: versions.plannerVersion,
            };
            httpStatus = 200;
          }
        }

        this.store.insertReceipt(
          transaction,
          receipt(
            operationKind,
            request.requestId,
            payloadHash,
            httpStatus,
            { kind: "planner_decision", decision },
            now,
          ),
        );
        this.failureInjector.hit("after_receipt_insert");
        if (decision.status === "accepted") this.failureInjector.hit("after_planner_mutation");
        this.failureInjector.hit("before_commit");
        return {
          decision,
          workspace: this.store.readInitializedWorkspace(transaction),
        };
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  bootstrap(request: BootstrapWorkspaceRequest): BootstrapWorkspaceResponse {
    if (!isBootstrapWorkspaceRequest(request)) {
      throw new PlannerServiceError(
        "INVALID_REQUEST",
        isDiagnosticExportMarker(request)
          ? DIAGNOSTIC_EXPORT_WARNING
          : "Bootstrap must select seed or an exact v2 import.",
        { httpStatus: 400 },
      );
    }
    type BootstrapOutcome =
      | { ok: true; response: BootstrapWorkspaceResponse }
      | { ok: false; error: PlannerServiceError };

    let outcome: BootstrapOutcome;
    try {
      outcome = this.store.transaction((transaction) => {
        const operationKind = "workspace_bootstrap" as const;
        const payloadHash = hashCanonicalPayload(operationKind, request);
        const existing = this.store.findReceipt(transaction, operationKind, request.requestId);
        if (existing) {
          assertReceiptPayload(existing, payloadHash);
          const stored = existing.decision as StoredBootstrapDecision;
          const workspace = this.store.readWorkspace(transaction);
          if (stored.kind === "bootstrap_rejected") {
            return {
              ok: false as const,
              error: new PlannerServiceError(stored.code, stored.message, {
                httpStatus: 409,
                workspace,
              }),
            };
          }
          if (stored.kind !== "bootstrap_accepted" || !workspace.initialized) {
            throw new PlannerServiceError(
              "STORE_CORRUPT",
              "Bootstrap receipt does not match workspace state.",
              { httpStatus: 503 },
            );
          }
          return {
            ok: true as const,
            response: { workspace, imported: stored.imported },
          };
        }

        const current = this.store.readWorkspace(transaction);
        const now = this.clock.now();
        if (current.initialized) {
          const message = "Household workspace has already been initialized.";
          this.store.insertReceipt(
            transaction,
            receipt(
              operationKind,
              request.requestId,
              payloadHash,
              409,
              { kind: "bootstrap_rejected", code: "ALREADY_INITIALIZED", message },
              now,
            ),
          );
          this.failureInjector.hit("after_receipt_insert");
          this.failureInjector.hit("before_commit");
          return {
            ok: false as const,
            error: new PlannerServiceError("ALREADY_INITIALIZED", message, {
              httpStatus: 409,
              workspace: current,
            }),
          };
        }

        let transformed: LegacyV2TransformResult;
        if (request.mode === "import-v2") {
          try {
            transformed = this.transformLegacyV2(request.payload);
          } catch (error) {
            if (error instanceof PlannerServiceError) throw error;
            const fieldErrors =
              error && typeof error === "object" && "fieldErrors" in error
                ? (error as { fieldErrors?: Record<string, string> }).fieldErrors
                : undefined;
            throw new PlannerServiceError(
              "INVALID_REQUEST",
              error instanceof Error ? error.message : "Legacy v2 import is invalid.",
              { httpStatus: 422, fieldErrors, cause: error },
            );
          }
          validateState(this.domain, transformed.state, {
            code: "INVALID_REQUEST",
            httpStatus: 422,
          });
        } else {
          transformed = {
            state: this.seedFactory(),
            transcriptEntries: [],
            discardedEventCount: 0,
          };
          validateState(this.domain, transformed.state, {
            code: "INTERNAL_ERROR",
            httpStatus: 500,
          });
        }
        this.store.insertWorkspace(transaction, transformed.state, now);
        this.failureInjector.hit("after_workspace_update");
        for (const entry of transformed.transcriptEntries) {
          this.store.insertTranscriptEntry(transaction, {
            entryId: this.idFactory.createId("transcript"),
            role: entry.role,
            text: entry.text,
            context: entry.context,
            turnId: null,
            occurredAt: now,
          });
        }
        this.store.insertReceipt(
          transaction,
          receipt(
            operationKind,
            request.requestId,
            payloadHash,
            200,
            { kind: "bootstrap_accepted", imported: request.mode === "import-v2" },
            now,
          ),
        );
        this.failureInjector.hit("after_receipt_insert");
        this.failureInjector.hit("before_commit");
        return {
          ok: true as const,
          response: {
            workspace: this.store.readInitializedWorkspace(transaction),
            imported: request.mode === "import-v2",
          },
        };
      });
    } catch (error) {
      return mapStoreError(error);
    }

    if (!outcome.ok) throw outcome.error;
    return outcome.response;
  }

  exportWorkspace(): ExportEnvelope {
    try {
      return this.store.readTransaction((transaction) => {
        const workspace = this.store.readInitializedWorkspace(transaction);
        validateState(this.domain, workspace.state);
        return {
          kind: DIAGNOSTIC_EXPORT_KIND,
          formatVersion: DIAGNOSTIC_EXPORT_FORMAT_VERSION,
          restorable: false,
          warning: DIAGNOSTIC_EXPORT_WARNING,
          schemaVersion: workspace.schemaVersion,
          exportedAt: this.clock.now(),
          plannerVersion: workspace.plannerVersion,
          syncRevision: workspace.syncRevision,
          state: workspace.state,
          events: this.store.readAllEvents(transaction),
          transcriptEntries: this.store.readAllTranscriptEntries(transaction),
          chatTurns: this.store.readAllChatTurns(transaction),
        };
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }
}

export function createPlannerApplicationService(
  options: CreatePlannerApplicationServiceOptions,
): PlannerApplicationServiceImpl {
  return new PlannerApplicationServiceImpl(options);
}
