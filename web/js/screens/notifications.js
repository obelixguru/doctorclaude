// Notifications & alarms — ported from ui/NotificationSettingsScreen.kt, with one honest
// difference stated at the top of the screen.
//
// THE ANDROID APP CAN ALARM WITH THE PHONE IN A POCKET. A web page cannot: it only runs while it is
// open on screen, and iOS gives no way around that. So this screen does NOT pretend to be a
// background alarm. It says so plainly, and points at the channel that does work — the Telegram
// alert from the server cron, which reaches the parent whatever this phone is doing.
//
// That is not a downgrade of the safety model, it IS the safety model: AlarmPolicy.kt already calls
// the phone alarm "a CONVENIENCE layer" and the parent's Telegram alert "the real safety net". This
// screen just makes the same statement out loud on a device where the convenience layer is weaker.

import { el, clear, mount } from "../util.js";
import { t } from "../i18n.js";
import * as store from "../store.js";
import { state } from "../store.js";
import * as voice from "../voice.js";

export function notifications(nav, openSheet) {
  const root = el("div");
  render();
  return root;

  function set(key, value) {
    state.settings[key] = value;
    store.persist();
    render();
  }

  function toggle(labelKey, subKey, key, opts = {}) {
    const input = el("input", {
      type: "checkbox",
      checked: !!state.settings[key],
      onchange: (e) => {
        // Turning the hypo alarm off is the one choice that gets a confirmation, the way the app
        // warns before making a low vibrate-only: it is the alert you least want to lose.
        if (key === "hypoEnabled" && !e.target.checked) {
          e.target.checked = true;
          openSheet({
            title: t("notifHypoLabel"),
            body: el("div.small", { style: "line-height:1.5", text: t("notifHypoWarn") }),
            confirmLabel: t("confirm"),
            danger: true,
            onConfirm: () => set(key, false),
          });
          return;
        }
        set(key, e.target.checked);
      },
    });
    return el("div.switch", {}, [
      el("div.col.grow", {}, [
        el("div", { style: "font-weight:600", text: t(labelKey) }),
        subKey ? el("div.tiny.dim", { text: t(subKey) }) : null,
        opts.warn ? el("div.tiny", { style: "color:var(--danger-2);margin-top:3px", text: t(opts.warn) }) : null,
      ]),
      input,
    ]);
  }

  function render() {
    clear(root);
    const s = state.settings;

    const volume = el("input", {
      type: "range", min: "0", max: "100", step: "5", value: String(s.volumePct),
      style: "width:100%",
      oninput: (e) => { state.settings.volumePct = Number(e.target.value); },
      onchange: (e) => { state.settings.volumePct = Number(e.target.value); store.persist(); },
    });

    const timeField = (key, labelKey) => {
      const mins = state.settings[key];
      const val = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      return el("label.field.grow", {}, [
        el("span", { text: t(labelKey) }),
        el("input", {
          type: "time", value: val,
          onchange: (e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) set(key, h * 60 + m);
          },
        }),
      ]);
    };

    mount(root,
      el("h1.h1", { style: "padding:10px 2px 12px", text: t("notifPageTitle") }),

      // Said first, before any switch, so nobody configures this expecting a background alarm.
      el("div.banner.warn", { style: "line-height:1.5", text: t("notifWebLimit") }),

      el("div.card", {}, [
        el("div.eyebrow", { text: t("notifModeTitle") }),
        el("div", { style: "height:6px" }),
        toggle("notifModeSound", null, "soundEnabled"),
        el("div", { style: "margin-top:10px" }, [
          el("div.tiny.dim", { style: "margin-bottom:6px", text: t("notifVolumeLabel") }),
          volume,
        ]),
        el("button.btn.subtle", {
          style: "margin-top:12px", text: t("notifTestBtn"),
          onclick: () => { voice.primeAudio(); voice.beep({ volumePct: state.settings.volumePct, times: 2 }); voice.vibrate(); },
        }),
      ]),

      el("div.card", {}, [
        el("div.eyebrow", { text: t("notifTypesTitle") }),
        el("div", { style: "height:6px" }),
        toggle("notifHypoLabel", "notifHypoSub", "hypoEnabled", { warn: s.hypoEnabled ? null : "notifHypoWarn" }),
        toggle("notifHyperLabel", "notifHyperSub", "hyperEnabled"),
      ]),

      el("div.card", {}, [
        el("div.eyebrow", { text: t("notifQuietTitle") }),
        el("p.tiny.dim", { style: "margin:8px 0 0;line-height:1.5", text: t("notifQuietSub") }),
        toggle("notifQuietLabel", null, "quietHoursEnabled"),
        s.quietHoursEnabled
          ? el("div.row", { style: "gap:8px" }, [timeField("quietStartMin", "notifQuietFrom"), timeField("quietEndMin", "notifQuietTo")])
          : null,
        toggle("notifHypoAlwaysLabel", "notifHypoAlwaysSub", "hypoAlwaysSounds"),
      ]),

      el("div.card", {}, [
        el("div.eyebrow", { text: t("voiceLabel") }),
        el("div", { style: "height:6px" }),
        toggle("voiceLabel", "voiceSub", "voiceEnabled"),
      ]),

      el("div.banner.info", { style: "line-height:1.5", text: t("notifTelegramNote") }),
    );
  }
}
