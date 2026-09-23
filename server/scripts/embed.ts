// Nightly embedding pipeline.
//
// 1. Fetch list of public repos from the Make-Your-School GitHub org
// 2. git clone --depth=1 (or fetch+reset if already cloned) into ./data/repos
// 3. Walk text files, chunk, embed with local multilingual-e5-small
// 4. Write rows into a temporary sqlite-vec DB
// 5. Atomically rename into place
//
// Run manually:   bun scripts/embed.ts
// Scheduled:      systemd timer (see deploy/ki-hackdays-embed.timer)
//
// After a successful run the chat service should be restarted so it picks up
// the new DB — the systemd unit handles this via ExecStartPost.

import { readdir, readFile, mkdir, rename, unlink, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, relative, extname, posix } from "node:path";
import { execSync } from "node:child_process";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { embedPassage } from "../src/embeddings.ts";
import { config } from "../src/config.ts";

const GITHUB_ORG = "Make-Your-School";

// Repos der Organisation, die kein Hackday-Material sind.
//
// KI-Chatbot ist dieses Projekt selbst und war mit 257 Chunks der groesste
// Posten im ganzen Index — 12 Prozent des Wissens waren TypeScript, Deploy-
// Anleitungen und diese Datei hier. Das kann bei jeder Frage als Treffer
// auftauchen; genau deswegen musste die Beispielcode-Karte in chat.ts auf
// .ino/.c/.cpp/.h eingeengt werden, sonst servierte sie den eigenen
// Serverquelltext als "Arduino-Beispiel".
//
// .github traegt nur Organisationsvorlagen (Issue-Templates, Profiltext).
//
// MiniHackIdeas bleibt bewusst drin: das sind echte Projektideen fuer
// Schueler*innen, die frueh fertig sind.
const SKIP_REPOS = new Set(["KI-Chatbot", ".github"]);
const REPO_CACHE = process.env.REPO_CACHE ?? "./data/repos";
const WORK_DB = config.rag.dbPath + ".tmp";
const FINAL_DB = config.rag.dbPath;

// Was eingebettet wird: Doku und Bauteil-Code. Sonst nichts.
//
// Gemessen am 23.09.2026 ueber alle 83 Repos: mit .json/.js/.ts/.html/.css/.yml
// bestanden 1279 von 2218 Chunks — also 58 Prozent des gesamten Wissens — aus
// Quelltext und Konfiguration von Webprojekten. Allein mks-welcome/tools/meta.json,
// ein Build-Artefakt der Projektwebseite, war mit 658 Chunks fast ein Drittel
// des Index.
//
// Der Verlust ist messbar klein: von den 935 Web-/Config-Chunks stammten 929 aus
// mks-welcome, die restlichen 6 verteilten sich auf vier Material-Repos. Kein
// einziges Arduino- oder Calliope-Beispiel haengt daran.
//
// Das ist nicht nur Platzverschwendung: die Bedeutungssuche vergibt pro Frage
// genau RAG_TOP_K Plaetze, und jeder Chunk Webquelltext konkurriert darin mit
// echten Bauteil-Dokus.
//
// .py bleibt drin — die Raspberry-Pi-Repos koennten Python-Beispiele bekommen,
// und aktuell kostet es genau einen Chunk.
const TEXT_EXTS = new Set([
  ".md", ".mdx", ".txt", ".rst",
  ".ino", ".c", ".cpp", ".h", ".py",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__", ".next", ".cache",
]);
const MAX_FILE_BYTES = 500_000;
const MIN_CONTENT_CHARS = 50;

// Rough character-based chunking. Not perfect, but fine for semantic retrieval
// with an overlap that preserves context across boundaries.
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

// --- GitHub repo listing ---------------------------------------------------

type Repo = {
  name: string;
  clone_url: string;
  default_branch: string;
  archived: boolean;
  fork: boolean;
};

/** Loescht eine sqlite-Datei samt ihrer Begleitdateien -wal und -shm. */
const removeDbFiles = async (path: string): Promise<void> => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) await unlink(path + suffix);
  }
};

const repoUrl = (repo: Repo): string => repo.clone_url.replace(/\.git$/, "");

const repoFilePath = (repoDir: string, filePath: string): string =>
  relative(repoDir, filePath).replace(/\\/g, "/");

const encodeRepoPath = (relPath: string): string =>
  relPath
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");

const sourceUrl = (repo: Repo, relPath: string): string =>
  `${repoUrl(repo)}/blob/${repo.default_branch}/${encodeRepoPath(relPath)}`;

const rawBaseUrl = (repo: Repo): string =>
  repoUrl(repo).replace("https://github.com/", "https://raw.githubusercontent.com/");

const rawFileUrl = (repo: Repo, relPath: string): string =>
  `${rawBaseUrl(repo)}/${repo.default_branch}/${encodeRepoPath(relPath)}`;

const listRepos = async (): Promise<Repo[]> => {
  const out: Repo[] = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=100&page=${page}&type=public`;
    const headers: Record<string, string> = {
      "User-Agent": "mys-chat-embed",
      Accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
    }
    const batch = (await resp.json()) as Repo[];
    if (batch.length === 0) break;
    out.push(...batch.filter(r => !r.archived && !r.fork && !SKIP_REPOS.has(r.name)));
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
};

// --- Git sync --------------------------------------------------------------

const syncRepo = (repo: Repo) => {
  const target = join(REPO_CACHE, repo.name);
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

  if (existsSync(join(target, ".git"))) {
    try {
      execSync(
        `git -C ${q(target)} fetch --depth=1 origin ${repo.default_branch}`,
        { stdio: "pipe" }
      );
      execSync(
        `git -C ${q(target)} reset --hard origin/${repo.default_branch}`,
        { stdio: "pipe" }
      );
      return;
    } catch {
      // Fall through to re-clone
      execSync(`rm -rf ${q(target)}`);
    }
  }
  execSync(`git clone --depth=1 ${q(repo.clone_url)} ${q(target)}`, { stdio: "pipe" });
};

// --- File walk --------------------------------------------------------------

async function* walkText(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walkText(p);
    } else if (entry.isFile()) {
      if (!TEXT_EXTS.has(extname(entry.name).toLowerCase())) continue;
      try {
        const info = await stat(p);
        if (info.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      yield p;
    }
  }
}

// --- Chunking ---------------------------------------------------------------

const chunkText = (text: string): string[] => {
  const cleaned = text.replace(/\r\n/g, "\n");
  if (cleaned.length <= CHUNK_SIZE) return [cleaned];
  const chunks: string[] = [];
  let i = 0;
  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  while (i < cleaned.length) {
    chunks.push(cleaned.slice(i, i + CHUNK_SIZE));
    i += step;
  }
  return chunks;
};

const splitFrontmatter = (content: string): { frontmatter: string; body: string } | null => {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return null;

  const frontmatter = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 5).trim();
  if (!frontmatter) return null;
  return { frontmatter, body };
};

type LinkEntry = {
  label: string;
  url: string;
};

type ImageEntry = {
  alt: string;
  url: string;
};

const frontmatterValue = (frontmatter: string, key: string): string | null => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  return match?.[1]?.trim() ?? null;
};

const normalizeLinkUrl = (url: string): string => url.replace(/\.git$/, "");

const frontmatterUrlLabel = (key: string): string => {
  if (key === "clone_url") return "GitHub-Repo";
  if (key === "product_url") return "Produktseite";
  if (key === "manufacture_url") return "Herstellerseite";
  return key.replaceAll("_", " ");
};

const classifyBodyUrl = (label: string, url: string): string => {
  if (/youtu\.be|youtube\.com/i.test(url)) {
    if (!label || /^youtube$/i.test(label)) return "Video";
    return `Video: ${label}`;
  }
  if (/github\.com/i.test(url)) return `GitHub: ${label}`;
  return label;
};

const resolveImageUrl = (repo: Repo, relPath: string, rawUrl: string): string | null => {
  const url = rawUrl.trim();
  if (!url) return null;
  if (/^data:/i.test(url)) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;

  const imagePath = url.startsWith("/")
    ? posix.normalize(url.slice(1))
    : posix.normalize(posix.join(posix.dirname(relPath), url));
  if (!imagePath || imagePath.startsWith("../")) return null;
  return rawFileUrl(repo, imagePath);
};

/**
 * Das Ziel aus ![alt](ziel) herausloesen.
 *
 * Markdown erlaubt spitze Klammern, wenn der Pfad Leerzeichen enthaelt:
 * ![](<./mys animation.avif>). Frueher wurde hier stumpf am ersten Leerzeichen
 * abgeschnitten — dabei blieb "<./mys" uebrig und wurde als "%3C./mys" in die
 * Datenbank geschrieben. Im Index standen mehrere solcher toter Bild-URLs.
 *
 * Ohne Klammern kann hinter dem Pfad ein Titel stehen: ![](bild.png "Titel").
 * Da ist Abschneiden am Leerzeichen richtig.
 */
const markdownTarget = (raw: string): string => {
  const value = raw.trim();
  if (!value.startsWith("<")) return value.split(/\s+/)[0] ?? "";
  const end = value.indexOf(">");
  return (end > 0 ? value.slice(1, end) : value.slice(1)).trim();
};

const extractMarkdownImages = (repo: Repo, relPath: string, body: string): ImageEntry[] => {
  const images: ImageEntry[] = [];
  const seen = new Set<string>();

  const addImage = (alt: string, rawUrl: string): void => {
    const url = resolveImageUrl(repo, relPath, rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push({ alt: alt.trim(), url });
  };

  for (const match of body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    addImage(match[1] ?? "", markdownTarget(match[2] ?? ""));
  }

  for (const match of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0] ?? "";
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch?.[1]) continue;
    const altMatch = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
    addImage(altMatch?.[1] ?? "", srcMatch[1]);
  }

  return images;
};

const isLikelyBadgeImage = (image: ImageEntry): boolean => {
  const haystack = `${image.alt} ${image.url}`.toLowerCase();
  return (
    haystack.includes("shields.io") ||
    haystack.includes("badge") ||
    haystack.includes("build status")
  );
};

const pickPrimaryImage = (
  repo: Repo,
  relPath: string,
  frontmatter: string | null,
  body: string
): string | null => {
  if (frontmatter) {
    for (const key of ["image", "image_url", "thumbnail", "thumbnail_url", "coverImage", "cover_image"]) {
      const value = frontmatterValue(frontmatter, key);
      if (!value) continue;
      const resolved = resolveImageUrl(repo, relPath, value);
      if (resolved) return resolved;
    }
  }

  const candidates = extractMarkdownImages(repo, relPath, body).filter(
    image => !isLikelyBadgeImage(image)
  );
  return candidates[0]?.url ?? null;
};

const extractHelpfulLinks = (
  repo: Repo,
  relPath: string,
  frontmatter: string | null,
  body: string
): string | null => {
  const links: LinkEntry[] = [];
  const seen = new Set<string>();
  const preferredRepoUrl = frontmatter ? frontmatterValue(frontmatter, "clone_url") : null;

  const addLink = (label: string, rawUrl: string): void => {
    const url = normalizeLinkUrl(rawUrl.trim());
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };

  if (preferredRepoUrl) {
    addLink("Passendes GitHub-Repo", preferredRepoUrl);
  } else {
    addLink("GitHub-Repo", repoUrl(repo));
  }

  if (frontmatter) {
    for (const match of frontmatter.matchAll(/^([a-zA-Z0-9_-]+):\s*["']?(https?:\/\/[^\s"']+)["']?\s*$/gm)) {
      const key = match[1];
      const url = match[2];
      addLink(frontmatterUrlLabel(key), url);
    }
  }

  const currentRepoUrl = normalizeLinkUrl(repoUrl(repo));
  if (!preferredRepoUrl || normalizeLinkUrl(preferredRepoUrl) === currentRepoUrl) {
    addLink("GitHub-Repo", currentRepoUrl);
  }

  for (const match of body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const label = classifyBodyUrl(match[1].trim(), match[2]);
    addLink(label, match[2]);
  }

  for (const match of body.matchAll(/(^|\s)(https?:\/\/[^\s<>")]+)(?=$|\s)/g)) {
    const url = match[2];
    const label = /youtu\.be|youtube\.com/i.test(url) ? "Video" : "Link";
    addLink(label, url);
  }

  if (links.length === 0) return null;

  const title = frontmatter ? frontmatterValue(frontmatter, "title") : null;
  const displayName = title || `${repo.name}/${relPath}`;
  const lines = links.slice(0, 6).map((entry) => `- ${entry.label}: ${entry.url}`);
  return `Hilfreiche Links zu ${displayName} aus ${repo.name}/${relPath}:\n${lines.join("\n")}`;
};

const metadataChunk = (repo: Repo, relPath: string, frontmatter: string): string =>
  `Dokument-Metadaten aus ${repo.name}/${relPath}:\n${frontmatter}`;

// --- Main -------------------------------------------------------------------

const main = async () => {
  await mkdir(REPO_CACHE, { recursive: true });
  await mkdir("./data", { recursive: true });
  await removeDbFiles(WORK_DB);

  console.log(`[embed] listing repos from ${GITHUB_ORG}...`);
  const repos = await listRepos();
  console.log(`[embed] ${repos.length} active, non-fork repos`);

  console.log(`[embed] syncing repos into ${REPO_CACHE}...`);
  for (const repo of repos) {
    process.stdout.write(`[embed]   ${repo.name} ... `);
    try {
      syncRepo(repo);
      process.stdout.write("ok\n");
    } catch (err) {
      process.stdout.write(`FAILED (${(err as Error).message.split("\n")[0]})\n`);
    }
  }

  // Fresh DB
  const db = new Database(WORK_DB, { create: true });
  db.loadExtension(sqliteVec.getLoadablePath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      source_url TEXT NOT NULL,
      image_url TEXT,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      embedding float[${config.rag.embeddingDim}]
    );
  `);

  const insertChunk = db.prepare(
    "INSERT INTO chunks (repo, path, repo_url, source_url, image_url, text) VALUES (?, ?, ?, ?, ?, ?) RETURNING rowid"
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)"
  );

  const persistChunk = async (
    repo: Repo,
    relPath: string,
    text: string,
    imageUrl: string | null
  ): Promise<void> => {
    const vec = await embedPassage(text);
    const row = insertChunk.get(
      repo.name,
      relPath,
      repoUrl(repo),
      sourceUrl(repo, relPath),
      imageUrl,
      text
    ) as { rowid: number };
    insertVec.run(
      row.rowid,
      new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
    );
  };

  console.log(`[embed] embedding chunks...`);
  let total = 0;
  for (const repo of repos) {
    const repoDir = join(REPO_CACHE, repo.name);
    if (!existsSync(repoDir)) continue;

    let repoChunks = 0;
    db.exec("BEGIN");
    try {
      for await (const filePath of walkText(repoDir)) {
        let content: string;
        try {
          content = await readFile(filePath, "utf8");
        } catch {
          continue;
        }
        const rel = repoFilePath(repoDir, filePath);
        const fm = extname(filePath).toLowerCase().startsWith(".md")
          ? splitFrontmatter(content)
          : null;
        const body = (fm ? fm.body : content).trim();
        const imageUrl = extname(filePath).toLowerCase().startsWith(".md")
          ? pickPrimaryImage(repo, rel, fm?.frontmatter ?? null, body)
          : null;

        if (fm) {
          await persistChunk(repo, rel, metadataChunk(repo, rel, fm.frontmatter), imageUrl);
          repoChunks += 1;

          const linkChunk = extractHelpfulLinks(repo, rel, fm.frontmatter, fm.body);
          if (linkChunk) {
            await persistChunk(repo, rel, linkChunk, imageUrl);
            repoChunks += 1;
          }
        }

        if (body.length < MIN_CONTENT_CHARS) continue;

        for (const chunk of chunkText(body)) {
          await persistChunk(repo, rel, chunk, imageUrl);
          repoChunks += 1;
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      console.error(`[embed]   ${repo.name} failed:`, (err as Error).message);
      try { db.exec("ROLLBACK"); } catch {}
      continue;
    }
    total += repoChunks;
    console.log(`[embed]   ${repo.name}: ${repoChunks} chunks`);
  }

  // Alles aus dem WAL in die Hauptdatei schreiben, BEVOR umbenannt wird.
  //
  // Der Tausch unten bewegt nur knowledge.db.tmp — nicht die Begleitdateien
  // -wal und -shm. Ohne diesen Checkpoint bleibt alles, was seit dem letzten
  // automatischen Checkpoint geschrieben wurde, im zurueckgelassenen -wal
  // liegen und ist weg. db.close() allein raeumt das WAL nicht ab.
  //
  // Das ist nicht theoretisch: am 23.09.2026 meldete der naechtliche Lauf
  // "done — 2125 chunks", und genau die letzten acht Repos fehlten danach im
  // Index — darunter mks-Arduino-UNO_R4_WiFi mit 94 Chunks. Die lagen in einer
  // 4,3 MB grossen .tmp-wal, die beim Umbenennen liegen blieb. Der Lauf meldete
  // dabei keinen einzigen Fehler, weil aus seiner Sicht auch keiner passiert war.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  if (total === 0) {
    await removeDbFiles(WORK_DB);
    throw new Error("No chunks embedded; refusing to replace existing knowledge DB");
  }

  // Wenn nach dem Checkpoint immer noch etwas im WAL steht, waere der Tausch
  // ein stiller Datenverlust. Dann lieber laut abbrechen und die alte, heile
  // Datenbank stehen lassen.
  const leftover = existsSync(WORK_DB + "-wal") ? statSync(WORK_DB + "-wal").size : 0;
  if (leftover > 0) {
    throw new Error(
      `WAL checkpoint failed: ${leftover} bytes still in ${WORK_DB}-wal. ` +
        `Refusing to swap — the existing knowledge DB is untouched.`
    );
  }

  // Atomic swap into place.
  //
  // Auch -wal und -shm der ALTEN Datei muessen weg. Bleiben sie liegen, haengen
  // sie sich an die frisch umbenannte Datei und sqlite liest eine fremde
  // Journaldatei zu einer neuen Datenbank. Auf dem Server lag so eine Leiche
  // vom 11.04.2026 herum.
  await removeDbFiles(FINAL_DB);
  await rename(WORK_DB, FINAL_DB);

  console.log(`[embed] done — ${total} total chunks written to ${FINAL_DB}`);
};

main().catch(err => {
  console.error("[embed] FATAL:", err);
  process.exit(1);
});
