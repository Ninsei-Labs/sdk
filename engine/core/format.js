// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/format.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Форматирование чисел, времени и адресов.

const nf = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

export function amount(v, dp = 2) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  const max = Math.min(dp, 6);
  // ПЫЛЬ НЕ ИСЧЕЗАЕТ. Раньше печать была жёстко «шесть знаков», и сумма меньше 0.000001 показывалась как
  // 0.000000 - то есть ненулевое значение выглядело нулём. Для денег это худший вид отображения: человек
  // видит ноль там, где у него что-то есть. Знаки добавляются ровно в том случае, когда печать обнулила
  // ненулевое, и не больше 18 (предел точности wei).
  if (n !== 0 && Math.abs(n) < Math.pow(10, -max)) {
    const need = Math.min(18, Math.max(max + 1, -Math.floor(Math.log10(Math.abs(n)))));
    return nf(need, need).format(n).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  return nf(max, max).format(n);
}


export function usd(v) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  return "$" + nf(0, Math.abs(n) < 100 ? 2 : 0).format(n);
}

export function pct(v, dp = 2) {
  return (Number(v) * 100).toFixed(dp) + "%";
}

export function compact(v) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

export function shortHash(h, head = 6, tail = 4) {
  if (!h) return "-";
  const s = String(h);
  if (s.length <= head + tail + 2) return s;
  return s.slice(0, head) + "..." + s.slice(-tail);
}

// sim-время -> настенные часы демки (UTC, как в макетах литпепера)
export function clockTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function clockTimeShort(ms) {
  return clockTime(ms).slice(0, 5);
}

// Длительность в секундах -> "12m 30s"
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function countdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function dateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

// Байты (Uint8Array/Buffer) -> hex-строка без префикса 0x.
export function toHex(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// РАЗБОР СУММЫ, КОТОРУЮ ВВЁЛ ЧЕЛОВЕК.
//
// ПОЧЕМУ ЭТО ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ replace ПРЯМО В ПОЛЕ. В полях суммы стояло
// `e.target.value.replace(/[^0-9.]/g, "")`: всё, кроме цифр и точки, СТИРАЛОСЬ. Европейская запятая
// ("0,05" - так пишут в половине стран) превращалась в "005", то есть в 5 - ошибка в СТО РАЗ, и заметить её
// в интерфейсе почти невозможно: поле показывает "005", котировка считается по пяти, человек платит в сто
// раз больше. Запятая без точки - десятичный разделитель, запятая при наличии точки - разделитель тысяч;
// так же это делают кошельки Monero.
//
// Возвращает КАНОНИЧЕСКУЮ строку (только цифры и максимум одна точка). Именно её видно в поле и именно её
// парсит остальной код - поэтому «что написано» и «что посчитано» не могут разойтись.
export function normalizeAmountInput(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/[^0-9.,]/g, "");
  if (s.includes(".")) {
    // Точка есть - запятые разделяют тысячи ("1,234.5" -> "1234.5").
    s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    // Одна запятая без точки - десятичный разделитель ("0,05" -> "0.05"). Всё, что стоит ПОСЛЕ второй
    // запятой, отбрасываем: угадывать, что "1,2,3" значило 123, значит на опечатке увеличить платёж в сто раз.
    const i = s.indexOf(",");
    const rest = s.slice(i + 1);
    const cut = rest.indexOf(",");
    s = s.slice(0, i) + "." + (cut < 0 ? rest : rest.slice(0, cut));
  }
  // Вторая точка - тоже опечатка, и хвост за ней отбрасывается, а не склеивается с числом ("1.2.3" -> "1.2").
  const dot = s.indexOf(".");
  if (dot >= 0) {
    const rest = s.slice(dot + 1);
    const cut = rest.indexOf(".");
    s = s.slice(0, dot + 1) + (cut < 0 ? rest : rest.slice(0, cut));
  }
  s = s.replace(/^0+(?=\d)/, "");                     // "005" -> "5", но "0.5" не трогаем
  if (!/[0-9]/.test(s)) return "";
  return s;
}

/** Число из введённого человеком или null, если числа там нет. Никаких «догадок»: пусто - значит пусто. */
export function parseAmount(raw) {
  const s = normalizeAmountInput(raw);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function shortId() {
  // 16 hex-символов (8 байт = 2^64). Раньше было 4 символа (randomHex(2)): при 100 000 сделок совпадение
  // практически неизбежно - 68.8% на 8 символах и 100% на 4, - а id служит ключом в состоянии и именем файла
  // восстановления, поэтому совпадение означало бы потерю записи, за которой стоят средства.
  // ВАЖНО: у уже созданных сделок id остаются короткими. Переименовывать их нельзя: id лежит в файле
  // восстановления, в ссылках и в состоянии - они бы разъехались.
  return randomHex(8);
}

// БЫСТРАЯ ПРИКИДКА ФОРМЫ Monero-адреса: base58, длина 95 (обычный) / 106 (integrated), префикс сети.
//
// ЧЕГО ЭТА ФУНКЦИЯ НЕ ДЕЛАЕТ: НЕ ПРОВЕРЯЕТ КОНТРОЛЬНУЮ СУММУ. Любая опечатка внутри адреса пройдёт здесь
// незамеченной. Раньше она называлась isValidMoneroAddress - и это имя было ловушкой: функция, которую
// зовут "проверкой адреса", но которая пропускает опечатку, рано или поздно попадает на путь денег.
//
// НАСТОЯЩАЯ ПРОВЕРКА - checkAddress() из ../monero/address.js: формат + разбор base58 + keccak256-контрольная
// сумма + совпадение сети. Именно её зовёт форма. Здесь - только чтобы отсеять явный мусор до тяжёлого разбора.
export function looksLikeMoneroAddress(addr) {
  const a = String(addr || "").trim();
  if (![95, 106].includes(a.length)) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
  return ["4", "5", "7", "8", "9", "A", "B"].includes(a[0]);
}

