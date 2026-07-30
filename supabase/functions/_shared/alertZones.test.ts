// Tests for the shared alert zones — the contract the user set: the Telegram message and the phone
// alarm must fire at the same moments, on thresholds 60 / 70 / 170 / 180, and a value that just sits
// out of range must stop nagging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneOf, zoneAlert, alertMessage } from "./alertZones.ts";

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
