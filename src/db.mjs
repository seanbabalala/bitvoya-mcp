import mysql from "mysql2/promise";

let pool;

export function createDb(config) {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 6,
      queueLimit: 0,
    });
  }

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
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };
}
