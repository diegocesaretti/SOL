import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantIntent } from "./service.js";

test("routes simple yes/no approvals deterministically", () => {
  assert.deepEqual(parseAssistantIntent("sí"), { kind: "yes" });
  assert.deepEqual(parseAssistantIntent("No"), { kind: "no" });
});

test("routes explicit proposal references without AI", () => {
  assert.deepEqual(parseAssistantIntent("aprobar a1b2c3d4"), {
    kind: "approve",
    reference: "a1b2c3d4",
  });
  assert.deepEqual(parseAssistantIntent("rechazar ABCD1234"), {
    kind: "reject",
    reference: "abcd1234",
  });
});

test("recognizes agenda and creation intents", () => {
  assert.deepEqual(parseAssistantIntent("¿Qué tengo hoy?"), { kind: "today" });
  assert.deepEqual(parseAssistantIntent("agenda mañana"), { kind: "tomorrow" });
  assert.deepEqual(parseAssistantIntent("Recordame comprar filtros mañana"), { kind: "create" });
});

test("ordinary questions remain read-only conversation requests", () => {
  assert.deepEqual(parseAssistantIntent("¿Cuántos pendientes tengo esta semana?"), { kind: "question" });
});
