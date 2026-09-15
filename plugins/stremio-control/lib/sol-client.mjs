export class SolPluginClient {
  constructor(env = process.env, fetchImpl = fetch) {
    this.baseUrl = (env.SOL_PLUGIN_API_URL || env.SOL_CORE_URL || "").trim().replace(/\/$/, "");
    this.token = env.SOL_PLUGIN_TOKEN?.trim() || "";
    this.enabled = Boolean(this.baseUrl && this.token);
    this.fetchImpl = fetchImpl;
  }

  async request(path, body) {
    if (!this.enabled) throw new Error("SOL plugin runtime API is unavailable");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `SOL Plugin API HTTP ${response.status}`);
    return payload;
  }

  async registerMcpTools(callbackUrl, tools) {
    if (!this.enabled) return [];
    const result = await this.request("/v1/plugin-api/mcp/tools/register", { callbackUrl, tools });
    return result.tools || [];
  }
}
