import { createHash } from "node:crypto";

import {
  EMBEDDED_CODEX_PROVENANCE,
  type PlannerOperationPreview,
} from "../../lib/planner-operation-contract.ts";
import {
  EMPTY_FOREGROUND_AUTHORITY,
  PLANNER_TOOL_ARGUMENT_BYTES_LIMIT,
  PLANNER_TOOL_NAMES,
  PLANNER_TOOL_NAMESPACE,
  authorizePlannerOperations,
  createPlannerToolFailure,
  createPlannerToolSuccess,
  isPlannerApplyArguments,
  isPlannerPreviewArguments,
  isPlannerReadArguments,
  projectPlannerRead,
  serializePlannerToolResult,
  type PlannerToolFailure,
  type PlannerToolName,
  type PlannerToolResult,
} from "../../lib/planner-tool-contract.ts";
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

const IDENTIFIER_LIMIT = 200;

type DynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: typeof PLANNER_TOOL_NAMESPACE;
  tool: PlannerToolName;
  arguments: unknown;
};

export type DynamicToolCallResponse = Readonly<{
  success: boolean;
  contentItems: readonly [{ readonly type: "inputText"; readonly text: string }];
}>;

export type NativePlannerEffectHostOptions = {
  planner: PlannerApplicationService & PlannerMutationKernel<SqliteTransaction>;
  store: SqliteCodexThreadStore;
  isEligibleCall(threadId: string, turnId: string): boolean;
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
  if (Buffer.byteLength(serializedArguments, "utf8") > PLANNER_TOOL_ARGUMENT_BYTES_LIMIT) {
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
    const executeAndComplete = (transaction?: SqliteTransaction) => {
      const { result, completion } = this.#runTool(
        call,
        identity,
        now,
        workspace,
        transaction,
      );
      if (this.#options.store.completePlannerToolCall(completion, transaction)) return result;
      const terminal = this.#options.store.readPlannerToolCalls(
        call.threadId,
        call.turnId,
        transaction,
      )
        .find((candidate) => candidate.callId === call.callId);
      if (
        terminal?.resultEnvelope !== null && terminal?.resultEnvelope !== undefined &&
        terminal.callbackIdentityHash === identity.callbackIdentityHash
      ) {
        return terminal.resultEnvelope;
      }
      throw new Error("Native planner call lost its durable completion ownership.");
    };
    return call.tool === "apply"
      ? this.#options.store.transaction((transaction) => executeAndComplete(transaction))
      : executeAndComplete();
  }

  #runTool(
    call: DynamicToolCallParams,
    identity: NativePlannerToolCallIdentity,
    now: number,
    workspace: ReturnType<PlannerApplicationService["readWorkspace"]>,
    transaction?: SqliteTransaction,
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
            "new_foreground_turn",
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

    let result: PlannerToolResult;
    let completion: NativePlannerToolCompletion;
    if (!isPlannerApplyArguments(call.arguments)) {
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
          "new_foreground_turn",
          authorized.operationIndex,
        );
        completion = completionBase(identity, result, now);
      } else {
        const requestId = `native-codex:${identity.callbackIdentityHash}`;
        if (!transaction) {
          throw new Error("Native planner apply lost its shared transaction boundary.");
        }
        const applied = this.#options.planner.applyPlannerOperations(
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
        if (applied.decision.status === "accepted") {
          const readback = projectPlannerRead(applied.workspace, call.arguments.readback) ??
            projectPlannerRead(applied.workspace, { kind: "workspace" });
          if (!readback) throw new Error("Accepted native planner apply lost canonical readback.");
          result = createPlannerToolSuccess(call.callId, applied.workspace, now, {
            status: "accepted" as const,
            eventId: applied.decision.eventId,
            readback,
          });
          completion = {
            ...completionBase(identity, result, now),
            operationKind: "native_codex_apply_planner_operations_v1",
            requestId,
            eventId: applied.decision.eventId,
            basePlannerVersion: call.arguments.basePlannerVersion,
            resultPlannerVersion: applied.decision.plannerVersion,
          };
        } else if (applied.decision.status === "version_conflict") {
          result = failure(
            call.callId,
            applied.workspace,
            now,
            "VERSION_CONFLICT",
            `Planner version changed from ${applied.decision.expectedVersion} to ${applied.decision.actualVersion}.`,
            "refresh_new_call",
          );
          completion = {
            ...completionBase(identity, result, now),
            operationKind: "native_codex_apply_planner_operations_v1",
            requestId,
            basePlannerVersion: call.arguments.basePlannerVersion,
            resultPlannerVersion: applied.decision.actualVersion,
          };
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
          completion = {
            ...completionBase(identity, result, now),
            operationKind: "native_codex_apply_planner_operations_v1",
            requestId,
            basePlannerVersion: call.arguments.basePlannerVersion,
            resultPlannerVersion: applied.workspace.plannerVersion,
          };
        }
      }
    }
    serializePlannerToolResult(result);
    return { result, completion };
  }
}

export function createNativePlannerEffectHost(options: NativePlannerEffectHostOptions) {
  return new NativePlannerEffectHost(options);
}
