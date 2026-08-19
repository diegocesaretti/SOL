import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  if (password.length > 256) throw new Error("password is too long");

  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [scheme, saltEncoded, keyEncoded] = encoded.split("$");
  if (scheme !== "scrypt" || !saltEncoded || !keyEncoded) return false;

  const salt = Buffer.from(saltEncoded, "base64url");
  const expected = Buffer.from(keyEncoded, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
