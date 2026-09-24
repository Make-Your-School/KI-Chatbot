// Aggregate-only usage statistics.
//
// Design rule: counters, never events.
//
// Nothing here can be traced back to a person. There is no row per request, no
// IP, no user agent, no timestamp finer than a day — so there is nothing to
// reconstruct a session, a timeline or an individual from. The finest thing the
// table can answer is "how many X happened on day Y", which is exactly what the
// /stats page shows.
//
// Lives in its own sqlite file (not codes.db) so that the two concerns stay
// separate: deleting or resetting statistics can never endanger the Schulcodes.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { systemLoad, systemHistory } from "./system.ts";

mkdirSync(dirname(config.stats.dbPath), { recursive: true });

const db = new Database(config.stats.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS stats_daily (
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    dim TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL,
    PRIMARY KEY (day, metric, dim)
  );
`);

// Counters are not personal data, but "keep as little as possible" is the whole
// point of this file, so old rows go away on their own.
db.prepare("DELETE FROM stats_daily WHERE day < ?").run(
  new Date(Date.now() - config.stats.retentionDays * 86400_000).toISOString().slice(0, 10)
);

export type Metric =
  | "chat"
  | "chat_error"
  | "login_ok"
  | "login_fail"
  | "rate_limited"
  | "rag_hit"
  | "rag_miss"
  | "provider"
  | "model";

// Days run on UTC, same as the rate-limit buckets, so both reset together.
const dayKey = (d = new Date()): string => d.toISOString().slice(0, 10);

const bump = db.prepare(
  "INSERT INTO stats_daily (day, metric, dim, count) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT(day, metric, dim) DO UPDATE SET count = count + 1"
);

/** Increment one counter for today. Never throws — stats must not break chat. */
export const record = (metric: Metric, dim = ""): void => {
  try {
    bump.run(dayKey(), metric, dim.slice(0, 64));
  } catch {
    /* a broken stats write is never worth failing a request over */
  }
};

// --- Reading ----------------------------------------------------------------

export type Totals = {
  chat: number;
  chatError: number;
  loginOk: number;
  loginFail: number;
  rateLimited: number;
  ragHit: number;
  ragMiss: number;
};

const EMPTY: Totals = {
  chat: 0, chatError: 0, loginOk: 0, loginFail: 0,
  rateLimited: 0, ragHit: 0, ragMiss: 0,
};

const METRIC_TO_FIELD: Record<string, keyof Totals> = {
  chat: "chat",
  chat_error: "chatError",
  login_ok: "loginOk",
  login_fail: "loginFail",
  rate_limited: "rateLimited",
  rag_hit: "ragHit",
  rag_miss: "ragMiss",
};

const totalsBetween = (from: string, to: string): Totals => {
  const rows = db
    .prepare(
      "SELECT metric, SUM(count) AS n FROM stats_daily " +
        "WHERE day >= ? AND day <= ? AND dim = '' GROUP BY metric"
    )
    .all(from, to) as Array<{ metric: string; n: number }>;

  const out: Totals = { ...EMPTY };
  for (const row of rows) {
    const field = METRIC_TO_FIELD[row.metric];
    if (field) out[field] = row.n;
  }
  return out;
};

const breakdown = (metric: Metric, from: string, to: string) =>
  db
    .prepare(
      "SELECT dim AS name, SUM(count) AS count FROM stats_daily " +
        "WHERE metric = ? AND day >= ? AND day <= ? AND dim <> '' " +
        "GROUP BY dim ORDER BY count DESC LIMIT 12"
    )
    .all(metric, from, to) as Array<{ name: string; count: number }>;

/**
 * Was heute an welches Modell ging.
 *
 * Kommt aus den gespeicherten Tageszaehlern, nicht aus dem Ratelimiter: das
 * Tageslimit eines Anbieters laeuft beim Anbieter weiter, egal ob wir zwischen-
 * durch neu gestartet sind. Ein Zaehler, der bei jedem Deploy auf null springt,
 * waere fuer diese Frage schlicht falsch.
 *
 * Kein LIMIT in der Abfrage — die Liste ist so lang wie die Modell-Liste, und
 * ein abgeschnittenes Tagesbudget waere irrefuehrend.
 */
export const modelUsageToday = (): Array<{ name: string; count: number }> => {
  const today = dayKey();
  return db
    .prepare(
      "SELECT dim AS name, SUM(count) AS count FROM stats_daily " +
        "WHERE metric = 'model' AND day = ? AND dim <> '' " +
        "GROUP BY dim ORDER BY count DESC"
    )
    .all(today) as Array<{ name: string; count: number }>;
};

const shiftDays = (n: number): string =>
  new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

/**
 * Provider/model counts for each selectable range. All three are sent at once —
 * they are a handful of rows, and shipping them together lets the page switch
 * ranges without another round trip.
 */
const breakdownByRange = (metric: Metric, today: string) => ({
  d30: breakdown(metric, shiftDays(29), today),
  month: breakdown(metric, today.slice(0, 8) + "01", today),
  year: breakdown(metric, today.slice(0, 4) + "-01-01", today),
});

export const summary = () => {
  const today = dayKey();
  const monthStart = today.slice(0, 8) + "01";
  const yearStart = today.slice(0, 4) + "-01-01";
  const last30 = shiftDays(29);

  const daily = db
    .prepare(
      "SELECT day, SUM(count) AS count FROM stats_daily " +
        "WHERE metric = 'chat' AND dim = '' AND day >= ? GROUP BY day ORDER BY day"
    )
    .all(last30) as Array<{ day: string; count: number }>;

  return {
    generatedAt: new Date().toISOString(),
    retentionDays: config.stats.retentionDays,
    ranges: {
      today: totalsBetween(today, today),
      week: totalsBetween(shiftDays(6), today),
      month: totalsBetween(monthStart, today),
      year: totalsBetween(yearStart, today),
    },
    daily,
    providers: breakdownByRange("provider", today),
    models: breakdownByRange("model", today),
    // Momentaufnahme plus Verlauf: die Zahl sagt "jetzt", die Kurve daneben
    // sagt, ob das jetzt normal ist.
    system: { ...systemLoad(), history: systemHistory() },
  };
};
