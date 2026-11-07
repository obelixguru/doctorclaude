// Tests for the shared alert zones — the contract the user set: the Telegram message and the phone
// alarm must fire at the same moments, on thresholds 60 / 70 / 170 / 180, and a value that just sits
// out of range must stop nagging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertMessage, blindFallMessage, fastDrop, fastDropMessage, forecastLowMessage, zoneAlert, zoneOf } from "./alertZones.ts";

test("a warning about the future cannot be taken for a reading, and names no dose", () => {
  const m = forecastLowMessage("Ryan", 96, 5);
  assert.equal(m, "🔮 <b>Ryan : 96 mg/dL, peut passer sous 70 dans l'heure</b>\nSur son historique, cet avertissement se vérifie environ 5 fois sur 10.\nGarder du sucre à portée.");
  assert.doesNotMatch(forecastLowMessage("Ryan", 96, null), /fois sur 10/);
  assert.doesNotMatch(m, /\d\s*u\b/);
});

test("zones follow the user's thresholds", () => {
  assert.equal(zoneOf(59), "red_low");
  assert.equal(zoneOf(60), "amber_low");
  assert.equal(zoneOf(69), "amber_low");
  assert.equal(zoneOf(70), "normal");
  assert.equal(zoneOf(170), "normal");
  assert.equal(zoneOf(171), "amber_high");
  assert.equal(zoneOf(180), "amber_high");
  assert.equal(zoneOf(181), "red_high");
});

test("entering a worse zone alerts once, staying there is silent", () => {
  assert.equal(zoneAlert(150, 185)?.reason, "enter");   // normal -> red high
  assert.equal(zoneAlert(185, 188), null);              // still high, same step
  assert.equal(zoneAlert(188, 186), null);              // drifting inside the zone
  assert.equal(zoneAlert(150, 175)?.reason, "enter");   // normal -> amber high
  assert.equal(zoneAlert(175, 178), null);              // still amber
});

test("a further step away from range alerts again", () => {
  assert.equal(zoneAlert(185, 195)?.reason, "step");    // +10 higher
  assert.equal(zoneAlert(185, 194), null);              // not yet a full step
  assert.equal(zoneAlert(65, 60), null);                // amber to amber: nothing to say
  assert.equal(zoneAlert(59, 54)?.reason, "step");      // -5 lower, still at the severe boundary
  assert.equal(zoneAlert(58, 53)?.reason, "severe");    // below 54 having been above it
});

test("a severe hypo is never silent (the 55 -> 50 hole)", () => {
  // Both floor(55/10) and floor(50/10) are 5, so the old multiple-of-10 rule sent nothing at all.
  const a = zoneAlert(55, 50);
  assert.equal(a?.reason, "severe");
  assert.equal(a?.severe, true);
  assert.match(alertMessage(55, 50, "Léo") ?? "", /TRÈS BASSE/);
});

test("improving is silent until it is back inside 70-170", () => {
  assert.equal(zoneAlert(250, 200), null);
  assert.equal(zoneAlert(200, 175), null);              // red -> amber: no message
  assert.equal(zoneAlert(175, 150)?.reason, "recovery");
  assert.equal(zoneAlert(150, 140), null);              // already normal
  assert.match(alertMessage(175, 150, "Léo") ?? "", /revenue à la normale/);
});

test("a value hovering on an amber boundary does not flap", () => {
  assert.equal(zoneAlert(169, 171), null);              // inside the deadband
  assert.equal(zoneAlert(171, 169), null);              // ...and back again
  assert.equal(zoneAlert(169, 173)?.reason, "enter");   // clearly inside -> one message
  assert.equal(zoneAlert(71, 69), null);
  assert.equal(zoneAlert(71, 67)?.reason, "enter");
});

test("the amber band is the hysteresis for a red episode", () => {
  // 250 -> 175 (amber, silent) -> 183 must NOT read as a brand-new hyper.
  assert.equal(zoneAlert(250, 175), null);
  assert.equal(zoneAlert(175, 183)?.reason, "enter");
  // ...which is the one message the parent does want: it went back over 180 from the amber band.
  // Sitting there afterwards stays silent.
  assert.equal(zoneAlert(183, 186), null);
});

test("messages name the patient and match the zone", () => {
  assert.match(alertMessage(150, 190, "Ana") ?? "", /Ana.*190.*haute/);
  assert.match(alertMessage(150, 175, "Ana") ?? "", /presque haute/);
  assert.match(alertMessage(100, 65, "Ana") ?? "", /presque basse/);
  assert.match(alertMessage(65, 58, "Ana") ?? "", /🚨/);
  assert.equal(alertMessage(120, 130, "Ana"), null);
});

test("an amber zone moving BACK toward range no longer pushes", () => {
  // Same principle as the in-app banner: a warning about a glucose already coming home is noise,
  // and a channel that cries wolf stops being read. Red zones keep alerting whatever the direction.
  assert.equal(alertMessage(182, 175, "Ryan"), null);        // coming down through the amber high
  assert.notEqual(alertMessage(168, 175, "Ryan"), null);     // still climbing into it
  assert.equal(alertMessage(61, 66, "Ryan"), null);          // climbing out of the amber low
  assert.notEqual(alertMessage(72, 66, "Ryan"), null);       // still falling into it
  // A red low still fires on the way IN, whatever the amber rule does above it.
  assert.notEqual(alertMessage(66, 57, "Ryan"), null);
  // (52 -> 57 is silent because re-alerting only fires on a further step AWAY from range — the
  // pre-existing rule that keeps a sitting hypo from re-ringing every five minutes.)
});

test("a fall between two runs: big, fast, recent and still in range, nothing else", () => {
  const min = 60000;
  const now = (v: number) => ({ t: 100 * min, v });
  const was = (v: number, ago: number) => ({ t: (100 - ago) * min, v });
  assert.deepEqual(fastDrop(was(255, 18), now(143)), { from: 255, minutes: 18 });
  assert.deepEqual(fastDrop(was(143, 12), now(73)), { from: 143, minutes: 12 });
  assert.equal(fastDrop(was(130, 10), now(95)), null, "35: not big enough");
  assert.equal(fastDrop(was(170, 20), now(120)), null, "2.5 a minute: a normal fall");
  assert.equal(fastDrop(was(250, 60), now(120)), null, "an hour old: not where it fell from");
  assert.equal(fastDrop(was(143, 12), now(62)), null, "under 70 the zones speak");
  assert.equal(fastDrop(was(300, 10), now(250)), null, "above 180 it is good news");
  assert.equal(fastDrop(null, now(100)), null);
  assert.equal(fastDrop(was(100, 12), now(150)), null, "rising");
});

test("back in range at full speed is not good news", () => {
  const drop = { from: 255, minutes: 18 };
  const m = alertMessage(255, 143, "Ryan", drop) ?? "";
  assert.match(m, /Ryan : 143 mg\/dL, ça descend vite/);
  assert.match(m, /255 il y a 18 min/);
  assert.doesNotMatch(m, /normale|✅/);
  assert.match(alertMessage(255, 143, "Ryan") ?? "", /revenue à la normale/);
  assert.match(alertMessage(175, 150, "Ryan", null) ?? "", /revenue à la normale/);
  // Only that sentence changes: everything the zones say stands.
  assert.match(alertMessage(100, 55, "Ryan", drop) ?? "", /basse/);
  assert.equal(alertMessage(120, 100, "Ryan", drop), null);
});

test("what these messages say: a value, a fall, and never a dose", () => {
  for (const m of [fastDropMessage("Ryan", 73, { from: 143, minutes: 12 }), blindFallMessage("Ryan", 150, 12.4)]) {
    assert.match(m, /Ryan/);
    assert.match(m, /sucre à portée/);
    assert.doesNotMatch(m, /\bu\b|insuline|Fiasp/);
  }
  assert.match(blindFallMessage("Ryan", 150, 12.4), /depuis 12 min/);
  assert.match(blindFallMessage("Ryan", 150, 12.4), /au doigt/);
});
