// GENERATED FILE - a byte-for-byte copy of the engine module www/js/ui/walletModal.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// A wallet-connect modal: browser-wallet choice and a QR for WalletConnect.
// The browser-wallet list comes from outside (setChoices); detection is evm/injected.js by EIP-6963. Here is
// only rendering: the CSP bans inline styles, so everything goes through dom.h(), and wallet icons are data: URLs.
// NOT the Reown (@reown/appkit) modal: it draws its own inline styles and <style> blocks, both banned by the demo
// CSP, and we did not weaken it for a modal. So we draw the modal ourselves and the QR with a qrcode generator as a data: URL.
// No secrets here: the QR holds the public WalletConnect session URI (wc:...), safe to show like any dapp.

import { h, copy } from "./dom.js";

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
      (refs.qrBox = h("div", { class: "ar-modal-qr", hidden: true }, [(refs.qr = h("img", { alt: "WalletConnect QR code" }))])),
      (refs.uri = h("code", { class: "ar-modal-uri" })),
      (refs.status = h("div", { class: "ar-modal-status" })),
      h("div", { class: "ar-modal-actions" }, [
        (refs.copyBtn = h("button", { class: "ar-btn-ghost", type: "button", text: "Copy link" })),
        (refs.cancelBtn = h("button", { class: "ar-btn-ghost", type: "button", text: "Cancel" })),
      ]),
      (refs.hint = h("div", { class: "ar-modal-hint", text: hint })),
    ]),
  ]);

  document.body.appendChild(overlay);

  const closed = { value: false };
  let onCancel = null;

  // TWO DIFFERENT EXITS FROM THE MODAL, and the difference is fundamental: close() closes it programmatically
  // (e.g. the session settled), while cancel() is the user refusing - and THAT is when we must kill the session
  // we asked for. They must not be confused: before, a successful connect closed the modal, which fired the
  // cancel handler and deleted the just-created session.
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
  refs.copyBtn.addEventListener("click", () => {
    if (refs.uri.textContent) copy(refs.uri.textContent, "WalletConnect link copied");
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cancel();
  });

  // setChoices([{ key, name, icon, hint, onClick }]) - the browser-wallet list plus WalletConnect. Icons are
  // data: URLs only (the wallet itself provides them): external addresses are not allowed by the demo CSP, and
  // rightly so - a network image must not influence which wallet is chosen.
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
      // The rest of the modal is closed by whoever handled the choice: a browser wallet shows its own window,
      // while WalletConnect still needs the QR shown.
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
    update({ qrDataUrl, uri, status, subtitle, hint: hintText, error } = {}) {
      if (closed.value) return;
      if (qrDataUrl) {
        refs.qr.src = qrDataUrl;
        // The frame is shown only when a QR actually exists: before WalletConnect is chosen this is empty.
        refs.qrBox.hidden = false;
      }
      if (uri !== undefined) refs.uri.textContent = uri || "";
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
