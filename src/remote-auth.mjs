import crypto from "node:crypto";
import { evaluateToolAuthorization, normalizeScopeList } from "./authz.mjs";

function readHeader(headers, name) {
  const normalizedName = String(name || "").toLowerCase();

  if (!headers || !normalizedName) {
    return null;
  }

  if (typeof headers.get === "function") {
    return headers.get(normalizedName) || headers.get(name) || null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (String(key || "").toLowerCase() === normalizedName) {
      if (Array.isArray(value)) {
        return value.join(", ");
      }
      return value === undefined || value === null ? null : String(value);
    }
  }

  return null;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortKeysDeep(value[key]);
      return result;
    }, {});
}

function encodeEnvelope(envelope) {
  return Buffer.from(JSON.stringify(sortKeysDeep(envelope))).toString("base64url");
}

function decodeEnvelope(payload) {
  return JSON.parse(Buffer.from(String(payload || ""), "base64url").toString("utf8"));
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeSignatureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length === 0 || rightBuffer.length === 0) {
    return false;
  }

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function extractBearerToken(headers, tokenHeader = "authorization") {
  const rawValue = readHeader(headers, tokenHeader);
  if (!rawValue) {
    return null;
  }

  if (String(tokenHeader).toLowerCase() !== "authorization") {
    return rawValue.trim();
  }

  const match = rawValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function normalizePrincipal(principal = {}) {
  return {
    user_id:
      principal.user_id === null || principal.user_id === undefined
        ? null
        : String(principal.user_id),
    account_id:
      principal.account_id === null || principal.account_id === undefined
        ? null
        : String(principal.account_id),
    email: principal.email ? String(principal.email) : null,
    user_role: principal.user_role ? String(principal.user_role) : null,
    account_status: String(principal.account_status || "active"),
    commercial_plan: principal.commercial_plan ? String(principal.commercial_plan) : null,
    token_id: principal.token_id ? String(principal.token_id) : null,
    token_type: String(principal.token_type || "agent_api_key"),
    actor_type: String(principal.actor_type || "partner_agent"),
    scopes: normalizeScopeList(principal.scopes),
    issued_at: principal.issued_at || null,
    expires_at: principal.expires_at || null,
  };
}

export function createSignedPrincipalEnvelope(principal, secret, options = {}) {
  if (!secret) {
    throw new Error("Remote auth shared secret is required for signed principal envelopes.");
  }

  const normalizedPrincipal = normalizePrincipal(principal);
  const envelope = {
    version: 1,
    issued_at: options.issued_at || new Date().toISOString(),
    request_id: options.request_id || null,
    principal: normalizedPrincipal,
  };
  const payload = encodeEnvelope(envelope);
  const signature = signPayload(payload, secret);

  return {
    envelope,
    payload,
    signature,
  };
}

export function verifySignedPrincipalEnvelope(payload, signature, options = {}) {
  const secret = String(options.secret || "");
  const maxSkewSeconds = Number.isFinite(options.maxSkewSeconds) ? options.maxSkewSeconds : 300;

  if (!payload || !signature) {
    throw new Error("Signed principal envelope is incomplete.");
  }

  if (!secret) {
    throw new Error("Remote auth shared secret is not configured.");
  }

  const expectedSignature = signPayload(payload, secret);
  if (!safeSignatureEqual(signature, expectedSignature)) {
    throw new Error("Signed principal envelope failed signature verification.");
  }

  const envelope = decodeEnvelope(payload);
  if (Number(envelope?.version) !== 1) {
    throw new Error("Unsupported principal envelope version.");
  }

  const issuedAtMs = Date.parse(String(envelope?.issued_at || ""));
  if (Number.isFinite(issuedAtMs) && maxSkewSeconds >= 0) {
    const skewMs = Math.abs(Date.now() - issuedAtMs);
    if (skewMs > maxSkewSeconds * 1000) {
      throw new Error("Signed principal envelope is outside the allowed clock skew.");
    }
  }

  const principal = normalizePrincipal(envelope.principal || {});
  const expiresAtMs = Date.parse(String(principal.expires_at || ""));
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    throw new Error("Principal token is expired.");
  }

  return {
    envelope,
    principal,
  };
}

export function buildSignedPrincipalHeaders(principal, config, options = {}) {
  const { payload, signature } = createSignedPrincipalEnvelope(
    principal,
    config?.remoteAuth?.sharedSecret,
    options
  );

  return {
    [config?.remoteAuth?.principalHeader || "x-bitvoya-principal"]: payload,
    [config?.remoteAuth?.signatureHeader || "x-bitvoya-signature"]: signature,
  };
}

export function resolveRemotePrincipalFromHeaders(headers, config) {
  const principalHeader = config?.remoteAuth?.principalHeader || "x-bitvoya-principal";
  const signatureHeader = config?.remoteAuth?.signatureHeader || "x-bitvoya-signature";
  const payload = readHeader(headers, principalHeader);
  const signature = readHeader(headers, signatureHeader);

  return verifySignedPrincipalEnvelope(payload, signature, {
    secret: config?.remoteAuth?.sharedSecret,
    maxSkewSeconds: config?.remoteAuth?.maxSkewSeconds,
  });
}

export function authorizeRemoteToolRequest({
  headers,
  config,
  toolName,
  bookingExecutionMode = "executor_handoff",
  resourceAccountId = null,
}) {
  const { envelope, principal } = resolveRemotePrincipalFromHeaders(headers, config);
  const authorization = evaluateToolAuthorization(principal, toolName, {
    bookingExecutionMode,
    resourceAccountId,
  });

  if (!authorization.allowed) {
    const missingScopeText =
      authorization.missing_scopes && authorization.missing_scopes.length > 0
        ? ` Missing scopes: ${authorization.missing_scopes.join(", ")}.`
        : "";
    throw new Error(
      `Remote principal is not authorized for ${toolName}. Reason: ${authorization.reason}.${missingScopeText}`
    );
  }

  return {
    envelope,
    principal,
    authorization,
  };
}
