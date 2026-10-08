// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/factory.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Вызовы контракта-фабрики эскроу ArrakisSwap.
//
// Библиотек для EVM в проекте нет и не добавляем. ОБЕ ФУНКЦИИ ФАБРИКИ ТЕПЕРЬ ПРИНИМАЮТ ПОДПИСАННУЮ КОТИРОВКУ
// (OrderQuote.Quote), подпись тремя словами (r, s, v) и три поля вносившего. Комиссия и адрес реестра - ЧАСТЬ
// КОТИРОВКИ, а не настройка контракта: функций feeBps()/feeFor() у фабрики больше нет (роутер удалён,
// решение #76), и спрашивать их не у чего. Все аргументы статические, поэтому calldata - селектор плюс слова
// по 32 байта; собирается здесь, в одном месте, и проверяется tools/check-evm-abi.mjs.
//
//   cast sig "predict((address,address,address,address,address,address,uint256,uint64,uint64,bytes32,bytes32,bytes32,uint256,uint256,uint256,address,uint64,uint256,uint256),bytes32,bytes32,uint8,bytes32,bytes32,bytes32)" -> 0x0824d205
//   cast sig "createOrderAndFund(<тот же tuple>,...)"                                                                                                                -> 0x4703a9d3

export const FACTORY_METHODS = {
  // СОСТАВ КОТИРОВКИ ВЫРОС ПОЛЕМ xmrAmount (#110 шаг 3): XMR-сторона сделки входит в подписанный набор, поэтому
  // селекторы обеих прежних функций сменились вторично (прежде - от поля cashier, #103).
  predict: "0x0824d205",
  // создать эскроу И внести деньги ОДНОЙ транзакцией (перевод value вместе с вызовом).
  createOrderAndFund: "0x4703a9d3",
  // создать эскроу и внести деньги, когда ВНОСЯЩИЙ восстановлен ИЗ ПОДПИСИ над дайджестом котировки
  // (issue #97, часть A): транзакцию шлёт кто угодно, а `locker` записан подписавшим.
  createOrderAndFundByDepositor: "0x2acd187b",
};

// ТЕМА СОБЫТИЯ OrderCreated. Она выросла адресом реестра, провайдером и ключом подписи:
//   cast keccak "OrderCreated(address,address,address,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint64,uint64,bytes32,address,address,address)"
// Тема живёт в ДВУХ местах - здесь и в watchtower/scan.mjs, - и обе обязаны совпадать: разойтись молча они
// не могут, сверку держит проверка ABI.
export const ORDER_CREATED_TOPIC =
  "0xa22cdabaed3cce4f51dde71626a108ffe9c7bc4216fd14d5e719f892e2fd8ab0";

// ПОЛЯ КОТИРОВКИ В ПОРЯДКЕ КОНТРАКТА. Порядок - часть ABI: перестановка даёт другой вызов (чужую функцию
// или ордер с чужими условиями). Список ОДИН на обе функции: разойтись им нечем.
export const QUOTE_FIELDS = [
  "provider", "quoteKey", "registry", "cashier", "locker", "claimer", "amount", "readyBy", "t1", "salt",
  "commitHalfClaimer", "edPointClaimer", "chainId", "feeBps", "fee", "feeRecipient", "validUntil", "nonce", "xmrAmount",
];
// Поля вносившего котировка НЕ несёт: они уходят отдельными аргументами (входят в init-код эскроу).
const LOCKER_HALF_FIELDS = ["commitHalfLocker", "edPointLocker", "edViewPointLocker"];
const ADDR_FIELDS = ["provider", "quoteKey", "registry", "cashier", "locker", "claimer", "feeRecipient"];
const B32_FIELDS = ["salt", "commitHalfClaimer", "edPointClaimer", "commitHalfLocker", "edPointLocker", "edViewPointLocker"];

// Слово calldata: значение, выровненное вправо до 32 байт. Числа приходят десятичными (wei, сроки), а в
// calldata обязаны быть шестнадцатеричными: дополнение нулями десятичных цифр кодировало бы их как hex и
// уводило сумму в другое число. Поймано сверкой с эталоном Foundry.
export function word(value, bytes = 32) {
  const raw = String(value).trim();
  let hex;
  if (/^0x[0-9a-fA-F]*$/.test(raw)) {
    hex = raw.slice(2).toLowerCase();
    if (hex.length === 0) hex = "0";
  } else if (/^[0-9]+$/.test(raw)) {
    hex = BigInt(raw).toString(16);
  } else {
    throw new Error("не число и не hex: " + value);
  }
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error("не hex: " + value);
  if (hex.length > bytes * 2) throw new Error(`значение не влезает в ${bytes} байт: ${value}`);
  return hex.padStart(bytes * 2, "0");
}

// ФОРМА ПРИВОДИТСЯ, А НЕ ТРЕБУЕТСЯ: точки и обязательства в записи движка лежат БЕЗ префикса 0x, а word()
// требует префикс. Байты одни и те же, поэтому оба вида кодируются одинаково.
const asHex32 = (v) => {
  const x = String(v === undefined || v === null ? "" : v).trim();
  return /^[0-9a-fA-F]{64}$/.test(x) ? "0x" + x.toLowerCase() : x;
};

// СЛОВА ПОДПИСАННОГО НАБОРА. Подпись - 65 байт r || s || v; v приводится к 27/28 (контракт принимает оба
// соглашения). r и s - ПОЛНЫЕ 32 байта, v - тоже ПОЛНОЕ слово из 32 байт (ABI uint8 не бывает короче слова:
// неполное слово сдвинуло бы хвост calldata и вызов ушёл бы на несуществующий селектор).
function quoteWords(quote) {
  for (const name of QUOTE_FIELDS) {
    if (quote[name] === undefined || quote[name] === null || quote[name] === "") throw new Error("в котировке нет поля: " + name);
  }
  // ФОРМА ПРОВЕРЯЕТСЯ, А НЕ ДОСТРАИВАЕТСЯ: короткий адрес или усечённый bytes32 молча выровнялся бы
  // нулями и ушёл в контракт ДРУГИМ значением.
  for (const name of ADDR_FIELDS) {
    if (!/^(0x)?[0-9a-fA-F]{40}$/.test(String(quote[name]).trim())) throw new Error("поле котировки " + name + " - не адрес");
  }
  for (const name of B32_FIELDS) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(quote[name]).trim())) throw new Error("поле котировки " + name + " - не bytes32");
  }
  const map = {
    provider: word(quote.provider, 32), quoteKey: word(quote.quoteKey, 32), registry: word(quote.registry, 32),
    cashier: word(quote.cashier, 32),
    locker: word(quote.locker, 32), claimer: word(quote.claimer, 32),
    amount: word(quote.amount, 32), readyBy: word(quote.readyBy, 32), t1: word(quote.t1, 32),
    salt: word(asHex32(quote.salt), 32),
    commitHalfClaimer: word(asHex32(quote.commitHalfClaimer), 32),
    edPointClaimer: word(asHex32(quote.edPointClaimer), 32),
    chainId: word(quote.chainId, 32), feeBps: word(quote.feeBps, 32), fee: word(quote.fee, 32),
    feeRecipient: word(quote.feeRecipient, 32), validUntil: word(quote.validUntil, 32), nonce: word(quote.nonce, 32),
    xmrAmount: word(quote.xmrAmount, 32),
  };
  return QUOTE_FIELDS.map((n) => map[n]).join("");
}

function signatureWords(signature) {
  const hex = String(signature || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error("подпись котировки должна быть 65 байт: " + String(signature).slice(0, 20));
  const r = hex.slice(0, 64), s = hex.slice(64, 128);
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return word("0x" + r, 32) + word("0x" + s, 32) + word(v, 32);
}

// ОБЩАЯ ЧАСТЬ predict и createOrderAndFund.
function lockerHalfWords(quote) {
  return LOCKER_HALF_FIELDS.map((name) => {
    if (quote[name] === undefined || quote[name] === null || quote[name] === "") throw new Error("в котировке нет поля вносившего: " + name);
    return word(asHex32(quote[name]), 32);
  }).join("");
}

function quoteCallArgs(quote) {
  return quoteWords(quote) + signatureWords(quote.signature) + lockerHalfWords(quote);
}

// ПРЕДСКАЗАТЬ АДРЕС. Состав аргументов совпадает с createOrderAndFund БАЙТ В БАЙТ (адрес - хеш кода
// создания, и подпись в него входит).
export function encodePredict(quote) {
  return FACTORY_METHODS.predict + quoteCallArgs(quote);
}

// СОЗДАТЬ И ВНЕСТИ. Вносившим становится msg.sender; его адрес уже внутри котировки, а фабрика сверяет его
// с отправителем.
export function encodeCreateOrderAndFund(quote) {
  return FACTORY_METHODS.createOrderAndFund + quoteCallArgs(quote);
}

// СОЗДАТЬ И ВНЕСТИ, когда вносящий восстановлен ИЗ ЕГО ПОДПИСИ над ДАЙДЖЕСТОМ КОТИРОВКИ (#97, часть A).
// Транзакцию шлёт кто угодно, поэтому подписантов ДВОЕ: `quote.signature` - подпись провайдера (её
// проверяет эскроу), `depositorSignature` - подпись ВНОСЯЩЕГО (её проверяет фабрика и требует, чтобы
// восстановленный адрес совпал с `quote.locker`). Обе - над ОДНИМ дайджестом котировки.
export function encodeCreateOrderAndFundByDepositor(quote, depositorSignature) {
  return FACTORY_METHODS.createOrderAndFundByDepositor + quoteWords(quote) +
    signatureWords(quote.signature) + signatureWords(depositorSignature) + lockerHalfWords(quote);
}

// Ответ predict() - один адрес в 32-байтовом слове.
export function decodeAddress(returnedHex) {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 64) throw new Error("короткий ответ: " + returnedHex);
  return "0x" + hex.slice(24, 64);
}


// ============================================================================================
// РЕАЛИЗАЦИЯ ЭСКРОУ: ЕЁ АДРЕС И ХЕШ ЕЁ КОДА (issue #114, поправка 2).
// С #114 эскроу каждого ордера - КЛОН EIP-1167 одной общей реализации, а адрес реализации и хеш её кода
// лежат у фабрики (implementation() / implementationCodeHash()). ФАБРИКА при создании ордера проверяет эту
// пару; КЛИЕНТ обязан проверить ТУ ЖЕ пару, иначе клон исполнит чужой код, а денежные пути "пройдут" впустую
// (delegatecall на адрес без кода УСПЕШЕН). Здесь - только чтение полей и вердикт; вызовы к цепи делает
// носитель (session.js: readContract/readCode), поэтому функция чистая и проверяется без сети.
// ============================================================================================

// Селекторы посчитаны инструментом, не вручную:
//   cast sig "implementation()"         -> 0x5c60da1b
//   cast sig "implementationCodeHash()" -> 0xbc0a3981
export const FACTORY_READS = {
  implementation: "0x5c60da1b",
  implementationCodeHash: "0xbc0a3981",
};

// Чтение поля фабрики без аргументов: calldata равен селектору.
export function encodeFactoryRead(name) {
  const sel = FACTORY_READS[name];
  if (typeof sel !== "string" || !/^0x[0-9a-f]{8}$/.test(sel)) throw new Error("нет такого чтения фабрики: " + name);
  return sel;
}

// implementation() - один адрес в 32-байтовом слове.
export function decodeImplementation(returnedHex) {
  return decodeAddress(returnedHex);
}

// implementationCodeHash() - одно слово bytes32.
export function decodeImplementationCodeHash(returnedHex) {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 64) throw new Error("короткий ответ implementationCodeHash(): " + returnedHex);
  return "0x" + hex.slice(0, 64).toLowerCase();
}

// ВЕРДИКТ ПО РЕАЛИЗАЦИИ - те же три условия, что проверяет фабрика (и что закрывает поправки #114):
//   1) адрес реализации назван и её КОД на цепи непуст: delegatecall на адрес без кода успешен, поэтому
//      клон без реализации принял бы ETH, а markReady/claim/refund "прошли" бы, ничего не сделав;
//   2) хеш кода реализации равен recorded-хешу фабрики (сравнение делает сама фабрика через codehash);
//   3) recorded-хеш входит в политику интерфейса (список известных сборок) - если она задана.
// Если передан hashCode (keccak256 байтов кода), сверяется и живой код: тогда вердикт не доверяет одному
// лишь ответу фабрики, а пересчитывает хеш из eth_getCode.
export function verifyFactoryImplementation({ implementation, implementationCodeHash, code, hashCode, policy } = {}) {
  if (!implementation || !/^0x[0-9a-fA-F]{40}$/.test(String(implementation))) {
    return { ok: false, why: "implementation-missing" };
  }
  if (!implementationCodeHash || !/^0x[0-9a-fA-F]{64}$/.test(String(implementationCodeHash))) {
    return { ok: false, why: "code-hash-missing" };
  }
  if (code === undefined || code === null || code === "0x" || code === "0x0") {
    return { ok: false, why: "implementation-has-no-code" };
  }
  const pinned = String(implementationCodeHash).toLowerCase();
  if (Array.isArray(policy) && policy.length) {
    if (!policy.map((h) => String(h).toLowerCase()).includes(pinned)) {
      return { ok: false, why: "implementation-code-unknown", codeHash: pinned };
    }
  }
  if (typeof hashCode === "function") {
    const live = String(hashCode(code)).toLowerCase();
    if (live !== pinned) return { ok: false, why: "implementation-code-mismatch", got: live, want: pinned };
  }
  return { ok: true, codeHash: pinned };
}
