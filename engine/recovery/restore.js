// GENERATED FILE - a byte-for-byte copy of the engine module www/js/recovery/restore.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Обратный путь recovery-файла: файл → кошелёк, которым можно забрать XMR.
//
// Прямой путь (генерация файла) - в recoveryFile.js. Здесь то, ради чего файл вообще существует:
// восстановление, когда вкладка потеряна. Два правила закреплены кодом, а не комментарием:
//
//   1) кошелёк восстанавливается из мнемоники, и восстановленный адрес ОБЯЗАН совпасть с адресом
//      в файле. Не совпал - файл повреждён или подменён, и продолжать нельзя: молчаливое
//      «восстановилось» означало бы показать пользователю чужой кошелёк и потерять его средства;
//   2) на сервер (watch-only кошелёк) уходит ТОЛЬКО view key с адресом и высотой. Ключ траты,
//      мнемоника и seed остаются в браузере - это граница продукта, поэтому она вынесена в
//      отдельную функцию и проверяется отдельным тестом (tools/check-recovery.mjs).

import { createSwapWallet } from "../monero/wallet.js";
import { decryptFile, validatePayload } from "./recoveryFile.js";
import { swapAddressFromHalves, watchViewSeedHex } from "../monero/swapKeys.js";

// Восстановленный кошелёк + всё, что нужно для скана: высота и предупреждения формата.
//
// ДВЕ РАЗНЫЕ СХЕМЫ, И ОБЕ ЖИВЫЕ. Файл версии 2 несёт МНЕМОНИКУ: из неё собирается полный кошелёк. Файл версии 3
// несёт ПОЛОВИНЫ, и полного ключа траты в нём НЕТ И БЫТЬ НЕ МОЖЕТ: у каждой стороны только своя половина,
// вторая раскрывается в цепи при заборе ETH. Поэтому из файла версии 3 собирается ВИДЯЩИЙ кошелёк (ключ
// просмотра - сумма двух половин просмотра), а трата становится возможной только после раскрытия.
//
// deps нужен для проверяемости: в браузере библиотеки берутся из вендорного бандла (подгружаются здесь
// динамически, потому что статический импорт бандла сломал бы прогоны в Node), а в тестах передаются свои.
export async function restoreWalletFromPayload(payload, deps = {}) {
  const { warnings } = validatePayload(payload);
  const m = payload.moneroWallet;
  const network = m.network || payload.moneroNetwork;
  if (payload.version >= 3) return await restoreFromHalves(payload, warnings, deps);

  // Мнемоника передаётся явно: monero-js проверит контрольную сумму и откажется работать,
  // если фраза битая (в wallet.js это теперь ошибка, а не тихая генерация нового кошелька).
  const wallet = await createSwapWallet({ seed: m.mnemonic, network });

  if (wallet.address !== m.address) {
    throw new Error("адрес из файла не совпал с адресом, выведенным из мнемоники: файл повреждён или изменён");
  }
  // Публичные ключи в файле - вторая проверка того же самого, но по другим данным: адрес
  // собирается из них, поэтому расхождение означает правку файла руками.
  for (const [field, value] of [
    ["publicSpendKey", wallet.publicSpendKey],
    ["publicViewKey", wallet.publicViewKey],
  ]) {
    if (m[field] && m[field] !== value) {
      throw new Error(`ключ ${field} из файла не совпал с выведенным из мнемоники: файл изменён`);
    }
  }

  return {
    wallet,
    payload,
    // Ради этого высота и хранится: без неё кошелёк сканирует историю Monero с нуля (десятки часов).
    restoreHeight: Number.isFinite(m.restoreHeight) && m.restoreHeight > 0 ? m.restoreHeight : 0,
    warnings,
  };
}

// ВОССТАНОВЛЕНИЕ ИЗ ПОЛОВИН (файл версии 3). Что здесь есть и чего здесь нет:
//
//   есть: ПРОВЕРКА ЦЕЛОСТНОСТИ. Адрес собирается из своих половин и ЧУЖИХ ТОЧЕК и обязан совпасть с адресом
//   в файле - ровно та же роль, что у сравнения адреса с мнемоникой в ветке v2. Не совпал - файл повреждён или
//   подменён, и продолжать нельзя;
//   есть: КЛЮЧ ПРОСМОТРА - сумма своей половины просмотра и половины контрагента (она в файле и не секрет).
//   Им кошелёк ВИДИТ поступления на общий адрес;
//   НЕТ: ключ траты. Его нельзя собрать: второй половины траты в файле нет, и это не упущение, а свойство
//   схемы. Она придёт из цепи, когда контрагент заберёт ETH, - вот тогда трата и станет возможной
//   (sweepSpendSecret сверяет её с публичным ключом ордера).
export async function restoreFromHalves(payload, warnings = [], deps = {}) {
  const m = payload.moneroWallet;
  const network = m.network || payload.moneroNetwork;
  const libs = deps.halves && deps.addressFromKeys
    ? { halves: deps.halves, addressFromKeys: deps.addressFromKeys, keccak256: deps.keccak256 }
    : await (async () => {
        const vendor = await import("../../assets/vendors/atomic/atomic-browser.js?v=0951c3dc");
        const { createHalves } = await import("../atomic/halves.js");
        const { addressFromKeys } = await import("../monero/address.js");
        const halves = createHalves({
          ed25519: vendor.ed25519, secp256k1: vendor.secp256k1,
          keccak256: vendor.keccak256, randomBytes: vendor.randomBytes,
        });
        return { halves, addressFromKeys, keccak256: vendor.keccak256 };
      })();
  if (!libs.keccak256) throw new Error("нет keccak256: без него адрес не проверить");

  const built = swapAddressFromHalves({
    halves: libs.halves, addressFromKeys: libs.addressFromKeys, deps: { keccak256: libs.keccak256 },
    ownSpendHalf: m.spendHalf, ownViewHalf: m.viewHalf,
    otherSpendPoint: m.otherSpendPoint, otherViewPoint: m.otherViewPoint, network,
  });
  if (built.address !== m.address) {
    throw new Error("адрес из файла не совпал с адресом, собранным из половин и точек контрагента: файл повреждён или изменён");
  }
  const viewSeedHex = watchViewSeedHex({
    halves: libs.halves, ownViewHalf: m.viewHalf, otherViewHalf: m.otherViewHalf,
  });
  const wallet = {
    address: built.address,
    network,
    spendPub: built.spendPub,
    viewPub: built.viewPub,
    viewSeedHex,
    spendHalf: m.spendHalf,
    viewHalf: m.viewHalf,
    otherSpendPoint: m.otherSpendPoint,
    otherViewPoint: m.otherViewPoint,
    otherViewHalf: m.otherViewHalf,
    source: "halves",
    // ЯВНО: этим кошельком ПОКА нельзя распоряжаться. Ключ траты появится после раскрытия половины в цепи.
    spendable: false,
  };
  return {
    wallet,
    payload,
    restoreHeight: Number.isFinite(m.restoreHeight) && m.restoreHeight > 0 ? m.restoreHeight : 0,
    warnings: [
      ...warnings,
      "этот файл описывает схему ПОЛОВИН: ключом просмотра видно поступления, а для траты нужна половина " +
        "контрагента, которая раскрывается в цепи при заборе ETH",
    ],
  };
}

// Полный путь: расшифровать файл паролем и восстановить кошелёк.
export async function restoreFromFile(fileObject, passphrase, deps = {}) {
  return restoreWalletFromPayload(await decryptFile(fileObject, passphrase), deps);
}

// Страховка на будущее, вынесена отдельной функцией именно для того, чтобы её можно было
// проверить тестом: сейчас share собирается по белому списку полей, поэтому секрет в него
// попасть не может. Но если завтра кто-то добавит в share поле «на всякий случай», падать это
// должно здесь, а не утекать на сервер. Проверяем двумя способами - по именам полей и по
// значениям (переименовать поле легко, а значение секрета останется тем же).
export function assertNoSecretsInShare(share, wallet) {
  // spendHalf и viewHalf добавлены вместе со схемой половин: это секреты той же силы, что и ключ траты,
  // и на сервер они попасть не должны - он видит только СУММУ половин просмотра, и этого хватает,
  // чтобы видеть входящие, и недостаточно, чтобы их потратить.
  for (const name of ["mnemonic", "seed", "seedHex", "privateSpendKey", "spendKey", "subaddressKeys", "spendHalf", "viewHalf"]) {
    if (Object.hasOwn(share, name)) throw new Error("watch-only share не должен содержать " + name);
  }
  const json = JSON.stringify(share);
  for (const [label, secret] of [
    ["ключ траты", wallet.privateSpendKey],
    ["мнемоника", wallet.mnemonic],
    ["seed", wallet.seedHex],
    ["половина ключа траты", wallet.spendHalf],
    ["половина ключа просмотра", wallet.viewHalf],
  ]) {
    if (secret && json.includes(secret)) throw new Error(`в watch-only share попал секрет (${label})`);
  }
  return share;
}

// То, что уходит на сервер: адрес и view key - этого достаточно, чтобы видеть входящие
// на кошелёк, и недостаточно, чтобы их потратить.
export function watchOnlyShareFromWallet({ swapId = null, wallet, restoreHeight = null } = {}) {
  if (!wallet || !wallet.address || !wallet.privateViewKey) {
    throw new Error("для watch-only нужен кошелёк с адресом и приватным view key");
  }
  // Собираем по белому списку: поля кошелька, которых здесь нет, наружу не попадут никогда.
  return assertNoSecretsInShare(
    {
      swapId: swapId || null,
      network: wallet.network,
      address: wallet.address,
      privateViewKey: wallet.privateViewKey,
      restoreHeight: Number.isFinite(restoreHeight) ? restoreHeight : null,
    },
    wallet
  );
}
