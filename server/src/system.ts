// Serverzustand: Momentaufnahme und Verlauf der letzten 24 Stunden.
//
// Liegt bewusst neben stats.ts statt darin. stats.ts fuehrt gespeicherte
// Tageszaehler ueber die Nutzung; hier geht es um die Maschine. Die beiden
// haben nichts miteinander zu tun, ausser dass dieselbe Seite sie zeigt.
//
// Der Verlauf liegt ausschliesslich im Arbeitsspeicher. Es sind Maschinenwerte
// — Last, Speicher, Platte —, aus denen sich niemand rekonstruieren laesst; auf
// die Platte muessen sie trotzdem nicht, denn ein Verlauf, der ohnehin nur 24
// Stunden gilt, braucht keine Datei. Ein Neustart faengt neu an, und die Seite
// sagt das auch.

import { freemem, loadavg, totalmem, cpus } from "node:os";
import { statfsSync } from "node:fs";
import { config } from "./config.ts";

export const systemLoad = () => {
  const cpuCount = cpus().length || 1;
  const total = totalmem();
  const free = freemem();

  let disk: { usedPercent: number; freeGb: number } | null = null;
  try {
    const fs = statfsSync(config.stats.dbPath.replace(/\/[^/]*$/, "") || ".");
    const totalBytes = fs.blocks * fs.bsize;
    const freeBytes = fs.bavail * fs.bsize;
    if (totalBytes > 0) {
      disk = {
        usedPercent: Math.round(((totalBytes - freeBytes) / totalBytes) * 100),
        freeGb: Math.round((freeBytes / 1e9) * 10) / 10,
      };
    }
  } catch {
    /* statfs is not available everywhere — the page copes with null */
  }

  return {
    // Load average relative to core count: 1.0 means "fully busy".
    load1: Math.round((loadavg()[0] / cpuCount) * 100) / 100,
    load15: Math.round((loadavg()[2] / cpuCount) * 100) / 100,
    cpuCount,
    memUsedPercent: Math.round(((total - free) / total) * 100),
    memTotalGb: Math.round((total / 1e9) * 10) / 10,
    disk,
    uptimeHours: Math.round(process.uptime() / 360) / 10,
  };
};

// ---------- Verlauf der letzten 24 Stunden ----------

/**
 * Alle fuenf Minuten ein Messpunkt, 24 Stunden lang: 288 Punkte.
 *
 * Feiner braucht es nicht zu sein — die Grafik ist gut 100 Pixel breit, mehr
 * Punkte als Pixel waeren nur Rechenarbeit. Groeber waere schade: ein
 * Lastspitzchen waehrend eines Hackdays soll sichtbar bleiben.
 */
const SAMPLE_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = Math.round(WINDOW_MS / SAMPLE_MS);

/** Prozentwerte, gerundet — die Grafik braucht keine Nachkommastellen. */
export type SystemSample = {
  /** Unix-Zeit in Millisekunden. */
  t: number;
  /** Last des letzten Moments, in Prozent der Kerne. Kann ueber 100 gehen. */
  load1: number;
  load15: number;
  mem: number;
  /** null, wenn statfs auf dieser Maschine nichts liefert. */
  disk: number | null;
};

const samples: SystemSample[] = [];

const takeSample = (): void => {
  const now = systemLoad();
  samples.push({
    t: Date.now(),
    load1: Math.round(now.load1 * 100),
    load15: Math.round(now.load15 * 100),
    mem: now.memUsedPercent,
    disk: now.disk?.usedPercent ?? null,
  });
  // Aelter als das Fenster und alles, was ueber die Punktzahl hinausgeht. Die
  // Zeitgrenze ist die eigentliche Regel, die Punktzahl nur die Bremse fuer den
  // Fall, dass der Timer haeufiger laeuft als gedacht.
  const cutoff = Date.now() - WINDOW_MS;
  while (samples.length > 0 && (samples[0].t < cutoff || samples.length > MAX_POINTS)) {
    samples.shift();
  }
};

// Sofort einen ersten Punkt, sonst steht die Grafik nach einem Neustart fuenf
// Minuten lang leer da — und genau in diesen fuenf Minuten schaut man nach
// einem Deploy hin.
takeSample();

const timer = setInterval(takeSample, SAMPLE_MS);
// Der Verlauf ist kein Grund, den Prozess am Leben zu halten.
timer.unref?.();

/**
 * Der Verlauf, wie ihn die Seite zeichnet.
 *
 * `windowHours` und `stepMinutes` gehen mit, damit die Seite die Zeitachse
 * nicht raten muss: sie zeichnet immer die vollen 24 Stunden, auch wenn erst
 * zehn Minuten davon gemessen sind. Ein kurzer Strich am rechten Rand heisst
 * dann "gerade neu gestartet" — und das steht direkt daneben als "Laeuft seit".
 */
export const systemHistory = () => ({
  windowHours: WINDOW_MS / 3_600_000,
  stepMinutes: SAMPLE_MS / 60_000,
  points: samples.slice(),
});
