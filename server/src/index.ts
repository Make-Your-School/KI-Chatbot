// Hono app entry. Routes:
//   POST /api/login    — exchange Schulcode for signed session cookie
//   POST /api/logout   — clear session cookie
//   GET  /api/me       — check if current session is valid
//   POST /api/chat     — stream a chat reply (SSE)
//   GET  /api/stats    — aggregate usage counters (needs a scope=stats code)
//   GET  /api/video-thumb/:id — YouTube thumbnail, proxied so no request from
//                        a pupil's browser ever reaches Google
//   GET  /api/link-preview/:id — og:image of a linked page, same reasoning
//   GET  /api/link-icon/:id    — that page's favicon, for links without one
//   GET  /api/health   — liveness probe
//   GET  /*            — static frontend files
//
// Intentional non-features:
//   - No access logs of request contents
//   - No conversation storage of any kind
//   - No user IDs beyond the code hash (which is itself hashed from the code)

import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.ts";
import { validateCode, issueSession, verifySession, lookupByHash, listCodes } from "./auth.ts";
import * as stats from "./stats.ts";
import { getThumbnail, VIDEO_ID_RE } from "./videoThumbs.ts";
import { getAsset, PREVIEW_ID_RE, type AssetKind } from "./linkPreviews.ts";
import { streamChat, type ChatMessage } from "./chat.ts";
import { getEmbedder } from "./embeddings.ts";
import { getModels, modelsFilePath } from "./models.ts";
import { tryConsumeDaily, tryConsumeLogin, usageToday, type DailyScope } from "./ratelimit.ts";

const app = new Hono();

// Extract the client IP from proxy headers. Behind Caddy, X-Forwarded-For is
// the canonical source. In dev (no reverse proxy) this falls back to "local"
// — fine, because rate limiting is not the thing guarding dev.
const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string => {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  return "local";
};

// Per-browser rate-limit key. The frontend generates a random id once and keeps
// it in localStorage; it identifies a browser, not a person, and never leaves
// the rate limiter. Anything malformed is ignored — the session id then carries
// the browser bucket too, which is the conservative fallback.
const BROWSER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const clientBrowserId = (
  c: { req: { header: (n: string) => string | undefined } },
  fallback: string
): string => {
  const raw = c.req.header("x-client-id")?.trim();
  return raw && BROWSER_ID_RE.test(raw) ? raw : fallback;
};

const LIMIT_MESSAGE: Record<DailyScope, (limit: number) => string> = {
  code: limit =>
    `Das Tages-Limit dieses Schulcodes ist erreicht (${limit} Anfragen). ` +
    `Bitte einer Mentor*in Bescheid geben oder morgen weitermachen.`,
  session: limit =>
    `Dein Tages-Limit ist erreicht (${limit} Anfragen). Morgen geht es weiter.`,
  browser: limit =>
    `Dein Tages-Limit ist erreicht (${limit} Anfragen). Morgen geht es weiter.`,
};

// --- API routes (registered BEFORE static so they're not shadowed) ---------

app.get("/api/health", c => c.json({ ok: true }));

app.post("/api/login", async c => {
  const ipLimit = tryConsumeLogin(clientIp(c));
  if (!ipLimit.ok) {
    return c.json(
      {
        ok: false,
        error: `Zu viele Login-Versuche (${ipLimit.limit}/Stunde). Bitte eine Stunde warten.`,
      },
      429
    );
  }

  const body = await c.req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) return c.json({ ok: false, error: "Schulcode fehlt." }, 400);

  const record = validateCode(code);
  if (!record) {
    stats.record("login_fail");
    return c.json(
      { ok: false, error: "Ungültiger oder abgelaufener Schulcode." },
      401
    );
  }
  stats.record("login_ok");

  const token = issueSession(record);
  setCookie(c, config.auth.cookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.isProd,
    path: "/",
    // Match the session's own expiry, which is clamped to the code's.
    maxAge: Math.max(
      60,
      Math.min(
        config.auth.sessionTtlSeconds,
        record.expires_at - Math.floor(Date.now() / 1000)
      )
    ),
  });
  return c.json({ ok: true, school: record.school, scope: record.scope });
});

app.post("/api/logout", c => {
  deleteCookie(c, config.auth.cookieName, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", c => {
  const session = verifySession(getCookie(c, config.auth.cookieName));
  if (!session) return c.json({ ok: false }, 401);

  const record = lookupByHash(session.hash);
  if (!record) {
    deleteCookie(c, config.auth.cookieName, { path: "/" });
    return c.json({ ok: false }, 401);
  }
  return c.json({ ok: true, school: record.school, scope: record.scope });
});

// Aggregate counters only — see src/stats.ts for what is and isn't collected.
// Gated behind a code with scope 'stats', so it can be shared with mentors
// without handing them the chat, and revoked like any other code.
app.get("/api/stats", c => {
  const session = verifySession(getCookie(c, config.auth.cookieName));
  if (!session) return c.json({ error: "Nicht eingeloggt." }, 401);

  const record = lookupByHash(session.hash);
  if (!record) {
    deleteCookie(c, config.auth.cookieName, { path: "/" });
    return c.json({ error: "Code nicht mehr gültig." }, 401);
  }
  if (record.scope !== "stats") {
    return c.json({ error: "Dieser Code hat keinen Zugriff auf die Statistik." }, 403);
  }
  return c.json({ ...stats.summary(), quota: quotaToday() });
});

/**
 * How much of today's budget is used up — the "how full is the tank" view.
 *
 * This is deliberately NOT part of stats.ts: the counters there are persisted
 * day totals with no notion of a ceiling, while this is live limiter state that
 * resets on restart. Mixing them would make the /stats page claim a history it
 * does not have.
 *
 * The limiter keys codes by their full hash; the code list only ever exposes
 * the first 8 characters. Matching on that prefix keeps the full hash inside
 * the server — it is not needed for a display, and there is no reason to hand
 * a browser a value that a lookup table could turn back into a code.
 */
const quotaToday = () => {
  const codeUsage = new Map(usageToday("code").map(u => [u.key.slice(0, 8), u.count]));
  const now = Math.floor(Date.now() / 1000);

  const codes = listCodes()
    .filter(code => code.scope === "chat" && code.expires_at > now)
    .map(code => ({
      school: code.school,
      label: code.label,
      used: codeUsage.get(code.hashPrefix) ?? 0,
      limit: code.daily_limit ?? config.rateLimit.perCodePerDay,
    }))
    .sort((a, b) => b.used - a.used || a.school.localeCompare(b.school, "de"));

  // Individual sessions and browsers are not listed. "How many were active and
  // what was the busiest one" is all the page needs to tell whether the
  // per-person limits are anywhere near biting.
  const spread = (scope: "session" | "browser", limit: number) => {
    const rows = usageToday(scope);
    return {
      active: rows.length,
      used: rows.reduce((sum, row) => sum + row.count, 0),
      busiest: rows[0]?.count ?? 0,
      limit,
    };
  };

  return {
    codes,
    sessions: spread("session", config.rateLimit.perSessionPerDay),
    browsers: spread("browser", config.rateLimit.perBrowserPerDay),
  };
};

app.post("/api/chat", async c => {
  const session = verifySession(getCookie(c, config.auth.cookieName));
  if (!session) return c.json({ error: "Nicht eingeloggt." }, 401);

  // The cookie is signed, but that only proves it was issued by us — it says
  // nothing about whether the code behind it still exists. Re-check on every
  // request so `code revoke` and code expiry take effect right away.
  const record = lookupByHash(session.hash);
  if (!record) {
    deleteCookie(c, config.auth.cookieName, { path: "/" });
    return c.json(
      { error: "Dieser Schulcode ist nicht mehr gültig. Bitte neu einloggen." },
      401
    );
  }
  if (record.scope !== "chat") {
    return c.json({ error: "Dieser Code ist nur für die Statistik gedacht." }, 403);
  }

  // Parse and validate before charging quota — a malformed body should not
  // cost anyone a request.
  const body = await c.req.json().catch(() => null);
  const history = Array.isArray(body?.messages) ? (body.messages as ChatMessage[]) : [];
  if (history.length === 0) {
    return c.json({ error: "Keine Nachrichten übergeben." }, 400);
  }

  const limited = tryConsumeDaily([
    {
      scope: "code",
      key: session.hash,
      limit: record.daily_limit ?? config.rateLimit.perCodePerDay,
    },
    { scope: "session", key: session.sid, limit: config.rateLimit.perSessionPerDay },
    {
      scope: "browser",
      key: clientBrowserId(c, session.sid),
      limit: config.rateLimit.perBrowserPerDay,
    },
  ]);
  if (!limited.ok) {
    stats.record("rate_limited");
    return c.json(
      { error: LIMIT_MESSAGE[limited.denied.scope](limited.denied.limit) },
      429
    );
  }
  stats.record("chat");

  // SSE stream to the browser.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };
      const rawWrite = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const write = (ev: unknown): boolean =>
        rawWrite(`data: ${JSON.stringify(ev)}\n\n`);
      // SSE comment as immediate keepalive: signals to browser/proxy that the
      // stream is live, even while the first turn is still doing RAG warmup.
      rawWrite(": connected\n\n");
      // Periodic keepalive during long quiet phases (RAG embedder warmup on
      // cold start, LLM provider fallback after 503s). Without this, Bun's
      // idleTimeout closes the connection silently mid-stream — the frontend
      // then sees no token events and renders nothing.
      const keepalive = setInterval(() => {
        if (closed) return;
        rawWrite(": keepalive\n\n");
      }, 5000);
      try {
        let sawSources = false;
        for await (const ev of streamChat(history)) {
          // Counters only: which provider/model answered and whether the
          // knowledge base had anything to offer. No content, no user.
          if (ev.type === "sources") sawSources = true;
          if (ev.type === "model") {
            stats.record("provider", ev.provider);
            stats.record("model", ev.model);
          }
          if (ev.type === "error") stats.record("chat_error");
          if (!write(ev)) break;
          if (ev.type === "done" || ev.type === "error") {
            stats.record(sawSources ? "rag_hit" : "rag_miss");
            break;
          }
        }
      } catch (err) {
        console.error("[chat] stream error:", err);
        stats.record("chat_error");
        if (!closed) write({ type: "error", message: "Interner Fehler beim Streaming." });
      } finally {
        clearInterval(keepalive);
        close();
      }
    },
    cancel() {
      // Browser or proxy closed the connection while the upstream request was still running.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", // disables nginx buffering if ever proxied
      Connection: "keep-alive",
    },
  });
});

// --- Static frontend (catch-all, registered LAST) --------------------------

app.use("/*", async (c, next) => {
  await next();

  const contentType = c.res.headers.get("Content-Type") ?? "";
  if (
    contentType.includes("text/html") ||
    contentType.includes("javascript") ||
    contentType.includes("text/css")
  ) {
    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
  }
});

// Vorschaubild eines YouTube-Videos, vom eigenen Server ausgeliefert.
//
// Hinter dem Login, damit daraus kein offener Bilder-Proxy fuer Fremde wird.
// Die ID wird streng geprueft und landet nie als Pfadbestandteil irgendwo —
// aus ihr wird ausschliesslich ein Dateiname im eigenen Cache-Ordner.
app.get("/api/video-thumb/:id", async c => {
  if (!verifySession(getCookie(c, config.auth.cookieName))) {
    return c.json({ error: "Nicht eingeloggt." }, 401);
  }
  const id = c.req.param("id");
  if (!VIDEO_ID_RE.test(id)) return c.json({ error: "Ungültige Video-ID." }, 400);

  const image = await getThumbnail(id);
  // 404 statt Platzhalter: die Karte im Browser faellt dann auf reinen Text
  // zurueck, statt ein kaputtes Bild anzuzeigen.
  if (!image) return c.json({ error: "Kein Vorschaubild." }, 404);

  c.header("Content-Type", "image/jpeg");
  // Die Bilder aendern sich nie. Einmal geladen, nie wieder angefragt.
  c.header("Cache-Control", "private, max-age=604800, immutable");
  return c.body(new Uint8Array(image));
});

// Vorschaubild eines externen Links (og:image), ebenfalls vom eigenen Server.
//
// Die Kennung laesst sich nur aufloesen, wenn die Adresse in den eingebetteten
// Repos verlinkt ist — siehe linkPreviews.ts. Damit ist das kein offener
// Abrufdienst, ueber den sich beliebige Adressen ansteuern liessen.
const serveLinkAsset = async (c: Context, kind: AssetKind) => {
  if (!verifySession(getCookie(c, config.auth.cookieName))) {
    return c.json({ error: "Nicht eingeloggt." }, 401);
  }
  // Der generische Context kennt die Route nicht, deshalb kann :id hier
  // theoretisch fehlen. Die Pruefung unten faengt das mit ab.
  const id = c.req.param("id") ?? "";
  if (!PREVIEW_ID_RE.test(id)) return c.json({ error: "Ungültige Kennung." }, 400);

  const asset = await getAsset(id, kind);
  // Viele Seiten haben kein Vorschaubild, manche nicht mal ein Logo. 404 heisst
  // hier "gibt es nicht"; die Karte im Browser faellt eine Stufe zurueck —
  // Vorschau auf Symbol, Symbol auf reinen Text.
  if (!asset) return c.json({ error: "Nicht vorhanden." }, 404);

  c.header("Content-Type", asset.contentType);
  c.header("Cache-Control", "private, max-age=604800");
  return c.body(new Uint8Array(asset.body));
};

app.get("/api/link-preview/:id", c => serveLinkAsset(c, "preview"));
app.get("/api/link-icon/:id", c => serveLinkAsset(c, "icon"));

app.get("/stats", serveStatic({ path: `${config.frontend.distPath}/stats.html` }));
app.use("/*", serveStatic({ root: config.frontend.distPath }));
app.use("/", serveStatic({ path: `${config.frontend.distPath}/index.html` }));

// --- Boot ------------------------------------------------------------------

console.log(`[ki-hackdays] listening on http://${config.host}:${config.port}`);
const activeProviders = config.providerOrder.filter((p: string) => {
  if (p === "gemini") return !!config.gemini.apiKey;
  if (p === "openrouter") return !!config.openRouter.apiKey;
  return false;
});
console.log(`[ki-hackdays] provider chain: ${activeProviders.join(" -> ") || "(none!)"}`);
for (const p of activeProviders) {
  if (p !== "gemini" && p !== "openrouter") continue;
  console.log(
    `[ki-hackdays] ${p} models: ${getModels(p).join(", ")} (live from ${modelsFilePath(p)})`
  );
}
console.log(
  `[ki-hackdays] rate limit/day: code ${config.rateLimit.perCodePerDay} (per-code override possible), ` +
    `session ${config.rateLimit.perSessionPerDay}, browser ${config.rateLimit.perBrowserPerDay}`
);
console.log(`[ki-hackdays] login limit: ${config.rateLimit.loginPerIpPerHour}/hour per IP`);
if (config.debug.pipeline) {
  console.log(
    `[ki-hackdays] debug pipeline logging enabled${config.debug.includeContent ? " (with content previews)" : ""}`
  );
}

// Warm up the embedding model at boot so the first chat request doesn't pay
// the ~10-20s transformers.js load. Runs async; we don't block server startup.
getEmbedder()
  .then(() => console.log("[ki-hackdays] embedder warm"))
  .catch((err: Error) => console.error("[ki-hackdays] embedder warmup failed:", err.message));

export default {
  port: config.port,
  hostname: config.host,
  // Bun's default idleTimeout (10s) closes connections where no bytes flowed
  // recently. SSE chat streams have long quiet phases (embedder warmup, LLM
  // provider fallback) — default cuts them mid-response. 255 is the Bun max.
  idleTimeout: 255,
  fetch: app.fetch,
};
