// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/permit.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// РАЗРЕШЕНИЕ НА ТОКЕН ДЛЯ ПОКУПКИ БЕЗ СВОЕГО ETH (issue #97, часть C): что именно умеет токен и чего не хватает.
//
// ЧТО ЗДЕСЬ И ЧЕГО НЕТ. Здесь ТОЛЬКО селекторы, сборка calldata и ЧЕСТНЫЙ вердикт о том, хватает ли протоколу
// разрешения по подписи. Ни одного вывода «у USDC permit есть» из памяти тут не записано: такой вывод -
// догадка, а догадка об учётной функции токена стоит денег. Возможность ПРОВЕРЯЕТСЯ чтением цепи (есть ли у
// адреса код, отвечает ли DOMAIN_SEPARATOR словом, отвечает ли nonces(owner)), и вердикт умеет говорить
// «неизвестно» - третьим значением, а не одним из двух.
//
// ЧТО УЖЕ ПРОВЕРЕНО ПРО НАШУ НОГУ ОБМЕНА (docs/48, www/js/evm/dexExec.js): разрешение нужно РОУТЕРУ обычным
// approve. Роутер этой сборки Permit2 НЕ ЗНАЕТ (`permit2()` у него откатывает, перенос оплачивает
// TransferHelper.safeTransferFrom от msg.sender). Значит Permit2 в реестре лежит для БУДУЩЕГО пути
// финансирования, а не потому, что этот своп его вызывает.
//
// ПОЧЕМУ ОДНОЙ ТРАНЗАКЦИИ ЗДЕСЬ НЕТ, И ЭТО НЕ ЗАБЫВЧИВОСТЬ. Своп платит ТОТ, КОГО роутер видит `msg.sender`.
// Пользователь без ETH не может отправить ни approve, ни своп, ни внесение. Внести за него и списать USDC по
// его подписи может только КОНТРАКТ-исполнитель (EOA чужую подпись на списание предъявить не может). Такого
// контракта в репозитории нет и план 61 его не называет, поэтому `usdcWithoutEthVerdict` ОТКАЗЫВАЕТСЯ назвать
// путь исполняемым и говорит, чего не хватает. Собирать calldata «на всякий случай» - значит выдать догадку
// за согласие (ровно то, что док 48 называет ловушкой подставленного получателя).
//
// ПОДПИСЬ ВНОСЯЩЕГО (www/js/evm/depositor.js) - ДРУГОЕ РАЗРЕШЕНИЕ. Оно даёт релейщику право ОТПРАВИТЬ
// транзакцию создания ордера, но не право списать токен. Одно другое не заменяет: списание USDC требует
// отдельного разрешения ПО ТОКЕНУ (approve или permit), и оно адресуется тому, кто тянет токен.

// Селекторы ERC-20 и EIP-2612. Рядом с каждым - строка подписи, из которой он посчитан: проверка
// (tools/check-usdc-without-eth.mjs) пересчитывает keccak256 от этих строк, поэтому селектор не может
// разойтись с подписью молча.
export const ERC20_METHOD = {
  approve: { hex: "0x095ea7b3", signature: "approve(address,uint256)" },
  allowance: { hex: "0xdd62ed3e", signature: "allowance(address,address)" },
  balanceOf: { hex: "0x70a08231", signature: "balanceOf(address)" },
};
export const EIP2612_METHOD = {
  permit: { hex: "0xd505accf", signature: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)" },
  nonces: { hex: "0x7ecebe00", signature: "nonces(address)" },
  DOMAIN_SEPARATOR: { hex: "0x3644e515", signature: "DOMAIN_SEPARATOR()" },
};

const hexBody = (s) => String(s === undefined || s === null ? "" : s).replace(/^0x/, "");
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const addrWord = (a) => hexBody(a).toLowerCase().padStart(64, "0");
const uintWord = (v) => BigInt(v).toString(16).padStart(64, "0");
const wordBytes = (hex) => {
  const b = hexBody(hex);
  // ПУСТОЙ ОТВЕТ - ЭТО «НЕ ПРОЧИТАЛИ», А НЕ «НОЛЬ БАЙТ». Так eth_call отвечает по адресу без кода:
  // показать это как «нет домена» значило бы принять незнание за отказ токена.
  if (b.length === 0) return null;
  return b.length % 2 ? null : b.length / 2;
};

// calldata для разрешения по подписи (EIP-2612). Подпись - r || s || v (65 байт); v - в {27,28}.
export function encodePermit({ owner, spender, value, deadline, signature }) {
  if (!isAddr(owner) || !isAddr(spender)) throw new Error("permit: owner и spender обязаны быть адресами");
  const hex = hexBody(signature);
  if (hex.length !== 130) throw new Error("permit: подпись обязана быть 65 байт, а пришло " + hex.length / 2);
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error("permit: v вне {27,28}: " + v);
  return EIP2612_METHOD.permit.hex +
    addrWord(owner) + addrWord(spender) + uintWord(value) + uintWord(deadline) +
    uintWord(v) + hex.slice(0, 64) + hex.slice(64, 128);
}

export const encodeNonces = (owner) => EIP2612_METHOD.nonces.hex + addrWord(owner);
export const encodeDomainSeparator = () => EIP2612_METHOD.DOMAIN_SEPARATOR.hex;
export const encodeApprove = ({ spender, amountWei }) => ERC20_METHOD.approve.hex + addrWord(spender) + uintWord(amountWei);

/**
 * Умеет ли ЭТОТ адрес разрешение по подписи (EIP-2612). Ответ - ТРИ состояния, и это не педантизм:
 * «не проверено» обязано отличаться от «нет».
 *   supported === true  - код есть, DOMAIN_SEPARATOR отвечает словом, nonces(owner) отвечает словом,
 *                         и в байткоде присутствует селектор permit;
 *   supported === false - код есть, но одного из признаков НЕТ (тогда разрешение по подписи недоступно);
 *   supported === null  - прочитать не удалось (нет кода/пустой ответ): это НЕ «нет permit», это «не знаем».
 */
export function permitSupportVerdict({ code = null, domainSeparator = null, nonces = null, owner = null } = {}) {
  const codeHex = hexBody(code);
  if (codeHex.length === 0) return { supported: null, kind: "no-code", reason: "по адресу токена нет кода - это не токен, и разрешение читать не у чего" };
  if (!isAddr(owner)) return { supported: null, kind: "no-owner", reason: "владелец не назван - nonces(owner) прочитать нечем" };
  const dsBytes = wordBytes(domainSeparator);
  if (dsBytes === null) return { supported: null, kind: "domain-unread", reason: "DOMAIN_SEPARATOR не отвечает 32 байтами: читать не удалось" };
  if (dsBytes !== 32) return { supported: false, kind: "domain-empty", reason: "DOMAIN_SEPARATOR вернул " + dsBytes + " байт вместо 32: EIP-712-домен не заявлен" };
  const nonceBytes = wordBytes(nonces);
  if (nonceBytes === null) return { supported: null, kind: "nonces-unread", reason: "nonces(owner) не отвечает: читать не удалось" };
  if (nonceBytes !== 32) return { supported: false, kind: "nonces-empty", reason: "nonces(owner) вернул " + nonceBytes + " байт вместо 32: EIP-2612-счётчика нет" };
  if (!codeHex.toLowerCase().includes(EIP2612_METHOD.permit.hex.slice(2))) {
    return { supported: false, kind: "permit-selector-absent", reason: "в байткоде токена нет селектора permit: разрешения по подписи токен не предоставляет" };
  }
  return { supported: true, kind: "eip2612", reason: "токен заявляет EIP-712-домен, счётчик nonces и селектор permit" };
}

/**
 * Можно ли провести покупку за токен БЕЗ своего ETH ОДНОЙ транзакцией. Вердикт говорит ИМЕННО то, чего не
 * хватает, и НЕ выдаёт calldata, пока путь не исполним полностью.
 * @param {{ orchestrator?: string|null, permitSupported?: boolean|null, token?: string|null }} args
 */
export function usdcWithoutEthVerdict({ orchestrator = null, permitSupported = null, token = null } = {}) {
  // ПЕРВЫЙ И ГЛАВНЫЙ ОТКАЗ, и он не про токен. Своп платит msg.sender (роутер), а чужую подпись на списание
  // может предъявить только КОНТРАКТ. Без исполнителя однотранзакционный путь не существует ВООБЩЕ - и это
  // не зависит от того, есть ли у токена permit.
  if (!isAddr(orchestrator)) {
    return {
      ok: false, blocked: true, kind: "no-orchestrator",
      reason: "нет контракта-исполнителя: списать токен по подписи пользователя и внести натив в эскроу одной транзакцией может только контракт, а в этой сборке его нет. Подпись вносящего без него даёт релейщику право ОТПРАВИТЬ создание ордера, но не право списать токен",
    };
  }
  if (permitSupported === false) {
    return {
      ok: false, blocked: true, kind: "token-no-permit",
      reason: "у токена нет разрешения по подписи (EIP-2612): разрешение придётся выдавать отдельным approve, то есть отдельной транзакцией - одной транзакцией путь не собирается",
    };
  }
  if (permitSupported !== true) {
    return {
      ok: false, blocked: true, kind: "permit-unproven",
      reason: "неизвестно, умеет ли токен разрешение по подписи: «не проверено» - это не «можно». Возможность обязана быть прочитана у цепи до сборки пути",
    };
  }
  return { ok: true, blocked: false, kind: "one-tx-possible", reason: "исполнитель назван, токен заявляет EIP-2612: путь одной транзакцией собирается" };
}
