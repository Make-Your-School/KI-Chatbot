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

/**
 * Wodurch ein Chunk gefunden wurde.
 *
 * Wichtig fuer den Aufrufer: "exact" und "keyword" heissen, dass die Person das
 * Bauteil beim Namen oder bei der Materialnummer genannt hat. "semantic" heisst
 * nur "passt thematisch irgendwie". Ohne diese Unterscheidung muss man aus der
 * Trefferzahl raten, wie wichtig ein Repo ist — und dabei verliert genau das
 * Repo, das die Stichwortsuche mit einem einzigen, sehr guten Treffer liefert.
 */
export type ChunkMatch = "exact" | "focused" | "keyword" | "semantic";

export type Chunk = {
  repo: string;
  path: string;
  repoUrl?: string;
  sourceUrl?: string;
  imageUrl?: string;
  text: string;
  distance: number;
  match: ChunkMatch;
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
  "material", "grove", "sensor", "board", "kabel", "projekt", "code",
  "sketch", "beispiel", "programm",
]);

// "arduino" steht bewusst NICHT in der Liste oben. Es kommt zwar in fast jedem
// Repo-Text vor, aber nur in drei Repo-NAMEN — und genau die (mks-Arduino-UNO_R3,
// mks-Arduino-UNO_R4_WiFi, mys_arduino_metalibrary) sind bei einer Einsteiger-
// frage wie "ich habe noch nie mit Arduino gearbeitet" die richtige Antwort.
// Die Gewichtung unten sorgt dafuer, dass ein Namenstreffer eine beilaeufige
// Erwaehnung im Text klar schlaegt.

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

// Stichwortsuche: "hat die Person ein Bauteil beim Namen genannt?"
//
// Nicht zu verwechseln mit der Bedeutungssuche weiter unten. Hier geht es nur
// um den Fall, dass ein Wort aus der Frage auf ein Repo zeigt. Deshalb zaehlt
// der Repo-Name am meisten, der Pfad etwas und der Fliesstext fast nichts:
// "Arduino" steht in fast jedem Text, aber nur in drei Repo-Namen.
const SCORE_REPO = 4;
const SCORE_PATH = 2;
const SCORE_TEXT = 1;

// Die Startseite eines Repos ist fast immer die bessere Antwort als eine tief
// verschachtelte Beispiel-Doku. Ohne diesen Bonus gewann bei "wie fange ich mit
// Arduino an" examples/dev/UNO_R4_WiFi-Bluetooth_DroidPad/readme.md gegen die
// eigentliche readme.md des Boards.
const SCORE_ROOT_README = 2;

// Ab hier gilt ein Treffer als gemeint und nicht als Zufall. 5 heisst in der
// Praxis: der Repo-Name selbst wurde getroffen (4) und noch irgendetwas dazu.
// Ein blosser Texttreffer reicht nicht mehr — genau der hat frueher bei "wie
// starte ich am einfachsten" die kurzen *_minimal.ino-Dateien nach oben
// gespuelt und alles andere verdraengt. Was hier durchfaellt, ist nicht
// verloren: die Bedeutungssuche bekommt den Platz.
const KEYWORD_SCORE_FLOOR = 5;

// Wie viele der k Plaetze die Stichwortsuche hoechstens belegen darf. Sie steht
// im Merge vor der Bedeutungssuche, durfte vorher alle Plaetze belegen und
// konnte damit die Bedeutungssuche komplett aushebeln. Die Haelfte reservieren
// heisst: ein klarer Namenstreffer kommt immer durch, ersetzt aber nie das
// inhaltliche Suchen.
const keywordBudget = (k: number): number => Math.max(1, Math.floor(k / 2));

const ROOT_README_BONUS = `CASE WHEN lower(chunks.path) = 'readme.md' THEN ${SCORE_ROOT_README} ELSE 0 END`;

const readmeOrder = (pathExpr: string): string =>
  `CASE WHEN lower(${pathExpr}) = 'readme.md' THEN 0 ` +
  `WHEN lower(${pathExpr}) LIKE '%readme.md' THEN 1 ELSE 2 END`;

const keywordQuerySql = (withUrls: boolean, termCount: number): string => {
  const scoreParts: string[] = [];
  const whereParts: string[] = [];
  const columns = [
    { name: "chunks.repo", weight: SCORE_REPO },
    { name: "chunks.path", weight: SCORE_PATH },
    { name: "chunks.text", weight: SCORE_TEXT },
  ];

  for (let i = 0; i < termCount; i += 1) {
    for (const column of columns) {
      scoreParts.push(
        `CASE WHEN lower(${column.name}) LIKE ? ESCAPE '\\' THEN ${column.weight} ELSE 0 END`
      );
      whereParts.push(`lower(${column.name}) LIKE ? ESCAPE '\\'`);
    }
  }
  scoreParts.push(ROOT_README_BONUS);

  const score = `-(${scoreParts.join(" + ")})`;
  const urlColumns = withUrls
    ? ",\n          chunks.repo_url AS repoUrl,\n          chunks.source_url AS sourceUrl,\n          chunks.image_url AS imageUrl"
    : "";
  const urlPassthrough = withUrls ? ", repoUrl, sourceUrl, imageUrl" : "";

  // ROW_NUMBER statt "einfach viele Zeilen holen und in JS entdoppeln": ein
  // gut passendes Repo liefert readme + Metadaten + Links-Block + Beispiele und
  // wuerde sonst das ganze Budget allein fuellen. So ist pro Repo genau eine
  // Zeile im Spiel, und zwar die beste.
  return `
        SELECT repo, path, text, distance${urlPassthrough}
        FROM (
          SELECT
            chunks.repo,
            chunks.path${urlColumns},
            chunks.text,
            ${score} AS distance,
            ROW_NUMBER() OVER (
              PARTITION BY chunks.repo
              ORDER BY ${score}, ${readmeOrder("chunks.path")}, length(chunks.text)
            ) AS rank_in_repo
          FROM chunks
          WHERE ${whereParts.join(" OR ")}
        )
        WHERE rank_in_repo = 1 AND distance <= ${-KEYWORD_SCORE_FLOOR}
        ORDER BY distance, ${readmeOrder("path")}, length(text)
        LIMIT ?
        `;
};

const keywordParams = (terms: string[]): string[] => {
  const patterns = terms.map(term => `%${escapeLike(term)}%`);
  // Dieselbe Musterliste dreimal: SELECT-Score, ORDER BY des Fensters, WHERE.
  // SQLite kann im Fenster-ORDER-BY den Alias nicht wiederverwenden, deshalb
  // steht der Score dort ein zweites Mal woertlich im SQL.
  const score = patterns.flatMap(pattern => [pattern, pattern, pattern]);
  return [...score, ...score, ...score];
};

const queryKeywordRows = (handle: Database, terms: string[], limit: number): Chunk[] => {
  if (terms.length === 0) return [];
  return handle
    .query(keywordQuerySql(true, terms.length))
    .all(...keywordParams(terms), limit) as Chunk[];
};

const queryLegacyKeywordRows = (
  handle: Database,
  terms: string[],
  limit: number
): Array<Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">> => {
  if (terms.length === 0) return [];
  return handle
    .query(keywordQuerySql(false, terms.length))
    .all(...keywordParams(terms), limit) as Array<
      Omit<Chunk, "repoUrl" | "sourceUrl" | "imageUrl">
    >;
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

/** Haengt an jede Zeile dran, aus welcher Suche sie stammt. */
const tagMatch = <T>(rows: T[], match: ChunkMatch): Array<T & { match: ChunkMatch }> =>
  rows.map(row => ({ ...row, match }));

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
    const exactRows = tagMatch(
      materialNumber ? queryMaterialNumberRows(handle, materialNumber) : [],
      "exact"
    );
    const repoFocus = deriveRepoFocus(exactRows);
    const focusedRows = tagMatch(
      repoFocus
        ? queryRepoFocusedRows(handle, repoFocus.repo, repoFocus.readmePath, repoFocus.examplePath, k)
        : [],
      "focused"
    );
    const keywordRows = tagMatch(queryKeywordRows(handle, searchTerms, keywordBudget(k)), "keyword");

    let rows: Chunk[] = [];
    try {
      rows = tagMatch(querySemanticRows(handle, vecBuf, k), "semantic");
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
      const keywordRows = queryLegacyKeywordRows(handle, searchTerms, keywordBudget(k));

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
        exactRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "exact" as ChunkMatch })),
        focusedRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "focused" as ChunkMatch })),
        keywordRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "keyword" as ChunkMatch })),
        rows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "semantic" as ChunkMatch }))
      );
      logRetrieveResult(
        query,
        materialNumber,
        searchTerms,
        exactRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "exact" as ChunkMatch })),
        focusedRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "focused" as ChunkMatch })),
        keywordRows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "keyword" as ChunkMatch })),
        rows.map(row => ({ ...row, repoUrl: legacyRepoUrl(row.repo), imageUrl: undefined, match: "semantic" as ChunkMatch })),
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

/**
 * Das Titelbild eines Repos — unabhaengig davon, welcher Chunk gerade gefunden
 * wurde.
 *
 * Vorher kam das Bild aus dem abgerufenen Chunk selbst. image_url ist aber nur
 * bei Markdown-Chunks gesetzt: wurde von einem Repo gerade die .ino-Datei
 * gefunden, gab es kein Bild — obwohl die readme.md des Repos eines hat. Das
 * Titelbild gehoert zum Bauteil, nicht zum Textausschnitt.
 *
 * Kuerzester Pfad zuerst: das ist die readme.md im Wurzelverzeichnis und damit
 * das Foto des Bauteils, nicht ein Aufbau-Screenshot aus einem Beispielordner.
 */
export const repoCoverImage = (repo: string): string | null => {
  const handle = openDb();
  if (!handle) return null;
  try {
    const row = handle
      .query(
        `SELECT image_url AS imageUrl
         FROM chunks
         WHERE repo = ? AND image_url IS NOT NULL AND image_url <> ''
         ORDER BY length(path), path
         LIMIT 1`
      )
      .get(repo) as { imageUrl?: string } | undefined;
    return row?.imageUrl ?? null;
  } catch {
    // Aeltere Datenbanken haben die Spalte nicht — dann eben kein Bild.
    return null;
  }
};

/**
 * Die Eckdaten eines Bauteils: Name, Schwierigkeit, Status, Materialnummer.
 *
 * Wie repoCoverImage() eine Eigenschaft des REPOS, nicht des gefundenen
 * Textausschnitts. Diese Angaben stehen im YAML-Frontmatter und landen beim
 * Einbetten in einem eigenen "Dokument-Metadaten"-Chunk. Ob der bei einer Frage
 * zufaellig mit abgerufen wird, ist Glueckssache — fuer einen Vergleich zweier
 * Bauteile muessen sie aber sicher da sein.
 */
export type RepoFacts = {
  repo: string;
  title?: string;
  /** Kurzbeschreibung, oft praeziser als title ("Arduino UNO R3" statt "Arduino UNO"). */
  shortDescr?: string;
  /** recommend | advanced | expert — die Leiter aus dem Frontmatter. */
  difficulty?: string;
  /** active | deprecated | EOL. */
  status?: string;
  materialNumber?: string;
  /** Adresse des Repos auf GitHub. */
  repoUrl?: string;
  /** Titelbild des Bauteils. */
  imageUrl?: string;
};

const FACT_KEYS = [
  ["title", "title"],
  ["material_short_descr", "shortDescr"],
  ["difficulty", "difficulty"],
  ["status", "status"],
  ["material_number", "materialNumber"],
] as const;

export const repoFacts = (repo: string): RepoFacts | null => {
  const handle = openDb();
  if (!handle) return null;
  try {
    const row = handle
      .query(
        `SELECT text, repo_url AS repoUrl FROM chunks
         WHERE repo = ? AND text LIKE 'Dokument-Metadaten%'
         ORDER BY length(path), path
         LIMIT 1`
      )
      .get(repo) as { text?: string; repoUrl?: string } | undefined;
    if (!row?.text) return null;

    const facts: RepoFacts = {
      repo,
      repoUrl: row.repoUrl || undefined,
      imageUrl: repoCoverImage(repo) ?? undefined,
    };
    for (const [key, field] of FACT_KEYS) {
      const match = row.text.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
      const value = match?.[1]?.trim();
      if (value) facts[field] = value;
    }
    return facts;
  } catch {
    return null;
  }
};

/**
 * Alle externen Adressen, die in den eingebetteten Repos verlinkt sind.
 *
 * Dient als Erlaubnisliste fuer die Link-Vorschauen: der Server holt nur
 * Seiten, die ohnehin schon in der Projektdokumentation stehen. Ohne diese
 * Liste waere der Vorschau-Endpunkt ein offener Abrufdienst, mit dem sich von
 * aussen beliebige Adressen ueber diesen Server aufrufen liessen.
 */
export const listLinkUrls = (): string[] => {
  const handle = openDb();
  if (!handle) return [];
  try {
    const rows = handle
      .query("SELECT text FROM chunks WHERE text LIKE 'Hilfreiche Links%'")
      .all() as Array<{ text: string }>;
    const urls = new Set<string>();
    for (const row of rows) {
      for (const match of row.text.matchAll(/https?:\/\/[^\s<>")]+/g)) {
        urls.add(match[0].replace(/[.,;:]+$/, ""));
      }
    }
    return [...urls];
  } catch {
    return [];
  }
};
