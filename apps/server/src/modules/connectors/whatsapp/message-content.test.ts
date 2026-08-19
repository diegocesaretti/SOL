import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWhatsappText,
  scoreWhatsappCandidate,
  whatsappTimestamp,
} from "./message-content.js";

test("detects a dated commitment as an AI candidate", () => {
  const signal = scoreWhatsappCandidate(
    "El viernes a las 15 paso a buscar la sembradora",
  );
  assert.equal(signal.candidate, true);
  assert.ok(signal.score >= 0.8);
  assert.ok(signal.reasons.includes("date"));
  assert.ok(signal.reasons.includes("time"));
  assert.ok(signal.reasons.includes("commitment"));
});

test("detects a deadline", () => {
  const signal = scoreWhatsappCandidate("El 28 vence la cuota del terreno");
  assert.equal(signal.candidate, true);
  assert.ok(signal.reasons.includes("deadline"));
});

test("does not spend AI quota on trivial chat", () => {
  assert.deepEqual(scoreWhatsappCandidate("dale 👍"), {
    candidate: false,
    score: 0,
    reasons: [],
  });
});

test("a weak temporal hint alone is not enough", () => {
  const signal = scoreWhatsappCandidate("mañana?");
  assert.equal(signal.candidate, false);
  assert.ok(signal.score < 0.5);
});

test("extracts captions and extended text", () => {
  assert.equal(
    extractWhatsappText({ extendedTextMessage: { text: "Nos vemos mañana" } }),
    "Nos vemos mañana",
  );
  assert.equal(
    extractWhatsappText({ imageMessage: { caption: "Factura vence viernes" } }),
    "Factura vence viernes",
  );
});

test("converts WhatsApp seconds to Date", () => {
  assert.equal(
    whatsappTimestamp(1_700_000_000).toISOString(),
    "2023-11-14T22:13:20.000Z",
  );
});
