import { randomUUID } from "node:crypto";
import { db } from "../database/client.js";
import type { EventBus } from "./event-bus.js";

interface OutboxRow {
  id: string;
  household_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

/**
 * Publishes persisted domain events into SOL's runtime event bus.
 * Delivery is intentionally at-least-once: handlers must be idempotent.
 */
export class OutboxDispatcher {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = true;
  private readonly workerId = randomUUID();

  constructor(
    private readonly eventBus: EventBus,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const result = await db.query<OutboxRow>(`
        SELECT id, household_id, event_type, payload, occurred_at, attempts
        FROM event_outbox
        WHERE published_at IS NULL
          AND available_at <= now()
        ORDER BY occurred_at ASC
        LIMIT 25
      `);

      for (const row of result.rows) {
        try {
          await this.eventBus.publish({
            id: row.id,
            type: row.event_type,
            occurredAt: row.occurred_at.toISOString(),
            householdId: row.household_id,
            payload: row.payload,
          });
          await db.query(
            `UPDATE event_outbox
             SET published_at = now(), attempts = attempts + 1, last_error = NULL
             WHERE id = $1 AND published_at IS NULL`,
            [row.id],
          );
        } catch (error) {
          const attempts = row.attempts + 1;
          const backoffSeconds = Math.min(300, Math.max(2, 2 ** Math.min(attempts, 8)));
          await db.query(
            `UPDATE event_outbox
             SET attempts = attempts + 1,
                 last_error = $2,
                 available_at = now() + ($3 * interval '1 second')
             WHERE id = $1 AND published_at IS NULL`,
            [
              row.id,
              error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
              backoffSeconds,
            ],
          );
        }
      }
    } catch (error) {
      console.error(`[outbox:${this.workerId}] dispatch failed`, error);
    } finally {
      this.busy = false;
    }
  }
}
