// Schulcode validation + signed session cookies.
//
// Design:
// - Codes are short, human-friendly (6 chars, no 0/O/I/1 confusion).
// - We store SHA-256(normalized code) in sqlite, never the plaintext code.
// - Sessions are stateless signed cookies: HMAC over {hash, iat, exp}.
//   No session table, no server-side storage of who is logged in.
// - The session payload references the code hash, which is what we use as
//   the rate-limit key — ties rate limit to a specific code, not an IP.

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

// --- Code format + hashing --------------------------------------------------

// Unambiguous alphabet: no 0/O, no I/1, no lowercase.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const normalize = (raw: string): string =>
  raw.trim().toUpperCase().replace(/[\s-]/g, "");

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

export type CodeRecord = {
  hash: string;
  school: string;
  label: string | null;
  created_at: number;
  expires_at: number;
};

export const validateCode = (input: string): CodeRecord | null => {
  if (!input || normalize(input).length < 4) return null;
  const hash = hashCode(input);
  const row = db
    .prepare("SELECT * FROM codes WHERE hash = ? AND expires_at > ?")
    .get(hash, Math.floor(Date.now() / 1000)) as CodeRecord | undefined;
  return row ?? null;
};

// --- Signed session cookie --------------------------------------------------
//
// Format: base64url(payloadJSON) + "." + base64url(HMAC-SHA256(payloadStr))

type SessionPayload = { hash: string; iat: number; exp: number };

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const sign = (data: string): string =>
  b64url(createHmac("sha256", config.auth.secret).update(data).digest());

export const issueSession = (codeHash: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    hash: codeHash,
    iat: now,
    exp: now + config.auth.sessionTtlSeconds,
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
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};

// --- Admin helpers (used by scripts/code.ts) --------------------------------

export const createCode = (
  school: string,
  label: string | null,
  ttlDays = 7
): string => {
  const code = generateCode(6);
  const hash = hashCode(code);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO codes (hash, school, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(hash, school, label, now, now + ttlDays * 86400);
  return code;
};

export type ListedCode = {
  hashPrefix: string;
  school: string;
  label: string | null;
  created_at: number;
  expires_at: number;
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
  }));
};

export const revokeCodesByPrefix = (prefix: string): number => {
  const result = db.prepare("DELETE FROM codes WHERE hash LIKE ?").run(prefix + "%");
  return result.changes;
};

export const pruneExpired = (): number => {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(now);
  return result.changes;
};
