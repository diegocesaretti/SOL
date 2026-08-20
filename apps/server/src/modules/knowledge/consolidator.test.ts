import assert from "node:assert/strict";
import test from "node:test";
import { parseConsolidationExtraction } from "./consolidator.js";

const itemA = "11111111-1111-1111-1111-111111111111";
const itemB = "22222222-2222-2222-2222-222222222222";

test("parses supported entities and evidence-backed durable facts", () => {
  const parsed = parseConsolidationExtraction(
    JSON.stringify({
      entities: [
        {
          ref: "luca",
          kind: "person",
          name: "Luca",
          aliases: ["Lu", "Luca"],
          confidence: 0.94,
          evidenceItemIds: [itemA],
        },
      ],
      facts: [
        {
          subjectRef: "luca",
          predicate: "routine.schedule",
          value: { day: "monday", start: "07:30", subject: "Matemática" },
          confidence: 0.91,
          evidenceItemIds: [itemA, itemB],
        },
      ],
    }),
    [itemA, itemB],
  );
  assert.equal(parsed.entities.length, 1);
  assert.deepEqual(parsed.entities[0]?.aliases, ["Lu"]);
  assert.equal(parsed.facts.length, 1);
  assert.deepEqual(parsed.facts[0]?.evidenceItemIds, [itemA, itemB]);
});

test("drops hallucinated evidence and low-confidence facts", () => {
  const parsed = parseConsolidationExtraction(
    JSON.stringify({
      entities: [
        {
          ref: "e1",
          kind: "person",
          name: "Someone",
          aliases: [],
          confidence: 0.9,
          evidenceItemIds: ["not-in-the-batch"],
        },
        {
          ref: "e2",
          kind: "project",
          name: "Project X",
          aliases: [],
          confidence: 0.8,
          evidenceItemIds: [itemA],
        },
      ],
      facts: [
        {
          subjectRef: "e2",
          predicate: "status",
          value: "active",
          confidence: 0.4,
          evidenceItemIds: [itemA],
        },
        {
          subjectRef: "missing-ref",
          predicate: "status",
          value: "active",
          confidence: 0.95,
          evidenceItemIds: [itemA],
        },
      ],
    }),
    [itemA],
  );
  assert.deepEqual(parsed.entities.map((entity) => entity.ref), ["e2"]);
  assert.equal(parsed.facts.length, 0);
});

test("normalizes safe predicates and rejects oversized values", () => {
  const parsed = parseConsolidationExtraction(
    JSON.stringify({
      entities: [
        {
          ref: "e1",
          kind: "topic",
          name: "School",
          confidence: 0.9,
          evidenceItemIds: [itemA],
        },
      ],
      facts: [
        {
          subjectRef: "e1",
          predicate: " School Schedule / Monday ",
          value: "x".repeat(20_000),
          confidence: 0.95,
          evidenceItemIds: [itemA],
        },
        {
          subjectRef: "e1",
          predicate: " School Schedule ",
          value: "07:30",
          confidence: 0.95,
          evidenceItemIds: [itemA],
        },
      ],
    }),
    [itemA],
  );
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0]?.predicate, "school_schedule");
});
