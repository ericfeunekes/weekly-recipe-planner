export function deriveTimerDisplay(
  durationSeconds: number,
  startedAt: number | undefined,
  now: number,
  paused = false,
  remainingSecondsOverride?: number,
) {
  const elapsed = startedAt === undefined
    ? 0
    : Math.max(0, Math.floor((now - startedAt) / 1_000));
  const remainingSeconds = Math.max(0, (remainingSecondsOverride ?? durationSeconds) - elapsed);
  return {
    remainingSeconds,
    status: startedAt === undefined
      ? paused ? "paused" : "timer"
      : remainingSeconds === 0
        ? "elapsed"
        : "running",
  } as const;
}
