import assert from "node:assert/strict";
import test from "node:test";
import { scoreIntelligenceCandidate } from "./intelligence-gate.js";

test("Intelligence Gate ignores trivial WhatsApp chatter", () => {
  const result = scoreIntelligenceCandidate({ provider: "whatsapp", bodyText: "Dale gracias" });
  assert.equal(result.candidate, false);
  assert.deepEqual(result.routes, []);
});

test("Intelligence Gate routes WhatsApp deadlines to operational processing", () => {
  const result = scoreIntelligenceCandidate({
    provider: "whatsapp",
    bodyText: "La factura vence el viernes y hay que pagarla antes de las 15 hs",
  });
  assert.equal(result.routes.includes("operational"), true);
  assert.equal(result.operationalScore >= 0.5, true);
});

test("Intelligence Gate routes durable preferences to Knowledge", () => {
  const result = scoreIntelligenceCandidate({
    provider: "whatsapp",
    bodyText: "Prefiero recibir los pedidos los viernes porque siempre estoy en el taller.",
  });
  assert.equal(result.routes.includes("knowledge"), true);
});

test("Intelligence Gate suppresses promotional Gmail", () => {
  const result = scoreIntelligenceCandidate({
    provider: "gmail",
    title: "Oferta exclusiva de esta semana",
    bodyText: "Newsletter con promociones y descuentos. Darse de baja.",
    metadata: { labelIds: ["CATEGORY_PROMOTIONS"], listUnsubscribe: "<mailto:unsubscribe@example.com>" },
  });
  assert.equal(result.candidate, false);
});

test("Intelligence Gate keeps human Gmail with durable information", () => {
  const result = scoreIntelligenceCandidate({
    provider: "gmail",
    title: "Re: Proyecto Pluvisensor",
    bodyText: "El proyecto se llama Pluvisensor y el equipo trabaja normalmente los viernes por la tarde.",
    metadata: { from: "Juan <juan@example.com>", labelIds: ["IMPORTANT"] },
  });
  assert.equal(result.routes.includes("knowledge"), true);
  assert.equal(result.priority === "normal" || result.priority === "high", true);
});
