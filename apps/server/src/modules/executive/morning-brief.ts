import { db } from "../../database/client.js";
import { config } from "../../config.js";
import type { AuthPrincipal } from "../auth/session.js";
import { syncGmailAccount } from "../connectors/gmail/sync.js";
import { syncGoogleCalendarAccount } from "../connectors/google-calendar/sync.js";
import { syncMercadoLibreAccount } from "../connectors/mercadolibre/sync.js";
import { buildExecutiveBrief } from "./briefs.js";
import { approveExecutiveProposal, listExecutiveProposals } from "./proposals.js";
import { getProactivitySettings } from "./proactivity.js";
import { fetchMorningWhatsappSummary, type SafeMorningWhatsappSummary } from "./whatsapp-brief-source.js";

export interface MorningBriefRun {
  id: string; scheduledFor: string; startedAt: string; finishedAt?: string;
  status: "running" | "completed" | "partial" | "failed" | "preview";
  sourcesChecked: Record<string, unknown>; sourceErrors: Record<string, string>;
  eventsCreated: string[]; eventsUpdated: string[]; actions: unknown[];
  whatsappMessageId?: string; summary?: string; dryRun: boolean;
}

function localDate(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function retry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); } catch (error) { last = error; }
  }
  throw last;
}

function mapRun(row: Record<string, any>): MorningBriefRun {
  return {
    id: row.id, scheduledFor: String(row.scheduled_for), startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : undefined,
    status: row.status, sourcesChecked: row.sources_checked ?? {}, sourceErrors: row.source_errors ?? {},
    eventsCreated: row.events_created ?? [], eventsUpdated: row.events_updated ?? [], actions: row.actions ?? [],
    whatsappMessageId: row.whatsapp_message_id ?? undefined, summary: row.summary ?? undefined, dryRun: row.dry_run,
  };
}

export async function getLastMorningBrief(memberId: string): Promise<MorningBriefRun | null> {
  const result = await db.query(`SELECT * FROM morning_brief_runs WHERE member_id=$1 ORDER BY started_at DESC LIMIT 1`, [memberId]);
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

async function sourceAccounts(principal: AuthPrincipal, provider: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM source_accounts WHERE household_id=$1 AND provider=$2 AND status='connected'
       AND (owner_member_id=$3 OR owner_member_id IS NULL)`,
    [principal.householdId, provider, principal.memberId],
  );
  return result.rows.map((row) => row.id);
}

export async function runMorningBrief(principal: AuthPrincipal, dryRun = false): Promise<MorningBriefRun> {
  const settings = await getProactivitySettings(principal.memberId);
  const scheduledFor = localDate(settings.morningTimezone);
  if (!dryRun) {
    const claimed = await db.query<{ id: string }>(
      `INSERT INTO morning_brief_runs(member_id,household_id,scheduled_for,status,dry_run)
       VALUES($1,$2,$3,'running',false) ON CONFLICT DO NOTHING RETURNING id`,
      [principal.memberId, principal.householdId, scheduledFor],
    );
    if (!claimed.rows[0]) {
      const existing = await db.query(`SELECT * FROM morning_brief_runs WHERE member_id=$1 AND scheduled_for=$2 AND dry_run=false`, [principal.memberId, scheduledFor]);
      return mapRun(existing.rows[0]);
    }
  }
  const run = await db.query<{ id: string }>(
    dryRun
      ? `INSERT INTO morning_brief_runs(member_id,household_id,scheduled_for,status,dry_run) VALUES($1,$2,$3,'running',true) RETURNING id`
      : `SELECT id FROM morning_brief_runs WHERE member_id=$1 AND scheduled_for=$3 AND dry_run=false`,
    [principal.memberId, principal.householdId, scheduledFor],
  );
  const runId = run.rows[0]!.id;
  const checked: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const actions: unknown[] = [];
  const eventsCreated: string[] = [];
  let whatsappMessageId: string | undefined;
  let whatsappSummary: SafeMorningWhatsappSummary | undefined;
  const sync = async (name: keyof typeof settings.morningSources, provider: string, fn: (id: string) => Promise<unknown>) => {
    if (!settings.morningSources[name]) return;
    try {
      const ids = await sourceAccounts(principal, provider);
      checked[name] = await Promise.all(ids.map((id) => retry(() => fn(id))));
    } catch (error) { errors[name] = error instanceof Error ? error.message : String(error); }
  };
  await sync("calendar", "google_calendar", syncGoogleCalendarAccount);
  await Promise.all([
    sync("gmail", "gmail", syncGmailAccount),
    sync("mercadolibre", "mercadolibre", syncMercadoLibreAccount),
  ]);
  if (settings.morningSources.whatsapp) {
    try {
      const after = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      whatsappSummary = await fetchMorningWhatsappSummary({
        baseUrl: config.whatsappNexoUrl,
        after,
        limit: settings.morningMaxWhatsapp,
      });
      checked.whatsapp = {
        mode: "nexo_filtered_external_input",
        sourceClass: whatsappSummary.sourceClass,
        controlChannelExcluded: whatsappSummary.controlChannelExcluded,
        excludedSourceClasses: whatsappSummary.excludedSourceClasses,
        effectiveAfter: whatsappSummary.effectiveAfter ?? after,
        selectedMessages: whatsappSummary.selectedMessages,
      };
    } catch (error) {
      errors.whatsapp = error instanceof Error ? error.message : String(error);
    }
  }

  let summary = "";
  try {
    const brief = await buildExecutiveBrief(principal.memberId, "morning", {
      persist: !dryRun,
      whatsapp: whatsappSummary,
    });
    summary = brief.summary;
    if (!dryRun && settings.morningAutoCreateEvents) {
      const proposals = await listExecutiveProposals({ householdId: principal.householdId, memberId: principal.memberId, status: "pending" });
      for (const proposal of proposals.filter((item) => ["event", "commitment"].includes(item.kind) && Boolean(item.startsAt) && item.confidence >= 0.9)) {
        try {
          const result = await approveExecutiveProposal({ proposalId: proposal.id, householdId: principal.householdId, memberId: principal.memberId, role: principal.role });
          eventsCreated.push(proposal.id); actions.push({ type: "calendar_event", proposalId: proposal.id, result });
        } catch (error) { errors[`event:${proposal.id}`] = error instanceof Error ? error.message : String(error); }
      }
    }
    if (!dryRun && settings.morningSendWhatsapp && settings.morningWhatsappGrant) {
      if (!config.whatsappNexoAutomationToken) throw new Error("NEXO_AUTOMATION_TOKEN is not configured");
      const response = await fetch(`${config.whatsappNexoUrl}/api/automation/morning-brief/send`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.whatsappNexoAutomationToken}` },
        body: JSON.stringify({ automation: "morning_brief", scheduledFor, text: brief.summary.slice(0, 5000) }),
        signal: AbortSignal.timeout(30_000),
      });
      const delivery = await response.json() as { sent?: boolean; duplicate?: boolean; messageId?: string; error?: string };
      if (!response.ok) throw new Error(delivery.error || `whatsapp_nexo_${response.status}`);
      whatsappMessageId = delivery.messageId;
      actions.push({ type: "whatsapp_morning_brief", proactivePolicy: "morning_brief", sent: delivery.sent, duplicate: delivery.duplicate });
    }
  } catch (error) { errors.brief = error instanceof Error ? error.message : String(error); }
  const status = dryRun ? "preview" : Object.keys(errors).length ? (summary ? "partial" : "failed") : "completed";
  const result = await db.query(
    `UPDATE morning_brief_runs SET finished_at=now(),status=$2,sources_checked=$3::jsonb,source_errors=$4::jsonb,
       events_created=$5::jsonb,actions=$6::jsonb,summary=$7,whatsapp_message_id=$8 WHERE id=$1 RETURNING *`,
    [runId, status, JSON.stringify(checked), JSON.stringify(errors), JSON.stringify(eventsCreated), JSON.stringify(actions), summary, whatsappMessageId ?? null],
  );
  return mapRun(result.rows[0]);
}
