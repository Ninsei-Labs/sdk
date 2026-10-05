// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/amounts.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Пересчёт балансов из «сырых» единиц контракта в человекочитаемые.
//
// Отдельным модулем, потому что это денежная математика и её надо проверять без браузера:
// правильность decimals - самая частая ошибка EVM-кошельков (у USDT/USDC на BSC их 18, а не 6),
// а цена ошибки - баланс, отличающийся на 10^12. Проверка живёт в tools/validate.mjs (npm test),
// поэтому она гоняется и в CI, и локально.

// BigInt (сырые единицы) -> число с точкой.
//
// Делим как Number, а не целочисленно: вариант "raw * 1e6 / 10^dec" съедал мелкие значения -
// 55000 wei при 18 decimals превращались ровно в 0, и демка показывала пустой баланс там, где
// деньги есть (поймано проверкой на конкретных числах). Точности double достаточно: 15-16
// значащих цифр против 6 знаков после точки, которые показывает интерфейс.
export function toHuman(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

// Убирает хвостовые нули у строки с точкой: "12.180000" -> "12.18".
// Точка обязательна: у "1000" хвостовые нули трогать нельзя.
export function trimTrailingZeros(text) {
  const s = String(text);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

// Сумма для показа и для кнопки MAX: усечение (не округление) и не больше 6 знаков после точки.
//
// Почему усечение: MAX не имеет права подставить сумму больше реального баланса - иначе форма
// справедливо ответит "Not enough ...", и кнопка MAX приведёт в тупик. Округление вверх как раз
// это и делало: 0.0399187 -> 0.039919 > баланса.
// Почему 6 знаков: человеческая точность, и ровно столько же показывает подсказка с балансом.
// Возвращает ЧИСЛО (для сравнений); строку для поля ввода даёт amountInputValue ниже.
export function floorAmount(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const scaled = Math.floor(n * 10 ** decimals);
  if (scaled > 0) return scaled / 10 ** decimals;
  // Меньше 10^-decimals: это пыль. Отдаём значение целиком (точность до 18 знаков), чтобы
  // MAX не подставил 0.0000001 вместо 0.000000123 - то есть не отбросил баланс почти целиком.
  return Math.floor(n * 1e18) / 1e18;
}

// Строка для поля ввода и для подсказки с балансом: одна и та же функция, поэтому MAX
// подставляет ровно то число, которое видит пользователь.
//
// toFixed, а не String(): String(1.23e-7) даёт "1e-7", а поле ввода принимает только цифры
// и точку - "1e-7" превратилось бы в "17" (это поймано проверкой, а не пользователем).
export function amountInputValue(value, decimals = 6) {
  // Сначала усекаем, потом форматируем: toFixed САМ округляет, и без усечения получалось
  // 0.039919 - то есть больше баланса, и MAX упирался в "Not enough ...".
  const cut = floorAmount(value, decimals);
  if (!Number.isFinite(cut) || cut <= 0) return "0";
  // Для пыли печатаем все знаки: иначе toFixed округлил бы до первого ненулевого разряда.
  const d = cut >= 10 ** -decimals ? decimals : 18;
  return trimTrailingZeros(cut.toFixed(d));
}

// Набор случаев для проверки: [сырое значение, decimals, ожидаемое].
// 6 decimals - USDT/USDC на Ethereum, Arbitrum, Base; 18 - на BNB Chain и у нативных токенов.
// Ожидания сверены арифметикой вручную: 1 единица при 18 decimals это 1e-18, поэтому
// 55000 wei - это 5.5e-14, а не 0.000055 (последнее - это 5.5e13 wei).
export const AMOUNT_CASES = [
  [12345678900n, 6, 12345.6789], // USDC, 6 decimals
  [108275582n, 6, 108.275582], // реальный баланс, снятый с Arbitrum
  [10n ** 18n, 18, 1], // 1 ETH
  [1500000000000000000n, 18, 1.5], // 1.5 ETH
  [55000000000000n, 18, 0.000055], // 0.000055 ETH - на экране видно, но старое округление врало
  [55000n, 18, 5.5e-14], // пыль: старая формула давала ровно 0 (тихая потеря)
  [3120000000000000000000n, 18, 3120], // 3120 BNB
  [0n, 18, 0], // пустой кошелёк
];

// Случаи для показа баланса и MAX: [баланс, ожидаемая строка].
// Первый - ровно то, на что жаловался пользователь: 0.03991877164758065 попадало в поле целиком.
export const MAX_CASES = [
  [0.03991877164758065, "0.039918"], // тот самый ETH: 6 знаков, как в подсказке
  [0.0399187, "0.039918"], // усечение вниз, а не округление вверх до 0.039919
  [12431.18, "12431.18"], // стейбл: хвостовых нулей нет
  [3.4125, "3.4125"],
  [1, "1"],
  [0.000000123, "0.000000123"], // пыль: ни нуля, ни экспоненты "1e-7"
  [0, "0"],
];

export const TRIM_CASES = [
  ["12,431.180000", "12,431.18"],
  ["0.039918", "0.039918"],
  ["1.000000", "1"],
  ["1000", "1000"],
  ["0.000000", "0"],
];

// Поле ввода принимает только цифры и точку (см. oninput в swapForm.js). Если строка этому
// не удовлетворяет, поле молча превратит её в другое число - поэтому проверяем и это.
const INPUT_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

export function checkAmounts({ tolerance = 1e-9 } = {}) {
  const failures = [];

  for (const [raw, decimals, expected] of AMOUNT_CASES) {
    const got = toHuman(raw, decimals);
    if (!Number.isFinite(got) || Math.abs(got - expected) > tolerance) {
      failures.push(`${raw} при ${decimals} decimals -> ${got}, ожидалось ${expected}`);
    }
  }

  for (const [balance, expected] of MAX_CASES) {
    const got = amountInputValue(balance);
    if (got !== expected) {
      failures.push(`MAX при балансе ${balance} -> "${got}", ожидалось "${expected}"`);
    }
    if (!INPUT_PATTERN.test(got)) {
      failures.push(`MAX при балансе ${balance} дал "${got}" - поле ввода такое значение исказит`);
    }
    // Главное свойство MAX: подставленная сумма НЕ больше баланса.
    if (floorAmount(balance) > balance) {
      failures.push(`MAX при балансе ${balance} подставил больше баланса: ${floorAmount(balance)}`);
    }
  }

  for (const [input, expected] of TRIM_CASES) {
    const got = trimTrailingZeros(input);
    if (got !== expected) failures.push(`показ баланса "${input}" -> "${got}", ожидалось "${expected}"`);
  }

  return failures;
}
