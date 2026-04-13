import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentAuthError, resolveRequestAuth } from "./agent-auth.mjs";
import { createHttpSessionRuntimeManager } from "./http-session-runtime.mjs";

const ACCESS_CONTROL_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
].join(", ");
const ACCESS_CONTROL_ALLOW_METHODS = "POST, GET, DELETE, OPTIONS";
const ACCESS_CONTROL_EXPOSE_HEADERS = "mcp-session-id";
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 30 * 1000;

function buildRequestUrl(req, fallbackHost) {
  const host = req.headers.host || fallbackHost || "127.0.0.1";
  return new URL(req.url || "/", `http://${host}`);
}

function readHeader(headers, name) {
  const normalizedName = String(name || "").toLowerCase();

  if (!headers || !normalizedName) {
    return null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (String(key || "").toLowerCase() !== normalizedName) {
      continue;
    }

    if (Array.isArray(value)) {
      return value.join(", ");
    }

    return value === undefined || value === null ? null : String(value);
  }

  return null;
}

function setRequestHeader(req, name, value) {
  const normalizedName = String(name || "").toLowerCase();
  if (!normalizedName) {
    return;
  }

  req.headers[normalizedName] = value;

  if (!Array.isArray(req.rawHeaders)) {
    return;
  }

  let replaced = false;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index] || "").toLowerCase() !== normalizedName) {
      continue;
    }

    req.rawHeaders[index] = name;
    req.rawHeaders[index + 1] = value;
    replaced = true;
  }

  if (!replaced) {
    req.rawHeaders.push(name, value);
  }
}

function normalizeOrigin(value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
}

function normalizeHost(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function isLoopbackHost(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function formatHostWithPort(host, port) {
  const normalizedHost = String(host || "").trim();
  if (!normalizedHost || !port) {
    return normalizedHost || null;
  }

  if (normalizedHost.includes(":") && !normalizedHost.startsWith("[")) {
    return `[${normalizedHost}]:${port}`;
  }

  return `${normalizedHost}:${port}`;
}

function deriveLoopbackHosts(bindHost, port) {
  const normalizedHost = String(bindHost || "").trim().toLowerCase();
  if (!isLoopbackHost(normalizedHost)) {
    return [];
  }

  return [
    formatHostWithPort("127.0.0.1", port),
    formatHostWithPort("localhost", port),
    formatHostWithPort("::1", port),
  ].filter(Boolean);
}

function deriveLoopbackOrigins(bindHost, port) {
  const normalizedHost = String(bindHost || "").trim().toLowerCase();
  if (!isLoopbackHost(normalizedHost) || !port) {
    return [];
  }

  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
}

export function resolveRemoteSecurity(config = {}) {
  const httpConfig = config.http || {};
  const allowedHosts = new Set();
  const allowedOrigins = new Set();

  for (const host of httpConfig.allowedHosts || []) {
    const normalized = normalizeHost(host);
    if (normalized) {
      allowedHosts.add(normalized);
    }
  }

  for (const origin of httpConfig.allowedOrigins || []) {
    const normalized = normalizeOrigin(origin);
    if (normalized) {
      allowedOrigins.add(normalized);
    }
  }

  const publicBaseUrl = normalizeOrigin(httpConfig.publicBaseUrl);
  if (publicBaseUrl) {
    allowedOrigins.add(publicBaseUrl);

    try {
      const url = new URL(httpConfig.publicBaseUrl);
      const normalizedHost = normalizeHost(url.host);
      if (normalizedHost) {
        allowedHosts.add(normalizedHost);
      }
    } catch {}
  }

  for (const host of deriveLoopbackHosts(httpConfig.host, httpConfig.port)) {
    const normalized = normalizeHost(host);
    if (normalized) {
      allowedHosts.add(normalized);
    }
  }

  for (const origin of deriveLoopbackOrigins(httpConfig.host, httpConfig.port)) {
    const normalized = normalizeOrigin(origin);
    if (normalized) {
      allowedOrigins.add(normalized);
    }
  }

  return {
    enableDnsRebindingProtection: Boolean(httpConfig.enableDnsRebindingProtection),
    allowedHosts: Array.from(allowedHosts),
    allowedOrigins: Array.from(allowedOrigins),
  };
}

function resolveAllowedOriginHeader(req, remoteSecurity) {
  const originHeader = normalizeOrigin(req?.headers?.origin);
  if (!originHeader) {
    return null;
  }

  return remoteSecurity.allowedOrigins.includes(originHeader) ? originHeader : null;
}

function setCommonHeaders(res, req, remoteSecurity) {
  res.setHeader("Access-Control-Allow-Headers", ACCESS_CONTROL_ALLOW_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", ACCESS_CONTROL_ALLOW_METHODS);
  res.setHeader("Access-Control-Expose-Headers", ACCESS_CONTROL_EXPOSE_HEADERS);

  const allowedOrigin = resolveAllowedOriginHeader(req, remoteSecurity);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
}

function buildHeaderValidationError(req, remoteSecurity) {
  if (!remoteSecurity.enableDnsRebindingProtection) {
    return null;
  }

  if (remoteSecurity.allowedHosts.length > 0) {
    const hostHeader = normalizeHost(req?.headers?.host);
    if (!hostHeader || !remoteSecurity.allowedHosts.includes(hostHeader)) {
      return `Invalid Host header: ${req?.headers?.host || ""}`;
    }
  }

  if (remoteSecurity.allowedOrigins.length > 0) {
    const originHeader = req?.headers?.origin;
    if (originHeader) {
      const normalizedOrigin = normalizeOrigin(originHeader);
      if (!normalizedOrigin || !remoteSecurity.allowedOrigins.includes(normalizedOrigin)) {
        return `Invalid Origin header: ${originHeader}`;
      }
    }
  }

  return null;
}

function sendJson(res, statusCode, payload, req = null, remoteSecurity = { allowedOrigins: [] }) {
  if (res.headersSent) {
    return;
  }

  setCommonHeaders(res, req, remoteSecurity);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function sendJsonRpcError(
  res,
  statusCode,
  message,
  id = null,
  req = null,
  remoteSecurity = { allowedOrigins: [] }
) {
  sendJson(
    res,
    statusCode,
    {
      jsonrpc: "2.0",
      error: {
        code: statusCode >= 500 ? -32603 : -32000,
        message,
      },
      id,
    },
    req,
    remoteSecurity
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    req.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > 1024 * 1024) {
        reject(new Error("Request body exceeds 1MB."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8").trim();
      if (!rawBody) {
        reject(new Error("MCP POST body is required."));
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error("MCP POST body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

async function safeCloseRuntime(runtime) {
  try {
    if (runtime?.transport) {
      await runtime.transport.close();
    }
  } catch {}

  try {
    if (runtime?.server) {
      await runtime.server.close();
    }
  } catch {}
}

function emitStructuredLog(logger, entry) {
  const payload = {
    ...entry,
    logged_at: new Date().toISOString(),
  };

  if (typeof logger === "function") {
    logger(payload);
    return;
  }

  const line = JSON.stringify(payload);

  if (logger && typeof logger.info === "function") {
    logger.info(line);
    return;
  }

  if (logger && typeof logger.log === "function") {
    logger.log(line);
    return;
  }

  console.error(line);
}

function extractJsonRpcMethod(body) {
  if (!body) {
    return null;
  }

  const methods = [];
  const items = Array.isArray(body) ? body : [body];

  for (const item of items) {
    if (item && typeof item === "object" && typeof item.method === "string") {
      methods.push(item.method);
    }
  }

  if (methods.length === 0) {
    return null;
  }

  return Array.from(new Set(methods)).join(",");
}

function isInitializeRequestBody(body) {
  const items = Array.isArray(body) ? body : [body];
  return items.some((item) => item && typeof item === "object" && item.method === "initialize");
}

function extractRequestMetadata(req, requestUrl) {
  return {
    method: req.method || null,
    path: requestUrl.pathname,
    user_agent: readHeader(req.headers, "user-agent"),
    accept: readHeader(req.headers, "accept"),
    content_type: readHeader(req.headers, "content-type"),
    origin: readHeader(req.headers, "origin"),
    host: readHeader(req.headers, "host"),
    mcp_session_id: readHeader(req.headers, "mcp-session-id"),
    mcp_protocol_version: readHeader(req.headers, "mcp-protocol-version"),
  };
}

function hasAuthHeaders(req, config) {
  const mode = String(config?.remoteAuth?.mode || "bearer").trim().toLowerCase();
  if (mode === "none") {
    return false;
  }

  if (mode === "signed_principal") {
    const principalHeader = config?.remoteAuth?.principalHeader || "x-bitvoya-principal";
    const signatureHeader = config?.remoteAuth?.signatureHeader || "x-bitvoya-signature";
    return Boolean(readHeader(req.headers, principalHeader) || readHeader(req.headers, signatureHeader));
  }

  const tokenHeader = config?.remoteAuth?.tokenHeader || "authorization";
  return Boolean(readHeader(req.headers, tokenHeader));
}

function buildPrincipalSummary(authInfo) {
  if (!authInfo) {
    return null;
  }

  const principal = authInfo?.extra?.principal || {};

  return {
    auth_mode: authInfo?.extra?.auth_mode || null,
    token_id: principal?.token_id || authInfo?.clientId || null,
    account_id: principal?.account_id || null,
    user_id: principal?.user_id || null,
    actor_type: principal?.actor_type || null,
  };
}

function buildAuthLogSummary(authInfo, error = null) {
  if (authInfo) {
    const principal = buildPrincipalSummary(authInfo);
    return {
      auth_result: "success",
      auth_reason: null,
      principal_type: principal?.actor_type || null,
      token_id_hint: principal?.token_id || null,
    };
  }

  if (error instanceof AgentAuthError) {
    return {
      auth_result: "failure",
      auth_reason: error.reasonCode || "auth_error",
      principal_type: null,
      token_id_hint: error?.details?.lookup?.token_id_hint || null,
    };
  }

  return {
    auth_result: "skipped",
    auth_reason: null,
    principal_type: null,
    token_id_hint: null,
  };
}

function isSamePrincipalSummary(left, right) {
  if (!left || !right) {
    return true;
  }

  if (left.token_id && right.token_id) {
    return left.token_id === right.token_id;
  }

  return (
    (left.account_id || null) === (right.account_id || null) &&
    (left.user_id || null) === (right.user_id || null) &&
    (left.actor_type || null) === (right.actor_type || null) &&
    (left.auth_mode || null) === (right.auth_mode || null)
  );
}

function ensureSessionAuthBinding(runtimeRecord, authInfo) {
  if (!runtimeRecord?.principalSummary || !authInfo) {
    return;
  }

  const requestPrincipalSummary = buildPrincipalSummary(authInfo);
  if (isSamePrincipalSummary(runtimeRecord.principalSummary, requestPrincipalSummary)) {
    return;
  }

  throw new AgentAuthError("MCP session is already bound to a different Bitvoya principal.", {
    statusCode: 403,
    reasonCode: "session_auth_mismatch",
    details: {
      session_id: runtimeRecord.sessionId || null,
    },
  });
}

function normalizeAcceptHeader(method, rawAccept) {
  const normalizedMethod = String(method || "").toUpperCase();
  const rawValue = String(rawAccept || "").trim();
  const tokens = rawValue
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  const hasJson = tokens.includes("application/json");
  const hasEventStream = tokens.includes("text/event-stream");
  const hasWildcard = tokens.includes("*/*");

  if (normalizedMethod === "GET") {
    if (!rawValue || hasEventStream || hasWildcard || hasJson) {
      return "text/event-stream";
    }
    return rawValue;
  }

  if (normalizedMethod === "POST") {
    if (!rawValue || hasJson || hasEventStream || hasWildcard) {
      return "application/json, text/event-stream";
    }
  }

  return rawValue || null;
}

function applyCompatibilityRequestHeaders(req) {
  const rawAccept = readHeader(req.headers, "accept");
  const normalizedAccept = normalizeAcceptHeader(req.method, rawAccept);

  if (normalizedAccept) {
    setRequestHeader(req, "Accept", normalizedAccept);
  }

  return {
    rawAccept: rawAccept || null,
    normalizedAccept: normalizedAccept || null,
  };
}

function createConnectedRuntime(buildServer, remoteSecurity, sessionManager, principalSummary, options = {}) {
  const pendingId = options.pendingId || null;
  const stateful = options.stateful !== false;

  return async () => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: stateful ? () => crypto.randomUUID() : undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: remoteSecurity.enableDnsRebindingProtection,
      allowedHosts: remoteSecurity.allowedHosts,
      allowedOrigins: remoteSecurity.allowedOrigins,
      onsessioninitialized: async (sessionId) => {
        if (pendingId) {
          sessionManager.bindPendingSessionRuntime(pendingId, sessionId);
        }
      },
    });

    await server.connect(transport);

    return {
      server,
      transport,
      principalSummary,
    };
  };
}

export async function startRemoteServer(options = {}) {
  const config = options.config;
  const authDb = options.authDb;
  const buildServer = options.buildServer;
  const logger = options.logger;
  let remoteSecurity = resolveRemoteSecurity(config);
  const sessionIdleTimeoutMs = Math.max(
    0,
    Number(config?.http?.sessionIdleTimeoutMs || DEFAULT_SESSION_IDLE_TIMEOUT_MS)
  );
  const sessionSweepIntervalMs = Math.max(
    10,
    Number(config?.http?.sessionSweepIntervalMs || DEFAULT_SESSION_SWEEP_INTERVAL_MS)
  );
  const ephemeralRuntimes = new Set();

  const sessionManager = createHttpSessionRuntimeManager({
    idleTimeoutMs: sessionIdleTimeoutMs,
    sweepIntervalMs: sessionSweepIntervalMs,
    onRuntimeClosed(record, reason) {
      emitStructuredLog(logger, {
        event: "mcp_session_runtime_closed",
        session_id: record?.sessionId || null,
        runtime_id: record?.runtimeId || null,
        reason,
      });
    },
  });

  if (config?.http?.port === undefined || config?.http?.port === null) {
    throw new Error("Remote HTTP transport requires config.http.port.");
  }

  async function closeEphemeralRuntime(runtime, reason = "ephemeral_close") {
    if (!runtime || runtime.closed) {
      return;
    }

    runtime.closed = true;
    ephemeralRuntimes.delete(runtime);
    await safeCloseRuntime(runtime);

    emitStructuredLog(logger, {
      event: "mcp_session_runtime_closed",
      session_id: null,
      runtime_id: runtime.runtimeId || null,
      reason,
    });
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestUrl = buildRequestUrl(req, config.http.host);
    const requestMeta = extractRequestMetadata(req, requestUrl);
    const authPresent = hasAuthHeaders(req, config);
    const requestHeaderCompat = applyCompatibilityRequestHeaders(req);

    let body;
    let jsonrpcMethod = null;
    let authInfo = null;
    let authError = null;
    let runtimeRecord = null;
    let runtimeState = "none";
    let pendingId = null;
    let ephemeralRuntime = null;
    let responseLogged = false;
    let resolvedSessionId = requestMeta.mcp_session_id || null;

    const finalizeLog = () => {
      if (responseLogged) {
        return;
      }

      responseLogged = true;
      const authSummary = buildAuthLogSummary(authInfo, authError);

      emitStructuredLog(logger, {
        event: "mcp_http_request",
        method: requestMeta.method,
        path: requestMeta.path,
        status_code: res.statusCode || 0,
        latency_ms: Date.now() - startedAt,
        session_id: resolvedSessionId,
        session_runtime: runtimeState,
        user_agent: requestMeta.user_agent,
        accept: requestMeta.accept,
        accept_normalized: requestHeaderCompat.normalizedAccept,
        content_type: requestMeta.content_type,
        origin: requestMeta.origin,
        host: requestMeta.host,
        mcp_session_id: requestMeta.mcp_session_id,
        mcp_protocol_version: requestMeta.mcp_protocol_version,
        jsonrpc_method: jsonrpcMethod,
        auth_present: authPresent,
        auth_result: authSummary.auth_result,
        auth_reason: authSummary.auth_reason,
        principal_type: authSummary.principal_type,
        token_id_hint: authSummary.token_id_hint,
      });
    };

    res.once("finish", finalizeLog);
    res.once("close", finalizeLog);

    const headerValidationError = buildHeaderValidationError(req, remoteSecurity);

    if (headerValidationError) {
      sendJson(
        res,
        403,
        {
          ok: false,
          message: headerValidationError,
        },
        req,
        remoteSecurity
      );
      return;
    }

    if (req.method === "OPTIONS") {
      setCommonHeaders(res, req, remoteSecurity);
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === config.http.healthPath) {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: config.server.name,
          transport: config.server.transport,
        },
        req,
        remoteSecurity
      );
      return;
    }

    if (requestUrl.pathname !== config.http.path) {
      sendJson(
        res,
        404,
        {
          ok: false,
          message: "Not found.",
        },
        req,
        remoteSecurity
      );
      return;
    }

    if (!["POST", "GET", "DELETE"].includes(req.method || "")) {
      sendJsonRpcError(res, 405, "Method not allowed.", null, req, remoteSecurity);
      return;
    }

    try {
      if (req.method === "POST") {
        body = await readJsonBody(req);
        jsonrpcMethod = extractJsonRpcMethod(body);
      }

      authInfo = await resolveRequestAuth(req, config, authDb);
      req.auth = authInfo;

      const requestPrincipalSummary = buildPrincipalSummary(authInfo);
      const requestedSessionId = requestMeta.mcp_session_id || null;
      const isInitializeRequest = req.method === "POST" && isInitializeRequestBody(body);

      if (requestedSessionId) {
        runtimeRecord = sessionManager.getSessionRuntime(requestedSessionId);
        if (!runtimeRecord) {
          sendJsonRpcError(res, 404, "Session not found", null, req, remoteSecurity);
          return;
        }

        ensureSessionAuthBinding(runtimeRecord, authInfo);
        resolvedSessionId = runtimeRecord.sessionId;
        runtimeState = "reused";
      } else if (isInitializeRequest) {
        const created = await sessionManager.createPendingSessionRuntime(
          requestPrincipalSummary,
          async ({ pendingId: nextPendingId }) =>
            createConnectedRuntime(
              buildServer,
              remoteSecurity,
              sessionManager,
              requestPrincipalSummary,
              {
                pendingId: nextPendingId,
                stateful: true,
              }
            )()
        );

        pendingId = created.pendingId;
        runtimeRecord = created.record;
        runtimeState = "created";
      } else if (req.method === "GET") {
        const runtime = await createConnectedRuntime(
          buildServer,
          remoteSecurity,
          sessionManager,
          requestPrincipalSummary,
          {
            stateful: false,
          }
        )();

        ephemeralRuntime = {
          ...runtime,
          runtimeId: crypto.randomUUID(),
          closed: false,
        };
        runtimeRecord = ephemeralRuntime;
        runtimeState = "ephemeral";
        ephemeralRuntimes.add(ephemeralRuntime);

        res.once("close", () => {
          void closeEphemeralRuntime(ephemeralRuntime, "ephemeral_response_closed");
        });
      } else {
        sendJsonRpcError(
          res,
          400,
          "Bad Request: Mcp-Session-Id header is required",
          null,
          req,
          remoteSecurity
        );
        return;
      }

      setCommonHeaders(res, req, remoteSecurity);
      await runtimeRecord.transport.handleRequest(req, res, body);

      if (pendingId) {
        const boundRuntime = sessionManager.getPendingSessionRuntime(pendingId);
        if (!boundRuntime && runtimeRecord.transport.sessionId) {
          resolvedSessionId = runtimeRecord.transport.sessionId;
        } else {
          const initializedRuntime =
            runtimeRecord.transport.sessionId &&
            sessionManager.getSessionRuntime(runtimeRecord.transport.sessionId);
          if (initializedRuntime) {
            resolvedSessionId = initializedRuntime.sessionId;
          }
        }
      }

      if (runtimeRecord?.sessionId) {
        resolvedSessionId = runtimeRecord.sessionId;
      }

      if (req.method === "DELETE" && resolvedSessionId) {
        await sessionManager.closeSessionRuntime(resolvedSessionId, "delete_request");
        runtimeState = "closed";
      }
    } catch (error) {
      authError = error;

      if (pendingId) {
        await sessionManager.closePendingSessionRuntime(pendingId, "initialize_failed");
      }

      if (runtimeState === "created" && runtimeRecord?.transport?.sessionId) {
        await sessionManager.closeSessionRuntime(runtimeRecord.transport.sessionId, "request_failed");
      }

      if (ephemeralRuntime) {
        await closeEphemeralRuntime(ephemeralRuntime, "ephemeral_error");
      }

      if (error instanceof AgentAuthError) {
        sendJson(
          res,
          error.statusCode,
          {
            ok: false,
            code: error.reasonCode,
            message: error.message,
            details: error.details || null,
          },
          req,
          remoteSecurity
        );
        return;
      }

      sendJsonRpcError(
        res,
        500,
        error?.message || "Internal server error.",
        null,
        req,
        remoteSecurity
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, resolve);
  });

  remoteSecurity = resolveRemoteSecurity({
    ...config,
    http: {
      ...(config.http || {}),
      port: server.address()?.port || config.http.port,
    },
  });

  return {
    host: config.http.host,
    port: server.address()?.port || config.http.port,
    getSessionRuntimeSnapshot() {
      return sessionManager.getSnapshot();
    },
    async close() {
      for (const runtime of Array.from(ephemeralRuntimes)) {
        await closeEphemeralRuntime(runtime, "shutdown");
      }

      await sessionManager.closeAllSessionRuntimes("shutdown");

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
