"""Entregas escolares autorizadas: Nexo WhatsApp a padre y alumno.
El permiso queda en policy.json local. Nunca publica chats ni credenciales.
"""
import datetime as dt
import json
import os
import re
import shutil
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DATA = Path(os.environ.get("SOL_PLUGIN_DATA_DIR", str(Path(__file__).parent / ".data"))) / "educacion"
AGENT = DATA / "agente.json"
POLICY = DATA / "delivery-policy.json"
LEDGER = DATA / "delivery-ledger.json"
NEXO_ROOT = Path(os.environ.get("EDUCACION_NEXO_DATA", str(Path.home()/"AppData/Local/SOL/plugin-data/nexo-whatsapp")))
OUTBOX = NEXO_ROOT / "inbox" / "educacion"
TZ = ZoneInfo("America/Argentina/Buenos_Aires")
NOW = dt.datetime.now(TZ)
TODAY = NOW.date()
PORT = int(os.environ.get("EDUCACION_NEXO_PORT",3210))
def read(path,default):
    try:return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:return default
def save(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+".tmp")
    temp.write_text(json.dumps(obj,indent=2,ensure_ascii=False),encoding="utf-8")
    os.replace(temp,path)
def request(route,payload=None):
    body=json.dumps(payload,ensure_ascii=False).encode("utf-8") if payload is not None else None
    req=Request(f"http://127.0.0.1:{PORT}{route}",data=body,
                headers={"Content-Type":"application/json"} if body is not None else {})
    with urlopen(req,timeout=35) as r:return json.load(r)
def date_parse(value):
    if not value:return None
    for fmt in ("%Y-%m-%d","%d/%m/%Y","%d/%m"):
        try:
            d=dt.datetime.strptime(value,fmt).date()
            if fmt=="%d/%m":
                d=d.replace(year=TODAY.year)
                if d < TODAY-dt.timedelta(days=10):d=d.replace(year=TODAY.year+1)
            return d
        except ValueError:pass
    return None
def responses(events,ledger,policy):
    """Reconcilia únicamente las respuestas salientes de las personas autorizadas."""
    try:msg=request("/api/output/conversation?limit=100").get("messages",[])
    except Exception:return 0
    valid={str(x["phone"]) for x in policy["recipients"]}
    changes=0
    for m in msg:
        if m.get("direction")!="inbound" or str(m.get("peerPhone")) not in valid:continue
        if m.get("id") in ledger["processedReplies"]:continue
        text=str(m.get("text") or "").strip()
        match=re.match(r"(?is)^EDU\s+([0-9a-f]{8,24})\s+(FECHA|TEMAS)\s*[:=-]?\s*(.+)$",text)
        if not match:continue
        code,field,value=match.groups()
        matches=[e for e in events if e["id"].startswith(code.lower())]
        if len(matches)!=1:continue
        ev=matches[0]
        if field.upper()=="FECHA":
            d=date_parse(value.strip())
            if d and d>=TODAY and d <=TODAY+dt.timedelta(days=400):
                ev["fecha"]=d.isoformat();ev["fechaFuente"]="confirmacion_familiar";changes+=1
            else:continue
        else:
            if len(value.strip())<4 or len(value)>500:continue
            ev["temas"]=value.strip();ev["temasFuente"]="confirmacion_familiar";changes+=1
        ev["actualizadoEn"]=NOW.isoformat()
        ev["guiaRevision"]=int(ev.get("guiaRevision",0))+1
        ev["regenerarGuia"]=True
        ledger["processedReplies"].append(m["id"])
    ledger["processedReplies"]=ledger["processedReplies"][-400:]
    return changes
def send(to,text,key,ledger,dry):
    if key in ledger["sent"]:return False
    if dry:return True
    response=request("/api/output/send",{"confirmedByUser":True,"to":to,"text":text,
             "reason":"SOL Educación autorización recurrente: "+key[:140]})
    if response.get("sent") is not True:raise RuntimeError("nexo_text_no_confirmed")
    ledger["sent"][key]=NOW.isoformat()
    save(LEDGER,ledger)
    return True
def send_pdf(to,path,caption,key,ledger,dry):
    if key in ledger["sent"]:return False
    if not path.is_file():return False
    if dry:return True
    import fitz
    with fitz.open(path) as doc:
        if not len(doc) or not doc[0].get_text().strip():raise RuntimeError("invalid_pdf")
    OUTBOX.mkdir(parents=True,exist_ok=True)
    target=OUTBOX/(path.stem+".pdf")
    shutil.copy2(path,target)
    payload={"confirmedByUser":True,"to":to,"kind":"document","filePath":str(target),
        "fileName":"Guia_"+path.stem+".pdf","caption":caption,
        "reason":"SOL Educación autorización recurrente: "+key[:140]}
    response=request("/api/output/media",payload)
    if response.get("sent") is not True:raise RuntimeError("nexo_document_no_confirmed")
    ledger["sent"][key]=NOW.isoformat()
    save(LEDGER,ledger)
    return True
def run(dry=False):
    policy=read(POLICY,{})
    if policy.get("enabled") is not True or policy.get("standingAuthorization") is not True:
        raise RuntimeError("education_standing_authorization_missing")
    recipients=policy.get("recipients",[])
    if len(recipients)!=2 or {x.get("role") for x in recipients}!={"padre","alumno"}:
        raise RuntimeError("bad_recipient_policy")
    if any(not re.fullmatch(r"\d{10,15}",str(x.get("phone",""))) for x in recipients):
        raise RuntimeError("invalid_phone_policy")
    record=read(AGENT,{"events":[]})
    ledger=read(LEDGER,{"sent":{},"processedReplies":[]})
    ledger.setdefault("sent",{});ledger.setdefault("processedReplies",[])
    changed=responses(record.get("events",[]),ledger,policy) if not dry else 0
    if changed and not dry:
        # Si la familia completa/corrige una fecha o temario, rearmar la guía
        # con los apuntes originales, conservando la misma evaluación.
        try:
            from education_agent import generate
            catalog=read(DATA/"index.json",{})
            for ev in record.get("events",[]):
                if ev.pop("regenerarGuia",False) and len(str(ev.get("temas","")).strip())>12:
                    if "no especificad" not in str(ev.get("temas","")).lower():
                        try:
                            generate(ev,catalog)
                        except Exception as e:
                            ev["observacion"]="Guía actualizada pendiente: "+str(e)[:160]
        except Exception as e:
            record["deliveryWarning"]="No se pudo regenerar guía: "+str(e)[:160]
        save(AGENT,record);save(LEDGER,ledger)
    sent=0;errors=[]
    for ev in record.get("events",[]):
        if ev.get("estado")=="descartado":continue
        code=ev["id"][:8]
        subject=ev.get("materia","Materia sin confirmar")
        day=date_parse(ev.get("fecha"))
        topics=ev.get("temas","").strip()
        unknown_topics=not topics or "no especificad" in topics.lower() or "sin temario" in topics.lower()
        missing=[]
        if not day:missing.append("la FECHA")
        if unknown_topics:missing.append("los TEMAS")
        if missing:
            question=(f"📚 SOL Educación · Luca\n"
                f"Hay un indicio de evaluación o trabajo de {subject}, pero me falta {' y '.join(missing)}. "
                f"¿Lo saben? Respondan a SOL con:\n"
                +(f"EDU {code} FECHA DD/MM\n" if not day else "")
                +(f"EDU {code} TEMAS temas que entran\n" if unknown_topics else "")
                +"Mientras tanto voy revisando los apuntes. No lo agendo como confirmado hasta conocer la fecha.")
            for r in recipients:
                key=f"ask:{ev['id']}:{','.join(missing)}:{r['role']}"
                try: sent+=bool(send(str(r["phone"]),question,key,ledger,dry))
                except Exception as e:errors.append(f"{key}: {str(e)[:130]}")
        elif day:
            # Aviso inicial para evaluación completa, sin revelar chats ajenos.
            note=f"📚 SOL Educación: {subject}\nFecha: {day.strftime('%d/%m/%Y')}\nTemas: {topics[:250]}\nAgendado para seguimiento y recordatorios."
            for r in recipients:
                key=f"confirmed:{ev['id']}:{day}:{r['role']}"
                try:sent+=bool(send(str(r["phone"]),note,key,ledger,dry))
                except Exception as e:errors.append(f"{key}: {str(e)[:130]}")
        guide=ev.get("guia",{})
        pdf=Path(guide.get("pdf","")) if guide and guide.get("pdf") else None
        if pdf:
            caption=(f"Guía de estudio SOL · {subject}. "+("La fecha todavía no está confirmada." if not day else f"Evaluación: {day.strftime('%d/%m/%Y')}."))
            for r in recipients:
                key=f"pdf:{ev['id']}:{r['role']}:{pdf.name}" + (f":rev{ev['guiaRevision']}" if ev.get("guiaRevision",0) else "")
                try: sent+=bool(send_pdf(str(r["phone"]),pdf,caption,key,ledger,dry))
                except Exception as e:errors.append(f"{key}: {str(e)[:130]}")
        if day:
            delta=(day-TODAY).days
            if delta in (1,2):
                for r in recipients:
                    txt=(f"⏰ SOL Educación · faltan {delta} día{'s' if delta!=1 else ''} "
                         f"para {subject} ({day.strftime('%d/%m')}). Temas: {topics[:220] if not unknown_topics else 'sin confirmar'}. "
                         +"Ya tenés la guía en este chat." if pdf else
                         f"⏰ SOL Educación · faltan {delta} días para {subject} ({day.strftime('%d/%m')}).")
                    key=f"reminder:{ev['id']}:{day}:{delta}:{r['role']}"
                    try:sent+=bool(send(str(r["phone"]),txt,key,ledger,dry))
                    except Exception as e:errors.append(f"{key}: {str(e)[:130]}")
    ledger["lastRun"]=NOW.isoformat()
    ledger["lastError"]=errors[:12]
    if not dry:save(LEDGER,ledger)
    return {"ok":not errors,"dry":dry,"sent":sent,"replyUpdates":changed,
            "events":len(record.get("events",[])),"errors":errors[:12]}
if __name__=="__main__":
    try:print(json.dumps(run(dry="--preview" in sys.argv),ensure_ascii=False))
    except Exception as e:print(json.dumps({"ok":False,"error":str(e)},ensure_ascii=False));sys.exit(1)
