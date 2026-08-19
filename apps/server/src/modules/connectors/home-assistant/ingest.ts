import { createHash } from "node:crypto";
import { db } from "../../../database/client.js";
import type { HomeAssistantEntity } from "./repository.js";
import type { HomeAssistantState } from "./client.js";

function boundedAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!attributes) return {};
  try {
    const text = JSON.stringify(attributes);
    if (Buffer.byteLength(text, "utf8") <= 32_000) return attributes;
  } catch {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of [
    "friendly_name",
    "device_class",
    "unit_of_measurement",
    "temperature",
    "current_temperature",
    "hvac_action",
    "battery_level",
    "source",
  ]) {
    if (key in attributes) result[key] = attributes[key];
  }
  return result;
}

function stateTime(state: HomeAssistantState | null | undefined, fallback: string): Date {
  const value = state?.last_updated || state?.last_changed || fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function friendlyName(entity: HomeAssistantEntity, state: HomeAssistantState): string {
  const fromState = state.attributes?.friendly_name;
  return typeof fromState === "string" && fromState.trim()
    ? fromState.trim().slice(0, 240)
    : entity.friendlyName ?? entity.entityId;
}

export async function ingestHomeAssistantStateChange(input: {
  householdId: string;
  sourceAccountId: string;
  entity: HomeAssistantEntity;
  oldState?: HomeAssistantState | null;
  newState: HomeAssistantState;
  timeFired: string;
}): Promise<{ recorded: boolean }> {
  const attributes = boundedAttributes(input.newState.attributes);
  const occurredAt = stateTime(input.newState, input.timeFired);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE home_assistant_entities
       SET friendly_name = COALESCE($3, friendly_name),
           device_class = COALESCE($4, device_class),
           unit_of_measurement = COALESCE($5, unit_of_measurement),
           current_state = $6,
           current_attributes = $7::jsonb,
           last_changed = $8,
           last_updated = $9,
           updated_at = now()
       WHERE source_account_id = $1 AND entity_id = $2`,
      [
        input.sourceAccountId,
        input.entity.entityId,
        typeof attributes.friendly_name === "string" ? attributes.friendly_name.slice(0, 240) : null,
        typeof attributes.device_class === "string" ? attributes.device_class.slice(0, 120) : null,
        typeof attributes.unit_of_measurement === "string" ? attributes.unit_of_measurement.slice(0, 80) : null,
        input.newState.state.slice(0, 1000),
        JSON.stringify(attributes),
        input.newState.last_changed || null,
        input.newState.last_updated || null,
      ],
    );

    const stateActuallyChanged = (input.oldState?.state ?? null) !== input.newState.state;
    if (input.entity.recordMode !== "changes" || !stateActuallyChanged) {
      await client.query("COMMIT");
      return { recorded: false };
    }

    const name = friendlyName(input.entity, input.newState);
    const oldText = input.oldState?.state ?? "unknown";
    const newText = input.newState.state;
    const externalId = `${input.entity.entityId}:${input.newState.last_updated || input.timeFired}`;
    const body = `${oldText} → ${newText}`;
    const metadata = {
      provider: "home_assistant",
      entityId: input.entity.entityId,
      domain: input.entity.domain,
      friendlyName: name,
      deviceClass: attributes.device_class ?? input.entity.deviceClass ?? null,
      unitOfMeasurement: attributes.unit_of_measurement ?? input.entity.unitOfMeasurement ?? null,
      oldState: oldText,
      newState: newText,
      timeFired: input.timeFired,
    };
    const source = await client.query<{ id: string }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind,
         owner_member_id, visibility, occurred_at, title, body_text,
         content_hash, raw_metadata
       ) VALUES ($1, $2, $3, 'home_assistant_state', NULL, 'family', $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT(source_account_id, kind, external_id)
       DO UPDATE SET raw_metadata = source_items.raw_metadata || EXCLUDED.raw_metadata
       RETURNING id`,
      [
        input.householdId,
        input.sourceAccountId,
        externalId,
        occurredAt,
        `${name}: ${newText}`,
        body,
        createHash("sha256").update(`${input.entity.entityId}\n${body}`).digest("hex"),
        JSON.stringify(metadata),
      ],
    );
    const sourceItemId = source.rows[0]?.id;
    if (sourceItemId) {
      await client.query(
        `INSERT INTO event_outbox(
           household_id, event_type, aggregate_type, aggregate_id, payload
         ) VALUES ($1, 'home_assistant.state.changed', 'source_item', $2, $3::jsonb)`,
        [
          input.householdId,
          sourceItemId,
          JSON.stringify({
            sourceItemId,
            sourceAccountId: input.sourceAccountId,
            entityId: input.entity.entityId,
            oldState: oldText,
            newState: newText,
          }),
        ],
      );
    }
    await client.query("COMMIT");
    return { recorded: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
