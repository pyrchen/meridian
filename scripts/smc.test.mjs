// Юнит-тесты scripts/smc.mjs — синтетические свечи с заранее известным ответом, без фреймворка.
// Запуск: node scripts/smc.test.mjs — код возврата 1 при любом провале.

import assert from 'node:assert/strict'
import { swings, structure, fvg, orderBlocks, breaker, mitigation, premiumDiscount, sweep, smcRefine, findFreshPOI } from './smc.mjs'

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
// summary
// ═══════════════════════════════════════════════════════════════════

for (const f of failures) {
  console.log(`FAIL: ${f.name}`)
  console.log(`  ${f.err && f.err.stack ? f.err.stack : f.err}`)
}
console.log(`\nsmc.test.mjs: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`)
if (failCount > 0) process.exit(1)
