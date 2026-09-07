import assert from "node:assert/strict";
import test from "node:test";
import { HomeAssistantClient } from "../lib/ha-client.mjs";

function client() {
  return new HomeAssistantClient({
    baseUrl: "http://homeassistant.local:8123",
    token: "test",
    cache: { setConnected() {} }
  });
}

test("call_service omits return_response for ordinary services", async () => {
  const ha = client();
  let sent;
  ha.command = async (type, payload) => {
    sent = { type, payload };
    return { ok: true };
  };
  await ha.callService("light", "turn_on", { brightness: 100 }, { entity_id: "light.kitchen" }, false);
  assert.equal(sent.type, "call_service");
  assert.equal(Object.hasOwn(sent.payload, "return_response"), false);
});

test("call_service requests a response only for response-capable services", async () => {
  const ha = client();
  let sent;
  ha.command = async (type, payload) => {
    sent = { type, payload };
    return { ok: true };
  };
  await ha.callService("weather", "get_forecasts", {}, { entity_id: "weather.home" }, true);
  assert.equal(sent.payload.return_response, true);
});
