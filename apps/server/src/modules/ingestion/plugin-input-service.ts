import { createHash } from "node:crypto";
import { db } from "../../database/client.js";
import { scoreIntelligenceCandidate } from "../knowledge/intelligence-gate.js";

export interface PluginRuntimePrincipal {
  pluginId: string;
  householdId: string;
  memberId: string;
  permissions: string[];
}

export interface PluginInputAccount {
  id: string;
  householdId: string;
  ownerMemberId: string;
  provider: string;
  externalAccountId: string;
  label: string;
  status: "connected" | "disconnected" | "error";
  authMode: string;
  lastSyncAt?: string;
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KINDS = new Set(["message", "email", "calendar_event", "document", "sensor_event", "other"]);

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}_required`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${name}_too_long`);
  return result;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name}_must_be_text`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${name}_too_long`);
  return result || undefined;
}

function isoDate(value: unknown, name: string, fallback?: Date): Date {
  if ((value === undefined || value === null || value === "") && fallback) return fallback;
  if (typeof value !== "string") throw new Error(`${name}_required`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`${name}_invalid`);
  return result;
}

function metadataValue(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata_must_be_object");
  const encoded = JSON.stringify(value);
  if (encoded.length > 100_000) throw new Error("metadata_too_large");
  return value as Record<string, unknown>;
}

function rowAccount(row: {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  provider: string;
  external_account_id: string | null;
  label: string;
  status: PluginInputAccount["status"];
  auth_mode: string | null;
  last_sync_at: Date | null;
}): PluginInputAccount {
  if (!row.owner_member_id || !row.external_account_id || !row.auth_mode) throw new Error("plugin_input_account_invalid");
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id,
    provider: row.provider,
    externalAccountId: row.external_account_id,
    label: row.label,
    status: row.status,
    authMode: row.auth_mode,
    lastSyncAt: row.last_sync_at?.toISOString(),
  };
}

function pluginAuthMode(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export async function registerPluginInput(
  principal: PluginRuntimePrincipal,
  input: { provider?: unknown; externalAccountId?: unknown; label?: unknown },
): Promise<PluginInputAccount> {
  const provider = requiredText(input.provider, "provider", 80).toLowerCase();
  if (!PROVIDER_RE.test(provider)) throw new Error("provider_invalid");
  const externalAccountId = requiredText(input.externalAccountId, "external_account_id", 500);
  const label = requiredText(input.label, "label", 120);
  const authMode = pluginAuthMode(principal.pluginId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO source_accounts(
         household_id, owner_member_id, provider, external_account_id, label,
         status, auth_mode, config
       ) VALUES ($1,$2,$3,$4,$5,'disconnected',$6,$7::jsonb)
       ON CONFLICT(household_id, provider, external_account_id) DO NOTHING`,
      [
        principal.householdId,
        principal.memberId,
        provider,
        externalAccountId,
        label,
        authMode,
        JSON.stringify({ pluginId: principal.pluginId }),
      ],
    );
    const result = await client.query<{
      id: string;
      household_id: string;
      owner_member_id: string | null;
      provider: string;
      external_account_id: string | null;
      label: string;
      status: PluginInputAccount["status"];
      auth_mode: string | null;
      last_sync_at: Date | null;
    }>(
      `SELECT id, household_id, owner_member_id, provider, external_account_id,
              label, status::text, auth_mode, last_sync_at
       FROM source_accounts
       WHERE household_id=$1 AND provider=$2 AND external_account_id=$3
       FOR UPDATE`,
      [principal.householdId, provider, externalAccountId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("plugin_input_registration_failed");
    if (row.auth_mode !== authMode || row.owner_member_id !== principal.memberId) {
      throw new Error("input_account_owned_by_other_runtime");
    }
    await client.query(
      `UPDATE source_accounts SET label=$2, updated_at=now() WHERE id=$1`,
      [row.id, label],
    );
    row.label = label;
    await client.query("COMMIT");
    return rowAccount(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ownedInput(principal: PluginRuntimePrincipal, sourceAccountId: string) {
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    provider: string;
    external_account_id: string | null;
    label: string;
    status: PluginInputAccount["status"];
    auth_mode: string | null;
    last_sync_at: Date | null;
  }>(
    `SELECT id, household_id, owner_member_id, provider, external_account_id,
            label, status::text, auth_mode, last_sync_at
     FROM source_accounts WHERE id=$1 AND household_id=$2 LIMIT 1`,
    [sourceAccountId, principal.householdId],
  );
  const row = result.rows[0];
  if (!row || row.auth_mode !== pluginAuthMode(principal.pluginId) || row.owner_member_id !== principal.memberId) {
    throw new Error("plugin_input_not_found");
  }
  return rowAccount(row);
}

export async function updatePluginInputStatus(
  principal: PluginRuntimePrincipal,
  sourceAccountId: string,
  input: { status?: unknown; lastSyncAt?: unknown },
): Promise<PluginInputAccount> {
  await ownedInput(principal, sourceAccountId);
  const status = input.status;
  if (status !== "connected" && status !== "disconnected" && status !== "error") throw new Error("status_invalid");
  const lastSyncAt = input.lastSyncAt === undefined ? undefined : isoDate(input.lastSyncAt, "last_sync_at");
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    provider: string;
    external_account_id: string | null;
    label: string;
    status: PluginInputAccount["status"];
    auth_mode: string | null;
    last_sync_at: Date | null;
  }>(
    `UPDATE source_accounts
     SET status=$2::source_status,
         last_sync_at=COALESCE($3,last_sync_at),
         updated_at=now()
     WHERE id=$1
     RETURNING id, household_id, owner_member_id, provider, external_account_id,
               label, status::text, auth_mode, last_sync_at`,
    [sourceAccountId, status, lastSyncAt ?? null],
  );
  if (!result.rows[0]) throw new Error("plugin_input_not_found");
  return rowAccount(result.rows[0]);
}

export async function ingestPluginItem(
  principal: PluginRuntimePrincipal,
  sourceAccountId: string,
  input: {
    externalId?: unknown;
    kind?: unknown;
    occurredAt?: unknown;
    observedAt?: unknown;
    title?: unknown;
    text?: unknown;
    metadata?: unknown;
    origin?: unknown;
  },
): Promise<{ stored: boolean; sourceItemId: string; candidate: boolean }> {
  const account = await ownedInput(principal, sourceAccountId);
  const externalId = requiredText(input.externalId, "external_id", 1000);
  const kind = requiredText(input.kind, "kind", 40);
  if (!KINDS.has(kind)) throw new Error("kind_invalid");
  const occurredAt = isoDate(input.occurredAt, "occurred_at");
  const observedAt = isoDate(input.observedAt, "observed_at", new Date());
  const title = optionalText(input.title, "title", 1000);
  const text = optionalText(input.text, "text", 200_000);
  const origin = optionalText(input.origin, "origin", 40) ?? "realtime";
  const suppliedMetadata = metadataValue(input.metadata);
  const metadata = {
    ...suppliedMetadata,
    pluginId: principal.pluginId,
    provider: account.provider,
    origin,
  };
  const visibility = account.ownerMemberId ? "private" : "family";
  const contentHash = title || text
    ? createHash("sha256").update(`${title ?? ""}\n${text ?? ""}`).digest("hex")
    : null;
  const intelligence = scoreIntelligenceCandidate({
    provider: account.provider,
    title,
    bodyText: text,
    metadata,
  });
  const operationalCandidate = Boolean(text) && intelligence.routes.includes("operational");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sourceResult = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind, owner_member_id,
         visibility, occurred_at, observed_at, title, body_text, content_hash, raw_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6::visibility_scope,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT(source_account_id, kind, external_id)
       DO UPDATE SET
         occurred_at=EXCLUDED.occurred_at,
         observed_at=EXCLUDED.observed_at,
         title=COALESCE(EXCLUDED.title,source_items.title),
         body_text=COALESCE(EXCLUDED.body_text,source_items.body_text),
         content_hash=COALESCE(EXCLUDED.content_hash,source_items.content_hash),
         raw_metadata=source_items.raw_metadata || EXCLUDED.raw_metadata,
         deleted_at=NULL
       RETURNING id,(xmax=0) AS inserted`,
      [
        principal.householdId,
        account.id,
        externalId,
        kind,
        account.ownerMemberId,
        visibility,
        occurredAt,
        observedAt,
        title ?? null,
        text ?? null,
        contentHash,
        JSON.stringify(metadata),
      ],
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error("plugin_item_persist_failed");

    await client.query(
      `UPDATE source_accounts
       SET status='connected', last_sync_at=GREATEST(COALESCE(last_sync_at,$2),$2), updated_at=now()
       WHERE id=$1`,
      [account.id, observedAt],
    );

    let candidate = false;
    if (operationalCandidate) {
      const candidateResult = await client.query<{ id: string }>(
        `INSERT INTO extraction_candidates(
           household_id, source_item_id, owner_member_id, source_provider, score, reasons
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT(source_item_id) DO NOTHING
         RETURNING id`,
        [
          principal.householdId,
          source.id,
          account.ownerMemberId,
          account.provider,
          intelligence.operationalScore,
          JSON.stringify(intelligence.reasons),
        ],
      );
      const candidateId = candidateResult.rows[0]?.id;
      candidate = Boolean(candidateId);
      if (candidateId && origin === "realtime") {
        await client.query(
          `INSERT INTO event_outbox(
             household_id, event_type, aggregate_type, aggregate_id, payload
           ) VALUES ($1,'intelligence.candidate.detected','extraction_candidate',$2,$3::jsonb)`,
          [
            principal.householdId,
            candidateId,
            JSON.stringify({ candidateId, sourceItemId: source.id, ownerMemberId: account.ownerMemberId, provider: account.provider }),
          ],
        );
      }
    }

    await client.query("COMMIT");
    return { stored: source.inserted, sourceItemId: source.id, candidate };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
