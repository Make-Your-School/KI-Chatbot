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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  isProd: process.env.NODE_ENV === "production",

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
    secret: process.env.AUTH_SECRET ?? "dev-secret-change-me-in-prod",
    cookieName: "mys_session",
    sessionTtlSeconds: 7 * 24 * 60 * 60, // 7 days, matches Schulcode TTL
    bypassForDebug: flag("DEBUG_BYPASS_AUTH"),
  },

  rateLimit: {
    perCodePerDay: Number(process.env.RATE_LIMIT_PER_CODE_PER_DAY ?? 50),
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

  frontend: {
    distPath: process.env.FRONTEND_DIST ?? "../frontend",
  },

  debug: {
    pipeline: flag("DEBUG_CHAT_PIPELINE"),
    includeContent: flag("DEBUG_CHAT_INCLUDE_CONTENT"),
    previewChars: Number(process.env.DEBUG_CHAT_PREVIEW_CHARS ?? 240),
  },
} as const;
