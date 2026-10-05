// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/halves.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Половина ключа для атомарного свопа XMR <-> EVM.
// См. .hermes/docs/18-xmr-swap-protocol.md, разделы 2, 3, 12, 13.
//
// ЧТО ЭТО. Ключ траты Monero собирается как сумма двух половин: ks = ks_a + ks_b (mod l). Потратить
// выход можно, только зная обе половины. Одна и та же половина должна работать на двух кривых:
// edwards25519 (Monero) и secp256k1 (EVM) - поэтому скаляр берётся МЕНЬШЕ меньшего из порядков групп
// (статья, §4.3, формула 5: ks_i < min(l, n)). Это не деталь: именно из-за этого неравенства
// доказательство равенства логарифмов сходится в обеих группах.
//
// ВАЖНО ПРО БЕЗОПАСНОСТЬ. Аудированы примитивы (@noble/curves), а НЕ этот код. Наш слой поверх них
// проверки не проходил, и документация это фиксирует (§13). Не использовать для настоящих денег
// до отдельного разбора.
//
// Зависимости передаются снаружи, как в www/js/monero/address.js: в браузере - вендоренный бандл,
// в проверках - тот же пакет из node_modules. Модуль не тянет ничего сам.

export function createHalves({ ed25519, secp256k1, keccak256, randomBytes }) {
  for (const [name, v] of [["ed25519", ed25519], ["secp256k1", secp256k1], ["keccak256", keccak256], ["randomBytes", randomBytes]]) {
    if (!v) throw new Error("createHalves: не передано " + name);
  }
  const ED_ORDER = ed25519.Point.Fn.ORDER;
  const SECP_ORDER = secp256k1.Point.Fn.ORDER;
  // Меньший из порядков: половина обязана помещаться в обе группы (статья §4.3).
  const LIMIT = ED_ORDER < SECP_ORDER ? ED_ORDER : SECP_ORDER;

  // Отбор с отбраковкой: даёт равномерное распределение, в отличие от приведения по модулю,
  // которое перекашивает вероятности в сторону малых значений.
  function newHalf() {
    for (let i = 0; i < 256; i++) {
      const bytes = randomBytes(32);
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      if (v > 0n && v < LIMIT) return v;
    }
    throw new Error("newHalf: не удалось получить скаляр за 256 попыток");
  }

  // ВЫВОД ПОЛОВИНЫ ИЗ СЕКРЕТА, А НЕ ИЗ СЛУЧАЙНОСТИ. Нужен ноде провайдера: она не хранит половину под
  // каждый ордер, а выводит её заново из своего ключа и привязки к ордеру. Один и тот же ордер даёт одну
  // и ту же половину, разные ордера - разные, посчитать может только владелец секрета.
  //
  // ОТБОР С ОТБРАКОВКОЙ, А НЕ ПРИВЕДЕНИЕ ПО МОДУЛЮ - по той же причине, что и в newHalf выше: приведение
  // перекашивает распределение в сторону малых значений, а половина идёт в адрес Monero, где
  // распределение обязано быть равномерным. Поэтому берём хеш, и если он не меньше порядка группы -
  // меняем счётчик и хешируем снова. Счётчик входит в хеш, значит весь путь воспроизводим: тот же ордер
  // при том же секрете даёт ту же половину и на той же попытке.
  //
  // ПОЧЕМУ keccak, А НЕ HMAC. keccak - губка, к удлинению сообщения она невосприимчива, поэтому порядок
  // «домен, секрет, привязка, счётчик» безопасен и не даёт из одного вывода получить другой. Так модуль
  // остаётся без зависимости от node:crypto и работает и в браузере.
  // Домены половин. Отсюда их берут И котирование, И выплата: разойдись строки - и нода выведет половину,
  // которой не соответствует ни её обязательство, ни собранный адрес, и обнаружит это только отказом.
  const HALF_DOMAIN = "arrakis-order-half-v1";          // половина ТРАТЫ
  const VIEW_HALF_DOMAIN = "arrakis-order-view-v1";     // половина ПРОСМОТРА

  function halfFromSeed(seedBytes, binding, domain = HALF_DOMAIN) {
    if (!seedBytes || seedBytes.length < 16) throw new Error("halfFromSeed: секрет короче 16 байт");
    if (!binding) throw new Error("halfFromSeed: не задана привязка к ордеру");
    const dom = new TextEncoder().encode(domain + "|" + String(binding) + "|");
    for (let counter = 0; counter < 256; counter++) {
      // Счётчик попытки лежит ЯВНО и четырьмя байтами, а не подменой соседнего байта: раньше он был
      // вписан трюком (инкремент последнего байта строки домена), и такой код читается как загадка.
      const input = new Uint8Array(dom.length + seedBytes.length + 4);
      input.set(dom, 0);
      input.set(seedBytes, dom.length);
      input[dom.length + seedBytes.length] = (counter >>> 24) & 0xff;
      input[dom.length + seedBytes.length + 1] = (counter >>> 16) & 0xff;
      input[dom.length + seedBytes.length + 2] = (counter >>> 8) & 0xff;
      input[dom.length + seedBytes.length + 3] = counter & 0xff;
      const bytes = keccak256(input);
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      if (v > 0n && v < LIMIT) return v;
    }
    throw new Error("halfFromSeed: не удалось получить скаляр за 256 попыток");
  }

  function pointFromHex(P, hex) { return P.fromHex(hex.startsWith("0x") ? hex.slice(2) : hex); }

  // ПОЛОВИНА МОЖЕТ ПРИЙТИ СТРОКОЙ, И ЭТО НОРМАЛЬНО. Файл восстановления хранит половины hex-строками
  // (BigInt нельзя положить в JSON - на этом уже один раз молча терялась запись сделки). Значит любой
  // вызывающий, который читает файл, обязан получить половину строкой, а арифметика кривой требует
  // bigint. Раньше это место принимало только bigint, и восстановление из НАСТОЯЩЕГО файла падало с
  // "expected bigint, got string" - а проверка восстановления этого не видела, потому что подавала
  // свежие половины. Приводим здесь, в одном месте, чтобы покрыть всех вызывающих сразу.
  function toScalar(v) {
    if (typeof v === "bigint") return v;
    if (typeof v === "string") {
      const t = v.trim().replace(/^0x/, "");
      if (!/^[0-9a-fA-F]{1,64}$/.test(t)) throw new Error("половина не похожа на число: " + v.slice(0, 12));
      return BigInt("0x" + t);
    }
    if (typeof v === "number") return BigInt(v);
    throw new Error("половина неизвестного вида: " + typeof v);
  }
  function hex(P) { return P.toHex(); }

  // Публичные половины на обеих кривых: Ks_i = ks_i*G (edwards25519), Bs_i = ks_i*H (secp256k1).
  function publicHalves(half) {
    return {
      ed: hex(ed25519.Point.BASE.multiply(toScalar(half))),
      secp: hex(secp256k1.Point.BASE.multiply(toScalar(half))),
    };
  }

  // Сумма половин: и приватно (mod l), и публично (сложение точек). Второе равенство - то,
  // на чём держится сборка общего адреса.
  function combineHalves(a, b) { return (toScalar(a) + toScalar(b)) % ED_ORDER; }
  function combinePublic(edHexA, edHexB) {
    return hex(pointFromHex(ed25519.Point, edHexA).add(pointFromHex(ed25519.Point, edHexB)));
  }

  return { LIMIT, ED_ORDER, SECP_ORDER, HALF_DOMAIN, VIEW_HALF_DOMAIN, newHalf, halfFromSeed, publicHalves, combineHalves, combinePublic };
}
