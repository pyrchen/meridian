// Meridian — движок среднесрочных сигналов по альткойнам.
// Запускается в GitHub Actions (cron ~30 мин). Аналитический «сервер» = раннер,
// «база данных» = public/data/signals.json в git (плюс полная история коммитов).
//
// Логика: мульти-таймфрейм. Дневной график — фильтр тренда (EMA50/EMA200).
// 4h график — вход: EMA, RSI, MACD, ATR, ADX, объём → составной скор 0-100.
// Вход/стоп/тейк по ATR с фиксированным risk:reward. Лонги — спот+фьючерс,
// шорты — только фьючерс. Сигналы НЕ перерисовываются: считаем по ЗАКРЫТЫМ свечам.
//
// Исход открытых сигналов оценивается по high/low закрытых свечей с момента входа:
// при равном касании TP и SL в одной свече берём консервативно SL (как в честном
// бэктесте). Старые незакрытые сигналы истекают через MAX_AGE_DAYS.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ema, rsi, macd, atr, adx, sma } from './indicators.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_PATH = resolve(ROOT, 'public', 'data', 'signals.json')

// ── параметры стратегии ──
const TOP_N = 100 // сколько альткойнов сканируем
const SCORE_MIN = 62 // минимальный скор для выдачи сигнала
const ATR_MULT = 1.8 // стоп = ATR * множитель
const RR = 2.5 // risk:reward (тейк = риск * RR)
const MAX_AGE_DAYS = 12 // незакрытый сигнал истекает
const KEEP_CLOSED = 400 // сколько закрытых храним в JSON (вся история — в git)
const TIMEOUT = 12000

const STABLES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USDD', 'EUR', 'EURI',
  'USDE', 'PYUSD', 'GUSD', 'USTC', 'AEUR', 'EURT', 'XUSD', 'USD1',
])
const LEVERAGED = /(\d+[LS]|UP|DOWN|BULL|BEAR)$/

async function getJSON(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'MeridianSignals/1.0', Accept: 'application/json' },
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

async function klines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const raw = await getJSON(url)
  // [openTime, open, high, low, close, volume, closeTime, ...]
  return raw.map((k) => ({
    t: k[0],
    o: +k[1],
    h: +k[2],
    l: +k[3],
    c: +k[4],
    v: +k[5],
    ct: k[6],
  }))
}

// только закрытые свечи (последняя в ответе Binance — формирующаяся)
function closed(cs, now) {
  return cs.filter((k) => k.ct <= now)
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length)
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const idx = i++
      try {
        ret[idx] = await fn(items[idx], idx)
      } catch {
        ret[idx] = null
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return ret
}

async function buildUniverse() {
  const all = await getJSON('https://api.binance.com/api/v3/ticker/24hr')
  const rows = all
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
    .filter(
      (r) =>
        r.base &&
        r.base !== 'BTC' && // альткойны
        !STABLES.has(r.base) &&
        !LEVERAGED.test(r.base) &&
        Number.isFinite(r.qv),
    )
    .sort((a, b) => b.qv - a.qv)
  return rows.slice(0, TOP_N)
}

function analyze(symbol, base, daily, h4, now) {
  const d = closed(daily, now)
  const f = closed(h4, now)
  if (d.length < 200 || f.length < 60) return null

  const dC = d.map((k) => k.c)
  const dEma50 = ema(dC, 50)
  const dEma200 = ema(dC, 200)
  if (dEma50 == null || dEma200 == null) return null
  const dClose = dC[dC.length - 1]
  const trendUp = dClose > dEma200 && dEma50 > dEma200
  const trendDown = dClose < dEma200 && dEma50 < dEma200
  if (!trendUp && !trendDown) return null

  const fC = f.map((k) => k.c)
  const fH = f.map((k) => k.h)
  const fL = f.map((k) => k.l)
  const fV = f.map((k) => k.v)
  const close = fC[fC.length - 1]
  const ema50 = ema(fC, 50)
  const ema200 = fC.length >= 200 ? ema(fC, 200) : null
  const r = rsi(fC, 14)
  const m = macd(fC)
  const a = atr(fH, fL, fC, 14)
  const adxv = adx(fH, fL, fC, 14)
  const volAvg = sma(fV, 20)
  if (ema50 == null || r == null || !m || a == null || adxv == null) return null

  const side = trendUp ? 'long' : 'short'
  const crossUp = m.prevHist != null && m.prevHist <= 0 && m.hist > 0
  const crossDown = m.prevHist != null && m.prevHist >= 0 && m.hist < 0
  const volHigh = volAvg != null && fV[fV.length - 1] > volAvg * 1.2

  const reasons = []
  let score = 0

  if (side === 'long') {
    // обязательные условия
    if (!(close > ema50) || !(m.hist > 0) || !(r >= 45 && r <= 68) || adxv < 18)
      return null
    reasons.push('Дневной тренд вверх: цена > EMA200, EMA50 > EMA200')
    score += 25
    if (close > ema50) {
      reasons.push('4h: цена выше EMA50 (импульс по тренду)')
      score += 15
    }
    if (m.hist > 0) {
      reasons.push(crossUp ? 'MACD пересёк сигнальную вверх' : 'MACD-гистограмма положительна')
      score += crossUp ? 22 : 12
    }
    if (r >= 50 && r <= 62) {
      reasons.push(`RSI ${r.toFixed(0)} — здоровый импульс без перегрева`)
      score += 13
    } else {
      reasons.push(`RSI ${r.toFixed(0)} в рабочей зоне`)
      score += 7
    }
    if (ema200 != null && close > ema200) {
      reasons.push('4h: цена выше EMA200')
      score += 8
    }
  } else {
    if (!(close < ema50) || !(m.hist < 0) || !(r >= 32 && r <= 55) || adxv < 18)
      return null
    reasons.push('Дневной тренд вниз: цена < EMA200, EMA50 < EMA200')
    score += 25
    if (close < ema50) {
      reasons.push('4h: цена ниже EMA50 (импульс по тренду)')
      score += 15
    }
    if (m.hist < 0) {
      reasons.push(crossDown ? 'MACD пересёк сигнальную вниз' : 'MACD-гистограмма отрицательна')
      score += crossDown ? 22 : 12
    }
    if (r >= 38 && r <= 50) {
      reasons.push(`RSI ${r.toFixed(0)} — нисходящий импульс без перепроданности`)
      score += 13
    } else {
      reasons.push(`RSI ${r.toFixed(0)} в рабочей зоне`)
      score += 7
    }
    if (ema200 != null && close < ema200) {
      reasons.push('4h: цена ниже EMA200')
      score += 8
    }
  }

  if (adxv >= 28) {
    reasons.push(`ADX ${adxv.toFixed(0)} — сильный тренд`)
    score += 12
  } else {
    reasons.push(`ADX ${adxv.toFixed(0)} — тренд подтверждён`)
    score += 6
  }
  if (volHigh) {
    reasons.push('Объём выше среднего за 20 свечей')
    score += 8
  }

  score = Math.min(100, Math.round(score))
  if (score < SCORE_MIN) return null

  const slDist = ATR_MULT * a
  const entry = close
  const sl = side === 'long' ? entry - slDist : entry + slDist
  const tp = side === 'long' ? entry + RR * slDist : entry - RR * slDist
  if (!(slDist > 0) || sl <= 0 || tp <= 0) return null

  return {
    symbol,
    base,
    side,
    markets: side === 'long' ? ['spot', 'futures'] : ['futures'],
    entry: round(entry),
    sl: round(sl),
    tp: round(tp),
    atr: round(a),
    riskPct: +((slDist / entry) * 100).toFixed(2),
    targetPct: +(((RR * slDist) / entry) * 100).toFixed(2),
    strength: score,
    reasons,
    indicators: {
      rsi: +r.toFixed(1),
      adx: +adxv.toFixed(1),
      macdHist: +m.hist.toPrecision(3),
    },
    timeframe: '4h',
  }
}

function round(n) {
  if (n >= 1000) return +n.toFixed(2)
  if (n >= 1) return +n.toFixed(4)
  if (n >= 0.01) return +n.toFixed(6)
  return +n.toPrecision(4)
}

function evaluateSignal(sig, candles, now) {
  const created = new Date(sig.createdAt).getTime()
  const after = closed(candles, now).filter((k) => k.t > created)
  for (const k of after) {
    if (sig.side === 'long') {
      const hitSL = k.l <= sig.sl
      const hitTP = k.h >= sig.tp
      if (hitSL) return closeSig(sig, 'sl', sig.sl, k.ct) // консервативно при двойном касании
      if (hitTP) return closeSig(sig, 'tp', sig.tp, k.ct)
    } else {
      const hitSL = k.h >= sig.sl
      const hitTP = k.l <= sig.tp
      if (hitSL) return closeSig(sig, 'sl', sig.sl, k.ct)
      if (hitTP) return closeSig(sig, 'tp', sig.tp, k.ct)
    }
  }
  if ((now - created) / 864e5 > MAX_AGE_DAYS) {
    const last = after.length ? after[after.length - 1] : null
    const exit = last ? last.c : sig.entry
    return closeSig(sig, 'expired', exit, last ? last.ct : now)
  }
  return null
}

function closeSig(sig, status, exit, ct) {
  const dir = sig.side === 'long' ? 1 : -1
  const pnlPct = ((exit - sig.entry) / sig.entry) * 100 * dir
  const riskPct = sig.riskPct || (Math.abs(sig.entry - sig.sl) / sig.entry) * 100
  return {
    ...sig,
    status,
    exitPrice: round(exit),
    closedAt: new Date(ct).toISOString(),
    pnlPct: +pnlPct.toFixed(2),
    r: +(pnlPct / riskPct).toFixed(2),
  }
}

function computeStats(open, closed) {
  const wins = closed.filter((s) => s.status === 'tp')
  const losses = closed.filter((s) => s.status === 'sl')
  const expired = closed.filter((s) => s.status === 'expired')
  const decided = wins.length + losses.length
  const rs = closed.filter((s) => s.status !== 'expired').map((s) => s.r)
  const side = (sd) => {
    const c = closed.filter((s) => s.side === sd && s.status !== 'expired')
    const w = c.filter((s) => s.status === 'tp').length
    return { total: c.length, wins: w, winRate: c.length ? +((w / c.length) * 100).toFixed(1) : 0 }
  }
  return {
    open: open.length,
    closedTotal: closed.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winRate: decided ? +((wins.length / decided) * 100).toFixed(1) : 0,
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : 0,
    totalPnlPct: +closed.reduce((a, s) => a + (s.pnlPct || 0), 0).toFixed(1),
    long: side('long'),
    short: side('short'),
  }
}

async function loadPrev() {
  try {
    const j = JSON.parse(await readFile(OUT_PATH, 'utf8'))
    return { open: j.open || [], closed: j.closed || [] }
  } catch {
    return { open: [], closed: [] }
  }
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('Watchdog: анализ превысил 240с — выход')
    process.exit(1)
  }, 240_000)

  const now = Date.now()
  const prev = await loadPrev()
  console.log(`Загружено: ${prev.open.length} открытых, ${prev.closed.length} закрытых`)

  const universe = await buildUniverse()
  console.log(`Универсум: ${universe.length} альткойнов по объёму`)

  // тянем дневные + 4h свечи
  const data = await mapLimit(universe, 8, async (u) => {
    const [daily, h4] = await Promise.all([
      klines(u.symbol, '1d', 250),
      klines(u.symbol, '4h', 320),
    ])
    return { ...u, daily, h4 }
  })
  const fetched = data.filter(Boolean)
  const h4map = new Map(fetched.map((x) => [x.symbol, x.h4]))
  console.log(`Свечи получены: ${fetched.length}`)

  // 1) оценка открытых сигналов
  const stillOpen = []
  const newlyClosed = []
  for (const sig of prev.open) {
    let candles = h4map.get(sig.symbol)
    if (!candles) {
      try {
        candles = await klines(sig.symbol, '4h', 320)
      } catch {
        candles = null
      }
    }
    if (!candles) {
      stillOpen.push(sig)
      continue
    }
    const res = evaluateSignal(sig, candles, now)
    if (res) newlyClosed.push(res)
    else stillOpen.push(sig)
  }

  // 2) генерация новых сигналов (дедуп против уже открытых по symbol+side)
  const openKey = new Set(stillOpen.map((s) => s.symbol + s.side))
  let added = 0
  for (const x of fetched) {
    const sig = analyze(x.symbol, x.base, x.daily, x.h4, now)
    if (!sig) continue
    if (openKey.has(sig.symbol + sig.side)) continue
    sig.id = `${sig.base}-${sig.side}-${now}-${added}`
    sig.createdAt = new Date(now).toISOString()
    sig.status = 'open'
    stillOpen.push(sig)
    openKey.add(sig.symbol + sig.side)
    added++
  }

  // 3) сборка и сохранение
  const closedAll = [...newlyClosed, ...prev.closed]
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, KEEP_CLOSED)
  const openSorted = stillOpen.sort((a, b) => b.strength - a.strength)
  const stats = computeStats(openSorted, closedAll)

  const out = {
    generatedAt: new Date(now).toISOString(),
    universeSize: fetched.length,
    params: { timeframe: '4h + дневной фильтр', atrMult: ATR_MULT, rr: RR, scoreMin: SCORE_MIN },
    stats,
    open: openSorted,
    closed: closedAll,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(out), 'utf8')
  console.log(
    `Готово: +${added} новых, ${newlyClosed.length} закрыто, открыто ${openSorted.length}. Винрейт ${stats.winRate}% (${stats.wins}W/${stats.losses}L).`,
  )

  clearTimeout(watchdog)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
