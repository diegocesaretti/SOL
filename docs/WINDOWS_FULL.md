# SOL Windows Full

Starting with SOL 0.15.0, the standard Windows distribution is `SOL-Windows.zip` and is the **Full** package.

It contains:

- SOL Core and the rollback-capable updater;
- the portable Node runtime;
- the latest stable `Nexo.solplugin` available when the build runs;
- the latest stable `CodexAudioRemote.solplugin` available when the build runs;
- the latest stable `HomeAssistant.solplugin` available when the build runs.

`SOL-Core-Windows.zip` is published alongside it for users who explicitly want only SOL Core.

## Update behavior

The normal SOL updater continues to use `SOL-Windows.zip`, so an existing Windows installation moves onto the Full channel automatically when it updates to 0.15.0 or later.

Bundled plugins are synchronized by SOL's Plugin Manager at startup:

- a missing plugin is installed after an owner/member scope exists;
- an installed plugin is upgraded only when the bundled semantic version is newer;
- an equal or newer locally installed plugin is left untouched;
- existing compatible settings, scope and enabled/disabled state are preserved;
- upgrades use SOL's transactional plugin replacement and rollback path;
- a plugin that requests new permissions is not silently granted them;
- plugins with required settings (for example Home Assistant URL/token) remain stopped until configured.

Fresh installations may start before onboarding has created an owner. In that case bundled plugin installation is deferred and retried after onboarding rather than inventing a household/member scope.

## Build integrity

The Windows workflow downloads the rolling stable releases for the three official plugins, validates each package's root `sol-plugin.json`, verifies the expected plugin id, calculates SHA-256 and writes `bundled-plugins/catalog.json` inside the Full package.

At runtime SOL verifies each bundled package against the catalog digest before installing or upgrading it.

Real `.env` files, plugin credentials, WhatsApp sessions, Home Assistant tokens and Codex credentials are never included in either Windows ZIP.
