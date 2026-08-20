import { db } from "../../../database/client.js";
import { syncGmailAccount } from "./sync.js";

export class GmailSyncScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly intervalMs: number) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await db.query<{ id: string }>(
        `SELECT sa.id
         FROM source_accounts sa
         JOIN gmail_oauth_credentials gc ON gc.source_account_id = sa.id
         WHERE sa.provider = 'gmail' AND sa.status <> 'disconnected'
         ORDER BY COALESCE(sa.last_sync_at, to_timestamp(0)) ASC`,
      );
      for (const row of result.rows) {
        try { await syncGmailAccount(row.id); }
        catch (error) { console.error(`[gmail:${row.id}] scheduled sync failed`, error); }
      }
    } finally {
      this.running = false;
    }
  }
}
