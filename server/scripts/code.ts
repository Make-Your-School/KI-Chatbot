// CLI for managing Schulcodes.
//
//   bun scripts/code.ts new <school> [--label=<text>] [--days=<n>]
//                                     [--code=<CODE>] [--limit=<n>]
//   bun scripts/code.ts list
//   bun scripts/code.ts revoke <CODE|hash-prefix>
//   bun scripts/code.ts logout-all
//   bun scripts/code.ts prune
//
// Stores into server/data/codes.db (SHA-256 hash only — the plaintext code is
// shown once on creation and never again).
//
// --code sets an explicit code instead of a random one, for codes that have to
// be memorable enough to read off a slide. Such a code is typed by many people,
// so give it a matching --limit; the per-session and per-browser limits from the
// .env still apply on top and are what keep one person from using up the whole
// allowance.
//
// NOTE: never commit a code you actually hand out. Codes live in data/codes.db
// on the server; anything in this repo is public. All codes in comments and
// docs are deliberately fake placeholders.

import {
  isCodeScope,
  type CodeScope,
  createCode,
  listCodes,
  revokeByCode,
  revokeCodesByPrefix,
  pruneExpired,
  logoutEveryone,
} from "../src/auth.ts";

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
                                   [--code=<CODE>] [--limit=<n>]
  bun scripts/code.ts list
  bun scripts/code.ts revoke <CODE|hash-prefix>
  bun scripts/code.ts logout-all
  bun scripts/code.ts prune

  --code   Fester Code statt Zufallscode, 4-32 Zeichen A-Z/0-9.
           Beispiel: --code=BEISPIELCODE
  --limit  Tages-Limit fuer genau diesen Code. Ohne Angabe gilt
           RATE_LIMIT_PER_CODE_PER_DAY aus der .env.
  --scope  Was der Code oeffnet. Standard: chat
             chat   = normaler Schulcode, darf chatten
             stats  = darf NUR ki-hackdays.de/stats sehen, nicht chatten

  revoke      Loescht einen Code. Wer damit eingeloggt ist, fliegt sofort raus.
              Fuer eigene Codes einfach den Code selbst angeben (revoke BEISPIELCODE),
              fuer Zufallscodes das Hash-Praefix aus der Liste.
  logout-all  Loggt ALLE ueberall aus, ohne einen Code zu loeschen.
              Die Codes bleiben gueltig, man muss sich nur neu anmelden.`);
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

    const rawScope = parseFlag("scope", "chat") ?? "chat";
    if (!isCodeScope(rawScope)) {
      console.error("Fehler: --scope muss 'chat' oder 'stats' sein.");
      process.exit(1);
    }
    const scope: CodeScope = rawScope;

    const customCode = parseFlag("code");
    const rawLimit = parseFlag("limit");
    let dailyLimit: number | undefined;
    if (rawLimit !== undefined) {
      dailyLimit = Number(rawLimit);
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100000) {
        console.error("Fehler: --limit muss eine ganze Zahl zwischen 1 und 100000 sein.");
        process.exit(1);
      }
    }

    let code = "";
    try {
      code = createCode(school, label, days, { code: customCode, dailyLimit, scope });
    } catch (err) {
      console.error(`Fehler: ${(err as Error).message}`);
      process.exit(1);
    }

    console.log(`\nSchulcode erstellt:\n`);
    console.log(`  Code:    ${code}`);
    console.log(`  Schule:  ${school}`);
    if (label) console.log(`  Label:   ${label}`);
    console.log(`  Gültig:  ${days} Tage`);
    console.log(`  Limit:   ${dailyLimit ?? "Standard aus .env"}`);
    console.log(`  Zugang:  ${scope === "stats" ? "NUR Statistik (/stats)" : "Chat"}`);
    if (customCode === undefined) {
      console.log(`\nDiesen Code an die Mentor*innen weitergeben — er wird NICHT nochmal angezeigt.`);
    }
    console.log("");
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
      "Hash      Schule                        Label            Zugang  Limit   Erstellt          Läuft ab"
    );
    console.log(
      "--------  ----------------------------  ---------------  ------  ------  ----------------  ----------------"
    );
    for (const c of codes) {
      const school = c.school.padEnd(28).slice(0, 28);
      const label = (c.label ?? "").padEnd(15).slice(0, 15);
      const scopeCol = c.scope.padEnd(6).slice(0, 6);
      const limit = String(c.daily_limit ?? "-").padEnd(6).slice(0, 6);
      const created = fmtDate(c.created_at);
      const expires = fmtDate(c.expires_at);
      const expired = c.expires_at * 1000 < Date.now() ? "  (abgelaufen)" : "";
      console.log(
        `${c.hashPrefix}  ${school}  ${label}  ${scopeCol}  ${limit}  ${created}  ${expires}${expired}`
      );
    }
    console.log("");
    break;
  }
  case "revoke": {
    const target = args[1];
    if (!target || target.length < 4) {
      console.error("Fehler: Bitte einen Code oder ein Hash-Präfix (min. 4 Zeichen) angeben.");
      process.exit(1);
    }

    // Try the plaintext code first — that is what you have for your own codes.
    // Only fall back to prefix matching if nothing matched, so that a code
    // which happens to look like hex doesn't quietly delete something else.
    let n = revokeByCode(target);
    let how = `Code "${target.trim().toUpperCase()}"`;
    if (n === 0 && /^[0-9a-f]+$/i.test(target)) {
      n = revokeCodesByPrefix(target);
      how = `Hash-Präfix "${target}"`;
    }

    if (n === 0) {
      console.log(`Kein Code gefunden für ${how}. Nichts entfernt.`);
      break;
    }
    console.log(`${n} Code(s) entfernt (${how}).`);
    console.log("Wer damit eingeloggt war, ist ab sofort ausgesperrt.");
    break;
  }
  case "logout-all": {
    const epoch = logoutEveryone();
    console.log(`\nAlle Sitzungen beendet (Epoche ${epoch}).\n`);
    console.log("Die Schulcodes bleiben gültig — alle müssen sich nur neu anmelden.");
    console.log("Wirkt sofort, kein Neustart des Dienstes nötig.\n");
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
