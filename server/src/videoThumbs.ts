// Vorschaubilder fuer YouTube-Videos, ausgeliefert vom eigenen Server.
//
// Warum nicht direkt verlinken: ein <img src="https://i.ytimg.com/..."> laesst
// den Browser jeder Schueler*in eine Anfrage an Google stellen, sobald die
// Antwort angezeigt wird — mit IP-Adresse, Uhrzeit und Referrer, und ohne dass
// irgendjemand ein Video angeklickt hat. Der Rest dieser Anwendung gibt nichts
// an Dritte weiter; ein Vorschaubild ist kein Grund, damit anzufangen.
//
// Der Server holt das Bild also einmal selbst und legt es auf die Platte. Ab
// dann wird es lokal ausgeliefert. Gecacht wird auf Dauer: die Vorschaubilder
// aendern sich praktisch nie, und der gesamte Bestand passt in ein Megabyte.

import { mkdirSync, existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { debugLog } from "./debug.ts";

mkdirSync(config.videoThumbs.dir, { recursive: true });

/** Elf Zeichen aus dem YouTube-Alphabet. Alles andere wird nicht angefasst. */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const cachePath = (id: string): string => join(config.videoThumbs.dir, `${id}.jpg`);

// mqdefault ist 320x180 und rund 15 KB. hqdefault waere 480x360, sieht in einer
// 9,5rem breiten Karte aber nicht besser aus und ist dreimal so gross.
const sourceUrl = (id: string): string => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// Damit ein kaputtes Video nicht bei jedem Anzeigen der Antwort erneut eine
// Anfrage nach draussen ausloest.
const failed = new Map<string, number>();
const FAILURE_TTL_MS = 60 * 60 * 1000;

const recentlyFailed = (id: string): boolean => {
  const at = failed.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > FAILURE_TTL_MS) {
    failed.delete(id);
    return false;
  }
  return true;
};

/**
 * Das Vorschaubild, aus dem Zwischenspeicher oder frisch geholt.
 * null heisst "gibt es nicht" — der Aufrufer antwortet dann mit 404 und die
 * Karte im Browser faellt auf reinen Text zurueck.
 */
export const getThumbnail = async (id: string): Promise<Buffer | null> => {
  if (!VIDEO_ID_RE.test(id)) return null;

  const path = cachePath(id);
  if (existsSync(path)) {
    try {
      return await readFile(path);
    } catch {
      /* unlesbare Datei: weiter unten neu holen */
    }
  }
  if (recentlyFailed(id)) return null;

  try {
    const resp = await fetch(sourceUrl(id), {
      headers: { "User-Agent": "ki-hackdays-thumb" },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());
    // YouTube liefert fuer unbekannte IDs ein graues Platzhalterbild statt 404.
    // Das ist winzig — daran erkennt man es zuverlaessiger als am Statuscode.
    if (buf.length < 1024 || buf.length > config.videoThumbs.maxBytes) {
      throw new Error(`unplausible size ${buf.length}`);
    }

    await writeFile(path, buf);
    debugLog("thumb", "fetched", { id, bytes: buf.length });
    return buf;
  } catch (err) {
    failed.set(id, Date.now());
    debugLog("thumb", "fetch failed", { id, message: (err as Error).message });
    return null;
  }
};
