import { addonSupportsStream } from "./stremio-addons.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function declaredResources(manifest) {
  const resources = Array.isArray(manifest?.resources) ? manifest.resources : [];
  return resources.map((resource) => typeof resource === "string" ? { name: resource } : resource)
    .filter((resource) => resource && typeof resource === "object" && typeof resource.name === "string");
}

function declaresStream(manifest) {
  return declaredResources(manifest).some((resource) => resource.name === "stream");
}

function streamKey(stream) {
  if (typeof stream?.url === "string" && stream.url) return `url:${stream.url}`;
  if (typeof stream?.infoHash === "string" && stream.infoHash) return `torrent:${stream.infoHash.toLowerCase()}:${Number(stream.fileIdx ?? -1)}`;
  if (typeof stream?.externalUrl === "string" && stream.externalUrl) return `external:${stream.externalUrl}`;
  if (typeof stream?.ytId === "string" && stream.ytId) return `youtube:${stream.ytId}`;
  return `json:${JSON.stringify(stream)}`;
}

function resourceUrl(manifestUrl, mediaType, mediaId, { rawColons = false } = {}) {
  const url = new URL(manifestUrl);
  const marker = "/manifest.json";
  if (!url.pathname.endsWith(marker)) throw new Error("stremio_addon_manifest_path_invalid");
  const basePath = url.pathname.slice(0, -marker.length);
  const type = encodeURIComponent(String(mediaType));
  let id = encodeURIComponent(String(mediaId));
  if (rawColons) id = id.replace(/%3A/gi, ":");
  url.pathname = `${basePath}/stream/${type}/${id}.json`;
  url.hash = "";
  return url.toString();
}

async function fetchStreams(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`stremio_addon_http_${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("stremio_addon_invalid_json");
  if (!Array.isArray(payload.streams)) throw new Error("stremio_addon_streams_invalid");
  return payload.streams.filter((stream) => stream && typeof stream === "object" && !Array.isArray(stream));
}

async function requestProvider(addon, mediaType, mediaId, timeoutMs) {
  const manifestCompatible = addonSupportsStream(addon.manifest, mediaType, mediaId);
  const attempts = [];
  const variants = [{ rawColons: false, label: "encoded_id" }];
  if (String(mediaId).includes(":")) variants.push({ rawColons: true, label: "raw_colons_fallback" });

  let firstError = null;
  for (const variant of variants) {
    const url = resourceUrl(addon.manifestUrl, mediaType, mediaId, variant);
    try {
      const streams = await fetchStreams(url, timeoutMs);
      attempts.push({ variant: variant.label, ok: true, count: streams.length });
      if (streams.length > 0) {
        return { streams, manifestCompatible, attempts, error: null };
      }
    } catch (error) {
      const message = error?.message || String(error);
      attempts.push({ variant: variant.label, ok: false, error: message });
      firstError ||= message;
    }
  }

  return {
    streams: [],
    manifestCompatible,
    attempts,
    error: firstError
  };
}

export function installStremioAddonCompatibilityPatch(aggregator) {
  if (!aggregator || aggregator.__solCompatPatched) return aggregator;
  aggregator.__solCompatPatched = true;

  aggregator.getStreams = async function getStreamsCompat(mediaType, mediaId, { provider = null } = {}) {
    await this.refresh();
    const providerKey = clean(provider).toLowerCase();
    const candidates = this.addons.filter((addon) =>
      declaresStream(addon.manifest)
      && (!providerKey || addon.name.toLowerCase().includes(providerKey) || addon.id.toLowerCase().includes(providerKey))
    );

    const results = await Promise.allSettled(candidates.map((addon) => requestProvider(
      addon,
      mediaType,
      mediaId,
      this.timeoutMs
    )));

    const merged = [];
    const errors = [];
    const providers = [];
    const seen = new Set();

    results.forEach((result, addonIndex) => {
      const addon = candidates[addonIndex];
      if (result.status === "rejected") {
        const message = result.reason?.message || String(result.reason);
        errors.push({ addonName: addon.name, error: message });
        providers.push({ id: addon.id, name: addon.name, manifestCompatible: null, streamCount: 0, attempts: [] });
        return;
      }

      const diagnostic = result.value;
      providers.push({
        id: addon.id,
        name: addon.name,
        manifestCompatible: diagnostic.manifestCompatible,
        streamCount: diagnostic.streams.length,
        attempts: diagnostic.attempts
      });

      if (!diagnostic.streams.length) {
        errors.push({
          addonName: addon.name,
          error: diagnostic.error || "stremio_addon_zero_streams",
          manifestCompatible: diagnostic.manifestCompatible,
          attempts: diagnostic.attempts
        });
      }

      diagnostic.streams.forEach((stream, providerIndex) => {
        const key = streamKey(stream);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({ addon, stream, providerIndex });
      });
    });

    return { streams: merged, errors, providers };
  };

  return aggregator;
}

export const __test = { resourceUrl, requestProvider, declaresStream };
