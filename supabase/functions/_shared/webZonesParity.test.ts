// The alert thresholds now live in FOUR places: this server module, the Android app
// (data/GlucoseAlert.kt), the Telegram monitor that imports it, and the web client
// (web/js/zones.js). The user's rule is that they all fire at the same moments —
// "il faut qu'elle sonne dans les mêmes moments".
//
// Three of those are prose-checked by review. This one is not: the web port is a real second
// implementation, so it is swept against the original here across the whole plausible glucose
// range. A drift in either file — a boundary moved, a deadband dropped — fails the suite instead of
// silently making the mother's screen disagree with the alert the rest of the family gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneAlert as srvAlert, zoneOf as srvZone } from "./alertZones.ts";
// @ts-ignore — the web client is plain JS on purpose (no build step, so it can be hosted anywhere).
import { zoneAlert as webAlert, zoneOf as webZone } from "../../../web/js/zones.js";

test("web zoneOf matches the server across 20..450 mg/dL", () => {
  for (let v = 20; v <= 450; v++) {
    assert.equal(webZone(v), srvZone(v), `zoneOf disagrees at ${v}`);
  }
});

test("web zoneAlert matches the server for every prev→cur pair in range", () => {
  // Stepping by 3 keeps the sweep ~20k pairs (fast) while still landing on and around every
  // boundary and deadband: 54, 60, 70, 170, 180, and the 5/10 mg/dL step rules.
  for (let prev = 30; prev <= 400; prev += 3) {
    for (let cur = 30; cur <= 400; cur += 3) {
      const s = srvAlert(prev, cur);
      const w = webAlert(prev, cur);
      assert.deepEqual(w, s, `zoneAlert disagrees for ${prev} -> ${cur}`);
    }
  }
});

test("web zoneAlert matches the server on the exact boundary values", () => {
  // The stepped sweep can miss a single-point disagreement, so every threshold and its neighbours
  // are also crossed against every other one.
  const edges = [53, 54, 55, 59, 60, 61, 66, 67, 68, 69, 70, 71, 72, 73,
                 168, 169, 170, 171, 172, 173, 179, 180, 181, 185, 190, 191];
  for (const prev of edges) {
    for (const cur of edges) {
      assert.deepEqual(webAlert(prev, cur), srvAlert(prev, cur), `zoneAlert disagrees for ${prev} -> ${cur}`);
    }
  }
});
