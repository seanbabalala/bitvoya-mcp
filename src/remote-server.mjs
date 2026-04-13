import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentAuthError, resolveRequestAuth } from "./agent-auth.mjs";

const ACCESS_CONTROL_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
].join(", ");
const ACCESS_CONTROL_ALLOW_METHODS = "POST, GET, DELETE, OPTIONS";
const ACCESS_CONTROL_EXPOSE_HEADERS = "mcp-session-id";

function buildRequestUrl(req, fallbackHost) {
  const host = req.headers.host || fallbackHost || "127.0.0.1";
  return new URL(req.url || "/", `http://${host}`);
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

async function closeRuntime(server, transport) {
  try {
    if (transport) {
      await transport.close();
    }
  } catch {}

  try {
    if (server) {
      await server.close();
    }
  } catch {}
}

export async function startRemoteServer(options = {}) {
  const config = options.config;
  const authDb = options.authDb;
  const buildServer = options.buildServer;
  const remoteSecurity = resolveRemoteSecurity(config);

  if (config?.http?.port === undefined || config?.http?.port === null) {
    throw new Error("Remote HTTP transport requires config.http.port.");
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = buildRequestUrl(req, config.http.host);
    const headerValidationError = buildHeaderValidationError(req, remoteSecurity);

    if (headerValidationError) {
      sendJson(res, 403, {
        ok: false,
        message: headerValidationError,
      }, req, remoteSecurity);
      return;
    }

    if (req.method === "OPTIONS") {
      setCommonHeaders(res, req, remoteSecurity);
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === config.http.healthPath) {
      sendJson(res, 200, {
        ok: true,
        service: config.server.name,
        transport: config.server.transport,
      }, req, remoteSecurity);
      return;
    }

    if (requestUrl.pathname !== config.http.path) {
      sendJson(res, 404, {
        ok: false,
        message: "Not found.",
      }, req, remoteSecurity);
      return;
    }

    if (!["POST", "GET", "DELETE"].includes(req.method || "")) {
      sendJsonRpcError(res, 405, "Method not allowed.", null, req, remoteSecurity);
      return;
    }

    let mcpServer = null;
    let transport = null;

    try {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      req.auth = await resolveRequestAuth(req, config, authDb);

      mcpServer = buildServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: remoteSecurity.enableDnsRebindingProtection,
        allowedHosts: remoteSecurity.allowedHosts,
        allowedOrigins: remoteSecurity.allowedOrigins,
      });

      res.on("close", () => {
        void closeRuntime(mcpServer, transport);
      });

      setCommonHeaders(res, req, remoteSecurity);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      await closeRuntime(mcpServer, transport);

      if (error instanceof AgentAuthError) {
        sendJson(res, error.statusCode, {
          ok: false,
          code: error.reasonCode,
          message: error.message,
          details: error.details || null,
        }, req, remoteSecurity);
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

  return {
    host: config.http.host,
    port: server.address()?.port || config.http.port,
    async close() {
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
