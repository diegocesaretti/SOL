import { randomUUID } from "node:crypto";
import { db } from "../database/client.js";
import type { EventBus } from "./event-bus.js";
import { installOutboxWake } from "./outbox-wakeup.js";

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
 *
 * Normal delivery is event-driven: PostgreSQL NOTIFY wakes this dispatcher when
 * an outbox row is inserted. The timer is only a slow recovery sweep for missed
 * notifications, crashes or a sleeping cloud database.
 */
export class OutboxDispatcher {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = true;
  private rerunRequested = false;
  private unregisterWake?: () => void;
  private readonly workerId = randomUUID();

  constructor(
    private readonly eventBus: EventBus,
    private readonly recoveryIntervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unregisterWake = installOutboxWake(() => this.kick());
    this.kick();
    this.timer = setInterval(() => this.kick(), this.recoveryIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unregisterWake?.();
    this.unregisterWake = undefined;
  }

  kick(): void {
    if (this.stopped) return;
    this.rerunRequested = true;
    queueMicrotask(() => void this.tick());
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      do {
        this.rerunRequested = false;
        const processed = await this.dispatchBatch();
        // Drain immediately while work exists so event chains do not wait for
        // another database notification or recovery sweep.
        if (processed > 0) this.rerunRequested = true;
      } while (!this.stopped && this.rerunRequested);
    } catch (error) {
      console.error(`[outbox:${this.workerId}] dispatch failed`, error);
    } finally {
      this.busy = false;
    }
  }

  private async dispatchBatch(): Promise<number> {
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

    return result.rowCount ?? result.rows.length;
  }
}
