// Conservative compatibility catalogue based on SOL plugin tool declarations.
// These names are NOT an authorization grant: each invocation still passes SOL's
// owner-scoped /v1/plugin-api/mcp/tools/invoke-read enforcement.
export const PLUGIN_READ_CONTRACTS = Object.freeze({
  "home-assistant": ["home_assistant_cache_status","home_assistant_get_state","home_assistant_search_states","home_assistant_tv_status"],
  "bambuddy": ["bambuddy_health","bambuddy_list_printers","bambuddy_fleet_status","bambuddy_printer_status","bambuddy_materials","bambuddy_queue","bambuddy_obico_status"],
  "bwa-3d": ["bwa_3d_status","bwa_3d_mercadolibre_mcp_status","bwa_3d_mercadolibre_docs_search"],
  "finanzas": ["finanzas_status","finanzas_vencimientos_list","finanzas_vencimiento_get","finanzas_resumen"],
  "educacion": ["educacion_estado","educacion_materias","educacion_materiales_buscar","educacion_material_leer","educacion_tareas","educacion_calendario","educacion_proximas_evaluaciones"]
});
const BLOCKED_VERBS = /(?:^|_)(?:call_service|control|navigate|send|write|delete|create|upsert|play|execute|ejecutar|sincronizar|confirmar|marcar_pagado|login|logout|print|action|patch|link|set|update|approve|publish|archive)(?:_|$)/;
export function safeToolName(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_]{2,100}$/.test(name)
    && !name.startsWith("sol_agent_") && !BLOCKED_VERBS.test(name);
}
export function catalogCoverage(list) {
  const indexed=new Map(Object.entries(PLUGIN_READ_CONTRACTS).flatMap(([plugin,names])=>names.map(name=>[name,plugin])));
  return (list || []).map(item=>({
    id:item.id, name:item.name, plugin:indexed.get(item.name)||"other",
    knownReadContract:indexed.has(item.name),
    safetyNameAccepted:safeToolName(item.name)
  }));
}
