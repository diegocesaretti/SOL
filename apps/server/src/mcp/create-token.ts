import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config } from "../config.js";
import { closeDatabase, db } from "../database/client.js";
import { createMcpAccessToken } from "../modules/mcp/access.js";
import type { AuthPrincipal } from "../modules/auth/session.js";

const members = await db.query<{
  household_id: string;
  household_name: string;
  member_id: string;
  display_name: string;
  login_name: string;
  role: AuthPrincipal["role"];
}>(
  `SELECT h.id AS household_id, h.name AS household_name, m.id AS member_id,
          m.display_name, m.login_name, m.role::text AS role
   FROM members m
   JOIN households h ON h.id = m.household_id
   WHERE m.status = 'active'
   ORDER BY h.created_at, m.created_at`,
);

if (!members.rows.length) {
  console.error("No active SOL members exist. Complete onboarding first.");
  await closeDatabase();
  process.exit(1);
}

const rl = createInterface({ input, output });
try {
  console.log("\nSOL MCP · create member-scoped token\n");
  members.rows.forEach((row, index) => {
    console.log(`${index + 1}. ${row.display_name} (${row.role}) · ${row.household_name}`);
  });
  const selectedRaw = await rl.question("\nMember number: ");
  const selectedIndex = Number(selectedRaw) - 1;
  const row = members.rows[selectedIndex];
  if (!row) throw new Error("Invalid member selection");
  if (row.role === "guest") throw new Error("Guest members cannot receive MCP access tokens");

  const labelRaw = await rl.question("Client label [Local MCP client]: ");
  const daysRaw = await rl.question("Expires in days [90]: ");
  const submitRaw = await rl.question("Allow this client to submit information/schedules into SOL Life? [y/N]: ");
  const allowSubmit = ["y", "yes", "s", "si", "sí"].includes(submitRaw.trim().toLowerCase());
  const principal: AuthPrincipal = {
    householdId: row.household_id,
    memberId: row.member_id,
    displayName: row.display_name,
    loginName: row.login_name,
    role: row.role,
  };
  const created = await createMcpAccessToken(principal, {
    label: labelRaw.trim() || "Local MCP client",
    expiresInDays: daysRaw.trim() ? Number(daysRaw) : 90,
    allowSubmit,
  });

  console.log("\nToken created. Copy it now; SOL stores only its hash:\n");
  console.log(created.token);
  console.log(`\nScopes: ${created.access.scopes.join(", ")}\n`);
  console.log("Generic MCP stdio configuration template:\n");
  console.log(JSON.stringify({
    mcpServers: {
      sol: {
        command: "pnpm",
        args: ["--dir", config.repoRoot, "mcp"],
        env: { SOL_MCP_TOKEN: created.token },
      },
    },
  }, null, 2));
  console.log(
    allowSubmit
      ? "\nThis token can read permitted SOL data and submit provenance-bearing information/schedules. It cannot perform external actions.\n"
      : "\nThis token is read-only and inherits the selected member's SOL privacy boundary.\n",
  );
} finally {
  rl.close();
  await closeDatabase();
}
