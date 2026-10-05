// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/order.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Сборка стороны ордера атомарного свопа: половина ключа, точки, доказательство, зашифрованная
// посылка и обязательство для контракта.
// Разбор: .hermes/docs/20-key-shares.md, разделы 12, 19, 23, 25.
//
// ЧТО ЭТО ЗАКРЫВАЕТ. До сих пор модули существовали по отдельности: половины, DLEQ, передача половины,
// байтовый формат. Здесь они собираются в одну сторону ордера и, главное, здесь КОДОМ выполняются два
// обязательных условия из раздела 20.5:
//   1) перед блокировкой проверяется, что в посылке контрагента лежит настоящая половина (сверка с точкой);
//   2) при этом проверяется и его DLEQ - что обе публичные точки стоят за одним скаляром.
// Без этих двух проверок схема не даёт гарантии, и они не «на будущее», а здесь.
//
// ЧЕСТНОЕ ОГРАНИЧЕНИЕ ДЕМО. Настоящего мейкера (RFQ-узла) ещё нет: в market.js котировки фиктивные.
// Поэтому сторона контрагента собирается ЛОКАЛЬНО и помечается как заглушка (standIn: true). Это
// позволяет прогнать полный цикл - от половины до обязательства и до вскрытия - но ценность гарантии
// появляется только с настоящим контрагентом, у которого свой ключ.

import { createHalves } from "./halves.js";import { halfCommitmentHex } from "./orderHalfCommit.js";
import { createDleq2 } from "./dleq2.js";
import { createHalfEnc, packSealed } from "./halfenc.js";
import { addressFromKeys } from "../monero/address.js";
import { swapAddressFromHalves } from "../monero/swapKeys.js";

export function createOrderBuilder({ ed25519, secp256k1, keccak256, sha3_512, randomBytes }) {
  const halves = createHalves({ ed25519, secp256k1, keccak256, randomBytes });
  const dleq = createDleq2({ ed25519, secp256k1, keccak256, sha3_512, randomBytes });
  const enc = createHalfEnc({ secp256k1, ed25519, keccak256, randomBytes });

  // Сторона ордера: ДВЕ половины (траты и просмотра), их точки, доказательство и ключ шифрования.
  //
  // ЗАЧЕМ ОТДЕЛЬНАЯ ПОЛОВИНА ПРОСМОТРА. Ключ просмотра в Monero независим от ключа траты, и из половины
  // траты его не вывести. Без суммы половин ПРОСМОТРА кошелёк не найдёт входящие и не сможет сканировать:
  // половины траты для скана недостаточно. При этом делиться половиной просмотра БЕЗОПАСНО - она даёт
  // видеть и не даёт тратить; трата требует суммы половин ТРАТЫ.
  //
  // ДОКАЗАТЕЛЬСТВА ДЛЯ НЕЁ НЕ НУЖНО, и это осознанно: половина просмотра приходит вместе с котировкой и
  // сама определяет точку просмотра, поэтому подменять её нечем. Доказательство DLEQ остаётся там, где
  // оно решает - на половине ТРАТЫ, за которую платят ETH.
  function newSide(orderContext, standIn = false, onBit) {
    const half = halves.newHalf();
    const pub = halves.publicHalves(half);                     // ed25519 и secp256k1
    const viewHalf = halves.newHalf();
    const viewPub = halves.publicHalves(viewHalf).ed;          // точка просмотра: из неё собирается адрес
    const encPair = enc.recipientKeyPair();                    // отдельно от ключа траты
    const proof = dleq.prove(half, orderContext, onBit);        // привязано к контексту ордера
    return { half, pub, viewHalf, viewPub, enc: encPair, proof, standIn };
  }

  // Проверка стороны контрагента - это и есть условие (1) и (2) из раздела 20.5.
  // Проверка стороны контрагента: доказательство и - если посылка дана - вскрытие ЕГО посылки НАШИМ
  // приватным ключом со сверкой по ЕГО публичной точке.
  //
  // РОЛИ КЛЮЧЕЙ ЗДЕСЬ ПРИНЦИПИАЛЬНЫ, и первая версия этой функции их путала: она вскрывала посылку
  // приватным ключом самого контрагента, которого у нас нет и быть не может - посылка адресована ему.
  // Такая проверка не могла пройти никогда, но выглядела как работающая, что хуже всего.
  function verifySide(side, orderContext, sealedPayloadBytes, ownEncPriv) {
    const proofOk = dleq.verify(side.proof, orderContext);
    if (!proofOk.ok) return { ok: false, reason: "DLEQ контрагента не прошёл: " + proofOk.reason };
    // ДОКАЗАННАЯ ТОЧКА ОБЯЗАНА БЫТЬ ТОЙ ЖЕ, ЧТО УЙДЁТ В ОРДЕР, и этой сверки не было.
    //
    // Чего не хватало без неё: доказательство подтверждает, что за парой точек стоит ОДИН скаляр, но НЕ
    // подтверждает, что доказанная точка ed25519 - та самая, по которой собирается общий адрес и которую
    // контракт потом заставит раскрыть. Контрагент мог предъявить корректное доказательство для одной
    // точки, а в ордер подставить другую. На своей стороне всё выглядело бы исправным, а расхождение
    // вылезло бы в самом конце - при заборе XMR, когда исправлять уже нечем.
    //
    // Сверка одна на обе стороны: у своей стороны pub.ed выведена из половины, у контрагента приходит из
    // котировки; в обоих случаях это ТА точка, которую увидят в контракте.
    if (side.pub && side.pub.ed && String(side.proof.XB).toLowerCase() !== String(side.pub.ed).toLowerCase()) {
      return { ok: false, reason: "доказанная точка ed25519 не совпадает с заявленной: " + side.proof.XB + " против " + side.pub.ed };
    }
    if (sealedPayloadBytes && ownEncPriv) {
      const opened = enc.open(enc.unpackSealed(sealedPayloadBytes), ownEncPriv, side.pub.ed);
      if (!opened.ok) return { ok: false, reason: "посылка контрагента не подтверждает половину: " + opened.reason };
    }
    return { ok: true };
  }

  // Посылка со своей половиной, зашифрованная на ключ контрагента: то, что уходит ему и в контракт.
  function sealFor(counterparty, ownHalf, orderContext) {
    const sealed = enc.seal(ownHalf, counterparty.enc.pub, orderContext);
    const bytes = packSealed(sealed);
    return { sealed, bytes, commitment: enc.sealedCommitmentOf(bytes) };
  }

  // Открыть посылку контрагента своей половиной и проверить, что это именно его половина.
  function openFrom(sealedBytes, ownEncPriv, counterpartyEdPub) {
    return enc.open(enc.unpackSealed(sealedBytes), ownEncPriv, counterpartyEdPub);
  }

  // ОБЯЗАТЕЛЬСТВО НА ПОЛОВИНУ - то, что контракт проверяет в `claim` и `refund`, и то, что входит в
  // `termsHash`. Ровно это считает Solidity: `keccak256` от secp256k1-ТОЧКИ половины (`half·G`), а не от
  // числа. Значит формула обязана совпадать у приложения и у ноды - поэтому она живёт ОТДЕЛЬНЫМ модулем и
  // здесь только вызывается, а курс (`secp256k1`) передаётся снаружи: две копии одной формулы расходятся
  // ровно тогда, когда цепь отвергнет «точно правильную» половину (#123).
  function halfCommitment(half) {
    return halfCommitmentHex(half, secp256k1, keccak256);
  }

  // Общий адрес Monero: сумма публичных половин. Проверяется свойством (a+b)G == aG + bG.
  function jointAddressPoint(sideA, sideB) {
    return halves.combinePublic(sideA.pub.ed, sideB.pub.ed);
  }

  // ТОЧКА ПО ПОЛОВИНЕ. Нужна там, где от контрагента пришла ПОЛОВИНА (так она приходит в котировке под
  // ордер), а для адреса нужна точка. Точка из половины выводится тем же модулем половин, что и везде.
  function pointOf(half) {
    return halves.publicHalves(typeof half === "bigint" ? half : BigInt(half)).ed;
  }

  // ОБЩИЙ АДРЕС MONERO - то, ради чего схема и построена. Ни одна сторона не знает чужой половины ТРАТЫ:
  // адрес собирается из СВОЕЙ половины и ЧУЖОЙ ТОЧКИ, потому что (a+b)G == aG + bG. До раскрытия второй
  // половины расчётом адрес существует, но потратить с него не может никто.
  //
  // КОДИРОВЩИК БЕРЁМ ТОТ ЖЕ, ЧТО У КОШЕЛЬКА (monero/address.js). Второй кодировщик разошёлся бы с первым
  // там, где ошибку видно только отправкой XMR, - и заметил бы её не тот, кто ошибся.
  //
  // КЛЮЧ ПРОСМОТРА СОБИРАЕТСЯ ОТДЕЛЬНО И ИЗ СВОИХ ПОЛОВИН: в Monero ключи просмотра и траты независимы, и
  // подменять один другим нельзя. Без верной половины просмотра пользователь не увидит приход.
  function jointAddress({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network }) {
    return swapAddressFromHalves({
      halves, addressFromKeys, deps: { keccak256 },
      ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network,
    });
  }

  return { halves, dleq, enc, newSide, verifySide, sealFor, openFrom, jointAddressPoint, pointOf, jointAddress, halfCommitment };
}
