import { db } from "../../database/client.js";
import { codexProvider } from "../ai/codex/runtime.js";
import { listGoogleCalendarAccounts } from "../connectors/google-calendar/repository.js";
import {
  listUpcomingGoogleEvents,
  type UpcomingCalendarEvent,
} from "../connectors/google-calendar/sync.js";
import { listExecutiveProposals } from "./proposals.js";

interface BriefMember {
  memberId: string;
  householdId: string;
  displayName: string;
  timezone: string;
  householdName: string;
}

interface BriefTask {
  id: string;
  title: string;
  description?: string;
  dueAt?: string;
  assignedMemberId?: string;
}

export interface ExecutiveBriefContent {
  type: "morning" | "tomorrow_preview";
  periodStart: string;
  periodEnd: string;
  member: { id: string; displayName: string };
  events: UpcomingCalendarEvent[];
  tasks: BriefTask[];
  pendingProposals: Awaited<ReturnType<typeof listExecutiveProposals>>;
  conflicts: Array<{ first: string; second: string; overlapMinutes: number }>;
  summary: string;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second"),
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const representedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return representedAsUtc - date.getTime();
}

function localMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const localTarget = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = new Date(localTarget);
  for (let i = 0; i < 2; i += 1) {
    guess = new Date(localTarget - timezoneOffsetMs(guess, timezone));
  }
  return guess;
}

export function zonedDayRange(timezone: string, dayOffset = 0, now = new Date()): { start: Date; end: Date } {
  const p = localParts(now, timezone);
  const dateCursor = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset, 12));
  const y = dateCursor.getUTCFullYear();
  const m = dateCursor.getUTCMonth() + 1;
  const d = dateCursor.getUTCDate();
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
  return {
    start: localMidnightUtc(y, m, d, timezone),
    end: localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone),
  };
}

async function loadMember(memberId: string): Promise<BriefMember | null> {
  const result = await db.query<{
    member_id: string;
    household_id: string;
    display_name: string;
    member_timezone: string | null;
    household_timezone: string;
    household_name: string;
  }>(
    `SELECT m.id AS member_id, m.household_id, m.display_name,
            m.timezone AS member_timezone, h.timezone AS household_timezone,
            h.name AS household_name
     FROM members m JOIN households h ON h.id = m.household_id
     WHERE m.id = $1 AND m.status = 'active'`,
    [memberId],
  );
  const row = result.rows[0];
  return row
    ? {
        memberId: row.member_id,
        householdId: row.household_id,
        displayName: row.display_name,
        timezone: row.member_timezone || row.household_timezone,
        householdName: row.household_name,
      }
    : null;
}

async function loadTasks(member: BriefMember, end: Date): Promise<BriefTask[]> {
  const result = await db.query<{
    id: string;
    title: string;
    description: string | null;
    due_at: Date | null;
    assigned_member_id: string | null;
  }>(
    `SELECT id, title, description, due_at, assigned_member_id
     FROM tasks
     WHERE household_id = $1 AND status = 'open'
       AND (owner_member_id = $2 OR assigned_member_id = $2 OR owner_member_id IS NULL)
       AND (due_at IS NULL OR due_at < $3)
     ORDER BY due_at NULLS LAST, updated_at DESC
     LIMIT 30`,
    [member.householdId, member.memberId, end],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    dueAt: row.due_at?.toISOString(),
    assignedMemberId: row.assigned_member_id ?? undefined,
  }));
}

function eventInstant(value: { date?: string; dateTime?: string } | undefined, end = false): Date | null {
  if (!value) return null;
  if (value.dateTime) {
    const date = new Date(value.dateTime);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value.date) {
    const date = new Date(`${value.date}T00:00:00Z`);
    if (end) return date;
    return date;
  }
  return null;
}

function findConflicts(events: UpcomingCalendarEvent[]) {
  const timed = events
    .map((event) => ({ event, start: eventInstant(event.start), end: eventInstant(event.end, true) }))
    .filter((item): item is { event: UpcomingCalendarEvent; start: Date; end: Date } =>
      Boolean(item.start && item.end && item.event.start.dateTime),
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const conflicts: Array<{ first: string; second: string; overlapMinutes: number }> = [];
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      if (timed[j]!.start >= timed[i]!.end) break;
      const overlap = Math.min(timed[i]!.end.getTime(), timed[j]!.end.getTime()) - timed[j]!.start.getTime();
      if (overlap > 0) {
        conflicts.push({
          first: timed[i]!.event.title,
          second: timed[j]!.event.title,
          overlapMinutes: Math.round(overlap / 60000),
        });
      }
    }
  }
  return conflicts;
}

function fallbackSummary(content: Omit<ExecutiveBriefContent, "summary">): string {
  const pieces = [
    `${content.events.length} evento(s)`,
    `${content.tasks.length} tarea(s) pendiente(s)`,
    `${content.pendingProposals.length} propuesta(s) por revisar`,
  ];
  if (content.conflicts.length) pieces.push(`${content.conflicts.length} conflicto(s) de agenda`);
  return pieces.join(" · ");
}

export async function buildExecutiveBrief(
  memberId: string,
  type: "morning" | "tomorrow_preview" = "morning",
): Promise<ExecutiveBriefContent> {
  const member = await loadMember(memberId);
  if (!member) throw new Error("member_not_found");
  const range = zonedDayRange(member.timezone, type === "tomorrow_preview" ? 1 : 0);
  const accounts = await listGoogleCalendarAccounts(member.householdId, member.memberId, false);
  const events: UpcomingCalendarEvent[] = [];
  for (const account of accounts.filter((item) => item.status === "connected")) {
    try {
      events.push(...(await listUpcomingGoogleEvents(account.id, range.start, range.end)));
    } catch (error) {
      console.error(`[brief:${member.memberId}] calendar ${account.id} unavailable`, error);
    }
  }
  events.sort((a, b) => (eventInstant(a.start)?.getTime() ?? 0) - (eventInstant(b.start)?.getTime() ?? 0));

  const [tasks, proposals] = await Promise.all([
    loadTasks(member, range.end),
    listExecutiveProposals({ householdId: member.householdId, memberId: member.memberId, status: "pending" }),
  ]);
  const base = {
    type,
    periodStart: range.start.toISOString(),
    periodEnd: range.end.toISOString(),
    member: { id: member.memberId, displayName: member.displayName },
    events,
    tasks,
    pendingProposals: proposals,
    conflicts: findConflicts(events),
  } satisfies Omit<ExecutiveBriefContent, "summary">;

  let summary = fallbackSummary(base);
  if (await codexProvider.isAvailable()) {
    try {
      const result = await codexProvider.reason({
        householdId: member.householdId,
        memberId: member.memberId,
        purpose: "planning",
        instructions: [
          `Prepare a concise ${type === "morning" ? "today" : "tomorrow"} brief for the current SOL member.`,
          "Prioritize schedule, conflicts, time-sensitive tasks and pending proposals.",
          "Do not invent times or facts. Do not execute actions. Use natural Rioplatense Spanish.",
        ].join("\n"),
        context: {
          household: member.householdName,
          timezone: member.timezone,
          periodStart: base.periodStart,
          periodEnd: base.periodEnd,
          events: base.events,
          tasks: base.tasks,
          pendingProposals: base.pendingProposals.map((proposal) => ({
            id: proposal.id,
            kind: proposal.kind,
            title: proposal.title,
            startsAt: proposal.startsAt,
            dueAt: proposal.dueAt,
            confidence: proposal.confidence,
          })),
          conflicts: base.conflicts,
        },
      });
      summary = result.text.trim() || summary;
    } catch (error) {
      console.error(`[brief:${member.memberId}] Codex summary failed`, error);
    }
  }

  const content: ExecutiveBriefContent = { ...base, summary };
  await db.query(
    `INSERT INTO executive_briefs(
       household_id, member_id, brief_type, period_start, period_end, content
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT(household_id, member_id, brief_type, period_start, period_end)
     DO UPDATE SET content = EXCLUDED.content, created_at = now()`,
    [member.householdId, member.memberId, type, range.start, range.end, JSON.stringify(content)],
  );
  return content;
}

export async function readExecutiveBrief(
  memberId: string,
  type: "morning" | "tomorrow_preview",
): Promise<ExecutiveBriefContent | null> {
  const member = await loadMember(memberId);
  if (!member) return null;
  const range = zonedDayRange(member.timezone, type === "tomorrow_preview" ? 1 : 0);
  const result = await db.query<{ content: ExecutiveBriefContent }>(
    `SELECT content FROM executive_briefs
     WHERE household_id = $1 AND member_id = $2 AND brief_type = $3
       AND period_start = $4 AND period_end = $5`,
    [member.householdId, member.memberId, type, range.start, range.end],
  );
  return result.rows[0]?.content ?? null;
}
