// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/halvesSweep.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// КЛЮЧИ ДЛЯ ВЫВОДА ИЗ ФАЙЛА ПОЛОВИН. Вынесено отдельным модулем, потому что это ОДНА логика на два
// потребителя: страница вывода (sweep.js) и проверка (tools/check-sweep-halves.mjs). Пока код жил прямо на
// странице, проверить его можно было только в браузере, а вторая копия в проверке неизбежно разошлась бы с
// первой - и заметил бы это не тот, кто ошибся.
//
// ПОЧЕМУ ЭТО ГЛАВНАЯ ФУНКЦИЯ ВСЕГО ВЫВОДА. Контракт убеждается лишь в том, что ХЕШ раскрытой половины совпал
// с обязательством. Связь «раскрытая половина и точка в адресе» проверить он не может: ed25519 в EVM нет.
// Значит её проверяем мы, и ДО всякой синхронизации: (s_a + s_b)*G обязана совпасть с публичным ключом траты
// ордера. Не совпало - не метём и говорим прямо.
//
// Секреты здесь не создаются: обе половины уже есть у стороны (своя - в файле, чужая - раскрыта в цепи).
export function spendKeysFromRevealedHalf({
  halves, ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewHalf, revealedHalf,
}) {
  if (!halves) throw new Error("нужна математика половин");
  for (const [name, v] of Object.entries({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewHalf, revealedHalf })) {
    if (v === undefined || v === null || v === "") throw new Error("не задано: " + name);
  }
  const sum = halves.combineHalves(BigInt(ownSpendHalf), BigInt(revealedHalf));
  const sumPub = halves.publicHalves(sum).ed;
  // Ожидаемый ключ траты собирается ИЗ СВОЕЙ ПОЛОВИНЫ И ЧУЖОЙ ТОЧКИ - то есть из того, что было в ордере.
  // ПОЛОВИНА ИЗ ФАЙЛА ПРИХОДИТ СТРОКОЙ, И ЭТО НАДО УЧЕСТЬ КАЖДЫЙ РАЗ. Строкой она была и в сумме, и здесь -
  // здесь забыли, и вывод XMR падал на живом стенде с «invalid field element: expected bigint, got string»
  // уже ПОСЛЕ чтения раскрытой половины из цепи: до этой строки дело доходило, а дальше нет.
  const expected = halves.combinePublic(halves.publicHalves(BigInt(ownSpendHalf)).ed, otherSpendPoint);
  const norm = (h) => String(h).replace(/^0x/i, "").toLowerCase();
  if (norm(sumPub) !== norm(expected)) {
    throw new Error(
      "раскрытая половина не соответствует адресу: (s_a + s_b)*G != ключ траты ордера. " +
        "Половина из другого ордера или подменена - метать нельзя"
    );
  }
  // Полный ключ ПРОСМОТРА - тоже сумма: своей половины из файла и половины контрагента. Тратить он не даёт,
  // а без него кошелёк не найдёт наши XMR в цепи: ключи просмотра и траты в Monero независимы.
  const viewSum = halves.combineHalves(BigInt(ownViewHalf), BigInt(otherViewHalf));
  // ПОРЯДОК БАЙТ - ЭТО ФОРМАТ, А НЕ КОСМЕТИКА, И ЗДЕСЬ ОН БЫЛ НЕВЕРЕН ДО 28.09.2026.
  // Прежняя редакция писала скаляр обычной записью числа: старший байт первым. Библиотека ждёт ЗАПИСЬ
  // MONERO - младшим байтом вперёд, как скаляр лежит в памяти.
  //
  // ЗАМЕР 28.09.2026, ОБЕ СБОРКИ monero-ts 0.11.16 (нативная в узле и вендорная в браузере), ОДНИ И ТЕ ЖЕ
  // ключи: своя же строка (createWalletKeys().getPrivateSpendKey()) принимается КАК ЕСТЬ и публичный ключ
  // совпадает, а развёрнутая отвергается словами "failed to verify secret spend key". Обе сборки ведут себя
  // ОДИНАКОВО - значит расхождение было нашим, а не библиотеки: прежняя запись числа давала развёрнутый
  // порядок, и обе точки входа чинили это обходным путём (страница вывода - reversedKey, инструмент узла -
  // flip). Обходные пути оставлены КАК СЕТЬ для чужого файла, но срабатывать не должны, и срабатывание
  // видно в журнале.
  //
  // ПРЕФИКСА 0x ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО: библиотека выдаёт ключ 64 hex без префикса и такой принимает,
  // а вид "0x"+64 hex отвергает на разборе - "failed to parse secret spend key".
  const be32 = (v) => BigInt(v).toString(16).padStart(64, "0");  // обычная запись числа, старший байт первым
  const le32 = (v) => be32(v).match(/../g).reverse().join("");   // запись Monero: младший байт первым
  return { privateSpendKey: le32(sum), privateViewKey: le32(viewSum) };
}

// ОБРАТНЫЙ ПЕРЕХОД - ТОЖЕ ОДНА ФУНКЦИЯ НА ВСЕХ. Кто читает выданный ключ как ЧИСЛО, обязан развернуть порядок:
// обычная запись числа (BigInt("0x" + ключ)) прочтёт запись Monero задом наперёд и даст другой скаляр - молча,
// без всякой ошибки. Ровно на этом мы уже стояли: и проверка, и инструмент пары разбирали ключ напрямую, и
// после исправления порядка байт оба обязаны были бы покраснеть - если бы их не поправили вместе с модулем.
export function scalarFromMoneroHex(h) {
  const hex = String(h).replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("ключ не в записи Monero: ожидались 64 hex");
  return BigInt("0x" + hex.match(/../g).reverse().join(""));
}
