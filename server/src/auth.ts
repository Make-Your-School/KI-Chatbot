// Schulcode validation + signed session cookies.
//
// Design:
// - Codes are short, human-friendly (6 chars, no 0/O/I/1 confusion).
// - We store SHA-256(normalized code) in sqlite, never the plaintext code.
// - Sessions are signed cookies: HMAC over {hash, sid, iat, exp}. No session
//   table — but every request re-checks that the referenced code still exists
//   and has not expired, so `code revoke` takes effect immediately instead of
//   after the cookie's own 7-day lifetime.
// - `sid` is a random per-login id. It is one of the three rate-limit keys
//   (code / session / browser) and is never stored server-side.
// - `ep` is the session epoch. Bumping it (scripts/code.ts logout-all) makes
//   every cookie ever issued invalid at once, without touching AUTH_SECRET.

import { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

// --- DB bootstrap -----------------------------------------------------------

mkdirSync(dirname(config.codes.dbPath), { recursive: true });

const db = new Database(config.codes.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    hash TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Migration: per-code daily limit. NULL means "use the configured default".
// A code shared by a whole event wants a much higher ceiling than a school code.
const hasColumn = (table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(c => c.name === column);

if (!hasColumn("codes", "daily_limit")) {
  db.exec("ALTER TABLE codes ADD COLUMN daily_limit INTEGER");
}

// Migration: what a code may open. 'chat' is the normal Schulcode; 'stats'
// opens only the statistics page and cannot chat. Existing rows default to
// 'chat', so nothing changes for codes that already exist.
if (!hasColumn("codes", "scope")) {
  db.exec("ALTER TABLE codes ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat'");
}

// Small key/value table. Holds the session epoch — see logoutEveryone().
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// --- Session epoch ----------------------------------------------------------
//
// Every issued cookie carries the epoch that was current at login. Raising the
// epoch therefore invalidates all of them in one step — the "log everyone out"
// button. Doing it this way rather than by rotating AUTH_SECRET means it can be
// triggered from the CLI without editing .env or restarting the service.

export const currentEpoch = (): number => {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'session_epoch'").get() as
    | { value: string }
    | undefined;
  const parsed = Number(row?.value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

/** Invalidates every active session. Returns the new epoch. */
export const logoutEveryone = (): number => {
  const next = currentEpoch() + 1;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('session_epoch', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(next));
  return next;
};

// --- Code format + hashing --------------------------------------------------

// Unambiguous alphabet: no 0/O, no I/1, no lowercase.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Everything a person might put between the parts of a code gets thrown away,
// so one stored code covers every plausible spelling of it:
//
//   MEINCODE1234   meincode1234   MeinCode 1234
//   MEINCODE-1234  meincode_1234  MEINCODE.1234
//
// The dash range covers the typographic variants that autocorrect and slide
// software like to substitute for a plain hyphen (‑ ‒ – — ― and the minus sign),
// which otherwise turn a correctly read-out code into a failed login.
//
// Changing this set cannot invalidate existing codes: CUSTOM_CODE_RE only ever
// allowed A-Z0-9 through, so no stored code contains any of these characters.
const CODE_SEPARATORS = /[\s._\u2010-\u2015\u2212-]/g;

const normalize = (raw: string): string =>
  raw.trim().toUpperCase().replace(CODE_SEPARATORS, "");

export const hashCode = (code: string): string =>
  createHash("sha256").update(normalize(code)).digest("hex");

const generateCode = (length = 6): string => {
  const bytes = randomBytes(length * 2); // oversample for modulo bias safety
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
};

// --- Validation -------------------------------------------------------------

export type CodeScope = "chat" | "stats";

export const CODE_SCOPES: readonly CodeScope[] = ["chat", "stats"] as const;

export const isCodeScope = (v: unknown): v is CodeScope =>
  typeof v === "string" && (CODE_SCOPES as readonly string[]).includes(v);

export type CodeRecord = {
  hash: string;
  school: string;
  label: string | null;
  created_at: number;
  expires_at: number;
  daily_limit: number | null;
  scope: CodeScope;
};

// A custom code must survive being read off a slide and typed on a phone.
// normalize() has already uppercased the input and removed every separator, so
// "meincode", "MEINCODE" and "mein-code" all arrive here as "MEINCODE" and only
// letters and digits are left to validate.
const CUSTOM_CODE_RE = /^[A-Z0-9]{4,32}$/;

// Single source of truth for "is this code hash currently usable?".
// Used both at login (via validateCode) and on every chat request, so that a
// revoked or expired code kills live sessions instead of lingering for days.
export const lookupByHash = (hash: string): CodeRecord | null => {
  const row = db
    .prepare("SELECT * FROM codes WHERE hash = ? AND expires_at > ?")
    .get(hash, Math.floor(Date.now() / 1000)) as CodeRecord | undefined;
  if (!row) return null;
  // Rows written before the scope column existed come back without it.
  return { ...row, scope: isCodeScope(row.scope) ? row.scope : "chat" };
};

export const validateCode = (input: string): CodeRecord | null => {
  if (!input || normalize(input).length < 4) return null;
  return lookupByHash(hashCode(input));
};

// --- Signed session cookie --------------------------------------------------
//
// Format: base64url(payloadJSON) + "." + base64url(HMAC-SHA256(payloadStr))

export type SessionPayload = {
  hash: string;
  /** Random per-login id, used as a rate-limit key. */
  sid: string;
  /** Session epoch at login time — see logoutEveryone(). */
  ep: number;
  iat: number;
  exp: number;
};

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const sign = (data: string): string =>
  b64url(createHmac("sha256", config.auth.secret).update(data).digest());

export const issueSession = (record: CodeRecord): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    hash: record.hash,
    sid: b64url(randomBytes(12)),
    ep: currentEpoch(),
    iat: now,
    // Never outlive the Schulcode itself.
    exp: Math.min(now + config.auth.sessionTtlSeconds, record.expires_at),
  };
  const payloadStr = b64url(Buffer.from(JSON.stringify(payload)));
  return `${payloadStr}.${sign(payloadStr)}`;
};

export const verifySession = (token: string | undefined): SessionPayload | null => {
  if (!token) return null;
  const [payloadStr, sig] = token.split(".");
  if (!payloadStr || !sig) return null;

  const expected = sign(payloadStr);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(b64urlDecode(payloadStr).toString()) as SessionPayload;
    if (typeof payload?.hash !== "string") return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    // Anything from an older epoch — or a cookie predating the epoch field —
    // is dead. That is exactly what "log everyone out" has to mean.
    if (payload.ep !== currentEpoch()) return null;
    if (typeof payload.sid !== "string" || !payload.sid) return null;
    return payload;
  } catch {
    return null;
  }
};

// --- Admin helpers (used by scripts/code.ts) --------------------------------

export type CreateCodeOptions = {
  /** Explicit code instead of a random one, for a code people have to remember. */
  code?: string;
  /** Per-code daily chat limit. Omitted = use the configured default. */
  dailyLimit?: number;
  /** What the code opens. Default 'chat'. */
  scope?: CodeScope;
};

export const createCode = (
  school: string,
  label: string | null,
  ttlDays = 7,
  opts: CreateCodeOptions = {}
): string => {
  let code: string;
  if (opts.code !== undefined) {
    code = normalize(opts.code);
    if (!CUSTOM_CODE_RE.test(code)) {
      throw new Error(
        "Ungültiger Code. Erlaubt sind 4 bis 32 Zeichen aus A-Z und 0-9 " +
          "(Leerzeichen und Bindestriche werden ignoriert)."
      );
    }
  } else {
    code = generateCode(6);
  }

  const hash = hashCode(code);
  if (lookupByHash(hash)) {
    throw new Error("Dieser Code existiert bereits und ist noch gültig.");
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT OR REPLACE INTO codes (hash, school, label, created_at, expires_at, daily_limit, scope) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    hash, school, label, now, now + ttlDays * 86400,
    opts.dailyLimit ?? null, opts.scope ?? "chat"
  );
  return code;
};

export type ListedCode = {
  hashPrefix: string;
  school: string;
  label: string | null;
  created_at: number;
  expires_at: number;
  daily_limit: number | null;
  scope: CodeScope;
};

export const listCodes = (): ListedCode[] => {
  const rows = db
    .prepare("SELECT * FROM codes ORDER BY created_at DESC")
    .all() as CodeRecord[];
  return rows.map(r => ({
    hashPrefix: r.hash.slice(0, 8),
    school: r.school,
    label: r.label,
    created_at: r.created_at,
    expires_at: r.expires_at,
    daily_limit: r.daily_limit,
    scope: r.scope ?? "chat",
  }));
};

/**
 * Delete by the plaintext code itself. Handy for codes you set yourself
 * (`revoke BEISPIELCODE`); for random codes you only have the hash prefix.
 * Returns the number of rows removed.
 */
export const revokeByCode = (code: string): number =>
  db.prepare("DELETE FROM codes WHERE hash = ?").run(hashCode(code)).changes;

// substr() instead of LIKE: a prefix containing % or _ would otherwise act as
// a wildcard and delete more codes than asked for.
export const revokeCodesByPrefix = (prefix: string): number => {
  const normalized = prefix.trim().toLowerCase();
  const result = db
    .prepare("DELETE FROM codes WHERE substr(hash, 1, ?) = ?")
    .run(normalized.length, normalized);
  return result.changes;
};

export const pruneExpired = (): number => {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(now);
  return result.changes;
};
