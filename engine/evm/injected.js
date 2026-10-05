// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/injected.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Браузерные кошельки: обнаружение по EIP-6963 и подключение по EIP-1193.
//
// ПОЧЕМУ EIP-6963, А НЕ window.ethereum.isMetaMask. При двух установленных расширениях
// window.ethereum - это «кто успел последним», и угадывание по флагам даёт чужие имена и иконки:
// пользователь видит «MetaMask», а подключается Rabby. EIP-6963 решает это стандартно: кошелёк
// объявляет себя событием `eip6963:announceProvider` с именем, иконкой и своим провайдером, а
// страница просит объявиться событием `eip6963:requestProvider`. Так список кошельков настоящий,
// и он же обновляется, если пользователь поставил расширение при открытой вкладке.
//
// window.ethereum остаётся фолбэком для старых кошельков, которые 6963 ещё не умеют. В этом
// случае честное имя - «Browser wallet»: назвать его MetaMask мы не имеем права, не проверив.
//
// Здесь НЕТ состояния: этот модуль только находит провайдеров и делает рукопожатие. Состояние,
// балансы и смена сети живут в evm/session.js - общие для обоих коннекторов.

const ANNOUNCE = "eip6963:announceProvider";
const REQUEST = "eip6963:requestProvider";

// Коды EIP-1193, которые важны на экране: отказ пользователя - это не ошибка приложения.
export const USER_REJECTED = 4001;

export function isUserRejection(error) {
  const code = error && (error.code || (error.data && error.data.originalError && error.data.originalError.code));
  if (code === USER_REJECTED) return true;
  return /rejected|denied|cancell?ed|closed by user/i.test(String((error && error.message) || error || ""));
}

// Человеческое имя для фолбэка: флаги - единственное, что есть у старых кошельков.
function fallbackName(eth) {
  if (!eth) return null;
  if (eth.isMetaMask) return "MetaMask";
  if (eth.isRabby) return "Rabby";
  if (eth.isCoinbaseWallet) return "Coinbase Wallet";
  if (eth.isBraveWallet) return "Brave Wallet";
  if (eth.isFrame) return "Frame";
  return "Browser wallet";
}

// Собрать список кошельков: сначала объявившиеся по EIP-6963, затем фолбэк window.ethereum.
// timeoutMs нужен потому, что announceProvider - событие: без паузы список будет пустым даже при
// установленном кошельке (у расширения свой темп инициализации).
export function discoverWallets({ win = globalThis, timeoutMs = 250 } = {}) {
  const found = [];
  const seen = new Set();
  const add = (entry) => {
    const key = entry.rdns || entry.uuid || entry.name;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(entry);
  };

  const onAnnounce = (event) => {
    const detail = event && event.detail;
    if (!detail || !detail.provider || !detail.info) return;
    add({
      uuid: detail.info.uuid || null,
      name: detail.info.name || "Browser wallet",
      icon: detail.info.icon || null,
      rdns: detail.info.rdns || null,
      provider: detail.provider,
      source: "eip6963",
    });
  };

  if (win && typeof win.addEventListener === "function") {
    win.addEventListener(ANNOUNCE, onAnnounce);
    if (typeof win.dispatchEvent === "function") {
      // Просим объявиться; ответы придут асинхронно, поэтому ждём короткую паузу.
      win.dispatchEvent(new Event(REQUEST));
    }
  }

  return new Promise((resolve) => {
    const finish = () => {
      if (win && typeof win.removeEventListener === "function") win.removeEventListener(ANNOUNCE, onAnnounce);
      // Фолбэк: старый кошелёк, который 6963 не умеет, но window.ethereum выставил.
      // providers (массив) бывает, когда установлено несколько кошельков без поддержки 6963.
      const legacy = win && win.ethereum;
      if (!found.length && legacy) {
        const list = Array.isArray(legacy.providers) && legacy.providers.length ? legacy.providers : [legacy];
        for (const p of list) {
          add({ name: fallbackName(p), icon: null, rdns: null, provider: p, source: "legacy" });
        }
      }
      resolve(found);
    };
    if (timeoutMs > 0 && typeof setTimeout === "function") setTimeout(finish, timeoutMs);
    else finish();
  });
}

// Подписка на «кошелёк появился». Нужна, чтобы список в модалке не был снимком на момент открытия:
// пользователь может поставить расширение, не перезагружая страницу.
//
// Работаем именно с самим объявлением, а не с повторным обнаружением: событие EIP-6963 несёт и имя,
// и провайдер кошелька, а события не переигрываются - кошелёк, объявившийся до нашей подписки, при
// повторном запросе ответит снова, но снимок всё равно был бы потерян. Так список только дополняется.
export function watchWallets(fn, { win = globalThis } = {}) {
  if (!win || typeof win.addEventListener !== "function") return () => {};
  const known = new Map();
  const publish = () => fn([...known.values()]);
  const onAnnounce = (event) => {
    const detail = event && event.detail;
    if (!detail || !detail.provider || !detail.info) return;
    const key = detail.info.rdns || detail.info.uuid || detail.info.name;
    if (!key || known.has(key)) return;
    known.set(key, {
      uuid: detail.info.uuid || null,
      name: detail.info.name || "Browser wallet",
      icon: detail.info.icon || null,
      rdns: detail.info.rdns || null,
      provider: detail.provider,
      source: "eip6963",
    });
    publish();
  };
  win.addEventListener(ANNOUNCE, onAnnounce);
  // Просим объявиться: кошельки, которые уже установлены, ответят прямо сейчас и попадут в список.
  // Пустой список наружу не отдаём - иначе UI очищался бы просто потому, что кошельков нет.
  if (typeof win.dispatchEvent === "function") win.dispatchEvent(new Event(REQUEST));
  return () => win.removeEventListener(ANNOUNCE, onAnnounce);
}

// Рукопожатие EIP-1193: просим аккаунты (здесь кошелёк спросит разрешение) и узнаём сеть.
export async function handshake(provider) {
  if (!provider || typeof provider.request !== "function") {
    throw new Error("Этот кошелёк не умеет EIP-1193 (нет request)");
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : null;
  const chainIdHex = await provider.request({ method: "eth_chainId" });
  return { address: address || null, chainId: Number(chainIdHex) || null };
}

// Тихая проверка «сайт уже разрешён этому кошельку» - для восстановления после перезагрузки.
// eth_accounts НЕ показывает окно кошелька: пустой ответ значит «разрешения нет», и это нормальное
// состояние, а не ошибка. Именно поэтому нельзя звать здесь eth_requestAccounts: страница при
// загрузке не должна выкидывать окно подключения.
export async function silentAccounts(provider) {
  if (!provider || typeof provider.request !== "function") return [];
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

// Почему кошелёк мог не открыться - переводим код ошибки в понятную причину.
//
// -32002 - самая частая причина «нажал, а окно не появилось»: у кошелька уже есть открытый
// запрос (окно висит на другом экране/вкладке, или предыдущая попытка не завершена).
export function explainInjectedError(e, label = "Кошелёк") {
  const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
  const message = String((e && e.message) || e);
  if (code === -32002 || /already pending|already processing/i.test(message)) {
    return (
      label +
      ": в кошельке уже есть незавершённый запрос, поэтому новое окно не открылось. " +
      "Открой расширение, заверши или отмени тот запрос и нажми снова."
    );
  }
  if (/no provider|not connected|provider is disconnected|undefined is not a function/i.test(message)) {
    return label + ": расширение не отвечает (браузер мог выгрузить его или страница открыта не там, где оно работает).";
  }
  if (/user rejected|user denied|rejected by user/i.test(message) || code === 4001) {
    return label + ": запрос отклонён в кошельке.";
  }
  return label + ": " + message;
}
