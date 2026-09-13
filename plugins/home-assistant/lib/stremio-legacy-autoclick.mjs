const RESUME_STATUSES = new Set([
  "resume_in_progress",
  "resume_current_without_bitfield"
]);

function clean(value) {
  return String(value ?? "").trim();
}

function candidateIds(args = {}, result = {}) {
  const resolved = result?.resolved || {};
  const selected = resolved?.selected || {};
  const values = [
    args.id,
    resolved.id,
    resolved.videoId,
    selected.id,
    selected.imdb_id,
    selected.imdbId
  ].map(clean).filter(Boolean);
  return new Set(values);
}

function shouldSkipForResume(client, args = {}, result = {}) {
  const decisionStatus = clean(result?.smartPlayback?.episodeDecision?.status);
  if (RESUME_STATUSES.has(decisionStatus)) {
    return { skip: true, reason: `stremio_${decisionStatus}` };
  }

  const runtime = client?.__stremioSmartRuntime;
  const library = runtime?.account?.library;
  if (!Array.isArray(library) || !library.length) return { skip: false, reason: null };

  const ids = candidateIds(args, result);
  if (!ids.size) return { skip: false, reason: null };

  const resolvedVideoId = clean(result?.resolved?.videoId || result?.resolved?.selected?.videoId);
  const match = library.find((item) => {
    if (!item || item.finished || Number(item.positionSeconds || 0) <= 0) return false;
    if (!ids.has(clean(item.mediaId)) && !ids.has(clean(item.playbackId))) return false;
    if (item.type === "series" && resolvedVideoId && clean(item.playbackId) !== resolvedVideoId) return false;
    return true;
  });

  return match
    ? { skip: true, reason: "stremio_account_resume_in_progress" }
    : { skip: false, reason: null };
}

export function installStremioLegacyAutoclick(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioLegacyAutoclickInstalled) return SolPluginClient;
  proto.__stremioLegacyAutoclickInstalled = true;

  const originalHandle = proto.handleStremioTool;
  proto.handleStremioTool = async function handleStremioToolWithLegacyAutoclick(tool, args = {}) {
    const result = await originalHandle.call(this, tool, args);

    if (tool !== "home_assistant_stremio_play") return result;
    if (args?.autoPlay === false) return result;
    if (result?.firstStreamClick) return result;
    if (result?.smartPlayback?.effectiveProfile === "family") return result;

    const resume = shouldSkipForResume(this, args, result);
    if (resume.skip) {
      return {
        ...result,
        firstStreamClick: {
          ok: true,
          skipped: true,
          commandSent: false,
          reason: resume.reason
        },
        deliveryMode: result?.deliveryMode || "stremio_native_resume"
      };
    }

    const firstStreamClick = await this.clickFirstStream();
    return {
      ...result,
      firstStreamClick,
      deliveryMode: firstStreamClick?.ok
        ? (firstStreamClick?.skipped ? "stremio_autoplay_started" : "first_stream_center_click")
        : (result?.deliveryMode || "stremio_native_stream_list_unconfirmed")
    };
  };

  return SolPluginClient;
}

export const __test = { candidateIds, shouldSkipForResume };
