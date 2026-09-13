import assert from "node:assert/strict";
import test from "node:test";
import { installStremioLegacyAutoclick } from "../lib/stremio-legacy-autoclick.mjs";

function makeClient(result, { library = [], click = { ok: true, via: "home_assistant_remote" } } = {}) {
  class Client {
    constructor() {
      this.calls = 0;
      this.__stremioSmartRuntime = { account: { library } };
    }

    async handleStremioTool() {
      return structuredClone(result);
    }

    async clickFirstStream() {
      this.calls += 1;
      return structuredClone(click);
    }
  }

  installStremioLegacyAutoclick(Client);
  return new Client();
}

test("fresh legacy Stremio play sends the first-stream click", async () => {
  const client = makeClient({
    launch: { ok: true },
    resolved: { id: "tt123", selected: { id: "tt123" } },
    smartPlayback: { effectiveProfile: "default", episodeDecision: null }
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play", { id: "tt123" });
  assert.equal(client.calls, 1);
  assert.equal(result.firstStreamClick.ok, true);
  assert.equal(result.deliveryMode, "first_stream_center_click");
});

test("series resume does not send a blind center key", async () => {
  const client = makeClient({
    launch: { ok: true },
    resolved: { id: "tt999", videoId: "tt999:1:4" },
    smartPlayback: {
      effectiveProfile: "default",
      episodeDecision: { status: "resume_in_progress", videoId: "tt999:1:4" }
    }
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play", { id: "tt999" });
  assert.equal(client.calls, 0);
  assert.equal(result.firstStreamClick.skipped, true);
  assert.equal(result.firstStreamClick.commandSent, false);
  assert.equal(result.deliveryMode, "stremio_native_resume");
});

test("movie resume from linked account does not send a blind center key", async () => {
  const client = makeClient({
    launch: { ok: true },
    resolved: { id: "tt555", selected: { id: "tt555" } },
    smartPlayback: { effectiveProfile: "default", episodeDecision: null }
  }, {
    library: [{ type: "movie", mediaId: "tt555", playbackId: "tt555", positionSeconds: 1200, finished: false }]
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play", { id: "tt555" });
  assert.equal(client.calls, 0);
  assert.equal(result.firstStreamClick.skipped, true);
  assert.equal(result.firstStreamClick.reason, "stremio_account_resume_in_progress");
});

test("family profile never receives the generic legacy autoclick", async () => {
  const client = makeClient({
    launch: { ok: true },
    smartPlayback: { effectiveProfile: "family", episodeDecision: null }
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play", { id: "ttkid" });
  assert.equal(client.calls, 0);
  assert.equal(result.firstStreamClick, undefined);
});

test("an existing play_best click is never duplicated", async () => {
  const client = makeClient({
    launch: { ok: true },
    firstStreamClick: { ok: true, commandSent: true },
    smartPlayback: { effectiveProfile: "default", episodeDecision: null }
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play", { id: "tt123" });
  assert.equal(client.calls, 0);
  assert.equal(result.firstStreamClick.commandSent, true);
});
