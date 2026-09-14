const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480, 360];
const BAD_SOURCE_RE = /\b(cam|hdcam|telesync|telecine|tsrip|screener|scr)\b/i;
const LATIN_RE = /\b(latino|latina|latam|latin[ -]?america|audio[ ._-]*latino|espanol[ ._-]*latino|spanish[ ._-]*latino)\b/i;
const SPANISH_RE = /\b(espanol|spanish|castellano|spa|esp)\b/i;
const ENGLISH_RE = /\b(english|eng)\b/i;

function clean(value) {
  return String(value ?? "").trim();
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

function languageTags(text) {
  const tags = [];
  if (LATIN_RE.test(text) || /🇦🇷|🇲🇽|🇨🇴|🇨🇱|🇺🇾|🇵🇪|🇻🇪/u.test(text)) tags.push("latin");
  if (SPANISH_RE.test(text)) tags.push("spanish");
  if (ENGLISH_RE.test(text)) tags.push("english");
  return [...new Set(tags)];
}

export function inspectStream(stream) {
  const text = streamText(stream);
  return {
    text,
    quality: parseResolution(text),
    languages: languageTags(text),
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
    badSource: details.badSource === true
  };
}

export const __test = { clean, streamText, parseResolution, languageTags };
