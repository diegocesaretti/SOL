const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

function clean(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function splitConfiguredManifestUrl(manifestUrl) {
  const raw = clean(manifestUrl);
  if (!raw) throw new Error("stremio_addon_manifest_url_required");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("stremio_addon_manifest_url_invalid"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("stremio_addon_manifest_url_invalid");

  const hashIndex = raw.indexOf("#");
  const noHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = noHash.indexOf("?");
  const pathPart = queryIndex >= 0 ? noHash.slice(0, queryIndex) : noHash;
  const queryPart = queryIndex >= 0 ? noHash.slice(queryIndex) : "";
  let manifestPart = pathPart.replace(/\/+$/, "");
  if (!/\/manifest\.json$/i.test(manifestPart)) {
    manifestPart = `${manifestPart.replace(/\/manifest\.json$/i, "")}/manifest.json`;
  }
  return {
    manifestUrl: `${manifestPart}${queryPart}`,
    basePart: manifestPart.slice(0, -"/manifest.json".length),
    queryPart
  };
}

export function streamResourceUrl(manifestUrl, mediaType, mediaId, { rawColons = false } = {}) {
  const configured = splitConfiguredManifestUrl(manifestUrl);
  const type = encodeURIComponent(clean(mediaType));
  let id = encodeURIComponent(clean(mediaId));
  if (!type || !id) throw new Error("stremio_stream_resource_identity_required");
  if (rawColons) id = id.replace(/%3A/gi, ":");
  return `${configured.basePart}/stream/${type}/${id}.json${configured.queryPart}`;
}

function requestError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "stremio_addon_timeout";
  return error?.message || String(error);
}

async function fetchStreamsOnce(url, timeoutMs) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        "user-agent": "SOL-Stremio-NativeIndex/1"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, transient: true, elapsedMs: Date.now() - started, error: requestError(error) };
  }

  const status = response.status;
  const elapsedMs = Date.now() - started;
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      transient: TRANSIENT_HTTP.has(status),
      status,
      elapsedMs,
      error: `stremio_addon_http_${status}`
    };
  }

  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { return { ok: false, transient: false, status, elapsedMs, error: "stremio_addon_invalid_json" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.streams)) {
    return { ok: false, transient: false, status, elapsedMs, error: "stremio_addon_streams_invalid" };
  }
  return {
    ok: true,
    transient: false,
    status,
    elapsedMs,
    streams: payload.streams.filter((stream) => stream && typeof stream === "object" && !Array.isArray(stream))
  };
}

async function fetchStreams(url, timeoutMs, retries) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await fetchStreamsOnce(url, timeoutMs);
    if (last.ok || !last.transient || attempt >= retries) return { ...last, networkAttempts: attempt + 1 };
    await sleep(Math.min(800, 200 * (attempt + 1)));
  }
  return { ...(last || {}), ok: false, error: last?.error || "stremio_addon_request_failed" };
}

export async function queryProviderStreams({
  manifestUrl,
  mediaType,
  mediaId,
  timeoutMs = 20000,
  retries = 1
} = {}) {
  const safeTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || 20000));
  const safeRetries = Math.max(0, Math.min(3, Number(retries) || 0));
  const variants = [{ rawColons: false, label: "encoded_id" }];
  if (String(mediaId || "").includes(":")) variants.push({ rawColons: true, label: "raw_colons_fallback" });

  const attempts = [];
  let successfulResponse = false;
  let firstError = null;
  for (const variant of variants) {
    const url = streamResourceUrl(manifestUrl, mediaType, mediaId, variant);
    const result = await fetchStreams(url, safeTimeout, safeRetries);
    attempts.push({
      variant: variant.label,
      ok: result.ok === true,
      status: result.status ?? null,
      elapsedMs: result.elapsedMs ?? null,
      networkAttempts: result.networkAttempts || 1,
      count: result.ok ? result.streams.length : 0,
      error: result.ok ? null : result.error || "stremio_addon_request_failed"
    });
    if (result.ok) {
      successfulResponse = true;
      if (result.streams.length) return { streams: result.streams, error: null, attempts };
    } else {
      firstError ||= result.error || "stremio_addon_request_failed";
    }
  }

  return {
    streams: [],
    error: successfulResponse ? null : (firstError || "stremio_addon_request_failed"),
    attempts
  };
}
