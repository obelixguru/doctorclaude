// Entry point: the consent gate, the tab router, the modal sheet, and the alarm overlay.
//
// MainActivity.kt switches screens with booleans rather than a navigation library; this does the
// same, for the same reason — five screens do not need a router, and a hand-rolled one has no
// history stack to get out of step with the tab bar.

import { el, clear } from "./util.js";
import { t, setLang } from "./i18n.js";
import * as store from "./store.js";
import { state } from "./store.js";
import * as voice from "./voice.js";

import { consentScreen, loginScreen } from "./screens/login.js";
import { dashboard } from "./screens/dashboard.js";
import { food } from "./screens/food.js";
import { insulin } from "./screens/insulin.js";
import { history } from "./screens/history.js";
import { profile } from "./screens/profile.js";
import { notifications } from "./screens/notifications.js";

const appEl = document.getElementById("app");
const tabsEl = document.getElementById("tabs");

const TABS = [
  ["glucose", "tabGlucose", "◉"],
  ["food", "tabMeals", "🍽"],
  ["insulin", "tabInsulin", "💉"],
  ["history", "tabHistory", "📈"],
  ["profile", "tabProfile", "⚙"],
];

let tab = "glucose";
let alarmShown = null;   // the value currently being alarmed about, so it is not re-sounded

// The first tap anywhere unlocks WebAudio. Without it a browser refuses to make a sound, and the
// first hypo alarm of a session — the one that matters most — would be silent.
document.addEventListener("pointerdown", () => voice.primeAudio(), { once: true });

function nav(to) {
  tab = to;
  render();
  window.scrollTo(0, 0);
}

// ── The modal sheet, shared by every screen that needs a confirmation ──────────────────────────
function openSheet({ title, body, confirmLabel, danger, onConfirm }) {
  const scrim = el("div.scrim", {
    onclick: (e) => { if (e.target === scrim) close(); },
  });
  const close = () => scrim.remove();
  scrim.append(el("div.sheet", {}, [
    el("h2", { text: title }),
    body ?? null,
    el("div.btn-row", { style: "margin-top:16px" }, [
      el("button.btn.subtle", { text: t("cancel"), onclick: close }),
      el(`button.btn${danger ? ".danger" : ""}`, {
        text: confirmLabel ?? t("confirm"),
        onclick: async () => { close(); await onConfirm?.(); },
      }),
    ]),
  ]));
  document.body.append(scrim);
}

// ── The alarm overlay ─────────────────────────────────────────────────────────────────────────
function alarmOverlay(alert) {
  const low = alert.zone === "red_low";
  const overlay = el(`div.alarm.${low ? "low" : "high"}`, {}, [
    el("div.ttl", { text: t(low ? "alertLow" : "alertHigh") }),
    el("div.big", { text: String(alert.value) }),
    el("div", { style: "font-size:15px;opacity:.95", text: "mg/dL" }),
    el("p", { style: "font-size:16px;font-weight:600;max-width:300px;line-height:1.45",
      text: t(low ? "alertActLow" : "alertActHigh") }),
    el("button.btn", {
      style: "background:rgba(255,255,255,.22);max-width:280px;margin-top:8px",
      text: t("alertStop"),
      onclick: () => { voice.stopSpeaking(); store.dismissAlert(); },
    }),
    el("p", { style: "font-size:11px;opacity:.9;max-width:300px;line-height:1.4", text: t("notifTelegramNote") }),
  ]);
  return overlay;
}

function maybeSound(alert) {
  if (alarmShown === alert.value) return;
  alarmShown = alert.value;
  // Quiet hours silence the CHIME, never the visual alarm — and a hypo pierces them by default.
  if (state.settings.soundEnabled && !store.quieted(alert.zone)) {
    voice.beep({ volumePct: state.settings.volumePct, times: alert.severe ? 5 : 3 });
  }
  voice.vibrate(alert.severe ? [300, 120, 300, 120, 300] : [220, 120, 220]);
}

// ── Render ────────────────────────────────────────────────────────────────────────────────────
function render() {
  clear(appEl);
  document.querySelector(".alarm")?.remove();

  if (!state.consented) {
    tabsEl.hidden = true;
    appEl.append(consentScreen(() => {
      state.consented = true;
      store.persist();
      render();
    }));
    return;
  }

  if (!state.session || !state.activePatientId) {
    tabsEl.hidden = true;
    appEl.append(loginScreen(() => { store.startPolling(); boot(); render(); }));
    return;
  }

  tabsEl.hidden = false;
  renderTabs();

  const screen =
    tab === "glucose" ? dashboard(nav)
    : tab === "food" ? food(nav, openSheet)
    : tab === "insulin" ? insulin(nav, openSheet)
    : tab === "history" ? history(nav, openSheet)
    : tab === "profile" ? profileWithNotifications()
    : dashboard(nav);

  appEl.append(screen);

  if (state.activeAlert) {
    const a = state.activeAlert;
    maybeSound(a);
    document.body.append(alarmOverlay(a));
  }
}

/** Profile and the notification settings share a tab: the app reaches the latter through a card on
 *  the former (notifCardTitle), so the same path is kept here. */
function profileWithNotifications() {
  let sub = "profile";
  const host = el("div");
  const paint = () => {
    clear(host);
    if (sub === "profile") {
      host.append(
        profile(nav, openSheet, () => { setLang(state.lang); render(); }),
        // A real <button>, not a clickable <div>: a div with an onclick is invisible to VoiceOver
        // and unreachable by keyboard, which would put the alarm settings out of reach of anyone
        // navigating that way.
        el("button.card.cardlink", {
          type: "button",
          onclick: () => { sub = "notifications"; paint(); window.scrollTo(0, 0); },
        }, [
          el("div.row.between", {}, [
            el("div.col", { style: "text-align:left" }, [
              el("div", { style: "font-weight:700", text: t("notifCardTitle") }),
              el("div.tiny.dim", { text: t("notifCardSub") }),
            ]),
            el("div.dim", { text: "›" }),
          ]),
        ]),
      );
    } else {
      host.append(
        el("button.btn.subtle.auto.sm", {
          style: "margin:8px 0", text: `‹ ${t("back")}`,
          onclick: () => { sub = "profile"; paint(); window.scrollTo(0, 0); },
        }),
        notifications(nav, openSheet),
      );
    }
  };
  paint();
  return host;
}

function renderTabs() {
  clear(tabsEl);
  for (const [id, key, ico] of TABS) {
    tabsEl.append(el("button", {
      class: tab === id ? "on" : "",
      // The label is already the button's text; without aria-hidden VoiceOver also reads the emoji
      // ("assiette et couverts, Repas"), which is noise on every single tab.
      "aria-current": tab === id ? "page" : null,
      onclick: () => nav(id),
    }, [el("span.ico", { "aria-hidden": "true", text: ico }), el("span", { text: t(key) })]));
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  if (!state.session) return;
  // A stored session may have expired while the app was closed; refreshing the connections list is
  // what discovers that, and it also re-derives the subject hash the API calls are keyed by.
  const r = await store.refreshPatients();
  if (!r.ok) { render(); return; }
  store.startPolling();
  store.loadMeals();
  store.loadHistory();
  store.loadProfile();
}

store.subscribe(() => {
  // A re-render on every glucose tick would blow away a half-typed meal, so only the screens that
  // are purely a view of the data repaint themselves from the store.
  if (tab === "glucose" || state.activeAlert) render();
});

setLang(state.lang);
render();
boot();

// The service worker is what makes the app installable and lets it open offline. It is registered
// last so a failure here can never keep the app itself from starting.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw", e));
  });
}
