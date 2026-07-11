export function deriveTimerDisplay(
  durationSeconds: number,
  startedAt: number | undefined,
  now: number,
) {
  const elapsed = startedAt === undefined
    ? 0
    : Math.max(0, Math.floor((now - startedAt) / 1_000));
  const remainingSeconds = Math.max(0, durationSeconds - elapsed);
  return {
    remainingSeconds,
    status: startedAt === undefined
      ? "timer"
      : remainingSeconds === 0
        ? "elapsed"
        : "running",
  } as const;
}
