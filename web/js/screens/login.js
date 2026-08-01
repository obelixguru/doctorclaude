// Login + the consent gate, ported from ui/LoginScreen.kt and ui/SafetyScreens.kt.
//
// The consent screen is not decoration: the app shows it before anything else on first launch,
// because a tool that talks about insulin has to say plainly, once, that it is not a doctor. It is
// reproduced here word for word.

import { el } from "../util.js";
import { t } from "../i18n.js";
import * as store from "../store.js";

export function consentScreen(onAccept) {
  let checked = false;
  const accept = el("button.btn", { disabled: true, text: t("consentAccept") });
  const box = el("input", {
    type: "checkbox",
    onchange: (e) => { checked = e.target.checked; accept.disabled = !checked; },
  });
  accept.addEventListener("click", () => { if (checked) onAccept(); });

  return el("div", {}, [
    el("div.card", {}, [
      el("h1.h1", { text: t("consentTitle") }),
      el("p.small.muted", { style: "white-space:pre-line;line-height:1.55", text: t("consentBody") }),
      el("label.row", { style: "align-items:flex-start;gap:10px;margin:14px 0" }, [
        box,
        el("span.small", { text: t("consentCheck") }),
      ]),
      accept,
    ]),
  ]);
}

export function loginScreen(onDone) {
  const email = el("input", { type: "email", autocomplete: "username", inputmode: "email",
    autocapitalize: "none", spellcheck: "false", placeholder: "nom@exemple.com" });
  const pass = el("input", { type: "password", autocomplete: "current-password" });
  const err = el("div.banner.bad", { hidden: true });
  const btn = el("button.btn", { text: t("connect") });

  async function submit() {
    const e = email.value.trim(), p = pass.value;
    if (!e || !p) return;
    btn.disabled = true;
    btn.textContent = t("connecting");
    err.hidden = true;
    const r = await store.login(e, p);
    btn.disabled = false;
    btn.textContent = t("connect");
    if (r.ok) return onDone();
    err.hidden = false;
    err.textContent = r.reason === "bad" ? t("loginBad")
      : r.reason === "rate" ? t("loginRate")
      : r.reason === "no_patient" ? t("howItWorksBody")
      : t("loginFail");
  }

  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });

  return el("div", {}, [
    el("div.center", { style: "padding:26px 0 18px" }, [
      el("img", { src: "icons/icon-192.png", alt: "", width: 64, height: 64,
        style: "border-radius:16px;box-shadow:var(--shadow)" }),
      el("h1.h1", { style: "margin-top:12px", text: "Doctor Claude" }),
      el("p.small.muted", { style: "margin:4px 0 0", text: t("loginSubtitle") }),
    ]),
    el("div.card", {}, [
      err,
      el("label.field", {}, [el("span", { text: t("emailLabel") }), email]),
      el("label.field", {}, [el("span", { text: t("passwordLabel") }), pass]),
      btn,
    ]),
    el("div.card", {}, [
      el("div.eyebrow", { text: t("howItWorks") }),
      el("p.small.muted", { style: "margin:8px 0 0;line-height:1.5", text: t("howItWorksBody") }),
    ]),
    el("p.disclaimer.center", { text: t("doseDisclaimer") }),
  ]);
}
