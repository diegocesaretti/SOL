import type { AuthPrincipal } from "../auth/session.js";
import { listTimeline, type TimelineItem } from "../life/timeline.js";
import { getEditions, localClock } from "./daily.js";

/**
 * Member-scoped, read-only projection. Event labels are category labels,
 * never message bodies, senders, contact names, order data or untrusted text.
 * Persistent device labels come only from member-visible structured metadata
 * or an explicitly configured local printer roster (owner/adult only).
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 64;
const MAX_DEVICES_PER_SOURCE = 18;

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
  if (type === "task" || type === "event") return "calendar";
  return "life";
}

export interface NeuralNode {
  id: string; label: string; type: string; role: string; center: boolean;
  x: number; y: number; z: number; activity: number; count: number;
  parent?: string; detail?: string; observed?: boolean;
}
export interface NeuralEdge { source: string; target: string; strength: number; kind: string; }
export interface NeuralNetworkSnapshot {
  nodes: NeuralNode[];
  edges: NeuralEdge[];
  events: Array<{ id: string; source: string; target: string; occurredAt: string; intensity: number }>;
  edition: { id: string; asOf: string; newCount: number } | null;
  meta: { window: string; sampled: boolean; computedAt: string; eventRelays: number; deviceNodes: number };
}
const sources = [
  { id: "whatsapp", label: "WhatsApp", x: .22, y: .28, z: -.9 },
  { id: "gmail", label: "Gmail", x: .40, y: .19, z: .8 },
  { id: "calendar", label: "Calendario", x: .59, y: .19, z: -.75 },
  { id: "educacion", label: "Educación", x: .75, y: .30, z: .55 },
  { id: "bwa", label: "BWA 3D", x: .77, y: .49, z: -.85 },
  { id: "bambuddy", label: "Bambuddy", x: .70, y: .70, z: .7 },
  { id: "home", label: "Home Assistant", x: .51, y: .76, z: -.9 },
  { id: "finanzas", label: "Finanzas", x: .34, y: .70, z: .55 },
  { id: "memoria", label: "Memoria", x: .23, y: .55, z: -.4 },
  { id: "life", label: "Otras fuentes", x: .22, y: .43, z: .8 },
] as const;

const finite = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const activityFor = (count: number) => finite(Math.log1p(count) / Math.log(18));
function hash(value: string): number {
  let h = 2166136261;
  for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}
function positionAround(parent: NeuralNode, seed: string, index: number, radius: number) {
  const a = ((hash(seed) % 10000) / 10000) * Math.PI * 2 + index * 2.399963;
  const r = radius * (.74 + (hash(seed + ":radius") % 23) / 100);
  return {
    x: .5 + (parent.x - .5) * .10 + (parent.x - .5) * .90 + Math.cos(a) * r,
    y: .5 + (parent.y - .5) * .10 + (parent.y - .5) * .90 + Math.sin(a) * r,
    z: parent.z + Math.sin(a * 2) * .50,
  };
}
function safeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const name = value.trim();
  // Device keys/names only; forbid URLs, email addresses, control characters.
  if (!name || name.length > 44 || /[\u0000-\u001f<>@/\\]/.test(name)) return;
  return name;
}
function metadataValue(metadata: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!metadata) return;
  for (const key of keys) {
    const value = safeDeviceName(metadata[key]);
    if (value) return value;
  }
}
export function neuralDeviceFromMetadata(item: TimelineItem, source: string): string | undefined {
  if (source === "bambuddy") return metadataValue(item.metadata, ["printerName", "printer_name", "printer", "deviceName", "device_name", "printerId"]);
  if (source === "home") return metadataValue(item.metadata, ["entityId", "entity_id", "deviceName", "device_name", "deviceId"]);
}
function eventCategory(item: TimelineItem, source: string): { group: string; groupName: string; label: string } {
  if (source === "whatsapp") return { group: "messages", groupName: "Mensajes", label: "Mensaje" };
  if (source === "gmail") return { group: "inbox", groupName: "Correo recibido", label: "Correo" };
  if (source === "bwa") {
    const raw = String(item.metadata?.recordType ?? item.metadata?.eventType ?? item.metadata?.type ?? "").toLowerCase();
    const sale = /sale|venta|order|pedido|payment|pago/.test(raw) || item.metadata?.orderId !== undefined;
    return sale
      ? { group: "sales", groupName: "Ventas registradas", label: "Venta" }
      : { group: "commerce", groupName: "Actividad comercial", label: "Evento comercial" };
  }
  if (source === "bambuddy") return { group: "prints", groupName: "Actividad de impresión", label: "Evento de impresión" };
  if (source === "home") return { group: "states", groupName: "Cambios del hogar", label: "Cambio de estado" };
  if (source === "educacion") return { group: "school", groupName: "Actividad educativa", label: "Evento educativo" };
  if (source === "calendar") return { group: "schedule", groupName: "Agenda", label: item.type === "task" ? "Tarea" : "Evento" };
  return { group: "activity", groupName: "Actividad reciente", label: "Observación" };
}

/** Optional explicit printer roster; names only, never inferred statuses. */
export function configuredNeuralPrinters(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map(safeDeviceName).filter((name): name is string => !!name))].slice(0, MAX_DEVICES_PER_SOURCE);
}

/** This projection receives only the principal's already authorized Life records. */
export function projectNeuralNetwork(
  items: TimelineItem[],
  edition: { id: string; asOf: string; newCount: number } | null,
  now = new Date(),
  printerRoster: string[] = [],
): NeuralNetworkSnapshot {
  const start = now.getTime() - WINDOW_MS;
  const visible = items.filter(item => {
    const t = Date.parse(item.occurredAt);
    return Number.isFinite(t) && t >= start && t <= now.getTime();
  });
  const counts = new Map<string, number>();
  for (const item of visible) {
    const src = neuralSourceKey(item.provider, item.type);
    counts.set(src, (counts.get(src) || 0) + 1);
  }
  const nodes: NeuralNode[] = [
    { id: "panorama", label: "Panorama", type: "core", role: "center", center: true, x: .50, y: .47, z: 1, activity: .16, count: visible.length },
    { id: "sol", label: "SOL · Life", type: "core", role: "center", center: true, x: .43, y: .43, z: .1, activity: .20, count: visible.length },
    { id: "pulse", label: "Pulse · Atención", type: "core", role: "center", center: true, x: .57, y: .48, z: 1.25, activity: .12, count: 0 },
    ...sources.map(s => ({ ...s, type: "hub", role: "center", center: true, activity: activityFor(counts.get(s.id) || 0), count: counts.get(s.id) || 0, detail: "Observaciones visibles en las últimas 24 h" })),
  ];
  const edges: NeuralEdge[] = sources.map(s => ({ source: s.id, target: "panorama", strength: .28 + activityFor(counts.get(s.id) || 0) * .65, kind: "observation" }));
  edges.push({ source: "sol", target: "panorama", strength: .80, kind: "projection" });
  edges.push({ source: "panorama", target: "pulse", strength: .67, kind: "review" });
  edges.push({ source: "sol", target: "pulse", strength: .32, kind: "context" });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const groupCounts = new Map<string, number>();
  const ensureChild = (id: string, label: string, parentId: string, type: string, count = 0) => {
    const old = byId.get(id);
    if (old) return old;
    const parent = byId.get(parentId);
    if (!parent) throw new Error("neural_parent_missing");
    const pos = positionAround(parent, id, byId.size % 12, type === "printer" || type === "device" ? .040 : .052);
    const node: NeuralNode = { id, label, parent: parentId, type, role: "node", center: false, ...pos, activity: activityFor(count), count, observed: type === "printer" || type === "device" };
    nodes.push(node); byId.set(id, node);
    edges.push({ source: id, target: parentId, strength: type === "group" ? .52 : .62, kind: "membership" });
    return node;
  };
  // Only configured names appear without a recent event. Do not suggest their
  // machine state/activity is known until member-visible evidence arrives.
  for (const name of printerRoster.slice(0, MAX_DEVICES_PER_SOURCE)) {
    ensureChild("printer:" + name.toLowerCase(), name, "bambuddy", "printer");
  }
  const events: NeuralNetworkSnapshot["events"] = [];
  const perSource = new Map<string, Set<string>>();
  for (const item of visible.slice(0, MAX_EVENTS)) {
    const source = neuralSourceKey(item.provider, item.type);
    const category = eventCategory(item, source);
    const groupId = "group:" + source + ":" + category.group;
    const group = ensureChild(groupId, category.groupName, source, "group");
    groupCounts.set(groupId, (groupCounts.get(groupId) || 0) + 1);
    let target = group.id;
    const device = neuralDeviceFromMetadata(item, source);
    if (device) {
      const deviceId = (source === "bambuddy" ? "printer:" : "device:") + device.toLowerCase();
      const known = perSource.get(source) || new Set<string>();
      if (byId.has(deviceId) || known.size < MAX_DEVICES_PER_SOURCE) {
        known.add(deviceId); perSource.set(source, known);
        ensureChild(deviceId, device, source, source === "bambuddy" ? "printer" : "device");
        target = deviceId;
      }
    }
    const eventId = "event:" + item.type + ":" + item.id;
    const activity = item.metadata?.intelligencePriority === "high" ? .95 : .48;
    const eventNode = ensureChild(eventId, category.label, target, "event");
    eventNode.activity = activity;
    eventNode.count = 1;
    eventNode.detail = "Observación reciente · " + new Date(item.occurredAt).toISOString().slice(11, 16) + " UTC";
    events.push({ id: item.type + ":" + item.id, source: eventId, target, occurredAt: item.occurredAt, intensity: activity > .9 ? 1.7 : 1 });
  }
  for (const [id, count] of groupCounts) {
    const node = byId.get(id);
    if (node) { node.count = count; node.activity = activityFor(count); node.detail = count + " eventos de la muestra"; }
  }
  const hot = events.filter(e => e.intensity > 1).length;
  nodes[0]!.activity = finite(.2 + activityFor(visible.length) * .65);
  nodes[2]!.activity = finite(.12 + activityFor(hot) * .7);
  nodes[2]!.count = hot;
  // Extra small local links enrich the connectome without fabricating traffic.
  for (const hub of sources) {
    const children = nodes.filter(n => n.parent === hub.id && n.type !== "event");
    for (let i = 1; i < children.length; i++) {
      edges.push({ source: children[i - 1]!.id, target: children[i]!.id, strength: .23, kind: "decorative" });
    }
  }
  return {
    nodes, edges, events, edition,
    meta: {
      window: "Últimas 24 h · hasta 240 observaciones accesibles · refresco 30 s",
      sampled: items.length >= 240,
      computedAt: now.toISOString(),
      eventRelays: events.length,
      deviceNodes: nodes.filter(n => n.type === "printer" || n.type === "device").length,
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
  const allowedRoster = principal.role === "owner" || principal.role === "adult"
    ? configuredNeuralPrinters(process.env.SOL_NEURAL_PRINTERS)
    : [];
  return projectNeuralNetwork(
    timeline.items,
    latest ? { id: latest.id, asOf: latest.asOf, newCount: latest.newCount } : null,
    now,
    allowedRoster,
  );
}
