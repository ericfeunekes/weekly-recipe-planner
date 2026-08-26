import { createHash } from "node:crypto";

import {
  EMBEDDED_CODEX_PROVENANCE,
  type PlannerOperationPreview,
} from "../../lib/planner-operation-contract.ts";
import {
  EMPTY_FOREGROUND_AUTHORITY,
  PLANNER_APPROVED_WEEK_TOOL_ARGUMENT_BYTES_LIMIT,
  PLANNER_TOOL_ARGUMENT_BYTES_LIMIT,
  PLANNER_TOOL_NAMES,
  PLANNER_TOOL_NAMESPACE,
  authorizePlannerOperations,
  createPlannerToolFailure,
  createPlannerToolSuccess,
  isHistoricalPlannerApplyArguments,
  isPlannerApplyArguments,
  isPlannerImportRecipeArguments,
  isPlannerImportApprovedWeekArguments,
  isPlannerPreviewArguments,
  isPlannerReadArguments,
  projectPlannerRead,
  serializePlannerToolResult,
  type PlannerToolFailure,
  type PlannerApplyArguments,
  type PlannerToolName,
  type PlannerToolResult,
} from "../../lib/planner-tool-contract.ts";
import type { SourcedRecipeReplacement } from "../../lib/sourced-recipe-contract.ts";
import { HOUSEHOLD_COMMAND_REGISTRY } from "../../lib/household-command-contract.ts";
import type {
  PlannerApplicationService,
  PlannerMutationKernel,
} from "../application/ports.ts";
import type {
  NativePlannerToolCallIdentity,
  NativePlannerToolCompletion,
  SqliteCodexThreadStore,
} from "../store/codex-thread-store.ts";
import type { SqliteTransaction } from "../store/sqlite-store.ts";
import { CanonicalRecipeReadError, readCanonicalRecipe } from "./canonical-recipe-reader.ts";

const IDENTIFIER_LIMIT = 200;

type DynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: typeof PLANNER_TOOL_NAMESPACE;
  tool: PlannerToolName;
  arguments: unknown;
};

class DurableCompletionLostError extends Error {
  readonly result: PlannerToolResult;

  constructor(result: PlannerToolResult) {
    super("Native planner transaction lost durable completion ownership.");
    this.name = "DurableCompletionLostError";
    this.result = result;
  }
}

export type DynamicToolCallResponse = Readonly<{
  success: boolean;
  contentItems: readonly [{ readonly type: "inputText"; readonly text: string }];
}>;

export type NativePlannerEffectHostOptions = {
  planner: PlannerApplicationService & PlannerMutationKernel<SqliteTransaction>;
  store: SqliteCodexThreadStore;
  isEligibleCall(threadId: string, turnId: string): boolean;
  recipeRoot?: string;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= IDENTIFIER_LIMIT && value.trim().length > 0 && !value.includes("\0");
}

function argumentShape(value: unknown): string {
  if (!isRecord(value)) return "received a non-object argument value";
  const keys = Object.keys(value).sort().join(", ") || "none";
  const operations = value.operations;
  if (!Array.isArray(operations) || operations.length === 0 || !isRecord(operations[0])) {
    return `received outer keys [${keys}]`;
  }
  const operationKeys = Object.keys(operations[0]).sort().join(", ") || "none";
  const command = operations[0].command;
  const commandType = isRecord(command) && typeof command.type === "string"
    ? command.type
    : null;
  const commandKeys = isRecord(command)
    ? Object.keys(command).sort().join(", ") || "none"
    : "not an object";
  const expected = commandType !== null && commandType in HOUSEHOLD_COMMAND_REGISTRY
    ? Object.keys(HOUSEHOLD_COMMAND_REGISTRY[commandType as keyof typeof HOUSEHOLD_COMMAND_REGISTRY].schema.properties).sort().join(", ")
    : null;
  return `received outer keys [${keys}]; first operation keys [${operationKeys}]; first command keys [${commandKeys}]` +
    (expected === null ? "" : `; ${commandType} requires command keys [${expected}]`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseDynamicToolCall(value: unknown): DynamicToolCallParams {
  if (!isRecord(value)) throw new TypeError("Dynamic planner callback is malformed.");
  const threadId = value.threadId;
  const turnId = value.turnId;
  const callId = value.callId;
  const namespace = value.namespace;
  const tool = value.tool;
  if (
    !isIdentifier(threadId) || !isIdentifier(turnId) || !isIdentifier(callId) ||
    namespace !== PLANNER_TOOL_NAMESPACE ||
    typeof tool !== "string" || !PLANNER_TOOL_NAMES.includes(tool as PlannerToolName)
  ) {
    throw new TypeError("Dynamic planner callback identity or tool is invalid.");
  }
  const serializedArguments = canonicalJson(value.arguments);
  const argumentLimit = tool === "importApprovedWeek"
    ? PLANNER_APPROVED_WEEK_TOOL_ARGUMENT_BYTES_LIMIT
    : PLANNER_TOOL_ARGUMENT_BYTES_LIMIT;
  if (Buffer.byteLength(serializedArguments, "utf8") > argumentLimit) {
    throw new TypeError("Dynamic planner callback arguments exceed their byte limit.");
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool: tool as PlannerToolName,
    arguments: value.arguments,
  };
}

function callIdentity(call: DynamicToolCallParams): NativePlannerToolCallIdentity {
  const argumentHash = sha256(canonicalJson(call.arguments));
  return Object.freeze({
    threadId: call.threadId,
    turnId: call.turnId,
    callId: call.callId,
    tool: call.tool,
    argumentHash,
    callbackIdentityHash: sha256([
      call.threadId,
      call.turnId,
      call.callId,
      call.namespace,
      call.tool,
      argumentHash,
    ].join("\0")),
  });
}

function response(result: PlannerToolResult): DynamicToolCallResponse {
  return Object.freeze({
    success: result.ok,
    contentItems: Object.freeze([
      Object.freeze({ type: "inputText" as const, text: serializePlannerToolResult(result) }),
    ]) as readonly [{ readonly type: "inputText"; readonly text: string }],
  });
}

function failure(
  callId: string,
  workspace: ReturnType<PlannerApplicationService["readWorkspace"]>,
  now: number,
  code: PlannerToolFailure["error"]["code"],
  message: string,
  retry: PlannerToolFailure["error"]["retry"],
  operationIndex?: number,
) {
  if (!workspace.initialized) {
    return createPlannerToolFailure(callId, { plannerVersion: 0, syncRevision: 0 }, now, {
      code: "INTERNAL_ERROR",
      message: "The planner has not been initialized.",
      retry: "none",
    });
  }
  return createPlannerToolFailure(callId, workspace, now, {
    code,
    message,
    retry,
    ...(operationIndex === undefined ? {} : { operationIndex }),
  });
}

function completionBase(
  identity: NativePlannerToolCallIdentity,
  result: PlannerToolResult,
  completedAt: number,
): NativePlannerToolCompletion {
  return {
    ...identity,
    status: result.ok ? "succeeded" : "rejected",
    resultCode: result.ok ? "OK" : result.error.code,
    resultEnvelope: result,
    completedAt,
  };
}

export class NativePlannerEffectHost {
  readonly #options: NativePlannerEffectHostOptions;
  readonly #live = new Map<string, Promise<PlannerToolResult>>();

  constructor(options: NativePlannerEffectHostOptions) {
    this.#options = options;
  }

  #completeOrReplay(
    call: DynamicToolCallParams,
    identity: NativePlannerToolCallIdentity,
    result: PlannerToolResult,
    completion: NativePlannerToolCompletion,
    transaction?: SqliteTransaction,
  ): PlannerToolResult {
    if (this.#options.store.completePlannerToolCall(completion, transaction)) return result;
    const terminal = this.#options.store.readPlannerToolCalls(
      call.threadId,
      call.turnId,
      transaction,
    ).find((candidate) => candidate.callId === call.callId);
    if (
      terminal?.resultEnvelope !== null && terminal?.resultEnvelope !== undefined &&
      terminal.callbackIdentityHash === identity.callbackIdentityHash
    ) {
      if (transaction) throw new DurableCompletionLostError(terminal.resultEnvelope);
      return terminal.resultEnvelope;
    }
    throw new Error("Native planner call lost its durable completion ownership.");
  }

  async handle(params: unknown): Promise<DynamicToolCallResponse> {
    const call = parseDynamicToolCall(params);
    if (!this.#options.isEligibleCall(call.threadId, call.turnId)) {
      throw new TypeError("Dynamic planner callback came from an ineligible native turn.");
    }
    const identity = callIdentity(call);
    const existing = this.#live.get(identity.callbackIdentityHash);
    const execution = existing ?? this.#execute(call, identity);
    if (!existing) {
      this.#live.set(identity.callbackIdentityHash, execution);
      void execution.finally(() => {
        if (this.#live.get(identity.callbackIdentityHash) === execution) {
          this.#live.delete(identity.callbackIdentityHash);
        }
      }).catch(() => undefined);
    }
    return response(await execution);
  }

  async #execute(
    call: DynamicToolCallParams,
    identity: NativePlannerToolCallIdentity,
  ): Promise<PlannerToolResult> {
    const now = this.#options.now?.() ?? Date.now();
    const reservation = this.#options.store.reservePlannerToolCall(identity, now);
    if (reservation.status === "replay") {
      if (reservation.call.resultEnvelope === null) {
        throw new Error("Terminal native planner call omitted its replay result.");
      }
      return reservation.call.resultEnvelope;
    }
    if (reservation.status === "duplicate_mismatch" || reservation.status === "call_limit") {
      const workspace = this.#options.planner.readWorkspace();
      return failure(
        call.callId,
        workspace,
        now,
        reservation.status === "duplicate_mismatch" ? "DUPLICATE_MISMATCH" : "CALL_CANCELLED",
        reservation.status === "duplicate_mismatch"
          ? "A native planner call reused its identity with different arguments."
          : "The native turn exceeded its planner call limit.",
        "new_foreground_turn",
      );
    }

    const workspace = this.#options.planner.readWorkspace();
    const executeAndComplete = (
      transaction?: SqliteTransaction,
      importedRecipe?: SourcedRecipeReplacement,
      importedWeekRecipes?: Map<string, SourcedRecipeReplacement>,
    ) => {
      const { result, completion } = this.#runTool(
        call,
        identity,
        now,
        workspace,
        transaction,
        importedRecipe,
        importedWeekRecipes,
      );
      return this.#completeOrReplay(call, identity, result, completion, transaction);
    };
    const executeInTransaction = (importedRecipe?: SourcedRecipeReplacement, importedWeekRecipes?: Map<string, SourcedRecipeReplacement>) => {
      try {
        return this.#options.store.transaction((transaction) =>
          executeAndComplete(transaction, importedRecipe, importedWeekRecipes));
      } catch (error) {
        if (error instanceof DurableCompletionLostError) return error.result;
        throw error;
      }
    };
    if (call.tool === "importRecipe") {
      if (!isPlannerImportRecipeArguments(call.arguments) || this.#options.recipeRoot === undefined) {
        return executeAndComplete();
      }
      let recipe: SourcedRecipeReplacement;
      try {
        recipe = await readCanonicalRecipe(this.#options.recipeRoot, call.arguments.recipePath);
      } catch (error) {
        const result = failure(
          call.callId,
          workspace,
          now,
          "INVALID_ARGUMENTS",
          error instanceof CanonicalRecipeReadError ? error.message : "Canonical recipe import failed safely.",
          "revise_new_call",
        );
        return this.#completeOrReplay(
          call,
          identity,
          result,
          completionBase(identity, result, now),
        );
      }
      return executeInTransaction(recipe);
    }
    if (call.tool === "importApprovedWeek") {
      if (!isPlannerImportApprovedWeekArguments(call.arguments) || this.#options.recipeRoot === undefined) return executeAndComplete();
      const approvedArguments = call.arguments;
      try {
        const recipes = new Map<string, SourcedRecipeReplacement>();
        for (const target of approvedArguments.targets) {
          const recipe = await readCanonicalRecipe(this.#options.recipeRoot, target.recipePath);
          if (recipe.source.kind !== "canonical" || recipe.source.revision !== target.recipeRevision) throw new CanonicalRecipeReadError("Canonical recipe revision no longer matches the reviewed approved-week request.");
          recipes.set(target.mealId, recipe);
        }
        return executeInTransaction(undefined, recipes);
      } catch (error) {
        const result = failure(call.callId, workspace, now, "INVALID_ARGUMENTS", error instanceof Error ? error.message : "Approved-week import failed safely.", "revise_new_call");
        return this.#completeOrReplay(call, identity, result, completionBase(identity, result, now));
      }
    }
    return call.tool === "apply"
      ? executeInTransaction()
      : executeAndComplete();
  }

  #applyOperations(
    call: DynamicToolCallParams,
    identity: NativePlannerToolCallIdentity,
    now: number,
    transaction: SqliteTransaction,
    argumentsValue: PlannerApplyArguments,
    requireRequestedReadback: boolean,
  ): { result: PlannerToolResult; completion: NativePlannerToolCompletion } {
    const requestId = `native-codex:${identity.callbackIdentityHash}`;
    const applied = this.#options.planner.applyPlannerOperations(
      transaction,
      {
        requestId,
        basePlannerVersion: argumentsValue.basePlannerVersion,
        operations: argumentsValue.operations,
      },
      {
        operationKind: "native_codex_apply_planner_operations_v1",
        provenance: EMBEDDED_CODEX_PROVENANCE,
        now,
      },
    );
    let result: PlannerToolResult;
    if (applied.decision.status === "accepted") {
      const requestedReadback = projectPlannerRead(applied.workspace, argumentsValue.readback);
      const readback = requestedReadback ?? (
        requireRequestedReadback ? null : projectPlannerRead(applied.workspace, { kind: "workspace" })
      );
      if (!readback) {
        throw new Error(requireRequestedReadback
          ? "Accepted canonical recipe import lost its meal readback."
          : "Accepted native planner apply lost canonical readback.");
      }
      result = createPlannerToolSuccess(call.callId, applied.workspace, now, {
        status: "accepted" as const,
        eventId: applied.decision.eventId,
        occurrenceResults: applied.decision.occurrenceResults,
        readback,
      });
    } else if (applied.decision.status === "version_conflict") {
      result = failure(
        call.callId,
        applied.workspace,
        now,
        "VERSION_CONFLICT",
        `Planner version changed from ${applied.decision.expectedVersion} to ${applied.decision.actualVersion}.`,
        "refresh_new_call",
      );
    } else {
      result = failure(
        call.callId,
        applied.workspace,
        now,
        "DOMAIN_REJECTED",
        applied.decision.message,
        "revise_new_call",
        applied.decision.operationIndex,
      );
    }
    return {
      result,
      completion: {
        ...completionBase(identity, result, now),
        operationKind: "native_codex_apply_planner_operations_v1",
        requestId,
        ...(applied.decision.status === "accepted" ? { eventId: applied.decision.eventId } : {}),
        basePlannerVersion: argumentsValue.basePlannerVersion,
        resultPlannerVersion: applied.decision.status === "version_conflict"
          ? applied.decision.actualVersion
          : applied.workspace.plannerVersion,
      },
    };
  }

  #runTool(
    call: DynamicToolCallParams,
    identity: NativePlannerToolCallIdentity,
    now: number,
    workspace: ReturnType<PlannerApplicationService["readWorkspace"]>,
    transaction?: SqliteTransaction,
    importedRecipe?: SourcedRecipeReplacement,
    importedWeekRecipes?: Map<string, SourcedRecipeReplacement>,
  ): { result: PlannerToolResult; completion: NativePlannerToolCompletion } {
    if (!workspace.initialized) {
      const result = failure(
        call.callId,
        workspace,
        now,
        "INTERNAL_ERROR",
        "The planner has not been initialized.",
        "none",
      );
      return { result, completion: completionBase(identity, result, now) };
    }

    if (call.tool === "read") {
      const result = !isPlannerReadArguments(call.arguments)
        ? failure(
            call.callId,
            workspace,
            now,
            "INVALID_ARGUMENTS",
            "planner.read arguments did not match the closed query union.",
            "revise_new_call",
          )
        : (() => {
            const projection = projectPlannerRead(workspace, call.arguments.query);
            return projection
              ? createPlannerToolSuccess(call.callId, workspace, now, projection)
              : failure(
                  call.callId,
                  workspace,
                  now,
                  "DOMAIN_REJECTED",
                  "The requested planner record does not exist.",
                  "revise_new_call",
                );
          })();
      serializePlannerToolResult(result);
      return { result, completion: completionBase(identity, result, now) };
    }

    if (call.tool === "preview") {
      let result: PlannerToolResult;
      if (!isPlannerPreviewArguments(call.arguments)) {
        result = failure(
          call.callId,
          workspace,
          now,
          "INVALID_ARGUMENTS",
          "planner.preview arguments did not match the ordered operation contract; " +
            argumentShape(call.arguments) +
            ". Expected exactly outer keys [basePlannerVersion, operations] and each operation as {command:{type,...}}.",
          "revise_new_call",
        );
      } else {
        const authorized = authorizePlannerOperations(
          call.arguments.operations,
          EMPTY_FOREGROUND_AUTHORITY,
        );
        if (!authorized.ok) {
          result = failure(
            call.callId,
            workspace,
            now,
            "NOT_AUTHORIZED",
            authorized.message,
            authorized.retry,
            authorized.operationIndex,
          );
        } else {
          const preview = this.#options.planner.previewOperations(call.arguments);
          result = preview.decision.status === "previewed"
            ? createPlannerToolSuccess(call.callId, workspace, now, {
                status: "previewed" as const,
                outcomes: preview.decision.outcomes as PlannerOperationPreview[],
              })
            : preview.decision.status === "version_conflict"
              ? (() => {
                  const current = this.#options.planner.readWorkspace();
                  const currentVersion = current.initialized
                    ? current.plannerVersion
                    : preview.decision.actualVersion;
                  return failure(
                    call.callId,
                    current,
                    now,
                    "VERSION_CONFLICT",
                    `Planner version changed from ${preview.decision.expectedVersion} to ${currentVersion}.`,
                    "refresh_new_call",
                  );
                })()
              : failure(
                  call.callId,
                  workspace,
                  now,
                  "DOMAIN_REJECTED",
                  preview.decision.message,
                  "revise_new_call",
                  preview.decision.operationIndex,
                );
        }
      }
      serializePlannerToolResult(result);
      return { result, completion: completionBase(identity, result, now) };
    }

    if (call.tool === "importRecipe") {
      if (!isPlannerImportRecipeArguments(call.arguments) || importedRecipe === undefined || !transaction) {
        const result = failure(
          call.callId,
          workspace,
          now,
          "INVALID_ARGUMENTS",
          this.#options.recipeRoot === undefined
            ? "Canonical recipe import is not configured for this planner host."
            : "planner.importRecipe arguments did not match the closed import contract.",
          "revise_new_call",
        );
        return { result, completion: completionBase(identity, result, now) };
      }
      const applyArguments: PlannerApplyArguments = {
        basePlannerVersion: call.arguments.basePlannerVersion,
        readback: {
          kind: "meal",
          weekId: call.arguments.weekId,
          mealId: call.arguments.mealId,
        },
        operations: [{
          command: {
            type: "replaceMealRecipeFromSource" as const,
            weekId: call.arguments.weekId as import("../../lib/household-contract.ts").WeekId,
            mealId: call.arguments.mealId,
            recipe: importedRecipe,
          },
        }],
      };
      const applied = this.#applyOperations(
        call,
        identity,
        now,
        transaction,
        applyArguments,
        true,
      );
      serializePlannerToolResult(applied.result);
      return applied;
    }

    if (call.tool === "importApprovedWeek") {
      if (!isPlannerImportApprovedWeekArguments(call.arguments) || importedWeekRecipes === undefined || !transaction) {
        const result = failure(call.callId, workspace, now, "INVALID_ARGUMENTS", "planner.importApprovedWeek arguments did not match the closed import contract.", "revise_new_call");
        return { result, completion: completionBase(identity, result, now) };
      }
      const approvedArguments = call.arguments;
      const week = workspace.state.weeks.find((candidate) => candidate.id === approvedArguments.weekId);
      const shellIds = week?.data.meals.map((meal) => meal.id) ?? [];
      const requestedIds = [...approvedArguments.targets.map((target) => target.mealId), ...approvedArguments.manualMealIds];
      const validManuals = week !== undefined && approvedArguments.manualMealIds.every((mealId) => week.data.meals.find((meal) => meal.id === mealId)?.sourceRecipe === undefined);
      if (!week || new Set(shellIds).size !== requestedIds.length || shellIds.some((id) => !requestedIds.includes(id)) || !validManuals) {
        const result = failure(call.callId, workspace, now, "DOMAIN_REJECTED", "Approved-week targets and explicitly manual meals must exhaust the existing week shell.", "revise_new_call");
        return { result, completion: completionBase(identity, result, now) };
      }
      const requestId = `native-codex:${identity.callbackIdentityHash}`;
      const applied = this.#options.planner.applyApprovedWeekImport(transaction, {
        requestId, basePlannerVersion: approvedArguments.basePlannerVersion, weekId: approvedArguments.weekId,
        operations: approvedArguments.targets.map((target) => ({ command: { type: "replaceMealRecipeFromSource" as const, weekId: approvedArguments.weekId as import("../../lib/household-contract.ts").WeekId, mealId: target.mealId, recipe: importedWeekRecipes.get(target.mealId)! } })),
      }, { operationKind: "native_codex_import_approved_week_v1", provenance: EMBEDDED_CODEX_PROVENANCE, now });
      const result = applied.decision.status === "accepted"
        ? createPlannerToolSuccess(call.callId, applied.workspace, now, { status: "accepted" as const, eventId: applied.decision.eventId, weekId: approvedArguments.weekId, importedMealIds: approvedArguments.targets.map((target) => target.mealId) })
        : applied.decision.status === "version_conflict"
          ? failure(call.callId, applied.workspace, now, "VERSION_CONFLICT", `Planner version changed from ${applied.decision.expectedVersion} to ${applied.decision.actualVersion}.`, "refresh_new_call")
          : failure(call.callId, applied.workspace, now, "DOMAIN_REJECTED", applied.decision.message, "revise_new_call", applied.decision.operationIndex);
      return { result, completion: { ...completionBase(identity, result, now), operationKind: "native_codex_import_approved_week_v1", requestId, ...(applied.decision.status === "accepted" ? { eventId: applied.decision.eventId } : {}), basePlannerVersion: approvedArguments.basePlannerVersion, resultPlannerVersion: applied.workspace.plannerVersion } };
    }

    let result: PlannerToolResult;
    let completion: NativePlannerToolCompletion;
    if (!isPlannerApplyArguments(call.arguments) && isHistoricalPlannerApplyArguments(call.arguments)) {
      const requestId = `native-codex:${identity.callbackIdentityHash}`;
      if (!transaction) throw new Error("Native planner historical replay lost its shared transaction boundary.");
      try {
        const replayed = this.#options.planner.replayHistoricalPlannerOperations(
          transaction,
          {
            requestId,
            basePlannerVersion: call.arguments.basePlannerVersion,
            operations: call.arguments.operations,
          },
          {
            operationKind: "native_codex_apply_planner_operations_v1",
            provenance: EMBEDDED_CODEX_PROVENANCE,
            now,
          },
        );
        if (replayed.decision.status !== "accepted") {
          result = failure(
            call.callId,
            replayed.workspace,
            now,
            replayed.decision.status === "version_conflict" ? "VERSION_CONFLICT" : "DOMAIN_REJECTED",
            replayed.decision.status === "version_conflict"
              ? `Planner version changed from ${replayed.decision.expectedVersion} to ${replayed.decision.actualVersion}.`
              : replayed.decision.message,
            replayed.decision.status === "version_conflict" ? "refresh_new_call" : "revise_new_call",
            replayed.decision.status === "domain_rejected" ? replayed.decision.operationIndex : undefined,
          );
          completion = completionBase(identity, result, now);
        } else {
          const readback = projectPlannerRead(replayed.workspace, call.arguments.readback) ??
            projectPlannerRead(replayed.workspace, { kind: "workspace" });
          if (!readback) throw new Error("Historical native planner replay lost canonical readback.");
          result = createPlannerToolSuccess(call.callId, replayed.workspace, now, {
            status: "replayed" as const,
            eventId: replayed.decision.eventId,
            occurrenceResults: replayed.decision.occurrenceResults,
            readback,
          });
          completion = {
            ...completionBase(identity, result, now),
            operationKind: "native_codex_apply_planner_operations_v1",
            requestId,
            eventId: replayed.decision.eventId,
            basePlannerVersion: call.arguments.basePlannerVersion,
            resultPlannerVersion: replayed.decision.plannerVersion,
          };
        }
      } catch (error) {
        result = failure(
          call.callId,
          workspace,
          now,
          "INVALID_ARGUMENTS",
          error instanceof Error ? error.message : "Historical planner receipt replay failed.",
          "revise_new_call",
        );
        completion = completionBase(identity, result, now);
      }
    } else if (!isPlannerApplyArguments(call.arguments)) {
      result = failure(
        call.callId,
        workspace,
        now,
        "INVALID_ARGUMENTS",
        "planner.apply arguments did not match the ordered operation/readback contract.",
        "revise_new_call",
      );
      completion = completionBase(identity, result, now);
    } else {
      const authorized = authorizePlannerOperations(
        call.arguments.operations,
        EMPTY_FOREGROUND_AUTHORITY,
      );
      if (!authorized.ok) {
        result = failure(
          call.callId,
          workspace,
          now,
          "NOT_AUTHORIZED",
          authorized.message,
          authorized.retry,
          authorized.operationIndex,
        );
        completion = completionBase(identity, result, now);
      } else {
        if (!transaction) {
          throw new Error("Native planner apply lost its shared transaction boundary.");
        }
        ({ result, completion } = this.#applyOperations(
          call,
          identity,
          now,
          transaction,
          call.arguments,
          false,
        ));
      }
    }
    serializePlannerToolResult(result);
    return { result, completion };
  }
}

export function createNativePlannerEffectHost(options: NativePlannerEffectHostOptions) {
  return new NativePlannerEffectHost(options);
}
