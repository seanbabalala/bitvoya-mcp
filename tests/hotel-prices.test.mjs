import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolAuthorization } from "../src/authz.mjs";
import { getHotelPriceSignals } from "../src/tools/hotels.mjs";

const FUTURE = { checkin: "2099-12-18", checkout: "2099-12-21" };

function fakeApi(handler) {
  const calls = [];
  return {
    calls,
    async getHotelPrices(params, options) {
      calls.push({ params, options });
      return handler(params);
    },
  };
}

test("maps nightly prices by hotel id and keeps the requested order", async () => {
  const api = fakeApi(() => [
    { id: "4816", minPrice: 15099, initMinPrice: 15099.48, initPriceUnit: "CNY" },
    { id: "4837", minPrice: 13887, initMinPrice: 1870, initPriceUnit: "EUR" },
  ]);
  const result = await getHotelPriceSignals(api, { hotel_ids: ["4837", "4816", "4837", " "], ...FUTURE, adult_num: 2 });

  assert.equal(result.tool, "get_hotel_prices");
  assert.equal(result.status, "ok");
  assert.deepEqual(api.calls[0].params.hotelIds, ["4837", "4816"]);
  assert.equal(api.calls[0].options.timeoutMs, 12000);
  assert.equal(result.data.stay.nights, 3);
  assert.deepEqual(result.data.prices[0], {
    hotel_id: "4837",
    available: true,
    from_per_night_cny: 13887,
    supplier_currency: "EUR",
    supplier_from_per_night: 1870,
  });
  assert.deepEqual(result.entity_refs.hotel_ids, ["4837", "4816"]);
});

test("hotels without a price are reported as unavailable", async () => {
  const api = fakeApi(() => [{ id: "1", minPrice: 900 }, { id: "2", minPrice: 0 }]);
  const result = await getHotelPriceSignals(api, { hotel_ids: ["1", "2", "3"], ...FUTURE });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.prices.map((item) => item.available), [true, false, false]);
  assert.equal(result.data.prices[1].from_per_night_cny, null);
});

test("a timeout is a partial result with a retry warning, other errors propagate", async () => {
  const slow = fakeApi(() => {
    throw new Error("The operation was aborted due to timeout");
  });
  const result = await getHotelPriceSignals(slow, { hotel_ids: ["1"], ...FUTURE });
  assert.equal(result.status, "partial");
  assert.match(result.decision_support.warnings[0], /timed out/);

  const broken = fakeApi(() => {
    throw new Error("HTTP 500 from /hotels/prices");
  });
  await assert.rejects(getHotelPriceSignals(broken, { hotel_ids: ["1"], ...FUTURE }), /HTTP 500/);
});

test("invalid dates skip the lookup", async () => {
  const api = fakeApi(() => []);
  const result = await getHotelPriceSignals(api, { hotel_ids: ["1"], checkin: "2099-12-21", checkout: "2099-12-18" });
  assert.equal(api.calls.length, 0);
  assert.equal(result.status, "not_found");
  assert.match(result.decision_support.warnings[0], /checkout after checkin/);
});

test("discovery-only keys may call get_hotel_prices", () => {
  const principal = { account_id: "1", actor_type: "bitvoya_managed_agent", scopes: ["inventory.read", "grounding.read"] };
  assert.equal(evaluateToolAuthorization(principal, "get_hotel_prices").allowed, true);
  assert.equal(evaluateToolAuthorization(principal, "prepare_booking_quote").allowed, false);
});
