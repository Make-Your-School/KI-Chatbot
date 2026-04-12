// Provider-Modell-Listen mit Live-Reload.
//
// Beide Provider haben eine git-versionierte Modell-Liste unter
// server/models/<provider>.txt. Die Datei wird bei jedem Aufruf gestat()ed
// und nur bei mtime-Änderung neu eingelesen — d.h. live editierbar (oder
// per `git pull` aktualisierbar) ohne Service-Restart.
//
// Format der Listendatei:
//   - Eine Modell-ID pro Zeile, in Fallback-Reihenfolge
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

type Cache = { models: string[]; mtime: number; warnedMissing: boolean };

const caches: Record<Provider, Cache> = {
  openrouter: { models: HARDCODED_FALLBACK.openrouter, mtime: -1, warnedMissing: false },
  gemini: { models: HARDCODED_FALLBACK.gemini, mtime: -1, warnedMissing: false },
};

const parseFile = (content: string): string[] =>
  content
    .split("\n")
    .map((line: string) => {
      const hash = line.indexOf("#");
      return (hash >= 0 ? line.slice(0, hash) : line).trim();
    })
    .filter((line: string) => line.length > 0);

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
      cache.mtime = -1;
      return cache.models;
    }

    cache.warnedMissing = false;
    const mtime = statSync(path).mtimeMs;
    if (mtime === cache.mtime) return cache.models;

    const parsed = parseFile(readFileSync(path, "utf8"));
    if (parsed.length === 0) {
      console.warn(
        `[models] ${path} is empty — using hardcoded fallback (${HARDCODED_FALLBACK[provider].join(", ")})`
      );
      cache.models = HARDCODED_FALLBACK[provider];
      cache.mtime = mtime;
      return cache.models;
    }

    cache.models = parsed;
    cache.mtime = mtime;
    console.log(
      `[models] reloaded ${parsed.length} ${provider} model(s) from ${path}: ${parsed.join(", ")}`
    );
    return cache.models;
  } catch (err) {
    console.error(`[models] failed to read ${path}:`, err);
    return cache.models;
  }
}
