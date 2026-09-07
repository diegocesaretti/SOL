import { rm, readFile, writeFile } from "node:fs/promises";

const targets = [
  "apps/server/src/modules/connectors/gmail",
  "apps/server/src/modules/connectors/google-calendar",
  "apps/server/src/modules/connectors/home-assistant",
  "apps/server/src/modules/connectors/mercadolibre",
  "apps/server/src/modules/connectors/sol-whatsapp",
  "apps/server/src/modules/connectors/whatsapp",
  "apps/server/src/ui/calendar.ts",
  "apps/server/src/ui/home-assistant.ts",
  "apps/server/src/ui/mercadolibre.ts",
  "apps/server/src/ui/sol-whatsapp.ts",
  "apps/server/src/ui/whatsapp.ts",
  "apps/server/src/ui/whatsapp.test.ts",
  "docs/GMAIL.md",
  "docs/HOME_ASSISTANT.md",
  "docs/MERCADOLIBRE.md",
  "docs/SOL_WHATSAPP.md",
  "docs/WHATSAPP.md",
];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
}

async function replace(path, from, to) {
  const text = await readFile(path, "utf8");
  if (!text.includes(from)) return;
  await writeFile(path, text.replace(from, to), "utf8");
}

await replace(
  "README.md",
  "Native connectors remain available as legacy/fallback integrations.",
  "External services are integrated exclusively through SOL plugins. The Core owns identity, permissions, source accounts, source items, ingestion contracts, knowledge, memory, and plugin supervision; it contains no provider-specific ingestion runtime.",
);

console.log("Removed native external connector runtimes and provider-specific UI/docs");
