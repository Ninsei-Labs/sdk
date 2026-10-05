// GENERATED FILE - a byte-for-byte copy of the engine module www/js/ui/walletModal.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Своя модалка подключения кошелька: выбор браузерного кошелька и QR для WalletConnect.
//
// Список браузерных кошельков приходит снаружи (setChoices) - обнаружением занимается
// www/js/evm/injected.js по EIP-6963. Здесь только отрисовка: CSP запрещает inline-стили, поэтому
// всё идёт через dom.h(), а иконки кошельков - data:-URL, что разрешено img-src 'self' data:.
//
// Почему не модалка Reown (@reown/appkit): она рисует свои стили inline - и атрибутом style="",
// и целыми <style>-блоками. CSP демки запрещает и то, и другое (ловушка №1 в
// .hermes/docs/05-frontend-stack.md), ослаблять её ради модалки мы не стали. Поэтому модалку
// рисуем сами через dom.h() (стили идут через CSSOM), а QR - генератором qrcode из бандла
// в виде data:-URL (img-src 'self' data: в CSP это разрешает).
//
// Никаких секретов здесь нет: в QR лежит открытая ссылка сессии WalletConnect (wc:...),
// её и показывать пользователю не страшно - такое же показывает любая dapp.

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
      // Список браузерных кошельков: пустой, пока не пришёл от обнаружения (тогда и не виден).
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

  // Два разных выхода из модалки, и разница принципиальная:
  //   close()  - закрывает программно (например, сессия успешно установлена);
  //   cancel() - пользователь отказался: вот тут-то и надо гасить сессию, которую мы просили.
  // Путать их нельзя: раньше успешное подключение закрывало модалку, а та дёргала обработчик
  // отмены и удаляла только что созданную сессию (в логе SDK это видно как wc_sessionDelete
  // через 85 мс после wc_sessionSettle).
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

  // setChoices([{ key, name, icon, hint, onClick }]) - список браузерных кошельков и WalletConnect.
  // Иконки только из data:-URL (их отдаёт сам кошелёк по EIP-6963): внешние адреса в CSP демки не
  // разрешены, и это правильно - картинка из сети не должна влиять на то, какой кошелёк выбран.
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
      // Дальше модалку гасит тот, кто обработал выбор: у браузерного кошелька окно показывает сам
      // кошелёк, а у WalletConnect нужно ещё показать QR.
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
        // Рамку показываем только когда QR реально есть: до выбора WalletConnect это пустое место.
        refs.qrBox.hidden = false;
      }
      if (uri !== undefined) refs.uri.textContent = uri || "";
      if (subtitle !== undefined) refs.subtitle.textContent = subtitle || "";
      if (hintText !== undefined) refs.hint.textContent = hintText || "";
      // error важнее status: иначе переданное «попробуйте ещё раз» перетирает сам текст ошибки, и
      // причина отказа видна только в тосте (раньше error влиял лишь на цвет - мёртвый параметр).
      const line = error || status;
      if (line !== undefined) {
        refs.status.className = "ar-modal-status" + (error ? " ar-modal-status-error" : "");
        refs.status.textContent = line || "";
      }
    },
  };
}
