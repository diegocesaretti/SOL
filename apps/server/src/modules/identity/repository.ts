import { db } from "../../database/client.js";

export interface HouseholdSummary {
  id: string;
  name: string;
  timezone: string;
  memberCount: number;
}

export interface OnboardingState {
  configured: boolean;
  households: HouseholdSummary[];
}

export async function getOnboardingState(): Promise<OnboardingState> {
  const result = await db.query<{
    id: string;
    name: string;
    timezone: string;
    member_count: string;
  }>(`
    SELECT
      h.id,
      h.name,
      h.timezone,
      COUNT(m.id)::text AS member_count
    FROM households h
    LEFT JOIN members m
      ON m.household_id = h.id
      AND m.status = 'active'
    GROUP BY h.id
    ORDER BY h.created_at ASC
  `);

  const households = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    memberCount: Number(row.member_count),
  }));

  return {
    configured: households.length > 0,
    households,
  };
}

export async function listMembers(householdId: string) {
  const result = await db.query<{
    id: string;
    display_name: string;
    login_name: string | null;
    role: string;
    status: string;
    locale: string | null;
    timezone: string | null;
  }>(
    `SELECT id, display_name, login_name, role::text, status::text, locale, timezone
     FROM members
     WHERE household_id = $1
     ORDER BY created_at ASC`,
    [householdId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    loginName: row.login_name ?? undefined,
    role: row.role,
    status: row.status,
    locale: row.locale ?? undefined,
    timezone: row.timezone ?? undefined,
  }));
}
