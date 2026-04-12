// In-memory rate limiting.
//
// Two independent buckets:
//   - Chat:  keyed by Schulcode hash, resets at UTC midnight (50/day default)
//   - Login: keyed by client IP, sliding 1-hour window (20/hour default)
//
// Nothing is persisted — a server restart resets all counters. That's fine at
// the current scale and aligns with the "nothing stored" design goal.

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  limit: number;
};

// ---------- Chat bucket (per-code, daily) ----------

type DayBucket = { count: number; dayKey: string };
const chatBuckets = new Map<string, DayBucket>();

const todayKey = (): string => new Date().toISOString().slice(0, 10);

export const tryConsume = (key: string, limit: number): RateLimitResult => {
  const day = todayKey();
  let bucket = chatBuckets.get(key);
  if (!bucket || bucket.dayKey !== day) {
    bucket = { count: 0, dayKey: day };
    chatBuckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, limit };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, limit };
};

// ---------- Login bucket (per-IP, hourly window) ----------

type WindowBucket = { count: number; windowStart: number };
const loginBuckets = new Map<string, WindowBucket>();

const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export const tryConsumeLogin = (ip: string): RateLimitResult => {
  const now = Date.now();
  let bucket = loginBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > LOGIN_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    loginBuckets.set(ip, bucket);
  }
  if (bucket.count >= LOGIN_LIMIT) {
    return { ok: false, remaining: 0, limit: LOGIN_LIMIT };
  }
  bucket.count += 1;
  return { ok: true, remaining: LOGIN_LIMIT - bucket.count, limit: LOGIN_LIMIT };
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
