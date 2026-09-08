import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../../config.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_SECRET_BYTES = 64 * 1024;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function decodeKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64url");
  if (key.length !== KEY_BYTES) throw new Error("vault_master_key_invalid");
  return key;
}

async function readKey(path: string): Promise<Buffer> {
  return decodeKey(await readFile(path, "utf8"));
}

export async function loadVaultMasterKey(
  path = resolve(config.dataDir, "vault.key"),
): Promise<Buffer> {
  try {
    return await readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const generated = randomBytes(KEY_BYTES);
  try {
    await writeFile(path, `${generated.toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await readKey(path);
  }
}

function requireKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error("vault_master_key_invalid");
}

export function encryptSecretJson(
  key: Buffer,
  payload: unknown,
  aad: string,
): EncryptedSecret {
  requireKey(key);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  if (plaintext.length > MAX_SECRET_BYTES) throw new Error("credential_secret_too_large");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptSecretJson<T = unknown>(
  key: Buffer,
  encrypted: EncryptedSecret,
  aad: string,
): T {
  requireKey(key);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
