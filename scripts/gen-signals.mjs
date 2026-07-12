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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ema, rsi, macd, atr, dmi, sma, volPercentile, aggregate } from './indicators.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_PATH = resolve(ROOT, 'public', 'data', 'signals.json')
const NEWS_PATH = resolve(ROOT, 'public', 'data', 'news.json')

// Гео-нейтральное публичное зеркало Binance (api.binance.com отдаёт 451 на
// US-IP, где крутятся GitHub-раннеры). Тот же формат, без авторизации.
const BINANCE = 'https://data-api.binance.vision'

const TOP_N = 100
// Phase 1 (P1-2/P1-6): скор сжат до трёх семейств (fTrend 33 + fReg 14 + fRs 12 ≈ 59 макс
// вместо ~104 раньше; у scalp нет fRs совсем → потолок ~44) — SCORE_MIN пересчитан харнессом
// на новой шкале, свип {35,40,42,45,48,50} на data/history (см. data/backtest/report.json):
//   35→avgNetR−0.08(n7816) · 40→−0.07(n5787) · 42→−0.05(n3931) · 45→−0.01(n908, НО scalp=0!)
//   48→−0.03(n700, scalp=0) · 50→−0.01(n524, scalp=0)
// ВАЖНО: 45/48/50 математически убивают scalp (её потолок скора ~44 < 45 — нет fRs-семейства,
// это тот же P1-6 «critical coupling» баг, только на уровне одного горизонта, а не всего
// движка). scalp — 198/371 (53%) исторического потока сигналов; такое SCORE_MIN нарушало бы
// guardrail 5 (floor-check). Выбрано 42 — лучший avgNetR среди значений, не морящих ни один
// горизонт/regime-срез (все страты scalp/mid остаются «enough», n≥STRATUM_MIN).
// SCORE_MIN_OVERRIDE позволяет свипать харнессом без правки файла (backtest.mjs).
export const SCORE_MIN = Number(process.env.SCORE_MIN_OVERRIDE) || 42 // минимальная сила сигнала (фильтр качества)
export const RR_MIN = 2 // минимальное соотношение прибыль/риск — ниже 2:1 не сохраняем
export const ATR_MULT = 1.8
export const RR = 2.5
export const RR_CAP = 2.5 // Phase 1 (P1-1): жёсткий потолок RR — было score≥80/85/90 → 3/4/6
export const MAX_AGE_DAYS = { scalp: 4, mid: 12, long: 45, veryLong: 400 } // срок жизни по горизонту

// Маркер движка. Каждый сигнал, произведённый ЭТИМ движком (Phase 0 офлайн-харнесс + Phase 1
// перестройка скора), несёт поле `engine` — чтобы «новые» сигналы отличались от старых по
// ЯВНОМУ штампу, а не по косвенной эвристике «есть поле rr» (как в old/new-абляции roadmap).
// Валидация: офлайн-бэктест-харнесс на ~3 годах истории, lookahead-аудит PASS
// (data/backtest/audit.json). Абляция pooled avgNetR, ПОДТВЕРЖДЕНА реплеем под openKey-дедупом:
// −0.09 (старый) → −0.05 (Phase 1) → +0.037 (Phase 2 ADX35) → +0.046 (Phase 2 scalp≥38).
// Плюс в обоих backtestable-режимах (up/down по +0.054), WR 32%; 90% CI [−0.05,+0.15] — точечная
// оценка плюсовая, ноль не исключён (survivorship-bias односторонне оптимистичен). Это ЧЕСТНОЕ
// ПЛАТО: pooled avgNetR держит скальп (76% потока, край +0.012); край +0.5 недостижим — требовал
// бы WR ~43% при rr2.5 против факт. ~32%, такого края в индикаторах нет. См. docs/SIGNAL_REDESIGN_PLAN.md.
export const ENGINE = 'v2-harness'
export const ENGINE_ONLINE_AT = '2026-07-12' // дата вывода харнесс-валидированного движка в онлайн

export const ADX_GATE = Number(process.env.ADX_GATE_OVERRIDE) || 35 // Phase 2 (P2-2): entry ADX floor (mid/long/veryLong); harness plateau 34–38, было 18
// Скальп (1ч) шумнее — планка ADX выше. Харнесс-свип-2: scalp≥38 поднял pooled avgNetR
// +0.037→+0.062 при плюсе во всех режимах BTC; scalp≥40 ломает flat (−0.10). Пер-горизонтный
// гейт вместо глобального — принципиально: чем короче ТФ, тем сильнее нужен тренд для входа.
export const ADX_GATE_SCALP = Number(process.env.ADX_GATE_SCALP_OVERRIDE) || 38
export const SUPPRESS_FLAT_SHORT = process.env.SUPPRESS_FLAT_SHORT !== '0' // Phase 2 (P2-4): нет шортов при BTC=flat (flat-shorts avgNetR −0.484)

const KEEP_CLOSED = 1500 // держим больше закрытых — нужно для будущей калибровки/валидации
const SPARK_N = 44
const TIMEOUT = 12000

// Стоимость сделки (round-trip, % от номинала) — для честных net-метрик.
// Фьючерс-фандинг НЕ учитываем: fapi гео-блокнут (451) с US-раннеров CI, зеркала нет.
export const FEE_RT = { futures: 0.1, spot: 0.2 } // тейкерская комиссия туда-обратно
export const SLIP_RT = 0.06 // консервативное проскальзывание round-trip
const SLIP_STOP_EXTRA = 0.05 // добавка на проскальзывание по стопу/истечению (гэп)
const RISK_BUDGET_PCT = 1 // риск на сделку для совета по размеру (% депозита)
export const QV_MIN = 1.5e6 // минимальный 24ч объём ($) — отсев неликвидного хвоста (стоп нельзя ставить в шум)
export const MIN_TARGET_PCT = 0.5 // нижний порог цели (%): меньше — нетто-стоимость съедает прибыль (см. net-учёт)

// Горизонты. rr/minScore/atrMult/trendOpts/rsDays/trendAggregate переопределяют дефолты.
// Соотношение сигнального и трендового ТФ держим 4–7× (не 1×), чтобы фильтр был
// действительно старше сигнала и не дублировал тот же ряд:
//   • long   — вход 1d, тренд недельный
//   • veryLong — вход 1w, тренд «месячный» (агрегируем 4 недели в свечу)
export const HORIZONS = [
  { key: 'scalp', label: 'Скальп', sigTf: '1h', trendTf: '4h', tfHours: 1 },
  { key: 'mid', label: 'Средне', sigTf: '4h', trendTf: '1d', tfHours: 4, rsDays: 7 },
  { key: 'long', label: 'Долго', sigTf: '1d', trendTf: '1w', tfHours: 24, rsDays: 21, trendOpts: { fast: 20, slow: 50, min: 55 } },
  {
    // Phase 1 (P1-1): rr3 — доказанно проигрышный тир (rr3→WR5.7%), приведено к RR_CAP.
    // minScore-оверрайд (75) снят: он был откалиброван под старый максимум скора (~104);
    // на сжатой шкале (~59, см. SCORE_MIN выше) 75 недостижимо в принципе — это тот же
    // P1-6 «critical coupling» баг, только для veryLong, а не для глобального SCORE_MIN.
    // Оставлять его означало бы тихо занулить горизонт навсегда. Горизонт использует общий
    // SCORE_MIN (harness-selected) наравне с mid/long.
    key: 'veryLong', label: 'Сверхдолго', sigTf: '1w', trendTf: '1w', tfHours: 168,
    rr: 2.5, atrMult: 2.2, rsDays: 60,
    trendAggregate: 4, trendOpts: { fast: 6, slow: 12, min: 18 },
  },
]
export const KLINE_LIMITS = { '1h': 330, '4h': 330, '1d': 320, '1w': 260 }

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
// Чистая функция: считает режим по уже закрытым дневным свечам BTC. Вынесена из
// btcRegime(now), чтобы backtest.mjs мог прогнать её AS-OF любого T без сети (P0-1/P0-4).
export function btcRegimeFrom(closedDailyBtc) {
  const c = closedDailyBtc.map((k) => k.c)
  const e50 = ema(c, 50)
  const e200 = ema(c, 200)
  const last = c[c.length - 1]
  const dir = last > e200 && e50 > e200 ? 'up' : last < e200 && e50 < e200 ? 'down' : 'flat'
  const wk = c.length > 7 ? ((last - c[c.length - 8]) / c[c.length - 8]) * 100 : 0
  return { dir, change7d: +wk.toFixed(1) }
}

// Тонкая обёртка с сетью/IO — единственное место, где btcRegime трогает fetch.
async function btcRegime(now) {
  try {
    const d = closed(await klines('BTCUSDT', '1d', 320), now)
    return btcRegimeFrom(d)
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

// Phase 1 (P1-1): убит score→rr ладдер (был фатальным дефектом — rr3→WR5.7%, rr4→WR0%,
// z=−4.83 по разделению победа/проигрыш). RR больше не зависит от conviction/score —
// фиксированный потолок RR_CAP для всех горизонтов и всех score.
function dynamicRR(baseRR = RR) {
  return Math.min(baseRR, RR_CAP)
}

// ── Smart Money Concepts (структурное подтверждение, на ЗАКРЫТЫХ свечах) ──
// Order Block: последняя противоположная свеча перед импульсом, в зону которой цена вернулась.
function findOrderBlock(candles, side, lookback = 50) {
  const f = candles.slice(-lookback)
  if (f.length < 15) return null
  const last = f[f.length - 1]
  for (let i = f.length - 4; i >= 5; i--) {
    const c = f[i]
    const n1 = f[i + 1], n2 = f[i + 2], n3 = f[i + 3]
    if (!n1 || !n2 || !n3) continue
    if (side === 'long' && c.c < c.o) {
      if ((n1.c + n2.c + n3.c) / 3 > c.h * 1.005 && last.c >= c.l && last.c <= c.h * 1.02)
        return { high: c.h, low: c.l }
    } else if (side === 'short' && c.c > c.o) {
      if ((n1.c + n2.c + n3.c) / 3 < c.l * 0.995 && last.c >= c.l * 0.98 && last.c <= c.h)
        return { high: c.h, low: c.l }
    }
  }
  return null
}

// Fair Value Gap: 3-свечной имбаланс, который цена сейчас закрывает.
function findFVG(candles, side) {
  const f = candles.slice(-30)
  if (f.length < 5) return null
  const last = f[f.length - 1]
  for (let i = f.length - 2; i >= 2; i--) {
    if (side === 'long') {
      if (f[i].l - f[i - 2].h > 0 && last.c >= f[i - 2].h && last.c <= f[i].l)
        return { mid: (f[i - 2].h + f[i].l) / 2 }
    } else {
      if (f[i - 2].l - f[i].h > 0 && last.c <= f[i - 2].l && last.c >= f[i].h)
        return { mid: (f[i - 2].l + f[i].h) / 2 }
    }
  }
  return null
}

// Liquidity Sweep: недавний прокол свинг-уровня с возвратом за него (сбор ликвидности).
function liquiditySweep(candles, side, lookback = 20) {
  const f = candles.slice(-(lookback + 3))
  if (f.length < 8) return false
  const ref = f.slice(0, -3)
  const recent = f.slice(-3)
  if (side === 'long') {
    const lo = Math.min(...ref.map((c) => c.l))
    return recent.some((c) => c.l < lo * 0.998 && c.c > lo)
  }
  const hi = Math.max(...ref.map((c) => c.h))
  return recent.some((c) => c.h > hi * 1.002 && c.c < hi)
}

// Калибровка по закрытым сделкам: что отличало выигрыши от проигрышей в каждой
// страте (горизонт×сторона). Используется для адаптивного подъёма minScore там, где
// исторический WR низкий и выборка достаточна. Только повышаем планку — консервативно.
export function calibrateFromClosed(closedArr) {
  const byStratum = {}
  for (const s of closedArr) {
    if (s.status === 'expired') continue
    const k = `${s.horizon || 'mid'}:${s.side}`
    ;(byStratum[k] ||= { wins: [], losses: [] })[s.status === 'tp' ? 'wins' : 'losses'].push(s)
  }
  const out = {}
  for (const [key, { wins, losses }] of Object.entries(byStratum)) {
    const decided = wins.length + losses.length
    if (decided < 30) continue
    out[key] = {
      decided,
      wr: +((wins.length / decided) * 100).toFixed(1),
    }
  }
  return out
}

export function analyzeHorizon(u, H, sigCandles, trendCandles, btc, newsHit, now, rsRank, calib) {
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
  // Phase 2 (P2-1): long:short убит. На ~3 годах харнесса он отрицателен во ВСЕХ режимах BTC
  // (down −0.26 / flat −1.02 / up −0.41 avgNetR) — критерий 8 плана требует занулить шорт-путь,
  // не дающий OOS avgNetR ≥ 0 хотя бы в одном non-down режиме. Долгосрочный шорт на спот-
  // горизонте — «падающий нож». См. data/backtest/report.json (strata long|short|*).
  if (H.key === 'long' && side === 'short') return null
  // Phase 2 (P2-4): нет шортов при BTC=flat/chop — на харнессе flat-шорты дали avgNetR −0.484
  // (чистый яд), уборка их — самый большой единичный вклад в положительный pooled avgNetR.
  if (SUPPRESS_FLAT_SHORT && side === 'short' && btc.dir === 'flat') return null
  const baseRR = H.rr ?? RR
  const atrMult = H.atrMult ?? ATR_MULT
  let minScore = H.minScore ?? SCORE_MIN
  if (baseRR < RR_MIN) return null // фильтр: соотношение прибыль/риск ниже 2:1 не сохраняем

  // адаптивный порог: страты с плохим историческим WR (выборка ≥ STRATUM_MIN) поднимают планку.
  // Phase 1: бонус (+5/+8) откалиброван под старую шкалу скора (макс ~104); на сжатой шкале
  // (макс ~59) та же прибавка — намного агрессивнее пропорционально. Отключено/инертно до
  // P4-3 (avgNetR-aware re-baseline на новой шкале) — не хотим искажать SCORE_MIN-свип Phase 1.
  const ADAPTIVE_BUMP_ENABLED = false
  const cal = calib && calib[`${H.key}:${side}`]
  if (ADAPTIVE_BUMP_ENABLED && cal && cal.decided >= STRATUM_MIN && cal.wr < 70) minScore += cal.wr < 50 ? 8 : 5

  // ── обязательные условия входа (гейты) ──
  // RSI сужен до momentum-зоны (было 45–68/32–55): режем слабый импульс и перекупленность/перепроданность
  // пер-горизонтный ADX-гейт: скальп (шумный 1ч) требует более сильного тренда, чем mid/long
  const adxGate = H.key === 'scalp' ? ADX_GATE_SCALP : ADX_GATE
  if (side === 'long') {
    if (!(close > ema50) || !(m.hist > 0) || !(r >= 50 && r <= 65) || adxv < adxGate) return null
  } else {
    if (!(close < ema50) || !(m.hist < 0) || !(r >= 35 && r <= 50) || adxv < adxGate) return null
  }
  // наклон EMA50 должен совпадать с направлением (тренд ускоряется, не разворачивается)
  const ema50prev = ema(fC.slice(0, -3), 50)
  if (ema50prev != null) {
    const slope = ema50 - ema50prev
    if ((side === 'long' && slope < 0) || (side === 'short' && slope > 0)) return null
  }
  // анти-чейз: цена дальше 3×ATR от EMA50 — движение уже состоялось, вход с плохим R
  if (Math.abs(close - ema50) > 3 * a) return null
  // объёмный пол для коротких ТФ: нет участия — нет интереса рынка к продолжению
  if ((H.key === 'scalp' || H.key === 'mid') && volAvg != null && fV[last] < volAvg * 0.7) return null

  // ── СКОР (Phase 1, P1-2): momentum/volume/SMC/news сняты с суммы — на данных они не
  // дискриминировали победителей (RSI z≈−0.01, MACD z≈+0.03, volume z=−1.15, news z=+0.10;
  // SMC-«вред» — mixed-engine confound). MACD-sign/RSI-band/EMA50 остаются гейтами входа выше
  // (unchanged), 0.7×-объём и QV_MIN — гейтами ликвидности (unchanged). score = fTrend+fReg+fRs.
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

  // 2) СИЛА/РЕЖИМ: ADX (подтверждение, НЕ дубль гейта) + согласие DI − штраф мёртвой волы — потолок 14
  let fReg = adxv >= 28 ? 8 : adxv >= 22 ? 5 : 2
  reasons.push(`ADX ${adxv.toFixed(0)} — ${adxv >= 28 ? 'сильный тренд' : adxv >= 22 ? 'тренд уверенный' : 'тренд подтверждён'}`)
  const diAgree = side === 'long' ? d.plusDI > d.minusDI : d.minusDI > d.plusDI
  if (diAgree) fReg += 3
  if (volPct != null) {
    if (volPct < 0.15) { fReg -= 6; reasons.push('⚠ Очень низкая волатильность — цель далеко, риск застоя') }
    else if (volPct < 0.3) fReg -= 3
  }
  fReg = cap(fReg, 14)

  // 3) ОТНОСИТЕЛЬНАЯ СИЛА (кросс-секционно по вселенной) — мягкий тилт, потолок 12, без скальпа
  let fRs = 0
  if (rsRank != null && H.key !== 'scalp') {
    const rel = side === 'long' ? rsRank : 1 - rsRank // лонгу — сильные монеты, шорту — слабые
    if (rel >= 0.5) {
      fRs = Math.round(12 * ((rel - 0.5) / 0.5))
      if (fRs > 0) reasons.push(`Относительная сила: топ ${Math.max(1, Math.round((1 - rel) * 100))}% вселенной`)
    }
  }

  let score = fTrend + fReg + fRs

  // ── ДИСПЛЕЙ-ОНЛИ (Phase 1, P1-2): Smart Money / BTC-режим — больше не дают очков, только
  // информационные reasons. SMC снят из скора для parsimony (мнимый «вред» 14.7% vs 26.0% WR —
  // mixed-engine confound, не гейт). BTC-оверлей был mis-signed в выборке (z=−2.29, +4 short-
  // tailwind поднимал проигрышные шорты) — полноценная side-symmetric suppression замена —
  // Phase 2 (P2-4, НЕ в этой фазе), здесь просто не начисляем очки.
  if (findOrderBlock(f, side)) reasons.push('Smart Money: цена в Order Block (зона институционального интереса)')
  if (findFVG(f, side)) reasons.push('Smart Money: закрытие Fair Value Gap (имбаланс цены)')
  if (liquiditySweep(f, side)) reasons.push('Smart Money: снятие ликвидности перед входом')

  if (side === 'long') {
    if (btc.dir === 'down') reasons.push('⚠ BTC в нисходящем тренде — риск для лонгов альтов')
    else if (btc.dir === 'up') reasons.push('BTC в восходящем тренде — попутный ветер')
  } else {
    if (btc.dir === 'up') reasons.push('⚠ BTC растёт — риск для шорта альта')
    else if (btc.dir === 'down') reasons.push('BTC слабый — поддержка шорта')
  }

  // новости (Phase 1, P1-2): единственный оставшийся эффект — жёсткое вето «против сделки»
  // (было −14 к скору). «За» сделку — только инфо-строка, очков не даёт (было +6; news z=+0.10 —
  // шум, к тому же unreplayable в харнессе — нет point-in-time архива).
  let news = null
  if (newsHit) {
    news = newsHit
    if (H.key === 'veryLong') {
      reasons.push(`В новостях ${news.count} упоминаний — фон для справки`)
    } else {
      const against = (side === 'long' && news.sentiment === 'neg') || (side === 'short' && news.sentiment === 'pos')
      if (against) return null // жёсткое вето: новостной фон против сделки
      const forIt = (side === 'long' && news.sentiment === 'pos') || (side === 'short' && news.sentiment === 'neg')
      if (forIt) reasons.push(`Новостной фон поддерживает (${news.count} упоминаний)`)
      else reasons.push(`В новостях ${news.count} упоминаний — проверь фон`)
    }
  }

  score = Math.min(100, Math.max(0, Math.round(score)))
  if (score < minScore) return null

  // Phase 1 (P1-1): RR больше не зависит от score/conviction — фиксированный потолок RR_CAP.
  const rr = dynamicRR(baseRR)

  const scoreBreakdown = {
    trend: fTrend, regime: fReg, rs: fRs,
    base: fTrend + fReg + fRs, total: score,
  }

  const slDist = atrMult * a
  const entry = close
  const sl = side === 'long' ? entry - slDist : entry + slDist
  const tp = side === 'long' ? entry + rr * slDist : entry - rr * slDist
  if (!(slDist > 0) || sl <= 0 || tp <= 0) return null
  const riskPct = +((slDist / entry) * 100).toFixed(2)
  const targetPct = +(((rr * slDist) / entry) * 100).toFixed(2)
  if (targetPct < MIN_TARGET_PCT) return null // цель меньше нетто-порога — отбраковываем
  // доп. цели для частичной фиксации (информативно; статистика по основному tp)
  const tp2 = round(side === 'long' ? entry + (rr + 1.5) * slDist : entry - (rr + 1.5) * slDist)
  const tp3 = null // Phase 1 (P1-1): score≥85 tp3-расширение снято вместе со score→rr ладдером
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
    tp2,
    tp3,
    atr: round(a),
    riskPct,
    targetPct,
    rr: +rr.toFixed(2),
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
    engine: ENGINE,
  }
}

// ── оценка исхода ──
export function evaluateSignal(sig, candles, now) {
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
export function tradeCostPct(sig, status) {
  const venue = (sig.markets || ['futures']).includes('futures') ? 'futures' : 'spot'
  let cost = (FEE_RT[venue] ?? FEE_RT.spot) + SLIP_RT
  if (status === 'sl' || status === 'expired') cost += SLIP_STOP_EXTRA
  return cost
}

export function closeSig(sig, status, exit, ct, best, worst) {
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

export const STRATUM_MIN = 50 // порог выборки (decided), ниже которого вердикт не выносим

export function aggStats(arr) {
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

export function computeStats(open, closedArr) {
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
export function buildRsRanks(fetched, now) {
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

  // калибровка порогов по истории закрытых (адаптивный minScore по слабым стратам)
  const calib = calibrateFromClosed(prev.closed)
  const calibKeys = Object.keys(calib)
  if (calibKeys.length) {
    console.log(`Калибровка: ${calibKeys.length} страт с выборкой ≥30 — ` +
      calibKeys.map((k) => `${k} WR${calib[k].wr}%`).join(', '))
  }

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
      const sig = analyzeHorizon(x, H, x.tf[H.sigTf], x.tf[H.trendTf], btc, newsHit, now, rs ?? null, calib)
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
    engine: {
      version: ENGINE,
      online: true,
      onlineAt: ENGINE_ONLINE_AT,
      basis: 'harness',
      gates: { adxGate: ADX_GATE, adxGateScalp: ADX_GATE_SCALP, suppressFlatShort: SUPPRESS_FLAT_SHORT, rrCap: RR_CAP },
      note: 'Новый движок в онлайне, валидирован офлайн-бэктест-харнессом (~3г истории, lookahead-аудит PASS). Phase 1: убит score→rr ладдер, скор сжат до trend+regime+rs. Phase 2: ADX-гейт 18→35 (скальп→38, шумный 1ч), нет шортов при BTC=flat, long:short убит. Подтверждённая реплеем абляция pooled avgNetR: −0.09 (старый) → −0.05 (Phase 1) → +0.046 (v2, close/next-open совпали), WR 32%, оба значимых режима BTC +0.054. Край mid +0.14 / long +0.30, скальп +0.01 (76% потока — держит pooled). Честная оговорка: 90% CI [−0.05,+0.15] — точечная оценка плюсовая, ноль статистически не исключён (survivorship-bias односторонне оптимистичен); это потолок робастной avgNetR на данных, край +0.5 недостижим.',
    },
    params: {
      horizons: HORIZONS.map((h) => `${h.label}(${h.sigTf})`),
      atrMult: ATR_MULT,
      rr: RR,
      rrDynamic: `Phase 1: фиксированный RR_CAP=${RR_CAP} для всех горизонтов, без score-ладдера`,
      scoreMin: SCORE_MIN,
      adxGate: ADX_GATE,
      adxGateScalp: ADX_GATE_SCALP,
      suppressFlatShort: SUPPRESS_FLAT_SHORT,
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

// Запускаем main() только когда файл — точка входа процесса (node scripts/gen-signals.mjs),
// а не когда его импортируют ради экспортов (напр. scripts/backtest.mjs). Это единственное
// условие для инварианта P0-1 «main() — единственное место с fetch/file-IO/process.exit»:
// сам факт import не должен тянуть за собой сеть/запись файла.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
