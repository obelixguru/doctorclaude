// Small shared helpers: DOM building, formatting, and the subject hash.

/** SHA-256 as lowercase hex — the same function the app calls `sha256Hex` (LibreLinkUpClient.kt:391).
 *  `crypto.subtle` needs a SECURE CONTEXT, so the page must be served over https:// or from
 *  localhost. Opened as a file:// URL it is undefined and nothing can be keyed to a patient. */
export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build an element. `el("div.card", {onclick}, [child, "text"])`.
 *
 * Children given as strings are set via textContent, never innerHTML — meal descriptions and AI
 * replies are rendered through here, and neither should ever be able to inject markup.
 */
export function el(spec, attrs = {}, children = []) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = node.className ? `${node.className} ${v}` : v;
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = v;            // only ever called with literals we author
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Append children, skipping the absent ones.
 *
 * Use this instead of `node.append(...)` for anything conditional: the DOM's own append STRINGIFIES
 * null, so `root.append(cond ? x : null)` silently writes the text "null" into the page. That is
 * exactly what it did on the meals screen ("nullnull" above the composer) before this existed.
 */
export function mount(parent, ...kids) {
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

/** "14:32" in the viewer's own timezone. Readings carry an absolute epoch, so a phone in another
 *  zone than the sensor still reads the right clock time. */
export const hhmm = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const ddmm = (ms) =>
  new Date(ms).toLocaleDateString([], { day: "2-digit", month: "2-digit" });

export const minutesSince = (ms) => Math.max(0, Math.round((Date.now() - ms) / 60000));

/** Clamp + round to an integer, or null when there is nothing usable to show. */
export function intOrNull(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function numOrNull(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
