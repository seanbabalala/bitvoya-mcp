import { asNullableNumber, compactText, parseJsonField } from "../format.mjs";
import { buildAgenticToolResult, buildNextTool } from "../agentic-output.mjs";

function toPlaceholders(count) {
  return new Array(count).fill("?").join(", ");
}

function mapCityRow(row) {
  return {
    source_city_id: row.source_city_id,
    tripwiki_city_id: row.tripwiki_city_id,
    tripwiki_country_id: row.tripwiki_country_id,
    city_name: row.city_name,
    country_name: row.country_name,
    country_code: row.country_code,
    iata_city_code: row.iata_city_code,
    timezone: row.timezone,
    latitude: asNullableNumber(row.latitude),
    longitude: asNullableNumber(row.longitude),
    grounding_status: row.grounding_status,
    priority_score: asNullableNumber(row.priority_score),
    display_names: parseJsonField(row.display_names_json, {}),
    aliases: parseJsonField(row.aliases_json, []),
    best_for_travelers: parseJsonField(row.best_for_travelers_json, []),
    city_positioning: row.city_positioning,
    city_character: row.city_character,
    stay_area_recommendation: row.stay_area_recommendation,
    airport_access_summary: row.airport_access_summary,
    rail_access_summary: row.rail_access_summary,
    metro_access_summary: row.metro_access_summary,
    luxury_scene_summary: row.luxury_scene_summary,
    event_demand_summary: row.event_demand_summary,
    safety_summary: row.safety_summary,
    routing_notes: row.routing_notes,
    why_agents_should_care: row.why_agents_should_care,
    summary: parseJsonField(row.summary_json, {}),
    coverage: parseJsonField(row.coverage_json, {}),
    missing_dimensions: parseJsonField(row.missing_dimensions_json, []),
    last_reviewed_at: row.last_reviewed_at,
    grounding_published_at: row.grounding_published_at,
  };
}

function mapCitySearchRow(row) {
  return {
    source_city_id: row.source_city_id,
    tripwiki_city_id: row.tripwiki_city_id,
    city_name: row.city_name,
    country_name: row.country_name,
    country_code: row.country_code,
    priority_score: asNullableNumber(row.priority_score),
    grounding_status: row.grounding_status,
    aliases: parseJsonField(row.aliases_json, []),
    best_for_travelers: parseJsonField(row.best_for_travelers_json, []),
    summary: compactText(row.city_positioning || row.city_character || row.why_agents_should_care, 240),
  };
}

function mapPoiRow(row) {
  return {
    canonical_poi_id: row.canonical_poi_id,
    canonical_poi_name: row.canonical_poi_name,
    canonical_poi_type: row.canonical_poi_type,
    relation_type: row.relation_type,
    district_name: row.district_name,
    description: row.description,
    practical_note: row.practical_note,
    best_for: parseJsonField(row.best_for_json, []),
    recommended_visit_minutes: row.recommended_visit_minutes,
    priority_tier: row.priority_tier,
    rank_no: row.rank_no,
    sort_score: asNullableNumber(row.sort_score),
    source_authority: row.source_authority,
    source_url: row.source_url,
  };
}

function mapCitySnapshotRow(row) {
  return {
    source_city_id: row.source_city_id,
    tripwiki_city_id: row.tripwiki_city_id,
    city_name: row.city_name,
    country_name: row.country_name,
    country_code: row.country_code,
    timezone: row.timezone,
    priority_score: asNullableNumber(row.priority_score),
    grounding_status: row.grounding_status,
    city_positioning: compactText(row.city_positioning, 180),
    city_character: compactText(row.city_character, 180),
    stay_area_recommendation: compactText(row.stay_area_recommendation, 180),
    luxury_scene_summary: compactText(row.luxury_scene_summary, 180),
    why_agents_should_care: compactText(row.why_agents_should_care, 180),
  };
}

function summarizeTopLabels(items, field, limit = 3) {
  return (Array.isArray(items) ? items : [])
    .map((item) => item?.[field])
    .filter(Boolean)
    .slice(0, limit)
    .join(", ");
}

export async function searchCities(db, { query, limit }) {
  const needle = `%${String(query).trim().toLowerCase()}%`;
  const exact = String(query).trim().toLowerCase();

  const rows = await db.query(
    `
      SELECT
        source_city_id,
        tripwiki_city_id,
        city_name,
        country_name,
        country_code,
        priority_score,
        grounding_status,
        aliases_json,
        best_for_travelers_json,
        city_positioning,
        city_character,
        why_agents_should_care
      FROM vw_tripwiki_city_grounding_card
      WHERE
        LOWER(city_name) LIKE ?
        OR LOWER(country_name) LIKE ?
        OR LOWER(COALESCE(display_names_json, '')) LIKE ?
        OR LOWER(COALESCE(aliases_json, '')) LIKE ?
      ORDER BY
        CASE
          WHEN LOWER(city_name) = ? THEN 0
          WHEN LOWER(COALESCE(display_names_json, '')) LIKE ? THEN 1
          WHEN LOWER(COALESCE(aliases_json, '')) LIKE ? THEN 2
          ELSE 3
        END,
        COALESCE(priority_score, 0) DESC,
        city_name ASC
      LIMIT ?
    `,
    [needle, needle, needle, needle, exact, `%${exact}%`, `%${exact}%`, limit]
  );

  const results = rows.map(mapCitySearchRow);
  const topNames = summarizeTopLabels(results, "city_name");

  return buildAgenticToolResult({
    tool: "search_cities",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "destination_discovery",
    summary:
      results.length > 0
        ? `Found ${results.length} grounded city candidates for "${query}". Top matches: ${topNames}.`
        : `No grounded city cards matched "${query}".`,
    recommended_next_tools:
      results.length > 0
        ? [
            buildNextTool("get_city_grounding", "Load one city's full grounding card and POIs.", [
              "source_city_id or tripwiki_city_id or city_name",
            ]),
            buildNextTool("search_cities_live", "Resolve Bitvoya live city ids before hotel search.", [
              "keyword",
            ]),
          ]
        : [
            buildNextTool("search_cities_live", "Fallback to the live city index when grounding has no direct match.", [
              "keyword",
            ]),
          ],
    selection_hints:
      results.length > 0
        ? [
            "Use source_city_id for downstream Bitvoya inventory tools.",
            "Use tripwiki_city_id when you want stable grounding identity across systems.",
          ]
        : [],
    entity_refs: {
      city_ids: results.map((row) => row.source_city_id),
      tripwiki_city_ids: results.map((row) => row.tripwiki_city_id),
    },
    data: {
      query,
      count: results.length,
      results,
    },
  });
}

async function findCityByIdentity(db, { source_city_id, tripwiki_city_id, city_name }) {
  if (source_city_id) {
    return db.queryOne(
      "SELECT * FROM vw_tripwiki_city_grounding_card WHERE source_city_id = ? LIMIT 1",
      [String(source_city_id)]
    );
  }

  if (tripwiki_city_id) {
    return db.queryOne(
      "SELECT * FROM vw_tripwiki_city_grounding_card WHERE tripwiki_city_id = ? LIMIT 1",
      [String(tripwiki_city_id)]
    );
  }

  if (!city_name) return null;

  const exact = String(city_name).trim().toLowerCase();
  return db.queryOne(
    `
      SELECT *
      FROM vw_tripwiki_city_grounding_card
      WHERE
        LOWER(city_name) = ?
        OR LOWER(COALESCE(display_names_json, '')) LIKE ?
        OR LOWER(COALESCE(aliases_json, '')) LIKE ?
      ORDER BY
        CASE
          WHEN LOWER(city_name) = ? THEN 0
          WHEN LOWER(COALESCE(display_names_json, '')) LIKE ? THEN 1
          ELSE 2
        END,
        COALESCE(priority_score, 0) DESC
      LIMIT 1
    `,
    [exact, `%${exact}%`, `%${exact}%`, exact, `%${exact}%`]
  );
}

export async function getCityGrounding(db, identity, poiLimit) {
  const row = await findCityByIdentity(db, identity);
  if (!row) {
    return null;
  }

  const poiRows = await db.query(
    `
      SELECT *
      FROM vw_tripwiki_city_poi
      WHERE source_city_id = ?
      ORDER BY
        COALESCE(priority_tier, 999) ASC,
        COALESCE(sort_score, 0) DESC,
        COALESCE(rank_no, 999) ASC
      LIMIT ?
    `,
    [row.source_city_id, poiLimit]
  );

  const city = mapCityRow(row);
  const topPois = poiRows.map(mapPoiRow);

  return buildAgenticToolResult({
    tool: "get_city_grounding",
    status: "ok",
    intent: "destination_grounding",
    summary: `Loaded grounded destination card for ${city.city_name} with ${topPois.length} high-priority POIs and planner notes.`,
    recommended_next_tools: [
      buildNextTool("search_hotels", "Move from grounded destination context into live hotel inventory.", [
        "city_id or city_name",
      ]),
      buildNextTool("search_destination_suggestions", "Resolve mixed city/hotel phrases from user language.", [
        "query",
      ]),
    ],
    selection_hints: [
      "Use source_city_id for hotel inventory tools.",
      "Read stay_area_recommendation before narrowing to luxury neighborhoods.",
    ],
    entity_refs: {
      city_ids: [city.source_city_id],
      tripwiki_city_ids: [city.tripwiki_city_id],
    },
    data: {
      city,
      top_pois: topPois,
    },
  });
}

export async function getCityGroundingSnapshotMap(db, sourceCityIds) {
  const ids = Array.from(
    new Set(
      sourceCityIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await db.query(
    `
      SELECT
        source_city_id,
        tripwiki_city_id,
        city_name,
        country_name,
        country_code,
        timezone,
        priority_score,
        grounding_status,
        city_positioning,
        city_character,
        stay_area_recommendation,
        luxury_scene_summary,
        why_agents_should_care
      FROM vw_tripwiki_city_grounding_card
      WHERE source_city_id IN (${toPlaceholders(ids.length)})
    `,
    ids
  );

  return new Map(rows.map((row) => [String(row.source_city_id), mapCitySnapshotRow(row)]));
}
