// Meals — ported from ui/FoodScreen.kt.
//
// The point of this screen is the PROSPECTIVE question: "if I eat this, how much insulin?", asked
// BEFORE the meal. That is what `plan` is for, and why the plan line is given the most prominent
// place on the card rather than being tucked under the entry. Advice that only arrives after the
// food is eaten is of no use to anybody.
//
// Every number in the plan line comes from the server's dose guard. This screen only displays it —
// it never computes, rounds or adjusts a dose. The LLM contributes words, never figures.

import { el, clear, mount, hhmm, ddmm, intOrNull } from "../util.js";
import { t, getLang } from "../i18n.js";
import * as store from "../store.js";
import { state } from "../store.js";
import * as api from "../api.js";
import * as voice from "../voice.js";

export function food(nav, openSheet) {
  const root = el("div");
  let busy = false;
  let lastPlan = null;      // { planLine, totalUnits, carbsG, productName, carbSource }
  let notice = null;

  if (!state.meals.length) store.loadMeals();
  render();
  return root;

  function render() {
    clear(root);
    mount(root,
      el("div.row.between", { style: "padding:10px 2px 12px" }, [
        el("h1.h1", { text: t("foodTitle") }),
      ]),
      notice ? el(`div.banner.${notice.kind}`, { text: notice.text }) : null,
      lastPlan ? planCard() : null,
      composer(),
      list(),
    );
  }

  // ── The answer to "how much insulin for this?" ───────────────────────────────────────────────
  function planCard() {
    const p = lastPlan;
    return el("div.card", { style: "border-color:var(--accent-2)" }, [
      el("div.eyebrow", { style: "color:var(--accent)", text: t("predictTitle") }),
      p.productName ? el("div", { style: "font-weight:700;margin-top:6px", text: p.productName }) : null,
      p.carbsG != null
        ? el("div.small.muted", { style: "margin-top:2px", text: `${p.carbsG} g` })
        : null,
      p.planLine
        ? el("p", { style: "margin:10px 0 0;font-size:15px;line-height:1.5;font-weight:600;white-space:pre-line", text: p.planLine })
        : el("p.small.muted", { style: "margin:10px 0 0", text: t("foodSaved") }),
      el("p.disclaimer", { text: t("doseDisclaimer") }),
    ]);
  }

  // ── Entry ────────────────────────────────────────────────────────────────────────────────────
  function composer() {
    const desc = el("input", { type: "text", placeholder: t("foodDescHint") });
    const carbs = el("input", { type: "number", inputmode: "numeric", min: "0", placeholder: t("foodCarbsHint") });
    const qty = el("input", { type: "number", inputmode: "numeric", min: "1", value: "1", placeholder: t("foodQtyHint") });
    const total = el("div.tiny.dim");

    const syncTotal = () => {
      const c = intOrNull(carbs.value), q = intOrNull(qty.value) || 1;
      total.textContent = c != null && q > 1 ? t("foodQtyTotal", c * q) : "";
    };
    carbs.addEventListener("input", syncTotal);
    qty.addEventListener("input", syncTotal);

    const mic = voice.canListen()
      ? el("button.btn.subtle.auto", { text: "🎤", style: "min-width:52px", onclick: async () => {
          mic.textContent = "…";
          const heard = await voice.listen(getLang(), { onstart: () => { mic.textContent = "●"; } });
          mic.textContent = "🎤";
          if (heard) desc.value = heard;
        } })
      : null;

    // A photo of the plate or the label. `capture` opens the camera directly on a phone; without it
    // iOS shows the photo picker, which is the right fallback on a desktop browser.
    const fileInput = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true,
      onchange: (e) => { const f = e.target.files?.[0]; if (f) doScan(f); } });
    const galleryInput = el("input", { type: "file", accept: "image/*", hidden: true,
      onchange: (e) => { const f = e.target.files?.[0]; if (f) doScan(f); } });

    const submit = async (planned) => {
      const description = desc.value.trim();
      if (!description || busy) return;
      busy = true; notice = { kind: "info", text: t("foodSaving") }; render();
      const args = {
        description,
        carbsG: intOrNull(carbs.value),
        quantity: Math.max(1, intOrNull(qty.value) || 1),
        lang: getLang(),
      };
      const r = planned
        ? await api.meals.plan(state.subject, args)
        : await api.meals.add(state.subject, args);
      busy = false;
      if (!r || r.error) {
        notice = { kind: "bad", text: r?.error ?? t("errorGeneric") };
      } else {
        notice = null;
        lastPlan = {
          planLine: r.planLine ?? null,
          totalUnits: r.plan?.totalUnits ?? r.totalUnits ?? null,
          carbsG: r.carbsG ?? r.plan?.carbsG ?? null,
          productName: r.productName ?? null,
          carbSource: r.carbSource ?? null,
        };
        await store.loadMeals();
      }
      render();
    };

    return el("div.card", {}, [
      el("label.field", {}, [el("span", { text: t("foodDescHint") }),
        el("div.row", { style: "gap:8px" }, [el("div.grow", {}, [desc]), mic].filter(Boolean))]),
      el("div.row", { style: "gap:8px" }, [
        el("label.field.grow", {}, [el("span", { text: t("foodCarbsHint") }), carbs]),
        el("label.field", { style: "width:104px" }, [el("span", { text: t("foodQtyHint") }), qty]),
      ]),
      total,
      el("div.btn-row", { style: "margin-top:6px" }, [
        // "JE VAIS MANGER" comes first and is the accented button: the prospective path is the one
        // the app is built around.
        el("button.btn", { text: t("foodPlan"), disabled: busy, onclick: () => submit(true) }),
        el("button.btn.subtle", { text: t("foodAdd"), disabled: busy, onclick: () => submit(false) }),
      ]),
      el("div.btn-row", { style: "margin-top:8px" }, [
        el("button.btn.subtle", { text: t("foodScanShort"), disabled: busy, onclick: () => fileInput.click() }),
        el("button.btn.subtle", { text: t("foodGalleryShort"), disabled: busy, onclick: () => galleryInput.click() }),
      ]),
      fileInput, galleryInput,
      el("p.tiny.dim", { style: "margin:10px 0 0;line-height:1.45", text: t("foodVoiceHint") }),
    ]);
  }

  // ── Photo → carbs ────────────────────────────────────────────────────────────────────────────
  async function doScan(file) {
    busy = true; notice = { kind: "info", text: t("foodScanning") }; render();
    try {
      const b64 = await toBase64(file);
      const r = await api.scan(b64, state.subject, state.history, getLang(), file.type || "image/jpeg");
      busy = false;
      if (!r || r.error) {
        notice = { kind: "bad", text: r?.error ?? t("foodScanFail") };
      } else {
        notice = null;
        lastPlan = {
          planLine: r.planLine ?? r.analysis ?? null,
          carbsG: r.carbsG ?? null,
          productName: r.productName ?? null,
          carbSource: r.carbSource ?? null,
        };
        await store.loadMeals();
      }
    } catch {
      busy = false;
      notice = { kind: "bad", text: t("foodScanFail") };
    }
    render();
  }

  /** File → raw base64 (no `data:` prefix), which is what mechabetics-scan expects. */
  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = reject;
      fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
      fr.readAsDataURL(file);
    });
  }

  // ── The list ─────────────────────────────────────────────────────────────────────────────────
  function list() {
    const card = el("div.card", {}, [el("div.eyebrow", { text: t("history") })]);
    if (!state.meals.length) {
      card.append(el("p.small.dim", { style: "margin:12px 0 0", text: t("foodEmpty") }));
      return card;
    }
    const wrap = el("div", { style: "margin-top:8px" });
    for (const m of state.meals) {
      wrap.append(el("div.item", {}, [
        el("div.dot.meal"),
        el("div.grow.col", {}, [
          el("div", { style: "font-weight:600", text: m.description || "—" }),
          el("div.tiny.dim", {
            text: [
              Number.isFinite(m.tsMs) ? `${ddmm(m.tsMs)} ${hhmm(m.tsMs)}` : "",
              m.carbs_g != null ? `${m.carbs_g} g` : "",
              (m.quantity ?? 1) > 1 ? `×${m.quantity}` : "",
            ].filter(Boolean).join(" · "),
          }),
        ]),
        el("div.col", { style: "align-items:flex-end;gap:6px" }, [
          el("span.tag", { text: m.planned ? t("foodPlanned") : t("foodEaten") }),
          el("button.btn.subtle.auto.sm", { text: t("del"), onclick: () => remove(m) }),
        ]),
      ]));
    }
    card.append(wrap);
    return card;
  }

  async function remove(m) {
    openSheet({
      title: t("foodDeleteConfirm"),
      body: el("div.small.muted", { text: m.description || "" }),
      confirmLabel: t("del"),
      danger: true,
      onConfirm: async () => {
        await api.meals.remove(state.subject, m.id);
        await store.loadMeals();
        render();
      },
    });
  }
}
