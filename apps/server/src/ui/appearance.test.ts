import assert from "node:assert/strict";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { solThemeScript, solThemeStyles } from "./appearance.js";

test("shared SOL theme startup script parses and style palette is wired", () => {
  assert.doesNotThrow(() => new Script(solThemeScript()));
  const css=solThemeStyles();
  assert.match(css,/--sol-theme-glow/);
  assert.match(css,/var\(--accent\)/);
});
test("SOL theme persists valid colors and rejects invalid storage values", () => {
  const store=new Map<string,string>();
  const properties=new Map<string,string>();
  const listeners=new Map<string,Function>();
  const ctx=createContext({
    localStorage:{
      getItem:(key:string)=>store.get(key)||null,
      setItem:(key:string,value:string)=>{store.set(key,value);},
    },
    document:{documentElement:{style:{setProperty:(key:string,value:string)=>properties.set(key,value)}}},
    window:{
      addEventListener:(name:string,handler:Function)=>listeners.set(name,handler),
      dispatchEvent:()=>{},
    },
    CustomEvent:class{constructor(_name:string,_opts:unknown){}},
  });
  new Script(solThemeScript()).runInContext(ctx);
  const windowObj=ctx.window as { SOLTheme: { get:()=>Record<string,string>;set:(args:Record<string,string>)=>Record<string,string>;preset:(name:string)=>unknown } };
  windowObj.SOLTheme.set({accent:"#112233",background:"url(fake)",glow:"#445566"});
  assert.equal(windowObj.SOLTheme.get().accent,"#112233");
  assert.equal(windowObj.SOLTheme.get().background,"#070d1a");
  assert.equal(properties.get("--accent"),"#112233");
  assert.equal(JSON.parse(store.get("sol.appearance.v1")||"{}").glow,"#445566");
  windowObj.SOLTheme.preset("forest");
  assert.equal(windowObj.SOLTheme.get().accent,"#9cf3c5");
});
