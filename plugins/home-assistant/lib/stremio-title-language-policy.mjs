import { AsyncLocalStorage } from "node:async_hooks";

const INSTALL_MARK = Symbol.for("sol.home_assistant.stremio_manual_latin_defaults");

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeConfiguredTitle(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseConfiguredTitles(value) {
  const raw = clean(value);
  if (!raw) return [];

  let items = null;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // Fall back to the human-friendly separator format below.
    }
  }

  if (!items) items = raw.split(/\r?\n|[;|]+/g);
  return [...new Set(items.map(normalizeConfiguredTitle).filter(Boolean))];
}

function specificLanguage(value) {
  const language = clean(value).toLowerCase();
  return ["latin", "spanish", "english"].includes(language) ? language : null;
}

function firstConfiguredMatch(configured, candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeConfiguredTitle(candidate);
    if (normalized && configured.has(normalized)) return normalized;
  }
  return null;
}

export function installManualLatinTitlePolicy(SolPluginClientClass, env = process.env) {
  const prototype = SolPluginClientClass?.prototype;
  if (!prototype || prototype[INSTALL_MARK]) return { installed: false, reason: "already_installed_or_invalid_class" };

  const normalizedTitles = parseConfiguredTitles(env?.HA_SOL_STREMIO_LATIN_DEFAULT_TITLES);
  const configured = new Set(normalizedTitles);
  const context = new AsyncLocalStorage();
  const originalPlayBest = prototype.playBest;
  const originalResolveForStream = prototype.resolveForStream;
  const originalStreamPreferences = prototype.streamPreferences;
  const originalStatus = prototype.stremioStatus;

  if (typeof originalPlayBest !== "function" || typeof originalResolveForStream !== "function" || typeof originalStreamPreferences !== "function") {
    return { installed: false, reason: "required_methods_missing" };
  }

  Object.defineProperty(prototype, INSTALL_MARK, { value: true, configurable: false, enumerable: false });

  prototype.playBest = function playBestWithManualLatinDefaults(args = {}) {
    const state = { query: clean(args.query), resolvedTitle: null };
    return context.run(state, () => originalPlayBest.call(this, args));
  };

  prototype.resolveForStream = async function resolveForStreamWithManualLatinDefaults(args = {}) {
    const result = await originalResolveForStream.call(this, args);
    const state = context.getStore();
    if (state) {
      state.query = clean(args.query || state.query);
      state.resolvedTitle = clean(result?.resolved?.selected?.name);
    }
    return result;
  };

  prototype.streamPreferences = function streamPreferencesWithManualLatinDefaults(args = {}) {
    const base = originalStreamPreferences.call(this, args);
    const explicitLanguage = specificLanguage(args.language);
    if (explicitLanguage || configured.size === 0) {
      return explicitLanguage
        ? { ...base, languageSource: "explicit" }
        : base;
    }

    const state = context.getStore();
    const matchedTitle = firstConfiguredMatch(configured, [state?.resolvedTitle, state?.query, args.query]);
    if (!matchedTitle) return base;

    return {
      ...base,
      language: "latin",
      languageSource: "manual_title_default",
      matchedManualLatinTitle: matchedTitle
    };
  };

  if (typeof originalStatus === "function") {
    prototype.stremioStatus = function stremioStatusWithManualLatinDefaults() {
      return {
        ...originalStatus.call(this),
        manualLatinDefaults: {
          count: configured.size,
          matching: "normalized_exact_title",
          language: "latin"
        }
      };
    };
  }

  return { installed: true, configuredTitles: normalizedTitles };
}
