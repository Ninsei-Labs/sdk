// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/orderHalfCommit.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ОБЯЗАТЕЛЬСТВО НА ПОЛОВИНУ - одна формула на все стороны.
//
// ЧТО СЧИТАЕТ ЦЕПЬ. `keccak256(x || y)` от secp256k1-ТОЧКИ половины `half·G` - то есть АДРЕС этой точки.
// При раскрытии контракт проверяет не «хеш числа совпал», а что предъявленная половина РАЗМНОЖАЕТСЯ в ту же
// точку (приём `ecrecover`, `ArrakisEscrow.halfMatchesCommit`). Обязательство-ТОЧКА закрывает #123: раньше
// `keccak256(be32(half))` принимал любое число с совпавшим хешем, и вносящий ETH мог закоммитить хеш мусора,
// вернуть этим мусором ETH и запереть XMR второй стороны. Связь точки secp256k1 с точкой ed25519 (и адресом
// Monero) держит DLEQ - её проверяет рискующая сторона ДО платежа.
//
// Это же обязательство входит в termsHash и в котировку. Значит формула обязана совпадать у приложения, у
// ноды провайдера и у любого, кто станет проверять сделку. Две реализации одной формулы расходятся ровно
// тогда, когда это дороже всего: цепь отвергнет половину, которая «точно правильная».
//
// ТОЧКА БЕРЁТСЯ НЕСЖАТОЙ - 64 байта `x || y`, старшим байтом вперёд, как координаты ключа Ethereum.
// `secp256k1` и `keccak256` передаются снаружи: модуль не тянет зависимостей сам, как и соседние.

export function halfCommitmentHex(half, secp256k1, keccak256) {
  if (!secp256k1 || !keccak256) throw new Error("нужны secp256k1 и keccak256");
  const value = BigInt(half);
  if (value <= 0n) throw new Error("половина должна быть положительным числом");
  const raw = secp256k1.Point.BASE.multiply(value).toBytes(false);   // 65 байт: 0x04 || x(32) || y(32)
  const xy = raw.slice(1);                                            // 64 байта: x || y
  return "0x" + Array.from(keccak256(xy), (b) => b.toString(16).padStart(2, "0")).join("");
}
