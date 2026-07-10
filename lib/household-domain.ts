import type { HouseholdCommand } from "./household-command-contract";
import type { HouseholdPlannerState } from "./household-contract";

export type HouseholdStateValidation =
  | { ok: true }
  | {
      ok: false;
      issues: Array<{ path: string; message: string }>;
    };

export type HouseholdCommandExecution =
  | {
      ok: true;
      state: HouseholdPlannerState;
      summary: string;
      target: string;
      changes: string[];
      createdIds: Record<string, string>;
    }
  | {
      ok: false;
      state: HouseholdPlannerState;
      message: string;
      fieldErrors?: Record<string, string>;
    };

export type HouseholdCommandContext = {
  now: number;
  createId(prefix: string): string;
};

export interface HouseholdDomainPort {
  validateState(state: HouseholdPlannerState): HouseholdStateValidation;
  execute(
    state: HouseholdPlannerState,
    command: HouseholdCommand,
    context: HouseholdCommandContext,
  ): HouseholdCommandExecution;
}

