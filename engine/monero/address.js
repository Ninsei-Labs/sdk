// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/address.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Проверка и сборка Monero-адресов: формат + настоящий checksum + префиксы всех сетей.
//
// Важная деталь, на которой легко ошибиться: у Monero СВОЙ base58 - блочный
// (8 байт кодируются 11 символами, остаток идёт в конце). Он НЕ совместим с обычным
// биткойн-base58: там ведущий символ '1' означает нулевой байт, а у Monero блок кодируется
// как ЧИСЛО, и '1' может быть просто цифрой внутри числа. Поэтому ни bs58.decode, ни
// bs58.encode здесь не годятся - base58 реализован ниже численно (см. base58ToBlock).
//
// Зачем это нужно в демке: без проверки checksum опечатка в адресе получения
// выглядит валидной, а в atomic-свопе ошибка в адресе означает потерянные деньги.
//
// Префиксы сетей (из src/cryptonote_config.h, официальные значения):
//   mainnet: 18 обычный, 19 с payment id, 42 суб-адрес
//   stagenet: 24 / 25 / 36
//   testnet: 53 / 54 / 63
// Вендоренная monero-js умеет ТОЛЬКО mainnet (у неё в address.js жёстко 18/19/42),
// поэтому здесь свой энкодер: библиотека даёт публичные ключи, а строку адреса собираем мы.

const BLOCK_CHARS = 11;

// encoded bytes -> chars (из monero-js/src/base58.js, ENC_BLOCK_BYTE_LENS)
const CHARS_BY_BYTES = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11 };
const BYTES_BY_CHARS = { 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 };

const PREFIXES = {
  18: { network: "mainnet", kind: "primary" },
  19: { network: "mainnet", kind: "integrated" },
  42: { network: "mainnet", kind: "subaddress" },
  24: { network: "stagenet", kind: "primary" },
  25: { network: "stagenet", kind: "integrated" },
  36: { network: "stagenet", kind: "subaddress" },
  53: { network: "testnet", kind: "primary" },
  54: { network: "testnet", kind: "integrated" },
  63: { network: "testnet", kind: "subaddress" },
};

// обратная таблица: сеть + вид -> байт префикса (для сборки адреса)
export const PREFIX_BY_NETWORK = {
  mainnet: { primary: 18, integrated: 19, subaddress: 42 },
  stagenet: { primary: 24, integrated: 25, subaddress: 36 },
  testnet: { primary: 53, integrated: 54, subaddress: 63 },
};

export function prefixFor(network, kind = "primary") {
  const byKind = PREFIX_BY_NETWORK[network];
  if (!byKind) throw new Error("Unknown network: " + network);
  const prefix = byKind[kind];
  if (prefix === undefined) throw new Error("Unknown address kind: " + kind);
  return prefix;
}

// Синхронная проверка формата (для UI до загрузки библиотеки).
export function formatCheck(addr) {
  const a = String(addr || "").trim();
  if (![95, 106].includes(a.length)) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
  // первая буква адреса определяется префиксом сети: 4/8 mainnet, 5/7 stagenet, 9/A/B testnet
  return ["4", "5", "7", "8", "9", "A", "B"].includes(a[0]);
}

// Первая буква адреса прямо следует из префикса: 4/8 - mainnet, 5/7 - stagenet, 9/A/B - testnet
export function networkFromShape(addr) {
  const a = String(addr || "").trim();
  if (!formatCheck(a)) return null;
  if (a[0] === "4" || a[0] === "8") return "mainnet";
  if (a[0] === "5" || a[0] === "7") return "stagenet";
  if (["9", "A", "B"].includes(a[0])) return "testnet";
  return null;
}

export function isStagenetShaped(addr) {
  return networkFromShape(addr) === "stagenet";
}

let lib = null;
let libFailed = false;

async function loadLib() {
  if (lib) return lib;
  if (libFailed) return null;
  try {
    const mod = await import("../../assets/vendors/monero/monero-js-browser.js?v=05c682ea");
    lib = mod.default || mod;
    return lib;
  } catch {
    libFailed = true;
    return null;
  }
}

// Алфавит Monero-base58 (тот же, что у Bitcoin, но правила кодирования другие).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_VALUES = (() => {
  const m = new Map();
  [...B58_ALPHABET].forEach((c, i) => m.set(c, BigInt(i)));
  return m;
})();

// Блок байтов -> base58-строка (числом: никакого «ведущий '1' = нулевой байт»).
function blockToBase58(block) {
  let num = 0n;
  for (const b of block) num = (num << 8n) | BigInt(b);
  let s = "";
  while (num > 0n) {
    s = B58_ALPHABET[Number(num % 58n)] + s;
    num /= 58n;
  }
  return s;
}

// base58-строка блока -> ровно `bytes` байтов, выравнивание по ПРАВОМУ краю.
//
// Почему не bs58 из npm: его декодер трактует каждый ведущий символ '1' как нулевой БАЙТ
// (биткойн-семантика). В Monero блок кодируется как число, и '1' может быть просто цифрой
// внутри числа - тогда bs58 выдаёт лишний нулевой байт, payload разъезжается, и checksum
// ложно не сходится. На этом ловились: 18 адресов из 120 (15%) проверялись как «с опечаткой».
function base58ToBlock(str, bytes) {
  let num = 0n;
  for (const ch of str) {
    const v = B58_VALUES.get(ch);
    if (v === undefined) throw new Error("Invalid Monero base58 character: " + ch);
    num = num * 58n + v;
  }
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n) throw new Error("Base58 block does not fit in " + bytes + " bytes");
  return out;
}

// Блочный Monero-base58: строка -> байты.
//
// Порядок блоков важен: Monero сначала кодирует полные 8-байтовые блоки (по 11 символов),
// а НЕПОЛНЫЙ остаток идёт В КОНЦЕ и занимает меньше символов (см. monero-js/src/base58.js:
// сначала tot_block_cnt блоков, затем last_block_enc_len). Поэтому остаток берём с конца строки.
export function decodeMoneroBase58(str) {
  const s = String(str);
  const L = s.length;
  const rem = L % BLOCK_CHARS;
  const lastChars = rem === 0 ? BLOCK_CHARS : rem;
  const lastBytes = BYTES_BY_CHARS[lastChars];
  if (!lastBytes) throw new Error("Invalid Monero base58 length");

  const chunks = [];
  const headLen = L - lastChars;
  for (let i = 0; i < headLen; i += BLOCK_CHARS) chunks.push(base58ToBlock(s.slice(i, i + BLOCK_CHARS), 8));
  chunks.push(base58ToBlock(s.slice(headLen), lastBytes));

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Блочный Monero-base58: байты -> строка (обратная к decode выше).
// Полные 8-байтовые блоки кодируются по 11 символов (слева дополняются '1'), остаток - в конце.
export function encodeMoneroBase58(bytes) {
  const arr = Array.from(bytes);
  const L = arr.length;
  const rem = L % 8;
  const lastBytes = rem === 0 ? 8 : rem;
  const headLen = L - lastBytes;

  let out = "";
  for (let i = 0; i < headLen; i += 8) {
    const s = blockToBase58(arr.slice(i, i + 8));
    out += "1".repeat(Math.max(0, CHARS_BY_BYTES[8] - s.length)) + s;
  }
  const t = blockToBase58(arr.slice(headLen));
  out += "1".repeat(Math.max(0, CHARS_BY_BYTES[lastBytes] - t.length)) + t;
  return out;
}

// Полезная нагрузка адреса (без checksum): префикс + публичный spend + публичный view [+ payment id]
export function addressPayload({ network, kind = "primary", spendPub, viewPub, paymentId }) {
  const prefix = prefixFor(network, kind);
  const spend = hexToBytes(spendPub, 32, "public spend key");
  const view = hexToBytes(viewPub, 32, "public view key");
  const out = [prefix, ...spend, ...view];
  if (kind === "integrated") {
    const pid = hexToBytes(paymentId, 8, "payment id");
    out.push(...pid);
  }
  return Uint8Array.from(out);
}

function hexToBytes(hex, expectedBytes, label) {
  const s = String(hex || "").trim();
  if (!new RegExp("^[0-9a-fA-F]{" + expectedBytes * 2 + "}$").test(s)) {
    throw new Error("Bad " + label + ": expected " + expectedBytes * 2 + " hex characters");
  }
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Сборка адреса из публичных ключей: deps = { keccak256 } (в браузере - из бандла monero-js).
// bs58 здесь не нужен: base58 у Monero блочный и числовой, см. комментарий у base58ToBlock.
export function addressFromKeys({ network, kind = "primary", spendPub, viewPub, paymentId }, deps) {
  if (!deps?.keccak256) throw new Error("addressFromKeys needs { keccak256 }");
  const payload = addressPayload({ network, kind, spendPub, viewPub, paymentId });
  const digest = Uint8Array.from(deps.keccak256(deps.Buffer ? deps.Buffer.from(payload) : payload));
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(digest.slice(0, 4), payload.length);
  return encodeMoneroBase58(full);
}

// Полная проверка: формат + блочный декод + keccak256-checksum + сеть.
// expectNetwork (необязательно): если задан, адрес чужой сети считается ошибкой -
// в свапе на stagenet mainnet-адрес это потерянные деньги, а не придирка.
export async function checkAddress(addr, opts = {}) {
  const a = String(addr || "").trim();
  if (!formatCheck(a)) {
    return { ok: false, reason: "Not a Monero address (expected 95 or 106 base58 characters)" };
  }
  const shape = networkFromShape(a);
  if (opts.expectNetwork && shape && shape !== opts.expectNetwork) {
    return { ok: false, reason: `This is a ${shape} address, but the swap runs on ${opts.expectNetwork}` };
  }
  const l = await loadLib();
  if (!l) {
    return { ok: true, verified: false, network: shape, reason: "Format looks valid (checksum check unavailable: monero-js bundle is not built)" };
  }
  try {
    const bytes = decodeMoneroBase58(a);
    const payloadLen = bytes.length - 4;
    if (payloadLen < 65) throw new Error("Address is too short");
    const payload = bytes.slice(0, payloadLen);
    const checksum = bytes.slice(payloadLen);
    // keccak256 из бандла требует Buffer: Uint8Array он не принимает
    const digest = Uint8Array.from(l.keccak256(l.Buffer.from(payload)));
    const match = checksum.length === 4 && checksum.every((b, i) => b === digest[i]);
    if (!match) {
      // Мок-адреса демки (wallet.js, режим mock) намеренно без checksum: они помечены в UI как
      // фиктивные. Если такой адрес попадёт сюда, «опечатка» - не единственная версия, и текст
      // должен это говорить, иначе отладка уходит не туда.
      return { ok: false, reason: "Checksum mismatch: the address has a typo, is corrupted, or is a demo mock address (mock addresses have no checksum)" };
    }

    const prefix = payload[0];
    const meta = PREFIXES[prefix] || { network: "unknown", kind: "unknown" };
    if (meta.network === "unknown") return { ok: false, reason: `Unsupported address prefix ${prefix}` };
    if (opts.expectNetwork && meta.network !== opts.expectNetwork) {
      return { ok: false, reason: `This is a ${meta.network} address, but the swap runs on ${opts.expectNetwork}` };
    }
    return { ok: true, verified: true, network: meta.network, kind: meta.kind, bytes: bytes.length };
  } catch (e) {
    return { ok: false, reason: "Address decode failed: " + e.message };
  }
}

// Хелпер для кода, который уже загрузил бандл: собрать адрес нужной сети из ключей кошелька.
export async function addressForNetwork({ network, kind = "primary", spendPub, viewPub }) {
  const l = await loadLib();
  if (!l) throw new Error("monero-js bundle is not available");
  return addressFromKeys({ network, kind, spendPub, viewPub }, { keccak256: l.keccak256, Buffer: l.Buffer });
}
