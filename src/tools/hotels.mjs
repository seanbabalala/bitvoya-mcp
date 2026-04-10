import { asNullableNumber, compactText, parseJsonField } from "../format.mjs";

function mapHotelSearchRow(row) {
  return {
    source_hotel_id: row.source_hotel_id,
    tripwiki_hotel_id: row.tripwiki_hotel_id,
    hotel_name: row.hotel_name,
    brand_name: row.brand_name,
    city_name: row.city_name,
    country_name: row.country_name,
    star_rating: asNullableNumber(row.star_rating),
    review_score: asNullableNumber(row.review_score),
    review_count: row.review_count,
    base_nightly_price: asNullableNumber(row.base_nightly_price),
    currency: row.currency,
    grounding_status: row.grounding_status,
    why_stay_here: compactText(row.why_stay_here, 220),
    luxury_fit: compactText(row.hotel_luxury_fit_reason, 200),
  };
}

function mapHotelRow(row) {
  return {
    source_hotel_id: row.source_hotel_id,
    tripwiki_hotel_id: row.tripwiki_hotel_id,
    source_city_id: row.source_city_id,
    tripwiki_city_id: row.tripwiki_city_id,
    hotel_name: row.hotel_name,
    brand_name: row.brand_name,
    city_name: row.city_name,
    region_name: row.region_name,
    country_name: row.country_name,
    country_code: row.country_code,
    star_rating: asNullableNumber(row.star_rating),
    review_score: asNullableNumber(row.review_score),
    review_count: row.review_count,
    address: row.address,
    latitude: asNullableNumber(row.latitude),
    longitude: asNullableNumber(row.longitude),
    base_nightly_price: asNullableNumber(row.base_nightly_price),
    currency: row.currency,
    canonical_status: row.canonical_status,
    grounding_status: row.grounding_status,
    seed_status: row.seed_status,
    why_stay_here: row.why_stay_here,
    why_not_stay_here: row.why_not_stay_here,
    hotel_area_character: row.hotel_area_character,
    hotel_transport_summary: row.hotel_transport_summary,
    hotel_airport_access_summary: row.hotel_airport_access_summary,
    hotel_rail_access_summary: row.hotel_rail_access_summary,
    hotel_metro_access_summary: row.hotel_metro_access_summary,
    hotel_walkability_summary: row.hotel_walkability_summary,
    hotel_shopping_access_summary: row.hotel_shopping_access_summary,
    hotel_attraction_access_summary: row.hotel_attraction_access_summary,
    hotel_food_access_summary: row.hotel_food_access_summary,
    hotel_nightlife_access_summary: row.hotel_nightlife_access_summary,
    hotel_family_fit_reason: row.hotel_family_fit_reason,
    hotel_couple_fit_reason: row.hotel_couple_fit_reason,
    hotel_business_fit_reason: row.hotel_business_fit_reason,
    hotel_luxury_fit_reason: row.hotel_luxury_fit_reason,
    hotel_short_stay_fit_reason: row.hotel_short_stay_fit_reason,
    hotel_long_stay_fit_reason: row.hotel_long_stay_fit_reason,
    hotel_risk_notes: row.hotel_risk_notes,
    hotel_tradeoff_notes: row.hotel_tradeoff_notes,
    agent_planning_notes: row.agent_planning_notes,
    planner_summary: parseJsonField(row.planner_summary_json, {}),
    access_overview: parseJsonField(row.access_overview_json, {}),
    neighborhood_overview: parseJsonField(row.neighborhood_overview_json, {}),
    traveler_fit: parseJsonField(row.traveler_fit_json, {}),
    coverage: parseJsonField(row.coverage_json, {}),
    ranking_features: parseJsonField(row.ranking_features_json, {}),
    missing_dimensions: parseJsonField(row.missing_dimensions_json, []),
    last_reviewed_at: row.last_reviewed_at,
    grounding_published_at: row.grounding_published_at,
  };
}

function mapNearbyPoiRow(row) {
  return {
    canonical_poi_id: row.canonical_poi_id,
    canonical_poi_name: row.canonical_poi_name,
    canonical_poi_type: row.canonical_poi_type,
    relation_type: row.relation_type,
    district_name: row.district_name,
    description: row.description,
    practical_note: row.practical_note,
    distance_meters: asNullableNumber(row.distance_meters),
    estimated_travel_time_minutes: row.estimated_travel_time_minutes,
    travel_mode: row.travel_mode,
    best_for: parseJsonField(row.best_for_json, []),
    priority_tier: row.priority_tier,
    rank_no: row.rank_no,
    source_authority: row.source_authority,
    source_url: row.source_url,
  };
}

export async function searchHotels(db, { query, city_name, limit }) {
  const needle = `%${String(query).trim().toLowerCase()}%`;
  const exact = String(query).trim().toLowerCase();
  const cityNeedle = city_name ? `%${String(city_name).trim().toLowerCase()}%` : null;

  const rows = await db.query(
    `
      SELECT
        source_hotel_id,
        tripwiki_hotel_id,
        hotel_name,
        brand_name,
        city_name,
        country_name,
        star_rating,
        review_score,
        review_count,
        base_nightly_price,
        currency,
        grounding_status,
        why_stay_here,
        hotel_luxury_fit_reason
      FROM vw_tripwiki_hotel_grounding_card
      WHERE
        (
          LOWER(hotel_name) LIKE ?
          OR LOWER(COALESCE(brand_name, '')) LIKE ?
          OR LOWER(COALESCE(city_name, '')) LIKE ?
        )
        AND (? IS NULL OR LOWER(COALESCE(city_name, '')) LIKE ?)
      ORDER BY
        CASE
          WHEN LOWER(hotel_name) = ? THEN 0
          WHEN LOWER(COALESCE(brand_name, '')) = ? THEN 1
          ELSE 2
        END,
        COALESCE(star_rating, 0) DESC,
        COALESCE(review_score, 0) DESC,
        COALESCE(base_nightly_price, 0) DESC,
        hotel_name ASC
      LIMIT ?
    `,
    [needle, needle, needle, cityNeedle, cityNeedle, exact, exact, limit]
  );

  return {
    query,
    city_name: city_name || null,
    count: rows.length,
    results: rows.map(mapHotelSearchRow),
  };
}

async function findHotelByIdentity(db, { source_hotel_id, tripwiki_hotel_id, hotel_name }) {
  if (source_hotel_id) {
    return db.queryOne(
      "SELECT * FROM vw_tripwiki_hotel_grounding_card WHERE source_hotel_id = ? LIMIT 1",
      [String(source_hotel_id)]
    );
  }

  if (tripwiki_hotel_id) {
    return db.queryOne(
      "SELECT * FROM vw_tripwiki_hotel_grounding_card WHERE tripwiki_hotel_id = ? LIMIT 1",
      [String(tripwiki_hotel_id)]
    );
  }

  if (!hotel_name) return null;

  const exact = String(hotel_name).trim().toLowerCase();
  return db.queryOne(
    `
      SELECT *
      FROM vw_tripwiki_hotel_grounding_card
      WHERE
        LOWER(hotel_name) = ?
        OR LOWER(hotel_name) LIKE ?
      ORDER BY
        CASE
          WHEN LOWER(hotel_name) = ? THEN 0
          ELSE 1
        END,
        COALESCE(star_rating, 0) DESC,
        COALESCE(review_score, 0) DESC
      LIMIT 1
    `,
    [exact, `%${exact}%`, exact]
  );
}

export async function getHotelGrounding(db, identity, poiLimit) {
  const row = await findHotelByIdentity(db, identity);
  if (!row) {
    return null;
  }

  const poiRows = await db.query(
    `
      SELECT *
      FROM vw_tripwiki_hotel_nearby_poi
      WHERE source_hotel_id = ?
      ORDER BY
        COALESCE(priority_tier, 999) ASC,
        COALESCE(distance_meters, 999999) ASC,
        COALESCE(rank_no, 999) ASC
      LIMIT ?
    `,
    [row.source_hotel_id, poiLimit]
  );

  return {
    hotel: mapHotelRow(row),
    nearby_pois: poiRows.map(mapNearbyPoiRow),
  };
}
