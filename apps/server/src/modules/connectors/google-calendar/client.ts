import { getGoogleAccessToken } from "./oauth.js";

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function googleCalendarFetch<T>(
  sourceAccountId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const request = async (forceRefresh: boolean) => {
    const token = await getGoogleAccessToken(sourceAccountId, forceRefresh);
    return fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  };

  let response = await request(false);
  if (response.status === 401) response = await request(true);
  const body = await parseBody(response);
  if (!response.ok) {
    const googleMessage =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: unknown } }).error?.message ?? "")
        : "";
    throw new GoogleApiError(
      googleMessage || `Google Calendar API request failed (${response.status})`,
      response.status,
      body,
    );
  }
  return body as T;
}
