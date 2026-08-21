import { db } from "../../database/client.js";

export interface ProactivitySettings {
  enabled: boolean;
  morningBriefEnabled: boolean;
  morningTime: string;
  tomorrowPreviewEnabled: boolean;
  tomorrowTime: string;
  suppressEmpty: boolean;
}

export const DEFAULT_PROACTIVITY_SETTINGS: ProactivitySettings = {
  enabled: true,
  morningBriefEnabled: true,
  morningTime: "07:30",
  tomorrowPreviewEnabled: true,
  tomorrowTime: "20:30",
  suppressEmpty: true,
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

export async function getProactivitySettings(memberId: string): Promise<ProactivitySettings> {
  const result = await db.query<{
    enabled: boolean;
    morning_brief_enabled: boolean;
    morning_time: string;
    tomorrow_preview_enabled: boolean;
    tomorrow_time: string;
    suppress_empty: boolean;
  }>(
    `SELECT enabled, morning_brief_enabled, morning_time::text,
            tomorrow_preview_enabled, tomorrow_time::text, suppress_empty
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
  };
}

export async function updateProactivitySettings(
  memberId: string,
  patch: Partial<ProactivitySettings>,
): Promise<ProactivitySettings> {
  const current = await getProactivitySettings(memberId);
  const next: ProactivitySettings = {
    enabled: patch.enabled ?? current.enabled,
    morningBriefEnabled: patch.morningBriefEnabled ?? current.morningBriefEnabled,
    morningTime: normalizeClock(patch.morningTime ?? current.morningTime),
    tomorrowPreviewEnabled: patch.tomorrowPreviewEnabled ?? current.tomorrowPreviewEnabled,
    tomorrowTime: normalizeClock(patch.tomorrowTime ?? current.tomorrowTime),
    suppressEmpty: patch.suppressEmpty ?? current.suppressEmpty,
  };

  await db.query(
    `INSERT INTO member_proactivity_settings(
       member_id, enabled, morning_brief_enabled, morning_time,
       tomorrow_preview_enabled, tomorrow_time, suppress_empty, updated_at
     ) VALUES ($1,$2,$3,$4::time,$5,$6::time,$7,now())
     ON CONFLICT(member_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   morning_brief_enabled = EXCLUDED.morning_brief_enabled,
                   morning_time = EXCLUDED.morning_time,
                   tomorrow_preview_enabled = EXCLUDED.tomorrow_preview_enabled,
                   tomorrow_time = EXCLUDED.tomorrow_time,
                   suppress_empty = EXCLUDED.suppress_empty,
                   updated_at = now()`,
    [
      memberId,
      next.enabled,
      next.morningBriefEnabled,
      next.morningTime,
      next.tomorrowPreviewEnabled,
      next.tomorrowTime,
      next.suppressEmpty,
    ],
  );
  return next;
}
