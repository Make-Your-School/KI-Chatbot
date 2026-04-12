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

const HELPFUL_LINKS_HEADING_RE = /^hilfreich(?:e|er)\s+link(?:s)?:\s*$/i;

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
    if (HELPFUL_LINKS_HEADING_RE.test(lines[i].trim())) headingIndex = i;
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

const getAssistantPresentation = (text, resources = []) => {
  const extracted = extractTextResources(text || "");
  return {
    content: extracted.content,
    resources: mergeResources(extracted.resources, resources),
  };
};

const hostLabel = (href) => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
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
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  for (let i = 0; i < linkTokens.length; i += 1) {
    html = html.replace(`__LINK_${i}__`, linkTokens[i]);
  }

  return html;
};

const renderAssistantMarkdown = (text) => {
  if (!text.trim()) return "";

  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let currentListItem = null;
  let codeFence = null;
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    if (currentListItem) {
      listItems.push(currentListItem.join(" ").trim());
      currentListItem = null;
    }
    blocks.push(
      `<${listType}>${listItems
        .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
        .join("")}</${listType}>`
    );
    listType = null;
    listItems = [];
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
    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);

    if (trimmed.startsWith("```")) {
      if (codeFence === null) {
        flushParagraph();
        flushList();
        codeFence = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        flushCodeBlock();
      }
      continue;
    }

    if (codeFence !== null) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (orderedMatch || unorderedMatch) {
      flushParagraph();
      const nextType = orderedMatch ? "ol" : "ul";
      const content = (orderedMatch?.[1] ?? unorderedMatch?.[1] ?? "").trim();

      if (listType && listType !== nextType) flushList();
      if (!listType) listType = nextType;

      if (currentListItem) listItems.push(currentListItem.join(" ").trim());
      currentListItem = [content];
      continue;
    }

    if (listType) {
      if (!currentListItem) currentListItem = [trimmed];
      else currentListItem.push(trimmed);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushCodeBlock();

  if (blocks.length === 0) {
    return `<p>${renderInlineMarkdown(text)}</p>`;
  }

  return blocks.join("");
};

const setBubbleContent = (bubble, role, text) => {
  const contentEl = bubble.querySelector(".bubble-content");
  if (!contentEl) return;

  if (role === "assistant") {
    contentEl.innerHTML = renderAssistantMarkdown(getAssistantPresentation(text).content);
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

const makeResourcesBlock = (resources) => {
  if (!resources || resources.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "resources";

  const label = document.createElement("strong");
  label.textContent = "Hilfreiche Links:";
  wrap.appendChild(label);

  const list = document.createElement("div");
  list.className = "resource-list";

  const seen = new Set();
  for (const resource of resources) {
    const safeHref = safeUrl(resource?.url || "");
    const canonical = canonicalUrl(resource?.url || "");
    if (!safeHref || !canonical || seen.has(canonical) || shouldHideLink(safeHref)) continue;
    seen.add(canonical);

    const link = document.createElement("a");
    link.className = "resource-link";
    link.href = safeHref;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.dataset.kind = resource.kind || "other";

    const title = document.createElement("span");
    title.className = "resource-link-label";
    title.textContent = resource.label || safeHref;

    const host = document.createElement("span");
    host.className = "resource-link-host";
    host.textContent = hostLabel(safeHref);

    link.appendChild(title);
    link.appendChild(host);
    list.appendChild(link);
  }

  if (!list.childNodes.length) return null;
  wrap.appendChild(list);
  return wrap;
};

const makeSourcesBlock = (sources) => {
  if (!sources || sources.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "sources";
  const label = document.createElement("strong");
  label.textContent = "Kontextquellen:";
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

      const host = document.createElement("span");
      host.className = "resource-link-host";
      host.textContent = hostLabel(href);

      link.appendChild(title);
      link.appendChild(host);
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
  wrap.appendChild(list);
  return wrap;
};

const makeImageBlock = (image) => {
  if (!image || typeof image.url !== "string") return null;
  const safeHref = safeUrl(image.url);
  if (!safeHref) return null;

  const wrap = document.createElement("div");
  wrap.className = "answer-image";

  const link = document.createElement("a");
  link.href = safeHref;
  link.target = "_blank";
  link.rel = "noreferrer";

  const img = document.createElement("img");
  img.src = safeHref;
  img.alt = `Bild aus ${image.repo}/${image.path}`;
  img.loading = "lazy";
  img.decoding = "async";

  link.appendChild(img);
  wrap.appendChild(link);
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
  wrap.appendChild(pre);
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
      const image = makeImageBlock(msg.image);
      if (image) bubble.appendChild(image);
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

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const code = codeInput.value.trim();
  if (!code) return;
  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.ok) {
      loginError.textContent = body.error || "Login fehlgeschlagen.";
      loginError.hidden = false;
      return;
    }
    codeInput.value = "";
    showView("chat");
  } catch (err) {
    loginError.textContent = "Netzwerkfehler. Versuch es gleich noch mal.";
    loginError.hidden = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  const body = await fetch("/api/logout", { method: "POST" })
    .then((resp) => resp.json().catch(() => ({})))
    .catch(() => ({}));
  history = [];
  saveHistory(history);
  showView(body?.bypassAuth ? "chat" : "login");
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
  let image = null;
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
      headers: { "Content-Type": "application/json" },
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
          setBubbleContent(assistantBubble, "assistant", assistantText);
          scrollToBottom();
        } else if (event.type === "sources") {
          sources = event.sources;
        } else if (event.type === "resources") {
          resources = event.resources;
        } else if (event.type === "image") {
          image = event.image || null;
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
        image: image || undefined,
        example: example || undefined,
        resources: resources.length > 0 ? resources : undefined,
        sources: sources.length > 0 ? sources : undefined,
      });
      saveHistory(history);
      if (assistantBubble) {
        const imageBlock = makeImageBlock(image);
        if (imageBlock) assistantBubble.appendChild(imageBlock);
        const exampleBlock = makeExampleBlock(example);
        if (exampleBlock) assistantBubble.appendChild(exampleBlock);
        setBubbleContent(assistantBubble, "assistant", presentation.content);
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
