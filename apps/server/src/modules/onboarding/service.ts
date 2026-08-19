import { db } from "../../database/client.js";
import { hashPassword } from "../auth/password.js";

export interface BootstrapInput {
  householdName: string;
  timezone: string;
  ownerName: string;
  ownerLogin: string;
  ownerPassword: string;
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
    loginName: string;
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

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function requiredText(value: unknown, label: string, maxLength = 120): string {
  if (typeof value !== "string") throw new ValidationError(`${label} is required`);
  const normalized = value.trim();
  if (!normalized) throw new ValidationError(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new ValidationError(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function validateTimezone(value: unknown): string {
  const timezone = requiredText(value, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ValidationError("timezone must be a valid IANA timezone");
  }
  return timezone;
}

function validateLogin(value: unknown): string {
  const login = requiredText(value, "ownerLogin", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(login)) {
    throw new ValidationError(
      "ownerLogin must be 3-40 characters using letters, numbers, dot, dash or underscore",
    );
  }
  return login;
}

async function validatedPasswordHash(value: unknown): Promise<string> {
  if (typeof value !== "string") throw new ValidationError("ownerPassword is required");
  try {
    return await hashPassword(value);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : "invalid ownerPassword",
    );
  }
}

export async function bootstrapHousehold(input: BootstrapInput): Promise<BootstrapResult> {
  const householdName = requiredText(input.householdName, "householdName");
  const ownerName = requiredText(input.ownerName, "ownerName");
  const ownerLogin = validateLogin(input.ownerLogin);
  const timezone = validateTimezone(input.timezone);
  const passwordHash = await validatedPasswordHash(input.ownerPassword);
  const ownerLocale =
    typeof input.ownerLocale === "string" && input.ownerLocale.trim()
      ? input.ownerLocale.trim().slice(0, 35)
      : undefined;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Serialize first-run attempts so two tabs cannot create two initial households.
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
      login_name: string;
      locale: string | null;
      timezone: string | null;
    }>(
      `INSERT INTO members(
         household_id, display_name, login_name, role, status, locale, timezone
       ) VALUES ($1, $2, $3, 'owner', 'active', $4, $5)
       RETURNING id, display_name, login_name, locale, timezone`,
      [household.id, ownerName, ownerLogin, ownerLocale ?? null, timezone],
    );
    const owner = ownerResult.rows[0];
    if (!owner) throw new Error("Failed to create owner member");

    await client.query(
      `INSERT INTO member_credentials(member_id, password_hash)
       VALUES ($1, $2)`,
      [owner.id, passwordHash],
    );

    await client.query(
      `INSERT INTO event_outbox(
         household_id, event_type, aggregate_type, aggregate_id, payload
       ) VALUES ($1, 'household.bootstrapped', 'household', $1, $2::jsonb)`,
      [
        household.id,
        JSON.stringify({
          householdId: household.id,
          ownerMemberId: owner.id,
          occurredBy: "onboarding",
        }),
      ],
    );

    await client.query("COMMIT");

    return {
      household,
      owner: {
        id: owner.id,
        displayName: owner.display_name,
        loginName: owner.login_name,
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
