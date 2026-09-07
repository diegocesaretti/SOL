import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginToolRegistration } from "./tool-registry.js";

test("accepts loopback plugin tool registrations", () => {
  const registration = validatePluginToolRegistration({
    transport: "http",
    baseUrl: "http://127.0.0.1:45678",
    tools: [{
      name: "whatsapp_status",
      description: "Read WhatsApp plugin status",
      requiresSubmit: false,
      input: [],
    }],
  });
  assert.equal(registration.baseUrl, "http://127.0.0.1:45678");
  assert.equal(registration.tools[0]?.name, "whatsapp_status");
});

test("rejects non-loopback plugin tool callbacks", () => {
  assert.throws(() => validatePluginToolRegistration({
    transport: "http",
    baseUrl: "http://192.168.1.20:45678",
    tools: [],
  }), /loopback host/);
});

test("preserves submit requirements and literal human confirmation", () => {
  const registration = validatePluginToolRegistration({
    transport: "http",
    baseUrl: "http://localhost:43210",
    tools: [{
      name: "send_whatsapp",
      description: "Send one message",
      requiresSubmit: true,
      input: [{
        name: "confirmedByUser",
        type: "boolean",
        required: true,
        literalTrue: true,
      }],
    }],
  });
  assert.equal(registration.tools[0]?.requiresSubmit, true);
  assert.equal(registration.tools[0]?.input[0]?.literalTrue, true);
});

test("rejects duplicate tool names", () => {
  assert.throws(() => validatePluginToolRegistration({
    transport: "http",
    baseUrl: "http://127.0.0.1:3333",
    tools: [
      { name: "same_tool", description: "First", input: [] },
      { name: "same_tool", description: "Second", input: [] },
    ],
  }), /duplicate tool name/);
});
