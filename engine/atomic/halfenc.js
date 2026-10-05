// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/halfenc.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Передача половины ключа: зашифрованная половина, пригодная для публикации в цепи.
// Разбор и обоснование: .hermes/docs/20-key-shares.md, разделы 5, 12.3, 16, 18.
//
// ЧТО ЭТО. Половина x передаётся получателю так, что:
//   1) третьи лица прочитать её не могут (маска выводится из общего секрета ECDH с получателем);
//   2) ПОЛУЧАТЕЛЬ может проверить, что в шифртексте лежит именно та половина, которой соответствует
//      опубликованная точка X - простым равенством (x*G == X), без отдельного ZK-доказательства;
//   3) данные помещаются в цепь: точка-получателя + эфемерная точка + замаскированный скаляр.
//
// ЭТО НАША КОМПОЗИЦИЯ, а не перенос из статьи. В документах протокола половина передаётся адаптерной
// подписью ECDSA (Binks, раздел про ecdsa adaptor verify/decrypt). Мы делаем проще и проверяемо:
// ECDH + маска + проверка равенством. Стойкость примитивов - на @noble/curves, но сам состав решения - наш.
//
// РЕШЕНИЕ ПО АДАПТЕРНОЙ ПОДПИСИ ПРИНЯТО: ОНА НЕ ПРИМЕНЯЕТСЯ, и это выбор, а не недоделка. Раскрытие половины
// идёт механизмом keccak commit/reveal (обязательства объявляются ДО денег, контракт сверяет хеш половины),
// а здесь половина передаётся зашифрованной. Разбор, выгоды, цена и причина - .hermes/docs/28-adaptor-note.md,
// раздел 8.
//
// ВАЖНО: примитивы аудированы, ЭТА реализация - нет.

// ЗАПЕРТО ДО ЯВНОГО РАЗРЕШЕНИЯ (вывод аудитора, review_01 §P3: «удалить или запереть мёртвую ветку, чтобы
// её не вызвали „на всякий случай“»). Посылка зашифрованной половины в живом потоке не участвует: раскрытие
// идёт механизмом keccak commit/reveal, а половину вторая сторона получает из цепи. Мёртвая ветка, которую
// можно позвать случайно, - это путь ключей, который никто не проверял в сделке, поэтому он заперт.
//
// ЗАПЕРТО ИМЕННО СОЗДАНИЕ И ВСКРЫТИЕ КОНВЕРТА (seal/open), а НЕ КОНСТРУКТОР. Разница измерена, а не
// придумана: конструктор зовёт ЖИВОЙ поток (www/js/atomic/order.js:26 создаёт механизм, :43 берёт у него
// ключ получателя), поэтому замок на конструкторе сломал бы рабочий путь. Мёртвое здесь - сам конверт:
// запечатать половину и вскрыть её.
// РАЗРЕШЕНИЕ ДАЁТСЯ ЯВНО: globalThis.ARRAKIS_ALLOW_HALFENC = true (так делает только проверка
// tools/check-halfenc.mjs, у которой на запертость есть отдельный случай).
export const HALFENC_LOCK_REASON =
  "halfenc is locked: the sealed-half envelope is not part of the live flow (keccak commit/reveal replaced it). " +
  "Set globalThis.ARRAKIS_ALLOW_HALFENC = true to work with it in a test or a spike.";

export function halfencUnlocked() {
  return globalThis.ARRAKIS_ALLOW_HALFENC === true;
}

export function createHalfEnc({ secp256k1, ed25519, keccak256, randomBytes }) {
  const ED_ORDER = ed25519.Point.Fn.ORDER;
  const SEC_ORDER = secp256k1.Point.Fn.ORDER;
  const LIMIT = ED_ORDER < SEC_ORDER ? ED_ORDER : SEC_ORDER;   // маскируем в меньшем порядке

  function bytesToBig(b) { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; }
  function randScalar(limit) {
    for (let i = 0; i < 256; i++) {
      const v = bytesToBig(randomBytes(32));
      if (v > 0n && v < limit) return v;
    }
    throw new Error("randScalar: не удалось за 256 попыток");
  }
  const bigToHex = (v) => v.toString(16).padStart(64, "0");

  // Ключ шифрования получателя: публикуется заранее и не связан с половиной ключа траты.
  function recipientKeyPair() {
    const priv = randScalar(SEC_ORDER);
    return { priv, pub: secp256k1.Point.BASE.multiply(priv).toHex() };
  }

  // Маска выводится из общего секрета ECDH: у отправителя через свою эфемерную пару и ключ получателя,
  // у получателя - через свой приватный ключ и эфемерную точку. Формула одна и та же.
  function maskFrom(sharedPointHex, context) {
    const h = keccak256(Uint8Array.from(Buffer.concat([
      Buffer.from(sharedPointHex.replace(/^0x/, ""), "hex"),
      Buffer.from(context || "", "utf8"),
    ])));
    return bytesToBig(h) % LIMIT;
  }

  // ЗАКРЫТИЕ: половина x -> публикуемая посылка для получателя.
  function seal(x, recipientPubHex, context) {
    // ЗАМОК НА САМОМ КОНВЕРТЕ: сюда попадает только мёртвая ветка, и «на всякий случай» позвать её нельзя.
    if (!halfencUnlocked()) throw new Error(HALFENC_LOCK_REASON);
    if (!(x > 0n && x < LIMIT)) throw new Error("seal: половина вне границ min(l, n)");
    const recipient = secp256k1.Point.fromHex(recipientPubHex.replace(/^0x/, ""));
    const ephPriv = randScalar(SEC_ORDER);
    const ephPub = secp256k1.Point.BASE.multiply(ephPriv);
    const shared = recipient.multiply(ephPriv);                     // ECDH у отправителя
    const mask = maskFrom(shared.toHex(), context);
    // Все hex-поля приводятся к одному виду: с префиксом 0x и в нижнем регистре. Иначе объект-посылка
    // и результат распаковки различались бы представлением одних и тех же байт (на этом и споткнулась
    // проверка: seal отдавал точки без префикса, а распаковка добавляла его).
    const canon = (h) => "0x" + String(h).replace(/^0x/i, "").toLowerCase();
    return {
      recipient: canon(recipientPubHex),   // кому адресовано
      ephemeral: canon(ephPub.toHex()),    // эфемерная точка, нужна получателю
      masked: "0x" + bigToHex((x + mask) % LIMIT),   // замаскированный скаляр
      context: context || "",
    };
  }

  // ВСКРЫТИЕ: получатель восстанавливает половину и ПРОВЕРЯЕТ её по опубликованной точке.
  function open(sealed, recipientPriv, publicPointHex) {
    // ЗАМОК И НА ВСКРЫТИИ: вторая половина той же мёртвой ветки.
    if (!halfencUnlocked()) return { ok: false, reason: HALFENC_LOCK_REASON };
    if (!sealed || !sealed.ephemeral || !sealed.masked) return { ok: false, reason: "посылка неполная" };
    const eph = secp256k1.Point.fromHex(sealed.ephemeral.replace(/^0x/, ""));
    const shared = eph.multiply(recipientPriv);                      // ECDH у получателя
    const mask = maskFrom(shared.toHex(), sealed.context);
    const x = (BigInt(sealed.masked) - mask + LIMIT) % LIMIT;
    if (x === 0n) return { ok: false, reason: "восстановлен ноль" };
    if (!publicPointHex) return { ok: true, x };
    // Проверка связки "в шифртексте именно эта половина": x*G обязан совпасть с опубликованной точкой.
    const expect = ed25519.Point.BASE.multiply(x).toHex();
    const got = ed25519.Point.fromHex((publicPointHex.startsWith("0x") ? publicPointHex.slice(2) : publicPointHex)).toHex();
    if (expect !== got) return { ok: false, reason: "в шифртексте не та половина" };
    return { ok: true, x };
  }

  // Обязательство для контракта: keccak256 тех самых байтов посылки. Живёт внутри фабрики, потому что
  // хеш-функция передаётся ей снаружи (как и все зависимости), и снаружи видно только через этот объект.
  function sealedCommitmentOf(hexBytes) {
    const h = keccak256(hexToBytesArr(hexBytes));
    return "0x" + bytesToHexStr(h);
  }

  return { LIMIT, recipientKeyPair, seal, open, packSealed, unpackSealed, sealedCommitmentOf };
}

// --- Байтовый формат посылки ---------------------------------------------------------------
//
// Контракту нужны БАЙТЫ: их keccak256 идёт в sealedCommitment ордера, и те же байты уходят в
// calldata при lock(). Формат фиксированный и однозначный, потому что от него зависит обязательство:
// при любой другой раскладке хеш не совпадёт и блокировка будет отвергнута.
//
//   0        : версия формата (1)
//   1..33    : публичный ключ получателя шифрования (33 байта, сжатая точка secp256k1)
//   34..66   : эфемерная точка отправителя (33 байта, сжатая)
//   67..98   : замаскированный скаляр (32 байта, big-endian)
//   99       : длина контекста в байтах (0..255)
//   100..    : контекст ордера в UTF-8
//
// Итого 100 + длина контекста байт. JSON здесь намеренно не используется: порядок ключей и форматирование
// чисел дали бы разные байты для одного и того же содержимого - а обязательство требует однозначности.
const FORMAT_VERSION = 1;

function bytesToHexStr(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function utf8(str) {
  const s = String(str == null ? "" : str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}
function fromUtf8(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[++i] & 0x3f));
    else s += String.fromCharCode(((c & 0x0f) << 12) | ((b[++i] & 0x3f) << 6) | (b[++i] & 0x3f));
  }
  return s;
}
const hexToBytesArr = (h) => {
  const s = String(h || "").replace(/^0x/i, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};

// Посылка -> байты (hex). Именно эти байты хешируются в обязательство и уходят в calldata.
export function packSealed(sealed) {
  if (!sealed || !sealed.recipient || !sealed.ephemeral || !sealed.masked) throw new Error("packSealed: посылка неполная");
  const recipient = hexToBytesArr(sealed.recipient);
  const ephemeral = hexToBytesArr(sealed.ephemeral);
  if (recipient.length !== 33) throw new Error("packSealed: ключ получателя должен быть 33 байта (сжатая точка)");
  if (ephemeral.length !== 33) throw new Error("packSealed: эфемерная точка должна быть 33 байта (сжатая)");
  const masked = BigInt(sealed.masked).toString(16).padStart(64, "0");
  const ctx = utf8(sealed.context);
  if (ctx.length > 255) throw new Error("packSealed: контекст длиннее 255 байт");
  return "0x" + bytesToHexStr(Uint8Array.of(FORMAT_VERSION))
    + bytesToHexStr(recipient) + bytesToHexStr(ephemeral) + masked
    + ctx.length.toString(16).padStart(2, "0") + bytesToHexStr(ctx);
}

// Байты -> посылка. Проверяет версию и длины; повреждённые данные не разбираются молча.
export function unpackSealed(hexBytes) {
  const b = hexToBytesArr(hexBytes);
  if (b.length < 100) throw new Error("unpackSealed: посылка короче 100 байт");
  if (b[0] !== FORMAT_VERSION) throw new Error("unpackSealed: неизвестная версия формата: " + b[0]);
  const ctxLen = b[99];
  if (b.length !== 100 + ctxLen) throw new Error("unpackSealed: длина не совпадает с указанной в контексте");
  return {
    recipient: "0x" + bytesToHexStr(b.slice(1, 34)),
    ephemeral: "0x" + bytesToHexStr(b.slice(34, 67)),
    masked: "0x" + bytesToHexStr(b.slice(67, 99)),
    context: fromUtf8(b.slice(100)),
  };
}

