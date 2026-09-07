import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HaStateCache } from "../lib/cache.mjs";

test("state_changed updates cache without a network read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sol-ha-cache-"));
  try {
    const cache = new HaStateCache(dir, 10);
    cache.installSnapshot({
      states: [{
        entity_id: "light.kitchen",
        state: "off",
        attributes: { friendly_name: "Kitchen" },
        last_changed: "2026-01-01T00:00:00Z",
        last_updated: "2026-01-01T00:00:00Z"
      }],
      entities: [{ entity_id: "light.kitchen", device_id: "dev1" }],
      devices: [{ id: "dev1", area_id: "kitchen", name: "Kitchen light" }],
      areas: [{ area_id: "kitchen", name: "Kitchen" }],
      services: {}
    });

    assert.equal(cache.getEntity("light.kitchen").state, "off");
    cache.applyStateChanged({
      time_fired: "2026-01-01T00:00:01Z",
      data: {
        entity_id: "light.kitchen",
        new_state: {
          entity_id: "light.kitchen",
          state: "on",
          attributes: { friendly_name: "Kitchen" },
          last_changed: "2026-01-01T00:00:01Z",
          last_updated: "2026-01-01T00:00:01Z"
        }
      }
    });
    assert.equal(cache.getEntity("light.kitchen").state, "on");
    assert.equal(cache.search("kitchen")[0].entityId, "light.kitchen");
    await cache.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Home Assistant 2026.9 child device inherits parent area", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sol-ha-child-"));
  try {
    const cache = new HaStateCache(dir, 10);
    cache.installSnapshot({
      states: [{ entity_id: "sensor.left_channel", state: "1", attributes: {} }],
      entities: [{ entity_id: "sensor.left_channel", device_id: "child" }],
      devices: [
        { id: "child", parent_device_id: "parent", area_id: null, name: "Left channel" },
        { id: "parent", area_id: "studio", name: "Receiver" }
      ],
      areas: [{ area_id: "studio", name: "Studio" }],
      services: {}
    });
    assert.equal(cache.getEntity("sensor.left_channel").area?.name, "Studio");
    await cache.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
