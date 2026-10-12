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
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `SOL Plugin API HTTP ${response.status}`);
    return payload;
  }

  async registerMcpTools(callbackUrl, tools) {
    if (!this.enabled) return [];
    const result = await this.request("/v1/plugin-api/mcp/tools/register", {
      body: { callbackUrl, tools: Array.isArray(tools) ? tools : [] }
    });
    return result.tools || [];
  }
}
