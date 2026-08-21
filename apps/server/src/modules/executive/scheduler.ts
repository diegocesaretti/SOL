import { db } from "../../database/client.js";
import { buildExecutiveBrief, readExecutiveBrief } from "./briefs.js";
import {
  briefDeliveryHandled,
  getProactivitySettings,
  requestBriefDelivery,
} from "./proactivity.js";

const STARTUP_GRACE_MS = 45_000;

export function localMinuteOfDay(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((item) => item.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((item) => item.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function clockMinutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error("invalid_time");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function scheduleWindowOpen(
  now: Date,
  timezone: string,
  clock: string,
  windowMinutes = 300,
): boolean {
  const current = localMinuteOfDay(now, timezone);
  const target = clockMinutes(clock);
  return current >= target && current < Math.min(24 * 60, target + windowMinutes);
}

export class ExecutiveScheduler {
  private timer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly intervalMs: number) {}

  start(): void {
    if (this.timer || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.tick();
    }, STARTUP_GRACE_MS);
    this.startupTimer.unref();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async deliverScheduledBrief(
    memberId: string,
    type: "morning" | "tomorrow_preview",
    suppressEmpty: boolean,
  ): Promise<void> {
    const existing = await readExecutiveBrief(memberId, type);
    if (existing && (await briefDeliveryHandled(memberId, existing))) return;

    // Refresh at delivery time so a manually generated earlier brief does not make
    // the proactive message stale.
    const brief = await buildExecutiveBrief(memberId, type);
    const delivery = await requestBriefDelivery(memberId, brief, suppressEmpty);
    if (delivery.requested) {
      console.log(`[executive:${memberId}] proactive ${type} queued for delivery`);
    } else if (delivery.suppressed) {
      console.log(`[executive:${memberId}] proactive ${type} suppressed because it was empty`);
    }
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
        try {
          const settings = await getProactivitySettings(member.id);
          if (!settings.enabled) continue;

          if (
            settings.morningBriefEnabled &&
            scheduleWindowOpen(now, member.timezone, settings.morningTime)
          ) {
            await this.deliverScheduledBrief(member.id, "morning", settings.suppressEmpty);
          }

          if (
            settings.tomorrowPreviewEnabled &&
            scheduleWindowOpen(now, member.timezone, settings.tomorrowTime)
          ) {
            await this.deliverScheduledBrief(member.id, "tomorrow_preview", settings.suppressEmpty);
          }
        } catch (error) {
          console.error(`[executive:${member.id}] proactive scheduler failed`, error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
