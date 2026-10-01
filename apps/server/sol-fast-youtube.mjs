function clean(value) {
  return String(value ?? "").trim();
}

export const YOUTUBE_TARGETS = Object.freeze({
  cocina: Object.freeze({
    target: "cocina",
    entityId: "media_player.tv_cocina_2",
    verifyEntityIds: Object.freeze(["media_player.tv_cocina_2", "media_player.tv_cocina"])
  }),
  dormitorio: Object.freeze({
    target: "dormitorio",
    entityId: "media_player.tv_dormitorio_2",
    verifyEntityIds: Object.freeze(["media_player.tv_dormitorio_2", "media_player.tv_dormitorio"])
  })
});

export function normalizeYoutubeUrl(value) {
  const raw = clean(value);
  if (!raw) throw new Error("youtube_url_required");

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
  const allowed = host === "youtu.be"
    || host === "youtube.com"
    || host === "m.youtube.com"
    || host === "music.youtube.com";
  if (!allowed) throw new Error("youtube_url_invalid_host");

  return parsed.toString();
}

export function resolveYoutubeTarget(args = {}) {
  const requested = clean(args.target || "cocina").toLowerCase();
  if (!["cocina", "dormitorio"].includes(requested)) {
    throw new Error("youtube_target_invalid");
  }

  const configured = YOUTUBE_TARGETS[requested];
  const explicitEntityId = clean(args.entityId);
  if (!explicitEntityId) return { ...configured, verifyEntityIds: [...configured.verifyEntityIds] };

  return {
    target: requested,
    entityId: explicitEntityId,
    verifyEntityIds: [
      explicitEntityId,
      ...configured.verifyEntityIds.filter((entityId) => entityId !== explicitEntityId)
    ]
  };
}

export function buildYoutubePlayPlan(args = {}) {
  const url = normalizeYoutubeUrl(args.url);
  const destination = resolveYoutubeTarget(args);
  return {
    url,
    expectedTitle: clean(args.expectedTitle),
    destination,
    tool: "home_assistant_call_service",
    toolArgs: {
      domain: "media_player",
      service: "play_media",
      target: { entity_id: destination.entityId },
      serviceData: {
        media: {
          media_content_id: url,
          media_content_type: "url"
        }
      },
      confirmedByUser: true
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
  const activeState = ["on", "playing", "paused", "idle"].includes(clean(state.state).toLowerCase());
  const youtubeApp = activeState && appText.includes("youtube");
  const exactTitle = Boolean(expectedTitle && title && titlesLikelyMatch(expectedTitle, title));

  if (exactTitle) {
    return {
      level: "expected_title",
      appActive: youtubeApp,
      title,
      entityId: state.entityId || null,
      lastUpdated: state.lastUpdated || null
    };
  }
  if (youtubeApp) {
    return {
      level: "youtube_app",
      appActive: true,
      title: title || null,
      entityId: state.entityId || null,
      lastUpdated: state.lastUpdated || null
    };
  }
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
