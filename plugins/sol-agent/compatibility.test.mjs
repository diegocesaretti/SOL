import test from "node:test";
import assert from "node:assert/strict";
import { safeToolName, catalogCoverage, PLUGIN_READ_CONTRACTS } from "./compatibility.mjs";
import { validateCatalog } from "./autonomous.mjs";

test("read contract covers all existing SOL domains",()=>{
 for (const plugin of ["home-assistant","bambuddy","bwa-3d","finanzas","educacion"]) {
   assert.ok(Array.isArray(PLUGIN_READ_CONTRACTS[plugin]));
   assert.ok(PLUGIN_READ_CONTRACTS[plugin].length>0);
 }
 const rows=catalogCoverage([{id:"air",name:"home_assistant_get_state"},{id:"printers",name:"bambuddy_fleet_status"},{id:"finance",name:"finanzas_resumen"}]);
 assert.deepEqual(rows.map(x=>x.plugin),["home-assistant","bambuddy","finanzas"]);
 assert.ok(rows.every(x=>x.knownReadContract && x.safetyNameAccepted));
});

test("block known action/tool names at catalog validation regardless of SOL API",()=>{
 const names=["home_assistant_call_service","bambuddy_control","bambuddy_print_sd",
   "finanzas_vencimiento_upsert","finanzas_vencimiento_marcar_pagado","educacion_agente_ejecutar",
   "bwa_3d_mercadolibre_mcp_login","home_assistant_youtube_play"];
 for (const name of names) {
   assert.equal(safeToolName(name),false,name);
   assert.throws(()=>validateCatalog([{id:"device",name,arguments:{}}]),/invalid_tool_name/);
 }
});

test("future read-only plugins remain possible through owner allowlist",()=>{
 const name="future_inventory_read";
 assert.equal(safeToolName(name),true);
 const catalog=validateCatalog([{id:"inventory",name,arguments:{limit:5}}]);
 assert.equal(catalog.length,1);
 assert.equal(catalogCoverage(catalog)[0].plugin,"other");
});
