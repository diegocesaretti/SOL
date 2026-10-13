import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanoramaSource } from "./panorama-source.mjs";
const edition = (id, newCount=1) => ({
  id, date:"2026-10-12", slot:"12", createdAt:"2026-10-12T15:01:00Z",
  asOf:"2026-10-12T15:00:00Z", newCount, narrative:"Una evaluación mencionada en el colegio",
});
const ID1="11111111-1111-4111-8111-111111111111";
const ID2="22222222-2222-4222-8222-222222222222";
const fixed=()=>new Date("2026-10-12T15:10:00Z");
test("Panorama first read creates baseline and does not message retrospectively", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pulse-pano-"));
  try{
    const invoked=[],events=[];
    const sol={enabled:true,request:async(path)=>{
      invoked.push(path);
      if(path.endsWith("/latest"))return {editions:[edition(ID1)]};
      throw Error("investigation_should_not_start_on_baseline");
    }};
    const engine=createPanoramaSource({sol,ownerId:"person",dataDir:dir,enabled:true,now:fixed,
      ingest:async(e)=>{events.push(e);return {ok:true}}});
    assert.deepEqual((await engine.tick()).baselined,true);
    assert.equal(events.length,0);
    assert.equal(invoked.length,1);
    assert.equal((await engine.tick()).investigated,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("new Panorama edition triggers bounded investigated opportunity once",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pulse-pano-"));
  try{
    let editions=[edition(ID1)],analyses=0;
    const events=[];
    const sol={enabled:true,request:async(path,options)=>{
      if(path.endsWith("/latest"))return {editions};
      if(path.endsWith("/investigate")){
        analyses++;
        assert.equal(options.body.editionId,ID2);
        return {editionId:ID2,shouldNotify:true,summary:"Confirmar examen",
          importance:84,verification:"read_tool_checked",nextSteps:["Consultar el temario"]};
      }
      throw Error("unknown_call");
    }};
    const engine=createPanoramaSource({sol,ownerId:"person",dataDir:dir,enabled:true,
      now:fixed,ingest:async(e)=>{events.push(e);return {ok:true,deduplicated:false}}});
    await engine.tick();
    editions=[edition(ID1),edition(ID2)];
    assert.equal((await engine.tick()).emitted,1);
    assert.equal(analyses,1);
    assert.equal(events[0].source,"panorama");
    assert.equal(events[0].sourceEventId,ID2);
    assert.equal(events[0].privacy,"private");
    assert.match(events[0].message,/Consultar el temario/);
    assert.equal((await engine.tick()).emitted,0);
    assert.equal(analyses,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("investigation failure preserves edition for retry; disabled engine reads nothing",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pulse-pano-"));
  try{
    let editions=[edition(ID1)],fail=true,calls=0;
    const sol={enabled:true,request:async(path)=>{
      calls++;
      if(path.endsWith("/latest"))return {editions};
      if(fail)throw Error("codex_temporarily_unavailable");
      return {editionId:ID2,shouldNotify:false,summary:""};
    }};
    const engine=createPanoramaSource({sol,ownerId:"person",enabled:true,dataDir:dir,
      now:fixed,ingest:async()=>{throw Error("not_expected")}});
    await engine.tick();
    editions=[edition(ID1),edition(ID2)];
    assert.equal((await engine.tick()).ok,false);
    fail=false;
    assert.equal((await engine.tick()).investigated,1);
    const disabled=createPanoramaSource({sol,ownerId:"person",enabled:false,dataDir:dir,
      now:fixed,ingest:async()=>({ok:true})});
    const before=calls;
    assert.equal((await disabled.tick()).skipped,"not_configured");
    assert.equal(calls,before);
  }finally{await rm(dir,{recursive:true,force:true});}
});
