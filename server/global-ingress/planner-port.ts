import {
  GLOBAL_CODEX_EVENT_TAIL_LIMIT,
  type PlannerReadEvent,
  type PlannerReadProjection,
} from "../../lib/global-codex-contract.ts";
import type {
  InitializedWorkspace,
  WorkspaceResponse,
} from "../../lib/planner-api-contract.ts";
import {
  GLOBAL_CODEX_PROVENANCE,
  type ApplyPlannerOperationsRequest,
  type PlannerOperationsDecision,
} from "../../lib/planner-operation-contract.ts";

export type GlobalCodexPlannerApplication = {
  readWorkspace(): WorkspaceResponse;
  applyOperations(
    request: ApplyPlannerOperationsRequest,
    context: {
      operationKind: "global_codex_apply_planner_batch_v1";
      provenance: typeof GLOBAL_CODEX_PROVENANCE;
    },
  ): { decision: PlannerOperationsDecision; workspace: InitializedWorkspace };
};

export type GlobalCodexPlannerPort = {
  readPlanner(): PlannerReadProjection;
  applyBatch(request: ApplyPlannerOperationsRequest): {
    decision: PlannerOperationsDecision;
    planner: PlannerReadProjection;
  };
};

function sanitizeEvent(event: InitializedWorkspace["events"][number]): PlannerReadEvent {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    requestId: event.requestId,
    actor: event.actor,
    provenance: event.provenance,
    command: event.command,
    baseVersion: event.baseVersion,
    resultVersion: event.resultVersion,
    summary: event.summary,
    target: event.target,
    changes: event.changes,
    revertsEventId: event.revertsEventId,
    occurredAt: event.occurredAt,
  };
}

export function projectPlannerWorkspace(workspace: WorkspaceResponse): PlannerReadProjection {
  if (!workspace.initialized) {
    return {
      initialized: false,
      schemaVersion: workspace.schemaVersion,
      events: [],
    };
  }
  return {
    initialized: true,
    schemaVersion: workspace.schemaVersion,
    plannerVersion: workspace.plannerVersion,
    syncRevision: workspace.syncRevision,
    state: workspace.state,
    events: workspace.events.slice(-GLOBAL_CODEX_EVENT_TAIL_LIMIT).map(sanitizeEvent),
  };
}

export function createGlobalCodexPlannerPort(
  planner: GlobalCodexPlannerApplication,
): GlobalCodexPlannerPort {
  return {
    readPlanner() {
      return projectPlannerWorkspace(planner.readWorkspace());
    },
    applyBatch(request) {
      const response = planner.applyOperations(request, {
        operationKind: "global_codex_apply_planner_batch_v1",
        provenance: GLOBAL_CODEX_PROVENANCE,
      });
      return {
        decision: response.decision,
        planner: projectPlannerWorkspace(response.workspace),
      };
    },
  };
}
