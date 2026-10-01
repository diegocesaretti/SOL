function clean(value) {
  return String(value ?? "").trim();
}

export function youtubeTargetsFromEnv(env = process.env) {
  return {
    cocina: {
      target: "cocina",
      entityId: clean(env.HA_SOL_YOUTUBE_COCINA_ENTITY_ID) || "media_player.tv_cocina_2"
    },
    dormitorio: {
      target: "dormitorio",
      entityId: clean(env.HA_SOL_YOUTUBE_DORMITORIO_ENTITY_ID) || "media_player.tv_dormitorio_2"
    }
  };
}

export function normalizeYoutubeUrl(value) {
  const raw = clean(value);
  if (!raw) throw new Error("youtube_url_required");

  if (/^[A-Za-z0-9_-]{6,20}$/.test(raw)) {
    return `https://www.youtube.com/watch?v=${raw}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("youtube_url_invalid");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("youtube_url_invalid_protocol");
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!["youtu.be", "youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    throw new Error("youtube_url_invalid_host");
  }

  return parsed.toString();
}

export function resolveYoutubeTarget(args = {}, targets = youtubeTargetsFromEnv()) {
  const requested = clean(args.target || "cocina").toLowerCase();
  const target = targets[requested];
  if (!target?.entityId) throw new Error("youtube_target_invalid");
  return { target: requested, entityId: target.entityId };
}

export function buildYoutubePlayPlan(args = {}, targets = youtubeTargetsFromEnv()) {
  const destination = resolveYoutubeTarget(args, targets);
  const url = normalizeYoutubeUrl(args.url);
  return {
    url,
    expectedTitle: clean(args.expectedTitle),
    destination,
    serviceData: {
      media: {
        media_content_id: url,
        media_content_type: "url"
      }
    }
  };
}

function normalizedWords(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

export function titlesLikelyMatch(expected, actual) {
  const wanted = normalizedWords(expected);
  const seen = normalizedWords(actual);
  if (!wanted.length || !seen.length) return false;

  const wantedSet = new Set(wanted);
  const seenSet = new Set(seen);
  let overlap = 0;
  for (const word of wantedSet) if (seenSet.has(word)) overlap += 1;
  const ratio = overlap / Math.min(wantedSet.size, seenSet.size);
  return overlap >= 2 && ratio >= 0.6;
}

export function youtubeStateEvidence(state, expectedTitle = "") {
  if (!state || typeof state !== "object") return null;
  const attributes = state.attributes && typeof state.attributes === "object" ? state.attributes : {};
  const appText = [attributes.app_id, attributes.app_name].map(clean).join(" ").toLowerCase();
  const title = clean(attributes.media_title);
  const active = ["on", "playing", "paused", "idle"].includes(clean(state.state).toLowerCase());

  const youtubeApp = active && appText.includes("youtube");
  if (youtubeApp && expectedTitle && title && titlesLikelyMatch(expectedTitle, title)) {
    return { level: "expected_title", appActive: true, title };
  }
  if (youtubeApp) return { level: "youtube_app", appActive: true, title: title || null };
  return null;
}

export function stateFingerprint(state) {
  if (!state || typeof state !== "object") return "";
  const attributes = state.attributes && typeof state.attributes === "object" ? state.attributes : {};
  return JSON.stringify({
    entityId: state.entityId || null,
    state: state.state || null,
    lastUpdated: state.lastUpdated || null,
    app_id: attributes.app_id || null,
    app_name: attributes.app_name || null,
    media_title: attributes.media_title || null,
    media_position_updated_at: attributes.media_position_updated_at || null
  });
}

export async function verifyYoutubePlayback({ readState, plan, beforeState, timeoutMs = 3000 }) {
  const startedAt = Date.now();
  const before = stateFingerprint(beforeState);
  const delays = [0, 120, 220, 350, 500, 700, 900, 1200];
  let attempts = 0;
  let lastState = beforeState;
  let bestEvidence = null;


  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (Date.now() - startedAt > timeoutMs) break;

    attempts += 1;
    lastState = await readState(plan.destination.entityId);
    const evidence = youtubeStateEvidence(lastState, plan.expectedTitle);
    if (!evidence) continue;

    const changed = stateFingerprint(lastState) !== before;
    if (evidence.level === "expected_title" || changed) {
      return {
        confirmed: true,
        level: evidence.level === "expected_title" ? "expected_title" : "youtube_state_changed",
        attempts,
        elapsedMs: Date.now() - startedAt,
        evidence,
        state: lastState
      };
    }
    bestEvidence = evidence;
  }

  return {
    confirmed: false,
    level: bestEvidence ? "youtube_app_active_unconfirmed" : "not_confirmed",
    attempts,
    elapsedMs: Date.now() - startedAt,
    evidence: bestEvidence,
    state: lastState
  };
}
