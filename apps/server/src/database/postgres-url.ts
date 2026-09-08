const CURRENT_SECURE_ALIAS_MODES = new Set(["prefer", "require", "verify-ca"]);

/**
 * pg/pg-connection-string currently treats prefer/require/verify-ca as
 * verify-full. Future major versions will change that behavior. Make SOL's
 * current security expectation explicit now and silence the transition warning.
 */
export function normalizePostgresConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return connectionString;
  }

  const sslMode = url.searchParams.get("sslmode")?.trim().toLowerCase();
  if (!sslMode || !CURRENT_SECURE_ALIAS_MODES.has(sslMode)) {
    return connectionString;
  }

  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}
