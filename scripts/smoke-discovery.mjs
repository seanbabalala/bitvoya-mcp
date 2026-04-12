import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createBitvoyaApi } from "../src/bitvoya-api.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDb } from "../src/db.mjs";
import { agenticToolOutputSchema } from "../src/agentic-output.mjs";
import {
  compareHotels,
  compareRates,
  getHotelDetail,
  getHotelRooms,
  searchHotels,
} from "../src/tools/hotels.mjs";

export async function runDiscoverySmoke() {
  const config = loadConfig();
  const db = createDb(config);
  const api = createBitvoyaApi(config);

  try {
    const hotelDetail = await getHotelDetail(api, db, { hotel_id: "875" });
    const hotelSearchEnglish = await searchHotels(api, db, {
      query: "Shanghai Himalayas Hotel",
      limit: 3,
    });
    const hotelSearchCluster = await searchHotels(api, db, {
      query: "Shanghai Pudong",
      limit: 3,
    });
    const hotelSearchGroundingFallback = await searchHotels(api, db, {
      query: "Waldorf Astoria on the Bund",
      limit: 3,
    });
    const hotelSearchAreaRecovery = await searchHotels(api, db, {
      query: "Lujiazui Shanghai",
      limit: 3,
    });
    const hotelRooms = await getHotelRooms(api, db, {
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
    const hotelRoomsRecovered = await getHotelRooms(api, db, {
      hotel_id: "external-langham-melbourne",
      hotel_name: "The Langham Melbourne",
      city_name: "Melbourne",
      checkin: "2026-04-14",
      checkout: "2026-04-17",
      adult_num: 2,
      child_num: 0,
      room_num: 1,
      room_limit: 2,
      rate_limit_per_room: 4,
      priority_profile: "balanced",
      prefer_benefits: true,
    });
    const comparedHotels = await compareHotels(api, db, {
      hotel_ids: ["875", "882"],
      checkin: "2026-05-01",
      checkout: "2026-05-03",
      adult_num: 2,
      child_num: 0,
      room_num: 1,
      priority_profile: "perks",
      prefer_benefits: true,
    });
    const comparedRates = await compareRates(api, db, {
      hotel_id: "875",
      checkin: "2026-05-01",
      checkout: "2026-05-03",
      adult_num: 2,
      child_num: 0,
      room_num: 1,
      room_limit: 2,
      rate_limit_per_room: 4,
      priority_profile: "perks",
      prefer_benefits: true,
    });

    for (const payload of [hotelDetail, hotelSearchEnglish, hotelSearchCluster, hotelSearchGroundingFallback, hotelSearchAreaRecovery, hotelRooms, hotelRoomsRecovered, comparedHotels, comparedRates]) {
      agenticToolOutputSchema.parse(payload);
    }

    assert.equal(hotelDetail.status, "ok");
    assert.equal(hotelSearchEnglish.status, "ok");
    assert.equal(hotelSearchCluster.status, "ok");
    assert.equal(hotelSearchGroundingFallback.status, "ok");
    assert.equal(hotelSearchAreaRecovery.status, "ok");
    assert.equal(hotelRooms.status, "ok");
    assert.equal(comparedHotels.status, "ok");
    assert.equal(comparedRates.status, "ok");
    assert.equal(hotelDetail.data?.found, true);
    assert.ok((hotelSearchEnglish.data?.results || []).length > 0);
    assert.equal(hotelSearchCluster.data?.query_resolution?.recommended_route, "ambiguous_review");
    assert.ok((hotelSearchCluster.data?.hotel_candidates || []).length >= 2);
    assert.equal(hotelSearchGroundingFallback.data?.query_resolution?.recommended_route, "grounding_review");
    assert.ok((hotelSearchGroundingFallback.data?.grounding_fallback_matches?.results || []).length > 0);
    assert.match(
      String(hotelSearchGroundingFallback.data?.query_resolution?.top_grounding_candidate?.hotel_name || ""),
      /Waldorf Astoria/i
    );
    assert.equal(hotelSearchAreaRecovery.data?.query_resolution?.recommended_route, "grounding_review");
    assert.ok((hotelSearchAreaRecovery.data?.grounding_fallback_matches?.results || []).length >= 2);
    assert.equal(
      hotelSearchAreaRecovery.data?.grounding_fallback_matches?.results?.[0]?.query_match?.match_type,
      "semantic_grounding"
    );
    assert.equal(hotelRooms.data?.found, true);
    assert.equal(hotelRoomsRecovered.data?.found, true);
    assert.equal(hotelRoomsRecovered.data?.identity_resolution?.resolution_status, "remapped");
    assert.ok(
      /Langham/i.test(String(hotelRoomsRecovered.data?.hotel?.hotel_name_en || "")) ||
        /朗廷/.test(String(hotelRoomsRecovered.data?.hotel?.hotel_name || ""))
    );
    assert.ok((hotelRooms.data?.selection_guide?.top_recommendations || []).length > 0);
    assert.ok((comparedHotels.data?.ranked_hotels || []).length >= 2);
    assert.ok((comparedRates.data?.compared_rates || []).length > 0);

    const result = {
      hotel_detail: hotelDetail.summary,
      search_hotels_english: {
        summary: hotelSearchEnglish.summary,
        recommended_route: hotelSearchEnglish.data?.query_resolution?.recommended_route,
        top_result: hotelSearchEnglish.data?.results?.[0]
          ? {
              hotel_id: hotelSearchEnglish.data.results[0].hotel_id,
              hotel_name: hotelSearchEnglish.data.results[0].hotel_name,
            }
          : null,
      },
      search_hotels_cluster: {
        summary: hotelSearchCluster.summary,
        recommended_route: hotelSearchCluster.data?.query_resolution?.recommended_route,
        cluster_signal: hotelSearchCluster.data?.query_resolution?.cluster_signal,
      },
      search_hotels_grounding_fallback: {
        summary: hotelSearchGroundingFallback.summary,
        recommended_route: hotelSearchGroundingFallback.data?.query_resolution?.recommended_route,
        top_grounding_candidate: hotelSearchGroundingFallback.data?.query_resolution?.top_grounding_candidate
          ? {
              hotel_name: hotelSearchGroundingFallback.data.query_resolution.top_grounding_candidate.hotel_name,
              source_hotel_id: hotelSearchGroundingFallback.data.query_resolution.top_grounding_candidate.source_hotel_id,
            }
          : null,
      },
      search_hotels_area_recovery: {
        summary: hotelSearchAreaRecovery.summary,
        recommended_route: hotelSearchAreaRecovery.data?.query_resolution?.recommended_route,
        top_result: hotelSearchAreaRecovery.data?.results?.[0]
          ? {
              hotel_name: hotelSearchAreaRecovery.data.results[0].hotel_name,
              match_type: hotelSearchAreaRecovery.data.results[0].query_match?.match_type,
            }
          : null,
      },
      hotel_rooms: hotelRooms.data?.selection_guide?.recommended_rate
        ? {
            summary: hotelRooms.summary,
            recommended_rate: {
              rate_id: hotelRooms.data.selection_guide.recommended_rate.rate_id,
              rate_name: hotelRooms.data.selection_guide.recommended_rate.rate_name,
            },
          }
        : { summary: hotelRooms.summary },
      hotel_rooms_recovered: hotelRoomsRecovered.data?.selection_guide?.recommended_rate
        ? {
            summary: hotelRoomsRecovered.summary,
            identity_resolution: hotelRoomsRecovered.data?.identity_resolution
              ? {
                  input_hotel_id: hotelRoomsRecovered.data.identity_resolution.input_hotel_id,
                  resolved_hotel_id: hotelRoomsRecovered.data.identity_resolution.resolved_hotel_id,
                  resolution_status: hotelRoomsRecovered.data.identity_resolution.resolution_status,
                }
              : null,
            recommended_rate: {
              rate_id: hotelRoomsRecovered.data.selection_guide.recommended_rate.rate_id,
              rate_name: hotelRoomsRecovered.data.selection_guide.recommended_rate.rate_name,
            },
          }
        : { summary: hotelRoomsRecovered.summary },
      compare_hotels: {
        summary: comparedHotels.summary,
        top_pick: comparedHotels.data?.comparison_highlights?.top_pick,
      },
      compare_rates: {
        summary: comparedRates.summary,
        top_pick: comparedRates.data?.comparison_highlights?.top_pick,
      },
    };

    return result;
  } finally {
    await db.close();
  }
}

async function main() {
  const result = await runDiscoverySmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
