import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { gatewayConfig } from "./config.js";

export interface SignedPayload {
  typ: string;
  iat: number;
  exp?: number;
  [key: string]: unknown;
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function signature(payload: string): string {
  return createHmac("sha256", gatewayConfig.signingSecret).update(payload).digest("base64url");
}

export function signOpaqueToken(payload: SignedPayload): string {
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

export function verifyOpaqueToken<T extends SignedPayload>(token: string, expectedType?: string): T | null {
  const [encoded, supplied] = token.split(".");
  if (!encoded || !supplied) return null;
  const expected = signature(encoded);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: T;
  try {
    payload = JSON.parse(decode(encoded).toString("utf8")) as T;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || typeof payload.iat !== "number" || typeof payload.typ !== "string") return null;
  if (expectedType && payload.typ !== expectedType) return null;
  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function randomId(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

export function pairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let value = "";
  for (let index = 0; index < 8; index += 1) value += alphabet[bytes[index]! % alphabet.length];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export function deterministicPairCode(input: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = createHmac("sha256", gatewayConfig.signingSecret)
    .update(`sol-pair-v2:${input}`)
    .digest();
  let value = "";
  for (let index = 0; index < 8; index += 1) value += alphabet[bytes[index]! % alphabet.length];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function secureStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
