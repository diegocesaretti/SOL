import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

function textOf(node) {
  if (!node || typeof node !== "object") return "";
  return String(node.text || node.description || node.view_id || node.class || "").trim();
}

function collectStableLabels(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8 || out.length >= 80) return;
  const label = textOf(node);
  if (label) out.push(label.slice(0, 120));
  if (Array.isArray(node.children)) for (const child of node.children) collectStableLabels(child, out, depth + 1);
}

function focusKey(observation) {
  const focus = observation?.focus_hint || observation?.focused;
  if (!focus) return null;
  const label = textOf(focus) || "focus";
  const bounds = Array.isArray(focus.bounds_normalized) ? focus.bounds_normalized : Array.isArray(focus.bounds) ? focus.bounds : [];
  return `${label}|${bounds.map((v) => Number(v).toFixed(3)).join(",")}`;
}

function focusSummary(observation) {
  const focus = observation?.focus_hint || observation?.focused;
  if (!focus) return null;
  return {
    key: focusKey(observation),
    text: focus.text || null,
    description: focus.description || null,
    class: focus.class || null,
    bounds: focus.bounds_normalized || focus.bounds || null
  };
}

function screenKey(observation) {
  const labels = [];
  collectStableLabels(observation?.tree, labels);
  const stable = JSON.stringify({ package: observation?.package || "", labels });
  return `${observation?.package || "unknown"}:${createHash("sha1").update(stable).digest("hex").slice(0, 16)}`;
}

function normalizeDirection(direction) {
  const d = String(direction || "").trim().toLowerCase();
  return ["up", "down", "left", "right", "center", "home", "back"].includes(d) ? d : null;
}

export class TvNavigationMemory {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, screens: {} };
    this.dirty = false;
    this.flushTimer = null;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed?.version === 1 && parsed?.screens) this.data = parsed;
    } catch {}
  }

  current(observation) {
    const key = screenKey(observation);
    const focus = focusSummary(observation);
    const screen = this.data.screens[key];
    const outgoing = focus?.key && screen?.edges?.[focus.key] ? Object.values(screen.edges[focus.key]) : [];
    return {
      screenKey: key,
      focus,
      learnedTransitions: outgoing
        .sort((a, b) => (b.successes || 0) - (a.successes || 0))
        .slice(0, 16)
    };
  }

  record({ before, after, direction }) {
    const d = normalizeDirection(direction);
    if (!d || !before || !after) return;
    const beforeScreenKey = screenKey(before);
    const afterScreenKey = screenKey(after);
    if (beforeScreenKey !== afterScreenKey) return;
    const from = focusSummary(before);
    const to = focusSummary(after);
    if (!from?.key || !to?.key || from.key === to.key) return;

    const screen = this.data.screens[beforeScreenKey] ||= { package: before.package || "", nodes: {}, edges: {}, updatedAt: null };
    screen.nodes[from.key] = from;
    screen.nodes[to.key] = to;
    const bucket = screen.edges[from.key] ||= {};
    const edgeKey = `${d}->${to.key}`;
    const edge = bucket[edgeKey] ||= { direction: d, to: to.key, toFocus: to, successes: 0, lastSeenAt: null };
    edge.successes += 1;
    edge.lastSeenAt = new Date().toISOString();
    screen.updatedAt = edge.lastSeenAt;
    this.scheduleFlush();
  }

  findRoute(observation, targetText, maxDepth = 14) {
    const target = String(targetText || "").trim().toLowerCase();
    const key = screenKey(observation);
    const screen = this.data.screens[key];
    const start = focusSummary(observation)?.key;
    if (!screen || !start || !target) return null;
    const matches = (node) => {
      const hay = `${node?.text || ""} ${node?.description || ""} ${node?.class || ""}`.toLowerCase();
      return hay.includes(target);
    };
    if (matches(screen.nodes[start])) return { screenKey: key, route: [], target: screen.nodes[start] };

    const queue = [{ node: start, path: [] }];
    const seen = new Set([start]);
    while (queue.length) {
      const current = queue.shift();
      if (current.path.length >= maxDepth) continue;
      const edges = Object.values(screen.edges[current.node] || {}).sort((a, b) => (b.successes || 0) - (a.successes || 0));
      for (const edge of edges) {
        if (!edge?.to || seen.has(edge.to)) continue;
        const nextPath = [...current.path, edge.direction];
        if (matches(screen.nodes[edge.to] || edge.toFocus)) {
          return { screenKey: key, route: nextPath, target: screen.nodes[edge.to] || edge.toFocus, confidence: Math.min(0.98, 0.55 + 0.04 * (edge.successes || 1)) };
        }
        seen.add(edge.to);
        queue.push({ node: edge.to, path: nextPath });
      }
    }
    return null;
  }

  scheduleFlush() {
    this.dirty = true;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 500);
    this.flushTimer.unref?.();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async close() {
    clearTimeout(this.flushTimer);
    await this.flush();
  }
}

export { focusKey, focusSummary, screenKey };
