import { getCityGroundingSnapshotMap } from "./cities.mjs";
import {
  asArray,
  asBoolean,
  asNullableNumber,
  compactText,
  firstNonEmpty,
  normalizeSearchText,
  parseJsonField,
  uniqueBy,
} from "../format.mjs";
import { buildAgenticToolResult, buildNextTool } from "../agentic-output.mjs";

function toPlaceholders(count) {
  return new Array(count).fill("?").join(", ");
}

function normalizeId(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
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

function mapTag(item) {
  return {
    id: normalizeId(item?.id),
    tag: item?.tag || null,
    name: item?.name || null,
    text: compactText(item?.text, 220),
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
  if (source === "city_id" || source === "city_name") {
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

  return {
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
  const supplierTotal = asNullableNumber(firstNonEmpty(rate?.totalPriceCny, rate?.totalPrice));
  const taxTotal = asNullableNumber(firstNonEmpty(rate?.taxPriceCny, rate?.taxPrice));
  const displayTotal = asNullableNumber(firstNonEmpty(rate?.total_with_service_fee, supplierTotal));
  const explicitServiceFee = asNullableNumber(rate?.service_fee?.amount);
  const derivedServiceFee =
    explicitServiceFee !== null
      ? explicitServiceFee
      : supplierTotal !== null && displayTotal !== null
        ? Math.max(0, displayTotal - supplierTotal)
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
      currency: firstNonEmpty(rate?.priceUnit, rate?.service_fee?.currency, "CNY"),
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
      penalty_cny: asNullableNumber(rate?.cancelPolicy?.penalty),
      penalty_currency: firstNonEmpty(rate?.cancelPolicy?.unit),
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
        estimated_service_fee_due_now_cny: guaranteeSupported ? derivedServiceFee || 0 : null,
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

  return {
    room_id: normalizeId(room?.id),
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
      if (hotel?.membership_benefits?.has_member_benefits) {
        return `${hotel.membership_benefits.interest_count + hotel.membership_benefits.promotion_count} member-benefit signals are attached before booking.`;
      }
      return null;
    case "luxury":
      return hotel?.grounding_excerpt?.luxury_fit || null;
    case "location":
      return firstNonEmpty(
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

  const priceRows = await api.getHotelPrices({
    hotelIds,
    checkin: stayContext.checkin,
    checkout: stayContext.checkout,
    adultNum: stayContext.adult_num,
  });

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
        }
      : null,
    strongest_static_story: strongestStaticStory
      ? {
          hotel_id: strongestStaticStory.hotel.hotel_id,
          hotel_name: strongestStaticStory.hotel.hotel_name,
          positioning: strongestStaticStory.hotel?.static_story?.positioning || null,
        }
      : null,
    strongest_location_story: strongestLocationStory
      ? {
          hotel_id: strongestLocationStory.hotel.hotel_id,
          hotel_name: strongestLocationStory.hotel.hotel_name,
          access_highlights: strongestLocationStory.hotel?.static_story?.access_highlights || [],
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
  const uniqueHotels = uniqueBy(asArray(rawHotels), (hotel) => normalizeId(hotel?.id));

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
  const results = rankedSearch.ranked.slice(offset, offset + limit).map((item, index) => ({
    ...item.hotel,
    search_rank: offset + index + 1,
    shortlist_score: item.decision_brief?.score ?? null,
    query_match: item.query_match,
    decision_brief: item.decision_brief,
  }));

  return {
    section_type: options.sectionType || "search_section",
    summary:
      results.length > 0
        ? `Ranked ${results.length} hotel result(s). Top pick: ${rankedSearch.ranked[0]?.hotel?.hotel_name || "N/A"}.`
        : "No ranked hotel results were produced.",
    applied_preferences: rankedSearch.applied_preferences,
    comparison_method: rankedSearch.comparison_method,
    selection_guide: rankedSearch.selection_guide,
    count: results.length,
    total_matches: totalMatches,
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

  let searchStrategy = null;
  let resolvedCity = null;
  let cityCandidates = [];
  let hotelSeedRows = [];
  let hotelCandidates = [];
  let cityInventorySection = null;
  let directHotelSection = null;
  let exposeCityInventorySection = false;
  let exposeDirectHotelSection = false;

  if (source === "city_id") {
    resolvedCity = { id: cityId, name: cityName, nameEn: null };
    searchStrategy = query ? "city_inventory_filtered" : "city_inventory";

    const [cityHotels, cityGroundingMap] = await Promise.all([
      api.searchHotelsByCity(cityId),
      getCityGroundingSnapshotMap(db, [cityId]),
    ]);

    cityCandidates = [buildExplicitCityCandidateRow(resolvedCity, cityGroundingMap.get(cityId) || null)];
    exposeCityInventorySection = true;
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
  } else if (source === "city_name") {
    const [rawCityCandidates, suggest] = await Promise.all([
      api.searchCitiesOnly(cityName).catch(() => []),
      api.searchSuggest(cityName).catch(() => ({ cities: [], hotels: [] })),
    ]);
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

    searchStrategy = "city_inventory";
    exposeCityInventorySection = true;
    const cityHotels = await api.searchHotelsByCity(resolvedCity.id);
    cityInventorySection = await buildRankedHotelSection(api, db, cityHotels, params, {
      query,
      stayContext,
      matchSource: searchStrategy,
      offset,
      limit,
      enableQueryRelevance: false,
      sectionType: "city_inventory_shortlist",
    });
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
        })()
      );
    }

    if (hotelSeedRows.length > 0) {
      tasks.push(
        (async () => {
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

  const status =
    activeSection?.count || combinedResults.length > 0 || cityCandidates.length > 0 || hotelCandidates.length > 0
      ? "ok"
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
    source === "query"
      ? `Resolved "${query}" into ${cityCandidates.length} city candidate(s) and ${hotelCandidates.length} hotel candidate(s). ` +
        `Recommended route: ${routeDecision.recommended_route}.` +
        (activeSection?.count
          ? ` Expanded ${activeSection.count} ranked hotel result(s) from the recommended track.`
          : "")
      : cityInventorySection?.count
        ? `Resolved city input to ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId} and returned ${cityInventorySection.count} ranked hotel result(s).`
        : `Resolved city input to ${cityCandidates[0]?.city_name || resolvedCity?.name || cityId}, but no ranked hotel result was produced.`;

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
        : [
            buildNextTool("search_destination_suggestions", "Resolve the query through the mixed suggest layer when live candidates are thin.", [
              "query",
            ]),
          ],
    pricing_notes: [
      "search_price.supplier_min_price_cny is only a search-stage supplier signal.",
      "Use get_hotel_rooms for checkout-relevant display_total_cny and service_fee_cny.",
    ],
    selection_hints: [
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

  return buildAgenticToolResult({
    tool: "get_hotel_grounding",
    status: "ok",
    intent: "hotel_grounding",
    summary: `Loaded grounded hotel card for ${hotel.hotel_name} with ${nearbyPois.length} nearby POIs and traveler-fit notes.`,
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
    },
  });
}

export async function getHotelDetail(api, db, { hotel_id }) {
  const hotel = await api.getHotelDetail(hotel_id);
  const hotelId = normalizeId(firstNonEmpty(hotel?.id, hotel_id));
  const cityId = normalizeId(hotel?.profiles?.CITY?.id);

  const [groundingPayload, cityGroundingMap] = await Promise.all([
    getHotelGrounding(db, { source_hotel_id: hotelId }, 6).catch(() => null),
    getCityGroundingSnapshotMap(db, cityId ? [cityId] : []),
  ]);

  const normalizedHotel = normalizeHotelSummary(hotel, {
    grounding: groundingPayload?.data?.hotel || groundingPayload?.hotel || null,
    cityGrounding: cityId ? cityGroundingMap.get(cityId) || null : null,
    matchSource: "hotel_detail",
  });
  const hotelDetail = normalizeHotelDetailPayload(hotel);
  const decisionBrief = buildHotelDecisionBrief(normalizedHotel);

  return buildAgenticToolResult({
    tool: "get_hotel_detail",
    status: "ok",
    intent: "hotel_evaluation",
    summary: `Loaded live hotel detail for ${normalizedHotel.hotel_name}. Member benefits: ${normalizedHotel.membership_benefits.interest_count} interests, ${normalizedHotel.membership_benefits.promotion_count} promotions.`,
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
      "Use hotel.membership_benefits for a compact benefit summary.",
      "Use hotel_detail.benefits for the normalized underlying benefit arrays.",
      "Use decision_brief.choose_reasons and tradeoffs for agent-facing recommendation text.",
    ],
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
      grounding: groundingPayload?.data || groundingPayload,
      city_grounding_excerpt: cityId ? buildCityGroundingExcerpt(cityGroundingMap.get(cityId) || null) : null,
    },
  });
}

export async function getHotelRooms(api, db, params, options = {}) {
  const [hotel, rooms] = await Promise.all([
    api.getHotelDetail(params.hotel_id),
    api.getHotelRooms({
      hotelId: params.hotel_id,
      checkin: params.checkin,
      checkout: params.checkout,
      adultNum: params.adult_num,
      childNum: params.child_num || 0,
      roomNum: params.room_num || 1,
    }, {
      requestPrincipal: options.request_principal || null,
    }),
  ]);

  const hotelId = normalizeId(firstNonEmpty(hotel?.id, params.hotel_id));
  const cityId = normalizeId(hotel?.profiles?.CITY?.id);

  const [groundingMap, cityGroundingMap] = await Promise.all([
    getHotelGroundingSnapshotMap(db, hotelId ? [hotelId] : []),
    getCityGroundingSnapshotMap(db, cityId ? [cityId] : []),
  ]);

  const normalizedRooms = asArray(rooms)
    .map((room) => normalizeRoom(room, params.rate_limit_per_room))
    .slice(0, params.room_limit);

  const normalizedHotel = normalizeHotelSummary(hotel, {
    grounding: hotelId ? groundingMap.get(hotelId) || null : null,
    cityGrounding: cityId ? cityGroundingMap.get(cityId) || null : null,
    matchSource: "hotel_rooms",
  });
  const flattenedRates = flattenRoomRates(normalizedRooms);
  const cheapestRate = sortByDisplayTotal(flattenedRates)[0];
  const rateRanking = rankRatesWithPreferences(flattenedRates, params);
  const selectionGuide = rateRanking.guide;
  const primaryRecommendation = rateRanking.ranked_rows[0] || null;

  return buildAgenticToolResult({
    tool: "get_hotel_rooms",
    status: normalizedRooms.length > 0 ? "ok" : "not_found",
    intent: "rate_selection",
    summary:
      normalizedRooms.length > 0
        ? `Loaded ${normalizedRooms.length} room options for ${normalizedHotel.hotel_name}. Cheapest current display total is ${cheapestRate?.rate?.pricing?.display_total_cny ?? "N/A"} CNY.` +
          (primaryRecommendation
            ? ` Top in-tool recommendation under ${rateRanking.applied_preferences.priority_profile}: ${primaryRecommendation.rate_name}.`
            : "")
        : `No live room inventory was returned for ${normalizedHotel.hotel_name}.`,
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
        : [],
    pricing_notes: [
      "display_total_cny is the guest-facing total aligned with current frontend semantics.",
      "supplier_total_cny and service_fee_cny stay explicit so agents can reason about guarantee vs prepay.",
    ],
    selection_hints: [
      "Choose room_id from rooms[].room_id and rate_id from rooms[].rates[].rate_id.",
      "Do not infer final payable totals from search-stage prices once live rates are available.",
      "Use selection_guide when the agent needs a fast cheapest vs flexible vs benefits-based recommendation.",
      "Pass priority_profile, payment_preference, require_free_cancellation, or prefer_benefits when the agent already knows traveler intent.",
    ],
    entity_refs: {
      hotel_ids: [normalizedHotel.hotel_id],
      city_ids: [normalizedHotel?.city?.source_city_id],
      room_ids: normalizedRooms.map((room) => room.room_id),
      rate_ids: normalizedRooms.flatMap((room) => asArray(room.rates).map((rate) => rate.rate_id)),
      tripwiki_hotel_ids: [normalizedHotel?.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [normalizedHotel?.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      found: true,
      hotel: normalizedHotel,
      stay: {
        checkin: params.checkin,
        checkout: params.checkout,
        adult_num: params.adult_num,
        child_num: params.child_num || 0,
        room_num: params.room_num || 1,
      },
      pricing_notice: buildRoomPricingNotice(),
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

  return buildAgenticToolResult({
    tool: "compare_hotels",
    status,
    intent: "hotel_comparison",
    summary:
      ranked.length > 0
        ? `Compared ${ranked.length} hotels under the ${appliedPreferences.priority_profile} profile. Top pick: ${ranked[0].hotel.hotel_name}.` +
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
