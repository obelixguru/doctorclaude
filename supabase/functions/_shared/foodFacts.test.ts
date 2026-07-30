// Pure-function tests. The network paths are exercised against the live API by hand — what matters
// here is that a country typed by a parent reaches Open Food Facts in the form it actually indexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offCountrySlug } from "./foodFacts.ts";

test("a country typed in French or Spanish still reaches the English index", () => {
  // The failure this prevents is silent: an unmatched country returns no products, we fall back to a
  // global figure, and nothing on screen says the country was ignored.
  for (const spelling of ["Espagne", "España", "espana", "Spain", "  spain  "]) {
    assert.equal(offCountrySlug(spelling), "spain", `«${spelling}» must map to spain`);
  }
  assert.equal(offCountrySlug("Maroc"), "morocco");
  assert.equal(offCountrySlug("Belgique"), "belgium");
  assert.equal(offCountrySlug("États-Unis"), "united-states");
  assert.equal(offCountrySlug("Sénégal"), "senegal");
});

test("an unmapped country is slugified rather than dropped", () => {
  assert.equal(offCountrySlug("New Zealand"), "new-zealand");
  assert.equal(offCountrySlug("Côte d'Ivoire"), "cote-d'ivoire".replace("'", "'"));
});

test("no country means no country filter, never a wrong one", () => {
  assert.equal(offCountrySlug(null), null);
  assert.equal(offCountrySlug(""), null);
  assert.equal(offCountrySlug("   "), null);
});
