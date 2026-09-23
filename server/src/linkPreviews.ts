// Vorschaubilder fuer externe Links — wie sie Messenger unter einem Link zeigen.
//
// Zwei Dinge sind hier bewusst so gebaut:
//
// 1. Der Server holt die Seite, nicht der Browser. Wie bei den Video-
//    Vorschaubildern soll kein Geraet einer Schueler*in bei einem fremden
//    Anbieter auftauchen, nur weil eine Antwort angezeigt wurde.
//
// 2. Es gibt eine Erlaubnisliste. Der Endpunkt bekommt keine Adresse, sondern
//    eine Kennung — und die laesst sich nur in eine Adresse aufloesen, wenn
//    diese in den eingebetteten Repos verlinkt ist. Ohne das waere der Dienst
//    ein offener Abrufdienst: wer eine Adresse hineinreicht, laesst sie von
//    diesem Server aufrufen, auch Adressen im internen Netz.
//
// Nicht jede Seite hat ein Vorschaubild. arduino.cc zum Beispiel hat keines,
// die Produktseiten im Shop schon. Fehlt es, antwortet der Endpunkt mit 404
// und die Karte im Browser bleibt eine Textkarte.

import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { debugLog } from "./debug.ts";
import { listLinkUrls } from "./rag.ts";

mkdirSync(config.linkPreviews.dir, { recursive: true });

export const PREVIEW_ID_RE = /^[0-9a-f]{16}$/;

const MIN_PREVIEW_BYTES = 8 * 1024;
// Ein Favicon darf winzig sein — es wird ja auch nur winzig angezeigt.
const MIN_ICON_BYTES = 64;

/** Kurze, stabile Kennung einer Adresse. Nur ein Namensschild, kein Geheimnis. */
export const previewId = (url: string): string =>
  createHash("sha256").update(url).digest("hex").slice(0, 16);

// Erlaubnisliste, aus der Wissensdatenbank gebaut. Wird nach Ablauf neu
// erzeugt, damit nach einem naechtlichen Einbetten auch neue Links gehen.
let allowed = new Map<string, string>();
let allowedAt = 0;
const ALLOWLIST_TTL_MS = 10 * 60 * 1000;

const resolveId = (id: string): string | null => {
  if (Date.now() - allowedAt > ALLOWLIST_TTL_MS) {
    allowed = new Map(listLinkUrls().map(url => [previewId(url), url]));
    allowedAt = Date.now();
    debugLog("preview", "allowlist rebuilt", { entries: allowed.size });
  }
  return allowed.get(id) ?? null;
};

// Nach Art getrennt: dass eine Seite kein Vorschaubild hat, heisst nicht, dass
// sie auch kein Logo hat.
const failed = new Map<string, number>();
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;

const recentlyFailed = (id: string): boolean => {
  const at = failed.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > FAILURE_TTL_MS) {
    failed.delete(id);
    return false;
  }
  return true;
};

/** Was geholt wird: das grosse Vorschaubild oder das kleine Seitensymbol. */
export type AssetKind = "preview" | "icon";

const cachePath = (id: string, kind: AssetKind): string =>
  join(config.linkPreviews.dir, kind === "icon" ? `${id}.icon` : `${id}.img`);

const META_RE =
  /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi;
const CONTENT_RE = /content\s*=\s*["']([^"']+)["']/i;

/** Die erste brauchbare Bildadresse aus den Meta-Angaben der Seite. */
const findPreviewImage = (html: string, pageUrl: string): string | null => {
  for (const tag of html.matchAll(META_RE)) {
    const raw = tag[0].match(CONTENT_RE)?.[1]?.trim();
    if (!raw) continue;
    try {
      const resolved = new URL(raw, pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        return resolved.toString();
      }
    } catch {
      /* unbrauchbare Adresse — naechster Treffer */
    }
  }
  return null;
};

const fetchLimited = async (url: string, maxBytes: number): Promise<Buffer | null> => {
  const resp = await fetch(url, {
    headers: { "User-Agent": "ki-hackdays-preview", Accept: "*/*" },
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  if (!resp.ok) return null;

  const buf = Buffer.from(await resp.arrayBuffer());
  // Groesse erst nach dem Laden pruefen: Content-Length fehlt oft. Der
  // Zeitlimit oben deckelt den Schaden bei wirklich grossen Antworten.
  return buf.length > maxBytes ? null : buf;
};

const ICON_LINK_RE = /<link[^>]+rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/gi;
const SIZES_RE = /sizes\s*=\s*["'](\d+)x\d+["']/i;

/**
 * Das Seitensymbol — das kleine Logo, das ein Browser im Tab zeigt.
 *
 * Fuer Seiten ohne Vorschaubild ist das der Rest an Wiedererkennung, den es
 * gibt: arduino.cc hat kein og:image, aber ein Logo. Als Symbol in der Ecke
 * der Karte sagt es trotzdem sofort, wo der Link hinfuehrt.
 *
 * Groesstes zuerst — ein 180er apple-touch-icon sieht besser aus als ein
 * 16x16-Favicon, das auf Kartengroesse nur ein Klecks waere.
 */
const findIconUrl = (html: string, pageUrl: string): string | null => {
  const candidates: Array<{ url: string; size: number }> = [];
  for (const tag of html.matchAll(ICON_LINK_RE)) {
    const raw = tag[0].match(CONTENT_RE)?.[1] ?? tag[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!raw) continue;
    try {
      const resolved = new URL(raw.trim(), pageUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      const declared = Number(tag[0].match(SIZES_RE)?.[1] ?? 0);
      // Ohne Groessenangabe: apple-touch-icon ist erfahrungsgemaess das
      // groessere, sonst bleibt es bei "unbekannt".
      const size = declared || (/apple-touch/i.test(tag[0]) ? 180 : 32);
      candidates.push({ url: resolved.toString(), size });
    } catch {
      /* unbrauchbare Adresse */
    }
  }
  candidates.sort((a, b) => b.size - a.size);
  if (candidates[0]) return candidates[0].url;

  // Letzter Versuch: der Ort, an dem ein Favicon per Konvention liegt.
  try {
    return new URL("/favicon.ico", pageUrl).toString();
  } catch {
    return null;
  }
};

export type Preview = { body: Buffer; contentType: string };

const CONTENT_TYPE_PATH = join(config.linkPreviews.dir, "types.json");
let contentTypes: Record<string, string> | null = null;

const loadTypes = async (): Promise<Record<string, string>> => {
  if (contentTypes) return contentTypes;
  try {
    contentTypes = JSON.parse(await readFile(CONTENT_TYPE_PATH, "utf8")) as Record<string, string>;
  } catch {
    contentTypes = {};
  }
  return contentTypes;
};

const rememberType = async (key: string, type: string): Promise<void> => {
  const types = await loadTypes();
  types[key] = type;
  try {
    await writeFile(CONTENT_TYPE_PATH, JSON.stringify(types));
  } catch {
    /* ohne Merkzettel wird beim naechsten Mal image/jpeg angenommen */
  }
};

/**
 * Vorschaubild oder Seitensymbol einer verlinkten Seite.
 *
 * Beide Arten laufen durch denselben Ablauf — Erlaubnisliste, Ablage auf der
 * Platte, Fehlergedaechtnis —, sie unterscheiden sich nur darin, welches Bild
 * aus der Seite gelesen wird und wie gross es mindestens sein muss.
 */
export const getAsset = async (id: string, kind: AssetKind): Promise<Preview | null> => {
  if (!PREVIEW_ID_RE.test(id)) return null;

  const key = `${kind}:${id}`;
  const path = cachePath(id, kind);
  if (existsSync(path)) {
    try {
      const types = await loadTypes();
      return { body: await readFile(path), contentType: types[key] ?? "image/jpeg" };
    } catch {
      /* unlesbar — unten neu holen */
    }
  }
  if (recentlyFailed(key)) return null;

  const pageUrl = resolveId(id);
  if (!pageUrl) return null;

  try {
    const html = await fetchLimited(pageUrl, config.linkPreviews.maxHtmlBytes);
    if (!html) throw new Error("page not fetchable");
    const page = html.toString("utf8");

    const imageUrl =
      kind === "icon" ? findIconUrl(page, pageUrl) : findPreviewImage(page, pageUrl);
    if (!imageUrl) throw new Error(kind === "icon" ? "no icon link" : "no og:image");

    const image = await fetchLimited(imageUrl, config.linkPreviews.maxImageBytes);
    // Untergrenzen sind verschieden: ein Vorschaubild soll eine Karte fuellen,
    // ein Symbol nur 20 Pixel breit sein. arduino.cc gibt als og:image ein 1 KB
    // grosses Logo an — als Vorschau ein verpixelter Klecks, als Symbol genau
    // richtig.
    const floor = kind === "icon" ? MIN_ICON_BYTES : MIN_PREVIEW_BYTES;
    if (!image || image.length < floor) throw new Error("image too small");

    // Anhand der ersten Bytes, nicht anhand des gemeldeten Typs: ausgeliefert
    // wird nur, was wirklich ein Bild ist.
    const contentType = sniffImageType(image);
    if (!contentType) throw new Error("not an image");

    await writeFile(path, image);
    await rememberType(key, contentType);
    debugLog("preview", "fetched", { id, kind, bytes: image.length, contentType });
    return { body: image, contentType };
  } catch (err) {
    failed.set(key, Date.now());
    debugLog("preview", "failed", { id, kind, message: (err as Error).message });
    return null;
  }
};

/** Bildformat an der Signatur erkennen. null heisst "kein Bild". */
const sniffImageType = (buf: Buffer): string | null => {
  if (buf.length < 12) return null;
  // Favicons sind haeufig .ico oder .svg. SVG in einem <img> kann keine Skripte
  // ausfuehren, ist an dieser Stelle also unbedenklich.
  if (buf.subarray(0, 4).toString("hex") === "00000100") return "image/x-icon";
  const head = buf.subarray(0, 300).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buf.subarray(4, 8).toString("ascii") === "ftyp" && buf.subarray(8, 12).toString("ascii").startsWith("avif")) {
    return "image/avif";
  }
  return null;
};
