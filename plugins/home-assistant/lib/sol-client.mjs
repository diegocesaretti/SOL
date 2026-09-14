import {
  STREMIO_MCP_TOOLS,
  SolPluginClient as CoreSolPluginClient
} from "./sol-client-core.mjs";
import { detailDeepLink } from "./stremio.mjs";
import { summarizeRankedStream } from "./stremio-addons.mjs";
import { installStremioAddonCompatibilityPatch } from "./stremio-addon-compat.mjs";

export { STREMIO_MCP_TOOLS };

function boolEnv(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function focusNudgeMode(env) {
  const value = String(env.HA_SOL_STREMIO_FOCUS_NUDGE || "right_left").trim().toLowerCase();
  return ["off", "right_left"].includes(value) ? value : "right_left";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSelection(selection) {
  return {
    selected: selection?.selected ? summarizeRankedStream(selection.selected, 0) : null,
    providerCount: Array.isArray(selection?.providers) ? selection.providers.length : 0,
    streamCount: Array.isArray(selection?.ranked) ? selection.ranked.length : 0,
    providers: Array.isArray(selection?.providers) ? selection.providers : [],
    errors: Array.isArray(selection?.errors) ? selection.errors : []
  };
}

export class SolPluginClient extends CoreSolPluginClient {
  constructor(env = process.env) {
    super(env);
    this.stremioAddonTimeoutMs = numberEnv(env, "HA_SOL_STREMIO_ADDON_TIMEOUT_MS", 20000, 1000, 120000);
    this.stremioAddonRetries = numberEnv(env, "HA_SOL_STREMIO_ADDON_RETRIES", 1, 0, 3);
    this.addonAggregator.timeoutMs = this.stremioAddonTimeoutMs;
    installStremioAddonCompatibilityPatch(this.addonAggregator, { retries: this.stremioAddonRetries });

    this.stremioAutoPlayFirstStream = boolEnv(env, "HA_SOL_STREMIO_AUTOPLAY_FIRST_STREAM", true);
    this.stremioFirstStreamDelayMs = numberEnv(env, "HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS", 3500, 0, 60000);
    this.stremioFocusNudge = focusNudgeMode(env);
    this.stremioFocusNudgeDelayMs = numberEnv(env, "HA_SOL_STREMIO_FOCUS_NUDGE_DELAY_MS", 250, 0, 5000);
  }

  stremioStatus() {
    return {
      ...super.stremioStatus(),
      addonCompatibility: {
        protocolMode: "stream_bridge_compatible",
        requestTimeoutMs: this.stremioAddonTimeoutMs,
        retryCount: this.stremioAddonRetries,
        tolerantManifestFiltering: true,
        encodedEpisodeIds: true,
        rawColonFallback: true,
        preservesConfiguredManifestPath: true,
        preservesManifestQuery: true,
        directLookupGatesNativePlayback: false
      },
      firstStreamAutoPlay: {
        enabled: this.stremioAutoPlayFirstStream,
        configured: Boolean(this.stremioRemoteEntityId),
        delayMs: this.stremioFirstStreamDelayMs,
        transport: "Home Assistant remote.send_command",
        focusNudge: this.stremioFocusNudge,
        focusNudgeDelayMs: this.stremioFocusNudgeDelayMs,
        readiness: "fixed configurable delay; no Satellite or Accessibility dependency"
      },
      playbackVerification: {
        status: "transport_only",
        configured: false,
        screenshotRequired: false,
        note: "HA-only mode verifies command delivery, not the rendered video surface."
      }
    };
  }

  async waitForStreamUi() {
    if (this.stremioFirstStreamDelayMs > 0) await sleep(this.stremioFirstStreamDelayMs);
    return {
      ready: true,
      via: "fixed_delay",
      waitedMs: this.stremioFirstStreamDelayMs
    };
  }

  async verifyPlayback() {
    return {
      status: "unverified",
      confirmed: null,
      via: "home_assistant_transport_only",
      screenshotRequired: false,
      reason: "visual_observation_not_configured"
    };
  }

  async clickFirstStream() {
    if (!this.stremioAutoPlayFirstStream) {
      return { ok: false, commandSent: false, reason: "stremio_first_stream_autoplay_disabled" };
    }
    if (!this.stremioRemoteEntityId) {
      return { ok: false, commandSent: false, reason: "stremio_remote_entity_id_required" };
    }

    const readiness = await this.waitForStreamUi();
    const commands = [];
    try {
      if (this.stremioFocusNudge === "right_left") {
        await this.haService("remote", "send_command", {
          entity_id: this.stremioRemoteEntityId,
          command: ["DPAD_RIGHT"]
        });
        commands.push("DPAD_RIGHT");
        if (this.stremioFocusNudgeDelayMs > 0) await sleep(this.stremioFocusNudgeDelayMs);

        await this.haService("remote", "send_command", {
          entity_id: this.stremioRemoteEntityId,
          command: ["DPAD_LEFT"]
        });
        commands.push("DPAD_LEFT");
        if (this.stremioFocusNudgeDelayMs > 0) await sleep(this.stremioFocusNudgeDelayMs);
      }

      const result = await this.haService("remote", "send_command", {
        entity_id: this.stremioRemoteEntityId,
        command: ["DPAD_CENTER"]
      });
      commands.push("DPAD_CENTER");
      return {
        ok: true,
        commandSent: true,
        via: "home_assistant_remote",
        service: "remote.send_command",
        remoteEntityId: this.stremioRemoteEntityId,
        command: "DPAD_CENTER",
        commands,
        readiness,
        playbackVerification: await this.verifyPlayback(),
        result
      };
    } catch (error) {
      return {
        ok: false,
        commandSent: commands.includes("DPAD_CENTER"),
        commands,
        reason: error?.message || String(error),
        readiness
      };
    }
  }

  async handleStremioTool(tool, args = {}) {
    const effectiveTool = tool === "home_assistant_stremio_play"
      ? "home_assistant_stremio_play_best"
      : tool;
    if (effectiveTool !== "home_assistant_stremio_play_best") {
      return super.handleStremioTool(effectiveTool, args);
    }
    if (!this.stremioEnabled) throw new Error("stremio_deep_links_disabled");

    const { resolved, streamId } = await this.resolveForStream(args);
    const preferences = this.streamPreferences(args);
    let selection = { selected: null, ranked: [], errors: [], providers: [] };
    let directLookupError = null;

    if (this.stremioAddonConfigError) {
      directLookupError = this.stremioAddonConfigError;
    } else if (this.addonAggregator.configured) {
      try {
        selection = await this.addonAggregator.selectStream(resolved.type, streamId, preferences);
      } catch (error) {
        directLookupError = error?.message || String(error);
      }
    } else {
      directLookupError = "stremio_addon_manifests_not_configured";
    }

    const summary = safeSelection(selection);
    const content = {
      type: resolved.type,
      id: resolved.id,
      videoId: resolved.videoId,
      selected: resolved.selected
    };
    const nativeLink = detailDeepLink({
      type: content.type,
      id: content.id,
      videoId: content.videoId || content.id,
      autoPlay: args.autoPlay === false ? false : true
    });
    const launch = await this.launchStremio(nativeLink);

    if (args.autoPlay === false) {
      return {
        content,
        preferences,
        ...summary,
        directLookupError,
        launch,
        deliveryMode: "stremio_native_detail_opened",
        playbackRequested: false
      };
    }

    const firstStreamClick = await this.clickFirstStream();
    const nativeFallback = {
      used: !selection.selected,
      reason: !selection.selected
        ? (directLookupError || (summary.errors[0]?.error ?? "stremio_direct_addon_lookup_empty"))
        : null
    };
    const playbackVerification = firstStreamClick.playbackVerification || await this.verifyPlayback();

    return {
      content,
      preferences,
      ...summary,
      directLookupError,
      nativeFallback,
      launch,
      deliveryMode: firstStreamClick.ok ? "first_stream_center_click" : "stremio_native_stream_list_unconfirmed",
      firstStreamClick,
      playbackVerification,
      playbackConfirmed: playbackVerification.confirmed,
      playbackRequested: true
    };
  }
}
