// History — ported from ui/HistoryScreen.kt. Three tabs: the general picture, the past AI reports,
// and the injections.
//
// The window matters more than it looks: the CGM cloud only serves a rolling ~12–24 h, which is why
// the app persists readings server-side. This screen is the only place the family can see a WEEK.

import { el, clear, mount, hhmm, ddmm } from "../util.js";
import { t } from "../i18n.js";
import * as store from "../store.js";
import { state } from "../store.js";
import { statusOf, LOW_WARN, HIGH_WARN } from "../zones.js";
import { drawGraph } from "../graph.js";

export function history() {
  const root = el("div");
  let tab = "general";
  let days = 7;

  store.loadHistory(days);
  render();
  return root;

  function render() {
    clear(root);
    mount(root,
      el("h1.h1", { style: "padding:10px 2px 12px", text: t("historyScreenTitle") }),
      el("div.seg", { style: "margin-bottom:12px" }, [
        el("button", { class: tab === "general" ? "on" : "", text: t("generalTab"), onclick: () => { tab = "general"; render(); } }),
        el("button", { class: tab === "analyses" ? "on" : "", text: t("pastAnalyses"), onclick: () => { tab = "analyses"; render(); } }),
        el("button", { class: tab === "injections" ? "on" : "", text: t("injections"), onclick: () => { tab = "injections"; render(); } }),
      ]),
      tab === "general" ? general() : tab === "analyses" ? analyses() : injections(),
    );
  }

  function dayPicker() {
    return el("div.seg", { style: "margin-bottom:12px" },
      [1, 7, 14].map((d) => el("button", {
        class: days === d ? "on" : "",
        text: d === 1 ? t("periodLast24h") : t("periodOverDays", d),
        onclick: async () => { days = d; await store.loadHistory(d); render(); },
      })));
  }

  function general() {
    const wrap = el("div", {}, [dayPicker()]);
    const readings = state.storedReadings ?? [];

    if (readings.length < 2) {
      wrap.append(el("div.card", {}, [el("p.small.dim.center", { style: "margin:22px 0", text: t("historyEmpty") })]));
      return wrap;
    }

    const card = el("div.card.tight");
    const canvas = el("canvas.chart");
    card.append(canvas);
    wrap.append(card);

    const events = [
      ...(state.storedMeals ?? []).map((m) => ({ ts: m.ts, kind: "meal" })),
      ...(state.insulin ?? []).map((d) => ({ ts: d.ts, kind: "insulin" })),
    ];
    requestAnimationFrame(() => drawGraph(canvas, readings, events));

    // Time in range over the shown window, computed from the readings themselves so the figure
    // always matches the curve above it.
    const n = readings.length;
    const low = readings.filter((r) => r.value < LOW_WARN).length;
    const high = readings.filter((r) => r.value > HIGH_WARN).length;
    const pLow = Math.round((low / n) * 100);
    const pHigh = Math.round((high / n) * 100);
    const tir = Math.max(0, 100 - pLow - pHigh);
    const avg = Math.round(readings.reduce((s, r) => s + r.value, 0) / n);

    wrap.append(el("div.card", {}, [
      el("div.eyebrow", { text: days === 1 ? t("periodLast24h") : t("periodOverDays", days) }),
      el("div.stats", { style: "margin-top:10px" }, [
        el("div.stat", {}, [el("div.n", { text: String(avg) }), el("div.tiny.dim", { text: t("average") })]),
        el("div.stat", {}, [el("div.n", { style: "color:var(--warn-2)", text: `${pHigh}%` }), el("div.tiny.dim", { text: t("statHigh") })]),
        el("div.stat", {}, [el("div.n", { style: "color:var(--danger-2)", text: `${pLow}%` }), el("div.tiny.dim", { text: t("statLow") })]),
      ]),
      el("div.tir", { style: "margin-top:12px" }, [
        el("i", { style: `width:${pLow}%;background:var(--danger)` }),
        el("i", { style: `width:${tir}%;background:var(--good)` }),
        el("i", { style: `width:${pHigh}%;background:var(--warn)` }),
      ]),
      el("div.row.between.tiny.dim", { style: "margin-top:6px" }, [
        el("span", { text: `${LOW_WARN}–${HIGH_WARN} mg/dL` }),
        el("span", { text: `${tir}%` }),
      ]),
    ]));
    return wrap;
  }

  function analyses() {
    const wrap = el("div", {}, [dayPicker()]);
    const list = state.analyses ?? [];
    if (!list.length) {
      wrap.append(el("div.card", {}, [el("p.small.dim", { text: t("historyEmpty") })]));
      return wrap;
    }
    for (const a of list) {
      wrap.append(el("div.card", {}, [
        el("div.row.between", {}, [
          el("div.eyebrow", { text: `${ddmm(a.ts)} ${hhmm(a.ts)}` }),
          a.glucose != null
            ? el("span.tag", { style: `color:var(--${statusOf(a.glucose) === "good" ? "good-2" : statusOf(a.glucose) === "warning" ? "warn-2" : "danger-2"})`, text: `${a.glucose} mg/dL` })
            : null,
        ]),
        el("p.small", { style: "margin:8px 0 0;line-height:1.55;white-space:pre-line", text: a.message ?? "" }),
      ]));
    }
    return wrap;
  }

  function injections() {
    const wrap = el("div", {}, [dayPicker()]);
    const list = state.insulin ?? [];
    const card = el("div.card", {}, [el("div.eyebrow", { text: t("injections") })]);
    if (!list.length) {
      card.append(el("p.small.dim", { style: "margin:12px 0 0", text: t("insulinEmpty") }));
      wrap.append(card);
      return wrap;
    }
    const inner = el("div", { style: "margin-top:8px" });
    for (const d of list) {
      inner.append(el("div.item", {}, [
        el("div.dot.insulin"),
        el("div.grow.col", {}, [
          el("div", { style: "font-weight:700", text: `${d.units} u` }),
          el("div.tiny.dim", { text: [`${ddmm(d.ts)} ${hhmm(d.ts)}`, d.name].filter(Boolean).join(" · ") }),
        ]),
        el("span.tag", { text: d.kind === "basal" ? t("insulinSlowTag") : t("insulinRapidTag") }),
      ]));
    }
    card.append(inner);
    wrap.append(card);
    return wrap;
  }
}
