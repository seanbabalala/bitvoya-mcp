import { createHttpClient } from "./http.mjs";
import { asArray, uniqueBy } from "./format.mjs";
import { buildSignedPrincipalHeaders } from "./remote-auth.mjs";

function createBitvoyaApiError(message, { endpoint, response = null, businessCode = null } = {}) {
  const error = new Error(message);
  error.bitvoyaEndpoint = endpoint || null;
  error.bitvoyaResponse = response;
  error.bitvoyaBusinessCode = businessCode;
  return error;
}

function unwrapEnvelope(response, endpoint) {
  const success =
    response?.success === true ||
    response?.code === 200 ||
    response?.message === "success" ||
    response?.msg === "SUCCESS";

  if (!response || !success) {
    throw createBitvoyaApiError(
      response?.error ||
        response?.message ||
        response?.msg ||
        `Bitvoya API call failed for ${endpoint}`,
      {
        endpoint,
        response,
      }
    );
  }

  const businessPayload = response?.data;
  const businessCodeRaw =
    businessPayload && typeof businessPayload === "object" && "code" in businessPayload
      ? businessPayload.code
      : null;
  const businessCode =
    businessCodeRaw === null || businessCodeRaw === undefined || businessCodeRaw === ""
      ? null
      : Number.parseInt(String(businessCodeRaw), 10);
  const businessSuccess = businessCode === null || businessCode === 0 || businessCode === 200;

  if (!businessSuccess) {
    throw createBitvoyaApiError(
      businessPayload?.error ||
        businessPayload?.message ||
        businessPayload?.msg ||
        `Bitvoya API business error for ${endpoint}`,
      {
        endpoint,
        response,
        businessCode,
      }
    );
  }

  if (response.data && typeof response.data === "object" && "data" in response.data) {
    return response.data.data;
  }

  return response.data;
}

// The API takes at most this many hotels in one price request from the MCP.
const PRICE_BATCH_SIZE = 10;

/** The API held a live lookup back (busy, paused or over budget): the rates are unknown, not sold out. */
function createHeldBackError(payload, endpoint, response) {
  const wait = Number(payload?.retry_after_seconds);
  const retryAfterSeconds = Number.isFinite(wait) && wait > 0 ? wait : null;
  const error = createBitvoyaApiError(
    `Live rates were not checked: the Bitvoya API is holding back live lookups right now` +
      ` (${payload?.reason || "busy"}). Retry ${retryAfterSeconds ? `in about ${retryAfterSeconds}s` : "shortly"};` +
      " this does not mean the hotel is sold out.",
    { endpoint, response }
  );
  error.heldBack = true;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function dedupeHotels(items) {
  return uniqueBy(items, (item) => item?.id || null);
}

function buildQuery(params) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === "") continue;
    query.set(key, String(value));
  }

  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function buildRequestPrincipalHeaders(config, requestPrincipal) {
  if (!requestPrincipal) {
    return undefined;
  }

  if (!config?.remoteAuth?.sharedSecret) {
    throw new Error(
      "BITVOYA_MCP_REMOTE_AUTH_SHARED_SECRET is required to forward Bitvoya account pricing context."
    );
  }

  return buildSignedPrincipalHeaders(requestPrincipal, config);
}

export function createBitvoyaApi(config) {
  const http = createHttpClient(config.api);

  return {
    async searchSuggest(searchKey) {
      const payload = unwrapEnvelope(
        await http.request("/search/suggest", {
          method: "POST",
          body: { search_key: searchKey },
        }),
        "/search/suggest"
      );

      return {
        cities: asArray(payload?.cityList),
        hotels: dedupeHotels([...asArray(payload?.hotelEsEnList), ...asArray(payload?.hotelEsList)]),
      };
    },

    async searchHotelsByCity(cityId, profiles = "CITY,BRAND,GROUP,INTEREST,PROMOTION") {
      const payload = unwrapEnvelope(
        await http.request("/hotels/search", {
          method: "POST",
          body: {
            city_id: String(cityId),
            profiles,
          },
        }),
        "/hotels/search"
      );

      return asArray(payload);
    },

    /**
     * `rows` holds the hotels with something to sell for the stay. `deferredHotelIds` are hotels the
     * API did not ask the supplier about this time: their price is unknown, not absent.
     */
    async getHotelPrices({ hotelIds, checkin, checkout, adultNum }, options = {}) {
      const ids = asArray(hotelIds)
        .map((value) => String(value).trim())
        .filter(Boolean);
      const batches = [];
      for (let index = 0; index < ids.length; index += PRICE_BATCH_SIZE) {
        batches.push(ids.slice(index, index + PRICE_BATCH_SIZE));
      }

      const answers = await Promise.all(
        batches.map(async (batch) => {
          const response = await http.request("/hotels/prices", {
            method: "POST",
            timeoutMs: options.timeoutMs,
            body: {
              hotel_ids: batch.join(","),
              checkin,
              checkout,
              adult_num: adultNum,
            },
          });
          return {
            rows: asArray(unwrapEnvelope(response, "/hotels/prices")),
            deferredHotelIds: asArray(response?.data?.deferred_hotel_ids).map(String),
          };
        })
      );

      return {
        rows: answers.flatMap((answer) => answer.rows),
        deferredHotelIds: answers.flatMap((answer) => answer.deferredHotelIds),
      };
    },

    async getHotelDetail(hotelId, profiles = "CITY,BRAND,GROUP,INTEREST,PROMOTION") {
      return unwrapEnvelope(
        await http.request("/hotels/detail", {
          method: "POST",
          body: {
            hotel_id: String(hotelId),
            profiles,
          },
        }),
        "/hotels/detail"
      );
    },

    async getHotelRooms({
      hotelId,
      checkin,
      checkout,
      adultNum,
      childNum = 0,
      roomNum = 1,
    }, options = {}) {
      const response = await http.request("/hotels/rooms", {
        method: "POST",
        headers: buildRequestPrincipalHeaders(config, options.requestPrincipal),
        body: {
          hotel_id: String(hotelId),
          checkin,
          checkout,
          adult_num: adultNum,
          child_num: childNum,
          room_num: roomNum,
        },
      });
      const payload = unwrapEnvelope(response, "/hotels/rooms");

      if (payload?.availability === "unknown") {
        throw createHeldBackError(payload, "/hotels/rooms", response);
      }

      return asArray(payload);
    },

    async getHotelGodProfile(hotelId) {
      return unwrapEnvelope(
        await http.request("/hotels/god-profile", {
          method: "POST",
          body: {
            hotel_id: String(hotelId),
          },
        }),
        "/hotels/god-profile"
      );
    },

    async getHotelMedia(hotelId) {
      return unwrapEnvelope(
        await http.request("/getHotelMedia", {
          method: "POST",
          body: {
            hotel_id: String(hotelId),
          },
        }),
        "/getHotelMedia"
      );
    },

    async getNearbyHotels({ hotelId, lang = "en", limit = 6, radiusKm = 5 }) {
      return unwrapEnvelope(
        await http.request(
          `/hotels/nearby${buildQuery({
            hotel_id: hotelId,
            lang,
            limit,
            radius_km: radiusKm,
          })}`
        ),
        "/hotels/nearby"
      );
    },

    async getHotelCollections({ hotelId, lang = "en" }) {
      return unwrapEnvelope(
        await http.request(
          `/hotels/collections/by-hotel${buildQuery({
            hotel_id: hotelId,
            lang,
          })}`
        ),
        "/hotels/collections/by-hotel"
      );
    },

    async getSeoCollection({ city, tag, lang = "en" }) {
      return unwrapEnvelope(
        await http.request(
          `/hotels/collections${buildQuery({
            city,
            tag,
            lang,
          })}`
        ),
        "/hotels/collections"
      );
    },

    async getCollectionSitemapData({ lang = "en" } = {}) {
      return unwrapEnvelope(
        await http.request(`/hotels/sitemap-collections${buildQuery({ lang })}`),
        "/hotels/sitemap-collections"
      );
    },

    async getHotCities(limit = 10) {
      return unwrapEnvelope(
        await http.request(`/cities/hot${buildQuery({ limit })}`),
        "/cities/hot"
      );
    },

    async searchCitiesOnly(keyword) {
      return unwrapEnvelope(
        await http.request(`/cities/search${buildQuery({ keyword })}`),
        "/cities/search"
      );
    },

    async getFeaturedHotels({ domestic = 2, page = 1, limit = 9 } = {}) {
      return unwrapEnvelope(
        await http.request(
          `/featured-hotels${buildQuery({
            domestic,
            page,
            limit,
          })}`
        ),
        "/featured-hotels"
      );
    },

    async submitBooking(bookingData, options = {}) {
      return unwrapEnvelope(
        await http.request("/booking/submit", {
          method: "POST",
          headers: buildRequestPrincipalHeaders(config, options.requestPrincipal),
          body: bookingData,
        }),
        "/booking/submit"
      );
    },

    async getBookingDetails(orderId, options = {}) {
      return unwrapEnvelope(
        await http.request(`/booking/${encodeURIComponent(String(orderId))}/details`, {
          headers: buildRequestPrincipalHeaders(config, options.requestPrincipal),
        }),
        `/booking/${orderId}/details`
      );
    },

    async createStripeSession({
      orderId,
      orderType = "booking",
      paymentType = "full_payment",
      successUrl,
      cancelUrl,
    }, options = {}) {
      return unwrapEnvelope(
        await http.request("/payment/stripe/create-session", {
          method: "POST",
          headers: buildRequestPrincipalHeaders(config, options.requestPrincipal),
          body: {
            order_id: String(orderId),
            payment_method: "stripe",
            order_type: orderType,
            payment_type: paymentType,
            success_url: successUrl,
            cancel_url: cancelUrl,
          },
        }),
        "/payment/stripe/create-session"
      );
    },
  };
}
