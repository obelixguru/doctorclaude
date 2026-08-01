// Insulin — ported from ui/InsulinScreen.kt. Two tabs: the doses logged, and the ratios.
//
// This screen RECORDS what was injected; it never proposes a figure. Every suggested dose in this
// app comes from the server's deterministic guard, computed from the doctor's own ratios — so the
// only numbers typed here are the ones the user actually gave.

import { el, clear, mount, hhmm, ddmm, numOrNull } from "../util.js";
import { t, getLang } from "../i18n.js";
import * as store from "../store.js";
import { state } from "../store.js";
import * as api from "../api.js";

export function insulin(nav, openSheet) {
  const root = el("div");
  let tab = "doses";
  let busy = false;
  let notice = null;

  if (!state.insulin.length) store.loadHistory();
  if (!state.profile) store.loadProfile();
  render();
  return root;

  function render() {
    clear(root);
    mount(root,
      el("h1.h1", { style: "padding:10px 2px 12px", text: t("insulinTitle") }),
      el("div.seg", { style: "margin-bottom:12px" }, [
        el("button", { class: tab === "doses" ? "on" : "", text: t("insulinTabDoses"), onclick: () => { tab = "doses"; render(); } }),
        el("button", { class: tab === "settings" ? "on" : "", text: t("insulinTabSettings"), onclick: () => { tab = "settings"; render(); } }),
      ]),
      notice ? el(`div.banner.${notice.kind}`, { text: notice.text }) : null,
      tab === "doses" ? el("div", {}, [composer(), list()]) : ratios(),
    );
  }

  // ── Log an injection ─────────────────────────────────────────────────────────────────────────
  function composer() {
    const units = el("input", { type: "number", inputmode: "decimal", step: "0.5", min: "0", placeholder: t("insulinUnitsHint") });
    const name = el("input", { type: "text", placeholder: t("insulinNameHint") });
    let kind = "rapid";

    const seg = el("div.seg", { style: "margin-bottom:10px" }, [
      el("button", { class: "on", text: t("insulinRapidTag"), onclick: (e) => pick(e, "rapid") }),
      el("button", { text: t("insulinSlowTag"), onclick: (e) => pick(e, "basal") }),
    ]);
    function pick(e, k) {
      kind = k;
      [...seg.children].forEach((b) => b.classList.toggle("on", b === e.currentTarget));
    }

    async function submit() {
      const u = numOrNull(units.value);
      if (!(u > 0) || busy) return;
      busy = true; notice = null; render();
      const r = await api.meals.addInsulin(state.subject, { units: u, name: name.value.trim() || null, kind });
      busy = false;
      notice = r?.ok ? { kind: "info", text: t("insulinSaved") } : { kind: "bad", text: r?.error ?? t("errorGeneric") };
      await store.loadHistory();
      render();
    }

    return el("div.card", {}, [
      el("div.eyebrow", { text: t("insulinAddTitle") }),
      el("div", { style: "height:10px" }),
      seg,
      el("div.row", { style: "gap:8px" }, [
        el("label.field", { style: "width:110px" }, [el("span", { text: t("insulinUnitsHint") }), units]),
        el("label.field.grow", {}, [el("span", { text: t("insulinNameHint") }), name]),
      ]),
      el("button.btn", { text: t("foodAdd"), disabled: busy, onclick: submit }),
    ]);
  }

  function list() {
    const card = el("div.card", {}, [el("div.eyebrow", { text: t("injections") })]);
    if (!state.insulin.length) {
      card.append(el("p.small.dim", { style: "margin:12px 0 0", text: t("insulinEmpty") }));
      return card;
    }
    const wrap = el("div", { style: "margin-top:8px" });
    for (const d of state.insulin) {
      wrap.append(el("div.item", {}, [
        el("div.dot.insulin"),
        el("div.grow.col", {}, [
          el("div", { style: "font-weight:700", text: `${d.units} u` }),
          el("div.tiny.dim", { text: [`${ddmm(d.ts)} ${hhmm(d.ts)}`, d.name].filter(Boolean).join(" · ") }),
        ]),
        el("div.col", { style: "align-items:flex-end;gap:6px" }, [
          el("span.tag", { text: d.kind === "basal" ? t("insulinSlowTag") : t("insulinRapidTag") }),
          el("button.btn.subtle.auto.sm", { text: t("del"), onclick: () => remove(d) }),
        ]),
      ]));
    }
    card.append(wrap);
    return card;
  }

  async function remove(d) {
    openSheet({
      title: t("insulinDeleteConfirm"),
      body: el("div.small.muted", { text: `${d.units} u · ${ddmm(d.ts)} ${hhmm(d.ts)}` }),
      confirmLabel: t("del"),
      danger: true,
      onConfirm: async () => {
        await api.meals.removeInsulin(state.subject, d.id);
        await store.loadHistory();
        render();
      },
    });
  }

  // ── Ratios (read from the profile; edited on the Profile screen) ─────────────────────────────
  function ratios() {
    const p = state.profile ?? {};
    const has = p.carb_ratio || p.correction_factor || p.target_mgdl;
    const card = el("div.card", {}, [
      el("div.eyebrow", { text: has ? t("ratiosDoctor") : t("ratiosEstimated") }),
      el("div.stats", { style: "margin-top:12px" }, [
        el("div.stat", {}, [
          el("div.n", { text: p.carb_ratio ? String(p.carb_ratio) : "--" }),
          el("div.tiny.dim", { text: "g / u" }),
        ]),
        el("div.stat", {}, [
          el("div.n", { text: p.correction_factor ? String(p.correction_factor) : "--" }),
          el("div.tiny.dim", { text: "mg/dL / u" }),
        ]),
        el("div.stat", {}, [
          el("div.n", { text: p.target_mgdl ? String(p.target_mgdl) : "--" }),
          el("div.tiny.dim", { text: t("target") }),
        ]),
      ]),
      el("button.btn.subtle", { style: "margin-top:14px", text: t("tabProfile"), onclick: () => nav("profile") }),
      el("p.disclaimer", { text: t("doseDisclaimer") }),
    ]);

    // Autotune: the server looks at the logged doses and proposes tighter ratios. Advisory only —
    // applying them writes to the profile, and the wording keeps "à valider avec le médecin".
    const out = el("div");
    const btn = el("button.btn", {
      text: t("autotuneBtn"),
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = t("loading");
        const r = await api.autotune(state.subject, getLang());
        btn.disabled = false;
        btn.textContent = t("autotuneBtn");
        clear(out);
        if (!r || r.error || r.reason === "insufficient_data") {
          out.append(el("p.small.dim", { style: "margin-top:10px", text: r?.message ?? t("historyEmpty") }));
          return;
        }
        out.append(
          el("p.small", { style: "margin:10px 0 0;line-height:1.5;white-space:pre-line", text: r.message ?? "" }),
          el("button.btn.ghost", {
            style: "margin-top:10px", text: t("autotuneApply"),
            onclick: async () => {
              await api.profile.save(state.subject, {
                ...(r.carbRatio ? { carb_ratio: r.carbRatio } : {}),
                ...(r.correctionFactor ? { correction_factor: r.correctionFactor } : {}),
              });
              await store.loadProfile();
              render();
            },
          }),
          el("p.disclaimer", { text: t("doseDisclaimer") }),
        );
      },
    });

    return el("div", {}, [
      card,
      el("div.card", {}, [
        el("div.eyebrow", { text: t("autotuneTitle") }),
        el("p.small.muted", { style: "margin:8px 0 12px;line-height:1.5", text: t("autotuneSub") }),
        btn,
        out,
      ]),
    ]);
  }
}
