import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { createBitvoyaApi } from "../src/bitvoya-api.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDb } from "../src/db.mjs";
import { createRuntimeStore } from "../src/runtime-store.mjs";
import { createBookingIntent, prepareBookingQuote } from "../src/tools/booking.mjs";
import { hashAgentToken, parseAgentToken } from "../src/token-auth.mjs";

const DEFAULT_ENV_PATH = "/root/.config/bitvoya-mcp/server.env";
const DEFAULT_BOOKING_INPUT = {
  hotel_id: "875",
  room_id: "0",
  rate_id: "6993794",
  checkin: "2026-05-01",
  checkout: "2026-05-03",
  adult_num: 2,
  child_num: 0,
  room_num: 1,
  payment_method: "guarantee",
  phone: "13800000000",
};

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
  node ./scripts/create-handoff-session.mjs --token <raw-agent-key>
  node ./scripts/create-handoff-session.mjs --token-id <token-id>

Options:
  --token <raw-agent-key>          Raw Bitvoya agent key.
  --token-id <token-id>            Lookup by token_id only.
  --hotel-id <id>                  Default: ${DEFAULT_BOOKING_INPUT.hotel_id}
  --room-id <id>                   Default: ${DEFAULT_BOOKING_INPUT.room_id}
  --rate-id <id>                   Default: ${DEFAULT_BOOKING_INPUT.rate_id}
  --checkin <YYYY-MM-DD>           Default: ${DEFAULT_BOOKING_INPUT.checkin}
  --checkout <YYYY-MM-DD>          Default: ${DEFAULT_BOOKING_INPUT.checkout}
  --adult-num <n>                  Default: ${DEFAULT_BOOKING_INPUT.adult_num}
  --child-num <n>                  Default: ${DEFAULT_BOOKING_INPUT.child_num}
  --room-num <n>                   Default: ${DEFAULT_BOOKING_INPUT.room_num}
  --payment-method <mode>          guarantee | prepay. Default: ${DEFAULT_BOOKING_INPUT.payment_method}
  --guest-first-name <name>        Optional. Falls back to Bitvoya user first_name or "Bitvoya".
  --guest-last-name <name>         Optional. Falls back to Bitvoya user last_name or "Traveler".
  --email <email>                  Optional. Falls back to Bitvoya account email.
  --phone <phone>                  Default: ${DEFAULT_BOOKING_INPUT.phone}
  --store-path <path>              Optional runtime-store override.
  --env-path <path>                Override env file path. Default: ${DEFAULT_ENV_PATH}
  --db-host <host>
  --db-port <port>
  --db-name <name>
  --db-user <user>
  --db-password <password>
  --token-pepper <pepper>          Optional HMAC pepper if token hashes use one.
  --json                           Emit JSON only.
  --help                           Show this message.

Notes:
  - This creates a real quote and intent in the configured MCP runtime store.
  - The generated secure_handoff.launch_url is intended for Bitvoya-hosted checkout testing.
  - Public agent behavior should stop after create_booking_intent and hand the traveler into Bitvoya secure checkout.
`);
}

function parseArgs(argv) {
  const args = { _: [] };

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

function resolveTokenPepper(args, fileEnv) {
  return String(
    args["token-pepper"] ||
      process.env.BITVOYA_MCP_TOKEN_PEPPER ||
      fileEnv.BITVOYA_MCP_TOKEN_PEPPER ||
      ""
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
    scopes: parseJsonField(row.scopes_json, []),
    metadata: parseJsonField(row.metadata_json, {}),
    expires_at: normalizeDateString(row.expires_at),
    revoked_at: normalizeDateString(row.revoked_at),
    last_used_at: normalizeDateString(row.last_used_at),
    created_at: normalizeDateString(row.created_at),
    updated_at: normalizeDateString(row.updated_at),
  };
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

async function lookupBoundUser(connection, tokenRecord) {
  if (!tokenRecord?.user_id) {
    return {
      user_id: null,
      account_id: tokenRecord?.account_id || null,
      email: null,
      first_name: null,
      last_name: null,
      uuid: null,
    };
  }

  const [rows] = await connection.execute(
    `SELECT id, uuid, email, first_name, last_name FROM users WHERE id = ? LIMIT 1`,
    [tokenRecord.user_id]
  );

  if (rows.length === 0) {
    return {
      user_id: String(tokenRecord.user_id),
      account_id: tokenRecord.account_id || String(tokenRecord.user_id),
      email: null,
      first_name: null,
      last_name: null,
      uuid: null,
    };
  }

  const row = rows[0];
  const userId = row.id === null || row.id === undefined ? String(tokenRecord.user_id) : String(row.id);
  const uuid = row.uuid ? String(row.uuid) : null;

  return {
    user_id: userId,
    account_id: uuid || tokenRecord.account_id || userId,
    email: row.email ? String(row.email) : null,
    first_name: row.first_name ? String(row.first_name) : null,
    last_name: row.last_name ? String(row.last_name) : null,
    uuid,
  };
}

function resolvePaymentMethod(rawValue) {
  const value = String(rawValue || DEFAULT_BOOKING_INPUT.payment_method)
    .trim()
    .toLowerCase();
  if (!["guarantee", "prepay"].includes(value)) {
    throw new Error("--payment-method must be guarantee or prepay.");
  }
  return value;
}

function resolveGuestField(primary, fallback) {
  const value = String(primary || "").trim();
  if (value) {
    return value;
  }
  return String(fallback || "").trim();
}

function buildOutput({
  lookup,
  lifecycle,
  boundUser,
  dbConfigSource,
  config,
  bookingInput,
  quote,
  intent,
}) {
  const secureHandoff = intent.data?.secure_handoff || null;

  return {
    ok: Boolean(lifecycle?.active) && Boolean(secureHandoff),
    lookup: {
      type: lookup.lookup_type,
      token_format_valid: lookup.token_format_valid,
      match_state: lookup.match_state,
      token_id_hint: lookup.token_id_hint,
      db_config_source: dbConfigSource,
    },
    account_binding: {
      user_id: boundUser.user_id,
      account_id: boundUser.account_id,
      email: boundUser.email,
      shared_account_view: true,
    },
    runtime: {
      booking_execution_mode: config.bookingExecution.mode,
      handoff_mode: config.handoff.mode,
      runtime_store_path: config.store.path,
      handoff_base_url: config.handoff.baseUrl,
    },
    booking_input: bookingInput,
    quote: {
      summary: quote.summary,
      data: quote.data?.quote || null,
    },
    intent: {
      summary: intent.summary,
      data: intent.data?.intent || null,
      execution_boundary: intent.data?.execution_boundary || null,
      execution_state: intent.data?.execution_state || null,
      blocking_requirements: intent.data?.blocking_requirements || [],
    },
    secure_handoff: secureHandoff,
    next_steps: [
      "Open secure_handoff.launch_url in a browser.",
      "Log in with the same Bitvoya account bound to this agent key.",
      "Complete card or payment steps on the Bitvoya-hosted secure checkout page.",
      "Use get_booking_state with the returned intent_id to inspect downstream order and payment state.",
    ],
  };
}

function printHumanReadable(result) {
  console.log(`OK: ${result.ok ? "yes" : "no"}`);
  console.log(
    `Lookup: ${result.lookup.type} / ${result.lookup.match_state} / db=${result.lookup.db_config_source}`
  );
  console.log(
    `Binding: user_id=${result.account_binding.user_id || "unknown"} account_id=${result.account_binding.account_id || "unknown"} email=${result.account_binding.email || "unknown"}`
  );
  console.log(
    `Runtime: booking_mode=${result.runtime.booking_execution_mode} handoff_mode=${result.runtime.handoff_mode}`
  );
  console.log(`Store: ${result.runtime.runtime_store_path}`);
  console.log(`Quote: ${result.quote.data?.quote_id || "n/a"} / ${result.quote.summary}`);
  console.log(`Intent: ${result.intent.data?.intent_id || "n/a"} / ${result.intent.summary}`);
  console.log(
    `Secure handoff: state=${result.secure_handoff?.state || "unknown"} launch=${result.secure_handoff?.launch_url_status || "unknown"}`
  );

  if (result.secure_handoff?.launch_url) {
    console.log(`Launch URL: ${result.secure_handoff.launch_url}`);
  }

  if (Array.isArray(result.intent.blocking_requirements) && result.intent.blocking_requirements.length > 0) {
    console.log(`Blocking: ${result.intent.blocking_requirements.join(" | ")}`);
  }

  console.log("Next:");
  for (const step of result.next_steps) {
    console.log(`- ${step}`);
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
  const tokenPepper = resolveTokenPepper(args, fileEnv);

  const authConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name,
  });

  try {
    const lookup = await findTokenRecord(authConnection, {
      rawToken,
      tokenId,
      tokenPepper,
    });

    if (!lookup.record) {
      throw new Error(`Agent key lookup failed: ${lookup.match_state}`);
    }

    const lifecycle = buildLifecycle(lookup.record);
    if (!lifecycle.active) {
      throw new Error(`Agent key is not active: ${lifecycle.derived_state}`);
    }

    const boundUser = await lookupBoundUser(authConnection, lookup.record);

    process.env.BITVOYA_MCP_ENV_PATH = envPath;
    const config = loadConfig();
    if (args["store-path"]) {
      config.store.path = String(args["store-path"]);
    }

    const bookingInput = {
      hotel_id: String(args["hotel-id"] || DEFAULT_BOOKING_INPUT.hotel_id),
      room_id: String(args["room-id"] || DEFAULT_BOOKING_INPUT.room_id),
      rate_id: String(args["rate-id"] || DEFAULT_BOOKING_INPUT.rate_id),
      checkin: String(args.checkin || DEFAULT_BOOKING_INPUT.checkin),
      checkout: String(args.checkout || DEFAULT_BOOKING_INPUT.checkout),
      adult_num: parseInteger(args["adult-num"], DEFAULT_BOOKING_INPUT.adult_num),
      child_num: parseInteger(args["child-num"], DEFAULT_BOOKING_INPUT.child_num),
      room_num: parseInteger(args["room-num"], DEFAULT_BOOKING_INPUT.room_num),
      payment_method: resolvePaymentMethod(args["payment-method"]),
      guest_first_name: resolveGuestField(args["guest-first-name"], boundUser.first_name || "Bitvoya"),
      guest_last_name: resolveGuestField(args["guest-last-name"], boundUser.last_name || "Traveler"),
      email: resolveGuestField(args.email, boundUser.email || "agent-test@bitvoya.local"),
      phone: resolveGuestField(args.phone, DEFAULT_BOOKING_INPUT.phone),
    };

    const db = createDb(config);
    const api = createBitvoyaApi(config);
    const store = createRuntimeStore(config);

    try {
      const quote = await prepareBookingQuote(
        api,
        db,
        store,
        config,
        {
          hotel_id: bookingInput.hotel_id,
          room_id: bookingInput.room_id,
          rate_id: bookingInput.rate_id,
          checkin: bookingInput.checkin,
          checkout: bookingInput.checkout,
          adult_num: bookingInput.adult_num,
          child_num: bookingInput.child_num,
          room_num: bookingInput.room_num,
        },
        {
          execution_mode: config.bookingExecution.mode,
          config,
        }
      );

      const intent = await createBookingIntent(
        store,
        {
          quote_id: quote.data?.quote?.quote_id,
          payment_method: bookingInput.payment_method,
          guest_primary: {
            first_name: bookingInput.guest_first_name,
            last_name: bookingInput.guest_last_name,
          },
          contact: {
            email: bookingInput.email,
            phone: bookingInput.phone,
          },
          user_info: {
            user_id: boundUser.user_id,
            account_id: boundUser.account_id,
            email: boundUser.email || bookingInput.email,
          },
        },
        {
          execution_mode: config.bookingExecution.mode,
          config,
        }
      );

      const result = buildOutput({
        lookup,
        lifecycle,
        boundUser,
        dbConfigSource: dbConfig.source,
        config,
        bookingInput,
        quote,
        intent,
      });

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printHumanReadable(result);
    } finally {
      await db.close();
    }
  } finally {
    await authConnection.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
