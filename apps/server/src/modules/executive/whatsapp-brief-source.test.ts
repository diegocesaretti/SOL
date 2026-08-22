import assert from "node:assert/strict";
import test from "node:test";
import { validateMorningWhatsappSummary } from "./whatsapp-brief-source.js";

test("accepts only external INPUT summaries with every Codex control class excluded", () => {
  const result = validateMorningWhatsappSummary({
    summary: "Juan confirmó la entrega para hoy.",
    sourceClass: "WHATSAPP_INPUT_EXTERNAL",
    controlChannelExcluded: true,
    excludedSourceClasses: ["CODEX_CONTROL_HUMAN", "CODEX_CONTROL_ASSISTANT", "CODEX_CONTROL_MIRROR"],
    selectedMessages: 12,
    effectiveAfter: "2026-08-21T11:00:00.000Z",
  });
  assert.equal(result.sourceClass, "WHATSAPP_INPUT_EXTERNAL");
  assert.equal(result.controlChannelExcluded, true);
  assert.equal(result.selectedMessages, 12);
});

test("rejects a summary when the Codex control mirror was not explicitly excluded", () => {
  assert.throws(() => validateMorningWhatsappSummary({
    summary: "contenido",
    sourceClass: "WHATSAPP_INPUT_EXTERNAL",
    controlChannelExcluded: true,
    excludedSourceClasses: ["CODEX_CONTROL_HUMAN", "CODEX_CONTROL_ASSISTANT"],
    selectedMessages: 1,
  }), /CODEX_CONTROL_MIRROR/);
});

test("rejects control-channel content presented as normal WhatsApp evidence", () => {
  assert.throws(() => validateMorningWhatsappSummary({
    summary: "contenido",
    sourceClass: "CODEX_CONTROL_HUMAN",
    controlChannelExcluded: false,
    excludedSourceClasses: [],
  }), /control_channel_not_excluded/);
});
