import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyLaunchObservation,
  installStremioLaunchGuard,
  wakeForStremio
} from "../lib/stremio-launch-guard.mjs";

test("launcher observation is classified as home screen", () => {
  const state = classifyLaunchObservation({
    package: "com.google.android.apps.tv.launcherx",
    tree: { text: "Home", children: [] }
  }, "Star Wars");
  assert.equal(state.homeScreen, true);
  assert.equal(state.stremio, false);
});

test("wake command sends literal Android TV remote key 0", async () => {
  const calls = [];
  const client = {
    stremioRemoteEntityId: "remote.tv",
    async haService(domain, service, data) {
      calls.push({ domain, service, data });
      return [];
    }
  };
  const result = await wakeForStremio(client, { command: "0", delayMs: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    domain: "remote",
    service: "send_command",
    data: { entity_id: "remote.tv", command: "0" }
  }]);
});

test("play_best relaunches once when first deep link remains on Android TV home", async () => {
  const originalFetch = globalThis.fetch;
  let frame = 0;
  globalThis.fetch = async () => {
    frame += 1;
    return new Response(new Uint8Array([frame, frame + 1, frame + 2]), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "x-codex-profile": "preview",
        "x-codex-dhash": frame.toString(16).padStart(16, "0")
      }
    });
  };

  const observations = [
    { package: "com.google.android.apps.tv.launcherx", tree: { text: "Home", children: [] } },
    { package: "com.google.android.apps.tv.launcherx", tree: { text: "Home", children: [] } },
    { package: "com.stremio.one", tree: { text: "Loading", children: [] } }
  ];

  class FakeClient {
    constructor() {
      this.stremioRemoteEntityId = "remote.tv";
      this.stremioTvEnabled = true;
      this.stremioTvUrl = "http://tv-satellite.local:8765";
      this.stremioTvTimeoutMs = 1000;
      this.launches = 0;
      this.commands = [];
      this.clicks = 0;
    }

    stremioStatus() { return { enabled: true }; }

    async haService(domain, service, data) {
      this.commands.push({ domain, service, data });
      return [];
    }

    async tvObserveRaw() {
      return observations.shift() || { package: "com.stremio.one", tree: { text: "Loading", children: [] } };
    }

    async launchStremio(uri) {
      this.launches += 1;
      return { ok: true, deepLink: uri };
    }

    async clickFirstStream() {
      this.clicks += 1;
      return { ok: true };
    }

    async autoSelectVisualStream() { return { ok: false }; }

    async handleStremioTool(tool) {
      assert.equal(tool, "home_assistant_stremio_play_best");
      const launch = await this.launchStremio("stremio:///detail/movie/tt0121766/tt0121766?autoPlay=true");
      const click = await this.clickFirstStream();
      return { launch, click };
    }
  }

  installStremioLaunchGuard(FakeClient, {
    wakeCommand: "0",
    wakeDelayMs: 0,
    watchdogMs: 1200,
    retryCount: 1
  });

  try {
    const client = new FakeClient();
    const result = await client.handleStremioTool("home_assistant_stremio_play_best", { query: "Star Wars" });
    assert.equal(client.launches, 2);
    assert.equal(client.clicks, 1);
    assert.equal(client.commands.length, 2);
    assert.equal(client.commands[0].data.command, "0");
    assert.equal(client.commands[1].data.command, "0");
    assert.equal(result.launchGuard.retries, 1);
    assert.equal(result.launchGuard.finalStatus, "stremio_loading");
    assert.equal(result.launchGuard.allowStreamInput, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});