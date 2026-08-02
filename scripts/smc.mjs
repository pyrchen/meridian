// Meridian — SMC (Smart Money Concepts) слой, чистый модуль (docs/SMC_ENGINE_SPEC.md, §6).
//
// P0-1-инвариант, унаследованный от gen-signals.mjs: НИ fetch, НИ readFile/writeFile,
// НИ process.exit, НИ Date.now(), НИ Math.random(). Только функции над массивами свечей
// [{t,o,h,l,c,v,ct}] по возрастанию t, уже обрезанными по ct<=T вызывающей стороной
// (backtest.mjs передаёт ровно то окно, что видела бы analyzeHorizon в этот момент).
// Если внутри какой-то функции здесь захочется «следующей свечи» — это лукахед, стоп.
//
// Источник каждого правила — docs/knowledge/sancho-smc/extracted/*.md. Пометка [вывод]
// в комментариях = наша инженерная доработка там, где автор не даёт формального критерия
// (см. SMC_ENGINE_SPEC.md §6.0 — у источника нет единого детерминированного определения
// свинг-точки, отсюда и тюнинг ниже вынесен в env-параметры, которые харнесс свипает).

// ── тюнимые параметры (см. SMC_ENGINE_SPEC.md §6.0/§6.1) ──

// Размер фрактала свинг-точки: 3 или 5 свечей. У автора нет единого правила (визуальная
// разметка vs два механических шаблона) — 5 «основной» (структура/BOS), 3 — вспомогательный.
// Параметр, а не константа: харнесс свипает чувствительность вывода к этой неоднозначности.
export const SMC_SWING_N = Number(process.env.SMC_SWING_N_OVERRIDE) || 5

// Режим слома структуры. Источник расходится сам с собой (см. спеку §6.1 «Осторожно»):
// для БРЕЙКЕРА автор требует закрытия тела безальтернативно, а для рыночной структуры
// ВООБЩЕ дважды прямым текстом ОТВЕРГАЕТ подтверждение по телу и в предпочтительном
// методе размечает и свинг, и слом по теням. Дефолт здесь — 'wick' (предпочтение автора
// для structure()/BOS); breaker()/mitigation() игнорируют этот параметр и ВСЕГДА требуют
// тело — это отдельное, явно заявленное для них требование, не связанное со SMC_BREAK_MODE.
export const SMC_BREAK_MODE = process.env.SMC_BREAK_MODE_OVERRIDE || 'wick'

// FAKE-BOS прокси [вывод]: числового порога «агрессивности» автор не даёт (§6.1, «Ложный
// слом»). Две проверки, обе обязательны для признания слома истинным: размер импульсной
// ноги / ATR(14) >= порог, и сразу после пробоя образовался FVG в сторону слома.
export const SMC_FAKEBOS_ATR_MULT = Number(process.env.SMC_FAKEBOS_ATR_MULT_OVERRIDE) || 1.5

// Глубина поиска свипа назад от текущей свечи (баров сигнального ТФ) — сколько истории
// оглядываем, ища «свип значимого уровня перед входом» (гейт 4 рефайнера) [вывод]: автор
// не называет окно, лишь то, что свип должен предшествовать входу «недавно».
export const SMC_SWEEP_LOOKBACK = Number(process.env.SMC_SWEEP_LOOKBACK_OVERRIDE) || 20

// Окно «предыдущего локального минимума/максимума» для упрощённой одно-свечной методики
// ордер-блока (нужно решить, что значит «сняла ликвидность на продажу/покупку» — автор
// говорит «обновила предыдущий локальный минимум», но не называет глубину окна) [вывод].
export const SMC_OB_SWEEP_LOOKBACK = Number(process.env.SMC_OB_SWEEP_LOOKBACK_OVERRIDE) || 10

// TTL отложенного лимитника при `defer` (баров сигнального ТФ) [вывод] — автор срока жизни
// лимитника не называет (спека §6.2). Тратится из бюджета MAX_AGE_DAYS[horizon], не добавляется.
export const SMC_DEFER_EXPIRY_BARS = Number(process.env.SMC_DEFER_EXPIRY_BARS_OVERRIDE) || 8

// Допуск синхронизации свингов между активами для SMT-дивергенции (мс) [вывод] — автор
// требует «синхронизированные по времени» свинги, но не даёт числового окна допуска.
export const SMC_SMT_TOLERANCE_MS = Number(process.env.SMC_SMT_TOLERANCE_MS_OVERRIDE) || 3 * 3600 * 1000

// Абляция гейтов рефайнера (диагностика, не часть спеки): по умолчанию все три ветоспособных
// гейта из §6.2 активны («2,3,4»). Любое подмножество можно выключить харнессом, чтобы
// отделить «архитектура рефайнера в принципе не работает на v3-focus» от «конкретно строгое
// прочтение гейта 3 душит поток» — v3-focus входит по close моментум-бара, SMC — по откату
// В зону; если это архитектурное расхождение, а не баг конкретного гейта, снятие гейта 3
// должно вернуть поток БЕЗ разворота дельты в плюс. Выключенный гейт просто не ветирует —
// но его детектор всё равно запускается (best-effort) и используется для improve/defer,
// если что-то нашёл; иначе improve/defer вырождаются в pass за неимением структурного якоря.
export const SMC_GATES = new Set(
  (process.env.SMC_GATES_OVERRIDE || '2,3,4').split(',').map((s) => s.trim()).filter(Boolean),
)

// ── внутренние утилиты ──

// Локальная ATR-серия (не трогаем indicators.mjs — там экспортируется только хвостовое
// значение atr()). Нужна структуре(): без предрасчёта серии FAKE-BOS проверка на каждой
// BOS-точке пересчитывала бы ATR с нуля (O(n) каждый раз) — на тысячах кандидатов бэктеста
// это ушло бы в заметный O(n²) оверхед. Предрасчёт — один проход, O(n).
function atrSeriesLocal(candles, p = 14) {
  const out = new Array(candles.length).fill(null)
  if (candles.length < p + 1) return out
  const tr = new Array(candles.length).fill(null)
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  let a = 0
  for (let i = 1; i <= p; i++) a += tr[i]
  a /= p
  out[p] = a
  for (let i = p + 1; i < candles.length; i++) {
    a = (a * (p - 1) + tr[i]) / p
    out[i] = a
  }
  return out
}

// Первая свеча после fromIdx, пробивающая level в направлении dir ('above'|'below').
//   mode='wick' — довольно касания тенью (h>level / l<level);
//   mode='body' — нужно закрытие ТЕЛА за уровнем; если тень пробила раньше тела —
//     это свип, а не слом, и попытка слома по ЭТОМУ уровню считается несостоявшейся.
// Важно: при mode='body' мы НЕ продолжаем искать «а вдруг тело закроется позже» после
// свипа — у автора для брейкера прямо сказано «формация не формируется вовсе», и мы
// применяем ту же логику единообразно (иначе получили бы произвольно отложенный BOS,
// не описанный источником).
function firstLevelBreak(candles, fromIdx, level, dir, mode) {
  for (let i = fromIdx + 1; i < candles.length; i++) {
    const k = candles[i]
    const wickCross = dir === 'above' ? k.h > level : k.l < level
    if (!wickCross) continue
    if (mode === 'wick') return { idx: i, ct: k.ct }
    const bodyClose = dir === 'above' ? k.c > level : k.c < level
    return bodyClose ? { idx: i, ct: k.ct } : null
  }
  return null
}

// ── swings ──

// Свинг-точки: n=3 или n=5 (см. SMC_SWING_N). Центральная свеча индекса i — свинг-хай,
// если её high строго больше high ЛЮБОЙ из half свечей слева/справа (порядок между самими
// соседями значения не имеет — это прямо сказано в источнике для 5-свечного варианта).
// Одна свеча может быть одновременно свинг-хаем и свинг-лоу (широкий диапазон,
// «поглощающая» свеча) — цвет тела не учитывается нигде.
export function swings(candles, n = SMC_SWING_N) {
  const half = Math.floor(n / 2)
  const out = []
  for (let i = half; i < candles.length - half; i++) {
    const center = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - half; j <= i + half; j++) {
      if (j === i) continue
      if (candles[j].h >= center.h) isHigh = false
      if (candles[j].l <= center.l) isLow = false
    }
    if (isHigh) out.push({ idx: i, t: center.t, ct: center.ct, price: center.h, type: 'high' })
    if (isLow) out.push({ idx: i, t: center.t, ct: center.ct, price: center.l, type: 'low' })
  }
  return out
}

// ── structure (+ BOS + FAKE-BOS прокси) ──

// FAKE-BOS: без следующей свечи после пробоя честно возвращаем «неизвестно» (null), а не
// гадаем — иначе это была бы скрытая форма лукахеда (решение зависело бы от свечи,
// которой ещё не существует в момент T, если пробой произошёл на самой последней свече окна).
function classifyFakeBos(candles, atrArr, swingPoint, brk, dirUp) {
  if (brk.idx >= candles.length - 1) {
    return { impulseAtr: null, fvgAfter: null, trueBreak: null }
  }
  const a = atrArr[brk.idx]
  const breakCandle = candles[brk.idx]
  const legSize = Math.abs(breakCandle.c - swingPoint.price)
  const impulseAtr = a ? legSize / a : null
  const from = Math.max(0, brk.idx - 1)
  const to = Math.min(candles.length, brk.idx + 2) // [breakIdx-1, breakIdx, breakIdx+1]
  const zones = to - from >= 3 ? fvg(candles.slice(from, to)) : []
  const fvgAfter = zones.some((z) => z.type === 'fvg' && (dirUp ? z.side === 'bullish' : z.side === 'bearish'))
  const trueBreak = impulseAtr != null ? impulseAtr >= SMC_FAKEBOS_ATR_MULT && fvgAfter : null
  return { impulseAtr: impulseAtr != null ? +impulseAtr.toFixed(3) : null, fvgAfter, trueBreak }
}

// Рыночная структура: последовательность HH/HL/LH/LL по свингам, плюс список BOS-событий.
// Автор не различает BOS/CHoCH/MSS/MSB (синонимы одного процесса) — здесь один тип события
// «bos» = снятие свинга, безотносительно того, разворот это или продолжение (§6.1,
// «Важно для кодирования»). Каждая точка сравнивается только с ПРЕДЫДУЩЕЙ точкой того же
// типа (HH выше предыдущего свинг-хая и т.п.) — без требования жёсткого чередования
// хай/лоу, ровно как описано в источнике.
export function structure(candles, opts = {}) {
  const n = opts.n ?? SMC_SWING_N
  const mode = opts.mode ?? SMC_BREAK_MODE
  const sw = swings(candles, n)
  const highs = sw.filter((s) => s.type === 'high').sort((a, b) => a.idx - b.idx)
  const lows = sw.filter((s) => s.type === 'low').sort((a, b) => a.idx - b.idx)

  const points = []
  let lastHigh = null
  let lastLow = null
  const merged = [...highs.map((s) => ({ ...s, kind: 'high' })), ...lows.map((s) => ({ ...s, kind: 'low' }))].sort(
    (a, b) => a.idx - b.idx,
  )
  for (const s of merged) {
    if (s.kind === 'high') {
      const label = lastHigh == null || s.price > lastHigh.price ? 'HH' : 'LH'
      points.push({ idx: s.idx, ct: s.ct, price: s.price, type: 'high', label })
      lastHigh = s
    } else {
      const label = lastLow == null || s.price < lastLow.price ? 'LL' : 'HL'
      points.push({ idx: s.idx, ct: s.ct, price: s.price, type: 'low', label })
      lastLow = s
    }
  }

  const atrArr = atrSeriesLocal(candles, 14)
  const bos = []
  for (const p of points) {
    const dir = p.type === 'high' ? 'above' : 'below'
    const brk = firstLevelBreak(candles, p.idx, p.price, dir, mode)
    if (!brk) continue
    const fake = classifyFakeBos(candles, atrArr, p, brk, dir === 'above')
    bos.push({ swingIdx: p.idx, swingType: p.type, level: p.price, idx: brk.idx, ct: brk.ct, mode, ...fake })
  }

  return {
    n,
    mode,
    swingHighs: highs,
    swingLows: lows,
    points,
    bos,
    lastBOS: bos.length ? bos[bos.length - 1] : null,
  }
}

// ── fvg (полная таксономия, вся считается из OHLCV) ──

function fillPct(candles, formIdx, side, entryLevel, fulfillLevel) {
  const span = Math.abs(fulfillLevel - entryLevel)
  if (!(span > 0)) return 100
  let deepest = entryLevel
  for (let i = formIdx + 1; i < candles.length; i++) {
    const probe = side === 'bullish' ? candles[i].l : candles[i].h
    if (side === 'bullish') { if (probe < deepest) deepest = probe } else if (probe > deepest) deepest = probe
  }
  const covered = Math.abs(deepest - entryLevel)
  return Math.max(0, Math.min(100, (covered / span) * 100))
}

function stateOf(pct) {
  return pct >= 100 ? 'filled' : pct > 0 ? 'partial' : 'open'
}

// «Начало»/«фулфил»: [вывод] источник для триггер-уровней сформулирован противоречиво
// (C-imbalance-smt.md, «Триггер-уровни внутри FVG» — буквальный текст не согласуется с
// собственной геометрией гэпа, см. разбор в отчёте). Берём САМОСОГЛАСОВАННУЮ трактовку:
// «начало» — край зоны, которого цена достигает ПЕРВЫМ при откате в направлении, в котором
// зона обычно ретестируется (для бычьего FVG цена откатывает СВЕРХУ вниз в зону → начало =
// верхний край = low свечи 3; фулфил = полное закрытие = нижний край = high свечи 1).
// Зеркально для медвежьего. Это единственная трактовка, самосогласованная с описанием OB
// («начало» = ближний/мелкий край, даёт наиболее частую реакцию).
function makeFvgZone(side, c1, c3, endIdx) {
  const lo = side === 'bullish' ? c1.h : c3.h
  const hi = side === 'bullish' ? c3.l : c1.l
  return {
    type: 'fvg',
    side,
    lo,
    hi,
    entryLevel: side === 'bullish' ? hi : lo,
    fulfillLevel: side === 'bullish' ? lo : hi,
    midLevel: (lo + hi) / 2,
    startIdx: endIdx - 2,
    endIdx,
  }
}

export function fvg(candles) {
  const zones = []

  // 3-свечные FVG (BISI/бычий, SIBI/медвежий) — таблица §6.1.
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2]
    const c3 = candles[i]
    if (c3.l > c1.h) zones.push(makeFvgZone('bullish', c1, c3, i))
    else if (c1.l > c3.h) zones.push(makeFvgZone('bearish', c1, c3, i))
  }

  // 2-свечные разновидности: Volume Imbalance (тени пересекаются) vs Gap (не пересекаются).
  // Диапазон — по ТЕЛАМ (close[i-1] → open[i]), тени используются только для проверки
  // условия пересечения (C-imbalance-smt.md — автор явно предупреждает не путать).
  for (let i = 1; i < candles.length; i++) {
    const k1 = candles[i - 1]
    const k2 = candles[i]
    const bull = k2.o > k1.c
    const bear = k2.o < k1.c
    if (!bull && !bear) continue
    const side = bull ? 'bullish' : 'bearish'
    const wicksOverlap = k1.l <= k2.h && k2.l <= k1.h
    const lo = Math.min(k1.c, k2.o)
    const hi = Math.max(k1.c, k2.o)
    zones.push({
      type: wicksOverlap ? 'volImbalance' : 'gap',
      side,
      lo,
      hi,
      entryLevel: side === 'bullish' ? hi : lo,
      fulfillLevel: side === 'bullish' ? lo : hi,
      midLevel: (lo + hi) / 2,
      startIdx: i - 1,
      endIdx: i,
    })
  }

  // filledPct/state для всех зон, построенных выше.
  for (const z of zones) {
    z.filledPct = +fillPct(candles, z.endIdx, z.side, z.entryLevel, z.fulfillLevel).toFixed(2)
    z.state = stateOf(z.filledPct)
  }

  // IFVG: закрытие тела ЗА уровнем фулфила исходного 3-свечного FVG инвертирует полярность
  // (C-imbalance-smt.md — «необходимо и достаточно закрытие тела свечи за уровнем фулфила»).
  for (const z of zones) {
    if (z.type !== 'fvg') continue
    z.inverted = false
    z.invertedAt = null
    for (let i = z.endIdx + 1; i < candles.length; i++) {
      const k = candles[i]
      const beyond = z.side === 'bullish' ? k.c < z.fulfillLevel : k.c > z.fulfillLevel
      if (beyond) { z.inverted = true; z.invertedAt = k.ct; break }
    }
  }

  // BPR: пересечение разнонаправленных 3-свечных FVG (наложение диапазонов).
  const fvgOnly = zones.filter((z) => z.type === 'fvg')
  const bprs = []
  for (let i = 0; i < fvgOnly.length; i++) {
    for (let j = i + 1; j < fvgOnly.length; j++) {
      const a = fvgOnly[i]
      const b = fvgOnly[j]
      if (a.side === b.side) continue
      const lo = Math.max(a.lo, b.lo)
      const hi = Math.min(a.hi, b.hi)
      if (!(lo < hi)) continue
      const first = a.endIdx <= b.endIdx ? a : b
      const endIdx = Math.max(a.endIdx, b.endIdx)
      const entryLevel = first.side === 'bullish' ? hi : lo
      const fulfillLevel = first.side === 'bullish' ? lo : hi
      const pct = +fillPct(candles, endIdx, first.side, entryLevel, fulfillLevel).toFixed(2)
      bprs.push({
        type: 'bpr',
        side: first.side,
        lo,
        hi,
        entryLevel,
        fulfillLevel,
        midLevel: (lo + hi) / 2,
        startIdx: Math.min(a.startIdx, b.startIdx),
        endIdx,
        filledPct: pct,
        state: stateOf(pct),
      })
    }
  }

  return [...zones, ...bprs]
}

// ── orderBlocks (упрощённая одно-свечная методика, §6.1) ──

function makeObZone(side, c, idx, candles) {
  const lo = side === 'bullish' ? c.l : c.o
  const hi = side === 'bullish' ? c.o : c.h
  let invalidated = false
  let invalidatedAt = null
  for (let j = idx + 1; j < candles.length; j++) {
    const k = candles[j]
    const breach = side === 'bullish' ? k.l < lo : k.h > hi
    if (breach) { invalidated = true; invalidatedAt = k.ct; break }
  }
  return { type: 'ob', side, lo, hi, idx, ct: c.ct, invalidated, invalidatedAt }
}

export function orderBlocks(candles, opts = {}) {
  const lookback = opts.sweepLookback ?? SMC_OB_SWEEP_LOOKBACK
  const out = []
  for (let i = lookback; i < candles.length - 1; i++) {
    const c = candles[i]
    const next = candles[i + 1]
    if (c.c > c.o) {
      // бычий кандидат: растущая свеча, нижняя тень «сняла ликвидность на продажу» —
      // обновила локальный минимум предыдущих `lookback` свечей [вывод: окно].
      const priorLow = Math.min(...candles.slice(i - lookback, i).map((k) => k.l))
      if (!(c.l < priorLow)) continue
      // «Поглощение манипулятивного движения» следующей свечой [вывод]: закрытие следующей
      // свечи выходит за экстремум (high) кандидата — без этого «это не ордер-блок» (B-blocks.md).
      if (!(next.c > c.h)) continue
      out.push(makeObZone('bullish', c, i, candles))
    } else if (c.c < c.o) {
      const priorHigh = Math.max(...candles.slice(i - lookback, i).map((k) => k.h))
      if (!(c.h > priorHigh)) continue
      if (!(next.c < c.l)) continue
      out.push(makeObZone('bearish', c, i, candles))
    }
  }
  return out
}

// ── breaker / mitigation (различаются ТОЛЬКО наличием свипа до слома, §6.1) ──

// Обе формации используют один и тот же 4-точечный скан: P0(low)→P1(high, зона)→P2(low)→
// пробой P1 вверх (бычий сценарий), и зеркально P0(high)→P1(low, зона)→P2(high)→пробой P1
// вниз (медвежий). Различает их одно сравнение: P2 глубже P0 (свип Low1 перед сломом LH) —
// брейкер (Low1→LH→Low2→break, B-blocks.md); P2 НЕ глубже P0 (неудачный свинг, без
// предварительного снятия) — митигейшн (A→B→C, «формируется БЕЗ предварительного снятия
// ликвидности» — это прямая цитата, ключевой дискриминатор). Точки — свинги SMC_SWING_N
// (для брейкера источник явно называет 5-свечные; для митигейшн размер фрактала НЕ назван —
// берём тот же параметр [вывод], см. спеку §6.1). Тело обязательно ДЛЯ ОБЕИХ формаций
// независимо от SMC_BREAK_MODE — это отдельное, явно заявленное автором требование
// («свип без закрепления тела — брейкер не формируется вовсе»; для митигейшн — «валидация
// происходит исключительно в момент... закрепления тела», инвалидация необратима).
function finishZone(z, candles) {
  let invalidated = false
  let invalidatedAt = null
  for (let j = z.breakIdx + 1; j < candles.length; j++) {
    const k = candles[j]
    const breach = z.side === 'bullish' ? k.l < z.lo : k.h > z.hi
    if (breach) { invalidated = true; invalidatedAt = k.ct; break }
  }
  return { ...z, invalidated, invalidatedAt }
}

function scanReversalPattern(candles, opts, wantSweep) {
  const n = opts.n ?? SMC_SWING_N
  const sw = swings(candles, n)
  const highs = sw.filter((s) => s.type === 'high').sort((a, b) => a.idx - b.idx)
  const lows = sw.filter((s) => s.type === 'low').sort((a, b) => a.idx - b.idx)
  const zones = []

  for (const p1 of highs) {
    const p0 = [...lows].reverse().find((l) => l.idx < p1.idx)
    const p2 = lows.find((l) => l.idx > p1.idx)
    if (!p0 || !p2) continue
    const swept = p2.price < p0.price
    if (swept !== wantSweep) continue
    const brk = firstLevelBreak(candles, p2.idx, p1.price, 'above', 'body')
    if (!brk) continue
    const zoneCandle = candles[p1.idx]
    zones.push(
      finishZone(
        {
          kind: wantSweep ? 'breaker' : 'mitigation',
          side: 'bullish',
          hi: p1.price,
          lo: zoneCandle.l,
          p0Idx: p0.idx,
          p1Idx: p1.idx,
          p2Idx: p2.idx,
          breakIdx: brk.idx,
          breakCt: brk.ct,
        },
        candles,
      ),
    )
  }

  for (const p1 of lows) {
    const p0 = [...highs].reverse().find((h) => h.idx < p1.idx)
    const p2 = highs.find((h) => h.idx > p1.idx)
    if (!p0 || !p2) continue
    const swept = p2.price > p0.price
    if (swept !== wantSweep) continue
    const brk = firstLevelBreak(candles, p2.idx, p1.price, 'below', 'body')
    if (!brk) continue
    const zoneCandle = candles[p1.idx]
    zones.push(
      finishZone(
        {
          kind: wantSweep ? 'breaker' : 'mitigation',
          side: 'bearish',
          hi: zoneCandle.h,
          lo: p1.price,
          p0Idx: p0.idx,
          p1Idx: p1.idx,
          p2Idx: p2.idx,
          breakIdx: brk.idx,
          breakCt: brk.ct,
        },
        candles,
      ),
    )
  }

  return zones
}

export function breaker(candles, opts = {}) {
  return scanReversalPattern(candles, opts, true)
}

export function mitigation(candles, opts = {}) {
  return scanReversalPattern(candles, opts, false)
}

// ── premiumDiscount / dealingRange ──

// Медиана диапазона: выше 50% — премиум (зона продаж), ниже — дискаунт (зона покупок).
// A-structure-range.md [09:59].
export function premiumDiscount(price, range) {
  const { lo, hi } = range || {}
  if (!(hi > lo)) return { zone: null, pct: null, mid: null }
  const mid = (lo + hi) / 2
  const pct = (price - lo) / (hi - lo)
  const zone = price > mid ? 'premium' : price < mid ? 'discount' : 'equilibrium'
  return { zone, pct: +pct.toFixed(4), mid }
}

// Якорение диапазона [вывод] — главный риск-параметр слоя (спека §6.1): последний
// завершённый импульсный отрезок между двумя соседними свингами ПРОТИВОПОЛОЖНОГО типа.
// Берём просто последнюю пару (last swing + ближайший предыдущий свинг другого типа) —
// не «первые два свинга» и не трёхэтапную схему 2025-версии, обе из которых требуют
// доп. эвристик, которых источник не формализует численно (см. «Рендж/Консолидация»).
export function dealingRange(candles, opts = {}) {
  const n = opts.n ?? SMC_SWING_N
  const sw = swings(candles, n).sort((a, b) => a.idx - b.idx)
  if (sw.length < 2) return null
  const last = sw[sw.length - 1]
  for (let i = sw.length - 2; i >= 0; i--) {
    if (sw[i].type !== last.type) {
      const a = sw[i]
      const b = last
      const lo = Math.min(a.price, b.price)
      const hi = Math.max(a.price, b.price)
      const direction = b.price > a.price ? 'up' : 'down'
      return { lo, hi, startIdx: a.idx, endIdx: b.idx, startCt: a.ct, endCt: b.ct, direction }
    }
  }
  return null
}

// ── sweep ──

// Пробой уровня тенью с возвратом закрытия обратно — противопоставлен слому (закрытие
// тела за уровнем). Направление не задаётся явно (спека: `sweep(candles, level)`) —
// проверяются оба варианта, возвращается САМОЕ СВЕЖЕЕ совпадение в пределах lookback
// (сканируем от конца окна назад — без лукахеда, весь скан внутри уже переданного окна).
export function sweep(candles, level, opts = {}) {
  const lookback = opts.lookback ?? SMC_SWEEP_LOOKBACK
  const from = Math.max(0, candles.length - lookback)
  for (let i = candles.length - 1; i >= from; i--) {
    const k = candles[i]
    if (k.h > level && k.c < level) return { idx: i, ct: k.ct, level, dir: 'high', price: k.h }
    if (k.l < level && k.c > level) return { idx: i, ct: k.ct, level, dir: 'low', price: k.l }
  }
  return null
}

// ── smtDivergence ──

// Асимметрия структуры свингов между двумя коррелирующими активами на синхронизированных
// по времени точках (C-imbalance-smt.md). «Сильный/слабый» определяется единообразно для
// верха и низа: актив, чей второй свинг НЕ подтвердил (не обновил) экстремум партнёра —
// сильный (для лонга); актив, чей свинг подтвердил/обновил экстремум — слабый (для шорта).
export function smtDivergence(altCandles, btcCandles, opts = {}) {
  const n = opts.n ?? SMC_SWING_N
  const tol = opts.toleranceMs ?? SMC_SMT_TOLERANCE_MS
  const altSw = swings(altCandles, n)
  const btcSw = swings(btcCandles, n)

  function lastTwo(arr, type) {
    const f = arr.filter((s) => s.type === type).sort((a, b) => a.idx - b.idx)
    return f.length >= 2 ? [f[f.length - 2], f[f.length - 1]] : null
  }
  function nearestByTime(arr, ct) {
    let best = null
    let bd = Infinity
    for (const s of arr) {
      const d = Math.abs(s.ct - ct)
      if (d < bd) { bd = d; best = s }
    }
    return bd <= tol ? best : null
  }

  const out = { high: null, low: null }

  const altHighs = lastTwo(altSw, 'high')
  if (altHighs) {
    const [h1, h2] = altHighs
    const btcHighs = btcSw.filter((s) => s.type === 'high')
    const b1 = nearestByTime(btcHighs, h1.ct)
    const b2 = nearestByTime(btcHighs, h2.ct)
    if (b1 && b2) {
      const altConfirmed = h2.price > h1.price
      const btcConfirmed = b2.price > b1.price
      if (altConfirmed !== btcConfirmed) {
        out.high = {
          type: 'bearish',
          weakAsset: altConfirmed ? 'alt' : 'btc',
          strongAsset: altConfirmed ? 'btc' : 'alt',
          alt: { h1, h2 },
          btc: { b1, b2 },
        }
      }
    }
  }

  const altLows = lastTwo(altSw, 'low')
  if (altLows) {
    const [l1, l2] = altLows
    const btcLows = btcSw.filter((s) => s.type === 'low')
    const b1 = nearestByTime(btcLows, l1.ct)
    const b2 = nearestByTime(btcLows, l2.ct)
    if (b1 && b2) {
      const altConfirmed = l2.price < l1.price
      const btcConfirmed = b2.price < b1.price
      if (altConfirmed !== btcConfirmed) {
        out.low = {
          type: 'bullish',
          weakAsset: altConfirmed ? 'alt' : 'btc',
          strongAsset: altConfirmed ? 'btc' : 'alt',
          alt: { l1, l2 },
          btc: { b1, b2 },
        }
      }
    }
  }

  return out
}

// ── smcRefine — потребитель A (постпроцессор над готовым сигналом v3-focus, §6.2) ──

// Гейт 2: «есть цель-магнит» — незакрытый FVG или неснятый пул ликвидности впереди цены.
// Уровень цели [вывод]: ДАЛЬНИЙ (относительно текущей цены) край зоны — полное закрытие
// имбаланса В СТОРОНУ СДЕЛКИ, а не собственный «fulfillLevel» зоны (тот считается от
// направления, в котором зона обычно ретестируется СРАЗУ после формирования, — это не
// обязательно совпадает с тем, как её будет проходить цена намного позже и, возможно,
// с другой стороны; см. отчёт агента по этому пункту).
function findTargetMagnet(side, price, fvgZones, str) {
  if (side === 'long') {
    const cand = fvgZones.filter((z) => z.state !== 'filled' && z.lo > price).sort((a, b) => a.lo - b.lo)[0]
    if (cand) return { kind: 'fvg', level: cand.hi, zone: cand }
    const pool = str.points.filter((p) => p.type === 'high' && p.price > price).sort((a, b) => a.price - b.price)[0]
    if (pool) return { kind: 'liquidity', level: pool.price, point: pool }
    return null
  }
  const cand = fvgZones.filter((z) => z.state !== 'filled' && z.hi < price).sort((a, b) => b.hi - a.hi)[0]
  if (cand) return { kind: 'fvg', level: cand.lo, zone: cand }
  const pool = str.points.filter((p) => p.type === 'low' && p.price < price).sort((a, b) => b.price - a.price)[0]
  if (pool) return { kind: 'liquidity', level: pool.price, point: pool }
  return null
}

// Гейт 3: тест ранее не смягчённой зоны (OB/брейкер/митигейшн по стороне сделки), которую
// цена входа сейчас тестирует ВПЕРВЫЕ с момента формирования зоны.
// Индекс свечи, на которой зона СЧИТАЕТСЯ окончательно сформированной/подтверждённой —
// НЕ то же самое для разных типов зон, и раньше здесь была ошибка (нашлась при внешнем
// ревью): для OB это НЕ z.idx (сама манипулятивная свеча), а z.idx+1 — свеча, ПОГЛОТИВШАЯ
// манипулятивное движение (orderBlocks() требует её для валидности зоны вообще, см. B-blocks.md
// «без поглощения — это не ордер-блок»). Её диапазон почти всегда перекрывает зону по
// построению (она и есть подтверждение), поэтому она не «ретест», а часть формирования —
// без сдвига зона считалась «уже протестированной» в момент своего же рождения, и почти
// каждый свежий OB немедленно проваливал гейт 3. Для breaker/mitigation аналогичной второй
// подтверждающей свечи нет — z.breakIdx УЖЕ указывает на саму свечу слома (тело закрылось
// за уровнем), сдвиг не нужен.
function confirmedIdx(z) {
  return z.breakIdx != null ? z.breakIdx : z.idx + 1
}

export function findFreshPOI(side, price, obZones, brZones, mtZones, candles) {
  const wantSide = side === 'long' ? 'bullish' : 'bearish'
  const candidates = [...obZones, ...brZones, ...mtZones].filter((z) => z.side === wantSide && !z.invalidated)
  for (const z of candidates) {
    if (!(price >= z.lo && price <= z.hi)) continue
    const fIdx = confirmedIdx(z)
    const testedBefore = candles.slice(fIdx + 1, Math.max(fIdx + 1, candles.length - 1)).some(
      (k) => k.l <= z.hi && k.h >= z.lo,
    )
    if (testedBefore) continue
    return z
  }
  return null
}

// Гейт 4: свип значимого уровня перед входом — берём ближайший (по времени) свинг
// противоположного типа (для лонга — свинг-лоу, для шорта — свинг-хай) и проверяем sweep().
function findPreEntrySweep(side, candles, n) {
  const sw = swings(candles, n)
  const type = side === 'long' ? 'low' : 'high'
  const target = sw.filter((s) => s.type === type).sort((a, b) => b.idx - a.idx)[0]
  if (!target) return null
  const ev = sweep(candles, target.price, { lookback: SMC_SWEEP_LOOKBACK })
  if (!ev || ev.dir !== type) return null
  return ev
}

// improve: сужаем стоп до структурной точки, ЕСЛИ она ближе текущего 1.8×ATR (только
// сужение — расширять стоп запрещено спекой §6.2); тянем цель до магнита, ЕСЛИ он дальше
// текущего RR_CAP-таргета. Если ни одно не применимо — pass.
function computeImprovement(signal, poi, magnet) {
  const side = signal.side
  const entry = signal.entry
  let sl = signal.sl
  let tp = signal.tp
  let improved = false

  if (poi) {
    const structSl = side === 'long' ? poi.lo : poi.hi
    const validSlSide = side === 'long' ? structSl < entry : structSl > entry
    if (validSlSide) {
      const curDist = Math.abs(entry - signal.sl)
      const structDist = Math.abs(entry - structSl)
      if (structDist > 0 && structDist < curDist) { sl = structSl; improved = true }
    }
  }

  if (magnet) {
    const better = side === 'long' ? magnet.level > signal.tp : magnet.level < signal.tp
    if (better) { tp = magnet.level; improved = true }
  }

  return { sl, tp, improved }
}

// defer: лимитник в зону имбаланса/POI, TTL, инвалидация. Уровни по автору (§6.2):
// вход — начало (ближний край) зоны; стоп — «за вторую свечу формации», здесь упрощено
// [вывод] до дальнего края зоны интереса (у OB/брейкер/митигейшн не для каждого типа
// чисто выделяется «вторая свеча» — дальний край POI — тот же порядок величины и тот же
// структурный смысл: «за структуру»); цель — уровень fulfillment/магнита из гейта 2.
// poi может отсутствовать, если гейт 3 абляционно выключен и детектор ничего не нашёл —
// без зоны лимитник ставить не за что, defer невозможен (см. smcRefine: в этом случае
// вызывающая сторона не доходит до buildPending вовсе).
function buildPending(side, poi, magnet, signal) {
  const limit = side === 'long' ? poi.hi : poi.lo
  const invalidate = side === 'long' ? poi.lo : poi.hi
  const tp = magnet ? magnet.level : signal.tp
  return { limit, invalidate, sl: invalidate, tp, expiryBars: SMC_DEFER_EXPIRY_BARS }
}

// smcScore [вывод] — не часть формальных гейтов спеки, справочная свёртка confluence-
// факторов 0-100 (для отчётности/сортировки, не влияет на решение action).
function scoreOf({ magnet, poi, sweptLevel, improved }) {
  let s = 40
  s += magnet?.kind === 'fvg' ? 15 : 10
  s += poi?.kind === 'breaker' ? 20 : poi?.kind === 'mitigation' ? 15 : 10
  if (sweptLevel) s += 15
  if (improved) s += 10
  return Math.max(0, Math.min(100, s))
}

// Рефайнер: постпроцессор над готовым сигналом v3-focus (§6.2). `signal` — кандидат от
// analyzeHorizon (side/entry/sl/tp/...); `ctx.sigCandles` — то же окно сигнального ТФ,
// что получила analyzeHorizon (уже ct<=T). Гейт 1 (orderflow старшего ТФ) уже прошит в
// v3-focus (сигнала бы не было иначе) — здесь не перепроверяется.
export function smcRefine(signal, ctx) {
  const side = signal.side
  const price = signal.entry
  const sigCandles = ctx.sigCandles
  const n = ctx.swingN ?? SMC_SWING_N
  const mode = ctx.breakMode ?? SMC_BREAK_MODE
  const gates = ctx.gates ?? SMC_GATES // абляция диагностики — см. SMC_GATES

  const fvgZones = fvg(sigCandles)
  const obZones = orderBlocks(sigCandles)
  const brZones = breaker(sigCandles, { n })
  const mtZones = mitigation(sigCandles, { n })
  const str = structure(sigCandles, { n, mode })

  const reasonCodes = []

  // Гейт 2 (цель-магнит). Детектор запускается всегда — при выключенном гейте он просто
  // не ветирует своим отсутствием, но найденный магнет всё равно используется ниже для
  // improve/defer-цели.
  const magnet = findTargetMagnet(side, price, fvgZones, str)
  if (!magnet) {
    if (gates.has('2')) {
      reasonCodes.push('veto:no-target-magnet')
      return { action: 'veto', reasonCodes, smcScore: 0 }
    }
    reasonCodes.push('gate2:skipped-no-magnet')
  } else {
    reasonCodes.push(`gate2:magnet-${magnet.kind}`)
  }

  // Гейт 3 (ранее не смягчённая зона). Та же логика: детектор best-effort, ветирует только
  // если гейт включён.
  const poi = findFreshPOI(side, price, obZones, brZones, mtZones, sigCandles)
  if (!poi) {
    if (gates.has('3')) {
      reasonCodes.push('veto:no-fresh-poi')
      return { action: 'veto', reasonCodes, smcScore: 0 }
    }
    reasonCodes.push('gate3:skipped-no-poi')
  } else {
    reasonCodes.push(`gate3:poi-${poi.kind ?? poi.type}`)
  }

  // Гейт 4 (свип перед входом) — ядро механизма, в абляции не выключается (без него нет
  // самого различения pass/improve vs defer). Если поза лишена poi (гейт 3 абляционно
  // выключен и ничего не нашлось) — строить лимитник не от чего, defer вырождается в pass.
  const sweptLevel = findPreEntrySweep(side, sigCandles, n)
  if (sweptLevel) {
    reasonCodes.push('gate4:swept')
    const { sl, tp, improved } = computeImprovement(signal, poi, magnet)
    const smcScore = scoreOf({ magnet, poi, sweptLevel, improved })
    if (improved) return { action: 'improve', reasonCodes, sl, tp, smcScore }
    return { action: 'pass', reasonCodes, smcScore }
  }

  reasonCodes.push('gate4:no-sweep-defer')
  if (!poi) {
    reasonCodes.push('defer:no-poi-fallback-pass')
    return { action: 'pass', reasonCodes, smcScore: scoreOf({ magnet, poi, sweptLevel: null, improved: false }) }
  }
  const pending = buildPending(side, poi, magnet, signal)
  const smcScore = scoreOf({ magnet, poi, sweptLevel: null, improved: false })
  return { action: 'defer', reasonCodes, pending, smcScore }
}
