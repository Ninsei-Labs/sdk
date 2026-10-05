// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/session.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Кошелёк EVM: состояние, балансы, смена сети и два способа подключения.

// ПОЧЕМУ ДВА КОННЕКТОРА. WalletConnect (Reown) нужен, когда пользователь пришёл с телефона или из
// кошелька без расширения: сессия живёт по QR. Браузерный кошелёк (MetaMask, Rabby, Coinbase...),
// если он установлен, подключается напрямую через EIP-1193 - это быстрее и без лишнего звена.
// Оба дают один и тот же интерфейс EIP-1193, поэтому состояние, балансы и смена сети у них общие:
// разница только в рукопожатии (см. www/js/evm/injected.js).

// Что здесь реально, а что нет - принципиально важно:
//   РЕАЛЬНО: подключение (QR или браузерное расширение), адрес, chainId, балансы нативного токена и
//            ERC-20 (значения приходят от кошелька пользователя через его провайдер, decimals - из
//            конфига);
//   НЕ РЕАЛЬНО: переводы. Контракт escrow пока не задеплоен, адрес escrow в демке - мок, поэтому
//            отправка транзакции остаётся имитацией (см. evm/index.js). Реальные деньги демка не
//            двигает и не должна.

// Модалку рисуем сами (ui/walletModal.js): у Reown она со inline-стилями, а CSP демки их запрещает.
// Провайдер WalletConnect инициализируется с showQrModal: false, ссылку сессии берём из события
// display_uri и кодируем в QR в data:-URL.

// Балансы кешируются в состоянии: UI спрашивает balanceOf() синхронно, а обновление идёт
// через refreshBalances() (подключение, смена сети, событие кошелька).
import { CHAINS, EVM, chainById, chainByChainId, tokensOf } from "../core/config.js";
import {
  discoverWallets,
  explainInjectedError,
  handshake as injectedHandshake,
  isUserRejection,
  silentAccounts,
} from "./injected.js";
import { openWalletModal } from "../ui/walletModal.js";
import { toHuman } from "./amounts.js";
// ПРАВИЛО КОМИССИИ CLAIM - ИЗ ОБЩЕГО МОДУЛЯ (issue #127): та же формула, по которой нода считает подарок.
import { claimMaxFeePerGasWei } from "./claimGas.js";

const listeners = new Set();

const state = {
  status: "idle", // idle | pairing | connected | error
  kind: null, // walletconnect | injected - каким коннектором подключены
  label: null, // имя кошелька для UI: "WalletConnect", "MetaMask", "Rabbit"...
  address: null,
  chainId: null, // числовой chainId сети, в которой сейчас кошелёк
  balances: {}, // "42161:USDC" -> человекочитаемое число
  error: null,
  lastRefresh: 0,
};

let provider = null;
let modal = null;
let lib = null;

function emit() {
  for (const fn of listeners) {
    try {
      fn(publicState());
    } catch (e) {
      console.warn("wallet listener failed", e);
    }
  }
}

function publicState() {
  return { ...state, balances: { ...state.balances } };
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function status() {
  return publicState();
}

export function isConnected() {
  return state.status === "connected" && !!state.address;
}

export function address() {
  return state.address;
}

export function chainIdOf() {
  return state.chainId;
}

// ПРОВАЙДЕР КОШЕЛЬКА НАРУЖУ - ЯДРУ, А НЕ ЭКРАНАМ. Ядро (sdk/) получает кошелёк адаптером и окон не
// открывает: ему нужен тот же EIP-1193 провайдер, которым подписывает страница. Второй провайдер заводить
// нельзя - подпись ушла бы не тем ключом. Для экранов это имя ничего не значит: состояние кошелька они
// читают через status()/isConnected(), как и раньше.
export function currentProvider() {
  return provider;
}

export function balanceOf(chainSlugOrId, symbol) {
  const chain = chainById(chainSlugOrId);
  const v = state.balances[`${chain.chainId}:${String(symbol).toUpperCase()}`];
  return v === undefined ? 0 : v;
}

const hexChainId = (id) => "0x" + Number(id).toString(16);

async function loadLib() {
  if (!lib) {
    // Динамический импорт своего же файла: CSP script-src 'self' это разрешает,
    // и 2 МБ бандла грузятся только когда пользователь реально жмёт Connect.
    lib = await import("../../assets/vendors/walletconnect/wc-browser.js?v=13fe06e5");
  }
  return lib;
}

function rpcMap() {
  const map = {};
  for (const c of CHAINS) map[c.chainId] = c.rpcUrl;
  return map;
}

function reset(status = "idle", error = null) {
  state.status = status;
  state.error = error;
  state.kind = null;
  state.label = null;
  state.address = null;
  state.chainId = null;
  state.balances = {};
  provider = null;
  emit();
}

// --- общая часть обоих коннекторов ----------------------------------------------------------
//
// WalletConnect и браузерный кошелёк дают один и тот же интерфейс EIP-1193, поэтому события,
// состояние и чтение балансов у них общие. Различается только рукопожатие, поэтому здесь -
// обработчики, а в connect()/connectInjected() - как именно получен провайдер.

function wireProvider(p) {
  p.on("chainChanged", (id) => {
    state.chainId = Number(id);
    state.error = null;
    emit();
    refreshBalances();
  });
  p.on("accountsChanged", (accounts) => {
    const next = (accounts && accounts[0]) || null;
    // Пустой список - пользователь отключил сайт в кошельке. Это не «подключено без адреса»,
    // а именно отключение: иначе экран показывал бы пустой кошелёк как рабочий.
    if (!next) {
      if (modal) modal.close();
      reset("idle", null);
      return;
    }
    state.address = next;
    emit();
    refreshBalances();
  });
  // disconnect приходит от WalletConnect и от браузерного кошелька (например, при сбросе);
  // session_delete - только WalletConnect. Оба означают одно: сессии больше нет.
  p.on("disconnect", () => {
    if (modal) modal.close();
    reset("idle", null);
  });
  p.on("session_delete", () => {
    if (modal) modal.close();
    reset("idle", null);
  });
}

// ВОЗВРАТ СТРАНИЦЫ ИЗ BFCACHE. Chrome (с 149) разрывает WebSocket, когда страница уходит в кэш
// "вперёд-назад", и делает это НАМЕРЕННО: в консоли это выглядит как "failed: Page entered Back-Forward
// Cache", хотя сеть ни при чём. Следствие: провайдер WalletConnect кэширован в переменной, его сокет уже
// закрыт, а повторы релея замерли вместе со страницей - и после возврата сессия ВЫГЛЯДИТ живой, а запросы
// к кошельку не доходят. Ни одноразовый restore(), ни события провайдера этого не замечают. Чиним тем же
// механизмом, на который restore() опирается: init() поднимает сессию из localStorage. disconnect() здесь
// НЕ вызываем - он удаляет сессию из хранилища, то есть сломал бы ровно то, что восстанавливаем.
let resumeInFlight = false;

export async function resumeConnection() {
  if (resumeInFlight || state.status !== "connected" || state.kind !== "walletconnect" || !provider) return;
  resumeInFlight = true;
  const p = provider;
  try {
    await Promise.race([
      p.request({ method: "eth_accounts" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("релей не ответил за 4 с")), 4000)),
    ]);
    console.log("[wc] после возврата страницы соединение живо");
    return;
  } catch (e) {
    console.log("[wc] после возврата страницы релей не отвечает (" + e.message + ") - поднимаю сессию заново");
  } finally {
    resumeInFlight = false;
  }
  provider = null;                       // у старого сокета браузер закрыл соединение, кэш смысла не имеет
  try {
    const want = state.chainId || (CHAINS.find((c) => c.escrow) || {}).chainId;
    const fresh = await ensureProvider(want);
    const accounts = await fresh.request({ method: "eth_accounts" });
    if (!Array.isArray(accounts) || !accounts.length) {
      console.log("[wc] сессии в хранилище не осталось - нужен новый QR");
      reset("idle", null);
      return;
    }
    state.address = accounts[0];
    emit();
    await refreshBalances();
    console.log("[wc] сессия поднята заново: " + state.address);
  } catch (e) {
    console.log("[wc] поднять сессию не удалось: " + e.message);
    reset("idle", null);
  }
}

// Возврат страницы: pageshow (в том числе из bfcache) и появление вкладки. Дебаунс, чтобы переключение
// вкладок не дёргало релей на каждый чих.
let resumeTimer = null;
const scheduleResume = () => {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => { resumeConnection(); }, 400);
};
// ПОДПИСКА НА СОБЫТИЯ ОКНА - ТОЛЬКО ТАМ, ГДЕ ОКНО ЕСТЬ. Раньше это стояло без проверки среды, и модуль
// падал при загрузке в Node (проверки репозитория) и в SDK, который обещает «без DOM»: падение приходило
// не в момент подписки, а на импорте файла - то есть ломало всё, что его подтягивает.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pageshow", () => scheduleResume());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleResume(); });
}

async function ensureProvider(wantChainId) {
  if (provider) return provider;
  const { EthereumProvider } = await loadLib();
  provider = await EthereumProvider.init({
    projectId: EVM.projectId,
    chains: [wantChainId],
    // Только сети, где демка может сеттлиться: сеть без эскроу предлагать кошельку незачем (и
    // проект WalletConnect может её не знать, что сломало бы подключение).
    optionalChains: CHAINS.filter((c) => c.escrow).map((c) => c.chainId),
    showQrModal: false,
    rpcMap: rpcMap(),
    // url в метаданных WalletConnect сверяет с фактическим origin страницы (проверка
    // происхождения приложения). Если подставить боевой домен, локально и на тестовом
    // домене сессия срывается - поэтому берём origin, а не константу.
    metadata: { ...EVM.metadata, url: location.origin },
  });

  provider.on("display_uri", (uri) => showUri(uri));
  wireProvider(provider);
  // kind/label здесь НЕ выставляем: провайдер создан, но подключения ещё нет. Иначе после
  // перезагрузки без сессии состояние было бы idle, а UI считал бы кошелёк подключённым
  // (это ловится проверкой в браузере: status=idle, kind=walletconnect).
  return provider;
}

async function showUri(uri) {
  if (!modal || modal.closed.value) return;
  try {
    const { QRCode } = await loadLib();
    const qrDataUrl = await QRCode.toDataURL(uri, {
      margin: 1,
      width: 440,
      errorCorrectionLevel: "M",
      color: { dark: "#0a0d13", light: "#ffffff" },
    });
    modal.update({ qrDataUrl, uri, status: "Waiting for the wallet to approve..." });
  } catch (e) {
    // QR не собрался - ссылку всё равно показываем, её можно скопировать.
    modal.update({ uri, status: "Scan failed to render, copy the link instead", error: true });
    console.warn("qr render failed", e);
  }
}

// Восстановление сессии после перезагрузки страницы.
//
// WalletConnect держит сессию в localStorage, и EthereumProvider.init() поднимает её обратно.
// Но у нас провайдер создавался ЛЕНИВО - только при нажатии «Connect wallet», - поэтому после F5
// сессия лежала в хранилище, а страница о ней не знала: показывала «Connect wallet» и предлагала
// новый QR. Восстановление делаем явным шагом при загрузке: поднять провайдер и, если сессия есть,
// объявить её подключённой (адрес, сеть, балансы).
//
// Состояние читаем ПОСЛЕ init, а не по событию: при восстановлении событие может прийти раньше,
// чем страница успела подписаться на провайдера.
let restoreTried = false;

// ПОМЕТКА "ВЫШЕЛ ВРУЧНУЮ". WalletConnect держит сессию в localStorage, поэтому одного disconnect() мало:
// при следующей загрузке restore() поднимет её обратно, и выход окажется фиктивным. Пометку снимаем
// ТОЛЬКО при осознанном подключении.
const OPTOUT_KEY = "arrakis.wallet.optOut";
const isOptedOut = () => { try { return localStorage.getItem(OPTOUT_KEY) === "1"; } catch { return false; } };
const setOptOut = (on) => { try { on ? localStorage.setItem(OPTOUT_KEY, "1") : localStorage.removeItem(OPTOUT_KEY); } catch {} };

export async function restore() {
  // Вышел вручную - не подхватываем: иначе кнопка "выйти" ничего не значит.
  if (isOptedOut()) { restoreTried = true; console.log("[wc] восстановление пропущено: кошелёк отключён вручную"); return publicState(); }
  if (restoreTried || state.status === "connected") return publicState();
  restoreTried = true;
  // Порядок: сначала сессия WalletConnect (лежит в localStorage), затем браузерный кошелёк.
  // Второй шаг тихий: eth_accounts не показывает окно, поэтому загрузка страницы не превращается
  // в «подключите кошелёк» для тех, кто уже подключил его раньше.
  if (EVM.projectId) {
    try {
      const want = chainById(state.chainId || undefined);
      const p = await ensureProvider(want.chainId);
      const accounts = (p && p.accounts) || [];
      // Пусто - сессии в хранилище нет (или она была отключена). Это нормальное состояние: ниже
      // пробуем браузерный кошелёк и, если и его нет, страница предложит подключиться.
      if (accounts.length) {
        state.kind = "walletconnect";
        state.label = "WalletConnect";
        state.address = accounts[0];
        state.chainId = Number(p.chainId) || want.chainId;
        state.status = "connected";
        state.error = null;
        emit();
        await refreshBalances();
        console.info("WalletConnect: сессия восстановлена после перезагрузки", state.address);
      }
    } catch (e) {
      console.warn("WalletConnect: восстановить сессию не удалось", e && e.message ? e.message : e);
    }
  }
  if (!isConnected()) return restoreInjected();
  return publicState();
}

// Тихая проверка браузерных кошельков: тот, кто уже разрешён сайту, возвращает адрес без окна.
export async function restoreInjected({ wallets } = {}) {
  if (isConnected()) return publicState();
  const list = wallets || (await discoverWallets());
  for (const w of list) {
    const accounts = await silentAccounts(w.provider);
    if (!accounts.length) continue;
    provider = w.provider;
    state.kind = "injected";
    state.label = w.name || "Browser wallet";
    wireProvider(provider);
    state.address = accounts[0];
    try {
      state.chainId = Number(await provider.request({ method: "eth_chainId" })) || null;
    } catch {
      state.chainId = null;
    }
    state.status = "connected";
    state.error = null;
    emit();
    await refreshBalances();
    console.info("Браузерный кошелёк восстановлен без запроса: " + state.address);
    return publicState();
  }
  return publicState();
}

// Подключение браузерного кошелька: здесь кошелёк покажет окно разрешения.
export async function connectInjected({ wallet, chainSlug } = {}) {
  setOptOut(false);  // осознанное подключение снимает пометку
  if (!wallet || !wallet.provider) {
    throw new Error("Расширение кошелька не найдено в этом браузере");
  }
  if (isConnected() && state.kind === "injected" && state.label === (wallet.name || null)) {
    return { address: state.address, chainId: state.chainId };
  }
  const want = chainById(chainSlug || state.chainId || undefined);
  provider = wallet.provider;
  state.kind = "injected";
  state.label = wallet.name || "Browser wallet";
  state.status = "pairing";
  state.error = null;
  emit();
  wireProvider(provider);
  try {
    const res = await injectedHandshake(provider);
    if (!res.address) throw new Error("Кошелёк не вернул ни одного адреса");
    state.address = res.address;
    state.chainId = res.chainId || want.chainId;
    state.status = "connected";
    state.error = null;
    emit();
    // Сеть приводим к выбранной в форме: пользователь мог подключиться в другой сети.
    if (state.chainId !== want.chainId) await switchChain(want);
    await refreshBalances();
    return { address: state.address, chainId: state.chainId };
  } catch (e) {
    const label = state.label || wallet.name || "Кошелёк";
    const message = explainInjectedError(e, label);
    if (isUserRejection(e)) {
      console.info("[wallet] отказ пользователя: " + message);
      reset("idle", null);
      return null;
    }
    console.warn("[wallet] подключение не состоялось: " + message, e);
    reset("error", message);
    throw new Error(message);
  }
}

// Подключение. chainSlug - сеть, выбранная в форме; она же становится основной в сессии.
//
// WalletConnect здесь НЕ стартует сразу: сначала показывается выбор - браузерные кошельки, найденные
// по EIP-6963, и WalletConnect отдельной строкой. Так пользователю с расширением не создаётся сессия
// WalletConnect, которую он не просил, а с телефона не приходится искать расширение.
export async function connect({ chainSlug } = {}) {
  if (isConnected()) return { address: state.address, chainId: state.chainId };
  const want = chainById(chainSlug || state.chainId || undefined);

  state.status = "pairing";
  state.error = null;
  emit();

  const wallets = await discoverWallets();
  // Журнал обнаружения: первое, что нужно при «кошелёк не открывается» - кого мы вообще нашли.
  // У старых расширений (без EIP-6963) источник legacy: имя взято по флагам, и провайдер может
  // принадлежать другому расширению - тогда окно открывает не тот кошелёк, на который нажали.
  if (wallets.length) {
    console.info(
      "[wallet] обнаружены в браузере: " +
        wallets.map((w) => w.name + " [" + w.source + (w.rdns ? " " + w.rdns : "") + "]").join(", ")
    );
  } else {
    console.info("[wallet] браузерных кошельков не найдено (остаётся WalletConnect)");
  }
  modal = openWalletModal({
    title: "Connect a wallet",
    subtitle: `Requested network: ${want.name}. The QR below is a public WalletConnect link - nothing secret. This demo never moves real funds: there is no escrow contract on-chain yet.`,
    hint: "Browser wallets are detected in this browser (EIP-6963). WalletConnect works with mobile wallets by QR.",
  });

  const choice = await new Promise((resolve) => {
    // Отмена (крестик, клик по фону, Cancel) - это не ошибка приложения, а решение пользователя.
    modal.setOnCancel(() => resolve({ type: "cancel" }));
    const options = wallets.map((w) => ({
      key: w.rdns || w.name,
      name: w.name,
      icon: w.icon,
      // Честная пометка: кошелёк, найденный через window.ethereum, мы называем по его флагам, но
      // подтвердить, что это именно он, не можем - поэтому и подпись соответствующая.
      hint: w.source === "eip6963" ? null : "detected via window.ethereum",
      onClick: () => resolve({ type: "injected", wallet: w }),
    }));
    if (EVM.projectId) {
      options.push({
        key: "walletconnect",
        name: "WalletConnect",
        icon: null,
        hint: "QR code for a mobile wallet",
        onClick: () => resolve({ type: "walletconnect" }),
      });
    }
    modal.setChoices(options);
    modal.update({
      status: wallets.length
        ? "Choose a browser wallet above, or scan the QR code below."
        : "No browser wallet found in this browser - use the QR code below.",
    });
  });

  if (choice.type === "cancel") {
    reset("idle", null);
    return null;
  }

  // --- браузерный кошелёк: окно разрешения показывает сам кошелёк ---
  if (choice.type === "injected") {
    try {
      const res = await connectInjected({ wallet: choice.wallet, chainSlug: want.id });
      if (modal) modal.close();
      return res;
    } catch (e) {
      // Модалку НЕ закрываем: причина отказа должна остаться на экране. Иначе получается
      // «нажал - ничего не произошло», и понять, что случилось, неоткуда (ловится проверкой).
      const message = String((e && e.message) || e);
      if (modal) {
        modal.update({
          error: message,
          status: "Try again, or use WalletConnect below.",
        });
      }
      throw e;
    }
  }

  // --- WalletConnect: прежний путь, включая мгновенную отмену ---
  if (!EVM.projectId) {
    if (modal) modal.close();
    reset("error", "no-project-id");
    throw new Error("WalletConnect projectId is not configured");
  }
  modal.update({ status: "Preparing the session..." });
  // Отмена должна НЕМЕДЛЕННО завершить подключение. Без этого await provider.connect()
  // висит до таймаута сессии, кнопка "Connect wallet" остаётся disabled, и демка выглядит
  // сломанной (баг поймался проверкой в браузере: после отмены кнопка не оживала).
  let cancelReject = null;
  const cancelled = new Promise((_, reject) => {
    cancelReject = () => reject(new Error("Connection cancelled"));
  });

  modal.setOnCancel(() => {
    // Пользователь закрыл модалку: сессию надо погасить, иначе она останется висеть.
    const p = provider;
    provider = null;
    if (p) Promise.resolve(p.disconnect()).catch(() => {});
    reset("idle", null);
    if (cancelReject) cancelReject();
  });

  try {
    const p = await ensureProvider(want.chainId);
    await Promise.race([p.connect({ chains: [want.chainId] }), cancelled]);
    state.kind = "walletconnect";
    state.label = "WalletConnect";
    state.address = (p.accounts && p.accounts[0]) || null;
    state.chainId = Number(p.chainId);
    state.status = "connected";
    state.error = null;
    // Именно close(), а не cancel(): подключение состоялось, гасить сессию не нужно.
    if (modal) modal.close();
    emit();
    await refreshBalances();
    return { address: state.address, chainId: state.chainId };
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    console.warn("WalletConnect connect failed:", message);
    // Отказ пользователя - это не ошибка приложения.
    const rejected = isUserRejection(e) || /cancell?ed/i.test(message);
    if (modal) modal.close();
    reset(rejected ? "idle" : "error", rejected ? null : message);
    if (!rejected) throw e;
    return null;
  }
}

// ПОДПИСЬ СООБЩЕНИЯ кошельком (EIP-191). Это НЕ транзакция: она ничего не двигает, не стоит газа и не
// может быть предъявлена контракту - она доказывает ровно одно: владение адресом. На этом держится вход
// в свой список сделок, потому что подключение кошелька само по себе ничего не доказывает: сервер по нему
// не знает, кто на другом конце.
//
// Метод personal_sign поддержан собранным SDK - проверено поиском по бандлу, а не по памяти.
export async function signMessage(message) {
  if (!provider || state.status !== "connected") {
    throw new Error("кошелёк не подключён: подпись невозможна");
  }
  // СООБЩЕНИЕ ПЕРЕДАЁМ В HEX, А НЕ ТЕКСТОМ. Так требует EIP-191: первым аргументом personal_sign идут
  // байты сообщения в hex. MetaMask принимает и текст (поэтому на живом кошельке это годами не всплывало),
  // а узел отвечает отказом: "invalid value: string ..., expected a valid hex string". Проверено вызовом:
  // текст - отказ -32602, hex - подпись. Порядок аргументов [данные, адрес] - как у MetaMask и WalletConnect.
  // Если кошелёк ответит ошибкой, показываем её КАК ЕСТЬ: по тексту сразу видно причину.
  const hex = "0x" + Array.from(new TextEncoder().encode(String(message)), (b) => b.toString(16).padStart(2, "0")).join("");
  return await provider.request({ method: "personal_sign", params: [hex, state.address] });
}

// ПОДПИСЬ TYPED DATA КОШЕЛЬКОМ (EIP-712, eth_signTypedData_v4). ЭТО ТОЖЕ НЕ ТРАНЗАКЦИЯ: подпись не
// двигает деньги и не стоит газа, поэтому её может дать человек БЕЗ своего ETH. Ею вносящий разрешает
// фабрике записать его адрес в ордер (issue #97, часть A/C), а отправить транзакцию за него вправе кто
// угодно (путь createOrderAndFundByDepositor).
//
// ЧТО ИМЕННО ПОДПИСЫВАЕТСЯ, РЕШАЕТ ВЫЗЫВАЮЩИЙ: сюда приходит ГОТОВОЕ typed data (www/js/evm/depositor.js),
// а не строка. Собирать форму здесь значило бы завести вторую запись протокола рядом с настоящей.
export async function signTypedData(typedData) {
  if (!provider || state.status !== "connected") {
    throw new Error("кошелёк не подключён: подпись typed data невозможна");
  }
  if (!typedData || typeof typedData !== "object") throw new Error("signTypedData: не передано typed data");
  // Порядок аргументов [адрес, JSON] - как требует EIP-712 и как принимают MetaMask и WalletConnect.
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [state.address, JSON.stringify(typedData)],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("кошелёк вернул не 65-байтовую подпись typed data: " + String(signature).slice(0, 20));
  }
  return signature;
}

export async function disconnect() {
  setOptOut(true);   // запоминаем решение: после перезагрузки кошелёк не подхватится
  const p = provider;
  const kind = state.kind;
  if (!p) {
    reset("idle", null);
    return;
  }
  try {
    if (kind === "injected") {
      // У браузерного кошелька нет «сессии» на нашей стороне: мы можем только попросить отозвать
      // разрешение (wallet_revokePermissions) и забыть адрес у себя. Честно: следующие
      // eth_accounts могут снова вернуть адрес, если кошелёк помнит сайт.
      if (typeof p.revokePermissions === "function") {
        await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
      }
    } else {
      await p.disconnect();
    }
  } catch (e) {
    console.warn("disconnect failed", e);
  }
  reset("idle", null);
}

// Смена сети в кошельке. Если сети у пользователя нет - предлагаем добавить её с нашим rpcUrl
// (это параметр кошелька, страница по этому адресу не ходит - CSP не при чём).
export async function switchChain(chainSlugOrId) {
  const chain = typeof chainSlugOrId === "object" ? chainSlugOrId : chainById(chainSlugOrId);
  if (!provider || !isConnected()) return false;
  const hex = hexChainId(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
    const unknownChain = code === 4902 || /unrecognized chain|not added/i.test(String(e && e.message));
    if (!unknownChain) {
      if (/rejected|denied/i.test(String(e && e.message))) return false;
      state.error = String((e && e.message) || e);
      emit();
      return false;
    }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: { name: chain.native.symbol, symbol: chain.native.symbol, decimals: chain.native.decimals },
          rpcUrls: [chain.rpcUrl],
          blockExplorerUrls: [chain.explorerAddr],
        }],
      });
    } catch (e2) {
      if (!/rejected|denied/i.test(String(e2 && e2.message))) {
        state.error = String((e2 && e2.message) || e2);
        emit();
      }
      return false;
    }
  }
  state.chainId = chain.chainId;
  emit();
  await refreshBalances();
  return true;
}

// Чтение балансов через провайдер кошелька: нативный - eth_getBalance, ERC-20 - balanceOf
// через eth_call (селектор 0x70a08231), decimals берём из конфига (в них и была ловушка BSC).
// Отправить транзакцию из кошелька ПОЛЬЗОВАТЕЛЯ и вернуть её хеш.
//
// Метод EIP-1193, один для WalletConnect и для браузерных кошельков: и те, и другие отдают
// провайдера с request(). Подпись происходит в кошельке, наш код ключей не касается.
//
// Вызов возвращается не сразу: пользователь подтверждает транзакцию в своём кошельке, и до этого
// момента промис висит. Вызывающий код обязан показать это в интерфейсе, иначе шаг выглядит зависшим.
//
// value передаётся как hex-строка (wei). Для вызова payable-функции эскроу (lock) сумма уходит в value,
// у самой функции аргументов нет; для createOrder у фабрики value не нужен вовсе.
// Прочитать контракт: вызов view-функции без транзакции и без газа.
//
// Нужен, чтобы узнать адрес эскроу ДО его создания (фабрика.predict) и чтобы читать состояние
// (эскроу.status) при опросе. Ключей не требует, кошелёк не спрашивает - только провайдер.
export async function readContract({ to, data } = {}) {
  if (!provider) throw new Error("кошелёк не подключён: читать контракт нечем");
  if (!to) throw new Error("не указан адрес контракта");
  if (!data) throw new Error("не указаны данные вызова");
  const result = await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error("неожиданный ответ на вызов контракта: " + String(result).slice(0, 60));
  }
  return result;
}

// КВИТАНЦИЯ ТРАНЗАКЦИИ. Нужна там, где хеша мало: у создания ордера в её событиях лежит ФАКТИЧЕСКИЙ адрес
// эскроу. Предсказанный адрес - это надежда (он зависит от соли и кода фабрики), а событие - факт.
// Читается тем же провайдером, что и вызовы контракта: второго способа обращаться к цепи не заводим.
// КОД КОНТРАКТА (eth_getCode). Нужен проверке кода фабрики (#103): extcodehash - это keccak256 от этого
// кода, и по нему интерфейс сверяет фабрику со списком известных сборок. eth_call сюда не годится: код
// читается ДРУГИМ методом, поэтому и функция отдельная.
export async function readCode({ address } = {}) {
  if (!provider) throw new Error("кошелёк не подключён: читать код контракта нечем");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error("не адрес для чтения кода: " + String(address));
  return await provider.request({ method: "eth_getCode", params: [address, "latest"] });
}

export async function readReceipt({ hash } = {}) {
  if (!provider) throw new Error("кошелёк не подключён: квитанцию читать нечем");
  if (!hash) throw new Error("не указан хеш транзакции");
  const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
  if (!r || typeof r !== "object") return null;      // ещё не в блоке - это НЕ ошибка, а ожидание
  return r;
}

export async function sendTransaction({ to, data, value = "0x0", gas } = {}) {
  if (!provider) throw new Error("кошелёк не подключён: отправлять нечем");
  if (!to) throw new Error("не указан адрес контракта");
  if (!data) throw new Error("не указаны данные вызова");
  const from = address();
  if (!from) throw new Error("кошелёк не подключён: нет адреса отправителя");
  const tx = { from, to, data, value: typeof value === "bigint" ? "0x" + value.toString(16) : value };
  if (gas) tx.gas = typeof gas === "bigint" ? "0x" + gas.toString(16) : gas;
  // КОМИССИЮ СЧИТАЕМ САМИ И ОДНИМ ПРАВИЛОМ. Формула (2 x baseFee + чаевые) вынесена в
  // www/js/evm/claimGas.js - в тот же модуль, по которому нода считает ПОДАРОК на claim. Второй расчёт
  // здесь разошёлся бы с подарком (issue #127). Пол чаевых - политика сети (Arbitrum: 0), не 1 gwei.
  try {
    const latest = await provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    const baseFee = latest && latest.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 0n;
    let priorityFeeWei = 0n;
    try {
      // Чаевые берём из eth_gasPrice: этот метод есть у любого провайдера. eth_maxPriorityFeePerGas
      // поддерживают не все, и MetaMask отвечает на него ошибкой -32601, которая лезет в консоль пользователя.
      const gp = await provider.request({ method: "eth_gasPrice", params: [] });
      if (typeof gp === "string" && /^0x[0-9a-fA-F]+$/.test(gp)) {
        const diff = BigInt(gp) - baseFee;
        if (diff > 0n) priorityFeeWei = diff;      // разница gasPrice - baseFee и есть чаевые
      }
    } catch { /* не подсказал - чаевые остаются нулевыми */ }
    const maxFee = claimMaxFeePerGasWei({ baseFeeWei: baseFee, priorityFeeWei });
    // maxFee === null значит сеть без EIP-1559 (baseFee = 0): поля не выставляем, решает кошелёк.
    if (maxFee !== null) {
      tx.maxPriorityFeePerGas = "0x" + (maxFee - baseFee * 2n).toString(16);
      tx.maxFeePerGas = "0x" + maxFee.toString(16);
    }
  } catch (feeErr) {
    // Не смогли посчитать - отдаём решение кошельку, как раньше. Молча падать из-за этого нельзя.
    console.warn("не удалось посчитать комиссию, решает кошелёк: " + ((feeErr && feeErr.message) || feeErr));
  }
  const hash = await provider.request({ method: "eth_sendTransaction", params: [tx] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("кошелёк вернул не хеш транзакции: " + String(hash).slice(0, 60));
  }
  return hash;
}

export async function refreshBalances() {
  if (!isConnected() || !provider) return;
  const chain = chainByChainId(state.chainId);
  if (!chain) {
    state.error = `Wallet is on chain ${state.chainId}, which this demo does not support`;
    emit();
    return;
  }
  const addr = state.address;
  const next = {};
  const reads = [
    [chain.native.symbol, null, chain.native.decimals, "eth_getBalance"],
  ];
  for (const t of chain.tokens) reads.push([t.symbol, t.address, t.decimals, null]);

  const results = await Promise.all(
    reads.map(async ([symbol, tokenAddress, decimals, method]) => {
      try {
        let raw;
        if (method === "eth_getBalance") {
          raw = await provider.request({ method, params: [addr, "latest"] });
        } else {
          const data = "0x70a08231" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
          raw = await provider.request({ method: "eth_call", params: [{ to: tokenAddress, data }, "latest"] });
        }
        return [symbol, toHuman(BigInt(raw), decimals)];
      } catch (e) {
        console.warn(`balance read failed for ${symbol}`, e);
        return [symbol, undefined];
      }
    }),
  );

  for (const [symbol, value] of results) {
    if (value !== undefined) next[`${chain.chainId}:${String(symbol).toUpperCase()}`] = value;
  }
  state.balances = { ...state.balances, ...next };
  state.lastRefresh = Date.now();
  state.error = null;
  emit();
}

export function tokensWithBalance(chainSlug) {
  const chain = chainById(chainSlug);
  return tokensOf(chain.id).map((t) => ({ ...t, balance: balanceOf(chain.id, t.symbol) }));
}
