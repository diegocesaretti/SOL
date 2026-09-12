import test from "node:test";
import assert from "node:assert/strict";
import { installStremioDebugging } from "../lib/stremio-debug.mjs";

test("unverified DPAD_CENTER continues into visual selector instead of reporting false success", async () => {
  const tools = [];

  class FakeClient {
    constructor() {
      this.stremioTvEnabled = true;
      this.stremioTvUrl = "http://tv.local:8765";
      this.stremioTvTimeoutMs = 1000;
      this.stremioFirstStreamDelayMs = 500;
      this.stremioPlaybackVerifyMs = 500;
      this.stremioAutoSelectAttempts = 2;
      this.addonAggregator = { configured: true };
      this.visualCalls = 0;
    }

    async tvObserveRaw() { return null; }
    async tvClickText() { return { ok: false, reason: "text_not_clicked" }; }
    async waitForStreamUi() { return { ready: true, via: "tv_satellite_timeout_fallback", waitedMs: 6500 }; }
    async verifyPlayback() { return { status: "unverified", confirmed: null, via: "tv_satellite_accessibility" }; }
    async clickFirstStream() {
      return {
        ok: true,
        command: "DPAD_CENTER",
        readiness: { ready: true, via: "tv_satellite_timeout_fallback", waitedMs: 6500 },
        playbackVerification: { status: "unverified", confirmed: null, via: "tv_satellite_accessibility" }
      };
    }
    async autoSelectVisualStream() {
      this.visualCalls += 1;
      return { ok: true, attempt: 1, matchedText: "1080p", via: "execute" };
    }
    async handleStremioTool(tool) {
      assert.equal(tool, "home_assistant_stremio_play_best");
      const firstStreamClick = await this.clickFirstStream();
      if (firstStreamClick.ok) return { deliveryMode: "first_stream_center_click", firstStreamClick };
      const autoSelection = await this.autoSelectVisualStream({ addonName: "Filtered Addon", title: "1080p" });
      return {
        deliveryMode: autoSelection.ok ? "visual_selection_automatic_fallback" : "unconfirmed",
        firstStreamClick,
        autoSelection,
        providerCount: 1,
        streamCount: 3,
        selected: { addonName: "Filtered Addon", title: "1080p", quality: "1080p" }
      };
    }
  }

  installStremioDebugging(FakeClient, tools);
  const client = new FakeClient();
  const result = await client.handleStremioTool("home_assistant_stremio_play_best", { query: "Back to the Future" });

  assert.equal(result.deliveryMode, "visual_selection_automatic_fallback");
  assert.equal(client.visualCalls, 1);
  assert.equal(result.firstStreamClick.ok, false);
  assert.equal(result.firstStreamClick.commandSent, true);
  assert.equal(result.firstStreamClick.reason, "stremio_center_sent_but_playback_unverified");
  assert.equal(typeof result.debugTraceId, "string");
  assert.ok(tools.some((tool) => tool.name === "home_assistant_stremio_debug_last"));
});
