export function pluginApiTimeoutMs(path) {
  // Two Codex planning/review passes can outlast the normal plugin API deadline.
  return path === "/v1/plugin-api/panorama/investigate" ? 300000 : 10000;
}

export class SolPluginClientCore {
  constructor(env = process.env) {
    this.baseUrl = (env.SOL_PLUGIN_API_URL || env.SOL_CORE_URL || "").trim().replace(/\/$/, "");
    this.token = env.SOL_PLUGIN_TOKEN?.trim() || "";
    this.enabled = Boolean(this.baseUrl && this.token);
  }

  async request(path, { method = "POST", body } = {}) {
    if (!this.enabled) throw new Error("SOL plugin runtime API is unavailable");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(pluginApiTimeoutMs(path))
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `SOL Plugin API HTTP ${response.status}`);
    return payload;
  }

  // One authenticated, member-scoped stream; the regular request timeouts do
  // not apply to this intentionally long-lived connection.
  async watchPanorama(onEdition, { signal, onConnected } = {}) {
    if (!this.enabled) throw new Error("SOL plugin runtime API is unavailable");
    const response = await fetch(this.baseUrl + "/v1/plugin-api/panorama/stream", {
      method: "GET",
      headers: { authorization: "Bearer " + this.token, accept: "text/event-stream" },
      signal
    });
    if (!response.ok || !response.body) throw new Error("panorama_stream_http_" + response.status);
    onConnected?.();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      if (buffer.length > 65536) throw new Error("panorama_stream_event_too_large");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!frame.includes("event: edition")) continue;
        const data = frame.split("\n").find(x => x.startsWith("data: "));
        if (!data) continue;
        const edition = JSON.parse(data.slice(6));
        if (/^[0-9a-f-]{36}$/i.test(edition?.editionId || "")) onEdition(edition.editionId);
      }
    }
  }

  async registerMcpTools(callbackUrl, tools) {
    if (!this.enabled) return [];
    const result = await this.request("/v1/plugin-api/mcp/tools/register", {
      body: { callbackUrl, tools: Array.isArray(tools) ? tools : [] }
    });
    return result.tools || [];
  }
}
