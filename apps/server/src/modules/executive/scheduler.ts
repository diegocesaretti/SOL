import { db } from "../../database/client.js";
import { buildExecutiveBrief, readExecutiveBrief } from "./briefs.js";

function localHour(date: Date, timezone: string): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((item) => item.type === "hour");
  return Number(part?.value ?? 0);
}

export class ExecutiveScheduler {
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
      const members = await db.query<{
        id: string;
        timezone: string;
      }>(
        `SELECT m.id, COALESCE(m.timezone, h.timezone) AS timezone
         FROM members m JOIN households h ON h.id = m.household_id
         WHERE m.status = 'active' AND m.role <> 'guest'`,
      );
      const now = new Date();
      for (const member of members.rows) {
        const hour = localHour(now, member.timezone);
        try {
          // Generate once during a broad window so a restart at 08:15 does not miss the day.
          if (hour >= 6 && hour < 12 && !(await readExecutiveBrief(member.id, "morning"))) {
            await buildExecutiveBrief(member.id, "morning");
          }
          if (hour >= 18 && !(await readExecutiveBrief(member.id, "tomorrow_preview"))) {
            await buildExecutiveBrief(member.id, "tomorrow_preview");
          }
        } catch (error) {
          console.error(`[executive:${member.id}] scheduled brief failed`, error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
