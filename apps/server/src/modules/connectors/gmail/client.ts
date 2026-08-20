import { getGmailAccessToken } from "./oauth.js";

const API_BASE = "https://gmail.googleapis.com/gmail/v1";

export class GmailApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = "GmailApiError";
  }
}

async function request<T>(
  sourceAccountId: string,
  path: string,
  forceRefresh = false,
): Promise<T> {
  if (!path.startsWith("/")) throw new Error("Gmail API path must start with /");
  const token = await getGmailAccessToken(sourceAccountId, forceRefresh);
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (response.status === 401 && !forceRefresh) return request<T>(sourceAccountId, path, true);
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text.slice(0, 4000); }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? JSON.stringify((body as { error?: unknown }).error).slice(0, 1200)
        : `Gmail API error ${response.status}`;
    throw new GmailApiError(response.status, message, body);
  }
  return body as T;
}

export function gmailGet<T>(sourceAccountId: string, path: string): Promise<T> {
  return request<T>(sourceAccountId, path);
}
