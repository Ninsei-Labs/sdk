// Воркер: считает сторону ордера ВНЕ главного потока.
//
// Зачем он нужен, если он ничего не ускоряет. Доказательство DLEQ в JS занимает около 11 секунд
// (измерено; разбор половин ключа). Если считать его в главном потоке, страница
// замирает целиком - вместе с любым индикатором прогресса, который на ней нарисован. Воркер не делает
// счёт быстрее ни на миллисекунду: он делает его невидимым для интерфейса. Пока воркер считает, страница
// жива и может честно показывать, что происходит.
//
// Протокол: { id, type, ...аргументы } -> { id, kind: "progress"|"done"|"error", ... }
import {
  createOrderBuilder, ed25519, secp256k1, keccak256, sha3_512, randomBytes,
} from "../../assets/vendors/atomic/atomic-browser.js";

const builder = createOrderBuilder({ ed25519, secp256k1, keccak256, sha3_512, randomBytes });

// THE COMMITMENT THE CONTRACT WILL COMPARE, DERIVED FROM THE PROVEN POINT. The worker's vendored builder can check
// the DLEQ equation, but its verifySide did not compare the proven secp256k1 point with the quote's commitment.
// engine/atomic/order.js carries that comparison; this worker runs the prebuilt bundle, so the same comparison is
// made here from the bundle's own secp256k1 and keccak256. A proof that is valid for another point must not build a
// side that funding then signs.
const commitmentOfPoint = (value) => {
  try {
    const point = secp256k1.Point.fromHex(String(value || "").replace(/^0x/i, ""));
    const xy = point.toBytes(false).slice(1);
    return "0x" + Array.from(keccak256(xy), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
};
const low160 = (value) => String(value || "").replace(/^0x/i, "").toLowerCase().slice(-40);

// Ключи шифрования построенных сторон: приватный ключ по своему публичному. Наружу приватные не уходят -
// вскрытие посылки происходит здесь.
//
// ПОЧЕМУ КАРТА, А НЕ ОДНА ПЕРЕМЕННАЯ. Сторон в ордере две, и посылка шифруется на ключ КОНКРЕТНОЙ стороны.
// Одна переменная хранила ключ последней построенной стороны, поэтому посылка вскрывалась не тем ключом, и
// проверка честно отвечала "в шифртексте не та половина". Теперь ключ находится по публичному.
const encPrivByPub = new Map();

// Кому зашифрована посылка в данном контексте ордера. Контекст - идентификатор стороны.
const sealedToPub = new Map();

const canon = (h) => "0x" + String(h || "").replace(/^0x/i, "").toLowerCase();

self.onmessage = async (event) => {
  const { id, type, orderContext, ownHalf, counterparty, sealedBytes, joint } = event.data || {};
  const say = (stage, detail) => self.postMessage({ id, kind: "progress", stage, detail });
  try {
    if (type === "newSide") {
      // Половина генерируется мгновенно, а доказательство считается долго: сообщаем оба этапа
      // раздельно, чтобы интерфейс успел показать первый до начала второго.
      say("half", "генерирую половину ключа");
      // Текст идёт НА КНОПКУ: она неактивна во время доказательства, и это единственное место, куда
      // смотрит пользователь. Поэтому коротко и на языке интерфейса.
      say("proof", "proving DLEQ proof: about 10 seconds");
      const side = builder.newSide(orderContext, false, (bit, total) => {
        say("proof", "proving DLEQ proof: " + bit + " of " + total + " bits (" +
          Math.round((bit / total) * 100) + "%)");
      });
      // Hex-поля отдаём в каноническом виде (с префиксом 0x, нижний регистр), как это делает seal():
      // иначе одни и те же байты гуляют по коду в двух записях, и однажды это даёт ошибку в другом месте.
      const canon = (h) => "0x" + String(h).replace(/^0x/i, "").toLowerCase();
      // Ключ кладём в карту по публичному: он понадобится, если посылка шифруется на эту сторону.
      encPrivByPub.set(canon(side.enc.pub), side.enc.priv);
      self.postMessage({
        id, kind: "done",
        result: {
          pub: { ed: canon(side.pub.ed), secp: canon(side.pub.secp) },
          encPub: canon(side.enc.pub),
          proof: side.proof,
          half: side.half,   // BigInt: структурное клонирование переносит его без потерь
      // ПОЛОВИНА ПРОСМОТРА ТОЖЕ УХОДИТ НАРУЖУ. Без неё сборка общего адреса падала на «не задано:
      // ownViewHalf»: воркер возвращал только половину КЛЮЧА ТРАТЫ, а вызывающий код брал из ответа обе.
      // Сторона их создаёт (order.js: newSide), терялся именно ответ воркера.
      viewHalf: side.viewHalf,
      viewPub: canon(side.viewPub),
        },
      });
    } else if (type === "seal") {
      say("seal", "шифрую половину для контрагента");
      // Запоминаем, на чей ключ зашифровали: именно им и надо будет вскрывать.
      sealedToPub.set(String(orderContext), canon(counterparty && counterparty.encPub));
      const sealed = builder.sealFor({ enc: { pub: counterparty.encPub } }, ownHalf, orderContext);
      self.postMessage({ id, kind: "done", result: { commitment: sealed.commitment, bytes: sealed.bytes } });
    } else if (type === "commit") {
      // Обязательство на половину: наружу уходит только хеш, сама половина остаётся здесь.
      const hex = "0x" + builder.halfCommitment(ownHalf).replace(/^0x/, "");
      self.postMessage({ id, kind: "done", result: { commitment: hex } });
    } else if (type === "pointOf") {
      self.postMessage({ id, kind: "done", result: { ed: builder.pointOf(ownHalf) } });
    } else if (type === "jointAddress") {
      // АДРЕС СЧИТАЕТСЯ ЗДЕСЬ, А НЕ В ГЛАВНОМ ПОТОКЕ: криптография живёт в одном месте, и главный поток
      // не должен обрастать половинами и кривыми. Наружу уходит строка адреса и обе публичные точки.
      self.postMessage({ id, kind: "done", result: builder.jointAddress(joint || {}) });
    } else if (type === "newMakerMaterial") {
      // МАТЕРИАЛ МЕЙКЕРА ОБРАТНОЙ СДЕЛКИ: ДВЕ ПОЛОВИНЫ И ИХ ПУБЛИЧНАЯ ЧАСТЬ, БЕЗ ДОКАЗАТЕЛЬСТВА.
      //
      // ПОЧЕМУ БЕЗ ДОКАЗАТЕЛЬСТВА, хотя в прямом направлении сторона его несёт. Доказательство DLEQ
      // связывает половину с ПРИВЯЗКОЙ ордера (соль, сроки, адрес забора), а привязку в обратном режиме
      // назначает НОДА и присылает её в билете. Пока билета нет, контекста нет, и доказывать нечего -
      // ровно поэтому фаза 1 мейкера у ноды (tools/maker-reverse-order.mjs) считает те же величины и
      // ничего не доказывает. Считать здесь одиннадцатисекундное доказательство значило бы заморозить
      // кнопку заявки на то, что ноде пока не нужно.
      //
      // ЧТО УХОДИТ НАРУЖУ: те же четыре имени, которыми нода принимает заявку мейкера
      // (rfq/reverseOrder.mjs, makerRequestRefusal), - и две половины, которыми мейкер потом забирает
      // выплату и видит приход XMR. Имена половин взяты у вывода (order.js: newSide) и у файла
      // восстановления (recovery/recoveryFile.js: spendHalf, viewHalf), чтобы у одного и того же
      // значения не появилось второго имени.
      const spendHalf = builder.halves.newHalf();
      const viewHalf = builder.halves.newHalf();
      self.postMessage({
        id, kind: "done",
        result: {
          // ОБЯЗАТЕЛЬСТВО И ТОЧКА - ОБ ОДНОЙ И ТОЙ ЖЕ ПОЛОВИНЕ ТРАТЫ, и считает их один модуль половин:
          // цепь сверяет половину с обязательством (NinseiEscrow.sol:235), поэтому разойтись им нельзя.
          commitHalfClaimer: canon(builder.halfCommitment(spendHalf)),
          edPointClaimer: canon(builder.halves.publicHalves(spendHalf).ed),
          // ТОЧКА ПРОСМОТРА: по ней нода собирает общий адрес (адрес - сумма точек).
          edViewPointClaimer: canon(builder.halves.publicHalves(viewHalf).ed),
          // ПОЛОВИНА ПРОСМОТРА - ПРИВАТНАЯ и уходит ноде единственной из двух приватных: без неё она не
          // увидит приход XMR. Форма записи та же, что у ноды: 32 байта hex (maker-reverse-order.mjs:83).
          viewHalfClaimer: canon("0x" + viewHalf.toString(16).padStart(64, "0")),
          spendHalf,
          viewHalf,
        },
      });
    } else if (type === "verify") {
      say("verify", "проверяю доказательство контрагента");
      const side = { proof: counterparty.proof, pub: { ed: counterparty.edPub }, commitHalfClaimer: counterparty.commitHalfClaimer || null };
      // Вскрываем тем ключом, на который посылка была зашифрована в этом контексте.
      const recipient = sealedToPub.get(String(orderContext));
      const openWith = recipient ? encPrivByPub.get(recipient) : null;
      if (sealedBytes && !openWith) {
        throw new Error("нет ключа, которым вскрывать посылку: не было шифрования в этом контексте ордера");
      }
      let verdict = builder.verifySide(side, orderContext, sealedBytes || null, openWith);
      // THE PROOF IS ABOUT THE COMMITMENT IN THE QUOTE, not only about two points that stand for one scalar. The
      // contract pays against commitHalfClaimer; without this comparison a counterparty proves one point and funds
      // another, and the half revealed at claim time does not open the joint address.
      if (verdict && verdict.ok === true) {
        if (!counterparty.commitHalfClaimer) {
          verdict = { ok: false, reason: "the counterparty side carries no commitHalfClaimer" };
        } else {
          const proven = commitmentOfPoint(counterparty.proof && counterparty.proof.XA);
          if (!proven || low160(proven) !== low160(counterparty.commitHalfClaimer)) {
            verdict = { ok: false, reason: "the proven secp256k1 point does not match commitHalfClaimer: " + (proven || "unparsed") + " vs " + counterparty.commitHalfClaimer };
          }
        }
      }
      self.postMessage({ id, kind: "done", result: verdict });
    } else {
      self.postMessage({ id, kind: "error", message: "неизвестный запрос воркеру: " + String(type) });
    }
  } catch (err) {
    self.postMessage({ id, kind: "error", message: (err && err.message) || String(err) });
  }
};
