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
import { ema, rsi, macd, atr, dmi, sma, volPercentile, aggregate } from './indicators.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_PATH = resolve(ROOT, 'public', 'data', 'signals.json')
const NEWS_PATH = resolve(ROOT, 'public', 'data', 'news.json')

// Гео-нейтральное публичное зеркало Binance (api.binance.com отдаёт 451 на
// US-IP, где крутятся GitHub-раннеры). Тот же формат, без авторизации.
const BINANCE = 'https://data-api.binance.vision'

const TOP_N = 100
const SCORE_MIN = 70 // минимальная сила сигнала (фильтр качества)
const RR_MIN = 2 // минимальное соотношение прибыль/риск — ниже 2:1 не сохраняем
const ATR_MULT = 1.8
const RR = 2.5
const MAX_AGE_DAYS = { scalp: 4, mid: 12, long: 45, veryLong: 400 } // срок жизни по горизонту
const KEEP_CLOSED = 1500 // держим больше закрытых — нужно для будущей калибровки/валидации
const SPARK_N = 44
const TIMEOUT = 12000

// Стоимость сделки (round-trip, % от номинала) — для честных net-метрик.
// Фьючерс-фандинг НЕ учитываем: fapi гео-блокнут (451) с US-раннеров CI, зеркала нет.
const FEE_RT = { futures: 0.1, spot: 0.2 } // тейкерская комиссия туда-обратно
const SLIP_RT = 0.06 // консервативное проскальзывание round-trip
const SLIP_STOP_EXTRA = 0.05 // добавка на проскальзывание по стопу/истечению (гэп)
const RISK_BUDGET_PCT = 1 // риск на сделку для совета по размеру (% депозита)
const QV_MIN = 1.5e6 // минимальный 24ч объём ($) — отсев неликвидного хвоста (стоп нельзя ставить в шум)

// Горизонты. rr/minScore/atrMult/trendOpts/rsDays/trendAggregate переопределяют дефолты.
// Соотношение сигнального и трендового ТФ держим 4–7× (не 1×), чтобы фильтр был
// действительно старше сигнала и не дублировал тот же ряд:
//   • long   — вход 1d, тренд недельный
//   • veryLong — вход 1w, тренд «месячный» (агрегируем 4 недели в свечу)
const HORIZONS = [
  { key: 'scalp', label: 'Скальп', sigTf: '1h', trendTf: '4h', tfHours: 1 },
  { key: 'mid', label: 'Средне', sigTf: '4h', trendTf: '1d', tfHours: 4, rsDays: 7 },
  { key: 'long', label: 'Долго', sigTf: '1d', trendTf: '1w', tfHours: 24, rsDays: 21, trendOpts: { fast: 20, slow: 50, min: 55 } },
  {
    key: 'veryLong', label: 'Сверхдолго', sigTf: '1w', trendTf: '1w', tfHours: 168,
    rr: 3, minScore: 75, atrMult: 2.2, rsDays: 60,
    trendAggregate: 4, trendOpts: { fast: 6, slow: 12, min: 18 },
  },
]
const KLINE_LIMITS = { '1h': 330, '4h': 330, '1d': 320, '1w': 260 }

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

function isoWeek(ts) {
  const d = new Date(ts)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const y = d.getUTCFullYear()
  const w = Math.ceil(((d - new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7)
  return `${y}-W${String(w).padStart(2, '0')}`
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
        r.base && r.base !== 'BTC' && !STABLES.has(r.base) && !LEVERAGED.test(r.base) &&
        Number.isFinite(r.qv) && r.qv >= QV_MIN, // отсев неликвидных: стоп нельзя ставить в шум тонкой монеты
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
function trendDir(trendClosed, opts = {}) {
  const { fast = 50, slow = 200, min = slow } = opts
  if (trendClosed.length < min) return null
  const c = trendClosed.map((k) => k.c)
  const eF = ema(c, fast)
  const eS = ema(c, slow)
  if (eF == null || eS == null) return null
  const last = c[c.length - 1]
  if (last > eS && eF > eS) return 'up'
  if (last < eS && eF < eS) return 'down'
  return null
}

function round(n) {
  if (n >= 1000) return +n.toFixed(2)
  if (n >= 1) return +n.toFixed(4)
  if (n >= 0.01) return +n.toFixed(6)
  return +n.toPrecision(4)
}

function estimateEtaHours(adxv, tfHours, rr = RR, atrMult = ATR_MULT) {
  const eff = Math.min(0.6, Math.max(0.25, 0.25 + (adxv - 18) / 120))
  return Math.round(((rr * atrMult) / eff) * tfHours)
}

function analyzeHorizon(u, H, sigCandles, trendCandles, btc, newsHit, now, rsRank) {
  // тренд старшего ТФ (для veryLong агрегируем недели в «месяцы» — реальное 4× разделение)
  let tc = closed(trendCandles, now)
  if (H.trendAggregate) tc = aggregate(tc, H.trendAggregate)
  const trend = trendDir(tc, H.trendOpts)
  if (!trend) return null
  const f = closed(sigCandles, now)
  if (f.length < 60) return null

  const fC = f.map((k) => k.c)
  const fH = f.map((k) => k.h)
  const fL = f.map((k) => k.l)
  const fV = f.map((k) => k.v)
  const last = fC.length - 1
  const close = fC[last]
  const ema50 = ema(fC, 50)
  const ema200 = fC.length >= 200 ? ema(fC, 200) : null
  const r = rsi(fC, 14)
  const m = macd(fC)
  const a = atr(fH, fL, fC, 14)
  const d = dmi(fH, fL, fC, 14) // { adx, plusDI, minusDI }
  const volAvg = sma(fV, 20)
  const volPct = volPercentile(fC, 14, 100) // перцентиль волатильности 0..1 (или null)
  if (ema50 == null || r == null || !m || a == null || !d) return null
  const adxv = d.adx

  const side = trend === 'up' ? 'long' : 'short'
  if (H.key === 'veryLong' && side === 'short') return null // сверхдолгосрок — только покупка на споте
  const rr = H.rr ?? RR
  const atrMult = H.atrMult ?? ATR_MULT
  const minScore = H.minScore ?? SCORE_MIN
  if (rr < RR_MIN) return null // фильтр: соотношение прибыль/риск ниже 2:1 не сохраняем

  // ── обязательные условия входа (гейты) ──
  const crossUp = m.prevHist != null && m.prevHist <= 0 && m.hist > 0
  const crossDown = m.prevHist != null && m.prevHist >= 0 && m.hist < 0
  if (side === 'long') {
    if (!(close > ema50) || !(m.hist > 0) || !(r >= 45 && r <= 68) || adxv < 18) return null
  } else {
    if (!(close < ema50) || !(m.hist < 0) || !(r >= 32 && r <= 55) || adxv < 18) return null
  }
  const volHigh = volAvg != null && fV[last] > volAvg * 1.2

  // ── СКОР ПО НЕЗАВИСИМЫМ СЕМЕЙСТВАМ (каждое с потолком) ──
  // Главная идея: EMA50 + MACD + RSI скоррелированы ~0.9 → это ОДИН фактор импульса.
  // Раньше каждый прибавлял в общий балл (тройной счёт). Теперь — одно семейство с потолком.
  const reasons = []
  const cap = (v, hi) => Math.max(-hi, Math.min(hi, v))
  const ef = H.trendOpts?.fast ?? 50
  const es = H.trendOpts?.slow ?? 200

  // 1) ТРЕНД старшего ТФ + положение к EMA200 сигнального ТФ — потолок 33
  let fTrend = 25
  reasons.push(`Тренд ${H.trendTf}${H.trendAggregate ? `×${H.trendAggregate}` : ''} ${side === 'long' ? 'вверх' : 'вниз'} (EMA${ef}/${es})`)
  const ema200ok = ema200 != null && (side === 'long' ? close > ema200 : close < ema200)
  if (ema200ok) { fTrend += 8; reasons.push(`${H.sigTf}: цена ${side === 'long' ? 'выше' : 'ниже'} EMA200`) }
  fTrend = cap(fTrend, 33)

  // 2) МОМЕНТУМ (EMA50 + MACD + RSI в ОДНО семейство) — потолок 27
  let fMom = 9
  reasons.push(`${H.sigTf}: импульс по EMA50`)
  const macdStrong = side === 'long' ? crossUp : crossDown
  fMom += macdStrong ? 12 : 7
  reasons.push(macdStrong ? `MACD пересёк сигнальную ${side === 'long' ? 'вверх' : 'вниз'}` : 'MACD-гистограмма по тренду')
  const rsiSweet = side === 'long' ? r >= 50 && r <= 62 : r >= 38 && r <= 50
  fMom += rsiSweet ? 6 : 3
  reasons.push(`RSI ${r.toFixed(0)} — ${rsiSweet ? 'здоровый импульс' : 'рабочая зона'}`)
  fMom = cap(fMom, 27)

  // 3) СИЛА/РЕЖИМ: ADX (подтверждение, НЕ дубль гейта) + согласие DI − штраф мёртвой волы — потолок 14
  let fReg = adxv >= 28 ? 8 : adxv >= 22 ? 5 : 2
  reasons.push(`ADX ${adxv.toFixed(0)} — ${adxv >= 28 ? 'сильный тренд' : adxv >= 22 ? 'тренд уверенный' : 'тренд подтверждён'}`)
  const diAgree = side === 'long' ? d.plusDI > d.minusDI : d.minusDI > d.plusDI
  if (diAgree) fReg += 3
  if (volPct != null) {
    if (volPct < 0.15) { fReg -= 6; reasons.push('⚠ Очень низкая волатильность — цель далеко, риск застоя') }
    else if (volPct < 0.3) fReg -= 3
  }
  fReg = cap(fReg, 14)

  // 4) ОБЪЁМ — потолок 8
  let fVol = 0
  if (volHigh) { fVol = 8; reasons.push('Объём выше среднего за 20 свечей') }
  else if (volAvg != null && fV[last] > volAvg) fVol = 4

  // 5) ОТНОСИТЕЛЬНАЯ СИЛА (кросс-секционно по вселенной) — мягкий тилт, потолок 12, без скальпа
  let fRs = 0
  if (rsRank != null && H.key !== 'scalp') {
    const rel = side === 'long' ? rsRank : 1 - rsRank // лонгу — сильные монеты, шорту — слабые
    if (rel >= 0.5) {
      fRs = Math.round(12 * ((rel - 0.5) / 0.5))
      if (fRs > 0) reasons.push(`Относительная сила: топ ${Math.max(1, Math.round((1 - rel) * 100))}% вселенной`)
    }
  }

  let score = fTrend + fMom + fReg + fVol + fRs

  // ── ОВЕРЛЕИ поверх базы: системный риск BTC + новости ──
  const w = H.key === 'scalp' ? 0.5 : 1
  let btcDelta = 0
  if (side === 'long') {
    if (btc.dir === 'down') { btcDelta = -12 * w; score += btcDelta; reasons.push('⚠ BTC в нисходящем тренде — риск для лонгов альтов') }
    else if (btc.dir === 'up') { btcDelta = 4 * w; score += btcDelta; reasons.push('BTC в восходящем тренде — попутный ветер') }
  } else {
    if (btc.dir === 'up') { btcDelta = -10 * w; score += btcDelta; reasons.push('⚠ BTC растёт — риск для шорта альта') }
    else if (btc.dir === 'down') { btcDelta = 4 * w; score += btcDelta; reasons.push('BTC слабый — поддержка шорта') }
  }
  let newsDelta = 0

  let news = null
  if (newsHit) {
    news = newsHit
    if (H.key === 'veryLong') {
      reasons.push(`В новостях ${news.count} упоминаний — фон для справки`)
    } else {
      const against = (side === 'long' && news.sentiment === 'neg') || (side === 'short' && news.sentiment === 'pos')
      const forIt = (side === 'long' && news.sentiment === 'pos') || (side === 'short' && news.sentiment === 'neg')
      if (against) { newsDelta = -14; score += newsDelta; reasons.push(`⚠ Новостной фон против сделки (${news.count} упоминаний)`) }
      else if (forIt) { newsDelta = 6; score += newsDelta; reasons.push(`Новостной фон поддерживает (${news.count} упоминаний)`) }
      else reasons.push(`В новостях ${news.count} упоминаний — проверь фон`)
    }
  }

  score = Math.min(100, Math.max(0, Math.round(score)))
  if (score < minScore) return null

  const scoreBreakdown = {
    trend: fTrend, momentum: fMom, regime: fReg, volume: fVol, rs: fRs,
    btc: Math.round(btcDelta), news: newsDelta,
    base: fTrend + fMom + fReg + fVol + fRs, total: score,
  }

  const slDist = atrMult * a
  const entry = close
  const sl = side === 'long' ? entry - slDist : entry + slDist
  const tp = side === 'long' ? entry + rr * slDist : entry - rr * slDist
  if (!(slDist > 0) || sl <= 0 || tp <= 0) return null
  const riskPct = +((slDist / entry) * 100).toFixed(2)
  // совет по размеру (inverse-vol): чтобы рисковать RISK_BUDGET_PCT% депозита,
  // позиция = бюджет_риска / риск_сделки. Меньше риск → больше позиция.
  const posSizePct = +Math.min(100, Math.max(1, (RISK_BUDGET_PCT / riskPct) * 100)).toFixed(1)

  const markets =
    H.key === 'veryLong' ? ['spot'] : H.key === 'scalp' ? ['futures'] : side === 'long' ? ['spot', 'futures'] : ['futures']

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
    riskPct,
    targetPct: +(((rr * slDist) / entry) * 100).toFixed(2),
    strength: score,
    posSizePct,
    riskBudgetPct: RISK_BUDGET_PCT,
    rsRank: rsRank != null ? +rsRank.toFixed(2) : null,
    etaHours: estimateEtaHours(adxv, H.tfHours, rr, atrMult),
    reasons,
    indicators: {
      rsi: +r.toFixed(1),
      adx: +adxv.toFixed(1),
      macdHist: +m.hist.toPrecision(3),
      plusDI: +d.plusDI.toFixed(1),
      minusDI: +d.minusDI.toFixed(1),
      volPct: volPct != null ? +volPct.toFixed(2) : null,
    },
    news: news ? news.items : null,
    newsSentiment: news ? news.sentiment : null,
    newsCount: news ? news.count : 0,
    spark: fC.slice(-SPARK_N).map((x) => round(x)),
    scoreBreakdown,
    cohortWeek: isoWeek(now),
  }
}

// ── оценка исхода ──
function evaluateSignal(sig, candles, now) {
  const created = new Date(sig.createdAt).getTime()
  const after = closed(candles, now).filter((k) => k.t > created)
  let best = sig.side === 'long' ? -Infinity : Infinity // максимум хода в сторону прибыли (MFE)
  let worst = sig.side === 'long' ? Infinity : -Infinity // максимум хода против сделки (MAE)
  for (const k of after) {
    if (sig.side === 'long') {
      best = Math.max(best, k.h)
      worst = Math.min(worst, k.l)
      if (k.l <= sig.sl) return closeSig(sig, 'sl', sig.sl, k.ct, best, worst)
      if (k.h >= sig.tp) return closeSig(sig, 'tp', sig.tp, k.ct, best, worst)
    } else {
      best = Math.min(best, k.l)
      worst = Math.max(worst, k.h)
      if (k.h >= sig.sl) return closeSig(sig, 'sl', sig.sl, k.ct, best, worst)
      if (k.l <= sig.tp) return closeSig(sig, 'tp', sig.tp, k.ct, best, worst)
    }
  }
  const maxAge = (MAX_AGE_DAYS[sig.horizon] || 12) * 864e5
  if (now - created > maxAge) {
    const lastK = after.length ? after[after.length - 1] : null
    return closeSig(sig, 'expired', lastK ? lastK.c : sig.entry, lastK ? lastK.ct : now, best, worst)
  }
  return null
}

// стоимость сделки (round-trip, % от цены) для net-метрик; фандинг не учитываем (см. FEE_RT)
function tradeCostPct(sig, status) {
  const venue = (sig.markets || ['futures']).includes('futures') ? 'futures' : 'spot'
  let cost = (FEE_RT[venue] ?? FEE_RT.spot) + SLIP_RT
  if (status === 'sl' || status === 'expired') cost += SLIP_STOP_EXTRA
  return cost
}

function closeSig(sig, status, exit, ct, best, worst) {
  const dir = sig.side === 'long' ? 1 : -1
  const pnlPct = ((exit - sig.entry) / sig.entry) * 100 * dir
  const riskPct = sig.riskPct || (Math.abs(sig.entry - sig.sl) / sig.entry) * 100
  const durationH = +((new Date(ct).getTime() - new Date(sig.createdAt).getTime()) / 36e5).toFixed(1)
  // доля пути до тейка в лучшей точке (MFE), 0–100%
  let toTpPct = null
  if (best != null && Number.isFinite(best)) {
    const denom = sig.side === 'long' ? sig.tp - sig.entry : sig.entry - sig.tp
    const num = sig.side === 'long' ? best - sig.entry : sig.entry - best
    if (denom > 0) toTpPct = Math.max(0, Math.min(100, Math.round((num / denom) * 100)))
  }
  // максимальная просадка против сделки в единицах риска R (MAE)
  let maeR = null
  if (worst != null && Number.isFinite(worst)) {
    const adverse = sig.side === 'long' ? sig.entry - worst : worst - sig.entry
    if (riskPct > 0) maeR = +Math.max(0, (adverse / sig.entry) * 100 / riskPct).toFixed(2)
  }
  // net: вычитаем комиссию + проскальзывание (round-trip) из движения цены
  const costPct = tradeCostPct(sig, status)
  const netPnlPct = +(pnlPct - costPct).toFixed(2)
  return {
    ...sig,
    status,
    exitPrice: round(exit),
    closedAt: new Date(ct).toISOString(),
    durationH,
    pnlPct: +pnlPct.toFixed(2),
    r: +(pnlPct / riskPct).toFixed(2),
    netPnlPct,
    netR: +(netPnlPct / riskPct).toFixed(2),
    costPct: +costPct.toFixed(2),
    toTpPct,
    maeR,
  }
}

const STRATUM_MIN = 50 // порог выборки (decided), ниже которого вердикт не выносим

function aggStats(arr) {
  const wins = arr.filter((s) => s.status === 'tp')
  const losses = arr.filter((s) => s.status === 'sl')
  const decided = wins.length + losses.length
  const rs = arr.filter((s) => s.status !== 'expired').map((s) => s.r)
  const netRs = arr.filter((s) => s.status !== 'expired' && s.netR != null).map((s) => s.netR)
  const netWins = arr.filter((s) => s.status !== 'expired' && (s.netPnlPct ?? 0) > 0).length
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    closedTotal: arr.length,
    wins: wins.length,
    losses: losses.length,
    decided,
    winRate: decided ? +((wins.length / decided) * 100).toFixed(1) : 0,
    netWinRate: decided ? +((netWins / decided) * 100).toFixed(1) : 0,
    avgR: +mean(rs).toFixed(2),
    avgNetR: +mean(netRs).toFixed(2),
    totalPnlPct: +arr.reduce((a, s) => a + (s.pnlPct || 0), 0).toFixed(1),
    totalNetPnlPct: +arr.reduce((a, s) => a + (s.netPnlPct || 0), 0).toFixed(1),
  }
}

function computeStats(open, closedArr) {
  const base = aggStats(closedArr)
  const expired = closedArr.filter((s) => s.status === 'expired').length
  const winDur = closedArr.filter((s) => s.status === 'tp' && s.durationH != null).map((s) => s.durationH)
  // разбивка по стратам (горизонт × сторона) с гейтом по объёму выборки
  const strata = {}
  for (const s of closedArr) {
    const key = `${s.horizon || 'mid'}:${s.side}`
    ;(strata[key] ||= []).push(s)
  }
  const byStratum = Object.entries(strata)
    .map(([key, arr]) => {
      const [horizon, side] = key.split(':')
      const a = aggStats(arr)
      return { horizon, side, ...a, enough: a.decided >= STRATUM_MIN }
    })
    .sort((x, y) => y.closedTotal - x.closedTotal)
  return {
    open: open.length,
    closedTotal: base.closedTotal,
    wins: base.wins,
    losses: base.losses,
    expired,
    winRate: base.winRate,
    netWinRate: base.netWinRate,
    avgR: base.avgR,
    avgNetR: base.avgNetR,
    totalPnlPct: base.totalPnlPct,
    totalNetPnlPct: base.totalNetPnlPct,
    avgWinDurationH: winDur.length ? +(winDur.reduce((a, b) => a + b, 0) / winDur.length).toFixed(1) : 0,
    avgEtaOpenH: open.length ? Math.round(open.reduce((a, s) => a + (s.etaHours || 0), 0) / open.length) : 0,
    sampleGate: STRATUM_MIN,
    byStratum,
  }
}

// Кросс-секционная относительная сила: ранжируем монеты по доходности за rsDays
// (на закрытых свечах) внутри вселенной. Возвращаем percentile 0..1 по горизонту.
function buildRsRanks(fetched, now) {
  const ranks = {}
  for (const H of HORIZONS) {
    if (!H.rsDays) continue
    const weekly = H.sigTf === '1w'
    const tf = weekly ? '1w' : '1d'
    const bars = weekly ? Math.max(2, Math.round(H.rsDays / 7)) : H.rsDays
    const rows = []
    for (const x of fetched) {
      const cs = closed(x.tf[tf] || [], now).map((k) => k.c)
      if (cs.length < bars + 1) continue
      const a = cs[cs.length - 1 - bars]
      const b = cs[cs.length - 1]
      if (a > 0) rows.push({ symbol: x.symbol, ret: b / a - 1 })
    }
    rows.sort((p, q) => p.ret - q.ret)
    const m = new Map()
    rows.forEach((r, i) => m.set(r.symbol, rows.length > 1 ? i / (rows.length - 1) : 0.5))
    ranks[H.key] = m
  }
  return ranks
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
    const [h1, h4, d1, w1] = await Promise.all([
      klines(u.symbol, '1h', KLINE_LIMITS['1h']),
      klines(u.symbol, '4h', KLINE_LIMITS['4h']),
      klines(u.symbol, '1d', KLINE_LIMITS['1d']),
      klines(u.symbol, '1w', KLINE_LIMITS['1w']),
    ])
    return { ...u, tf: { '1h': h1, '4h': h4, '1d': d1, '1w': w1 } }
  })
  const fetched = data.filter(Boolean)
  const tfMap = { '1h': new Map(), '4h': new Map(), '1d': new Map(), '1w': new Map() }
  for (const x of fetched) for (const k of Object.keys(tfMap)) tfMap[k].set(x.symbol, x.tf[k])
  const rsRanks = buildRsRanks(fetched, now) // относительная сила по горизонтам
  console.log(`Свечи получены: ${fetched.length}`)

  // 1) оценка открытых
  const stillOpen = []
  const newlyClosed = []
  for (const sig of prev.open) {
    if (STABLES.has(sig.base)) continue // вычищаем стейблы, проскочившие в прежней схеме
    if ((sig.strength || 0) < SCORE_MIN) continue // ниже нового порога качества — больше не держим
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
      const cl = closed(candles, now)
      sig.spark = cl.slice(-SPARK_N).map((k) => round(k.c)) // всегда обновляем — нужно для прогресса к цели
      if (!sig.etaHours) sig.etaHours = estimateEtaHours(sig.indicators?.adx ?? 22, 4)
      stillOpen.push(sig)
    }
  }

  // 2) генерация по горизонтам
  const openKey = new Set(stillOpen.map((s) => s.symbol + s.side + (s.horizon || 'mid')))
  let added = 0
  for (const x of fetched) {
    const newsHit = newsHitFn(x.base)
    for (const H of HORIZONS) {
      const rs = rsRanks[H.key] ? rsRanks[H.key].get(x.symbol) : null
      const sig = analyzeHorizon(x, H, x.tf[H.sigTf], x.tf[H.trendTf], btc, newsHit, now, rs ?? null)
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
    params: {
      horizons: HORIZONS.map((h) => `${h.label}(${h.sigTf})`),
      atrMult: ATR_MULT,
      rr: RR,
      scoreMin: SCORE_MIN,
      costPct: { futures: FEE_RT.futures + SLIP_RT, spot: FEE_RT.spot + SLIP_RT },
      riskBudgetPct: RISK_BUDGET_PCT,
    },
    stats,
    open: openSorted,
    closed: closedAll,
  }
  console.log(`Net винрейт ${stats.netWinRate}% · avgNetR ${stats.avgNetR}`)

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
