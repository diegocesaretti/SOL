const zone="America/Argentina/Cordoba";
export function localClock(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(date).map(p=>[p.type,p.value]));
  return {day:parts.year+"-"+parts.month+"-"+parts.day,hour:Number(parts.hour)};
}
export function quietHour(date=new Date()) {
  const {hour}=localClock(date);return hour>=22||hour<7;
}
export function urgentAllowed(event,now=new Date()){
  return event?.type==="home.alarm.critical" || !quietHour(now);
}
export function messageFor(event) {
  if(event?.source==="panorama"&&event?.type==="panorama.investigation"&&typeof event.message==="string")return event.message.slice(0,1100);
  const labels={
    "order.cancelled":"Se canceló una venta de Mercado Libre.",
    "printer.failure":"Hay una falla en una impresora.",
    "order.status.changed":"Cambió el estado de un pedido.",
    "weather.storm":"Hay una alerta meteorológica importante.",
    "invoice.deadline.today":"Hoy vence una obligación registrada en Finanzas.",
    "invoice.deadline.overdue":"Hay un vencimiento reciente sin registrar como pagado en Finanzas."
  };
  const text=labels[event.type]||("Detecté un evento que necesita revisión: "+String(event.type||"evento").slice(0,80));
  return "SOL Pulse · Aviso importante\n"+text+"\nOrigen: "+String(event.source||"SOL")+"\nRevisá los detalles en SOL.";
}
export function digestText(events) {
  const bySource={};for(const e of events){bySource[e.source]=(bySource[e.source]||0)+1;}
  const lines=Object.entries(bySource).map(([s,n])=>"- "+s+": "+n+" novedad(es)");
  return "SOL Pulse · Resumen de actividad\n"+lines.join("\n")+"\nPodés consultarme los detalles cuando quieras.";
}
export async function sendWhatsApp({url,recipient,text,token,eventId,fetchImpl=fetch}){
  if(!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/api\/automation\/pulse\/send$/.test(url))throw new Error("invalid_nexo_local_url");
  if(!/^[1-9]\d{9,14}$/.test(recipient))throw new Error("invalid_recipient");
  if(typeof token!=="string"||token.length<32)throw new Error("pulse_automation_token_missing");
  if(!/^[a-zA-Z0-9_.:-]{8,100}$/.test(eventId||""))throw new Error("pulse_event_id_invalid");
  if(!text||text.length>1200)throw new Error("invalid_notification_text");
  const reply=await fetchImpl(url,{
    method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+token},
    body:JSON.stringify({automation:"sol_pulse",eventId,to:recipient,text}),
    signal:AbortSignal.timeout(15000)
  });
  if(!reply.ok)throw new Error("nexo_http_"+reply.status);
  const data=await reply.json();
  if(data?.sent!==true && data?.duplicate!==true)throw new Error("nexo_send_unconfirmed");
  return {accepted:true,duplicate:data?.duplicate===true};
}
