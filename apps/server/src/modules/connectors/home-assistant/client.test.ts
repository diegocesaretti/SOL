import assert from "node:assert/strict";
import test from "node:test";
import {
  homeAssistantWebSocketUrl,
  normalizeHomeAssistantBaseUrl,
} from "./client.js";

test("normalizes a local Home Assistant base URL", () => {
  assert.equal(
    normalizeHomeAssistantBaseUrl("http://homeassistant.local:8123/"),
    "http://homeassistant.local:8123",
  );
});

test("preserves a supported reverse-proxy path", () => {
  assert.equal(
    normalizeHomeAssistantBaseUrl("https://example.test/ha/"),
    "https://example.test/ha",
  );
  assert.equal(
    homeAssistantWebSocketUrl("https://example.test/ha"),
    "wss://example.test/ha/api/websocket",
  );
});

test("rejects embedded credentials and unsupported protocols", () => {
  assert.throws(() => normalizeHomeAssistantBaseUrl("ftp://homeassistant.local"));
  assert.throws(() => normalizeHomeAssistantBaseUrl("http://user:secret@homeassistant.local:8123"));
});
