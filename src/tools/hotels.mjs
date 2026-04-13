import { getCityGroundingSnapshotMap } from "./cities.mjs";
import {
  asArray,
  asBoolean,
  asNullableNumber,
  compactText,
  firstNonEmpty,
  normalizeSearchText,
  parseJsonField,
  roundNullableNumber,
  uniqueBy,
} from "../format.mjs";
import { buildAgenticToolResult, buildNextTool } from "../agentic-output.mjs";

const SEARCH_STAGE_PRICE_TIMEOUT_MS = 1600;

function toPlaceholders(count) {
  return new Array(count).fill("?").join(", ");
}

function normalizeId(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function normalizeLiveInventoryId(value) {
  const normalized = normalizeId(value);
  if (normalized === null) {
    return null;
  }

  return normalized === "0" ? null : normalized;
}

function normalizeImageUrl(value) {
  if (!value) return null;

  const firstImage = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0];

  if (!firstImage) return null;
  if (firstImage.startsWith("http")) return firstImage;

  return `https://app.bitvoya.com${firstImage.startsWith("/") ? "" : "/"}${firstImage}`;
}

function normalizeTagTranslationValue(value, maxLength = null) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  return Number.isInteger(maxLength) ? compactText(normalized, maxLength) : normalized;
}

function normalizeTagTranslationMap(value, maxLength = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, normalizeTagTranslationValue(entryValue, maxLength)])
    .filter(([, entryValue]) => Boolean(entryValue));

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeTagI18n(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized = {
    tag: normalizeTagTranslationMap(value.tag),
    name: normalizeTagTranslationMap(value.name),
    text: normalizeTagTranslationMap(value.text, 220),
  };

  return normalized.tag || normalized.name || normalized.text
    ? {
        ...(normalized.tag ? { tag: normalized.tag } : {}),
        ...(normalized.name ? { name: normalized.name } : {}),
        ...(normalized.text ? { text: normalized.text } : {}),
      }
    : null;
}

function mapTag(item) {
  const i18n = normalizeTagI18n(item?.i18n);

  return {
    id: normalizeId(item?.id),
    tag: item?.tag || null,
    name: item?.name || null,
    text: compactText(item?.text, 220),
    ...(i18n ? { i18n } : {}),
  };
}

function buildGroundingSearchBestFor(row) {
  const bestFor = [];

  if (row?.hotel_luxury_fit_reason) bestFor.push("luxury fit");
  if (row?.hotel_family_fit_reason) bestFor.push("family trips");
  if (row?.hotel_couple_fit_reason) bestFor.push("couple stays");
  if (row?.hotel_business_fit_reason) bestFor.push("business trips");
  if (row?.hotel_short_stay_fit_reason) bestFor.push("short stays");
  if (row?.hotel_long_stay_fit_reason) bestFor.push("long stays");

  return bestFor.slice(0, 4);
}

function buildGroundingSearchDecisionBrief(row, queryMatch = null) {
  const qualityNarrative =
    Number.isFinite(asNullableNumber(row?.review_score)) || Number.isFinite(asNullableNumber(row?.star_rating))
      ? `Grounding quality signals show ${asNullableNumber(row?.star_rating) ?? "N/A"} stars and review score ${asNullableNumber(row?.review_score) ?? "N/A"}.`
      : null;
  const pricingNarrative = Number.isFinite(asNullableNumber(row?.base_nightly_price))
    ? `Grounding snapshot base nightly price starts from ${asNullableNumber(row.base_nightly_price)} ${row?.currency || ""}.`.trim()
    : null;

  return {
    choose_reasons: uniqueTexts(
      [
        queryMatch?.note,
        row?.hotel_luxury_fit_reason,
        row?.why_stay_here,
        row?.hotel_transport_summary,
        qualityNarrative,
        pricingNarrative,
      ],
      4
    ),
    tradeoffs: uniqueTexts([row?.why_not_stay_here, row?.hotel_tradeoff_notes], 3),
    best_for: buildGroundingSearchBestFor(row),
    score: queryMatch?.relevance_score ?? null,
  };
}

function mapHotelGroundingSearchRow(row, query = null) {
  const querySignal =
    row?.__grounding_query_match || row?.__grounding_semantic_context
      ? {
          query_match: row?.__grounding_query_match || null,
          semantic_context: row?.__grounding_semantic_context || null,
        }
      : query
        ? buildGroundedHotelQuerySignal(row, query)
        : { query_match: null, semantic_context: null };
  const queryMatch = querySignal.query_match || null;

  return {
    source_hotel_id: normalizeId(row.source_hotel_id),
    source_city_id: normalizeId(row.source_city_id),
    tripwiki_hotel_id: normalizeId(row.tripwiki_hotel_id),
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
    query_match: queryMatch,
    semantic_context: querySignal.semantic_context || null,
    match_origin: "grounding_snapshot",
    identity_signals: {
      display_name: row.hotel_name || null,
      alternate_names: uniqueTexts(
        [
          row.hotel_name,
          row.brand_name,
          [row.hotel_name, row.city_name].filter(Boolean).join(" "),
          [row.brand_name, row.city_name].filter(Boolean).join(" "),
        ],
        4
      ),
    },
    quality_signals: {
      star_rating: asNullableNumber(row.star_rating),
      review_score: asNullableNumber(row.review_score),
      review_count: asNullableNumber(row.review_count),
    },
    pricing_snapshot: Number.isFinite(asNullableNumber(row.base_nightly_price))
      ? {
          base_nightly_price: asNullableNumber(row.base_nightly_price),
          currency: row.currency || null,
          note: "Grounding snapshot only. Validate live room totals and service fees before booking.",
        }
      : null,
    grounding_excerpt: {
      source_hotel_id: normalizeId(row.source_hotel_id),
      tripwiki_hotel_id: normalizeId(row.tripwiki_hotel_id),
      grounding_status: row.grounding_status || null,
      why_stay_here: compactText(row.why_stay_here, 220),
      why_not_stay_here: compactText(row.why_not_stay_here, 180),
      luxury_fit: compactText(row.hotel_luxury_fit_reason, 180),
      area_character: compactText(row.hotel_area_character, 180),
      transport_summary: compactText(row.hotel_transport_summary, 180),
      planner_notes: compactText(row.agent_planning_notes, 180),
      tradeoff_notes: uniqueTexts([row.hotel_tradeoff_notes], 2),
    },
    decision_brief: buildGroundingSearchDecisionBrief(row, queryMatch),
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

function mapHotelSnapshotRow(row) {
  return {
    source_hotel_id: row.source_hotel_id,
    tripwiki_hotel_id: row.tripwiki_hotel_id,
    source_city_id: row.source_city_id,
    hotel_name: row.hotel_name,
    brand_name: row.brand_name,
    city_name: row.city_name,
    country_name: row.country_name,
    country_code: row.country_code,
    star_rating: asNullableNumber(row.star_rating),
    review_score: asNullableNumber(row.review_score),
    review_count: row.review_count,
    address: row.address,
    base_nightly_price: asNullableNumber(row.base_nightly_price),
    currency: row.currency,
    grounding_status: row.grounding_status,
    why_stay_here: compactText(row.why_stay_here, 220),
    why_not_stay_here: compactText(row.why_not_stay_here, 180),
    hotel_luxury_fit_reason: compactText(row.hotel_luxury_fit_reason, 180),
    hotel_family_fit_reason: compactText(row.hotel_family_fit_reason, 160),
    hotel_couple_fit_reason: compactText(row.hotel_couple_fit_reason, 160),
    hotel_business_fit_reason: compactText(row.hotel_business_fit_reason, 160),
    hotel_short_stay_fit_reason: compactText(row.hotel_short_stay_fit_reason, 160),
    hotel_long_stay_fit_reason: compactText(row.hotel_long_stay_fit_reason, 160),
    hotel_area_character: compactText(row.hotel_area_character, 180),
    hotel_transport_summary: compactText(row.hotel_transport_summary, 180),
    hotel_airport_access_summary: compactText(row.hotel_airport_access_summary, 160),
    hotel_rail_access_summary: compactText(row.hotel_rail_access_summary, 160),
    hotel_metro_access_summary: compactText(row.hotel_metro_access_summary, 160),
    hotel_walkability_summary: compactText(row.hotel_walkability_summary, 160),
    hotel_shopping_access_summary: compactText(row.hotel_shopping_access_summary, 160),
    hotel_attraction_access_summary: compactText(row.hotel_attraction_access_summary, 160),
    hotel_food_access_summary: compactText(row.hotel_food_access_summary, 160),
    hotel_nightlife_access_summary: compactText(row.hotel_nightlife_access_summary, 160),
    hotel_risk_notes: compactText(row.hotel_risk_notes, 180),
    hotel_tradeoff_notes: compactText(row.hotel_tradeoff_notes, 180),
    agent_planning_notes: compactText(row.agent_planning_notes, 180),
    planner_summary: parseJsonField(row.planner_summary_json, {}),
    access_overview: parseJsonField(row.access_overview_json, {}),
    neighborhood_overview: parseJsonField(row.neighborhood_overview_json, {}),
    traveler_fit: parseJsonField(row.traveler_fit_json, {}),
    missing_dimensions: parseJsonField(row.missing_dimensions_json, []),
  };
}

function scoreCityMatch(city, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;

  const candidates = [
    city?.name,
    city?.nameEn,
    city?.displayName,
    city?.pathName,
    city?.pathNameEn,
    city?.pathNameEnglish,
  ]
    .map((value) => normalizeSearchText(value))
    .filter(Boolean);

  let bestScore = Number.POSITIVE_INFINITY;

  for (const field of candidates) {
    if (field === normalizedQuery) {
      bestScore = Math.min(bestScore, 0);
      continue;
    }

    if (field.startsWith(normalizedQuery)) {
      bestScore = Math.min(bestScore, 1);
      continue;
    }

    if (field.includes(normalizedQuery)) {
      bestScore = Math.min(bestScore, 2);
    }
  }

  return Number.isFinite(bestScore) ? bestScore : null;
}

function cityMatchesQuery(city, query) {
  return scoreCityMatch(city, query) !== null;
}

function selectBestCityCandidate(cities, query) {
  const scored = asArray(cities)
    .map((city) => ({ city, score: scoreCityMatch(city, query) }))
    .filter((item) => item.score !== null);

  if (scored.length === 0) {
    return asArray(cities)[0] || null;
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const hotelCountA = asNullableNumber(a.city?.hotelCount) || 0;
    const hotelCountB = asNullableNumber(b.city?.hotelCount) || 0;
    if (hotelCountA !== hotelCountB) return hotelCountB - hotelCountA;
    return String(a.city?.name || "").localeCompare(String(b.city?.name || ""));
  });

  return scored[0]?.city || null;
}

const SEARCH_IDENTITY_STOPWORDS = new Set(["the", "a", "an", "on", "at", "in", "by", "of", "and", "hotel", "hotels"]);

function tokenizeSearchIdentity(value) {
  const normalized = normalizeSearchText(value)
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  return Array.from(
    new Set(
      normalized
        .split(/\s+/)
        .filter((token) => token && !SEARCH_IDENTITY_STOPWORDS.has(token))
    )
  );
}

function scoreTokenIdentityMatch(fieldValue, normalizedQuery) {
  const fieldTokens = tokenizeSearchIdentity(fieldValue);
  const queryTokens = tokenizeSearchIdentity(normalizedQuery);

  if (fieldTokens.length < 2 || queryTokens.length < 2) {
    return null;
  }

  const fieldSet = new Set(fieldTokens);
  const overlapCount = queryTokens.filter((token) => fieldSet.has(token)).length;

  if (overlapCount < 2) {
    return null;
  }

  const queryCoverage = overlapCount / queryTokens.length;
  const fieldCoverage = overlapCount / fieldTokens.length;

  if (queryCoverage === 1 && fieldCoverage === 1) {
    return 1.25;
  }

  if (queryCoverage === 1 && fieldCoverage >= 0.6) {
    return 1.5;
  }

  if (queryCoverage >= 0.75) {
    return 2.25;
  }

  if (queryCoverage >= 0.6) {
    return 2.5;
  }

  return null;
}

function scoreIdentityFields(fields, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;

  const normalizedFields = asArray(fields)
    .map((value) => normalizeSearchText(value))
    .filter(Boolean);

  let bestScore = Number.POSITIVE_INFINITY;

  for (const field of normalizedFields) {
    if (field === normalizedQuery) {
      bestScore = Math.min(bestScore, 0);
      continue;
    }

    if (field.startsWith(normalizedQuery)) {
      bestScore = Math.min(bestScore, 1);
      continue;
    }

    if (field.includes(normalizedQuery)) {
      bestScore = Math.min(bestScore, 2);
      continue;
    }

    const tokenScore = scoreTokenIdentityMatch(field, normalizedQuery);
    if (tokenScore !== null) {
      bestScore = Math.min(bestScore, tokenScore);
    }
  }

  return Number.isFinite(bestScore) ? bestScore : null;
}

function scoreHotelIdentityMatch(hotel, query) {
  return scoreIdentityFields(
    [
    hotel?.name,
    hotel?.nameEn,
    hotel?.displayName,
    hotel?.profiles?.BRAND?.name,
    hotel?.profiles?.BRAND?.nameEn,
    ],
    query
  );
}

function scoreGroundedHotelIdentityMatch(row, query) {
  return scoreIdentityFields(
    [
      row?.hotel_name,
      row?.brand_name,
      row?.city_name,
      [row?.hotel_name, row?.city_name].filter(Boolean).join(" "),
      [row?.brand_name, row?.city_name].filter(Boolean).join(" "),
    ],
    query
  );
}

function scoreGroundedHotelSemanticMatch(row, query) {
  const queryTokens = tokenizeSearchIdentity(query);
  if (queryTokens.length === 0) {
    return null;
  }

  const cityTokens = tokenizeSearchIdentity(row?.city_name);
  const citySet = new Set(cityTokens);
  const primaryTokens = queryTokens.filter((token) => !citySet.has(token));
  const tokensForCoverage = primaryTokens.length > 0 ? primaryTokens : queryTokens;

  const semanticFieldSpecs = [
    { key: "area_character", label: "area_character", value: row?.hotel_area_character, weight: 0.32 },
    { key: "transport_summary", label: "transport_summary", value: row?.hotel_transport_summary, weight: 0.22 },
    { key: "why_stay_here", label: "why_stay_here", value: row?.why_stay_here, weight: 0.28 },
    { key: "planner_notes", label: "planner_notes", value: row?.agent_planning_notes, weight: 0.18 },
  ];

  const matchedFields = [];
  const matchedTokens = new Set();
  let weightedCoverage = 0;

  for (const spec of semanticFieldSpecs) {
    const normalized = normalizeSearchText(spec.value);
    if (!normalized) continue;

    const hits = tokensForCoverage.filter((token) => normalized.includes(token));
    if (hits.length === 0) continue;

    matchedFields.push({
      field: spec.label,
      matched_tokens: hits,
    });
    for (const token of hits) {
      matchedTokens.add(token);
    }
    weightedCoverage += spec.weight * (hits.length / tokensForCoverage.length);
  }

  if (matchedTokens.size === 0) {
    return null;
  }

  const tokenCoverage = matchedTokens.size / tokensForCoverage.length;

  if (tokensForCoverage.length >= 2 && tokenCoverage < 0.5) {
    return null;
  }

  const primaryField = matchedFields
    .slice()
    .sort((a, b) => b.matched_tokens.length - a.matched_tokens.length)[0]?.field || null;
  const score =
    tokenCoverage === 1
      ? primaryField === "area_character"
        ? 2.75
        : 2.95
      : tokenCoverage >= 0.66
        ? primaryField === "area_character"
          ? 3.05
          : 3.2
        : 3.35;

  return {
    score,
    token_coverage: roundScore(tokenCoverage * 100),
    weighted_coverage: roundScore(weightedCoverage * 100),
    matched_tokens: Array.from(matchedTokens),
    matched_fields: matchedFields,
    primary_field: primaryField,
  };
}

function buildGroundedHotelQuerySignal(row, query) {
  const identityScore = scoreGroundedHotelIdentityMatch(row, query);
  if (identityScore !== null) {
    return {
      score: identityScore,
      query_match: buildSearchMatchDescriptor(identityScore, "grounding_hotel"),
      semantic_context: null,
    };
  }

  const semanticMatch = scoreGroundedHotelSemanticMatch(row, query);
  if (!semanticMatch) {
    return {
      score: null,
      query_match: null,
      semantic_context: null,
    };
  }

  return {
    score: semanticMatch.score,
    query_match: {
      match_type: "semantic_grounding",
      relevance_score: semanticMatch.token_coverage >= 100 ? 68 : semanticMatch.token_coverage >= 66 ? 60 : 54,
      note:
        semanticMatch.primary_field === "area_character"
          ? "Grounding area context matches the query even though hotel identity is not a direct name match."
          : "Grounding narrative context matches the query even though hotel identity is not a direct name match.",
    },
    semantic_context: semanticMatch,
  };
}

function filterHotelsByQuery(hotels, query) {
  const scored = [];

  for (const hotel of asArray(hotels)) {
    const score = scoreHotelIdentityMatch(hotel, query);
    if (score === null) continue;
    scored.push({ hotel, score });
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const nameA = normalizeSearchText(a.hotel?.nameEn || a.hotel?.name);
      const nameB = normalizeSearchText(b.hotel?.nameEn || b.hotel?.name);
      return nameA.localeCompare(nameB);
    })
    .map((item) => item.hotel);
}

function normalizeResolvedCityCandidate(city) {
  if (!city) return null;

  return {
    id: normalizeId(city?.id || city?.cityId),
    name: firstNonEmpty(city?.name, city?.displayName),
    nameEn: firstNonEmpty(city?.nameEn),
  };
}

function buildSearchMatchDescriptor(score, scope) {
  if (score === null || score === undefined) {
    return null;
  }

  const mapping =
    score === 0
      ? { match_type: "exact", relevance_score: 100 }
      : score === 1
        ? { match_type: "prefix", relevance_score: 88 }
        : score < 2
          ? { match_type: "token_set", relevance_score: 84 }
          : score === 2
            ? { match_type: "contains", relevance_score: 72 }
            : { match_type: "token_overlap", relevance_score: 64 };

  const noteByScope = {
    city: {
      exact: "Exact city identity match.",
      prefix: "Strong prefix match against a live city candidate.",
      contains: "Partial city-name match.",
      token_set: "Strong token-order-insensitive match against a live city candidate.",
      token_overlap: "Partial token overlap against a live city candidate.",
    },
    hotel: {
      exact: "Exact hotel or brand match.",
      prefix: "Strong prefix match against hotel or brand identity.",
      contains: "Partial hotel or brand match.",
      token_set: "Strong token-order-insensitive match against hotel or brand identity.",
      token_overlap: "Partial token overlap against hotel or brand identity.",
    },
    grounding_hotel: {
      exact: "Exact grounded hotel or brand match.",
      prefix: "Strong grounded prefix match against hotel or brand identity.",
      contains: "Partial grounded hotel or brand match.",
      token_set: "Strong token-order-insensitive grounded match against hotel or brand identity.",
      token_overlap: "Partial grounded token overlap against hotel or brand identity.",
    },
    explicit_city: {
      exact: "Explicit city input provided by the caller.",
      prefix: "Explicit city input provided by the caller.",
      contains: "Explicit city input provided by the caller.",
      token_set: "Explicit city input provided by the caller.",
      token_overlap: "Explicit city input provided by the caller.",
    },
  };

  return {
    ...mapping,
    note: noteByScope[scope]?.[mapping.match_type] || "Search match detected.",
  };
}

function sortMatchRows(rows, tiebreaker) {
  return [...asArray(rows)].sort((a, b) => {
    const scoreA = a?.match?.relevance_score ?? 0;
    const scoreB = b?.match?.relevance_score ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return tiebreaker(a, b);
  });
}

async function buildCityCandidateRows(db, rawCities, query, limit = 5) {
  const uniqueCities = uniqueBy(
    asArray(rawCities)
      .map((city) => ({
        ...city,
        cityId: normalizeId(city?.cityId || city?.id),
      }))
      .filter((city) => city.cityId),
    (city) => city.cityId
  );
  const groundingMap = await getCityGroundingSnapshotMap(
    db,
    uniqueCities.map((city) => city.cityId)
  );

  const rows = uniqueCities.map((city) => {
    const grounding = groundingMap.get(city.cityId) || null;
    return {
      city_id: city.cityId,
      city_name: firstNonEmpty(city?.name, city?.displayName, grounding?.city_name),
      city_name_en: firstNonEmpty(city?.nameEn),
      code: firstNonEmpty(city?.code),
      hotel_count: asNullableNumber(city?.hotelCount),
      display_name: firstNonEmpty(city?.displayName, city?.nameEn, city?.name),
      match: buildSearchMatchDescriptor(scoreCityMatch(city, query), "city"),
      grounding_excerpt: buildCityGroundingExcerpt(grounding),
    };
  });

  return sortMatchRows(
    rows,
    (a, b) =>
      (b?.hotel_count ?? 0) - (a?.hotel_count ?? 0) ||
      String(a?.city_name || "").localeCompare(String(b?.city_name || ""))
  ).slice(0, limit);
}

function mergeCityCandidateSeeds(...sources) {
  return uniqueBy(
    sources.flatMap((source) =>
      asArray(source)
        .map((city) => ({
          ...city,
          cityId: normalizeId(firstNonEmpty(city?.cityId, city?.id)),
          id: normalizeId(firstNonEmpty(city?.id, city?.cityId)),
        }))
        .filter((city) => city.cityId || city.id)
    ),
    (city) => normalizeId(firstNonEmpty(city?.cityId, city?.id))
  );
}

function buildExplicitCityCandidateRow(resolvedCity, grounding = null) {
  return {
    city_id: normalizeId(resolvedCity?.id),
    city_name: firstNonEmpty(resolvedCity?.name, grounding?.city_name),
    city_name_en: firstNonEmpty(resolvedCity?.nameEn),
    code: null,
    hotel_count: null,
    display_name: firstNonEmpty(resolvedCity?.nameEn, resolvedCity?.name),
    match: buildSearchMatchDescriptor(0, "explicit_city"),
    grounding_excerpt: buildCityGroundingExcerpt(grounding),
  };
}

function buildHotelCandidateSeedRows(rawHotels, query, limit = 5) {
  const rows = uniqueBy(asArray(rawHotels), (hotel) => normalizeId(hotel?.id))
    .map((hotel) => ({
      hotel,
      hotel_id: normalizeId(hotel?.id),
      hotel_name: firstNonEmpty(hotel?.name),
      hotel_name_en: firstNonEmpty(hotel?.nameEn),
      match: buildSearchMatchDescriptor(scoreHotelIdentityMatch(hotel, query), "hotel"),
      match_origin: "live_suggest",
      sales: asNullableNumber(hotel?.sales),
    }))
    .filter((row) => row.hotel_id && row.match);

  return sortMatchRows(
    rows,
    (a, b) =>
      (b?.sales ?? 0) - (a?.sales ?? 0) ||
      String(a?.hotel_name_en || a?.hotel_name || "").localeCompare(String(b?.hotel_name_en || b?.hotel_name || ""))
  ).slice(0, limit);
}

function resolveSearchRoute({ source, cityCandidates = [], hotelCandidates = [] }) {
  if (source === "city_id") {
    return {
      detected_intent: "destination",
      recommended_route: "city_inventory",
      confidence: "high",
      reason: "Explicit city input was provided, so destination inventory is the primary route.",
    };
  }

  if (source === "city_name") {
    const topHotel = hotelCandidates[0] || null;
    const hotelScore = topHotel?.match?.relevance_score ?? 0;

    if (topHotel && hotelScore >= 88) {
      return {
        detected_intent: "hotel",
        recommended_route: "direct_hotel",
        confidence: hotelScore >= 96 ? "high" : "medium",
        reason: `Explicit city input narrowed the search area, but hotel-identity signals point most clearly to "${topHotel.hotel_name}".`,
      };
    }

    return {
      detected_intent: "destination",
      recommended_route: "city_inventory",
      confidence: "high",
      reason: "Explicit city input was provided, so destination inventory is the primary route.",
    };
  }

  const topCity = cityCandidates[0] || null;
  const topHotel = hotelCandidates[0] || null;
  const cityScore = topCity?.match?.relevance_score ?? 0;
  const hotelScore = topHotel?.match?.relevance_score ?? 0;

  if (topCity && topHotel) {
    if (cityScore >= 88 && hotelScore >= 88 && Math.abs(cityScore - hotelScore) <= 12) {
      return {
        detected_intent: "ambiguous",
        recommended_route: "ambiguous_review",
        confidence: "medium",
        reason: "The query strongly matched both a destination and specific hotel identities.",
      };
    }

    if (cityScore > hotelScore) {
      return {
        detected_intent: "destination",
        recommended_route: "city_inventory",
        confidence: cityScore >= 88 ? "high" : "medium",
        reason: `Destination signals are stronger than hotel-identity signals for "${topCity.city_name}".`,
      };
    }

    return {
      detected_intent: "hotel",
      recommended_route: "direct_hotel",
      confidence: hotelScore >= 88 ? "high" : "medium",
      reason: `Hotel-identity signals are stronger than destination signals for "${topHotel.hotel_name}".`,
    };
  }

  if (topCity) {
    return {
      detected_intent: "destination",
      recommended_route: "city_inventory",
      confidence: cityScore >= 88 ? "high" : "medium",
      reason: `The query resolved most clearly to destination "${topCity.city_name}".`,
    };
  }

  if (topHotel) {
    return {
      detected_intent: "hotel",
      recommended_route: "direct_hotel",
      confidence: hotelScore >= 88 ? "high" : "medium",
      reason: `The query resolved most clearly to hotel "${topHotel.hotel_name}".`,
    };
  }

  return {
    detected_intent: "unknown",
    recommended_route: "no_match",
    confidence: "low",
    reason: "No strong live city or hotel candidate was resolved from the query.",
  };
}

function shouldExpandCityInventory({ source, routeDecision, topCityCandidate }) {
  if (source === "city_id" || source === "city_name") {
    return Boolean(topCityCandidate);
  }

  if (!topCityCandidate) {
    return false;
  }

  if (routeDecision?.recommended_route === "city_inventory" || routeDecision?.recommended_route === "ambiguous_review") {
    return true;
  }

  return (topCityCandidate?.match?.relevance_score ?? 0) >= 88;
}

function shouldExpandDirectHotels({ source, routeDecision, topHotelCandidate }) {
  if (source !== "query") {
    return false;
  }

  if (!topHotelCandidate) {
    return false;
  }

  if (routeDecision?.recommended_route === "direct_hotel" || routeDecision?.recommended_route === "ambiguous_review") {
    return true;
  }

  return (topHotelCandidate?.match?.relevance_score ?? 0) >= 88;
}

function buildGroundingExcerpt(grounding) {
  if (!grounding) return null;

  return {
    source_hotel_id: grounding.source_hotel_id,
    tripwiki_hotel_id: grounding.tripwiki_hotel_id,
    grounding_status: grounding.grounding_status,
    why_stay_here: grounding.why_stay_here,
    why_not_stay_here: grounding.why_not_stay_here,
    luxury_fit: grounding.hotel_luxury_fit_reason,
    area_character: grounding.hotel_area_character,
    transport_summary: grounding.hotel_transport_summary,
    traveler_fit_highlights: buildTravelerFitHighlights(grounding),
    access_highlights: buildAccessHighlights(grounding),
    planner_highlights: buildPlannerHighlights(grounding),
    risk_notes: uniqueTexts([grounding.hotel_risk_notes], 2),
    tradeoff_notes: uniqueTexts([grounding.hotel_tradeoff_notes], 2),
    missing_dimensions: collectStructuredHighlights(grounding.missing_dimensions, 3, 120),
  };
}

function buildCityGroundingExcerpt(cityGrounding) {
  if (!cityGrounding) return null;

  return {
    source_city_id: cityGrounding.source_city_id,
    tripwiki_city_id: cityGrounding.tripwiki_city_id,
    grounding_status: cityGrounding.grounding_status,
    city_positioning: cityGrounding.city_positioning,
    city_character: cityGrounding.city_character,
    luxury_scene_summary: cityGrounding.luxury_scene_summary,
    stay_area_recommendation: cityGrounding.stay_area_recommendation,
    why_agents_should_care: cityGrounding.why_agents_should_care,
  };
}

function collectStructuredHighlights(value, limit = 4, textLimit = 160, depth = 0, bucket = [], seen = new Set()) {
  if (bucket.length >= limit || value === null || value === undefined || depth > 2) {
    return bucket;
  }

  if (typeof value === "string") {
    const normalized = compactText(value, textLimit);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      bucket.push(normalized);
    }
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredHighlights(item, limit, textLimit, depth + 1, bucket, seen);
      if (bucket.length >= limit) break;
    }
    return bucket;
  }

  if (typeof value !== "object") {
    return bucket;
  }

  const preferredKeys = [
    "summary",
    "overview",
    "recommendation",
    "reason",
    "note",
    "description",
    "text",
    "title",
    "label",
    "headline",
    "insight",
    "best_for",
  ];

  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectStructuredHighlights(value[key], limit, textLimit, depth + 1, bucket, seen);
      if (bucket.length >= limit) return bucket;
    }
  }

  for (const nested of Object.values(value)) {
    collectStructuredHighlights(nested, limit, textLimit, depth + 1, bucket, seen);
    if (bucket.length >= limit) break;
  }

  return bucket;
}

function buildTravelerFitHighlights(grounding) {
  return uniqueTexts(
    [
      grounding?.hotel_luxury_fit_reason,
      grounding?.hotel_family_fit_reason,
      grounding?.hotel_couple_fit_reason,
      grounding?.hotel_business_fit_reason,
      grounding?.hotel_short_stay_fit_reason,
      grounding?.hotel_long_stay_fit_reason,
      ...collectStructuredHighlights(grounding?.traveler_fit, 2, 140),
    ],
    4
  );
}

function buildAccessHighlights(grounding) {
  return uniqueTexts(
    [
      grounding?.hotel_transport_summary,
      grounding?.hotel_airport_access_summary,
      grounding?.hotel_rail_access_summary,
      grounding?.hotel_metro_access_summary,
      grounding?.hotel_walkability_summary,
      grounding?.hotel_shopping_access_summary,
      grounding?.hotel_attraction_access_summary,
      grounding?.hotel_food_access_summary,
      grounding?.hotel_nightlife_access_summary,
      ...collectStructuredHighlights(grounding?.access_overview, 2, 140),
    ],
    4
  );
}

function buildPlannerHighlights(grounding) {
  return uniqueTexts(
    [
      grounding?.why_stay_here,
      grounding?.agent_planning_notes,
      ...collectStructuredHighlights(grounding?.planner_summary, 2, 150),
      ...collectStructuredHighlights(grounding?.neighborhood_overview, 2, 150),
    ],
    4
  );
}

function buildHotelStaticStory(hotel, grounding, cityGrounding) {
  return {
    positioning: compactText(
      firstNonEmpty(grounding?.why_stay_here, hotel?.shortPoint, hotel?.buildInfo, cityGrounding?.luxury_scene_summary),
      220
    ),
    why_not_stay_here: compactText(grounding?.why_not_stay_here, 180),
    traveler_fit_highlights: buildTravelerFitHighlights(grounding),
    access_highlights: buildAccessHighlights(grounding),
    planner_highlights: buildPlannerHighlights(grounding),
    risk_notes: uniqueTexts([grounding?.hotel_risk_notes], 2),
    tradeoff_notes: uniqueTexts([grounding?.hotel_tradeoff_notes], 2),
    agent_notes: uniqueTexts([grounding?.agent_planning_notes], 2),
    city_context: uniqueTexts(
      [
        cityGrounding?.city_positioning,
        cityGrounding?.city_character,
        cityGrounding?.stay_area_recommendation,
        cityGrounding?.why_agents_should_care,
      ],
      3
    ),
    missing_dimensions: collectStructuredHighlights(grounding?.missing_dimensions, 3, 120),
  };
}

function stripHotelNameSuffix(value, hotelName) {
  const normalizedValue = String(value || "").trim();
  const normalizedHotelName = String(hotelName || "").trim();

  if (!normalizedValue || !normalizedHotelName) {
    return normalizedValue || null;
  }

  for (const separator of [" - ", " – ", " — ", "-", "–", "—", "－"]) {
    const suffix = `${separator}${normalizedHotelName}`;
    if (normalizedValue.endsWith(suffix)) {
      return normalizedValue.slice(0, -suffix.length).trim();
    }
  }

  return normalizedValue;
}

function isSpecificBenefitLabel(value) {
  return /(\d|住|美元|折|早餐|升级|接送|餐饮|spa|credit|礼遇|礼宾|付)/i.test(String(value || ""));
}

function buildBenefitDisplayLabel(item, hotelName = null) {
  const rawName = compactText(stripHotelNameSuffix(item?.name, hotelName), 60);
  const rawTag = compactText(item?.tag, 36);

  if (rawName && isSpecificBenefitLabel(rawName)) {
    return rawName;
  }

  if (rawTag && !["其他", "权益", "福利", "礼遇"].includes(rawTag)) {
    return rawTag;
  }

  return rawName || rawTag || null;
}

function buildHotelBenefitBrief(hotel) {
  const topInterests = asArray(hotel?.membership_benefits?.top_interests);
  const topPromotions = asArray(hotel?.membership_benefits?.top_promotions);
  const topSignals = uniqueTexts(
    [
      ...topInterests.map((item) => buildBenefitDisplayLabel(item, hotel?.hotel_name)),
      ...topPromotions.map((item) => buildBenefitDisplayLabel(item, hotel?.hotel_name)),
    ],
    4
  );
  const totalSignalCount =
    (hotel?.membership_benefits?.interest_count || 0) + (hotel?.membership_benefits?.promotion_count || 0);

  return {
    has_benefits: totalSignalCount > 0,
    total_signal_count: totalSignalCount,
    interest_count: hotel?.membership_benefits?.interest_count || 0,
    promotion_count: hotel?.membership_benefits?.promotion_count || 0,
    top_signals: topSignals,
    strongest_signal: topSignals[0] || null,
    headline:
      totalSignalCount > 0
        ? topSignals.length > 0
          ? `Attached member-value signals include ${topSignals.join(", ")}.`
          : `${totalSignalCount} member-value signal(s) are attached before booking.`
        : null,
  };
}

function buildHotelLocationBrief(hotel) {
  const accessHighlights = uniqueTexts(
    [
      hotel?.grounding_excerpt?.area_character,
      hotel?.grounding_excerpt?.transport_summary,
      ...(hotel?.static_story?.access_highlights || []),
      hotel?.city_grounding_excerpt?.stay_area_recommendation,
    ],
    4
  );

  return {
    headline: compactText(
      firstNonEmpty(
        hotel?.grounding_excerpt?.area_character,
        hotel?.grounding_excerpt?.transport_summary,
        hotel?.static_story?.access_highlights?.[0],
        hotel?.static_story?.positioning
      ),
      180
    ),
    area_character: hotel?.grounding_excerpt?.area_character || null,
    transport_summary: hotel?.grounding_excerpt?.transport_summary || null,
    access_highlights: accessHighlights,
    city_context: hotel?.city_grounding_excerpt?.stay_area_recommendation || null,
  };
}

function formatDistanceMeters(distanceMeters) {
  const numericDistance = asNullableNumber(distanceMeters);
  if (!Number.isFinite(numericDistance)) {
    return null;
  }

  if (numericDistance >= 1000) {
    return `${roundScore(numericDistance / 1000, 1)} km`;
  }

  return `${Math.round(numericDistance)} m`;
}

function buildPoiAccessLabel(poi) {
  const travelTime = asNullableNumber(poi?.estimated_travel_time_minutes);

  return [poi?.travel_mode || null, Number.isFinite(travelTime) ? `${Math.round(travelTime)} min` : null, formatDistanceMeters(poi?.distance_meters)]
    .filter(Boolean)
    .join(", ");
}

function humanizeIdentifier(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function buildPoiDisplayName(poi) {
  const relationLabel = humanizeIdentifier(poi?.relation_type);
  const typeLabel = humanizeIdentifier(poi?.canonical_poi_type);

  return firstNonEmpty(
    poi?.canonical_poi_name,
    [poi?.district_name, relationLabel].filter(Boolean).join(" "),
    relationLabel,
    typeLabel,
    poi?.district_name || null
  );
}

function buildNearbyPoiBrief(nearbyPois = []) {
  const topPois = asArray(nearbyPois)
    .filter(Boolean)
    .slice(0, 4)
    .map((poi) => ({
      name: buildPoiDisplayName(poi),
      canonical_name: poi?.canonical_poi_name || null,
      type: poi?.canonical_poi_type || null,
      relation_type: poi?.relation_type || null,
      district_name: poi?.district_name || null,
      access: buildPoiAccessLabel(poi),
      best_for: asArray(poi?.best_for).slice(0, 3),
      practical_note: compactText(poi?.practical_note, 120),
    }));

  return {
    count: asArray(nearbyPois).filter(Boolean).length,
    headline:
      topPois.length > 0
        ? `Nearby anchors include ${uniqueTexts(topPois.map((poi) => poi.name).filter(Boolean), 3).join(", ")}.`
        : null,
    top_pois: topPois,
  };
}

function buildBitvoyaValueBrief(hotel, nearbyPois = []) {
  const benefitBrief = hotel?.benefit_brief || buildHotelBenefitBrief(hotel);
  const locationBrief = hotel?.location_brief || buildHotelLocationBrief(hotel);
  const poiBrief = hotel?.nearby_pois_brief || buildNearbyPoiBrief(nearbyPois);
  const valueSignals = [];

  if (benefitBrief?.has_benefits) {
    valueSignals.push("attached member benefits");
  }
  if (locationBrief?.headline) {
    valueSignals.push("grounded area/access context");
  }
  if ((poiBrief?.count || 0) > 0) {
    valueSignals.push("nearby POI anchors");
  }

  return {
    summary:
      valueSignals.length > 0
        ? `Bitvoya can explain this stay through ${valueSignals.join(", ")}, not price alone.`
        : "Bitvoya adds hotel-fit context beyond raw room pricing.",
    primary_angle: firstNonEmpty(
      benefitBrief?.headline,
      hotel?.static_story?.positioning,
      locationBrief?.headline,
      poiBrief?.headline,
      hotel?.grounding_excerpt?.luxury_fit
    ),
    selling_points: uniqueTexts(
      [
        benefitBrief?.headline,
        hotel?.static_story?.positioning,
        hotel?.grounding_excerpt?.luxury_fit,
        locationBrief?.headline,
        poiBrief?.headline,
      ],
      4
    ),
  };
}

function buildSearchPrice(priceInfo, stayContext) {
  if (!priceInfo) return null;

  const supplierMinPrice = asNullableNumber(firstNonEmpty(priceInfo.minPrice, priceInfo.initMinPrice));
  if (supplierMinPrice === null) return null;

  return {
    supplier_min_price_cny: supplierMinPrice,
    currency: priceInfo.initPriceUnit || "CNY",
    semantics: "search_stage_supplier_min_price",
    note: "Search-stage supplier quote only. Use get_hotel_rooms for service-fee-adjusted display totals.",
    stay: stayContext,
  };
}

function normalizeHotelSummary(
  hotel,
  { searchPriceInfo = null, grounding = null, cityGrounding = null, matchSource = null } = {}
) {
  const cityProfile = hotel?.profiles?.CITY || {};
  const brandProfile = hotel?.profiles?.BRAND || {};
  const groupProfile = hotel?.profiles?.GROUP || {};
  const interests = asArray(hotel?.profiles?.INTEREST).map(mapTag);
  const promotions = asArray(hotel?.profiles?.PROMOTION).map(mapTag);

  const normalized = {
    hotel_id: normalizeId(hotel?.id),
    hotel_name: firstNonEmpty(hotel?.name, grounding?.hotel_name),
    hotel_name_en: firstNonEmpty(hotel?.nameEn),
    match_source: matchSource,
    quality_signals: {
      star_rating: asNullableNumber(
        firstNonEmpty(hotel?.starRate, hotel?.star_rating, hotel?.star, grounding?.star_rating)
      ),
      review_score: asNullableNumber(
        firstNonEmpty(hotel?.reviewScore, hotel?.commentScore, hotel?.score, grounding?.review_score)
      ),
      review_count: asNullableNumber(firstNonEmpty(hotel?.reviewCount, hotel?.commentCount, grounding?.review_count)),
    },
    city: {
      source_city_id: normalizeId(firstNonEmpty(cityProfile?.id, grounding?.source_city_id, cityGrounding?.source_city_id)),
      city_name: firstNonEmpty(cityProfile?.name, grounding?.city_name, cityGrounding?.city_name),
      city_name_en: firstNonEmpty(cityProfile?.nameEn),
      country_name: firstNonEmpty(grounding?.country_name, cityGrounding?.country_name),
      country_code: firstNonEmpty(grounding?.country_code, cityGrounding?.country_code),
    },
    brand: {
      name: firstNonEmpty(brandProfile?.name, grounding?.brand_name),
      name_en: firstNonEmpty(brandProfile?.nameEn),
      group_name: firstNonEmpty(groupProfile?.name),
      group_name_en: firstNonEmpty(groupProfile?.nameEn),
    },
    address: firstNonEmpty(hotel?.address, grounding?.address),
    address_en: firstNonEmpty(hotel?.addressEn),
    contact: {
      telephone: firstNonEmpty(hotel?.telephone),
      email: firstNonEmpty(hotel?.email),
    },
    geo: {
      latitude: asNullableNumber(hotel?.latitude),
      longitude: asNullableNumber(hotel?.longitude),
    },
    media: {
      hero_image_url: normalizeImageUrl(hotel?.image),
      video_url: firstNonEmpty(hotel?.video),
    },
    editorial: {
      build_info: compactText(hotel?.buildInfo, 180),
      short_point: compactText(hotel?.shortPoint, 180),
    },
    static_story: buildHotelStaticStory(hotel, grounding, cityGrounding),
    membership_benefits: {
      has_member_benefits: interests.length > 0 || promotions.length > 0,
      interest_count: interests.length,
      promotion_count: promotions.length,
      top_interests: interests.slice(0, 3),
      top_promotions: promotions.slice(0, 3),
    },
    search_price: searchPriceInfo,
    grounding_excerpt: buildGroundingExcerpt(grounding),
    city_grounding_excerpt: buildCityGroundingExcerpt(cityGrounding),
  };

  normalized.benefit_brief = buildHotelBenefitBrief(normalized);
  normalized.location_brief = buildHotelLocationBrief(normalized);
  normalized.bitvoya_value_brief = buildBitvoyaValueBrief(normalized);

  return normalized;
}

function normalizeHotelDetailPayload(hotel) {
  return {
    checkin_time: firstNonEmpty(hotel?.checkinTime),
    checkout_time: firstNonEmpty(hotel?.checkoutTime),
    build_info: compactText(hotel?.buildInfo, 240),
    short_point: compactText(hotel?.shortPoint, 240),
    designer: compactText(hotel?.designer, 200),
    description: compactText(hotel?.content, 1800),
    benefits: {
      interests: asArray(hotel?.profiles?.INTEREST).map(mapTag),
      promotions: asArray(hotel?.profiles?.PROMOTION).map(mapTag),
    },
    raw_profile_ids: {
      city_id: normalizeId(hotel?.profiles?.CITY?.id),
      brand_id: normalizeId(hotel?.profiles?.BRAND?.id),
      group_id: normalizeId(hotel?.profiles?.GROUP?.id),
    },
  };
}

function normalizeAmenityItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    code: item.code || null,
    text: item.text || null,
    value: item.value || null,
  };
}

function normalizeAmenities(rawValue) {
  return asArray(parseJsonField(rawValue, []))
    .map(normalizeAmenityItem)
    .filter(Boolean);
}

function sortRatesByDisplayTotal(a, b) {
  const valueA = a?.pricing?.display_total_cny;
  const valueB = b?.pricing?.display_total_cny;

  if (valueA === null || valueA === undefined) return 1;
  if (valueB === null || valueB === undefined) return -1;
  return valueA - valueB;
}

function normalizeRate(rate) {
  const supplierTotal = roundNullableNumber(firstNonEmpty(rate?.totalPriceCny, rate?.totalPrice));
  const taxTotal = roundNullableNumber(firstNonEmpty(rate?.taxPriceCny, rate?.taxPrice));
  const displayTotal = roundNullableNumber(firstNonEmpty(rate?.total_with_service_fee, supplierTotal));
  const explicitServiceFee = roundNullableNumber(rate?.service_fee?.amount);
  const supplierCurrency = firstNonEmpty(rate?.priceUnit, rate?.service_fee?.currency);
  const supplierPenaltyCurrency = firstNonEmpty(rate?.cancelPolicy?.unit);
  const derivedServiceFee =
    explicitServiceFee !== null
      ? explicitServiceFee
      : supplierTotal !== null && displayTotal !== null
        ? roundNullableNumber(Math.max(0, displayTotal - supplierTotal))
        : null;

  const prepaySupported = asBoolean(rate?.paymentType?.allowPayAll);
  const guaranteeSupported = asBoolean(rate?.paymentType?.allowCreditGuarantee);

  return {
    rate_id: normalizeId(rate?.id),
    supplier_rate_id: normalizeId(rate?.rateId),
    room_id: normalizeId(rate?.roomId),
    rate_name: firstNonEmpty(rate?.name),
    rate_name_en: firstNonEmpty(rate?.nameEn),
    breakfast: rate?.breakfast ?? null,
    pricing: {
      currency: "CNY",
      supplier_currency: supplierCurrency || null,
      supplier_total_cny: supplierTotal,
      supplier_tax_and_fee_cny: taxTotal,
      service_fee_cny: derivedServiceFee,
      display_total_cny: displayTotal,
      display_total_includes_service_fee:
        displayTotal !== null && supplierTotal !== null ? displayTotal > supplierTotal : derivedServiceFee > 0,
      semantics_note:
        "display_total_cny mirrors the current guest-facing checkout total when total_with_service_fee is present.",
    },
    cancellation: {
      free_cancel_until: firstNonEmpty(rate?.cancelPolicy?.cancelTime),
      penalty_cny: roundNullableNumber(rate?.cancelPolicy?.penalty),
      penalty_currency: "CNY",
      supplier_penalty_currency: supplierPenaltyCurrency || null,
      timezone: firstNonEmpty(rate?.cancelPolicy?.utc),
    },
    payment_options: {
      prepay_supported: prepaySupported,
      guarantee_supported: guaranteeSupported,
    },
    payment_scenarios: {
      prepay: {
        supported: prepaySupported,
        estimated_due_now_cny: prepaySupported ? displayTotal : null,
        note:
          prepaySupported && displayTotal !== null
            ? "Current web checkout treats the service-fee-adjusted total as the guest-facing payable amount."
            : null,
      },
      guarantee: {
        supported: guaranteeSupported,
        estimated_service_fee_due_now_cny: guaranteeSupported ? roundNullableNumber(derivedServiceFee || 0) : null,
        estimated_due_at_hotel_cny: guaranteeSupported ? supplierTotal : null,
        note: guaranteeSupported
          ? derivedServiceFee && derivedServiceFee > 0
            ? "Current web checkout uses a split flow for guarantee rates: service fee now, supplier total at the hotel."
            : "Guarantee rates may only require card guarantee when service_fee_cny is zero."
          : null,
      },
    },
    benefits: {
      interests: asArray(rate?.interests).map(mapTag),
      promotions: asArray(rate?.promotions).map(mapTag),
    },
  };
}

function normalizeRoom(room, rateLimitPerRoom) {
  const normalizedRates = asArray(room?.hotelRoomDetails)
    .map(normalizeRate)
    .sort(sortRatesByDisplayTotal);
  const normalizedRoomId =
    firstNonEmpty(
      normalizeLiveInventoryId(room?.id),
      ...normalizedRates.map((rate) => normalizeLiveInventoryId(rate?.room_id))
    ) || normalizeId(firstNonEmpty(room?.id, normalizedRates[0]?.room_id));

  return {
    room_id: normalizedRoomId,
    hotel_id: normalizeId(firstNonEmpty(room?.hotelId, room?.hotel_id)),
    room_name: firstNonEmpty(room?.name),
    room_name_en: firstNonEmpty(room?.nameEn),
    image_urls: String(room?.image || "")
      .split(",")
      .map((value) => normalizeImageUrl(value))
      .filter(Boolean),
    amenities: normalizeAmenities(room?.amenities),
    total_rate_options: normalizedRates.length,
    cheapest_display_total_cny: normalizedRates[0]?.pricing?.display_total_cny ?? null,
    rates: normalizedRates.slice(0, rateLimitPerRoom),
  };
}

function flattenRoomRates(rooms) {
  return asArray(rooms).flatMap((room) =>
    asArray(room?.rates).map((rate) => ({
      room,
      rate,
    }))
  );
}

function sortByDisplayTotal(entries) {
  return [...asArray(entries)].sort(
    (a, b) =>
      (a?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY) -
      (b?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY)
  );
}

function countRateBenefits(rate) {
  return asArray(rate?.benefits?.interests).length + asArray(rate?.benefits?.promotions).length;
}

const HOTEL_COMPARISON_PRIORITY_PROFILES = Object.freeze({
  balanced: {
    quality: 0.22,
    price: 0.18,
    perks: 0.16,
    luxury: 0.16,
    location: 0.12,
    flexibility: 0.08,
    low_due_now: 0.08,
  },
  price: {
    quality: 0.17,
    price: 0.4,
    perks: 0.08,
    luxury: 0.05,
    location: 0.05,
    flexibility: 0.1,
    low_due_now: 0.15,
  },
  perks: {
    quality: 0.17,
    price: 0.1,
    perks: 0.38,
    luxury: 0.15,
    location: 0.08,
    flexibility: 0.06,
    low_due_now: 0.06,
  },
  luxury: {
    quality: 0.24,
    price: 0.08,
    perks: 0.14,
    luxury: 0.3,
    location: 0.1,
    flexibility: 0.07,
    low_due_now: 0.07,
  },
  location: {
    quality: 0.18,
    price: 0.12,
    perks: 0.1,
    luxury: 0.12,
    location: 0.32,
    flexibility: 0.08,
    low_due_now: 0.08,
  },
  flexibility: {
    quality: 0.14,
    price: 0.14,
    perks: 0.08,
    luxury: 0.06,
    location: 0.06,
    flexibility: 0.38,
    low_due_now: 0.14,
  },
  low_due_now: {
    quality: 0.1,
    price: 0.15,
    perks: 0.08,
    luxury: 0.05,
    location: 0.05,
    flexibility: 0.15,
    low_due_now: 0.42,
  },
});

const RATE_COMPARISON_PRIORITY_PROFILES = Object.freeze({
  balanced: {
    price: 0.38,
    perks: 0.18,
    flexibility: 0.2,
    payment_fit: 0.12,
    low_due_now: 0.12,
  },
  price: {
    price: 0.58,
    perks: 0.07,
    flexibility: 0.12,
    payment_fit: 0.08,
    low_due_now: 0.15,
  },
  perks: {
    price: 0.2,
    perks: 0.48,
    flexibility: 0.12,
    payment_fit: 0.1,
    low_due_now: 0.1,
  },
  flexibility: {
    price: 0.18,
    perks: 0.08,
    flexibility: 0.5,
    payment_fit: 0.1,
    low_due_now: 0.14,
  },
  low_due_now: {
    price: 0.18,
    perks: 0.08,
    flexibility: 0.12,
    payment_fit: 0.12,
    low_due_now: 0.5,
  },
});

function roundScore(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function normalizeWeightProfile(weights) {
  const entries = Object.entries(weights || {}).filter(([, value]) => Number.isFinite(value) && value > 0);
  const sum = entries.reduce((total, [, value]) => total + value, 0);

  if (!sum) {
    return {};
  }

  return Object.fromEntries(entries.map(([key, value]) => [key, value / sum]));
}

function withWeightBoosts(baseWeights, boosts = {}) {
  const next = { ...(baseWeights || {}) };

  for (const [key, value] of Object.entries(boosts)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    next[key] = (next[key] || 0) + value;
  }

  return normalizeWeightProfile(next);
}

function buildMetricStats(values) {
  const finiteValues = asArray(values).filter((value) => Number.isFinite(value));

  if (finiteValues.length === 0) {
    return null;
  }

  return {
    min: Math.min(...finiteValues),
    max: Math.max(...finiteValues),
  };
}

function normalizeMetricValue(rawValue, stats, direction = "desc") {
  if (!Number.isFinite(rawValue)) {
    return 0;
  }

  if (!stats || !Number.isFinite(stats.min) || !Number.isFinite(stats.max)) {
    return 1;
  }

  if (stats.max === stats.min) {
    return 1;
  }

  const ratio = (rawValue - stats.min) / (stats.max - stats.min);
  const normalized = direction === "asc" ? 1 - ratio : ratio;
  return Math.max(0, Math.min(1, normalized));
}

function uniqueTexts(values, limit = 4) {
  return Array.from(
    new Set(
      asArray(values)
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function isLikelyTransientLiveError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("abort") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

function summarizeLiveError(error, fallback = "Live Bitvoya inventory request failed.") {
  return compactText(String(error?.message || error || fallback), 180) || fallback;
}

function getRateLowestDueNowCny(rate) {
  const candidates = [];

  const guaranteeDueNow = asNullableNumber(rate?.payment_scenarios?.guarantee?.estimated_service_fee_due_now_cny);
  if (rate?.payment_options?.guarantee_supported && guaranteeDueNow !== null) {
    candidates.push(guaranteeDueNow);
  }

  const prepayDueNow = asNullableNumber(rate?.payment_scenarios?.prepay?.estimated_due_now_cny);
  if (rate?.payment_options?.prepay_supported && prepayDueNow !== null) {
    candidates.push(prepayDueNow);
  }

  if (candidates.length === 0) {
    return null;
  }

  return Math.min(...candidates);
}

function summarizeLiveRateSnapshot(normalizedRooms) {
  const flattened = sortByDisplayTotal(flattenRoomRates(normalizedRooms));
  const cheapest = flattened[0] || null;
  const guide = buildRateComparisonGuide(flattened);
  const lowestDueNowValues = flattened
    .map((entry) => getRateLowestDueNowCny(entry?.rate))
    .filter((value) => Number.isFinite(value));

  return {
    cheapest_display_total_cny: cheapest?.rate?.pricing?.display_total_cny ?? null,
    cheapest_supplier_total_cny: cheapest?.rate?.pricing?.supplier_total_cny ?? null,
    cheapest_service_fee_cny: cheapest?.rate?.pricing?.service_fee_cny ?? null,
    room_id: cheapest?.room?.room_id || null,
    rate_id: cheapest?.rate?.rate_id || null,
    room_count: normalizedRooms.length,
    rate_count: flattened.length,
    best_benefits_count: countRateBenefits(guide.best_benefits?.rate),
    best_flexible_penalty_cny: guide.most_flexible?.rate?.cancellation?.penalty_cny ?? null,
    best_flexible_rate_id: guide.most_flexible?.rate?.rate_id || null,
    best_guarantee_due_now_cny:
      guide.best_guarantee?.rate?.payment_scenarios?.guarantee?.estimated_service_fee_due_now_cny ?? null,
    best_guarantee_rate_id: guide.best_guarantee?.rate?.rate_id || null,
    free_cancellation_available: flattened.some((entry) => Boolean(entry?.rate?.cancellation?.free_cancel_until)),
    guarantee_available: flattened.some((entry) => Boolean(entry?.rate?.payment_options?.guarantee_supported)),
    prepay_available: flattened.some((entry) => Boolean(entry?.rate?.payment_options?.prepay_supported)),
    lowest_due_now_cny: lowestDueNowValues.length > 0 ? Math.min(...lowestDueNowValues) : null,
  };
}

function resolveHotelComparisonPreferences(params = {}, stayContext = null) {
  const requestedProfile = String(params.priority_profile || "balanced").trim().toLowerCase();
  const priorityProfile = HOTEL_COMPARISON_PRIORITY_PROFILES[requestedProfile] ? requestedProfile : "balanced";
  const paymentPreference = ["prepay", "guarantee"].includes(params.payment_preference)
    ? params.payment_preference
    : "any";
  const requireFreeCancellation = asBoolean(params.require_free_cancellation);
  const preferBenefits = asBoolean(params.prefer_benefits);

  const weightBoosts = {};
  if (preferBenefits) weightBoosts.perks = 0.08;
  if (requireFreeCancellation) weightBoosts.flexibility = 0.12;
  if (paymentPreference === "guarantee") weightBoosts.low_due_now = 0.08;
  if (paymentPreference === "prepay") weightBoosts.price = 0.04;

  const weights = withWeightBoosts(HOTEL_COMPARISON_PRIORITY_PROFILES[priorityProfile], weightBoosts);

  return {
    priority_profile: priorityProfile,
    payment_preference: paymentPreference,
    require_free_cancellation: requireFreeCancellation,
    prefer_benefits: preferBenefits,
    live_stay_context: Boolean(stayContext),
    weights,
  };
}

function resolveRateComparisonPreferences(params = {}) {
  const requestedProfile = String(params.priority_profile || "balanced").trim().toLowerCase();
  const priorityProfile = RATE_COMPARISON_PRIORITY_PROFILES[requestedProfile] ? requestedProfile : "balanced";
  const paymentPreference = ["prepay", "guarantee"].includes(params.payment_preference)
    ? params.payment_preference
    : "any";
  const requireFreeCancellation = asBoolean(params.require_free_cancellation);
  const preferBenefits = asBoolean(params.prefer_benefits);

  const weightBoosts = {};
  if (preferBenefits) weightBoosts.perks = 0.1;
  if (requireFreeCancellation) weightBoosts.flexibility = 0.14;
  if (paymentPreference === "guarantee" || paymentPreference === "prepay") {
    weightBoosts.payment_fit = 0.12;
  }
  if (paymentPreference === "guarantee") weightBoosts.low_due_now = 0.1;
  if (paymentPreference === "prepay") weightBoosts.price = 0.06;

  const weights = withWeightBoosts(RATE_COMPARISON_PRIORITY_PROFILES[priorityProfile], weightBoosts);

  return {
    priority_profile: priorityProfile,
    payment_preference: paymentPreference,
    require_free_cancellation: requireFreeCancellation,
    prefer_benefits: preferBenefits,
    weights,
  };
}

function computeHotelMetricInputs(hotel, liveRateSummary = null) {
  const reviewScore = asNullableNumber(hotel?.quality_signals?.review_score) || 0;
  const starRating = asNullableNumber(hotel?.quality_signals?.star_rating) || 0;
  const reviewCount = asNullableNumber(hotel?.quality_signals?.review_count) || 0;
  const memberBenefitCount =
    (hotel?.membership_benefits?.interest_count || 0) + (hotel?.membership_benefits?.promotion_count || 0);
  const bestFlexiblePenalty = asNullableNumber(liveRateSummary?.best_flexible_penalty_cny);

  return {
    quality: reviewScore * 6 + starRating * 4 + Math.min(8, Math.log10(reviewCount + 1) * 3),
    price: asNullableNumber(
      firstNonEmpty(
        liveRateSummary?.cheapest_display_total_cny,
        hotel?.search_price?.supplier_min_price_cny
      )
    ),
    perks: memberBenefitCount * 1.8 + Math.min(8, (liveRateSummary?.best_benefits_count || 0) * 1.6),
    luxury:
      (hotel?.grounding_excerpt?.luxury_fit ? 12 : 0) +
      (hotel?.grounding_excerpt?.why_stay_here ? 4 : 0) +
      starRating * 4 +
      reviewScore * 2,
    location:
      (hotel?.grounding_excerpt?.transport_summary ? 10 : 0) +
      (hotel?.grounding_excerpt?.area_character ? 6 : 0) +
      (hotel?.city_grounding_excerpt?.stay_area_recommendation ? 4 : 0) +
      (hotel?.address ? 2 : 0),
    flexibility:
      (liveRateSummary?.free_cancellation_available ? 10 : 0) +
      (bestFlexiblePenalty !== null
        ? Math.max(0, 8 - bestFlexiblePenalty / 400)
        : 0),
    low_due_now: asNullableNumber(
      firstNonEmpty(
        liveRateSummary?.lowest_due_now_cny,
        liveRateSummary?.best_guarantee_due_now_cny,
        liveRateSummary?.cheapest_display_total_cny,
        hotel?.search_price?.supplier_min_price_cny
      )
    ),
  };
}

function computeRateMetricInputs(entry, preferences) {
  const benefitCount = countRateBenefits(entry?.rate);
  const cancellationPenalty = asNullableNumber(entry?.rate?.cancellation?.penalty_cny);
  const paymentFit =
    preferences?.payment_preference === "guarantee"
      ? entry?.rate?.payment_options?.guarantee_supported
        ? 1
        : 0
      : preferences?.payment_preference === "prepay"
        ? entry?.rate?.payment_options?.prepay_supported
          ? 1
          : 0
        : (entry?.rate?.payment_options?.guarantee_supported ? 1 : 0) +
          (entry?.rate?.payment_options?.prepay_supported ? 1 : 0);

  return {
    price: asNullableNumber(entry?.rate?.pricing?.display_total_cny),
    perks: benefitCount,
    flexibility:
      (entry?.rate?.cancellation?.free_cancel_until ? 10 : 0) +
      (cancellationPenalty !== null
        ? Math.max(0, 8 - cancellationPenalty / 400)
        : 0),
    payment_fit: paymentFit,
    low_due_now: getRateLowestDueNowCny(entry?.rate),
  };
}

function buildWeightedScoreBreakdown(metricInputs, weights, metricDirections, modifierSpecs = []) {
  const metricStats = Object.fromEntries(
    Object.keys(weights).map((dimension) => [
      dimension,
      buildMetricStats(metricInputs.map((item) => item?.metrics?.[dimension])),
    ])
  );

  return metricInputs.map((item) => {
    const weightedDimensions = Object.entries(weights).map(([dimension, weight]) => {
      const rawValue = item?.metrics?.[dimension] ?? null;
      const normalizedScore = normalizeMetricValue(rawValue, metricStats[dimension], metricDirections[dimension] || "desc");
      const contribution = normalizedScore * weight * 100;

      return {
        dimension,
        weight: roundScore(weight, 4),
        raw_value: roundScore(rawValue, 2),
        normalized_score: roundScore(normalizedScore * 100),
        contribution: roundScore(contribution),
      };
    });

    const weightedScore = weightedDimensions.reduce((total, dimension) => total + (dimension.contribution || 0), 0);
    const preferenceModifiers = modifierSpecs.map((spec) => spec(item)).filter(Boolean);
    const modifierTotal = preferenceModifiers.reduce((total, modifier) => total + (modifier?.contribution || 0), 0);
    const totalScore = weightedScore + modifierTotal;
    const topDimensions = [...weightedDimensions]
      .sort((a, b) => (b.contribution || 0) - (a.contribution || 0))
      .slice(0, 3)
      .map((dimension) => dimension.dimension);

    return {
      ...item,
      weighted_score: roundScore(weightedScore),
      total_score: roundScore(totalScore),
      score_breakdown: {
        total_score: roundScore(totalScore),
        weighted_score: roundScore(weightedScore),
        top_dimensions: topDimensions,
        weighted_dimensions: weightedDimensions,
        preference_modifiers: preferenceModifiers,
      },
    };
  });
}

function buildHotelPriorityReason(hotel, liveRateSummary, topDimension) {
  switch (topDimension) {
    case "price":
      if (Number.isFinite(liveRateSummary?.cheapest_display_total_cny)) {
        return `Ranks well on current display price at ${liveRateSummary.cheapest_display_total_cny} CNY.`;
      }
      if (Number.isFinite(hotel?.search_price?.supplier_min_price_cny)) {
        return `Ranks well on current search-stage supplier price at ${hotel.search_price.supplier_min_price_cny} CNY.`;
      }
      return null;
    case "perks":
      if (hotel?.benefit_brief?.headline) {
        return hotel.benefit_brief.headline;
      }
      if (hotel?.membership_benefits?.has_member_benefits) {
        return `${hotel.membership_benefits.interest_count + hotel.membership_benefits.promotion_count} member-benefit signals are attached before booking.`;
      }
      return null;
    case "luxury":
      return hotel?.grounding_excerpt?.luxury_fit || null;
    case "location":
      return firstNonEmpty(
        hotel?.location_brief?.headline,
        hotel?.grounding_excerpt?.transport_summary,
        hotel?.grounding_excerpt?.area_character,
        hotel?.city_grounding_excerpt?.stay_area_recommendation
      );
    case "flexibility":
      if (liveRateSummary?.free_cancellation_available) {
        return "At least one live rate exposes free-cancellation flexibility.";
      }
      return null;
    case "low_due_now":
      if (Number.isFinite(liveRateSummary?.lowest_due_now_cny)) {
        return `Lowest due-now amount observed across live rates is ${liveRateSummary.lowest_due_now_cny} CNY.`;
      }
      return null;
    case "quality":
      if (
        Number.isFinite(hotel?.quality_signals?.review_score) ||
        Number.isFinite(hotel?.quality_signals?.star_rating)
      ) {
        return `Quality signals show ${hotel?.quality_signals?.star_rating ?? "N/A"} stars and review score ${hotel?.quality_signals?.review_score ?? "N/A"}.`;
      }
      return null;
    default:
      return null;
  }
}

function buildRatePriorityReason(entry, topDimension, preferences = null) {
  switch (topDimension) {
    case "price":
      if (Number.isFinite(entry?.rate?.pricing?.display_total_cny)) {
        return `Ranks well on guest-facing display total at ${entry.rate.pricing.display_total_cny} CNY.`;
      }
      return null;
    case "perks": {
      const benefitCount = countRateBenefits(entry?.rate);
      if (benefitCount > 0) {
        return `${benefitCount} explicit rate-level perk signal(s) are attached.`;
      }
      return null;
    }
    case "flexibility":
      if (entry?.rate?.cancellation?.free_cancel_until) {
        return `Free cancellation is exposed until ${entry.rate.cancellation.free_cancel_until}.`;
      }
      return null;
    case "payment_fit":
      if (preferences?.payment_preference === "guarantee" && entry?.rate?.payment_options?.guarantee_supported) {
        return "Supports guarantee flow directly.";
      }
      if (preferences?.payment_preference === "prepay" && entry?.rate?.payment_options?.prepay_supported) {
        return "Supports prepay flow directly.";
      }
      if (
        entry?.rate?.payment_options?.guarantee_supported &&
        entry?.rate?.payment_options?.prepay_supported
      ) {
        return "Supports both guarantee and prepay paths.";
      }
      return null;
    case "low_due_now": {
      const dueNow = getRateLowestDueNowCny(entry?.rate);
      if (dueNow !== null) {
        return `Lowest due-now amount for this rate is ${dueNow} CNY.`;
      }
      return null;
    }
    default:
      return null;
  }
}

function buildHotelTradeoffs(hotel, liveRateSummary = null) {
  const tradeoffs = [];

  tradeoffs.push(...asArray(hotel?.static_story?.tradeoff_notes).slice(0, 2));
  tradeoffs.push(...asArray(hotel?.static_story?.risk_notes).slice(0, 1));

  if (!hotel?.membership_benefits?.has_member_benefits) {
    tradeoffs.push("No explicit member-benefit package is attached in current detail data.");
  }

  if (!hotel?.grounding_excerpt?.transport_summary) {
    tradeoffs.push("Transport grounding is thin, so access quality is less explainable.");
  }

  if (!liveRateSummary?.cheapest_display_total_cny && !hotel?.search_price?.supplier_min_price_cny) {
    tradeoffs.push("No current price signal is available for quick commercial comparison.");
  }

  return uniqueTexts(tradeoffs, 4);
}

function buildHotelStrengths(hotel, liveRateSummary = null) {
  const strengths = [];

  if (hotel?.benefit_brief?.headline) {
    strengths.push(hotel.benefit_brief.headline);
  }

  if (hotel?.static_story?.positioning) {
    strengths.push(hotel.static_story.positioning);
  }

  if (hotel?.grounding_excerpt?.luxury_fit) {
    strengths.push(hotel.grounding_excerpt.luxury_fit);
  }

  if (hotel?.membership_benefits?.interest_count > 0) {
    strengths.push(
      `${hotel.membership_benefits.interest_count} member interest benefit(s) surfaced before booking.`
    );
  }

  if (liveRateSummary?.cheapest_display_total_cny) {
    strengths.push(`Current cheapest live display total is ${liveRateSummary.cheapest_display_total_cny} CNY.`);
  } else if (hotel?.search_price?.supplier_min_price_cny) {
    strengths.push(`Search-stage supplier min price is ${hotel.search_price.supplier_min_price_cny} CNY.`);
  }

  if (hotel?.grounding_excerpt?.transport_summary) {
    strengths.push(hotel.grounding_excerpt.transport_summary);
  }

  if (hotel?.location_brief?.headline) {
    strengths.push(hotel.location_brief.headline);
  }

  if (hotel?.nearby_pois_brief?.headline) {
    strengths.push(hotel.nearby_pois_brief.headline);
  }

  strengths.push(...asArray(hotel?.static_story?.traveler_fit_highlights).slice(0, 2));
  strengths.push(...asArray(hotel?.static_story?.access_highlights).slice(0, 1));

  return uniqueTexts(strengths, 4);
}

function buildHotelDecisionBrief(hotel, liveRateSummary = null, scoreBreakdown = null) {
  const bestFor = [];
  const priorityReason = buildHotelPriorityReason(hotel, liveRateSummary, scoreBreakdown?.top_dimensions?.[0]);

  if (hotel?.grounding_excerpt?.luxury_fit) bestFor.push("luxury fit");
  if (hotel?.membership_benefits?.has_member_benefits) bestFor.push("member-perk seekers");
  if (hotel?.grounding_excerpt?.transport_summary) bestFor.push("access-sensitive trips");
  if (liveRateSummary?.cheapest_display_total_cny) bestFor.push("commercially grounded shortlists");

  return {
    choose_reasons: uniqueTexts([priorityReason, ...buildHotelStrengths(hotel, liveRateSummary)], 4),
    tradeoffs: buildHotelTradeoffs(hotel, liveRateSummary),
    best_for: bestFor.slice(0, 4),
    score: scoreBreakdown?.total_score ?? null,
    score_breakdown: scoreBreakdown,
  };
}

function describeHotelAudienceTag(tag) {
  switch (tag) {
    case "luxury fit":
      return "traveler is prioritizing luxury fit and brand-level positioning";
    case "member-perk seekers":
      return "traveler is perk-sensitive and cares about attached member value";
    case "access-sensitive trips":
      return "traveler needs a stronger transport and area logic";
    case "commercially grounded shortlists":
      return "traveler wants the recommendation tied to live commercial signals";
    default:
      return tag || null;
  }
}

function buildAgentBriefPresenterLines({
  recommendedOpening = null,
  recommendedAngle = null,
  hotelFocus = null,
  cityFocus = null,
  perkFocus = null,
  proofPoints = [],
  sellThisWhen = [],
  branches = [],
  watchouts = [],
  nextQuestion = null,
} = {}) {
  const lines = [];

  if (recommendedOpening) {
    lines.push(`Open with: ${compactText(recommendedOpening, 220)}`);
  }

  if (recommendedAngle) {
    lines.push(`Angle: ${compactText(recommendedAngle, 220)}`);
  }

  if (hotelFocus) {
    lines.push(`Hotel story: ${compactText(hotelFocus, 220)}`);
  }

  if (cityFocus) {
    lines.push(`City / area: ${compactText(cityFocus, 220)}`);
  }

  if (perkFocus) {
    lines.push(`Perks: ${compactText(perkFocus, 220)}`);
  }

  if (asArray(proofPoints).length > 0) {
    lines.push(
      `Sell with: ${asArray(proofPoints)
        .slice(0, 3)
        .map((item) => compactText(item, 140))
        .join(" | ")}`
    );
  }

  if (asArray(sellThisWhen).length > 0) {
    lines.push(`Use this when: ${asArray(sellThisWhen).slice(0, 3).map((item) => compactText(item, 120)).join(" | ")}`);
  }

  if (asArray(branches).length > 0) {
    lines.push(`Decision split: ${asArray(branches).slice(0, 3).map((item) => compactText(item, 140)).join(" | ")}`);
  }

  if (asArray(watchouts).length > 0) {
    lines.push(`Watchouts: ${asArray(watchouts).slice(0, 2).map((item) => compactText(item, 140)).join(" | ")}`);
  }

  if (nextQuestion) {
    lines.push(`Ask next: ${compactText(nextQuestion, 180)}`);
  }

  return lines;
}

function buildSearchAgentBrief({
  queryResolution = null,
  results = [],
  selectionGuide = null,
  stayContext = null,
  warnings = [],
  cityCandidates = [],
} = {}) {
  const topResult = asArray(results)[0] || null;
  const timeoutWarning = asArray(warnings).find((warning) => /timed out|timeout|abort/i.test(String(warning || ""))) || null;
  if (!topResult) {
    if (timeoutWarning) {
      const resolvedCityName = cityCandidates[0]?.city_name || cityCandidates[0]?.city_name_en || null;
      const recommendedOpening = resolvedCityName
        ? `Do not ask the traveler to restate the same request. Explain that live inventory timed out for ${resolvedCityName} and that the next step is a retry or fallback, not re-qualification.`
        : "Do not ask the traveler to restate the same request. Explain that live inventory timed out and that the next step is a retry or fallback, not re-qualification.";
      const recommendedAngle = stayContext
        ? "Keep the existing stay request intact and frame the issue as a transient live-inventory timeout."
        : "Frame the issue as a transient live-inventory timeout before asking for any new input.";
      const nextQuestion = stayContext
        ? "Ask whether to retry immediately or switch to a static/grounded shortlist while live inventory recovers."
        : "Ask whether to retry immediately or use a non-live shortlist first.";

      return {
        recommended_opening: recommendedOpening,
        recommended_angle: recommendedAngle,
        next_question: nextQuestion,
        presenter_lines: buildAgentBriefPresenterLines({
          recommendedOpening,
          recommendedAngle,
          nextQuestion,
        }),
      };
    }

    return {
      recommended_opening: "No clear hotel winner emerged yet, so pivot into clarification instead of pretending there is a recommendation.",
      recommended_angle: "Use destination, date, or traveler-priority clarification before describing any property as a winner.",
      next_question: stayContext
        ? "Ask whether the traveler wants a different hotel, a different date range, or a destination-level shortlist."
        : "Ask for dates or the traveler priority before trying to recommend one property.",
      presenter_lines: buildAgentBriefPresenterLines({
        recommendedOpening: "No clear hotel winner emerged yet, so pivot into clarification instead of pretending there is a recommendation.",
        recommendedAngle: "Use destination, date, or traveler-priority clarification before describing any property as a winner.",
        nextQuestion: stayContext
          ? "Ask whether the traveler wants a different hotel, a different date range, or a destination-level shortlist."
          : "Ask for dates or the traveler priority before trying to recommend one property.",
      }),
    };
  }

  const route = queryResolution?.recommended_route || "city_inventory";
  const strongestBenefits = selectionGuide?.strongest_benefits || null;
  const bestValue = selectionGuide?.best_value || null;
  const branches = [];

  if (strongestBenefits?.hotel_id && strongestBenefits.hotel_id !== topResult.hotel_id) {
    branches.push(`If perks matter more than the overall winner, pivot to ${strongestBenefits.hotel_name}.`);
  }

  if (bestValue?.hotel_id && bestValue.hotel_id !== topResult.hotel_id) {
    branches.push(`If price sensitivity appears, compare ${bestValue.hotel_name} before committing.`);
  }

  const recommendedOpening =
    route === "direct_hotel"
      ? `Treat this as a specific-property lookup. Lead with ${topResult.hotel_name} instead of expanding back into a city sweep.`
      : route === "ambiguous_review"
        ? `Do not dump the whole shortlist. Lead with ${topResult.hotel_name} as the current winner, then give one alternative by traveler priority.`
        : `Start with ${topResult.hotel_name} as the current lead, not a flat inventory list.`;

  const recommendedAngle = compactText(
    firstNonEmpty(
      topResult?.bitvoya_value_brief?.primary_angle,
      topResult?.decision_brief?.choose_reasons?.[0],
      topResult?.static_story?.positioning,
      topResult?.location_brief?.headline
    ),
    180
  );
  const hotelFocus = compactText(
    firstNonEmpty(
      topResult?.static_story?.positioning,
      topResult?.grounding_excerpt?.why_stay_here,
      topResult?.grounding_excerpt?.luxury_fit
    ),
    220
  );
  const cityFocus = compactText(
    firstNonEmpty(
      topResult?.location_brief?.city_context,
      topResult?.city_grounding_excerpt?.stay_area_recommendation,
      topResult?.city_grounding_excerpt?.city_character
    ),
    220
  );
  const perkFocus = compactText(
    firstNonEmpty(
      topResult?.benefit_brief?.headline,
      selectionGuide?.strongest_benefits?.headline
    ),
    220
  );
  const proofPoints = uniqueTexts(
    [
      topResult?.location_brief?.headline,
      topResult?.nearby_pois_brief?.headline,
      ...(asArray(topResult?.decision_brief?.choose_reasons).slice(0, 2)),
    ],
    3
  );
  const sellThisWhen = asArray(topResult?.decision_brief?.best_for).map(describeHotelAudienceTag).filter(Boolean);
  const watchouts = asArray(topResult?.decision_brief?.tradeoffs).slice(0, 2);
  const nextQuestion = stayContext
    ? "Ask whether the traveler wants to optimize perks, flexibility, or lowest total before opening live rooms."
    : "Ask for dates before talking about bookability or final payable totals.";

  return {
    mode: "hotel_search",
    recommended_opening: recommendedOpening,
    recommended_angle: recommendedAngle,
    hotel_focus: hotelFocus,
    city_focus: cityFocus,
    perk_focus: perkFocus,
    proof_points: proofPoints,
    sell_this_when: sellThisWhen,
    branches,
    watchouts,
    next_question: nextQuestion,
    presenter_lines: buildAgentBriefPresenterLines({
      recommendedOpening,
      recommendedAngle,
      hotelFocus,
      cityFocus,
      perkFocus,
      proofPoints,
      sellThisWhen,
      branches,
      watchouts,
      nextQuestion,
    }),
  };
}

function buildHotelDetailAgentBrief(hotel, decisionBrief = null) {
  const recommendedOpening = `Present ${hotel?.hotel_name} as ${compactText(firstNonEmpty(hotel?.static_story?.positioning, hotel?.bitvoya_value_brief?.primary_angle), 170)}.`;
  const recommendedAngle = compactText(
    uniqueTexts(
      [hotel?.benefit_brief?.headline, hotel?.location_brief?.headline, hotel?.nearby_pois_brief?.headline],
      2
    ).join(" "),
    200
  );
  const hotelFocus = compactText(
    firstNonEmpty(
      hotel?.static_story?.positioning,
      hotel?.grounding_excerpt?.why_stay_here,
      hotel?.grounding_excerpt?.luxury_fit
    ),
    220
  );
  const cityFocus = compactText(
    firstNonEmpty(
      hotel?.location_brief?.city_context,
      hotel?.city_grounding_excerpt?.stay_area_recommendation,
      hotel?.city_grounding_excerpt?.city_character
    ),
    220
  );
  const perkFocus = compactText(firstNonEmpty(hotel?.benefit_brief?.headline), 220);
  const proofPoints = uniqueTexts(
    [hotel?.location_brief?.headline, hotel?.nearby_pois_brief?.headline, hotel?.grounding_excerpt?.planner_highlights?.[0]],
    3
  );
  const sellThisWhen = asArray(decisionBrief?.best_for).map(describeHotelAudienceTag).filter(Boolean);
  const branches = uniqueTexts(
    [
      hotel?.benefit_brief?.has_benefits
        ? `If perk sensitivity is high, lead with ${asArray(hotel?.benefit_brief?.top_signals).slice(0, 3).join(", ")}.`
        : null,
      hotel?.location_brief?.transport_summary
        ? "If access matters, pivot to the grounded transport story instead of generic amenities."
        : null,
      hotel?.nearby_pois_brief?.count
        ? "If the traveler cares about what is around the hotel, use the nearby POI anchors as proof rather than vague neighborhood language."
        : null,
    ],
    3
  );
  const watchouts = asArray(decisionBrief?.tradeoffs).slice(0, 2);
  const nextQuestion = "Ask whether to open live rooms now or compare this against a different hotel style.";

  return {
    mode: "hotel_detail",
    recommended_opening: recommendedOpening,
    recommended_angle: recommendedAngle,
    hotel_focus: hotelFocus,
    city_focus: cityFocus,
    perk_focus: perkFocus,
    proof_points: proofPoints,
    sell_this_when: sellThisWhen,
    branches,
    watchouts,
    next_question: nextQuestion,
    presenter_lines: buildAgentBriefPresenterLines({
      recommendedOpening,
      recommendedAngle,
      hotelFocus,
      cityFocus,
      perkFocus,
      proofPoints,
      sellThisWhen,
      branches,
      watchouts,
      nextQuestion,
    }),
  };
}

function buildHotelRoomsAgentBrief({
  hotel,
  primaryRecommendation = null,
  selectionGuide = null,
  dateValidation = null,
  roomCount = 0,
  inventoryError = null,
  identityResolution = null,
} = {}) {
  if (roomCount > 0 && primaryRecommendation) {
    const displayTotal = firstNonEmpty(
      primaryRecommendation?.pricing?.display_total_cny,
      primaryRecommendation?.display_total_cny
    );
    const dueNow = firstNonEmpty(
      primaryRecommendation?.lowest_due_now_cny,
      getRateLowestDueNowCny({
        payment_options: primaryRecommendation?.payment_options,
        payment_scenarios: primaryRecommendation?.payment_scenarios,
      })
    );
    const branches = uniqueTexts(
      [
        selectionGuide?.cheapest?.rate_id && selectionGuide.cheapest.rate_id !== primaryRecommendation.rate_id
          ? `If pure lowest total matters, pivot to ${selectionGuide.cheapest.rate_name}.`
          : null,
        selectionGuide?.most_flexible?.rate_id && selectionGuide.most_flexible.rate_id !== primaryRecommendation.rate_id
          ? `If flexibility matters, pivot to ${selectionGuide.most_flexible.rate_name}.`
          : null,
        selectionGuide?.best_benefits?.rate_id && selectionGuide.best_benefits.rate_id !== primaryRecommendation.rate_id
          ? `If attached perks matter most, pivot to ${selectionGuide.best_benefits.rate_name}.`
          : null,
      ],
      3
    );
    const recommendedOpening = `This stay is bookable now. Lead with ${primaryRecommendation.rate_name} on ${primaryRecommendation.room_name}.`;
    const recommendedAngle = compactText(
      uniqueTexts(
        [
          hotel?.benefit_brief?.headline,
          `Quote ${displayTotal ?? "N/A"} CNY as the guest-facing display total.`,
          dueNow !== null
            ? `Due-now amount can be framed at ${dueNow} CNY when guarantee semantics apply.`
            : null,
        ],
        2
      ).join(" "),
      220
    );
    const hotelFocus = compactText(
      firstNonEmpty(
        hotel?.static_story?.positioning,
        hotel?.grounding_excerpt?.why_stay_here,
        hotel?.grounding_excerpt?.luxury_fit
      ),
      220
    );
    const cityFocus = compactText(
      firstNonEmpty(
        hotel?.location_brief?.city_context,
        hotel?.city_grounding_excerpt?.stay_area_recommendation,
        hotel?.city_grounding_excerpt?.city_character
      ),
      220
    );
    const perkFocus = compactText(firstNonEmpty(hotel?.benefit_brief?.headline), 220);
    const proofPoints = uniqueTexts(
      [
        `${primaryRecommendation.room_name} / ${primaryRecommendation.rate_name}`,
        displayTotal !== null ? `Guest-facing total ${displayTotal} CNY` : null,
        dueNow !== null ? `Guarantee due-now ${dueNow} CNY` : null,
        hotel?.location_brief?.headline,
      ],
      4
    );
    const nextQuestion = "Ask whether the traveler wants lowest total, better flexibility, or the strongest attached perks before preparing a quote.";

    return {
      mode: "hotel_rooms_available",
      booking_readiness: {
        status: "bookable_now",
        room_id: primaryRecommendation.room_id,
        rate_id: primaryRecommendation.rate_id,
      },
      recommended_opening: recommendedOpening,
      recommended_angle: recommendedAngle,
      hotel_focus: hotelFocus,
      city_focus: cityFocus,
      perk_focus: perkFocus,
      proof_points: proofPoints,
      branches,
      watchouts: asArray(primaryRecommendation?.tradeoffs).slice(0, 2),
      next_question: nextQuestion,
      presenter_lines: buildAgentBriefPresenterLines({
        recommendedOpening,
        recommendedAngle,
        hotelFocus,
        cityFocus,
        perkFocus,
        proofPoints,
        branches,
        watchouts: asArray(primaryRecommendation?.tradeoffs).slice(0, 2),
        nextQuestion,
      }),
    };
  }

  if (inventoryError || identityResolution?.resolution_status === "unresolved") {
    const displayHotel =
      hotel?.hotel_name ||
      identityResolution?.resolved_hotel_name ||
      identityResolution?.input_hotel_name ||
      `hotel_id ${identityResolution?.input_hotel_id || "unknown"}`;
    const unresolvedIdentity = identityResolution?.resolution_status === "unresolved";
    const recommendedOpening = unresolvedIdentity
      ? `Live room lookup did not resolve ${displayHotel} into a bookable Bitvoya hotel yet. Do not present this as sold out.`
      : `Live room lookup failed for ${displayHotel}, but that is not the same as confirmed sellout.`;
    const recommendedAngle = compactText(
      uniqueTexts(
        [
          inventoryError ? `Live lookup error: ${inventoryError}` : null,
          hotel?.bitvoya_value_brief?.primary_angle,
          hotel?.static_story?.positioning,
          unresolvedIdentity
            ? "If the hotel id may be from a frontend page or foreign system, recover the canonical Bitvoya hotel id before judging inventory."
            : null,
        ],
        3
      ).join(" "),
      220
    );
    const hotelFocus = compactText(
      firstNonEmpty(
        hotel?.static_story?.positioning,
        hotel?.grounding_excerpt?.why_stay_here,
        hotel?.grounding_excerpt?.luxury_fit
      ),
      220
    );
    const cityFocus = compactText(
      firstNonEmpty(
        hotel?.location_brief?.city_context,
        hotel?.city_grounding_excerpt?.stay_area_recommendation,
        hotel?.city_grounding_excerpt?.city_character
      ),
      220
    );
    const perkFocus = compactText(firstNonEmpty(hotel?.benefit_brief?.headline), 220);
    const proofPoints = uniqueTexts(
      [hotel?.location_brief?.headline, hotel?.nearby_pois_brief?.headline],
      2
    );
    const branches = uniqueTexts(
      [
        unresolvedIdentity
          ? "Retry with hotel_name and optional city_name so MCP can recover the canonical live hotel id."
          : "Retry the live room lookup before concluding the hotel is unavailable.",
        "If dates are fixed, compare same-city alternatives while this hotel's live identity or inventory is repaired.",
      ],
      3
    );
    const nextQuestion = unresolvedIdentity
      ? "Ask for the hotel name or canonical hotel id if the current id may be non-canonical."
      : "Ask whether to retry live inventory or pivot to alternatives.";

    return {
      mode: unresolvedIdentity ? "hotel_rooms_identity_unresolved" : "hotel_rooms_lookup_error",
      booking_readiness: {
        status: unresolvedIdentity ? "needs_identity_resolution" : "needs_inventory_retry",
      },
      recommended_opening: recommendedOpening,
      recommended_angle: recommendedAngle,
      hotel_focus: hotelFocus,
      city_focus: cityFocus,
      perk_focus: perkFocus,
      proof_points: proofPoints,
      branches,
      watchouts: [],
      next_question: nextQuestion,
      presenter_lines: buildAgentBriefPresenterLines({
        recommendedOpening,
        recommendedAngle,
        hotelFocus,
        cityFocus,
        perkFocus,
        proofPoints,
        branches,
        nextQuestion,
      }),
    };
  }

  const recommendedOpening =
    dateValidation?.status === "past_stay"
      ? "Do not frame this as a true sellout. The requested stay window is already in the past relative to the server date."
      : `No live rate came back for this stay window at ${hotel?.hotel_name}, but that is not the same as the hotel being useless to the traveler.`;
  const recommendedAngle = compactText(
    firstNonEmpty(
      hotel?.bitvoya_value_brief?.primary_angle,
      hotel?.static_story?.positioning,
      hotel?.location_brief?.headline
    ),
    200
  );
  const hotelFocus = compactText(
    firstNonEmpty(
      hotel?.static_story?.positioning,
      hotel?.grounding_excerpt?.why_stay_here,
      hotel?.grounding_excerpt?.luxury_fit
    ),
    220
  );
  const cityFocus = compactText(
    firstNonEmpty(
      hotel?.location_brief?.city_context,
      hotel?.city_grounding_excerpt?.stay_area_recommendation,
      hotel?.city_grounding_excerpt?.city_character
    ),
    220
  );
  const perkFocus = compactText(firstNonEmpty(hotel?.benefit_brief?.headline), 220);
  const proofPoints = uniqueTexts(
    [hotel?.location_brief?.headline, hotel?.nearby_pois_brief?.headline],
    2
  );
  const branches = uniqueTexts(
    [
      dateValidation?.status === "past_stay"
        ? "Ask for a future date range before drawing any inventory conclusion."
        : "Retry nearby dates before declaring the property unavailable.",
      "If the traveler is date-fixed, compare same-city alternatives rather than stopping at the first no-inventory result.",
    ],
    3
  );
  const nextQuestion =
    dateValidation?.status === "past_stay"
      ? "Ask for the correct future dates."
      : "Ask whether to shift dates or pivot to alternatives in the same destination.";

  return {
    mode: "hotel_rooms_unavailable",
    booking_readiness: {
      status: dateValidation?.status === "past_stay" ? "needs_new_dates" : "needs_inventory_retry",
    },
    recommended_opening: recommendedOpening,
    recommended_angle: recommendedAngle,
    hotel_focus: hotelFocus,
    city_focus: cityFocus,
    perk_focus: perkFocus,
    proof_points: proofPoints,
    branches,
    watchouts: [],
    next_question: nextQuestion,
    presenter_lines: buildAgentBriefPresenterLines({
      recommendedOpening,
      recommendedAngle,
      hotelFocus,
      cityFocus,
      perkFocus,
      proofPoints,
      branches,
      nextQuestion,
    }),
  };
}

function buildCompareHotelsAgentBrief({
  ranked = [],
  cheapestLive = null,
  bestBenefits = null,
  appliedPreferences = null,
  stayContext = null,
} = {}) {
  const topPick = asArray(ranked)[0] || null;
  if (!topPick) {
    return null;
  }

  const branches = [];
  if (cheapestLive?.hotel?.hotel_id && cheapestLive.hotel.hotel_id !== topPick.hotel.hotel_id) {
    branches.push(`If lowest live total matters, pivot to ${cheapestLive.hotel.hotel_name}.`);
  }
  if (bestBenefits?.hotel?.hotel_id && bestBenefits.hotel.hotel_id !== topPick.hotel.hotel_id) {
    branches.push(`If benefits matter more than the weighted winner, pivot to ${bestBenefits.hotel.hotel_name}.`);
  }

  const recommendedOpening = `Do not read the ranking top-down. Lead with ${topPick.hotel.hotel_name} as the current ${appliedPreferences?.priority_profile || "balanced"} winner.`;
  const recommendedAngle = compactText(
    firstNonEmpty(
      topPick.hotel?.bitvoya_value_brief?.primary_angle,
      topPick.decision_brief?.choose_reasons?.[0],
      topPick.hotel?.static_story?.positioning
    ),
    180
  );
  const sellThisWhen = asArray(topPick.decision_brief?.best_for).map(describeHotelAudienceTag).filter(Boolean);
  const watchouts = asArray(topPick.decision_brief?.tradeoffs).slice(0, 2);
  const nextQuestion = stayContext
    ? "Ask which matters more now: perks, lowest payable total, or flexibility."
    : "Ask for dates before turning this ranking into a booking recommendation.";

  return {
    mode: "hotel_comparison",
    recommended_opening: recommendedOpening,
    recommended_angle: recommendedAngle,
    sell_this_when: sellThisWhen,
    branches,
    watchouts,
    next_question: nextQuestion,
    presenter_lines: buildAgentBriefPresenterLines({
      recommendedOpening,
      recommendedAngle,
      sellThisWhen,
      branches,
      watchouts,
      nextQuestion,
    }),
  };
}

function buildRateTradeoffs(rate) {
  const tradeoffs = [];

  if (!rate?.payment_options?.guarantee_supported) {
    tradeoffs.push("Cannot use guarantee flow on this rate.");
  }

  if (!rate?.payment_options?.prepay_supported) {
    tradeoffs.push("Cannot use prepay on this rate.");
  }

  if (!rate?.cancellation?.free_cancel_until) {
    tradeoffs.push("No free-cancel deadline is exposed for this rate.");
  }

  if (countRateBenefits(rate) === 0) {
    tradeoffs.push("No explicit interest or promotion package is attached to this rate.");
  }

  return tradeoffs;
}

function buildRateChooseWhen(entry, role = null, topDimension = null, preferences = null) {
  if (role === "cheapest") {
    return "Pick this when minimizing the guest-facing display total is the priority.";
  }

  if (role === "most_flexible") {
    return "Pick this when cancellation flexibility matters more than pure price.";
  }

  if (role === "best_benefits") {
    return "Pick this when attached perks and promotions matter more than the lowest total.";
  }

  if (role === "best_guarantee") {
    return "Pick this when the user prefers guarantee flow and lower due-now cost.";
  }

  if (role === "best_prepay") {
    return "Pick this when the user wants a clean prepay-ready rate.";
  }

  const priorityReason = buildRatePriorityReason(entry, topDimension, preferences);
  if (priorityReason) {
    return priorityReason;
  }

  const rate = entry?.rate;
  if (countRateBenefits(rate) > 0) {
    return "Pick this when benefit content matters and the guest accepts the attached pricing.";
  }

  return "Pick this when the room and payment semantics fit the trip better than the alternatives.";
}

function buildHotelComparisonRow({ hotel, decision_brief, live_rate_summary, applied_preferences }) {
  return {
    hotel_id: hotel.hotel_id,
    hotel_name: hotel.hotel_name,
    city_name: hotel?.city?.city_name || null,
    score: decision_brief.score,
    score_breakdown: decision_brief.score_breakdown,
    choose_reasons: decision_brief.choose_reasons,
    tradeoffs: decision_brief.tradeoffs,
    best_for: decision_brief.best_for,
    quality_signals: hotel.quality_signals,
    membership_benefits: hotel.membership_benefits,
    benefit_brief: hotel.benefit_brief || null,
    location_brief: hotel.location_brief || null,
    nearby_pois_brief: hotel.nearby_pois_brief || null,
    bitvoya_value_brief: hotel.bitvoya_value_brief || null,
    applied_preferences: {
      priority_profile: applied_preferences?.priority_profile || "balanced",
      payment_preference: applied_preferences?.payment_preference || "any",
    },
    price_snapshot:
      live_rate_summary || hotel.search_price
        ? {
            cheapest_live_display_total_cny: live_rate_summary?.cheapest_display_total_cny ?? null,
            search_stage_supplier_min_price_cny: hotel?.search_price?.supplier_min_price_cny ?? null,
            lowest_due_now_cny: live_rate_summary?.lowest_due_now_cny ?? null,
          }
        : null,
    live_inventory_signals: live_rate_summary
      ? {
          rate_count: live_rate_summary.rate_count,
          free_cancellation_available: live_rate_summary.free_cancellation_available,
          guarantee_available: live_rate_summary.guarantee_available,
          prepay_available: live_rate_summary.prepay_available,
          best_benefits_count: live_rate_summary.best_benefits_count,
        }
      : null,
    grounding_excerpt: hotel.grounding_excerpt,
  };
}

function buildRateComparisonGuide(flattenedRates) {
  const sortedByPrice = sortByDisplayTotal(flattenedRates);
  const cheapest = sortedByPrice[0] || null;

  const mostFlexible = [...asArray(flattenedRates)]
    .filter((entry) => entry?.rate?.cancellation?.free_cancel_until)
    .sort((a, b) => {
      const penaltyA = a?.rate?.cancellation?.penalty_cny ?? Number.POSITIVE_INFINITY;
      const penaltyB = b?.rate?.cancellation?.penalty_cny ?? Number.POSITIVE_INFINITY;
      if (penaltyA !== penaltyB) return penaltyA - penaltyB;
      return (a?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY) - (b?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY);
    })[0] || null;

  const bestBenefits = [...asArray(flattenedRates)]
    .sort((a, b) => {
      const benefitsDelta = countRateBenefits(b?.rate) - countRateBenefits(a?.rate);
      if (benefitsDelta !== 0) return benefitsDelta;
      return (a?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY) - (b?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY);
    })[0] || null;

  const bestGuarantee = [...asArray(flattenedRates)]
    .filter((entry) => entry?.rate?.payment_options?.guarantee_supported)
    .sort((a, b) => {
      const dueNowA = a?.rate?.payment_scenarios?.guarantee?.estimated_service_fee_due_now_cny ?? Number.POSITIVE_INFINITY;
      const dueNowB = b?.rate?.payment_scenarios?.guarantee?.estimated_service_fee_due_now_cny ?? Number.POSITIVE_INFINITY;
      if (dueNowA !== dueNowB) return dueNowA - dueNowB;
      return (a?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY) - (b?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY);
    })[0] || null;

  const bestPrepay = [...asArray(flattenedRates)]
    .filter((entry) => entry?.rate?.payment_options?.prepay_supported)
    .sort((a, b) =>
      (a?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY) -
      (b?.rate?.pricing?.display_total_cny ?? Number.POSITIVE_INFINITY)
    )[0] || null;

  return {
    cheapest,
    most_flexible: mostFlexible,
    best_benefits: bestBenefits,
    best_guarantee: bestGuarantee,
    best_prepay: bestPrepay,
  };
}

function summarizeRateGuideEntry(entry, role) {
  if (!entry) return null;

  return {
    room_id: entry.room.room_id,
    room_name: entry.room.room_name,
    rate_id: entry.rate.rate_id,
    rate_name: entry.rate.rate_name,
    display_total_cny: entry.rate.pricing.display_total_cny,
    supplier_total_cny: entry.rate.pricing.supplier_total_cny,
    service_fee_cny: entry.rate.pricing.service_fee_cny,
    choose_when: buildRateChooseWhen(entry, role),
  };
}

function buildRateComparisonRow(entry, guide = {}, scoreBreakdown = null, preferences = null) {
  let role = null;
  if (guide.cheapest?.rate?.rate_id === entry.rate.rate_id) role = "cheapest";
  else if (guide.most_flexible?.rate?.rate_id === entry.rate.rate_id) role = "most_flexible";
  else if (guide.best_benefits?.rate?.rate_id === entry.rate.rate_id) role = "best_benefits";
  else if (guide.best_guarantee?.rate?.rate_id === entry.rate.rate_id) role = "best_guarantee";
  else if (guide.best_prepay?.rate?.rate_id === entry.rate.rate_id) role = "best_prepay";

  return {
    room_id: entry.room.room_id,
    room_name: entry.room.room_name,
    rate_id: entry.rate.rate_id,
    rate_name: entry.rate.rate_name,
    score: scoreBreakdown?.total_score ?? null,
    score_breakdown: scoreBreakdown,
    highlight_role: role,
    choose_when: buildRateChooseWhen(entry, role, scoreBreakdown?.top_dimensions?.[0], preferences),
    tradeoffs: buildRateTradeoffs(entry.rate),
    pricing: entry.rate.pricing,
    cancellation: entry.rate.cancellation,
    payment_options: entry.rate.payment_options,
    payment_scenarios: entry.rate.payment_scenarios,
    benefits: entry.rate.benefits,
  };
}

function buildRatePreferenceModifierSpecs(appliedPreferences) {
  return [
    (item) => {
      if (!appliedPreferences.require_free_cancellation) {
        return null;
      }

      return item?.entry?.rate?.cancellation?.free_cancel_until
        ? {
            preference: "require_free_cancellation",
            status: "satisfied",
            contribution: 8,
            note: "This rate exposes a free-cancel deadline.",
          }
        : {
            preference: "require_free_cancellation",
            status: "not_satisfied",
            contribution: -16,
            note: "This rate does not expose free cancellation.",
          };
    },
    (item) => {
      if (!appliedPreferences.prefer_benefits) {
        return null;
      }

      return countRateBenefits(item?.entry?.rate) > 0
        ? {
            preference: "prefer_benefits",
            status: "satisfied",
            contribution: 6,
            note: "This rate carries explicit interests or promotions.",
          }
        : {
            preference: "prefer_benefits",
            status: "not_satisfied",
            contribution: -6,
            note: "This rate has no explicit perk payload.",
          };
    },
    (item) => {
      if (appliedPreferences.payment_preference === "any") {
        return null;
      }

      const supportsRequestedPayment =
        appliedPreferences.payment_preference === "guarantee"
          ? item?.entry?.rate?.payment_options?.guarantee_supported
          : item?.entry?.rate?.payment_options?.prepay_supported;

      return supportsRequestedPayment
        ? {
            preference: `payment_preference:${appliedPreferences.payment_preference}`,
            status: "satisfied",
            contribution: 10,
            note: `This rate supports ${appliedPreferences.payment_preference} flow.`,
          }
        : {
            preference: `payment_preference:${appliedPreferences.payment_preference}`,
            status: "not_satisfied",
            contribution: -18,
            note: `This rate does not support ${appliedPreferences.payment_preference} flow.`,
          };
    },
  ];
}

function buildRateComparisonMethod() {
  return {
    type: "weighted_profile_ranking",
    score_scale: "0-100 weighted dimensions plus preference modifiers",
    price_dimension: "display_total_cny",
    low_due_now_dimension: "best available due-now amount across guarantee/prepay semantics",
  };
}

function buildRoundedAppliedPreferences(appliedPreferences) {
  return {
    ...appliedPreferences,
    weights: Object.fromEntries(
      Object.entries(appliedPreferences.weights).map(([key, value]) => [key, roundScore(value, 4)])
    ),
  };
}

function rankRatesWithPreferences(flattenedRates, params = {}) {
  const appliedPreferences = resolveRateComparisonPreferences(params);
  const guide = buildRateComparisonGuide(flattenedRates);
  const scored = buildWeightedScoreBreakdown(
    flattenedRates.map((entry) => ({
      entry,
      metrics: computeRateMetricInputs(entry, appliedPreferences),
    })),
    appliedPreferences.weights,
    {
      price: "asc",
      perks: "desc",
      flexibility: "desc",
      payment_fit: "desc",
      low_due_now: "asc",
    },
    buildRatePreferenceModifierSpecs(appliedPreferences)
  );

  const rankedEntries = [...scored].sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
  const rankedRows = rankedEntries.map((item) =>
    buildRateComparisonRow(item.entry, guide, item.score_breakdown, appliedPreferences)
  );

  return {
    applied_preferences: appliedPreferences,
    comparison_method: buildRateComparisonMethod(),
    guide,
    ranked_entries: rankedEntries,
    ranked_rows: rankedRows,
  };
}

function summarizeRankedRateRow(row) {
  if (!row) return null;

  return {
    room_id: row.room_id,
    room_name: row.room_name,
    rate_id: row.rate_id,
    rate_name: row.rate_name,
    score: row.score,
    highlight_role: row.highlight_role,
    top_dimensions: row.score_breakdown?.top_dimensions || [],
    choose_when: row.choose_when,
    display_total_cny: row.pricing?.display_total_cny ?? null,
    supplier_total_cny: row.pricing?.supplier_total_cny ?? null,
    service_fee_cny: row.pricing?.service_fee_cny ?? null,
    lowest_due_now_cny: getRateLowestDueNowCny({
      payment_options: row.payment_options,
      payment_scenarios: row.payment_scenarios,
    }),
    free_cancel_until: row.cancellation?.free_cancel_until ?? null,
    payment_options: row.payment_options,
  };
}

export async function getHotelGroundingSnapshotMap(db, sourceHotelIds) {
  const ids = Array.from(
    new Set(
      sourceHotelIds
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
        source_hotel_id,
        tripwiki_hotel_id,
        source_city_id,
        hotel_name,
        brand_name,
        city_name,
        country_name,
        country_code,
        star_rating,
        review_score,
        review_count,
        address,
        base_nightly_price,
        currency,
        grounding_status,
        why_stay_here,
        why_not_stay_here,
        hotel_luxury_fit_reason,
        hotel_family_fit_reason,
        hotel_couple_fit_reason,
        hotel_business_fit_reason,
        hotel_short_stay_fit_reason,
        hotel_long_stay_fit_reason,
        hotel_area_character,
        hotel_transport_summary,
        hotel_airport_access_summary,
        hotel_rail_access_summary,
        hotel_metro_access_summary,
        hotel_walkability_summary,
        hotel_shopping_access_summary,
        hotel_attraction_access_summary,
        hotel_food_access_summary,
        hotel_nightlife_access_summary,
        hotel_risk_notes,
        hotel_tradeoff_notes,
        agent_planning_notes,
        planner_summary_json,
        access_overview_json,
        neighborhood_overview_json,
        traveler_fit_json,
        missing_dimensions_json
      FROM vw_tripwiki_hotel_grounding_card
      WHERE source_hotel_id IN (${toPlaceholders(ids.length)})
    `,
    ids
  );

  return new Map(rows.map((row) => [String(row.source_hotel_id), mapHotelSnapshotRow(row)]));
}

async function getNearbyPoiSnapshotMap(db, sourceHotelIds, limitPerHotel = 4) {
  const ids = Array.from(
    new Set(
      sourceHotelIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await db.query(
    `
      SELECT *
      FROM vw_tripwiki_hotel_nearby_poi
      WHERE source_hotel_id IN (${toPlaceholders(ids.length)})
      ORDER BY
        source_hotel_id ASC,
        COALESCE(priority_tier, 999) ASC,
        COALESCE(distance_meters, 999999) ASC,
        COALESCE(rank_no, 999) ASC
    `,
    ids
  );

  const grouped = new Map();

  for (const row of rows) {
    const hotelId = String(row.source_hotel_id);
    const bucket = grouped.get(hotelId) || [];

    if (bucket.length < limitPerHotel) {
      bucket.push(mapNearbyPoiRow(row));
      grouped.set(hotelId, bucket);
    }
  }

  return grouped;
}

async function buildHotelSummaryBatch(db, hotels, { priceMap = new Map(), stayContext = null, matchSource = null } = {}) {
  const uniqueHotels = uniqueBy(asArray(hotels), (hotel) => normalizeId(hotel?.id));
  const hotelIds = uniqueHotels.map((hotel) => String(hotel.id));
  const cityIds = uniqueHotels
    .map((hotel) => normalizeId(hotel?.profiles?.CITY?.id))
    .filter(Boolean);

  const [groundingMap, cityGroundingMap] = await Promise.all([
    getHotelGroundingSnapshotMap(db, hotelIds),
    getCityGroundingSnapshotMap(db, cityIds),
  ]);

  return uniqueHotels.map((hotel) => {
    const hotelId = String(hotel.id);
    const cityId = normalizeId(hotel?.profiles?.CITY?.id);

    return normalizeHotelSummary(hotel, {
      searchPriceInfo: buildSearchPrice(priceMap.get(hotelId), stayContext),
      grounding: groundingMap.get(hotelId) || null,
      cityGrounding: cityId ? cityGroundingMap.get(cityId) || null : null,
      matchSource,
    });
  });
}

async function loadPriceMap(api, hotelIds, stayContext) {
  if (!stayContext || asArray(hotelIds).length === 0) {
    return new Map();
  }

  let priceRows = [];
  try {
    priceRows = await api.getHotelPrices({
      hotelIds,
      checkin: stayContext.checkin,
      checkout: stayContext.checkout,
      adultNum: stayContext.adult_num,
    }, {
      // Search-stage prices are a helpful signal, but MCP discovery should return
      // a grounded shortlist even when batch price enrichment is slower than the
      // chat tool budget.
      timeoutMs: SEARCH_STAGE_PRICE_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isLikelyTransientLiveError(error)) {
      throw error;
    }

    priceRows = [];
  }

  return new Map(
    priceRows
      .filter((row) => row?.id !== null && row?.id !== undefined)
      .map((row) => [String(row.id), row])
  );
}

async function loadHotelDetailsForSuggestions(api, suggestions) {
  const detailPromises = asArray(suggestions).map(async (hotel) => {
    try {
      return await api.getHotelDetail(hotel.id);
    } catch {
      return {
        id: hotel.id,
        name: hotel.name,
        nameEn: hotel.nameEn,
        longitude: hotel.longitude,
        latitude: hotel.latitude,
        profiles: {
          CITY: null,
          BRAND: null,
          GROUP: null,
          INTEREST: [],
          PROMOTION: [],
        },
      };
    }
  });

  return Promise.all(detailPromises);
}

function countRawHotelBenefits(hotel) {
  return (
    asArray(hotel?.profiles?.INTEREST).length +
    asArray(hotel?.profiles?.PROMOTION).length
  );
}

function getRankingWorkingSetCap(params = {}, options = {}) {
  const limit = Math.max(1, Number(params?.limit || options?.limit || 5));
  const offset = Math.max(0, Number(params?.offset || options?.offset || 0));
  const query = String(options?.query || "").trim();
  const base =
    options?.sectionType === "city_inventory_shortlist" && !query
      ? Math.max((offset + limit) * 8, 72)
      : Math.max((offset + limit) * 6, 48);

  return Math.min(base, 120);
}

function scoreHotelForRankingWorkingSet(hotel, params = {}, options = {}) {
  const priorityProfile = String(params?.priority_profile || "balanced").trim();
  const preferBenefits = Boolean(params?.prefer_benefits) || priorityProfile === "perks";
  const query = String(options?.query || "").trim();
  const rawName = normalizeSearchText(
    firstNonEmpty(hotel?.nameEn, hotel?.name, hotel?.profiles?.BRAND?.nameEn, hotel?.profiles?.BRAND?.name)
  );
  const rawCity = normalizeSearchText(firstNonEmpty(hotel?.profiles?.CITY?.nameEn, hotel?.profiles?.CITY?.name));
  const normalizedQuery = normalizeSearchText(query);
  const benefitCount = countRawHotelBenefits(hotel);
  const starRating = asNullableNumber(firstNonEmpty(hotel?.starRate, hotel?.star_rating, hotel?.star)) || 0;
  const reviewScore =
    asNullableNumber(firstNonEmpty(hotel?.reviewScore, hotel?.commentScore, hotel?.score)) || 0;

  let score = 0;

  if (normalizedQuery) {
    if (rawName === normalizedQuery) {
      score += 120;
    } else if (rawName.startsWith(normalizedQuery)) {
      score += 90;
    } else if (rawName.includes(normalizedQuery)) {
      score += 64;
    } else if (rawCity && normalizedQuery.includes(rawCity)) {
      score += 24;
    }
  }

  if (preferBenefits) {
    score += benefitCount * 28;
  } else {
    score += Math.min(benefitCount, 3) * 10;
  }

  if (priorityProfile === "luxury") {
    score += starRating * 15 + reviewScore * 2.2;
  } else if (priorityProfile === "perks") {
    score += starRating * 9 + reviewScore * 1.2;
  } else {
    score += starRating * 10 + reviewScore * 1.5;
  }

  return score;
}

function selectHotelsForRankingWorkingSet(rawHotels, params = {}, options = {}) {
  const uniqueHotels = uniqueBy(asArray(rawHotels), (hotel) => normalizeId(hotel?.id));
  const workingSetCap = getRankingWorkingSetCap(params, options);

  if (uniqueHotels.length <= workingSetCap) {
    return {
      hotels: uniqueHotels,
      raw_total: uniqueHotels.length,
      working_set_total: uniqueHotels.length,
      working_set_limited: false,
    };
  }

  const selected = uniqueHotels
    .map((hotel, index) => ({
      hotel,
      index,
      score: scoreHotelForRankingWorkingSet(hotel, params, options),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return left.index - right.index;
    })
    .slice(0, workingSetCap)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.hotel);

  return {
    hotels: selected,
    raw_total: uniqueHotels.length,
    working_set_total: selected.length,
    working_set_limited: true,
  };
}

function buildSearchContext({ query, cityId, cityName, resolvedCity, strategy, offset, limit, stayContext }) {
  return {
    input: {
      query: query || null,
      city_id: cityId || null,
      city_name: cityName || null,
      offset,
      limit,
    },
    strategy,
    resolved_city: resolvedCity
      ? {
          city_id: normalizeId(resolvedCity.id),
          city_name: resolvedCity.name || null,
          city_name_en: resolvedCity.nameEn || null,
        }
      : null,
    stay: stayContext,
  };
}

function buildSearchPricingNotice(stayContext) {
  if (!stayContext) {
    return {
      stage: "catalog_only",
      note: "No stay dates supplied, so search results omit live supplier min-price lookups.",
    };
  }

  return {
    stage: "search",
    search_price_field: "supplier_min_price_cny",
    note: "Search-stage min prices come from /hotels/prices and do not include the service-fee-adjusted display total used at checkout.",
  };
}

function buildGroundingFallbackPricingNotice() {
  return {
    stage: "grounding_fallback",
    search_price_field: "pricing_snapshot.base_nightly_price",
    note:
      "Grounding fallback prices are snapshot base-nightly references only. Validate live room totals, payment semantics, and service fees with get_hotel_detail or get_hotel_rooms before booking.",
  };
}

function buildSearchQueryMatch(hotel, query) {
  return buildSearchMatchDescriptor(scoreHotelIdentityMatch(hotel, query), "hotel");
}

function buildSearchShortlistGuide(ranked) {
  const topPick = ranked[0] || null;
  const bestValue =
    [...ranked]
      .filter((item) => Number.isFinite(item.hotel?.search_price?.supplier_min_price_cny))
      .sort(
        (a, b) =>
          (a.hotel?.search_price?.supplier_min_price_cny ?? Number.POSITIVE_INFINITY) -
          (b.hotel?.search_price?.supplier_min_price_cny ?? Number.POSITIVE_INFINITY)
      )[0] || null;
  const strongestBenefits =
    [...ranked].sort(
      (a, b) =>
        ((b.hotel?.membership_benefits?.interest_count || 0) + (b.hotel?.membership_benefits?.promotion_count || 0)) -
        ((a.hotel?.membership_benefits?.interest_count || 0) + (a.hotel?.membership_benefits?.promotion_count || 0))
    )[0] || null;
  const strongestStaticStory = ranked.find((item) => item.hotel?.static_story?.positioning) || null;
  const strongestLocationStory = ranked.find(
    (item) => (item.hotel?.static_story?.access_highlights || []).length > 0
  ) || null;

  return {
    top_pick: topPick
      ? {
          hotel_id: topPick.hotel.hotel_id,
          hotel_name: topPick.hotel.hotel_name,
          score: topPick.decision_brief?.score ?? null,
          choose_reasons: topPick.decision_brief?.choose_reasons || [],
          best_for: topPick.decision_brief?.best_for || [],
          benefit_brief: topPick.hotel?.benefit_brief || null,
          location_brief: topPick.hotel?.location_brief || null,
          bitvoya_value_brief: topPick.hotel?.bitvoya_value_brief || null,
        }
      : null,
    best_value: bestValue
      ? {
          hotel_id: bestValue.hotel.hotel_id,
          hotel_name: bestValue.hotel.hotel_name,
          supplier_min_price_cny: bestValue.hotel?.search_price?.supplier_min_price_cny ?? null,
        }
      : null,
    strongest_benefits: strongestBenefits
      ? {
          hotel_id: strongestBenefits.hotel.hotel_id,
          hotel_name: strongestBenefits.hotel.hotel_name,
          benefit_count:
            (strongestBenefits.hotel?.membership_benefits?.interest_count || 0) +
            (strongestBenefits.hotel?.membership_benefits?.promotion_count || 0),
          top_signals: strongestBenefits.hotel?.benefit_brief?.top_signals || [],
          headline: strongestBenefits.hotel?.benefit_brief?.headline || null,
        }
      : null,
    strongest_static_story: strongestStaticStory
      ? {
          hotel_id: strongestStaticStory.hotel.hotel_id,
          hotel_name: strongestStaticStory.hotel.hotel_name,
          positioning: strongestStaticStory.hotel?.static_story?.positioning || null,
          bitvoya_value_brief: strongestStaticStory.hotel?.bitvoya_value_brief || null,
        }
      : null,
    strongest_location_story: strongestLocationStory
      ? {
          hotel_id: strongestLocationStory.hotel.hotel_id,
          hotel_name: strongestLocationStory.hotel.hotel_name,
          access_highlights: strongestLocationStory.hotel?.static_story?.access_highlights || [],
          location_brief: strongestLocationStory.hotel?.location_brief || null,
        }
      : null,
  };
}

function rankSearchHotels(normalizedHotels, rawHotelMap, params = {}, searchContext = {}) {
  const appliedPreferences = resolveHotelComparisonPreferences(params, searchContext.stayContext || null);
  const scored = buildWeightedScoreBreakdown(
    asArray(normalizedHotels).map((hotel, index) => ({
      hotel,
      index,
      query_match: searchContext.enableQueryRelevance
        ? buildSearchQueryMatch(rawHotelMap.get(hotel.hotel_id) || {}, searchContext.query)
        : null,
      metrics: computeHotelMetricInputs(hotel),
    })),
    appliedPreferences.weights,
    {
      quality: "desc",
      price: "asc",
      perks: "desc",
      luxury: "desc",
      location: "desc",
      flexibility: "desc",
      low_due_now: "asc",
    },
    [
      (item) => {
        if (!searchContext.query || !item?.query_match) {
          return null;
        }

        const contribution =
          item.query_match.match_type === "exact"
            ? 16
            : item.query_match.match_type === "prefix"
              ? 10
              : item.query_match.match_type === "token_set"
                ? 8
                : item.query_match.match_type === "contains"
                  ? 4
                  : 2;

        return {
          preference: "query_relevance",
          status: item.query_match.match_type,
          contribution,
          note: item.query_match.note,
        };
      },
    ]
  ).map((item) => ({
    ...item,
    decision_brief: buildHotelDecisionBrief(item.hotel, null, item.score_breakdown),
  }));

  const ranked = [...scored].sort((a, b) => {
    const scoreDiff = (b.total_score ?? 0) - (a.total_score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;

    const matchScoreA = 100 - (a.query_match?.relevance_score ?? 0);
    const matchScoreB = 100 - (b.query_match?.relevance_score ?? 0);
    if (matchScoreA !== matchScoreB) return matchScoreA - matchScoreB;

    return (a.index ?? 0) - (b.index ?? 0);
  });

  return {
    applied_preferences: buildRoundedAppliedPreferences(appliedPreferences),
    comparison_method: {
      type: "weighted_search_shortlist_ranking",
      score_scale: "0-100 weighted dimensions plus query relevance modifiers",
      price_dimension: "search_stage_supplier_min_price_cny when available",
      note: "Search-stage ranking favors explainable shortlist fit; validate room/rate inventory before booking.",
    },
    ranked,
    selection_guide: buildSearchShortlistGuide(ranked),
  };
}

async function buildRankedHotelSection(api, db, rawHotels, params, options = {}) {
  const workingSet = selectHotelsForRankingWorkingSet(rawHotels, params, options);
  const uniqueHotels = workingSet.hotels;

  if (uniqueHotels.length === 0) {
    return {
      section_type: options.sectionType || "search_section",
      summary: "No hotel rows were available for this section.",
      applied_preferences: buildRoundedAppliedPreferences(
        resolveHotelComparisonPreferences(params, options.stayContext || null)
      ),
      comparison_method: {
        type: "weighted_search_shortlist_ranking",
        score_scale: "0-100 weighted dimensions plus query relevance modifiers",
        price_dimension: "search_stage_supplier_min_price_cny when available",
        note: "Search-stage ranking favors explainable shortlist fit; validate room/rate inventory before booking.",
      },
      selection_guide: {},
      count: 0,
      total_matches: 0,
      raw_total_matches: 0,
      ranking_working_set: workingSet,
      next_offset: null,
      results: [],
      ranked: [],
    };
  }

  const rawHotelMap = new Map(
    uniqueHotels
      .map((hotel) => [normalizeId(hotel?.id), hotel])
      .filter(([hotelId]) => Boolean(hotelId))
  );
  const priceMap = await loadPriceMap(
    api,
    uniqueHotels.map((hotel) => hotel?.id),
    options.stayContext || null
  );
  const normalizedHotels = await buildHotelSummaryBatch(db, uniqueHotels, {
    priceMap,
    stayContext: options.stayContext || null,
    matchSource: options.matchSource || null,
  });
  const rankedSearch = rankSearchHotels(normalizedHotels, rawHotelMap, params, {
    query: options.query || "",
    stayContext: options.stayContext || null,
    enableQueryRelevance: Boolean(options.enableQueryRelevance),
  });
  const totalMatches = rankedSearch.ranked.length;
  const offset = options.offset || 0;
  const limit = options.limit || totalMatches;
  const pagedRanked = rankedSearch.ranked.slice(offset, offset + limit);
  const nearbyPoiMap = await getNearbyPoiSnapshotMap(
    db,
    pagedRanked.map((item) => item?.hotel?.hotel_id),
    4
  );
  const results = pagedRanked.map((item, index) => {
    const nearbyPois = nearbyPoiMap.get(item.hotel.hotel_id) || [];
    const nearbyPoisBrief = buildNearbyPoiBrief(nearbyPois);
    const enrichedHotel = {
      ...item.hotel,
      nearby_pois_brief: nearbyPoisBrief,
      bitvoya_value_brief: buildBitvoyaValueBrief(
        {
          ...item.hotel,
          nearby_pois_brief: nearbyPoisBrief,
        },
        nearbyPois
      ),
    };

    return {
      ...enrichedHotel,
      search_rank: offset + index + 1,
      shortlist_score: item.decision_brief?.score ?? null,
      query_match: item.query_match,
      decision_brief: buildHotelDecisionBrief(enrichedHotel, null, item.score_breakdown),
    };
  });
  const topResult = results[0] || null;

  return {
    section_type: options.sectionType || "search_section",
    summary:
      results.length > 0
        ? `Ranked ${results.length} hotel result(s). Top pick: ${topResult?.hotel_name || "N/A"}.` +
          (topResult
            ? ` ${compactText(firstNonEmpty(topResult?.bitvoya_value_brief?.primary_angle, topResult?.location_brief?.headline), 180) || ""}`
            : "")
          +
          (workingSet.working_set_limited
            ? ` Large-city latency guard ranked a high-signal live working set of ${workingSet.working_set_total} hotels out of ${workingSet.raw_total}.`
            : "")
        : "No ranked hotel results were produced.",
    applied_preferences: rankedSearch.applied_preferences,
    comparison_method: rankedSearch.comparison_method,
    selection_guide: rankedSearch.selection_guide,
    count: results.length,
    total_matches: totalMatches,
    raw_total_matches: workingSet.raw_total,
    ranking_working_set: workingSet,
    next_offset: offset + results.length < totalMatches ? offset + results.length : null,
    results,
    ranked: rankedSearch.ranked,
  };
}

function buildHotelCandidateRows(hotelSeedRows, directHotelSection = null, limit = 5) {
  const enrichedMap = new Map(
    asArray(directHotelSection?.results).map((hotel) => [hotel.hotel_id, hotel])
  );

  return asArray(hotelSeedRows)
    .slice(0, limit)
    .map((row) => {
      const enriched = enrichedMap.get(row.hotel_id) || null;
      return {
        hotel_id: row.hotel_id,
        hotel_name: enriched?.hotel_name || row.hotel_name,
        hotel_name_en: enriched?.hotel_name_en || row.hotel_name_en || null,
        match: row.match,
        match_origin: row.match_origin || null,
        identity_signals: {
          display_name: enriched?.hotel_name_en || enriched?.hotel_name || row.hotel_name_en || row.hotel_name || null,
          alternate_names: uniqueTexts(
            [enriched?.hotel_name, enriched?.hotel_name_en, row.hotel_name, row.hotel_name_en],
            3
          ),
        },
        city: enriched?.city || null,
        brand: enriched?.brand || null,
        quality_signals: enriched?.quality_signals || null,
        search_price: enriched?.search_price || null,
        grounding_excerpt: enriched?.grounding_excerpt || null,
        static_story: enriched?.static_story
          ? {
              positioning: enriched.static_story.positioning,
              traveler_fit_highlights: asArray(enriched.static_story.traveler_fit_highlights).slice(0, 3),
            }
          : null,
      };
    });
}

function buildGroundingFallbackGuide(results) {
  const rows = asArray(results).filter(Boolean);
  const topPick = rows[0] || null;
  const bestValue =
    [...rows]
      .filter((row) => Number.isFinite(row?.pricing_snapshot?.base_nightly_price))
      .sort(
        (a, b) =>
          (a?.pricing_snapshot?.base_nightly_price ?? Number.POSITIVE_INFINITY) -
          (b?.pricing_snapshot?.base_nightly_price ?? Number.POSITIVE_INFINITY)
      )[0] || null;
  const strongestStory = rows.find((row) => row?.grounding_excerpt?.why_stay_here) || null;
  const strongestLuxuryFit = rows.find((row) => row?.grounding_excerpt?.luxury_fit) || null;

  return {
    top_pick: topPick
      ? {
          source_hotel_id: topPick.source_hotel_id,
          tripwiki_hotel_id: topPick.tripwiki_hotel_id,
          hotel_name: topPick.hotel_name,
          city_name: topPick.city_name,
          query_match: topPick.query_match,
          choose_reasons: topPick?.decision_brief?.choose_reasons || [],
        }
      : null,
    best_value: bestValue
      ? {
          source_hotel_id: bestValue.source_hotel_id,
          tripwiki_hotel_id: bestValue.tripwiki_hotel_id,
          hotel_name: bestValue.hotel_name,
          base_nightly_price: bestValue?.pricing_snapshot?.base_nightly_price ?? null,
          currency: bestValue?.pricing_snapshot?.currency ?? null,
        }
      : null,
    strongest_story: strongestStory
      ? {
          source_hotel_id: strongestStory.source_hotel_id,
          hotel_name: strongestStory.hotel_name,
          why_stay_here: strongestStory?.grounding_excerpt?.why_stay_here || null,
        }
      : null,
    strongest_luxury_fit: strongestLuxuryFit
      ? {
          source_hotel_id: strongestLuxuryFit.source_hotel_id,
          hotel_name: strongestLuxuryFit.hotel_name,
          luxury_fit: strongestLuxuryFit?.grounding_excerpt?.luxury_fit || null,
        }
      : null,
  };
}

function buildGroundingFallbackSection(results, { query, offset = 0, limit = 5, recoveryHint = null } = {}) {
  const rows = asArray(results).filter(Boolean);
  const paged = rows.slice(offset, offset + limit).map((row, index) => ({
    ...row,
    search_rank: offset + index + 1,
  }));

  return {
    section_type: "grounding_fallback_matches",
    summary:
      paged.length > 0
        ? `Recovered ${paged.length} grounded hotel candidate(s) for "${query}" ${recoveryHint || "after the live suggest layer returned no usable hotel or city match"}.`
        : `No grounded hotel candidate was recovered for "${query}".`,
    comparison_method: {
      type: "grounding_identity_recovery",
      score_scale: "identity match relevance first, then quality and price snapshot tie-breakers",
      price_dimension: "pricing_snapshot.base_nightly_price when available",
      note: "Grounding fallback is a recovery layer. Use it to re-anchor the property, then validate live detail and room inventory before booking.",
    },
    selection_guide: buildGroundingFallbackGuide(rows),
    count: paged.length,
    total_matches: rows.length,
    next_offset: offset + paged.length < rows.length ? offset + paged.length : null,
    results: paged,
  };
}

function buildGroundingRecoveryAgentBrief(results = [], stayContext = null) {
  const topPick = asArray(results)[0] || null;
  if (!topPick) {
    return null;
  }

  const recommendedOpening =
    "Lead with the grounded winner instead of saying the search failed. Make clear that live inventory needs a retry, but hotel-fit reasoning is already usable.";
  const recommendedAngle = compactText(
    firstNonEmpty(
      topPick?.decision_brief?.choose_reasons?.[0],
      topPick?.grounding_excerpt?.why_stay_here,
      topPick?.grounding_excerpt?.luxury_fit
    ),
    180
  );
  const branches = uniqueTexts(
    [
      stayContext
        ? "If the traveler is date-fixed, inspect this grounded winner first, then retry live rooms."
        : "If the traveler is still flexible, use this grounded shortlist to narrow style before asking for dates.",
      "If the traveler wants bookability now, retry the live hotel search after the timeout rather than abandoning the property.",
    ],
    3
  );
  const nextQuestion = stayContext
    ? "Ask whether to retry live pricing now or inspect the top grounded hotel first."
    : "Ask for concrete dates only after presenting the grounded winner.";

  return {
    mode: "grounding_recovery",
    recommended_opening: recommendedOpening,
    recommended_angle: recommendedAngle,
    branches,
    next_question: nextQuestion,
    presenter_lines: buildAgentBriefPresenterLines({
      recommendedOpening,
      recommendedAngle,
      branches,
      nextQuestion,
    }),
  };
}

function shouldPreferGroundingClusterReview({ routeDecision, hotelCandidates, groundingCandidates }) {
  if (routeDecision?.recommended_route !== "direct_hotel") {
    return false;
  }

  const liveCandidates = asArray(hotelCandidates).filter(Boolean);
  const grounded = asArray(groundingCandidates).filter(Boolean);
  if (liveCandidates.length !== 1 || grounded.length < 2) {
    return false;
  }

  const liveScore = liveCandidates[0]?.match?.relevance_score ?? 0;
  const topGroundScore = grounded[0]?.query_match?.relevance_score ?? 0;
  const cityBuckets = new Map();

  for (const candidate of grounded) {
    const cityName = firstNonEmpty(candidate?.city_name);
    if (!cityName) continue;
    cityBuckets.set(cityName, (cityBuckets.get(cityName) || 0) + 1);
  }

  const dominantCityCount = [...cityBuckets.values()].sort((a, b) => b - a)[0] || 0;
  return liveScore <= 72 && topGroundScore >= 60 && dominantCityCount >= 2;
}

function buildGroundingRecoveryResult({
  query,
  cityId,
  cityName,
  source,
  offset,
  limit,
  stayContext,
  cityCandidates,
  hotelCandidates,
  groundingCandidates,
  summaryPrefix,
  warningMessage,
  searchStrategy = "grounding_fallback",
  params = {},
}) {
  const assumptions = [];
  if (!stayContext) {
    assumptions.push(
      "Without checkin/checkout, grounding fallback only provides static and snapshot pricing context."
    );
  }
  if (params.require_free_cancellation) {
    assumptions.push(
      "Free-cancellation preference cannot be validated from grounding fallback; confirm it on live rates."
    );
  }
  if (params.payment_preference && params.payment_preference !== "any") {
    assumptions.push(
      "payment_preference cannot be confirmed from grounding fallback alone; validate guarantee or prepay support on live rates."
    );
  }

  const groundingFallbackSection = buildGroundingFallbackSection(groundingCandidates, {
    query,
    offset,
    limit,
    recoveryHint:
      searchStrategy === "grounding_area_recovery"
        ? "after widening a thin live hotel match with grounding context"
        : "after the live suggest layer returned no usable hotel or city match",
  });
  const groundingRouteDecision = {
    detected_intent: "hotel",
    recommended_route: "grounding_review",
    confidence:
      (groundingCandidates[0]?.query_match?.relevance_score ?? 0) >= 68
        ? "medium"
        : "low",
    reason: summaryPrefix,
  };
  const agentBrief = buildGroundingRecoveryAgentBrief(groundingFallbackSection.results, stayContext);

  return buildAgenticToolResult({
    tool: "search_hotels",
    status: "ok",
    intent: "hotel_inventory_discovery",
    summary:
      `${summaryPrefix} ` +
      `Grounding recovered ${groundingFallbackSection.total_matches} hotel candidate(s).`,
    recommended_next_tools: [
      buildNextTool("get_hotel_grounding", "Open the recovered planner-grade grounding card before narrowing further.", [
        "source_hotel_id or tripwiki_hotel_id or hotel_name",
      ]),
      buildNextTool("get_hotel_detail", "Try the live Bitvoya hotel detail payload for a recovered source_hotel_id.", [
        "hotel_id",
      ]),
      buildNextTool("search_destination_suggestions", "Retry mixed live suggestion resolution if the user pivots to a city or district phrasing.", [
        "query",
      ]),
    ],
    warnings: warningMessage ? [warningMessage] : [],
    pricing_notes: [
      "Grounding fallback price snapshots are directional only.",
      "Use get_hotel_rooms for live payable totals, payment semantics, and service-fee-aware checkout decisions.",
    ],
    selection_hints: [
      "Read query_resolution first: grounding_review means the main answer came from grounding-assisted recovery rather than a clean live hotel identity match.",
      "Use grounding_fallback_matches.selection_guide.top_pick for the first candidate to inspect.",
      "Open get_hotel_grounding before rate search when the query looks area-like, landmark-like, or identity is still fuzzy.",
    ],
    assumptions,
    entity_refs: {
      city_ids: groundingCandidates.map((hotel) => hotel.source_city_id),
      hotel_ids: groundingCandidates.map((hotel) => hotel.source_hotel_id),
      tripwiki_hotel_ids: groundingCandidates.map((hotel) => hotel.tripwiki_hotel_id),
    },
    data: {
      search_context: buildSearchContext({
        query,
        cityId,
        cityName,
        resolvedCity: null,
        strategy: searchStrategy,
        offset,
        limit,
        stayContext,
      }),
      query_resolution: buildQueryResolution({
        source,
        query,
        cityId,
        cityName,
        routeDecision: groundingRouteDecision,
        cityCandidates,
        hotelCandidates,
        groundingCandidates,
      }),
      pricing_notice: buildGroundingFallbackPricingNotice(),
      city_candidates: cityCandidates,
      hotel_candidates: hotelCandidates,
      grounding_fallback_matches: groundingFallbackSection,
      city_inventory_shortlist: null,
      direct_hotel_matches: null,
      applied_preferences: null,
      comparison_method: groundingFallbackSection.comparison_method,
      selection_guide: groundingFallbackSection.selection_guide,
      agent_brief: agentBrief,
      count: groundingFallbackSection.count,
      total_matches: groundingFallbackSection.total_matches,
      next_offset: groundingFallbackSection.next_offset,
      results: groundingFallbackSection.results,
    },
  });
}

function buildHotelClusterSignal(hotelCandidates = []) {
  const candidates = asArray(hotelCandidates).filter(Boolean);
  if (candidates.length < 2) {
    return null;
  }

  const cityBuckets = new Map();
  const brandBuckets = new Map();

  for (const candidate of candidates) {
    const cityName = firstNonEmpty(candidate?.city?.city_name_en, candidate?.city?.city_name);
    if (cityName) {
      cityBuckets.set(cityName, (cityBuckets.get(cityName) || 0) + 1);
    }

    const brandName = firstNonEmpty(candidate?.brand?.name_en, candidate?.brand?.name);
    if (brandName) {
      brandBuckets.set(brandName, (brandBuckets.get(brandName) || 0) + 1);
    }
  }

  const dominantCity = [...cityBuckets.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const dominantBrand = [...brandBuckets.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  return {
    candidate_hotel_count: candidates.length,
    dominant_city: dominantCity
      ? {
          city_name: dominantCity[0],
          share: roundScore((dominantCity[1] / candidates.length) * 100),
        }
      : null,
    dominant_brand: dominantBrand
      ? {
          brand_name: dominantBrand[0],
          share: roundScore((dominantBrand[1] / candidates.length) * 100),
        }
      : null,
    sample_hotels: candidates.slice(0, 3).map((candidate) => ({
      hotel_id: candidate.hotel_id,
      hotel_name: candidate.hotel_name_en || candidate.hotel_name,
      match_type: candidate?.match?.match_type || null,
    })),
  };
}

function refineSearchRouteDecision(routeDecision, { source, cityCandidates, hotelCandidates }) {
  if (source !== "query" || routeDecision?.recommended_route !== "direct_hotel") {
    return routeDecision;
  }

  const candidates = asArray(hotelCandidates).filter(Boolean);
  if (candidates.length <= 1) {
    return routeDecision;
  }

  const topScore = candidates[0]?.match?.relevance_score ?? 0;
  const secondScore = candidates[1]?.match?.relevance_score ?? 0;
  const topCityName = firstNonEmpty(candidates[0]?.city?.city_name_en, candidates[0]?.city?.city_name);
  const sameCityCount = candidates.filter(
    (candidate) =>
      firstNonEmpty(candidate?.city?.city_name_en, candidate?.city?.city_name) === topCityName
  ).length;
  const clusterSignal = buildHotelClusterSignal(candidates);

  if (topScore >= 100) {
    return routeDecision;
  }

  if (topScore >= 88 && secondScore <= 64) {
    return routeDecision;
  }

  if (asArray(cityCandidates).length === 0 && sameCityCount >= 2) {
    return {
      detected_intent: "cluster",
      recommended_route: "ambiguous_review",
      confidence: topScore >= 84 ? "medium" : "low",
      reason:
        "The query resolved to multiple same-city hotel candidates, so it behaves more like an area or clustered hotel search than a single exact property lookup.",
      cluster_signal: clusterSignal,
    };
  }

  if (secondScore >= 72) {
    return {
      detected_intent: "ambiguous",
      recommended_route: "ambiguous_review",
      confidence: "medium",
      reason:
        "Multiple hotel identities matched strongly enough that the shortlist should be reviewed before assuming one exact intended property.",
      cluster_signal: clusterSignal,
    };
  }

  return routeDecision;
}

function buildQueryResolution({
  source,
  query,
  cityId,
  cityName,
  routeDecision,
  cityCandidates,
  hotelCandidates,
  groundingCandidates = [],
}) {
  const agentInterpretation =
    routeDecision.recommended_route === "city_inventory"
      ? "destination_inventory"
      : routeDecision.recommended_route === "direct_hotel"
        ? "single_hotel_lookup"
        : routeDecision.recommended_route === "ambiguous_review"
          ? "hotel_cluster_review"
          : routeDecision.recommended_route === "grounding_review"
            ? "grounded_hotel_review"
          : "no_match";

  return {
    source,
    input_query: query || cityName || null,
    explicit_city_id: cityId || null,
    detected_intent: routeDecision.detected_intent,
    confidence: routeDecision.confidence,
    recommended_route: routeDecision.recommended_route,
    agent_interpretation: agentInterpretation,
    should_assume_single_hotel: routeDecision.recommended_route === "direct_hotel",
    should_compare_multiple_hotels:
      routeDecision.recommended_route === "ambiguous_review" ||
      (routeDecision.recommended_route === "grounding_review" && asArray(groundingCandidates).length > 1),
    reason: routeDecision.reason,
    candidate_counts: {
      city_candidates: asArray(cityCandidates).length,
      hotel_candidates: asArray(hotelCandidates).length,
      grounding_candidates: asArray(groundingCandidates).length,
    },
    cluster_signal: routeDecision.cluster_signal || buildHotelClusterSignal(hotelCandidates),
    top_city_candidate: cityCandidates[0] || null,
    top_hotel_candidate: hotelCandidates[0] || null,
    top_grounding_candidate: groundingCandidates[0] || null,
    grounding_fallback_applied: routeDecision.recommended_route === "grounding_review",
  };
}

function buildRoomPricingNotice() {
  return {
    display_total_field: "display_total_cny",
    supplier_total_field: "supplier_total_cny",
    service_fee_field: "service_fee_cny",
    note:
      "Current Bitvoya web checkout uses total_with_service_fee when present. Guarantee flows are currently treated as split payment when a service fee exists.",
  };
}

function parseDateOnlyToUtcMs(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildStayDateValidation(checkin, checkout) {
  const now = new Date();
  const serverToday = now.toISOString().slice(0, 10);
  const todayMs = Date.parse(`${serverToday}T00:00:00Z`);
  const checkinMs = parseDateOnlyToUtcMs(checkin);
  const checkoutMs = parseDateOnlyToUtcMs(checkout);
  const validFormat = checkinMs !== null && checkoutMs !== null;
  const chronological = validFormat ? checkoutMs > checkinMs : null;
  const nights =
    validFormat && chronological ? Math.round((checkoutMs - checkinMs) / 86400000) : null;
  const checkinInPast = validFormat ? checkinMs < todayMs : null;
  const checkoutInPast = validFormat ? checkoutMs <= todayMs : null;

  return {
    server_today: serverToday,
    valid_format: validFormat,
    chronological,
    nights,
    checkin_in_past: checkinInPast,
    checkout_in_past_or_today: checkoutInPast,
    status: !validFormat
      ? "invalid_format"
      : !chronological
        ? "invalid_range"
        : checkinInPast
          ? "past_stay"
          : "future_or_current_stay",
  };
}

function summarizeTopLabels(items, field, limit = 3) {
  return asArray(items)
    .map((item) => item?.[field])
    .filter(Boolean)
    .slice(0, limit)
    .join(", ");
}

async function searchGroundedHotelRows(db, { query, city_name, limit }) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = tokenizeSearchIdentity(query);
  const searchTerms = Array.from(new Set(tokens.length > 0 ? tokens : [normalizedQuery])).filter(Boolean);

  if (!normalizedQuery || searchTerms.length === 0) {
    return [];
  }

  const cityNeedle = city_name ? `%${normalizeSearchText(city_name)}%` : null;
  const whereClauses = searchTerms.map(
    () =>
      "(" +
      "LOWER(hotel_name) LIKE ? OR " +
      "LOWER(COALESCE(brand_name, '')) LIKE ? OR " +
      "LOWER(COALESCE(city_name, '')) LIKE ? OR " +
      "LOWER(COALESCE(hotel_area_character, '')) LIKE ? OR " +
      "LOWER(COALESCE(hotel_transport_summary, '')) LIKE ? OR " +
      "LOWER(COALESCE(why_stay_here, '')) LIKE ? OR " +
      "LOWER(COALESCE(agent_planning_notes, '')) LIKE ?" +
      ")"
  );
  const params = [];

  for (const term of searchTerms) {
    const needle = `%${term}%`;
    params.push(needle, needle, needle, needle, needle, needle, needle);
  }

  const fetchLimit = Math.max(limit * 20, 40);
  const rows = await db.query(
    `
      SELECT
        source_hotel_id,
        source_city_id,
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
        why_not_stay_here,
        hotel_luxury_fit_reason,
        hotel_family_fit_reason,
        hotel_couple_fit_reason,
        hotel_business_fit_reason,
        hotel_short_stay_fit_reason,
        hotel_long_stay_fit_reason,
        hotel_area_character,
        hotel_transport_summary,
        hotel_tradeoff_notes,
        agent_planning_notes
      FROM vw_tripwiki_hotel_grounding_card
      WHERE
        (${whereClauses.join(" OR ")})
        AND (? IS NULL OR LOWER(COALESCE(city_name, '')) LIKE ?)
      ORDER BY
        COALESCE(review_score, 0) DESC,
        COALESCE(star_rating, 0) DESC,
        COALESCE(review_count, 0) DESC,
        COALESCE(base_nightly_price, 0) DESC,
        hotel_name ASC
      LIMIT ?
    `,
    [...params, cityNeedle, cityNeedle, fetchLimit]
  );

  const rankedRows = rows
    .map((row) => ({
      row,
      signal: buildGroundedHotelQuerySignal(row, query),
    }))
    .filter((item) => item.signal?.score !== null)
    .sort((a, b) => {
      if (a.signal.score !== b.signal.score) return a.signal.score - b.signal.score;
      const relevanceDelta =
        (b.signal?.query_match?.relevance_score || 0) - (a.signal?.query_match?.relevance_score || 0);
      if (relevanceDelta !== 0) return relevanceDelta;
      const semanticCoverageDelta =
        (b.signal?.semantic_context?.weighted_coverage || 0) - (a.signal?.semantic_context?.weighted_coverage || 0);
      if (semanticCoverageDelta !== 0) return semanticCoverageDelta;
      const reviewScoreDelta = (asNullableNumber(b.row?.review_score) || 0) - (asNullableNumber(a.row?.review_score) || 0);
      if (reviewScoreDelta !== 0) return reviewScoreDelta;
      const starDelta = (asNullableNumber(b.row?.star_rating) || 0) - (asNullableNumber(a.row?.star_rating) || 0);
      if (starDelta !== 0) return starDelta;
      return String(a.row?.hotel_name || "").localeCompare(String(b.row?.hotel_name || ""));
    });

  const topScore = rankedRows[0]?.signal?.score ?? null;
  const scoreWindow = topScore === null ? null : topScore < 2 ? 0.6 : 0.35;

  return rankedRows
    .filter((item) => (topScore === null || scoreWindow === null ? true : item.signal.score <= topScore + scoreWindow))
    .slice(0, limit)
    .map((item) => ({
      ...item.row,
      __grounding_query_match: item.signal.query_match,
      __grounding_semantic_context: item.signal.semantic_context,
    }));
}

export async function searchHotelsGrounding(db, { query, city_name, limit }) {
  const rows = await searchGroundedHotelRows(db, { query, city_name, limit });
  const results = rows.map((row) => mapHotelGroundingSearchRow(row, query));

  return buildAgenticToolResult({
    tool: "search_hotels_grounding",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "hotel_grounding_discovery",
    summary:
      results.length > 0
        ? `Found ${results.length} grounded hotel cards for "${query}". Top matches: ${summarizeTopLabels(results, "hotel_name")}.`
        : `No grounded hotel cards matched "${query}".`,
    recommended_next_tools:
      results.length > 0
        ? [
            buildNextTool("get_hotel_grounding", "Open one hotel's full planner-grade grounding card.", [
              "source_hotel_id or tripwiki_hotel_id or hotel_name",
            ]),
            buildNextTool("get_hotel_detail", "Move from grounding into the live Bitvoya hotel payload.", [
              "hotel_id",
            ]),
          ]
        : [
            buildNextTool("search_destination_suggestions", "Try live destination suggestion resolution as a fallback.", [
              "query",
            ]),
          ],
    entity_refs: {
      hotel_ids: results.map((row) => row.source_hotel_id),
      tripwiki_hotel_ids: results.map((row) => row.tripwiki_hotel_id),
    },
    data: {
      query,
      city_name: city_name || null,
      count: results.length,
      results,
    },
  });
}

export async function searchHotels(api, db, params) {
  const query = String(params.query || "").trim();
  const cityId = normalizeId(params.city_id);
  const cityName = String(params.city_name || "").trim() || null;
  const limit = params.limit || 5;
  const offset = params.offset || 0;
  const source = cityId ? "city_id" : cityName ? "city_name" : "query";
  const candidateLimit = Math.max(3, Math.min(limit || 5, 5));

  const stayContext =
    params.checkin && params.checkout
      ? {
          checkin: params.checkin,
          checkout: params.checkout,
          adult_num: params.adult_num || 2,
        }
      : null;
  const stayDateValidation = stayContext
    ? buildStayDateValidation(stayContext.checkin, stayContext.checkout)
    : null;

  let searchStrategy = null;
  let resolvedCity = null;
  let cityCandidates = [];
  let hotelSeedRows = [];
  let hotelCandidates = [];
  let cityInventorySection = null;
  let directHotelSection = null;
  let exposeCityInventorySection = false;
  let exposeDirectHotelSection = false;
  const liveWarnings = [];

  if (source === "city_id") {
    resolvedCity = { id: cityId, name: cityName, nameEn: null };
    searchStrategy = query ? "city_inventory_filtered" : "city_inventory";

    const cityGroundingMap = await getCityGroundingSnapshotMap(db, [cityId]);
    let cityHotels = [];
    try {
      cityHotels = await api.searchHotelsByCity(cityId);
    } catch (error) {
      if (!isLikelyTransientLiveError(error)) {
        throw error;
      }

      liveWarnings.push(`Live city inventory timed out for city_id ${cityId}: ${summarizeLiveError(error)}`);
      cityHotels = [];
    }

    cityCandidates = [buildExplicitCityCandidateRow(resolvedCity, cityGroundingMap.get(cityId) || null)];
    exposeCityInventorySection = cityHotels.length > 0;
    if (cityHotels.length > 0) {
      cityInventorySection = await buildRankedHotelSection(
        api,
        db,
        query ? filterHotelsByQuery(cityHotels, query) : cityHotels,
        params,
        {
          query,
          stayContext,
          matchSource: searchStrategy,
          offset,
          limit,
          enableQueryRelevance: Boolean(query),
          sectionType: "city_inventory_shortlist",
        }
      );
    }
  } else if (source === "city_name") {
    const rawCityCandidates = await api.searchCitiesOnly(cityName).catch(() => []);
    const suggest =
      asArray(rawCityCandidates).length > 0
        ? { cities: [], hotels: [] }
        : await api.searchSuggest(cityName).catch(() => ({ cities: [], hotels: [] }));
    const mergedCityCandidates = mergeCityCandidateSeeds(rawCityCandidates, suggest.cities);
    cityCandidates = await buildCityCandidateRows(db, mergedCityCandidates, cityName, candidateLimit);
    resolvedCity = normalizeResolvedCityCandidate(selectBestCityCandidate(mergedCityCandidates, cityName));

    if (!resolvedCity) {
      const routeDecision = {
        detected_intent: "unknown",
        recommended_route: "no_match",
        confidence: "low",
        reason: `No live city candidate was resolved for "${cityName}".`,
      };

      return buildAgenticToolResult({
        tool: "search_hotels",
        status: "not_found",
        intent: "hotel_inventory_discovery",
        summary: `No live city candidate was resolved for "${cityName}", so hotel inventory could not be searched.`,
        recommended_next_tools: [
          buildNextTool("search_cities_live", "Resolve a valid Bitvoya city id first.", ["keyword"]),
          buildNextTool("search_destination_suggestions", "Try mixed city/hotel suggestion resolution.", ["query"]),
        ],
        data: {
          search_context: buildSearchContext({
            query,
            cityId,
            cityName,
            resolvedCity: null,
            strategy: "city_not_found",
            offset,
            limit,
            stayContext,
          }),
          query_resolution: buildQueryResolution({
            source,
            query,
            cityId,
            cityName,
            routeDecision,
            cityCandidates,
            hotelCandidates: [],
          }),
          pricing_notice: buildSearchPricingNotice(stayContext),
          city_candidates: cityCandidates,
          hotel_candidates: [],
          city_inventory_shortlist: null,
          direct_hotel_matches: null,
          count: 0,
          total_matches: 0,
          next_offset: null,
          results: [],
        },
      });
    }

    let cityHotels = [];
    let cityInventoryTimedOut = false;
    let cityInventoryError = null;
    try {
      cityHotels = await api.searchHotelsByCity(resolvedCity.id);
    } catch (error) {
      if (!isLikelyTransientLiveError(error)) {
        throw error;
      }

      cityInventoryTimedOut = true;
      cityInventoryError = error;
      liveWarnings.push(
        `Live city inventory timed out for ${resolvedCity.name || cityName}: ${summarizeLiveError(error)}`
      );
    }

    if (cityHotels.length > 0) {
      const filteredCityHotels = query ? filterHotelsByQuery(cityHotels, query) : cityHotels;
      const effectiveCityHotels =
        query && filteredCityHotels.length > 0 ? filteredCityHotels : cityHotels;

      searchStrategy =
        query && filteredCityHotels.length > 0 ? "city_inventory_filtered" : "city_inventory";
      exposeCityInventorySection = true;
      cityInventorySection = await buildRankedHotelSection(api, db, effectiveCityHotels, params, {
        query,
        stayContext,
        matchSource: searchStrategy,
        offset,
        limit,
        enableQueryRelevance: Boolean(query),
        sectionType: "city_inventory_shortlist",
      });

      if (query) {
        hotelSeedRows = buildHotelCandidateSeedRows(
          effectiveCityHotels,
          query,
          Math.max(candidateLimit, offset + limit)
        );
        hotelCandidates = buildHotelCandidateRows(hotelSeedRows, cityInventorySection, candidateLimit);
      }
    } else if (cityInventoryTimedOut) {
      const groundingQuery = query || cityName;
      const groundingRows = await searchGroundedHotelRows(db, {
        query: groundingQuery,
        city_name: resolvedCity.name || cityName,
        limit: Math.max(limit + offset, candidateLimit, 8),
      });
      const groundingCandidates = groundingRows.map((row) => mapHotelGroundingSearchRow(row, groundingQuery));

      if (groundingCandidates.length > 0) {
        return buildGroundingRecoveryResult({
          query: groundingQuery,
          cityId,
          cityName,
          source,
          offset,
          limit,
          stayContext,
          cityCandidates,
          hotelCandidates,
          groundingCandidates,
          params,
          searchStrategy: "grounding_timeout_recovery",
          summaryPrefix: `Live city inventory timed out for "${resolvedCity.name || cityName}", so the answer was recovered through grounding.`,
          warningMessage:
            `Live Bitvoya city inventory timed out while searching ${resolvedCity.name || cityName}; grounding was used as a temporary recovery layer.`,
        });
      }

      cityInventorySection = {
        section_type: "city_inventory_shortlist",
        summary: `Live city inventory timed out for ${resolvedCity.name || cityName}, so no live hotel rows could be ranked yet.`,
        applied_preferences: buildRoundedAppliedPreferences(
          resolveHotelComparisonPreferences(params, stayContext || null)
        ),
        comparison_method: {
          type: "live_city_inventory_timeout",
          score_scale: "unavailable",
          price_dimension: "unavailable",
          note: "Live city inventory timed out before ranking could be completed.",
        },
        selection_guide: {},
        count: 0,
        total_matches: 0,
        next_offset: null,
        results: [],
        ranked: [],
      };
      exposeCityInventorySection = true;
      searchStrategy = "city_inventory_timeout";
    }
  } else {
    const [rawCityCandidates, suggest] = await Promise.all([
      api.searchCitiesOnly(query).catch(() => []),
      api.searchSuggest(query),
    ]);

    const mergedCityCandidates = mergeCityCandidateSeeds(rawCityCandidates, suggest.cities);
    cityCandidates = await buildCityCandidateRows(db, mergedCityCandidates, query, candidateLimit);
    hotelSeedRows = buildHotelCandidateSeedRows(
      suggest.hotels,
      query,
      Math.max(candidateLimit, offset + limit)
    );

    const routeDecision = resolveSearchRoute({
      source,
      cityCandidates,
      hotelCandidates: hotelSeedRows,
    });
    const topCityCandidate = cityCandidates[0] || null;
    const topHotelCandidate = hotelSeedRows[0] || null;
    const expandCityInventory = shouldExpandCityInventory({
      source,
      routeDecision,
      topCityCandidate,
    });
    const expandDirectHotels = shouldExpandDirectHotels({
      source,
      routeDecision,
      topHotelCandidate,
    });
    exposeCityInventorySection = expandCityInventory;
    exposeDirectHotelSection = expandDirectHotels;

    const tasks = [];

    if (expandCityInventory && topCityCandidate?.city_id) {
      resolvedCity = {
        id: topCityCandidate.city_id,
        name: topCityCandidate.city_name,
        nameEn: topCityCandidate.city_name_en,
      };
      searchStrategy = "city_inventory_from_query";
      tasks.push(
        (async () => {
          try {
            const cityHotels = await api.searchHotelsByCity(topCityCandidate.city_id);
            cityInventorySection = await buildRankedHotelSection(api, db, cityHotels, params, {
              query,
              stayContext,
              matchSource: searchStrategy,
              offset,
              limit,
              enableQueryRelevance: false,
              sectionType: "city_inventory_shortlist",
            });
          } catch (error) {
            if (!isLikelyTransientLiveError(error)) {
              throw error;
            }

            liveWarnings.push(
              `Live city inventory timed out for ${topCityCandidate.city_name || query}: ${summarizeLiveError(error)}`
            );
          }
        })()
      );
    }

    if (hotelSeedRows.length > 0) {
      tasks.push(
        (async () => {
          try {
            const directHotels = await loadHotelDetailsForSuggestions(
              api,
              hotelSeedRows.slice(0, Math.max(limit + offset, candidateLimit)).map((row) => row.hotel)
            );
            directHotelSection = await buildRankedHotelSection(api, db, directHotels, params, {
              query,
              stayContext,
              matchSource: "hotel_suggestions",
              offset,
              limit,
              enableQueryRelevance: true,
              sectionType: "direct_hotel_matches",
            });
          } catch (error) {
            if (!isLikelyTransientLiveError(error)) {
              throw error;
            }

            liveWarnings.push(
              `Live hotel detail expansion timed out for "${query}": ${summarizeLiveError(error)}`
            );
          }
        })()
      );
    }

    await Promise.all(tasks);
    hotelCandidates = buildHotelCandidateRows(hotelSeedRows, directHotelSection, candidateLimit);
    const refinedRouteDecision = refineSearchRouteDecision(routeDecision, {
      source,
      cityCandidates,
      hotelCandidates,
    });

    if (!topCityCandidate && !topHotelCandidate) {
      const groundingRows = await searchGroundedHotelRows(db, {
        query,
        city_name: null,
        limit: Math.max(limit + offset, candidateLimit, 8),
      });
      const groundingCandidates = groundingRows.map((row) => mapHotelGroundingSearchRow(row, query));

      if (groundingCandidates.length > 0) {
        return buildGroundingRecoveryResult({
          query,
          cityId,
          cityName,
          source,
          offset,
          limit,
          stayContext,
          cityCandidates,
          hotelCandidates,
          groundingCandidates,
          params,
          searchStrategy: "grounding_fallback",
          summaryPrefix: `No live city or hotel match was found for "${query}", so the answer was recovered through grounding.`,
          warningMessage:
            "Live Bitvoya suggest returned no direct city or hotel match, so this response was recovered from grounding.",
        });
      }

      return buildAgenticToolResult({
        tool: "search_hotels",
        status: "not_found",
        intent: "hotel_inventory_discovery",
        summary: `No live city or hotel match was found for "${query}".`,
        recommended_next_tools: [
          buildNextTool("search_destination_suggestions", "Resolve the query through the Bitvoya suggest index.", [
            "query",
          ]),
          buildNextTool("search_hotels_grounding", "Check whether the hotel exists in the grounding layer.", [
            "query",
          ]),
        ],
        data: {
          search_context: buildSearchContext({
            query,
            cityId,
            cityName,
            resolvedCity: null,
            strategy: "no_live_match",
            offset,
            limit,
            stayContext,
          }),
          query_resolution: buildQueryResolution({
            source,
            query,
            cityId,
            cityName,
            routeDecision: refinedRouteDecision,
            cityCandidates,
            hotelCandidates,
          }),
          pricing_notice: buildSearchPricingNotice(stayContext),
          city_candidates: cityCandidates,
          hotel_candidates: hotelCandidates,
          city_inventory_shortlist: null,
          direct_hotel_matches: null,
          count: 0,
          total_matches: 0,
          next_offset: null,
          results: [],
        },
      });
    }

    if (refinedRouteDecision.recommended_route === "direct_hotel") {
      const liveTopRelevance = hotelCandidates[0]?.match?.relevance_score ?? 0;
      if (hotelCandidates.length === 1 && liveTopRelevance <= 72) {
        const groundingRows = await searchGroundedHotelRows(db, {
          query,
          city_name: null,
          limit: Math.max(limit + offset, candidateLimit, 8),
        });
        const groundingCandidates = groundingRows.map((row) => mapHotelGroundingSearchRow(row, query));

        if (
          shouldPreferGroundingClusterReview({
            routeDecision: refinedRouteDecision,
            hotelCandidates,
            groundingCandidates,
          })
        ) {
          return buildGroundingRecoveryResult({
            query,
            cityId,
            cityName,
            source,
            offset,
            limit,
            stayContext,
            cityCandidates,
            hotelCandidates,
            groundingCandidates,
            params,
            searchStrategy: "grounding_area_recovery",
            summaryPrefix:
              `Live suggest only exposed a thin single-hotel match for "${query}", so the answer was widened with grounding context.`,
            warningMessage:
              "The live suggest layer looked overly narrow for this query, so the response was widened with grounding context before assuming a single hotel.",
          });
        }
      }
    }

    if (refinedRouteDecision.recommended_route !== routeDecision.recommended_route) {
      searchStrategy = `${searchStrategy || routeDecision.recommended_route}_refined`;
    }
  }

  const baseRouteDecision = resolveSearchRoute({
    source,
    cityCandidates,
    hotelCandidates: hotelCandidates.length > 0 ? hotelCandidates : hotelSeedRows,
  });
  const routeDecision = refineSearchRouteDecision(baseRouteDecision, {
    source,
    cityCandidates,
    hotelCandidates: hotelCandidates.length > 0 ? hotelCandidates : hotelSeedRows,
  });

  if (hotelCandidates.length === 0 && hotelSeedRows.length > 0) {
    hotelCandidates = buildHotelCandidateRows(hotelSeedRows, directHotelSection, candidateLimit);
  }

  if (!cityInventorySection && !directHotelSection && liveWarnings.length > 0) {
    const groundingQuery = query || cityName;
    if (groundingQuery) {
      const groundingRows = await searchGroundedHotelRows(db, {
        query: groundingQuery,
        city_name: cityName || null,
        limit: Math.max(limit + offset, candidateLimit, 8),
      });
      const groundingCandidates = groundingRows.map((row) => mapHotelGroundingSearchRow(row, groundingQuery));

      if (groundingCandidates.length > 0) {
        return buildGroundingRecoveryResult({
          query: groundingQuery,
          cityId,
          cityName,
          source,
          offset,
          limit,
          stayContext,
          cityCandidates,
          hotelCandidates,
          groundingCandidates,
          params,
          searchStrategy: "grounding_timeout_recovery",
          summaryPrefix: `Live Bitvoya inventory timed out while resolving "${groundingQuery}", so the answer was recovered through grounding.`,
          warningMessage: liveWarnings[0],
        });
      }
    }
  }

  const activeSection =
    routeDecision.recommended_route === "direct_hotel"
      ? directHotelSection || cityInventorySection
      : routeDecision.recommended_route === "ambiguous_review"
        ? directHotelSection || cityInventorySection
        : cityInventorySection || directHotelSection;
  const combinedResults = [
    ...asArray(cityInventorySection?.results),
    ...asArray(directHotelSection?.results),
  ];
  const assumptions = [];

  if (!stayContext) {
    assumptions.push(
      "Without checkin/checkout, shortlist ranking uses static context and search-stage pricing only."
    );
  }

  if (params.require_free_cancellation) {
    assumptions.push(
      "Free-cancellation preference cannot be confirmed at search stage; validate it with get_hotel_rooms or compare_hotels."
    );
  }

  if (params.payment_preference && params.payment_preference !== "any") {
    assumptions.push(
      "payment_preference biases the shortlist, but actual guarantee/prepay support must be validated on live rates."
    );
  }

  if (routeDecision.recommended_route === "ambiguous_review") {
    assumptions.push(
      "The query matched both destination and hotel signals; inspect query_resolution and both candidate sections before narrowing."
    );
  }

  const warnings = [...liveWarnings];
  if (stayDateValidation?.status === "past_stay") {
    warnings.push(
      `The supplied stay dates (${stayContext.checkin} to ${stayContext.checkout}) are already in the past relative to the MCP server date ${stayDateValidation.server_today}.`
    );
  } else if (stayDateValidation?.status === "invalid_range") {
    warnings.push(
      `The supplied stay range is invalid because checkout ${stayContext.checkout} is not after checkin ${stayContext.checkin}.`
    );
  } else if (stayDateValidation?.status === "invalid_format") {
    warnings.push("The supplied stay dates are not valid YYYY-MM-DD values.");
  }

  const liveTimeoutOnly =
    !(activeSection?.count || combinedResults.length > 0) &&
    liveWarnings.length > 0;
  const status =
    activeSection?.count || combinedResults.length > 0 || cityCandidates.length > 0 || hotelCandidates.length > 0
      ? liveTimeoutOnly
        ? "partial"
        : "ok"
      : "not_found";
  const queryResolution = buildQueryResolution({
    source,
    query,
    cityId,
    cityName,
    routeDecision,
    cityCandidates,
    hotelCandidates,
  });
  const searchContextResolvedCity =
    resolvedCity ||
    (cityCandidates[0]
      ? {
          id: cityCandidates[0].city_id,
          name: cityCandidates[0].city_name,
          nameEn: cityCandidates[0].city_name_en,
        }
      : null);
  const summary =
    liveTimeoutOnly
      ? source === "query"
        ? `Live Bitvoya inventory timed out while resolving "${query}", so no live shortlist was produced yet.`
        : `Live Bitvoya inventory timed out for ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId}, so no live shortlist was produced yet.`
      : source === "query"
        ? `Resolved "${query}" into ${cityCandidates.length} city candidate(s) and ${hotelCandidates.length} hotel candidate(s). ` +
          `Recommended route: ${routeDecision.recommended_route}.` +
          (activeSection?.count
            ? ` ${activeSection.summary}`
            : "")
        : source === "city_name" && query
          ? activeSection?.count
            ? `Resolved city input to ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId} and narrowed "${query}" to ${activeSection.count} ranked hotel result(s). Recommended route: ${routeDecision.recommended_route}. ${activeSection.summary}`
            : `Resolved city input to ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId}, but no ranked hotel result matched "${query}".`
        : cityInventorySection?.count
          ? `Resolved city input to ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId} and returned ${cityInventorySection.count} ranked hotel result(s). ${cityInventorySection.summary}`
          : `Resolved city input to ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId}, but no ranked hotel result was produced.`;
  const agentBrief = buildSearchAgentBrief({
    queryResolution,
    results: activeSection?.results || [],
    selectionGuide: activeSection?.selection_guide || null,
    stayContext,
    warnings: liveWarnings,
    cityCandidates,
  });

  return buildAgenticToolResult({
    tool: "search_hotels",
    status,
    intent: "hotel_inventory_discovery",
    summary,
    recommended_next_tools:
      activeSection?.count
        ? [
            buildNextTool("get_hotel_detail", "Inspect one shortlisted property's static and grounded detail before rate search.", [
              "hotel_id",
            ]),
            buildNextTool("get_hotel_profile", "Open the richer static property profile when shortlist differentiation is still weak.", [
              "hotel_id",
            ]),
            buildNextTool("get_hotel_rooms", "Check live rate inventory for one selected hotel.", [
              "hotel_id",
              "checkin",
              "checkout",
            ]),
            buildNextTool("compare_hotels", "Compare shortlisted hotels before narrowing to one property.", [
              "hotel_ids",
            ]),
          ]
        : liveTimeoutOnly
          ? [
              buildNextTool("search_hotels", "Retry the same hotel search after the transient live timeout.", [
                "query or city_name",
                "checkin",
                "checkout",
              ]),
              ...(query
                ? [
                    buildNextTool("search_hotels_grounding", "Use the grounding layer while live inventory is timing out.", [
                      "query",
                    ]),
                  ]
                : []),
            ]
        : [
            buildNextTool("search_destination_suggestions", "Resolve the query through the mixed suggest layer when live candidates are thin.", [
              "query",
            ]),
          ],
    warnings,
    pricing_notes: [
      "search_price.supplier_min_price_cny is only a search-stage supplier signal.",
      "Use get_hotel_rooms for checkout-relevant display_total_cny and service_fee_cny.",
    ],
    selection_hints: [
      "Start with results[].bitvoya_value_brief, benefit_brief, location_brief, and nearby_pois_brief before falling back to generic price-only narration.",
      "Read query_resolution.recommended_route first, then inspect both city_candidates and hotel_candidates when the query is ambiguous.",
      "Use city_inventory_shortlist when the input behaves like a destination search.",
      "Use direct_hotel_matches when the input behaves like a specific-property search.",
      "Use decision_brief.choose_reasons and tradeoffs to build shortlist explanations directly in the agent.",
      "Do not use search-stage prices as final payable totals.",
    ],
    assumptions,
    entity_refs: {
      city_ids: [
        cityId,
        resolvedCity?.id,
        ...cityCandidates.map((city) => city.city_id),
        ...combinedResults.map((hotel) => hotel?.city?.source_city_id),
      ],
      hotel_ids: [
        ...hotelCandidates.map((hotel) => hotel.hotel_id),
        ...combinedResults.map((hotel) => hotel.hotel_id),
      ],
      tripwiki_city_ids: [
        ...cityCandidates.map((city) => city?.grounding_excerpt?.tripwiki_city_id),
        ...combinedResults.map((hotel) => hotel?.city_grounding_excerpt?.tripwiki_city_id),
      ],
      tripwiki_hotel_ids: [
        ...hotelCandidates.map((hotel) => hotel?.grounding_excerpt?.tripwiki_hotel_id),
        ...combinedResults.map((hotel) => hotel?.grounding_excerpt?.tripwiki_hotel_id),
      ],
    },
    data: {
      search_context: buildSearchContext({
        query,
        cityId,
        cityName,
        resolvedCity: searchContextResolvedCity,
        strategy: searchStrategy || routeDecision.recommended_route,
        offset,
        limit,
        stayContext,
      }),
      date_validation: stayDateValidation,
      query_resolution: queryResolution,
      pricing_notice: buildSearchPricingNotice(stayContext),
      city_candidates: cityCandidates,
      hotel_candidates: hotelCandidates,
      city_inventory_shortlist: exposeCityInventorySection && cityInventorySection
        ? {
            summary: cityInventorySection.summary,
            resolved_city: searchContextResolvedCity,
            applied_preferences: cityInventorySection.applied_preferences,
            comparison_method: cityInventorySection.comparison_method,
            selection_guide: cityInventorySection.selection_guide,
            count: cityInventorySection.count,
            total_matches: cityInventorySection.total_matches,
            next_offset: cityInventorySection.next_offset,
            results: cityInventorySection.results,
          }
        : null,
      direct_hotel_matches: exposeDirectHotelSection && directHotelSection
        ? {
            summary: directHotelSection.summary,
            applied_preferences: directHotelSection.applied_preferences,
            comparison_method: directHotelSection.comparison_method,
            selection_guide: directHotelSection.selection_guide,
            count: directHotelSection.count,
            total_matches: directHotelSection.total_matches,
            next_offset: directHotelSection.next_offset,
            results: directHotelSection.results,
          }
        : null,
      applied_preferences: activeSection?.applied_preferences || null,
      comparison_method: activeSection?.comparison_method || null,
      selection_guide: activeSection?.selection_guide || null,
      agent_brief: agentBrief,
      count: activeSection?.count || 0,
      total_matches: activeSection?.total_matches || 0,
      next_offset: activeSection?.next_offset || null,
      results: activeSection?.results || [],
    },
  });
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

function normalizeHotelIdentityText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreHotelIdentityCandidate(candidate, hotelName, cityName = null) {
  const targetHotel = normalizeHotelIdentityText(hotelName);
  const candidateAlias = normalizeHotelIdentityText(firstNonEmpty(candidate?.alias, candidate?.hotel_name, candidate?.hotel_name_en));
  const candidateName = normalizeHotelIdentityText(firstNonEmpty(candidate?.entity_name, candidate?.hotel_name, candidate?.hotel_name_en));
  const targetCity = normalizeHotelIdentityText(cityName);
  const candidateCity = normalizeHotelIdentityText(candidate?.city_name);

  let score = 0;

  if (targetHotel && candidateAlias === targetHotel) score += 140;
  if (targetHotel && candidateName === targetHotel) score += 130;
  if (targetHotel && candidateAlias && (candidateAlias.includes(targetHotel) || targetHotel.includes(candidateAlias))) score += 70;
  if (targetHotel && candidateName && (candidateName.includes(targetHotel) || targetHotel.includes(candidateName))) score += 60;
  if (candidate?.source === "canonical") score += 18;
  if (Number(candidate?.is_primary) === 1) score += 10;

  if (targetCity && candidateCity) {
    if (candidateCity === targetCity) score += 30;
    else if (candidateCity.includes(targetCity) || targetCity.includes(candidateCity)) score += 18;
    else score -= 24;
  }

  return score;
}

async function findCanonicalHotelAliasCandidates(db, { hotel_name, city_name }, limit = 8) {
  const exact = normalizeSearchText(hotel_name);
  if (!exact) return [];

  const parts = exact.split(/\s+/).filter(Boolean);
  const fuzzyLike = `%${parts.join("%")}%`;
  const broadLike = `%${exact}%`;

  const rows = await db.query(
    `
      SELECT
        a.tripwiki_entity_id,
        a.entity_name,
        a.source_entity_key AS source_hotel_id,
        a.alias,
        a.locale,
        a.source,
        a.is_primary,
        h.tripwiki_hotel_id,
        h.source_city_id,
        h.city_name,
        h.hotel_name,
        JSON_UNQUOTE(JSON_EXTRACT(h.display_names_json, '$."en-US"')) AS hotel_name_en,
        h.star_rating,
        h.review_score
      FROM tripwiki_canonical_entity_aliases_v1 a
      LEFT JOIN tripwiki_canonical_hotels_v1 h
        ON h.source_hotel_id = a.source_entity_key
      WHERE a.entity_type = 'hotel'
        AND (
          LOWER(a.alias) = ?
          OR LOWER(a.entity_name) = ?
          OR LOWER(a.alias) LIKE ?
          OR LOWER(a.entity_name) LIKE ?
          OR LOWER(a.alias) LIKE ?
          OR LOWER(a.entity_name) LIKE ?
        )
      ORDER BY
        CASE
          WHEN LOWER(a.alias) = ? THEN 0
          WHEN LOWER(a.entity_name) = ? THEN 1
          ELSE 2
        END,
        COALESCE(h.star_rating, 0) DESC,
        COALESCE(h.review_score, 0) DESC
      LIMIT ?
    `,
    [exact, exact, broadLike, broadLike, fuzzyLike, fuzzyLike, exact, exact, Math.max(limit * 4, 12)]
  );

  return uniqueBy(
    rows
      .map((row) => ({
        ...row,
        match_score: scoreHotelIdentityCandidate(row, hotel_name, city_name),
      }))
      .filter((row) => row.source_hotel_id && row.match_score > 0)
      .sort((a, b) => b.match_score - a.match_score),
    (row) => row.source_hotel_id
  ).slice(0, limit);
}

async function findCanonicalHotelSuggestCandidate(api, { hotel_name, city_name }) {
  const hotelName = compactText(hotel_name, 200);
  if (!hotelName) return null;

  const queries = uniqueTexts(
    [
      hotelName,
      city_name && !normalizeSearchText(hotelName).includes(normalizeSearchText(city_name))
        ? `${city_name} ${hotelName}`
        : null,
    ],
    3
  );

  const seeded = [];
  for (const query of queries) {
    const suggest = await api.searchSuggest(query).catch(() => ({ hotels: [] }));
    seeded.push(
      ...asArray(suggest?.hotels).map((hotel) => ({
        hotel_id: normalizeId(hotel?.id),
        hotel_name: firstNonEmpty(hotel?.name),
        hotel_name_en: firstNonEmpty(hotel?.nameEn),
        code: normalizeId(hotel?.code),
        global_hotel_code: normalizeId(hotel?.globalHotelCode),
      }))
    );
  }

  const ranked = uniqueBy(
    seeded
      .map((hotel) => ({
        ...hotel,
        match_score: scoreHotelIdentityCandidate(hotel, hotel_name, city_name),
      }))
      .filter((hotel) => hotel.hotel_id && hotel.match_score > 0)
      .sort((a, b) => b.match_score - a.match_score),
    (hotel) => hotel.hotel_id
  );

  return ranked[0] || null;
}

async function resolveHotelIdentity(api, db, { hotel_id, hotel_name = null, city_name = null }) {
  const inputHotelId = normalizeId(hotel_id);
  const inputHotelName = compactText(hotel_name, 220);
  const inputCityName = compactText(city_name, 160);
  const notes = [];
  let hotel = null;
  let detailError = null;
  let resolutionStatus = "direct";
  let resolutionSource = "input_hotel_id";
  let resolvedHotelId = inputHotelId;
  let aliasCandidate = null;
  let suggestCandidate = null;

  try {
    hotel = await api.getHotelDetail(inputHotelId);
  } catch (error) {
    detailError = error;
  }

  if (hotel?.id) {
    resolvedHotelId = normalizeId(hotel.id);
    if (resolvedHotelId && inputHotelId && resolvedHotelId !== inputHotelId) {
      resolutionStatus = "remapped";
      resolutionSource = "live_detail";
      notes.push(`Live detail normalized hotel_id ${inputHotelId} to ${resolvedHotelId}.`);
    }

    return {
      input_hotel_id: inputHotelId,
      input_hotel_name: inputHotelName,
      input_city_name: inputCityName,
      resolved_hotel_id: resolvedHotelId,
      resolved_hotel_name: firstNonEmpty(hotel?.name, inputHotelName),
      resolved_hotel_name_en: firstNonEmpty(hotel?.nameEn),
      resolution_status: resolutionStatus,
      resolution_source: resolutionSource,
      notes,
      hotel,
      detail_error: detailError,
      alias_candidate: null,
      suggest_candidate: null,
    };
  }

  if (inputHotelName) {
    const aliasCandidates = await findCanonicalHotelAliasCandidates(db, {
      hotel_name: inputHotelName,
      city_name: inputCityName,
    }).catch(() => []);
    aliasCandidate = aliasCandidates[0] || null;

    if (aliasCandidate?.source_hotel_id) {
      resolvedHotelId = normalizeId(aliasCandidate.source_hotel_id);
      resolutionStatus = resolvedHotelId === inputHotelId ? "direct_name_match" : "remapped";
      resolutionSource = "tripwiki_alias";
      notes.push(
        `Recovered canonical Bitvoya hotel_id ${resolvedHotelId} from hotel_name "${inputHotelName}".`
      );
    } else {
      suggestCandidate = await findCanonicalHotelSuggestCandidate(api, {
        hotel_name: inputHotelName,
        city_name: inputCityName,
      }).catch(() => null);

      if (suggestCandidate?.hotel_id) {
        resolvedHotelId = suggestCandidate.hotel_id;
        resolutionStatus = resolvedHotelId === inputHotelId ? "direct_name_match" : "remapped";
        resolutionSource = "search_suggest";
        notes.push(
          `Recovered canonical Bitvoya hotel_id ${resolvedHotelId} from live hotel suggestion matching "${inputHotelName}".`
        );
      }
    }
  }

  if (resolvedHotelId && resolvedHotelId !== inputHotelId) {
    try {
      hotel = await api.getHotelDetail(resolvedHotelId);
      if (hotel?.id) {
        return {
          input_hotel_id: inputHotelId,
          input_hotel_name: inputHotelName,
          input_city_name: inputCityName,
          resolved_hotel_id: normalizeId(hotel.id),
          resolved_hotel_name: firstNonEmpty(hotel?.name, aliasCandidate?.hotel_name, suggestCandidate?.hotel_name, inputHotelName),
          resolved_hotel_name_en: firstNonEmpty(
            hotel?.nameEn,
            aliasCandidate?.hotel_name_en,
            suggestCandidate?.hotel_name_en
          ),
          resolution_status: resolutionStatus,
          resolution_source: resolutionSource,
          notes,
          hotel,
          detail_error: null,
          alias_candidate: aliasCandidate,
          suggest_candidate: suggestCandidate,
        };
      }
    } catch (error) {
      detailError = error;
    }
  }

  if (!detailError) {
    notes.push(
      inputHotelName
        ? `The provided hotel_id ${inputHotelId} did not resolve through /hotels/detail, even after hotel-name recovery.`
        : `The provided hotel_id ${inputHotelId} did not resolve through /hotels/detail.`
    );
  } else {
    notes.push(`Live detail lookup failed: ${compactText(detailError?.message, 180) || "unknown error"}`);
  }

  if (!inputHotelName) {
    notes.push(
      "If hotel_id came from a frontend page or foreign system, pass hotel_name and optional city_name so MCP can recover the canonical live-inventory hotel id."
    );
  }

  return {
    input_hotel_id: inputHotelId,
    input_hotel_name: inputHotelName,
    input_city_name: inputCityName,
    resolved_hotel_id: normalizeId(
      firstNonEmpty(
        hotel?.id,
        aliasCandidate?.source_hotel_id,
        suggestCandidate?.hotel_id,
        resolvedHotelId !== inputHotelId ? resolvedHotelId : null
      )
    ),
    resolved_hotel_name: firstNonEmpty(
      hotel?.name,
      aliasCandidate?.hotel_name,
      aliasCandidate?.entity_name,
      suggestCandidate?.hotel_name,
      inputHotelName
    ),
    resolved_hotel_name_en: firstNonEmpty(hotel?.nameEn, aliasCandidate?.hotel_name_en, suggestCandidate?.hotel_name_en),
    resolution_status: "unresolved",
    resolution_source: resolutionSource,
    notes,
    hotel,
    detail_error: detailError,
    alias_candidate: aliasCandidate,
    suggest_candidate: suggestCandidate,
  };
}

function hydrateHotelIdentity(normalizedHotel, identityResolution, nearbyPois = []) {
  const hydrated = {
    ...normalizedHotel,
    hotel_id: normalizeId(
      firstNonEmpty(
        normalizedHotel?.hotel_id,
        identityResolution?.resolved_hotel_id,
        identityResolution?.input_hotel_id
      )
    ),
    hotel_name: firstNonEmpty(
      normalizedHotel?.hotel_name,
      identityResolution?.resolved_hotel_name,
      identityResolution?.input_hotel_name
    ),
    hotel_name_en: firstNonEmpty(normalizedHotel?.hotel_name_en, identityResolution?.resolved_hotel_name_en),
  };

  hydrated.benefit_brief = buildHotelBenefitBrief(hydrated);
  hydrated.location_brief = buildHotelLocationBrief(hydrated);
  hydrated.bitvoya_value_brief = buildBitvoyaValueBrief(hydrated, nearbyPois);

  return hydrated;
}

function buildIdentityResolutionBrief(identityResolution) {
  if (!identityResolution) return null;

  const aliasCandidate = identityResolution.alias_candidate
    ? {
        source_hotel_id: normalizeId(identityResolution.alias_candidate.source_hotel_id),
        hotel_name: firstNonEmpty(
          identityResolution.alias_candidate.hotel_name,
          identityResolution.alias_candidate.entity_name
        ),
        hotel_name_en: firstNonEmpty(identityResolution.alias_candidate.hotel_name_en),
        city_name: firstNonEmpty(identityResolution.alias_candidate.city_name),
        match_score: asNullableNumber(identityResolution.alias_candidate.match_score),
      }
    : null;
  const suggestCandidate = identityResolution.suggest_candidate
    ? {
        hotel_id: normalizeId(identityResolution.suggest_candidate.hotel_id),
        hotel_name: firstNonEmpty(identityResolution.suggest_candidate.hotel_name),
        hotel_name_en: firstNonEmpty(identityResolution.suggest_candidate.hotel_name_en),
        code: normalizeId(identityResolution.suggest_candidate.code),
        global_hotel_code: normalizeId(identityResolution.suggest_candidate.global_hotel_code),
      }
    : null;

  return {
    input_hotel_id: identityResolution.input_hotel_id,
    input_hotel_name: identityResolution.input_hotel_name,
    input_city_name: identityResolution.input_city_name,
    resolved_hotel_id: identityResolution.resolved_hotel_id,
    resolved_hotel_name: identityResolution.resolved_hotel_name,
    resolved_hotel_name_en: identityResolution.resolved_hotel_name_en,
    resolution_status: identityResolution.resolution_status,
    resolution_source: identityResolution.resolution_source,
    notes: uniqueTexts(identityResolution.notes, 4),
    alias_candidate: aliasCandidate,
    suggest_candidate: suggestCandidate,
  };
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

  const hotel = mapHotelRow(row);
  const nearbyPois = poiRows.map(mapNearbyPoiRow);
  const nearbyPoisBrief = buildNearbyPoiBrief(nearbyPois);

  return buildAgenticToolResult({
    tool: "get_hotel_grounding",
    status: "ok",
    intent: "hotel_grounding",
    summary: `Loaded grounded hotel card for ${hotel.hotel_name} with ${nearbyPois.length} nearby POIs and traveler-fit notes.` +
      (nearbyPoisBrief?.headline ? ` ${nearbyPoisBrief.headline}` : ""),
    recommended_next_tools: [
      buildNextTool("get_hotel_detail", "Pair grounding with the live hotel detail payload.", ["hotel_id"]),
      buildNextTool("get_hotel_rooms", "Move from hotel fit assessment into live rate selection.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
    ],
    entity_refs: {
      hotel_ids: [hotel.source_hotel_id],
      city_ids: [hotel.source_city_id],
      tripwiki_hotel_ids: [hotel.tripwiki_hotel_id],
      tripwiki_city_ids: [hotel.tripwiki_city_id],
    },
    data: {
      hotel,
      nearby_pois: nearbyPois,
      nearby_pois_brief: nearbyPoisBrief,
      bitvoya_static_brief: {
        summary: "Bitvoya grounding clarifies hotel fit, area context, and nearby anchors before rate search.",
        selling_points: uniqueTexts(
          [hotel?.why_stay_here, hotel?.hotel_luxury_fit_reason, hotel?.hotel_transport_summary, nearbyPoisBrief?.headline],
          4
        ),
      },
    },
  });
}

export async function getHotelDetail(api, db, { hotel_id, hotel_name = null, city_name = null }) {
  const identityResolution = await resolveHotelIdentity(api, db, {
    hotel_id,
    hotel_name,
    city_name,
  });
  const hotel = identityResolution.hotel;
  const hotelId = normalizeId(
    firstNonEmpty(hotel?.id, identityResolution?.resolved_hotel_id, hotel_id)
  );
  const cityId = normalizeId(firstNonEmpty(hotel?.profiles?.CITY?.id, identityResolution?.alias_candidate?.source_city_id));

  const [groundingPayload, cityGroundingMap] = await Promise.all([
    getHotelGrounding(db, { source_hotel_id: hotelId }, 6).catch(() => null),
    getCityGroundingSnapshotMap(db, cityId ? [cityId] : []),
  ]);

  const nearbyPois = asArray(groundingPayload?.data?.nearby_pois || groundingPayload?.nearby_pois);
  const nearbyPoisBrief = buildNearbyPoiBrief(nearbyPois);
  const normalizedHotel = hydrateHotelIdentity(
    {
      ...normalizeHotelSummary(hotel, {
        grounding: groundingPayload?.data?.hotel || groundingPayload?.hotel || null,
        cityGrounding: cityId ? cityGroundingMap.get(cityId) || null : null,
        matchSource: "hotel_detail",
      }),
      nearby_pois_brief: nearbyPoisBrief,
    },
    identityResolution,
    nearbyPois
  );

  if (!hotel) {
    return buildAgenticToolResult({
      tool: "get_hotel_detail",
      status: "partial",
      intent: "hotel_evaluation",
      summary:
        `Live hotel detail could not resolve hotel_id ${hotel_id}.` +
        (identityResolution?.resolved_hotel_id && identityResolution.resolved_hotel_id !== hotel_id
          ? ` A canonical candidate ${identityResolution.resolved_hotel_id} was recovered, but live detail still did not load.`
          : "") +
        ` Do not present this as a hotel-quality judgment or sellout.`,
      recommended_next_tools: [
        buildNextTool("search_hotels", "Recover the canonical hotel id from hotel name or destination search before rate lookup.", [
          "query or city_name",
          "checkin",
          "checkout",
        ]),
        buildNextTool("get_hotel_grounding", "Keep the hotel usable via static grounding while canonical live identity is recovered.", [
          "source_hotel_id or hotel_name",
        ]),
      ],
      warnings: uniqueTexts(identityResolution?.notes, 4),
      selection_hints: [
        "When hotel_id may come from a frontend page or foreign system, also pass hotel_name and optional city_name so MCP can recover the canonical Bitvoya live id.",
        "Use grounding, benefits, and nearby POIs to keep the hotel in play while live identity is repaired.",
      ],
      entity_refs: {
        hotel_ids: [normalizeId(firstNonEmpty(identityResolution?.resolved_hotel_id, hotel_id))],
      },
      data: {
        found: false,
        hotel: normalizedHotel,
        hotel_detail: null,
        decision_brief: buildHotelDecisionBrief(normalizedHotel),
        benefit_brief: normalizedHotel.benefit_brief,
        location_brief: normalizedHotel.location_brief,
        nearby_pois_brief: nearbyPoisBrief,
        bitvoya_value_brief: normalizedHotel.bitvoya_value_brief,
        identity_resolution: buildIdentityResolutionBrief(identityResolution),
        grounding: groundingPayload?.data || groundingPayload,
        city_grounding_excerpt: cityId ? buildCityGroundingExcerpt(cityGroundingMap.get(cityId) || null) : null,
      },
    });
  }

  const hotelDetail = normalizeHotelDetailPayload(hotel);
  const decisionBrief = buildHotelDecisionBrief(normalizedHotel);
  const agentBrief = buildHotelDetailAgentBrief(normalizedHotel, decisionBrief);

  return buildAgenticToolResult({
    tool: "get_hotel_detail",
    status: "ok",
    intent: "hotel_evaluation",
    summary: `Loaded live hotel detail for ${normalizedHotel.hotel_name}.` +
      (identityResolution?.resolution_status === "remapped"
        ? ` Canonical live hotel_id recovered as ${normalizedHotel.hotel_id}.`
        : "") +
      (normalizedHotel?.benefit_brief?.headline ? ` ${normalizedHotel.benefit_brief.headline}` : "") +
      (nearbyPoisBrief?.count ? ` Bitvoya grounding adds ${nearbyPoisBrief.count} nearby POI anchor(s).` : "") +
      (normalizedHotel?.location_brief?.headline ? ` ${normalizedHotel.location_brief.headline}` : ""),
    recommended_next_tools: [
      buildNextTool("get_hotel_rooms", "Check live room and rate inventory before any booking step.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
      buildNextTool("compare_hotels", "Compare this hotel against shortlisted alternatives.", ["hotel_ids"]),
      buildNextTool("get_hotel_profile", "Open the richer static God Profile when more property context is needed.", [
        "hotel_id",
      ]),
      buildNextTool("get_hotel_media", "Fetch gallery assets for visual grounding.", ["hotel_id"]),
    ],
    selection_hints: [
      "Start with benefit_brief, location_brief, nearby_pois_brief, and bitvoya_value_brief before reducing the hotel to price or star rating.",
      "Use hotel.membership_benefits for a compact benefit summary.",
      "Use hotel_detail.benefits for the normalized underlying benefit arrays.",
      "Use decision_brief.choose_reasons and tradeoffs for agent-facing recommendation text.",
      "When hotel_id is suspect, pass hotel_name and optional city_name so MCP can recover the canonical live id instead of guessing.",
    ],
    warnings:
      identityResolution?.resolution_status === "remapped"
        ? uniqueTexts(identityResolution?.notes, 2)
        : [],
    entity_refs: {
      hotel_ids: [normalizedHotel.hotel_id],
      city_ids: [normalizedHotel?.city?.source_city_id],
      tripwiki_hotel_ids: [normalizedHotel?.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [normalizedHotel?.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      found: true,
      hotel: normalizedHotel,
      hotel_detail: hotelDetail,
      decision_brief: decisionBrief,
      benefit_brief: normalizedHotel.benefit_brief,
      location_brief: normalizedHotel.location_brief,
      nearby_pois_brief: nearbyPoisBrief,
      bitvoya_value_brief: normalizedHotel.bitvoya_value_brief,
      agent_brief: agentBrief,
      identity_resolution: buildIdentityResolutionBrief(identityResolution),
      grounding: groundingPayload?.data || groundingPayload,
      city_grounding_excerpt: cityId ? buildCityGroundingExcerpt(cityGroundingMap.get(cityId) || null) : null,
    },
  });
}

export async function getHotelRooms(api, db, params, options = {}) {
  const identityResolution = await resolveHotelIdentity(api, db, {
    hotel_id: params.hotel_id,
    hotel_name: params.hotel_name,
    city_name: params.city_name,
  });
  const liveLookupHotelId = normalizeId(
    firstNonEmpty(identityResolution?.resolved_hotel_id, params.hotel_id)
  );

  let hotel = identityResolution.hotel;
  let rooms = [];
  let liveRoomsError = null;
  let roomLookupError = null;

  if (liveLookupHotelId) {
    try {
      rooms = await api.getHotelRooms(
        {
          hotelId: liveLookupHotelId,
          checkin: params.checkin,
          checkout: params.checkout,
          adultNum: params.adult_num,
          childNum: params.child_num || 0,
          roomNum: params.room_num || 1,
        },
        {
          requestPrincipal: options.request_principal || null,
        }
      );
    } catch (error) {
      if (isLikelyTransientLiveError(error)) {
        liveRoomsError = error;
      } else {
        roomLookupError = error;
      }
    }
  }

  const hotelId = normalizeId(firstNonEmpty(hotel?.id, liveLookupHotelId, params.hotel_id));
  const cityId = normalizeId(
    firstNonEmpty(hotel?.profiles?.CITY?.id, identityResolution?.alias_candidate?.source_city_id)
  );

  const [groundingMap, cityGroundingMap, nearbyPoiMap] = await Promise.all([
    getHotelGroundingSnapshotMap(db, hotelId ? [hotelId] : []),
    getCityGroundingSnapshotMap(db, cityId ? [cityId] : []),
    getNearbyPoiSnapshotMap(db, hotelId ? [hotelId] : [], 6),
  ]);

  const nearbyPois = hotelId ? nearbyPoiMap.get(hotelId) || [] : [];
  const nearbyPoisBrief = buildNearbyPoiBrief(nearbyPois);
  const enrichedHotel = hydrateHotelIdentity(
    {
      ...normalizeHotelSummary(hotel, {
        grounding: hotelId ? groundingMap.get(hotelId) || null : null,
        cityGrounding: cityId ? cityGroundingMap.get(cityId) || null : null,
        matchSource: "hotel_rooms",
      }),
      nearby_pois_brief: nearbyPoisBrief,
    },
    identityResolution,
    nearbyPois
  );

  const normalizedRooms = asArray(rooms)
    .map((room) => normalizeRoom(room, params.rate_limit_per_room))
    .slice(0, params.room_limit);

  const flattenedRates = flattenRoomRates(normalizedRooms);
  const cheapestRate = sortByDisplayTotal(flattenedRates)[0];
  const rateRanking = rankRatesWithPreferences(flattenedRates, params);
  const selectionGuide = rateRanking.guide;
  const primaryRecommendation = rateRanking.ranked_rows[0] || null;
  const dateValidation = buildStayDateValidation(params.checkin, params.checkout);
  const noInventoryWarnings = [];
  const unresolvedIdentity = identityResolution?.resolution_status === "unresolved" && !hotel;
  const roomLookupErrorSummary = roomLookupError ? summarizeLiveError(roomLookupError) : null;

  if (!dateValidation.valid_format) {
    noInventoryWarnings.push(
      "The supplied stay dates are not valid YYYY-MM-DD values, so live inventory lookup may be unreliable."
    );
  } else if (!dateValidation.chronological) {
    noInventoryWarnings.push(
      `The stay range is invalid because checkout ${params.checkout} is not after checkin ${params.checkin}.`
    );
  } else if (dateValidation.checkin_in_past) {
    noInventoryWarnings.push(
      `The requested stay is in the past relative to the MCP server date ${dateValidation.server_today} (checkin ${params.checkin}, checkout ${params.checkout}).`
    );
  }

  if (identityResolution?.resolution_status === "remapped") {
    noInventoryWarnings.push(...uniqueTexts(identityResolution?.notes, 2));
  } else if (unresolvedIdentity) {
    noInventoryWarnings.push(...uniqueTexts(identityResolution?.notes, 3));
  }

  if (liveRoomsError) {
    noInventoryWarnings.push(
      `Live room inventory timed out for ${enrichedHotel.hotel_name}: ${summarizeLiveError(liveRoomsError)}`
    );
  }

  if (roomLookupErrorSummary) {
    noInventoryWarnings.push(
      `Live room inventory failed for ${enrichedHotel.hotel_name || `hotel_id ${params.hotel_id}`}: ${roomLookupErrorSummary}`
    );
  }

  const agentBrief = buildHotelRoomsAgentBrief({
    hotel: enrichedHotel,
    primaryRecommendation,
    selectionGuide: {
      recommended_rate: summarizeRankedRateRow(primaryRecommendation),
      cheapest: summarizeRateGuideEntry(selectionGuide.cheapest, "cheapest"),
      most_flexible: summarizeRateGuideEntry(selectionGuide.most_flexible, "most_flexible"),
      best_benefits: summarizeRateGuideEntry(selectionGuide.best_benefits, "best_benefits"),
      best_guarantee: summarizeRateGuideEntry(selectionGuide.best_guarantee, "best_guarantee"),
      best_prepay: summarizeRateGuideEntry(selectionGuide.best_prepay, "best_prepay"),
    },
    dateValidation,
    roomCount: normalizedRooms.length,
    inventoryError: liveRoomsError ? summarizeLiveError(liveRoomsError) : roomLookupErrorSummary,
    identityResolution,
  });

  const status =
    normalizedRooms.length > 0
      ? "ok"
      : liveRoomsError || roomLookupError || unresolvedIdentity
        ? "partial"
        : "not_found";
  const inventoryStatus =
    normalizedRooms.length > 0
      ? "available"
      : liveRoomsError
        ? "timeout"
        : roomLookupError
          ? "error"
          : unresolvedIdentity
            ? "identity_unresolved"
            : "empty";

  return buildAgenticToolResult({
    tool: "get_hotel_rooms",
    status,
    intent: "rate_selection",
    summary:
      normalizedRooms.length > 0
        ? `Loaded ${normalizedRooms.length} room options for ${enrichedHotel.hotel_name}.` +
          (identityResolution?.resolution_status === "remapped"
            ? ` Canonical live hotel_id recovered as ${enrichedHotel.hotel_id}.`
            : "") +
          (enrichedHotel?.benefit_brief?.headline ? ` ${enrichedHotel.benefit_brief.headline}` : "") +
          ` Cheapest current display total is ${cheapestRate?.rate?.pricing?.display_total_cny ?? "N/A"} CNY.` +
          (primaryRecommendation
            ? ` Top in-tool recommendation under ${rateRanking.applied_preferences.priority_profile}: ${primaryRecommendation.rate_name}.`
            : "")
        : liveRoomsError
          ? `Live room inventory timed out for ${enrichedHotel.hotel_name}.` +
            (enrichedHotel?.bitvoya_value_brief?.primary_angle
              ? ` Static value signal: ${compactText(enrichedHotel.bitvoya_value_brief.primary_angle, 180)}`
              : "") +
            ` Retry the live room lookup before concluding the hotel is unavailable.`
        : roomLookupError
          ? `Live room lookup failed for ${enrichedHotel.hotel_name || `hotel_id ${params.hotel_id}`}.` +
            ` The backend returned: ${roomLookupErrorSummary}.` +
            ` Do not present this as a clean no-inventory result.`
        : unresolvedIdentity
          ? `Live room lookup could not resolve hotel_id ${params.hotel_id} into a canonical Bitvoya hotel.` +
            (params.hotel_name
              ? ` Hotel name hint "${params.hotel_name}" still did not produce a live detail payload.`
              : "") +
            ` Do not present this as sold out.`
        : `No live room inventory was returned for ${enrichedHotel.hotel_name}.` +
          (enrichedHotel?.bitvoya_value_brief?.primary_angle
            ? ` Static value signal: ${compactText(enrichedHotel.bitvoya_value_brief.primary_angle, 180)}`
            : "") +
          (dateValidation.status === "past_stay"
            ? ` The requested stay dates (${params.checkin} to ${params.checkout}) are already in the past relative to the MCP server date ${dateValidation.server_today}.`
            : ""),
    recommended_next_tools:
      normalizedRooms.length > 0
        ? [
            buildNextTool("compare_rates", "Open the full scored rate comparison if the agent needs deeper tradeoff analysis.", [
              "hotel_id",
              "checkin",
              "checkout",
            ]),
            buildNextTool("prepare_booking_quote", "Freeze one selected hotel_id + room_id + rate_id combination before booking.", [
              "hotel_id",
              "room_id",
              "rate_id",
              "checkin",
              "checkout",
            ]),
            buildNextTool("get_hotel_detail", "Return to hotel-level fit and benefit context if needed.", ["hotel_id"]),
          ]
        : liveRoomsError || roomLookupError
          ? [
              buildNextTool("get_hotel_rooms", "Retry the live room inventory lookup for the same hotel and stay window.", [
                "hotel_id",
                "checkin",
                "checkout",
              ]),
              buildNextTool("compare_hotels", "If the traveler is date-fixed, compare alternatives while the broken live lookup is retried.", [
                "hotel_ids",
                "checkin",
                "checkout",
              ]),
              buildNextTool("get_hotel_detail", "Keep the hotel in play via static fit and benefit context while live rooms are retried.", ["hotel_id"]),
            ]
          : [
              buildNextTool("search_hotels", "Retry the search with a nearby future date range or pivot to alternative hotels in the same city.", [
                "query or city_name",
                "checkin",
                "checkout",
              ]),
              buildNextTool("compare_hotels", "Compare same-city alternatives for the same stay window when one property has no live inventory.", [
                "hotel_ids",
                "checkin",
                "checkout",
              ]),
            ],
    warnings: normalizedRooms.length > 0 ? [] : noInventoryWarnings,
    pricing_notes: [
      "display_total_cny is the guest-facing total aligned with current frontend semantics.",
      "supplier_total_cny and service_fee_cny stay explicit so agents can reason about guarantee vs prepay.",
    ],
    selection_hints: [
      "Start with hotel.benefit_brief, hotel.location_brief, hotel.nearby_pois_brief, and hotel.bitvoya_value_brief before collapsing the answer into pure rate math.",
      "Choose room_id from rooms[].room_id and rate_id from rooms[].rates[].rate_id.",
      "Do not call create_booking_intent directly from hotel selection or any search-context token. Run prepare_booking_quote first and then use the returned prepared_quote_id.",
      "Do not infer final payable totals from search-stage prices once live rates are available.",
      "Use selection_guide when the agent needs a fast cheapest vs flexible vs benefits-based recommendation.",
      "Pass priority_profile, payment_preference, require_free_cancellation, or prefer_benefits when the agent already knows traveler intent.",
      "When hotel_id may be non-canonical, also pass hotel_name and optional city_name so MCP can recover the canonical Bitvoya live id instead of guessing.",
    ],
    entity_refs: {
      hotel_ids: [enrichedHotel.hotel_id],
      city_ids: [enrichedHotel?.city?.source_city_id],
      room_ids: normalizedRooms.map((room) => room.room_id),
      rate_ids: normalizedRooms.flatMap((room) => asArray(room.rates).map((rate) => rate.rate_id)),
      tripwiki_hotel_ids: [enrichedHotel?.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [enrichedHotel?.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      found: normalizedRooms.length > 0,
      inventory_status: inventoryStatus,
      hotel: enrichedHotel,
      stay: {
        checkin: params.checkin,
        checkout: params.checkout,
        adult_num: params.adult_num,
        child_num: params.child_num || 0,
        room_num: params.room_num || 1,
      },
      date_validation: dateValidation,
      pricing_notice: buildRoomPricingNotice(),
      benefit_brief: enrichedHotel.benefit_brief,
      location_brief: enrichedHotel.location_brief,
      nearby_pois_brief: nearbyPoisBrief,
      bitvoya_value_brief: enrichedHotel.bitvoya_value_brief,
      agent_brief: agentBrief,
      identity_resolution: buildIdentityResolutionBrief(identityResolution),
      applied_preferences: buildRoundedAppliedPreferences(rateRanking.applied_preferences),
      comparison_method: rateRanking.comparison_method,
      selection_guide: {
        recommended_rate: summarizeRankedRateRow(primaryRecommendation),
        top_recommendations: rateRanking.ranked_rows.slice(0, 3).map(summarizeRankedRateRow),
        cheapest: summarizeRateGuideEntry(selectionGuide.cheapest, "cheapest"),
        most_flexible: summarizeRateGuideEntry(selectionGuide.most_flexible, "most_flexible"),
        best_benefits: summarizeRateGuideEntry(selectionGuide.best_benefits, "best_benefits"),
        best_guarantee: summarizeRateGuideEntry(selectionGuide.best_guarantee, "best_guarantee"),
        best_prepay: summarizeRateGuideEntry(selectionGuide.best_prepay, "best_prepay"),
      },
      total_room_options: asArray(rooms).length,
      room_limit_applied: params.room_limit,
      rate_limit_per_room: params.rate_limit_per_room,
      live_inventory_error: liveRoomsError ? summarizeLiveError(liveRoomsError) : roomLookupErrorSummary,
      rooms: normalizedRooms,
    },
  });
}

export async function compareHotels(api, db, params, options = {}) {
  const hotelIds = uniqueBy(
    asArray(params.hotel_ids).map((value) => normalizeId(value)).filter(Boolean),
    (value) => value
  );

  if (hotelIds.length < 2) {
    throw new Error("compare_hotels requires at least 2 hotel_ids.");
  }

  const stayContext =
    params.checkin && params.checkout
      ? {
          checkin: params.checkin,
          checkout: params.checkout,
          adult_num: params.adult_num || 2,
          child_num: params.child_num || 0,
          room_num: params.room_num || 1,
        }
      : null;

  const appliedPreferences = resolveHotelComparisonPreferences(params, stayContext);

  const compared = await Promise.all(
    hotelIds.map(async (hotelId) => {
      const detailPayload = await getHotelDetail(api, db, { hotel_id: hotelId });
      const detailData = detailPayload?.data || detailPayload;

      let liveRateSummary = null;
      let liveRateError = null;

      if (stayContext) {
        try {
          const rawRooms = await api.getHotelRooms({
            hotelId,
            checkin: stayContext.checkin,
            checkout: stayContext.checkout,
            adultNum: stayContext.adult_num,
            childNum: stayContext.child_num,
            roomNum: stayContext.room_num,
          }, {
            requestPrincipal: options.request_principal || null,
          });
          const normalizedRooms = asArray(rawRooms).map((room) => normalizeRoom(room, 8));
          liveRateSummary = summarizeLiveRateSnapshot(normalizedRooms);
        } catch (error) {
          liveRateError = error?.message || String(error);
        }
      }

      return {
        hotel: detailData.hotel,
        live_rate_summary: liveRateSummary,
        live_rate_error: liveRateError,
        metrics: computeHotelMetricInputs(detailData.hotel, liveRateSummary),
      };
    })
  );

  const modifierSpecs = [
    (item) => {
      if (!appliedPreferences.require_free_cancellation) {
        return null;
      }

      if (!stayContext) {
        return {
          preference: "require_free_cancellation",
          status: "not_evaluated",
          contribution: 0,
          note: "No stay dates were supplied, so free-cancellation availability could not be validated live.",
        };
      }

      return item?.live_rate_summary?.free_cancellation_available
        ? {
            preference: "require_free_cancellation",
            status: "satisfied",
            contribution: 8,
            note: "At least one live rate exposes free cancellation.",
          }
        : {
            preference: "require_free_cancellation",
            status: "not_satisfied",
            contribution: -18,
            note: "No compared live rate exposed free cancellation.",
          };
    },
    (item) => {
      if (!appliedPreferences.prefer_benefits) {
        return null;
      }

      const hasBenefits =
        item?.hotel?.membership_benefits?.has_member_benefits || (item?.live_rate_summary?.best_benefits_count || 0) > 0;

      return hasBenefits
        ? {
            preference: "prefer_benefits",
            status: "satisfied",
            contribution: 5,
            note: "Member or rate-level benefit content is present.",
          }
        : {
            preference: "prefer_benefits",
            status: "not_satisfied",
            contribution: -6,
            note: "No explicit benefit package was surfaced in the compared data.",
          };
    },
    (item) => {
      if (appliedPreferences.payment_preference === "any") {
        return null;
      }

      if (!stayContext) {
        return {
          preference: `payment_preference:${appliedPreferences.payment_preference}`,
          status: "not_evaluated",
          contribution: 0,
          note: "Payment-path fit requires live rate inventory.",
        };
      }

      const supportsRequestedPayment =
        appliedPreferences.payment_preference === "guarantee"
          ? item?.live_rate_summary?.guarantee_available
          : item?.live_rate_summary?.prepay_available;

      return supportsRequestedPayment
        ? {
            preference: `payment_preference:${appliedPreferences.payment_preference}`,
            status: "satisfied",
            contribution: 8,
            note: `Live inventory supports ${appliedPreferences.payment_preference} flow.`,
          }
        : {
            preference: `payment_preference:${appliedPreferences.payment_preference}`,
            status: "not_satisfied",
            contribution: -12,
            note: `Live inventory did not expose ${appliedPreferences.payment_preference} support.`,
          };
    },
  ];

  const scored = buildWeightedScoreBreakdown(
    compared,
    appliedPreferences.weights,
    {
      quality: "desc",
      price: "asc",
      perks: "desc",
      luxury: "desc",
      location: "desc",
      flexibility: "desc",
      low_due_now: "asc",
    },
    modifierSpecs
  ).map((item) => {
    const decisionBrief = buildHotelDecisionBrief(item.hotel, item.live_rate_summary, item.score_breakdown);

    return {
      ...item,
      decision_brief: decisionBrief,
      comparison_row: buildHotelComparisonRow({
        hotel: item.hotel,
        decision_brief: decisionBrief,
        live_rate_summary: item.live_rate_summary,
        applied_preferences: appliedPreferences,
      }),
    };
  });

  const ranked = [...scored].sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));

  const cheapestLive = [...scored]
    .filter((item) => Number.isFinite(item.live_rate_summary?.cheapest_display_total_cny))
    .sort(
      (a, b) =>
        (a.live_rate_summary?.cheapest_display_total_cny ?? Number.POSITIVE_INFINITY) -
        (b.live_rate_summary?.cheapest_display_total_cny ?? Number.POSITIVE_INFINITY)
    )[0] || null;

  const bestBenefits = [...scored].sort(
    (a, b) =>
      ((b.hotel?.membership_benefits?.interest_count || 0) + (b.hotel?.membership_benefits?.promotion_count || 0)) -
      ((a.hotel?.membership_benefits?.interest_count || 0) + (a.hotel?.membership_benefits?.promotion_count || 0))
  )[0] || null;

  const strongestLuxuryNarrative = [...scored].find((item) => item.hotel?.grounding_excerpt?.luxury_fit) || null;
  const liveErrors = scored.filter((item) => item.live_rate_error);
  const status = ranked.length === 0 ? "not_found" : liveErrors.length > 0 ? "partial" : "ok";
  const assumptions = [];

  if (!stayContext) {
    assumptions.push(
      "Without checkin/checkout, flexibility and due-now scoring can only use static or missing signals, not live room inventory."
    );
  }

  if (liveErrors.length > 0) {
    assumptions.push("Some hotels could not return live inventory, so those rows rely more heavily on static context.");
  }

  const agentBrief = buildCompareHotelsAgentBrief({
    ranked,
    cheapestLive,
    bestBenefits,
    appliedPreferences,
    stayContext,
  });

  return buildAgenticToolResult({
    tool: "compare_hotels",
    status,
    intent: "hotel_comparison",
    summary:
      ranked.length > 0
        ? `Compared ${ranked.length} hotels under the ${appliedPreferences.priority_profile} profile. Top pick: ${ranked[0].hotel.hotel_name}.` +
          (ranked[0].hotel?.bitvoya_value_brief?.primary_angle
            ? ` ${compactText(ranked[0].hotel.bitvoya_value_brief.primary_angle, 180)}`
            : "") +
          (cheapestLive ? ` Lowest live display total: ${cheapestLive.hotel.hotel_name}.` : "") +
          (bestBenefits ? ` Strongest benefits: ${bestBenefits.hotel.hotel_name}.` : "")
        : "No hotel comparison result could be generated.",
    recommended_next_tools: [
      buildNextTool("get_hotel_rooms", "Validate the shortlisted winner with live room/rate inventory.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
      buildNextTool("compare_rates", "Once one hotel wins, compare its rate options directly.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
    ],
    pricing_notes: stayContext
      ? ["Live comparison used room/rate inventory when available for each compared hotel."]
      : ["No stay dates were supplied, so comparison relies on static context and search-stage price signals only."],
    selection_hints: [
      "Read ranked_hotels[].benefit_brief, location_brief, nearby_pois_brief, and bitvoya_value_brief before defaulting to price-only explanations.",
      "Use compare_hotels to shortlist properties; use compare_rates to decide within one property.",
      "Change priority_profile when the agent should optimize price, perks, luxury, location, flexibility, or low due-now outlay.",
      "Use payment_preference, require_free_cancellation, and prefer_benefits to harden the ranking for the traveler intent.",
    ],
    warnings: liveErrors.map((item) => `${item.hotel.hotel_name}: ${item.live_rate_error}`),
    assumptions,
    entity_refs: {
      hotel_ids: ranked.map((item) => item.hotel.hotel_id),
      city_ids: ranked.map((item) => item.hotel?.city?.source_city_id),
      tripwiki_hotel_ids: ranked.map((item) => item.hotel?.grounding_excerpt?.tripwiki_hotel_id),
      tripwiki_city_ids: ranked.map((item) => item.hotel?.city_grounding_excerpt?.tripwiki_city_id),
    },
    data: {
      stay: stayContext,
      applied_preferences: {
        ...appliedPreferences,
        weights: Object.fromEntries(
          Object.entries(appliedPreferences.weights).map(([key, value]) => [key, roundScore(value, 4)])
        ),
      },
      comparison_method: {
        type: "weighted_profile_ranking",
        score_scale: "0-100 weighted dimensions plus preference modifiers",
        price_dimension:
          stayContext ? "cheapest live display_total_cny when available" : "search_stage_supplier_min_price_cny fallback",
      },
      comparison_highlights: {
        top_pick: ranked[0]
          ? {
              hotel_id: ranked[0].hotel.hotel_id,
              hotel_name: ranked[0].hotel.hotel_name,
              score: ranked[0].decision_brief.score,
              top_dimensions: ranked[0].score_breakdown?.top_dimensions || [],
            }
          : null,
        lowest_live_price: cheapestLive
          ? {
              hotel_id: cheapestLive.hotel.hotel_id,
              hotel_name: cheapestLive.hotel.hotel_name,
              cheapest_display_total_cny: cheapestLive.live_rate_summary?.cheapest_display_total_cny ?? null,
            }
          : null,
        strongest_benefits: bestBenefits
          ? {
              hotel_id: bestBenefits.hotel.hotel_id,
              hotel_name: bestBenefits.hotel.hotel_name,
              benefit_count:
                (bestBenefits.hotel?.membership_benefits?.interest_count || 0) +
                (bestBenefits.hotel?.membership_benefits?.promotion_count || 0),
            }
          : null,
        strongest_luxury_narrative: strongestLuxuryNarrative
          ? {
              hotel_id: strongestLuxuryNarrative.hotel.hotel_id,
              hotel_name: strongestLuxuryNarrative.hotel.hotel_name,
            }
          : null,
      },
      agent_brief: agentBrief,
      ranked_hotels: ranked.map((item, index) => ({
        rank: index + 1,
        ...item.comparison_row,
      })),
    },
  });
}

export async function compareRates(api, db, params, options = {}) {
  const roomsPayload = await getHotelRooms(api, db, {
    hotel_id: params.hotel_id,
    checkin: params.checkin,
    checkout: params.checkout,
    adult_num: params.adult_num || 2,
    child_num: params.child_num || 0,
    room_num: params.room_num || 1,
    room_limit: params.room_limit || 10,
    rate_limit_per_room: params.rate_limit_per_room || 10,
  }, options);

  const roomsData = roomsPayload?.data || roomsPayload;
  let flattenedRates = flattenRoomRates(roomsData.rooms);

  if (params.room_id) {
    flattenedRates = flattenedRates.filter((entry) => entry.room.room_id === String(params.room_id));
  }

  if (Array.isArray(params.rate_ids) && params.rate_ids.length > 0) {
    const allowed = new Set(params.rate_ids.map((value) => String(value)));
    flattenedRates = flattenedRates.filter((entry) => allowed.has(entry.rate.rate_id));
  }

  if (flattenedRates.length === 0) {
    return buildAgenticToolResult({
      tool: "compare_rates",
      status: "not_found",
      intent: "rate_comparison",
      summary: "No candidate rates remained after the room_id / rate_ids filters were applied.",
      recommended_next_tools: [
        buildNextTool("get_hotel_rooms", "Inspect the current room/rate inventory and choose valid ids.", [
          "hotel_id",
          "checkin",
          "checkout",
        ]),
      ],
      entity_refs: {
        hotel_ids: [String(params.hotel_id)],
      },
      data: {
        hotel_id: String(params.hotel_id),
        room_id: params.room_id || null,
        requested_rate_ids: asArray(params.rate_ids).map((value) => String(value)),
      },
    });
  }

  const rateRanking = rankRatesWithPreferences(flattenedRates, params);
  const appliedPreferences = rateRanking.applied_preferences;
  const guide = rateRanking.guide;
  const ranked = rateRanking.ranked_rows;

  return buildAgenticToolResult({
    tool: "compare_rates",
    status: "ok",
    intent: "rate_comparison",
    summary:
      `Compared ${flattenedRates.length} candidate rates for ${roomsData.hotel.hotel_name}. ` +
      `Top pick under ${appliedPreferences.priority_profile} profile: ${ranked[0]?.rate_name || "N/A"}.`,
    recommended_next_tools: [
      buildNextTool("prepare_booking_quote", "Freeze one selected room_id + rate_id before creating booking intent.", [
        "hotel_id",
        "room_id",
        "rate_id",
        "checkin",
        "checkout",
      ]),
      buildNextTool("get_hotel_detail", "Return to hotel-level context if the room choice depends on property fit.", [
        "hotel_id",
      ]),
    ],
    pricing_notes: [
      "display_total_cny is the guest-facing total to compare first.",
      "For guarantee, due-now cost is usually service_fee_cny rather than the full supplier total.",
    ],
    selection_hints: [
      "Use cheapest when total price dominates.",
      "Use most_flexible when cancellation matters.",
      "Use best_guarantee when due-now outlay should stay low.",
      "Change priority_profile or payment_preference when the ranking should reflect a different traveler intent.",
    ],
    entity_refs: {
      hotel_ids: [roomsData.hotel.hotel_id],
      room_ids: flattenedRates.map((entry) => entry.room.room_id),
      rate_ids: flattenedRates.map((entry) => entry.rate.rate_id),
      city_ids: [roomsData.hotel?.city?.source_city_id],
      tripwiki_hotel_ids: [roomsData.hotel?.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [roomsData.hotel?.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      hotel: roomsData.hotel,
      stay: roomsData.stay,
      applied_preferences: buildRoundedAppliedPreferences(appliedPreferences),
      comparison_method: rateRanking.comparison_method,
      pricing_notice: roomsData.pricing_notice,
      comparison_highlights: {
        top_pick: ranked[0]
          ? {
              room_id: ranked[0].room_id,
              room_name: ranked[0].room_name,
              rate_id: ranked[0].rate_id,
              rate_name: ranked[0].rate_name,
              score: ranked[0].score,
              top_dimensions: ranked[0].score_breakdown?.top_dimensions || [],
            }
          : null,
        cheapest: summarizeRateGuideEntry(guide.cheapest, "cheapest"),
        most_flexible: summarizeRateGuideEntry(guide.most_flexible, "most_flexible"),
        best_benefits: summarizeRateGuideEntry(guide.best_benefits, "best_benefits"),
        best_guarantee: summarizeRateGuideEntry(guide.best_guarantee, "best_guarantee"),
        best_prepay: summarizeRateGuideEntry(guide.best_prepay, "best_prepay"),
      },
      compared_rates: ranked,
    },
  });
}
