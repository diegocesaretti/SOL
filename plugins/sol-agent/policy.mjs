// Deterministic guardrails inspired by Home Assistant and small-business operator reports.
// This module NEVER calls a tool, changes an entity, sends a message, or authorizes an action.
export const PROFILES = Object.freeze(["general", "home", "business"]);
export function normalizeProfile(profile = "general") {
  if (!PROFILES.includes(profile)) throw new Error("invalid_goal_profile");
  return profile;
}
export function guidanceFor(profile = "general") {
  switch (normalizeProfile(profile)) {
    case "home": return [
      "HOGAR: priorizar bienestar diario, confort, energía y fallas reales; no alertar por lecturas aisladas.",
      "Una lectura aislada de sensores, presencia o temperatura NO confirma un incidente. Releer en otra ejecución.",
      "Una entidad unavailable/unknown es estado incierto, no prueba de que un aparato esté encendido o apagado.",
      "No inferir presencia de personas, alarmas, incendios, fallas eléctricas ni diagnósticos de un valor aislado.",
      "Evitar recomendaciones ruidosas; horarios de silencio y contexto de TV/descanso importan.",
      "Nunca proponer tocar cerraduras, alarmas o dispositivos riesgosos sin revisión explícita."
    ].join(" ");
    case "business": return [
      "NEGOCIO: priorizar faltantes, pedidos retrasados, reclamos, fallas de impresoras y flujo de producción.",
      "Correlacionar ventas, stock, cola de producción y estado de impresoras cuando existan fuentes autorizadas.",
      "Distinguir stock publicado de stock físico; no inventar demanda, costos, margen, plazos o competidores.",
      "Cambios de precio, publicaciones, inicio de impresión, pagos, compras y mensajes requieren confirmación.",
      "No tratar una falla de API como caída de ventas ni una pausa de impresora como avería confirmada.",
      "Priorizar propuestas concretas con fuente y siguiente verificación, evitando informes triviales."
    ].join(" ");
    default: return "Proponer solo hallazgos útiles y comprobables; detectar incertidumbre, evitar alarmas infundadas y respetar permisos de cada fuente.";
  }
}
export function proposalGate({ profile = "general", proposal, history = [], feedback = [], now = new Date() }) {
  normalizeProfile(profile);
  if (!proposal || !Array.isArray(proposal.evidence) || !proposal.evidence.length)
    return { accepted: false, reason: "missing_evidence" };
  const threshold = profile === "home" ? 0.65 : 0.55;
  if (!(Number(proposal.confidence) >= threshold))
    return { accepted: false, reason: "low_confidence" };
  const checked = proposal.evidence.every(id => history.some(h => h.type === "read_result" && h.toolId === id));
  if (!checked) return { accepted: false, reason: "unverified_source" };
  if (profile === "home") {
    // Sensor anomalies must survive an independent scheduled cycle; repeated reads
    // within a single model turn do not count as independent confirmation.
    const confirmed = proposal.evidence.every(id => {
      const records = history.filter(h => h.type === "read_result" && h.toolId === id);
      const groups = new Map();
      for (const r of records) if (Number.isInteger(r.cycle) && typeof r.hash === "string")
        groups.set(r.cycle, { hash: r.hash, at: r.at });
      const recent = [...groups.entries()].sort((a,b) => b[0] - a[0]).slice(0,2);
      return recent.length === 2 &&
        recent[0][1].hash === recent[1][1].hash &&
        Date.parse(recent[0][1].at) - Date.parse(recent[1][1].at) >= 120000;
    });
    if (!confirmed) return { accepted: false, reason: "needs_second_observation" };
  }
  const suppressed = feedback.some(f => ["irrelevant", "incorrect"].includes(f.rating)
    && String(f.proposalTitle || "").trim().toLowerCase() === proposal.title.trim().toLowerCase()
    && now.getTime() - Date.parse(f.at) >= 0 && now.getTime() - Date.parse(f.at) < 7*86400000);
  if (suppressed && proposal.priority !== "high")
    return { accepted: false, reason: "recent_negative_feedback" };
  return { accepted: true, reason: "verified", attention: profile === "home" ? "quiet_digest" : "review" };
}
