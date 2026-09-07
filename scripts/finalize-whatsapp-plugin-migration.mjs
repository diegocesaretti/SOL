import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transforms) {
  let text = await readFile(path, "utf8");
  let changed = false;
  for (const [from, to] of transforms) {
    if (text.includes(to)) continue;
    if (!text.includes(from)) throw new Error(`Patch anchor not found in ${path}: ${from.slice(0, 160)}`);
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) await writeFile(path, text, "utf8");
}

await patch("apps/server/src/modules/ingestion/plugin-input-service.ts", [[
`    if (row.auth_mode !== authMode || row.owner_member_id !== principal.memberId) {
      throw new Error("input_account_owned_by_other_runtime");
    }
    await client.query(
      \`UPDATE source_accounts SET label=$2, updated_at=now() WHERE id=$1\`,
      [row.id, label],
    );
    row.label = label;`,
`    const sameOwner = row.owner_member_id === principal.memberId;
    const adoptableLegacyWhatsapp = provider === "whatsapp" && row.auth_mode === "linked-device";
    if (!sameOwner || (row.auth_mode !== authMode && !adoptableLegacyWhatsapp)) {
      throw new Error("input_account_owned_by_other_runtime");
    }
    if (adoptableLegacyWhatsapp) {
      await client.query(
        \`UPDATE source_accounts
         SET label=$2, auth_mode=$3, config=config || $4::jsonb, updated_at=now()
         WHERE id=$1\`,
        [row.id, label, authMode, JSON.stringify({ pluginId: principal.pluginId, adoptedFrom: "linked-device" })],
      );
      row.auth_mode = authMode;
    } else {
      await client.query(
        \`UPDATE source_accounts SET label=$2, updated_at=now() WHERE id=$1\`,
        [row.id, label],
      );
    }
    row.label = label;`
]]);

await patch("apps/server/src/modules/connectors/whatsapp/repository.ts", [
  [
    "  WHERE s.provider = 'whatsapp'\n`;",
    "  WHERE s.provider = 'whatsapp'\n    AND COALESCE(s.auth_mode, '') NOT LIKE 'plugin:%'\n`;",
  ],
  [
    "    WHERE s.provider = 'whatsapp'\n      AND COALESCE(s.auth_mode, '') <> 'linked-device-assistant'",
    "    WHERE s.provider = 'whatsapp'\n      AND COALESCE(s.auth_mode, '') <> 'linked-device-assistant'\n      AND COALESCE(s.auth_mode, '') NOT LIKE 'plugin:%'",
  ],
]);

console.log("WhatsApp plugin migration finalized");
