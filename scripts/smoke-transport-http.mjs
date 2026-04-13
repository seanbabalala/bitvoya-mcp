import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startRemoteServer } from "../src/remote-server.mjs";

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

function createTestConfig() {
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
      allowedHosts: ["www.bitvoya.com"],
      allowedOrigins: ["https://www.bitvoya.com"],
      enableDnsRebindingProtection: true,
    },
    remoteAuth: {
      mode: "none",
    },
  };
}

export async function runRemoteTransportSmoke() {
  const runtime = await startRemoteServer({
    config: createTestConfig(),
    authDb: null,
    buildServer() {
      return new McpServer({
        name: "bitvoya-mcp-test",
        version: "0.0.0",
      });
    },
  });

  try {
    const allowedGet = await sendHttpRequest({
      port: runtime.port,
      method: "GET",
      path: "/mcp",
      headers: {
        Host: "bitvoya.com",
        Accept: "text/event-stream",
        Origin: "https://bitvoya.com",
      },
      destroyOnResponse: true,
    });

    const deniedOriginGet = await sendHttpRequest({
      port: runtime.port,
      method: "GET",
      path: "/mcp",
      headers: {
        Host: "bitvoya.com",
        Accept: "text/event-stream",
        Origin: "https://evil.example",
      },
    });

    const deniedHostGet = await sendHttpRequest({
      port: runtime.port,
      method: "GET",
      path: "/mcp",
      headers: {
        Host: "evil.example",
        Accept: "text/event-stream",
      },
    });

    const preflight = await sendHttpRequest({
      port: runtime.port,
      method: "OPTIONS",
      path: "/mcp",
      headers: {
        Host: "bitvoya.com",
        Origin: "https://bitvoya.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, content-type, mcp-protocol-version, last-event-id",
      },
    });

    assert.equal(allowedGet.statusCode, 200);
    assert.match(String(allowedGet.headers["content-type"] || ""), /text\/event-stream/);
    assert.equal(allowedGet.headers["access-control-allow-origin"], "https://bitvoya.com");
    assert.match(
      String(allowedGet.headers["access-control-expose-headers"] || ""),
      /mcp-session-id/i
    );

    assert.equal(deniedOriginGet.statusCode, 403);
    assert.match(deniedOriginGet.body, /Invalid Origin header/i);

    assert.equal(deniedHostGet.statusCode, 403);
    assert.match(deniedHostGet.body, /Invalid Host header/i);

    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://bitvoya.com");
    assert.match(String(preflight.headers["access-control-allow-methods"] || ""), /GET/);
    assert.match(
      String(preflight.headers["access-control-allow-headers"] || ""),
      /mcp-protocol-version/i
    );

    return {
      allowed_get: {
        status: allowedGet.statusCode,
        content_type: allowedGet.headers["content-type"] || null,
        access_control_allow_origin: allowedGet.headers["access-control-allow-origin"] || null,
      },
      denied_origin_get: {
        status: deniedOriginGet.statusCode,
      },
      denied_host_get: {
        status: deniedHostGet.statusCode,
      },
      preflight: {
        status: preflight.statusCode,
        access_control_allow_origin: preflight.headers["access-control-allow-origin"] || null,
      },
    };
  } finally {
    await runtime.close();
  }
}

async function main() {
  const result = await runRemoteTransportSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
