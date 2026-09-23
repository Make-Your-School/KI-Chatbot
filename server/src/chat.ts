// LLM streaming proxy.
//
// Takes a message history from the client, runs RAG on the last user message,
// injects system prompt + retrieved context, then streams tokens back as a
// generator. The index.ts route wraps the generator in a Server-Sent Events
// response for the browser.
//
// Provider chain: tries Google AI Studio (Gemini, OpenAI-kompatibler Endpoint)
// und OpenRouter in der durch config.providerOrder festgelegten Reihenfolge.
// Beide sprechen das OpenAI-SSE-Format, daher ist das Streaming-Handling unten
// einheitlich. Bei Fehler/Timeout/4xx eines Versuchs wird der nächste probiert.

import { config } from "./config.ts";
import { debugContentLog, debugLog } from "./debug.ts";
import { getModels, type Provider } from "./models.ts";
import {
  classifyStatus,
  isHealthy,
  listUnhealthy,
  markHealthy,
  markUnhealthy,
} from "./providerHealth.ts";
import { retrieve, formatContext, loadFileText } from "./rag.ts";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompts.ts";

export type ChatMessage = { role: "user" | "assistant"; content: string };

type SourceHint = {
  repo: string;
  path: string;
  repoUrl?: string;
  sourceUrl?: string;
  imageUrl?: string;
};

type ImageHint = {
  url: string;
  repo: string;
  path: string;
};

type ExampleHint = {
  repo: string;
  path: string;
  sourceUrl?: string;
};

type HistoryMessage = ChatMessage & {
  sources?: SourceHint[];
  images?: ImageHint[];
  example?: ExampleHint;
};

type ResourceKind = "repo" | "doc" | "video" | "product" | "other";

type ResourceLink = {
  label: string;
  url: string;
  kind: ResourceKind;
};

type ExampleCode = {
  repo: string;
  path: string;
  sourceUrl?: string;
  code: string;
  /** True when the file was cut down to fit the card. */
  truncated?: boolean;
};

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | {
      type: "sources";
      sources: Array<{
        repo: string;
        path: string;
        repoUrl?: string;
        sourceUrl?: string;
        imageUrl?: string;
      }>;
    }
  | { type: "resources"; resources: ResourceLink[] }
  | { type: "images"; images: Array<{ url: string; repo: string; path: string }> }
  | { type: "example"; example: ExampleCode }
  | { type: "model"; provider: Provider; model: string }
  | { type: "done" }
  | { type: "error"; message: string };

const MAX_HISTORY = 20; // cap how much we forward to avoid prompt bloat
const MAX_MESSAGE_CHARS = 4000;
const MAX_SOURCE_HINTS = 3;
const MAX_IMAGES = 2;
const MAX_FOCUSED_REPOS = 2;
const MAX_RESOURCE_LINKS = 4;
const MATERIAL_NUMBER_RE = /\bmaterial(?:karte)?(?:\s*(?:nr\.?|nummer))?\s*#?\s*(\d{1,4})\b/i;
const CODE_INTENT_RE = /\b(code|quellcode|sketch|programm|ino|beispielcode)\b/i;
const LINK_INTENT_RE = /\b(link|links|repo|github|readme|doku|dokumentation|video|anleitung)\b/i;
const IMAGE_INTENT_RE = /\b(bild|foto|abbildung|aussehen|wie sieht|welches teil|welches bauteil)\b/i;
const SETUP_INTENT_RE = /\b(was ist|wie benutze|wie verwende|wie schlie(?:ß|ss)e|anschlie(?:ß|ss)en|anschluss|aufbau)\b/i;
const REFERENTIAL_INTENT_RE = /\b(hierfür|hierfuer|dafür|dafuer|damit|dies|diese|diesem|dieses|das material|das teil|so eins)\b/i;

type Attempt = {
  provider: Provider;
  // Best guess fürs Modell-Label, falls der Stream nichts mitschickt.
  // Bei Gemini ist das das angefragte Modell (genau bekannt).
  // Bei OpenRouter ist das das erste Modell der Liste — wird aber sofort
  // vom echten Modell aus dem ersten Stream-Chunk überschrieben.
  fallbackModel: string;
  label: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type OpenAIMessage = { role: "system" | "user" | "assistant"; content: string };

const buildAttempts = (messages: OpenAIMessage[]): Attempt[] => {
  const attempts: Attempt[] = [];
  for (const provider of config.providerOrder) {
    if (provider === "gemini" && config.gemini.apiKey) {
      // Google AI Studio kennt kein server-seitiges Model-Routing, also
      // legen wir pro Modell einen eigenen Versuch an. Modelle die kürzlich
      // 429/5xx oder Netzwerkfehler hatten, überspringen wir für die Cooldown-
      // Dauer. Falls dadurch NICHTS übrig bleibt, probieren wir trotzdem alle
      // — besser ein teurer Retry als "kein Anbieter verfügbar".
      const allModels = getModels("gemini");
      const healthy = allModels.filter(isHealthy);
      const modelsToUse = healthy.length > 0 ? healthy : allModels;
      if (healthy.length < allModels.length) {
        debugLog("chat", "skipping unhealthy gemini models", {
          skipped: allModels.filter(m => !isHealthy(m)),
          unhealthy: listUnhealthy(),
        });
      }
      for (const model of modelsToUse) {
        attempts.push({
          provider: "gemini",
          fallbackModel: model,
          label: `gemini/${model}`,
          url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.gemini.apiKey}`,
          },
          body: { model, messages, stream: true },
        });
      }
    } else if (provider === "openrouter" && config.openRouter.apiKey) {
      // OpenRouter kann mit `models: [...]` selbst durch die Liste fallen,
      // daher reicht ein einziger Versuch für alle OpenRouter-Modelle.
      const orModels = getModels("openrouter");
      attempts.push({
        provider: "openrouter",
        fallbackModel: orModels[0] ?? "unknown",
        label: `openrouter/[${orModels.join(",")}]`,
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openRouter.apiKey}`,
          "HTTP-Referer": config.openRouter.siteUrl,
          "X-Title": config.openRouter.siteName,
        },
        body: { models: orModels, messages, stream: true },
      });
    }
  }
  return attempts;
};

const friendlyError = (status: number): string => {
  if (status === 0)
    return "Die KI ist gerade nicht erreichbar (Netzwerkfehler). Bitte gleich nochmal versuchen.";
  if (status === 429)
    return "Die KI-Modelle sind gerade alle überlastet (Rate Limit beim Anbieter). Bitte in ein paar Minuten nochmal versuchen.";
  if (status === 401 || status === 403)
    return "Die KI ist gerade nicht erreichbar (Authentifizierung). Bitte einer Mentor*in Bescheid geben.";
  if (status >= 500)
    return "Die KI ist gerade nicht erreichbar (Server-Fehler beim Anbieter). Bitte gleich nochmal versuchen.";
  return `Die KI ist gerade nicht erreichbar (Fehler ${status}). Bitte gleich nochmal versuchen.`;
};

const sanitizeStructuredHistory = (history: ChatMessage[]): HistoryMessage[] =>
  history
    .filter(
      m =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0
    )
    .slice(-MAX_HISTORY)
    .map(m => {
      // `image` (Einzahl) ist das alte Feld und steht absichtlich nicht mehr im
      // Typ — nur der Migrationspfad unten darf es noch lesen.
      const structured = m as HistoryMessage & { image?: ImageHint };
      const sources = Array.isArray(structured.sources)
        ? structured.sources
            .filter(source => source && typeof source.repo === "string" && typeof source.path === "string")
            .slice(0, MAX_SOURCE_HINTS)
            .map(source => ({
              repo: source.repo,
              path: source.path,
              repoUrl: typeof source.repoUrl === "string" ? source.repoUrl : undefined,
              sourceUrl: typeof source.sourceUrl === "string" ? source.sourceUrl : undefined,
              imageUrl: typeof source.imageUrl === "string" ? source.imageUrl : undefined,
            }))
        : undefined;
      // Der Client schickt seit dem Mehrbild-Umbau `images`. Aeltere Verlaeufe
      // liegen als `image` im localStorage der Schueler*innen und muessen
      // weiter lesbar sein — sonst verliert ein offener Tab seinen Kontext.
      const rawImages: unknown[] = Array.isArray(structured.images)
        ? structured.images
        : structured.image
          ? [structured.image]
          : [];
      const images = rawImages
        .filter(
          (img): img is ImageHint =>
            !!img &&
            typeof (img as ImageHint).url === "string" &&
            typeof (img as ImageHint).repo === "string" &&
            typeof (img as ImageHint).path === "string"
        )
        .slice(0, MAX_IMAGES)
        .map(img => ({ url: img.url, repo: img.repo, path: img.path }));
      const example =
        structured.example &&
        typeof structured.example.repo === "string" &&
        typeof structured.example.path === "string"
          ? {
              repo: structured.example.repo,
              path: structured.example.path,
              sourceUrl:
                typeof structured.example.sourceUrl === "string"
                  ? structured.example.sourceUrl
                  : undefined,
            }
          : undefined;

      return {
        role: m.role,
        content: m.content.slice(0, MAX_MESSAGE_CHARS),
        sources,
        images,
        example,
      };
    });

const sanitizeHistory = (history: ChatMessage[]): ChatMessage[] =>
  sanitizeStructuredHistory(history).map(({ role, content }) => ({ role, content }));

/**
 * Ein Bild pro Repo, hoechstens MAX_IMAGES.
 *
 * Zwei sind kein Selbstzweck: den Arduino gibt es als UNO R3 und als UNO R4
 * WiFi, und die Frage "welchen hast du denn?" beantwortet man am schnellsten,
 * indem man beide nebeneinander sieht. Mehr als zwei waere eine Galerie und
 * keine Hilfe mehr.
 */
const pickImages = (
  chunks: Array<{ imageUrl?: string; repo: string; path: string }>
): Array<{ url: string; repo: string; path: string }> => {
  const out: Array<{ url: string; repo: string; path: string }> = [];
  const seenRepos = new Set<string>();

  for (const chunk of chunks) {
    if (typeof chunk.imageUrl !== "string" || chunk.imageUrl.length === 0) continue;
    if (seenRepos.has(chunk.repo)) continue;
    seenRepos.add(chunk.repo);
    out.push({ url: chunk.imageUrl, repo: chunk.repo, path: chunk.path });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
};

const normalizeResourceUrl = (url: string): string => url.replace(/\.git$/, "");

const classifyResourceKind = (label: string, url: string): ResourceKind => {
  const haystack = `${label} ${url}`.toLowerCase();
  if (haystack.includes("youtu.be") || haystack.includes("youtube.com") || haystack.includes("video")) {
    return "video";
  }
  if (haystack.includes("produkt") || haystack.includes("product")) {
    return "product";
  }
  if (
    haystack.includes("readme") ||
    haystack.includes("doku") ||
    haystack.includes("wiki") ||
    haystack.includes("anleitung") ||
    haystack.includes("blob/")
  ) {
    return "doc";
  }
  if (haystack.includes("github") || haystack.includes("repo")) {
    return "repo";
  }
  return "other";
};

const sourceResourceLabel = (path: string): string => {
  const fileName = path.split("/").pop() ?? path;
  if (/^readme\./i.test(fileName)) return "README / Doku";
  return `Datei: ${fileName}`;
};

const labelPriority = (label: string): number => {
  const normalized = label.toLowerCase();
  if (normalized.includes("passendes github-repo")) return 0;
  if (normalized === "github-repo") return 1;
  if (normalized.includes("readme / doku") || normalized.includes("wiki") || normalized.includes("doku")) return 2;
  if (normalized.startsWith("datei:")) return 3;
  return 4;
};

const extractResources = (
  chunks: Array<{ text: string; repoUrl?: string; sourceUrl?: string; path: string }>,
  repoLinkLimit = 1
): ResourceLink[] => {
  const all: Array<ResourceLink & { order: number }> = [];
  const seen = new Set<string>();
  let order = 0;

  const addResource = (label: string, rawUrl: string): void => {
    const url = normalizeResourceUrl(rawUrl.trim());
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    all.push({ label, url, kind: classifyResourceKind(label, url), order });
    order += 1;
  };

  for (const chunk of chunks) {
    if (chunk.repoUrl) addResource("GitHub-Repo", chunk.repoUrl);
    if (chunk.sourceUrl) addResource(sourceResourceLabel(chunk.path), chunk.sourceUrl);

    for (const line of chunk.text.split("\n")) {
      const match = line.match(/^-\s*(.+):\s*(https?:\/\/\S+)\s*$/);
      if (!match) continue;
      addResource(match[1].trim(), match[2].trim());
    }
  }

  const sorted = all.sort((a, b) => {
    const kindOrder = { repo: 0, doc: 1, video: 2, product: 3, other: 4 };
    return (
      kindOrder[a.kind] - kindOrder[b.kind] ||
      labelPriority(a.label) - labelPriority(b.label) ||
      a.order - b.order ||
      a.label.localeCompare(b.label, "de")
    );
  });

  // Ein Repo-Link pro Repo, auf das sich die Antwort stuetzt — bei den zwei
  // Arduino-Varianten sind das zwei, sonst einer. Alles andere bleibt bei
  // einem: die Karte soll "hier klickst du weiter" sagen, nicht "hier sind
  // alle Links, die ich finden konnte".
  const perKindLimit: Record<ResourceKind, number> = {
    repo: Math.max(1, Math.min(repoLinkLimit, MAX_FOCUSED_REPOS)),
    doc: 1,
    video: 1,
    product: 1,
    other: 1,
  };
  const used: Record<ResourceKind, number> = {
    repo: 0,
    doc: 0,
    video: 0,
    product: 0,
    other: 0,
  };
  const selected: ResourceLink[] = [];

  for (const resource of sorted) {
    if (used[resource.kind] >= perKindLimit[resource.kind]) continue;
    selected.push({ label: resource.label, url: resource.url, kind: resource.kind });
    used[resource.kind] += 1;
    if (selected.length >= MAX_RESOURCE_LINKS) break;
  }

  return selected;
};

// Only Arduino/C-family files count as a code sample.
//
// This used to include .py/.js/.ts/.jsx/.tsx/.json, which meant the card could
// serve this project's own TypeScript as an "Arduino example" — every public
// repo of the org is indexed, including this one.
//
// Checked against all 79 mks-* material repos (23.09.2026): every single one
// ships real .ino/.c/.cpp/.h files, and none depends on a fenced block in a
// README for its example. Markdown fences in the material repos are almost all
// `bash` or untagged, i.e. wiring and install notes rather than sketches. So
// narrowing this costs no real examples and removes the whole class of
// wrong-repo hits.
const CODE_PATH_RE = /\.(ino|c|cc|cpp|h|hpp)$/i;

// A retrieved chunk is a blind 800-char slice, so showing it raw produces a
// "sample" that begins and ends mid-statement. We pull the whole file instead
// and only cut it if it would swamp the chat bubble — and then at line
// boundaries, with the card saying that it was shortened.
const MAX_EXAMPLE_LINES = 240;
const MAX_EXAMPLE_CHARS = 8000;

const fitExample = (code: string): { code: string; truncated: boolean } => {
  const normalized = code.replace(/\s+$/, "");
  const lines = normalized.split("\n");

  if (lines.length <= MAX_EXAMPLE_LINES && normalized.length <= MAX_EXAMPLE_CHARS) {
    return { code: normalized, truncated: false };
  }

  const kept: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, MAX_EXAMPLE_LINES)) {
    if (chars + line.length + 1 > MAX_EXAMPLE_CHARS) break;
    kept.push(line);
    chars += line.length + 1;
  }
  return { code: kept.join("\n").replace(/\s+$/, ""), truncated: true };
};

const pickExampleCode = (
  chunks: Array<{ path: string; repo: string; sourceUrl?: string; text: string }>
): ExampleCode | null => {
  const candidates = chunks.filter(chunk =>
    CODE_PATH_RE.test(chunk.path) &&
    !chunk.text.startsWith("Hilfreiche Links") &&
    !chunk.text.startsWith("Dokument-Metadaten")
  );

  const preferred = candidates.find(chunk => /(^|\/)examples?\//i.test(chunk.path)) ?? candidates[0];
  if (!preferred) return null;

  // Fall back to the chunk if the file can't be reassembled (no index yet).
  const whole = loadFileText(preferred.repo, preferred.path) ?? preferred.text;
  const fitted = fitExample(whole);
  if (!fitted.code.trim()) return null;

  return {
    repo: preferred.repo,
    path: preferred.path,
    sourceUrl: preferred.sourceUrl,
    code: fitted.code,
    truncated: fitted.truncated,
  };
};

const extractMaterialNumber = (text: string): string | null =>
  text.match(MATERIAL_NUMBER_RE)?.[1] ?? null;

const asksForCode = (text: string): boolean => CODE_INTENT_RE.test(text);

const asksForLinks = (text: string): boolean => LINK_INTENT_RE.test(text);

const asksForImage = (text: string): boolean => IMAGE_INTENT_RE.test(text);

const asksForSetupHelp = (text: string): boolean => SETUP_INTENT_RE.test(text);

const isReferentialFollowUp = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (REFERENTIAL_INTENT_RE.test(normalized)) return true;
  return normalized.length <= 80 && asksForCode(normalized) && !extractMaterialNumber(normalized);
};

const buildRetrievalQuery = (
  history: HistoryMessage[],
  lastUserIndex: number
): { query: string; usedHistory: boolean; sourceHints: string[] } => {
  const lastUser = history[lastUserIndex];
  if (!lastUser) return { query: "", usedHistory: false, sourceHints: [] };

  const current = lastUser.content.trim();
  if (!isReferentialFollowUp(current)) {
    return { query: current, usedHistory: false, sourceHints: [] };
  }

  const earlierMessages = history.slice(0, lastUserIndex);
  const previousUser = [...earlierMessages].reverse().find(message => message.role === "user");
  const previousAssistant = [...earlierMessages].reverse().find(message => message.role === "assistant");
  const sourceHints = [
    ...(previousAssistant?.sources?.map(source => `${source.repo}/${source.path}`) ?? []),
    previousAssistant?.example
      ? `${previousAssistant.example.repo}/${previousAssistant.example.path}`
      : null,
    ...(previousAssistant?.images?.map(image => `${image.repo}/${image.path}`) ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, MAX_SOURCE_HINTS);

  const parts = [current];
  if (previousUser?.content.trim()) {
    parts.push(`Vorherige Nutzerfrage: ${previousUser.content.trim()}`);
  }
  if (sourceHints.length > 0) {
    parts.push(`Vorherige Material-Quellen: ${sourceHints.join(", ")}`);
  }

  return {
    query: parts.join("\n\n"),
    usedHistory: parts.length > 1,
    sourceHints,
  };
};

/**
 * Welche Repos die Antwort wirklich tragen — hoechstens MAX_FOCUSED_REPOS.
 *
 * Mass dafuer ist, wie viele der abgerufenen Chunks aus einem Repo stammen.
 * Ein Repo, das nur mit einem einzigen Chunk vertreten ist, war meistens ein
 * Streifschuss der Bedeutungssuche und soll weder Bild noch Link stellen.
 *
 * Frueher gab es hier genau ein Repo, und nur wenn es den Zweiten klar
 * schlug. Bei "wie fange ich mit Arduino an" liegen aber R3 und R4 WiFi
 * gleichauf — das war exakt der Fall, in dem die Regel nichts zurueckgab.
 */
const pickFocusedRepos = (
  retrievalQuery: string,
  chunks: Array<{ repo: string }>
): string[] => {
  if (chunks.length === 0) return [];
  // Eine Materialnummer meint genau ein Bauteil, da gibt es nichts zu waehlen.
  if (extractMaterialNumber(retrievalQuery)) {
    const first = chunks[0]?.repo;
    return first ? [first] : [];
  }

  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    counts.set(chunk.repo, (counts.get(chunk.repo) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de")
  );
  if (chunks.length === 1) return ranked[0] ? [ranked[0][0]] : [];

  return ranked
    .filter(([, count]) => count >= 2)
    .slice(0, MAX_FOCUSED_REPOS)
    .map(([repo]) => repo);
};

export async function* streamChat(
  rawHistory: ChatMessage[]
): AsyncGenerator<ChatStreamEvent> {
  const structuredHistory = sanitizeStructuredHistory(rawHistory);
  const history = sanitizeHistory(rawHistory);
  const lastUserIndex = structuredHistory.map(message => message.role).lastIndexOf("user");
  const lastUser = lastUserIndex >= 0 ? structuredHistory[lastUserIndex] : undefined;
  if (!lastUser) {
    yield { type: "error", message: "Keine Nachricht gefunden." };
    return;
  }

  const retrievalPlan = buildRetrievalQuery(structuredHistory, lastUserIndex);

  debugLog("chat", "stream start", {
    historyCount: structuredHistory.length,
    lastUserChars: lastUser.content.length,
  });
  debugContentLog("chat", "last user", lastUser.content);
  debugLog("chat", "retrieval query built", {
    usedHistory: retrievalPlan.usedHistory,
    sourceHintCount: retrievalPlan.sourceHints.length,
    queryChars: retrievalPlan.query.length,
  });
  debugContentLog("chat", "retrieval query", retrievalPlan.query);

  const chunks = await retrieve(retrievalPlan.query).catch(err => {
    console.error("[chat] rag failed:", err);
    debugLog("chat", "rag failed", { message: (err as Error).message });
    return [];
  });
  const context = formatContext(chunks);

  debugLog("chat", "context built", {
    chunkCount: chunks.length,
    contextChars: context.length,
  });
  debugContentLog("chat", "context", context);

  if (chunks.length > 0) {
    yield {
      type: "sources",
      sources: chunks.map(c => ({
        repo: c.repo,
        path: c.path,
        repoUrl: c.repoUrl,
        sourceUrl: c.sourceUrl,
        imageUrl: c.imageUrl,
      })),
    };
    debugLog("chat", "sources emitted", chunks.map(c => ({
      repo: c.repo,
      path: c.path,
      hasRepoUrl: !!c.repoUrl,
      hasSourceUrl: !!c.sourceUrl,
      hasImageUrl: !!c.imageUrl,
    })));

    const focusedRepos = pickFocusedRepos(retrievalPlan.query, chunks);
    const focusedChunks =
      focusedRepos.length > 0
        ? chunks.filter(chunk => focusedRepos.includes(chunk.repo))
        : chunks;
    const showResources =
      asksForLinks(lastUser.content) ||
      (focusedRepos.length > 0 && !asksForCode(lastUser.content));
    // Bild zeigen, sobald klar ist, worum es geht. Die Zielgruppe hat das
    // Bauteil zum ersten Mal in der Hand — ein Foto beantwortet "meinst du
    // das hier?" schneller als jeder Satz. Frueher hing das an einer Liste
    // von Formulierungen ("was ist", "anschliessen", ...), und genau die
    // Einstiegsfrage "wie starte ich am einfachsten?" stand nicht drin.
    const showImage =
      asksForImage(lastUser.content) ||
      (focusedRepos.length > 0 && !asksForCode(lastUser.content));
    const showExample = asksForCode(lastUser.content);

    debugLog("chat", "supplement selection", {
      focusedRepos,
      showResources,
      showImage,
      showExample,
      setupIntent: asksForSetupHelp(lastUser.content),
    });

    const resources = showResources
      ? extractResources(focusedChunks, focusedRepos.length || 1)
      : [];
    if (resources.length > 0) {
      debugLog("chat", "resources emitted", resources);
      yield { type: "resources", resources };
    } else {
      debugLog("chat", "no structured resources extracted");
    }

    const images = showImage ? pickImages(focusedChunks) : [];
    if (images.length > 0) {
      debugLog("chat", "images emitted", images);
      yield { type: "images", images };
    } else {
      debugLog("chat", "no image selected");
    }

    const example = showExample ? pickExampleCode(focusedChunks) : null;
    if (example) {
      debugLog("chat", "example code emitted", {
        repo: example.repo,
        path: example.path,
        chars: example.code.length,
        truncated: !!example.truncated,
      });
      yield { type: "example", example };
    } else {
      debugLog("chat", "no example code selected");
    }
  } else {
    debugLog("chat", "no chunks retrieved for query");
  }

  // Replace only the LAST user message with the context-augmented version.
  // Earlier turns stay as-is so the model keeps conversational memory, but we
  // don't balloon the prompt by stuffing context into every past turn.
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history.slice(0, -1),
    { role: "user" as const, content: buildUserMessage(lastUser.content, context) },
  ];

  debugLog("chat", "messages built for provider", {
    messageCount: messages.length,
    contextInjected: context.length > 0,
  });
  debugContentLog("chat", "final user message", messages[messages.length - 1]?.content ?? "");

  const attempts = buildAttempts(messages);
  debugLog("chat", "provider attempts", attempts.map(attempt => ({
    provider: attempt.provider,
    label: attempt.label,
  })));
  if (attempts.length === 0) {
    yield {
      type: "error",
      message:
        "Kein KI-Anbieter konfiguriert. Bitte einer Mentor*in Bescheid geben.",
    };
    return;
  }

  let resp: Response | null = null;
  let chosen: Attempt | null = null;
  let lastStatus = 0;

  for (const attempt of attempts) {
    try {
      const r = await fetch(attempt.url, {
        method: "POST",
        headers: attempt.headers,
        body: JSON.stringify(attempt.body),
      });
      if (r.ok && r.body) {
        console.log(`[chat] using ${attempt.label}`);
        debugLog("chat", "provider accepted request", {
          provider: attempt.provider,
          label: attempt.label,
        });
        if (attempt.provider === "gemini") markHealthy(attempt.fallbackModel);
        resp = r;
        chosen = attempt;
        break;
      }
      lastStatus = r.status;
      const text = await r.text().catch(() => "");
      console.error(
        `[chat] ${attempt.label} -> ${r.status}: ${text.slice(0, 500)}`
      );
      debugLog("chat", "provider returned non-ok response", {
        provider: attempt.provider,
        label: attempt.label,
        status: r.status,
        bodyPreview: text.slice(0, 240),
      });
      if (attempt.provider === "gemini") {
        const kind = classifyStatus(r.status);
        if (kind) markUnhealthy(attempt.fallbackModel, kind);
      }
    } catch (err) {
      lastStatus = 0;
      console.error(
        `[chat] ${attempt.label} fetch failed: ${(err as Error).message}`
      );
      debugLog("chat", "provider request failed", {
        provider: attempt.provider,
        label: attempt.label,
        message: (err as Error).message,
      });
      if (attempt.provider === "gemini") markUnhealthy(attempt.fallbackModel, "network");
    }
  }

  if (!resp || !resp.body || !chosen) {
    debugLog("chat", "all providers failed", { lastStatus });
    yield { type: "error", message: friendlyError(lastStatus) };
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Wir wollen genau ein model-Event yielden — und zwar mit dem echten
  // Modell, das der Provider gewählt hat (relevant für OpenRouter, das
  // server-seitig durch die Liste fällt). Beide Provider echoen das Modell
  // im SSE-Chunk-JSON unter `model`. Falls aus irgendeinem Grund kein
  // Chunk ein `model`-Feld hat, fallen wir auf attempt.fallbackModel zurück.
  let modelEventSent = false;
  let assistantChars = 0;
  let assistantPreview = "";
  const sendModelEvent = (model: string): ChatStreamEvent => {
    modelEventSent = true;
    debugLog("chat", "model event", {
      provider: chosen!.provider,
      model,
    });
    return { type: "model", provider: chosen!.provider, model };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Beide Provider streamen OpenAI-style SSE: Zeilen `data: {...}`,
      // Terminator `data: [DONE]`.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          if (!modelEventSent) yield sendModelEvent(chosen.fallbackModel);
          yield { type: "done" };
          return;
        }
        try {
          const json = JSON.parse(payload);
          if (!modelEventSent && typeof json.model === "string" && json.model.length > 0) {
            yield sendModelEvent(json.model);
          }
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            assistantChars += delta.length;
            if (assistantPreview.length < 1000) {
              assistantPreview += delta;
            }
            yield { type: "token", text: delta };
          }
        } catch {
          // Swallow keepalives, OpenRouter comment lines, malformed fragments.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  debugLog("chat", "stream completed", {
    provider: chosen.provider,
    fallbackModel: chosen.fallbackModel,
    assistantChars,
  });
  debugContentLog("chat", "assistant preview", assistantPreview);

  if (!modelEventSent) yield sendModelEvent(chosen.fallbackModel);
  yield { type: "done" };
}
