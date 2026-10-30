import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeProfile, guidanceFor, proposalGate } from "./policy.mjs";
import { safeToolName, catalogCoverage } from "./compatibility.mjs";

const idRe = /^[a-z][a-z0-9_-]{2,39}$/;
const iso = value => new Date(value).toISOString();
const sum = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cut = (value, limit) => String(value || "").trim().slice(0, limit);
const nextTime = (date, minutes) => new Date(date.getTime() + minutes * 60000).toISOString();

export function validateCatalog(raw) {
  let list;
  try { list = typeof raw === "string" ? JSON.parse(raw || "[]") : raw; }
  catch { throw new Error("invalid_tools_json"); }
  if (!Array.isArray(list) || list.length > 24) throw new Error("invalid_tool_catalog");
  const ids = new Set();
  return list.map(item => {
    const id = item?.id;
    const name = item?.name;
    if (typeof id !== "string" || !idRe.test(id) || ids.has(id)) throw new Error("invalid_tool_id");
    if (!safeToolName(name)) throw new Error("invalid_tool_name");
    if (!item.arguments || typeof item.arguments !== "object" || Array.isArray(item.arguments) || JSON.stringify(item.arguments).length > 2000) throw new Error("invalid_tool_args");
    ids.add(id);
    // Arguments are fixed by the owner, never generated or modified by a model.
    return { id, name, arguments: item.arguments, description: cut(item.description || name, 120) };
  });
}
export function validateGoal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_goal");
  const objective = cut(value.objective, 800);
  const intervalMinutes = value.intervalMinutes === undefined ? 60 : Number(value.intervalMinutes);
  if (objective.length < 12 || !Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 1440) throw new Error("invalid_goal_fields");
  const id = value.id || "mission-" + randomUUID().slice(0, 12);
  if (typeof id !== "string" || !idRe.test(id)) throw new Error("invalid_goal_id");
  return { id, objective, intervalMinutes, profile: normalizeProfile(value.profile) };
}
export function validateDecision(value, tools) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_decision");
  if (value.action === "read") {
    if (typeof value.toolId !== "string" || !tools.some(t => t.id === value.toolId)) throw new Error("tool_not_allowed");
    return { action: "read", toolId: value.toolId, note: cut(value.note, 320) };
  }
  if (value.action === "finish") {
    const note = cut(value.note, 500);
    if (!note) throw new Error("empty_finish");
    const proposal = value.proposal && typeof value.proposal === "object" && typeof value.proposal.title === "string" && typeof value.proposal.rationale === "string"
      ? { title: cut(value.proposal.title, 140), rationale: cut(value.proposal.rationale, 600),
          priority: ["low","medium","high"].includes(value.proposal.priority) ? value.proposal.priority : "medium",
          confidence: Math.min(1, Math.max(0, Number(value.proposal.confidence) || 0)),
          evidence: Array.isArray(value.proposal.evidence) ? [...new Set(value.proposal.evidence.filter(id => tools.some(t => t.id === id)))].slice(0, 8) : [] } : null;
    return { action: "finish", note, proposal: proposal?.title && proposal?.rationale ? proposal : null };
  }
  if (value.action === "wait") return { action: "wait", note: cut(value.note, 320) || "Sin novedades", waitMinutes: Math.max(10, Math.min(1440, Number(value.waitMinutes) || 60)) };
  throw new Error("invalid_decision_action");
}
function cleanHistory(items) { return (items || []).slice(-12).map(x => ({ at: x.at, type: x.type, note: cut(x.note, 320), toolId: x.toolId || undefined, hash: x.hash || undefined })); }
function initial() { return { version: 2, missions: {}, budget: { day: "", model: 0, reads: 0 }, updatedAt: null }; }
function mission(config, now) {
  return { id: config.id, objective: config.objective, intervalMinutes: config.intervalMinutes, profile: config.profile,
    paused: false, dueAt: now, phase: "ready", steps: 0, cycles: 0, history: [], feedback: [],
    proposals: [], errors: 0, lastError: null, filteredProposals: 0, updatedAt: now };
}
export function createAutonomousRuntime({ dataDir, tools = [], configuredGoals = [], decide, invokeRead,
  now = () => new Date(), modelDailyLimit = 30, readDailyLimit = 60, stepLimit = 4 }) {
  if (!dataDir || typeof decide !== "function" || typeof invokeRead !== "function") throw new Error("missing_runtime_dependencies");
  const catalog = validateCatalog(tools);
  const file = join(dataDir, "sol-agent-missions.json");
  let state = initial(), busy = false;
  const current = () => now().toISOString();
  function resetDay() {
    const day = current().slice(0, 10);
    if (state.budget.day !== day) state.budget = { day, model: 0, reads: 0 };
  }
  async function persist() {
    state.updatedAt = current();
    await mkdir(dataDir, { recursive: true });
    const tmp = file + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(state, (key,value) => key === "_volatileObservation" ? undefined : value), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  }
  async function load() {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value?.version !== 2 || !value.missions || typeof value.missions !== "object" || !value.budget) throw new Error("invalid_autonomous_store");
      state = value;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    // An interrupted running mission resumes: no untrusted external write occurred.
    for (const item of Object.values(state.missions)) {
      if (item.phase === "running") { item.phase = "ready"; item.dueAt = current(); }
    }
    for (const config of configuredGoals) {
      const g = validateGoal(config);
      if (!state.missions[g.id]) state.missions[g.id] = mission(g, current());
      // Existing missions keep their full history, notes and next due time.
    }
    await persist();
  }
  async function addGoal(input) {
    if (busy) throw new Error("runtime_busy");
    const config = validateGoal(input);
    if (Object.keys(state.missions).length >= 12) throw new Error("goal_limit");
    if (state.missions[config.id]) throw new Error("goal_already_exists");
    state.missions[config.id] = mission(config, current());
    await persist();
    return { ok: true, id: config.id, status: "ready" };
  }
  async function pauseGoal(id, paused = true) {
    const item = state.missions[id];
    if (!item) throw new Error("goal_not_found");
    if (busy) throw new Error("runtime_busy");
    item.paused = Boolean(paused);
    if (!item.paused) item.dueAt = current();
    await persist();
    return { ok: true, id, paused: item.paused };
  }
  async function wakeGoal(id, reason = "external_signal") {
    if (busy) return { ok: false, skipped: "busy" };
    const g = state.missions[id];
    if (!g) throw new Error("goal_not_found");
    if (g.paused) return { ok: true, queued: false, reason: "paused" };
    const last = Date.parse(g.lastWakeAt || "");
    if (Number.isFinite(last) && now().getTime() - last >= 0 && now().getTime() - last < 300000)
      return { ok: true, queued: false, reason: "debounced" };
    g.lastWakeAt = current();
    g.dueAt = current();
    g.history.push({at:current(),type:"wake",note:cut(reason,140)});
    g.history = g.history.slice(-12);
    await persist();
    return {ok:true, queued:true, id:g.id};
  }
  async function recordFeedback(missionId, proposalId, rating, note = "") {
    if (busy) throw new Error("runtime_busy");
    if (!["useful","irrelevant","incorrect"].includes(rating)) throw new Error("invalid_feedback_rating");
    const g = state.missions[missionId];
    if (!g) throw new Error("goal_not_found");
    const p = (g.proposals || []).find(x => x.id === proposalId);
    if (!p) throw new Error("proposal_not_found");
    p.feedback = rating;
    const record = { at: current(), rating, proposalTitle: p.title, note: cut(note, 280) };
    g.feedback = [...(g.feedback || []), record].slice(-30);
    await persist();
    return { ok: true, missionId, proposalId, rating };
  }
  function inspect() {
    resetDay();
    return { ok: true, mode: "shadow_autonomous", active: Object.values(state.missions).filter(g => !g.paused).length,
      missionCount: Object.keys(state.missions).length, readContracts: catalogCoverage(catalog), modelCallsToday: state.budget.model,
      readCallsToday: state.budget.reads, modelDailyLimit, readDailyLimit, busy,
      missions: Object.values(state.missions).map(g => ({
        id: g.id, objective: g.objective, profile: g.profile || "general", paused: g.paused, phase: g.phase, dueAt: g.dueAt,
        cycles: g.cycles, steps: g.steps, updatedAt: g.updatedAt, lastError: g.lastError, proposalCount: g.proposals.length, filteredProposals: g.filteredProposals || 0
      })) };
  }
  function listProposals(limit = 30) {
    return Object.values(state.missions).flatMap(g => g.proposals.map(p => ({ ...p, missionId: g.id })))
      .sort((a,b)=>b.at.localeCompare(a.at)).slice(0, Math.min(50,Math.max(1, Number(limit)||30)));
  }
  async function cycle() {
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      resetDay();
      const due = Object.values(state.missions).filter(g => !g.paused && Date.parse(g.dueAt) <= now().getTime())
        .sort((a,b) => a.dueAt.localeCompare(b.dueAt))[0];
      if (!due) return { skipped: "nothing_due" };
      if (!catalog.length) return { skipped: "no_authorized_tools" };
      let stepsThisRun = 0;
      if (due.phase !== "running") due.phase = "running";
      due.updatedAt = current(); await persist();
      // This bound prevents an agent from monopolizing the host or an API quota.
      while (stepsThisRun < Math.max(1, Math.min(stepLimit, 6))) {
        if (state.budget.model >= modelDailyLimit) {
          due.phase = "waiting"; due.dueAt = nextTime(now(), 60); await persist();
          return { skipped: "model_daily_budget", missionId: due.id };
        }
        state.budget.model += 1; await persist(); // reserve BEFORE model call
        const decisionRaw = await decide({
          missionId: due.id, objective: due.objective, profile: due.profile || "general", guidance: guidanceFor(due.profile || "general"), history: cleanHistory(due.history),
          tools: catalog.map(t => ({ id: t.id, description: t.description })),
          feedback: (due.feedback || []).slice(-10),
          observation: due._volatileObservation || null,
          steps: due.steps, cycles: due.cycles
        });
        const decision = validateDecision(decisionRaw, catalog);
        if (decision.action === "read") {
          if (state.budget.reads >= readDailyLimit) {
            due.phase = "waiting"; due.dueAt = nextTime(now(), 60); await persist();
            return { skipped: "read_daily_budget", missionId: due.id };
          }
          const tool = catalog.find(t => t.id === decision.toolId);
          due.history.push({ at: current(), type: "planned_read", toolId: tool.id, note: decision.note });
          due.steps += 1; state.budget.reads += 1;
          await persist(); // write-ahead checkpoint of read-only operation
          const value = await invokeRead(tool.name, structuredClone(tool.arguments));
          const serialized = JSON.stringify(value);
          if (serialized.length > 200000) throw new Error("tool_response_too_large");
          // The raw result is NOT persisted. Only a digest and model-authored notes survive.
          due.history.push({ at: current(), type: "read_result", toolId: tool.id, cycle: due.cycles, hash: sum(value),
            note: "Lectura realizada. Resultado disponible temporalmente para el siguiente razonamiento." });
          // Include tool data only in-memory for the next model decision during this cycle.
          due._volatileObservation = { id: tool.id, result: serialized.slice(0, 3500) };
          await persist(); // _volatileObservation is stripped below at save time in the main wrapper
        } else if (decision.action === "finish") {
          due.history.push({ at: current(), type: "conclusion", note: decision.note });
          const gate = proposalGate({ profile: due.profile || "general", proposal: decision.proposal, history: due.history, feedback: due.feedback || [], now: now() });
          if (gate.accepted) {
            const signature = sum({ title: decision.proposal.title.toLowerCase().replace(/\\s+/g," "), evidence: [...decision.proposal.evidence].sort() });
            if (!due.proposals.some(p => p.signature === signature && Date.parse(p.at) >= now().getTime() - 86400000)) due.proposals.push({
              id: randomUUID(), signature, ...decision.proposal, profile: due.profile || "general", attention: gate.attention, at: current(), status: "review_only"
            });
          } else if (decision.proposal) { due.filteredProposals = (due.filteredProposals || 0) + 1; }
          due.proposals = due.proposals.slice(-100);
          due.cycles += 1; due.steps = 0; due.phase = "waiting";
          due.dueAt = nextTime(now(), due.intervalMinutes);
          delete due._volatileObservation;
          due.history = due.history.slice(-12);
          due.updatedAt = current(); await persist();
          return { ok: true, missionId: due.id, outcome: "finished" };
        } else {
          due.history.push({ at: current(), type: "wait", note: decision.note });
          due.phase = "waiting"; due.dueAt = nextTime(now(), decision.waitMinutes);
          delete due._volatileObservation;
          due.history = due.history.slice(-12); due.updatedAt = current(); await persist();
          return { ok: true, missionId: due.id, outcome: "waiting" };
        }
        stepsThisRun++;
        due.updatedAt = current();
      }
      delete due._volatileObservation;
      due.phase = "ready"; due.dueAt = nextTime(now(), 1);
      due.history = due.history.slice(-12); await persist();
      return { ok: true, missionId: due.id, outcome: "checkpoint", steps: stepsThisRun };
    } catch (error) {
      const item = Object.values(state.missions).find(g => g.phase === "running");
      if (item) {
        item.errors = (item.errors || 0) + 1;
        item.lastError = cut(error?.message || error, 150);
        item.phase = "waiting"; item.dueAt = nextTime(now(), Math.min(60, Math.max(1, 2 ** Math.min(item.errors, 5))));
        delete item._volatileObservation;
      }
      await persist().catch(() => {});
      return { ok: false, error: cut(error?.message || error, 150) };
    } finally { busy = false; }
  }
  // On-disk JSON is sanitized before every save, including after errors.
  const originalPersist = persist;
  async function checkpoint() {
    for (const item of Object.values(state.missions)) delete item._volatileObservation;
    await originalPersist();
  }
  return { load, addGoal, pauseGoal, wakeGoal, recordFeedback, inspect, listProposals, cycle, checkpoint };
}
