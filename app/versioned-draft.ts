import { createContext, useContext, useRef, useState } from "react";

export type CompositeDraft<T extends object> = {
  baseline: T;
  dirtyValues: Partial<T>;
};

export function editCompositeDraft<T extends object, K extends keyof T>(
  draft: CompositeDraft<T> | null,
  canonical: T,
  field: K,
  value: T[K],
): CompositeDraft<T> {
  const baseline = draft?.baseline ?? { ...canonical };
  const dirtyValues: Partial<T> = { ...(draft?.dirtyValues ?? {}) };
  dirtyValues[field] = value;

  return { baseline, dirtyValues };
}

export function composeCompositeDraft<T extends object>(
  canonical: T,
  draft: CompositeDraft<T> | null,
): T {
  return draft ? { ...canonical, ...draft.dirtyValues } : canonical;
}

export function settleCompositeDraft<T extends object>(
  current: CompositeDraft<T> | null,
  submitted: CompositeDraft<T> | null,
): CompositeDraft<T> | null {
  if (!current) return null;

  const dirtyValues: Partial<T> = {};
  for (const field of Object.keys(current.dirtyValues) as Array<keyof T>) {
    const submittedField = submitted !== null &&
      Object.prototype.hasOwnProperty.call(submitted.dirtyValues, field);
    if (
      !submittedField ||
      !Object.is(current.dirtyValues[field], submitted?.dirtyValues[field])
    ) {
      dirtyValues[field] = current.dirtyValues[field];
    }
  }

  return Object.keys(dirtyValues).length
    ? { baseline: current.baseline, dirtyValues }
    : null;
}

export const PlannerVersionContext = createContext(0);

export function useVersionedDraft<T extends object = Record<never, never>>() {
  const plannerVersion = useContext(PlannerVersionContext);
  const versionRef = useRef<number | null>(null);
  const editRevisionRef = useRef(0);
  const compositeDraftRef = useRef<CompositeDraft<T> | null>(null);
  const [compositeDraft, setCompositeDraft] = useState<CompositeDraft<T> | null>(null);
  return {
    versionRef,
    begin() {
      versionRef.current ??= plannerVersion;
      editRevisionRef.current += 1;
    },
    edit<K extends keyof T>(canonical: T, field: K, value: T[K]) {
      versionRef.current ??= plannerVersion;
      editRevisionRef.current += 1;
      const next = editCompositeDraft(compositeDraftRef.current, canonical, field, value);
      compositeDraftRef.current = next;
      setCompositeDraft(next);
    },
    compose(canonical: T, merge?: (canonical: T, draft: CompositeDraft<T>) => T): T {
      return compositeDraft && merge
        ? merge(canonical, compositeDraft)
        : composeCompositeDraft(canonical, compositeDraft);
    },
    mutationOptions(onAccepted?: () => void) {
      const submittedRevision = editRevisionRef.current;
      const submittedCompositeDraft = compositeDraftRef.current;
      return {
        basePlannerVersion: versionRef.current ?? plannerVersion,
        conflictStrategy: "recompose" as const,
        onAccepted(nextPlannerVersion: number) {
          const settledCompositeDraft = settleCompositeDraft(
            compositeDraftRef.current,
            submittedCompositeDraft,
          );
          compositeDraftRef.current = settledCompositeDraft;
          setCompositeDraft(settledCompositeDraft);
          const hasNewerDraft = settledCompositeDraft !== null ||
            (submittedCompositeDraft === null && editRevisionRef.current !== submittedRevision);
          if (!hasNewerDraft) {
            versionRef.current = null;
            editRevisionRef.current = 0;
            onAccepted?.();
          } else {
            versionRef.current = nextPlannerVersion;
          }
        },
        onConflict(nextPlannerVersion: number) {
          versionRef.current = nextPlannerVersion;
        },
      };
    },
  };
}
