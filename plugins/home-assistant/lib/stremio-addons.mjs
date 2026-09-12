const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480, 360];
const BAD_SOURCE_RE = /\b(cam|hdcam|telesync|telecine|tsrip|screener|scr)\b/i;
const LATIN_RE = /\b(latino|latina|latam|latin[ -]?america|audio[ ._-]*latino|espanol[ ._-]*latino|spanish[ ._-]*latino)\b/i;
const SPANISH_RE = /\b(espanol|spanish|castellano|spa|esp)\b/i;
const ENGLISH_RE = /\b(english|eng)\b/i;

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeManifestUrl(value) {
  const text = clean(value);
  if (!text) throw new Error("stremio_addon_manifest_url_required");
  let url;
  try { url = new URL(text); } catch { throw new Error("stremio_addon_manifest_url_invalid"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("stremio_addon_manifest_url_invalid");
  url.hash = "";
  if (!url.pathname.endsWith("/manifest.json")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/manifest.json`;
  }
  return url.toString();
}

export function parseAddonManifestList(value) {
  const text = clean(value);
  if (!text) return [];
  let values;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("not_array");
      values = parsed;
    } catch {
      throw new Error("stremio_addon_manifests_invalid_json");
    }
  } else {
    values = text.split(/[;\n\r]+/g);
  }
  const result = [];
  const seen = new Set();
  for (const item of values) {
    if (!clean(item)) continue;
    const url = normalizeManifestUrl(item);
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}

function addonBaseUrl(manifestUrl) {
  return manifestUrl.slice(0, -"/manifest.json".length);
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`stremio_addon_http_${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("stremio_addon_invalid_json");
  return payload;
}

function declaredResources(manifest) {
  const resources = Array.isArray(manifest?.resources) ? manifest.resources : [];
  return resources.map((resource) => typeof resource === "string" ? { name: resource } : resource)
    .filter((resource) => resource && typeof resource === "object" && typeof resource.name === "string");
}

function prefixesFor(manifest, resource) {
  if (Array.isArray(resource.idPrefixes)) return resource.idPrefixes.map(String);
  if (Array.isArray(manifest?.idPrefixes)) return manifest.idPrefixes.map(String);
  return [];
}

function typesFor(manifest, resource) {
  if (Array.isArray(resource.types)) return resource.types.map(String);
  if (Array.isArray(manifest?.types)) return manifest.types.map(String);
  return [];
}

export function addonSupportsStream(manifest, mediaType, mediaId) {
  for (const resource of declaredResources(manifest)) {
    if (resource.name !== "stream") continue;
    const types = typesFor(manifest, resource);
    if (types.length && !types.includes(mediaType)) continue;
    const prefixes = prefixesFor(manifest, resource);
    if (prefixes.length && !prefixes.some((prefix) => String(mediaId).startsWith(prefix))) continue;
    return true;
  }
  return false;
}

function streamKey(stream) {
  if (typeof stream?.url === "string" && stream.url) return `url:${stream.url}`;
  if (typeof stream?.infoHash === "string" && stream.infoHash) return `torrent:${stream.infoHash.toLowerCase()}:${Number(stream.fileIdx ?? -1)}`;
  if (typeof stream?.externalUrl === "string" && stream.externalUrl) return `external:${stream.externalUrl}`;
  if (typeof stream?.ytId === "string" && stream.ytId) return `youtube:${stream.ytId}`;
  return `json:${JSON.stringify(stream)}`;
}

function streamText(stream) {
  const hints = stream?.behaviorHints && typeof stream.behaviorHints === "object" ? stream.behaviorHints : {};
  return [stream?.name, stream?.title, stream?.description, hints.filename].filter(Boolean).join("\n");
}

function parseResolution(text) {
  const lower = text.toLowerCase();
  if (/\b(4k|uhd|2160p?)\b/.test(lower)) return 2160;
  for (const resolution of RESOLUTIONS.slice(1)) {
    if (new RegExp(`\\b${resolution}p?\\b`, "i").test(lower)) return resolution;
  }
  return null;
}

function parseSizeGb(text) {
  const match = text.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*(tb|gb|mb)(?:\s|$)/i);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "tb") return value * 1024;
  if (unit === "mb") return value / 1024;
  return value;
}

function parseSeeders(text) {
  const patterns = [
    /(?:seeders?|seeds?)\s*[:=]?\s*(\d+)/i,
    /(?:^|\s)S\s*[:=]\s*(\d+)/i,
    /(?:👤|👥)\s*(\d+)/u
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseCodec(text) {
  if (/\b(av1)\b/i.test(text)) return "av1";
  if (/\b(hevc|h\.?265|x265)\b/i.test(text)) return "h265";
  if (/\b(avc|h\.?264|x264)\b/i.test(text)) return "h264";
  return null;
}

function languageTags(text) {
  const tags = [];
  if (LATIN_RE.test(text) || /🇦🇷|🇲🇽|🇨🇴|🇨🇱|🇺🇾|🇵🇪|🇻🇪/u.test(text)) tags.push("latin");
  if (SPANISH_RE.test(text)) tags.push("spanish");
  if (ENGLISH_RE.test(text)) tags.push("english");
  return [...new Set(tags)];
}

function locatorType(stream) {
  if (typeof stream?.url === "string" && stream.url) return "direct";
  if (typeof stream?.infoHash === "string" && stream.infoHash) return "torrent";
  if (typeof stream?.externalUrl === "string" && stream.externalUrl) return "external";
  if (typeof stream?.ytId === "string" && stream.ytId) return "youtube";
  return "unknown";
}

export function inspectStream(stream) {
  const text = streamText(stream);
  const lower = text.toLowerCase();
  return {
    text,
    quality: parseResolution(text),
    sizeGb: parseSizeGb(text),
    seeders: parseSeeders(text),
    codec: parseCodec(text),
    languages: languageTags(text),
    hdr: /\b(hdr10\+?|hdr)\b/i.test(text),
    dolbyVision: /\b(dolby[ ._-]*vision|dv)\b/i.test(text),
    cachedHint: /\b(cached|debrid|real[ -]?debrid|alldebrid|premiumize|rd\+|ad\+)\b/i.test(text) || /⚡/u.test(text),
    badSource: BAD_SOURCE_RE.test(lower),
    locator: locatorType(stream),
    notWebReady: stream?.behaviorHints?.notWebReady === true
  };
}

function requestedQuality(value) {
  const text = clean(value).toLowerCase();
  if (!text || text === "auto" || text === "any") return null;
  if (["4k", "2160p", "2160"].includes(text)) return 2160;
  const number = Number(text.replace(/p$/, ""));
  return RESOLUTIONS.includes(number) ? number : null;
}

function scoreStream(details, preferences = {}) {
  let score = 0;
  const reasons = [];
  const wantedQuality = requestedQuality(preferences.quality);
  const wantedLanguage = clean(preferences.language || "any").toLowerCase();
  const wantedCodec = clean(preferences.codec || "any").toLowerCase();
  const maxSizeGb = Number(preferences.maxSizeGb || 0);

  if (details.badSource) {
    score -= 5000;
    reasons.push("source_low_quality");
  }

  if (wantedQuality) {
    if (details.quality === wantedQuality) {
      score += 1200;
      reasons.push("quality_exact");
    } else if (details.quality) {
      const distance = Math.abs(RESOLUTIONS.indexOf(details.quality) - RESOLUTIONS.indexOf(wantedQuality));
      score += Math.max(-400, 400 - distance * 260);
      reasons.push("quality_near");
    } else {
      score -= 250;
    }
  } else if (details.quality) {
    const autoQualityScore = { 2160: 360, 1440: 320, 1080: 300, 720: 220, 576: 130, 480: 100, 360: 40 };
    score += autoQualityScore[details.quality] || 0;
  }

  if (wantedLanguage !== "any") {
    if (details.languages.includes(wantedLanguage)) {
      score += 700;
      reasons.push("language_match");
    } else if (wantedLanguage === "spanish" && details.languages.includes("latin")) {
      score += 500;
      reasons.push("language_compatible");
    } else {
      score -= 550;
    }
  }

  if (wantedCodec !== "any") {
    if (details.codec === wantedCodec) {
      score += 240;
      reasons.push("codec_match");
    } else if (details.codec) score -= 180;
  }

  if (Number.isFinite(maxSizeGb) && maxSizeGb > 0 && details.sizeGb !== null) {
    if (details.sizeGb <= maxSizeGb) {
      score += 120;
      reasons.push("size_ok");
    } else {
      score -= 2200 + Math.min(1000, (details.sizeGb - maxSizeGb) * 30);
      reasons.push("size_over_limit");
    }
  }

  if (details.seeders !== null) {
    score += Math.min(300, Math.log2(details.seeders + 1) * 42);
    if (details.seeders >= 20) reasons.push("healthy_seeders");
  }
  if (details.cachedHint) {
    score += 260;
    reasons.push("cached_hint");
  }
  if (details.locator === "direct") score += 80;
  else if (details.locator === "torrent") score += 35;
  else if (details.locator === "external") score -= 80;
  else if (details.locator === "unknown") score -= 500;
  if (details.hdr) score += preferences.preferHdr ? 90 : 0;
  if (details.dolbyVision) score += preferences.preferDolbyVision ? 100 : 0;

  return { score, reasons };
}

export function summarizeRankedStream(entry, index = null) {
  const details = entry.details || inspectStream(entry.stream);
  return {
    rank: index === null ? null : index + 1,
    addonName: entry.addon?.name || null,
    addonId: entry.addon?.id || null,
    providerIndex: entry.providerIndex,
    name: entry.stream?.name || null,
    title: entry.stream?.title || null,
    quality: details.quality ? `${details.quality}p` : null,
    resolution: details.quality,
    languages: details.languages,
    codec: details.codec,
    sizeGb: details.sizeGb === null ? null : Number(details.sizeGb.toFixed(2)),
    seeders: details.seeders,
    hdr: details.hdr,
    dolbyVision: details.dolbyVision,
    cachedHint: details.cachedHint,
    locator: details.locator,
    score: Math.round(entry.score || 0),
    reasons: entry.reasons || []
  };
}

export class StremioAddonAggregator {
  constructor({ manifestUrls = [], timeoutMs = 8000, refreshMs = 300000 } = {}) {
    this.manifestUrls = [...manifestUrls];
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 8000));
    this.refreshMs = Math.max(30000, Number(refreshMs) || 300000);
    this.loadedAt = 0;
    this.addons = [];
    this.errors = [];
  }

  get configured() { return this.manifestUrls.length > 0; }

  async refresh({ force = false } = {}) {
    if (!this.configured) {
      this.addons = [];
      this.errors = [];
      return [];
    }
    if (!force && this.addons.length && Date.now() - this.loadedAt < this.refreshMs) return this.addons;
    const results = await Promise.allSettled(this.manifestUrls.map(async (manifestUrl) => {
      const manifest = await fetchJson(manifestUrl, this.timeoutMs);
      if (!manifest.id || !manifest.name || !manifest.version || !Array.isArray(manifest.resources)) {
        throw new Error("stremio_addon_manifest_invalid");
      }
      return {
        id: String(manifest.id),
        name: String(manifest.name),
        version: String(manifest.version),
        manifestUrl,
        baseUrl: addonBaseUrl(manifestUrl),
        manifest
      };
    }));
    const addons = [];
    const errors = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") addons.push(result.value);
      else errors.push({ index, error: result.reason?.message || String(result.reason) });
    });
    this.addons = addons;
    this.errors = errors;
    this.loadedAt = Date.now();
    return addons;
  }

  async status({ refresh = false } = {}) {
    await this.refresh({ force: refresh });
    return {
      configured: this.configured,
      configuredCount: this.manifestUrls.length,
      loadedCount: this.addons.length,
      addons: this.addons.map((addon) => ({
        id: addon.id,
        name: addon.name,
        version: addon.version,
        streamTypes: declaredResources(addon.manifest)
          .filter((resource) => resource.name === "stream")
          .flatMap((resource) => typesFor(addon.manifest, resource))
      })),
      errors: this.errors
    };
  }

  async getStreams(mediaType, mediaId, { provider = null } = {}) {
    await this.refresh();
    const providerKey = clean(provider).toLowerCase();
    const compatible = this.addons.filter((addon) =>
      addonSupportsStream(addon.manifest, mediaType, mediaId)
      && (!providerKey || addon.name.toLowerCase().includes(providerKey) || addon.id.toLowerCase().includes(providerKey))
    );
    const results = await Promise.allSettled(compatible.map(async (addon) => {
      const type = encodeURIComponent(mediaType);
      const id = encodeURIComponent(mediaId).replace(/%3A/gi, ":");
      const payload = await fetchJson(`${addon.baseUrl}/stream/${type}/${id}.json`, this.timeoutMs);
      if (!Array.isArray(payload.streams)) throw new Error("stremio_addon_streams_invalid");
      return payload.streams.filter((stream) => stream && typeof stream === "object" && !Array.isArray(stream));
    }));

    const merged = [];
    const errors = [];
    const seen = new Set();
    results.forEach((result, addonIndex) => {
      const addon = compatible[addonIndex];
      if (result.status === "rejected") {
        errors.push({ addonName: addon.name, error: result.reason?.message || String(result.reason) });
        return;
      }
      result.value.forEach((stream, providerIndex) => {
        const key = streamKey(stream);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({ addon, stream, providerIndex });
      });
    });
    return { streams: merged, errors, providers: compatible.map((addon) => ({ id: addon.id, name: addon.name })) };
  }

  async rankStreams(mediaType, mediaId, preferences = {}) {
    const result = await this.getStreams(mediaType, mediaId, { provider: preferences.provider });
    const ranked = result.streams.map((entry) => {
      const details = inspectStream(entry.stream);
      const scored = scoreStream(details, preferences);
      return { ...entry, details, ...scored };
    }).sort((a, b) => b.score - a.score || (b.details.seeders || 0) - (a.details.seeders || 0));
    return { ranked, errors: result.errors, providers: result.providers };
  }

  async selectStream(mediaType, mediaId, preferences = {}) {
    const result = await this.rankStreams(mediaType, mediaId, preferences);
    return {
      selected: result.ranked[0] || null,
      ranked: result.ranked,
      errors: result.errors,
      providers: result.providers
    };
  }
}
