// In-memory rate limiting.
//
// Chat is guarded by three independent daily buckets, all of which must have
// room before ANY of them is charged:
//
//   - code    — per Schulcode. Protects the API budget as a whole. A shared
//               code shared by a whole event gets a high ceiling via its own
//               daily_limit column; school codes use the configured default.
//   - session — per login. Cheap to reset (just log in again), so this is a
//               politeness limit, not a security boundary.
//   - browser — per localStorage id. The stable per-person cap, and the one
//               that actually keeps a single heavy user from eating a shared
//               code's whole quota.
//
// Login is guarded separately, keyed by client IP over a sliding hour.
//
// Nothing is persisted — a server restart resets all counters. That's fine at
// the current scale and aligns with the "nothing stored" design goal.

import { config } from "./config.ts";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  limit: number;
};

// ---------- Daily buckets (chat) ----------

export type DailyScope = "code" | "session" | "browser";

export type DailySpec = {
  scope: DailyScope;
  /** Raw key within the scope — hashed code, session id, browser id. */
  key: string;
  limit: number;
};

export type DailyDenial = {
  scope: DailyScope;
  limit: number;
};

type DayBucket = { count: number; dayKey: string };

// One map for all three scopes; keys are namespaced by scope so a session id
// can never collide with a code hash.
const chatBuckets = new Map<string, DayBucket>();

const todayKey = (): string => new Date().toISOString().slice(0, 10);

const bucketFor = (spec: DailySpec): DayBucket => {
  const mapKey = `${spec.scope}:${spec.key}`;
  const day = todayKey();
  let bucket = chatBuckets.get(mapKey);
  if (!bucket || bucket.dayKey !== day) {
    bucket = { count: 0, dayKey: day };
    chatBuckets.set(mapKey, bucket);
  }
  return bucket;
};

/**
 * Check every bucket first, then charge them all. Checking and charging in one
 * pass would burn quota in the earlier buckets on a request that is rejected
 * by a later one.
 *
 * Specs with a non-positive limit are skipped, so a scope can be switched off
 * by configuring 0.
 */
export const tryConsumeDaily = (
  specs: DailySpec[]
): { ok: true } | { ok: false; denied: DailyDenial } => {
  const active = specs.filter(s => s.limit > 0 && s.key.length > 0);

  for (const spec of active) {
    if (bucketFor(spec).count >= spec.limit) {
      return { ok: false, denied: { scope: spec.scope, limit: spec.limit } };
    }
  }
  for (const spec of active) {
    bucketFor(spec).count += 1;
  }
  return { ok: true };
};

// ---------- Login bucket (per-IP, hourly window) ----------

type WindowBucket = { count: number; windowStart: number };
const loginBuckets = new Map<string, WindowBucket>();

const LOGIN_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export const tryConsumeLogin = (ip: string): RateLimitResult => {
  const limit = config.rateLimit.loginPerIpPerHour;
  const now = Date.now();
  let bucket = loginBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > LOGIN_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    loginBuckets.set(ip, bucket);
  }
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, limit };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, limit };
};

// ---------- Periodic cleanup so Maps don't grow unbounded ----------

const cleanup = setInterval(() => {
  const day = todayKey();
  for (const [k, v] of chatBuckets) {
    if (v.dayKey !== day) chatBuckets.delete(k);
  }
  const now = Date.now();
  for (const [k, v] of loginBuckets) {
    if (now - v.windowStart > LOGIN_WINDOW_MS) loginBuckets.delete(k);
  }
}, 60 * 60 * 1000);
cleanup.unref?.();

// ---------- Read-only view for the statistics page ----------

export type DailyUsage = { key: string; count: number };

/**
 * Today's counters for one scope, highest first.
 *
 * This is live in-memory state, not something stored: it is the same data the
 * limiter checks, and it disappears on restart. The /stats page uses it to show
 * how much of the day's budget is gone — the one thing the persisted counters
 * cannot answer, because they have no notion of a limit.
 *
 * The keys are hashed codes, session ids and browser ids. Only the code scope's
 * keys ever leave this module, and only far enough to be matched against the
 * code list; nothing here is sent to a browser.
 */
export const usageToday = (scope: DailyScope): DailyUsage[] => {
  const day = todayKey();
  const prefix = `${scope}:`;
  const out: DailyUsage[] = [];
  for (const [mapKey, bucket] of chatBuckets) {
    if (!mapKey.startsWith(prefix) || bucket.dayKey !== day || bucket.count <= 0) continue;
    out.push({ key: mapKey.slice(prefix.length), count: bucket.count });
  }
  return out.sort((a, b) => b.count - a.count);
};
