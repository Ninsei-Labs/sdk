// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/prices.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Живые рыночные числа для EVM-ноги: цена нейтива (Chainlink on-chain) и стоимость газа (RPC).
//
// ПОЧЕМУ ON-CHAIN, А НЕ API. Цена берётся вызовом контракта через тот же RPC, что уже разрешён
// в CSP (`connect-src`), поэтому:
//   - не появляется ни одного нового внешнего домена (и ни одного нового доверенного сервиса);
//   - нет ключей, лимитов и «мы упали, потому что у CoinGecko 429»;
//   - значение нельзя перепутать с ценой другой сети: адрес фида свой у каждой цепи.
// Адреса фидов НЕ выдуманы: каждый подтверждён вызовом в сети - описание `description()` должно
// совпасть с ожидаемой парой, а ответ - попасть в разумный коридор и быть свежим. Проверка живёт
// в tools/check-prices.mjs (работает на заглушке RPC, без сети).
//
// ЧЕГО ЗДЕСЬ НЕТ: если фида для сети нет или он молчит - возвращаем null, и вызывающий код обязан
// показать, что число демонстрационное, а не подставить вчерашнюю константу молча.

const SELECTOR = {
  description: "0x7284e416", // description()
  latestRoundData: "0xfeaf968c", // latestRoundData() -> (roundId, answer, startedAt, updatedAt, answeredInRound)
};

const CACHE_MS = 60_000; // цена: минута - компромисс между свежестью и числом запросов
const GAS_CACHE_MS = 30_000; // газ меняется чаще, но и он не обязан бегать на каждый ввод символа
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // старше суток фид считаем несвежим и не показываем как живой

const cache = new Map(); // ключ: chainId + вид запроса

function cached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return undefined;
}

function put(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function rpc(chain, method, params = []) {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(method + ": HTTP " + res.status);
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + (j.error.message || "ошибка RPC"));
  return j.result;
}

const word = (data, i) => BigInt("0x" + String(data).slice(2).slice(i * 64, (i + 1) * 64));

// Декодирование строки ABI: [offset][length][bytes]. Нужно, чтобы отличить фид ETH/USD от любого
// другого, который кто-то подставил в конфиг. TextDecoder, а не Buffer: этот код живёт в браузере.
function decodeString(data) {
  const s = String(data || "");
  if (s.length < 2 + 128) return "";
  const len = Number(BigInt("0x" + s.slice(2 + 64, 2 + 128)));
  const body = s.slice(2 + 128, 2 + 128 + len * 2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

// Цена нейтива в USD. null - если фида нет, он молчит или значения не проходят проверку.
export async function nativeUsd(chain, { force = false } = {}) {
  const feed = chain && chain.priceFeed;
  if (!feed || !feed.address) return null;
  const key = chain.id + ":usd";
  if (!force) {
    const hit = cached(key, CACHE_MS);
    if (hit !== undefined) return hit;
  }
  try {
    const [descHex, roundHex] = await Promise.all([
      rpc(chain, "eth_call", [{ to: feed.address, data: SELECTOR.description }, "latest"]),
      rpc(chain, "eth_call", [{ to: feed.address, data: SELECTOR.latestRoundData }, "latest"]),
    ]);
    const desc = decodeString(descHex);
    const answer = word(roundHex, 1);
    const updatedAt = Number(word(roundHex, 3)) * 1000;
    const decimals = Number(feed.decimals || 8);
    const value = Number(answer) / 10 ** decimals;
    const fresh = updatedAt > 0 && Date.now() - updatedAt < MAX_AGE_MS;
    const sane = value >= (feed.min || 0.01) && value <= (feed.max || 1e7);
    if (desc !== feed.pair || !fresh || !sane) {
      return put(key, null); // null, а не «примерно столько»: молчание честнее выдумки
    }
    return put(key, { usd: value, updatedAt, source: "chainlink", pair: desc });
  } catch {
    return put(key, null);
  }
}

// Стоимость газа в USD: оценка лимита × цена газа × цена нейтива.
// На Arbitrum в цену газа уже входит L1-составляющая (так устроен их gas price), поэтому
// отдельный вызов NodeInterface не нужен - обычная оценка даёт сопоставимую с кошельками цифру.
export async function gasUsd(chain, { from = null, payToken = null, amountWei = null } = {}) {
  const key = chain.id + ":gas";
  const hit = cached(key, GAS_CACHE_MS);
  if (hit !== undefined) return hit;
  const price = await nativeUsd(chain);
  if (!price) return put(key, null);
  try {
    const gasPrice = BigInt(await rpc(chain, "eth_gasPrice"));
    let gasLimit = null;
    let measured = false;
    // Оцениваем ту транзакцию, которую человек и подпишет: перевод оплачиваемого токена.
    // Эскроу ещё не задеплоен, поэтому это честная нижняя оценка, а не «газ свопа».
    try {
      // Без аккаунта eth_estimateGas подставляет НУЛЕВОЙ адрес, и перевод токена справедливо
      // падает с "ERC20: transfer from the zero address". Поэтому без from не оцениваем вовсе:
      // берём типовой лимит и честно помечаем, что он не измерен (в интерфейсе это видно).
      // ВАЖНО: признак "перевод токена" и признак "есть аккаунт" - РАЗНЫЕ условия. Раньше они
      // были слиты в одну ветку, и без аккаунта перевод токена получал лимит нативного перевода
      // (21000 вместо 65000) - поймал tools/check-prices.mjs.
      const tokenTransfer = Boolean(payToken && !payToken.native);
      if (tokenTransfer && from) {
        // transfer(address,uint256) = 0xa9059cbb
        const to = String(from || "").replace(/^0x/, "").padStart(64, "0");
        const value = BigInt(amountWei || 1).toString(16).padStart(64, "0");
        gasLimit = BigInt(await rpc(chain, "eth_estimateGas", [{ from, to: payToken.address, data: "0xa9059cbb" + to + value }]));
        measured = true;
      } else if (from) {
        gasLimit = BigInt(await rpc(chain, "eth_estimateGas", [{ from, to: from, value: "0x1" }]));
        measured = true;
      } else {
        // Ни аккаунта, ни измерения: типовой лимит и честный признак «не измерено».
        gasLimit = BigInt(chain.gasLimitFallback || (tokenTransfer ? 65000 : 21000));
      }
    } catch {
      gasLimit = BigInt(chain.gasLimitFallback || (tokenTransfer ? 65000 : 21000));
    }
    const wei = gasPrice * gasLimit;
    const usd = (Number(wei) / 1e18) * price.usd;
    return put(key, { usd, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), native: price, source: "rpc", measured });
  } catch {
    return put(key, null);
  }
}

// Одна точка обновления: подтянуть цену и газ для сети и вернуть то, чем можно подписать интерфейс.
export async function refreshChainPrices(chain, opts = {}) {
  if (!chain || !chain.rpcUrl) return { nativeUsd: null, gasUsd: null, source: "none" };
  const [price, gas] = await Promise.all([nativeUsd(chain), gasUsd(chain, opts)]);
  // Цена нейтива - общая для всех расчётов сети (балансы, «≈ $», оценка газа), поэтому пишем её
  // в конфиг сети: иначе одна и та же цифра жила бы в двух местах и разъезжалась.
  if (price && Number.isFinite(price.usd)) chain.native.usd = price.usd;
  return {
    nativeUsd: price ? price.usd : null,
    nativeUpdatedAt: price ? price.updatedAt : null,
    gasUsd: gas ? gas.usd : null,
    // ЦЕНА ГАЗА В ВЕЙ - НАРУЖУ, А НЕ ТОЛЬКО СТОИМОСТЬ ОЦЕНКИ. Из неё считается запас газа на действия ордера
    // (www/js/evm/gasReserve.js): отметка готовности и возврат - другие транзакции, у них свои пределы, и
    // «стоимость одной оценки» их не заменяет. Нет газа у цепи - null, и вызывающий обязан сказать, что запас
    // не измерен, а не подставить ноль.
    gasPriceWei: gas ? gas.gasPrice : null,
    gasSource: gas ? gas.source : null,
    gasMeasured: gas ? Boolean(gas.measured) : false,
    source: price ? "chainlink" : "demo",
  };
}

// Коротко и в одну строку, но про ОБЕ половины: строка называется «Gas & price», значит и газ,
// и цена должны быть в значении. Живая цена видна по самому тексту (Chainlink), демо - по «demo values».
export function priceLabel(info) {
  if (!info || !info.source || info.source === "none") return "demo values";
  if (info.source !== "chainlink") return "demo values";
  const when = info.nativeUpdatedAt ? new Date(info.nativeUpdatedAt).toISOString().slice(11, 16) : "?";
  const gas = info.gasMeasured ? "gas by RPC" : "gas estimate";
  return gas + ", price by Chainlink at " + when + " UTC";
}

export function resetPriceCache() {
  cache.clear();
}
