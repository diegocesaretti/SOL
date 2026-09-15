import test from "node:test";
import assert from "node:assert/strict";
import {
  installManualSpanishTitlePolicy,
  normalizeConfiguredTitle,
  parseConfiguredTitles
} from "../lib/stremio-title-language-policy.mjs";

function FakeClientClass(resolvedName = "El Niño y la Garza") {
  return class FakeClient {
    streamPreferences(args = {}) {
      return { quality: args.quality || "1080p", language: args.language || "any" };
    }

    async resolveForStream() {
      return { resolved: { selected: { name: resolvedName } } };
    }

    async playBest(args = {}) {
      const result = await this.resolveForStream(args);
      return { title: result.resolved.selected.name, preferences: this.streamPreferences(args) };
    }

    stremioStatus() {
      return { enabled: true };
    }
  };
}

test("normalizes case, accents, punctuation and repeated whitespace", () => {
  assert.equal(normalizeConfiguredTitle("  EL Niño: ¡Y LA Garza!  "), "el nino y la garza");
  assert.equal(normalizeConfiguredTitle("Spider–Man   2"), "spider man 2");
});

test("parses semicolon, pipe, newline and JSON-array title lists", () => {
  assert.deepEqual(
    parseConfiguredTitles("Amélie; EL NIÑO Y LA GARZA|Matrix\nCoco"),
    ["amelie", "el nino y la garza", "matrix", "coco"]
  );
  assert.deepEqual(parseConfiguredTitles('["Coco","Amélie"]'), ["coco", "amelie"]);
});

test("configured resolved title defaults to Spanish when no specific language was requested", async () => {
  const Client = FakeClientClass("El Niño y la Garza");
  const installed = installManualSpanishTitlePolicy(Client, {
    HA_SOL_STREMIO_SPANISH_DEFAULT_TITLES: "matrix; el nino y la garza"
  });
  assert.equal(installed.installed, true);

  const result = await new Client().playBest({ query: "El NINO y la GARZA!!!", language: "any" });
  assert.equal(result.preferences.language, "spanish");
  assert.equal(result.preferences.languageSource, "manual_title_default");
  assert.equal(result.preferences.matchedManualSpanishTitle, "el nino y la garza");
});

test("resolved catalog title can match even when the spoken query differs", async () => {
  const Client = FakeClientClass("Amélie");
  installManualSpanishTitlePolicy(Client, { HA_SOL_STREMIO_SPANISH_DEFAULT_TITLES: "amelie" });

  const result = await new Client().playBest({ query: "la pelicula francesa de amelie" });
  assert.equal(result.preferences.language, "spanish");
  assert.equal(result.preferences.matchedManualSpanishTitle, "amelie");
});

test("an explicit specific language overrides the manual title default", async () => {
  const Client = FakeClientClass("Coco");
  installManualSpanishTitlePolicy(Client, { HA_SOL_STREMIO_SPANISH_DEFAULT_TITLES: "COCO" });

  const result = await new Client().playBest({ query: "coco", language: "english" });
  assert.equal(result.preferences.language, "english");
  assert.equal(result.preferences.languageSource, "explicit");
  assert.equal("matchedManualSpanishTitle" in result.preferences, false);
});

test("status exposes manual-default policy count and Latino priority", () => {
  const Client = FakeClientClass("Matrix");
  installManualSpanishTitlePolicy(Client, { HA_SOL_STREMIO_SPANISH_DEFAULT_TITLES: "Matrix; Coco" });
  const status = new Client().stremioStatus();
  assert.deepEqual(status.manualSpanishDefaults, {
    count: 2,
    matching: "normalized_exact_title",
    language: "spanish",
    latinoPriority: true
  });
});
