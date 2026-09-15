const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480, 360];
const BAD_SOURCE_RE = /\b(cam|hdcam|telesync|telecine|tsrip|screener|scr)\b/i;
const MULTI_AUDIO_RE = /\b(multi[ ._-]*audio|multiaudio|dual[ ._-]*audio|multi[ ._-]*lang(?:uage)?)\b/i;
const LATIN_LABEL_RE = /\b(lat|latam|latino|latina|latin[ -]?america|audio[ ._-]*latino|espa(?:n|ñ)ol[ ._-]*latino|spanish[ ._-]*latino)\b/i;
const SPANISH_RE = /\b(espa(?:n|ñ)ol|spanish|castellano|spa|esp)\b/i;
const ENGLISH_RE = /\b(english|eng)\b/i;
const FRENCH_RE = /\b(french|fran(?:c|ç)ais|fre|fra)\b/i;
const PORTUGUESE_RE = /\b(portuguese|portugu[eê]s|por|pt-br|pt)\b/i;

const FLAG_RULES = [
  { token: "🇲🇽", language: "spanish", spanishVariant: "latin", latinPriority: 3, latinSignal: "mexico_flag" },
  { token: "🇦🇷", language: "spanish", spanishVariant: "latin", latinPriority: 1, latinSignal: "latin_flag" },
  { token: "🇨🇴", language: "spanish", spanishVariant: "latin", latinPriority: 1, latinSignal: "latin_flag" },
  { token: "🇨🇱", language: "spanish", spanishVariant: "latin", latinPriority: 1, latinSignal: "latin_flag" },
  { token: "🇺🇾", language: "spanish", spanishVariant: "latin", latinPriority: 1, latinSignal: "latin_flag" },
  { token: "🇵🇪", language: "spanish", spanishVariant: "latin", latinPriority: 1, latinSignal: "latin_flag" },
  { token: "🇻🇪", language: "spanish", spanishVariant: "latin", latinPriority: 1, latinSignal: "latin_flag" },
  { token: "🇪🇸", language: "spanish" },
  { token: "🇬🇧", language: "english" },
  { token: "🇺🇸", language: "english" },
  { token: "🇫🇷", language: "french" },
  { token: "🇵🇹", language: "portuguese" },
  { token: "🇧🇷", language: "portuguese" }
];

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

function audioMetadata(text) {
  const signals = [];

  for (const rule of FLAG_RULES) {
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const index = text.indexOf(rule.token, fromIndex);
      if (index < 0) break;
      signals.push({ ...rule, index, source: "flag" });
      fromIndex = index + rule.token.length;
    }
  }

  for (const rule of TEXT_RULES) {
    const index = firstRegexIndex(text, rule.regex);
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
  const explicitMulti = MULTI_AUDIO_RE.test(text);
  const audioType = explicitMulti || audioLanguages.length > 1
    ? "multi"
    : audioLanguages.length === 1
      ? "single"
      : "unknown";

  // Keep the compact legacy tags stable for callers while audioLanguages is the
  // canonical structured representation used by native stream selection.
  const languages = [];
  if (spanishVariant === "latin") languages.push("latin");
  if (SPANISH_RE.test(text) || text.includes("🇪🇸")) languages.push("spanish");
  if (ENGLISH_RE.test(text) || text.includes("🇬🇧") || text.includes("🇺🇸")) languages.push("english");

  return {
    audioType,
    audioLanguages,
    spanishVariant,
    languages: [...new Set(languages)],
    latinPriority: Number(strongestLatin?.latinPriority || 0),
    latinSignal: strongestLatin?.latinSignal || null
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
    badSource: details.badSource === true
  };
}

export const __test = { streamText, parseResolution, audioMetadata };
