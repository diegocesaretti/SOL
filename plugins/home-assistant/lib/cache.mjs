import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function objectMap(items, key) {
  return Object.fromEntries((Array.isArray(items) ? items : []).flatMap((item) => {
    const value = item?.[key];
    return typeof value === "string" && value ? [[value, item]] : [];
  }));
}

function nowIso() {
  return new Date().toISOString();
}

export class HaStateCache {
  constructor(dataDir, flushMs = 2000) {
    this.path = join(dataDir, "state-cache.json");
    this.flushMs = flushMs;
    this.states = {};
    this.entities = {};
    this.devices = {};
    this.areas = {};
    this.services = {};
    this.meta = {
      loadedFromDisk: false,
      connected: false,
      lastSnapshotAt: null,
      lastEventAt: null,
      lastPersistedAt: null,
      eventCount: 0,
      version: 1
    };
    this.flushTimer = null;
    this.dirty = false;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      if (!raw || typeof raw !== "object") return;
      this.states = raw.states && typeof raw.states === "object" ? raw.states : {};
      this.entities = raw.entities && typeof raw.entities === "object" ? raw.entities : {};
      this.devices = raw.devices && typeof raw.devices === "object" ? raw.devices : {};
      this.areas = raw.areas && typeof raw.areas === "object" ? raw.areas : {};
      this.services = raw.services && typeof raw.services === "object" ? raw.services : {};
      this.meta = {
        ...this.meta,
        ...(raw.meta && typeof raw.meta === "object" ? raw.meta : {}),
        loadedFromDisk: true,
        connected: false
      };
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`HA cache load failed: ${error?.message || error}`);
    }
  }

  installSnapshot({ states, entities, devices, areas, services }) {
    this.states = objectMap(states, "entity_id");
    this.entities = objectMap(entities, "entity_id");
    this.devices = objectMap(devices, "id");
    this.areas = objectMap(areas, "area_id");
    this.services = services && typeof services === "object" ? services : {};
    this.meta.lastSnapshotAt = nowIso();
    this.markDirty();
  }

  applyStateChanged(event) {
    const entityId = event?.data?.entity_id;
    if (typeof entityId !== "string" || !entityId) return false;
    const next = event?.data?.new_state;
    if (next && typeof next === "object") this.states[entityId] = next;
    else delete this.states[entityId];
    this.meta.eventCount = Number(this.meta.eventCount || 0) + 1;
    this.meta.lastEventAt = event?.time_fired || nowIso();
    this.markDirty();
    return true;
  }

  setConnected(value) {
    this.meta.connected = Boolean(value);
    this.markDirty();
  }

  replaceRegistries({ entities, devices, areas, services }) {
    if (entities) this.entities = objectMap(entities, "entity_id");
    if (devices) this.devices = objectMap(devices, "id");
    if (areas) this.areas = objectMap(areas, "area_id");
    if (services) this.services = services;
    this.meta.lastSnapshotAt = nowIso();
    this.markDirty();
  }

  getEntity(entityId) {
    const state = this.states[entityId];
    if (!state) return null;
    const registry = this.entities[entityId] || null;
    const device = registry?.device_id ? this.devices[registry.device_id] || null : null;
    const parent = device?.parent_device_id ? this.devices[device.parent_device_id] || null : null;
    const areaId = registry?.area_id || device?.area_id || parent?.area_id || null;
    const area = areaId ? this.areas[areaId] || null : null;
    return {
      entityId,
      domain: entityId.split(".", 1)[0],
      state: state.state,
      attributes: state.attributes || {},
      lastChanged: state.last_changed || null,
      lastUpdated: state.last_updated || null,
      registry,
      device,
      parentDevice: parent,
      area,
      areaId
    };
  }

  listPeople() {
    return Object.keys(this.states)
      .filter((id) => id.startsWith("person."))
      .map((id) => this.getEntity(id))
      .filter(Boolean);
  }

  listAreas() {
    const counts = {};
    for (const entityId of Object.keys(this.states)) {
      const entity = this.getEntity(entityId);
      if (!entity?.areaId) continue;
      counts[entity.areaId] = (counts[entity.areaId] || 0) + 1;
    }
    return Object.values(this.areas).map((area) => ({
      ...area,
      entityCount: counts[area.area_id] || 0
    }));
  }

  search(query, limit = 30) {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    for (const entityId of Object.keys(this.states)) {
      const entity = this.getEntity(entityId);
      if (!entity) continue;
      const fields = [
        entity.entityId,
        entity.attributes?.friendly_name,
        entity.registry?.name,
        entity.registry?.original_name,
        entity.device?.name_by_user,
        entity.device?.name,
        entity.parentDevice?.name_by_user,
        entity.parentDevice?.name,
        entity.area?.name
      ].filter((value) => typeof value === "string" && value).map((value) => value.toLowerCase());
      let score = 0;
      for (const term of terms) {
        const best = fields.reduce((value, field) => {
          if (field === term) return Math.max(value, 8);
          if (field.startsWith(term)) return Math.max(value, 5);
          if (field.includes(term)) return Math.max(value, 3);
          return value;
        }, 0);
        if (!best) {
          score = 0;
          break;
        }
        score += best;
      }
      if (score) scored.push({ score, entity });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.entity.entityId.localeCompare(b.entity.entityId))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
      .map(({ entity }) => entity);
  }

  status() {
    return {
      connected: this.meta.connected,
      loadedFromDisk: this.meta.loadedFromDisk,
      stateCount: Object.keys(this.states).length,
      entityRegistryCount: Object.keys(this.entities).length,
      deviceCount: Object.keys(this.devices).length,
      areaCount: Object.keys(this.areas).length,
      serviceDomainCount: Object.keys(this.services).length,
      lastSnapshotAt: this.meta.lastSnapshotAt,
      lastEventAt: this.meta.lastEventAt,
      lastPersistedAt: this.meta.lastPersistedAt,
      eventCount: this.meta.eventCount
    };
  }

  markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) => console.warn(`HA cache persist failed: ${error?.message || error}`));
    }, this.flushMs);
    this.flushTimer.unref?.();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(dirname(this.path), { recursive: true });
    this.meta.lastPersistedAt = nowIso();
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({
      version: 1,
      states: this.states,
      entities: this.entities,
      devices: this.devices,
      areas: this.areas,
      services: this.services,
      meta: this.meta
    }), "utf8");
    await rename(temporary, this.path);
  }

  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
