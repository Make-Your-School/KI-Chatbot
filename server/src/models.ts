// Provider-Modell-Listen mit Live-Reload.
//
// Beide Provider haben eine git-versionierte Modell-Liste unter
// server/models/<provider>.txt. Die Datei wird bei jedem Aufruf gestat()ed
// und nur bei mtime-Änderung neu eingelesen — d.h. live editierbar (oder
// per `git pull` aktualisierbar) ohne Service-Restart.
//
// Format der Listendatei:
//   - Eine Modell-ID pro Zeile, in Fallback-Reihenfolge
//   - Optional dahinter, durch Leerzeichen getrennt, das Tageslimit des
//     Anbieters für dieses Modell ("gemini-3.5-flash-lite 1000"). Das ist eine
//     reine Anzeige für /stats — der Server bremst NICHT danach. Das Limit
//     gehört dem Anbieter, nicht uns: wer es kennt, sieht auf der Statistik,
//     wie nah der Tag daran ist, statt es erst am 429 zu merken. Selbst
//     bremsen wäre falsch, weil wir damit ein Modell aussperren würden, das
//     beim Anbieter noch Luft hat.
//   - `#` kommentiert den Rest der Zeile aus, Leerzeilen werden ignoriert
//
// Wenn die Datei fehlt oder leer ist, fällt der Server auf einen
// hardcodierten Default zurück, damit er nicht abstürzt — sollte aber
// in der Praxis nie passieren, weil die Listen committed sind.

import { existsSync, statSync, readFileSync } from "fs";
import { resolve } from "path";

export type Provider = "openrouter" | "gemini";

const MODELS_DIR = process.env.MODELS_DIR ?? "./models";

// Last-resort wenn die Datei verschwindet. Niemals die einzige Quelle der
// Wahrheit, sondern nur ein Sicherheitsnetz.
const HARDCODED_FALLBACK: Record<Provider, string[]> = {
  openrouter: ["meta-llama/llama-3.3-70b-instruct:free"],
  gemini: ["gemini-2.5-flash", "gemini-2.0-flash"],
};

type Cache = {
  models: string[];
  /** Modell-ID -> Tageslimit des Anbieters, nur für die Modelle, die eins haben. */
  limits: Map<string, number>;
  mtime: number;
  warnedMissing: boolean;
};

const emptyCache = (provider: Provider): Cache => ({
  models: HARDCODED_FALLBACK[provider],
  limits: new Map(),
  mtime: -1,
  warnedMissing: false,
});

const caches: Record<Provider, Cache> = {
  openrouter: emptyCache("openrouter"),
  gemini: emptyCache("gemini"),
};

type ParsedList = { models: string[]; limits: Map<string, number> };

const parseFile = (content: string): ParsedList => {
  const models: string[] = [];
  const limits = new Map<string, number>();

  for (const raw of content.split("\n")) {
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (line.length === 0) continue;

    // "modell-id" oder "modell-id 1000". Alles hinter dem zweiten Feld wird
    // ignoriert — eine Zahl, die keine ist, wird stillschweigend verworfen und
    // das Modell bleibt ohne Limit. Ein Tippfehler im Limit darf nicht dazu
    // führen, dass das Modell aus der Fallback-Liste verschwindet.
    const [id, rawLimit] = line.split(/\s+/, 2);
    models.push(id);
    const limit = Number(rawLimit);
    if (Number.isInteger(limit) && limit > 0) limits.set(id, limit);
  }

  return { models, limits };
};

export const modelsFilePath = (provider: Provider): string =>
  resolve(MODELS_DIR, `${provider}.txt`);

/**
 * Returns the current list of model IDs for a provider in fallback order.
 * Hot-reloads from disk if the file's mtime changed since the last call.
 */
export function getModels(provider: Provider): string[] {
  const path = modelsFilePath(provider);
  const cache = caches[provider];

  try {
    if (!existsSync(path)) {
      if (!cache.warnedMissing) {
        console.warn(
          `[models] ${path} not found — using hardcoded fallback (${HARDCODED_FALLBACK[provider].join(", ")})`
        );
        cache.warnedMissing = true;
      }
      cache.models = HARDCODED_FALLBACK[provider];
      cache.limits = new Map();
      cache.mtime = -1;
      return cache.models;
    }

    cache.warnedMissing = false;
    const mtime = statSync(path).mtimeMs;
    if (mtime === cache.mtime) return cache.models;

    const parsed = parseFile(readFileSync(path, "utf8"));
    if (parsed.models.length === 0) {
      console.warn(
        `[models] ${path} is empty — using hardcoded fallback (${HARDCODED_FALLBACK[provider].join(", ")})`
      );
      cache.models = HARDCODED_FALLBACK[provider];
      cache.limits = new Map();
      cache.mtime = mtime;
      return cache.models;
    }

    cache.models = parsed.models;
    cache.limits = parsed.limits;
    cache.mtime = mtime;
    console.log(
      `[models] reloaded ${parsed.models.length} ${provider} model(s) from ${path}: ${parsed.models.join(", ")}`
    );
    return cache.models;
  } catch (err) {
    console.error(`[models] failed to read ${path}:`, err);
    return cache.models;
  }
}

/**
 * Die eingetragenen Tageslimits, über beide Anbieter zusammengelegt.
 *
 * Modell-IDs kollidieren zwischen den Anbietern nicht (OpenRouter hängt immer
 * ein "anbieter/" davor), deshalb reicht eine Map. getModels() vorher aufrufen
 * erledigt das Nachladen bei geänderter Datei — der Cache ist derselbe.
 */
export const getModelLimits = (): Map<string, number> => {
  const all = new Map<string, number>();
  for (const provider of ["gemini", "openrouter"] as Provider[]) {
    getModels(provider);
    for (const [id, limit] of caches[provider].limits) all.set(id, limit);
  }
  return all;
};
