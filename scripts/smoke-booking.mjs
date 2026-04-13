import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBitvoyaApi } from "../src/bitvoya-api.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDb } from "../src/db.mjs";
import { createRuntimeStore } from "../src/runtime-store.mjs";
import { agenticToolOutputSchema } from "../src/agentic-output.mjs";
import { getHotelRooms } from "../src/tools/hotels.mjs";
import {
  attachBookingCard,
  createBookingIntent,
  createBookingPaymentSession,
  getBookingState,
  prepareBookingQuote,
  refreshBookingState,
  submitBookingIntent,
} from "../src/tools/booking.mjs";

function createTempStoreConfig(config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitvoya-mcp-smoke-"));
  return {
    config: {
      ...config,
      store: {
        ...config.store,
        path: path.join(tempDir, "runtime-store.json"),
      },
    },
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createFakeBookingApi() {
  return {
    async submitBooking(payload) {
      return {
        order_id: "order_test_001",
        booking_id: "booking_test_001",
        status: "submitted",
        confirmation_url: "https://example.com/confirm/order_test_001",
        payload_echo: Boolean(payload?.guestInfo),
      };
    },
    async getBookingDetails(orderId) {
      return {
        order_info: {
          order_id: orderId,
          booking_id: "booking_test_001",
          booking_status: "confirmed",
        },
        payment_info: {
          payment_status: "pending",
        },
        stay_info: {
          checkin: "2026-05-01",
          checkout: "2026-05-03",
        },
      };
    },
    async createStripeSession({ paymentType }) {
      return {
        session_id: "sess_test_001",
        session_url: "https://checkout.stripe.com/pay/sess_test_001",
        payment_type: paymentType,
        currency: "CNY",
        service_fee_amount: 109.12,
      };
    },
  };
}

export async function runBookingSmoke() {
  const baseConfig = loadConfig();
  const { config, cleanup } = createTempStoreConfig(baseConfig);
  const db = createDb(config);
  const api = createBitvoyaApi(config);
  const store = createRuntimeStore(config);
  const fakeApi = createFakeBookingApi();

  try {
    const liveRooms = await getHotelRooms(api, db, {
      hotel_id: "875",
      checkin: "2026-05-01",
      checkout: "2026-05-03",
      adult_num: 2,
      child_num: 0,
      room_num: 1,
      room_limit: 2,
      rate_limit_per_room: 4,
      priority_profile: "balanced",
    });
    assert.equal(liveRooms.status, "ok");

    const recommendedRate =
      liveRooms.data?.selection_guide?.recommended_rate ||
      liveRooms.data?.selection_guide?.cheapest ||
      liveRooms.data?.rooms?.[0]?.rates?.[0] ||
      null;

    assert.ok(recommendedRate?.room_id, "Smoke booking requires a live room_id.");
    assert.ok(recommendedRate?.rate_id, "Smoke booking requires a live rate_id.");
    assert.notEqual(String(recommendedRate.room_id), "0", "Live room_id should not leak placeholder value 0.");

    const staleSelection = await prepareBookingQuote(api, db, store, config, {
      hotel_id: "875",
      room_id: "legacy_room_id",
      rate_id: "legacy_rate_id",
      checkin: "2026-05-01",
      checkout: "2026-05-03",
      adult_num: 2,
      child_num: 0,
      room_num: 1,
    });

    assert.equal(staleSelection.status, "partial");
    assert.ok(
      Array.isArray(staleSelection.data?.valid_live_selections) && staleSelection.data.valid_live_selections.length > 0,
      "Stale quote selection should return current live alternatives."
    );

    const staleIntent = await createBookingIntent(store, {
      prepared_quote_id: "quote_bWVsYm91cm5lLTQ1NjU3OC1sYW5naGFtLW1lbGJvdXJuZQ_1_2026-04-14_2026-04-17_2_0",
      payment_method: "guarantee",
      guest_primary: {
        first_name: "Smoke",
        last_name: "Guest",
      },
      contact: {
        email: "smoke@example.com",
        phone: "13800000000",
      },
    });

    const staleQuoteState = await getBookingState(store, {
      prepared_quote_id: "quote_bWVsYm91cm5lLTQ1NjU3OC1sYW5naGFtLW1lbGJvdXJuZQ_1_2026-04-14_2026-04-17_2_0",
    });

    assert.equal(staleIntent.status, "partial");
    assert.equal(staleIntent.data?.requested_quote?.quote_id_origin, "frontend_search_context_token");
    assert.equal(staleIntent.data?.requested_quote?.prepared_quote_id, "quote_bWVsYm91cm5lLTQ1NjU3OC1sYW5naGFtLW1lbGJvdXJuZQ_1_2026-04-14_2026-04-17_2_0");
    assert.equal(staleIntent.data?.recovered_search_context?.hotel_name, "Langham Melbourne");
    assert.equal(staleIntent.data?.recovered_search_context?.city_name, "Melbourne");
    assert.equal(staleQuoteState.status, "partial");
    assert.equal(staleQuoteState.data?.requested_quote?.quote_id_origin, "frontend_search_context_token");
    assert.equal(staleQuoteState.data?.recovered_search_context?.checkin, "2026-04-14");
    assert.equal(staleQuoteState.data?.recovered_search_context?.checkout, "2026-04-17");

    const quote = await prepareBookingQuote(api, db, store, config, {
      hotel_id: "875",
      room_id: String(recommendedRate.room_id),
      rate_id: String(recommendedRate.rate_id),
      checkin: "2026-05-01",
      checkout: "2026-05-03",
      adult_num: 2,
      child_num: 0,
      room_num: 1,
    });

    const storedQuote = store.getQuote(quote.data?.quote?.quote_id);
    store.createQuote({
      ...storedQuote,
      quote_id: "quote_legacy_currency_test",
      pricing: {
        ...(storedQuote?.pricing || {}),
        currency: "AUD",
        supplier_currency: null,
      },
      cancellation_policy: {
        ...(storedQuote?.cancellation_policy || {}),
        penalty_currency: "AUD",
        supplier_penalty_currency: null,
      },
    });

    const correctedLegacyCurrencyIntent = await createBookingIntent(store, {
      quote_id: "quote_legacy_currency_test",
      payment_method: "guarantee",
      guest_primary: {
        first_name: "Smoke",
        last_name: "Guest",
      },
      contact: {
        email: "smoke@example.com",
        phone: "13800000000",
      },
    });

    const intent = await createBookingIntent(store, {
      prepared_quote_id: quote.data?.prepared_quote_id,
      payment_method: "guarantee",
      guest_primary: {
        first_name: "Smoke",
        last_name: "Guest",
      },
      contact: {
        email: "smoke@example.com",
        phone: "13800000000",
      },
    });

    const cardAttached = await attachBookingCard(store, config, {
      intent_id: intent.data?.intent?.intent_id,
      pan: "4242424242424242",
      expiry: "12/29",
      cardholder_name: "Smoke Guest",
    });

    const quoteState = await getBookingState(store, {
      prepared_quote_id: quote.data?.prepared_quote_id,
    });
    const intentState = await getBookingState(store, {
      intent_id: intent.data?.intent?.intent_id,
    });
    const submitted = await submitBookingIntent(fakeApi, store, config, {
      intent_id: intent.data?.intent?.intent_id,
    });
    const paymentSession = await createBookingPaymentSession(fakeApi, store, {
      intent_id: intent.data?.intent?.intent_id,
    });
    const refreshed = await refreshBookingState(fakeApi, store, {
      intent_id: intent.data?.intent?.intent_id,
    });

    for (const payload of [
      quote,
      correctedLegacyCurrencyIntent,
      staleIntent,
      staleQuoteState,
      intent,
      cardAttached,
      quoteState,
      intentState,
      submitted,
      paymentSession,
      refreshed,
    ]) {
      agenticToolOutputSchema.parse(payload);
    }

    assert.equal(quote.status, "ok");
    assert.equal(quote.data?.prepared_quote_id, quote.data?.quote?.quote_id);
    assert.equal(intent.status, "ok");
    assert.equal(cardAttached.status, "ok");
    assert.equal(quoteState.status, "ok");
    assert.equal(intentState.status, "ok");
    assert.equal(submitted.status, "ok");
    assert.equal(paymentSession.status, "ok");
    assert.equal(refreshed.status, "ok");
    assert.equal(correctedLegacyCurrencyIntent.status, "ok");
    assert.equal(correctedLegacyCurrencyIntent.data?.intent?.quote_snapshot?.pricing?.currency, "CNY");
    assert.equal(correctedLegacyCurrencyIntent.data?.intent?.legacy_submit_preview?.currency, "CNY");
    assert.equal(quote.data?.quote?.pricing?.currency, "CNY");
    assert.equal(intent.data?.intent?.quote_snapshot?.pricing?.currency, "CNY");
    assert.equal(intent.data?.intent?.legacy_submit_preview?.currency, "CNY");
    assert.equal(intent.data?.intent?.legacy_submit_preview?.rateDetail?.currency, "CNY");
    assert.equal(intent.data?.execution_state?.status, "awaiting_card");
    assert.equal(cardAttached.data?.execution_state?.status, "ready_to_submit");
    assert.equal(submitted.data?.order_overview?.order_id, "order_test_001");
    assert.equal(paymentSession.data?.payment_overview?.payment_session?.status, "created");
    assert.equal(refreshed.data?.execution_state?.lifecycle_state?.order_state, "confirmed");

    const result = {
      stale_prepare_booking_quote: {
        summary: staleSelection.summary,
        first_live_option: staleSelection.data?.valid_live_selections?.[0] || null,
      },
      stale_create_booking_intent: {
        summary: staleIntent.summary,
        requested_quote: staleIntent.data?.requested_quote || null,
      },
      stale_get_booking_state: {
        summary: staleQuoteState.summary,
        requested_quote: staleQuoteState.data?.requested_quote || null,
      },
      corrected_legacy_currency_intent: {
        summary: correctedLegacyCurrencyIntent.summary,
        legacy_preview_currency: correctedLegacyCurrencyIntent.data?.intent?.legacy_submit_preview?.currency || null,
      },
      prepare_booking_quote: quote.summary,
      create_booking_intent: {
        summary: intent.summary,
        blockers: intent.data?.blocking_requirements,
      },
      attach_booking_card: {
        summary: cardAttached.summary,
        blockers: cardAttached.data?.blocking_requirements,
      },
      get_booking_state_quote: quoteState.summary,
      get_booking_state_intent: {
        summary: intentState.summary,
        lifecycle_state: intentState.data?.execution_state?.lifecycle_state,
      },
      submit_booking_intent: {
        summary: submitted.summary,
        order_overview: submitted.data?.order_overview,
      },
      create_booking_payment_session: {
        summary: paymentSession.summary,
        payment_session: paymentSession.data?.payment_overview?.payment_session,
      },
      refresh_booking_state: {
        summary: refreshed.summary,
        lifecycle_state: refreshed.data?.execution_state?.lifecycle_state,
      },
    };

    return result;
  } finally {
    await db.close();
    cleanup();
  }
}

async function main() {
  const result = await runBookingSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
