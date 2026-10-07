// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/depositor.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ВНОСЯЩИЙ ПО ПОДПИСИ, КЛИЕНТСКАЯ СТОРОНА (issue #97, часть C): EIP-712 typed data над ДАЙДЖЕСТОМ КОТИРОВКИ.
//
// ЗАЧЕМ. Часть A дала фабрике путь `createOrderAndFundByDepositor`: транзакцию вправе отправить КТО УГОДНО
// (релейщик, наш сервис), но вносившим записывается тот, кто подписал дайджест котировки. Чтобы релейщик
// мог отправить транзакцию, вносящий обязан сперва подписать. Подпись кошелька - это typed data, а не
// транзакция: она не стоит газа и не двигает деньги, поэтому человек БЕЗ своего ETH тоже может её дать.
//
// ПОЧЕМУ ФОРМА ЗДЕСЬ, А НЕ ВЫДУМАНА. Набор полей и домен - ЧАСТЬ ПРОТОКОЛА: тот же OrderQuote, что
// проверяет эскроу (mvp/contracts/OrderQuote.sol) и подписывает нода (rfq/lib/quoteEip712Spec.mjs,
// sdk/src/quoteEip712Spec.mjs). Перестановка двух полей даёт ДРУГОЙ дайджест, подпись восстанавливается в
// чужой адрес, и фабрика отказывает `BadDepositorSignature`. Поэтому форма лежит ОДНИМ списком ниже, а
// проверка (tools/check-usdc-without-eth.mjs) считает этой формой дайджест и сверяет его с дайджестом,
// посчитанным СПЕКОЙ ноды/SDK на той же котировке - разойтись молча они не могут.
//
// ДОМЕН. verifyingContract - АДРЕС ФАБРИКИ ИЗ САМОЙ КОТИРОВКИ (поле `factory`), chainId - живой из котировки:
// подпись, сделанная для другой фабрики или сети, здесь не восстановится. Второго источника домена нет.
//
// ЧЕГО ЗДЕСЬ НЕТ. Криптографии: дайджест считает КОШЕЛЁК (eth_signTypedData_v4), а не этот модуль. Здесь -
// только форма и её проверка, чтобы кошелёк подписал ровно то, что проверит цепь.

// Имя и версия домена - протокол котировок v8, дословно как в OrderQuote.sol.
export const DEPOSITOR_DOMAIN_NAME = "NinseiEscrowFactory";
export const DEPOSITOR_DOMAIN_VERSION = "1";

// НАБОР ПОЛЕЙ В ПОРЯДКЕ КОНТРАКТА. Порядок - часть ABI: перестановка даёт другой дайджест. Список один -
// из него строится и строка типа, и сообщение, разойтись им нечем.
export const ORDER_QUOTE_TYPED_FIELDS = [
  ["provider", "address"],
  ["quoteKey", "address"],
  ["registry", "address"],
  ["cashier", "address"],
  ["locker", "address"],
  ["claimer", "address"],
  ["amount", "uint256"],
  ["readyBy", "uint64"],
  ["t1", "uint64"],
  ["salt", "bytes32"],
  ["commitHalfClaimer", "bytes32"],
  ["edPointClaimer", "bytes32"],
  ["chainId", "uint256"],
  ["feeBps", "uint256"],
  ["fee", "uint256"],
  ["feeRecipient", "address"],
  ["validUntil", "uint64"],
  ["nonce", "uint256"],
  // THE XMR SIDE OF THE DEAL (#110 step 3), in atomic units: it joined the signed set together with the contract
  // (OrderQuote.sol), the node/SDK spec and the vector, so the depositor's signature covers the same XMR the chain
  // verifies. A field the chain could not see used to stay OUT of this list on purpose - that is no longer the case.
  ["xmrAmount", "uint256"],
];

// Тип сообщения. Собирается из списка: правка списка меняет и тип, и подпись - то есть не может остаться
// незамеченной, в отличие от второго литерала рядом.
export const ORDER_QUOTE_TYPED_TYPE = "OrderQuote(" + ORDER_QUOTE_TYPED_FIELDS.map(([n, t]) => t + " " + n).join(",") + ")";

const isHex = (v, bytes) => new RegExp("^(0x)?[0-9a-fA-F]{" + bytes * 2 + "}$").test(String(v === undefined || v === null ? "" : v).trim());
const isNum = (v) => /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(v === undefined || v === null ? "" : v).trim());

// ФОРМА ПРИВОДИТСЯ, А НЕ ТРЕБУЕТСЯ. Точки ed25519 котировка несёт БЕЗ префикса 0x (так их пишет нода),
// а кошелёк и контракт ждут одинаковые БАЙТЫ. Поэтому приводим к одному виду здесь, на границе, и
// отвергаем всё, что не адрес/не bytes32/не число: молчаливое выравнивание нулями ушло бы ДРУГИМ значением.
function normaliseField(name, type, value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (raw === "") throw new Error("котировка не несёт поля для подписи вносящего: " + name);
  if (type === "address") {
    if (!isHex(raw, 20)) throw new Error("поле " + name + " - не адрес: " + raw);
    return "0x" + raw.replace(/^0x/, "").toLowerCase();
  }
  if (type === "bytes32") {
    if (!isHex(raw, 32)) throw new Error("поле " + name + " - не bytes32: " + raw);
    return "0x" + raw.replace(/^0x/, "").toLowerCase();
  }
  // uint64 / uint256: кошелёк принимает строку; десятичную и hex-форму даёт один и тот же разбор.
  if (!isNum(raw)) throw new Error("поле " + name + " - не число: " + raw);
  return String(BigInt(raw));
}

/**
 * EIP-712 typed data, которое подписывает вносящий (eth_signTypedData_v4).
 * Домен строится ИЗ КОТИРОВКИ: verifyingContract = quote.factory, chainId = quote.chainId.
 * @returns {{ domain: object, types: object, primaryType: string, message: object }}
 */
export function orderQuoteTypedData(quote) {
  if (!quote || typeof quote !== "object") throw new Error("нет подписанной котировки: подписывать нечего");
  if (!isHex(quote.factory, 20)) throw new Error("в котировке нет адреса фабрики (factory) - домен подписи не собрать");
  if (!isNum(quote.chainId)) throw new Error("в котировке нет chainId - домен подписи не собрать");
  const message = {};
  for (const [name, type] of ORDER_QUOTE_TYPED_FIELDS) {
    message[name] = normaliseField(name, type, quote[name]);
  }
  return {
    domain: {
      name: DEPOSITOR_DOMAIN_NAME,
      version: DEPOSITOR_DOMAIN_VERSION,
      chainId: Number(BigInt(quote.chainId)),
      verifyingContract: "0x" + String(quote.factory).replace(/^0x/, "").toLowerCase(),
    },
    types: {
      // EIP712Domain явно: кошельки показывают его человеку, и он обязан совпасть с тем, что считает цепь.
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      OrderQuote: ORDER_QUOTE_TYPED_FIELDS.map(([name, type]) => ({ name, type })),
    },
    primaryType: "OrderQuote",
    message,
  };
}

// ПОДПИСЬ НА ПРОВОДЕ - 65 БАЙТ r || s || v. Проверяем форму ЗДЕСЬ: фабрика принимает подпись тремя словами,
// и «похожая на подпись» строка не должна уехать в контракт как согласие.
export function depositorSignatureShape(signature) {
  const hex = String(signature === undefined || signature === null ? "" : signature).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return { ok: false, reason: "подпись вносящего обязана быть 65 байт (r || s || v), а пришло " + hex.length / 2 + " байт" };
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) return { ok: false, reason: "v подписи вносящего вне {27,28}: " + v };
  return { ok: true, r: "0x" + hex.slice(0, 64).toLowerCase(), s: "0x" + hex.slice(64, 128).toLowerCase(), v: 27 + (v - 27) };
}
