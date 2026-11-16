import assert from "node:assert/strict";
import test from "node:test";
import { createBitvoyaApi } from "../src/bitvoya-api.mjs";
import { createHttpClient } from "../src/http.mjs";

const FUTURE = { checkin: "2099-12-18", checkout: "2099-12-21" };

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

test("asks for prices 10 hotels at a time and keeps the hotels the API did not check", async (t) => {
  const calls = stubFetch(t, (body) => {
    const ids = body.hotel_ids.split(",");
    return {
      success: true,
      code: 200,
      data: {
        code: 0,
        data: ids.slice(1).map((id) => ({ id, minPrice: 1000 })),
        deferred_hotel_ids: ids.slice(0, 1),
        deferred_reason: "budget",
      },
    };
  });
  const hotelIds = Array.from({ length: 23 }, (_, index) => String(100 + index));
  const answer = await createBitvoyaApi(apiConfig()).getHotelPrices({ hotelIds, ...FUTURE, adultNum: 2 });

  assert.deepEqual(calls.map((call) => call.body.hotel_ids.split(",").length), [10, 10, 3]);
  assert.equal(answer.rows.length, 20);
  assert.deepEqual(answer.deferredHotelIds, ["100", "110", "120"]);
});

test("no hotels means no price request", async (t) => {
  const calls = stubFetch(t, () => ({ success: true, data: { data: [] } }));
  const answer = await createBitvoyaApi(apiConfig()).getHotelPrices({ hotelIds: [" "], ...FUTURE, adultNum: 2 });
  assert.equal(calls.length, 0);
  assert.deepEqual(answer, { rows: [], deferredHotelIds: [] });
});

test("a held-back rooms answer is an error that says the rates were not checked", async (t) => {
  stubFetch(t, () => ({
    success: true,
    code: 200,
    data: { availability: "unknown", rooms: [], query_state: "busy", reason: "switch", retryable: true, retry_after_seconds: 30 },
  }));
  const api = createBitvoyaApi(apiConfig());
  await assert.rejects(api.getHotelRooms({ hotelId: "1", ...FUTURE, adultNum: 2 }), (error) => {
    assert.equal(error.heldBack, true);
    assert.equal(error.retryAfterSeconds, 30);
    assert.match(error.message, /not checked.*\(switch\).*about 30s.*not mean the hotel is sold out/);
    return true;
  });
});

test("rooms answers still come back as a list", async (t) => {
  stubFetch(t, () => ({ success: true, code: 200, data: [{ id: "r1" }] }));
  const rooms = await createBitvoyaApi(apiConfig()).getHotelRooms({ hotelId: "1", ...FUTURE, adultNum: 2 });
  assert.deepEqual(rooms, [{ id: "r1" }]);
});
