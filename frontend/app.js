// Frontend chat app.
//
// State model:
// - Conversation history lives in sessionStorage under "mys-history".
//   sessionStorage is per-tab, so closing the tab wipes the history — this is
//   intentional and matches the server's "nothing stored" promise.
// - Login status is determined by a successful GET /api/me (server-side cookie).

const $ = (id) => document.getElementById(id);

const loginView = $("login");
const chatView = $("chat");
const loginForm = $("login-form");
const codeInput = $("code-input");
const loginError = $("login-error");
const messagesEl = $("messages");
const starterPromptsEl = $("starter-prompts");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const sendBtn = $("send-btn");
const resetBtn = $("reset-btn");
const logoutBtn = $("logout-btn");

const STORAGE_KEY = "mys-history";
const CLIENT_ID_KEY = "mys-client";

// Random per-browser id, sent with each chat request as the key for the
// per-browser daily limit. It says nothing about who you are and is never
// stored server-side — the rate limiter keeps it in memory until midnight.
// If localStorage is unavailable the server falls back to the session id.
const clientId = (() => {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, "");
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
})();
const STARTER_PROMPTS = [
  "Ich habe noch nie mit Arduino gearbeitet. Wie starte ich am einfachsten?",
  "Wie schließe ich einen Grove-Sensor an ein Arduino-Board an?",
  "Ich habe Material 48. Was ist das und wie benutze ich es?",
  "Ich bekomme beim Hochladen auf den Arduino einen Fehler. Was prüfe ich zuerst?",
];

// ---------- History (sessionStorage) ----------

const loadHistory = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveHistory = (history) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* sessionStorage may be unavailable in some browsers/modes */
  }
};

let history = loadHistory();

const resizeChatInput = () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
};

// ---------- View switching ----------

const showView = (name) => {
  loginView.hidden = name !== "login";
  chatView.hidden = name !== "chat";
  if (name === "chat") {
    chatInput.focus();
    renderAll();
  } else {
    codeInput.focus();
  }
};

// ---------- Rendering ----------

const escapeHtml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeUrl = (href) => {
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    /* ignore invalid URLs */
  }
  return null;
};

const canonicalUrl = (href) => {
  const safeHref = safeUrl(href);
  if (!safeHref) return null;
  return safeHref.replace(/\/$/, "");
};

const HIDDEN_LINK_URLS = new Set([
  "https://github.com/Make-Your-School/mks-welcome",
  "https://github.com/Make-Your-School/mks-welcome/blob/main/public/mks/readme.md",
]);

const shouldHideLink = (href) => {
  const canonical = canonicalUrl(href);
  return canonical ? HIDDEN_LINK_URLS.has(canonical) : false;
};

// The model is asked to end with a "Mehr dazu:" block, which we lift out of the
// text and render as a card instead. It does not always write the heading the
// same way — "**Mehr dazu:**", "### Mehr dazu" and "Mehr dazu" all show up.
// Normalising first means the block is caught in every spelling; missing it
// used to render the links twice, once raw in the text and once in the card.
//
// "Hilfreiche Links" was the old wording. It stays recognised: the prompt change
// only shifts what the model tends to write, and a model that still writes the
// old heading must not end up with a raw link list in the middle of the text.
const HELPFUL_LINKS_HEADING_RE = /^(?:hilfreich(?:e|er)\s+link(?:s)?|mehr\s+dazu|weitere\s+links?)$/i;

const normalizeHeadingLine = (line) =>
  line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*{1,3}\s*/, "")
    .replace(/\*{1,3}$/, "")
    .replace(/\s*:\s*$/, "")
    .replace(/\*{1,3}$/, "")
    .trim();

const isResourceHeading = (line) =>
  HELPFUL_LINKS_HEADING_RE.test(normalizeHeadingLine(line));

// Used while tokens are still streaming in: cut everything from the heading
// onward instead of parsing it. A half-arrived link list parses as "not a link
// block", so the full extractor would show the raw heading for a moment and
// then yank it away again — visible as flicker.
const stripResourceTail = (text) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isResourceHeading(lines[i])) return lines.slice(0, i).join("\n").trimEnd();
  }
  return text;
};

const parseTextResourceLine = (line) => {
  const stripped = line.replace(/^[-*]\s+/, "").trim();
  if (!stripped) return [];

  const markdownMatches = [...stripped.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)];
  if (markdownMatches.length > 0) {
    return markdownMatches
      .map((match) => ({
        label: match[1].trim(),
        url: match[2].trim(),
      }))
      .filter((resource) => !!safeUrl(resource.url));
  }

  const plainMatch = stripped.match(/^(?:(.+?):\s*)?(https?:\/\/\S+)\s*$/);
  if (!plainMatch) return [];

  const url = plainMatch[2].trim();
  if (!safeUrl(url)) return [];

  return [{
    label: plainMatch[1]?.trim() || hostLabel(url),
    url,
  }];
};

const extractTextResources = (text) => {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let headingIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (isResourceHeading(lines[i])) headingIndex = i;
  }

  if (headingIndex < 0) return { content: text, resources: [] };

  const resources = [];
  let blockEndIndex = headingIndex + 1;
  let foundAny = false;
  let seenNonEmptyAfterLinks = false;

  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (foundAny) {
        blockEndIndex = i + 1;
        continue;
      }
      continue;
    }

    const parsed = parseTextResourceLine(trimmed);
    if (parsed.length === 0) {
      if (!foundAny) {
        return { content: text, resources: [] };
      }
      seenNonEmptyAfterLinks = true;
      break;
    }

    resources.push(...parsed);
    foundAny = true;
    blockEndIndex = i + 1;
  }

  if (!foundAny) return { content: text, resources: [] };

  if (!seenNonEmptyAfterLinks) {
    while (blockEndIndex < lines.length && !lines[blockEndIndex].trim()) {
      blockEndIndex += 1;
    }
  }

  const remainingLines = [...lines.slice(0, headingIndex), ...lines.slice(blockEndIndex)];
  while (remainingLines.length > 0 && !remainingLines[0].trim()) {
    remainingLines.shift();
  }
  while (remainingLines.length > 0 && !remainingLines[remainingLines.length - 1].trim()) {
    remainingLines.pop();
  }

  return {
    content: remainingLines.join("\n"),
    resources,
  };
};

const mergeResources = (...resourceLists) => {
  const merged = [];
  const seen = new Set();

  for (const list of resourceLists) {
    for (const resource of list || []) {
      const canonical = canonicalUrl(resource?.url || "");
      if (!canonical || seen.has(canonical) || shouldHideLink(canonical)) continue;
      seen.add(canonical);
      merged.push(resource);
    }
  }

  return merged;
};

// Der Server kennt die Links besser als das Modell.
//
// Beides zu mischen hat Karten verdoppelt: das Modell schreibt "GitHub-Repo
// Arduino UNO R4 WiFi" in seinen Text, der Server schickt dieselbe Adresse aus
// den Repo-Metadaten — mit Bild und geprüfter URL. Zwei Karten fürs selbe Repo,
// eine davon ohne Bild.
//
// Die Links aus dem Text werden weiterhin aus dem Fließtext entfernt (sonst
// stünde die Liste roh mitten in der Antwort), aber nur noch dann als Karten
// gezeigt, wenn der Server gar nichts geschickt hat.
const getAssistantPresentation = (text, resources = []) => {
  const extracted = extractTextResources(text || "");
  return {
    content: extracted.content,
    resources: resources.length > 0 ? resources : extracted.resources,
  };
};

const hostLabel = (href) => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
};

// Practically every link here points at the project's own GitHub org, so a
// "github.com" line under every single card is pure noise. The chip is only
// worth showing when it actually tells you something new — a video, a shop, a
// manufacturer's wiki.
const hostChipLabel = (href) => {
  const host = hostLabel(href);
  return host === "github.com" ? "" : host;
};

/** Appends the host chip to a card, unless there is nothing worth saying. */
const appendHostChip = (node, href) => {
  const text = hostChipLabel(href);
  if (!text) return;
  const host = document.createElement("span");
  host.className = "resource-link-host";
  host.textContent = text;
  node.appendChild(host);
};

// Sternchen als Auszeichnung — aber nicht mitten im Wort.
//
// Diese Anwendung schreibt konsequent "Schüler*innen", "Mentor*in", "eine*n".
// Mit der üblichen Markdown-Regel wird daraus Unsinn: in "hol dir eine*n
// Mentor*in" öffnet das Sternchen nach "eine" eine Kursivstelle und das nach
// "Mentor" schließt sie wieder. Auf dem Bildschirm stand dann "eine*n Mentor*in"
// mit kursivem "n Mentor" — genau in dem Satz, der am häufigsten vorkommt.
//
// Die Lösung ist eine Regel, die es in CommonMark so nicht gibt: ein Sternchen
// leitet nur dann eine Auszeichnung ein, wenn links davon kein Buchstabe und
// keine Ziffer steht, und beendet sie nur, wenn rechts davon keiner steht. Ein
// Sternchen zwischen zwei Wortzeichen ist damit immer ein Gendersternchen.
//
// "*wichtig*" und "**fett**" funktionieren weiterhin, weil dort links ein
// Leerzeichen oder der Zeilenanfang steht und rechts ein Satzzeichen oder das
// Zeilenende.
//
// \p{L} statt [A-Za-zÄÖÜäöü]: deckt auch é, ß und alles andere ab, was in
// deutschen Texten und Bauteilnamen vorkommt.
const WORD = "[\\p{L}\\p{N}]";
const EMPHASIS_RE = {
  strong: new RegExp(`(?<!${WORD})\\*\\*([^*]+)\\*\\*(?!${WORD})`, "gu"),
  em: new RegExp(`(?<!${WORD})\\*([^*]+)\\*(?!${WORD})`, "gu"),
};

const renderInlineMarkdown = (text) => {
  const linkTokens = [];
  const withTokens = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    const safeHref = safeUrl(href);
    if (!safeHref) return label;
    const token = `__LINK_${linkTokens.length}__`;
    linkTokens.push(
      `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    );
    return token;
  });

  let html = escapeHtml(withTokens);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(EMPHASIS_RE.strong, "<strong>$1</strong>");
  html = html.replace(EMPHASIS_RE.em, "<em>$1</em>");

  for (let i = 0; i < linkTokens.length; i += 1) {
    html = html.replace(`__LINK_${i}__`, linkTokens[i]);
  }

  return html;
};

// Chat bubbles are narrow, so h1/h2 would dwarf everything around them. Model
// headings are shifted down two levels and clamped.
const MAX_HEADING_LEVEL = 6;

const renderAssistantMarkdown = (text) => {
  if (!text.trim()) return "";

  const lines = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trim().split("\n");
  const blocks = [];
  let paragraph = [];
  let codeFence = null;
  let codeLines = [];
  let afterBlankLine = false;

  // Nested lists, one stack entry per indentation level. `open` is the item
  // currently being built — it stays open so that a lazy continuation line or a
  // deeper sub-list can still be folded into it.
  let listStack = [];

  const closeItem = (level) => {
    if (level.open === null) return;
    level.items.push(
      `<li>${renderInlineMarkdown(level.open)}${level.children.join("")}</li>`
    );
    level.open = null;
    level.children = [];
  };

  const openLevel = (type, indent, content) => {
    listStack.push({ type, indent, items: [], open: content, children: [] });
  };

  // Close levels until only `depth` remain, folding each finished list into the
  // open item of its parent — or into the block stream at the top level.
  const closeListsTo = (depth) => {
    while (listStack.length > depth) {
      const level = listStack.pop();
      closeItem(level);
      if (level.items.length === 0) continue;
      const html = `<${level.type}>${level.items.join("")}</${level.type}>`;
      const parent = listStack[listStack.length - 1];
      if (!parent) blocks.push(html);
      else if (parent.open !== null) parent.children.push(html);
      else parent.items.push(html);
    }
  };

  const flushLists = () => closeListsTo(0);

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushCodeBlock = () => {
    if (codeFence === null) return;
    const langClass = codeFence ? ` class="language-${escapeHtml(codeFence)}"` : "";
    blocks.push(
      `<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
    );
    codeFence = null;
    codeLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```")) {
      if (codeFence === null) {
        flushParagraph();
        flushLists();
        codeFence = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        flushCodeBlock();
      }
      afterBlankLine = false;
      continue;
    }

    if (codeFence !== null) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      // A blank line does NOT close the list — markdown allows loose lists with
      // blank lines between items. It only marks that the next plain line
      // starts a new paragraph instead of continuing the last list item.
      afterBlankLine = true;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushLists();
      const level = Math.min(headingMatch[1].length + 2, MAX_HEADING_LEVEL);
      blocks.push(
        `<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`
      );
      afterBlankLine = false;
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);

    if (orderedMatch || unorderedMatch) {
      flushParagraph();
      const type = orderedMatch ? "ol" : "ul";
      const content = (orderedMatch?.[1] ?? unorderedMatch?.[1] ?? "").trim();
      const indent = rawLine.length - rawLine.trimStart().length;

      // Dedent: close every level that sits deeper than this line.
      while (listStack.length > 0 && indent < listStack[listStack.length - 1].indent) {
        closeListsTo(listStack.length - 1);
      }

      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        openLevel(type, indent, content);
      } else if (top.type !== type) {
        // Same level, different marker — that's a new list, not a new item.
        closeListsTo(listStack.length - 1);
        openLevel(type, indent, content);
      } else {
        closeItem(top);
        top.open = content;
        top.children = [];
      }
      afterBlankLine = false;
      continue;
    }

    if (listStack.length > 0) {
      if (afterBlankLine) {
        flushLists();
        paragraph.push(trimmed);
      } else {
        // Lazy continuation of the current item.
        const top = listStack[listStack.length - 1];
        top.open = top.open === null ? trimmed : `${top.open} ${trimmed}`;
      }
      afterBlankLine = false;
      continue;
    }

    paragraph.push(trimmed);
    afterBlankLine = false;
  }

  flushParagraph();
  flushLists();
  flushCodeBlock();

  if (blocks.length === 0) {
    return `<p>${renderInlineMarkdown(text)}</p>`;
  }

  return blocks.join("");
};

// Kopierknopf für Codeblöcke.
//
// Abtippen ist bei Schüler*innen, die zum ersten Mal programmieren, die
// häufigste Fehlerquelle überhaupt — ein vergessenes Semikolon und nichts geht
// mehr. Der Knopf spart genau das.
const copyToClipboard = async (text) => {
  // Die Zwischenablage-Schnittstelle gibt es nur in sicherem Kontext. In
  // Produktion läuft alles über https, aber bei einem lokalen Test über http
  // fehlt sie — dann der alte Weg über ein unsichtbares Textfeld.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* z.B. abgelehnte Berechtigung — unten weiterversuchen */
    }
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
};

const addCopyButton = (pre) => {
  if (pre.querySelector(".code-copy")) return;
  pre.classList.add("has-copy");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "code-copy";
  button.textContent = "Kopieren";

  let resetTimer = null;
  button.addEventListener("click", async () => {
    const ok = await copyToClipboard(pre.querySelector("code")?.textContent ?? "");
    button.textContent = ok ? "Kopiert" : "Ging nicht";
    button.classList.toggle("is-done", ok);
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.textContent = "Kopieren";
      button.classList.remove("is-done");
    }, 1600);
  });

  pre.appendChild(button);
};

/** Hängt an jeden Codeblock unterhalb von root einen Kopierknopf. */
const addCopyButtons = (root) => {
  for (const pre of root.querySelectorAll("pre")) addCopyButton(pre);
};

const setBubbleContent = (bubble, role, text, { streaming = false } = {}) => {
  const contentEl = bubble.querySelector(".bubble-content");
  if (!contentEl) return;

  if (role === "assistant") {
    // While tokens are arriving the link block is only cut off, not parsed —
    // parsing a half-written list makes the block appear and vanish again.
    const content = streaming
      ? stripResourceTail(text)
      : getAssistantPresentation(text).content;
    contentEl.innerHTML = renderAssistantMarkdown(content);
    // Während des Streamens nicht: der Inhalt wird bei jedem Token neu gesetzt,
    // der Knopf wäre bei jedem Wort weg und wieder da. Und ein halb
    // geschriebener Codeblock ist ohnehin nichts zum Kopieren.
    if (!streaming) addCopyButtons(contentEl);
    return;
  }

  contentEl.textContent = text;
};

const makeBubble = (role, text) => {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  const content = document.createElement("div");
  content.className = "bubble-content";
  div.appendChild(content);
  setBubbleContent(div, role, text);
  return div;
};

const makeTypingBubble = () => {
  const div = document.createElement("div");
  div.className = "bubble assistant";
  div.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  return div;
};

const providerLabel = (provider) => {
  if (provider === "gemini") return "Gemini";
  if (provider === "openrouter") return "OpenRouter";
  return provider || "?";
};

const makeMetaBlock = (meta) => {
  if (!meta || !meta.provider || !meta.model) return null;
  const div = document.createElement("div");
  div.className = "msg-meta";
  div.textContent = `via ${providerLabel(meta.provider)} · ${meta.model}`;
  return div;
};

// Bildquelle fuer eine Karte. Neben echten URLs sind eigene Pfade erlaubt —
// Video-Vorschaubilder liegen unter /api/video-thumb/<id>, damit der Browser
// nichts bei YouTube anfragt. "//host/..." ist bewusst ausgeschlossen: das waere
// wieder ein fremder Server.
const safeImageSrc = (src) => {
  if (typeof src !== "string" || !src) return null;
  if (src.startsWith("/") && !src.startsWith("//")) return src;
  return safeUrl(src);
};

// Das kleine Seitensymbol, links oben in der Ecke der Karte. Fuer Links, die
// kein Vorschaubild hergeben — arduino.cc etwa hat kein og:image, aber ein
// Logo, und das sagt schon, wo der Link hinfuehrt.
const attachIcon = (node, src) => {
  const href = safeImageSrc(src);
  if (!href) return;
  node.classList.add("has-icon");
  const img = document.createElement("img");
  img.className = "resource-icon";
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => {
    img.remove();
    node.classList.remove("has-icon");
  });
  img.src = href;
  node.prepend(img);
};

// Das Bild einer Karte, in zwei Stufen: grosses Vorschaubild, sonst das kleine
// Seitensymbol, sonst reiner Text.
//
// Der Server weiss beim Zusammenstellen der Antwort noch nicht, was eine fremde
// Seite hergibt — er muesste sie dafuer erst abrufen und die Antwort so lange
// aufhalten. Also schickt er beide Adressen mit und der Browser probiert sie
// der Reihe nach durch.
const attachThumb = (node, src, iconSrc) => {
  const href = safeImageSrc(src);
  if (!href) {
    attachIcon(node, iconSrc);
    return;
  }
  node.classList.add("has-thumb");
  const img = document.createElement("img");
  img.className = "resource-thumb";
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => {
    img.remove();
    node.classList.remove("has-thumb");
    attachIcon(node, iconSrc);
  });
  img.src = href;
  node.prepend(img);
};

// Ein Stapel Vorschaubilder, leicht gefächert — so sieht man auf einen Blick,
// dass hinter der Karte mehrere Videos stecken, ohne sie alle auszubreiten.
// Höchstens drei: ab da wird es Matsch statt Stapel.
const STACK_MAX = 3;

const attachThumbStack = (node, sources) => {
  const hrefs = sources.map(safeImageSrc).filter(Boolean).slice(0, STACK_MAX);
  if (hrefs.length === 0) return;
  if (hrefs.length === 1) {
    attachThumb(node, hrefs[0]);
    return;
  }

  node.classList.add("has-thumb", "has-stack");
  const stack = document.createElement("span");
  stack.className = "resource-stack";

  // Von hinten nach vorn einfügen: das vorderste Bild steht zuletzt im DOM und
  // liegt damit ohne z-index-Gefummel oben.
  for (const [index, href] of [...hrefs].reverse().entries()) {
    const img = document.createElement("img");
    img.className = "resource-stack-img";
    // 0 ist das vorderste Bild, 1 und 2 liegen dahinter. Das CSS dreht danach —
    // die vorderste Karte bleibt gerade, die anderen schauen schräg hervor.
    img.dataset.depth = String(hrefs.length - 1 - index);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    // Fällt ein Bild aus, verschwindet nur dieses. Sind am Ende alle weg,
    // wird aus der Karte wieder eine reine Textkarte.
    img.addEventListener("error", () => {
      img.remove();
      if (!stack.querySelector("img")) {
        stack.remove();
        node.classList.remove("has-thumb", "has-stack");
      }
    });
    img.src = href;
    stack.appendChild(img);
  }

  node.prepend(stack);
};

const makeResourceLink = (resource, safeHref) => {
  const link = document.createElement("a");
  link.className = "resource-link";
  link.href = safeHref;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.dataset.kind = resource.kind || "other";

  const title = document.createElement("span");
  title.className = "resource-link-label";
  title.textContent = resource.label || safeHref;
  link.appendChild(title);
  // Das blosse Wort "Video" über einem Vorschaubild mit Play-Dreieck sagt
  // nichts, was das Bild nicht schon sagt — der Host darunter schon. Hat das
  // Video eine echte Beschriftung ("Video: Aufbau"), bleibt sie stehen; die
  // hat jemand von Hand geschrieben. Für Screenreader bleibt der Text da, er
  // wird nur unsichtbar gestellt.
  if (link.dataset.kind === "video" && /^videos?$/i.test(title.textContent.trim())) {
    link.classList.add("is-labelless");
  }
  appendHostChip(link, safeHref);

  // Repo-Karten tragen das Foto des Bauteils, Video-Karten das Vorschaubild.
  // Ohne das unterscheiden sich die beiden Arduino-Karten um drei Zeichen im
  // Text, und fuenf Video-Karten sehen alle gleich aus.
  attachThumb(link, resource?.image, resource?.icon);
  return link;
};

// Eine Karte, die die übrigen Videokarten ein- und ausblendet.
//
// Bewusst KEIN <details>: dessen Inhalt liegt im selben Kasten wie die Karte,
// und sobald er aufklappt, wächst der Kasten und schiebt die Karte an eine
// andere Stelle. Stattdessen ist die Karte ein Knopf im Kartenraster und die
// Videoliste ein Rasterfeld über die volle Breite, das direkt hinter dem Knopf
// im DOM steht — es öffnet sich also in der Zeile unter ihm und nicht am Ende
// des ganzen Rasters.
//
// Der Stapel plus Play-Dreieck sagt schon "hier sind mehrere Videos", deshalb
// ohne sichtbaren Text. Für Screenreader steht die Beschriftung im aria-label,
// und sie wird wieder sichtbar, falls die Vorschaubilder nicht laden.
const makeVideoGroup = (videos, list) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "resource-link is-videogroup";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `${videos.length} Videos anzeigen`);

  const title = document.createElement("span");
  title.className = "resource-link-label";
  title.textContent = `${videos.length} Videos`;
  button.appendChild(title);

  attachThumbStack(button, videos.map((entry) => entry.resource?.image));

  const panel = document.createElement("div");
  panel.className = "resource-list resource-videolist";
  panel.hidden = true;
  for (const entry of videos) {
    panel.appendChild(makeResourceLink(entry.resource, entry.safeHref));
  }
  // Der Knopf zeigt auf sein Panel, damit Screenreader den Bezug haben —
  // sichtbar steht es ohnehin direkt darunter.
  panel.id = `videolist-${Math.random().toString(36).slice(2, 9)}`;
  button.setAttribute("aria-controls", panel.id);

  button.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", `${videos.length} Videos ${open ? "ausblenden" : "anzeigen"}`);
  });

  list.appendChild(button);
  list.appendChild(panel);
};

const makeResourcesBlock = (resources) => {
  if (!resources || resources.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "resources";

  const label = document.createElement("strong");
  label.textContent = "Mehr dazu:";
  wrap.appendChild(label);

  const list = document.createElement("div");
  list.className = "resource-list";

  const seen = new Set();
  const usable = [];
  for (const resource of resources) {
    const safeHref = safeUrl(resource?.url || "");
    const canonical = canonicalUrl(resource?.url || "");
    if (!safeHref || !canonical || seen.has(canonical) || shouldHideLink(safeHref)) continue;
    seen.add(canonical);
    usable.push({ resource, safeHref });
  }

  const videos = usable.filter(entry => entry.resource.kind === "video");

  // Die Karten stehen in der Reihenfolge, die der Server geschickt hat: Repo,
  // Anleitung, Video, Hersteller, Shop. Die Videogruppe rutscht an die Stelle
  // des ERSTEN Videos statt ans Ende — vorher liefen erst alle anderen Karten
  // durch und dann die Videos, wodurch der Shop vor den Videos landete,
  // obwohl der Server ihn längst dahinter einsortiert hatte.
  let videoPlaced = false;
  for (const entry of usable) {
    if (entry.resource.kind !== "video") {
      list.appendChild(makeResourceLink(entry.resource, entry.safeHref));
      continue;
    }
    if (videoPlaced) continue;
    videoPlaced = true;
    // Ein Video ist eine Karte. Fünf sind eine Wand — und fünf ist genau das,
    // was die zwei Arduino-Boards mitbringen. Ab zwei klappen sie deshalb zu
    // einer Karte zusammen, die beim Klicken die übrigen zeigt.
    if (videos.length === 1) {
      list.appendChild(makeResourceLink(entry.resource, entry.safeHref));
    } else {
      makeVideoGroup(videos, list);
    }
  }

  if (!list.childNodes.length) return null;
  wrap.appendChild(list);
  return wrap;
};

// Collapsed by default.
//
// This list is honesty, not navigation: it says which files the answer was
// built from. Retrieval always returns a fixed number of chunks, so a few of
// them are near-misses the model never used — and five long repo paths under
// every answer buried the two or three links that are actually worth clicking.
// Folding it away keeps the receipt without letting it shout.
const makeSourcesBlock = (sources) => {
  if (!sources || sources.length === 0) return null;
  const wrap = document.createElement("details");
  wrap.className = "sources";
  const label = document.createElement("summary");
  wrap.appendChild(label);
  const list = document.createElement("div");
  list.className = "resource-list";
  // de-duplicate by final destination if available, else by repo/path
  const seen = new Set();
  for (const s of sources) {
    const href = s.sourceUrl || s.repoUrl;
    const canonical = href ? canonicalUrl(href) : `${s.repo}/${s.path}`;
    if (!canonical || seen.has(canonical) || (href && shouldHideLink(href))) continue;
    seen.add(canonical);
    const labelText = `${s.repo}/${s.path}`;
    if (href) {
      const link = document.createElement("a");
      link.className = "resource-link";
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";

      const title = document.createElement("span");
      title.className = "resource-link-label source-link-label";
      title.textContent = labelText;

      link.appendChild(title);
      appendHostChip(link, href);
      list.appendChild(link);
    } else {
      const item = document.createElement("div");
      item.className = "resource-link source-link-static";

      const title = document.createElement("span");
      title.className = "resource-link-label source-link-label";
      title.textContent = labelText;

      item.appendChild(title);
      list.appendChild(item);
    }
  }

  if (!list.childNodes.length) return null;
  const count = list.childNodes.length;
  label.textContent = `Grundlage der Antwort (${count} ${count === 1 ? "Datei" : "Dateien"})`;
  wrap.appendChild(list);
  return wrap;
};

// Older histories in localStorage carry a single `image`; new ones carry
// `images`. Reading both means a tab that was open across the deploy keeps its
// pictures instead of silently losing them.
const imageList = (msg) => {
  if (Array.isArray(msg?.images)) return msg.images;
  return msg?.image ? [msg.image] : [];
};

// A repo name is a poor alt text for a screen reader. The part is what the
// picture actually shows, and it is the last path segment of the repo name:
// "mks-Arduino-UNO_R3" -> "Arduino UNO_R3".
const partNameFromRepo = (repo) =>
  String(repo || "")
    .replace(/^m(?:ks|ys)[-_]/i, "")
    // "generic" is the placeholder for "no particular manufacturer" — it names
    // nothing and only makes the caption longer.
    .replace(/^generic[-_]/i, "")
    .replace(/[-_]+/g, " ")
    .trim();

// Wo im Text gehört das Bild hin?
//
// Der Server schickt zu jedem Bild den Namen des Bauteils mit — denselben, den
// das Modell im Text benutzt, beide stammen aus material_short_descr. Gesucht
// wird also der erste Absatz, in dem einer dieser Namen vorkommt; direkt
// darunter landen die Fotos.
//
// Findet sich keiner, bleibt es beim alten Verhalten: ans Ende der Antwort.
// Lieber unten als an einer willkürlichen Stelle.
const looseText = (value) => String(value || "").toLowerCase().replace(/[\s\-_]/g, "");

const findMentionParagraph = (content, images) => {
  const names = images.map((image) => looseText(image?.label)).filter((name) => name.length >= 4);
  if (names.length === 0) return null;

  for (const node of content.querySelectorAll("p, li")) {
    const haystack = looseText(node.textContent);
    if (names.some((name) => haystack.includes(name))) return node;
  }
  return null;
};

/**
 * Hängt die Fotos an die Stelle, an der im Text über die Bauteile geredet wird.
 * Klappt das nicht, werden sie unten an die Blase gehängt.
 */
const placeImages = (bubble, images) => {
  const list = Array.isArray(images) ? images : [];
  const block = makeImagesBlock(list);
  if (!block) return;

  const content = bubble.querySelector(".bubble-content");
  const anchor = content ? findMentionParagraph(content, list) : null;
  if (!anchor) {
    bubble.appendChild(block);
    return;
  }
  // Im Fließtext kleiner: die Fotos sollen den Absatz begleiten, nicht ihn
  // unterbrechen.
  block.classList.add("is-inline");
  anchor.after(block);
};

const makeImagesBlock = (images) => {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) return null;

  const wrap = document.createElement("div");
  wrap.className = "answer-images";

  let shown = 0;
  for (const image of list.slice(0, 2)) {
    const safeHref = safeUrl(image?.url || "");
    if (!safeHref) continue;

    const figure = document.createElement("figure");
    figure.className = "answer-image";

    const link = document.createElement("a");
    link.href = safeHref;
    link.target = "_blank";
    link.rel = "noreferrer";

    const img = document.createElement("img");
    const part = partNameFromRepo(image.repo);
    img.alt = part ? `Foto: ${part}` : `Bild aus ${image.repo}/${image.path}`;
    img.loading = "lazy";
    img.decoding = "async";
    // Raw URLs go stale (file renamed, repo gone private, branch called master).
    // Without this the bubble shows a broken-image icon instead of nothing.
    // Only this one picture disappears — a second, working one stays.
    img.addEventListener("error", () => figure.remove());
    img.src = safeHref;

    link.appendChild(img);
    figure.appendChild(link);

    // Two pictures without labels are a riddle, not an answer: the whole point
    // of showing both boards is being able to tell which one is which.
    if (list.length > 1 && part) {
      figure.appendChild(Object.assign(document.createElement("figcaption"), {
        className: "answer-image-caption",
        textContent: part,
      }));
    }

    wrap.appendChild(figure);
    shown += 1;
  }

  if (shown === 0) return null;
  wrap.classList.toggle("is-pair", shown > 1);
  return wrap;
};

const makeExampleBlock = (example) => {
  if (!example || typeof example.code !== "string" || !example.code.trim()) return null;

  const wrap = document.createElement("div");
  wrap.className = "example-code";

  const title = document.createElement("strong");
  title.textContent = "Beispielcode:";
  wrap.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "example-code-meta";
  if (typeof example.sourceUrl === "string" && safeUrl(example.sourceUrl)) {
    const link = document.createElement("a");
    link.href = example.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${example.repo}/${example.path}`;
    meta.appendChild(link);
  } else {
    meta.textContent = `${example.repo}/${example.path}`;
  }
  wrap.appendChild(meta);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = example.code;
  pre.appendChild(code);
  addCopyButton(pre);
  wrap.appendChild(pre);

  if (example.truncated) {
    const note = document.createElement("div");
    note.className = "example-code-note";
    note.textContent = "Gekürzt — die vollständige Datei steht im verlinkten Repo.";
    wrap.appendChild(note);
  }

  return wrap;
};

const renderStarterPrompts = () => {
  starterPromptsEl.innerHTML = "";

  if (history.length !== 0) {
    starterPromptsEl.hidden = true;
    return;
  }

  starterPromptsEl.hidden = false;

  const label = document.createElement("div");
  label.className = "starter-prompts-label";
  label.textContent = "Zum Starten zum Beispiel:";
  starterPromptsEl.appendChild(label);

  const list = document.createElement("div");
  list.className = "starter-prompts-list";

  for (const prompt of STARTER_PROMPTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "starter-prompt";
    button.textContent = prompt;
    button.addEventListener("click", () => {
      chatInput.value = prompt;
      resizeChatInput();
      chatInput.focus();
      chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    });
    list.appendChild(button);
  }

  starterPromptsEl.appendChild(list);
};

const renderAll = () => {
  messagesEl.innerHTML = "";
  renderStarterPrompts();
  if (history.length === 0) {
    const hint = makeBubble(
      "assistant",
      "Hey! Ich bin dein Mentor*innen KI Chat. Erzähl mir, was du gerade baust oder wo du nicht weiterkommst — ich stell dir gern ein paar Fragen, damit wir zusammen einen Weg finden."
    );
    messagesEl.appendChild(hint);
    return;
  }
  for (const msg of history) {
    const presentation = msg.role === "assistant"
      ? getAssistantPresentation(msg.content, msg.resources)
      : { content: msg.content, resources: msg.resources };
    const bubble = makeBubble(msg.role, presentation.content);
    if (msg.role === "assistant") {
      placeImages(bubble, imageList(msg));
      const example = makeExampleBlock(msg.example);
      if (example) bubble.appendChild(example);
      const resources = makeResourcesBlock(presentation.resources);
      if (resources) bubble.appendChild(resources);
      const src = makeSourcesBlock(msg.sources);
      if (src) bubble.appendChild(src);
      const meta = makeMetaBlock(msg.meta);
      if (meta) bubble.appendChild(meta);
    }
    messagesEl.appendChild(bubble);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
};

const scrollToBottom = () => {
  messagesEl.scrollTop = messagesEl.scrollHeight;
};

// ---------- Login flow ----------

const checkSession = async () => {
  try {
    const resp = await fetch("/api/me");
    return resp.ok;
  } catch {
    return false;
  }
};

const submitCode = async (code) => {
  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.ok) {
      return { ok: false, error: body.error || "Login fehlgeschlagen." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Netzwerkfehler. Versuch es gleich noch mal." };
  }
};

const showLoginError = (message) => {
  loginError.textContent = message;
  loginError.hidden = false;
};

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const code = codeInput.value.trim();
  if (!code) return;
  const result = await submitCode(code);
  if (!result.ok) {
    showLoginError(result.error);
    return;
  }
  codeInput.value = "";
  showView("chat");
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  history = [];
  saveHistory(history);
  showView("login");
});

resetBtn.addEventListener("click", () => {
  if (history.length === 0) return;
  if (!confirm("Gesprächsverlauf in diesem Tab löschen?")) return;
  history = [];
  saveHistory(history);
  renderAll();
});

// ---------- Chat send + SSE streaming ----------

const sendMessage = async (text) => {
  const userMsg = { role: "user", content: text };
  history.push(userMsg);
  saveHistory(history);
  renderStarterPrompts();
  messagesEl.appendChild(makeBubble("user", text));

  const typing = makeTypingBubble();
  messagesEl.appendChild(typing);
  scrollToBottom();

  sendBtn.disabled = true;
  chatInput.disabled = true;

  let assistantBubble = null;
  let assistantText = "";
  let sources = [];
  let resources = [];
  let images = [];
  let example = null;
  let modelMeta = null; // { provider, model } once received

  const replaceTypingWithBubble = () => {
    if (assistantBubble) return;
    assistantBubble = makeBubble("assistant", "");
    typing.replaceWith(assistantBubble);
  };

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(clientId ? { "X-Client-Id": clientId } : {}),
      },
      body: JSON.stringify({ messages: history }),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      typing.remove();
      const errBubble = document.createElement("div");
      errBubble.className = "bubble error";
      errBubble.textContent = body.error || `Fehler ${resp.status}`;
      messagesEl.appendChild(errBubble);
      // Roll the user message back out of history so the retry doesn't double-send
      history.pop();
      saveHistory(history);
      renderStarterPrompts();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.type === "token") {
          replaceTypingWithBubble();
          assistantText += event.text;
          setBubbleContent(assistantBubble, "assistant", assistantText, { streaming: true });
          scrollToBottom();
        } else if (event.type === "sources") {
          sources = event.sources;
        } else if (event.type === "resources") {
          resources = event.resources;
        } else if (event.type === "images") {
          images = Array.isArray(event.images) ? event.images : [];
        } else if (event.type === "example") {
          example = event.example || null;
        } else if (event.type === "model") {
          modelMeta = { provider: event.provider, model: event.model };
        } else if (event.type === "error") {
          if (typing.parentNode) typing.remove();
          const errBubble = document.createElement("div");
          errBubble.className = "bubble error";
          errBubble.textContent = event.message || "Unbekannter Fehler.";
          messagesEl.appendChild(errBubble);
          history.pop();
          saveHistory(history);
          renderStarterPrompts();
          return;
        } else if (event.type === "done") {
          /* handled below */
        }
      }
    }

    if (typing.parentNode) typing.remove();
    if (assistantText) {
      const presentation = getAssistantPresentation(assistantText, resources);
      history.push({
        role: "assistant",
        content: assistantText,
        meta: modelMeta || undefined,
        images: images.length > 0 ? images : undefined,
        example: example || undefined,
        resources: resources.length > 0 ? resources : undefined,
        sources: sources.length > 0 ? sources : undefined,
      });
      saveHistory(history);
      if (assistantBubble) {
        // Erst den fertigen Text setzen, dann die Fotos hineinhaengen.
        // setBubbleContent schreibt .bubble-content komplett neu — stand
        // placeImages davor, wurde der Bildblock genau dann wieder geloescht,
        // wenn er seinen Absatz gefunden hatte. Sichtbar war das als "die
        // Fotos fehlen", obwohl sie unterwegs kurz da waren.
        setBubbleContent(assistantBubble, "assistant", presentation.content);
        placeImages(assistantBubble, images);
        const exampleBlock = makeExampleBlock(example);
        if (exampleBlock) assistantBubble.appendChild(exampleBlock);
        const resourcesBlock = makeResourcesBlock(presentation.resources);
        if (resourcesBlock) assistantBubble.appendChild(resourcesBlock);
        const srcBlock = makeSourcesBlock(sources);
        if (srcBlock) assistantBubble.appendChild(srcBlock);
        const metaBlock = makeMetaBlock(modelMeta);
        if (metaBlock) assistantBubble.appendChild(metaBlock);
      }
    }
  } catch (err) {
    if (typing.parentNode) typing.remove();
    const errBubble = document.createElement("div");
    errBubble.className = "bubble error";
    errBubble.textContent = `Netzwerkfehler: ${err.message}`;
    messagesEl.appendChild(errBubble);
    history.pop();
    saveHistory(history);
    renderStarterPrompts();
  } finally {
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
    scrollToBottom();
  }
};

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  chatInput.style.height = "";
  sendMessage(text);
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// Auto-grow textarea
chatInput.addEventListener("input", () => {
  resizeChatInput();
});

// ---------- Boot ----------

(async () => {
  const ok = await checkSession();
  showView(ok ? "chat" : "login");
})();
