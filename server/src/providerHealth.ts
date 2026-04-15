// In-memory health tracker for LLM models.
//
// Goal: stop re-probing models that just returned 429/503/network errors so the
// next chat request doesn't re-burn seconds on known-bad providers. State lives
// only in the running process — a restart clears it, which is fine because the
// cooldowns are short-lived anyway.
//
// A model marked unhealthy is skipped when picking attempts until the cooldown
// expires. If *every* candidate is marked unhealthy, callers should fall back
// to trying the full list anyway — better than returning "no providers".

export type UnhealthyKind = "rate-limit" | "overload" | "network";

// Rate-limits usually reset slowly (hourly quotas), overloads clear in under a
// minute, transient network blips faster still.
const COOLDOWN_SECONDS: Record<UnhealthyKind, number> = {
  "rate-limit": 300,
  overload: 60,
  network: 30,
};

type Entry = { until: number; kind: UnhealthyKind };
const entries = new Map<string, Entry>();

const now = (): number => Math.floor(Date.now() / 1000);

export const markUnhealthy = (model: string, kind: UnhealthyKind): void => {
  entries.set(model, { until: now() + COOLDOWN_SECONDS[kind], kind });
};

export const markHealthy = (model: string): void => {
  entries.delete(model);
};

export const isHealthy = (model: string): boolean => {
  const entry = entries.get(model);
  if (!entry) return true;
  if (entry.until <= now()) {
    entries.delete(model);
    return true;
  }
  return false;
};

export const listUnhealthy = (): Array<{ model: string; kind: UnhealthyKind; secondsLeft: number }> => {
  const n = now();
  const out: Array<{ model: string; kind: UnhealthyKind; secondsLeft: number }> = [];
  for (const [model, entry] of entries) {
    if (entry.until <= n) {
      entries.delete(model);
      continue;
    }
    out.push({ model, kind: entry.kind, secondsLeft: entry.until - n });
  }
  return out;
};

export const classifyStatus = (status: number): UnhealthyKind | null => {
  if (status === 429) return "rate-limit";
  if (status >= 500) return "overload";
  return null;
};
