// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/wallet.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Одноразовый Monero-кошелёк свапа.
//
// Ключи считает monero-js (ebellocchia/monero-js, MIT, вендорен в www/assets/vendors/monero-js):
// мнемоника и ключи чистым JS - реальные и мгновенные. Библиотека умеет только mainnet-префиксы
// адресов, поэтому строку адреса собирает наш энкодер (monero/address.js) для сети из конфига -
// так работает и stagenet (24/36).
//
// Ключи НЕ покидают браузер: наружу (на бэкенд, для watch-only кошелька) уходит только view key,
// и делает это отдельная явная функция - recovery/restore.js::watchOnlyShareFromWallet. Так это
// и описано в litepaper §5.4: кошелёк одноразовый, на одну сделку, seed основного кошелька
// пользователя никогда не импортируется.

import { MONERO } from "../core/config.js";
import { randomHex, toHex } from "../core/format.js";
import { addressFromKeys } from "./address.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  return out;
}

// Псевдо-адрес для мок-режима: правильная длина (95) и префикс сети, но БЕЗ checksum.
// В UI он всегда помечен как mock - чтобы никто не отправил туда XMR.

// ---------------------------------------------------------------------------
// monero-js (мнемоника + ключи + адреса, чистый JS)
// ---------------------------------------------------------------------------

let moneroJsModule = null;
let moneroJsError = null;

export async function loadMoneroJs() {
  if (moneroJsModule) return moneroJsModule;
  if (moneroJsError) throw new Error(moneroJsError);
  try {
    const mod = await import("../../assets/vendors/monero/monero-js-browser.js?v=05c682ea");
    moneroJsModule = mod.default || mod;
    return moneroJsModule;
  } catch (e) {
    // Причину не подменяем: «бандл не собран», «не залит» и «заблокирован CSP» - разные проблемы
    moneroJsError = "monero-js unavailable: " + e.message +
      " (соберите npm run build:vendor; про CSP см. .hermes/docs/06-deploy.md)";
    throw new Error(moneroJsError);
  }
}

async function withMoneroJs({ mnemonic: phrase, network = MONERO.networkType } = {}) {
  const lib = await loadMoneroJs();
  await lib.wallet.initEcc();

  // Если фразу передали - она обязана быть валидной. Раньше невалидная фраза молча заменялась
  // свежесгенерированной, и восстановление из испорченного recovery-файла давало ДРУГОЙ кошелёк:
  // ошибка выглядела бы как успех, а средства остались бы недоступны. Генерация - только когда
  // фразы нет вовсе.
  let words;
  if (phrase) {
    if (!lib.mnemonic.isValid(phrase)) {
      throw new Error("мнемоника не прошла проверку контрольной суммы (файл или форма повреждены?)");
    }
    words = String(phrase).trim();
  } else {
    words = lib.mnemonic.generateWithChecksum();
  }
  const seed = lib.mnemonic.toSeed(words); // 32 байта: для Monero сид == декодированная мнемоника
  const w = lib.wallet.fromSeed(seed);

  const net = network || "mainnet";
  const deps = { keccak256: lib.keccak256, Buffer: lib.Buffer };
  const spendPub = toHex(w.publicSpendKey);
  const viewPub = toHex(w.publicViewKey);
  const sub = w.subaddress(1, 0);
  // адрес своей сети собираем сами (библиотека умеет только mainnet);
  // addressMainnet оставляем для сверки: на mainnet они обязаны совпадать
  const address = addressFromKeys({ network: net, kind: "primary", spendPub, viewPub }, deps);
  const subaddress = addressFromKeys(
    { network: net, kind: "subaddress", spendPub: toHex(sub.publicSpendKey), viewPub: toHex(sub.publicViewKey) },
    deps
  );

  return {
    source: "monero-js",
    library: "ebellocchia/monero-js (MIT)",
    network: net,
    mnemonic: words,
    mnemonicWords: words.split(" ").length,
    seedHex: toHex(seed),
    privateSpendKey: toHex(w.privateSpendKey),
    privateViewKey: toHex(w.privateViewKey),
    publicSpendKey: spendPub,
    publicViewKey: viewPub,
    address,
    subaddress,
    addressMainnet: w.primaryAddress().encode(),
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// monero-ts убран
// ---------------------------------------------------------------------------
// Здесь был второй режим кошелька - WebAssembly wallet2 (woodser/monero-ts), который собирался
// в www/assets/vendors/monero/monero-ts-browser.js. Он удалён из демки по двум причинам:
//   1) WASM-кошельку нужен SharedArrayBuffer, то есть COOP/COEP, а на домене демки COEP заблокировал
//      бы сторонние ресурсы (шрифты, Verify WalletConnect);
//   2) сам бандл переехал в sweep/ - у него свой домен с COOP/COEP (см. .hermes/docs/09-sweep-origin.md).
// Раньше здесь называлась третья причина - «политика демки не пускает webpack-сборку monero-ts, она
// использует eval». Причина была настоящей, но перестала ею быть: с monero-ts 0.11.16 бандл под
// строгой политикой (script-src 'self' 'wasm-unsafe-eval', без 'unsafe-eval') работает, и это
// доказано прогоном tools/check-csp-eval.mjs - прежний 0.11.15 под ней же падает на импорте.
// Пока ветка кода оставалась, она тянула import по несуществующему пути - то есть была мёртвой
// и при этом выглядела рабочей. Ключи в демке считает monero-js, и это единственный путь.

// ---------------------------------------------------------------------------

export async function createSwapWallet({ network = MONERO.networkType, seed } = {}) {
  return withMoneroJs({ mnemonic: seed, network });
}

// Доступна ли библиотека ключей (панель Demo controls показывает это одной строкой).
export async function probeMode() {
  try {
    const lib = await loadMoneroJs();
    await lib.wallet.initEcc();
    return { available: true, info: "mnemonic + keys + addresses (" + MONERO.networkType + ")" };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// Совместный адрес свапа. В реальном протоколе это адрес из СУММЫ публичных ключей
// двух сторон (S_a + S_b, V_a + V_b): потратить выход можно только собрав обе половины
// spend-ключа, а DLEQ-доказательство связывает половины с секретом.
// В демке сумма считается по хешу от ключей: интерфейс и поток те же, криптография подменена явно.
export function combineAddress({ swapId, userPublicSpendKey, userPublicViewKey, makerKeySeed }) {
  const mk = (salt) => {
    const payload = `${salt}|${swapId}|${userPublicSpendKey}|${userPublicViewKey}`;
    let hh = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
      hh ^= payload.charCodeAt(i);
      hh = (hh * 0x01000193) >>> 0;
    }
    return hh.toString(16).padStart(8, "0") + randomHex(28);
  };
  return {
    mock: true,
    address: "8" + mk(makerKeySeed).slice(0, 94),
    spendShare: "0x" + mk("spend-share").slice(0, 64),
    viewShare: "0x" + mk("view-share").slice(0, 64),
    note: "mock: в реальном протоколе это сумма публичных ключей обеих сторон с DLEQ-доказательством",
  };
}

export function networkLabel(network = MONERO.networkType) {
  return { mainnet: "Monero mainnet", stagenet: "Monero stagenet", testnet: "Monero testnet" }[network] || network;
}
