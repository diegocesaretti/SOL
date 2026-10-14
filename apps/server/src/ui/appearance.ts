/**
 * Browser-local appearance preferences. No private SOL data is stored.
 */
export const solThemeStyles = (): string => `
:root{--sol-theme-glow:#5279bc}
body{background-color:var(--bg);background-image:radial-gradient(ellipse at 9% 3%,color-mix(in srgb,var(--sol-theme-glow) 36%,transparent),transparent 45%),radial-gradient(ellipse at 95% 80%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 55%)}
body::before{background:var(--sol-theme-glow)}
body::after{background:var(--accent)}
.sidebar{background:linear-gradient(165deg,color-mix(in srgb,var(--panel) 78%,transparent),color-mix(in srgb,var(--bg) 88%,transparent))}
.brandmark{background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 44%,transparent),color-mix(in srgb,var(--panel2) 77%,transparent))}
.nav a.active{background:linear-gradient(100deg,color-mix(in srgb,var(--accent) 21%,transparent),color-mix(in srgb,var(--sol-theme-glow) 17%,transparent));border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.card{background-color:color-mix(in srgb,var(--panel) 82%,transparent)}
button.primary,.button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
`;

export const solThemeScript = (): string => `
(()=> {
  "use strict";
  const KEY="sol.appearance.v1";
  const defaults={accent:"#aee7ff",background:"#070d1a",panel:"#13243c",text:"#f0f7ff",glow:"#5279bc"};
  const presets={
    "ocean":{...defaults},
    "amber":{accent:"#ffd39b",background:"#110e12",panel:"#26202b",text:"#fff2dc",glow:"#9b5f80"},
    "forest":{accent:"#9cf3c5",background:"#081510",panel:"#17362b",text:"#e9fff5",glow:"#327d65"},
    "violet":{accent:"#d8b7ff",background:"#100d1b",panel:"#24203c",text:"#f4ecff",glow:"#7662c9"}
  };
  let current={...defaults};
  const validColor=value=>typeof value==="string"&&/^#[0-9a-f]{6}$/i.test(value);
  function normalize(source){
    const value={...defaults};
    if(source&&typeof source==="object"){
      for(const key of Object.keys(defaults))if(validColor(source[key]))value[key]=source[key].toLowerCase();
    }
    return value;
  }
  function draw(){
    const style=document.documentElement.style;
    style.setProperty("--bg",current.background);
    style.setProperty("--panel",current.panel);
    style.setProperty("--panel2",current.panel);
    style.setProperty("--panel3",current.panel);
    style.setProperty("--text",current.text);
    style.setProperty("--accent",current.accent);
    style.setProperty("--sol-theme-glow",current.glow);
    style.setProperty("--line","color-mix(in srgb,"+current.text+" 17%,transparent)");
    style.setProperty("--muted","color-mix(in srgb,"+current.text+" 66%,transparent)");
    window.dispatchEvent(new CustomEvent("sol-theme-change",{detail:{...current}}));
  }
  function load(){
    try{current=normalize(JSON.parse(localStorage.getItem(KEY)||"null"))}
    catch{current={...defaults}}
    draw();
  }
  window.SOLTheme={
    get:()=>({...current}),
    presets:()=>Object.keys(presets),
    set(partial){
      current=normalize({...current,...partial});draw();
      try{localStorage.setItem(KEY,JSON.stringify(current))}catch{}
      return {...current};
    },
    preset(name){return this.set(presets[name]||defaults)},
    reset(){return this.set(defaults)}
  };
  window.addEventListener("storage",e=>{if(e.key===KEY)load()});
  load();
})();
`;
