// Voice in and voice out, using what iOS Safari gives us natively.
//
// OUT — SpeechSynthesis, the browser's built-in voice. This is the web equivalent of the app's
// `ai/NativeTts.kt` (the free on-device Android voice), and it is free and offline in the same way.
// The premium ElevenLabs voice is a Hosted-tier server feature; nothing here tries to reproduce it.
//
// WHAT IS SPOKEN IS EXACTLY WHAT THE SERVER SENT. The app once read out an invented "pain blanc"
// because a hard-coded list of examples was appended to the spoken text on the client side — the
// model had not said it. So this module never composes, appends to, or edits the phrase: it speaks
// `voiceText` verbatim, or it stays silent.
//
// IN — webkitSpeechRecognition. Present on iOS Safari, but it must be started from a real user
// gesture (a tap), which is why `listen()` is only ever called from a button handler.

let currentUtterance = null;

export const canSpeak = () => typeof window.speechSynthesis !== "undefined";

/** Speak `text` verbatim. Returns a promise that settles when it finishes or is stopped. */
export function speak(text, lang = "fr") {
  return new Promise((resolve) => {
    if (!canSpeak() || !text) return resolve();
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = lang === "es" ? "es-ES" : "fr-FR";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onend = u.onerror = () => { currentUtterance = null; resolve(); };
    currentUtterance = u;
    // iOS keeps a paused queue alive across page shows; resuming first avoids a silent utterance.
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (!canSpeak()) return;
  try { window.speechSynthesis.cancel(); } catch { /* nothing to cancel */ }
  currentUtterance = null;
}

export const isSpeaking = () =>
  canSpeak() && (window.speechSynthesis.speaking || currentUtterance != null);

// ── Speech recognition ────────────────────────────────────────────────────────────────────────

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canListen = () => typeof Recognition !== "undefined";

/**
 * Listen once and resolve with the transcript (or null). MUST be called from a tap handler.
 * `onstart` fires when the mic is actually live, so the UI only says "J'ÉCOUTE…" when it is true.
 */
export function listen(lang = "fr", { onstart } = {}) {
  return new Promise((resolve) => {
    if (!canListen()) return resolve(null);
    const rec = new Recognition();
    rec.lang = lang === "es" ? "es-ES" : "fr-FR";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    rec.onstart = () => onstart?.();
    rec.onresult = (e) => finish(e.results?.[0]?.[0]?.transcript?.trim() || null);
    rec.onerror = () => finish(null);
    rec.onend = () => finish(null);
    try { rec.start(); } catch { finish(null); }
  });
}

// ── The alarm tone ────────────────────────────────────────────────────────────────────────────

let audioCtx = null;

/**
 * The alarm chime, synthesised with WebAudio so no audio file has to ship or load.
 *
 * A browser will not make a sound until the user has interacted with the page at least once, so
 * `primeAudio()` is called from the first tap — otherwise the very first hypo alarm of a session
 * would be silent, which is the one that matters most.
 */
export function primeAudio() {
  try {
    audioCtx = audioCtx ?? new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no WebAudio: the visual alarm still shows */ }
}

export function beep({ volumePct = 80, times = 3 } = {}) {
  if (!audioCtx || volumePct <= 0) return;
  const vol = Math.min(1, Math.max(0, volumePct / 100)) * 0.35;
  const now = audioCtx.currentTime;
  for (let i = 0; i < times; i++) {
    const t = now + i * 0.42;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1180, t + 0.16);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.02);
    gain.gain.linearRampToValueAtTime(0, t + 0.34);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.36);
  }
}

/** Vibrate, where supported. iOS Safari does not implement this; it is a no-op there, not an error. */
export function vibrate(pattern = [200, 100, 200]) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
