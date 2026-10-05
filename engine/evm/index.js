// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/index.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Кошелёк, которым пользуется интерфейс демки.
//
// Реализация одна: WalletConnect (www/js/evm/walletconnect.js) - настоящий кошелёк
// пользователя, настоящие балансы. Раньше здесь был выбор режима (WalletConnect или
// встроенный демо-кошелёк) для Demo controls; демо-кошелёк убран вместе с переключателем,
// потому что мы движемся к настоящему продукту, а не к макету.
//
// Чего в демке по-прежнему НЕТ: переводов. Контракта escrow ещё не существует, адрес escrow
// генерируется моком (www/js/mock/chain.js), поэтому шаг фондирования остаётся имитацией -
// simulateEscrowFunding() ниже. Когда контракт появится, на его месте будет
// provider.sendTransaction/eth_sendTransaction, а имитация исчезнет вместе с моком цепочки.

import {
  address,
  balanceOf,
  chainIdOf,
  connect,
  disconnect,
  isConnected,
  refreshBalances,
  restore,
  status,
  subscribe,
  switchChain,
  currentProvider,
  tokensWithBalance,
  connectInjected,
  restoreInjected,
} from "./session.js";
import { discoverWallets } from "./injected.js";
// fundOrder нужен ЛОКАЛЬНЫМ именем: export * из модуля ./funding.js« ниже только реэкспортирует, но не
// создаёт переменную в этом модуле. Из-за этого fundOrderLive вызывал несуществующее имя и падал.
import { fundOrder } from "./funding.js";
export * from "./factory.js";
export * from "./escrow.js";
export * from "./funding.js";
// ВНОСЯЩИЙ ПО ПОДПИСИ И РАЗРЕШЕНИЕ НА ТОКЕН. Форма подписи вносящего (evm/depositor.js) и вердикт о
// разрешении по подписи (evm/permit.js) выходят через ТОТ ЖЕ шов движка: страница и SDK пользуются одним
// кодом протокола, а не двумя похожими.
export * from "./depositor.js";
export * from "./permit.js";

// currentProvider - ПРОВАЙДЕР КОШЕЛЬКА НАРУЖУ, ЯДРУ: склейник отдаёт его адаптеру SDK (evm-wallet.mjs), чтобы
// подпись шла тем же ключом, что и у страницы. Экранам он не нужен: они читают status()/isConnected().
export { address, balanceOf, chainIdOf, connect, disconnect, isConnected, refreshBalances, restore, status, subscribe, switchChain, currentProvider };
export { connectInjected, restoreInjected };
// ВАЖНО: это импорт, а не реэкспорт. Конструкция export { X } из модуля ...« только реэкспортирует имя и НЕ
// создаёт его в этом модуле, а fundOrderLive ниже вызывает sendTransaction и readContract напрямую.
// Ровно на этом уже падало дважды: сначала fundOrder, затем readContract - оба имени были доступны
// снаружи, но не внутри файла.
import { sendTransaction, readContract, readReceipt, readCode } from "./session.js";
export { sendTransaction, readContract, readReceipt, readCode };

// Список браузерных кошельков в этом браузере (EIP-6963, с фолбэком на window.ethereum).
// Пустой список - обычное дело: значит расширения нет, и остаётся WalletConnect.
export function wallets() {
  return discoverWallets();
}

// Балансы всех принимаемых токенов сети (нативный первым) - для экранов, которым нужен список.

// ИМИТАЦИЯ: настоящей транзакции не отправляем, потому что отправлять некуда - escrow-контракта
// нет. Возвращаем поддельный хеш, чтобы состояние сделки осталось выводимым (см. docs/03).
// В UI это сказано прямо: демка не двигает реальные деньги.
export async function simulateEscrowFunding(tx) {
  await new Promise((r) => setTimeout(r, 900));
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hash = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, ...tx, simulated: true };
}

// БОЕВОЙ ПУТЬ ФОНДИРОВАНИЯ: настоящие транзакции в кошельке пользователя.
//
// Заменяет simulateEscrowFunding. Отличие принципиальное: симуляция выдумывала хеш, здесь уходят две
// настоящие транзакции - createOrder в фабрику и lock(sealedHalf) в созданный эскроу.
//
// Разделение обязанностей намеренное: криптография (половины, DLEQ, посылка) живёт в www/js/atomic/ и
// сюда НЕ заглядывает. Эта функция получает уже готовые sealedCommitment и sealedHalf - то есть ровно то,
// что уходит в контракт. Порядок вычислений задаёт вызывающий: сначала проверить сторону контрагента
// (раздел 20.5), и только потом лочить.
//
// factory передаётся снаружи: адрес берётся из конфига сети тем, кто вызывает, чтобы здесь не заводить
// второй источник правды об адресах.
// ПОДПИСЬ ПРИВЕДЕНА К НОВОЙ СХЕМЕ, и это была не косметика: здесь оставались хешлок, обязательство и
// посылка от прежнего устройства, а обязательств на половины и точек ed25519 - которые fundOrder ТРЕБУЕТ
// и без которых падает - не было вовсе. То есть живой путь фондирования не мог пройти даже первый шаг:
// вызов уходил дальше без четырёх обязательных полей. Ни синтаксис, ни проверки этого не видели, потому
// что живой путь никем не запускается: он требует настоящего кошелька и подписи.
// ЧЕТЫРЕ ПОЛЯ И ДВА СРОКА ЯВНО. Сроки приходят готовыми (readyBy, t1), а не считаются здесь от текущего
// времени: они входят в контекст, к которому привязано доказательство, значит должны быть решены ДО него.
export async function fundOrderLive({ factory, locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, salt, amountWei, amountLabel, claimWindowSeconds = 3600, readyWindowSeconds = 14400, readyBy, t1, quote, depositorSignature, onStep }) {
  return fundOrder({
    factory,
    quote,                         // подписанная котировка: несёт комиссию, адрес реестра и провайдера
    // ПОДПИСЬ ВНОСЯЩЕГО НАД ДАЙДЖЕСТОМ КОТИРОВКИ (issue #97, части A/C). Есть - фондирование идёт путём
    // createOrderAndFundByDepositor, и транзакцию вправе отправить кто угодно. Нет - прежний путь.
    depositorSignature,
    locker,
    claimer,
    commitHalfLocker,
    commitHalfClaimer,
    edPointLocker,
    edPointClaimer,
    edViewPointLocker,
    salt,                          // повтор фондирования обязан попасть в тот же адрес эскроу
    amountLabel,                   // "0.03 ETH" вместо числа в wei на кнопке
    amountWei,
    claimWindowSeconds,
    readyWindowSeconds,
    readyBy,                       // сроки, к которым уже привязано доказательство
    t1,
    call: readContract,
    send: sendTransaction,
    receipt: readReceipt,          // адрес эскроу берём из квитанции, а не из предсказания
    onStep,
  });
}
