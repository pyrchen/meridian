// Meridian — движок сигналов по альткойнам (мульти-горизонт + новости + режим BTC).
// Запускается в GitHub Actions (cron ~30 мин). «Сервер» = раннер, «БД» = git.
//
// Горизонты (для фьючерсов — все три, спот — только средне/долго, т.к. спот = хранение):
//   • Скальп  — сигнал 1h,  тренд-фильтр 4h   (часы)
//   • Средне  — сигнал 4h,  тренд-фильтр 1d   (дни)
//   • Долго   — сигнал 1d,  тренд-фильтр 1d   (недели)
//
// Стратегия на каждом горизонте: тренд старшего ТФ + вход по сигнальному ТФ
// (EMA50/200, RSI, MACD, ATR, ADX, объём) → составной скор 0-100. Вход/стоп/тейк
// по ATR с R:R. Сигналы не перерисовываются — считаем по ЗАКРЫТЫМ свечам.
//
// Учитываются:
//   • Новости — упоминания монеты в свежей ленте (crypto/ai/business) + грубый тон:
//     против сделки — режет скор (вплоть до отмены), за — добавляет.
//   • Режим BTC — нисходящий BTC давит лонги альтов, восходящий — шорты.
//
// Исход (TP/SL) оценивается по high/low закрытых свечей; при двойном касании — SL.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ema, rsi, macd, atr, adx, sma } from './indicators.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_PATH = resolve(ROOT, 'public', 'data', 'signals.json')
const NEWS_PATH = resolve(ROOT, 'public', 'data', 'news.json')

// Гео-нейтральное публичное зеркало Binance (api.binance.com отдаёт 451 на
// US-IP, где крутятся GitHub-раннеры). Тот же формат, без авторизации.
const BINANCE = 'https://data-api.binance.vision'

const TOP_N = 100
const SCORE_MIN = 62
const ATR_MULT = 1.8
const RR = 2.5
const MAX_AGE_DAYS = { scalp: 4, mid: 12, long: 45 } // срок жизни по горизонту
const KEEP_CLOSED = 300
const SPARK_N = 44
const TIMEOUT = 12000

const HORIZONS = [
  { key: 'scalp', label: 'Скальп', sigTf: '1h', trendTf: '4h', tfHours: 1 },
  { key: 'mid', label: 'Средне', sigTf: '4h', trendTf: '1d', tfHours: 4 },
  { key: 'long', label: 'Долго', sigTf: '1d', trendTf: '1d', tfHours: 24 },
]
const KLINE_LIMITS = { '1h': 330, '4h': 330, '1d': 320 }

const STABLES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USDD', 'EUR', 'EURI',
  'USDE', 'PYUSD', 'GUSD', 'USTC', 'AEUR', 'EURT', 'XUSD', 'USD1',
  'RLUSD', 'USDG', 'USD0', 'USDY', 'USDX', 'EURC', 'FRAX', 'GHO',
  'CRVUSD', 'SUSD', 'USDS', 'BOLD', 'USDF', 'FDUSDT',
])
const LEVERAGED = /(\d+[LS]|UP|DOWN|BULL|BEAR)$/

// ── сеть ──
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
  const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const raw = await getJSON(url)
  return raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }))
}

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
  const all = await getJSON(`${BINANCE}/api/v3/ticker/24hr`)
  return all
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
    .filter(
      (r) =>
        r.base && r.base !== 'BTC' && !STABLES.has(r.base) && !LEVERAGED.test(r.base) && Number.isFinite(r.qv),
    )
    .sort((a, b) => b.qv - a.qv)
    .slice(0, TOP_N)
}

// ── режим BTC ──
async function btcRegime(now) {
  try {
    const d = closed(await klines('BTCUSDT', '1d', 320), now)
    const c = d.map((k) => k.c)
    const e50 = ema(c, 50)
    const e200 = ema(c, 200)
    const last = c[c.length - 1]
    const dir = last > e200 && e50 > e200 ? 'up' : last < e200 && e50 < e200 ? 'down' : 'flat'
    const wk = c.length > 7 ? ((last - c[c.length - 8]) / c[c.length - 8]) * 100 : 0
    return { dir, change7d: +wk.toFixed(1) }
  } catch {
    return { dir: 'flat', change7d: 0 }
  }
}

// ── новостной индекс ──
const COIN_NAMES = {
  ETH: ['ethereum', 'эфир', 'эфириум'], SOL: ['solana', 'солан'], XRP: ['ripple', 'рипл'],
  BNB: ['binance coin', 'bnb'], DOGE: ['dogecoin', 'доги'], ADA: ['cardano', 'кардано'],
  AVAX: ['avalanche', 'аваланч'], LINK: ['chainlink', 'чейнлинк'], DOT: ['polkadot', 'полкадот'],
  POL: ['polygon', 'полигон'], MATIC: ['polygon', 'полигон'], TRX: ['tron', 'трон'],
  LTC: ['litecoin', 'лайткоин'], SHIB: ['shiba', 'шиба'], TON: ['toncoin'], NEAR: ['near protocol'],
  APT: ['aptos'], ARB: ['arbitrum', 'арбитрум'], OP: ['optimism'], SUI: ['sui network'],
  INJ: ['injective'], PEPE: ['pepe', 'пепе'], WIF: ['dogwifhat'], BONK: ['bonk'],
  FET: ['fetch.ai', 'fetch ai', 'artificial superintelligence'], RENDER: ['render network'],
  RNDR: ['render network'], FIL: ['filecoin'], ATOM: ['cosmos'], UNI: ['uniswap'],
  AAVE: ['aave'], MKR: ['makerdao', 'maker dao'], ICP: ['internet computer'], HBAR: ['hedera'],
  ETC: ['ethereum classic'], XLM: ['stellar'], ALGO: ['algorand'], VET: ['vechain'],
  TAO: ['bittensor'], SEI: ['sei network'], TIA: ['celestia'], JUP: ['jupiter'],
  ENA: ['ethena'], ONDO: ['ondo'], WLD: ['worldcoin'], TRUMP: ['trump'], PENGU: ['pudgy'],
}
const NEG = ['hack', 'exploit', 'breach', 'lawsuit', 'sue', ' sec ', ' ban', 'delist', 'scam', 'rug', 'crash', 'plunge', 'halt', 'freeze', 'fraud', 'vulnerab', 'outage', 'взлом', ' иск', 'запрет', 'делистинг', 'обвал', 'паде', 'заморозк', 'мошен', 'крах']
const POS = ['partnership', 'listing', ' etf', 'upgrade', 'integrat', 'launch', 'adopt', 'rally', 'surge', 'approval', 'mainnet', 'staking', 'partner', 'invest', 'партнёр', 'листинг', 'запуск', 'рост', 'одобр', 'интеграц', 'инвест', 'обновлен']

async function loadNewsIndex(now) {
  let items = []
  try {
    const j = JSON.parse(await readFile(NEWS_PATH, 'utf8'))
    const cats = ['crypto', 'ai', 'business']
    for (const c of cats) for (const it of j.categories?.[c] || []) items.push(it)
  } catch {
    return () => null
  }
  const cutoff = now - 72 * 3.6e6
  const prepared = items
    .filter((it) => !it.publishedAt || new Date(it.publishedAt).getTime() > cutoff)
    .map((it) => ({
      title: it.title,
      source: it.source,
      url: it.url,
      publishedAt: it.publishedAt,
      lower: ((it.title || '') + ' ' + (it.summary || '')).toLowerCase(),
    }))

  return (base) => {
    const names = COIN_NAMES[base] || []
    const tickerRe = base.length >= 4 ? new RegExp(`\\b${base}\\b`, 'i') : null
    const hits = []
    for (const it of prepared) {
      let ok = false
      for (const nm of names) if (it.lower.includes(nm)) { ok = true; break }
      if (!ok && tickerRe && tickerRe.test(it.title)) ok = true
      if (ok) hits.push(it)
      if (hits.length >= 4) break
    }
    if (!hits.length) return null
    let score = 0
    for (const h of hits) {
      for (const w of NEG) if (h.lower.includes(w)) score--
      for (const w of POS) if (h.lower.includes(w)) score++
    }
    const sentiment = score > 0 ? 'pos' : score < 0 ? 'neg' : 'neutral'
    return {
      count: hits.length,
      sentiment,
      items: hits.slice(0, 3).map((h) => ({ title: h.title, source: h.source, url: h.url, publishedAt: h.publishedAt })),
    }
  }
}

// ── индикаторы / тренд ──
function trendDir(trendClosed) {
  if (trendClosed.length < 200) return null
  const c = trendClosed.map((k) => k.c)
  const e50 = ema(c, 50)
  const e200 = ema(c, 200)
  if (e50 == null || e200 == null) return null
  const last = c[c.length - 1]
  if (last > e200 && e50 > e200) return 'up'
  if (last < e200 && e50 < e200) return 'down'
  return null
}

function round(n) {
  if (n >= 1000) return +n.toFixed(2)
  if (n >= 1) return +n.toFixed(4)
  if (n >= 0.01) return +n.toFixed(6)
  return +n.toPrecision(4)
}

function estimateEtaHours(adxv, tfHours) {
  const eff = Math.min(0.6, Math.max(0.25, 0.25 + (adxv - 18) / 120))
  return Math.round(((RR * ATR_MULT) / eff) * tfHours)
}

function analyzeHorizon(u, H, sigCandles, trendCandles, btc, newsHit, now) {
  const trend = trendDir(closed(trendCandles, now))
  if (!trend) return null
  const f = closed(sigCandles, now)
  if (f.length < 60) return null

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

  const side = trend === 'up' ? 'long' : 'short'
  const crossUp = m.prevHist != null && m.prevHist <= 0 && m.hist > 0
  const crossDown = m.prevHist != null && m.prevHist >= 0 && m.hist < 0
  const volHigh = volAvg != null && fV[fV.length - 1] > volAvg * 1.2

  const reasons = []
  let score = 0

  if (side === 'long') {
    if (!(close > ema50) || !(m.hist > 0) || !(r >= 45 && r <= 68) || adxv < 18) return null
    reasons.push(`Тренд ${H.trendTf} вверх: цена > EMA200, EMA50 > EMA200`)
    score += 25
    reasons.push(`${H.sigTf}: цена выше EMA50 — импульс по тренду`)
    score += 15
    reasons.push(crossUp ? 'MACD пересёк сигнальную вверх' : 'MACD-гистограмма положительна')
    score += crossUp ? 22 : 12
    if (r >= 50 && r <= 62) { reasons.push(`RSI ${r.toFixed(0)} — здоровый импульс`); score += 13 }
    else { reasons.push(`RSI ${r.toFixed(0)} в рабочей зоне`); score += 7 }
    if (ema200 != null && close > ema200) { reasons.push(`${H.sigTf}: цена выше EMA200`); score += 8 }
  } else {
    if (!(close < ema50) || !(m.hist < 0) || !(r >= 32 && r <= 55) || adxv < 18) return null
    reasons.push(`Тренд ${H.trendTf} вниз: цена < EMA200, EMA50 < EMA200`)
    score += 25
    reasons.push(`${H.sigTf}: цена ниже EMA50 — импульс по тренду`)
    score += 15
    reasons.push(crossDown ? 'MACD пересёк сигнальную вниз' : 'MACD-гистограмма отрицательна')
    score += crossDown ? 22 : 12
    if (r >= 38 && r <= 50) { reasons.push(`RSI ${r.toFixed(0)} — нисходящий импульс`); score += 13 }
    else { reasons.push(`RSI ${r.toFixed(0)} в рабочей зоне`); score += 7 }
    if (ema200 != null && close < ema200) { reasons.push(`${H.sigTf}: цена ниже EMA200`); score += 8 }
  }

  if (adxv >= 28) { reasons.push(`ADX ${adxv.toFixed(0)} — сильный тренд`); score += 12 }
  else { reasons.push(`ADX ${adxv.toFixed(0)} — тренд подтверждён`); score += 6 }
  if (volHigh) { reasons.push('Объём выше среднего за 20 свечей'); score += 8 }

  // режим BTC (для скальпа влияет слабее)
  const w = H.key === 'scalp' ? 0.5 : 1
  if (side === 'long') {
    if (btc.dir === 'down') { reasons.push('⚠ BTC в нисходящем тренде — риск для лонгов альтов'); score -= 10 * w }
    else if (btc.dir === 'up') { reasons.push('BTC в восходящем тренде — попутный ветер'); score += 5 * w }
  } else {
    if (btc.dir === 'up') { reasons.push('⚠ BTC растёт — риск для шорта альта'); score -= 8 * w }
    else if (btc.dir === 'down') { reasons.push('BTC слабый — поддержка шорта'); score += 5 * w }
  }

  // новостной фон
  let news = null
  if (newsHit) {
    news = newsHit
    const against = (side === 'long' && news.sentiment === 'neg') || (side === 'short' && news.sentiment === 'pos')
    const forIt = (side === 'long' && news.sentiment === 'pos') || (side === 'short' && news.sentiment === 'neg')
    if (against) { reasons.push(`⚠ Новостной фон против сделки (${news.count} упоминаний)`); score -= 14 }
    else if (forIt) { reasons.push(`Новостной фон поддерживает (${news.count} упоминаний)`); score += 6 }
    else { reasons.push(`В новостях ${news.count} упоминаний — проверь фон`) }
  }

  score = Math.min(100, Math.round(score))
  if (score < SCORE_MIN) return null

  const slDist = ATR_MULT * a
  const entry = close
  const sl = side === 'long' ? entry - slDist : entry + slDist
  const tp = side === 'long' ? entry + RR * slDist : entry - RR * slDist
  if (!(slDist > 0) || sl <= 0 || tp <= 0) return null

  const markets = H.key === 'scalp' ? ['futures'] : side === 'long' ? ['spot', 'futures'] : ['futures']

  return {
    symbol: u.symbol,
    base: u.base,
    side,
    horizon: H.key,
    horizonLabel: H.label,
    timeframe: H.sigTf,
    markets,
    entry: round(entry),
    sl: round(sl),
    tp: round(tp),
    atr: round(a),
    riskPct: +((slDist / entry) * 100).toFixed(2),
    targetPct: +(((RR * slDist) / entry) * 100).toFixed(2),
    strength: score,
    etaHours: estimateEtaHours(adxv, H.tfHours),
    reasons,
    indicators: { rsi: +r.toFixed(1), adx: +adxv.toFixed(1), macdHist: +m.hist.toPrecision(3) },
    news: news ? news.items : null,
    newsSentiment: news ? news.sentiment : null,
    newsCount: news ? news.count : 0,
    spark: fC.slice(-SPARK_N).map((x) => round(x)),
  }
}

// ── оценка исхода ──
function evaluateSignal(sig, candles, now) {
  const created = new Date(sig.createdAt).getTime()
  const after = closed(candles, now).filter((k) => k.t > created)
  for (const k of after) {
    if (sig.side === 'long') {
      if (k.l <= sig.sl) return closeSig(sig, 'sl', sig.sl, k.ct)
      if (k.h >= sig.tp) return closeSig(sig, 'tp', sig.tp, k.ct)
    } else {
      if (k.h >= sig.sl) return closeSig(sig, 'sl', sig.sl, k.ct)
      if (k.l <= sig.tp) return closeSig(sig, 'tp', sig.tp, k.ct)
    }
  }
  const maxAge = (MAX_AGE_DAYS[sig.horizon] || 12) * 864e5
  if (now - created > maxAge) {
    const last = after.length ? after[after.length - 1] : null
    return closeSig(sig, 'expired', last ? last.c : sig.entry, last ? last.ct : now)
  }
  return null
}

function closeSig(sig, status, exit, ct) {
  const dir = sig.side === 'long' ? 1 : -1
  const pnlPct = ((exit - sig.entry) / sig.entry) * 100 * dir
  const riskPct = sig.riskPct || (Math.abs(sig.entry - sig.sl) / sig.entry) * 100
  const durationH = +((new Date(ct).getTime() - new Date(sig.createdAt).getTime()) / 36e5).toFixed(1)
  return {
    ...sig,
    status,
    exitPrice: round(exit),
    closedAt: new Date(ct).toISOString(),
    durationH,
    pnlPct: +pnlPct.toFixed(2),
    r: +(pnlPct / riskPct).toFixed(2),
  }
}

function computeStats(open, closedArr) {
  const wins = closedArr.filter((s) => s.status === 'tp')
  const losses = closedArr.filter((s) => s.status === 'sl')
  const expired = closedArr.filter((s) => s.status === 'expired')
  const decided = wins.length + losses.length
  const rs = closedArr.filter((s) => s.status !== 'expired').map((s) => s.r)
  const winDur = wins.filter((s) => s.durationH != null).map((s) => s.durationH)
  return {
    open: open.length,
    closedTotal: closedArr.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winRate: decided ? +((wins.length / decided) * 100).toFixed(1) : 0,
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : 0,
    totalPnlPct: +closedArr.reduce((a, s) => a + (s.pnlPct || 0), 0).toFixed(1),
    avgWinDurationH: winDur.length ? +(winDur.reduce((a, b) => a + b, 0) / winDur.length).toFixed(1) : 0,
    avgEtaOpenH: open.length ? Math.round(open.reduce((a, s) => a + (s.etaHours || 0), 0) / open.length) : 0,
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
    console.error('Watchdog: анализ превысил 280с — выход')
    process.exit(1)
  }, 280_000)

  const now = Date.now()
  const prev = await loadPrev()
  console.log(`Загружено: ${prev.open.length} открытых, ${prev.closed.length} закрытых`)

  const [universe, btc, newsHitFn] = await Promise.all([buildUniverse(), btcRegime(now), loadNewsIndex(now)])
  console.log(`Универсум: ${universe.length}; BTC: ${btc.dir} (${btc.change7d}% за 7д)`)

  // тянем 1h/4h/1d по всем монетам
  const data = await mapLimit(universe, 8, async (u) => {
    const [h1, h4, d1] = await Promise.all([
      klines(u.symbol, '1h', KLINE_LIMITS['1h']),
      klines(u.symbol, '4h', KLINE_LIMITS['4h']),
      klines(u.symbol, '1d', KLINE_LIMITS['1d']),
    ])
    return { ...u, tf: { '1h': h1, '4h': h4, '1d': d1 } }
  })
  const fetched = data.filter(Boolean)
  const tfMap = { '1h': new Map(), '4h': new Map(), '1d': new Map() }
  for (const x of fetched) for (const k of Object.keys(tfMap)) tfMap[k].set(x.symbol, x.tf[k])
  console.log(`Свечи получены: ${fetched.length}`)

  // 1) оценка открытых
  const stillOpen = []
  const newlyClosed = []
  for (const sig of prev.open) {
    if (STABLES.has(sig.base)) continue // вычищаем стейблы, проскочившие в прежней схеме
    let candles = tfMap[sig.timeframe || '4h']?.get(sig.symbol)
    if (!candles) {
      try { candles = await klines(sig.symbol, sig.timeframe || '4h', KLINE_LIMITS[sig.timeframe] || 330) } catch { candles = null }
    }
    if (!candles) { stillOpen.push(sig); continue }
    const res = evaluateSignal(sig, candles, now)
    if (res) {
      newlyClosed.push(res)
    } else {
      // бэкафилл для сигналов, созданных на прежней схеме
      if (!sig.horizon) sig.horizon = 'mid'
      if (!sig.timeframe) sig.timeframe = '4h'
      if (!sig.spark || !sig.etaHours) {
        const cl = closed(candles, now)
        if (!sig.spark) sig.spark = cl.slice(-SPARK_N).map((k) => round(k.c))
        if (!sig.etaHours) sig.etaHours = estimateEtaHours(sig.indicators?.adx ?? 22, 4)
      }
      stillOpen.push(sig)
    }
  }

  // 2) генерация по горизонтам
  const openKey = new Set(stillOpen.map((s) => s.symbol + s.side + (s.horizon || 'mid')))
  let added = 0
  for (const x of fetched) {
    const newsHit = newsHitFn(x.base)
    for (const H of HORIZONS) {
      const sig = analyzeHorizon(x, H, x.tf[H.sigTf], x.tf[H.trendTf], btc, newsHit, now)
      if (!sig) continue
      const key = sig.symbol + sig.side + sig.horizon
      if (openKey.has(key)) continue
      sig.id = `${sig.base}-${sig.side}-${sig.horizon}-${now}-${added}`
      sig.createdAt = new Date(now).toISOString()
      sig.status = 'open'
      stillOpen.push(sig)
      openKey.add(key)
      added++
    }
  }

  // 3) сборка
  const closedAll = [...newlyClosed, ...prev.closed]
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, KEEP_CLOSED)
  const openSorted = stillOpen.sort((a, b) => b.strength - a.strength)
  const stats = computeStats(openSorted, closedAll)

  const out = {
    generatedAt: new Date(now).toISOString(),
    universeSize: fetched.length,
    btc,
    params: { horizons: HORIZONS.map((h) => `${h.label}(${h.sigTf})`), atrMult: ATR_MULT, rr: RR, scoreMin: SCORE_MIN },
    stats,
    open: openSorted,
    closed: closedAll,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(out), 'utf8')
  console.log(`Готово: +${added} новых, ${newlyClosed.length} закрыто, открыто ${openSorted.length}. Винрейт ${stats.winRate}%.`)

  clearTimeout(watchdog)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
