function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

const port = intEnv("PORT", 8787);
const renderHostname = optional("RENDER_EXTERNAL_HOSTNAME");
const publicOrigin = (
  optional("SOL_GATEWAY_PUBLIC_ORIGIN") ??
  (renderHostname ? `https://${renderHostname}` : `http://127.0.0.1:${port}`)
).replace(/\/$/, "");
const signingSecret = optional("SOL_GATEWAY_SIGNING_SECRET") ?? (process.env.NODE_ENV === "production" ? "" : "sol-dev-signing-secret-change-me-please");
const toolExposure = (optional("SOL_GATEWAY_TOOL_EXPOSURE") ?? "both").toLowerCase();
if (!["raw", "facade", "both"].includes(toolExposure)) {
  throw new Error("SOL_GATEWAY_TOOL_EXPOSURE must be raw, facade or both");
}

if (!signingSecret || Buffer.byteLength(signingSecret, "utf8") < 32) {
  throw new Error("SOL_GATEWAY_SIGNING_SECRET must be at least 32 bytes");
}

export const gatewayConfig = {
  port,
  publicOrigin,
  signingSecret,
  toolExposure: toolExposure as "raw" | "facade" | "both",
  challengeToken: optional("OPENAI_APPS_CHALLENGE"),
  supportEmail: optional("SOL_GATEWAY_SUPPORT_EMAIL"),
  reviewPairCode: optional("SOL_GATEWAY_REVIEW_PAIR_CODE"),
  jobTimeoutMs: intEnv("SOL_GATEWAY_JOB_TIMEOUT_MS", 65_000),
  bridgeLongPollMs: Math.min(30_000, intEnv("SOL_GATEWAY_BRIDGE_LONG_POLL_MS", 25_000)),
  pairCodeTtlMs: Math.min(30 * 60_000, intEnv("SOL_GATEWAY_PAIR_CODE_TTL_MS", 10 * 60_000)),
  accessTokenTtlSeconds: Math.min(24 * 60 * 60, intEnv("SOL_GATEWAY_ACCESS_TOKEN_TTL_SECONDS", 60 * 60)),
  refreshTokenTtlSeconds: Math.min(90 * 24 * 60 * 60, intEnv("SOL_GATEWAY_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60)),
} as const;