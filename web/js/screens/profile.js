// Profile — ported from ui/ProfileScreen.kt. Also the home of the account controls (which person
// this device follows, the language) since the web client has no separate settings screen.
//
// The ratio fields are the ones the dose guard computes from, so they are the doctor's numbers, not
// guesses. The server REJECTS an out-of-range value rather than clamping it (a silently corrected
// ratio is one nobody notices), so a rejected save has to say so out loud rather than look saved.

import { el, clear, mount, intOrNull } from "../util.js";
import { t, setLang, getLang } from "../i18n.js";
import * as store from "../store.js";
import { state } from "../store.js";
import * as api from "../api.js";

// [field, label key, input type]. Names match the server's allow-list in mechabetics-profile.
const FIELDS = [
  ["nickname", "fieldNickname", "text"],
  ["age", "fieldAge", "number"],
  ["weight_kg", "fieldWeight", "number"],
  ["rapid_insulin", "fieldRapidName", "text"],
  ["rapid_units_per_day", "fieldRapidUnits", "number"],
  ["basal_insulin", "fieldBasalName", "text"],
  ["basal_units_per_day", "fieldBasalUnits", "number"],
];

const RATIO_FIELDS = [
  ["carb_ratio", "fieldCarbRatio"],
  ["correction_factor", "fieldCorrection"],
  ["target_mgdl", "fieldTarget"],
];

export function profile(nav, openSheet, onLangChange) {
  const root = el("div");
  let notice = null;
  let busy = false;

  if (!state.profile) store.loadProfile();
  render();
  return root;

  function render() {
    clear(root);
    const p = state.profile ?? {};
    const inputs = {};

    const field = (name, labelKey, type) => {
      const input = el("input", { type, value: p[name] ?? "", ...(type === "number" ? { inputmode: "decimal" } : {}) });
      inputs[name] = input;
      return el("label.field", {}, [el("span", { text: t(labelKey) }), input]);
    };

    const notes = el("textarea", { text: p.notes ?? "" });
    inputs.notes = notes;

    async function save() {
      busy = true; notice = null; render();
      const body = {};
      for (const [name] of [...FIELDS, ...RATIO_FIELDS]) {
        const v = inputs[name]?.value?.trim();
        if (v) body[name] = /^(age|weight_kg|rapid_units_per_day|basal_units_per_day|carb_ratio|correction_factor|target_mgdl)$/.test(name)
          ? Number(v.replace(",", "."))
          : v;
      }
      if (inputs.notes?.value?.trim()) body.notes = inputs.notes.value.trim();
      body.lang = getLang();

      const r = await api.profile.save(state.subject, body);
      busy = false;
      // A rejected value comes back as an error; showing it verbatim is the point — the user needs
      // to know WHICH figure was refused, not that "something went wrong".
      notice = r?.error ? { kind: "bad", text: r.error } : { kind: "info", text: t("profileSaved") };
      await store.loadProfile();
      render();
    }

    mount(root,
      el("h1.h1", { style: "padding:10px 2px 4px", text: t("profileTitle") }),
      el("p.small.muted", { style: "margin:0 2px 14px;line-height:1.5", text: t("profileIntro") }),
      notice ? el(`div.banner.${notice.kind}`, { text: notice.text }) : null,

      accountCard(),

      el("div.card", {}, [
        ...FIELDS.map(([n, l, ty]) => field(n, l, ty)),
        el("label.field", {}, [el("span", { text: t("fieldNotes") }), notes]),
      ]),

      el("div.card", {}, [
        el("div.eyebrow", { text: t("ratiosDoctor") }),
        el("div", { style: "height:10px" }),
        ...RATIO_FIELDS.map(([n, l]) => field(n, l, "number")),
        el("p.disclaimer", { text: t("doseDisclaimer") }),
      ]),

      el("button.btn", { text: busy ? t("autoSaving") : t("saveProfile"), disabled: busy, onclick: save }),
      el("div", { style: "height:10px" }),
      el("button.btn.subtle", { text: t("logout"), onclick: confirmLogout }),
      el("div", { style: "height:14px" }),
      installCard(),
    );
  }

  // ── Which person, and which language ─────────────────────────────────────────────────────────
  function accountCard() {
    const card = el("div.card", {}, [el("div.eyebrow", { text: t("patientPick") })]);

    if (state.patients.length) {
      const sel = el("select", {
        onchange: async (e) => {
          await store.setPatient(e.target.value);
          store.refreshGlucose();
          store.loadMeals();
          store.loadProfile();
          render();
        },
      }, state.patients.map((p) => el("option", {
        value: p.patientId,
        selected: p.patientId === state.activePatientId,
        text: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.patientId.slice(0, 8),
      })));
      card.append(el("label.field", { style: "margin-top:10px" }, [sel]));
    }

    const langSel = el("select", {
      onchange: (e) => {
        state.lang = e.target.value;
        setLang(state.lang);
        store.persist();
        onLangChange?.();
      },
    }, [
      el("option", { value: "fr", selected: getLang() === "fr", text: "Français" }),
      el("option", { value: "es", selected: getLang() === "es", text: "Español" }),
    ]);
    card.append(el("label.field", {}, [el("span", { text: t("language") }), langSel]));
    return card;
  }

  function installCard() {
    return el("div.card", {}, [
      el("div.eyebrow", { text: t("installTitle") }),
      el("p.small.muted", { style: "margin:8px 0 0;line-height:1.5", text: t("installBody") }),
    ]);
  }

  function confirmLogout() {
    openSheet({
      title: t("logout"),
      body: el("div.small.muted", { text: t("loginSubtitle") }),
      confirmLabel: t("logout"),
      danger: true,
      onConfirm: () => { store.logout(); },
    });
  }
}
