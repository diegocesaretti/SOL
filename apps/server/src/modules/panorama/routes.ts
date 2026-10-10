import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { calendarDays, dailyEditions, generateEdition, validDate } from "./daily.js";

export async function handlePanoramaDailyApi(
  path:string, request:IncomingMessage,response:ServerResponse,principal:AuthPrincipal,
):Promise<boolean> {
  const url=new URL(request.url||path,"http://sol.local");
  if(path==="/v1/panorama/digest/day" && request.method==="GET"){
    const date=url.searchParams.get("date")||"";
    if(!validDate(date)){sendJson(response,400,{error:"invalid_digest_date"});return true;}
    sendJson(response,200,{date,editions:await dailyEditions(principal,date)});
    return true;
  }
  if(path==="/v1/panorama/digest/calendar" && request.method==="GET"){
    const month=url.searchParams.get("month")||"";
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)){sendJson(response,400,{error:"invalid_digest_month"});return true;}
    sendJson(response,200,{month,days:await calendarDays(principal,month)});
    return true;
  }
  if(path==="/v1/panorama/digest/generate" && request.method==="POST"){
    if(!String(request.headers["content-type"]||"").includes("application/json")){sendJson(response,415,{error:"json_required"});return true;}
    // Guard against requests from an unrelated site to the loopback UI.
    const origin=request.headers.origin;
    if(origin){
      try {
        const same=new URL(origin);
        if(same.host!==request.headers.host){sendJson(response,403,{error:"same_origin_required"});return true;}
      }catch{sendJson(response,403,{error:"same_origin_required"});return true;}
    }
    const body=await readJsonBody<{date?:unknown}>(request,4096);
    if(typeof body.date!=="string"||!validDate(body.date)){sendJson(response,400,{error:"invalid_digest_date"});return true;}
    try{
      const digest=await generateEdition(principal,body.date,"manual");
      sendJson(response,200,{edition:digest});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(message==="digest_outside_allowed_range"||message==="member_not_active")sendJson(response,400,{error:message});
      else throw error;
    }
    return true;
  }
  return false;
}
