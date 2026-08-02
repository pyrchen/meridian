// Юнит-тесты scripts/smc.mjs — синтетические свечи с заранее известным ответом, без фреймворка.
// Запуск: node scripts/smc.test.mjs — код возврата 1 при любом провале.

import assert from 'node:assert/strict'
import { swings, structure, fvg, orderBlocks, breaker, mitigation, premiumDiscount, sweep, smcRefine, findFreshPOI, smcGenerate } from './smc.mjs'

let passCount = 0
let failCount = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passCount++
  } catch (e) {
    failCount++
    failures.push({ name, err: e })
  }
}

// ── конструктор свечей: i — индекс бара (час), явные o/h/l/c/v ──
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)
const HOUR = 3600 * 1000
function c(i, o, h, l, cl, v = 100) {
  const t = T0 + i * HOUR
  return { t, o, h, l, c: cl, v, ct: t + HOUR - 1 }
}

// ═══════════════════════════════════════════════════════════════════
// swings()
// ═══════════════════════════════════════════════════════════════════

test('swings: 3-candle swing high detected at center', () => {
  const cs = [c(0, 100, 105, 95, 102), c(1, 102, 110, 100, 108), c(2, 108, 107, 101, 104)]
  const sw = swings(cs, 3)
  const highs = sw.filter((s) => s.type === 'high')
  assert.equal(highs.length, 1)
  assert.equal(highs[0].idx, 1)
  assert.equal(highs[0].price, 110)
})

test('swings: 3-candle swing low detected at center', () => {
  const cs = [c(0, 100, 101, 95, 99), c(1, 99, 100, 90, 95), c(2, 95, 98, 92, 96)]
  const sw = swings(cs, 3)
  const lows = sw.filter((s) => s.type === 'low')
  assert.equal(lows.length, 1)
  assert.equal(lows[0].idx, 1)
  assert.equal(lows[0].price, 90)
})

test('swings: no swing when center does not exceed a neighbor', () => {
  // idx1.h=104 < idx0.h=105 — не свинг-хай (не строго больше ОБОИХ соседей)
  const cs = [c(0, 100, 105, 95, 102), c(1, 102, 104, 100, 103), c(2, 100, 103, 98, 101)]
  const sw = swings(cs, 3)
  assert.equal(sw.filter((s) => s.type === 'high').length, 0)
})

test('swings: one candle is simultaneously swing-high and swing-low (n=3)', () => {
  const cs = [c(0, 100, 102, 98, 101), c(1, 100, 110, 90, 105), c(2, 100, 103, 97, 102)]
  const sw = swings(cs, 3)
  const at1 = sw.filter((s) => s.idx === 1)
  assert.equal(at1.length, 2, 'ожидали и high, и low на idx=1')
  assert.ok(at1.some((s) => s.type === 'high' && s.price === 110))
  assert.ok(at1.some((s) => s.type === 'low' && s.price === 90))
})

test('swings: 5-candle swing high — relative order of outer candles does not matter', () => {
  // хаи: 108,106,[115],104,109 — центр строго больше всех четырёх, но 108>106 и 104<109
  // (соседи не монотонны) — источник прямо говорит, что это не имеет значения
  const cs = [
    c(0, 100, 108, 90, 105),
    c(1, 100, 106, 90, 103),
    c(2, 100, 115, 90, 112),
    c(3, 100, 104, 90, 101),
    c(4, 100, 109, 90, 106),
  ]
  const sw = swings(cs, 5)
  const highs = sw.filter((s) => s.type === 'high')
  assert.equal(highs.length, 1)
  assert.equal(highs[0].idx, 2)
  assert.equal(highs[0].price, 115)
})

test('swings: 5-candle swing — a candle failing to beat just ONE of the four neighbors is not a swing', () => {
  // центр 110 < idx4.h=112 — не свинг, несмотря на то что он больше остальных трёх
  const cs = [
    c(0, 100, 100, 90, 98),
    c(1, 100, 105, 90, 102),
    c(2, 100, 110, 90, 107),
    c(3, 100, 103, 90, 101),
    c(4, 100, 112, 90, 108),
  ]
  const sw = swings(cs, 5)
  assert.equal(sw.filter((s) => s.type === 'high').length, 0)
})

// ═══════════════════════════════════════════════════════════════════
// fvg() — present / absent / partial / filled
// ═══════════════════════════════════════════════════════════════════

test('fvg: bullish FVG absent when candle ranges overlap (no gap)', () => {
  const cs = [c(0, 100, 105, 98, 102), c(1, 101, 106, 99, 103), c(2, 102, 107, 100, 104)]
  const zones = fvg(cs).filter((z) => z.type === 'fvg')
  assert.equal(zones.length, 0)
})

test('fvg: bullish FVG present and open (untouched) after formation', () => {
  const cs = [
    c(0, 100, 102, 99, 101), // c1.h = 102
    c(1, 103, 108, 102, 107),
    c(2, 108, 112, 106, 110), // c3.l = 106 > 102 → gap [102,106]
    c(3, 109, 111, 107, 110), // остаётся выше зоны (l=107>106) — не трогает её; и l<=h(idx1)=108, чтобы не образовать второй (побочный) FVG на тройке (1,2,3)
  ]
  const zones = fvg(cs).filter((z) => z.type === 'fvg' && z.side === 'bullish')
  assert.equal(zones.length, 1)
  const z = zones[0]
  assert.equal(z.lo, 102)
  assert.equal(z.hi, 106)
  assert.equal(z.filledPct, 0)
  assert.equal(z.state, 'open')
})

test('fvg: bullish FVG partially filled', () => {
  const cs = [
    c(0, 100, 102, 99, 101),
    c(1, 103, 108, 102, 107),
    c(2, 108, 112, 106, 110), // gap [102,106]
    c(3, 106, 107, 104, 105), // low=104 — заходит в зону наполовину (102..106, глубина 2 из 4)
  ]
  const zones = fvg(cs).filter((z) => z.type === 'fvg' && z.side === 'bullish')
  assert.equal(zones.length, 1)
  assert.equal(zones[0].filledPct, 50)
  assert.equal(zones[0].state, 'partial')
})

test('fvg: bullish FVG fully filled', () => {
  const cs = [
    c(0, 100, 102, 99, 101),
    c(1, 103, 108, 102, 107),
    c(2, 108, 112, 106, 110), // gap [102,106]
    c(3, 106, 107, 101, 103), // low=101 <= 102 — полное закрытие
  ]
  const zones = fvg(cs).filter((z) => z.type === 'fvg' && z.side === 'bullish')
  assert.equal(zones.length, 1)
  assert.equal(zones[0].filledPct, 100)
  assert.equal(zones[0].state, 'filled')
})

test('fvg: bearish FVG geometry (mirror)', () => {
  const cs = [
    c(0, 110, 111, 108, 109), // c1.l = 108
    c(1, 106, 107, 102, 103),
    c(2, 102, 103, 98, 100), // c3.h = 103 < 108 → gap [103,108]
  ]
  const zones = fvg(cs).filter((z) => z.type === 'fvg' && z.side === 'bearish')
  assert.equal(zones.length, 1)
  assert.equal(zones[0].lo, 103)
  assert.equal(zones[0].hi, 108)
})

// ═══════════════════════════════════════════════════════════════════
// orderBlocks() — valid vs invalid (engulfing requirement)
// ═══════════════════════════════════════════════════════════════════

test('orderBlocks: valid bullish OB — sweep + engulfing next candle', () => {
  const cs = [
    c(0, 96, 97, 90, 95), // prior window low = 90
    c(1, 93, 94, 92, 93.5), // prior window low = 92
    c(2, 92, 93, 91, 92.5), // prior window low = 91 (min of window = 90)
    c(3, 95, 100, 85, 99), // candidate: up candle, low=85 < 90 (swept), high=100
    c(4, 99, 106, 98, 105), // next candle closes (105) beyond candidate.h (100) — engulfs
  ]
  const obs = orderBlocks(cs, { sweepLookback: 3 })
  const bullish = obs.filter((z) => z.side === 'bullish')
  assert.equal(bullish.length, 1)
  assert.equal(bullish[0].idx, 3)
  assert.equal(bullish[0].lo, 85)
  assert.equal(bullish[0].hi, 95)
})

test('findFreshPOI: a freshly formed OB is NOT reported as already-mitigated by its own confirming candle', () => {
  // Регрессия на баг, найденный внешним ревью: скан «уже протестирована ли зона» начинался
  // с formIdx+1, а formIdx для OB был индексом МАНИПУЛЯТИВНОЙ свечи — то есть следующая,
  // ПОГЛОЩАЮЩАЯ свеча (обязательная для валидности OB вообще) сама засчитывалась как ретест,
  // если её диапазон пересекал зону. Здесь у поглощающей свечи (idx4) нижняя тень (l=88)
  // заходит в зону [85,95] — старый код считал это «зона уже протестирована в момент
  // формирования» и немедленно ветировал гейт 3 для КАЖДОГО свежего OB такой формы.
  const cs = [
    c(0, 96, 97, 90, 95),
    c(1, 93, 94, 92, 93.5),
    c(2, 92, 93, 91, 92.5),
    c(3, 95, 100, 85, 99), // OB-кандидат: зона [85,95]
    c(4, 90, 106, 88, 105), // поглощающая свеча: закрытие 105>100 (поглощает), но l=88 залезает в зону
    c(5, 104, 107, 103, 105), // «текущая» свеча — просто последняя в окне
  ]
  const obs = orderBlocks(cs, { sweepLookback: 3 })
  assert.equal(obs.filter((z) => z.side === 'bullish').length, 1, 'фикстура должна дать ровно один валидный OB')
  const poi = findFreshPOI('long', 90, obs, [], [], cs)
  assert.ok(poi, 'свежий OB не должен быть отклонён как уже смягчённый собственной поглощающей свечой')
  assert.equal(poi.lo, 85)
  assert.equal(poi.hi, 95)
})

test('orderBlocks: invalid — same manipulative candle WITHOUT engulfing next candle', () => {
  const cs = [
    c(0, 96, 97, 90, 95),
    c(1, 93, 94, 92, 93.5),
    c(2, 92, 93, 91, 92.5),
    c(3, 95, 100, 85, 99), // same candidate: swept liquidity at low=85
    c(4, 99, 99.5, 97, 98), // next candle close=98 does NOT exceed candidate.h=100 — no engulfing
  ]
  const obs = orderBlocks(cs, { sweepLookback: 3 })
  assert.equal(obs.filter((z) => z.side === 'bullish').length, 0, 'без поглощения — это не ордер-блок')
})

// ═══════════════════════════════════════════════════════════════════
// breaker() vs mitigation() — ГЛАВНЫЙ тест: дискриминатор = свип до слома
// ═══════════════════════════════════════════════════════════════════
//
// Общая 4-точечная разметка (n=3 для компактности фикстуры):
//   P0 (swing low, idx1=90) → P1 (swing high, idx3=115, будущая зона) →
//   P2 (swing low, idx5) → пробой P1 закрытием тела на idx7.
// Различитель: P2 < P0 → брейкер (свип Low1 перед сломом LH из B-blocks.md);
//              P2 >= P0 → митигейшн (формируется БЕЗ предварительного снятия).

test('breaker vs mitigation: same shape, sweep before break ⇒ breaker only', () => {
  const cs = [
    c(0, 100, 105, 95, 102),
    c(1, 97, 104, 90, 98), // P0: swing low @90
    c(2, 98, 106, 94, 100),
    c(3, 110, 115, 109, 112), // P1: swing high @115 (зона)
    c(4, 108, 108, 104, 106),
    c(5, 95, 100, 85, 90), // P2: swing low @85 — НИЖЕ P0(90) ⇒ свип ⇒ брейкер
    c(6, 91, 102, 90, 95),
    c(7, 103, 120, 102, 118), // пробой: h=120>115 (тень), close=118>115 (тело) ⇒ слом подтверждён
  ]
  const br = breaker(cs, { n: 3 })
  const mt = mitigation(cs, { n: 3 })
  assert.equal(br.length, 1, 'брейкер должен сформироваться при свипе перед сломом')
  assert.equal(br[0].side, 'bullish')
  assert.equal(br[0].hi, 115)
  assert.equal(br[0].breakIdx, 7)
  assert.equal(mt.length, 0, 'митигейшн НЕ должен сформироваться на том же свипе — это другая формация')
})

test('breaker vs mitigation: same shape, NO sweep before break ⇒ mitigation only', () => {
  const cs = [
    c(0, 100, 105, 95, 102),
    c(1, 97, 104, 90, 98), // P0: swing low @90 (та же точка)
    c(2, 98, 106, 94, 100),
    c(3, 110, 115, 109, 112), // P1: swing high @115 (та же зона)
    c(4, 108, 108, 104, 106),
    c(5, 95, 100, 92, 94), // P2: swing low @92 — НЕ ниже P0(90) ⇒ неудачный свинг, без свипа
    c(6, 93, 102, 91, 97),
    c(7, 103, 120, 102, 118), // тот же пробой
  ]
  const br = breaker(cs, { n: 3 })
  const mt = mitigation(cs, { n: 3 })
  assert.equal(mt.length, 1, 'митигейшн должен сформироваться без предварительного свипа')
  assert.equal(mt[0].side, 'bullish')
  assert.equal(mt[0].hi, 115)
  assert.equal(mt[0].breakIdx, 7)
  assert.equal(br.length, 0, 'брейкер НЕ должен сформироваться без свипа — ключевой дискриминатор')
})

test('breaker: sweep without body-close confirmation excludes the formation entirely', () => {
  const cs = [
    c(0, 100, 105, 95, 102),
    c(1, 97, 104, 90, 98), // P0 @90
    c(2, 98, 106, 94, 100),
    c(3, 110, 115, 109, 112), // P1 @115
    c(4, 108, 108, 104, 106),
    c(5, 95, 100, 85, 90), // P2 @85 < P0 ⇒ свип есть
    c(6, 91, 102, 90, 95),
    c(7, 103, 118, 102, 111), // тень пробивает 115 (h=118), но ТЕЛО закрывается ниже (c=111) — не слом
  ]
  const br = breaker(cs, { n: 3 })
  assert.equal(br.length, 0, 'свип без закрытия тела — брейкер не формируется вовсе (B-blocks.md)')
})

// ═══════════════════════════════════════════════════════════════════
// structure() / BOS — body-close vs wick-only
// ═══════════════════════════════════════════════════════════════════

test('structure: wick-only touch of a swing level is NOT a BOS in body mode', () => {
  const cs = [
    c(0, 95, 100, 90, 96),
    c(1, 97, 110, 95, 105), // swing high @110 (n=3)
    c(2, 100, 105, 92, 98),
    c(3, 108, 115, 108, 109), // тень пробивает 110 (h=115), но тело закрывается ниже (c=109) — свип
  ]
  const str = structure(cs, { n: 3, mode: 'body' })
  const bosAtLevel = str.bos.filter((b) => b.level === 110)
  assert.equal(bosAtLevel.length, 0, 'в режиме body wick-only пробой не считается сломом')
})

test('structure: the same wick-only touch DOES count as BOS in wick mode', () => {
  const cs = [
    c(0, 95, 100, 90, 96),
    c(1, 97, 110, 95, 105), // swing high @110
    c(2, 100, 105, 92, 98),
    c(3, 108, 115, 108, 109), // тот же свип
  ]
  const str = structure(cs, { n: 3, mode: 'wick' })
  const bosAtLevel = str.bos.filter((b) => b.level === 110)
  assert.equal(bosAtLevel.length, 1, 'в режиме wick касание тенью уже считается сломом')
  assert.equal(bosAtLevel[0].idx, 3)
})

test('structure: body-close beyond the swing level IS a BOS regardless of mode', () => {
  const cs = [
    c(0, 95, 100, 90, 96),
    c(1, 97, 110, 95, 105), // swing high @110
    c(2, 100, 105, 92, 98),
    c(3, 108, 118, 107, 116), // тело закрывается выше 110 (c=116) — настоящий слом
  ]
  const bodyMode = structure(cs, { n: 3, mode: 'body' })
  const wickMode = structure(cs, { n: 3, mode: 'wick' })
  assert.equal(bodyMode.bos.filter((b) => b.level === 110).length, 1)
  assert.equal(wickMode.bos.filter((b) => b.level === 110).length, 1)
})

test('sweep(): detects the wick-pierce-and-reject pattern directly', () => {
  const cs = [
    c(0, 95, 100, 90, 96),
    c(1, 97, 110, 95, 105),
    c(2, 100, 105, 92, 98),
    c(3, 108, 115, 108, 109), // h=115>110, close=109<110 ⇒ sweep of the high side
  ]
  const ev = sweep(cs, 110, { lookback: 10 })
  assert.ok(ev, 'ожидали найти свип')
  assert.equal(ev.dir, 'high')
  assert.equal(ev.idx, 3)
})

// ═══════════════════════════════════════════════════════════════════
// premiumDiscount() — границы
// ═══════════════════════════════════════════════════════════════════

test('premiumDiscount: exact midpoint is equilibrium', () => {
  const r = premiumDiscount(150, { lo: 100, hi: 200 })
  assert.equal(r.zone, 'equilibrium')
  assert.equal(r.mid, 150)
})

test('premiumDiscount: just above midpoint is premium', () => {
  const r = premiumDiscount(150.01, { lo: 100, hi: 200 })
  assert.equal(r.zone, 'premium')
})

test('premiumDiscount: just below midpoint is discount', () => {
  const r = premiumDiscount(149.99, { lo: 100, hi: 200 })
  assert.equal(r.zone, 'discount')
})

test('premiumDiscount: range floor/ceiling', () => {
  assert.equal(premiumDiscount(100, { lo: 100, hi: 200 }).zone, 'discount')
  assert.equal(premiumDiscount(200, { lo: 100, hi: 200 }).zone, 'premium')
  assert.equal(premiumDiscount(100, { lo: 100, hi: 200 }).pct, 0)
  assert.equal(premiumDiscount(200, { lo: 100, hi: 200 }).pct, 1)
})

// ═══════════════════════════════════════════════════════════════════
// smcRefine() — базовая интеграция: veto без структурного основания
// ═══════════════════════════════════════════════════════════════════

test('smcRefine: vetoes a signal with no target magnet ahead of price (flat market)', () => {
  // плоский рынок без свингов/имбалансов впереди цены — не должно быть ни магнита, ни POI
  const flat = []
  for (let i = 0; i < 40; i++) flat.push(c(i, 100, 100.2, 99.8, 100, 50))
  const signal = { side: 'long', entry: 100, sl: 98, tp: 105, horizon: 'scalp', symbol: 'TESTUSDT' }
  const res = smcRefine(signal, { sigCandles: flat })
  assert.equal(res.action, 'veto')
  assert.ok(res.reasonCodes.some((r) => r.startsWith('veto:')))
})

// ═══════════════════════════════════════════════════════════════════
// smcGenerate() — потребитель B (§6.3): свип → слом → FVG → лимитник
// ═══════════════════════════════════════════════════════════════════
//
// Восьмишаговая последовательность требует координированной синтетики: свинг-хай (уровень
// будущего слома), свинг-лоу (уровень будущего свипа), сам свип, слом ПОСЛЕ свипа с
// импульсом ≥1.5×ATR и FVG в окне слома (иначе не пройдёт фильтр ложного слома), FVG от
// импульса (зона входа) и ОТДЕЛЬНАЯ незакрытая зона выше — иначе нет цели-магнита (гейт 2
// не смотрит на «уже пройденные» уровни — см. находку ниже). n=3 (компактный фрактал, тот
// же приём что и в фикстурах breaker/mitigation выше) через ctx.swingN.
//
// smcGenerate требует sigCandles.length>=60 (зеркалит f.length<60 гейт analyzeHorizon) —
// отсюда 40 «плоских» свечей в начале: o=h≈l=c, нигде нет строгого неравенства, поэтому НИ
// ОДНА не регистрируется свинг-точкой; нужны только чтобы ATR(14) и общая длина окна были
// реалистичными, на геометрию сигнала не влияют.

function buildGenFixture({ sweepOn = true, breakBodyClose = true } = {}) {
  const cs = []
  let i = 0
  const push = (o, h, l, cl) => cs.push(c(i++, o, h, l, cl))
  for (let p = 0; p < 40; p++) push(100, 100.5, 99.5, 100) // ATR/длина warm-up, без свингов
  // Цель-магнит (гейт 2): медвежий FVG [141.5,170], сформирован ЗАДОЛГО до сделки и НИКОГДА
  // не тестируется позже (пробой ниже дотягивается лишь до 116) — остаётся открытым, поэтому
  // findTargetMagnet находит его как «незакрытый имбаланс впереди цены» (лонг: z.lo>price).
  push(172, 173, 170, 171) // c1 гэпа: low=170
  push(170.5, 172, 165, 168)
  push(140, 141.5, 115, 118) // c3 гэпа: high=141.5 < c1.low(170) ⇒ медвежий гэп [141.5,170]
  push(118, 119, 99, 100) // переход вниз, high всегда < 141.5 — зона остаётся нетронутой
  // Свинг-хай @103 — уровень, который позже сломает импульс (гейт 5).
  push(100, 101, 99, 100.2)
  push(100.2, 100.6, 98.5, 99)
  push(99, 100.2, 98.3, 99.8)
  push(99.8, 100.5, 99, 100)
  push(100, 103, 99.5, 102.5) // свинг HIGH @103
  push(102.5, 102.6, 100, 100.5)
  push(100.5, 100.6, 97, 97.5)
  push(97.5, 98, 94, 94.5)
  push(94.5, 95, 90, 90.5) // свинг LOW @90 — уровень будущего свипа (гейт 4)
  push(90.5, 92, 90.2, 91.5)
  push(91.5, 93, 91, 92.5)
  push(92.5, 94, 92, 93.5)
  push(93.5, 95, 93, 94.5)
  push(94.5, 96, 94, 95.5)
  push(95.5, 97, 95, 96.5)
  if (sweepOn) {
    // Свип свинг-лоу@90: тень пробивает вниз, закрытие возвращается выше уровня.
    push(96.5, 97, 88, 91)
    // Свеча с ТЕМ ЖЕ минимумом (88) — без неё сама свечная свипа зарегистрировалась бы
    // НОВЫМ свинг-лоу (она ниже соседей), и findPreEntrySweep искал бы свип уже ЭТОГО
    // уровня, а не исходного @90 — совпадающий минимум ломает строгое неравенство свинга
    // с обеих сторон, ни одна из двух не регистрируется.
    push(89.5, 90, 88, 89.7)
  } else {
    // Вариант БЕЗ свипа: цена весь отрезок держится выше 90 (тоже на совпадающем минимуме
    // @92, чтобы форма разметки осталась той же — меняется только гейт 4).
    push(96.5, 97, 92, 94)
    push(93.5, 95, 92, 94.5)
  }
  // Слом свинг-хая@103. Минимум держим у 93 — заметно выше и свипнутого уровня (90), и
  // соседних минимумов, иначе широкий диапазон этой свечи сам ложно засчитался бы «свипом
  // @90» (sweep() не разбирает контекст, просто ищет тень-ниже-уровня/закрытие-выше во всём
  // окне поиска) или новым свинг-лоу. В wick-only варианте close=91 держит ТЕЛО ниже 103
  // (слома по телу нет), но нога всё равно достаточно большая (~12) для фильтра
  // ложного слома (импульс/ATR ≥1.5) — иначе «нет сигнала» объяснялось бы падением этого
  // фильтра, а не режимом слома, который здесь и проверяется.
  const breakClose = breakBodyClose ? 115 : 91
  push(90.5, 116, 93, breakClose)
  // c3 FVG зоны входа (c1 — свеча с минимумом 88/92 выше, high=90/92): лимитник встанет на
  // её ближний край. Open зафиксирован на 115 (валиден в обоих вариантах; в дефолтном он
  // РАВЕН close предыдущей свечи — иначе 2-свечная проверка bull/bear FVG между ними
  // породила бы лишнюю близкую зону, которая перебила бы дальний магнит по .lo).
  push(115, 118, 104, 106)
  // Финальная свеча — цена в дискаунте дилинг-рейнджа [90,118].
  push(106, 108, 97, 98)
  return cs
}

// Тренд-ТФ для биаса (гейт 1): свинг-хай@103, сломанный телом выше — биас long.
const genTrend = [
  c(0, 100, 101, 99, 100.5),
  c(1, 100.5, 103, 100, 102),
  c(2, 102, 102.5, 99, 100),
  c(3, 100, 108, 99.5, 107),
]

test('smcGenerate: valid long signal — sweep, then BOS, then retracement into the impulse FVG', () => {
  const cs = buildGenFixture()
  const cand = smcGenerate({ symbol: 'TESTUSDT', base: 'TEST', horizon: 'mid', timeframe: '4h', sigCandles: cs, trendCandles: genTrend, swingN: 3 })
  assert.ok(cand, 'ожидали валидный сигнал на подготовленной свип→слом→FVG последовательности')
  assert.equal(cand.side, 'long')
  // Вход — ближний край FVG от импульсной ноги слома (§6.3 п.6): entryLevel = c3.low.
  assert.equal(cand.entry, 104)
  // Стоп — ЗА экстремумом свипа (§6.3 п.7), не за край зоны входа (90) — экстремум ниже.
  assert.equal(cand.sl, 88)
  // Тейк — уровень магнита (§6.3 п.2/п.8): дальний край незакрытого FVG впереди цены.
  assert.equal(cand.tp, 165)
  assert.ok(cand.rr >= 2, `rr должен пройти отбраковку RR_MIN: ${cand.rr}`)
  assert.ok(cand.pending && cand.pending.limit === cand.entry && cand.pending.invalidate === cand.sl)
})

test('smcGenerate: no signal when the sweep is removed (gate 4 fails)', () => {
  const cs = buildGenFixture({ sweepOn: false })
  const cand = smcGenerate({ symbol: 'TESTUSDT', base: 'TEST', horizon: 'mid', timeframe: '4h', sigCandles: cs, trendCandles: genTrend, swingN: 3 })
  assert.equal(cand, null, 'без свипа перед сломом сетапа по спеке нет вовсе (§6.3 п.4)')
})

test('smcGenerate: no signal when the confirming BOS is wick-only under body mode (gate 5 fails)', () => {
  const cs = buildGenFixture({ breakBodyClose: false })
  const bodyCand = smcGenerate({ symbol: 'TESTUSDT', base: 'TEST', horizon: 'mid', timeframe: '4h', sigCandles: cs, trendCandles: genTrend, swingN: 3, breakMode: 'body' })
  assert.equal(bodyCand, null, 'тело не закрылось за свинг-хаем — в режиме body слома не было вовсе')
  // Контроль: ТЕ ЖЕ свечи в режиме wick сигнал находят — разница только в SMC_BREAK_MODE,
  // а не в случайно сломанной по пути фикстуре.
  const wickCand = smcGenerate({ symbol: 'TESTUSDT', base: 'TEST', horizon: 'mid', timeframe: '4h', sigCandles: cs, trendCandles: genTrend, swingN: 3, breakMode: 'wick' })
  assert.ok(wickCand, 'та же фикстура в режиме wick обязана дать сигнал — иначе тест выше ничего не доказывает про режим')
})

test('smcGenerate: no signal when no target magnet exists ahead of price (gate 2 fails)', () => {
  // [находка] Дискаунт-локация (гейт 3) и «есть магнит впереди» (гейт 2, фолбэк на пул
  // ликвидности) в этой реализации структурно СЦЕПЛЕНЫ: дилинг-рейндж якорится на ПОСЛЕДНИЙ
  // свинг + ближайший противоположный (dealingRange), и его верхняя граница ВСЕГДА сама
  // является зарегистрированной свинг-точкой типа 'high' — findTargetMagnet.pool берёт ЛЮБУЮ
  // такую точку с ценой выше текущей без исключений (в отличие от FVG-ветки, для пулов нет
  // проверки «уже смягчена»). Значит, если гейт 3 (дискаунт) прошёл, у гейта 2 почти всегда
  // уже есть готовый кандидат — это же верхняя граница РЕЙНДЖА. Поэтому «нет магнита» здесь
  // проверяем на плоском рынке: НЕТ ни одного свинга вовсе ⇒ dealingRange() возвращает null
  // (гейт 3 падает первым по вычислению) И независимо от этого явно нет ни одной FVG-зоны,
  // ни одной свинг-точки для пула (гейт 2 такой же пустой). Более узкий тест — где гейт 3
  // проходит, а гейт 2 сам по себе терпит неудачу, — при текущей архитектуре генератора
  // геометрически недостижим для лонга (симметрично и для шорта); см. отчёт агента.
  const flatSig = []
  for (let i = 0; i < 70; i++) flatSig.push(c(i, 100, 100.2, 99.8, 100))
  const cand = smcGenerate({ symbol: 'TESTUSDT', base: 'TEST', horizon: 'mid', timeframe: '4h', sigCandles: flatSig, trendCandles: genTrend, swingN: 3 })
  assert.equal(cand, null, 'плоский рынок: ни дилинг-рейнджа, ни FVG, ни пула ликвидности — магнита нет')
})

// ═══════════════════════════════════════════════════════════════════
// summary
// ═══════════════════════════════════════════════════════════════════

for (const f of failures) {
  console.log(`FAIL: ${f.name}`)
  console.log(`  ${f.err && f.err.stack ? f.err.stack : f.err}`)
}
console.log(`\nsmc.test.mjs: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`)
if (failCount > 0) process.exit(1)
