// GENERATED FILE - a byte-for-byte copy of the engine module www/js/recovery/recoveryFile.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Recovery-файл сделки: реальная криптография в браузере (WebCrypto).
//
// Litepaper §5: без сохранённого recovery-файла сделка не фондируется; если вкладка
// потеряна, этот файл - единственный способ забрать XMR или вернуть ETH (в том числе
// через standalone-клиент без сайта). Поэтому здесь настоящий AES-GCM, а не заглушка:
// файл можно расшифровать только паролем, который знает пользователь.
//
// Формат файла (Arrakis-swap-<id>.json.enc):
//   { v:2, alg:"AES-GCM-256/PBKDF2-SHA256", iter, salt, iv, ciphertext, meta:{id,side,createdAt} }
// Внутри ciphertext - payload (см. buildPayload), и его формат версионирован отдельно:
// версия оболочки (v) и версия payload (version) меняются независимо - шифрование и
// содержимое сделки это разные вещи.
//
// ЧТО ЛЕЖИТ В PAYLOAD И ПОЧЕМУ ИМЕННО ЭТО
// v3: МОЯ ПОЛОВИНА ключа траты и МОЯ ПОЛОВИНА ключа просмотра (spendHalf, viewHalf) плюс ПУБЛИЧНЫЕ точки
//   контрагента (otherSpendPoint, otherViewPoint). Полного ключа траты не существует НИ У КОГО: адрес
//   собран как сумма половин, и потратить может только тот, у кого окажутся обе. Вторую даёт цепь -
//   поэтому в файле лежит ещё и адрес эскроу: из него метание прочитает раскрытую половину.
//   Точки контрагента публичны (они и так в адресе и в ордере), но без них адрес из половин не собрать.
// v2: mnemonic - единственный источник ключей: и ключ траты, и view key выводятся из
//   него. Ключи в payload НЕ дублируются: копия секрета в файле - это
//   лишний способ его потерять и лишний повод рассинхронизировать поля
//   (раньше в файле лежали и seedHex, и оба приватных ключа).
//   publicSpendKey /
//   publicViewKey /
//   address           - для проверки: если из мнемоники выводится другой адрес, файл повреждён
//                       или подменён, и восстанавливать по нему кошелёк нельзя.
//   restoreHeight     - высота, с которой начинать скан. Без неё кошелёк сканирует историю
//                       Monero с нуля, а это десятки часов (замерено: ~35 блоков/с). Высота
//                       создания сделки - корректный пол: лок XMR случится не раньше.
//
// ЧЕГО В ФАЙЛЕ НЕТ: ключа траты в открытом виде (только внутри шифротекста), номера карты,
// адреса вывода и вообще ничего, что не нужно для завершения или отката сделки.
//
// ВИДА КОТИРОВКИ В PAYLOAD НЕТ, и НАБОР КЛЮЧЕЙ payload не проверяется: файл, выпущенный раньше, с лишним
// ключом вида читается по-прежнему (лишний ключ просто остаётся непрочитанным), а новый выпускается без него.
// Формат от этого не меняется: PAYLOAD_VERSION остаётся 3 - вид котировки к версии файла отношения не имел.

// ПАРАМЕТРЫ ШИФРОВАНИЯ НАЗВАНЫ ЯВНО И НЕ БЕРУТСЯ ИЗ УМОЛЧАНИЙ WEB-CRYPTO.
// Длина тега и длина ключа - часть ФОРМАТА, а не деталь реализации: файл, выпущенный сегодня, обязан
// читаться через годы, поэтому оба числа стоят в каждом вызове (encrypt/decrypt/deriveKey), лежат в
// замороженных объектах и подтверждены ЗАМЕРОМ в tools/check-recovery.mjs: длина тега (шифротекст минус
// открытый текст = 16 байт) и длина выведенного ключа (256 бит - доказано расшифровкой данным ключом,
// выведенным отдельно как 256 бит). Число итераций PBKDF2 - тоже часть формата, но оно ОСОЗНАННО
// изменяемо: растёт со временем, и тогда старые файлы читаются по своему числу (см. ITER_MIN ниже).
//
// ЧИСЛО ИТЕРАЦИЙ: 600 000 - РЕКОМЕНДАЦИЯ OWASP ДЛЯ PBKDF2-HMAC-SHA256.
// Источник: OWASP Password Storage Cheat Sheet, раздел PBKDF2 - «PBKDF2-HMAC-SHA256: 600,000 iterations
// (recommended)»; там же: при требовании FIPS-140 брать PBKDF2 с «work factor of 600,000 or more» и
// внутренним HMAC-SHA-256, а сами числа получены замерами на GPU RTX 4000 (на декабрь 2022).
// ПОЧЕМУ PBKDF2, А НЕ Argon2id/scrypt, КОТОРЫЕ OWASP СТАВИТ ВЫШЕ: в браузере доступно только то, что даёт
// WebCrypto, а в нём из password-hashing есть ОДИН PBKDF2 - Argon2id и scrypt в стандарт не входят. Выбирать
// не из чего, поэтому важна хотя бы верная для PBKDF2 цифра.
// ПОЧЕМУ 210 000 БЫЛО НЕВЕРНО: это число стоит в таблице OWASP для PBKDF2-HMAC-SHA512 (220 000), а у нас
// HMAC-SHA256 - то есть счёт был втрое ниже рекомендации для нашего же алгоритма.
// ЧЕГО ЭТО НЕ ДАЁТ, ЧТОБЫ НЕ ОБМАНЫВАТЬСЯ: итерации поднимают цену ОДНОЙ догадки (замер на машине
// разработки: 210k - 109 мс, 600k - 283 мс; на слабом устройстве в браузере заметно больше), но не
// спасают от слабого пароля: офлайн-перебор упирается в ЭНТРОПИЮ пароля, а не в счёт. Минимум в 12 знаков
// остаётся слабым местом - записано в .hermes/docs/10-recovery-file.md.
const ITER = 600_000;
// ПОЛ ДЛЯ ЧУЖИХ ФАЙЛОВ. Число итераций приходит ИЗ ФАЙЛА (иначе нельзя поднять его, не потеряв старые
// файлы), поэтому слабое значение обязано упереться в отказ: файл с числом ниже пола не расшифровываем.
const ITER_MIN = 100_000;
const ITER_MAX = 10_000_000;
// Идентификатор алгоритма - ОДНА строка на весь модуль: раньше он был вписан дважды (запись и чтение),
// и расхождение между копиями выяснилось бы только на живом файле.
const ALG_ID = "AES-GCM-256/PBKDF2-SHA256";
const AES = Object.freeze({ name: "AES-GCM", tagLength: 128, keyBits: 256 });
const KDF = Object.freeze({ name: "PBKDF2", hash: "SHA-256" });
const te = new TextEncoder();
const td = new TextDecoder();

export const FILE_MAGIC = "ARRAKIS-SWAP-RECOVERY";

// Версия оболочки (шифрование) и версия полезной нагрузки (состав сделки) - разные числа.
// ВЕРСИЯ КОНВЕРТА: 1 - без AAD (все файлы, выпущенные до 28.09.2026), 2 - заголовок аутентифицирован (AAD).
// Читать обязаны ОБЕ: у людей на руках файлы версии 1, и потерять их нельзя. Версия поднимается, когда
// меняется САМ КОНВЕРТ, а не полезная нагрузка внутри.
export const ENVELOPE_VERSION = 2;
const READABLE_ENVELOPE_VERSIONS = [1, 2];
export const PAYLOAD_VERSION = 3;
// v1 - самые первые файлы (seedHex и оба ключа отдельными полями), v2 - мнемоника как единственный
// источник, v3 - ПОЛОВИНЫ. Читать обязаны все три: у людей на руках есть файлы всех версий, и файл
// восстановления - единственный способ забрать свои XMR. Выбрасывать старые версии нельзя.
const SUPPORTED_PAYLOAD_VERSIONS = [1, 2, 3];
// СЕТИ, КОТОРЫЕ ЧИТАТЕЛЬ ФАЙЛА ЗНАЕТ. Три стандартные плюс fakechain - официальное имя regtest-режима
// monerod: нода контура CI называет себя именно так, и файл, выпущенный на такой сети, обязан читаться.
// Список поимённый: сеть вне него отвергается как неизвестная, и это остаётся в силе.
const NETWORKS = ["mainnet", "stagenet", "testnet", "fakechain"];

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// ЧИСЛО ИТЕРАЦИЙ - ПАРАМЕТР, А НЕ КОНСТАНТА ВЫЗОВА. При шифровании это ITER, при чтении - число ИЗ
// ФАЙЛА: формат его хранит именно для того, чтобы счёт можно было поднять, не потеряв уже выпущенные
// файлы. Прежде чтение брало константу и поле iter не читало вовсе - то есть повышение счёта сломало бы
// все старые файлы молча, а само поле в файле было бы украшением.
// AAD: ПОД АУТЕНТИФИКАЦИЕЙ ЗАГОЛОВОК, А НЕ ТОЛЬКО ШИФРОТЕКСТ. AES-GCM проверяет целостность того, что
// передано ему как additionalData. Без AAD (так было в версии 1) под проверкой был ТОЛЬКО шифротекст, а
// `meta` - идентификатор сделки, сторона, время, хеш условий - лежит рядом и правился бы без следа, и
// читатель взял бы подменённое. Строку собирают и писатель, и читатель ИЗ ОДНИХ ПОЛЕЙ В ОДНОМ ПОРЯДКЕ:
// правка любого поля меняет строку, и расшифровка отвергается.
// ПОЧЕМУ МАССИВ, А НЕ ОБЪЕКТ: порядок ключей в объекте - деталь реализации JSON, и «одинаковый» объект
// может дать разный текст. И почему ?? null: отсутствующее поле в массиве дало бы undefined, а это уже
// другое значение.
// ЭКСПОРТИРУЕТСЯ НАРОЧНО: строка - часть ФОРМАТА, и проверки обязаны собирать её тем же кодом, а не
// собственной копией (копия разошлась бы с форматом ровно там, где это дороже всего).
export function envelopeAad(envelope) {
  const m = envelope.meta || {};
  return JSON.stringify([
    envelope.v, envelope.alg, envelope.iter, envelope.salt, envelope.iv,
    m.id ?? null, m.side ?? null, m.createdAt ?? null, m.termsHash ?? null,
  ]);
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase), KDF.name, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: KDF.name, salt, iterations, hash: KDF.hash },
    base,
    { name: AES.name, length: AES.keyBits },
    false,
    ["encrypt", "decrypt"]
  );
}

// ВЫСОТА, С КОТОРОЙ НАЧИНАТЬ СКАН ПРИ ВОССТАНОВЛЕНИИ. Чистая функция: никуда не ходит, поэтому её
// проверяют без ноды - и это важно, потому что именно здесь раньше и терялась высота.
//
// ПОЧЕМУ ИСТОЧНИКОВ ДВА. Высоту брали ТОЛЬКО у ноды Monero, и когда нода не ответила, в файл честно
// ложился null. Восстановление после этого сканировало историю с нуля (десятки часов), хотя точная
// высота сделки уже была на руках: эскроу заводится транзакцией, и её блок лежит в квитанции. Нода -
// чужая служба, которая может лежать (боевой прокси отдавал 502), а сделка - своя и уже есть.
//
// БЕРЁМ МЕНЬШУЮ И ОТСТУПАЕМ НА БЛОК. Поступление XMR может лечь блоком раньше записанной высоты
// (на живом прогоне транзакция оказалась в 2206634 при высоте 2206635), а скан, начавшийся ниже денег,
// их находит; начавшийся выше - не находит никогда. Поэтому Math.min и минус один, но не ниже единицы.
// ТРЕТИЙ ИСТОЧНИК - ПРИЛОЖЕНИЕ. В записях прежних сделок поля birthHeight нет (оно появилось позже), но
// высоту при регистрации наблюдения приложение разрешило само и хранит; страница забирает её у своего
// сервера. Это НАШ источник, поэтому он не зависит от того, отвечает ли сейчас нода Monero, и именно он
// спасает уже выпущенные файлы: у них в записи высоты нет вовсе.
export function scanStartHeight({ escrowBirthHeight = null, serverRestoreHeight = null, nodeHeight = null } = {}) {
  const known = [escrowBirthHeight, serverRestoreHeight, nodeHeight]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (known.length === 0) return null;
  return Math.max(1, Math.min(...known) - 1);
}

// Полезная нагрузка: всё, что нужно, чтобы завершить или откатить сделку без сайта.
// restoreHeight передаёт вызывающий - сюда его кладёт scanStartHeight выше, а модуль не
// ходит в сеть сам, чтобы его можно было тестировать без ноды.
export function buildPayload({ swap, swapWallet, escrow, receiveAddress, restoreHeight = null }) {
  return {
    magic: FILE_MAGIC,
    // ВЕРСИЯ ОТРАЖАЕТ СОСТАВ, А НЕ ВЕРСИЮ МОДУЛЯ. Раньше здесь стоял PAYLOAD_VERSION, и после появления
    // половин файл, собранный из мнемоники, получал номер 3 - то есть заявлял состав, которого в нём нет,
    // и проверка справедливо его отвергала. Номер должен говорить правду о содержимом: у файла с половин
    // тройка, у файла с мнемоникой двойка.
    version: swapWallet && swapWallet.spendHalf ? 3 : 2,
    swapId: swap.id,
    // Хеш условий ордера с КОНТРАКТА (keccak256(locker, claimer, hashlock, amount, t0, t1, адрес эскроу, chainid)).
    // Он и есть привязка файла к цепи: зная условия, можно проверить, что файл относится именно к этому ордеру.
    // Поле НЕОБЯЗАТЕЛЬНОЕ: у файлов, выпущенных раньше, его нет, и читаться они должны по-прежнему.
    termsHash: (swap.escrow && swap.escrow.termsHash) || null,
    side: swap.side,
    network: swap.network,
    moneroNetwork: swap.moneroNetwork,
    createdAt: swap.createdAt,
    pay: { token: swap.payToken, amount: swap.payAmount },
    receive: { token: "XMR", amount: swap.xmrAmount, address: receiveAddress },
    rate: swap.rate,
    maker: swap.maker,
    quote: { signature: swap.quoteSignature, nonce: swap.quoteSignature ? swap.quoteSignature.slice(-8) : null },
    escrow: escrow || swap.escrow || null,
    // v3 (половины) и v2 (мнемоника) - разные составы, и они несовместимы: в v3 мнемоники НЕТ,
    // потому что полного ключа траты не существует. Что писать - решает источник кошелька.
    moneroWallet: swapWallet
      ? swapWallet.spendHalf
        ? {
            source: "halves",
            library: swapWallet.library || null,
            network: swapWallet.network,
            address: swapWallet.address,
            subaddress: swapWallet.subaddress || null,
            spendHalf: swapWallet.spendHalf,
            viewHalf: swapWallet.viewHalf,
            otherSpendPoint: swapWallet.otherSpendPoint,
            otherViewPoint: swapWallet.otherViewPoint,
            // ПОЛОВИНА ПРОСМОТРА КОНТРАГЕНТА - и это не секрет. Полный ключ ПРОСМОТРА (сумма двух половин)
            // позволяет ВИДЕТЬ входящие и не позволяет их потратить; трата требует суммы половин ТРАТЫ.
            // Без чужой половины просмотра кошелёк не сможет найти наши XMR в цепи: половины траты для
            // скана недостаточно, ключи просмотра и траты в Monero независимы.
            otherViewHalf: swapWallet.otherViewHalf || null,
            escrowAddress: (escrow && escrow.address) || (swap.escrow && swap.escrow.address) || null,
            restoreHeight: Number.isFinite(restoreHeight) ? restoreHeight : null,
          }
        : {
            source: swapWallet.source,
            library: swapWallet.library || null,
            network: swapWallet.network,
            address: swapWallet.address,
            subaddress: swapWallet.subaddress || null,
            mnemonic: swapWallet.mnemonic || null,
            publicSpendKey: swapWallet.publicSpendKey,
            publicViewKey: swapWallet.publicViewKey,
            restoreHeight: Number.isFinite(restoreHeight) ? restoreHeight : null,
          }
      : null,
    deadlines: swap.timeline,
    recoveryClient: "any standalone client implementing the Arrakis swap protocol (see litepaper §5.3)",
  };
}

// Проверка payload ПОСЛЕ расшифровки. Отдельная функция, потому что расшифровать можно и
// мусор (пароль подошёл, а внутри не то), и потому что тесты должны бить по каждому полю
// отдельно. Бросает с понятной причиной, а не падает в глубине восстановления кошелька.
// Секреты в тексте ошибок не появляются: мнемоника - это ключ траты.
export function validatePayload(payload) {
  const fail = (m) => {
    throw new Error("Повреждённый recovery-файл: " + m);
  };
  if (!payload || typeof payload !== "object") fail("внутри не объект");
  if (payload.magic !== FILE_MAGIC) fail("чужой файл (нет метки Arrakis)");
  if (!SUPPORTED_PAYLOAD_VERSIONS.includes(payload.version)) {
    fail(`версия данных ${payload.version} не поддерживается (умеем ${SUPPORTED_PAYLOAD_VERSIONS.join(", ")})`);
  }
  if (!payload.swapId) fail("нет идентификатора сделки");
  const m = payload.moneroWallet;
  if (!m || typeof m !== "object") fail("нет данных кошелька Monero");
  if (payload.version >= 3) {
    // ПОЛОВИНЫ. Мнемоники здесь нет и быть не должно: полного ключа траты не существует ни у одной
    // стороны, и файл, в котором он вдруг окажется, означает, что кошелёк собран не по схеме.
    for (const field of ["spendHalf", "viewHalf", "otherSpendPoint", "otherViewPoint", "otherViewHalf"]) {
      if (!m[field]) fail("в файле половин нет поля " + field);
    }
    if (m.mnemonic) fail("файл половин содержит мнемонику - кошелёк собран не по схеме");
  } else {
    if (!m.mnemonic) fail("нет мнемоники - восстановить кошелёк нечем");
    const words = String(m.mnemonic).trim().split(/\s+/).length;
    if (words !== 25 && words !== 13 && words !== 24) fail(`мнемоника не похожа на Monero-фразу (слов: ${words})`);
  }
  if (!m.address) fail("нет адреса кошелька - не с чем сверять восстановленный");
  const net = m.network || payload.moneroNetwork;
  if (!NETWORKS.includes(net)) fail(`неизвестная сеть "${net}"`);
  if (m.network && payload.moneroNetwork && m.network !== payload.moneroNetwork) {
    fail(`сеть кошелька (${m.network}) не совпадает с сетью сделки (${payload.moneroNetwork})`);
  }

  const warnings = [];
  if (!Number.isFinite(m.restoreHeight) || m.restoreHeight <= 0) {
    warnings.push(
      "нет высоты восстановления (restoreHeight): кошелёк будет сканировать историю с нуля, " +
        "а это десятки часов - укажи высоту лока XMR вручную"
    );
  }
  if (payload.version === 1) {
    warnings.push("файл старого формата (v1): ключи в нём лежали отдельными полями, ключ траты берём из мнемоники");
  }
  return { warnings };
}

export async function encryptPayload(payload, passphrase) {
  if (!passphrase || passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITER);
  // Заголовок собирается ДО шифрования: он же служит AAD, то есть шифротекст привязан к его содержимому.
  const meta = { id: payload.swapId, side: payload.side, createdAt: payload.createdAt, termsHash: payload.termsHash || null };
  const header = { v: ENVELOPE_VERSION, alg: ALG_ID, iter: ITER, salt: b64(salt), iv: b64(iv) };
  const ct = await crypto.subtle.encrypt(
    { name: AES.name, iv, tagLength: AES.tagLength, additionalData: te.encode(envelopeAad({ ...header, meta })) },
    key,
    te.encode(JSON.stringify(payload, bigintSafe))
  );
  return { ...header, ciphertext: b64(ct), meta };
}

// Расшифровка. Ошибки AES-GCM (неверный пароль, изменённый шифротекст) приходят как
// OperationError без деталей - переводим в человеческое сообщение, иначе пользователь
// видит «operation failed» и не понимает, пароль не тот или файл битый.
export async function decryptFile(fileObject, passphrase) {
  if (!fileObject || typeof fileObject !== "object") throw new Error("Not a recovery file (expecting JSON)");
  if (!READABLE_ENVELOPE_VERSIONS.includes(fileObject.v)) throw new Error(`Unsupported recovery file version: ${fileObject.v}`);
  if (fileObject.alg !== ALG_ID) throw new Error(`Unknown algorithm: ${fileObject.alg}`);
  for (const field of ["salt", "iv", "ciphertext"]) {
    if (typeof fileObject[field] !== "string" || !fileObject[field]) throw new Error(`Recovery file is missing "${field}"`);
  }
  // ЧИСЛО ИТЕРАЦИЙ ЧИТАЕТСЯ ИЗ ФАЙЛА И ПРОВЕРЯЕТСЯ. Ниже пола - отказ: слабый счёт не должен приводить
  // к тихой расшифровке. Выше потолка - тоже отказ: это уже не файл, а попытка занять процессор.
  const iter = Number(fileObject.iter);
  if (!Number.isInteger(iter) || iter < ITER_MIN) {
    throw new Error(`Recovery file declares too few PBKDF2 iterations: ${fileObject.iter} (minimum ${ITER_MIN})`);
  }
  if (iter > ITER_MAX) {
    throw new Error(`Recovery file declares too many PBKDF2 iterations: ${iter} (maximum ${ITER_MAX})`);
  }
  const salt = unb64(fileObject.salt);
  const iv = unb64(fileObject.iv);
  const key = await deriveKey(passphrase, salt, iter);
  // AAD ПОДМЕШИВАЕТСЯ ТОЛЬКО НАЧИНАЯ С ВЕРСИИ 2. Файлу версии 1 её подставить нельзя: он шифровался без
  // AAD, и с ней не расшифровался бы ни у кого - то есть «улучшение» обнулило бы все старые файлы.
  const additionalData = fileObject.v >= 2 ? te.encode(envelopeAad(fileObject)) : undefined;
  const decryptAlg = additionalData
    ? { name: AES.name, iv, tagLength: AES.tagLength, additionalData }
    : { name: AES.name, iv, tagLength: AES.tagLength };
  let pt;
  try {
    pt = await crypto.subtle.decrypt(decryptAlg, key, unb64(fileObject.ciphertext));
  } catch {
    throw new Error("Не удалось расшифровать файл: неверный пароль или файл изменён");
  }
  let payload;
  try {
    payload = JSON.parse(td.decode(pt));
  } catch {
    throw new Error("Расшифровалось, но внутри не JSON - файл повреждён");
  }
  validatePayload(payload);
  // У ВЕРСИИ 1 ЗАГОЛОВОК НЕ АУТЕНТИФИЦИРОВАН, ПОЭТОМУ СВЕРЯЕМ ЕГО С СОДЕРЖИМЫМ. Подменить meta у старого
  // файла можно (AAD там нет), но разойтись с данными внутри шифротекста ему не дадут: идентификатор
  // сделки обязан совпасть. Для версии 2 это уже избыточно - её проверяет AAD.
  if (fileObject.meta && fileObject.meta.id != null && payload.swapId != null &&
      String(fileObject.meta.id) !== String(payload.swapId)) {
    throw new Error("Идентификатор сделки в заголовке не совпал с содержимым файла: файл изменён");
  }
  return payload;
}

// BigInt В JSON НЕ СЕРИАЛИЗУЕТСЯ, а половины ключей это BigInt: JSON.stringify на них ПАДАЕТ, и файл
// восстановления не выпускается. Приводим BigInt к шестнадцатеричной строке - тот же смысл, но сериализуемый.
// Такой же обработчик стоит в записи состояния (core/store.js): это одна и та же граница сериализации.
const bigintSafe = (key, value) => (typeof value === "bigint" ? "0x" + value.toString(16) : value);
export async function createRecoveryFile(payload, passphrase) {
  const file = await encryptPayload(payload, passphrase);
  return JSON.stringify(file, bigintSafe, 2);
}

export function recoveryFileName(swapId) {
  // Имя файла - строчными и с привязкой к свопу: по нему видно, к какой сделке файл относится, и его
  // можно сверить с id на сервере (там он тот же). Раньше было "Arrakis-swap-<id>.json.enc": заглавная
  // буква в начале и никакой связи с конкретным свопом, если id ещё нет.
  // Если id ещё нет (файл качают до создания свопа) - имя ФИКСИРОВАННОЕ, без случайного хвоста.
  //
  // Раньше здесь был случайный хвост: он не давал файлам перезаписывать друг друга, но на практике каждое
  // нажатие кнопки "Download recovery file" рождало НОВОЕ имя, и в загрузках оказывалась кипа похожих
  // файлов непонятного происхождения. Именно это выглядело как "каждый раз скачивается другой файл".
  // Теперь имя стабильное, а повторное скачивание браузер сам пометит как (1) - это понятнее, чем новая
  // случайная строка. Имя совпадает с тем, что уже используется на сервере для незавершённого дела.
  const raw = String(swapId || "").trim();
  const known = raw && raw !== "pending" ? raw : "pending";
  // Нижний регистр и только безопасные символы: имя уходит в файловую систему, где регистр и спецсимволы
  // ведут себя по-разному на Windows, Linux и macOS.
  const safe = known.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `arrakis-${safe}.json.enc`;
}
