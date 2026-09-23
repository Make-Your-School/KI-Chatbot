// Retrieval over the sqlite-vec knowledge base.
//
// The knowledge.db is built by scripts/embed.ts. This module only reads it.
// If the DB doesn't exist yet (fresh install, embed hasn't run), retrieve()
// returns an empty array and the chat still works without RAG context.

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, statSync } from "node:fs";
import { config } from "./config.ts";
import { debugContentLog, debugLog } from "./debug.ts";
import { embedQuery } from "./embeddings.ts";

let db: Database | null = null;
let dbMtime = 0;

const openDb = (): Database | null => {
  if (!existsSync(config.rag.dbPath)) return null;

  // Reopen if the underlying file has been replaced (e.g. after a re-embed).
  const mtime = statSync(config.rag.dbPath).mtimeMs;
  if (db && mtime === dbMtime) return db;
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }

  const handle = new Database(config.rag.dbPath, { readonly: true, create: false });
  handle.loadExtension(sqliteVec.getLoadablePath());
  db = handle;
  dbMtime = mtime;
  return db;
};

export type Chunk = {
  repo: string;
  path: string;
  repoUrl?: string;
  sourceUrl?: string;
  imageUrl?: string;
  text: string;
  distance: number;
};

const LEGACY_GITHUB_ORG = "Make-Your-School";

const SEARCH_STOPWORDS = new Set([
  "ich", "du", "er", "sie", "es", "wir", "ihr", "habe", "hast", "hat",
  "will", "willst", "wollen", "möchte", "moechte", "nutzen", "benutzen",
  "benutze", "benutzt", "nutze", "verwenden", "verwende", "arbeiten", "starten", "hilfe", "bitte", "noch", "nie",
  "schon", "ein", "eine", "einen", "einem", "einer", "eines", "der",
  "die", "das", "den", "dem", "des", "und", "oder", "aber", "mit",
  "ohne", "für", "fuer", "von", "vom", "im", "in", "am", "an", "auf",
  "zu", "zum", "zur", "wie", "was", "welche", "welcher", "welches",
  "material", "grove", "sensor", "board", "kabel", "arduino", "projekt", "code",
  "sketch", "beispiel", "programm",
]);

const extractMaterialNumber = (query: string): string | null => {
  const match = query.match(/\bmaterial(?:karte)?(?:\s*(?:nr\.?|nummer))?\s*#?\s*(\d{1,4})\b/i);
  return match?.[1] ?? null;
};

const materialNumberPatterns = (materialNumber: string): string[] => {
  const value = escapeLike(materialNumber);
  return [
    `%material_number: ${value}%`,
    `%material_number:${value}%`,
    `%material_number: "${value}"%`,
    `%material_number:"${value}"%`,
    `%material_number: '${value}'%`,
    `%material_number:'${value}'%`,
  ];
};

const extractSearchTerms = (query: string): string[] => {
  const matches = query
    .toLowerCase()
    .replace(/[_./-]+/g, " ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const match of matches) {
    if (match.length < 4) continue;
    if (SEARCH_STOPWORDS.has(match)) continue;
    if (seen.has(match)) continue;
    seen.add(match);
    terms.push(match);
    if (terms.length >= 4) break;
  }

  return terms;
};

const escapeLike = (term: string): string =>
  term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const keywordQuerySql = (withUrls: boolean, termCount: number): string => {
  const scoreParts: string[] = [];
  const whereParts: string[] = [];
  const columns = [
    { name: "chunks.text", weight: 3 },
    { name: "chunks.path", weight: 2 },
    { name: "chunks.repo", weight: 2 },
  ];

  for (let i = 0; i < termCount; i += 1) {
    for (const column of columns) {
      scoreParts.push(
        `CASE WHEN lower(${column.name}) LIKE ? ESCAPE '\\' THEN ${column.weight} ELSE 0 END`
      );
      whereParts.push(`lower(${column.name}) LIKE ? ESCAPE '\\'`);
    }
  }

  const urlColumns = withUrls
    ? ",\n          chunks.repo_url AS repoUrl,\n          chunks.source_url AS sourceUrl,\n          chunks.image_url AS imageUrl"
    : "";

  return `
        SELECT
          chunks.repo,
          chunks.path${urlColumns},
          chunks.text,
          -(${scoreParts.join(" + ")}) AS distance
        FROM chunks
        WHERE ${whereParts.join(" OR ")}
        ORDER BY distance, length(chunks.text)
        LIMIT ?
        `;
};

const queryKeywordRows = (handle: Database, terms: string[], limit: number): Chunk[] => {
  if (terms.length === 0) return [];

  const patterns = terms.map(term => `%${escapeLike(term)}%`);
  const scoreParams = patterns.flatMap(pattern => [pattern, pattern, pattern]);
  const whereParams = patterns.flatMap(pattern => [pattern, pattern, pattern]);

  return handle
    .query(keywordQuerySql(true, terms.length))
    .all(...scoreParams, ...whereParams, limit) as Chunk[];
};

const queryLegacyKeywordRows = (
  handle: Database,
  terms: string[],
  limit: number
): Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">> => {
  if (terms.length === 0) return [];

  const patterns = terms.map(term => `%${escapeLike(term)}%`);
  const scoreParams = patterns.flatMap(pattern => [pattern, pattern, pattern]);
  const whereParams = patterns.flatMap(pattern => [pattern, pattern, pattern]);

  return handle
    .query(keywordQuerySql(false, terms.length))
    .all(...scoreParams, ...whereParams, limit) as Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">>;
};

const queryMaterialNumberRows = (
  handle: Database,
  materialNumber: string
): Chunk[] => {
  const patterns = materialNumberPatterns(materialNumber);
  const whereSql = patterns.map(() => "lower(chunks.text) LIKE lower(?) ESCAPE '\\'").join(" OR ");

  return handle
    .query(
      `
      SELECT
        chunks.repo,
        chunks.path,
        chunks.repo_url AS repoUrl,
        chunks.source_url AS sourceUrl,
        chunks.image_url AS imageUrl,
        chunks.text,
        -1.0 AS distance
      FROM chunks
      WHERE ${whereSql}
      LIMIT 2
      `
    )
    .all(...patterns) as Chunk[];
};

const queryLegacyMaterialNumberRows = (
  handle: Database,
  materialNumber: string
): Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">> => {
  const patterns = materialNumberPatterns(materialNumber);
  const whereSql = patterns.map(() => "lower(chunks.text) LIKE lower(?) ESCAPE '\\'").join(" OR ");

  return handle
    .query(
      `
      SELECT chunks.repo, chunks.path, chunks.text, -1.0 AS distance
      FROM chunks
      WHERE ${whereSql}
      LIMIT 2
      `
    )
    .all(...patterns) as Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">>;
};

const frontmatterField = (text: string, key: string): string | null => {
  const match = text.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  return match?.[1]?.trim() ?? null;
};

const queryRepoFocusedRows = (
  handle: Database,
  repo: string,
  readmePath: string,
  examplePath: string | null,
  limit: number
): Chunk[] => {
  const example = examplePath ?? "";

  return handle
    .query(
      `
      SELECT
        chunks.repo,
        chunks.path,
        chunks.repo_url AS repoUrl,
        chunks.source_url AS sourceUrl,
        chunks.image_url AS imageUrl,
        chunks.text,
        (
          CASE
            WHEN chunks.path = ? AND chunks.text LIKE 'Hilfreiche Links%' THEN -102.0
            WHEN chunks.path = ? AND chunks.text LIKE 'Dokument-Metadaten%' THEN -101.0
            WHEN chunks.path = ? THEN -100.0
            WHEN chunks.path = ? THEN -99.0
            ELSE -10.0
          END
        ) AS distance
      FROM chunks
      WHERE chunks.repo = ?
        AND (chunks.path = ? OR chunks.path = ?)
      ORDER BY distance, length(chunks.text)
      LIMIT ?
      `
    )
    .all(readmePath, readmePath, example, readmePath, repo, readmePath, example, limit) as Chunk[];
};

const queryLegacyRepoFocusedRows = (
  handle: Database,
  repo: string,
  readmePath: string,
  examplePath: string | null,
  limit: number
): Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">> => {
  const example = examplePath ?? "";

  return handle
    .query(
      `
      SELECT
        chunks.repo,
        chunks.path,
        chunks.text,
        (
          CASE
            WHEN chunks.path = ? AND chunks.text LIKE 'Hilfreiche Links%' THEN -102.0
            WHEN chunks.path = ? AND chunks.text LIKE 'Dokument-Metadaten%' THEN -101.0
            WHEN chunks.path = ? THEN -100.0
            WHEN chunks.path = ? THEN -99.0
            ELSE -10.0
          END
        ) AS distance
      FROM chunks
      WHERE chunks.repo = ?
        AND (chunks.path = ? OR chunks.path = ?)
      ORDER BY distance, length(chunks.text)
      LIMIT ?
      `
    )
    .all(readmePath, readmePath, example, readmePath, repo, readmePath, example, limit) as Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">>;
};

const deriveRepoFocus = (
  exactRows: Array<{ repo: string; path: string; text: string }>
): { repo: string; readmePath: string; examplePath: string | null } | null => {
  const base = exactRows[0];
  if (!base) return null;
  return {
    repo: base.repo,
    readmePath: base.path,
    examplePath: frontmatterField(base.text, "embedded_example_file"),
  };
};

const querySemanticRows = (
  handle: Database,
  vecBuf: Uint8Array,
  limit: number
): Chunk[] =>
  handle
    .query(
      `
      SELECT
        chunks.repo,
        chunks.path,
        chunks.repo_url AS repoUrl,
        chunks.source_url AS sourceUrl,
        chunks.image_url AS imageUrl,
        chunks.text,
        vec.distance
      FROM vec_chunks AS vec
      JOIN chunks ON chunks.rowid = vec.rowid
      WHERE vec.embedding MATCH ? AND k = ?
      ORDER BY vec.distance
      `
    )
    .all(vecBuf, limit) as Chunk[];

const queryLegacySemanticRows = (
  handle: Database,
  vecBuf: Uint8Array,
  limit: number
): Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">> =>
  handle
    .query(
      `
      SELECT chunks.repo, chunks.path, chunks.text, vec.distance
      FROM vec_chunks AS vec
      JOIN chunks ON chunks.rowid = vec.rowid
      WHERE vec.embedding MATCH ? AND k = ?
      ORDER BY vec.distance
      `
    )
    .all(vecBuf, limit) as Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">>;

const mergeChunks = (limit: number, ...chunkSets: Chunk[][]): Chunk[] => {
  const merged: Chunk[] = [];
  const seen = new Set<string>();

  for (const chunkSet of chunkSets) {
    for (const chunk of chunkSet) {
      const key = `${chunk.repo}\u0000${chunk.path}\u0000${chunk.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(chunk);
      if (merged.length >= limit) return merged;
    }
  }

  return merged;
};

const legacyRepoUrl = (repo: string): string =>
  `https://github.com/${LEGACY_GITHUB_ORG}/${repo}`;

const summarizeChunk = (chunk: Chunk) => ({
  repo: chunk.repo,
  path: chunk.path,
  distance: Number.isFinite(chunk.distance) ? Number(chunk.distance.toFixed(4)) : chunk.distance,
  hasRepoUrl: !!chunk.repoUrl,
  hasSourceUrl: !!chunk.sourceUrl,
  hasImageUrl: !!chunk.imageUrl,
});

const logRetrieveResult = (
  query: string,
  materialNumber: string | null,
  searchTerms: string[],
  exactRows: Chunk[],
  focusedRows: Chunk[],
  keywordRows: Chunk[],
  semanticRows: Chunk[],
  mergedRows: Chunk[],
  usedLegacySchema: boolean
): void => {
  debugLog("rag", "retrieve result", {
    usedLegacySchema,
    materialNumber,
    searchTerms,
    exactCount: exactRows.length,
    focusedCount: focusedRows.length,
    keywordCount: keywordRows.length,
    semanticCount: semanticRows.length,
    mergedCount: mergedRows.length,
  });
  debugLog("rag", "selected chunks", mergedRows.map(summarizeChunk));
  debugContentLog("rag", "query", query);
  mergedRows.forEach((chunk, index) => {
    debugContentLog("rag", `chunk ${index + 1} ${chunk.repo}/${chunk.path}`, chunk.text);
  });
};

export const retrieve = async (
  query: string,
  k = config.rag.topK
): Promise<Chunk[]> => {
  const handle = openDb();
  if (!handle) {
    console.warn("[rag] knowledge db not available — returning no context");
    debugLog("rag", "knowledge db not available", { dbPath: config.rag.dbPath });
    return [];
  }

  const vec = await embedQuery(query);
  const vecBuf = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  const materialNumber = extractMaterialNumber(query);
  const searchTerms = extractSearchTerms(query);
  debugLog("rag", "retrieve start", {
    topK: k,
    queryChars: query.length,
    materialNumber,
    searchTerms,
  });

  try {
    const exactRows = materialNumber
      ? queryMaterialNumberRows(handle, materialNumber)
      : [];
    const repoFocus = deriveRepoFocus(exactRows);
    const focusedRows = repoFocus
      ? queryRepoFocusedRows(handle, repoFocus.repo, repoFocus.readmePath, repoFocus.examplePath, k)
      : [];
    const keywordRows = queryKeywordRows(handle, searchTerms, k);

    let rows: Chunk[] = [];
    try {
      rows = querySemanticRows(handle, vecBuf, k);
    } catch (semanticErr) {
      const message = (semanticErr as Error).message;
      if (message.includes("repo_url") || message.includes("source_url") || message.includes("image_url")) {
        throw semanticErr;
      }
      console.error("[rag] semantic query failed:", message);
      debugLog("rag", "semantic query failed, using exact/keyword rows only", { message });
    }

    const merged = mergeChunks(k, exactRows, focusedRows, keywordRows, rows);
    logRetrieveResult(
      query,
      materialNumber,
      searchTerms,
      exactRows,
      focusedRows,
      keywordRows,
      rows,
      merged,
      false
    );
    return merged;
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes("repo_url") && !message.includes("source_url") && !message.includes("image_url")) {
      console.error("[rag] query failed:", message);
      debugLog("rag", "retrieve failed before legacy fallback", { message });
      return [];
    }

    try {
      const exactRows = materialNumber
        ? queryLegacyMaterialNumberRows(handle, materialNumber)
        : [];
      const repoFocus = deriveRepoFocus(exactRows);
      const focusedRows = repoFocus
        ? queryLegacyRepoFocusedRows(handle, repoFocus.repo, repoFocus.readmePath, repoFocus.examplePath, k)
        : [];
      const keywordRows = queryLegacyKeywordRows(handle, searchTerms, k);

      let rows: Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">> = [];
      try {
        rows = queryLegacySemanticRows(handle, vecBuf, k);
      } catch (semanticErr) {
        const semanticMessage = (semanticErr as Error).message;
        console.error("[rag] legacy semantic query failed:", semanticMessage);
        debugLog("rag", "legacy semantic query failed, using exact/keyword rows only", {
          message: semanticMessage,
        });
      }

      const merged = mergeChunks(
        k,
        exactRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        focusedRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        keywordRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        rows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined }))
      );
      logRetrieveResult(
        query,
        materialNumber,
        searchTerms,
        exactRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        focusedRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        keywordRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        rows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined })),
        merged,
        true
      );
      return merged;
    } catch (legacyErr) {
      console.error("[rag] query failed:", (legacyErr as Error).message);
      debugLog("rag", "legacy retrieve failed", { message: (legacyErr as Error).message });
      return [];
    }
  }
};

// --- Whole-file lookup ------------------------------------------------------
//
// Chunks are blind fixed-size slices of a file (see scripts/embed.ts), so a
// single chunk is almost never a usable code sample — it starts and ends
// mid-statement. For the "Beispielcode" card we therefore reassemble the whole
// file from its chunks in insert order.
//
// The overlap between consecutive chunks is detected rather than hardcoded, so
// this keeps working if CHUNK_OVERLAP in the embed script ever changes.

const MAX_OVERLAP_PROBE = 1000;

const joinOverlappingChunks = (parts: string[]): string => {
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 1) {
    const next = parts[i];
    const max = Math.min(MAX_OVERLAP_PROBE, out.length, next.length);
    let overlap = 0;
    for (let len = max; len > 0; len -= 1) {
      if (out.endsWith(next.slice(0, len))) {
        overlap = len;
        break;
      }
    }
    out += next.slice(overlap);
  }
  return out;
};

/** Full text of one embedded file, or null if it isn't in the index. */
export const loadFileText = (repo: string, path: string): string | null => {
  try {
    // openDb() is inside the try on purpose: it can throw (missing sqlite-vec,
    // a DB replaced mid-read). A failed example card must never take down the
    // whole chat response — the caller falls back to the raw chunk.
    const handle = openDb();
    if (!handle) return null;

    const rows = handle
      .prepare("SELECT text FROM chunks WHERE repo = ? AND path = ? ORDER BY rowid")
      .all(repo, path) as Array<{ text: string }>;
    if (rows.length === 0) return null;
    return joinOverlappingChunks(rows.map(r => r.text));
  } catch (err) {
    debugLog("rag", "loadFileText failed", { repo, path, message: (err as Error).message });
    return null;
  }
};

export const formatContext = (chunks: Chunk[]): string => {
  if (chunks.length === 0) return "";
  return chunks
    .map((c, i) => {
      const link = c.sourceUrl ?? c.repoUrl;
      const linkLine = link ? `GitHub-Link: ${link}\n` : "";
      return `[${i + 1}] Quelle: ${c.repo}/${c.path}\n${linkLine}${c.text}`;
    })
    .join("\n\n---\n\n");
};
