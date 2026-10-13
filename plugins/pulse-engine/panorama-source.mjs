import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_SEEN = 500;
async function save(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, path);
}
async function load(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value.ids)) throw new Error("panorama_checkpoint_invalid");
    return value;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
function safeEdition(edition) {
  return edition && /^[0-9a-f-]{36}$/i.test(String(edition.id || "")) &&
    typeof edition.createdAt === "string" && Number.isFinite(Date.parse(edition.createdAt));
}
function formatMessage(result) {
  const summary = String(result.summary || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 450);
  const steps = Array.isArray(result.nextSteps) ? result.nextSteps
    .slice(0, 3).map(x => String(x).replace(/[\u0000-\u001f]/g, " ").slice(0, 150)) : [];
  const evidence = result.verification === "read_tool_checked" ?
    "Contrastado con una fuente de SOL." : "Detectado en Panorama; requiere confirmación.";
  return ("SOL Pulse · Investigué una novedad\n" + summary +
    "\n" + evidence + (steps.length ? "\nOpciones: " + steps.join(" / ") : "")).slice(0, 1000);
}
export function createPanoramaSource({
  sol, ingest, ownerId, dataDir, enabled = false, intervalMs = 1800000, now = () => new Date(), onCycle = null,
}) {
  const file = join(dataDir, "pulse-panorama-checkpoint.json");
  let timer = null, running = false, busy = false, streamController = null, streamConnected = false;
  let lastSignalAt = null, lastStreamError = null, rerun = false;
  let lastPollAt = null, lastSuccessAt = null, lastError = null, lastEmitted = 0, lastExamined = 0;
  async function tick() {
    if (!enabled || !ownerId || !sol?.enabled) return { skipped: "not_configured" };
    if (busy) { rerun = true; return { skipped: "busy" }; }
    busy = true;
    lastPollAt = now().toISOString();
    lastEmitted = 0;
    lastExamined = 0;
    try {
      const response = await sol.request("/v1/plugin-api/panorama/latest", { method: "GET" });
      if (!Array.isArray(response?.editions)) throw new Error("panorama_editions_invalid");
      const editions = response.editions.filter(safeEdition).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
      let checkpoint = await load(file);
      if (!checkpoint) {
        await save(file, { version: 1, ids: editions.map(x => x.id), updatedAt: now().toISOString() });
        lastSuccessAt = now().toISOString();
        lastError = null;
        return { ok: true, baselined: true, observed: editions.length, investigated: 0 };
      }
      const seen = new Set(checkpoint.ids);
      const fresh = editions.filter(x => !seen.has(x.id)).slice(0, 6);
      for (const edition of fresh) {
        if (Number(edition.newCount) > 0) {
          const reviewed = await sol.request("/v1/plugin-api/panorama/investigate", {
            body: { editionId: edition.id },
          });
          lastExamined++;
          if (reviewed?.editionId !== edition.id) throw new Error("panorama_review_mismatch");
          if (reviewed.shouldNotify === true && typeof reviewed.summary === "string" && reviewed.summary.trim()) {
            const importance = Math.max(0, Math.min(100, Math.round(Number(reviewed.importance) || 0)));
            const signal = {
              source: "panorama", type: "panorama.investigation", ownerId,
              sourceEventId: edition.id, occurredAt: edition.asOf || now().toISOString(),
              title: reviewed.summary.slice(0, 160), privacy: "private",
              importance, message: formatMessage(reviewed),
            };
            const result = await ingest(signal);
            if (result?.ok !== true) throw new Error("panorama_ingest_failed");
            if (!result.deduplicated) lastEmitted++;
          }
        }
        seen.add(edition.id);
        checkpoint = { version: 1, ids: [...seen].slice(-MAX_SEEN), updatedAt: now().toISOString() };
        await save(file, checkpoint);
      }
      lastSuccessAt = now().toISOString();
      lastError = null;
      return { ok: true, observed: editions.length, investigated: lastExamined, emitted: lastEmitted };
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 180);
      return { ok: false, error: lastError };
    } finally {
      busy = false;
      // Re-evaluate notifications already pending as well as newly detected
      // editions. Sending remains controlled by Pulse's quiet hours and limits.
      if (onCycle) Promise.resolve().then(onCycle).catch(() => {});
      if (rerun) { rerun = false; queueMicrotask(() => void tick()); }
    }
  }
  async function followStream(signal) {
    while (running && !signal.aborted) {
      try {
        if (typeof sol.watchPanorama !== "function") return;
        await sol.watchPanorama(() => {
          lastSignalAt = now().toISOString();
          void tick();
        }, {
          signal,
          onConnected: () => { streamConnected = true; lastStreamError = null; void tick(); },
        });
        streamConnected = false;
      } catch (error) {
        streamConnected = false;
        if (!signal.aborted) lastStreamError = String(error?.message || error).slice(0, 180);
      }
      if (!running || signal.aborted) break;
      await new Promise(resolve => {
        const delay = setTimeout(resolve, 5000);
        delay.unref?.();
        signal.addEventListener("abort", () => { clearTimeout(delay); resolve(); }, { once: true });
      });
    }
  }
  function start() {
    if (!enabled || !ownerId || !sol?.enabled || running) return false;
    running = true;
    // Safety net on lost notifications or disconnected SOL; stream drives fast
    // updates rather than this low-frequency timer.
    timer = setInterval(() => void tick(), Math.max(120000, intervalMs));
    timer.unref?.();
    streamController = new AbortController();
    void followStream(streamController.signal);
    void tick();
    return true;
  }
  function stop() {
    running = false;
    streamConnected = false;
    streamController?.abort(); streamController = null;
    if (timer) clearInterval(timer); timer = null;
  }
  function status() {
    return { configured: Boolean(enabled && ownerId && sol?.enabled), running, lastPollAt,
      lastSuccessAt, lastError, lastExamined, lastEmitted, intervalMs, streamConnected, lastSignalAt, lastStreamError };
  }
  return { start, stop, tick, status };
}
