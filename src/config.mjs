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

export function loadConfig() {
  const envPath = process.env.BITVOYA_MCP_ENV_PATH || DEFAULT_ENV_PATH;
  const fileEnv = loadEnvFile(envPath);

  const config = {
    envPath,
    server: {
      name: envValue(fileEnv, "BITVOYA_MCP_SERVER_NAME", "bitvoya-mcp"),
      version: envValue(fileEnv, "BITVOYA_MCP_SERVER_VERSION", "0.1.0"),
    },
    db: {
      host: envValue(fileEnv, "BITVOYA_MCP_DB_HOST", "127.0.0.1"),
      port: intValue(fileEnv, "BITVOYA_MCP_DB_PORT", 3306),
      name: envValue(fileEnv, "BITVOYA_MCP_DB_NAME", "tripwiki_publish"),
      user: envValue(fileEnv, "BITVOYA_MCP_DB_USER", ""),
      password: envValue(fileEnv, "BITVOYA_MCP_DB_PASSWORD", ""),
    },
    limits: {
      defaultSearch: intValue(fileEnv, "BITVOYA_MCP_DEFAULT_SEARCH_LIMIT", 5),
      maxSearch: intValue(fileEnv, "BITVOYA_MCP_MAX_SEARCH_LIMIT", 12),
      defaultPoi: intValue(fileEnv, "BITVOYA_MCP_DEFAULT_POI_LIMIT", 8),
    },
  };

  if (!config.db.user || !config.db.password) {
    throw new Error(`Missing MCP database credentials in ${envPath}`);
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
    limits: config.limits,
  };
}
