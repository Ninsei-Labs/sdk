// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/dex.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// DEX-нога: КОТИРОВКА Uniswap v3, полученная из цепи. ТОЛЬКО ЧТЕНИЕ: eth_call, ни одной транзакции.
//
// ЧТО ЗДЕСЬ ЗАМЕНЕНО. Раньше в разбивке цены стоял мок: "Uniswap v3 USDC/WETH 0.05%" и спред 0.0004
// брались из констант конфига (www/js/mock/market.js:76-77), то есть комиссия пула и выход были
// ВЫДУМАНЫ. Теперь и то и другое читается у самой цепи через QuoterV2 - тот же путь, которым страница
// уже читает цену и газ (evm/prices.js): POST к chain.rpcUrl, никаких новых доменов, никаких новых
// параметров в URL и никаких новых внешних адресов. Хост уже разрешён в CSP - он берётся из реестра сетей.
//
// СЕЛЕКТОРЫ И СТРУКТУРА АРГУМЕНТОВ ВЗЯТЫ ИЗ ВЫЗОВА, А НЕ ИЗ ПАМЯТИ (проверено 2026-09-23):
//   * selector = keccak256(подпись)[0..4]. Считается в тесте (tools/check-uniswap-quote.mjs) из строки
//     подписи, лежащей здесь рядом с селектором, и наличие селектора сверяется в КОДЕ контракта.
//   * АРГУМЕНТЫ ИДУТ ПЯТЬЮ СЛОВАМИ ПОДРЯД, БЕЗ СЛОВА-СМЕЩЕНИЯ. Подпись формально принимает структуру
//     (address,address,uint256,uint24,uint160), и по спецификации ABI первым словом должно идти
//     смещение 0x20. НА РАЗВЁРНУТОМ QuoterV2 ЭТО ЛОЖЬ: вариант со смещением ОТКАТЫВАЕТ (execution
//     reverted), а пять слов подряд отвечают четырьмя словами (amountOut, sqrtPriceX96After,
//     initializedTicksCrossed, gasEstimate). Поэтому кодируем подряд - и это записано здесь, чтобы
//     никто не "починил" код по спецификации и не сломал котировку молча.
//
// ЧЕГО МОДУЛЬ НЕ ДЕЛАЕТ: не отправляет транзакции, не делает approve, не свопает и НЕ трогает путь
// фондирования. Оценка газа здесь - это gasEstimate, который вернул сам QuoterV2 (число из цепи), а не
// eth_estimateGas по чужой транзакции.
//
// ЧЕСТНОЕ "НЕТ КОТИРОВКИ" ВМЕСТО ВЫДУМАННОГО ЧИСЛА. Пустой пул, отсутствие пула, откат котировки и
// цена, разошедшаяся с эталоном, - ЧЕТЫРЕ РАЗНЫХ ответа, и каждый назван словами (why). Число
// возвращается только тогда, когда его действительно назвала цепь и оно прошло сверку с эталоном.
//
// МАРШРУТ ЗДЕСЬ ОБЪЯВЛЕН, А НЕ ВЫБРАН. Перебора "прямой путь или через хаб" в рантайме нет и быть не
// должно: человек объявил маршрут в реестре (DEX_ROUTES), а модуль только переводит его в путь и
// спрашивает цепь ОДНИМ вызовом. Если объявленного маршрута нет (или в нём пусто) - это честное
// "маршрута нет", причина лежит в данных (route.why), и такая нога блокирует подпись, а не ищет обход.
//
// ПРОВЕРКА ЦЕНЫ (priceGateVerdict) - ВТОРАЯ ЗАЩИТА ТОЙ ЖЕ СЕМЬИ, что покрытие суммы: неверная цена
// означает, что сделка не сойдётся, и подпись не начинается. Считается двумя способами, ни один из
// которых не требует фида на каждый токен: неявная цена натива из котировки против эталона (Chainlink)
// и полоса "около 1:1" на шагах между стейблами (без оракула вовсе). Пороги - в реестре
// (DEX_PRICE_GATE), исключение для тестнета - тоже данные (dexPriceGate у сети): там цена негодная по
// природе, и негодная цена помечается словами, а не останавливает поток. Оценок ликвидности здесь
// по-прежнему нет: глубину пула решает человек.

// Селекторы. Рядом с каждым - строка подписи, из которой он посчитан: проверка
// (tools/check-uniswap-quote.mjs) пересчитывает keccak256 от этих строк и падает, если хоть один
// селектор разошёлся с подписью.
// ЧТО ЗДЕСЬ ПРОВЕРЕНО ВЫЗОВОМ (2026-09-23, Arbitrum One и Ethereum, tools/check-uniswap-quote.mjs):
//   * quoteExactInputSingle 0xc6a5026a - котировка ОДНОЙ ступени, пять слов подряд без смещения;
//   * quoteExactInput 0xcdca1753 - котировка ВСЕГО ПУТИ ОДНИМ ВЫЗОВОМ. Подпись
//     quoteExactInput(bytes,uint256), селектор найден в коде QuoterV2 в обеих сетях, а сверка
//     одноступенчатого пути против одиночной котировки дала РОВНО то же число (36685744820778786 на
//     100 USDC), то есть кодирование пути (20 байт адрес + 3 байта комиссия, подряд) подтверждено числом,
//     а не по памяти. Эталонного значения нет - есть совпадение двух РАЗНЫХ вызовов.
export const DEX_METHOD = {
  // ФОРМА С ТОЧНЫМ ВЫХОДОМ. Это НЕ "сколько выйдет", а "получить ровно столько, потратив не больше
  // такого-то": при ней вопроса о разнице сумм не существует вовсе (док 45 §"Что добавит DEX-нога").
  // ОБЕ формы подтверждены вызовом на Arbitrum One и основной сети (tools/check-uniswap-quote.mjs):
  //   - одиночная даёт amountIn на ровно 0.035 WETH;
  //   - многошаговая по пути из двух ног тоже отвечает, но ПУТЬ У НЕЁ ЗАДАЁТСЯ В ОБРАТНУЮ СТОРОНУ - от
  //     получаемого токена к оплачиваемому (прямой путь отказывает: "Unexpected error"). Это измерено, а
  //     не выведено: перепутать направление здесь стоит отказа вызова.
  quoteExactOutputSingle: { hex: "0xbd21704a", signature: "quoteExactOutputSingle((address,address,uint256,uint24,uint160))" },
  quoteExactOutput: { hex: "0x2f80bb1d", signature: "quoteExactOutput(bytes,uint256)" },
  quoteExactInputSingle: { hex: "0xc6a5026a", signature: "quoteExactInputSingle((address,address,uint256,uint24,uint160))" },
  // Многошаговая форма: путь передаётся УПАКОВАННЫМ (token|fee|token|fee|token), аргумент динамический,
  // поэтому здесь смещение 0x40 (см. encodeQuoteExactInput), в отличие от одиночной формы.
  quoteExactInput: { hex: "0xcdca1753", signature: "quoteExactInput(bytes,uint256)" },
  getPool: { hex: "0x1698ee82", signature: "getPool(address,address,uint24)" },
  liquidity: { hex: "0x1a686502", signature: "liquidity()" },
  balanceOf: { hex: "0x70a08231", signature: "balanceOf(address)" },
  // withdraw у WETH9: НЕ для отправки, только для оценки газа unwrap (и только если у нас есть
  // измеренный держатель WETH - см. tools/check-uniswap-quote.mjs).
  withdraw: { hex: "0x2e1a7d4d", signature: "withdraw(uint256)" },
};

// ПУТЬ ИЗ ОБЪЯВЛЕННОГО МАРШРУТА (DEX_ROUTES в реестре). Здесь НЕТ никакого выбора: человек объявил шаги
// со ступенями, а мы только переводим символы в адреса. Обёрнутый нативный токен берётся из данных сети
// (u.wrapped), а не пишется строкой "WETH": у сети на BNB обёрнутый натив - WBNB.
// Возвращает null и причину, если объявленный маршрут собрать нельзя (шаг назван токеном, которого в
// этой сети нет) - это НЕ "маршрута нет", а ошибка в данных, и называть её надо иначе.
export function declaredRoutePath({ token, tokens = [], wrapped, route }) {
  if (!token || !route || !Array.isArray(route.steps) || !route.steps.length) return null;
  const bySym = new Map((tokens || []).map((t) => [String(t.symbol).toUpperCase(), t]));
  const addrOf = (sym) => {
    const s = String(sym).toUpperCase();
    if (wrapped && s === String(wrapped.symbol).toUpperCase()) return wrapped.address;
    const t = bySym.get(s);
    return t && t.address ? t.address : null;
  };
  const symbols = [token.symbol];
  const addresses = [token.address];
  const fees = [];
  const pools = [];
  for (const step of route.steps) {
    const a = addrOf(step.to);
    if (!a) return { error: `declared route names a token that this network has no address for: ${step.to}` };
    addresses.push(a);
    symbols.push(String(step.to).toUpperCase() === String(wrapped && wrapped.symbol).toUpperCase() ? wrapped.symbol : step.to);
    fees.push(Number(step.fee));
    pools.push(step.pool || null);
  }
  return { tokens: addresses, symbols, fees, pools };
}

// Путь одной строкой с комиссиями ступеней: "USDe → USDC 0.01% → WETH 0.05%". Одна и та же запись в
// интерфейсе и в отчёте - разойдясь, они начнут объяснять человеку одно, а оператору другое.
export function routeLabel(route) {
  if (!route || !route.symbols) return "";
  let s = route.symbols[0];
  for (let i = 0; i < route.fees.length; i++) s += " → " + route.symbols[i + 1] + " " + feeTierLabel(route.fees[i]);
  return s;
}

// Разбор пути на шаги: [{from, to, fee, feeLabel}] - для пошаговой строки в интерфейсе и в отчёте.
export function routeSteps(route) {
  if (!route || !route.symbols) return [];
  return route.fees.map((fee, i) => ({ from: route.symbols[i], to: route.symbols[i + 1], fee, feeLabel: feeTierLabel(fee) }));
}

const CACHE_MS = 20_000; // котировка живёт 20 с: дольше держать её нельзя (цена в пуле движется), чаще спрашивать незачем

const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  return undefined;
}
function put(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function resetDexCache() {
  cache.clear();
}

// Один eth_call в сеть сети из реестра. Никогда не бросает: молчание узла - это состояние интерфейса,
// а не падение экрана (так же сделано в evm/prices.js).
async function rpc(chain, method, params = [], { timeoutMs = 15_000 } = {}) {
  if (!chain || !chain.rpcUrl) return { ok: false, why: "network has no RPC endpoint" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) return { ok: false, why: method + ": HTTP " + res.status };
    const json = await res.json();
    if (json.error) return { ok: false, why: method + ": " + String(json.error.message || "rpc error").slice(0, 120) };
    return { ok: true, result: json.result };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return { ok: false, why: method + ": " + (aborted ? "no answer in " + timeoutMs + " ms" : String((e && e.message) || e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- кодирование/декодирование ABI без библиотек (в проекте ноль зависимостей в app/) ---------------
const hexBody = (s) => String(s || "").replace(/^0x/, "");
const word = (v) => hexBody(v).toLowerCase().padStart(64, "0");
// АДРЕС - ЭТО ЦЕЛОЕ СЛОВО ABI (24 нуля и 20 байт адреса), а не только 20 байт. Здесь была ошибка ровно
// наоборот от той, что кажется очевидной: сначала адрес дополнялся нулями до слова, а потом у слова
// срезались первые 24 знака - то есть дополнение выбрасывалось, и в calldata уходили аргументы,
// сдвинутые на 12 байт. Вызов на этом откатывался ("execution reverted"), и выглядело это как "в пуле
// нет ликвидности", хотя пул отвечал - врал наш кодировщик (поймано сверкой с рабочим вызовом).
const addrWord = (a) => word(a);
const uintWord = (v) => {
  let h = "";
  let n = BigInt(v);
  while (n > 0n) {
    h = (n & 0xffn).toString(16).padStart(2, "0") + h;
    n >>= 8n;
  }
  return h.padStart(64, "0");
};
function decodeWords(hex) {
  const b = hexBody(hex);
  const out = [];
  for (let i = 0; i + 64 <= b.length; i += 64) out.push(BigInt("0x" + b.slice(i, i + 64)));
  return out;
}
export function encodeQuoteExactInputSingle({ tokenIn, tokenOut, amountInWei, fee, sqrtPriceLimitX96 = 0 }) {
  return (
    DEX_METHOD.quoteExactInputSingle.hex +
    addrWord(tokenIn) +
    addrWord(tokenOut) +
    uintWord(amountInWei) +
    uintWord(fee) +
    uintWord(sqrtPriceLimitX96)
  );
}
export function encodeGetPool({ tokenA, tokenB, fee }) {
  return DEX_METHOD.getPool.hex + addrWord(tokenA) + addrWord(tokenB) + uintWord(fee);
}

// ОБРАТНАЯ ЗАДАЧА ПО ОДНОМУ ПУЛУ: сколько надо отдать, чтобы получить РОВНО amountOutWei. Раскладка та же,
// что у одиночной формы на вход (статическая структура идёт ВНУТРИ, без слова смещения): адрес, адрес,
// сумма, комиссия, предел цены. Подтверждено вызовом, см. DEX_METHOD.quoteExactOutputSingle.
export function encodeQuoteExactOutputSingle({ tokenIn, tokenOut, amountOutWei, fee, sqrtPriceLimitX96 = 0 }) {
  return DEX_METHOD.quoteExactOutputSingle.hex +
    addrWord(tokenIn) + addrWord(tokenOut) + uintWord(amountOutWei) + uintWord(fee) + uintWord(sqrtPriceLimitX96);
}

// ЛИБО СКОЛЬКО ВЫЙДЕТ, ЛИБО ПОЧЕМУ НЕТ - так же, как у формы на вход. Здесь ЭТО НЕ ПРОГНОЗ, а ответ на
// вопрос "хватает ли пула, чтобы получить ровно столько": отказ и есть "не хватает".
export async function quoteExactOutSingle(chain, { tokenIn, tokenOut, amountOutWei, fee }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { ok: false, why: "no verified QuoterV2 for this network" };
  const data = encodeQuoteExactOutputSingle({ tokenIn, tokenOut, amountOutWei, fee });
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { ok: false, why: res.why };
  const words = decodeWords(res.result);
  if (!words.length) return { ok: false, why: "quoter answered without data" };
  if (words[0] <= 0n) return { ok: false, why: "pool cannot serve this output" };
  return {
    ok: true,
    amountInWei: words[0].toString(),
    gasEstimate: words.length > 1 ? words[words.length - 1].toString() : null,
  };
}

// ОБРАТНАЯ ЗАДАЧА ПО ВСЕМУ ПУТИ: сколько надо отдать, чтобы получить РОВНО amountOutWei.
// ПУТЬ ЗДЕСЬ ИДЁТ В ОБРАТНУЮ СТОРОНУ - от получаемого токена к оплачиваемому, и комиссии в том же
// обратном порядке. Это не наше соглашение, а требование контракта: на прямом пути вызов отказывает
// ("Unexpected error"), на обратном отвечает числом. Измерено на обеих сетях, см. DEX_METHOD.
// ПРЕДПОЧТЕНИЕ ЭТОЙ ФОРМЫ: при ней минимум на выходе не "примерно равен" требуемой сумме, а равен ей
// точно, и вопроса "а что делать с разницей" не возникает вовсе (док 45).
export async function quoteExactOutPath(chain, { route, amountOutWei }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { ok: false, why: "no verified QuoterV2 for this network" };
  if (!route || !Array.isArray(route.tokens) || route.tokens.length < 2) return { ok: false, why: "route has no path" };
  const tokens = route.tokens.slice().reverse();
  const fees = (route.fees || []).slice().reverse();
  const path = encodePath({ tokens, fees });
  // Динамический аргумент (bytes) идёт со словом смещения: 0x40, затем сумма точного выхода, затем сам путь.
  const data = DEX_METHOD.quoteExactOutput.hex + uintWord(0x40) + uintWord(amountOutWei) + uintWord(path.bytes) +
    path.packed.padEnd(Math.ceil(path.packed.length / 64) * 64, "0");
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { ok: false, why: res.why };
  const out = decodeQuoteExactInput(res.result); // форма ответа та же: сумма, массивы, газ
  if (!out || out.amountOutWei <= 0n) return { ok: false, why: "pool cannot serve exactly this output" };
  return {
    ok: true,
    amountInWei: out.amountOutWei.toString(),
    gasEstimate: out.gasEstimate.toString(),
    shapeOk: out.sqrtPriceX96After.length === fees.length,
    reversed: tokens.map((x) => x).length === fees.length + 1,
  };
}

// ПУТЬ ДЛЯ МНОГОШАГОВОЙ КОТИРОВКИ. Путь в Uniswap v3 - это УПАКОВАННАЯ последовательность
// "адрес(20) + комиссия(3)" с завершающим адресом: token0|fee0|token1|fee1|token2. Никаких слов ABI
// внутри пути нет: 43 байта на одну ногу, 66 на две. Проверено числом: одноступенчатый путь через
// quoteExactInput вернул ровно тот же amountOut, что и quoteExactInputSingle по той же ступени.
export function encodePath({ tokens, fees }) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(hexBody(tokens[i]).toLowerCase().padStart(40, "0"));
    if (i < fees.length) parts.push(hexBody(Number(fees[i]).toString(16)).toLowerCase().padStart(6, "0"));
  }
  const packed = parts.join("");
  return { packed, bytes: packed.length / 2 };
}

// ВЫЗОВ quoteExactInput(bytes path, uint256 amountIn) - ОДИН eth_call на ВЕСЬ маршрут. Собран по
// спецификации ABI, потому что здесь аргумент динамический: слово смещения (0x40), затем amountIn,
// затем длина пути и сам путь, добитый до границы слова. ЗДЕСЬ, В ОТЛИЧИЕ ОТ ОДИНОЧНОЙ ФОРМЫ, СМЕЩЕНИЕ
// ДЕЙСТВИТЕЛЬНО НУЖНО - одиночная форма принимает статичную структуру и идёт словами подряд.
export function encodeQuoteExactInput({ tokens, fees, amountInWei }) {
  const { packed, bytes } = encodePath({ tokens, fees });
  const padded = packed.padEnd(Math.ceil(bytes / 32) * 64, "0");
  return DEX_METHOD.quoteExactInput.hex + word("0x40") + uintWord(amountInWei) + uintWord(bytes) + padded;
}
const wordToAddress = (w) => (w === undefined || w === null ? null : "0x" + w.toString(16).padStart(40, "0"));
const ZERO_ADDR = "0x" + "0".repeat(40);

// Ступень комиссии в процентах: 500 -> "0.05%". Это ЕДИНСТВЕННАЯ величина, которая раньше бралась из
// мока, и теперь она считается из самой ступени, а не берётся константой.
// Арифметика: fee измеряется в сотых долях базисной точки, 1 000 000 = 100%. Значит проценты = fee/10 000,
// то есть 500 -> 0.05%. Здесь сначала стояло ЕЩЁ деление на 100, и ступень 500 подписывалась как
// "0.0005%" - то есть комиссия занижалась в сто раз (поймано прогоном, а не на глаз).
export function feeTierPct(fee) {
  const n = Number(fee);
  if (!Number.isFinite(n)) return null;
  return n / 10_000;
}
export function feeTierLabel(fee) {
  const pct = feeTierPct(fee);
  if (pct === null) return String(fee);
  return String(Number(pct.toFixed(4))) + "%";
}

// ---------------------------------------------------------------------------
// Чтения
// ---------------------------------------------------------------------------

// Адрес пула у фабрики. null - пула нет (это ОТВЕТ, а не ошибка: значит менять не на что).
export async function poolAddress(chain, { tokenIn, tokenOut, fee }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.factory) return { ok: false, why: "no verified Uniswap factory for this network" };
  const res = await rpc(chain, "eth_call", [{ to: u.factory, data: encodeGetPool({ tokenA: tokenIn, tokenB: tokenOut, fee }) }, "latest"], opts);
  if (!res.ok) return { ok: false, why: res.why };
  const words = decodeWords(res.result);
  const pool = wordToAddress(words[0]);
  if (!pool || pool === ZERO_ADDR) return { ok: true, pool: null };
  return { ok: true, pool };
}

// Состояние пула: активная ликвидность и запасы обеих сторон. Нужно для ЧЕСТНОГО ответа "ликвидности
// нет": котировка пустого пула отвечает нулём, и без этого чтения мы не отличим "пула нет" от "пул есть,
// но пустой". Читается только в диагностическом пути (когда котировки нет или она неправдоподобна).
export async function poolState(chain, pool, { tokenIn, tokenOut }, opts = {}) {
  if (!pool) return null;
  const [liq, balIn, balOut] = await Promise.all([
    rpc(chain, "eth_call", [{ to: pool, data: DEX_METHOD.liquidity.hex }, "latest"], opts),
    rpc(chain, "eth_call", [{ to: tokenIn, data: DEX_METHOD.balanceOf.hex + addrWord(pool) }, "latest"], opts),
    rpc(chain, "eth_call", [{ to: tokenOut, data: DEX_METHOD.balanceOf.hex + addrWord(pool) }, "latest"], opts),
  ]);
  const one = (r) => (r.ok ? decodeWords(r.result)[0] ?? null : null);
  return {
    liquidity: liq.ok ? (BigInt(decodeWords(liq.result)[0] ?? 0n)).toString() : null,
    reserveInWei: balIn.ok && one(balIn) !== null ? one(balIn).toString() : null,
    reserveOutWei: balOut.ok && one(balOut) !== null ? one(balOut).toString() : null,
  };
}

// ОДНА КОТИРОВКА ОДНОЙ СТУПЕНИ. Откат котировки - это НАЗВАННЫЙ отказ, а не исключение.
export async function quoteTier(chain, { tokenIn, tokenOut, amountInWei, fee }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { fee, ok: false, why: "no verified QuoterV2 for this network" };
  const data = encodeQuoteExactInputSingle({ tokenIn, tokenOut, amountInWei, fee });
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { fee, ok: false, why: res.why };
  const words = decodeWords(res.result);
  if (words.length < 4) return { fee, ok: false, why: "quoter answered " + words.length + " words, expected 4" };
  const amountOut = words[0];
  if (amountOut <= 0n) return { fee, ok: false, why: "pool cannot serve this size" };
  return {
    fee,
    ok: true,
    amountOutWei: amountOut.toString(),
    gasEstimate: words[3].toString(),
    sqrtPriceX96After: words[1].toString(),
    initializedTicksCrossed: words[2].toString(),
  };
}

// Разбор ответа quoteExactInput. Ответ ДРУГОЙ, чем у одиночной формы: (uint256 amountOut,
// uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate) - то есть
// на каждый шаг пути по элементу в двух массивах. Смещения читаются из самого ответа, а не
// предполагаются: длина массивов равна числу ног пути, и это можно СВЕРИТЬ, а не поверить.
export function decodeQuoteExactInput(hex) {
  const words = decodeWords(hex);
  if (words.length < 4) return null;
  const at = (w) => Number(w) / 32;
  const readArr = (w) => {
    const i = at(w);
    if (!Number.isInteger(i) || i < 0 || i >= words.length) return [];
    const n = Number(words[i]);
    if (!Number.isInteger(n) || n <= 0 || i + 1 + n > words.length) return [];
    return words.slice(i + 1, i + 1 + n).map(String);
  };
  return {
    amountOutWei: words[0],
    sqrtPriceX96After: readArr(words[1]),
    initializedTicksCrossed: readArr(words[2]),
    gasEstimate: words[3],
  };
}

// КОТИРОВКА ВСЕГО ПУТИ ОДНИМ ВЫЗОВОМ. Здесь НЕТ цепочки "котировка шага 1, потом шаг 2 от её выхода":
// такая цепочка считает оба шага по одному и тому же состоянию пулов и даёт оптимистично неверное число.
export async function quotePath(chain, { route, amountInWei }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { ...route, ok: false, why: "no verified QuoterV2 for this network" };
  const data = encodeQuoteExactInput({ tokens: route.tokens, fees: route.fees, amountInWei });
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { ...route, ok: false, why: res.why };
  const out = decodeQuoteExactInput(res.result);
  if (!out) return { ...route, ok: false, why: "quoter answered a shape that is not quoteExactInput" };
  if (out.amountOutWei <= 0n) return { ...route, ok: false, why: "pool cannot serve this size" };
  return {
    ...route,
    ok: true,
    amountOutWei: out.amountOutWei.toString(),
    gasEstimate: out.gasEstimate.toString(),
    sqrtPriceX96After: out.sqrtPriceX96After,
    initializedTicksCrossed: out.initializedTicksCrossed,
    hops: route.fees.length,
    // ЧИСЛО ШАГОВ ОТВЕТА СВЕРЯЕТСЯ С ЧИСЛОМ НОГ ПУТИ: если контракт вернул не по элементу на шаг, то это
    // не тот ответ, который мы умеем читать, и лучше сказать это словами, чем показать число наугад.
    shapeOk: out.sqrtPriceX96After.length === route.fees.length,
  };
}

// ПОДПИСЬ ОБЪЯВЛЕННОГО МАРШРУТА: одна строка, по которой видно, ИЗ ЧЕГО он собран. Нужна для ключа
// кеша: если объявление поменяли (другая ступень, другой хаб), старый ответ на новый вопрос не годится.
export function routeSignature(route) {
  if (!route || !Array.isArray(route.steps) || !route.steps.length) return route && route.unwrap ? "unwrap" : "none";
  return route.steps.map((s) => String(s.to).toUpperCase() + ":" + Number(s.fee) + (s.pool ? ":" + String(s.pool).toLowerCase() : "")).join("+");
}

// ---------------------------------------------------------------------------
// ПРОВЕРКА ЦЕНЫ: СДЕЛКА НЕВЕРНАЯ ИЛИ НЕТ.
//
// Это НЕ оценка ликвидности - её, как и раньше, делает человек, и приговоров о глубине пулов здесь нет.
// Это проверка того же рода, что покрытие суммы: если цена не та, сделка не сойдётся, и она не должна
// начинаться. Признак неверной цены берётся ДВУМЯ способами, и ни одному из них не нужен фид на каждый
// токен (иначе USDe/USDS/PyUSD без своего фида сломали бы проверку вовсе):
//
//   1) ПОСЛЕДНИЙ ШАГ В НАТИВ. Из котировки выводится НЕЯВНАЯ цена натива в долларах (сколько входит в
//      долларах / сколько натива выходит) и сравнивается с эталоном цены натива - тем самым Chainlink,
//      который страница уже читает (evm/prices.js). Это работает для любого входа: у стейбла цена в
//      долларах известна из реестра, у остальных маршрут всё равно заканчивается нативом;
//   2) ШАГ МЕЖДУ ДВУМЯ СТЕЙБЛАМИ (USDe→USDC, USDS→USDC, PyUSD→USDC): цена обязана быть около 1:1, и это
//      проверяется САМОЙ КОТИРОВКОЙ, без оракула вообще. Абсурд вида "100 USDe дают 0.5 USDC" ловится
//      именно здесь.
//
// ПОРОГИ ПРИХОДЯТ ДАННЫМИ (реестр: DEX_PRICE_GATE), а не лежат здесь числами: менять их - правка данных.
// ПРИЗНАК СЕТИ tolerated (реестр: dexPriceGate === "tolerated") ОТМЕНЯЕТ БЛОКИРОВКУ, НО НЕ ФАКТ: цена
// остаётся негодной и названа таковой (bad), а интерфейс обязан её показать. Так тестнет не встаёт на
// цене, которую мы не выбирали, и при этом не притворяется, что цена рыночная.
//
// Функция ЧИСТАЯ: ни одного вызова в сеть, только числа ноги и эталон. Поэтому её можно прогнать на
// любых числах без сети - чем и доказывается, что защита краснеет (tools/check-dex-gate.mjs).
// ---------------------------------------------------------------------------
export function priceGateVerdict({
  amountInWei = null, amountOutWei = null, inDecimals = null, outDecimals = null,
  tokenUsd = null, referenceUsd = null, stableSteps = [], tolerated = false, gates = null,
} = {}) {
  const maxDev = gates && Number.isFinite(Number(gates.maxDeviationPct)) && Number(gates.maxDeviationPct) > 0 ? Number(gates.maxDeviationPct) : null;
  const band = gates && Number.isFinite(Number(gates.stableBandPct)) && Number(gates.stableBandPct) >= 0 ? Number(gates.stableBandPct) : null;
  const why = [];

  // (1) ШАГИ МЕЖДУ СТЕЙБЛАМИ: около 1:1, без оракула.
  const stable = (Array.isArray(stableSteps) ? stableSteps : []).map((s) => {
    const row = {
      from: s.from, to: s.to, fee: s.fee, feeLabel: feeTierLabel(s.fee),
      inWei: s.inWei || null, outWei: s.outWei || null, exactAmount: Boolean(s.exact),
      quoted: Boolean(s.ok), ok: false, ratio: null, deviationPct: null, why: null,
    };
    if (!s.ok) {
      // ШАГ СТЕЙБЛ-СТЕЙБЛ НЕ ОТВЕТИЛ - И ЭТО НАЗВАНО, А НЕ ПРОПУЩЕНО: неизмеренная цена не проходит
      // проверку, иначе "не проверили" выглядело бы как "цена в порядке".
      row.why = "the 1:1 step could not be quoted (" + (s.why || "no answer") + ")";
      why.push(row.why);
      return row;
    }
    const inUnits = Number(s.inWei) / 10 ** Number(s.inDecimals);
    const outUnits = Number(s.outWei) / 10 ** Number(s.outDecimals);
    if (!(inUnits > 0) || !(outUnits > 0)) {
      row.why = "the 1:1 step answered with a number that cannot be read";
      why.push(row.why);
      return row;
    }
    row.ratio = outUnits / inUnits;
    row.deviationPct = Math.abs(1 - row.ratio) * 100;
    if (band === null) { row.why = "the 1:1 band is not declared for this step, so this step cannot be checked"; why.push(row.why); return row; }
    if (row.deviationPct > band) {
      row.why = `${row.from}→${row.to} at ${row.feeLabel} pays ${row.ratio.toFixed(6)} ${row.to} per 1 ${row.from} - ${row.deviationPct.toFixed(2)}% off 1:1, and the band is ${band}%`;
      why.push(row.why);
      return row;
    }
    row.ok = true;
    return row;
  });

  // (2) НЕЯВНАЯ ЦЕНА НАТИВА ПРОТИВ ЭТАЛОНА.
  const inUnits = Number.isFinite(Number(inDecimals)) && Number(amountInWei) > 0 ? Number(amountInWei) / 10 ** Number(inDecimals) : null;
  const outUnits = Number.isFinite(Number(outDecimals)) && Number(amountOutWei) > 0 ? Number(amountOutWei) / 10 ** Number(outDecimals) : null;
  const valueUsd = inUnits !== null && Number(tokenUsd) > 0 ? inUnits * Number(tokenUsd) : null;
  const impliedUsd = valueUsd !== null && outUnits !== null && outUnits > 0 ? valueUsd / outUnits : null;
  const ref = Number(referenceUsd) > 0 ? Number(referenceUsd) : null;
  const deviationPct = impliedUsd !== null && ref !== null ? Math.abs(impliedUsd - ref) / ref * 100 : null;
  const nativeBad = deviationPct !== null && maxDev !== null && deviationPct > maxDev;
  if (nativeBad) {
    why.push(`the route implies the native coin at $${impliedUsd.toFixed(2)} while the reference price is $${ref.toFixed(2)} - ${deviationPct.toFixed(1)}% apart, and the limit is ${maxDev}%: this is not the market price`);
  } else if (deviationPct === null) {
    // НЕ ПРОВЕРЯЛИ - ЭТО НЕ "ВСЁ ХОРОШО". Причину называем ту, по которой проверить не вышло.
    why.push(ref === null
      ? "the reference price of the native coin is not known, so the price cannot be checked"
      : "the price of the token being paid is not known, so the price cannot be checked");
  } else if (maxDev === null) {
    why.push("the price limit is not declared for this route, so the price cannot be checked");
  }

  // ПРОВЕРКА СОСТОЯЛАСЬ - значит НАТИВНАЯ ЧАСТЬ состоялась (эталон есть, лимит объявлен). Шаги
  // стейбл-стейбл не входят сюда намеренно: неизмеренный или вышедший из полосы шаг - это уже bad
  // (см. выше), а не "не проверено".
  const checked = deviationPct !== null && maxDev !== null;
  const bad = nativeBad || stable.some((r) => !r.ok);
  // БЛОКИРУЕТ ЛИ: негодная цена - да (кроме сети с признаком tolerated); непроверенная цена - тоже да,
  // и по той же логике, по которой блокирует неизвестная требуемая сумма: "не проверили" нельзя
  // показывать как "проверили и всё хорошо". На тестнете не блокирует ни то, ни другое.
  const blocks = tolerated ? false : (bad || !checked);
  return {
    checked, bad, tolerated: Boolean(tolerated), blocks,
    why: why.length ? why.join("; ") : null,
    impliedUsd, referenceUsd: ref, deviationPct,
    maxDeviationPct: maxDev, stableBandPct: band,
    tokenUsd: Number(tokenUsd) > 0 ? Number(tokenUsd) : null,
    stable,
  };
}

// ---------------------------------------------------------------------------
// ПОЧЕМУ МАРШРУТА НЕТ - СЛОВАМИ, И ЭТИ СЛОВА - ИЗ ДАННЫХ. Причина лежит в самом объявлении (route.why):
// её писал человек, объявляя маршрут, и она подтверждена замером (tools/check-uniswap-quote.mjs - раздел
// "объявленные маршруты"). Одна и та же формулировка в интерфейсе и в отчёте: разойдясь, они начнут
// объяснять человеку одно, а оператору другое.
// Маршрута в реестре НЕТ ВОВСЕ (токен есть, объявления нет) - это ТОЖЕ честный ответ, а не "не нашли":
// значит, обход не объявляли, и подпись по нему не начинается.
export function noRouteWords({ paySymbol, wrappedSymbol, chainName, route = null }) {
  // ТЕМПЛЕЙТ, А НЕ СКЛЕЙКА СТРОК: текст тот же, но подстроки `from "` в исходнике больше нет (склейка
  // случайно читалась проверкой голых импортов пакета SDK как спецификатор). Правило то же, слова те же.
  const head = `no route from ${paySymbol} to ${wrappedSymbol} on ${chainName}`;
  const why = route && route.why ? String(route.why) : null;
  // В ВИДИМОМ ТЕКСТЕ НЕТ НИ "registry", НИ "DEX_ROUTES": это имена НАШЕГО устройства, а не то, что
  // человеку нужно понять. Смысл тот же: маршрут не ищут перебором, его объявляет человек.
  return why ? head + ": " + why : head + ": no route for " + paySymbol + " is declared - routes are declared by hand, not searched";
}


// ---------------------------------------------------------------------------
// ВЕРДИКТ НОГИ: МОЖНО ЛИ ПО НЕЙ ПОДПИСЫВАТЬ (док 45). Две защиты ОДНОЙ СЕМЬИ, и обе БЛОКИРУЮТ подпись:
//   * ПОКРЫТИЕ СУММЫ - маршрут обязан дать не меньше, чем требует ордер (сумма эскроу);
//   * ЦЕНА - цена маршрута обязана быть рыночной (priceGateVerdict): неверная цена означает то же самое,
//     что и недостача, - сделка не сойдётся.
// Отличается от наблюдений именно этим: "не покрывает" и "цена не та" - такие же ФАКТЫ, как "пула нет",
// и они обязаны останавливать человека ДО подписи, а не показываться строкой в разбивке цены. Отсюда
// правило: функция возвращает либо { blocked: false }, либо { blocked: true, kind, reason } - и
// вызывающий ОБЯЗАН считаться с blocked.
// Приговоров о ликвидности здесь нет: "не покрывает на 0.4%" - это число, а не оценка качества пула.
//
//   kind: "unquoted"            - котировки ещё нет вовсе (спрашивать нечего, ждать нельзя: блокируем)
//         "no-route"            - маршрута нет: причины лежат в leg.why (объявление реестра + отказ цепи)
//         "price-unchecked"     - цену проверить НЕЧЕМ (нет эталона цены натива): блокируем - "не
//                                 проверили" нельзя показывать как "проверили и всё хорошо"
//         "bad-price"           - цена не рыночная: числа в verdict.price (блокирует на боевой сети)
//         "unchecked"           - требуемая сумма неизвестна (нет курса XMR/<натив>, чтобы её посчитать)
//         "short"               - маршрут есть, но выход МЕНЬШЕ требуемой суммы: вот насколько
//         "bad-price-tolerated" - цена негодная, но у сети признак dexPriceGate: подпись НЕ блокируется,
//                                 а негодность НАЗВАНА (тестнет: проверяем поток, а не рынок)
//         "covers"              - всё сходится: подпись разрешена (прочие защиты страницы в силе)
//
// ЧИСЛА ПОКРЫТИЯ ВОЗВРАЩАЮТСЯ ВСЕГДА, КОГДА ОНИ ИЗВЕСТНЫ (needWei/getsWei/shortfallWei/covers) - даже
// когда подпись заперта ценой: человеку должно быть видно, ИЗ ЧЕГО взялся вердикт, а не только слово
// "заблокировано".
//
// МИНИМУМ НА ВЫХОДЕ БУДУЩЕГО СВОПА БЕРЁТСЯ ОТСЮДА ЖЕ - из требуемой суммы эскроу, а не "на глазок"
// (docs 45). Поэтому недостача невозможна по построению, а излишек остаётся пользователю: НИКАКОЙ
// автоматической конвертации остатка в коде нет и не должно появиться - фондирование вносит ровно сумму
// ордера, всё прочее остаётся у человека.
export function dexLegVerdict(leg, requiredOutWei = null) {
  if (leg && leg.unwrap) return { blocked: false, kind: "unwrap", reason: null, price: null };
  if (!leg) return { blocked: true, kind: "unquoted", reason: "the swap leg has not been quoted yet", price: null };
  if (!leg.ok) return { blocked: true, kind: "no-route", reason: leg.why || "no route", price: null };
  // ЦЕНА ПРИХОДИТ ИЗ САМОЙ НОГИ: её считает quoteDexOut тем же ответом цепи, что и выход. Нога без
  // проверки цены (её собрал кто-то руками) эту защиту не подтверждает - проверить её здесь нечем,
  // поэтому и вердикта о цене у такой ноги нет.
  const price = leg.price || null;
  const priceBad = Boolean(price && price.bad);
  const priceUnchecked = Boolean(price && price.checked === false);
  const priceBlocks = Boolean(price && price.blocks && (priceBad || priceUnchecked));
  // ТРЕБУЕМАЯ СУММА ПРИХОДИТ СЮДА АРГУМЕНТОМ, А НЕ БЕРЁТСЯ ИЗ САМОЙ НОГИ: котировка живёт в кеше 20 с, а
  // размер ордера человек может поменять в любой момент. Возьми мы требуемую сумму из кешированного
  // ответа - вердикт отставал бы от того, что человек видит в форме, и это ровно тот случай, когда
  // защита "есть, но не срабатывает".
  const need = requiredOutWei !== null && requiredOutWei !== undefined && Number(requiredOutWei) > 0 ? BigInt(requiredOutWei) : null;
  const gets = BigInt(leg.amountOutWei);
  const coverage = need === null ? null : {
    needWei: need.toString(), getsWei: gets.toString(), covers: gets >= need,
    shortfallWei: (gets >= need ? 0n : need - gets).toString(),
  };
  const base = {
    ...(coverage || {}),
    price,
    routeLabel: leg.routeLabel || null,
    decimals: leg.wrapped ? leg.wrapped.decimals : null,
    wrappedSymbol: leg.wrapped ? leg.wrapped.symbol : null,
  };
  // ПОРЯДОК ПРИЧИН: сначала "подписывать нельзя вообще" (маршрута нет - выше; цена непроверена; цена не
  // та), потом "суммы не хватает", потом "всё сошлось". Он важен: при неверной цене вопрос о покрытии
  // числам уже не верится.
  if (priceBlocks) return { blocked: true, ...base, kind: priceBad ? "bad-price" : "price-unchecked", reason: price.why };
  if (coverage === null) {
    return { blocked: true, ...base, kind: "unchecked", reason: "the required escrow amount is not known yet, so coverage cannot be checked" };
  }
  if (!coverage.covers) return { blocked: true, ...base, kind: "short", reason: "the declared route returns less than the order needs" };
  if (priceBad) return { blocked: false, ...base, kind: "bad-price-tolerated", reason: price.why };
  return { blocked: false, ...base, kind: "covers", reason: null };
}

// ---------------------------------------------------------------------------
// Главный вход для страницы: сколько натива даст оплата этим токеном ПО ОБЪЯВЛЕННОМУ МАРШРУТУ.
//
//   token              - токен оплаты из реестра (адрес, decimals и цена)
//   amountWei          - сумма оплаты в его минимальных единицах
//   requiredOutWei     - СКОЛЬКО НАТИВА ТРЕБУЕТ ОРДЕР (сумма эскроу на этот размер входа). Это НЕ
//                        наблюдение, а условие выполнимости: по нему считается вердикт "покрывает /
//                        не покрывает", и "не покрывает" блокирует подпись (см. dexLegVerdict).
//   route              - ОБЪЯВЛЕННЫЙ маршрут из реестра (DEX_ROUTES[chainId][symbol]). Выбора здесь нет
//                        и быть не должно: что объявлено - то и котируется, ОДНИМ вызовом. Объявления
//                        нет или в нём пусто - это честное "маршрута нет" (слова - из route.why), и
//                        подпись по нему не начинается.
//   tokens             - токены этой сети: по символу из шага берутся адрес и decimals
//   referenceNativeUsd - ЭТАЛОН цены натива в долларах (Chainlink у страницы). Без него проверка цены
//                        не состоится, и это не повод её пропустить (см. priceGateVerdict).
//   gates              - пороги проверки цены из реестра (DEX_PRICE_GATE)
//
// ХАБОВ ЗДЕСЬ БОЛЬШЕ НЕТ: обход через USDC/USDT - это тоже объявленный маршрут, а не поиск в рантайме.
//
// Возвращает ЛИБО { ok: true, ... } с числами из цепи, ЛИБО { ok: false, why } словами. Числа и
// "почему нет" вместе не возвращаются: показать человеку и то и другое - значит предложить ему
// догадаться, какому из двух ответов верить.
// ---------------------------------------------------------------------------
export async function quoteDexOut(chain, { token, amountWei, requiredOutWei = null, route = null, tokens = [], referenceNativeUsd = null, gates = null } = {}, opts = {}) {
  const u = chain && chain.uniswap;
  if (!token || !token.address) return { ok: false, why: token && token.native ? "paying the native coin needs no DEX leg" : "no token address" };
  if (!u || !u.quoter || !u.wrapped) return { ok: false, why: "no verified Uniswap addresses for " + (chain && chain.name ? chain.name : "this network") };
  const amount = BigInt(amountWei || 0);
  if (amount <= 0n) return { ok: false, why: "amount not entered" };
  const wrapped = u.wrapped;
  const chainName = (chain && chain.name) || (chain && chain.id) || "this network";
  if (String(token.address).toLowerCase() === String(wrapped.address).toLowerCase()) {
    // Обёрнутый нативный токен меняется на натив НЕ в пуле: это withdraw у WETH9, один к одному.
    return { ok: false, why: "this is the wrapped native coin: no pool needed, it unwraps 1:1", unwrap: true };
  }
  const declared = route || null;
  // ПРИЗНАК СЕТИ: негодная цена на тестнете не блокирует (реестр: dexPriceGate у сети). Отсутствие
  // признака - блокирует, и это умолчание: молчаливое "сойдёт" на боевой сети недопустимо.
  const tolerated = String((chain && chain.dexPriceGate) || "") === "tolerated";
  // ОБЪЯВЛЕНИЕ, КОТОРЫМ ПОЛЬЗУЕМСЯ, ВОЗВРАЩАЕТСЯ В ОТВЕТЕ ЦЕЛИКОМ (со ступенями, пулами и датой замера):
  // интерфейс и отчёт обязаны называть не только ЧТО получилось, но и ПО ЧЕМУ это объявлено.
  const declaration = declared
    ? {
        steps: (Array.isArray(declared.steps) ? declared.steps : []).map((s) => ({ to: s.to, fee: s.fee, pool: s.pool || null, verified: s.verified || null })),
        why: declared.why || null, unwrap: Boolean(declared.unwrap),
      }
    : null;
  // (1) МАРШРУТА НЕТ - ЭТО ОТВЕТ ИЗ ДАННЫХ, А НЕ ОШИБКА. Пустой steps значит "объявленного маршрута нет":
  // почему его нет - в route.why, и эти слова уходят и в интерфейс, и в отчёт (одни и те же).
  if (!declared || !Array.isArray(declared.steps) || !declared.steps.length) {
    if (declared && declared.unwrap) return { ok: false, why: "this is the wrapped native coin: no pool needed, it unwraps 1:1", unwrap: true };
    return { ok: false, why: noRouteWords({ paySymbol: token.symbol, wrappedSymbol: wrapped.symbol, chainName, route: declared }), declared: true, declaration, steps: [] };
  }
  // (2) ПУТЬ ИЗ ОБЪЯВЛЕННЫХ ШАГОВ. Не собрать объявленное (шаг называет токен, которого в этой сети нет) -
  // это ошибка В ДАННЫХ, и называть её надо иначе, чем "маршрута нет": по ней видно, что правки ждёт реестр.
  const path = declaredRoutePath({ token, tokens, wrapped, route: declared });
  if (!path || path.error) {
    return {
      ok: false, declared: true, dataError: true, declaration,
      why: "the declared route for " + token.symbol + " on " + chainName + " cannot be built: " + ((path && path.error) || "unknown reason"),
    };
  }
  const byAddr = new Map((Array.isArray(tokens) ? tokens : []).filter((t) => t && t.address).map((t) => [String(t.address).toLowerCase(), t]));
  const dec = (addr) => {
    if (String(addr).toLowerCase() === String(token.address).toLowerCase()) return token.decimals;
    if (String(addr).toLowerCase() === String(wrapped.address).toLowerCase()) return wrapped.decimals;
    const h = byAddr.get(String(addr).toLowerCase());
    return h && Number.isFinite(Number(h.decimals)) ? Number(h.decimals) : null;
  };
  // (3) КЕШ НА 20 С ПО СЕТИ, ТОКЕНУ, СУММЕ И ПОДПИСИ ОБЪЯВЛЕНИЯ. Сменив объявление, мы спрашиваем ДРУГОЙ
  // маршрут, и старый ответ на новый вопрос не годится. Требуемая сумма в ключ НЕ входит: она меняется от
  // размера ордера, а покрытие и цена считаются ниже - каждый раз, из свежих чисел.
  const key = [chain.id, token.symbol, amount.toString(), routeSignature(declared)].join("|");
  let base = cached(key);
  if (base === undefined) {
    // ОДИН ВЫЗОВ НА ВЕСЬ ПУТЬ. Цепочки "котировка шага 1, потом шаг 2 от её выхода" здесь нет и быть не
    // должно: такая цепочка считает оба шага по одному состоянию пулов и даёт оптимистично неверное число.
    const quote = await quotePath(chain, { route: { tokens: path.tokens, fees: path.fees, symbols: path.symbols, via: null }, amountInWei: amount }, opts);
    if (!quote.ok) return put(key, { ok: false, why: quote.why, declared: true });
    base = { ok: true, quote };
    put(key, base);
  }
  if (!base.ok) return { ...base, declaration };
  const q = base.quote;
  // ПУЛЫ МАРШРУТА ЧИТАЮТСЯ ВСЕГДА, КОГДА КОТИРОВКА ЕСТЬ - по одной записи на КАЖДУЮ ногу. Это ФАКТ,
  // который человеку нужен рядом с числом: "маршрут ответил столько-то" само по себе не говорит, много
  // ли лежит в пулах на его пути. Запасы в wei БЕЗ decimals человеку не читаются, поэтому decimals
  // едут рядом - подставлять 18 "по похожести" значило бы однажды показать 6-значный токен как 18-значный.
  if (base.hops === undefined) {
    const hops = [];
    for (let i = 0; i < path.fees.length; i++) {
      const fee = path.fees[i];
      const from = path.tokens[i], to = path.tokens[i + 1];
      const declaredStep = (declared.steps && declared.steps[i]) || {};
      const poolRes = await poolAddress(chain, { tokenIn: from, tokenOut: to, fee }, opts);
      const pool = poolRes.ok ? poolRes.pool : null;
      const declaredPool = declaredStep.pool || null;
      hops.push({
        step: i + 1, from: path.symbols[i], to: path.symbols[i + 1], fee, feeLabel: feeTierLabel(fee),
        decimals: [dec(from), dec(to)],
        pool,
        // СВЕРКА ОБЪЯВЛЕННОГО АДРЕСА ПУЛА С ЦЕПЬЮ. Если фабрика отвечает другим пулом, объявление
        // устарело: в отчёте инструмента это провал, здесь - факт рядом с числом (решает человек).
        declaredPool,
        poolMatchesDeclared: pool && declaredPool ? String(pool).toLowerCase() === String(declaredPool).toLowerCase() : null,
        verified: declaredStep.verified || null,
        // СОСТОЯНИЕ ПУЛА ЗДЕСЬ БОЛЬШЕ НЕ ЧИТАЕТСЯ. Три вызова eth_call на каждую ногу (liquidity(),
        // balanceOf(tokenIn), balanceOf(tokenOut)) собирались ради одной строки в интерфейсе - liquidity,
        // резервы пула, - и та убрана: после ссылки на пул человек смотрит глубину и состояние в обозревателе.
        // Сама функция poolState остаётся: её зовёт отчёт инструмента (tools/check-uniswap-quote.mjs), и там
        // эти числа нужны оператору. Здесь же они не нужны никому, а страница спрашивает их на каждом обновлении.
      });
    }
    base.hops = hops;
  }
  const hops = base.hops;
  // ШАГИ МЕЖДУ ДВУМЯ СТЕЙБЛАМИ ПРОВЕРЯЮТСЯ САМОЙ КОТИРОВКОЙ (около 1:1, без оракула вовсе). Сумма шага -
  // сумма маршрута: у объявленных маршрутов такой шаг идёт ПЕРВЫМ, поэтому для него это ровно его сумма
  // (и это отмечено полем exact у каждой строки).
  if (base.stableSteps === undefined) {
    const stables = (gates && Array.isArray(gates.stables) ? gates.stables : []).map((s) => String(s).toUpperCase());
    const steps = [];
    for (let i = 0; i < path.fees.length; i++) {
      const fromSym = String(path.symbols[i]).toUpperCase(), toSym = String(path.symbols[i + 1]).toUpperCase();
      if (!stables.includes(fromSym) || !stables.includes(toSym)) continue;
      const stepQuote = await quoteTier(chain, { tokenIn: path.tokens[i], tokenOut: path.tokens[i + 1], amountInWei: amount, fee: path.fees[i] }, opts);
      steps.push({
        from: path.symbols[i], to: path.symbols[i + 1], fee: path.fees[i],
        inWei: amount.toString(), outWei: stepQuote.ok ? stepQuote.amountOutWei : null,
        inDecimals: dec(path.tokens[i]), outDecimals: dec(path.tokens[i + 1]),
        ok: Boolean(stepQuote.ok), why: stepQuote.ok ? null : stepQuote.why, exact: i === 0,
      });
    }
    base.stableSteps = steps;
  }
  // ПРОВЕРКА ЦЕНЫ. Считается КАЖДЫЙ РАЗ, а не кешируется вместе с котировкой: эталон цены натива
  // подгружается отдельно и может появиться позже, чем ответ пула - ровно та же причина, по которой
  // здесь не кешируется и вердикт покрытия.
  const price = priceGateVerdict({
    amountInWei: amount, amountOutWei: q.amountOutWei,
    inDecimals: token.decimals, outDecimals: wrapped.decimals,
    tokenUsd: Number(token.usd) > 0 ? Number(token.usd) : null,
    referenceUsd: referenceNativeUsd,
    stableSteps: base.stableSteps, tolerated, gates,
  });
  // ПРЕДПОЧТИТЕЛЬНАЯ ФОРМА: "получить РОВНО требуемую сумму, потратив не больше введённого" (док 45).
  // Спрашивается тем же путём-победителем, но В ОБРАТНУЮ СТОРОНУ - контракт требует именно так. Ответ
  // важен не только числом: он снимает вопрос о разнице сумм, потому что минимум на выходе становится
  // равен требуемой сумме по построению. Отказ здесь - тоже ответ: значит ровно столько пул не отдаёт,
  // и тогда остаётся обычная форма на вход с минимумом от требуемой суммы.
  let exactOut = null;
  if (requiredOutWei !== null && requiredOutWei !== undefined && Number(requiredOutWei) > 0) {
    const eo = await quoteExactOutPath(chain, { route: q, amountOutWei: BigInt(requiredOutWei) }, opts);
    exactOut = eo.ok
      ? {
          ok: true, amountInWei: eo.amountInWei, gasEstimate: eo.gasEstimate,
          // ХВАТИТ ЛИ ВВЕДЁННОГО: сравнивается сумма на входе, потому что у этой формы ответ - именно
          // "сколько надо отдать". Излишек остаётся пользователю: никакой конвертации остатка в коде нет.
          enough: BigInt(eo.amountInWei) <= amount,
          enteredWei: amount.toString(),
          spareInWei: (BigInt(eo.amountInWei) <= amount ? amount - BigInt(eo.amountInWei) : 0n).toString(),
          shortInWei: (BigInt(eo.amountInWei) <= amount ? 0n : BigInt(eo.amountInWei) - amount).toString(),
        }
      : { ok: false, why: eo.why };
  }
  // ПОКРЫТИЕ СЧИТАЕТСЯ ЗДЕСЬ, А НЕ БЕРЁТСЯ ИЗ КЕША: пул и сумма входа кешируются на 20 с, а требуемая
  // сумма приходит из ордера и может смениться (человек поправил размер XMR) - и тогда покрытие обязано
  // пересчитаться, а не остаться прежним. Считается в целых wei.
  const required = requiredOutWei !== null && requiredOutWei !== undefined && Number(requiredOutWei) > 0
    ? (() => {
        const need = BigInt(requiredOutWei);
        const gets = BigInt(q.amountOutWei);
        return {
          outWei: need.toString(),
          getsWei: gets.toString(),
          covers: gets >= need,
          shortfallWei: (gets >= need ? 0n : need - gets).toString(),
        };
      })()
    : null;
  return {
    ok: true,
    leg: "pool",
    venue: "Uniswap v3",
    payToken: token.symbol,
    wrapped,
    // ОБЪЯВЛЕННЫЙ МАРШРУТ, КОТОРЫМ СПРОШЕНА ЦЕНА: ступени, их пулы и дата замера - целиком, как в реестре.
    // Интерфейс обязан показывать не только ЧТО получилось, но и ПО ЧЕМУ это объявлено.
    declaredRoute: declaration,
    // ПУТЬ - ЭТО ШАГИ С КОМИССИЯМИ, а не одна ступень: у объявленного обхода через стейбл их две.
    route: { symbols: q.symbols.slice(), fees: q.fees.slice(), pools: path.pools.slice(), via: null, hops: q.fees.length },
    routeLabel: routeLabel(q),
    steps: routeSteps(q),
    fee: q.fees[q.fees.length - 1],
    feeLabel: q.fees.map((f) => feeTierLabel(f)).join(" / "),
    amountInWei: amount.toString(),
    amountOutWei: q.amountOutWei,
    gasEstimate: q.gasEstimate,
    // ВЕРДИКТ ВЫПОЛНИМОСТИ: покрывает ли маршрут требуемую сумму ордера. null означает "требуемая сумма
    // не передана" - и тогда подпись блокируется как непроверенная (см. dexLegVerdict), а не разрешается.
    required,
    // ПРОВЕРКА ЦЕНЫ: проверили ли, похожа ли цена на рыночную, и блокирует ли это подпись на этой сети.
    price,
    // ПРЕДПОЧТИТЕЛЬНАЯ ФОРМА (точный выход): сколько надо отдать, чтобы получить ровно требуемую сумму.
    // Вопрос о разнице сумм при ней не встаёт - минимум на выходе равен требуемому по построению.
    exactOut,
    hopsDetail: hops,
    // Одиночная ступень (прежняя форма ответа) - из первой ноги пути. Читать их как "пул всего маршрута"
    // нельзя, и это сказано тут: у обхода через хаб ног две.
    pool: hops.length ? hops[0].pool : null,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// WETH -> ETH: unwrap у самого WETH9, один к одному, БЕЗ пула.
//
// Отсюда берётся описание строки "unwrap, 1:1". Оценка газа СЮДА НЕ ВХОДИТ: чтобы назвать газ unwrap,
// нужен счёт, который держит WETH и может платить за газ, а у страницы такого счёта нет (и отправлять
// ничего нельзя на этом шаге). Измеренный газ unwrap лежит в отчёте инструмента
// (tools/check-uniswap-quote.mjs: газ измеряется eth_estimateGas на настоящем держателе WETH, которого
// инструмент находит по журналам Transfer). Подставлять это число в интерфейс как "газ этой сделки"
// было бы подменой: оно измерено на чужом счёте и на другой сумме. Поэтому честно: gasEstimate === null.
// ---------------------------------------------------------------------------
export function unwrapLeg(chain) {
  const u = chain && chain.uniswap;
  if (!u || !u.wrapped) return { ok: false, why: "no verified wrapped native coin for this network" };
  const w = u.wrapped;
  return {
    ok: true,
    leg: "unwrap",
    venue: w.name || w.symbol,
    wrapped: w,
    rate: 1, // один к одному по определению WETH9: withdraw(wad) отдаёт ровно wad нативного
    gasEstimate: null,
    why: null,
  };
}
