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
} from "../src/tools/hotels.mjs";

export async function runDiscoverySmoke() {
  const config = loadConfig();
  const db = createDb(config);
  const api = createBitvoyaApi(config);

  try {
    const hotelDetail = await getHotelDetail(api, db, { hotel_id: "875" });
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

    for (const payload of [hotelDetail, hotelRooms, comparedHotels, comparedRates]) {
      agenticToolOutputSchema.parse(payload);
    }

    assert.equal(hotelDetail.status, "ok");
    assert.equal(hotelRooms.status, "ok");
    assert.equal(comparedHotels.status, "ok");
    assert.equal(comparedRates.status, "ok");
    assert.equal(hotelDetail.data?.found, true);
    assert.equal(hotelRooms.data?.found, true);
    assert.ok((hotelRooms.data?.selection_guide?.top_recommendations || []).length > 0);
    assert.ok((comparedHotels.data?.ranked_hotels || []).length >= 2);
    assert.ok((comparedRates.data?.compared_rates || []).length > 0);

    const result = {
      hotel_detail: hotelDetail.summary,
      hotel_rooms: hotelRooms.data?.selection_guide?.recommended_rate
        ? {
            summary: hotelRooms.summary,
            recommended_rate: {
              rate_id: hotelRooms.data.selection_guide.recommended_rate.rate_id,
              rate_name: hotelRooms.data.selection_guide.recommended_rate.rate_name,
            },
          }
        : { summary: hotelRooms.summary },
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
