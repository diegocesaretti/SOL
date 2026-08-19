import { db } from "../../database/client.js";
import { hashPassword } from "../auth/password.js";

export type NewMemberRole = "adult" | "member" | "child" | "guest";

export interface CreateMemberInput {
  householdId: string;
  displayName: string;
  loginName: string;
  password: string;
  role: NewMemberRole;
  locale?: string;
  timezone?: string;
}

export class MemberValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberValidationError";
  }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemberValidationError(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new MemberValidationError(`${label} is too long`);
  }
  return normalized;
}

function validateLogin(value: unknown): string {
  const login = requiredText(value, "loginName", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(login)) {
    throw new MemberValidationError(
      "loginName must be 3-40 characters using letters, numbers, dot, dash or underscore",
    );
  }
  return login;
}

function validateRole(value: unknown): NewMemberRole {
  if (value === "adult" || value === "member" || value === "child" || value === "guest") {
    return value;
  }
  throw new MemberValidationError("invalid member role");
}

function validateTimezone(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  const timezone = requiredText(value, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new MemberValidationError("timezone must be a valid IANA timezone");
  }
  return timezone;
}

export async function createMember(input: CreateMemberInput) {
  const displayName = requiredText(input.displayName, "displayName", 120);
  const loginName = validateLogin(input.loginName);
  const role = validateRole(input.role);

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.password);
  } catch (error) {
    throw new MemberValidationError(
      error instanceof Error ? error.message : "invalid password",
    );
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const householdResult = await client.query<{ timezone: string }>(
      "SELECT timezone FROM households WHERE id = $1",
      [input.householdId],
    );
    const household = householdResult.rows[0];
    if (!household) throw new MemberValidationError("household not found");

    const timezone = validateTimezone(input.timezone, household.timezone);
    const locale = input.locale?.trim().slice(0, 35) || undefined;

    const memberResult = await client.query<{
      id: string;
      display_name: string;
      login_name: string;
      role: NewMemberRole;
      status: "active";
      locale: string | null;
      timezone: string | null;
    }>(
      `INSERT INTO members(
         household_id, display_name, login_name, role, status, locale, timezone
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6)
       RETURNING id, display_name, login_name, role::text, status::text, locale, timezone`,
      [
        input.householdId,
        displayName,
        loginName,
        role,
        locale ?? null,
        timezone,
      ],
    );
    const member = memberResult.rows[0];
    if (!member) throw new Error("Failed to create member");

    await client.query(
      `INSERT INTO member_credentials(member_id, password_hash)
       VALUES ($1, $2)`,
      [member.id, passwordHash],
    );

    await client.query(
      `INSERT INTO event_outbox(
         household_id, event_type, aggregate_type, aggregate_id, payload
       ) VALUES ($1, 'member.created', 'member', $2, $3::jsonb)`,
      [
        input.householdId,
        member.id,
        JSON.stringify({
          memberId: member.id,
          role: member.role,
        }),
      ],
    );

    await client.query("COMMIT");

    return {
      id: member.id,
      displayName: member.display_name,
      loginName: member.login_name,
      role: member.role,
      status: member.status,
      locale: member.locale ?? undefined,
      timezone: member.timezone ?? timezone,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      throw new MemberValidationError("loginName is already in use in this household");
    }
    throw error;
  } finally {
    client.release();
  }
}
