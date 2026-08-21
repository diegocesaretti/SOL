import { db } from "../../database/client.js";
import type { ExecutiveBriefContent } from "./briefs.js";

export interface ProactivitySettings {
  enabled: boolean;
  morningBriefEnabled: boolean;
  morningTime: string;
  tomorrowPreviewEnabled: boolean;
  tomorrowTime: string;
  suppressEmpty: boolean;
  morningTimezone: string;
  morningSources: { gmail: boolean; whatsapp: boolean; mercadolibre: boolean; calendar: boolean };
  morningAutoCreateEvents: boolean;
  morningSendWhatsapp: boolean;
  morningWhatsappGrant: boolean;
  morningMaxWhatsapp: number;
  morningMaxEmails: number;
  morningMaxMercadolibre: number;
}
export type ProactivitySettingsPatch = Partial<Omit<ProactivitySettings, "morningSources">> & {
  morningSources?: Partial<ProactivitySettings["morningSources"]>;
};

export const DEFAULT_PROACTIVITY_SETTINGS: ProactivitySettings = {
  enabled: true,
  morningBriefEnabled: true,
  morningTime: "08:00",
  tomorrowPreviewEnabled: true,
  tomorrowTime: "20:30",
  suppressEmpty: true,
  morningTimezone: "America/Argentina/Buenos_Aires",
  morningSources: { gmail: true, whatsapp: true, mercadolibre: true, calendar: true },
  morningAutoCreateEvents: true,
  morningSendWhatsapp: true,
  morningWhatsappGrant: false,
  morningMaxWhatsapp: 200,
  morningMaxEmails: 100,
  morningMaxMercadolibre: 100,
};

function normalizeClock(value: string): string {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) throw new Error("invalid_time");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("invalid_time");
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function briefHasUsefulContent(brief: ExecutiveBriefContent): boolean {
  if (brief.events.length || brief.tasks.length || brief.pendingProposals.length || brief.conflicts.length) return true;
  const business = brief.business;
  if (!business) return false;
  return Boolean(
    business.period.orders ||
    business.unansweredQuestions.length
  );
}

export async function getProactivitySettings(memberId: string): Promise<ProactivitySettings> {
  const result = await db.query<{
    enabled: boolean;
    morning_brief_enabled: boolean;
    morning_time: string;
    tomorrow_preview_enabled: boolean;
    tomorrow_time: string;
    suppress_empty: boolean;
    morning_timezone: string;
    morning_sources: ProactivitySettings["morningSources"];
    morning_auto_create_events: boolean;
    morning_send_whatsapp: boolean;
    morning_whatsapp_grant: boolean;
    morning_max_whatsapp: number;
    morning_max_emails: number;
    morning_max_mercadolibre: number;
  }>(
    `SELECT enabled, morning_brief_enabled, morning_time::text,
            tomorrow_preview_enabled, tomorrow_time::text, suppress_empty,
            morning_timezone, morning_sources, morning_auto_create_events,
            morning_send_whatsapp, morning_whatsapp_grant, morning_max_whatsapp,
            morning_max_emails, morning_max_mercadolibre
     FROM member_proactivity_settings
     WHERE member_id = $1`,
    [memberId],
  );
  const row = result.rows[0];
  if (!row) return { ...DEFAULT_PROACTIVITY_SETTINGS };
  return {
    enabled: row.enabled,
    morningBriefEnabled: row.morning_brief_enabled,
    morningTime: normalizeClock(row.morning_time),
    tomorrowPreviewEnabled: row.tomorrow_preview_enabled,
    tomorrowTime: normalizeClock(row.tomorrow_time),
    suppressEmpty: row.suppress_empty,
    morningTimezone: row.morning_timezone,
    morningSources: row.morning_sources,
    morningAutoCreateEvents: row.morning_auto_create_events,
    morningSendWhatsapp: row.morning_send_whatsapp,
    morningWhatsappGrant: row.morning_whatsapp_grant,
    morningMaxWhatsapp: row.morning_max_whatsapp,
    morningMaxEmails: row.morning_max_emails,
    morningMaxMercadolibre: row.morning_max_mercadolibre,
  };
}

export async function updateProactivitySettings(
  memberId: string,
  patch: ProactivitySettingsPatch,
): Promise<ProactivitySettings> {
  const current = await getProactivitySettings(memberId);
  const next: ProactivitySettings = {
    enabled: patch.enabled ?? current.enabled,
    morningBriefEnabled: patch.morningBriefEnabled ?? current.morningBriefEnabled,
    morningTime: normalizeClock(patch.morningTime ?? current.morningTime),
    tomorrowPreviewEnabled: patch.tomorrowPreviewEnabled ?? current.tomorrowPreviewEnabled,
    tomorrowTime: normalizeClock(patch.tomorrowTime ?? current.tomorrowTime),
    suppressEmpty: patch.suppressEmpty ?? current.suppressEmpty,
    morningTimezone: patch.morningTimezone ?? current.morningTimezone,
    morningSources: { ...current.morningSources, ...patch.morningSources },
    morningAutoCreateEvents: patch.morningAutoCreateEvents ?? current.morningAutoCreateEvents,
    morningSendWhatsapp: patch.morningSendWhatsapp ?? current.morningSendWhatsapp,
    morningWhatsappGrant: patch.morningWhatsappGrant ?? current.morningWhatsappGrant,
    morningMaxWhatsapp: Math.max(10, Math.min(2000, patch.morningMaxWhatsapp ?? current.morningMaxWhatsapp)),
    morningMaxEmails: Math.max(10, Math.min(1000, patch.morningMaxEmails ?? current.morningMaxEmails)),
    morningMaxMercadolibre: Math.max(10, Math.min(1000, patch.morningMaxMercadolibre ?? current.morningMaxMercadolibre)),
  };
  try { new Intl.DateTimeFormat("en", { timeZone: next.morningTimezone }); } catch { throw new Error("invalid_timezone"); }

  await db.query(
    `INSERT INTO member_proactivity_settings(
       member_id, enabled, morning_brief_enabled, morning_time,
       tomorrow_preview_enabled, tomorrow_time, suppress_empty, morning_timezone,
       morning_sources, morning_auto_create_events, morning_send_whatsapp,
       morning_whatsapp_grant, morning_max_whatsapp, morning_max_emails,
       morning_max_mercadolibre, updated_at
     ) VALUES ($1,$2,$3,$4::time,$5,$6::time,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,now())
     ON CONFLICT(member_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   morning_brief_enabled = EXCLUDED.morning_brief_enabled,
                   morning_time = EXCLUDED.morning_time,
                   tomorrow_preview_enabled = EXCLUDED.tomorrow_preview_enabled,
                   tomorrow_time = EXCLUDED.tomorrow_time,
                   suppress_empty = EXCLUDED.suppress_empty,
                   morning_timezone = EXCLUDED.morning_timezone,
                   morning_sources = EXCLUDED.morning_sources,
                   morning_auto_create_events = EXCLUDED.morning_auto_create_events,
                   morning_send_whatsapp = EXCLUDED.morning_send_whatsapp,
                   morning_whatsapp_grant = EXCLUDED.morning_whatsapp_grant,
                   morning_max_whatsapp = EXCLUDED.morning_max_whatsapp,
                   morning_max_emails = EXCLUDED.morning_max_emails,
                   morning_max_mercadolibre = EXCLUDED.morning_max_mercadolibre,
                   updated_at = now()`,
    [
      memberId,
      next.enabled,
      next.morningBriefEnabled,
      next.morningTime,
      next.tomorrowPreviewEnabled,
      next.tomorrowTime,
      next.suppressEmpty,
      next.morningTimezone,
      JSON.stringify(next.morningSources),
      next.morningAutoCreateEvents,
      next.morningSendWhatsapp,
      next.morningWhatsappGrant,
      next.morningMaxWhatsapp,
      next.morningMaxEmails,
      next.morningMaxMercadolibre,
    ],
  );
  return next;
}

export async function briefDeliveryHandled(
  memberId: string,
  brief: ExecutiveBriefContent,
): Promise<boolean> {
  const result = await db.query<{ delivery_requested_at: Date | null }>(
    `SELECT delivery_requested_at
     FROM executive_briefs
     WHERE member_id = $1
       AND brief_type = $2
       AND period_start = $3
       AND period_end = $4`,
    [memberId, brief.type, new Date(brief.periodStart), new Date(brief.periodEnd)],
  );
  return Boolean(result.rows[0]?.delivery_requested_at);
}

export async function requestBriefDelivery(
  memberId: string,
  brief: ExecutiveBriefContent,
  suppressEmpty: boolean,
): Promise<{ requested: boolean; suppressed: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      id: string;
      household_id: string;
      delivery_requested_at: Date | null;
    }>(
      `SELECT id, household_id, delivery_requested_at
       FROM executive_briefs
       WHERE member_id = $1
         AND brief_type = $2
         AND period_start = $3
         AND period_end = $4
       FOR UPDATE`,
      [memberId, brief.type, new Date(brief.periodStart), new Date(brief.periodEnd)],
    );
    const row = found.rows[0];
    if (!row) throw new Error("brief_not_persisted");
    if (row.delivery_requested_at) {
      await client.query("COMMIT");
      return { requested: false, suppressed: false };
    }

    await client.query(
      `UPDATE executive_briefs
       SET delivery_requested_at = now()
       WHERE id = $1`,
      [row.id],
    );

    if (suppressEmpty && !briefHasUsefulContent(brief)) {
      await client.query("COMMIT");
      return { requested: false, suppressed: true };
    }

    await client.query(
      `INSERT INTO event_outbox(
         household_id, event_type, aggregate_type, aggregate_id, payload
       ) VALUES ($1, 'executive.brief.created', 'executive_brief', $2, $3::jsonb)`,
      [
        row.household_id,
        row.id,
        JSON.stringify({ briefId: row.id, memberId }),
      ],
    );
    await client.query("COMMIT");
    return { requested: true, suppressed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
