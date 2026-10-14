import assert from "node:assert/strict";
import { test } from "node:test";
import { neuralSourceKey, projectNeuralNetwork } from "./network.js";
import type { TimelineItem } from "../life/timeline.js";

test("Panorama neural source mapping is stable", () => {
  assert.equal(neuralSourceKey("nexo-whatsapp"), "whatsapp");
  assert.equal(neuralSourceKey("BWA-3D"), "bwa");
  assert.equal(neuralSourceKey("google_calendar"), "calendar");
  assert.equal(neuralSourceKey(undefined, "task"), "calendar");
  assert.equal(neuralSourceKey(undefined, "source"), "life");
});

test("neural snapshot is scoped to the supplied Life items and never includes private text", () => {
  const now = new Date("2026-10-14T18:00:00.000Z");
  const item: TimelineItem = {
    id: "opaque1", type: "source", occurredAt: "2026-10-14T17:54:00.000Z",
    title: "PRIVATE TITLE MUST NOT LEAK", summary: "PRIVATE SUMMARY MUST NOT LEAK",
    visibility: "private", provider: "whatsapp",
    metadata: { intelligencePriority: "high", confidential: "DO NOT LEAK" },
  };
  const old: TimelineItem = {
    ...item, id: "old", occurredAt: "2026-10-10T00:00:00.000Z", provider: "gmail",
  };
  const edition = { id: "daily", asOf: "2026-10-14T16:00:00.000Z", newCount: 1 };
  const snapshot = projectNeuralNetwork([item, old], edition, now);
  assert.equal(snapshot.nodes.find(x => x.id === "whatsapp")?.count, 1);
  assert.equal(snapshot.nodes.find(x => x.id === "gmail")?.count, 0);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.id, "source:opaque1");
  assert.equal(snapshot.events[0]?.intensity, 1.7);
  assert.ok(snapshot.edges.some(x => x.source === "whatsapp" && x.target === "panorama"));
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("PRIVATE"));
  assert.ok(!serialized.includes("DO NOT LEAK"));
  assert.equal(snapshot.edition?.id, "daily");
});

test("neural snapshot stays quiet without actual events", () => {
  const snapshot = projectNeuralNetwork([], null, new Date("2026-10-14T18:00:00Z"));
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.nodes.find(x => x.id === "whatsapp")?.activity, 0);
  assert.equal(snapshot.nodes.find(x => x.id === "panorama")?.center, true);
});
