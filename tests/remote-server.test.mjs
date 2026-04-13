import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startRemoteServer } from "../src/remote-server.mjs";
import { hashAgentToken, parseAgentToken } from "../src/token-auth.mjs";

const TEST_PROTOCOL_VERSION = "2025-03-26";
const RAW_AGENT_TOKEN = "btk_live_transporttest_supersecretvalue";

function sendHttpRequest({ port, method, path, headers = {}, body = null, destroyOnResponse = false }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers,
      },
      (res) => {
        if (destroyOnResponse) {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: "",
          });
          res.destroy();
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function parseJsonBody(response) {
  return response.body ? JSON.parse(response.body) : null;
}

function buildInitializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: TEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "transport-test-client",
        version: "0.0.1",
      },
    },
  };
}

function buildAuthDb(rawToken = RAW_AGENT_TOKEN) {
  const parsed = parseAgentToken(rawToken);
  const tokenHash = hashAgentToken(rawToken, { pepper: "" });
  const row = {
    id: 1,
    token_id: parsed.token_id,
    token_prefix: parsed.token_id.slice(0, 18),
    token_name: "Transport Test Token",
    token_type: "agent_api_key",
    actor_type: "partner_agent",
    account_id: "acct_transport_test",
    user_id: "user_transport_test",
    scopes_json: JSON.stringify(["mcp:read"]),
    status: "active",
    environment_label: "live",
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    last_used_at: null,
    metadata_json: JSON.stringify({ test: true }),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  return {
    touched: [],
    async queryOne(sql, params = []) {
      if (sql.includes("WHERE token_hash = ?")) {
        return params[0] === tokenHash ? row : null;
      }

      if (sql.includes("WHERE token_id = ?")) {
        return params[0] === parsed.token_id ? row : null;
      }

      return null;
    },
    async query(sql, params = []) {
      this.touched.push({ sql, params });
      return { affectedRows: 1 };
    },
  };
}

function createTestConfig(overrides = {}) {
  const overrideHttp = overrides.http || {};
  const overrideRemoteAuth = overrides.remoteAuth || {};
  const extraOverrides = { ...overrides };
  delete extraOverrides.http;
  delete extraOverrides.remoteAuth;

  return {
    server: {
      name: "bitvoya-mcp-test",
      transport: "streamable_http",
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      healthPath: "/healthz",
      publicBaseUrl: "https://bitvoya.com",
      allowedHosts: [],
      allowedOrigins: [],
      enableDnsRebindingProtection: true,
      sessionIdleTimeoutMs: 2000,
      sessionSweepIntervalMs: 100,
      ...overrideHttp,
    },
    remoteAuth: {
      mode: "bearer",
      tokenHeader: "authorization",
      principalHeader: "x-bitvoya-principal",
      signatureHeader: "x-bitvoya-signature",
      sharedSecret: "",
      tokenPepper: "",
      maxSkewSeconds: 300,
      requiredScopes: [],
      ...overrideRemoteAuth,
    },
    ...extraOverrides,
  };
}

function buildServer() {
  const server = new McpServer({
    name: "bitvoya-mcp-test",
    version: "0.0.0",
  });

  server.registerTool(
    "ping",
    {
      description: "Simple test tool.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "pong",
        },
      ],
    })
  );

  return server;
}

async function startTestRuntime(options = {}) {
  const logs = [];
  const authDb = options.authDb || buildAuthDb();
  const runtime = await startRemoteServer({
    config: createTestConfig(options.config || {}),
    authDb,
    buildServer,
    logger(entry) {
      logs.push(entry);
    },
  });

  return {
    runtime,
    authDb,
    logs,
    async close() {
      await runtime.close();
    },
  };
}

async function initializeSession(runtime, options = {}) {
  const response = await sendHttpRequest({
    port: runtime.port,
    method: "POST",
    path: "/mcp",
    headers: {
      Accept: options.accept || "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.rawToken || RAW_AGENT_TOKEN}`,
      ...(options.headers || {}),
    },
    body: JSON.stringify(buildInitializeRequest()),
  });

  return {
    response,
    payload: parseJsonBody(response),
    sessionId: String(response.headers["mcp-session-id"] || ""),
  };
}

async function sendToolsList(runtime, sessionId, options = {}) {
  const response = await sendHttpRequest({
    port: runtime.port,
    method: "POST",
    path: "/mcp",
    headers: {
      Accept: options.accept || "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.rawToken || RAW_AGENT_TOKEN}`,
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": options.protocolVersion || TEST_PROTOCOL_VERSION,
      ...(options.headers || {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  return {
    response,
    payload: parseJsonBody(response),
  };
}

test("OPTIONS /mcp returns 204", async () => {
  const harness = await startTestRuntime();

  try {
    const response = await sendHttpRequest({
      port: harness.runtime.port,
      method: "OPTIONS",
      path: "/mcp",
      headers: {
        Origin: "https://bitvoya.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    assert.equal(response.statusCode, 204);
  } finally {
    await harness.close();
  }
});

test("missing bearer token preserves auth error shape", async () => {
  const harness = await startTestRuntime();

  try {
    const response = await sendHttpRequest({
      port: harness.runtime.port,
      method: "POST",
      path: "/mcp",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildInitializeRequest()),
    });

    const payload = parseJsonBody(response);
    assert.equal(response.statusCode, 401);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "missing_bearer_token");
    assert.match(payload.message, /Missing Bitvoya bearer token/i);
  } finally {
    await harness.close();
  }
});

test("valid initialize creates a session runtime and tools/list reuses it", async () => {
  const harness = await startTestRuntime();

  try {
    const initialize = await initializeSession(harness.runtime);
    assert.equal(initialize.response.statusCode, 200);
    assert.ok(initialize.sessionId);

    const afterInitialize = harness.runtime.getSessionRuntimeSnapshot();
    assert.equal(afterInitialize.sessionCount, 1);
    const firstRuntimeId = afterInitialize.sessions[0].runtimeId;

    const toolsList = await sendToolsList(harness.runtime, initialize.sessionId);
    assert.equal(toolsList.response.statusCode, 200);
    assert.ok(Array.isArray(toolsList.payload.result.tools));

    const afterToolsList = harness.runtime.getSessionRuntimeSnapshot();
    assert.equal(afterToolsList.sessionCount, 1);
    assert.equal(afterToolsList.sessions[0].runtimeId, firstRuntimeId);

    const requestLogs = harness.logs.filter((entry) => entry.event === "mcp_http_request");
    assert.ok(requestLogs.some((entry) => entry.session_runtime === "created"));
    assert.ok(requestLogs.some((entry) => entry.session_runtime === "reused"));
  } finally {
    await harness.close();
  }
});

test("DELETE cleans up the session runtime", async () => {
  const harness = await startTestRuntime();

  try {
    const initialize = await initializeSession(harness.runtime);
    assert.equal(initialize.response.statusCode, 200);

    const deleteResponse = await sendHttpRequest({
      port: harness.runtime.port,
      method: "DELETE",
      path: "/mcp",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${RAW_AGENT_TOKEN}`,
        "Mcp-Session-Id": initialize.sessionId,
        "Mcp-Protocol-Version": TEST_PROTOCOL_VERSION,
      },
    });

    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(harness.runtime.getSessionRuntimeSnapshot().sessionCount, 0);
  } finally {
    await harness.close();
  }
});

test("idle timeout clears inactive session runtimes", async () => {
  const harness = await startTestRuntime({
    config: {
      http: {
        sessionIdleTimeoutMs: 40,
        sessionSweepIntervalMs: 10,
      },
    },
  });

  try {
    const initialize = await initializeSession(harness.runtime);
    assert.equal(initialize.response.statusCode, 200);
    assert.equal(harness.runtime.getSessionRuntimeSnapshot().sessionCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(harness.runtime.getSessionRuntimeSnapshot().sessionCount, 0);
    assert.ok(
      harness.logs.some(
        (entry) => entry.event === "mcp_session_runtime_closed" && entry.reason === "idle_timeout"
      )
    );
  } finally {
    await harness.close();
  }
});

test("accept header variations remain compatible", async () => {
  const accepts = [
    "application/json",
    "text/event-stream",
    "application/json, text/event-stream",
    "text/event-stream, application/json",
  ];

  for (const accept of accepts) {
    const harness = await startTestRuntime();

    try {
      const initialize = await initializeSession(harness.runtime, { accept });
      assert.equal(initialize.response.statusCode, 200, `initialize failed for Accept=${accept}`);
      assert.ok(initialize.sessionId);
    } finally {
      await harness.close();
    }
  }
});

test("logs do not leak the raw bearer token", async () => {
  const harness = await startTestRuntime();

  try {
    const initialize = await initializeSession(harness.runtime);
    assert.equal(initialize.response.statusCode, 200);

    const serializedLogs = JSON.stringify(harness.logs);
    assert.equal(serializedLogs.includes(RAW_AGENT_TOKEN), false);
    assert.equal(serializedLogs.includes(`Bearer ${RAW_AGENT_TOKEN}`), false);
  } finally {
    await harness.close();
  }
});

test("Cherry-like flow keeps GET SSE and initialized notification working", async () => {
  const harness = await startTestRuntime();

  try {
    const getResponse = await sendHttpRequest({
      port: harness.runtime.port,
      method: "GET",
      path: "/mcp",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${RAW_AGENT_TOKEN}`,
      },
      destroyOnResponse: true,
    });

    assert.equal(getResponse.statusCode, 200);
    assert.match(String(getResponse.headers["content-type"] || ""), /text\/event-stream/);

    const initialize = await initializeSession(harness.runtime, {
      accept: "application/json, text/event-stream",
    });
    assert.equal(initialize.response.statusCode, 200);

    const initializedNotification = await sendHttpRequest({
      port: harness.runtime.port,
      method: "POST",
      path: "/mcp",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${RAW_AGENT_TOKEN}`,
        "Mcp-Session-Id": initialize.sessionId,
        "Mcp-Protocol-Version": TEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });

    assert.equal(initializedNotification.statusCode, 202);

    const toolsList = await sendToolsList(harness.runtime, initialize.sessionId, {
      accept: "application/json, text/event-stream",
    });
    assert.equal(toolsList.response.statusCode, 200);
  } finally {
    await harness.close();
  }
});

test("Hermes-like generic flow works with initialize + tools/list over JSON responses", async () => {
  const harness = await startTestRuntime();

  try {
    const initialize = await initializeSession(harness.runtime, {
      accept: "application/json",
    });

    assert.equal(initialize.response.statusCode, 200);
    assert.equal(initialize.payload.result.protocolVersion, TEST_PROTOCOL_VERSION);

    const toolsList = await sendToolsList(harness.runtime, initialize.sessionId, {
      accept: "application/json",
      protocolVersion: initialize.payload.result.protocolVersion,
    });

    assert.equal(toolsList.response.statusCode, 200);
    assert.ok(Array.isArray(toolsList.payload.result.tools));
  } finally {
    await harness.close();
  }
});
