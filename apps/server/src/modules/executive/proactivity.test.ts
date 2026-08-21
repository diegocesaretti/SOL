import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutiveBriefContent } from "./briefs.js";
import { briefHasUsefulContent, DEFAULT_PROACTIVITY_SETTINGS } from "./proactivity.js";

function brief(overrides: Partial<ExecutiveBriefContent> = {}): ExecutiveBriefContent {
  return {
    type: "morning",
    periodStart: "2026-08-20T03:00:00.000Z",
    periodEnd: "2026-08-21T03:00:00.000Z",
    member: { id: "member", displayName: "Diego" },
    events: [],
    tasks: [],
    pendingProposals: [],
    conflicts: [],
    summary: "0 evento(s) · 0 tarea(s) pendiente(s) · 0 propuesta(s) por revisar",
    ...overrides,
  };
}

test("uses conservative proactive defaults", () => {
  assert.equal(DEFAULT_PROACTIVITY_SETTINGS.enabled, true);
  assert.equal(DEFAULT_PROACTIVITY_SETTINGS.morningTime, "07:30");
  assert.equal(DEFAULT_PROACTIVITY_SETTINGS.tomorrowTime, "20:30");
  assert.equal(DEFAULT_PROACTIVITY_SETTINGS.suppressEmpty, true);
});

test("suppresses empty briefs but keeps actionable content", () => {
  assert.equal(briefHasUsefulContent(brief()), false);
  assert.equal(
    briefHasUsefulContent(brief({
      pendingProposals: [{ id: "proposal" } as ExecutiveBriefContent["pendingProposals"][number]],
    })),
    true,
  );
  assert.equal(
    briefHasUsefulContent(brief({
      business: {
        accounts: [],
        period: {
          start: "2026-08-20T03:00:00.000Z",
          end: "2026-08-21T03:00:00.000Z",
          orders: 0,
          paidOrders: 0,
          revenueByCurrency: [],
          recentOrders: [],
        },
        activeItems: 0,
        unansweredQuestions: [{ id: "q1", text: "¿Tenés stock?" }],
      },
    })),
    true,
  );
});
