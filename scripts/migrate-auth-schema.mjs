import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createDb } from "../src/db.mjs";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node ./scripts/migrate-auth-schema.mjs
  node ./scripts/migrate-auth-schema.mjs --sql-file ./sql/001_mcp_auth_tables.sql
  node ./scripts/migrate-auth-schema.mjs --json

Options:
  --sql-file <path>  Run a single SQL file instead of all sql/*.sql files.
  --json             Print machine-readable JSON summary.
  --help             Show this message.
`);
}

function listSqlFiles(rootDir, requestedFile) {
  if (requestedFile) {
    return [path.resolve(rootDir, requestedFile)];
  }

  const sqlDir = path.resolve(rootDir, "sql");
  return fs
    .readdirSync(sqlDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => path.join(sqlDir, file));
}

function parseSqlStatements(content) {
  const statements = [];
  const lines = content.split(/\r?\n/);
  let current = "";

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("--")) {
      continue;
    }

    current += `${rawLine}\n`;

    if (trimmed.endsWith(";")) {
      const statement = current.trim();
      if (statement) {
        statements.push(statement.replace(/;$/, ""));
      }
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }

  return statements;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sqlFiles = listSqlFiles(rootDir, args["sql-file"]);
  const config = loadConfig();
  const authDb = createDb(config, {
    section: "authDb",
    poolKey: "bitvoya-mcp-auth-migrate",
  });

  const summary = {
    database: config.authDb.name,
    files: [],
    statements_executed: 0,
  };

  try {
    for (const sqlFile of sqlFiles) {
      const content = fs.readFileSync(sqlFile, "utf8");
      const statements = parseSqlStatements(content);
      const fileSummary = {
        file: sqlFile,
        statements: statements.length,
      };

      for (const statement of statements) {
        await authDb.query(statement);
        summary.statements_executed += 1;
      }

      summary.files.push(fileSummary);
    }
  } finally {
    await authDb.close();
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Applied MCP auth schema to ${summary.database}.`);
  for (const file of summary.files) {
    console.log(`- ${file.file}: ${file.statements} statements`);
  }
  console.log(`Total statements executed: ${summary.statements_executed}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
