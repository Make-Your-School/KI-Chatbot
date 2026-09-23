// Central config. All process.env reads happen here, nowhere else.

const optional = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
};

const flag = (name: string): boolean => /^(1|true|yes|on)$/i.test(process.env[name] ?? "");

const openRouterApiKey = optional("OPENROUTER_API_KEY");
const geminiApiKey = optional("GEMINI_API_KEY");

if (!openRouterApiKey && !geminiApiKey) {
  throw new Error(
    "Kein LLM-Anbieter konfiguriert. Setze GEMINI_API_KEY und/oder OPENROUTER_API_KEY in der .env."
  );
}

// --- Production safety gate -------------------------------------------------
//
// A missing AUTH_SECRET used to fall back to a value that is public in this
// repo, which would let anyone forge session cookies. In production we refuse
// to boot instead of failing silently.
//
// There is deliberately no auth bypass switch. Testing happens with a real
// Schulcode — creating one takes a single CLI call.

const isProd = process.env.NODE_ENV === "production";
const DEV_SECRET = "dev-secret-change-me-in-prod";
const authSecret = process.env.AUTH_SECRET ?? DEV_SECRET;

if (isProd && (authSecret === DEV_SECRET || authSecret.length < 32)) {
  throw new Error(
    "AUTH_SECRET fehlt oder ist zu kurz (mindestens 32 Zeichen). " +
      "Neu erzeugen mit: openssl rand -hex 32"
  );
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  isProd,

  // Reihenfolge, in der Anbieter probiert werden. Erster Treffer mit gültigem
  // API-Key gewinnt; bei Fehler/Timeout fällt es auf den nächsten durch.
  // Default: Gemini zuerst (free tier ist meist stabiler), OpenRouter als Backup.
  providerOrder: (process.env.PROVIDER_ORDER ?? "gemini,openrouter")
    .split(",")
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean),

  openRouter: {
    apiKey: openRouterApiKey,
    // Modell-Liste lebt git-versioniert in server/models/openrouter.txt und
    // wird live von src/models.ts gelesen — siehe getModels("openrouter").
    siteName: process.env.OPENROUTER_SITE_NAME ?? "KI Hackdays",
    siteUrl: process.env.OPENROUTER_SITE_URL ?? "https://ki-hackdays.de",
  },

  gemini: {
    // Google AI Studio (free tier). Key holen unter
    // https://aistudio.google.com/app/apikey
    // Wir nutzen den OpenAI-kompatiblen Endpoint:
    // https://ai.google.dev/gemini-api/docs/openai
    //
    // Modell-Liste lebt git-versioniert in server/models/gemini.txt und
    // wird live von src/models.ts gelesen — siehe getModels("gemini").
    apiKey: geminiApiKey,
  },

  auth: {
    // HMAC secret for signing session cookies.
    // Changing this invalidates all active sessions (Schulcode hashes are NOT
    // derived from this, so existing codes stay valid).
    secret: authSecret,
    cookieName: "mys_session",
    // Upper bound for a session. The actual expiry is clamped to the Schulcode's
    // own expires_at at login time, so a session can never outlive its code.
    sessionTtlSeconds: Number(process.env.SESSION_TTL_DAYS ?? 7) * 24 * 60 * 60,
  },

  // Three independent daily buckets, all checked before any is consumed:
  //   - per Schulcode  — protects the API budget of a shared code
  //   - per Session    — one login; resets if you log in again
  //   - per Browser    — the stable per-person cap (localStorage id)
  // A shared event code for an event needs the code ceiling high, so the other
  // two are what actually keep a single heavy user from eating everyone's quota.
  rateLimit: {
    perCodePerDay: Number(process.env.RATE_LIMIT_PER_CODE_PER_DAY ?? 200),
    perSessionPerDay: Number(process.env.RATE_LIMIT_PER_SESSION_PER_DAY ?? 40),
    perBrowserPerDay: Number(process.env.RATE_LIMIT_PER_BROWSER_PER_DAY ?? 50),
    // Per-IP login attempts per hour. Whole schools sit behind one NAT address,
    // so this has to be generous — brute force is not the threat model for a
    // 6-char code out of a 32-char alphabet (~10^9 combinations).
    loginPerIpPerHour: Number(process.env.RATE_LIMIT_LOGIN_PER_IP_PER_HOUR ?? 200),
  },

  rag: {
    dbPath: process.env.KNOWLEDGE_DB_PATH ?? "./data/knowledge.db",
    topK: Number(process.env.RAG_TOP_K ?? 5),
    embeddingModel: process.env.EMBEDDING_MODEL ?? "Xenova/multilingual-e5-small",
    cacheDir: process.env.EMBEDDING_CACHE_DIR ?? "./data/transformers-cache",
    // Dimension must match the model. multilingual-e5-small = 384.
    embeddingDim: 384,
  },

  codes: {
    dbPath: process.env.CODES_DB_PATH ?? "./data/codes.db",
  },

  // Aggregate-only usage counters. Deliberately a separate file from codes.db:
  // wiping statistics must never be able to touch the Schulcodes.
  stats: {
    dbPath: process.env.STATS_DB_PATH ?? "./data/stats.db",
    // Daily counters are tiny, but "store as little as possible" is the point,
    // so anything older than this is dropped at boot. 800 days keeps a full
    // previous year visible.
    retentionDays: Number(process.env.STATS_RETENTION_DAYS ?? 800),
  },

  frontend: {
    distPath: process.env.FRONTEND_DIST ?? "../frontend",
  },

  debug: {
    pipeline: flag("DEBUG_CHAT_PIPELINE"),
    includeContent: flag("DEBUG_CHAT_INCLUDE_CONTENT"),
    previewChars: Number(process.env.DEBUG_CHAT_PREVIEW_CHARS ?? 240),
  },
} as const;
