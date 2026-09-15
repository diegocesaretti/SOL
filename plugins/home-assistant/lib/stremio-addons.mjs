const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480, 360];
const BAD_SOURCE_RE = /\b(cam|hdcam|telesync|telecine|tsrip|screener|scr)\b/i;
const LATIN_LABEL_RE = /\b(lat|latam|latino|latina|latin[ -]?america|audio[ ._-]*latino|espa(?:n|ñ)ol[ ._-]*latino|spanish[ ._-]*latino)\b/i;
const LATIN_FLAG_RE = /🇦🇷|🇲🇽|🇨🇴|🇨🇱|🇺🇾|🇵🇪|🇻🇪/u;
const MEXICO_FLAG_RE = /🇲🇽/u;
const SPANISH_RE = /\b(espa(?:n|ñ)ol|spanish|castellano|spa|esp)\b/i;
const ENGLISH_RE = /\b(english|eng)\b/i;

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

function languageTags(text) {
  const tags = [];
  if (LATIN_LABEL_RE.test(text) || LATIN_FLAG_RE.test(text)) tags.push("latin");
  if (SPANISH_RE.test(text)) tags.push("spanish");
  if (ENGLISH_RE.test(text)) tags.push("english");
  return [...new Set(tags)];
}

function latinPreference(text) {
  if (MEXICO_FLAG_RE.test(text)) return { priority: 2, signal: "mexico_flag" };
  if (LATIN_LABEL_RE.test(text)) return { priority: 1, signal: "latin_label" };
  return { priority: 0, signal: null };
}

export function inspectStream(stream) {
  const text = streamText(stream);
  const latin = latinPreference(text);
  return {
    text,
    quality: parseResolution(text),
    languages: languageTags(text),
    latinPriority: latin.priority,
    latinSignal: latin.signal,
    badSource: BAD_SOURCE_RE.test(text)
  };
}

export function summarizeRankedStream(entry, index = null) {
  const details = entry?.details || inspectStream(entry?.stream || {});
  return {
    rank: index === null ? null : index + 1,
    addonName: entry?.addon?.name || null,
    addonId: entry?.addon?.id || null,
    providerIndex: Number.isInteger(Number(entry?.providerIndex)) ? Number(entry.providerIndex) : null,
    name: entry?.stream?.name || null,
    title: entry?.stream?.title || null,
    quality: details.quality ? `${details.quality}p` : null,
    resolution: details.quality,
    languages: details.languages,
    latinPriority: Number(details.latinPriority || 0),
    latinSignal: details.latinSignal || null,
    badSource: details.badSource === true
  };
}

export const __test = { streamText, parseResolution, languageTags, latinPreference };
