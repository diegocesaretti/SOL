import { getMercadoLibreAccessToken } from "./oauth.js";

const API_BASE = "https://api.mercadolibre.com";

/**
 * Mercado Libre is migrating identifiers to Int64. JSON.parse would silently round
 * integers above Number.MAX_SAFE_INTEGER, so quote unsafe integer literals before
 * parsing. Ordinary decimals/counts remain numbers.
 */
export function parseMercadoLibreJson<T>(text: string): T {
  let output = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const char = text[i]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      i += 1;
      continue;
    }

    const isNumberStart = /[0-9-]/.test(char) && (char !== "-" || /[0-9]/.test(text[i + 1] ?? ""));
    if (!isNumberStart) {
      output += char;
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < text.length && /[0-9eE+\-.]/.test(text[end]!)) end += 1;
    const token = text.slice(i, end);
    const integer = /^-?\d+$/.test(token);
    const digits = token.replace(/^-/, "");
    if (integer && digits.length >= 16) output += JSON.stringify(token);
    else output += token;
    i = end;
  }

  return JSON.parse(output) as T;
}

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
