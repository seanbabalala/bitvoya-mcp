import assert from "node:assert/strict";
import test from "node:test";
import { createHttpClient } from "../src/http.mjs";

function stubFetch(t, answer) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    return new Response(JSON.stringify(answer(body)), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

function apiConfig(extra = {}) {
  return { api: { baseUrl: "https://api.example.test/api", timeoutMs: 5000, userAgent: "bitvoya-mcp/test", ...extra } };
}

test("sends the rate key when one is configured", async (t) => {
  const calls = stubFetch(t, () => ({ success: true, data: {} }));
  await createHttpClient({ ...apiConfig().api, rateKey: "mcp-key" }).request("/hotels/detail");
  await createHttpClient(apiConfig().api).request("/hotels/detail");
  assert.equal(calls[0].headers["x-bitvoya-rate-key"], "mcp-key");
  assert.equal("x-bitvoya-rate-key" in calls[1].headers, false);
});
