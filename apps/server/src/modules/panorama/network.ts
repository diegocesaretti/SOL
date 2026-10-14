import type { AuthPrincipal } from "../auth/session.js";
import { listTimeline, type TimelineItem } from "../life/timeline.js";
import { getEditions, localClock } from "./daily.js";

/**
 * A read-only projection of the requesting member's visible Life records.
 * The viewer receives source names, counts and opaque event IDs only;
 * titles, bodies, participants and memory contents remain server-side.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
export function neuralSourceKey(provider?: string, type?: TimelineItem["type"]): string {
  const p = (provider || "").toLowerCase().replace(/[\s_-]/g, "");
  if (p.includes("whatsapp") || p.includes("nexo")) return "whatsapp";
  if (p.includes("gmail") || p.includes("mail")) return "gmail";
  if (p.includes("homeassistant") || p.includes("hass") || p.includes("smart")) return "home";
  if (p.includes("bambuddy") || p.includes("bambu") || p.includes("printer")) return "bambuddy";
  if (p.includes("mercadolibre") || p.includes("bwa") || p.includes("marketplace")) return "bwa";
  if (p.includes("moodle") || p.includes("educacion") || p.includes("classroom")) return "educacion";
  if (p.includes("calendar") || p.includes("calendario")) return "calendar";
  if (p.includes("finanzas") || p.includes("finance") || p.includes("bank")) return "finanzas";
  if (p.includes("memory") || p.includes("memoria") || p.includes("knowledge")) return "memoria";
  if (type === "task") return "calendar";
  if (type === "event") return "calendar";
  return "life";
}

const sources = [
  { id: "whatsapp", label: "WhatsApp", x: .16, y: .22, z: -1.1 },
  { id: "gmail", label: "Gmail", x: .36, y: .14, z: 1.1 },
  { id: "calendar", label: "Calendario", x: .64, y: .12, z: -.9 },
  { id: "educacion", label: "Educación", x: .82, y: .27, z: .5 },
  { id: "bwa", label: "BWA 3D", x: .88, y: .50, z: -1.0 },
  { id: "bambuddy", label: "Bambuddy", x: .78, y: .75, z: .7 },
  { id: "home", label: "Home Assistant", x: .55, y: .84, z: -1.2 },
  { id: "finanzas", label: "Finanzas", x: .31, y: .79, z: .8 },
  { id: "memoria", label: "Memoria", x: .11, y: .60, z: -.5 },
  { id: "life", label: "Otras fuentes", x: .12, y: .42, z: 1.0 },
] as const;

export interface NeuralNetworkSnapshot {
  nodes: Array<{ id: string; label: string; type: string; role: string; center: boolean; x: number; y: number; z: number; activity: number; count: number }>;
  edges: Array<{ source: string; target: string; strength: number; kind: string }>;
  events: Array<{ id: string; source: string; target: string; occurredAt: string; intensity: number }>;
  edition: { id: string; asOf: string; newCount: number } | null;
  meta: { window: string; sampled: boolean; computedAt: string };
}

/** All activity is measured within the sampled window, never a claim of exhaustive totals. */
export function projectNeuralNetwork(
  items: TimelineItem[],
  edition: { id: string; asOf: string; newCount: number } | null,
  now = new Date(),
): NeuralNetworkSnapshot {
  const since = now.getTime() - WINDOW_MS;
  const visible = items.filter(item => {
    const timestamp = Date.parse(item.occurredAt);
    return Number.isFinite(timestamp) && timestamp >= since && timestamp <= now.getTime();
  });
  const counts = new Map<string, number>();
  for (const item of visible) {
    const source = neuralSourceKey(item.provider, item.type);
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  const nodes = [
    { id: "panorama", label: "Panorama", type: "core", role: "center", center: true, x: .49, y: .47, z: 1.0, activity: .26, count: visible.length },
    { id: "sol", label: "SOL · Life", type: "core", role: "center", center: true, x: .38, y: .39, z: .25, activity: .24, count: visible.length },
    { id: "pulse", label: "Pulse · Atención", type: "core", role: "center", center: true, x: .64, y: .47, z: 1.3, activity: .15, count: 0 },
    ...sources.map(source => ({
      ...source, type: "hub", role: "center", center: true,
      activity: Math.min(1, Math.log1p(counts.get(source.id) || 0) / Math.log(24)),
      count: counts.get(source.id) || 0,
    })),
  ];
  const edges: NeuralNetworkSnapshot["edges"] = sources.map(source => ({
    source: source.id, target: "panorama",
    strength: .24 + Math.min(.70, Math.log1p(counts.get(source.id) || 0) / Math.log(24) * .70),
    kind: "observation",
  }));
  edges.push({ source: "panorama", target: "pulse", strength: .58, kind: "review" });
  edges.push({ source: "sol", target: "panorama", strength: .72, kind: "projection" });
  const events = visible.slice(0, 60).map(item => ({
    id: item.type + ":" + item.id,
    source: neuralSourceKey(item.provider, item.type),
    target: "panorama",
    occurredAt: item.occurredAt,
    intensity: item.metadata?.intelligencePriority === "high" ? 1.7 : 1,
  }));
  const hot = events.filter(item => item.intensity > 1).length;
  nodes[0].activity = Math.min(1, .2 + Math.log1p(visible.length) / Math.log(24) * .65);
  nodes[2].activity = Math.min(1, .14 + Math.log1p(hot) / Math.log(10) * .75);
  nodes[2].count = hot;
  return {
    nodes, edges, events, edition,
    meta: {
      window: "Últimas 24 h · muestra de hasta 240 registros visibles · sincronización cada 30 s",
      sampled: items.length >= 240,
      computedAt: now.toISOString(),
    },
  };
}

export async function getPanoramaNeuralNetwork(principal: AuthPrincipal): Promise<NeuralNetworkSnapshot> {
  const now = new Date();
  const date = localClock(now, "America/Argentina/Buenos_Aires").date;
  const [timeline, editions] = await Promise.all([
    listTimeline(principal, { limit: 240 }),
    getEditions(principal, date),
  ]);
  const latest = editions.at(-1);
  return projectNeuralNetwork(
    timeline.items,
    latest ? { id: latest.id, asOf: latest.asOf, newCount: latest.newCount } : null,
    now,
  );
}
