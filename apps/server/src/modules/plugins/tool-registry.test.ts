import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginToolInput, validatePluginToolRegistration } from "./tool-registry.js";

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

test("rejects plugin names that collide with SOL core tools", () => {
  assert.throws(() => validatePluginToolRegistration({
    transport: "http",
    baseUrl: "http://127.0.0.1:3333",
    tools: [{ name: "memory_search", description: "Collision", input: [] }],
  }), /reserved core tool name: memory_search/);
});

test("validates registered tool input before plugin execution", () => {
  const registration = validatePluginToolRegistration({
    transport: "http",
    baseUrl: "http://127.0.0.1:3333",
    tools: [{
      name: "send_whatsapp",
      description: "Send one message",
      requiresSubmit: true,
      input: [
        { name: "confirmedByUser", type: "boolean", required: true, literalTrue: true },
        { name: "to", type: "string", required: true, min: 3, max: 20 },
        { name: "mode", type: "string", required: false, enum: ["safe", "normal"] },
      ],
    }],
  });
  const tool = registration.tools[0]!;
  assert.deepEqual(validatePluginToolInput(tool, { confirmedByUser: true, to: "12345", mode: "safe" }), {
    confirmedByUser: true,
    to: "12345",
    mode: "safe",
  });
  assert.throws(() => validatePluginToolInput(tool, { to: "12345" }), /plugin_tool_input_required:confirmedByUser/);
  assert.throws(() => validatePluginToolInput(tool, { confirmedByUser: false, to: "12345" }), /plugin_tool_input_literal_true:confirmedByUser/);
  assert.throws(() => validatePluginToolInput(tool, { confirmedByUser: true, to: "12" }), /plugin_tool_input_min:to/);
  assert.throws(() => validatePluginToolInput(tool, { confirmedByUser: true, to: "12345", mode: "unsafe" }), /plugin_tool_input_enum:mode/);
  assert.throws(() => validatePluginToolInput(tool, { confirmedByUser: true, to: "12345", extra: true }), /plugin_tool_input_unknown:extra/);
});
