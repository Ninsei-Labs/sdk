// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/preSignGuards.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ЗАЩИТЫ ПЕРЕД ПОДПИСЬЮ: НЕДОПУСТИМАЯ СДЕЛКА НЕ НАЧИНАЕТСЯ (док 45).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. До сих пор защиты жили врозь: одна - в реестре маршрутов (evm/dex.js:
// покрытие суммы и цена DEX-ноги), прочие - в виде проверок, разбросанных по форме и по потоку ордера. От
// этого заводится ровно тот дефект, из-за которого файл и написан: правило есть, а подпись не
// останавливается, потому что экран его не спросил. Здесь правила сведены в ОДНО место, у них ОДНА
// форма ответа, и сводка (signingGateVerdict) отвечает на единственный вопрос, который решает дело:
// начинать подпись или нет.
//
// ЧТО ЗНАЧИТ ОТВЕТ. Каждый приговор несёт три поля, и они разные по смыслу:
//   blocks  - подписывать НЕЛЬЗЯ (это и есть защита; вызывающий ОБЯЗАН считаться с этим полем);
//   checked - удалось ли вообще проверить (true/false);
//   reason  - слова, и в них ЧИСЛА: человеку нужно не "нельзя", а "нельзя, потому что вот столько".
// Отличать checked от blocks обязательно, и вот почему на двух примерах из этого файла:
//
//   * НЕПРОВЕРЕННЫЙ БАЛАНС БЛОКИРУЕТ. Прочитать баланс мы умеем всегда, и "не прочитали" здесь значит
//     "не знаем, хватает ли денег на то, что человек собирается подписать". Пропустить это значило бы
//     отправить человека подписывать отказ кошелька.
//   * НЕИЗМЕРЕННЫЙ ЗАПАС НА ГАЗ НЕ БЛОКИРУЕТ, И ЭТО РЕШЕНИЕ, А НЕ ЗАБЫВЧИВОСТЬ. Отличие от проверки
//     цены DEX-ноги принципиальное: негодная цена означает, что сделка НЕВЕРНАЯ, а неизмеренный газ -
//     всего лишь "запас неизвестен". Сама сделка от этого не становится недопустимой, а нехватку
//     топлива на транзакцию назовёт кошелёк. Поэтому такой случай помечается словами (checked: false,
//     kind reserve-unstated) и НЕ запирает подпись.
//   * НЕ НАЗВАННЫЙ ПРОВАЙДЕРОМ ДИАПАЗОН ОБЪЁМА - ТАК ЖЕ: помечается, не запирает (решение уже принято
//     рынком: "объём не назван - ограничивать нечем", www/js/mock/market.js: coversSize).
//
// И ЕЩЁ ОДНО, ЧТО ЗДЕСЬ ПРИНЦИПИАЛЬНО. Все приговоры - ЧИСТЫЕ функции: ни сети, ни кошелька, ни DOM.
// Поэтому каждую защиту можно прогнать на числах, которые её ЛОМАЮТ, и увидеть, что она краснеет:
// "код есть" не равно "отказ работает" (tools/check-signing-guards.mjs).
//
// ПОРОГИ ПРИХОДЯТ ДАННЫМИ (реестр: SIGNING_GUARDS в core/config.js), а не лежат здесь числами: менять
// их - правка данных, а не логики.

// wei из того, что дал вызывающий (BigInt, строка, число). Не разобралось - null, и это НЕ ноль:
// ноль баланса и "баланс неизвестен" - два разных состояния, и путать их нельзя.
const wei = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try { const n = BigInt(v); return n >= 0n ? n : null; } catch { return null; }
};
// КОЛИЧЕСТВО В ЧЕЛОВЕЧЕСКОМ ВИДЕ - ОТДЕЛЬНО ОТ human. Размер объёма и границы диапазона приходят УЖЕ
// человеческими числами (единицы ASSET пары, док 41 §5), а не wei, и делить их на 10^decimals нечего:
// общая функция дала бы в отказе числа, отличающиеся от настоящих в 10^14 раз - то есть уверенный, но
// неверный ответ ("минимум 0.00001 XMR" вместо "0.1 XMR"). Поэтому формат свой.
const qty = (v) => String(Number(Number(v).toFixed(4)));
const finite = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
// Число в человеческом виде для слов: 6 знаков после запятой хватает и стейблу, и нативу, а полный
// wei в тексте человек не читает.
const human = (v, decimals = 18) => {
  const n = Number(v) / 10 ** Number(decimals);
  if (!Number.isFinite(n)) return String(v);
  return String(Number(n.toFixed(6)));
};

// ---------------------------------------------------------------------------
// 1) СУММА ПРОТИВ ДИАПАЗОНА КОТИРОВКИ. Диапазон называет провайдер (min/max/step), и за его границы
// он не берётся: размер вне диапазона - это НЕ "попробуем", а отказ, и он должен случиться ДО подписи,
// а не у провайдера после неё.
// ЕДИНИЦА - ЧАСТЬ ПРОВЕРКИ, А НЕ УКРАШЕНИЕ (док 41, §5): объём и границы обязаны быть в ОДНОЙ единице
// (ASSET пары), иначе сравниваются разные величины, и "в диапазоне" значит ничего.
// ---------------------------------------------------------------------------
export function rangeVerdict({ size = null, unit = null, min = null, max = null, step = null, quoteUnit = null } = {}) {
  const u = String(unit || quoteUnit || "").toUpperCase();
  const statedUnit = String(quoteUnit || "").toUpperCase();
  if (statedUnit && u && statedUnit !== u) {
    return {
      ok: false, checked: true, blocks: true, kind: "unit-mismatch",
      reason: `the size is measured in ${u} while the quote states its range in ${statedUnit} - the two cannot be compared`,
      size, min, max, step, unit: u, quoteUnit: statedUnit,
    };
  }
  const s = finite(size);
  if (s === null || s <= 0) {
    return {
      ok: false, checked: false, blocks: false, kind: "size-unstated",
      reason: "the size is not entered, so the provider's range cannot be checked",
      size: null, min: finite(min), max: finite(max), step: finite(step), unit: u,
    };
  }
  const lo = finite(min), hi = finite(max), st = finite(step);
  if (lo === null && hi === null) {
    // Провайдер не назвал границ - это его слово, а не наша ошибка: помечаем и не запираем.
    return {
      ok: true, checked: false, blocks: false, kind: "range-unstated",
      reason: "the provider did not state a volume range (min/max), so the size could not be checked against it",
      size: s, min: null, max: null, step: st, unit: u,
    };
  }
  const base = { size: s, min: lo, max: hi, step: st, unit: u, quoteUnit: statedUnit || u };
  if (lo !== null && s < lo) {
    return { ok: false, checked: true, blocks: true, kind: "below-min", ...base,
      reason: `the order size ${qty(s)} ${u} is below the provider minimum ${qty(lo)} ${u} - short by ${qty(lo - s)} ${u}: the provider does not take this size` };
  }
  if (hi !== null && s > hi) {
    return { ok: false, checked: true, blocks: true, kind: "above-max", ...base,
      reason: `the order size ${qty(s)} ${u} is above the provider maximum ${qty(hi)} ${u} - over by ${qty(s - hi)} ${u}: the provider does not take this size` };
  }
  if (st !== null && st > 0) {
    // Шаг считается ОТ min, а не от нуля: min=0.05 при шаге 0.1 не даёт больше ни одного размера,
    // и это правило рынка (www/js/mock/market.js: coversSize), а не выдумка этой функции.
    const from = lo !== null ? lo : 0;
    const grid = (s - from) / st;
    if (Math.abs(grid - Math.round(grid)) > 1e-6) {
      return { ok: false, checked: true, blocks: true, kind: "off-step", ...base,
        reason: `the order size ${qty(s)} ${u} does not sit on the ${qty(st)} ${u} step from ${qty(from)} ${u}` };
    }
  }
  return { ok: true, checked: true, blocks: false, kind: "in-range", ...base,
    reason: `the order size ${qty(s)} ${u} is inside the provider range ${lo === null ? "?" : qty(lo)}..${hi === null ? "?" : qty(hi)} ${u}` };
}

// ---------------------------------------------------------------------------
// 2) БАЛАНС ОПЛАТЫ. Не хватает того, чем платят, - подписывать нечего: транзакция откажет в кошельке,
// и человек узнает о нехватке ПОСЛЕ подписи. Неизвестный баланс (не прочитан) тоже запирает: см.
// рассуждение в шапке файла.
// ---------------------------------------------------------------------------
export function payBalanceVerdict({ payBalanceWei = null, payAmountWei = null, symbol = null, decimals = 18 } = {}) {
  const have = wei(payBalanceWei);
  const need = wei(payAmountWei);
  if (need === null || need <= 0n) {
    return { ok: false, checked: false, blocks: false, kind: "amount-unstated",
      reason: "the amount to fund is not known, so the wallet balance cannot be checked against it" };
  }
  if (have === null) {
    return { ok: false, checked: false, blocks: true, kind: "balance-unchecked",
      reason: "the wallet balance was not read, so it is unknown whether the wallet covers the order - signing is blocked" };
  }
  if (have < need) {
    return { ok: false, checked: true, blocks: true, kind: "balance-short",
      haveWei: have.toString(), needWei: need.toString(), shortfallWei: (need - have).toString(),
      reason: `the wallet holds ${human(have, decimals)} ${symbol} but the order locks ${human(need, decimals)} ${symbol} - short by ${human(need - have, decimals)} ${symbol}` };
  }
  return { ok: true, checked: true, blocks: false, kind: "balance-enough",
    haveWei: have.toString(), needWei: need.toString(),
    reason: `the wallet holds ${human(have, decimals)} ${symbol} for the order's ${human(need, decimals)} ${symbol}` };
}

// ---------------------------------------------------------------------------
// 3) ЗАПАС НА ГАЗ. Фондирование - транзакция, и она стоит газа в НАТИВНОЙ монете. Поэтому проверяется
// не только сумма ордера, но и сумма ордера ПЛЮС запас: у аккаунта, где лежит ровно amount, транзакция
// не пройдёт. Требуемое здесь считает вызывающий (amount + reserve), а не эта функция: одна величина
// вместо двух веток - меньше места для расхождения.
// Неизмеренный запас НЕ запирает: см. шапку файла (это отличие от проверки цены осознанное).
// ---------------------------------------------------------------------------
export function gasReserveVerdict({ nativeBalanceWei = null, requiredNativeWei = null, gasReserveWei = null, symbol = null, decimals = 18 } = {}) {
  const need = wei(requiredNativeWei);
  const reserve = wei(gasReserveWei);
  const have = wei(nativeBalanceWei);
  if (reserve === null || reserve <= 0n) {
    return { ok: true, checked: false, blocks: false, kind: "reserve-unstated",
      reason: "the gas reserve was not measured, so the gas part of the funding could not be checked (the wallet will name any shortfall)" };
  }
  if (need === null) {
    return { ok: false, checked: false, blocks: false, kind: "amount-unstated", reserveWei: reserve.toString(),
      reason: "the amount to fund is not known, so the native balance cannot be checked against amount + gas" };
  }
  if (have === null) {
    return { ok: false, checked: false, blocks: true, kind: "native-unchecked", needWei: need.toString(), reserveWei: reserve.toString(),
      reason: "the native balance was not read, so it is unknown whether the wallet covers amount + gas - signing is blocked" };
  }
  const total = need + reserve;
  if (have < total) {
    return { ok: false, checked: true, blocks: true, kind: "gas-short",
      haveWei: have.toString(), needWei: need.toString(), reserveWei: reserve.toString(), requiredTotalWei: total.toString(),
      shortfallWei: (total - have).toString(),
      reason: `funding needs ${human(need, decimals)} ${symbol} plus ${human(reserve, decimals)} ${symbol} of gas, but the wallet holds ${human(have, decimals)} ${symbol} - short by ${human(total - have, decimals)} ${symbol}` };
  }
  return { ok: true, checked: true, blocks: false, kind: "gas-enough",
    haveWei: have.toString(), needWei: need.toString(), reserveWei: reserve.toString(), requiredTotalWei: total.toString(),
    reason: `the wallet holds ${human(have, decimals)} ${symbol}: ${human(need, decimals)} for the order and ${human(reserve, decimals)} for gas` };
}

// ---------------------------------------------------------------------------
// 4) СВЕЖЕСТЬ КОТИРОВКИ. Правило продукта: просроченную (старше её собственного ttlMs) котировку не
// показывает никто, и подписать по ней нельзя - цена в ней уже не та, что человек видит. Метка
// считается по СВОЕЙ метке котировки (at), а не по времени ответа: иначе возраст "омолаживался" бы
// каждым опросом (док 41, §7).
// Нет метки или нет срока - проверить нечего; это помечается и не запирает (у рынка то же решение:
// "срок котировки провайдер не назвал" на экране, а не закрытие рынка).
// ---------------------------------------------------------------------------
export function quoteFreshnessVerdict({ at = null, ttlMs = null, expiresAt = null, nowMs = null } = {}) {
  const now = finite(nowMs) === null ? Date.now() : Number(nowMs);
  const exp = finite(expiresAt);
  if (exp !== null && exp <= now) {
    return { ok: false, checked: true, blocks: true, kind: "expired", expiresAt: exp, nowMs: now,
      reason: `the order quote expired ${Math.round((now - exp) / 1000)}s ago` };
  }
  const stamp = finite(at);
  if (stamp === null) {
    return { ok: false, checked: false, blocks: false, kind: "untimed",
      reason: "the quote carries no timestamp, so its age could not be checked" };
  }
  const ttl = finite(ttlMs);
  const ageMs = Math.max(0, now - stamp);
  if (ttl === null || ttl <= 0) {
    return { ok: true, checked: false, blocks: false, kind: "no-ttl", at: stamp, ageMs,
      reason: `the provider did not state how long the quote lives, so only its age is known: said ${Math.round(ageMs / 1000)}s ago` };
  }
  if (ageMs > ttl) {
    return { ok: false, checked: true, blocks: true, kind: "stale", at: stamp, ttlMs: ttl, ageMs,
      overMs: ageMs - ttl,
      reason: `the quote is ${Math.round(ageMs / 1000)}s old while it was valid for ${Math.round(ttl / 1000)}s - it expired ${Math.round((ageMs - ttl) / 1000)}s ago` };
  }
  return { ok: true, checked: true, blocks: false, kind: "fresh", at: stamp, ttlMs: ttl, ageMs,
    reason: `the quote is ${Math.round(ageMs / 1000)}s old and valid for ${Math.round(ttl / 1000)}s` };
}

// ---------------------------------------------------------------------------
// 5) СРОКИ ОРДЕРА (readyBy / t1). Срок в прошлом означает ордер, созданный уже закрытым: забрать по
// нему нельзя, деньги повиснут до возврата. Слишком тесные сроки означают то же самое, но незаметно:
// окно отметки готовности короче, чем занимает само подтверждение XMR, а окно расчёта короче, чем нужно
// мейкеру на забор. Слишком далёкий срок - третья крайность (issue #88): вернуть ETH можно только до
// `readyBy` и после `t1`, значит ордер с `t1` в году запирает деньги на год. Отсюда потолок.
// Пороги - данные (SIGNING_GUARDS).
// ---------------------------------------------------------------------------
export function deadlineVerdict({ nowSec = null, readyBy = null, t1 = null, minReadyLeadSec = null, minClaimWindowSec = null, maxDeadlineSec = null } = {}) {
  const now = finite(nowSec) === null ? Math.floor(Date.now() / 1000) : Number(nowSec);
  const r = finite(readyBy), c = finite(t1);
  if (r === null || c === null) {
    return { ok: false, checked: false, blocks: true, kind: "deadlines-unstated",
      reason: "the order's deadlines are not stated, so neither the ready window nor the claim window can be checked - signing is blocked" };
  }
  if (r <= now) {
    return { ok: false, checked: true, blocks: true, kind: "ready-by-in-past", readyBy: r, nowSec: now,
      reason: `the order would be created already past its ready-by deadline (${r} is ${Math.round(now - r)}s ago): nothing could be claimed in it` };
  }
  if (c <= r) {
    return { ok: false, checked: true, blocks: true, kind: "t1-not-after-ready-by", readyBy: r, t1: c,
      reason: `t1 (${c}) must be later than readyBy (${r}): an overlapping window lets claim and refund both be valid at once` };
  }
  const lead = finite(minReadyLeadSec), claim = finite(minClaimWindowSec);
  if (lead !== null && r - now < lead) {
    return { ok: false, checked: true, blocks: true, kind: "ready-window-too-short", readyBy: r, nowSec: now, minReadyLeadSec: lead,
      reason: `the ready-by deadline is only ${Math.round(r - now)}s away while the mark-ready window needs at least ${lead}s - XMR confirmations alone take minutes` };
  }
  if (claim !== null && c - r < claim) {
    return { ok: false, checked: true, blocks: true, kind: "claim-window-too-short", readyBy: r, t1: c, minClaimWindowSec: claim,
      reason: `the claim window is ${Math.round(c - r)}s while at least ${claim}s is needed to take the funds before the refund opens` };
  }
  // ПОТОЛОК СРОКА (issue #88). Без него срок можно поставить на год вперёд: обе стороны подпишут ордер,
  // ETH уйдут в эскроу - и вернуть их будет нельзя ни до `readyBy`, ни до `t1`, то есть целый год. Потолок
  // считается от `t1` (самого дальнего срока): `readyBy` всегда ближе, значит эта проверка покрывает оба.
  const cap = finite(maxDeadlineSec);
  if (cap !== null && c - now > cap) {
    return { ok: false, checked: true, blocks: true, kind: "deadline-too-far", readyBy: r, t1: c, nowSec: now, maxDeadlineSec: cap,
      reason: `the order's deadline is ${Math.round(c - now)}s (${Math.round((c - now) / 3600)}h) away while at most ${cap}s (${Math.round(cap / 3600)}h) is allowed: a deposit locked that long could not be refunded until t1` };
  }
  return { ok: true, checked: true, blocks: false, kind: "deadlines-ok", readyBy: r, t1: c, nowSec: now,
    reason: `ready in ${Math.round(r - now)}s, claim window ${Math.round(c - r)}s` };
}

// ---------------------------------------------------------------------------
// 6) СОСТОЯНИЕ ЭСКРОУ. Контракт запрещает второе внесение (AlreadyFunded) и не даёт забрать дважды,
// поэтому "подписаться ещё раз" в уже зафондированный, забранный или возвращённый эскроу - это не
// "на всякий случай проверим": вторая подпись либо откатится, либо создаст ВТОРОЙ ордер вместо
// прежнего. Читается вызовом status() по предсказанному адресу - до подписи.
// Отдельно про пустой ответ: по адресу, которого ещё нет, eth_call возвращает пусто - это "ордер
// новый", а не "проверить не удалось". Ошибка вызова - другое дело, и она запирает.
// ---------------------------------------------------------------------------
export function escrowStateVerdict({ status = null, error = null, address = null } = {}) {
  const where = address ? " the escrow at " + address : " the escrow";
  if (error) {
    return { ok: false, checked: false, blocks: true, kind: "state-unchecked", error: String(error),
      reason: `the state of${where} could not be read (${String(error)}), so it is unknown whether this order already exists - signing is blocked` };
  }
  if (!status) {
    return { ok: true, checked: true, blocks: false, kind: "new", address: address || null,
      reason: address ? `no escrow exists at ${address} yet: this is a new order` : "no escrow exists yet: this is a new order" };
  }
  if (status.isClaimed) {
    return { ok: false, checked: true, blocks: true, kind: "already-claimed", status, address: address || null,
      reason: `${where} is already claimed: the order is settled, a new signature would create a second order` };
  }
  if (status.isRefunded) {
    return { ok: false, checked: true, blocks: true, kind: "already-refunded", status, address: address || null,
      reason: `${where} was already refunded: the order is closed, a new signature would create a second order` };
  }
  if (status.isFunded) {
    return { ok: false, checked: true, blocks: true, kind: "already-funded", status, address: address || null,
      reason: `${where} is already funded: the contract refuses a second funding (AlreadyFunded) - top up that order instead of signing a new one` };
  }
  return { ok: true, checked: true, blocks: false, kind: "new", status, address: address || null,
    reason: `${where} exists but holds nothing: this is a new order` };
}

// ---------------------------------------------------------------------------
// 7) СОГЛАСИЕ НА ERC-20. Появится вместе с исполнением DEX-ноги: своп токена требует approve, и
// разрешение на списание - это ОТДЕЛЬНОЕ действие человека, а не следствие подписи свопа. Поэтому
// здесь две проверки, и обе обязательны: разрешение выдано (allowance хватает) И человек на него
// согласился явно. Достаток без согласия и согласие без достатка - разные отказы, и называются они
// по-разному.
// ПОТРЕБИТЕЛЬ У ЭТОЙ ЗАЩИТЫ УЖЕ ЕСТЬ (24 сентября 2026): сборщик исполнения DEX-ноги
// (www/js/evm/dexExec.js, swapAllowanceVerdict) зовёт её, чтобы отличить "разрешения не хватает" от
// "человек на него не согласился" - это РАЗНЫЕ отказы и называются они по-разному. В ПОДПИСЬ формы
// она по-прежнему не включена: форма ещё не свопает (своп - платный этап, док 48), и включать проверку
// в подпись раньше появления самого действия значило бы запирать человека на том, чего он ещё не делает.
// ---------------------------------------------------------------------------
export function allowanceVerdict({ tokenIsNative = false, allowanceWei = null, amountWei = null, consent = false, symbol = null, decimals = 18 } = {}) {
  if (tokenIsNative) {
    return { ok: true, checked: true, blocks: false, kind: "not-needed",
      reason: "the payment is the network's own coin: no ERC-20 approval and no pool are involved" };
  }
  const need = wei(amountWei), have = wei(allowanceWei);
  if (consent !== true) {
    return { ok: false, checked: false, blocks: true, kind: "consent-missing", needWei: need === null ? null : need.toString(),
      reason: `swapping ${symbol || "the token"} needs an ERC-20 approval for you to sign, and no consent was given for it` };
  }
  if (have === null) {
    return { ok: false, checked: false, blocks: true, kind: "allowance-unchecked",
      reason: `the existing allowance for ${symbol || "the token"} was not read, so it is unknown whether the approval is needed - signing is blocked` };
  }
  if (need === null || need <= 0n) {
    return { ok: false, checked: false, blocks: false, kind: "amount-unstated",
      reason: "the amount to swap is not known, so the allowance cannot be checked against it" };
  }
  if (have < need) {
    return { ok: false, checked: true, blocks: true, kind: "allowance-short",
      allowanceWei: have.toString(), needWei: need.toString(),
      reason: `the approved amount is ${human(have, decimals)} ${symbol || ""} but the swap spends ${human(need, decimals)} ${symbol || ""}: the approval must be raised first` };
  }
  return { ok: true, checked: true, blocks: false, kind: "allowed",
    allowanceWei: have.toString(), needWei: need.toString(),
    reason: `the approved amount ${human(have, decimals)} ${symbol || ""} covers the swap of ${human(need, decimals)} ${symbol || ""}` };
}

// ---------------------------------------------------------------------------
// 8) СЕТЬ КОШЕЛЬКА. Балансы читаются через кошелёк, то есть ИЗ ЕГО СЕТИ, и транзакция уйдёт туда же.
// Поэтому несовпадение сети - не предупреждение, а отказ: "страница на одной сети, кошелёк на другой"
// означает, что мы не знаем ни балансов, ни того, куда уйдут деньги. Признак сети кошелька берётся из
// session.js (chainIdOf), признак сети расчёта - из реестра (chainId выбранной сети).
// ---------------------------------------------------------------------------
export function networkGateVerdict({ walletChainId = null, selectedChainId = null, settlementChainId = null, selectedChainName = null } = {}) {
  const w = finite(walletChainId), s = finite(selectedChainId), set = finite(settlementChainId);
  if (w === null) {
    return { ok: false, checked: false, blocks: true, kind: "wallet-unknown",
      reason: "the wallet's network is unknown, so balances and the funding transaction have no network - signing is blocked" };
  }
  if (s === null) {
    return { ok: false, checked: false, blocks: true, kind: "network-unknown",
      reason: "the page's settlement network is unknown, so it cannot be compared with the wallet's - signing is blocked" };
  }
  if (w !== s) {
    return { ok: false, checked: true, blocks: true, kind: "wallet-network", walletChainId: w, selectedChainId: s,
      reason: `the wallet is on chain ${w} while this page settles on chain ${s}${selectedChainName ? " (" + selectedChainName + ")" : ""}: balances and the funding transaction would come from another network` };
  }
  if (set !== null && set !== s) {
    return { ok: false, checked: true, blocks: true, kind: "settlement-network", walletChainId: w, selectedChainId: s, settlementChainId: set,
      reason: `the escrow contract sits on chain ${set} while the page is set to chain ${s}: the money would go to a network where this order's escrow does not exist` };
  }
  return { ok: true, checked: true, blocks: false, kind: "network-match", chainId: s,
    reason: `the wallet and the page agree on chain ${s}${selectedChainName ? " (" + selectedChainName + ")" : ""}` };
}

// ---------------------------------------------------------------------------
// СВОДКА. Вызывающий собирает то, что у него есть, и получает ОДИН ответ: можно ли начинать подпись.
// Порядок проверок задаётся порядком массива: причина называется первая по списку, потому что при
// неверной сети вопрос о покрытии суммы уже не имеет смысла.
// ---------------------------------------------------------------------------
// ЖИВАЯ СЕТЬ НЕ ПОДПИСЫВАЕТ СДЕЛКУ С ЗАГЛУШКОЙ. В демке сторона контрагента собирается локально и помечена
// standIn: тогда DLEQ проверяется сам с собой и не доказывает ничего - это режим витрины, а не сделки.
// На живой сети такой подписи быть не должно: деньги ушли бы против несуществующей стороны.
export function counterpartyVerdict({ standIn = false, liveChain = false, network = null, chainId = null } = {}) {
  const v = (ok, kind, words) => ({ ok, checked: true, blocks: !ok, kind, words, reason: words });
  // СЕТЬ НАЗЫВАЕТСЯ ЧИСЛОМ И КОДОМ, а не словом «боевая»: по отказу должно быть видно, о какой сети речь
  // (у одной и той же ноды их может быть несколько), и это тот же стандарт, что у прочих отказов - причина
  // без числа считается дефектом, потому что по ней нельзя понять, что именно случилось.
  const where = (network || "this network") + (chainId === null || chainId === undefined ? "" : " (chainId " + chainId + ")");
  if (!standIn) return v(true, "real-provider", "counterparty is a real provider: the proof is checked against it");
  if (liveChain) {
    return v(false, "standin-on-production",
      `${where} is a live network and the counterparty is a local stand-in: the proof would be checked against itself, so the signature stays locked until a real provider answers`);
  }
  return v(true, "standin-on-testnet", `demo mode: the counterparty is a local stand-in and ${where} is a testnet (not a live network), the proof proves nothing by itself`);
}


// ---------------------------------------------------------------------------
// 9) ТОЧКИ ОРДЕРА В ЦЕПИ ПРОТИВ ТОЧЕК, НА КОТОРЫХ СОШЁЛСЯ DLEQ (находка P0-3 аудита).
// DLEQ доказывает связь точки с половиной, но сам по себе не мешает положить в ордер ДРУГИЕ точки:
// доказательство сойдётся на одних, а в createOrderAndFund уйдут другие - и после claim забор XMR
// не соберётся, потому что ключ траты выведен из других половин. Цепь этого не проверит (в EVM нет
// ed25519), поэтому проверяет та сторона, которая рискует, и ДО своего действия. Здесь только решается
// вопрос «заперта ли подпись»; сама сверка берёт точки ИЗ СЛОТОВ ЖИВОГО ЭСКРОУ, а не из памяти формы.
// ---------------------------------------------------------------------------
const normHex = (v) => (v === null || v === undefined ? "" : String(v).replace(/^0x/i, "").toLowerCase());
export function escrowPointsVerdict({ role = null, what = null, point = null, onchainPoint = null, commit = null, onchainCommit = null, readError = null } = {}) {
  const who = what || (role ? "the " + role + " point" : "the point");
  if (readError) {
    return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
      reason: `${who} of the live escrow could not be read (${String(readError)}): whether the order holds the points that DLEQ proved is unknown - signing is blocked` };
  }
  // ВЕТКА ВЫБИРАЕТСЯ ТЕМ, ЧТО ПРОСЯТ СВЕРИТЬ. Порядок проверок здесь - не косметика: если спрашивают про
  // обязательство, а проверять сначала точку, то на отсутствии ТОЧКИ вердикт скажет "точки не прочитаны",
  // и настоящая причина (обязательство не то) останется неназванной - это уже было поймано зубом.
  let compared = false;
  if (normHex(point)) {
    compared = true;
    if (!normHex(onchainPoint)) {
      return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
        reason: `the live escrow did not return ${who}: the order may hold different points than the proof proved - signing is blocked` };
    }
    if (normHex(point) !== normHex(onchainPoint)) {
      return { ok: false, checked: true, blocks: true, kind: "point-mismatch",
        reason: `${who} in the escrow (0x${normHex(onchainPoint)}) is NOT the point DLEQ proved (0x${normHex(point)}): the Monero address would be assembled from other halves and the XMR could not be swept after claim` };
    }
  }
  // ОБА ПОЛЯ СВЕРЯЮТСЯ НЕЗАВИСИМО. Ветка "иначе" здесь была ошибкой: при совпавшей точке расхождение
  // обязательства просто не проверялось, и подмена половины проходила мимо вердикта. Поймано зубом.
  if (normHex(commit)) {
    compared = true;
    if (!normHex(onchainCommit)) {
      return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
        reason: `the live escrow did not return ${who}: the order may hold a different half than we do - signing is blocked` };
    }
    if (normHex(commit) !== normHex(onchainCommit)) {
      return { ok: false, checked: true, blocks: true, kind: "commit-mismatch",
        reason: `${who} in the escrow (0x${normHex(onchainCommit)}) is NOT the one we hold (0x${normHex(commit)}): the reveal would not match the order` };
    }
  }
  if (!compared) {
    return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
      reason: `nothing to compare for ${who}: neither a point nor a commitment was recorded - signing is blocked` };
  }
  return { ok: true, checked: true, blocks: false, kind: "points-match",
    reason: `${who} in the escrow matches what we hold${normHex(point) && normHex(commit) ? " (point and commitment)" : ""}` };
}

// СЛОТЫ ЖИВОГО ОРДЕРА ПРОТИВ СОБРАННОГО СТРАНИЦЕЙ (блок C аудита). Один вопрос, четыре ответа: точки обеих
// сторон и обязательства на обе половины. Сверяется КАЖДОЕ поле, которое у нас есть, и отсутствие поля у
// цепи запирает так же, как несовпадение. Собрано из того же примитива, что и одиночная сверка точки
// (escrowPointsVerdict), чтобы формулировки отказов и правила сравнения были одни на всех.
export function liveOrderSlotsVerdict({ slots = null, expect = null, readError = null } = {}) {
  if (readError || !slots) {
    return { ok: false, checked: false, blocks: true, kind: "slots-unchecked",
      reason: `the live escrow slots could not be read (${String(readError || "no answer")}): whether the order holds the points and halves we assembled is unknown - signing is blocked` };
  }
  const fields = [
    ["edPointLocker", "the locker spend point", "point"],
    ["edPointClaimer", "the claimer spend point", "point"],
    ["edViewPointLocker", "the locker view point", "point"],
    ["commitHalfLocker", "the commitment of the locker half", "commit"],
    ["commitHalfClaimer", "the commitment of the claimer half", "commit"],
  ];
  const checked = [];
  const missing = [];
  for (const [key, what, kind] of fields) {
    if (!normHex(expect && expect[key])) continue;   // чего у нас нет, того и не сверяем - и это названо ниже
    if (!normHex(slots[key])) { missing.push(what); continue; }
    const v = kind === "point"
      ? escrowPointsVerdict({ what, point: expect[key], onchainPoint: slots[key] })
      : escrowPointsVerdict({ what, commit: expect[key], onchainCommit: slots[key] });
    if (v.blocks) return { ...v, fields: checked.concat([key]) };
    checked.push(key);
  }
  if (!checked.length) {
    return { ok: false, checked: false, blocks: true, kind: "slots-unchecked",
      reason: "nothing to compare: the app recorded neither a point nor a commitment for this order - signing is blocked" };
  }
  if (missing.length) {
    return { ok: false, checked: true, blocks: true, kind: "slots-unchecked",
      reason: `the live escrow did not return ${missing.join(", ")}: the order may differ from what was proved - signing is blocked` };
  }
  return { ok: true, checked: true, blocks: false, kind: "slots-match", fields: checked,
    reason: `the live escrow holds exactly what we assembled: ${checked.join(", ")}` };
}

export function signingGateVerdict(checks = []) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && typeof c === "object");
  const blocking = list.filter((c) => c.blocks === true);
  const unchecked = list.filter((c) => c.blocks !== true && c.checked === false);
  return {
    ok: blocking.length === 0,
    blocked: blocking.length > 0,
    kind: blocking.length ? blocking[0].kind : (list.length ? list[list.length - 1].kind : "nothing-to-check"),
    reason: blocking.length ? blocking.map((c) => c.reason).filter(Boolean).join("; ") : null,
    blockedBy: blocking.map((c) => c.kind),
    unchecked: unchecked.map((c) => c.kind),
    // САМО ПРОВЕРЕННОЕ ВОЗВРАЩАЕТСЯ ЦЕЛИКОМ: экран и отчёт обязаны называть не только вердикт, но и
    // из чего он взят, а числа там уже посчитаны.
    checks: list,
  };
}

// Слова для кнопки и подписи под ней. Одна фраза на вердикт - чтобы экран и отчёт говорили одно и то
// же: разойдясь, они начнут объяснять человеку одно, а оператору другое.
export function signingGateWords(gate) {
  if (!gate || !gate.blocked) return null;
  const first = (gate.checks || []).find((c) => c.blocks === true) || null;
  const why = first && first.reason ? first.reason : "the order cannot be checked";
  return "Signing is blocked: " + why + " (" + gate.kind + ")";
}
