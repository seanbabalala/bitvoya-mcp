import crypto from "node:crypto";
import { inferAgentKeyProfile, normalizeScopeList } from "./authz.mjs";
import {
  extractBearerToken,
  normalizePrincipal,
  resolveRemotePrincipalFromHeaders,
} from "./remote-auth.mjs";
import { hashAgentToken, parseAgentToken } from "./token-auth.mjs";

export class AgentAuthError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AgentAuthError";
    this.statusCode = Number(options.statusCode || 401);
    this.reasonCode = String(options.reasonCode || "unauthorized");
    this.details = options.details || null;
  }
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

  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    return String(value);
  }

  return new Date(parsed).toISOString();
}

function getExpiryEpochSeconds(expiresAt) {
  const parsed = Date.parse(String(expiresAt || ""));
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.floor(parsed / 1000);
}

function buildLifecycle(record) {
  const nowMs = Date.now();
  const expiresAtMs = record?.expires_at ? Date.parse(record.expires_at) : Number.NaN;
  const revoked = record?.status === "revoked" || Boolean(record?.revoked_at);
  const expired =
    record?.status === "expired" || (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs);
  const active = !revoked && !expired && record?.status === "active";

  return {
    active,
    revoked,
    expired,
    status: record?.status || "unknown",
    derived_state: revoked ? "revoked" : expired ? "expired" : active ? "active" : "inactive",
    expires_at: record?.expires_at || null,
    revoked_at: record?.revoked_at || null,
    last_used_at: record?.last_used_at || null,
  };
}

function sanitizeTokenRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    token_id: String(row.token_id),
    token_prefix: String(row.token_prefix),
    token_name: String(row.token_name),
    token_type: String(row.token_type),
    actor_type: String(row.actor_type),
    account_id: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    user_id: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    scopes: normalizeScopeList(parseJsonField(row.scopes_json, [])),
    status: String(row.status || "active"),
    environment_label:
      row.environment_label === null || row.environment_label === undefined
        ? null
        : String(row.environment_label),
    expires_at: normalizeDateString(row.expires_at),
    revoked_at: normalizeDateString(row.revoked_at),
    last_used_at: normalizeDateString(row.last_used_at),
    metadata: parseJsonField(row.metadata_json, {}),
    created_at: normalizeDateString(row.created_at),
    updated_at: normalizeDateString(row.updated_at),
  };
}

function buildPrincipalFromTokenRecord(record) {
  if (!record) {
    return null;
  }

  return normalizePrincipal({
    user_id: record.user_id,
    account_id: record.account_id,
    token_id: record.token_id,
    token_type: record.token_type,
    actor_type: record.actor_type,
    account_status: record.status === "active" ? "active" : record.status,
    scopes: record.scopes,
    expires_at: record.expires_at,
  });
}

function columnsSql() {
  return `
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
}

export function extractRequestIp(req) {
  const forwardedFor = req?.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = req?.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return req?.socket?.remoteAddress || null;
}

export function buildAccountBindingFromPrincipal(principal) {
  const normalized = normalizePrincipal(principal || {});

  return {
    user_id: normalized.user_id,
    account_id: normalized.account_id,
    token_id: normalized.token_id,
    token_type: normalized.token_type,
    actor_type: normalized.actor_type,
    scopes: normalized.scopes,
  };
}

export function getPrincipalFromAuthInfo(authInfo) {
  if (!authInfo?.extra?.principal) {
    return null;
  }

  return normalizePrincipal(authInfo.extra.principal);
}

export async function findAgentTokenRecord(authDb, lookup = {}) {
  const columns = columnsSql();

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
    const hashMatch = await authDb.queryOne(
      `SELECT ${columns} FROM mcp_agent_tokens WHERE token_hash = ? LIMIT 1`,
      [tokenHash]
    );

    if (hashMatch) {
      return {
        lookup_type: "raw_token",
        token_format_valid: true,
        match_state: "matched_hash",
        token_id_hint: parsed.token_id,
        record: sanitizeTokenRecord(hashMatch),
      };
    }

    const tokenIdMatch = await authDb.queryOne(
      `SELECT ${columns} FROM mcp_agent_tokens WHERE token_id = ? LIMIT 1`,
      [parsed.token_id]
    );

    if (tokenIdMatch) {
      return {
        lookup_type: "raw_token",
        token_format_valid: true,
        match_state: "token_id_found_secret_mismatch",
        token_id_hint: parsed.token_id,
        record: sanitizeTokenRecord(tokenIdMatch),
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

  if (!lookup.tokenId) {
    return {
      lookup_type: "token_id",
      token_format_valid: false,
      match_state: "missing_token_lookup",
      token_id_hint: null,
      record: null,
    };
  }

  const row = await authDb.queryOne(
    `SELECT ${columns} FROM mcp_agent_tokens WHERE token_id = ? LIMIT 1`,
    [lookup.tokenId]
  );

  return {
    lookup_type: "token_id",
    token_format_valid: true,
    match_state: row ? "matched_token_id" : "not_found",
    token_id_hint: String(lookup.tokenId),
    record: sanitizeTokenRecord(row),
  };
}

export async function touchAgentToken(authDb, tokenId, options = {}) {
  if (!tokenId) {
    return;
  }

  await authDb.query(
    `
      UPDATE mcp_agent_tokens
      SET last_used_at = NOW(), last_used_ip = COALESCE(?, last_used_ip)
      WHERE token_id = ?
    `,
    [options.ip || null, String(tokenId)]
  );
}

function ensureRequiredScopes(scopes, requiredScopes = []) {
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new AgentAuthError(
      `Agent key is missing required remote scopes: ${missingScopes.join(", ")}.`,
      {
        statusCode: 403,
        reasonCode: "missing_remote_scopes",
        details: {
          missing_scopes: missingScopes,
        },
      }
    );
  }
}

export async function verifyBearerAgentKey(authDb, rawToken, config, requestContext = {}) {
  const lookup = await findAgentTokenRecord(authDb, {
    rawToken,
    tokenPepper: config?.remoteAuth?.tokenPepper || "",
  });

  if (!lookup.record) {
    throw new AgentAuthError("Bitvoya agent key was not found.", {
      statusCode: 401,
      reasonCode: lookup.match_state,
      details: lookup,
    });
  }

  if (lookup.match_state !== "matched_hash") {
    throw new AgentAuthError("Bitvoya agent key secret does not match.", {
      statusCode: 401,
      reasonCode: lookup.match_state,
      details: lookup,
    });
  }

  const lifecycle = buildLifecycle(lookup.record);
  if (!lifecycle.active) {
    throw new AgentAuthError(
      `Bitvoya agent key is ${lifecycle.derived_state}.`,
      {
        statusCode: 403,
        reasonCode: lifecycle.derived_state,
        details: {
          lookup,
          lifecycle,
        },
      }
    );
  }

  const principal = buildPrincipalFromTokenRecord(lookup.record);
  ensureRequiredScopes(principal.scopes, config?.remoteAuth?.requiredScopes || []);
  const profile = inferAgentKeyProfile({
    actor_type: lookup.record.actor_type,
    scopes: lookup.record.scopes,
  });

  await touchAgentToken(authDb, lookup.record.token_id, { ip: requestContext.ip });

  return {
    lookup,
    record: lookup.record,
    lifecycle,
    profile,
    principal,
    authInfo: {
      token: rawToken,
      clientId: lookup.record.token_id,
      scopes: principal.scopes,
      expiresAt: getExpiryEpochSeconds(lookup.record.expires_at),
      extra: {
        auth_mode: "bearer",
        principal,
        token_record: {
          token_id: lookup.record.token_id,
          token_name: lookup.record.token_name,
          token_type: lookup.record.token_type,
          actor_type: lookup.record.actor_type,
          account_id: lookup.record.account_id,
          user_id: lookup.record.user_id,
          environment_label: lookup.record.environment_label,
        },
        lifecycle,
        profile,
      },
    },
  };
}

export function buildSignedPrincipalAuthInfo(config, headers) {
  const { envelope, principal } = resolveRemotePrincipalFromHeaders(headers, config);
  ensureRequiredScopes(principal.scopes, config?.remoteAuth?.requiredScopes || []);

  return {
    token: principal.token_id || envelope?.request_id || "signed-principal",
    clientId: principal.token_id || principal.account_id || "signed-principal",
    scopes: principal.scopes,
    expiresAt: getExpiryEpochSeconds(principal.expires_at),
    extra: {
      auth_mode: "signed_principal",
      envelope,
      principal,
    },
  };
}

export async function resolveRequestAuth(req, config, authDb) {
  const mode = String(config?.remoteAuth?.mode || "bearer").trim().toLowerCase();

  if (mode === "none") {
    return null;
  }

  if (mode === "signed_principal") {
    return buildSignedPrincipalAuthInfo(config, req.headers);
  }

  const rawToken = extractBearerToken(req.headers, config?.remoteAuth?.tokenHeader || "authorization");
  if (!rawToken) {
    throw new AgentAuthError("Missing Bitvoya bearer token.", {
      statusCode: 401,
      reasonCode: "missing_bearer_token",
    });
  }

  const verified = await verifyBearerAgentKey(authDb, rawToken, config, {
    ip: extractRequestIp(req),
    userAgent: req?.headers?.["user-agent"] || null,
  });

  return verified.authInfo;
}

export async function writeAuthAuditEvent(authDb, event = {}) {
  const eventId = String(event.event_id || `mcp_audit_${crypto.randomUUID()}`);
  const principal = normalizePrincipal(event.principal || {});
  const scopes = normalizeScopeList(event.scopes || principal.scopes || []);

  await authDb.query(
    `
      INSERT INTO mcp_auth_audit_events (
        event_id,
        token_id,
        account_id,
        user_id,
        actor_type,
        event_type,
        tool_name,
        request_id,
        status,
        reason_code,
        ip_address,
        user_agent,
        scopes_json,
        request_context_json,
        result_context_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      eventId,
      principal.token_id || null,
      principal.account_id || null,
      principal.user_id || null,
      principal.actor_type || null,
      String(event.event_type || "auth"),
      event.tool_name ? String(event.tool_name) : null,
      event.request_id ? String(event.request_id) : null,
      String(event.status || "unknown"),
      event.reason_code ? String(event.reason_code) : null,
      event.ip_address ? String(event.ip_address) : null,
      event.user_agent ? String(event.user_agent) : null,
      JSON.stringify(scopes),
      JSON.stringify(event.request_context || {}),
      JSON.stringify(event.result_context || {}),
    ]
  );

  return eventId;
}
