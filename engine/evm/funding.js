// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/funding.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Фондирование ордера в контракте-эскроу: настоящие транзакции, а не имитация.
//
// Роли в этом потоке и почему так:
//   - ордер создаёт и ETH вносит тот, кого в условиях записали `locker` (контракт требует ровно его);
//   - забирает по секрету `claimer` - адрес задан в условиях, вызывающий на получателя не влияет;
//   - секрет на этом шаге генерируется ЗДЕСЬ и помечен как тестовый: в бою он рождается при трате XMR
//     (HTLC), и тогда эта же функция просто получит его снаружи. Больше ничего в форме менять не нужно.
//
// keccak256 передаётся зависимостью, как в www/js/monero/address.js: библиотеку ключей грузит тот,
// кто вызвал, а не этот модуль. Монеро и Ethereum используют один и тот же Keccak-256, поэтому хеш,
// посчитанный бандлом, совпадает с тем, что проверяет Solidity.

import { encodeCreateOrderAndFund, encodeCreateOrderAndFundByDepositor, encodePredict, decodeAddress, ORDER_CREATED_TOPIC } from "./factory.js";
// ВНОСЯЩИЙ ПО ПОДПИСИ (issue #97, части A/C): форма подписи вносящего - из одного места (evm/depositor.js),
// рядом с формой протокола. Заведя проверку формы здесь, мы получили бы вторую запись того же правила.
import { depositorSignatureShape } from "./depositor.js";
import { encodeStatus, decodeStatus } from "./escrow.js";
// КОМИССИЯ: ставка, величина и получатель - ЧАСТЬ ПОДПИСАННОЙ КОТИРОВКИ. У фабрики их больше нет (роутер
// удалён), поэтому величина берётся из котировки и сверяется зеркалом формулы. Без котировки фондировать
// нечем: фабрика принимает подписанный набор, а не голые условия ордера.
import { feeTermsFromQuote } from "./fees.js";
// ЗАЩИТЫ ПЕРЕД ПОДПИСЬЮ (док 45): сроки ордера и состояние эскроу - чистые функции, потому что проверять
// их на числах, которые их ЛОМАЮТ, можно только тогда, когда они не знают ни про сеть, ни про кошелёк.
import { deadlineVerdict, escrowStateVerdict } from "../core/preSignGuards.js";
import { SIGNING_GUARDS } from "../core/config.js";

const ATOMIC = 1_000_000_000_000_000_000n; // 1 ETH = 10^18 wei

// Тестовый секрет: 32 байта из криптографического генератора браузера.
export function newSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Условия ордера. Время - абсолютное (unix), как требует контракт.
//
// ПОСЫЛКИ ЗДЕСЬ БОЛЬШЕ НЕТ (док 27): вместо неё в ордер идут ОБА обязательства на половины и ОБЕ
// публичные точки ed25519. Функция ТРЕБУЕТ их и падает, если их нет, - и это осознанно: молча
// отправить ордер с отсутствующими полями значило бы создать эскроу, по которому нельзя ни забрать,
// ни доказать связь половины с адресом. Пусть лучше откажет здесь и громко.
//
// СРОКА ДВА, И ОНИ НЕ СОВПАДАЮТ: readyBy - до него внёсший отмечает готовность ("XMR вижу"), t1 - с
// него забор закрыт, а вернуть может кто угодно. Совпадение вернуло бы окно, где оба пути валидны
// одновременно, и спор решал бы газ (док 26).
export function testOrderTerms({ locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, amountWei, salt, claimWindowSeconds = 3600, readyWindowSeconds = 14400, readyBy, t1 }) {
  // ТОЧКА ПРОСМОТРА В СПИСКЕ ОБЯЗАТЕЛЬНЫХ: без неё адрес Monero не собрать из полей ордера, и узнал бы
  // об этом не тот, кто ошибся, а забирающий - уже после фондирования.
  for (const [k, v] of Object.entries({ commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker })) {
    if (!v) throw new Error("не задано условие ордера: " + k);
  }
  const now = Math.floor(Date.now() / 1000);
  // СРОКИ МОЖНО ЗАДАТЬ ГОТОВЫМИ, И ЭТО НЕ УДОБСТВО, А НЕОБХОДИМОСТЬ. Они входят в канонический контекст
  // ордера, к которому привязано доказательство, а доказательство считается ДО фондирования. Если сроки
  // считать здесь и сейчас, они окажутся посчитаны ПОСЛЕ, то есть доказательство будет привязано к одним
  // срокам, а в контракт уйдут другие. Поэтому вызывающий решает их заранее и передаёт сюда.
  const hasReady = readyBy !== undefined && readyBy !== null && readyBy !== "";
  const hasT1 = t1 !== undefined && t1 !== null && t1 !== "";
  const readyByValue = hasReady ? Number(readyBy) : now + readyWindowSeconds;
  // t1 - ОКНО ПОСЛЕ readyBy, а не "от сейчас" (issue #88): плоская формула при 4-часовом окне готовности
  // давала t1 раньше readyBy. Тот же смысл, что в sdk/src/swap-flow.mjs и rfq/reverseOrder.mjs.
  const t1Value = hasT1 ? Number(t1) : readyByValue + claimWindowSeconds;
  // ИНВАРИАНТ ОРДЕРА ПРОВЕРЯЕТСЯ ЗДЕСЬ: до readyBy отмечают готовность, с t1 забор закрыт. Совпадение или
  // перестановка дали бы окно, где оба пути валидны одновременно, и спор решал бы газ (док 26).
  if (!(t1Value > readyByValue)) throw new Error("срок расчёта должен быть позже срока готовности: t1=" + t1Value + ", readyBy=" + readyByValue);
  // СРОКИ ПРОВЕРЯЮТСЯ ЗДЕСЬ НЕ ТОЛЬКО НА "ПОЗЖЕ": ордер со сроком в прошлом или со слишком тесным окном -
  // это ордер, по которому нельзя ни отметить готовность, ни забрать, то есть деньги, повисшие до
  // возврата. Правило (и числа порогов) живёт в модуле защит (core/preSignGuards.js), здесь - отказ словами.
  const deadlines = deadlineVerdict({ nowSec: now, readyBy: readyByValue, t1: t1Value, ...SIGNING_GUARDS });
  if (deadlines.blocks) throw new Error("сроки ордера не годны: " + deadlines.reason);
  return {
    locker,
    claimer,
    commitHalfLocker,                           // обязательство половины внёсшего
    commitHalfClaimer,                          // обязательство половины забирающего
    edPointLocker,                              // P_a: по ней вторая сторона собирает общий адрес
    edPointClaimer,                             // P_b
    edViewPointLocker,                          // V_a: половина ПРОСМОТРА внёсшего (нужна для адреса Monero)
    amount: String(amountWei),
    // ОКНО ГОТОВНОСТИ - ЭТО ПРО MONERO, А НЕ ПРО EVM. Мейкер залочит XMR только после фондирования, и
    // отметить готовность осмысленно лишь тогда, когда XMR реально подтверждён: блоки Monero идут по
    // Пуассону, среднее до первого подтверждения около 2,5 минут, но один медленный блок легко даёт
    // 10-20. Плюс шаги самого мейкера: кошелёк, комиссия, отправка. На пятнадцати минутах хвост не
    // помещался, поэтому 30 - по замеру, а не «на всякий случай». Замеры и источники: док 26.
    readyBy: String(readyByValue),
    t1: String(t1Value),                        // граница расчёта: час по умолчанию
    // СОЛЬ ВХОДИТ В УСЛОВИЯ, А НЕ ДОБАВЛЯЕТСЯ К НИМ. Она определяет адрес эскроу (CREATE2), и predict
    // обязан считать адрес ПО ТЕМ ЖЕ полям, что уедут в создание. Раньше её добавляли только в вызов
    // создания, а predict шёл без соли - и падал на её проверке в кодировщике calldata. Принцип файла
    // («один источник полей») нарушался ровно на этом поле.
    salt,
  };
}

// Сумма в wei из человеческого значения (строка) и decimals токена.
export function toWei(human, decimals = 18) {
  const [intPart, fracPart = ""] = String(human).split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

// ГАЗ ВЫСТАВЛЯЕМ САМИ И С ЗАПАСОМ - ЭТО НЕ ПЕРЕСТРАХОВКА, А ЛЕЧЕНИЕ КОНКРЕТНОЙ ОШИБКИ.
// createOrder и lock уходят двумя транзакциями подряд. Кошелёк оценивает вторую в момент подписи, когда
// эскроу ещё НЕ создан, поэтому считает по пустому адресу обычный перевод: 21000 + стоимость данных. На
// живом контракте это дало лимит 24167 при реальной надобности 50294 - и lock упал по газу, хотя вызов
// был полностью верный (та же сумма, тот же отправитель, тот же адрес). Оценку кошелька здесь доверять
// нельзя, поэтому лимиты задаём явно, с запасом от измеренных значений.
const GAS_CREATE_ORDER = 1_200_000n;   // измерено 612567 - запас ~2x: создаётся целый контракт
// Создание И взнос в одной транзакции: создание контракта плюс запись взноса, запас намеренно большой -
// недобор лимита стоит человеку подписи, а лишний газ в лимите на Arbitrum почти ничего не стоит.
const GAS_CREATE_ORDER_AND_FUND = 1_500_000n;
// GAS_LOCK УБРАН вместе с вызовом lock(bytes): взнос идёт в той же транзакции, что и создание ордера.

// СОБЫТИЕ OrderCreated: topic0 посчитан по фактической подписи (и сверяется проверкой watchtower),
// topics = [topic0, escrow, locker, claimer]; в data - оба обязательства, обе точки, сумма, readyBy, t1, соль.
// ТЕМА СОБЫТИЯ БЕРЁТСЯ ИЗ ОДНОГО МЕСТА - из factory.js, а не заводится здесь второй копией.
// Здесь она УЖЕ БЫЛА второй копией, и это дало настоящий дефект: после смены состава полей OrderCreated
// копия осталась прежней, событие по ней не находилось, и адрес эскроу молча падал в предсказание - то
// есть проверка "адрес из квитанции" перестала работать, не сказав об этом ни слова.

// ФАКТИЧЕСКИЙ адрес эскроу из квитанции. Возвращает null, если события нет (транзакция не в блоке или
// фабрика другая) - тогда вызывающий код обязан сказать об этом вслух, а не подставить догадку.
export function escrowFromReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  for (const log of receipt.logs) {
    const topics = log.topics || [];
    if (String(topics[0]).toLowerCase() !== ORDER_CREATED_TOPIC) continue;
    if (topics.length < 2) continue;
    const addr = "0x" + String(topics[1]).slice(26).toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(addr) && !/^0x0{40}$/.test(addr)) return addr;
  }
  return null;
}

// Ждём квитанцию: сразу после подписи её ещё нет, и это нормально. Ждать бесконечно нельзя - говорим честно.
async function waitReceipt(receiptReader, hash, { tries = 12, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const r = await receiptReader({ hash }).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

// Полный путь фондирования. Шаги возвращаются наружу, чтобы интерфейс мог показать каждый:
// predict - бесплатный вызов, createOrder и lock - две транзакции в кошельке пользователя.
export async function fundOrder({ factory, locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, salt: providedSalt, amountWei, amountLabel, claimWindowSeconds, readyWindowSeconds, readyBy, t1, quote, depositorSignature = null, call, send, receipt, onStep }) {
  if (!factory) throw new Error("не задан адрес фабрики эскроу для этой сети");
  if (!locker) throw new Error("не подключён EVM-кошелёк: некому вносить средства");
  if (!claimer) throw new Error("не задан получатель ордера (claimer)");
  if (locker.toLowerCase() === claimer.toLowerCase()) {
    throw new Error("locker и claimer совпадать не могут: контракт такой ордер отклонит");
  }
  // ПОДПИСАННАЯ КОТИРОВКА ОБЯЗАТЕЛЬНА: она несёт комиссию, адрес реестра и провайдера, без которых ордер
  // создать нельзя. Раньше комиссию спрашивали у фабрики - теперь у неё спрашивать нечего; отсутствие
  // котировки - это НАЗВАННЫЙ отказ, а не молчаливое фондирование не той суммы.
  if (!quote || typeof quote !== "object") throw new Error("нужна подписанная котировка: фабрика принимает котировку, а не голые условия ордера");

  // ОБЯЗАТЕЛЬСТВА И ТОЧКИ ОБЯЗАТЕЛЬНЫ, и проверяются здесь, а не в глубине: без них ордер создастся, но
  // ни забрать по нему, ни доказать связь половины с Monero-адресом будет нельзя. Пусть падает громко.
  // Соль определяет адрес эскроу и обязана существовать ДО сборки условий: условия уходят и в predict.
  const salt = providedSalt || newSecret(); // соль CREATE2: детерминирует адрес эскроу
  const terms = testOrderTerms({
    locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker,
    amountWei, salt, claimWindowSeconds, readyWindowSeconds, readyBy, t1,
  });
  // СОЛЬ БЕРЁМ ИЗ СДЕЛКИ, ЕСЛИ ОНА ТАМ УЖЕ ЕСТЬ. Соль определяет адрес эскроу (CREATE2), поэтому при
  // повторном запуске фондирования новая соль создавала НОВЫЙ эскроу, а запись сделки оставалась с прежним
  // адресом - интерфейс, ссылка на обозреватель и экран прогресса показывали адрес, которого на цепи нет.
  // Побочная польза не меньше основной: повтор с той же солью попадает в ТОТ ЖЕ адрес и, если ордер уже
  // профинансирован, просто не проходит - вместо тихого создания второго эскроу.
  // Параметры здесь деструктурированы ПО ИМЕНАМ, поэтому обращаться к order нельзя: переменной order в
  // этой функции не существует. Первая редакция этой строки содержала order.salt - и фондирование падало
  // с "order is not defined", причём падало ПОСЛЕ моей же правки, которая спрятала причину в логе.
  // Локальную переменную назвал salt, входной параметр принят как providedSalt: иначе получилась бы
  // "мёртвая зона" const salt = salt || ... - обращение к себе до объявления.
  // 1) адрес эскроу виден ДО создания - это и есть смысл фабрики
  onStep?.("computing the escrow address");
  // ПОЛЯ ПРЕДСКАЗАНИЯ ОБЯЗАНЫ СОВПАДАТЬ С ПОЛЯМИ СОЗДАНИЯ БАЙТ В БАЙТ - адрес есть хеш кода создания.
  // Здесь это гарантируется тем, что и predict, и createOrderAndFund собираются из ОДНИХ И ТЕХ ЖЕ terms:
  // разойтись они могут только если править одно из двух мест врозь. Раньше расхождение уже случалось
  // (в предсказание не попадала посылка), и лечится оно не аккуратностью, а общим источником полей.
  // ПОЛЯ ВНОСИВШЕГО ЕДУТ ОТДЕЛЬНЫМИ АРГУМЕНТАМИ ФАБРИКИ (их нет в подписанном наборе).
  const quoteEnc = { ...quote, commitHalfLocker: terms.commitHalfLocker, edPointLocker: terms.edPointLocker, edViewPointLocker: terms.edViewPointLocker };
  // КОТИРОВКА И УСЛОВИЯ - ОБ ОДНОМ: расхождение уводит адрес эскроу и подписывает не тот ордер.
  for (const name of ["locker", "claimer", "amount", "readyBy", "t1", "salt"]) {
    if (String(quote[name]).toLowerCase() !== String(terms[name]).toLowerCase()) {
      throw new Error("котировка и условия ордера расходятся по полю " + name);
    }
  }
  const predictedRaw = await call({ to: factory, data: encodePredict(quoteEnc) });
  const escrow = decodeAddress(predictedRaw);
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrow) || /^0x0{40}$/i.test(escrow)) {
    throw new Error("фабрика вернула некорректный адрес эскроу: " + String(predictedRaw).slice(0, 40));
  }

  // 1б) СОСТОЯНИЕ ЭСКРОУ ПРОВЕРЯЕТСЯ ДО ПОДПИСИ, А НЕ ПОСЛЕ НЕЁ. Адрес уже известен (predict выше), и
  // если по нему лежит зафондированный, забранный или возвращённый ордер, подписывать нельзя: контракт
  // запрещает второе внесение (AlreadyFunded), а новая подпись (с новой солью) создала бы ВТОРОЙ ордер
  // вместо прежнего - деньги ушли бы в него, а не в тот, о котором человек думает (док 45).
  //
  // ПУСТОЙ ОТВЕТ - ЭТО "ОРДЕРА НЕТ", А НЕ "ПРОВЕРИТЬ НЕ УДАЛОСЬ": по адресу, которого ещё не существует,
  // eth_call возвращает пусто (так же это читается в sdk/src/swap-flow.mjs: orderDeadlines). А вот ОШИБКА
  // вызова - другое состояние, и она запирает: "не проверили" нельзя считать за "всё хорошо".
  onStep?.("checking the order is not already on chain");
  let stateRead = null;
  try {
    const raw = await call({ to: escrow, data: encodeStatus() });
    const body = String(raw || "").replace(/^0x/, "");
    // Ответ escrow обязан быть четырьмя словами status(): короче - значит по этому адресу нет контракта,
    // исполняющего status(), то есть ордера там нет и быть не может.
    stateRead = body.length >= 256 ? { status: decodeStatus(raw) } : { status: null };
  } catch (e) {
    stateRead = { error: String((e && e.message) || e) };
  }
  const escrowState = escrowStateVerdict({ status: stateRead.status, error: stateRead.error, address: escrow });
  if (escrowState.blocks) throw new Error("подпись не начата: " + escrowState.reason);

  // 2) ОДНА ТРАНЗАКЦИЯ: создание ордера ВМЕСТЕ с внесением денег.
  //
  // Было двумя шагами (createOrder, затем lock), и у этого было два дефекта, оба наблюдались живьём:
  // кошелёк оценивал газ второй транзакции, когда кода по адресу ещё не было (лимит выходил как для
  // обычного перевода ETH, и она падала), а отказ фондирования оставлял на цепи пустой контракт.
  // Теперь отказ откатывает ВМЕСТО с созданием, а подпись нужна одна. Locker в этой функции передать
  // нельзя - им становится отправитель, поэтому адрес возврата всегда принадлежит тому, кто заплатил.
  // СУММУ ПОКАЗЫВАЕМ В ETH, А НЕ В WEI, и берём её готовой строкой от вызывающего: форматирование
  // сумм в проекте живёт в одном месте (fmt.amount), а второй форматтер здесь разошёлся бы с ним.
  // Надпись короткая намеренно: она выводится НА КНОПКУ и обязана помещаться в одну строку.
  // КОМИССИЯ ВХОДИТ В VALUE, И ЭТО ГЛАВНОЕ СЛЕДСТВИЕ ЕЁ ВВЕДЕНИЯ. Контракт требует внести РОВНО
  // `amount + fee` (NinseiEscrow.sol: fund и payable-конструктор), поэтому фондирование на сумму ордера
  // отвергается - причём отвергается уже после подписи, потому что проверка живёт в контракте.
  // Сумма ордера (`amount` в условиях) НЕ меняется: ровно её получит забирающий, ровно она входит в слепок
  // условий. Комиссия прибавляется сверху и удержится при заборе; при возврате вернётся вместе с суммой.
  onStep?.("reading the escrow fee from the signed quote");
  // КОМИССИЮ БЕРЁМ ИЗ КОТИРОВКИ И СВЕРЯЕМ ЗЕРКАЛОМ. Направление уже учтено: покупка - amount + fee (сверху),
  // продажа - amount (комиссия вычтется из выплаты забирающему).
  const fee = feeTermsFromQuote(quote);
  const totalValueWei = fee.totalWei;
  const feeWords = fee.feeWei > 0n
    ? " (order " + amountWei + " + fee " + fee.feeWei + ")"
    : "";
  onStep?.("locking " + (amountLabel || "funds") + feeWords + " in one transaction - confirm in wallet");
  // КАКОЙ ДВЕРЬЮ ФАБРИКИ ИДЁТ ВНЕСЕНИЕ, И ЭТО НЕ УКРАШЕНИЕ. Подпись вносящего есть - вносим путём части A:
  // `createOrderAndFundByDepositor` восстанавливает вносившего ИЗ ПОДПИСИ над дайджестом котировки, поэтому
  // транзакцию вправе отправить кто угодно (релейщик, наш сервис), а роль `locker` (право вернуть, право
  // отметить готовность) остаётся у подписавшего. Подписи нет - прежний `createOrderAndFund`: вносит и
  // отправляет один и тот же кошелёк, прямой обмен работает ровно как раньше. Менять условия ордера
  // отправителю нельзя ни на одном пути - обе подписи покрывают ОДИН И ТОТ ЖЕ дайджест котировки.
  if (depositorSignature !== null && depositorSignature !== undefined && depositorSignature !== "") {
    const shape = depositorSignatureShape(depositorSignature);
    if (!shape.ok) throw new Error("подпись вносящего негодна: " + shape.reason);
  }
  const relayedByDepositor = Boolean(depositorSignature);
  const createData = relayedByDepositor
    ? encodeCreateOrderAndFundByDepositor(quoteEnc, depositorSignature)
    : encodeCreateOrderAndFund(quoteEnc);
  const createHash = await send({
    to: factory,
    data: createData,
    value: "0x" + totalValueWei.toString(16),
    gas: GAS_CREATE_ORDER_AND_FUND,
  });

  // 2б) АДРЕС ЭСКРОУ БЕРЁМ ИЗ КВИТАНЦИИ, А НЕ ИЗ ПРЕДСКАЗАНИЯ. Предсказание верно только пока совпадают
  // соль и код фабрики: повторный запуск фондирования создаёт эскроу по новому адресу, а запись сделки
  // осталась бы со старым - и сделка выглядела бы сломанной (сроки не читаются, кнопки возврата нет).
  // Ровно это и произошло. Расхождение с предсказанием называем вслух: это признак настоящей ошибки.
  let actualEscrow = null;
  // БЛОК СОЗДАНИЯ ЭСКРОУ - это высота, с которой сделка существует в цепи, и единственный НЕЗАВИСИМЫЙ
  // от ноды Monero источник высоты для файла восстановления. Объявлен снаружи ветки намеренно: внутри
  // блока объявленная переменная снаружи не видна, а возвращать её надо всегда.
  let birthBlock = null;
  if (typeof receipt === "function") {
    const rc = await waitReceipt(receipt, createHash);
    actualEscrow = escrowFromReceipt(rc);
    if (rc && Number.isFinite(Number(rc.blockNumber))) birthBlock = Number(rc.blockNumber);
    if (!rc) {
      onStep?.("no receipt yet - using the predicted address");
    } else if (!actualEscrow) {
      onStep?.("no OrderCreated in the receipt - using the predicted address");
    } else if (actualEscrow !== String(escrow).toLowerCase()) {
      console.warn("[escrow] receipt address " + actualEscrow + " != predicted " + escrow + " - using the receipt one");
      onStep?.("receipt address differs from predicted - using the receipt one");
    }
  }
  const escrowToUse = actualEscrow || escrow;

  // 3) ВТОРОЙ ТРАНЗАКЦИИ БОЛЬШЕ НЕТ: деньги уехали вместе с созданием ордера. Имя lockHash сохраняем
  // намеренно - на него смотрят вызывающие, и переименование задело бы их без пользы.
  // ДОКЛАДКИ НЕТ И НЕ БУДЕТ: отдельной функции внесения у эскроу нет, и добавление её означало бы возврат
  // пути «создать пустым, внести вторым вызовом» - того самого, которым деньги запирались в закрытом
  // ордере. Если ордер не зафондирован, это видно по receipt: создания ордера без денег не бывает.
  const lockHash = createHash;

  // escrow - ФАКТИЧЕСКИЙ адрес (из квитанции, если она была); predictedEscrow оставляем, чтобы расхождение
  // было видно снаружи, а не только в логе.
  // КОМИССИЯ НАРУЖУ: она ушла в транзакцию, и запись сделки обязана её сохранить - иначе по записи нельзя
  // будет посчитать, сколько человек внёс, и это разойдётся с тем, что видно в цепи.
  return { feeWei: fee.feeWei, feeTotalWei: totalValueWei, feeBps: fee.bps, feeWasLegacyFactory: Boolean(fee.legacy),
           // КАКОЙ ПУТЬ ФАБРИКИ СРАБОТАЛ: видно снаружи, а не только по calldata в кошельке. По нему
           // проверка и запись сделки понимают, будет ли ETH возвращаться подписавшему, а не отправителю.
           depositorPath: relayedByDepositor,
           escrow: escrowToUse, predictedEscrow: escrow, escrowMismatch: Boolean(actualEscrow && actualEscrow !== String(escrow).toLowerCase()), salt, birthBlock, terms, createHash, lockHash };
}
