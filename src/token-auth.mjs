import crypto from "node:crypto";
import { normalizeScopeList } from "./authz.mjs";

function hashWithOptionalPepper(value, pepper = "") {
  if (pepper) {
    return crypto.createHmac("sha256", pepper).update(value).digest("hex");
  }

  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");

  if (leftBuffer.length === 0 || rightBuffer.length === 0) {
    return false;
  }

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAgentToken(options = {}) {
  const tokenPrefix = String(options.tokenPrefix || "btk").trim() || "btk";
  const environment = String(options.environment || "live").trim() || "live";
  const tokenId = String(options.tokenId || crypto.randomUUID().replace(/-/g, ""));
  const secretBytes = Number.isFinite(options.secretBytes) ? options.secretBytes : 24;
  const secret = crypto.randomBytes(secretBytes).toString("base64url");
  const rawToken = `${tokenPrefix}_${environment}_${tokenId}_${secret}`;

  return {
    raw_token: rawToken,
    token_id: `${tokenPrefix}_${environment}_${tokenId}`,
    token_prefix: rawToken.slice(0, Math.min(rawToken.length, 18)),
    environment,
  };
}

export function hashAgentToken(rawToken, options = {}) {
  return hashWithOptionalPepper(String(rawToken || ""), String(options.pepper || ""));
}

export function verifyAgentToken(rawToken, expectedHash, options = {}) {
  const computed = hashAgentToken(rawToken, options);
  return safeEqualHex(computed, expectedHash);
}

export function parseAgentToken(rawToken) {
  const parts = String(rawToken || "").trim().split("_");
  if (parts.length < 4) {
    return null;
  }

  const [tokenPrefix, environment, tokenId, ...secretParts] = parts;
  const secret = secretParts.join("_");

  if (!tokenPrefix || !environment || !tokenId || !secret) {
    return null;
  }

  return {
    token_prefix: tokenPrefix,
    environment,
    token_id: `${tokenPrefix}_${environment}_${tokenId}`,
    secret,
  };
}

export function buildAgentTokenRecordSeed(input = {}, options = {}) {
  const token = createAgentToken(options);
  const scopes = normalizeScopeList(input.scopes);

  return {
    raw_token: token.raw_token,
    record: {
      token_id: token.token_id,
      token_prefix: token.token_prefix,
      account_id:
        input.account_id === null || input.account_id === undefined
          ? null
          : String(input.account_id),
      user_id:
        input.user_id === null || input.user_id === undefined
          ? null
          : String(input.user_id),
      token_name: String(input.token_name || "Default MCP Token").trim() || "Default MCP Token",
      token_type: String(input.token_type || "agent_api_key"),
      actor_type: String(input.actor_type || "partner_agent"),
      token_hash: hashAgentToken(token.raw_token, options),
      scopes_json: JSON.stringify(scopes),
      environment_label: token.environment,
      expires_at: input.expires_at || null,
      metadata_json: JSON.stringify(input.metadata || {}),
    },
  };
}
