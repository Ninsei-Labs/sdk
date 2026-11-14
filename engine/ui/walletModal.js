// A wallet-connect modal for the injected connector: browser-wallet choice only.
// The browser-wallet list comes from outside (setChoices); detection is evm/injected.js by EIP-6963. Here is
// only rendering: the CSP bans inline styles, so everything goes through dom.h(), and wallet icons are data: URLs.
// The host owns any WalletConnect or QR UI.

import { h } from "./dom.js";

export function openWalletModal({ title = "Connect a wallet", subtitle = "", hint = "" } = {}) {
  const refs = {};

  const overlay = h("div", { class: "ar-overlay" }, [
    h("div", { class: "ar-modal" }, [
      h("div", { class: "ar-modal-head" }, [
        h("div", { class: "ar-modal-title", text: title }),
        (refs.closeBtn = h("button", { class: "ar-modal-close", type: "button", title: "Close", text: "\u00d7" })),
      ]),
      (refs.subtitle = h("div", { class: "ar-modal-sub", text: subtitle })),
      // The browser-wallet list: empty until detection delivers it (then invisible).
      (refs.choices = h("div", { class: "ar-modal-choices" })),
      (refs.status = h("div", { class: "ar-modal-status" })),
      h("div", { class: "ar-modal-actions" }, [
        (refs.cancelBtn = h("button", { class: "ar-btn-ghost", type: "button", text: "Cancel" })),
      ]),
      (refs.hint = h("div", { class: "ar-modal-hint", text: hint })),
    ]),
  ]);

  document.body.appendChild(overlay);

  const closed = { value: false };
  let onCancel = null;

  function close() {
    if (closed.value) return;
    closed.value = true;
    overlay.remove();
  }

  function cancel() {
    if (closed.value) return;
    close();
    if (onCancel) onCancel();
  }

  refs.closeBtn.addEventListener("click", cancel);
  refs.cancelBtn.addEventListener("click", cancel);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cancel();
  });

  // setChoices([{ key, name, icon, hint, onClick }]) - the browser-wallet list. Icons are data: URLs only
  // (the wallet itself provides them): external addresses are not allowed by the demo CSP, and rightly so -
  // a network image must not influence which wallet is chosen.
  function setChoices(list) {
    refs.choices.innerHTML = "";
    refs.choices.hidden = !list || !list.length;
    for (const item of list || []) {
      const btn = h("button", { class: "ar-modal-choice", type: "button" }, [
        item.icon
          ? h("img", { class: "ar-modal-choice-icon", src: item.icon, alt: "" })
          : h("span", { class: "ar-modal-choice-icon ar-modal-choice-icon-empty" }),
        h("span", { class: "ar-modal-choice-text" }, [
          h("span", { class: "ar-modal-choice-name", text: item.name }),
          item.hint ? h("span", { class: "ar-modal-choice-hint", text: item.hint }) : null,
        ]),
      ]);
      btn.addEventListener("click", () => {
        if (closed.value) return;
        item.onClick();
      });
      refs.choices.appendChild(btn);
    }
    return refs.choices;
  }

  return {
    closed,
    setChoices,
    close,
    cancel,
    setOnCancel(fn) {
      onCancel = fn;
    },
    update({ status, subtitle, hint: hintText, error } = {}) {
      if (closed.value) return;
      if (subtitle !== undefined) refs.subtitle.textContent = subtitle || "";
      if (hintText !== undefined) refs.hint.textContent = hintText || "";
      // error is more important than status: otherwise a generic "try again" overwrites the error text, and
      // the refusal reason is visible only in the toast.
      const line = error || status;
      if (line !== undefined) {
        refs.status.className = "ar-modal-status" + (error ? " ar-modal-status-error" : "");
        refs.status.textContent = line || "";
      }
    },
  };
}
