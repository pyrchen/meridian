// Технические индикаторы (чистый JS, без зависимостей). Все на массивах цен.

export function sma(arr, p) {
  if (arr.length < p) return null
  let s = 0
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i]
  return s / p
}

// EMA-ряд (разрежен до индекса p-1, дальше плотный)
export function emaSeries(arr, p) {
  if (arr.length < p) return []
  const k = 2 / (p + 1)
  const out = new Array(arr.length)
  let prev = 0
  for (let i = 0; i < p; i++) prev += arr[i]
  prev /= p
  out[p - 1] = prev
  for (let i = p; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function ema(arr, p) {
  const s = emaSeries(arr, p)
  return s.length ? s[s.length - 1] : null
}

// RSI по Уайлдеру
export function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= p
  loss /= p
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (p - 1) + (d > 0 ? d : 0)) / p
    loss = (loss * (p - 1) + (d < 0 ? -d : 0)) / p
  }
  if (loss === 0) return 100
  return 100 - 100 / (1 + gain / loss)
}

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  if (closes.length < slow + sig) return null
  const ef = emaSeries(closes, fast)
  const es = emaSeries(closes, slow)
  const line = []
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i])
  }
  const sigSeries = emaSeries(line, sig)
  const macdVal = line[line.length - 1]
  const signalVal = sigSeries[sigSeries.length - 1]
  const prevMacd = line[line.length - 2]
  const prevSignal = sigSeries[sigSeries.length - 2]
  return {
    macd: macdVal,
    signal: signalVal,
    hist: macdVal - signalVal,
    prevHist: prevMacd != null && prevSignal != null ? prevMacd - prevSignal : null,
  }
}

// ATR по Уайлдеру
export function atr(highs, lows, closes, p = 14) {
  if (closes.length < p + 1) return null
  const tr = []
  for (let i = 1; i < closes.length; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    )
  }
  let a = 0
  for (let i = 0; i < p; i++) a += tr[i]
  a /= p
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p
  return a
}

// DMI/ADX по Уайлдеру: сила тренда (ADX) + направление (+DI/-DI на последней свече)
function _dmi(highs, lows, closes, p = 14) {
  if (closes.length < 2 * p + 1) return null
  const tr = []
  const plusDM = []
  const minusDM = []
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i - 1]
    const down = lows[i - 1] - lows[i]
    plusDM.push(up > down && up > 0 ? up : 0)
    minusDM.push(down > up && down > 0 ? down : 0)
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    )
  }
  const smooth = (a) => {
    let s = 0
    for (let i = 0; i < p; i++) s += a[i]
    const out = [s]
    for (let i = p; i < a.length; i++) {
      s = s - s / p + a[i]
      out.push(s)
    }
    return out
  }
  const trS = smooth(tr)
  const pS = smooth(plusDM)
  const mS = smooth(minusDM)
  const dx = []
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) {
      dx.push(0)
      continue
    }
    const pdi = (100 * pS[i]) / trS[i]
    const mdi = (100 * mS[i]) / trS[i]
    const sum = pdi + mdi
    dx.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum)
  }
  if (dx.length < p) return null
  let adxv = 0
  for (let i = 0; i < p; i++) adxv += dx[i]
  adxv /= p
  for (let i = p; i < dx.length; i++) adxv = (adxv * (p - 1) + dx[i]) / p
  const last = trS.length - 1
  const plusDI = trS[last] ? (100 * pS[last]) / trS[last] : 0
  const minusDI = trS[last] ? (100 * mS[last]) / trS[last] : 0
  return { adx: adxv, plusDI, minusDI }
}

export function adx(highs, lows, closes, p = 14) {
  const d = _dmi(highs, lows, closes, p)
  return d ? d.adx : null
}

export function dmi(highs, lows, closes, p = 14) {
  return _dmi(highs, lows, closes, p)
}

export function bollinger(closes, p = 20, mult = 2) {
  if (closes.length < p) return null
  const slice = closes.slice(-p)
  const mean = slice.reduce((a, b) => a + b, 0) / p
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / p
  const sd = Math.sqrt(variance)
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd, sd }
}

// Перцентиль текущей реализованной волатильности (0..1) среди скользящего окна.
// Волатильность = std лог-доходностей за lookback свечей. Нужно, чтобы душить
// «мёртвую волу» (низ перцентиль) и сжимать риск в экстремальной (верх перцентиль).
export function volPercentile(closes, lookback = 14, window = 100) {
  if (closes.length < lookback + 3) return null
  const rets = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const vols = []
  for (let i = lookback; i <= rets.length; i++) {
    const slice = rets.slice(i - lookback, i)
    const m = slice.reduce((a, b) => a + b, 0) / lookback
    const v = slice.reduce((a, b) => a + (b - m) ** 2, 0) / lookback
    vols.push(Math.sqrt(v))
  }
  if (vols.length < 5) return null
  const cur = vols[vols.length - 1]
  const hist = vols.slice(-window)
  let le = 0
  for (const v of hist) if (v <= cur) le++
  return le / hist.length
}

// Агрегация свечей в более крупный ТФ (например 4 недельных → «месяц»).
//
// P0-7 fix (было: группы выровнены по КОНЦУ массива — `rem = candles.length % factor`,
// т.е. с какой свечи начинается первая группа, зависело от ТЕКУЩЕЙ длины входного массива.
// Когда раз в неделю дописывается новая свеча, длина меняется, `rem` циклически сдвигается
// (0→1→2→3→0…), и уже ЗАВЕРШЁННЫЕ месячные группы прошлого меняют состав между прогонами —
// veryLong-тренд «перерисовывался» задним числом).
//
// Теперь группы календарно заякорены: индекс группы = floor(epochWeek(t) / factor) —
// чистая функция от АБСОЛЮТНОГО времени свечи, не от позиции в массиве/его длины. Одна и та
// же календарная неделя всегда попадает в одну и ту же группу независимо от того, сколько
// свечей всего в массиве сейчас. Дописывание новой свечи может только продлить текущую
// (ещё неполную) группу или открыть следующую — уже завершённые группы не трогает.
// Как и раньше, наружу отдаём только ПОЛНЫЕ группы (ровно `factor` свечей): неполная
// голова (первая группа входного среза, если он не начинается на границе) и неполный
// хвост (текущая неделя, ещё не набравшая factor свечей) отбрасываются одинаково.
const WEEK_MS = 7 * 24 * 3600 * 1000

function mergeGroup(g) {
  return {
    t: g[0].t,
    o: g[0].o,
    h: Math.max(...g.map((k) => k.h)),
    l: Math.min(...g.map((k) => k.l)),
    c: g[g.length - 1].c,
    v: g.reduce((a, k) => a + k.v, 0),
    ct: g[g.length - 1].ct,
  }
}

export function aggregate(candles, factor) {
  if (!factor || factor <= 1) return candles
  const out = []
  let group = []
  let curIdx = null
  const flush = () => { if (group.length === factor) out.push(mergeGroup(group)); group = [] }
  for (const k of candles) {
    const idx = Math.floor(k.t / WEEK_MS / factor)
    if (curIdx !== null && idx !== curIdx) flush()
    group.push(k)
    curIdx = idx
  }
  flush() // финализируем последнюю группу, только если она полная — иначе это ещё копящийся хвост
  return out
}
