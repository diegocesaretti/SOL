import assert from "node:assert/strict";
import test from "node:test";
import { parseCandidateExtraction } from "./candidate-processor.js";

test("parses a valid structured extraction", () => {
  const result = parseCandidateExtraction(JSON.stringify({
    kind: "event",
    confidence: 0.94,
    title: "Juan visita por el tractor",
    summary: "Juan confirma que pasa el viernes a las 15.",
    dateTime: "2026-08-21T15:00:00-03:00",
    dueAt: null,
    participants: ["Juan"],
    needsConfirmation: false,
    notes: null,
  }));

  assert.equal(result.kind, "event");
  assert.equal(result.confidence, 0.94);
  assert.equal(result.needsConfirmation, false);
  assert.deepEqual(result.participants, ["Juan"]);
});

test("accepts fenced JSON but rejects invalid confidence", () => {
  const fenced = `\`\`\`json\n{"kind":"task","confidence":0.8,"title":"Comprar filtro","summary":"Comprar filtro","dateTime":null,"dueAt":null,"participants":[],"needsConfirmation":true,"notes":null}\n\`\`\``;
  assert.equal(parseCandidateExtraction(fenced).kind, "task");

  assert.throws(
    () => parseCandidateExtraction('{"kind":"task","confidence":2}'),
    /confidence/,
  );
});
