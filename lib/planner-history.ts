import type { PlannerData } from "./planner-domain";

export type PlannerActor = "Household" | "Codex";

export type PlannerEventEntry = {
  id: string;
  actor: PlannerActor;
  command: string;
  summary: string;
  target: string;
  changes: string[];
  before?: PlannerData;
  occurredAt?: number;
  /** Legacy display value retained until all writers emit occurredAt. */
  time?: string;
};

export type PlannerChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  context?: string;
  changes?: string[];
};

export const MAX_RECOVERABLE_EVENTS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength = Number.POSITIVE_INFINITY) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function readNonemptyString(value: unknown, maxLength = Number.POSITIVE_INFINITY) {
  const text = readString(value, maxLength);
  return text && text.trim().length > 0 ? text : null;
}

function calendarDayNumber(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
}

export function formatPlannerEventTime(
  occurredAt: number,
  nowMs = Date.now(),
): string {
  const eventDate = new Date(occurredAt);
  if (!Number.isFinite(eventDate.getTime())) return "Unknown time";
  const now = new Date(nowMs);
  const dayDifference = calendarDayNumber(now) - calendarDayNumber(eventDate);
  const label =
    dayDifference === 0
      ? "Today"
      : dayDifference === 1
        ? "Yesterday"
        : dayDifference > 1 && dayDifference < 7
          ? new Intl.DateTimeFormat("en-CA", { weekday: "long" }).format(eventDate)
          : new Intl.DateTimeFormat("en-CA", {
              year: "numeric",
              month: "short",
              day: "numeric",
            }).format(eventDate);
  const time = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(eventDate);
  return `${label}, ${time}`;
}

function readExplicitOccurredAt(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readTimestampFromId(id: string): number | null {
  const match = id.match(/^[^-]+-(\d{12,})-/);
  if (!match) return null;
  const parsed = Number(match[1]);
  const latestReasonableDate = Date.UTC(2100, 0, 1);
  return Number.isSafeInteger(parsed) && parsed >= Date.UTC(2000, 0, 1) && parsed < latestReasonableDate
    ? parsed
    : null;
}

function parseLegacyRelativeTime(value: string, nowMs: number): number | null {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;

  const match = value.match(
    /^(Today|Yesterday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s*(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i,
  );
  if (!match) return null;

  const [, relativeDay, rawHour, rawMinute, meridiem] = match;
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;

  const date = new Date(nowMs);
  if (relativeDay.toLowerCase() === "yesterday") {
    date.setDate(date.getDate() - 1);
  } else if (relativeDay.toLowerCase() !== "today") {
    const weekdays = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const targetDay = weekdays.indexOf(relativeDay.toLowerCase());
    if (targetDay < 0) return null;
    date.setDate(date.getDate() - ((date.getDay() - targetDay + 7) % 7));
  }

  const normalizedHour = (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
  date.setHours(normalizedHour, minute, 0, 0);
  return date.getTime();
}

function readOccurredAt(
  candidate: Record<string, unknown>,
  id: string,
  legacyTime: string | null,
  nowMs: number,
): number | null {
  return (
    readExplicitOccurredAt(candidate.occurredAt) ??
    readTimestampFromId(id) ??
    (legacyTime ? parseLegacyRelativeTime(legacyTime, nowMs) : null)
  );
}

export function retainRecoverableEventHistory(
  events: PlannerEventEntry[],
  requestedLimit = MAX_RECOVERABLE_EVENTS,
): PlannerEventEntry[] {
  const limit = Math.min(
    MAX_RECOVERABLE_EVENTS,
    Math.max(0, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 0),
  );
  return events.slice(0, limit);
}

export function migrateEventHistory(
  value: unknown,
  migrateSnapshot: (snapshot: unknown) => PlannerData,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): PlannerEventEntry[] {
  if (!Array.isArray(value)) return [];

  const migrated = value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = readNonemptyString(candidate.id, 200);
    const command = readNonemptyString(candidate.command, 200);
    const summary = readNonemptyString(candidate.summary, 4_000);
    const target = readNonemptyString(candidate.target, 1_000);
    const legacyTime = readNonemptyString(candidate.time, 1_000);
    if (!id || !command || !summary || !target) return [];

    const occurredAt = readOccurredAt(candidate, id, legacyTime, nowMs);
    if (occurredAt === null && !legacyTime) return [];
    const event: PlannerEventEntry = {
      id,
      actor: candidate.actor === "Codex" ? "Codex" : "Household",
      command,
      summary,
      target,
      changes: Array.isArray(candidate.changes)
        ? candidate.changes.filter(
            (change): change is string =>
              typeof change === "string" && change.length <= 4_000,
          )
        : [],
      time: occurredAt === null ? legacyTime ?? undefined : formatPlannerEventTime(occurredAt, nowMs),
    };
    if (occurredAt !== null) event.occurredAt = occurredAt;
    if (isRecord(candidate.before)) {
      try {
        event.before = migrateSnapshot(candidate.before);
      } catch {
        // A damaged recovery snapshot must not discard otherwise useful history metadata.
      }
    }
    return [event];
  });

  return retainRecoverableEventHistory(migrated);
}

function cloneChatMessage(message: PlannerChatMessage): PlannerChatMessage {
  const cloned: PlannerChatMessage = {
    id: message.id,
    role: message.role,
    text: message.text,
  };
  if (message.context !== undefined) cloned.context = message.context;
  if (message.changes !== undefined) cloned.changes = [...message.changes];
  return cloned;
}

function decodeChatMessage(value: unknown): PlannerChatMessage | null {
  if (!isRecord(value)) return null;
  const id = readNonemptyString(value.id, 200);
  const text = readNonemptyString(value.text, 12_000);
  if (!id || !text || (value.role !== "assistant" && value.role !== "user")) return null;
  if (value.context !== undefined && readString(value.context, 1_000) === null) return null;
  if (
    value.changes !== undefined &&
    (!Array.isArray(value.changes) ||
      !value.changes.every(
        (change) => typeof change === "string" && change.length <= 4_000,
      ))
  ) {
    return null;
  }

  const message: PlannerChatMessage = { id, role: value.role, text };
  if (typeof value.context === "string") message.context = value.context;
  if (Array.isArray(value.changes)) message.changes = [...value.changes];
  return message;
}

export function migrateChatMessages(
  value: unknown,
  fallback: PlannerChatMessage[] = [],
): PlannerChatMessage[] {
  if (!Array.isArray(value)) return fallback.map(cloneChatMessage);
  const decoded = value.map(decodeChatMessage);
  if (decoded.some((message) => message === null)) return fallback.map(cloneChatMessage);
  const messages = decoded as PlannerChatMessage[];
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    return fallback.map(cloneChatMessage);
  }
  return messages;
}
