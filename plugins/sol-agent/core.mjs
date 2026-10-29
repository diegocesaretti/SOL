import { createHash, randomUUID } from "node:crypto";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function parseSources(raw) {
  let items;
  try { items = JSON.parse(raw || "[]"); } catch { throw new Error("sources_invalid_json"); }
  if (!Array.isArray(items) || items.length > 16) throw new Error("sources_invalid_list");
  const ids = new Set();
  return items.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("source_invalid");
    const { id, name, arguments: args = {} } = item;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{1,39}$/.test(id) || ids.has(id)) throw new Error("source_invalid_id");
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,100}$/.test(name) || name.startsWith("sol_agent_")) throw new Error("source_invalid_name");
    if (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > 2000) throw new Error("source_invalid_arguments");
    ids.add(id);
    return { id, name, arguments: args };
  });
}
export function makeProposal(raw, sourceIds, time) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!["low", "medium", "high"].includes(raw.priority)) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 140) : "";
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim().slice(0, 500) : "";
  const evidence = Array.isArray(raw.evidence) ? [...new Set(raw.evidence.filter(x => sourceIds.includes(x)))].slice(0, 8) : [];
  if (!title || !rationale || !evidence.length) return null;
  const signature = digest({ title: title.toLowerCase(), evidence });
  return { id: randomUUID(), signature, title, rationale, priority: raw.priority,
    evidence, confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
    status: "proposed", createdAt: time };
}
export async function observe({ state, sources, invokeRead, infer, now = new Date() }) {
  const original = state || {};
  const snapshots = { ...(original.snapshots || {}) };
  const existing = Array.isArray(original.proposals) ? original.proposals : [];
  const changes = [];
  const errors = [];
  let baselined = 0;
  for (const source of sources) {
    try {
      // This is the sole tool invocation path. The caller MUST route to SOL invoke-read.
      const value = await invokeRead(source.name, source.arguments);
      const hash = digest(value);
      if (!snapshots[source.id]) {
        snapshots[source.id] = hash; baselined++;
      } else if (snapshots[source.id] !== hash) {
        changes.push({ id: source.id, name: source.name, sample: JSON.stringify(value).slice(0, 3000) });
      }
    } catch (error) { errors.push({ id: source.id, error: String(error?.message || error).slice(0, 100) }); }
  }
  const time = now.toISOString();
  if (changes.length && !infer) return { state: { ...original, snapshots, proposals: existing }, changes: changes.length, baselined, errors, skipped: "model_disabled" };
  let proposals = existing;
  if (changes.length) {
    // If inference fails, snapshots for changed sources are deliberately NOT advanced.
    const result = await infer({ changes, objectives: original.objectives || "", history: existing.slice(-10).map(p => ({ title: p.title, priority: p.priority })) });
    const candidates = Array.isArray(result?.proposals) ? result.proposals.slice(0, 5) : [];
    const signatures = new Set(existing.map(p => p.signature));
    const newItems = [];
    for (const candidate of candidates) {
      const proposal = makeProposal(candidate, changes.map(c => c.id), time);
      if (!proposal || signatures.has(proposal.signature)) continue;
      signatures.add(proposal.signature); newItems.push(proposal);
    }
    proposals = [...existing, ...newItems].slice(-100);
    for (const item of changes) snapshots[item.id] = digest(JSON.parse(item.sample));
    // The complete response is hashed below by the read wrapper; no raw samples are persisted.
  }
  return { state: { ...original, snapshots, proposals, lastCycle: time, lastErrors: errors }, changes: changes.length, baselined, errors, proposalsAdded: proposals.length - existing.length };
}
