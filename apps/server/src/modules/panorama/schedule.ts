import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

export const PANORAMA_INTERVALS = [2, 3, 4, 6, 12] as const;
export type PanoramaIntervalHours = typeof PANORAMA_INTERVALS[number] | null;
export function validPanoramaInterval(value: unknown): value is PanoramaIntervalHours {
  return value === null || (typeof value === "number" && PANORAMA_INTERVALS.some(n => n === value));
}
export function scheduledPanoramaHours(interval: PanoramaIntervalHours): number[] {
  if (interval === null) return [8, 12, 18];
  if (!validPanoramaInterval(interval)) throw Error("invalid_panorama_interval");
  const result: number[] = [];
  for (let hour = 8; hour <= 20; hour += interval) result.push(hour);
  return result;
}
export function panoramaSchedulePayload(intervalHours: PanoramaIntervalHours) {
  return { intervalHours, hours: scheduledPanoramaHours(intervalHours), zone: "member_timezone", defaultSchedule: intervalHours === null };
}
export async function getPanoramaSchedule(principal: AuthPrincipal) {
  const r = await db.query<{interval_hours:number|null}>(
    "SELECT interval_hours FROM panorama_schedule_preferences WHERE household_id=$1 AND member_id=$2",
    [principal.householdId, principal.memberId],
  );
  return panoramaSchedulePayload(r.rows[0]?.interval_hours ?? null);
}
export async function updatePanoramaSchedule(principal: AuthPrincipal, intervalHours: unknown) {
  if (principal.role !== "owner" && principal.role !== "adult") throw Error("panorama_schedule_forbidden");
  if (!validPanoramaInterval(intervalHours)) throw Error("invalid_panorama_interval");
  await db.query(
    "INSERT INTO panorama_schedule_preferences(household_id,member_id,interval_hours) VALUES ($1,$2,$3) ON CONFLICT(household_id,member_id) DO UPDATE SET interval_hours=$3,updated_at=NOW()",
    [principal.householdId, principal.memberId, intervalHours],
  );
  return panoramaSchedulePayload(intervalHours);
}
