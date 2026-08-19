export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context?: Record<string, unknown>;
}

export function normalizeHomeAssistantBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Home Assistant URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Home Assistant URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the Home Assistant URL");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestJson<T>(
  baseUrl: string,
  token: string,
  path: string,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(baseUrl, path), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Home Assistant API ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function testHomeAssistantConnection(
  baseUrl: string,
  token: string,
): Promise<void> {
  await requestJson<Record<string, unknown>>(baseUrl, token, "/api/");
}

export async function fetchHomeAssistantStates(
  baseUrl: string,
  token: string,
): Promise<HomeAssistantState[]> {
  const states = await requestJson<unknown>(baseUrl, token, "/api/states", 30_000);
  if (!Array.isArray(states)) throw new Error("Home Assistant /api/states returned an invalid response");
  return states.filter((item): item is HomeAssistantState => {
    if (!item || typeof item !== "object") return false;
    const state = item as Partial<HomeAssistantState>;
    return typeof state.entity_id === "string" && typeof state.state === "string";
  });
}

export function homeAssistantWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
