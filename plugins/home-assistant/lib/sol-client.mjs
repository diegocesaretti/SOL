export class SolPluginClient {
  constructor(env = process.env) {
    this.baseUrl = (env.SOL_PLUGIN_API_URL || env.SOL_CORE_URL || "").trim().replace(/\/$/, "");
    this.token = env.SOL_PLUGIN_TOKEN?.trim() || "";
    this.enabled = Boolean(this.baseUrl && this.token);
    this.inputId = null;
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

  async ensureInput(baseUrl) {
    if (this.inputId) return this.inputId;
    const result = await this.request("/v1/plugin-api/inputs/register", {
      body: {
        provider: "home_assistant",
        externalAccountId: baseUrl,
        label: "Home Assistant"
      }
    });
    this.inputId = result.input.id;
    return this.inputId;
  }

  async setInputStatus(baseUrl, status, lastSyncAt) {
    if (!this.enabled) return;
    const inputId = await this.ensureInput(baseUrl);
    await this.request(`/v1/plugin-api/inputs/${inputId}/status`, {
      body: { status, ...(lastSyncAt ? { lastSyncAt } : {}) }
    });
  }

  async ingestPresence(baseUrl, entity) {
    if (!this.enabled) return;
    const inputId = await this.ensureInput(baseUrl);
    await this.request(`/v1/plugin-api/inputs/${inputId}/items`, {
      body: {
        externalId: `${entity.entity_id}:${entity.last_updated || Date.now()}`,
        kind: "sensor_event",
        occurredAt: entity.last_updated || new Date().toISOString(),
        observedAt: new Date().toISOString(),
        title: entity.attributes?.friendly_name || entity.entity_id,
        text: `${entity.attributes?.friendly_name || entity.entity_id} is ${entity.state}`,
        origin: "home_assistant",
        metadata: {
          eventType: "presence",
          entityId: entity.entity_id,
          state: entity.state,
          latitude: entity.attributes?.latitude,
          longitude: entity.attributes?.longitude,
          source: entity.attributes?.source,
          gpsAccuracy: entity.attributes?.gps_accuracy
        }
      }
    });
  }

  async upsertPerson({ entityId, label, metadata, autoLinkMember }) {
    if (!this.enabled) return null;
    const result = await this.request("/v1/plugin-api/identities/person", {
      body: { externalId: entityId, label, metadata, autoLinkMember }
    });
    return result.person || null;
  }

  async registerTools(baseUrl, tools) {
    if (!this.enabled) return [];
    const result = await this.request("/v1/plugin-api/tools/register", {
      body: { transport: "http", baseUrl, tools }
    });
    return result.tools || [];
  }
}
