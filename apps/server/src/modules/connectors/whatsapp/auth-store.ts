import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";
import { db } from "../../../database/client.js";
import { openWhatsappAuth, sealWhatsappAuth } from "./crypto.js";

function credsAad(sourceAccountId: string): string {
  return `sol:whatsapp:${sourceAccountId}:creds`;
}

function keyAad(sourceAccountId: string, category: string, keyId: string): string {
  return `sol:whatsapp:${sourceAccountId}:key:${category}:${keyId}`;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

async function loadCreds(sourceAccountId: string): Promise<AuthenticationCreds> {
  const result = await db.query<{ encrypted_payload: string }>(
    `SELECT encrypted_payload
     FROM whatsapp_auth_creds
     WHERE source_account_id = $1`,
    [sourceAccountId],
  );

  const row = result.rows[0];
  if (!row) return initAuthCreds();

  const plaintext = await openWhatsappAuth(
    row.encrypted_payload,
    credsAad(sourceAccountId),
  );
  return deserialize<AuthenticationCreds>(plaintext);
}

export async function createWhatsappAuthState(sourceAccountId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const creds = await loadCreds(sourceAccountId);

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        if (ids.length === 0) return {};

        const result = await db.query<{
          key_id: string;
          encrypted_payload: string;
        }>(
          `SELECT key_id, encrypted_payload
           FROM whatsapp_auth_keys
           WHERE source_account_id = $1
             AND category = $2
             AND key_id = ANY($3::text[])`,
          [sourceAccountId, type, ids],
        );

        const rowsById = new Map(
          result.rows.map((row) => [row.key_id, row.encrypted_payload]),
        );
        const data: Partial<Record<string, SignalDataTypeMap[T]>> = {};

        await Promise.all(
          ids.map(async (id) => {
            const encrypted = rowsById.get(id);
            if (!encrypted) return;
            const plaintext = await openWhatsappAuth(
              encrypted,
              keyAad(sourceAccountId, String(type), id),
            );
            let value = deserialize<SignalDataTypeMap[T]>(plaintext);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as proto.Message.IAppStateSyncKeyData,
              ) as SignalDataTypeMap[T];
            }
            data[id] = value;
          }),
        );

        return data as { [id: string]: SignalDataTypeMap[T] };
      },
      set: async (updates) => {
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          for (const [category, entries] of Object.entries(updates)) {
            if (!entries) continue;
            for (const [keyId, value] of Object.entries(entries)) {
              if (value == null) {
                await client.query(
                  `DELETE FROM whatsapp_auth_keys
                   WHERE source_account_id = $1 AND category = $2 AND key_id = $3`,
                  [sourceAccountId, category, keyId],
                );
                continue;
              }

              const encrypted = await sealWhatsappAuth(
                serialize(value),
                keyAad(sourceAccountId, category, keyId),
              );
              await client.query(
                `INSERT INTO whatsapp_auth_keys(
                   source_account_id, category, key_id, encrypted_payload, updated_at
                 ) VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT(source_account_id, category, key_id)
                 DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
                               updated_at = now()`,
                [sourceAccountId, category, keyId, encrypted],
              );
            }
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      const encrypted = await sealWhatsappAuth(
        serialize(creds),
        credsAad(sourceAccountId),
      );
      await db.query(
        `INSERT INTO whatsapp_auth_creds(
           source_account_id, encrypted_payload, updated_at
         ) VALUES ($1, $2, now())
         ON CONFLICT(source_account_id)
         DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
                       updated_at = now()`,
        [sourceAccountId, encrypted],
      );
    },
  };
}

export async function clearWhatsappAuthState(sourceAccountId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM whatsapp_auth_keys WHERE source_account_id = $1",
      [sourceAccountId],
    );
    await client.query(
      "DELETE FROM whatsapp_auth_creds WHERE source_account_id = $1",
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
