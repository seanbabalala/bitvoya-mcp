// Brief result shaping for discovery tools.
//
// Discovery payloads repeat the same prose many times: one hotel's positioning sentence shows up in
// static_story, grounding_excerpt, decision_brief and bitvoya_value_brief, a city's context is
// copied into every hotel, and the active shortlist is serialised twice (data.results and its
// section). "brief" keeps every distinct fact once and drops the restatements; "full" returns the
// payload untouched for callers that want every field.

export const RESULT_DETAIL_LEVELS = ["brief", "full"];

const MAX_TEXT = 280;
const MAX_BENEFIT_TEXT = 360;
const MAX_NAME = 120;
const MAX_PROSE_ITEMS = 3;
const MAX_AMENITIES = 8;
// Sentences at least this long are dropped when they already appeared earlier in the payload.
const REPEAT_MIN_LENGTH = 80;

// Restatements or raw source material of fields that are kept.
const DROP_KEYS = new Set(["score_breakdown", "bitvoya_value_brief", "grounding", "missing_dimensions"]);
// Hotel-level fields that duplicate city-level data or are not needed to choose a hotel.
const HOTEL_DROP_KEYS = new Set(["city_grounding_excerpt", "contact"]);
const HOTEL_HINT_KEYS = ["static_story", "grounding_excerpt", "bitvoya_value_brief", "decision_brief", "location_brief"];
const STATIC_STORY_KEYS = new Set(["positioning", "why_not_stay_here", "traveler_fit_highlights", "tradeoff_notes", "risk_notes"]);
// A selection-guide entry points at a hotel that is already in the results.
const PICK_KEYS = new Set([
  "hotel_id",
  "hotel_name",
  "score",
  "choose_reasons",
  "best_for",
  "headline",
  "reason",
  "room_id",
  "room_name",
  "rate_id",
  "rate_name",
  "display_total_cny",
]);
// Records that should claim their sentences before summaries and guides restate them.
const CANONICAL_KEYS = new Set(["results", "hotel", "hotels", "rooms"]);
const SECTION_KEYS = ["city_inventory_shortlist", "direct_hotel_matches"];

const SKIP = Symbol("skip");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function capText(value, max = MAX_TEXT) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function isHotelLike(value) {
  return isPlainObject(value) && value.hotel_id !== undefined && HOTEL_HINT_KEYS.some((key) => value[key] !== undefined);
}

function isBenefitDefinition(value) {
  return value.id !== undefined && typeof value.text === "string" && ("tag" in value || "name" in value);
}

function looksLikeProse(items) {
  const total = items.reduce((sum, item) => sum + item.length, 0);
  return total / items.length > 40;
}

function shapeString(value, state) {
  if (/^https?:\/\//i.test(value)) return value;
  const text = capText(value);
  if (text.length >= REPEAT_MIN_LENGTH) {
    if (state.seenText.has(text)) return SKIP;
    state.seenText.add(text);
  }
  return text;
}

function shapeBenefit(value, state) {
  const key = `benefit:${value.id}`;
  const firstSighting = !state.seenIds.has(key);
  state.seenIds.add(key);

  const out = { id: value.id };
  if (value.tag) out.tag = value.tag;
  if (value.name) out.name = capText(String(value.name), MAX_NAME);
  const nameEn = value.i18n?.name?.en;
  if (nameEn) out.name_en = capText(String(nameEn), MAX_NAME);
  if (firstSighting) {
    out.text = capText(value.text, MAX_BENEFIT_TEXT);
    const textEn = value.i18n?.text?.en;
    if (textEn) out.text_en = capText(String(textEn), MAX_BENEFIT_TEXT);
  }
  return out;
}

function shapeArray(value, state, key) {
  if (value.length > 0 && value.every((item) => typeof item === "string")) {
    const prose = looksLikeProse(value);
    const out = [];
    for (const item of value) {
      const shaped = prose ? shapeString(item, state) : item;
      if (shaped === SKIP || out.includes(shaped)) continue;
      out.push(shaped);
      if (prose && out.length >= MAX_PROSE_ITEMS) break;
    }
    return out.length > 0 ? out : SKIP;
  }

  if (key === "amenities" && value.every((item) => isPlainObject(item) && "text" in item)) {
    return value
      .filter((item) => item.value !== null && item.value !== undefined && item.value !== "")
      .slice(0, MAX_AMENITIES)
      .map((item) => `${item.text}: ${item.value}`);
  }

  return value.map((item) => shapeValue(item, state, "")).filter((item) => item !== SKIP);
}

function shapeObject(value, state, parentKey) {
  if (isBenefitDefinition(value)) {
    return shapeBenefit(value, state);
  }

  const hotel = isHotelLike(value);
  const keys = Object.keys(value);
  const order = [...keys.filter((key) => CANONICAL_KEYS.has(key)), ...keys.filter((key) => !CANONICAL_KEYS.has(key))];
  const out = {};

  for (const key of order) {
    let child = value[key];
    if (child === null || child === undefined) continue;
    if (DROP_KEYS.has(key) || key === "i18n") continue;
    if (hotel && HOTEL_DROP_KEYS.has(key)) continue;
    if (hotel && key === "grounding_excerpt" && value.static_story) continue;

    if (key === "static_story" && isPlainObject(child)) {
      child = Object.fromEntries(Object.entries(child).filter(([storyKey]) => STATIC_STORY_KEYS.has(storyKey)));
    }
    if (parentKey === "selection_guide" && isPlainObject(child) && child.hotel_id !== undefined) {
      child = Object.fromEntries(Object.entries(child).filter(([pickKey]) => PICK_KEYS.has(pickKey)));
    }

    const shaped = shapeValue(child, state, key);
    if (shaped === SKIP) continue;
    if (isPlainObject(shaped) && Object.keys(shaped).length === 0) continue;
    out[key] = shaped;
  }

  // Keep the original key order so the shaped payload reads like the full one.
  return Object.fromEntries(keys.filter((key) => key in out).map((key) => [key, out[key]]));
}

function shapeValue(value, state, key) {
  if (typeof value === "string") return shapeString(value, state);
  if (Array.isArray(value)) return shapeArray(value, state, key);
  if (isPlainObject(value)) return shapeObject(value, state, key);
  return value;
}

// Collapses structures that the payload serialises twice before the field-level pass runs.
function dropDuplicatedBlocks(data) {
  const next = { ...data };

  for (const sectionKey of SECTION_KEYS) {
    const section = next[sectionKey];
    if (!isPlainObject(section)) continue;
    const copy = { ...section };
    if (Array.isArray(next.results) && sameJson(copy.results, next.results)) {
      delete copy.results;
      copy.results_in = "data.results";
    }
    if (next.selection_guide && sameJson(copy.selection_guide, next.selection_guide)) {
      delete copy.selection_guide;
      copy.selection_guide_in = "data.selection_guide";
    }
    next[sectionKey] = copy;
  }

  const resolution = next.query_resolution;
  const topCity = Array.isArray(next.city_candidates) ? next.city_candidates[0] : undefined;
  if (isPlainObject(resolution) && topCity && sameJson(resolution.top_city_candidate, topCity)) {
    next.query_resolution = {
      ...resolution,
      top_city_candidate: { city_id: topCity.city_id ?? null, same_as: "data.city_candidates[0]" },
    };
  }

  if (isPlainObject(next.hotel)) {
    for (const key of Object.keys(next)) {
      if (key !== "hotel" && next.hotel[key] !== undefined && sameJson(next[key], next.hotel[key])) {
        delete next[key];
      }
    }
  }

  return next;
}

export function normalizeResultDetail(value) {
  return RESULT_DETAIL_LEVELS.includes(value) ? value : "brief";
}

/**
 * Returns the payload a discovery tool should send back. Only `data` is shaped; the envelope
 * (summary, decision_support, entity_refs) is passed through unchanged.
 */
export function shapeToolPayload(payload, options = {}) {
  if (normalizeResultDetail(options.detail) === "full") return payload;
  if (!isPlainObject(payload) || !isPlainObject(payload.data)) return payload;

  const state = { seenText: new Set(), seenIds: new Set() };
  const data = shapeObject(dropDuplicatedBlocks(payload.data), state, "data");
  return { ...payload, data };
}
