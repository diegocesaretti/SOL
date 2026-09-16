const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480, 360];
const BAD_SOURCE_RE = /\b(cam|hdcam|telesync|telecine|tsrip|screener|scr)\b/i;
const MULTI_AUDIO_RE = /\b(multi[ ._-]*audio|multiaudio|dual[ ._-]*audio|multi[ ._-]*lang(?:uage)?)\b/i;
const LATIN_LABEL_RE = /\b(lat|latam|latino|latina|latin[ -]?america|audio[ ._-]*latino|espa(?:n|ñ)ol[ ._-]*latino|spanish[ ._-]*latino)\b/i;
const SPANISH_RE = /\b(espa(?:n|ñ)ol|spanish|castellano|spa|esp)\b/i;
const ENGLISH_RE = /\b(english|eng)\b/i;
const FRENCH_RE = /\b(french|fran(?:c|ç)ais|fre|fra)\b/i;
const PORTUGUESE_RE = /\b(portuguese|portugu[eê]s|por|pt-br|pt)\b/i;
const FLAG_SEQUENCE_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const UNICODE_ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;

const LATIN_SPANISH_COUNTRIES = new Set([
  "AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "GT", "HN", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"
]);

const COUNTRY_RULES = new Map([
  ["MX", { language: "spanish", spanishVariant: "latin", latinPriority: 3, latinSignal: "mexico_flag" }],
  ["ES", { language: "spanish" }],
  ["GQ", { language: "spanish" }],
  ["GB", { language: "english" }],
  ["US", { language: "english" }],
  ["FR", { language: "french" }],
  ["PT", { language: "portuguese" }],
  ["BR", { language: "portuguese" }]
]);

for (const countryCode of LATIN_SPANISH_COUNTRIES) {
  COUNTRY_RULES.set(countryCode, {
    language: "spanish",
    spanishVariant: "latin",
    latinPriority: 1,
    latinSignal: "latin_flag"
  });
}

const TEXT_RULES = [
  { regex: LATIN_LABEL_RE, language: "spanish", spanishVariant: "latin", latinPriority: 2, latinSignal: "latin_label" },
  { regex: SPANISH_RE, language: "spanish" },
  { regex: ENGLISH_RE, language: "english" },
  { regex: FRENCH_RE, language: "french" },
  { regex: PORTUGUESE_RE, language: "portuguese" }
];

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

function firstRegexIndex(text, regex) {
  const match = new RegExp(regex.source, regex.flags.replace("g", "")).exec(text);
  return match ? match.index : -1;
}

function decodeUnicodeEscapes(value) {
  const text = String(value ?? "");
  if (!text.includes("\\u")) return text;
  return text.replace(UNICODE_ESCAPE_RE, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function flagToCountryCode(flag) {
  const points = [...String(flag ?? "")];
  if (points.length !== 2) return null;
  const letters = points.map((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x1F1E6 || codePoint > 0x1F1FF) return null;
    return String.fromCharCode(65 + (codePoint - 0x1F1E6));
  });
  return letters.every(Boolean) ? letters.join("") : null;
}

function extractFlagSignals(text) {
  const signals = [];
  const detectedFlags = [];
  const detectedCountryCodes = [];

  for (const match of text.matchAll(FLAG_SEQUENCE_RE)) {
    const token = match[0];
    const countryCode = flagToCountryCode(token);
    if (!countryCode) continue;
    detectedFlags.push(token);
    detectedCountryCodes.push(countryCode);
    const rule = COUNTRY_RULES.get(countryCode);
    if (rule) signals.push({ ...rule, token, countryCode, index: match.index ?? 0, source: "flag" });
  }

  return { signals, detectedFlags, detectedCountryCodes };
}

function audioMetadata(text) {
  const scanText = decodeUnicodeEscapes(text);
  const { signals: flagSignals, detectedFlags, detectedCountryCodes } = extractFlagSignals(scanText);
  const signals = [...flagSignals];

  for (const rule of TEXT_RULES) {
    const index = firstRegexIndex(scanText, rule.regex);
    if (index >= 0) signals.push({ ...rule, index, source: "label" });
  }

  signals.sort((a, b) => a.index - b.index);

  const audioLanguages = [];
  for (const signal of signals) {
    if (signal.language && !audioLanguages.includes(signal.language)) audioLanguages.push(signal.language);
  }

  const latinSignals = signals
    .filter((signal) => Number(signal.latinPriority || 0) > 0)
    .sort((a, b) => Number(b.latinPriority || 0) - Number(a.latinPriority || 0) || a.index - b.index);
  const strongestLatin = latinSignals[0] || null;
  const spanishVariant = signals.some((signal) => signal.spanishVariant === "latin") ? "latin" : null;
  const explicitMulti = MULTI_AUDIO_RE.test(scanText);
  const audioType = explicitMulti || audioLanguages.length > 1
    ? "multi"
    : audioLanguages.length === 1
      ? "single"
      : "unknown";

  const languages = [];
  if (spanishVariant === "latin") languages.push("latin");
  for (const language of audioLanguages) {
    if (!languages.includes(language)) languages.push(language);
  }

  return {
    audioType,
    audioLanguages,
    spanishVariant,
    languages,
    latinPriority: Number(strongestLatin?.latinPriority || 0),
    latinSignal: strongestLatin?.latinSignal || null,
    detectedFlags,
    detectedCountryCodes
  };
}

export function inspectStream(stream) {
  const text = streamText(stream);
  const audio = audioMetadata(text);
  return {
    text,
    quality: parseResolution(text),
    audioType: audio.audioType,
    audioLanguages: audio.audioLanguages,
    spanishVariant: audio.spanishVariant,
    languages: audio.languages,
    latinPriority: audio.latinPriority,
    latinSignal: audio.latinSignal,
    detectedFlags: audio.detectedFlags,
    detectedCountryCodes: audio.detectedCountryCodes,
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
    audioType: details.audioType || "unknown",
    audioLanguages: Array.isArray(details.audioLanguages) ? details.audioLanguages : [],
    spanishVariant: details.spanishVariant || null,
    languages: details.languages,
    latinPriority: Number(details.latinPriority || 0),
    latinSignal: details.latinSignal || null,
    detectedFlags: Array.isArray(details.detectedFlags) ? details.detectedFlags : [],
    detectedCountryCodes: Array.isArray(details.detectedCountryCodes) ? details.detectedCountryCodes : [],
    badSource: details.badSource === true
  };
}

export const __test = { streamText, parseResolution, audioMetadata, decodeUnicodeEscapes, flagToCountryCode, extractFlagSignals };
