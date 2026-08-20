import { getMercadoLibreAccessToken } from "./oauth.js";
import { parseMercadoLibreJson } from "./json.js";

const API_BASE = "https://api.mercadolibre.com";

export class MercadoLibreApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MercadoLibreApiError";
  }
}

async function request<T>(
  sourceAccountId: string,
  path: string,
  init: RequestInit = {},
  forceRefresh = false,
): Promise<T> {
  if (!path.startsWith("/")) throw new Error("Mercado Libre API path must start with /");
  const token = await getMercadoLibreAccessToken(sourceAccountId, forceRefresh);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (response.status === 401 && !forceRefresh) {
    return request<T>(sourceAccountId, path, init, true);
  }

  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = parseMercadoLibreJson<unknown>(text);
    } catch {
      body = text.slice(0, 4000);
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message ?? `Mercado Libre API error ${response.status}`)
        : `Mercado Libre API error ${response.status}`;
    throw new MercadoLibreApiError(response.status, message, body);
  }
  return body as T;
}

export function mercadoLibreGet<T>(sourceAccountId: string, path: string): Promise<T> {
  return request<T>(sourceAccountId, path, { method: "GET" });
}
