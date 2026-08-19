import { CodexAppServerClient } from "./app-server.js";

export interface CodexAccountInfo {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface CodexAccountStatus {
  available: boolean;
  connected: boolean;
  requiresOpenaiAuth?: boolean;
  account?: CodexAccountInfo | null;
  rateLimits?: CodexRateLimits | null;
  error?: string;
}

export interface CodexRateWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimits {
  limitId?: string;
  limitName?: string | null;
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  rateLimitReachedType?: string | null;
}

interface AccountReadResult {
  account: CodexAccountInfo | null;
  requiresOpenaiAuth: boolean;
}

interface RateLimitsReadResult {
  rateLimits?: CodexRateLimits | null;
}

export type CodexLoginResult =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };

export async function readCodexAccount(
  client: CodexAppServerClient,
  refreshToken = false,
): Promise<AccountReadResult> {
  return client.request<AccountReadResult>("account/read", { refreshToken });
}

export async function readCodexRateLimits(
  client: CodexAppServerClient,
): Promise<CodexRateLimits | null> {
  const result = await client.request<RateLimitsReadResult>("account/rateLimits/read");
  return result.rateLimits ?? null;
}

export async function getCodexStatus(
  client: CodexAppServerClient,
): Promise<CodexAccountStatus> {
  try {
    const accountResult = await readCodexAccount(client, false);
    const connected = accountResult.account?.type === "chatgpt";
    let rateLimits: CodexRateLimits | null = null;

    if (connected) {
      try {
        rateLimits = await readCodexRateLimits(client);
      } catch (error) {
        console.warn("Unable to read Codex rate limits", error);
      }
    }

    return {
      available: true,
      connected,
      requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
      account: accountResult.account,
      rateLimits,
    };
  } catch (error) {
    return {
      available: false,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startCodexLogin(
  client: CodexAppServerClient,
  flow: "browser" | "device" = "browser",
): Promise<CodexLoginResult> {
  if (flow === "device") {
    return client.request<CodexLoginResult>("account/login/start", {
      type: "chatgptDeviceCode",
    });
  }

  return client.request<CodexLoginResult>("account/login/start", {
    type: "chatgpt",
    useHostedLoginSuccessPage: true,
    appBrand: "chatgpt",
  });
}

export async function logoutCodex(client: CodexAppServerClient): Promise<void> {
  await client.request("account/logout");
}
