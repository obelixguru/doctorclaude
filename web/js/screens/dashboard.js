// The glucose screen — ported from ui/DashboardScreen.kt.
//
// Everything here is gated on FRESHNESS. A number older than the window is not the current glucose,
// so it is not shown as one: the card turns red, says NO SIGNAL, and the curve is hidden. The app's
// wording is deliberate — "fais un test au doigt, ne te fie pas au dernier chiffre".

import { el, clear, hhmm, minutesSince } from "../util.js";
import { t, getLang } from "../i18n.js";
import { TREND } from "../config.js";
import * as store from "../store.js";
import { state } from "../store.js";
import * as api from "../api.js";
import { statusOf, LOW_WARN, HIGH_WARN } from "../zones.js";
import { drawGraph } from "../graph.js";
import * as voice from "../voice.js";

let analysis = null;        // the last coach reply { text, voiceText }
let analysisBusy = false;
let askBusy = false;
let openBadge = null;       // the timestamp of the marker whose badge is showing

export function dashboard(nav) {
  const root = el("div");
  render();
  return root;

  function render() {
    clear(root);
    root.append(header(), glucoseCard(), signalNotes(), chartCard(), statsCard(), coachCard(), askCard());
  }

  // ── Header: who we are following, and the language toggle ───────────────────────────────────
  function header() {
    const p = store.activePatient();
    const name = p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "";
    return el("div.row.between", { style: "padding:10px 2px 12px" }, [
      el("div.col", {}, [
        el("div.eyebrow", { text: t("sensor") }),
        el("div", { style: "font-weight:800;font-size:17px", text: name || "Doctor Claude" }),
      ]),
      state.patients.length > 1
        ? el("button.btn.subtle.auto.sm", { text: t("patientPick"), onclick: () => nav("profile") })
        : null,
    ]);
  }

  // ── The headline number ─────────────────────────────────────────────────────────────────────
  function glucoseCard() {
    const cur = state.current;
    const fresh = store.isFresh();

    if (!cur) {
      return el("div.glucose.lost", {}, [
        el("div.eyebrow", { text: t("current") }),
        el("div.value", { text: "--" }),
        el("div.sub", { text: t("waiting") }),
      ]);
    }

    // Stale: the value exists but is not current. Presented as a STOP state, never as a reading.
    if (!fresh) {
      return el("div.glucose.lost", {}, [
        el("div.eyebrow", { text: t("noSignal") }),
        el("div.row.between", {}, [
          el("div.value", { text: String(cur.value) }),
          el("div.arrow", { text: "⚠" }),
        ]),
        el("div.sub", { text: `${t("signalLost")} ${minutesSince(cur.ts)} min` }),
      ]);
    }

    const status = statusOf(cur.value);
    const tr = TREND[cur.trend];
    const label = status === "danger"
      ? (cur.value < LOW_WARN ? t("statusLow") : t("statusHigh"))
      : status === "warning"
        ? (cur.value < LOW_WARN ? t("statusLow") : t("statusHigh"))
        : t("statusInRange");

    return el(`div.glucose.${status}`, {}, [
      el("div.row.between", {}, [
        el("div.eyebrow", { text: t("current") }),
        el("div.eyebrow", { text: `${t("updated")} ${hhmm(cur.ts)}` }),
      ]),
      el("div.row.between", { style: "align-items:flex-end;margin:6px 0 2px" }, [
        el("div.row", { style: "align-items:baseline;gap:7px" }, [
          el("div.value", { text: String(cur.value) }),
          el("div.unit", { text: "mg/dL" }),
        ]),
        tr ? el("div.arrow", { style: "padding-bottom:6px", text: tr.arrow }) : null,
      ]),
      el("div.row.between", {}, [
        el("div.sub", { style: "font-weight:700", text: label }),
        tr ? el("div.sub", { text: t(tr.key) }) : null,
      ]),
    ]);
  }

  function signalNotes() {
    const notes = el("div");
    if (store.sensorExpired()) {
      notes.append(el("div.banner.bad", { text: `${t("sensorExpired")} — ${t("noSignalSub")}` }));
    } else if (state.current && !store.isFresh()) {
      notes.append(el("div.banner.bad", { text: t("noSignalSub") }));
    }
    if (state.lastError) {
      // Abbott rate-limiting is benign and self-healing, so it gets the reassuring wording. Anything
      // else means we are not talking to the server, which must say so — and say what to do instead.
      const rate = state.lastError === "rate_limited";
      notes.append(el(`div.banner.${rate ? "warn" : "bad"}`, {
        text: rate ? t("loginRate") : t("serverUnreachable"),
      }));
    }
    return notes;
  }

  // ── The curve ───────────────────────────────────────────────────────────────────────────────
  function chartCard() {
    const card = el("div.card.tight");
    if (!store.isFresh() || state.history.length < 2) {
      card.append(el("p.small.dim.center", { style: "margin:26px 0", text: t("graphHidden") }));
      return card;
    }

    const wrap = el("div.chart-wrap");
    const canvas = el("canvas.chart");
    wrap.append(canvas);
    card.append(wrap);

    // Markers: meals RED (glucose goes up), insulin GREEN (glucose comes down).
    const events = [
      ...(state.storedMeals ?? [])
        // A meal is on the curve once its time has passed — `planned` alone would hide an announced
        // meal for ever, since nothing flips that flag back (GlucoseGraph.kt:105).
        .filter((m) => m.ts <= Date.now())
        .map((m) => ({
          ts: m.ts, kind: "meal", id: m.id,
          label: m.description || "—",
          detail: m.carbs_g != null ? `${m.carbs_g} g` : "",
        })),
      ...(state.insulin ?? []).map((d) => ({
        ts: d.ts, kind: "insulin", id: d.id,
        label: d.name || t("insulinTitle"),
        detail: `${d.units} u · ${d.kind === "basal" ? t("insulinSlowTag") : t("insulinRapidTag")}`,
      })),
    ];

    // The canvas has no size until it is laid out, so drawing waits a frame.
    requestAnimationFrame(() => {
      const hits = drawGraph(canvas, state.history, events);
      canvas.onclick = (ev) => {
        const r = canvas.getBoundingClientRect();
        const h = hits.hit(ev.clientX - r.left, ev.clientY - r.top);
        wrap.querySelector(".badge-pop")?.remove();
        if (!h) { openBadge = null; return; }
        openBadge = h.ts;
        wrap.append(badgeFor(h));
      };
      if (openBadge != null) {
        const again = events.find((e) => e.ts === openBadge);
        if (again) {
          const r = hits.hit(0, 0); // placement comes from the event's time, not the old tap point
          void r;
        }
      }
    });

    return card;

    // TAPPING A MARKER SHOWS IT; THE BADGE IS THE DOOR TO THE EDITOR (GlucoseGraph.kt:214-218).
    function badgeFor(h) {
      const pop = el("div.badge-pop", {}, [
        el("b", { text: h.label }),
        el("span.tiny.dim", { text: `${hhmm(h.ts)}${h.detail ? ` · ${h.detail}` : ""}` }),
        el("span.go", {
          text: h.kind === "meal" ? `${t("tabMeals")} →` : `${t("tabInsulin")} →`,
          onclick: () => nav(h.kind === "meal" ? "food" : "insulin"),
        }),
      ]);
      // Placed near the marker, clamped inside the chart, flipping below when there is no room above.
      const w = 200, above = h.y > 74;
      pop.style.left = `${Math.max(4, Math.min(canvas.clientWidth - w - 4, h.x + 6))}px`;
      pop.style.top = above ? `${h.y - 68}px` : `${h.y + 12}px`;
      return pop;
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────────────────────
  function statsCard() {
    const s = state.stats;
    const card = el("div.card", {}, [el("div.eyebrow", { text: t("periodLast24h") })]);
    if (!s) {
      card.append(el("div.skeleton", { style: "width:70%;margin-top:10px" }));
      return card;
    }
    const avg = Math.round(Number(s.avg ?? s.average ?? 0)) || null;
    const high = Math.round(Number(s.high ?? s.pct_high ?? 0));
    const low = Math.round(Number(s.low ?? s.pct_low ?? 0));
    const tir = Math.max(0, 100 - high - low);

    card.append(
      el("div.stats", { style: "margin-top:10px" }, [
        el("div.stat", {}, [el("div.n", { text: avg ? String(avg) : "--" }), el("div.tiny.dim", { text: t("average") })]),
        el("div.stat", {}, [el("div.n", { style: "color:var(--warn-2)", text: `${high}%` }), el("div.tiny.dim", { text: t("statHigh") })]),
        el("div.stat", {}, [el("div.n", { style: "color:var(--danger-2)", text: `${low}%` }), el("div.tiny.dim", { text: t("statLow") })]),
      ]),
      el("div.tir", { style: "margin-top:12px" }, [
        el("i", { style: `width:${low}%;background:var(--danger)` }),
        el("i", { style: `width:${tir}%;background:var(--good)` }),
        el("i", { style: `width:${high}%;background:var(--warn)` }),
      ]),
      el("div.row.between.tiny.dim", { style: "margin-top:6px" }, [
        el("span", { text: `${LOW_WARN}–${HIGH_WARN} mg/dL` }),
        el("span", { text: `${tir}%` }),
      ]),
    );
    return card;
  }

  // ── The coach ───────────────────────────────────────────────────────────────────────────────
  function coachCard() {
    const card = el("div.card");
    const head = el("div.row.between", {}, [
      el("div.eyebrow", { text: t("momTitle") }),
      el("div.row", { style: "gap:6px" }, [
        voice.isSpeaking()
          ? el("button.btn.subtle.auto.sm", { text: t("voiceStop"), onclick: () => { voice.stopSpeaking(); render(); } })
          : null,
        el("button.btn.auto.sm", {
          text: analysisBusy ? t("askThinking") : t("analyze"),
          disabled: analysisBusy || !state.subject,
          onclick: runAnalysis,
        }),
      ]),
    ]);
    card.append(head);

    if (analysisBusy) {
      card.append(el("div", { style: "margin-top:12px" }, [
        el("div.skeleton", { style: "width:100%" }),
        el("div.skeleton", { style: "width:88%;margin-top:7px" }),
        el("div.skeleton", { style: "width:64%;margin-top:7px" }),
      ]));
    } else if (analysis?.text) {
      card.append(el("p.small", { style: "margin:12px 0 0;line-height:1.55;white-space:pre-line", text: analysis.text }));
      card.append(el("p.disclaimer", { text: t("doseDisclaimer") }));
    } else {
      card.append(el("p.small.dim", { style: "margin:12px 0 0", text: t("foodVoiceHint") }));
    }
    return card;
  }

  async function runAnalysis() {
    if (!state.subject) return;
    analysisBusy = true;
    render();
    const wantVoice = state.settings.voiceEnabled;
    const r = await api.coach(state.subject, state.history, getLang(), { speak: wantVoice, force: true });
    analysisBusy = false;
    analysis = r ? { text: r.analysis ?? r.text ?? r.message ?? "", voiceText: r.voiceText ?? null } : null;
    render();
    // Speak the server's phrase VERBATIM — never a locally composed one (see voice.js).
    if (wantVoice && analysis?.voiceText) voice.speak(analysis.voiceText, getLang()).then(render);
  }

  // ── Ask a question ──────────────────────────────────────────────────────────────────────────
  function askCard() {
    const input = el("input", { type: "text", placeholder: t("askPlaceholder") });
    const send = el("button.btn.auto", { text: askBusy ? t("askThinking") : t("askSend"), disabled: askBusy });
    const mic = voice.canListen()
      ? el("button.btn.subtle.auto", { text: "🎤", style: "min-width:52px", onclick: startListening })
      : null;

    send.addEventListener("click", () => submit(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(input.value); });

    async function startListening() {
      mic.textContent = "…";
      const heard = await voice.listen(getLang(), { onstart: () => { mic.textContent = "●"; } });
      mic.textContent = "🎤";
      if (heard) { input.value = heard; submit(heard); }
    }

    async function submit(q) {
      const question = String(q ?? "").trim();
      if (!question || askBusy || !state.subject) return;
      askBusy = true;
      render();
      const r = await api.ask(question, state.subject, state.history, getLang());
      askBusy = false;
      analysis = r ? { text: r.answer ?? r.analysis ?? r.text ?? "", voiceText: r.voiceText ?? null } : null;
      render();
      if (state.settings.voiceEnabled && analysis?.voiceText) voice.speak(analysis.voiceText, getLang()).then(render);
    }

    return el("div.card", {}, [
      el("div.row", { style: "gap:8px" }, [el("div.grow", {}, [input]), mic, send].filter(Boolean)),
    ]);
  }
}
