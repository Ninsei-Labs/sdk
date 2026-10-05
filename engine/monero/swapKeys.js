// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/swapKeys.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// КЛЮЧИ СОВМЕСТНОГО АДРЕСА ИЗ ПОЛОВИН. Разбор: .hermes/docs/27-half-release-by-settlement.md, раздел 2.
//
// ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО: полного ключа траты. Ни одна сторона не генерирует кошелёк свопа
// целиком - каждая даёт СВОЮ половину, а адрес собирается как СУММА. Именно поэтому «забрать XMR и тут же
// вернуть ETH» не получается: у противника нет чужой половины, и он не может потратить выход один.
// Прежняя функция combineAddress в wallet.js собирала адрес иначе - из seed мейкера, то есть из полного
// ключа на его стороне. Это кастодиальная схема, и она не часть того, что здесь, а то, от чего мы ушли.
//
// АРИФМЕТИКА. Monero - edwards25519. Ключ траты адреса есть СУММА половин, публичная точка адреса -
// СУММА точек. Это одно и то же, потому что (a+b)G == aG + bG, и именно на этом равенстве держится
// разделение: адрес знают оба, потратить может только тот, у кого обе половины.
//
// ДВЕ РАЗНЫЕ ОПЕРАЦИИ, И ИХ НЕЛЬЗЯ СЛИВАТЬ:
//   1) АДРЕС строится из ПУБЛИЧНЫХ данных: своя половина + чужая ТОЧКА. Секрет контрагента не нужен.
//      Это делается сразу при заведении ордера.
//   2) КЛЮЧ ТРАТЫ (s_a + s_b) появляется только ПОСЛЕ того, как вторая половина раскрыта расчётом.
//      До этого его нет ни у кого - иначе схема не работала бы.

// Пункт (1): адрес из публичных данных. Ничего секретного о контрагенте здесь не требуется.
export function swapAddressFromHalves({ halves, addressFromKeys, deps, ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network }) {
  if (!halves || !addressFromKeys) throw new Error("нужны halves и addressFromKeys");
  for (const [name, v] of Object.entries({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint })) {
    if (v === undefined || v === null || v === "") throw new Error("не задано: " + name);
  }
  const ownSpendPub = halves.publicHalves(ownSpendHalf).ed;
  const ownViewPub = halves.publicHalves(ownViewHalf).ed;
  const spendPub = halves.combinePublic(ownSpendPub, otherSpendPoint);
  const viewPub = halves.combinePublic(ownViewPub, otherViewPoint);
  // Строка адреса собирается тем же энкодером, что и раньше: сеть берётся из конфига, поэтому работают
  // и mainnet, и stagenet. Меняется только источник ключей - он теперь половины, а не seed.
  // deps = { keccak256, Buffer }: кодировщик адреса считает контрольную сумму сам, полагаться на глобали нельзя.
  const address = addressFromKeys({ network, kind: "primary", spendPub, viewPub }, deps);
  return { address, spendPub, viewPub, ownSpendPub, ownViewPub };
}

// Пункт (2): ключ траты после раскрытия второй половины, С ОБЯЗАТЕЛЬНОЙ ПРОВЕРКОЙ.
//
// ПРОВЕРКА ЗДЕСЬ - НЕ ФОРМАЛЬНОСТЬ, А ТО, РАДИ ЧЕГО ВСЁ. Раскрытая половина может оказаться не той:
// по схеме контракт пока принимает любую, чей хеш совпал с обязательством, поэтому единственное место,
// где связь «раскрытая половина ↔ точка адреса» подтверждается, - вот это сравнение. Сверяем
// (s_a + s_b)*G с публичным ключом траты, который был в ордере: не сошлось - НЕ метём и говорим вслух.
export function sweepSpendSecret({ halves, ownSpendHalf, revealedOtherHalf, expectedSpendPub }) {
  if (!halves) throw new Error("нужны halves");
  for (const [name, v] of Object.entries({ ownSpendHalf, revealedOtherHalf, expectedSpendPub })) {
    if (v === undefined || v === null || v === "") throw new Error("не задано: " + name);
  }
  const sum = halves.combineHalves(ownSpendHalf, BigInt(revealedOtherHalf));
  const sumPub = halves.publicHalves(sum).ed;
  const norm = (h) => "0x" + String(h).replace(/^0x/i, "").toLowerCase();
  if (norm(sumPub) !== norm(expectedSpendPub)) {
    throw new Error(
      "раскрытая половина не соответствует адресу: (s_a + s_b)*G != публичный ключ траты ордера. " +
      "Метать нельзя - половина чужая или из другого ордера"
    );
  }
  return { spendSecret: sum, spendPub: sumPub };
}

// Ключ просмотра для мониторинга входа: тоже сумма, но у него своя пара половин.
// Отдельная функция, потому что просмотр и трата - разные секреты, и путать их нельзя.
export function watchViewSeedHex({ halves, ownViewHalf, otherViewHalf }) {
  const sum = halves.combineHalves(ownViewHalf, BigInt(otherViewHalf));
  return "0x" + sum.toString(16).padStart(64, "0");
}
