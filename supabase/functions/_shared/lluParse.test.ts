// Tests for the LibreLinkUp wire parsing behind `mechabetics-llu` (the web client's proxy).
// The stakes here are narrow but absolute: a misread timestamp makes OLD DATA LOOK LIVE, and every
// downstream freshness check — the dose guard's staleness gate included — trusts this epoch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostOf, parseMeasurement, parseTimestamp, redirectRegionOf, sensorEndMs } from "./lluParse.ts";

test("US format is read as UTC, not as the runtime's zone", () => {
  // 2:32:11 PM UTC on 15 May 2026. Parsed with Date.parse this would shift by the server's offset.
  assert.equal(parseTimestamp("5/15/2026 2:32:11 PM"), Date.UTC(2026, 4, 15, 14, 32, 11));
  assert.equal(parseTimestamp("5/15/2026 2:32:11 AM"), Date.UTC(2026, 4, 15, 2, 32, 11));
  assert.equal(parseTimestamp("05/15/2026 02:32:11 PM"), Date.UTC(2026, 4, 15, 14, 32, 11));
});

test("midnight and noon are the cases a naive +12 gets wrong", () => {
  assert.equal(parseTimestamp("1/2/2026 12:00:00 AM"), Date.UTC(2026, 0, 2, 0, 0, 0));
  assert.equal(parseTimestamp("1/2/2026 12:00:00 PM"), Date.UTC(2026, 0, 2, 12, 0, 0));
  assert.equal(parseTimestamp("1/2/2026 12:59:59 AM"), Date.UTC(2026, 0, 2, 0, 59, 59));
});

test("ISO form is accepted too", () => {
  assert.equal(parseTimestamp("2026-05-15T14:32:11"), Date.UTC(2026, 4, 15, 14, 32, 11));
});

test("anything unrecognised is dropped, never stamped 'now'", () => {
  assert.equal(parseTimestamp(""), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp("not a date"), null);
  assert.equal(parseTimestamp("15/05/2026 14:32:11"), null);   // day-first: month 15 is refused
  assert.equal(parseTimestamp("2/31/2026 1:00:00 PM"), null);  // would silently roll to Mar 3
  assert.equal(parseTimestamp("5/15/2026 13:00:00 PM"), null); // 13 on a 12-hour clock
});

test("a measurement without a usable value or time is dropped", () => {
  assert.equal(parseMeasurement(null), null);
  assert.equal(parseMeasurement({ ValueInMgPerDl: 0, FactoryTimestamp: "5/15/2026 2:32:11 PM" }), null);
  assert.equal(parseMeasurement({ ValueInMgPerDl: 120, FactoryTimestamp: "garbage" }), null);
  assert.equal(parseMeasurement({ FactoryTimestamp: "5/15/2026 2:32:11 PM" }), null);
});

test("FactoryTimestamp (UTC) wins over the patient-local Timestamp", () => {
  const m = parseMeasurement({
    ValueInMgPerDl: 132,
    FactoryTimestamp: "5/15/2026 2:32:11 PM",
    Timestamp: "5/15/2026 4:32:11 PM",
    TrendArrow: 3,
  });
  assert.equal(m?.ts, Date.UTC(2026, 4, 15, 14, 32, 11));
  assert.equal(m?.value, 132);
  assert.equal(m?.trend, 3);
});

test("Timestamp is the fallback when FactoryTimestamp is absent", () => {
  const m = parseMeasurement({ Value: 88, Timestamp: "5/15/2026 4:32:11 PM" });
  assert.equal(m?.ts, Date.UTC(2026, 4, 15, 16, 32, 11));
  assert.equal(m?.value, 88);
});

test("only trend arrows 1..5 survive; anything else is 'unknown'", () => {
  const at = (t: unknown) => parseMeasurement({ Value: 100, Timestamp: "5/15/2026 1:00:00 PM", TrendArrow: t })?.trend;
  assert.equal(at(1), 1);
  assert.equal(at(5), 5);
  assert.equal(at(0), null);
  assert.equal(at(6), null);
  assert.equal(at(undefined), null);
});

test("the region redirect is recognised even though it arrives as HTTP 200", () => {
  assert.equal(redirectRegionOf({ status: 0, data: { redirect: true, region: "fr" } }), "fr");
  assert.equal(redirectRegionOf({ data: { redirect: false, region: "fr" } }), null);
  assert.equal(redirectRegionOf({ data: { redirect: true, region: "" } }), null);
  assert.equal(redirectRegionOf({ data: { graphData: [] } }), null);
  assert.equal(redirectRegionOf(null), null);
});

test("host follows the region, defaulting to the global entry point", () => {
  assert.equal(hostOf(null), "api.libreview.io");
  assert.equal(hostOf(undefined), "api.libreview.io");
  assert.equal(hostOf("fr"), "api-fr.libreview.io");
});

test("sensor expiry is 14 days after activation (epoch seconds in, ms out)", () => {
  const act = Math.floor(Date.UTC(2026, 4, 1, 12, 0, 0) / 1000);
  assert.equal(sensorEndMs({ sensor: { a: act } }), act * 1000 + 14 * 24 * 3600 * 1000);
  assert.equal(sensorEndMs({ sensor: { a: 0 } }), null);
  assert.equal(sensorEndMs({}), null);
  assert.equal(sensorEndMs(null), null);
});
