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
import { previewId } from "./linkPreviews.ts";
import { debugContentLog, debugLog } from "./debug.ts";
import { getModels, type Provider } from "./models.ts";
import {
  classifyStatus,
  isHealthy,
  listUnhealthy,
  markHealthy,
  markUnhealthy,
} from "./providerHealth.ts";
import {
  retrieve,
  formatContext,
  loadFileText,
  repoCoverImage,
  repoFacts,
  type ChunkMatch,
} from "./rag.ts";
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
  /** Name des Bauteils — damit die Oberflaeche das Bild im Text platzieren kann. */
  label?: string;
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

type ResourceKind = "repo" | "doc" | "video" | "shop" | "vendor" | "other";

type ResourceLink = {
  label: string;
  url: string;
  kind: ResourceKind;
  /** Grosses Bild fuer die Karte: Bauteilfoto, Video-Vorschau oder og:image. */
  image?: string;
  /** Kleines Seitensymbol. Rueckfallstufe, wenn es kein grosses Bild gibt. */
  icon?: string;
  /** Repo-Name, damit der Aufrufer weiss, welches Bild schon vergeben ist. */
  repo?: string;
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
  | { type: "images"; images: ImageHint[] }
  | { type: "example"; example: ExampleCode }
  | { type: "model"; provider: Provider; model: string }
  | { type: "done" }
  | { type: "error"; message: string };

const MAX_HISTORY = 20; // cap how much we forward to avoid prompt bloat
const MAX_MESSAGE_CHARS = 4000;
const MAX_SOURCE_HINTS = 3;
const MAX_IMAGES = 2;
const MAX_FOCUSED_REPOS = 2;
// Ohne Videos, die zaehlen getrennt. Zwei Bauteile belegen davon schon zwei
// Plaetze — mit 4 fiel die Herstellerseite hinten runter, sobald Repo, Repo,
// Doku und Produktseite davor lagen.
const MAX_RESOURCE_LINKS = 5;
const MAX_VIDEO_LINKS = 6;
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
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
// repoCoverImage() geht an die Datenbank. Innerhalb einer Antwort wird nach
// demselben Repo mehrfach gefragt (Bildblock und Link-Karte), deshalb hier ein
// kleiner Merker. Die Titelbilder aendern sich nur beim naechtlichen Einbetten.
const coverCache = new Map<string, string | null>();
const coverImage = (repo: string): string | null => {
  const hit = coverCache.get(repo);
  if (hit !== undefined) return hit;
  const value = repoCoverImage(repo);
  coverCache.set(repo, value);
  return value;
};

const pickImages = (
  chunks: Array<{ imageUrl?: string; repo: string; path: string }>
): ImageHint[] => {
  const out: ImageHint[] = [];
  const seenRepos = new Set<string>();

  for (const chunk of chunks) {
    if (seenRepos.has(chunk.repo)) continue;
    // Titelbild des Repos zuerst. Der gefundene Chunk ist nur der Notnagel:
    // war es eine .ino- oder .h-Datei, traegt er gar kein Bild, obwohl das
    // Bauteil eines hat.
    const url = coverImage(chunk.repo) ?? chunk.imageUrl;
    if (typeof url !== "string" || url.length === 0) continue;
    seenRepos.add(chunk.repo);
    const facts = repoFacts(chunk.repo);
    out.push({
      url,
      repo: chunk.repo,
      path: chunk.path,
      // Genau der Name, den das Modell im Text benutzt — er stammt aus
      // derselben Quelle wie die Beschriftung der Link-Karte.
      label: facts?.shortDescr ?? facts?.title,
    });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
};

const normalizeResourceUrl = (url: string): string => url.replace(/\.git$/, "");

/**
 * Die Video-ID aus einer YouTube-Adresse, in allen drei gebraeuchlichen Formen.
 * Gibt null zurueck, sobald irgendetwas nicht passt — daraus wird ein Pfad, und
 * ein geratener Pfad waere eine tote Bildadresse.
 */
const youtubeVideoId = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = parsed.pathname.slice(1);
  else if (host === "youtube.com" || host === "m.youtube.com") {
    if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
    else if (parsed.pathname.startsWith("/embed/")) id = parsed.pathname.slice(7);
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
};

/**
 * Vorschaubilder kommen ueber den eigenen Server, nicht direkt von YouTube.
 *
 * Ein <img src="https://i.ytimg.com/..."> wuerde den Browser der Schueler*in
 * bei Google melden, bevor ueberhaupt jemand auf ein Video geklickt hat — allein
 * dafuer, dass die Antwort angezeigt wurde. Der Umweg ueber /api/video-thumb
 * kostet etwas Speicher und haelt die Seite bei "keine Dritten".
 */
const videoThumbPath = (url: string): string | undefined => {
  const id = youtubeVideoId(url);
  return id ? `/api/video-thumb/${id}` : undefined;
};

// Einordnung nach der Adresse, nicht nach dem Feldnamen im Frontmatter.
//
// Die Feldnamen sagen etwas anderes als der Inhalt, und zwar systematisch.
// Gezaehlt ueber alle 83 Repos am 23.09.2026:
//
//   product_url     ->  53x wiki.seeedstudio.com   (das ist das WIKI)
//   manufacture_url ->  54x www.seeedstudio.com/   (nur die Startseite)
//
// Die Karte "Produktseite" fuehrte also aufs Wiki und "Herstellerseite" in den
// Shop. Beides war doppelt irrefuehrend: falsch beschriftet und falsch
// einsortiert. Die Adresse selbst luegt nicht.
const DOC_HOST_RE = /^(wiki|learn|docs?|tutorial|support)\./i;
const DOC_PATH_RE = /\/(wiki|learn|docs?|tutorials?|getting-started|datasheet)(\/|$|\.)/i;
const SHOP_HOST_RE = /^(store|shop)\./i;
const SHOP_PATH_RE = /\/(products?|cart|kategorie|shop)(\/|$)/i;
// Seiten, auf denen praktisch jede Unterseite eine Verkaufsseite ist. Fuer
// seeedstudio.com gilt das auch — das Wiki liegt auf einem eigenen Host und
// wird eine Zeile weiter oben schon als Anleitung erkannt.
const RETAILER_RE =
  /^(reichelt|conrad|amazon|mouser|digikey|farnell|berrybase|seeedstudio)\./i;

const classifyResourceKind = (label: string, url: string): ResourceKind => {
  const text = label.toLowerCase();
  if (/youtu\.be|youtube\.com/i.test(url) || text.includes("video")) return "video";

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    /* ohne Adresse bleibt nur der Text, siehe unten */
  }

  if (parsed) {
    // Die Reihenfolge ist die Aussage. Erst was eindeutig ist, dann die
    // Startseite, zuletzt der Shop-Verdacht.
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;

    if (host === "github.com") return "repo";
    if (DOC_HOST_RE.test(host) || DOC_PATH_RE.test(path)) return "doc";
    // Blosse Startseite: sagt ueber das konkrete Bauteil nichts, egal wem sie
    // gehoert. 54 Repos verlinken hier identisch auf www.seeedstudio.com/.
    if (path === "/" || path === "") return "vendor";
    if (SHOP_HOST_RE.test(host) || SHOP_PATH_RE.test(path) || RETAILER_RE.test(`${host}.`)) {
      return "shop";
    }
    // Eine Unterseite beim Hersteller, die weder Anleitung noch Shop ist —
    // etwa calliope.cc/calliope-mini/technische-daten. Die ist brauchbar und
    // soll nicht als Shop nach hinten sortiert werden.
    return "other";
  }

  // Nur wenn sich die Adresse nicht lesen laesst, entscheidet die Beschriftung.
  // Sie taugt dafuer schlecht — "Produktseite" steht im Frontmatter 53 Mal
  // ueber einem Wiki-Link —, ist dann aber das Einzige, was da ist.
  if (text.includes("wiki") || text.includes("doku") || text.includes("anleitung")) return "doc";
  if (text.includes("hersteller")) return "vendor";
  if (text.includes("produkt") || text.includes("shop")) return "shop";
  return "other";
};

// Die Beschriftung aus dem Frontmatter ist genauso unzuverlaessig wie die
// Einordnung, also wird sie fuer diese drei Arten ersetzt. Beschriftungen aus
// dem Fliesstext ("Video: Aufbau") bleiben, die hat jemand von Hand geschrieben.
const FRONTMATTER_LABELS = new Set(["produktseite", "herstellerseite", "github-repo"]);

const relabelByKind = (label: string, kind: ResourceKind): string => {
  if (!FRONTMATTER_LABELS.has(label.trim().toLowerCase())) return label;
  if (kind === "doc") return "Wiki / Anleitung";
  if (kind === "shop") return "Shop";
  if (kind === "vendor") return "Herstellerseite";
  return label;
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
  chunks: Array<{
    text: string;
    repo?: string;
    repoUrl?: string;
    sourceUrl?: string;
    imageUrl?: string;
    path: string;
  }>,
  focusedRepos: string[] = []
): ResourceLink[] => {
  const repoLinkLimit = Math.max(1, focusedRepos.length);
  const all: Array<ResourceLink & { order: number }> = [];
  const seen = new Set<string>();
  let order = 0;

  // Welche URL gehoert zu welchem Repo, und welches Bauteilbild haengt daran.
  //
  // Noetig, weil die Repo-Links nicht aus chunk.repoUrl kommen, sondern als
  // "- GitHub-Repo Arduino UNO R3: https://..." aus dem Links-Block im Text.
  // Ueber die URL finden wir zurueck zum Repo — und damit zum Bild.
  const repoByUrl = new Map<string, { repo: string; image?: string }>();
  for (const chunk of chunks) {
    if (!chunk.repoUrl || !chunk.repo) continue;
    const key = normalizeResourceUrl(chunk.repoUrl);
    if (repoByUrl.has(key)) continue;
    repoByUrl.set(key, { repo: chunk.repo, image: coverImage(chunk.repo) ?? chunk.imageUrl });
  }

  // Die Repo-Karte wird aus den Repo-Daten gebaut, nicht aus dem gefundenen
  // Text. Ob der Links-Block eines Repos zufaellig mit abgerufen wurde, ist
  // Glueckssache — die Karte soll trotzdem erscheinen, mit Bild und mit dem
  // Namen des Bauteils statt einem blossen "GitHub-Repo".
  const seededRepos = new Map<string, { label: string; image?: string; repo: string }>();
  for (const repo of focusedRepos) {
    const facts = repoFacts(repo);
    if (!facts?.repoUrl) continue;
    seededRepos.set(normalizeResourceUrl(facts.repoUrl), {
      // material_short_descr unterscheidet die beiden Boards ("Arduino UNO R3"
      // gegen "Arduino UNO R4 WiFi"), title tut das nicht.
      label: facts.shortDescr ?? facts.title ?? repo,
      image: facts.imageUrl,
      repo,
    });
  }

  const addResource = (label: string, rawUrl: string): void => {
    const url = normalizeResourceUrl(rawUrl.trim());
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;

    // Eine Datei INNERHALB eines Repos, das schon eine eigene Karte hat, ist
    // keine zweite Anlaufstelle — sie fuehrt an dieselbe Stelle. Frueher stand
    // deshalb neben "Arduino UNO R4 WiFi" noch eine Karte "README / Doku", die
    // in genau dieses Repo zeigte, nur ohne Bild und ohne sichtbaren Bezug.
    for (const repoUrl of seededRepos.keys()) {
      if (url !== repoUrl && url.startsWith(`${repoUrl}/`)) return;
    }

    seen.add(url);
    const seeded = seededRepos.get(url);
    const known = seeded ?? repoByUrl.get(url);
    // Zeigt die URL auf ein Repo aus dem Kontext, ist es eines — egal wie das
    // Label lautet. Das ist verlaesslicher als das Raten am Text.
    const kind = known ? "repo" : classifyResourceKind(label, url);
    all.push({
      // Bei einem Fokus-Repo gewinnt der Name des Bauteils ueber das, was
      // zufaellig im Text als Linktext stand. Sonst entscheidet die Art.
      label: seeded?.label ?? relabelByKind(label, kind),
      url,
      kind,
      image: known
        ? known.image
        : kind === "video"
          ? videoThumbPath(url)
          // Alles Uebrige — Produktseite, Herstellerseite, Wiki — bekommt die
          // Vorschau der Seite selbst, sofern sie eine anbietet.
          : `/api/link-preview/${previewId(url)}`,
      // Und wenn nicht, wenigstens das Logo der Seite. Zwei Stufen nach unten:
      // Vorschaubild, sonst Symbol, sonst reiner Text.
      icon: known || kind === "video" ? undefined : `/api/link-icon/${previewId(url)}`,
      repo: known?.repo,
      order,
    });
    order += 1;
  };

  // Zuerst die Fokus-Repos, damit sie sicher im Budget landen.
  for (const [url, seeded] of seededRepos) addResource(seeded.label, url);

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
    // Reihenfolge nach Nutzen waehrend der Hackdays: erst das Bauteil-Repo,
    // dann die Anleitung, dann Videos. Der Shop steht ganz hinten — wer gerade
    // baut, will nicht wissen, wo man das Teil kaufen kann. Die Herstellerseite
    // steht davor: sie ist immerhin eine Infoseite, und wenn sie nur die blosse
    // Startseite ist, faellt sie weiter unten ohnehin raus, sobald es eine
    // Anleitung gibt.
    const kindOrder = { repo: 0, doc: 1, video: 2, other: 3, vendor: 4, shop: 5 };
    return (
      kindOrder[a.kind] - kindOrder[b.kind] ||
      labelPriority(a.label) - labelPriority(b.label) ||
      a.order - b.order ||
      a.label.localeCompare(b.label, "de")
    );
  });

  // Ein Repo-Link pro Repo, auf das sich die Antwort stuetzt — bei den zwei
  // Arduino-Varianten sind das zwei, sonst einer. Doku, Produktseite und der
  // Rest bleiben bei einem: die Karte soll "hier klickst du weiter" sagen,
  // nicht "hier sind alle Links, die ich finden konnte".
  //
  // Videos duerfen mehr sein, weil sie in der Oberflaeche zu EINEM Aufklapper
  // zusammengefasst werden. Vorher stand hier 1, und bei "welches Board hast
  // du?" wurden damit 4 von 5 vorhandenen Videos einfach weggeworfen.
  const perKindLimit: Record<ResourceKind, number> = {
    repo: Math.max(1, Math.min(repoLinkLimit, MAX_FOCUSED_REPOS)),
    doc: 1,
    video: MAX_VIDEO_LINKS,
    other: 1,
    shop: 1,
    vendor: 1,
  };
  const used: Record<ResourceKind, number> = {
    repo: 0,
    doc: 0,
    video: 0,
    other: 0,
    shop: 0,
    vendor: 0,
  };
  const selected: ResourceLink[] = [];

  // Die blosse Startseite des Herstellers kommt nur mit, wenn es sonst keine
  // Anleitung gibt. Steht das Wiki schon da, sagt "www.seeedstudio.com/" nichts
  // mehr dazu — und das ist bei 54 von 80 Repos woertlich derselbe Link.
  // Bei kleinen Herstellern wie sensebox.de oder makeymakey.com IST die
  // Startseite die Doku, dort bleibt sie drin.
  const hasDoc = sorted.some(resource => resource.kind === "doc");

  for (const resource of sorted) {
    if (resource.kind === "vendor" && hasDoc) continue;
    if (used[resource.kind] >= perKindLimit[resource.kind]) continue;
    selected.push({
      label: resource.label,
      url: resource.url,
      kind: resource.kind,
      image: resource.image,
      icon: resource.icon,
      repo: resource.repo,
    });
    used[resource.kind] += 1;
    // Videos zaehlen nicht gegen das Platzbudget: sie belegen zusammen eine
    // einzige Zeile, egal wie viele es sind.
    if (selected.filter(r => r.kind !== "video").length >= MAX_RESOURCE_LINKS) break;
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
 * Zwei Wege hinein, und der erste ist der wichtigere:
 *
 * 1. Die Person hat das Bauteil genannt. Dann hat die Stichwortsuche oder die
 *    Materialnummer das Repo gefunden (chunk.match), und ein einziger Treffer
 *    reicht — er ist ja keiner aus Versehen.
 * 2. Sonst zaehlt, wie viele Chunks aus dem Repo kommen. Ein einzelner Chunk
 *    aus der Bedeutungssuche ist meist ein Streifschuss und soll weder Bild
 *    noch Link stellen.
 *
 * Punkt 1 fehlte und hat konkret wehgetan: die Stichwortsuche liefert per
 * ROW_NUMBER genau EINEN Chunk pro Repo. Ein Repo, das nur ueber sie gefunden
 * wird, konnte die Zwei-Chunk-Huerde damit nie nehmen. Bei "wie fange ich mit
 * Arduino an" fiel so der UNO R4 WiFi komplett raus — kein Bild, kein Link —,
 * obwohl die Suche ihn als besten Treffer geliefert hatte.
 */
/**
 * Kurzsteckbrief der Bauteile, auf die sich die Antwort stuetzt.
 *
 * Wird dem Modell zusaetzlich zum abgerufenen Text mitgegeben, damit ein
 * Vergleich ueberhaupt moeglich ist: "welches ist einfacher" laesst sich nicht
 * beantworten, wenn difficulty nur zufaellig im Kontext steht.
 *
 * Bewusst knapp — das sind vier Angaben pro Bauteil, kein zweiter Kontextblock.
 */
const buildRepoBriefing = (repos: string[]): string => {
  const lines: string[] = [];
  for (const repo of repos) {
    const facts = repoFacts(repo);
    if (!facts) continue;
    const parts = [facts.title ?? repo];
    if (facts.materialNumber) parts.push(`Materialnummer ${facts.materialNumber}`);
    if (facts.difficulty) parts.push(`Schwierigkeit ${facts.difficulty}`);
    if (facts.status) parts.push(`Status ${facts.status}`);
    lines.push(`- ${repo}: ${parts.join(", ")}`);
  }
  if (lines.length === 0) return "";
  return `Eckdaten der Bauteile im Kontext:\n${lines.join("\n")}`;
};

const pickFocusedRepos = (
  retrievalQuery: string,
  chunks: Array<{ repo: string; match?: ChunkMatch }>
): string[] => {
  if (chunks.length === 0) return [];
  // Eine Materialnummer meint genau ein Bauteil, da gibt es nichts zu waehlen.
  if (extractMaterialNumber(retrievalQuery)) {
    const first = chunks[0]?.repo;
    return first ? [first] : [];
  }

  const counts = new Map<string, number>();
  const named = new Set<string>();
  // Wo ein Repo zum ersten Mal auftaucht. chunks kommt in Relevanzreihenfolge
  // aus retrieve(), das ist die beste Rangfolge, die wir haben.
  const firstSeen = new Map<string, number>();
  for (const [index, chunk] of chunks.entries()) {
    counts.set(chunk.repo, (counts.get(chunk.repo) ?? 0) + 1);
    if (!firstSeen.has(chunk.repo)) firstSeen.set(chunk.repo, index);
    if (chunk.match && chunk.match !== "semantic") named.add(chunk.repo);
  }

  const ranked = [...counts.entries()].sort(
    // Beim Namen genannte Repos zuerst, danach nach Trefferzahl — und bei
    // Gleichstand nach der Reihenfolge der Suche.
    //
    // Frueher stand hier alphabetisch. Das sah harmlos aus, hat aber bei
    // Gleichstand den besten Treffer verworfen: sind drei Repos genannt und
    // nur zwei duerfen durch, gewann "Calliope" gegen "mks-Arduino-UNO_R3",
    // nur weil C vor m kommt.
    (a, b) =>
      Number(named.has(b[0])) - Number(named.has(a[0])) ||
      b[1] - a[1] ||
      (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0)
  );
  if (chunks.length === 1) return ranked[0] ? [ranked[0][0]] : [];

  const eligible = ranked.filter(([repo, count]) => named.has(repo) || count >= 2);
  const top = eligible[0];
  if (!top) return [];

  // Ein zweites Repo nur, wenn es wirklich gleichrangig ist.
  //
  // "Zeig immer bis zu zwei" waere falsch: bei "wie schliesse ich den Taster
  // an" gibt es genau ein richtiges Bauteil, und ein zweites daneben stiftet
  // Verwirrung. Bei "wie messe ich Entfernung" gibt es dagegen mehrere
  // sinnvolle Bauteile, und dann ist die Auswahl die eigentliche Antwort.
  //
  // Gleichrangig heisst: derselbe Fundweg. Beide beim Namen genannt, oder beide
  // nur thematisch gefunden. Ein beim Namen genanntes Bauteil und ein bloss
  // thematisch passendes sind keine Alternativen zueinander — da ist das
  // genannte gemeint und das andere Beifang.
  //
  // Innerhalb desselben Fundwegs reicht die Huerde von oben. Ueber die
  // Trefferzahl hinaus noch feiner zu sortieren waere Zahlendreherei: 3 gegen
  // 2 Chunks sagt nichts darueber, ob zwei Sensoren dieselbe Aufgabe loesen.
  const rest = eligible.slice(1).filter(([repo]) => named.has(repo) === named.has(top[0]));

  return [top, ...rest].slice(0, MAX_FOCUSED_REPOS).map(([repo]) => repo);
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
  // Wird weiter unten um die Eckdaten der Fokus-Repos ergaenzt, sobald
  // feststeht, welche das sind.
  let briefing = "";

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

    briefing = buildRepoBriefing(focusedRepos);

    debugLog("chat", "supplement selection", {
      focusedRepos,
      showResources,
      showImage,
      showExample,
      setupIntent: asksForSetupHelp(lastUser.content),
    });

    const resources = showResources ? extractResources(focusedChunks, focusedRepos) : [];
    if (resources.length > 0) {
      debugLog("chat", "resources emitted", resources);
      yield { type: "resources", resources };
    } else {
      debugLog("chat", "no structured resources extracted");
    }

    // Die Fotos stehen direkt unter der Antwort, nicht nur klein auf den
    // Link-Karten ganz unten.
    //
    // Sie waren kurzzeitig rausgefiltert, weil dasselbe Foto dann zweimal in
    // der Blase steht. Die beiden tun aber Verschiedenes: oben beantworten sie
    // "welches der beiden liegt vor mir?", waehrend im Text genau darueber
    // geredet wird — unten sind sie nur das Erkennungszeichen eines Links. Wer
    // die Frage "welches Board hast du?" liest, soll nicht erst an drei
    // Absaetzen vorbeiscrollen, um die Boards zu sehen.
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
    {
      role: "user" as const,
      content: buildUserMessage(lastUser.content, briefing ? `${briefing}\n\n${context}` : context),
    },
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
