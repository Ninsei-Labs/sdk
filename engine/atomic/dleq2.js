// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/dleq2.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// DLEQ между кривыми: доказательство, что за точками на secp256k1 и ed25519 стоит ОДИН скаляр.
// Перенос конструкции из github.com/athanorlabs/go-dleq (prove.go, verify.go) на @noble/curves.
// Разбор алгоритма: .hermes/docs/20-key-shares.md, разделы 14-16.
//
// ВЫЗОВ СЧИТАЕТСЯ ТАК ЖЕ, КАК В ОРИГИНАЛЕ: SHA3-512 И ШИРОКОЕ ПРИВЕДЕНИЕ. Прежняя редакция считала вызов
// keccak256, то есть 32 байта, и приводила их по модулю порядка - приведение было СМЕЩЕНО (около 2^-128) и
// отличалось от эталона; это названо аудитом (reports/audit-02/review_02-dleq2.md §5.1) и закрыто здесь.
// Теперь: хеш 64 байта, читается МЛАДШИМ БАЙТОМ ВПЕРЁД и приводится по модулю порядка - ровно то, что
// делает edwards25519 Scalar.SetUniformBytes в go-dleq (ed25519_curve.go, HashToScalar).
// СЛЕДСТВИЕ НАЗВАНО ПРЯМО: доказательства прежнего варианта не проходят, поэтому поднята версия контекста
// (arrakis-order-v3) - иначе живая котировка со старым доказательством молча ломалась бы.
//
// СТРОГАЯ ПРОВЕРКА ПОДГРУППЫ. У ed25519 кофактор 8, и точка может нести составляющую малого порядка:
// проверка «умножение на 8 не даёт ноль» её пропускает, а именно она делает равенства вырожденными.
// Проверяем строго: [l]*P = 0, то есть точка лежит в подгруппе простого порядка.
//
// ВАЖНО: примитивы аудированы (@noble/curves), ЭТА реализация - нет.

export function createDleq2({ ed25519, secp256k1, keccak256, sha3_512, randomBytes }) {
  // SHA3-512 ОБЯЗАТЕЛЕН: без него считать вызов нечем, а молчаливая подмена на keccak256 была бы ровно
  // той ошибкой, которую здесь закрывают. Отказ громкий и сразу.
  if (typeof sha3_512 !== "function") throw new Error("createDleq2: нужна функция sha3_512 (SHA3-512 из @noble/hashes)");
  const ED_ORDER = ed25519.Point.Fn.ORDER, SEC_ORDER = secp256k1.Point.Fn.ORDER;
  // Секрет живёт числом бит МЕНЬШЕГО порядка: так снимается ограничение ks < min(l, n).
  const BITS = Math.min(ED_ORDER.toString(2).length, SEC_ORDER.toString(2).length);

  const curves = {
    A: {
      name: "secp256k1", P: secp256k1.Point, order: SEC_ORDER,
      G: secp256k1.Point.BASE,
      Galt: secp256k1.Point.fromHex("0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"),
    },
    B: {
      name: "ed25519", P: ed25519.Point, order: ED_ORDER,
      G: ed25519.Point.BASE,
      Galt: ed25519.Point.fromHex("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94"),
    },
  };

  // ПРЕДВЫЧИСЛЕНИЯ ДЛЯ ВТОРОЙ БАЗОВОЙ ТОЧКИ. Она умножается в каждом бите четыре раза, плюс раз на
  // бит в обязательствах, то есть около тысячи раз на доказательство - и всё это время умножение шло
  // БЕЗ таблицы. Измерено (tools/measure-proof-components.mjs, отдельный замер предвычислений):
  //   без таблицы: 2,84 мс (secp256k1) и 2,86 мс (ed25519)
  //   W=8:         0,905 мс (3,1x) и 0,422 мс (6,8x); построение таблицы 226 мс, один раз на процесс
  // W=10 даёт ещё 13%, но построение втрое дороже (732 мс), а W=12 уже 2,4 с - на старте это заметно.
  // true означает ленивость: здесь только запоминается размер окна, таблица построится при первом
  // умножении. Поэтому импорт модуля не дорожает, а платит первый расчёт - и платит один раз.
  curves.A.Galt.precompute(8);
  curves.B.Galt.precompute(8);

  // КОНТЕКСТ ИДЁТ СЫРЫМИ БАЙТАМИ UTF-8. Прежний ctxHex собирал hex из charCodeAt и отдавал его в hexBytes:
  // для ASCII это ровно те же байты, но для любого символа выше 0x7F hex выходил длиннее двух цифр, hexBytes
  // резал его по чётности, и доказывающий с проверяющим могли посчитать РАЗНЫЕ вызовы. Канонический контекст
  // ордера - ASCII, поэтому живые котировки не меняются: это проверено сравнением байт (tools/check-dleq2.mjs).
  // Кодировщик свой, а не TextEncoder: он не требует глобального объекта в среде воркера страницы.
  const ctxUtf8 = (context) => {
    const t = String(context == null ? "" : context);
    const out = [];
    for (let i = 0; i < t.length; i++) {
      let c = t.codePointAt(i);
      if (c > 0xffff) i++;                                  // суррогатная пара: codePointAt уже вернул её целиком
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  const enc = (x) => (typeof x === "string" ? x : x.toHex ? x.toHex() : String(x));
  function hexBytes(h) {
    const s = h.replace(/^0x/, "");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  const bigToHex = (v) => v.toString(16).padStart(64, "0");
  function bytesToBig(b) { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; }
  // ЧТЕНИЕ МЛАДШИМ БАЙТОМ ВПЕРЁД - как у edwards25519 в эталоне. Это не стилистика: с обратным порядком
  // байт вызов получился бы другим, и доказательство не сошлось бы с реализацией на другой стороне.
  function bytesToBigLE(b) { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; }
  function concat(parts) {
    const t = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(t);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  // Вызов: один и тот же preimage, но приведение к скаляру - по правилам СВОЕЙ кривой.
  // ПРИВЯЗКА К ОРДЕРУ. Контекст (например, адрес эскроу и hashlock) входит в preimage вызова.
  // Без него доказательство можно было бы переиспользовать в другом ордере с той же половиной:
  // в вызове участвовали только точки и обязательства. Найдено при сверке документов, раздел 21.2.
  // Контекст ордера НЕ здесь: он уже входит в parts через сборку preimage (см. ctxUtf8). Одна механика
  // на обе стороны - иначе доказывающий и проверяющий считали бы вызов по-разному (так и вышло в первом
  // варианте правки: параметр был добавлен в сигнатуру, а подставлен в один вызов из двенадцати).
  function challenge(curve, parts) {
    const h = sha3_512(concat(parts.map((p) => (typeof p === "string" ? hexBytes(p) : p))));
    if (h.length !== 64) throw new Error("challenge: sha3_512 вернул " + h.length + " байт вместо 64");
    return bytesToBigLE(h) % curve.order;
  }
  // СЛУЧАЙНЫЙ СКАЛЯР - ТОЖЕ ШИРОКОЕ ПРИВЕДЕНИЕ: 64 случайных байта по модулю порядка, как NewRandomScalar
  // в эталоне. Прежний цикл брал 32 байта и отбраковывал всё, что не легло в порядок: смещение около
  // 2^-128 и лишние повторы. Ноль теоретически возможен (порядка 2^-252) и здесь заменяется единицей:
  // для обязательств это значит лишь ненулевую случайность, а не отказ.
  function randScalar(curve) {
    const v = bytesToBigLE(randomBytes(64)) % curve.order;
    return v === 0n ? 1n : v;
  }
  function bit(x, i) { return (x >> BigInt(i)) & 1n; }
  // Умножение на ПУБЛИЧНЫЙ скаляр. В доказательстве DLEQ все скаляры и так входят в само доказательство,
  // которое уходит контрагенту, поэтому постоянное время здесь не защищает ничего, а стоит дорого:
  // измерено multiply 3.1 мс против multiplyUnsafe 0.62 мс на ed25519 (3.5 против 0.78 на secp256k1).
  // На бит приходится около десятка умножений, и разница составляла основную часть тех 20 секунд.
  //
  // НОЛЬ ЗДЕСЬ ЗАКОНЕН. Это первое, что нужно знать об этой функции: нулевой бит даёт b*G при b=0, и
  // приведённый к нулю вызов тоже встречается. Прежний код возвращал в этом случае нейтральный элемент,
  // и это правильное поведение. Я однажды заменил его проверкой, которая бросала исключение, - и получил
  // падение на ровном месте, потому что комментарий прежнего кода не прочитал, а только переписал.
  // Ноль возвращает нейтральный элемент кривой, multiplyUnsafe(0) не вызывается вовсе: он бросает.
  function mPublic(curve, point, scalar) {
    // Скаляр приходит и числом, и hex-строкой: в доказательстве скаляры хранятся hex, чтобы переживать
    // JSON. Обе формы приводятся здесь, в одном месте.
    const raw = typeof scalar === "bigint" ? scalar : BigInt(scalar);
    const s = ((raw % curve.order) + curve.order) % curve.order;
    if (s === 0n) return curve.P.ZERO;
    // ТОЧКА С ТАБЛИЦЕЙ УМНОЖАЕТСЯ ЧЕРЕЗ multiply, остальные - через multiplyUnsafe. Это не взаимозаменяемо:
    // multiplyUnsafe таблицу не использует и на второй базовой точке остаётся втрое-вшестеро дороже, а
    // multiply БЕЗ таблицы, наоборот, дороже multiplyUnsafe (измерено 7,1 мс против 2,8). Поэтому выбор
    // привязан к конкретной точке, а не к удобству вызова.
    if (point === curve.Galt) return point.multiply(s);
    return point.multiplyUnsafe(s);
  }

  // Точка из скаляра на второй базовой точке кривой.
  function mul(curve, s, base) {
    return mPublic(curve, base || curve.G, typeof s === "bigint" ? s : BigInt(s));
  }
  const addP = (a, b) => a.add(b);
  const subP = (a, b) => a.subtract(b);
  const encP = (p) => hexBytes(p.toHex());
  const encS = (s) => hexBytes(bigToHex(s));

  // Обязательства по битам: C_i = b_i*G + r_i*G' , причём Σ r_i*2^i = 0, поэтому Σ C_i*2^i = x*G.
  function commitments(curve, x) {
    const rs = [], cs = [];
    let sum = 0n, pow = 1n;
    for (let i = 0; i < BITS; i++) {
      if (i === BITS - 1) {
        const inv = modInv(pow, curve.order);
        rs[i] = ((curve.order - (sum % curve.order)) * inv) % curve.order;
      } else {
        rs[i] = randScalar(curve);
        sum = (sum + rs[i] * pow) % curve.order;
        pow = (pow * 2n) % curve.order;
      }
      const b = bit(x, i);
      cs.push(addP(mul(curve, b), mul(curve, rs[i], curve.Galt)));
    }
    return { rs, cs };
  }
  function modInv(a, m) {
    let [old_r, r] = [a % m, m], [old_s, s] = [1n, 0n];
    while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
    if (old_r !== 1n) throw new Error("modInv: не обратим");
    return ((old_s % m) + m) % m;
  }
  function sumCommitments(curve, cs) {
    let sum = cs[0];
    for (let i = 1; i < cs.length; i++) sum = addP(sum, mul(curve, 2n ** BigInt(i) % curve.order, cs[i]));
    return sum;
  }

  // OR-доказательство «обязательство к 0 или к 1» для одного бита, по обеим кривым сразу.
  //
  // ПРИНИМАЕТ БИТ, А НЕ ПОЛОВИНУ, и это не украшательство: биту нужен ровно один бит половины и его
  // случайности. Из-за этого шаг САМОДОСТАТОЧЕН - ни половины, ни данных других битов он не требует, а
  // значит именно его можно отдать другому потоку, не передавая туда ключ целиком.
  function ringSig(bitValue, i, cA, cB, rA, rB, context) {
    const j = randScalar(curves.A), k = randScalar(curves.B);
    const pre = (p1, p2) => [ctxUtf8(context), encP(cA), encP(cB), encP(p1), encP(p2)];
    const eA = challenge(curves.A, pre(mul(curves.A, j, curves.A.Galt), mul(curves.B, k, curves.B.Galt)), context);
    const eB = challenge(curves.B, pre(mul(curves.A, j, curves.A.Galt), mul(curves.B, k, curves.B.Galt)), context);
    const b = bitValue === 1n || bitValue === 1 ? 1n : 0n;
    if (b === 0n) {
      const a0 = randScalar(curves.A), b0 = randScalar(curves.B);
      const cAm1 = subP(cA, curves.A.G), cBm1 = subP(cB, curves.B.G);
      const eA0 = challenge(curves.A, pre(subP(mul(curves.A, a0, curves.A.Galt), mPublic(curves.A, cAm1, eA)),
                                        subP(mul(curves.B, b0, curves.B.Galt), mPublic(curves.B, cBm1, eB))), context);
      const eB0 = challenge(curves.B, pre(subP(mul(curves.A, a0, curves.A.Galt), mPublic(curves.A, cAm1, eA)),
                                        subP(mul(curves.B, b0, curves.B.Galt), mPublic(curves.B, cBm1, eB))), context);
      return { eA: eA0, eB: eB0, a0, a1: (j + eA0 * rA) % curves.A.order, b0, b1: (k + eB0 * rB) % curves.B.order };
    }
    const a1 = randScalar(curves.A), b1 = randScalar(curves.B);
    const eA1 = challenge(curves.A, pre(subP(mul(curves.A, a1, curves.A.Galt), mPublic(curves.A, cA, eA)),
                                      subP(mul(curves.B, b1, curves.B.Galt), mPublic(curves.B, cB, eB))), context);
    const eB1 = challenge(curves.B, pre(subP(mul(curves.A, a1, curves.A.Galt), mPublic(curves.A, cA, eA)),
                                      subP(mul(curves.B, b1, curves.B.Galt), mPublic(curves.B, cB, eB))), context);
    return { eA, eB, a0: (j + eA1 * rA) % curves.A.order, a1, b0: (k + eB1 * rB) % curves.B.order, b1 };
  }

  // Скаляры уходят в hex: доказательство должно переживать JSON и границу потока - иначе его не передать.
  const sigOut = (s) => ({ eA: bigToHex(s.eA), eB: bigToHex(s.eB), a0: bigToHex(s.a0), a1: bigToHex(s.a1), b0: bigToHex(s.b0), b1: bigToHex(s.b1) });

  // ШАГ 1. ПОДГОТОВКА. Считается ПОСЛЕДОВАТЕЛЬНО и целиком: обязательства зависят от накопленной суммы
  // предыдущих, поэтому этот шаг не режется. Здесь же готовятся данные по каждому биту - ровно те, что
  // нужны шагу 2, и ничего сверх: сам бит, его обязательства и его случайности. ПОЛОВИНЫ ЗДЕСЬ БОЛЬШЕ НЕТ,
  // и это главное свойство: дальше её знать не требуется.
  function prepareProof(x, context) {
    const XA = mul(curves.A, x), XB = mul(curves.B, x);
    const cA = commitments(curves.A, x), cB = commitments(curves.B, x);
    const bits = [];
    for (let i = 0; i < BITS; i++) {
      bits.push({
        i,
        bit: bit(x, i) === 1n ? 1 : 0,
        cA: enc(cA.cs[i]), cB: enc(cB.cs[i]),
        rA: bigToHex(cA.rs[i]), rB: bigToHex(cB.rs[i]),
      });
    }
    return { XA: enc(XA), XB: enc(XB), context: String(context == null ? "" : context), bits };
  }

  // ШАГ 2. ДОКАЗАТЕЛЬСТВО ОДНОГО БИТА. Вызывается на подготовленных данных, самостоятелен и ничего не
  // знает ни о половине, ни о других битах. Из-за этого шаги независимы, а значит и распараллеливаемы.
  function proveBit(part, context) {
    const sig = ringSig(part.bit === 1 ? 1n : 0n, part.i,
      curves.A.P.fromHex(String(part.cA).replace(/^0x/, "")),
      curves.B.P.fromHex(String(part.cB).replace(/^0x/, "")),
      BigInt("0x" + String(part.rA).replace(/^0x/, "")),
      BigInt("0x" + String(part.rB).replace(/^0x/, "")),
      context);
    return { i: part.i, cA: part.cA, cB: part.cB, sig: sigOut(sig) };
  }

  // ШАГ 3. СБОРКА. Складывать нечего: порядок частей и есть порядок битов, и он проверяется ниже.
  function assembleProof(prepared, parts) {
    const byIndex = new Map(parts.map((p) => [p.i, p]));
    const proofs = [];
    for (let i = 0; i < BITS; i++) {
      const item = byIndex.get(i);
      if (!item) throw new Error("assembleProof: нет части для бита " + i);
      proofs.push({ cA: item.cA, cB: item.cB, sig: item.sig });
    }
    return { XA: prepared.XA, XB: prepared.XB, proofs };
  }

  // prove ОСТАЁТСЯ ТОЙ ЖЕ ФУНКЦИЕЙ и собрана из тех же трёх шагов: второй реализации одного и того же
  // здесь не появилось - иначе проверки гоняли бы один код, а работал другой.
  function prove(x, context, onBit) {
    const prepared = prepareProof(x, context);
    const parts = [];
    for (let i = 0; i < BITS; i++) {
      // Прогресс по ходу счёта. 253 бита - это те самые десять секунд, и без промежуточных сообщений
      // интерфейс не может показать, что работа идёт, а не встала. Сообщаем каждые 16 бит и на последнем.
      if (onBit && (i % 16 === 0 || i === BITS - 1)) onBit(i + 1, BITS);
      parts.push(proveBit(prepared.bits[i], prepared.context));
    }
    return assembleProof(prepared, parts);
  }

  // СТРОГАЯ ПРОВЕРКА ПОДГРУППЫ, А НЕ ТОЛЬКО МАЛОГО ПОРЯДКА. Прежняя редакция проверяла [8]*P != 0:
  // точку ЧИСТО малого порядка она отвергала, а точку с малой СОСТАВЛЯЮЩЕЙ (P = Q + T, где T порядка 2, 4
  // или 8) пропускала - и вырожденное равенство проходило. Строгое условие: [l]*P = 0, где l - порядок
  // подгруппы. secp256k1 не проверяется: у неё кофактор 1, и вся группа простого порядка.
  function torsionFree(curve, point) {
    if (curve.name !== "ed25519") return true;
    // ЧТО ИМЕННО ЗДЕСЬ СЧИТАЕТСЯ. isTorsionFree() у @noble/curves - это ровно [n]*P = 0 (проверено по
    // исходнику пакета: wnaf.mulUnsafe(this, CURVE.n).is0()), то есть точка лежит в подгруппе простого
    // порядка. Своя попытка записать это через multiplyUnsafe(order) ПАДАЕТ: библиотека требует скаляр
    // меньше порядка и на самом порядке бросает - то есть слагаемое проверки выглядело бы как отказ.
    try { return point.isTorsionFree() === true; } catch { return false; }
  }
  // ФОРМА ПРОВЕРЯЕТСЯ ДО СЧЁТА. Прежний цикл шёл по длине присланного списка: короткое доказательство
  // доказывало ДРУГОЕ представление, длинное - жгло время проверки (доказательство ~145 КБ и так считается
  // секундами). Честный путь всегда шлёт ровно BITS частей. Неразбираемое поле возвращает отказ, а не
  // исключение наружу: вызывающий обязан получать {ok:false}, а не падать.
  function verify(proof, context) {
    if (!proof || typeof proof !== "object") return { ok: false, reason: "доказательство: ожидается объект" };
    if (typeof proof.XA !== "string" || typeof proof.XB !== "string") return { ok: false, reason: "доказательство: нет XA или XB" };
    if (!Array.isArray(proof.proofs)) return { ok: false, reason: "доказательство: нет списка частей" };
    if (proof.proofs.length !== BITS) return { ok: false, reason: "доказательство: частей " + proof.proofs.length + ", а нужно " + BITS };
    const P = (curve, h) => curve.P.fromHex(String(h).replace(/^0x/, ""));
    let XA, XB, csA, csB;
    try {
      XA = P(curves.A, proof.XA); XB = P(curves.B, proof.XB);
      if (!torsionFree(curves.B, XB)) return { ok: false, reason: "доказательство: XB не лежит в подгруппе простого порядка" };
    } catch (e) {
      return { ok: false, reason: "доказательство: XA или XB не разбирается (" + String((e && e.message) || e) + ")" };
    }
    // НОМЕР БИТА НАЗЫВАЕТСЯ И ЗДЕСЬ: без него отказ «где-то в доказательстве» неотличим от порчи любого из
    // 253 обязательств, а разбирать 145 КБ руками никто не станет.
    try {
      csA = proof.proofs.map((item, i) => {
        try { return P(curves.A, item.cA); } catch (e) { throw new Error("бит " + i + ": " + String((e && e.message) || e)); }
      });
      csB = proof.proofs.map((item, i) => {
        try { return P(curves.B, item.cB); } catch (e) { throw new Error("бит " + i + ": " + String((e && e.message) || e)); }
      });
    } catch (e) {
      return { ok: false, reason: "доказательство: " + String((e && e.message) || e) };
    }
    if (!sumCommitments(curves.A, csA).equals(XA)) return { ok: false, reason: "сумма обязательств не даёт X на secp256k1" };
    if (!sumCommitments(curves.B, csB).equals(XB)) return { ok: false, reason: "сумма обязательств не даёт X на ed25519" };
    for (let i = 0; i < proof.proofs.length; i++) {
      const item = proof.proofs[i];
      try {
        if (!torsionFree(curves.B, csB[i])) return { ok: false, reason: "бит " + i + ": обязательство не лежит в подгруппе простого порядка" };
        const cA = item.cA, cB = item.cB;
        const sig = Object.fromEntries(Object.entries(item.sig).map(([k, v]) => [k, BigInt(String(v).startsWith("0x") ? v : "0x" + v)]));
        const pA = P(curves.A, cA), pB = P(curves.B, cB);
        const pre = (q1, q2) => [ctxUtf8(context), encP(pA), encP(pB), encP(q1), encP(q2)];
        const aG = mul(curves.A, sig.a1, curves.A.Galt), eCA = mPublic(curves.A, pA, sig.eA);
        const bH = mul(curves.B, sig.b1, curves.B.Galt), eCB = mPublic(curves.B, pB, sig.eB);
        const eA = challenge(curves.A, pre(subP(aG, eCA), subP(bH, eCB)), context);
        const eB = challenge(curves.B, pre(subP(aG, eCA), subP(bH, eCB)), context);
        const aG0 = mul(curves.A, sig.a0, curves.A.Galt), ecA = mPublic(curves.A, subP(pA, curves.A.G), eA);
        const bH0 = mul(curves.B, sig.b0, curves.B.Galt), ecB = mPublic(curves.B, subP(pB, curves.B.G), eB);
        const eA0 = challenge(curves.A, pre(subP(aG0, ecA), subP(bH0, ecB)), context);
        const eB0 = challenge(curves.B, pre(subP(aG0, ecA), subP(bH0, ecB)), context);
        if (eA0 !== sig.eA || eB0 !== sig.eB) return { ok: false, reason: "бит " + i + ": вызовы не сошлись" };
      } catch (e) {
        return { ok: false, reason: "бит " + i + ": поля не разбираются (" + String((e && e.message) || e) + ")" };
      }
    }
    return { ok: true };
  }

  return { BITS, curves, prove, verify, prepareProof, proveBit, assembleProof, torsionFree };
}
