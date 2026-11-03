import assert from "node:assert/strict";
import test from "node:test";
import { shapeToolPayload } from "../src/result-shaping.mjs";

const POSITIONING =
  "Pick this hotel for travelers who want a very central luxury base near Place Vendome, Rue Saint-Honore and the Louvre.";
const CITY_CONTEXT =
  "Most travelers should stay in the central arrondissements with direct Metro or RER access rather than near outer venues.";

function hotel(id, overrides = {}) {
  return {
    hotel_id: id,
    hotel_name: `Hotel ${id}`,
    media: { hero_image_url: `https://cdn.example.com/${id}.jpg` },
    contact: { phone: "+33 1 00 00 00 00" },
    static_story: {
      positioning: POSITIONING,
      city_context: CITY_CONTEXT,
      planner_highlights: ["Planner note one that is long enough to count as prose for the shaping rule."],
    },
    grounding_excerpt: { why_stay_here: POSITIONING },
    city_grounding_excerpt: { city_character: CITY_CONTEXT },
    bitvoya_value_brief: { selling_points: [POSITIONING] },
    decision_brief: {
      choose_reasons: [POSITIONING, "A second, distinct reason that is also long enough to be treated as prose."],
      score_breakdown: { quality: 0.3 },
    },
    membership_benefits: {
      top_interests: [
        {
          id: "5139",
          tag: "100 USD credit",
          name: "100 USD dining credit",
          text: "Daily breakfast for two, 100 USD credit, upgrade on arrival when available.",
          i18n: { name: { en: "100 USD dining credit (EN)" }, text: { en: "Daily breakfast for two (EN)" } },
        },
      ],
    },
    ...overrides,
  };
}

function searchPayload() {
  const results = [hotel("1"), hotel("2")];
  const selectionGuide = { top_pick: { hotel_id: "1", hotel_name: "Hotel 1", score: 80, location_brief: { headline: "x" } } };
  return {
    object: "tool_result",
    tool: "search_hotels",
    status: "ok",
    intent: "hotel_inventory_discovery",
    summary: "Ranked 2 hotels.",
    decision_support: { selection_hints: ["Use city_inventory_shortlist when the input behaves like a destination search."] },
    entity_refs: { hotel_ids: ["1", "2", "3", "4", "5", "6"] },
    data: {
      city_inventory_shortlist: { summary: "Ranked 2 hotels.", selection_guide: selectionGuide, results },
      selection_guide: selectionGuide,
      results,
      rooms: undefined,
    },
  };
}

test("full detail returns the payload untouched", () => {
  const payload = searchPayload();
  assert.equal(shapeToolPayload(payload, { detail: "full" }), payload);
});

test("brief keeps the envelope and every id", () => {
  const shaped = shapeToolPayload(searchPayload());
  assert.equal(shaped.summary, "Ranked 2 hotels.");
  assert.deepEqual(shaped.entity_refs.hotel_ids, ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(shaped.decision_support, searchPayload().decision_support);
  assert.deepEqual(shaped.data.results.map((item) => item.hotel_id), ["1", "2"]);
});

test("brief serialises the active shortlist once", () => {
  const { data } = shapeToolPayload(searchPayload());
  assert.equal(data.city_inventory_shortlist.results, undefined);
  assert.equal(data.city_inventory_shortlist.results_in, "data.results");
  assert.equal(data.city_inventory_shortlist.selection_guide_in, "data.selection_guide");
  assert.deepEqual(Object.keys(data.selection_guide.top_pick), ["hotel_id", "hotel_name", "score"]);
});

test("brief keeps each long sentence once, in the hotel that owns it", () => {
  const { data } = shapeToolPayload(searchPayload());
  const [first, second] = data.results;
  assert.equal(first.static_story.positioning, POSITIONING);
  assert.equal(first.grounding_excerpt, undefined);
  assert.equal(first.bitvoya_value_brief, undefined);
  assert.equal(first.city_grounding_excerpt, undefined);
  assert.equal(first.contact, undefined);
  assert.equal(first.static_story.city_context, undefined);
  assert.equal(first.static_story.planner_highlights, undefined);
  assert.deepEqual(first.decision_brief.choose_reasons, [
    "A second, distinct reason that is also long enough to be treated as prose.",
  ]);
  assert.equal(first.decision_brief.score_breakdown, undefined);
  assert.equal(second.static_story, undefined, "the second hotel only repeated the first one's sentences");
  assert.equal(first.media.hero_image_url, "https://cdn.example.com/1.jpg");
});

test("benefit text is sent the first time its id appears, with English names", () => {
  const { data } = shapeToolPayload(searchPayload());
  const [first, second] = data.results.map((item) => item.membership_benefits.top_interests[0]);
  assert.equal(first.text, "Daily breakfast for two, 100 USD credit, upgrade on arrival when available.");
  assert.equal(first.text_en, "Daily breakfast for two (EN)");
  assert.equal(first.name_en, "100 USD dining credit (EN)");
  assert.equal(first.i18n, undefined);
  assert.deepEqual(second, { id: "5139", tag: "100 USD credit", name: "100 USD dining credit", name_en: "100 USD dining credit (EN)" });
});

test("brief caps long prose but leaves URLs and short lists alone", () => {
  const longText = "word ".repeat(200).trim();
  const payload = {
    object: "tool_result",
    tool: "get_hotel_media",
    status: "ok",
    intent: "media",
    summary: "s",
    data: {
      note: longText,
      image_urls: ["https://cdn.example.com/a.jpg?x=" + "1".repeat(400), "https://cdn.example.com/b.jpg"],
      codes: ["CDG", "ORY", "BVA", "LBG"],
      amenities: [
        { code: "area", text: "Area", value: "35m²" },
        { code: "crib", text: "Crib", value: null },
      ],
    },
  };
  const { data } = shapeToolPayload(payload);
  assert.ok(data.note.length <= 280 && data.note.endsWith("…"));
  assert.equal(data.image_urls[0].length, payload.data.image_urls[0].length);
  assert.deepEqual(data.codes, ["CDG", "ORY", "BVA", "LBG"]);
  assert.deepEqual(data.amenities, ["Area: 35m²"]);
});

test("detail payloads drop top-level copies of the hotel's own briefs", () => {
  const location = { headline: "Central Paris, two minutes from the Tuileries." };
  const payload = {
    object: "tool_result",
    tool: "get_hotel_detail",
    status: "ok",
    intent: "hotel_detail",
    summary: "s",
    data: { hotel: hotel("9", { location_brief: location }), location_brief: location, grounding: { raw: "x" } },
  };
  const { data } = shapeToolPayload(payload);
  assert.equal(data.location_brief, undefined);
  assert.deepEqual(data.hotel.location_brief, location);
  assert.equal(data.grounding, undefined);
});
