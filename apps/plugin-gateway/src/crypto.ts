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

export interface SelfContainedPairCode {
  code: string;
  expiresAt: number;
}

export interface VerifiedPairCode {
  instanceId: string;
  expiresAt: number;
  scopeBits: number;
  replayKey: string;
}

export function signSelfContainedPairCode(instanceId: string, scopeBits: number, ttlMs: number): SelfContainedPairCode {
  const expiresAt = Math.floor((Date.now() + Math.max(60_000, ttlMs)) / 1000);
  const instanceHex = Buffer.from(instanceId, "utf8").toString("hex").toUpperCase();
  const expHex = expiresAt.toString(16).toUpperCase().padStart(8, "0");
  const scopeHex = scopeBits.toString(16).toUpperCase();
  const nonceHex = randomBytes(4).toString("hex").toUpperCase();
  const body = `${instanceHex}.${expHex}.${scopeHex}.${nonceHex}`;
  const sigHex = createHmac("sha256", gatewayConfig.signingSecret)
    .update(`sol-pair-v3:${body}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  return {
    code: `SOL2-${instanceHex}-${expHex}-${scopeHex}-${nonceHex}-${sigHex}`,
    expiresAt: expiresAt * 1000,
  };
}

export function verifySelfContainedPairCode(code: string): VerifiedPairCode | null {
  const normalized = code.trim().toUpperCase();
  const match = normalized.match(/^SOL2-([0-9A-F]+)-([0-9A-F]{8})-([0-9A-F])-([0-9A-F]{8})-([0-9A-F]{32})$/);
  if (!match) return null;

  const [, instanceHex, expHex, scopeHex, nonceHex, suppliedSig] = match;
  const body = `${instanceHex}.${expHex}.${scopeHex}.${nonceHex}`;
  const expectedSig = createHmac("sha256", gatewayConfig.signingSecret)
    .update(`sol-pair-v3:${body}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  const a = Buffer.from(suppliedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAtSeconds = Number.parseInt(expHex, 16);
  const scopeBits = Number.parseInt(scopeHex, 16);
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1000)) return null;
  if (!Number.isFinite(scopeBits) || (scopeBits & 1) !== 1 || (scopeBits & ~7) !== 0) return null;

  let instanceId: string;
  try {
    instanceId = Buffer.from(instanceHex, "hex").toString("utf8");
  } catch {
    return null;
  }
  if (!/^sol_[A-Za-z0-9_-]{8,80}$/.test(instanceId)) return null;

  return {
    instanceId,
    expiresAt: expiresAtSeconds * 1000,
    scopeBits,
    replayKey: suppliedSig,
  };
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function secureStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
