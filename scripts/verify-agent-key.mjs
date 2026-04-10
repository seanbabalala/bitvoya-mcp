import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  evaluateToolAuthorization,
  inferAgentKeyProfile,
  listToolAuthorizationPolicies,
  normalizeScopeList,
} from "../src/authz.mjs";
import { hashAgentToken, parseAgentToken } from "../src/token-auth.mjs";

const DEFAULT_ENV_PATH = "/root/.config/bitvoya-mcp/server.env";

function loadEnvFile(path) {
  if (!fs.existsSync(path)) {
    return {};
  }

  const content = fs.readFileSync(path, "utf8");
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

function printHelp() {
  console.log(`Usage:
  node ./scripts/verify-agent-key.mjs --token <raw-agent-key>
  node ./scripts/verify-agent-key.mjs --token-id <token-id>

Options:
  --token <raw-agent-key>         Raw Bitvoya agent key to verify.
  --token-id <token-id>           Lookup by token_id only.
  --booking-mode <mode>           executor_handoff | internal_execution
  --env-path <path>               Override env file path. Default: ${DEFAULT_ENV_PATH}
  --db-host <host>
  --db-port <port>
  --db-name <name>
  --db-user <user>
  --db-password <password>
  --token-pepper <pepper>         Optional HMAC pepper if token hashes use one.
  --json                          Emit JSON only.
  --help                          Show this message.

DB config resolution order:
  1. CLI flags
  2. BITVOYA_AGENT_KEYS_DB_*
  3. BITVOYA_MCP_AUTH_DB_*
  4. BITVOYA_MCP_DB_*
`);
}

function parseArgs(argv) {
  const args = {
    _: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      args._.push(current);
      continue;
    }

    const trimmed = current.slice(2);
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex >= 0) {
      args[trimmed.slice(0, equalIndex)] = trimmed.slice(equalIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[trimmed] = true;
      continue;
    }

    args[trimmed] = next;
    index += 1;
  }

  return args;
}

function envValue(fileEnv, key, fallback = "") {
  return process.env[key] || fileEnv[key] || fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveBookingMode(args, fileEnv) {
  const raw = String(
    args["booking-mode"] ||
      process.env.BITVOYA_MCP_BOOKING_EXECUTION_MODE ||
      fileEnv.BITVOYA_MCP_BOOKING_EXECUTION_MODE ||
      "executor_handoff"
  ).trim();

  return raw === "internal_execution" ? raw : "executor_handoff";
}

function resolveTokenPepper(args, fileEnv) {
  return String(
    args["token-pepper"] ||
      process.env.BITVOYA_MCP_TOKEN_PEPPER ||
      fileEnv.BITVOYA_MCP_TOKEN_PEPPER ||
      ""
  );
}

function resolveAuthDbConfig(args, fileEnv) {
  const cliConfig = {
    host: args["db-host"],
    port: args["db-port"],
    name: args["db-name"],
    user: args["db-user"],
    password: args["db-password"],
  };

  if (cliConfig.name && cliConfig.user && cliConfig.password) {
    return {
      host: String(cliConfig.host || "127.0.0.1"),
      port: parseInteger(cliConfig.port, 3306),
      name: String(cliConfig.name),
      user: String(cliConfig.user),
      password: String(cliConfig.password),
      source: "cli",
    };
  }

  const prefixes = ["BITVOYA_AGENT_KEYS_DB", "BITVOYA_MCP_AUTH_DB", "BITVOYA_MCP_DB"];

  for (const prefix of prefixes) {
    const name = envValue(fileEnv, `${prefix}_NAME`, "");
    const user = envValue(fileEnv, `${prefix}_USER`, "");
    const password = envValue(fileEnv, `${prefix}_PASSWORD`, "");

    if (!name || !user || !password) {
      continue;
    }

    return {
      host: envValue(fileEnv, `${prefix}_HOST`, "127.0.0.1"),
      port: parseInteger(envValue(fileEnv, `${prefix}_PORT`, "3306"), 3306),
      name,
      user,
      password,
      source: prefix,
    };
  }

  throw new Error(
    "Missing auth database credentials. Pass --db-name/--db-user/--db-password or configure BITVOYA_AGENT_KEYS_DB_* or BITVOYA_MCP_AUTH_DB_*."
  );
}

function parseJsonField(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (Buffer.isBuffer(value)) {
    return parseJsonField(value.toString("utf8"), fallback);
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeDateString(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString();
}

function buildLifecycle(record) {
  const now = Date.now();
  const expiresAtMs = record.expires_at ? Date.parse(record.expires_at) : Number.NaN;
  const revoked = record.status === "revoked" || Boolean(record.revoked_at);
  const expired =
    record.status === "expired" || (Number.isFinite(expiresAtMs) && expiresAtMs <= now);
  const active = !revoked && !expired && record.status === "active";

  return {
    status: record.status,
    derived_state: revoked ? "revoked" : expired ? "expired" : active ? "active" : "inactive",
    active,
    revoked,
    expired,
    expires_at: record.expires_at,
    revoked_at: record.revoked_at,
    last_used_at: record.last_used_at,
  };
}

function sanitizeRecord(row) {
  return {
    id: row.id,
    token_id: row.token_id,
    token_prefix: row.token_prefix,
    token_name: row.token_name,
    token_type: row.token_type,
    actor_type: row.actor_type,
    environment_label: row.environment_label,
    status: row.status,
    account_id: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    user_id: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    scopes: normalizeScopeList(parseJsonField(row.scopes_json, [])),
    metadata: parseJsonField(row.metadata_json, {}),
    expires_at: normalizeDateString(row.expires_at),
    revoked_at: normalizeDateString(row.revoked_at),
    last_used_at: normalizeDateString(row.last_used_at),
    created_at: normalizeDateString(row.created_at),
    updated_at: normalizeDateString(row.updated_at),
  };
}

async function findTokenRecord(connection, lookup) {
  const columns = `
    id,
    token_id,
    token_prefix,
    token_name,
    token_type,
    actor_type,
    account_id,
    user_id,
    scopes_json,
    status,
    environment_label,
    expires_at,
    revoked_at,
    last_used_at,
    metadata_json,
    created_at,
    updated_at
  `;

  if (lookup.rawToken) {
    const parsed = parseAgentToken(lookup.rawToken);
    if (!parsed) {
      return {
        lookup_type: "raw_token",
        token_format_valid: false,
        match_state: "invalid_format",
        token_id_hint: null,
        record: null,
      };
    }

    const tokenHash = hashAgentToken(lookup.rawToken, { pepper: lookup.tokenPepper });
    const [hashRows] = await connection.execute(
      `SELECT ${columns} FROM mcp_agent_tokens WHERE token_hash = ? LIMIT 1`,
      [tokenHash]
    );

    if (hashRows.length > 0) {
      return {
        lookup_type: "raw_token",
        token_format_valid: true,
        match_state: "matched_hash",
        token_id_hint: parsed.token_id,
        record: sanitizeRecord(hashRows[0]),
      };
    }

    const [tokenIdRows] = await connection.execute(
      `SELECT ${columns} FROM mcp_agent_tokens WHERE token_id = ? LIMIT 1`,
      [parsed.token_id]
    );

    if (tokenIdRows.length > 0) {
      return {
        lookup_type: "raw_token",
        token_format_valid: true,
        match_state: "token_id_found_secret_mismatch",
        token_id_hint: parsed.token_id,
        record: sanitizeRecord(tokenIdRows[0]),
      };
    }

    return {
      lookup_type: "raw_token",
      token_format_valid: true,
      match_state: "not_found",
      token_id_hint: parsed.token_id,
      record: null,
    };
  }

  const [rows] = await connection.execute(
    `SELECT ${columns} FROM mcp_agent_tokens WHERE token_id = ? LIMIT 1`,
    [lookup.tokenId]
  );

  return {
    lookup_type: "token_id",
    token_format_valid: true,
    match_state: rows.length > 0 ? "matched_token_id" : "not_found",
    token_id_hint: lookup.tokenId,
    record: rows.length > 0 ? sanitizeRecord(rows[0]) : null,
  };
}

function buildPrincipal(record) {
  if (!record) {
    return null;
  }

  return {
    user_id: record.user_id,
    account_id: record.account_id,
    token_id: record.token_id,
    token_type: record.token_type,
    actor_type: record.actor_type,
    account_status: record.status === "active" ? "active" : record.status,
    scopes: record.scopes,
    expires_at: record.expires_at,
  };
}

function buildToolMatrix(record, bookingExecutionMode) {
  if (!record) {
    return {
      current_mode: {
        authorized_tools: [],
        blocked_tools: [],
      },
      internal_execution_if_enabled: {
        authorized_tools: [],
        blocked_tools: [],
      },
    };
  }

  const principal = buildPrincipal(record);
  const policies = listToolAuthorizationPolicies({
    bookingExecutionMode: "internal_execution",
    includeHidden: true,
  });

  function evaluateForMode(mode) {
    const authorizedTools = [];
    const blockedTools = [];

    for (const policy of policies) {
      const evaluation = evaluateToolAuthorization(principal, policy.tool, {
        bookingExecutionMode: mode,
        resourceAccountId: record.account_id,
      });

      if (evaluation.allowed) {
        authorizedTools.push(policy.tool);
        continue;
      }

      blockedTools.push({
        tool: policy.tool,
        reason: evaluation.reason,
        missing_scopes: evaluation.missing_scopes,
        exposure: policy.exposure,
      });
    }

    return {
      authorized_tools: authorizedTools,
      blocked_tools: blockedTools,
    };
  }

  return {
    current_mode: {
      booking_execution_mode: bookingExecutionMode,
      ...evaluateForMode(bookingExecutionMode),
    },
    internal_execution_if_enabled: {
      booking_execution_mode: "internal_execution",
      ...evaluateForMode("internal_execution"),
    },
  };
}

function buildOutput({ lookup, dbConfigSource, bookingExecutionMode }) {
  const record = lookup.record;
  const lifecycle = record ? buildLifecycle(record) : null;
  const profile = record ? inferAgentKeyProfile(record) : null;
  const toolMatrix = buildToolMatrix(record, bookingExecutionMode);
  const matched =
    Boolean(record) &&
    (lookup.match_state === "matched_hash" || lookup.match_state === "matched_token_id");

  return {
    ok: matched && Boolean(lifecycle?.active),
    lookup: {
      type: lookup.lookup_type,
      token_format_valid: lookup.token_format_valid,
      match_state: lookup.match_state,
      token_id_hint: lookup.token_id_hint,
      db_config_source: dbConfigSource,
    },
    record,
    lifecycle,
    account_binding: record
      ? {
          user_id: record.user_id,
          account_id: record.account_id,
          shared_account_view: true,
          note:
            "All agent keys under the same Bitvoya account should resolve the same bookings, orders, entitlements, and membership state.",
        }
      : null,
    profile,
    tool_authorization: toolMatrix,
  };
}

function printHumanReadable(result) {
  console.log(`OK: ${result.ok ? "yes" : "no"}`);
  console.log(
    `Lookup: ${result.lookup.type} / ${result.lookup.match_state} / db=${result.lookup.db_config_source}`
  );

  if (!result.record) {
    return;
  }

  console.log(
    `Token: ${result.record.token_id} (${result.record.token_name}) actor=${result.record.actor_type}`
  );
  console.log(
    `Binding: user_id=${result.record.user_id} account_id=${result.record.account_id} shared_account_view=yes`
  );
  console.log(
    `Lifecycle: ${result.lifecycle.derived_state} status=${result.lifecycle.status} expires_at=${result.lifecycle.expires_at || "none"}`
  );
  console.log(`Scopes: ${result.record.scopes.join(", ") || "(none)"}`);

  if (result.profile) {
    console.log(
      `Profile: ${result.profile.profile_id} match=${result.profile.match_type} management=${result.profile.management}`
    );
  }

  console.log(
    `Authorized tools (${result.tool_authorization.current_mode.booking_execution_mode}): ${result.tool_authorization.current_mode.authorized_tools.join(", ") || "(none)"}`
  );

  if (result.tool_authorization.current_mode.blocked_tools.length > 0) {
    const blockedSummary = result.tool_authorization.current_mode.blocked_tools
      .map((entry) =>
        entry.missing_scopes.length > 0
          ? `${entry.tool}:${entry.reason}[${entry.missing_scopes.join("|")}]`
          : `${entry.tool}:${entry.reason}`
      )
      .join(", ");
    console.log(`Blocked tools: ${blockedSummary}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const rawToken = args.token || args._[0] || null;
  const tokenId = args["token-id"] || null;

  if (!rawToken && !tokenId) {
    printHelp();
    throw new Error("Provide --token <raw-agent-key> or --token-id <token-id>.");
  }

  const envPath = String(args["env-path"] || process.env.BITVOYA_MCP_ENV_PATH || DEFAULT_ENV_PATH);
  const fileEnv = loadEnvFile(envPath);
  const dbConfig = resolveAuthDbConfig(args, fileEnv);
  const bookingExecutionMode = resolveBookingMode(args, fileEnv);
  const tokenPepper = resolveTokenPepper(args, fileEnv);

  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name,
  });

  try {
    const lookup = await findTokenRecord(connection, {
      rawToken,
      tokenId,
      tokenPepper,
    });
    const result = buildOutput({
      lookup,
      dbConfigSource: dbConfig.source,
      bookingExecutionMode,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanReadable(result);
    }

    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
