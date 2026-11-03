import assert from "node:assert/strict";
import test from "node:test";
import { buildDestinationProbeTerms, cityNameEquals } from "../src/tools/hotels.mjs";

test("Chinese requests are split into words, destination first", () => {
  assert.deepEqual(buildDestinationProbeTerms("巴黎 蜜月 安静 有特权的酒店"), ["巴黎", "蜜月", "安静", "有特权的酒店"]);
  assert.deepEqual(buildDestinationProbeTerms("东京，带孩子，12月"), ["东京", "带孩子", "12月"]);
});

test("an unbroken Chinese phrase is probed by its leading characters", () => {
  assert.deepEqual(buildDestinationProbeTerms("巴黎蜜月酒店"), ["巴黎蜜月", "巴黎蜜", "巴黎"]);
  assert.deepEqual(buildDestinationProbeTerms("巴黎"), []);
});

test("Latin requests try word pairs before single words and skip travel words", () => {
  assert.deepEqual(buildDestinationProbeTerms("romantic stay new york"), ["stay new", "new york", "new", "york"]);
  assert.ok(!buildDestinationProbeTerms("spa hotel in Bali").includes("spa"));
  assert.deepEqual(buildDestinationProbeTerms("Paris"), []);
});

test("probes are capped", () => {
  assert.equal(buildDestinationProbeTerms("a1 b2 c3 d4 e5 f6 g7 h8 东").length, 6);
});

test("a city counts only when one of its names is the probe term", () => {
  const paris = { cityId: "5990", name: "巴黎", nameEn: "Paris", i18n: { name: { ja: "パリ", ko: "파리" } } };
  assert.ok(cityNameEquals(paris, "巴黎"));
  assert.ok(cityNameEquals(paris, "paris"));
  assert.ok(cityNameEquals(paris, "파리"));
  assert.ok(!cityNameEquals(paris, "巴"));
  assert.ok(!cityNameEquals({ name: "斯帕", nameEn: "Spa" }, "spa hotel"));
});
