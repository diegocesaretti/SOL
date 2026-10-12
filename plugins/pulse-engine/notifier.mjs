const zone="America/Argentina/Cordoba";
export function localClock(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(date).map(p=>[p.type,p.value]));
  return {day:parts.year+"-"+parts.month+"-"+parts.day,hour:Number(parts.hour)};
}
export function quietHour(date=new Date()) {
  const {hour}=localClock(date);return hour>=22||hour<7;
}
export function messageFor(event) {
  const labels={
    "order.cancelled":"Se canceló una venta de Mercado Libre.",
    "printer.failure":"Hay una falla en una impresora.",
    "order.status.changed":"Cambió el estado de un pedido.",
    "weather.storm":"Hay una alerta meteorológica importante."
  };
  const text=labels[event.type]||("Detecté un evento que necesita revisión: "+String(event.type||"evento").slice(0,80));
  return "SOL Pulse · Aviso importante\n"+text+"\nOrigen: "+String(event.source||"SOL")+"\nRevisá los detalles en SOL.";
}
export function digestText(events) {
  const bySource={};for(const e of events){bySource[e.source]=(bySource[e.source]||0)+1;}
  const lines=Object.entries(bySource).map(([s,n])=>"- "+s+": "+n+" novedad(es)");
  return "SOL Pulse · Resumen de actividad\n"+lines.join("\n")+"\nPodés consultarme los detalles cuando quieras.";
}
export async function sendWhatsApp({url,recipient,text,fetchImpl=fetch}){
  if(!/^http:\/\/127\.0\.0\.1:(3210|[0-9]{4,5})\/api\/output\/send$/.test(url))throw new Error("invalid_nexo_local_url");
  if(!/^[1-9]\d{9,14}$/.test(recipient))throw new Error("invalid_recipient");
  if(!text||text.length>1800)throw new Error("invalid_notification_text");
  const reply=await fetchImpl(url,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({to:recipient,text,reason:"sol-pulse:proactivity-opt-in",confirmedByUser:true}),
    signal:AbortSignal.timeout(15000)
  });
  if(!reply.ok)throw new Error("nexo_http_"+reply.status);
  const data=await reply.json();
  if(data?.sent!==true)throw new Error("nexo_send_unconfirmed");
  return {accepted:true};
}
