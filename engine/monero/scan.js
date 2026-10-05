// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/scan.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ИНДЕКСЕР MONERO: находим поступления на адрес сделки САМИ, разбирая блоки.
//
// ЗАЧЕМ. До этого поступления узнавались у monero-wallet-rpc через watch-only кошелёк
// (generate_from_keys). Этот путь упёрся в дефект: пара «кошелёк + ключи» создаётся и больше не
// открывается (.hermes/docs/19), а кроме того один экземпляр держит один кошелёк и обход 25 свопов
// занимал 140 с. Свой разбор блоков не зависит ни от сборки кошелька, ни от числа свопов.
//
// ЧТО НУЖНО И ЧЕГО НЕ НУЖНО. Нужен КЛЮЧ ПРОСМОТРА и ПУБЛИЧНЫЙ КЛЮЧ ТРАТЫ - оба есть у клиента и оба уже
// уходят на бэкенд по белому списку полей. Ключ траты НЕ нужен: смотреть поступления и распоряжаться
// ими - разные права, и это ровно та граница, на которой стоит некастодиальность.
//
// ФОРМУЛЫ - ИЗ ИСХОДНИКОВ MONERO, не по памяти (src/crypto/crypto.cpp, src/ringct/rctOps.cpp):
//   derivation    = 8 * (view_secret * tx_public_key)            - точка, 32 байта (generate_key_derivation)
//   scalar_i      = Hs(derivation || varint(i))                   - хеш в скаляр (derivation_to_scalar)
//   derived_key_i = scalar_i * G + spend_public_key               - (derive_public_key); совпал с выводом - наш
//   amount_i      = ecdhInfo[i].amount XOR Hs("amount" || derivation)[0..8]      - RingCT v2 (текущий)
//   amount_i      = ecdhInfo[i].amount - Hs(derivation)                          - RingCT v1 (старое)
// Здесь реализованы обе версии: старые транзакции в цепочке никуда не делись.

import { ed25519 } from "@noble/curves/ed25519.js";
// keccak-256 - из @noble/hashes, того же пакета, что у ядра SDK: собственный npm-пакет keccak256 требует
// Buffer и в браузер не входит. keccak_256 даёт тот же результат (проверено на известном значении).
import { keccak_256 } from "@noble/hashes/sha3.js";
// ПРАВИЛО unlock_time - ОДНО И ТО ЖЕ, живёт рядом (./unlock.js) и реэкспортируется отсюда, чтобы все, кто
// ходил в app/indexer.mjs, получали те же имена.
import { UNLOCK_TIME_BLOCK_MAX, unlockStateOf, laterBoundary } from "./unlock.js";
export { UNLOCK_TIME_BLOCK_MAX, unlockStateOf, laterBoundary };

export function keccak(bytes) { return keccak_256(bytes); }

// Порядок группы edwards25519 (l). Берём у самой кривой, а не числом из памяти: ошибка в этой
// константе сделала бы неверным и скаляр, и вывод, и сумму - то есть «невидимое поступление».
export const ED_ORDER = ed25519.Point.CURVE().n;

export function hexToBytes(hex) {
  const t = String(hex).trim().replace(/^0x/, "");
  if (t.length % 2) throw new Error("нечётная длина hex");
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }

// ПОРЯДОК БАЙТ - МАЛЕНЬКИЙ (little-endian). Это не придирка: Monero хранит скаляры младшим байтом
// вперёд, и `sc_reduce32` толкует 32 байта хеша именно так. Чтение их большим порядком даёт ДРУГОЕ
// число - скаляр выходит неверным, вывод не сходится, и поступление не находится МОЛЧА. Здесь на этом
// уже один раз потеряли вечер.
export function scalarFromBytesLE(bytes) {
  const rev = Uint8Array.from(bytes).reverse();
  return BigInt("0x" + bytesToHex(rev));
}
export function scalarFromHexLE(hex) { return scalarFromBytesLE(hexToBytes(hex)); }
export function scalarToBytesLE(v, n = 32) {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

// Хеш в скаляр: Hs(...) в Monero = keccak256, прочитанный МЛАДШИМ байтом вперёд, с приведением по l.
export function hashToScalar(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return scalarFromBytesLE(keccak(buf)) % ED_ORDER;
}

// Varint Monero (LEB128, 7 бит на байт, старший бит - продолжение).
export function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return new Uint8Array(out);
}

// Публичный ключ сделки проверяем на разборе: точка должна лежать на кривой.
function pointFromHex(hex) { return ed25519.Point.fromHex(String(hex).replace(/^0x/, "")); }

// derivation = 8 * (view_secret * tx_public_key) - ровно то, что делает generate_key_derivation.
//
// ПОРЯДОК БАЙТ: ЗДЕСЬ БЫЛА ТИХАЯ ПОТЕРЯ ПОСТУПЛЕНИЙ. Ключ просмотра приходит в двух видах, и вид не виден
// по строке: из monero-rpc - как БАЙТЫ младшим вперёд, а из записи сделки (её пишет страница) - как ЧИСЛО в
// hex. Чтение одного вида другим даёт другой скаляр: вывод не сходится, поступление не находится, и ни одной
// ошибки при этом не пишется. На живом прогоне оплата на общий адрес ордера лежала на цепи, а индексер
// честно докладывал ноль. Поэтому вид перебирается ЯВНО, а победивший называется в результате.
export function viewSecretCandidates(viewSecret) {
  if (typeof viewSecret === "bigint") return [["число", viewSecret % ED_ORDER]];
  const hex = String(viewSecret).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return [["не разобран", null]];
  // ОБА вида приводим по модулю порядка группы: без этого значение, большее порядка (а такое даёт любая
  // мусорная строка), не даст посчитать точку, и проверка ключа упадёт вместо того, чтобы сказать «не подошёл».
  return [["BE-число", BigInt("0x" + hex) % ED_ORDER], ["LE-байты", scalarFromHexLE(hex) % ED_ORDER]];
}

// ПОДХОДИТ ЛИ КЛЮЧ ПРОСМОТРА К АДРЕСУ. Сверка ровно одна: точка ключа обязана совпасть с точкой просмотра,
// записанной в адресе (её даёт decodeAddressKeys). Возврат: имя вида, которым совпало; false - не совпало НИ
// ОДНИМ видом, то есть ключ от другого адреса, и обход по нему не найдёт ничего, сколько его ни запускай;
// null - сверять не с чем.
export function viewKeyFormForAddress(viewSecret, expectedViewPubHex) {
  const want = String(expectedViewPubHex || "").toLowerCase();
  if (!want) return null;
  for (const [form, v] of viewSecretCandidates(viewSecret)) {
    if (v === null) continue;
    if (ed25519.Point.BASE.multiply(v).toHex().toLowerCase() === want) return form;
  }
  return false;
}

export function keyDerivation(txPublicKeyHex, viewSecretHex) {
  const txPub = pointFromHex(txPublicKeyHex);
  // Ключ просмотра принимаем и как LE-байты из monero-rpc, и как число, если он уже разобран.
  const a = (typeof viewSecretHex === "bigint" ? viewSecretHex : scalarFromHexLE(String(viewSecretHex).replace(/^0x/, ""))) % ED_ORDER;
  const shared = txPub.multiply(a);
  // ВАЖНО: возвращаем БАЙТЫ, а не hex-строку. Если отдать строку, дальше она поедет как «байты» строки
  // (в хеш уйдут ASCII-коды символов hex), и поступление просто не найдётся - молча и без ошибок.
  return hexToBytes(shared.multiply(8n).toHex());   // 32 байта точки (ge_tobytes) - это и есть derivation
}

// derived_key_i = Hs(derivation || varint(i)) * G + B
export function derivedOutputKey(derivation, outputIndex, spendPubHex) {
  const scalar = hashToScalar(derivation, varint(outputIndex));
  const point = ed25519.Point.BASE.multiply(scalar).add(pointFromHex(spendPubHex));
  return point.toHex();
}

// Вспомогательное: tx public key лежит в extra транзакции, тег 0x01, 32 байта.
// Читаем extra как есть - это тот же разбор, что делает кошелёк.
// extra приходит из ноды МАССИВОМ БАЙТ (не hex-строкой), поэтому принимаем оба вида.
export function txPublicKeyFromExtra(extra) {
  const b = Array.isArray(extra) ? Uint8Array.from(extra) : hexToBytes(extra);
  let i = 0;
  while (i < b.length) {
    const tag = b[i];
    if (tag === 0x01) return bytesToHex(b.subarray(i + 1, i + 33));
    if (tag === 0x02) { i += 1 + b[i + 1]; continue; }          // nonce
    if (tag === 0x00) { i += 1 + b[i + 1]; continue; }          // дополнительный public key
    return null;                                                 // неизвестный тег: не гадаем
  }
  return null;
}

// Расшифровка суммы. version: 2 = текущая схема (xor первых 8 байт), 1 = старая (вычитание скаляра).
//
// СЕКРЕТ - ЭТО СКАЛЯР ВЫВОДА, А НЕ DERIVATION. Здесь легко ошибиться: и то и другое - 32 байта, но в
// genAmountEncodingFactor уходит именно скаляр (derivation_to_scalar), записанный МЛАДШИМ байтом вперёд.
// С derivation результат получается правдоподобным на вид и НЕВЕРНЫМ по существу - проверил на живых
// числах: правильный ответ 1000000000 atomic, с derivation выходило 8830061611517333961.
export function decodeAmount(ecdhAmountHex, scalarLE, rctVersion) {
  const enc = hexToBytes(ecdhAmountHex);
  if (Number(rctVersion) >= 2) {
    // Множитель: keccak("amount" || скаляр_LE), 38 байт - порядок проверен по исходнику (rctOps.cpp).
    const label = new TextEncoder().encode("amount");
    const buf = new Uint8Array(label.length + scalarLE.length);
    buf.set(label, 0); buf.set(scalarLE, label.length);
    const factor = keccak(buf);
    const out = enc.slice();
    for (let i = 0; i < 8; i++) out[i] ^= factor[i];             // xor ТОЛЬКО первых 8 байт
    // И снова МЛАДШИЙ байт вперёд: суммы Monero тоже little-endian.
    return scalarFromBytesLE(out);
  }
  const s2 = hashToScalar(hexToBytes(hashToScalar(hexToBytes(bytesToHex(rctVersion === 1 ? scalarLE : scalarLE))).toString(16).padStart(64, "0")));
  const amt = BigInt("0x" + bytesToHex(enc)) % ED_ORDER;
  return (amt - s2 + ED_ORDER) % ED_ORDER;
}

// ГЛАВНОЕ: разобрать транзакцию и вернуть НАШИ выводы (её номера, ключи и суммы).
// txView - { txPublicKey, vout: [{key, index}], ecdhAmounts: [...], rctVersion }
export function findOurOutputs({ txPublicKey, viewSecretHex, spendPubHex, outputs, ecdhAmounts = [], rctVersion = 2 }) {
  if (!txPublicKey) throw new Error("в транзакции нет публичного ключа (extra тег 0x01) - разбирать нечего");
  // Вид ключа перебираем ЯВНО (см. viewSecretCandidates): верным может оказаться любой из них, и имя
  // победившего уходит наверх - чтобы в журнале было видно, ЧЕМ считали. Если не нашли ничем, отдаём первый
  // осмысленный вид, а не пустоту: иначе в журнале будет «ничем», и причина снова спрячется.
  const usable = viewSecretCandidates(viewSecretHex).filter(([, v]) => v !== null);
  const first = usable[0] || ["не разобран", null];
  for (const [form, secret] of usable) {
    const derivation = keyDerivation(txPublicKey, secret);
    const found = [];
    for (const o of outputs) {
      const scalar = hashToScalar(derivation, varint(o.index));
      const derived = derivedOutputKey(derivation, o.index, spendPubHex);
      if (derived.toLowerCase() === String(o.key).toLowerCase()) {
        // В расшифровку суммы идёт СКАЛЯР ЭТОГО вывода, младшим байтом вперёд.
        const amount = ecdhAmounts[o.index] ? decodeAmount(ecdhAmounts[o.index], scalarToBytesLE(scalar), rctVersion) : null;
        found.push({ index: o.index, key: o.key, amountAtomic: amount });
      }
    }
    if (found.length) return { derivation: bytesToHex(derivation), outputs: found, viewKeyForm: form };
  }
  return {
    derivation: first[1] === null ? null : bytesToHex(keyDerivation(txPublicKey, first[1])),
    outputs: [],
    viewKeyForm: first[0],
  };
}

// ============================================================================================
// ОБХОД ДИАПАЗОНА ВЫСОТ. Это и есть собственно индексация: читаем блоки подряд, из каждого берём
// хеши транзакций и разбираем их ОДНИМ запросом на блок (нода принимает список хешей), а затем
// проверяем выводы каждой транзакции против ВСЕХ наблюдаемых адресов сразу. Именно поэтому обход не
// зависит от числа свопов: блок читается один раз для всех.
//
// Чего здесь СОЗНАТЕЛЬНО нет: обрезки, подтверждений «по своей высоте», записи состояния в файлы.
// Высота - это параметр вызова, состояние обхода решает вызывающий (у бэкенда это поле в базе).
// ============================================================================================


export async function fetchBlock(daemonUrl, height) {
  const res = await fetch(`${String(daemonUrl).replace(/\/+$/, "")}/json_rpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height } }),
  });
  const j = await res.json();
  if (!j.result) throw new Error(`блок ${height} не получен: ${j.error ? j.error.message : "пустой ответ"}`);
  return j.result;
}

// Транзакции по списку хешей. Ходим на ПУТЬ /get_transactions, а не в /json_rpc: через JSON-RPC этот
// метод молча возвращает пусто (проверено, док 19), и это выглядит как «транзакций нет».
export async function fetchTransactions(daemonUrl, hashes) {
  if (!hashes.length) return [];
  const res = await fetch(`${String(daemonUrl).replace(/\/+$/, "")}/get_transactions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txs_hashes: hashes, decode_as_json: true }),
  });
  const j = await res.json();
  const wrappers = j.txs || [];
  // ХЕШ И ВЫСОТА ЖИВУТ В ОБЁРТКЕ, а не в разобранном теле транзакции: в as_json их просто нет. Без этого
  // пришивания «найденный перевод» не имеет ни хеша, ни высоты - то есть бесполезен вызывающему, и при
  // этом всё выглядит успешным.
  return (j.txs_as_json || []).map((s, i) => {
    const body = typeof s === "string" ? JSON.parse(s) : s;
    const w = wrappers[i] || {};
    body.tx_hash = w.tx_hash || body.tx_hash || null;
    body.block_height = w.block_height ?? null;
    body.confirmations = w.confirmations ?? null;
    body.in_pool = w.in_pool ?? null;
    return body;
  });
}

// Разбор одной транзакции против списка наблюдаемых адресов.
// watched: [{ address, viewSecret, spendPub }] - viewSecret принимается и числом, и LE-hex, и BE-hex
// (см. viewSecretCandidates). В результате едет viewKeyForm: имя вида, которым вывод сошёлся.
export function matchTransaction(tx, watched, { height = null, nowSec = null } = {}) {
  const out = [];
  const txPublicKey = txPublicKeyFromExtra(tx.extra);
  if (!txPublicKey) return out;                       // нет ключа в extra - смотреть нечего
  // ЗАПЕРТ ЛИ ВЫХОД - РЕШАЕТСЯ ЗДЕСЬ, ОДИН РАЗ НА ТРАНЗАКЦИЮ: все её выходы несут один unlock_time.
  // Обычная транзакция (unlock_time = 0) идёт как раньше; высота берётся у блока, в котором лежит перевод.
  const blockHeight = height === null || height === undefined ? (tx.block_height ?? null) : height;
  const unlock = unlockStateOf(tx.unlock_time, { height: blockHeight, nowSec });
  const keyOf = (o) => ((o.target || {}).tagged_key || o.target || {}).key;
  const outputs = (tx.vout || []).map((o, i) => ({ index: i, key: keyOf(o) }));
  const ecdhAmounts = ((tx.rct_signatures || {}).ecdhInfo || []).map((e) => e.amount);
  const rctVersion = (tx.rct_signatures || {}).type || 2;
  for (const w of watched) {
    const r = findOurOutputs({
      txPublicKey, viewSecretHex: w.viewSecret, spendPubHex: w.spendPub,
      outputs, ecdhAmounts, rctVersion: Number(rctVersion) >= 2 ? 2 : 1,
    });
    if (r.outputs.length) out.push({ address: w.address, index: w.index ?? null, outputs: r.outputs, derivation: r.derivation, viewKeyForm: r.viewKeyForm, unlockTime: Number(tx.unlock_time) || 0, unlock });
  }
  return out;
}

// Обход диапазона. Возвращает по каждому адресу сумму (receivedAtomic - только РАЗБЛОКИРОВАННОЕ), хеши,
// запертую сумму (lockedAtomic) с границей (lockedUntil) и лучшую (наибольшую) высоту найденного вывода.
export async function scanRange({ daemonUrl, fromHeight, toHeight, watched, log = () => {}, concurrency = 4, nowSec = null }) {
  const from = Number(fromHeight), to = Number(toHeight);
  if (!(from >= 0) || !(to >= from)) throw new Error("диапазон высот задан неверно: " + fromHeight + ".." + toHeight);
  const acc = new Map();
  for (const w of watched) acc.set(w.address, { address: w.address, receivedAtomic: 0n, lockedAtomic: 0n, lockedUntil: null, lockedTxids: [], txids: [], bestHeight: null, outputs: 0, viewKeyForm: null });
  const heights = [];
  for (let h = from; h <= to; h++) heights.push(h);

  // Ограниченный параллелизм: нода - общий ресурс, а блоки независимы.
  let cursor = 0;
  const worker = async () => {
    while (cursor < heights.length) {
      const h = heights[cursor++];
      try {
        const block = await fetchBlock(daemonUrl, h);
        const hashes = block.json ? (typeof block.json === "string" ? JSON.parse(block.json) : block.json).tx_hashes || [] : [];
        if (!hashes.length) continue;
        const txs = await fetchTransactions(daemonUrl, hashes);
        for (const tx of txs) {
          for (const hit of matchTransaction(tx, watched, { height: h, nowSec })) {
            const a = acc.get(hit.address);
            if (!a) continue;
            if (hit.viewKeyForm) a.viewKeyForm = hit.viewKeyForm;   // чем сошлось - это и уходит в журнал
            const lockedHere = !!(hit.unlock && hit.unlock.locked);
            const hash = String(tx.tx_hash || "").replace(/^0x/, "");
            for (const o of hit.outputs) {
              const amount = o.amountAtomic || 0n;
              // ЗАПЕРТЫЙ ВЫХОД - ЭТО НЕ ПРИХОД. Его перевод виден в txids (деньги на адресе есть), но сумма
              // НЕ идёт в receivedAtomic: иначе «готово» разрешило бы забор ETH под запертые XMR.
              if (lockedHere) {
                a.lockedAtomic += amount;
                if (hash && !a.lockedTxids.includes(hash)) a.lockedTxids.push(hash);
                if (laterBoundary(hit.unlock) > laterBoundary(a.lockedUntil)) a.lockedUntil = hit.unlock;
              } else {
                a.receivedAtomic += amount;
                a.outputs += 1;
              }
              if (hash && !a.txids.includes(hash)) a.txids.push(hash);
              if (a.bestHeight === null || h > a.bestHeight) a.bestHeight = h;
            }
          }
        }
      } catch (e) {
        log({ event: "indexer_block_error", height: h, error: String(e.message).slice(0, 160) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, heights.length)) }, worker));
  return { fromHeight: from, toHeight: to, results: Array.from(acc.values()) };
}

