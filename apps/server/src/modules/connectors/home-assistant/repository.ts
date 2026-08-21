import { randomUUID } from "node:crypto";
import { config } from "../../../config.js";
import { db } from "../../../database/client.js";
import { fetchHomeAssistantStates, normalizeHomeAssistantBaseUrl, testHomeAssistantConnection, type HomeAssistantState } from "./client.js";
import { openHomeAssistantToken, sealHomeAssistantToken } from "./crypto.js";

export interface HomeAssistantAccount {
  id: string;
  householdId: string;
  label: string;
  baseUrl: string;
  status: "connected" | "disconnected" | "error";
  haVersion?: string;
  lastConnectedAt?: string;
  lastError?: string;
}

export interface HomeAssistantEntity {
  sourceAccountId: string;
  entityId: string;
  domain: string;
  friendlyName?: string;
  deviceClass?: string;
  unitOfMeasurement?: string;
  selectedForSync: boolean;
  selectedForControl: boolean;
  recordMode: "snapshot" | "changes";
  currentState?: string;
  currentAttributes: Record<string, unknown>;
  lastChanged?: string;
  lastUpdated?: string;
}

interface AccountRow {
  id: string;
  household_id: string;
  label: string;
  status: HomeAssistantAccount["status"];
  base_url: string;
  ha_version: string | null;
  last_connected_at: Date | null;
  last_error: string | null;
}

function mapAccount(row: AccountRow): HomeAssistantAccount {
  return {
    id: row.id,
    householdId: row.household_id,
    label: row.label,
    baseUrl: row.base_url,
    status: row.status,
    haVersion: row.ha_version ?? undefined,
    lastConnectedAt: row.last_connected_at?.toISOString(),
    lastError: row.last_error ?? undefined,
  };
}

const ACCOUNT_SELECT = `
  SELECT sa.id, sa.household_id, sa.label, sa.status::text AS status,
         hc.base_url, hc.ha_version, hc.last_connected_at, hc.last_error
  FROM source_accounts sa
  JOIN home_assistant_credentials hc ON hc.source_account_id = sa.id
  WHERE sa.provider = 'home_assistant'
`;

export async function createHomeAssistantAccount(input: {
  householdId: string;
  label?: string;
  baseUrl: string;
  token: string;
}): Promise<HomeAssistantAccount> {
  const baseUrl = normalizeHomeAssistantBaseUrl(input.baseUrl);
  const token = input.token.trim();
  if (token.length < 20 || token.length > 4096) throw new Error("Home Assistant token looks invalid");
  await testHomeAssistantConnection(baseUrl, token);

  const id = randomUUID();
  const encryptedToken = await sealHomeAssistantToken(token, id);
  const label = input.label?.trim().slice(0, 120) || "Home Assistant";
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const household = await client.query("SELECT 1 FROM households WHERE id = $1", [input.householdId]);
    if (!household.rowCount) throw new Error("household_not_found");
    await client.query(
      `INSERT INTO source_accounts(
         id, household_id, owner_member_id, provider, label, status, auth_mode
       ) VALUES ($1, $2, NULL, 'home_assistant', $3, 'connected', 'long-lived-access-token')`,
      [id, input.householdId, label],
    );
    await client.query(
      `INSERT INTO home_assistant_credentials(
         source_account_id, base_url, encrypted_token, last_connected_at
       ) VALUES ($1, $2, $3, now())`,
      [id, baseUrl, encryptedToken],
    );
    await client.query(
      `INSERT INTO event_outbox(
         household_id, event_type, aggregate_type, aggregate_id, payload
       ) VALUES ($1, 'source_account.created', 'source_account', $2, $3::jsonb)`,
      [input.householdId, id, JSON.stringify({ sourceAccountId: id, provider: "home_assistant", ownerMemberId: null })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await discoverHomeAssistantEntities(id);
  const account = await getHomeAssistantAccount(id);
  if (!account) throw new Error("Home Assistant account disappeared after creation");
  return account;
}

export async function listHomeAssistantAccounts(householdId: string): Promise<HomeAssistantAccount[]> {
  const result = await db.query<AccountRow>(
    `${ACCOUNT_SELECT} AND sa.household_id = $1 ORDER BY sa.created_at ASC`,
    [householdId],
  );
  return result.rows.map(mapAccount);
}

export async function getHomeAssistantAccount(sourceAccountId: string): Promise<HomeAssistantAccount | null> {
  const result = await db.query<AccountRow>(`${ACCOUNT_SELECT} AND sa.id = $1 LIMIT 1`, [sourceAccountId]);
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

export async function loadHomeAssistantCredential(sourceAccountId: string): Promise<{
  baseUrl: string;
  token: string;
} | null> {
  const result = await db.query<{ base_url: string; encrypted_token: string }>(
    `SELECT base_url, encrypted_token FROM home_assistant_credentials WHERE source_account_id = $1`,
    [sourceAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    token: await openHomeAssistantToken(row.encrypted_token, sourceAccountId),
  };
}

export async function listConfiguredHomeAssistantAccountIds(): Promise<string[]> {
  if (!config.nexoLegacyConnectorsEnabled) return [];
  const result = await db.query<{ id: string }>(
    `SELECT sa.id
     FROM source_accounts sa
     JOIN home_assistant_credentials hc ON hc.source_account_id = sa.id
     WHERE sa.provider = 'home_assistant'
     ORDER BY sa.created_at ASC`,
  );
  return result.rows.map((row) => row.id);
}

function entityDomain(entityId: string): string {
  return entityId.includes(".") ? entityId.split(".", 1)[0]! : "unknown";
}

function defaultRecordMode(domain: string): "snapshot" | "changes" {
  return domain === "sensor" ? "snapshot" : "changes";
}

function safeAttributes(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") <= 32_000) return value;
  } catch {
    return {};
  }
  const picked: Record<string, unknown> = {};
  for (const key of ["friendly_name", "device_class", "unit_of_measurement", "temperature", "current_temperature", "hvac_action", "battery_level", "source"]) {
    if (key in value) picked[key] = value[key];
  }
  return picked;
}

async function upsertDiscoveredStates(sourceAccountId: string, states: HomeAssistantState[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const state of states) {
      const domain = entityDomain(state.entity_id);
      const attributes = safeAttributes(state.attributes);
      await client.query(
        `INSERT INTO home_assistant_entities(
           source_account_id, entity_id, domain, friendly_name, device_class,
           unit_of_measurement, record_mode, current_state, current_attributes,
           last_changed, last_updated, discovered_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now(),now())
         ON CONFLICT(source_account_id, entity_id)
         DO UPDATE SET domain = EXCLUDED.domain,
                       friendly_name = EXCLUDED.friendly_name,
                       device_class = EXCLUDED.device_class,
                       unit_of_measurement = EXCLUDED.unit_of_measurement,
                       current_state = EXCLUDED.current_state,
                       current_attributes = EXCLUDED.current_attributes,
                       last_changed = EXCLUDED.last_changed,
                       last_updated = EXCLUDED.last_updated,
                       discovered_at = now(), updated_at = now()`,
        [
          sourceAccountId,
          state.entity_id,
          domain,
          typeof attributes.friendly_name === "string" ? attributes.friendly_name.slice(0, 240) : null,
          typeof attributes.device_class === "string" ? attributes.device_class.slice(0, 120) : null,
          typeof attributes.unit_of_measurement === "string" ? attributes.unit_of_measurement.slice(0, 80) : null,
          defaultRecordMode(domain),
          state.state.slice(0, 1000),
          JSON.stringify(attributes),
          state.last_changed || null,
          state.last_updated || null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function discoverHomeAssistantEntities(sourceAccountId: string): Promise<number> {
  const credential = await loadHomeAssistantCredential(sourceAccountId);
  if (!credential) throw new Error("home_assistant_credentials_missing");
  const states = await fetchHomeAssistantStates(credential.baseUrl, credential.token);
  await upsertDiscoveredStates(sourceAccountId, states);
  await markHomeAssistantConnected(sourceAccountId);
  return states.length;
}

interface EntityRow {
  source_account_id: string;
  entity_id: string;
  domain: string;
  friendly_name: string | null;
  device_class: string | null;
  unit_of_measurement: string | null;
  selected_for_sync: boolean;
  selected_for_control: boolean;
  record_mode: HomeAssistantEntity["recordMode"];
  current_state: string | null;
  current_attributes: Record<string, unknown>;
  last_changed: Date | null;
  last_updated: Date | null;
}

function mapEntity(row: EntityRow): HomeAssistantEntity {
  return {
    sourceAccountId: row.source_account_id,
    entityId: row.entity_id,
    domain: row.domain,
    friendlyName: row.friendly_name ?? undefined,
    deviceClass: row.device_class ?? undefined,
    unitOfMeasurement: row.unit_of_measurement ?? undefined,
    selectedForSync: row.selected_for_sync,
    selectedForControl: row.selected_for_control,
    recordMode: row.record_mode,
    currentState: row.current_state ?? undefined,
    currentAttributes: row.current_attributes,
    lastChanged: row.last_changed?.toISOString(),
    lastUpdated: row.last_updated?.toISOString(),
  };
}

export async function listHomeAssistantEntities(sourceAccountId: string): Promise<HomeAssistantEntity[]> {
  const result = await db.query<EntityRow>(
    `SELECT source_account_id, entity_id, domain, friendly_name, device_class,
            unit_of_measurement, selected_for_sync, selected_for_control,
            record_mode, current_state, current_attributes, last_changed, last_updated
     FROM home_assistant_entities
     WHERE source_account_id = $1
     ORDER BY selected_for_sync DESC, domain ASC, COALESCE(friendly_name, entity_id) ASC`,
    [sourceAccountId],
  );
  return result.rows.map(mapEntity);
}

export async function listSelectedHomeAssistantEntities(sourceAccountId: string): Promise<HomeAssistantEntity[]> {
  const result = await db.query<EntityRow>(
    `SELECT source_account_id, entity_id, domain, friendly_name, device_class,
            unit_of_measurement, selected_for_sync, selected_for_control,
            record_mode, current_state, current_attributes, last_changed, last_updated
     FROM home_assistant_entities
     WHERE source_account_id = $1 AND selected_for_sync = true
     ORDER BY entity_id ASC`,
    [sourceAccountId],
  );
  return result.rows.map(mapEntity);
}

export async function updateHomeAssistantEntitySelection(input: {
  sourceAccountId: string;
  entityId: string;
  selectedForSync: boolean;
  recordMode?: "snapshot" | "changes";
}): Promise<void> {
  const result = await db.query(
    `UPDATE home_assistant_entities
     SET selected_for_sync = $3,
         record_mode = COALESCE($4::text, record_mode),
         updated_at = now()
     WHERE source_account_id = $1 AND entity_id = $2`,
    [input.sourceAccountId, input.entityId, input.selectedForSync, input.recordMode ?? null],
  );
  if (!result.rowCount) throw new Error("home_assistant_entity_not_found");
}

export async function markHomeAssistantConnected(sourceAccountId: string, haVersion?: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE home_assistant_credentials
       SET ha_version = COALESCE($2, ha_version), last_connected_at = now(),
           last_error = NULL, updated_at = now()
       WHERE source_account_id = $1`,
      [sourceAccountId, haVersion ?? null],
    );
    await client.query(
      `UPDATE source_accounts SET status = 'connected', updated_at = now() WHERE id = $1`,
      [sourceAccountId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markHomeAssistantError(sourceAccountId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await Promise.all([
    db.query(
      `UPDATE home_assistant_credentials SET last_error = $2, updated_at = now() WHERE source_account_id = $1`,
      [sourceAccountId, message.slice(0, 2000)],
    ),
    db.query(
      `UPDATE source_accounts SET status = 'error', updated_at = now() WHERE id = $1`,
      [sourceAccountId],
    ),
  ]);
}
