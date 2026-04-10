import fs from "node:fs";

const DEFAULT_ENV_PATH = "/root/.config/bitvoya-mcp/server.env";

function loadEnvFile(path) {
  if (!fs.existsSync(path)) {
    return {};
  }

  const content = fs.readFileSync(path, "utf8");
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

function envValue(fileEnv, key, fallback = "") {
  return process.env[key] || fileEnv[key] || fallback;
}

function intValue(fileEnv, key, fallback) {
  const raw = envValue(fileEnv, key, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csvValue(fileEnv, key) {
  const raw = envValue(fileEnv, key, "");
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function enumValue(fileEnv, key, fallback, allowedValues) {
  const raw = envValue(fileEnv, key, fallback).trim();
  return allowedValues.includes(raw) ? raw : fallback;
}

function resolveDbConfig(fileEnv, primaryPrefix, fallbackPrefix = "") {
  const prefix = String(primaryPrefix || "").trim();
  const fallback = String(fallbackPrefix || "").trim();
  const read = (suffix, defaultValue = "") =>
    envValue(
      fileEnv,
      `${prefix}_${suffix}`,
      fallback ? envValue(fileEnv, `${fallback}_${suffix}`, defaultValue) : defaultValue
    );

  return {
    host: read("HOST", "127.0.0.1"),
    port: Number.parseInt(read("PORT", "3306"), 10) || 3306,
    name: read("NAME", ""),
    user: read("USER", ""),
    password: read("PASSWORD", ""),
  };
}

export function loadConfig() {
  const envPath = process.env.BITVOYA_MCP_ENV_PATH || DEFAULT_ENV_PATH;
  const fileEnv = loadEnvFile(envPath);
  const primaryDb = resolveDbConfig(fileEnv, "BITVOYA_MCP_DB");
  const authDb = resolveDbConfig(fileEnv, "BITVOYA_MCP_AUTH_DB", "BITVOYA_MCP_DB");

  const config = {
    envPath,
    server: {
      name: envValue(fileEnv, "BITVOYA_MCP_SERVER_NAME", "bitvoya-mcp"),
      version: envValue(fileEnv, "BITVOYA_MCP_SERVER_VERSION", "0.2.0"),
      transport: envValue(fileEnv, "BITVOYA_MCP_TRANSPORT", "stdio"),
    },
    db: primaryDb,
    authDb,
    api: {
      baseUrl: envValue(fileEnv, "BITVOYA_API_BASE_URL", "https://app.bitvoya.com/api"),
      timeoutMs: intValue(fileEnv, "BITVOYA_API_TIMEOUT_MS", 30000),
      authToken: envValue(fileEnv, "BITVOYA_API_BEARER_TOKEN", ""),
      acceptLanguage: envValue(fileEnv, "BITVOYA_API_ACCEPT_LANGUAGE", "en"),
      userAgent: envValue(fileEnv, "BITVOYA_API_USER_AGENT", "bitvoya-mcp/0.2.0"),
    },
    remoteAuth: {
      mode: envValue(fileEnv, "BITVOYA_MCP_REMOTE_AUTH_MODE", "bearer"),
      tokenHeader: envValue(fileEnv, "BITVOYA_MCP_REMOTE_TOKEN_HEADER", "authorization"),
      principalHeader: envValue(fileEnv, "BITVOYA_MCP_REMOTE_PRINCIPAL_HEADER", "x-bitvoya-principal"),
      signatureHeader: envValue(fileEnv, "BITVOYA_MCP_REMOTE_SIGNATURE_HEADER", "x-bitvoya-signature"),
      sharedSecret: envValue(fileEnv, "BITVOYA_MCP_REMOTE_AUTH_SHARED_SECRET", ""),
      maxSkewSeconds: intValue(fileEnv, "BITVOYA_MCP_REMOTE_AUTH_MAX_SKEW_SECONDS", 300),
      requiredScopes: csvValue(fileEnv, "BITVOYA_MCP_REMOTE_REQUIRED_SCOPES"),
    },
    bookingExecution: {
      mode: enumValue(
        fileEnv,
        "BITVOYA_MCP_BOOKING_EXECUTION_MODE",
        "executor_handoff",
        ["executor_handoff", "internal_execution"]
      ),
    },
    handoff: {
      mode: enumValue(
        fileEnv,
        "BITVOYA_MCP_HANDOFF_MODE",
        "planned",
        ["disabled", "planned", "signed_url"]
      ),
      baseUrl: envValue(fileEnv, "BITVOYA_MCP_HANDOFF_BASE_URL", ""),
      signingSecret: envValue(fileEnv, "BITVOYA_MCP_HANDOFF_SIGNING_SECRET", ""),
      tokenTtlSeconds: intValue(fileEnv, "BITVOYA_MCP_HANDOFF_TOKEN_TTL_SECONDS", 1800),
    },
    store: {
      path: envValue(fileEnv, "BITVOYA_MCP_STORE_PATH", "/root/.config/bitvoya-mcp/runtime-store.json"),
      quoteTtlSeconds: intValue(fileEnv, "BITVOYA_MCP_QUOTE_TTL_SECONDS", 900),
      intentRetentionSeconds: intValue(fileEnv, "BITVOYA_MCP_INTENT_RETENTION_SECONDS", 604800),
      cardEncryptionKey: envValue(fileEnv, "BITVOYA_MCP_CARD_ENCRYPTION_KEY", ""),
    },
    limits: {
      defaultSearch: intValue(fileEnv, "BITVOYA_MCP_DEFAULT_SEARCH_LIMIT", 5),
      maxSearch: intValue(fileEnv, "BITVOYA_MCP_MAX_SEARCH_LIMIT", 12),
      defaultPoi: intValue(fileEnv, "BITVOYA_MCP_DEFAULT_POI_LIMIT", 8),
      defaultRoomLimit: intValue(fileEnv, "BITVOYA_MCP_DEFAULT_ROOM_LIMIT", 5),
      maxRoomLimit: intValue(fileEnv, "BITVOYA_MCP_MAX_ROOM_LIMIT", 10),
      defaultRateLimit: intValue(fileEnv, "BITVOYA_MCP_DEFAULT_RATE_LIMIT", 4),
      maxRateLimit: intValue(fileEnv, "BITVOYA_MCP_MAX_RATE_LIMIT", 10),
    },
  };

  if (!config.db.user || !config.db.password) {
    throw new Error(`Missing MCP database credentials in ${envPath}`);
  }

  if (!config.authDb.name || !config.authDb.user || !config.authDb.password) {
    throw new Error(`Missing MCP auth database credentials in ${envPath}`);
  }

  return config;
}

export function summarizeConfig(config) {
  return {
    envPath: config.envPath,
    server: config.server,
    db: {
      host: config.db.host,
      port: config.db.port,
      name: config.db.name,
      user: config.db.user,
      passwordConfigured: Boolean(config.db.password),
    },
    authDb: {
      host: config.authDb.host,
      port: config.authDb.port,
      name: config.authDb.name,
      user: config.authDb.user,
      passwordConfigured: Boolean(config.authDb.password),
    },
    api: {
      baseUrl: config.api.baseUrl,
      timeoutMs: config.api.timeoutMs,
      authTokenConfigured: Boolean(config.api.authToken),
      acceptLanguage: config.api.acceptLanguage,
      userAgent: config.api.userAgent,
    },
    remoteAuth: config.remoteAuth,
    bookingExecution: config.bookingExecution,
    handoff: {
      mode: config.handoff.mode,
      baseUrl: config.handoff.baseUrl,
      signingSecretConfigured: Boolean(config.handoff.signingSecret),
      tokenTtlSeconds: config.handoff.tokenTtlSeconds,
    },
    store: {
      path: config.store.path,
      quoteTtlSeconds: config.store.quoteTtlSeconds,
      intentRetentionSeconds: config.store.intentRetentionSeconds,
      cardEncryptionKeyConfigured: Boolean(config.store.cardEncryptionKey),
    },
    limits: config.limits,
  };
}
