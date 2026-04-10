import { getCityGroundingSnapshotMap } from "./cities.mjs";
import { getHotelDetail, getHotelGroundingSnapshotMap } from "./hotels.mjs";
import {
  asArray,
  asNullableNumber,
  compactText,
  firstNonEmpty,
  normalizeSearchText,
  parseJsonField,
  uniqueBy,
} from "../format.mjs";
import { buildAgenticToolResult, buildNextTool } from "../agentic-output.mjs";

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

function mapGroundingExcerpt(grounding) {
  if (!grounding) return null;

  return {
    source_hotel_id: grounding.source_hotel_id,
    tripwiki_hotel_id: grounding.tripwiki_hotel_id,
    grounding_status: grounding.grounding_status,
    why_stay_here: grounding.why_stay_here,
    luxury_fit: grounding.hotel_luxury_fit_reason,
    area_character: grounding.hotel_area_character,
    transport_summary: grounding.hotel_transport_summary,
  };
}

function mapCityGroundingExcerpt(grounding) {
  if (!grounding) return null;

  return {
    source_city_id: grounding.source_city_id,
    tripwiki_city_id: grounding.tripwiki_city_id,
    grounding_status: grounding.grounding_status,
    city_positioning: grounding.city_positioning,
    city_character: grounding.city_character,
    luxury_scene_summary: grounding.luxury_scene_summary,
    stay_area_recommendation: grounding.stay_area_recommendation,
  };
}

function mapLiveCity(city, grounding = null) {
  return {
    city_id: normalizeId(firstNonEmpty(city?.cityId, city?.id)),
    city_name: firstNonEmpty(city?.name, city?.displayName, grounding?.city_name),
    city_name_en: firstNonEmpty(city?.nameEn),
    display_name: firstNonEmpty(city?.displayName, city?.nameEn, city?.name),
    code: firstNonEmpty(city?.code),
    hotel_count: asNullableNumber(city?.hotelCount),
    path_name_en: firstNonEmpty(city?.pathNameEnglish, city?.pathNameEn),
    grounding_excerpt: mapCityGroundingExcerpt(grounding),
  };
}

function buildMinPrice(minPrice, note) {
  const value = asNullableNumber(minPrice);
  if (value === null) return null;

  return {
    supplier_min_price: value,
    currency: "CNY",
    semantics: "catalog_min_price",
    note,
  };
}

function mapSimpleHotelCard(hotel, grounding = null) {
  const id = normalizeId(firstNonEmpty(hotel?.hotel_id, hotel?.id));
  const name = firstNonEmpty(hotel?.hotel_name, hotel?.name, grounding?.hotel_name);
  const nameEn = firstNonEmpty(hotel?.nameEn, hotel?.hotel_name_en);
  const cityName = firstNonEmpty(hotel?.city_name, grounding?.city_name);

  return {
    hotel_id: id,
    hotel_name: name,
    hotel_name_en: nameEn,
    city_name: cityName,
    address: firstNonEmpty(hotel?.address, hotel?.addressEn, grounding?.address),
    star_rating: asNullableNumber(firstNonEmpty(hotel?.star_rating, grounding?.star_rating, hotel?.rating)),
    image_url: normalizeImageUrl(firstNonEmpty(hotel?.image, asArray(hotel?.images)[0])),
    min_price: buildMinPrice(
      firstNonEmpty(hotel?.min_price, hotel?.minPrice),
      "This is a lightweight catalog/discovery price signal, not a checkout-ready display total."
    ),
    distance_km: asNullableNumber(hotel?.distance_km),
    geo: {
      latitude: asNullableNumber(hotel?.latitude),
      longitude: asNullableNumber(hotel?.longitude),
    },
    seo_content: hotel?.seo_content
      ? {
          headline: compactText(hotel.seo_content.headline, 180),
          description: compactText(hotel.seo_content.description, 700),
          insider_tip: compactText(hotel.seo_content.insider_tip, 240),
          aggregate_rating_estimate: asNullableNumber(hotel.seo_content.aggregate_rating_estimate),
          review_count_estimate: asNullableNumber(hotel.seo_content.review_count_estimate),
        }
      : null,
    grounding_excerpt: mapGroundingExcerpt(grounding),
  };
}

function normalizeProfileSection(section, maxText = 500) {
  if (Array.isArray(section)) {
    return section.slice(0, 20);
  }

  if (section && typeof section === "object") {
    return section;
  }

  return compactText(section, maxText);
}

function normalizeHotelProfile(profile) {
  if (!profile) return null;

  return {
    hotel_id: normalizeId(profile.hotel_id),
    official_names: {
      zh: firstNonEmpty(profile.official_name_zh),
      en: firstNonEmpty(profile.official_name_en),
    },
    contact: {
      phone: firstNonEmpty(profile.phone),
      email: firstNonEmpty(profile.email),
      website: firstNonEmpty(profile.website),
    },
    stats: {
      opening_year: asNullableNumber(profile.opening_year),
      renovation_year: asNullableNumber(profile.renovation_year),
      star_rating: asNullableNumber(profile.star_rating),
      booking_rating: asNullableNumber(profile.rating_booking),
      tripadvisor_rating: asNullableNumber(profile.rating_tripadvisor),
      min_price_usd: asNullableNumber(profile.min_price_usd),
      total_rooms: asNullableNumber(profile.total_rooms),
      base_room_size: compactText(profile.base_room_size, 120),
    },
    usp: {
      zh: compactText(profile.usp_zh, 320),
      en: compactText(profile.usp_en, 320),
    },
    analysis: normalizeProfileSection(profile.analysis_json),
    basic_info: normalizeProfileSection(profile.basic_info_json),
    room_specs: normalizeProfileSection(profile.room_specs_json),
    dining: normalizeProfileSection(profile.dining_json),
    facilities: normalizeProfileSection(profile.facilities_json),
    policies_and_offers: normalizeProfileSection(profile.policy_offers_json),
    location: normalizeProfileSection(profile.location_json),
    competitors: normalizeProfileSection(profile.competitor_json),
    raw_sections_available: {
      analysis_json: Boolean(profile.analysis_json),
      basic_info_json: Boolean(profile.basic_info_json),
      room_specs_json: Boolean(profile.room_specs_json),
      dining_json: Boolean(profile.dining_json),
      facilities_json: Boolean(profile.facilities_json),
      policy_offers_json: Boolean(profile.policy_offers_json),
      location_json: Boolean(profile.location_json),
      competitor_json: Boolean(profile.competitor_json),
    },
  };
}

function normalizeMediaItem(item) {
  return {
    media_id: normalizeId(item?.id),
    hotel_id: normalizeId(item?.hotelId),
    title: firstNonEmpty(item?.title),
    media_type_id: asNullableNumber(item?.type),
    url: normalizeImageUrl(firstNonEmpty(item?.url)),
    original_url: firstNonEmpty(item?.originalUrl),
    created_at_ms: asNullableNumber(item?.gmtCreate),
    updated_at_ms: asNullableNumber(item?.gmtUpdate),
  };
}

function normalizeFeaturedItem(item) {
  return {
    featured_id: normalizeId(item?.id),
    hotel_id: normalizeId(item?.hotel_id),
    hotel_name: firstNonEmpty(item?.hotel_name, item?.name),
    image_url: normalizeImageUrl(asArray(item?.images)[0]),
    domestic_type: firstNonEmpty(item?.domestic_type),
    promotions: {
      tags: asArray(item?.promotions?.tags),
      directions: asArray(item?.promotions?.directions).slice(0, 5),
      count: asNullableNumber(item?.promotions?.count),
    },
    restrictions: item?.restrictions || {},
    validity: item?.validity || {},
    i18n: item?.i18n || {},
  };
}

function normalizeCollectionItem(item) {
  return {
    collection_tag: firstNonEmpty(item?.collection_tag),
    h1_title: compactText(item?.h1_title, 220),
    intro_content: compactText(item?.intro_content, 1200),
    meta_title: compactText(item?.meta_title, 180),
    meta_description: compactText(item?.meta_description, 220),
  };
}

function sliceWithOffset(items, offset, limit) {
  const total = items.length;
  const sliced = items.slice(offset, offset + limit);
  return {
    total,
    items: sliced,
    next_offset: offset + sliced.length < total ? offset + sliced.length : null,
  };
}

function summarizeTopLabels(items, field, limit = 3) {
  return asArray(items)
    .map((item) => item?.[field])
    .filter(Boolean)
    .slice(0, limit)
    .join(", ");
}

export async function searchDestinationSuggestions(api, db, { query, limit }) {
  const payload = await api.searchSuggest(query);

  const cities = uniqueBy(asArray(payload.cities), (item) => normalizeId(firstNonEmpty(item?.cityId, item?.id)))
    .slice(0, limit);
  const hotels = uniqueBy(asArray(payload.hotels), (item) => normalizeId(item?.id)).slice(0, limit);

  const [cityGroundingMap, hotelGroundingMap] = await Promise.all([
    getCityGroundingSnapshotMap(
      db,
      cities.map((item) => firstNonEmpty(item?.cityId, item?.id))
    ),
    getHotelGroundingSnapshotMap(
      db,
      hotels.map((item) => item?.id)
    ),
  ]);

  const cityResults = cities.map((city) =>
    mapLiveCity(city, cityGroundingMap.get(String(firstNonEmpty(city?.cityId, city?.id))) || null)
  );
  const hotelResults = hotels.map((hotel) =>
    mapSimpleHotelCard(hotel, hotelGroundingMap.get(String(hotel.id)) || null)
  );

  return buildAgenticToolResult({
    tool: "search_destination_suggestions",
    status: cityResults.length > 0 || hotelResults.length > 0 ? "ok" : "not_found",
    intent: "destination_resolution",
    summary:
      cityResults.length > 0 || hotelResults.length > 0
        ? `Resolved "${query}" into ${cityResults.length} city candidates and ${hotelResults.length} hotel candidates.`
        : `No live destination suggestions matched "${query}".`,
    recommended_next_tools:
      cityResults.length > 0 || hotelResults.length > 0
        ? [
            buildNextTool("search_hotels", "Use a resolved city id or city name to enter live hotel inventory.", [
              "city_id or city_name",
            ]),
            buildNextTool("get_hotel_detail", "Inspect one resolved hotel candidate before checking rates.", [
              "hotel_id",
            ]),
          ]
        : [
            buildNextTool("search_cities", "Try the grounding layer for broader destination alias matching.", [
              "query",
            ]),
          ],
    selection_hints: [
      "Prefer a resolved city candidate when the user intent is broad destination search.",
      "Prefer a resolved hotel candidate when the user names a property explicitly.",
    ],
    entity_refs: {
      city_ids: cityResults.map((city) => city.city_id),
      hotel_ids: hotelResults.map((hotel) => hotel.hotel_id),
      tripwiki_city_ids: cityResults.map((city) => city?.grounding_excerpt?.tripwiki_city_id),
      tripwiki_hotel_ids: hotelResults.map((hotel) => hotel?.grounding_excerpt?.tripwiki_hotel_id),
    },
    data: {
      query,
      count: {
        cities: cityResults.length,
        hotels: hotelResults.length,
      },
      cities: cityResults,
      hotels: hotelResults,
    },
  });
}

export async function listHotCities(api, db, { limit }) {
  const cities = asArray(await api.getHotCities(limit)).slice(0, limit);
  const cityGroundingMap = await getCityGroundingSnapshotMap(
    db,
    cities.map((item) => item?.cityId)
  );

  const results = cities.map((city) =>
    mapLiveCity(city, cityGroundingMap.get(String(city.cityId)) || null)
  );

  return buildAgenticToolResult({
    tool: "list_hot_cities",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "destination_discovery",
    summary:
      results.length > 0
        ? `Returned ${results.length} hot cities for discovery. Top entries: ${summarizeTopLabels(results, "city_name")}.`
        : "No hot-city entries were returned.",
    recommended_next_tools: [
      buildNextTool("search_hotels", "Jump into live hotel inventory for one city.", ["city_id or city_name"]),
      buildNextTool("get_city_grounding", "Expand one city into planner-grade destination context.", [
        "source_city_id or city_name",
      ]),
    ],
    entity_refs: {
      city_ids: results.map((city) => city.city_id),
      tripwiki_city_ids: results.map((city) => city?.grounding_excerpt?.tripwiki_city_id),
    },
    data: {
      count: results.length,
      results,
    },
  });
}

export async function getHotelProfile(api, db, { hotel_id }) {
  const [detailPayload, profile] = await Promise.all([
    getHotelDetail(api, db, { hotel_id }),
    api.getHotelGodProfile(hotel_id),
  ]);

  const normalizedProfile = normalizeHotelProfile(profile);
  const hotel = detailPayload?.data?.hotel || detailPayload.hotel;

  return buildAgenticToolResult({
    tool: "get_hotel_profile",
    status: "ok",
    intent: "hotel_static_evaluation",
    summary: `Loaded enriched static profile for ${hotel?.hotel_name || hotel_id}, including long-form property sections and normalized hotel detail.`,
    recommended_next_tools: [
      buildNextTool("get_hotel_rooms", "Move from static fit assessment into live room and rate inventory.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
      buildNextTool("get_hotel_media", "Pull gallery assets when an agent needs visual grounding.", [
        "hotel_id",
      ]),
    ],
    entity_refs: {
      hotel_ids: [hotel?.hotel_id || hotel_id],
      tripwiki_hotel_ids: [hotel?.grounding_excerpt?.tripwiki_hotel_id],
    },
    data: {
      found: true,
      hotel,
      hotel_detail: detailPayload?.data?.hotel_detail || detailPayload.hotel_detail,
      grounding: detailPayload?.data?.grounding || detailPayload.grounding,
      profile: normalizedProfile,
    },
  });
}

export async function getHotelMedia(api, { hotel_id, limit }) {
  const payload = await api.getHotelMedia(hotel_id);
  const media = asArray(payload?.media).map(normalizeMediaItem);
  const limited = media.slice(0, limit);

  const mediaCount = asNullableNumber(payload?.media_count) ?? media.length;

  return buildAgenticToolResult({
    tool: "get_hotel_media",
    status: limited.length > 0 ? "ok" : "not_found",
    intent: "hotel_visual_grounding",
    summary:
      limited.length > 0
        ? `Returned ${limited.length} media items for hotel ${hotel_id} (${mediaCount} total available).`
        : `No media items were returned for hotel ${hotel_id}.`,
    recommended_next_tools: [
      buildNextTool("get_hotel_detail", "Pair visuals with grounded hotel context.", ["hotel_id"]),
      buildNextTool("get_hotel_rooms", "Continue to live inventory after visual review.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
    ],
    entity_refs: {
      hotel_ids: [String(hotel_id)],
    },
    data: {
      hotel_id: String(hotel_id),
      media_count: mediaCount,
      returned_count: limited.length,
      cache_time: firstNonEmpty(payload?.cache_time),
      media: limited,
    },
  });
}

export async function getNearbyHotels(api, db, { hotel_id, lang, limit, radius_km }) {
  const payload = await api.getNearbyHotels({
    hotelId: hotel_id,
    lang,
    limit,
    radiusKm: radius_km,
  });

  const hotels = asArray(payload?.hotels);
  const groundingMap = await getHotelGroundingSnapshotMap(
    db,
    hotels.map((item) => item?.id)
  );

  const results = hotels.map((hotel) =>
    mapSimpleHotelCard(hotel, groundingMap.get(String(hotel.id)) || null)
  );

  return buildAgenticToolResult({
    tool: "get_nearby_hotels",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "alternative_hotel_comparison",
    summary:
      results.length > 0
        ? `Found ${results.length} nearby hotels within ${radius_km} km of hotel ${hotel_id}.`
        : `No nearby hotels were returned within ${radius_km} km of hotel ${hotel_id}.`,
    recommended_next_tools:
      results.length > 0
        ? [
            buildNextTool("get_hotel_detail", "Inspect one nearby alternative in detail.", ["hotel_id"]),
            buildNextTool("get_hotel_rooms", "Compare live rates for a nearby alternative.", [
              "hotel_id",
              "checkin",
              "checkout",
            ]),
          ]
        : [],
    entity_refs: {
      hotel_ids: [String(hotel_id), ...results.map((hotel) => hotel.hotel_id)],
      tripwiki_hotel_ids: results.map((hotel) => hotel?.grounding_excerpt?.tripwiki_hotel_id),
    },
    data: {
      hotel_id: String(hotel_id),
      count: results.length,
      radius_km,
      results,
    },
  });
}

export async function getHotelCollections(api, { hotel_id, lang }) {
  const payload = await api.getHotelCollections({ hotelId: hotel_id, lang });
  const collections = asArray(payload?.collections).map(normalizeCollectionItem);

  return buildAgenticToolResult({
    tool: "get_hotel_collections",
    status: collections.length > 0 ? "ok" : "not_found",
    intent: "editorial_context",
    summary:
      collections.length > 0
        ? `Hotel ${hotel_id} appears in ${collections.length} editorial collections.`
        : `Hotel ${hotel_id} does not currently map to any editorial collections.`,
    recommended_next_tools:
      collections.length > 0
        ? [
            buildNextTool("get_seo_collection", "Expand one editorial collection into its hotel set.", [
              "city",
              "tag",
            ]),
          ]
        : [],
    entity_refs: {
      hotel_ids: [String(hotel_id)],
      city_ids: [normalizeId(payload?.city_id)],
    },
    data: {
      hotel_id: String(hotel_id),
      city: firstNonEmpty(payload?.city),
      city_localized: firstNonEmpty(payload?.city_localized),
      city_id: normalizeId(payload?.city_id),
      count: collections.length,
      collections,
    },
  });
}

export async function getSeoCollection(api, db, { city, tag, lang, hotel_limit }) {
  const payload = await api.getSeoCollection({ city, tag, lang });
  const hotels = asArray(payload?.hotels);
  const groundingMap = await getHotelGroundingSnapshotMap(
    db,
    hotels.map((item) => item?.id)
  );

  const returnedHotels = hotels
    .slice(0, hotel_limit)
    .map((hotel) => mapSimpleHotelCard(hotel, groundingMap.get(String(hotel.id)) || null));

  return buildAgenticToolResult({
    tool: "get_seo_collection",
    status: returnedHotels.length > 0 ? "ok" : "not_found",
    intent: "editorial_collection_expansion",
    summary:
      returnedHotels.length > 0
        ? `Loaded collection "${tag}" for ${firstNonEmpty(payload?.city, city)} with ${returnedHotels.length} hotel cards.`
        : `No hotels were returned for collection "${tag}" in ${city}.`,
    recommended_next_tools:
      returnedHotels.length > 0
        ? [
            buildNextTool("get_hotel_detail", "Inspect one hotel from the editorial set.", ["hotel_id"]),
            buildNextTool("get_hotel_rooms", "Check live rates for one hotel from the collection.", [
              "hotel_id",
              "checkin",
              "checkout",
            ]),
          ]
        : [],
    entity_refs: {
      city_ids: [normalizeId(payload?.city_id)],
      hotel_ids: returnedHotels.map((hotel) => hotel.hotel_id),
      tripwiki_hotel_ids: returnedHotels.map((hotel) => hotel?.grounding_excerpt?.tripwiki_hotel_id),
    },
    data: {
      city: firstNonEmpty(payload?.city),
      city_en: firstNonEmpty(payload?.city_en),
      city_localized: firstNonEmpty(payload?.city_localized),
      city_id: normalizeId(payload?.city_id),
      collection_tag: firstNonEmpty(payload?.collection_tag, tag),
      lang_used: firstNonEmpty(payload?.lang_used, lang),
      meta: payload?.meta || {},
      total: asNullableNumber(payload?.total) ?? hotels.length,
      returned_count: returnedHotels.length,
      hotels: returnedHotels,
    },
  });
}

export async function listSeoCollections(api, { lang, offset, limit }) {
  const payload = await api.getCollectionSitemapData({ lang });
  const all = asArray(payload?.collections);
  const paged = sliceWithOffset(all, offset, limit);

  const results = paged.items.map((item) => ({
    city_name: firstNonEmpty(item?.city_name),
    localized_city_name: firstNonEmpty(item?.localized_city_name),
    collection_tag: firstNonEmpty(item?.collection_tag),
    updated_at: firstNonEmpty(item?.updated_at),
    h1_title: compactText(item?.h1_title, 220),
    intro_content: compactText(item?.intro_content, 800),
    meta_title: compactText(item?.meta_title, 180),
    meta_description: compactText(item?.meta_description, 220),
    city_id: normalizeId(item?.city_id),
  }));

  return buildAgenticToolResult({
    tool: "list_seo_collections",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "editorial_collection_discovery",
    summary:
      results.length > 0
        ? `Returned ${results.length} editorial collections from offset ${offset}.`
        : "No editorial collections were returned for this slice.",
    recommended_next_tools:
      results.length > 0
        ? [
            buildNextTool("get_seo_collection", "Expand one city/tag collection into a hotel set.", [
              "city",
              "tag",
            ]),
          ]
        : [],
    entity_refs: {
      city_ids: results.map((item) => item.city_id),
    },
    data: {
      lang_used: firstNonEmpty(payload?.lang_used, lang),
      total: asNullableNumber(payload?.count) ?? all.length,
      offset,
      count: results.length,
      next_offset: paged.next_offset,
      results,
    },
  });
}

export async function getFeaturedHotels(api, { domestic, page, limit }) {
  const payload = await api.getFeaturedHotels({ domestic, page, limit });
  const list = asArray(payload?.list);

  const results = list.map(normalizeFeaturedItem);

  return buildAgenticToolResult({
    tool: "get_featured_hotels",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "merchandising_discovery",
    summary:
      results.length > 0
        ? `Returned ${results.length} featured hotels for domestic segment ${firstNonEmpty(payload?.domestic_type, domestic)}.`
        : "No featured hotels were returned for this segment.",
    recommended_next_tools:
      results.length > 0
        ? [
            buildNextTool("get_hotel_detail", "Inspect one featured property in detail.", ["hotel_id"]),
            buildNextTool("get_hotel_rooms", "Check live inventory for one featured property.", [
              "hotel_id",
              "checkin",
              "checkout",
            ]),
          ]
        : [],
    entity_refs: {
      hotel_ids: results.map((item) => item.hotel_id),
    },
    data: {
      domestic_type: firstNonEmpty(payload?.domestic_type),
      pagination: payload?.pagination || {},
      count: results.length,
      results,
    },
  });
}

export async function searchCitiesLive(api, db, { keyword, limit }) {
  const cities = asArray(await api.searchCitiesOnly(keyword)).slice(0, limit);
  const cityGroundingMap = await getCityGroundingSnapshotMap(
    db,
    cities.map((item) => item?.cityId)
  );

  const results = cities.map((city) =>
    mapLiveCity(city, cityGroundingMap.get(String(city.cityId)) || null)
  );

  return buildAgenticToolResult({
    tool: "search_cities_live",
    status: results.length > 0 ? "ok" : "not_found",
    intent: "city_id_resolution",
    summary:
      results.length > 0
        ? `Resolved ${results.length} live Bitvoya city candidates for "${keyword}".`
        : `No live Bitvoya city candidates matched "${keyword}".`,
    recommended_next_tools:
      results.length > 0
        ? [
            buildNextTool("search_hotels", "Use a returned city_id to search live hotel inventory.", [
              "city_id",
            ]),
            buildNextTool("get_city_grounding", "Enrich a live city match with grounding context.", [
              "source_city_id",
            ]),
          ]
        : [
            buildNextTool("search_cities", "Fallback to tripwiki grounding search for aliases and planner notes.", [
              "query",
            ]),
          ],
    selection_hints: ["Prefer city_id over free-text city_name once a live city match is available."],
    entity_refs: {
      city_ids: results.map((city) => city.city_id),
      tripwiki_city_ids: results.map((city) => city?.grounding_excerpt?.tripwiki_city_id),
    },
    data: {
      keyword,
      count: results.length,
      results,
    },
  });
}
