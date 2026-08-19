import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../../../config.js";

const keyPath = resolve(config.repoRoot, ".sol", "secrets", "whatsapp-auth.key");
let keyPromise: Promise<Buffer> | undefined;

async function loadOrCreateKey(): Promise<Buffer> {
  if (keyPromise) return keyPromise;

  keyPromise = (async () => {
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });

    try {
      const existing = await readFile(keyPath);
      if (existing.length !== 32) {
        throw new Error("WhatsApp auth encryption key has an invalid length");
      }
      return existing;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") throw error;
    }

    const candidate = randomBytes(32);
    try {
      await writeFile(keyPath, candidate, { flag: "wx", mode: 0o600 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(keyPath);
      if (existing.length !== 32) {
        throw new Error("WhatsApp auth encryption key has an invalid length");
      }
      return existing;
    }
  })();

  return keyPromise;
}

export async function sealWhatsappAuth(
  plaintext: string,
  associatedData: string,
): Promise<string> {
  const key = await loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export async function openWhatsappAuth(
  sealed: string,
  associatedData: string,
): Promise<string> {
  const [version, ivText, tagText, encryptedText] = sealed.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("Unsupported or malformed WhatsApp auth payload");
  }

  const key = await loadOrCreateKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
