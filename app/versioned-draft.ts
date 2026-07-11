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
