// CLI for managing Schulcodes.
//
//   bun scripts/code.ts new <school> [--label=<text>] [--days=<n>]
//   bun scripts/code.ts list
//   bun scripts/code.ts revoke <hash-prefix>
//   bun scripts/code.ts prune
//
// Stores into server/data/codes.db (SHA-256 hash only — the plaintext code is
// shown once on creation and never again).

import { createCode, listCodes, revokeCodesByPrefix, pruneExpired } from "../src/auth.ts";

const args = process.argv.slice(2);
const cmd = args[0];

const parseFlag = (name: string, fallback?: string): string | undefined => {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  return flag ? flag.split("=").slice(1).join("=") : fallback;
};

const fmtDate = (unix: number): string =>
  new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16);

const usage = () => {
  console.log(`Usage:
  bun scripts/code.ts new <school> [--label=<text>] [--days=<n>]
  bun scripts/code.ts list
  bun scripts/code.ts revoke <hash-prefix>
  bun scripts/code.ts prune`);
};

switch (cmd) {
  case "new": {
    const school = args.find((a, i) => i >= 1 && !a.startsWith("--"));
    if (!school) {
      console.error("Fehler: <school> fehlt.\n");
      usage();
      process.exit(1);
    }
    const label = parseFlag("label") ?? null;
    const days = Number(parseFlag("days", "7"));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      console.error("Fehler: --days muss zwischen 1 und 365 liegen.");
      process.exit(1);
    }
    const code = createCode(school, label, days);
    console.log(`\nSchulcode erstellt:\n`);
    console.log(`  Code:    ${code}`);
    console.log(`  Schule:  ${school}`);
    if (label) console.log(`  Label:   ${label}`);
    console.log(`  Gültig:  ${days} Tage`);
    console.log(`\nDiesen Code an die Mentor*innen weitergeben — er wird NICHT nochmal angezeigt.\n`);
    break;
  }
  case "list": {
    const codes = listCodes();
    if (codes.length === 0) {
      console.log("Keine Codes vorhanden.");
      break;
    }
    console.log("\nCodes (Plaintext wird nicht gespeichert, nur Hash-Präfix):\n");
    console.log(
      "Hash      Schule                        Label            Erstellt          Läuft ab"
    );
    console.log(
      "--------  ----------------------------  ---------------  ----------------  ----------------"
    );
    for (const c of codes) {
      const school = c.school.padEnd(28).slice(0, 28);
      const label = (c.label ?? "").padEnd(15).slice(0, 15);
      const created = fmtDate(c.created_at);
      const expires = fmtDate(c.expires_at);
      const expired = c.expires_at * 1000 < Date.now() ? "  (abgelaufen)" : "";
      console.log(`${c.hashPrefix}  ${school}  ${label}  ${created}  ${expires}${expired}`);
    }
    console.log("");
    break;
  }
  case "revoke": {
    const prefix = args[1];
    if (!prefix || prefix.length < 4) {
      console.error("Fehler: Hash-Präfix muss mindestens 4 Zeichen haben.");
      process.exit(1);
    }
    const n = revokeCodesByPrefix(prefix);
    console.log(`${n} Code(s) entfernt.`);
    break;
  }
  case "prune": {
    const n = pruneExpired();
    console.log(`${n} abgelaufene Code(s) entfernt.`);
    break;
  }
  default: {
    usage();
    process.exit(cmd ? 1 : 0);
  }
}
