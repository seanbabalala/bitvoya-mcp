import mysql from "mysql2/promise";

const pools = new Map();

function normalizeDbConfig(configOrDbConfig, options = {}) {
  if (!configOrDbConfig || typeof configOrDbConfig !== "object") {
    throw new Error("Database config is required.");
  }

  if ("host" in configOrDbConfig || "database" in configOrDbConfig || "name" in configOrDbConfig) {
    return {
      host: configOrDbConfig.host,
      port: configOrDbConfig.port,
      user: configOrDbConfig.user,
      password: configOrDbConfig.password,
      database: configOrDbConfig.database || configOrDbConfig.name,
    };
  }

  const section = options.section || "db";
  const dbConfig = configOrDbConfig[section];
  if (!dbConfig) {
    throw new Error(`Database config section '${section}' is missing.`);
  }

  return {
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database || dbConfig.name,
  };
}

function getPoolKey(dbConfig, options = {}) {
  if (options.poolKey) {
    return String(options.poolKey);
  }

  return JSON.stringify({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
  });
}

export function createDb(configOrDbConfig, options = {}) {
  const dbConfig = normalizeDbConfig(configOrDbConfig, options);
  const poolKey = getPoolKey(dbConfig, options);

  if (!pools.has(poolKey)) {
    pools.set(
      poolKey,
      mysql.createPool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        charset: "utf8mb4",
        waitForConnections: true,
        connectionLimit: 6,
        queueLimit: 0,
      })
    );
  }

  const pool = pools.get(poolKey);

  return {
    async query(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },

    async queryOne(sql, params = []) {
      const rows = await this.query(sql, params);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    async ping() {
      const [rows] = await pool.query("SELECT DATABASE() AS db_name, NOW() AS server_time");
      return rows[0];
    },

    async close() {
      if (pools.has(poolKey)) {
        await pool.end();
        pools.delete(poolKey);
      }
    },
  };
}

export async function closeAllDbPools() {
  for (const [poolKey, pool] of pools.entries()) {
    await pool.end();
    pools.delete(poolKey);
  }
}
