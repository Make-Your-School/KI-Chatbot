// Hono app entry. Routes:
//   POST /api/login    — exchange Schulcode for signed session cookie
//   POST /api/logout   — clear session cookie
//   GET  /api/me       — check if current session is valid
//   POST /api/chat     — stream a chat reply (SSE)
//   GET  /api/health   — liveness probe
//   GET  /*            — static frontend files
//
// Intentional non-features:
//   - No access logs of request contents
//   - No conversation storage of any kind
//   - No user IDs beyond the code hash (which is itself hashed from the code)

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.ts";
import { validateCode, issueSession, verifySession } from "./auth.ts";
import { streamChat, type ChatMessage } from "./chat.ts";
import { getModels, modelsFilePath } from "./models.ts";
import { tryConsume, tryConsumeLogin } from "./ratelimit.ts";

const app = new Hono();
const debugBypassSession = {
  hash: "__debug_bypass_auth__",
  iat: 0,
  exp: Number.MAX_SAFE_INTEGER,
};

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

const currentSession = (token: string | undefined) =>
  config.auth.bypassForDebug
    ? debugBypassSession
    : verifySession(token);

// --- API routes (registered BEFORE static so they're not shadowed) ---------

app.get("/api/health", c => c.json({ ok: true }));

app.post("/api/login", async c => {
  if (config.auth.bypassForDebug) {
    return c.json({ ok: true, school: "Debug-Modus", bypassAuth: true });
  }

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
    return c.json(
      { ok: false, error: "Ungültiger oder abgelaufener Schulcode." },
      401
    );
  }

  const token = issueSession(record.hash);
  setCookie(c, config.auth.cookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.isProd,
    path: "/",
    maxAge: config.auth.sessionTtlSeconds,
  });
  return c.json({ ok: true, school: record.school });
});

app.post("/api/logout", c => {
  if (config.auth.bypassForDebug) {
    return c.json({ ok: true, bypassAuth: true });
  }
  deleteCookie(c, config.auth.cookieName, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", c => {
  if (config.auth.bypassForDebug) {
    return c.json({ ok: true, bypassAuth: true });
  }
  const session = currentSession(getCookie(c, config.auth.cookieName));
  if (!session) return c.json({ ok: false }, 401);
  return c.json({ ok: true });
});

app.post("/api/chat", async c => {
  const session = currentSession(getCookie(c, config.auth.cookieName));
  if (!session) return c.json({ error: "Nicht eingeloggt." }, 401);

  const limited = tryConsume(session.hash, config.rateLimit.perCodePerDay);
  if (!limited.ok) {
    return c.json(
      {
        error: `Tages-Limit erreicht (${limited.limit} Anfragen pro Schulcode). Bitte morgen wieder versuchen.`,
      },
      429
    );
  }

  const body = await c.req.json().catch(() => null);
  const history = Array.isArray(body?.messages) ? (body.messages as ChatMessage[]) : [];
  if (history.length === 0) {
    return c.json({ error: "Keine Nachrichten übergeben." }, 400);
  }

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
      const write = (ev: unknown): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      try {
        for await (const ev of streamChat(history)) {
          if (!write(ev)) break;
          if (ev.type === "done" || ev.type === "error") break;
        }
      } catch (err) {
        console.error("[chat] stream error:", err);
        if (!closed) write({ type: "error", message: "Interner Fehler beim Streaming." });
      } finally {
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
console.log(`[ki-hackdays] rate limit: ${config.rateLimit.perCodePerDay}/day per code`);
if (config.auth.bypassForDebug) {
  console.log("[ki-hackdays] WARNING: auth bypass enabled via DEBUG_BYPASS_AUTH");
}
if (config.debug.pipeline) {
  console.log(
    `[ki-hackdays] debug pipeline logging enabled${config.debug.includeContent ? " (with content previews)" : ""}`
  );
}

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
