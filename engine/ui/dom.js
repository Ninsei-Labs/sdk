// GENERATED FILE - a byte-for-byte copy of the engine module www/js/ui/dom.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Крошечные DOM-хелперы. Никаких фреймворков: демка должна читаться глазами.

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    // style пишем только через CSSOM: атрибут style="..." запрещён политикой CSP
    // (style-src-attr), а el.style.* и cssText - разрешены. Так эта ловушка не вернётся.
    else if (k === "style") {
      if (typeof v === "string") el.style.cssText = v;
      else Object.assign(el.style, v);
    }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function icon(name, cls = "") {
  return h("i", { class: `ki-filled ki-${name} ${cls}`.trim() });
}

export function toast(message, kind = "") {
  const root = document.getElementById("arToasts");
  if (!root) return;
  const el = h("div", { class: `ar-toast ${kind ? "ar-toast-" + kind : ""}`, text: message });
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, 5200);
}

export function copy(text, label = "Copied") {
  const done = () => toast(label, "ok");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch { toast("Copy failed", "bad"); }
    ta.remove();
  }
}

export function download(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function kv(label, value, opts = {}) {
  return h("div", { class: `ar-kv ${opts.cls || ""}`.trim() }, [
    h("span", { text: label }),
    typeof value === "string" ? h("span", { text: value }) : value,
  ]);
}

export function link(href, text, cls = "ar-linkbtn") {
  return h("a", { href, target: "_blank", rel: "noopener", class: cls, text });
}
