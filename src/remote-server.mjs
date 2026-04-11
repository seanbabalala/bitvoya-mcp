import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentAuthError, resolveRequestAuth } from "./agent-auth.mjs";

function buildRequestUrl(req, fallbackHost) {
  const host = req.headers.host || fallbackHost || "127.0.0.1";
  return new URL(req.url || "/", `http://${host}`);
}

function setCommonHeaders(res) {
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) {
    return;
  }

  setCommonHeaders(res);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function sendJsonRpcError(res, statusCode, message, id = null) {
  sendJson(res, statusCode, {
    jsonrpc: "2.0",
    error: {
      code: statusCode >= 500 ? -32603 : -32000,
      message,
    },
    id,
  });
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

  if (!config?.http?.port) {
    throw new Error("Remote HTTP transport requires config.http.port.");
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = buildRequestUrl(req, config.http.host);

    if (req.method === "OPTIONS") {
      setCommonHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === config.http.healthPath) {
      sendJson(res, 200, {
        ok: true,
        service: config.server.name,
        transport: config.server.transport,
      });
      return;
    }

    if (requestUrl.pathname !== config.http.path) {
      sendJson(res, 404, {
        ok: false,
        message: "Not found.",
      });
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, "Method not allowed.");
      return;
    }

    let mcpServer = null;
    let transport = null;

    try {
      const body = await readJsonBody(req);
      req.auth = await resolveRequestAuth(req, config, authDb);

      mcpServer = buildServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        void closeRuntime(mcpServer, transport);
      });

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
        });
        return;
      }

      sendJsonRpcError(res, 500, error?.message || "Internal server error.");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, resolve);
  });

  return {
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
