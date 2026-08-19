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

export interface BootstrapInput {
  householdName: string;
  timezone: string;
  ownerName: string;
  ownerLocale?: string;
}

export interface BootstrapResult {
  household: {
    id: string;
    name: string;
    timezone: string;
  };
  owner: {
    id: string;
    displayName: string;
    role: "owner";
    locale?: string;
    timezone: string;
  };
}

export class AlreadyConfiguredError extends Error {
  constructor() {
    super("SOL is already configured");
    this.name = "AlreadyConfiguredError";
  }
}

function requiredText(value: string, label: string, maxLength = 120): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function validateTimezone(value: string): string {
  const timezone = requiredText(value, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("timezone must be a valid IANA timezone");
  }
  return timezone;
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

export async function bootstrapHousehold(input: BootstrapInput): Promise<BootstrapResult> {
  const householdName = requiredText(input.householdName, "householdName");
  const ownerName = requiredText(input.ownerName, "ownerName");
  const timezone = validateTimezone(input.timezone);
  const ownerLocale = input.ownerLocale?.trim() || undefined;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Serialize first-run setup attempts so two tabs cannot create two households.
    await client.query("SELECT pg_advisory_xact_lock($1)", [1397705804]);

    const existing = await client.query("SELECT 1 FROM households LIMIT 1");
    if (existing.rowCount) throw new AlreadyConfiguredError();

    const householdResult = await client.query<{
      id: string;
      name: string;
      timezone: string;
    }>(
      `INSERT INTO households(name, timezone)
       VALUES ($1, $2)
       RETURNING id, name, timezone`,
      [householdName, timezone],
    );
    const household = householdResult.rows[0];
    if (!household) throw new Error("Failed to create household");

    const ownerResult = await client.query<{
      id: string;
      display_name: string;
      locale: string | null;
      timezone: string | null;
    }>(
      `INSERT INTO members(
         household_id, display_name, role, status, locale, timezone
       ) VALUES ($1, $2, 'owner', 'active', $3, $4)
       RETURNING id, display_name, locale, timezone`,
      [household.id, ownerName, ownerLocale ?? null, timezone],
    );
    const owner = ownerResult.rows[0];
    if (!owner) throw new Error("Failed to create owner member");

    await client.query("COMMIT");

    return {
      household,
      owner: {
        id: owner.id,
        displayName: owner.display_name,
        role: "owner",
        locale: owner.locale ?? undefined,
        timezone: owner.timezone ?? timezone,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listMembers(householdId: string) {
  const result = await db.query<{
    id: string;
    display_name: string;
    role: string;
    status: string;
    locale: string | null;
    timezone: string | null;
  }>(
    `SELECT id, display_name, role::text, status::text, locale, timezone
     FROM members
     WHERE household_id = $1
     ORDER BY created_at ASC`,
    [householdId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    locale: row.locale ?? undefined,
    timezone: row.timezone ?? undefined,
  }));
}
