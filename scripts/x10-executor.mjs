// Meridian X10 Executor — автотрейдинг политики X10 v1 на Bybit DEMO (api-demo.bybit.com).
// Политика: docs/X10_POLICY.md (CONFIRMED). Ядро mid:long/mid:short (движок v2-harness),
// вселенная топ-30 по объёму, лестница 15%/2% против лог-прямой 1x→10x за 365 дней,
// adxTilt (≥45→×1.5, ≥38→×1.0, <38→×0.5), кэп 30%/сделку и 45% суммарного открытого
// риска, levCap 10, salvage: эквити <0.15×старта → риск 2% навсегда.
//
// Банкролл ВИРТУАЛЬНЫЙ: старт $1000, ведётся в data/x10/state.json по реализованному
// PnL позиций (closed-pnl Bybit, комиссии включены). Демо-счёт — только площадка
// исполнения; его баланс ($165k) в сайзинге не участвует.
//
// Запуск: node scripts/x10-executor.mjs [--dry]   (планировщик дергает каждые 10 мин)
// Ключи: .env в корне репо (BYBIT_DEMO_API_KEY / BYBIT_DEMO_API_SECRET).
//
// shortcut: cross-маржа вместо изолированной (UTA-демо; ликвидация нам не грозит —
//   виртуальный банкролл на 2 порядка меньше демо-эквити, банкрот учитывается логикой).
// shortcut: реконсиляция закрытий по symbol+side последнего closed-pnl; при ручной
//   торговле на том же демо-счёте учёт разъедется — счёт только для бота.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const STATE_PATH = resolve(ROOT, 'data', 'x10', 'state.json')
const LOG_PATH = resolve(ROOT, 'data', 'x10', 'log.txt')

const SIGNALS_URL = 'https://raw.githubusercontent.com/pyrchen/meridian/main/public/data/signals.json'
const BINANCE = 'https://data-api.binance.vision'
const BYBIT = 'https://api-demo.bybit.com'
const RECV = '5000'
const DRY = process.argv.includes('--dry')

// ── политика X10 v1 (не менять без нового MC-прогона, см. docs/X10_POLICY.md) ──
const START_EQUITY = 1000
const TARGET_X = 10
const YEAR_DAYS = 365
const RISK_BEHIND = 0.15 // ниже лог-прямой к 10x
const RISK_AHEAD = 0.02 // на/выше лог-прямой
const ADX_TILT = (adx) => (adx >= 45 ? 1.5 : adx >= 38 ? 1.0 : 0.5)
const RISK_CAP_TRADE = 0.30
const RISK_CAP_TOTAL = 0.45
const LEV_CAP = 10
const SALVAGE_X = 0.15 // эквити <0.15×старта → риск RISK_AHEAD навсегда
const TOP_N = 30
const HORIZON = 'mid'
const ENGINE = 'v2-harness'
const MAX_AGE_DAYS = 12 // срок жизни mid-позиции (MAX_AGE_DAYS движка)
const FRESH_MS = 2 * 3.6e6 // сигнал старше 2ч не берём — вход далеко от next-open
const QV_MIN = 1.5e6

const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USDD', 'EUR', 'EURI', 'USDE', 'PYUSD', 'GUSD', 'USTC', 'AEUR', 'EURT', 'XUSD', 'USD1', 'RLUSD', 'USDG', 'USD0', 'USDY', 'USDX', 'EURC', 'FRAX', 'GHO', 'CRVUSD', 'SUSD', 'USDS', 'BOLD', 'USDF', 'FDUSDT'])
const LEVERAGED = /(\d+[LS]|UP|DOWN|BULL|BEAR)$/

// ── env / подпись ──
const env = {}
for (const line of (await readFile(resolve(ROOT, '.env'), 'utf8')).split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const KEY = env.BYBIT_DEMO_API_KEY
const SECRET = env.BYBIT_DEMO_API_SECRET
if (!KEY || !SECRET) throw new Error('BYBIT_DEMO_API_KEY/SECRET not in .env')

let clockDrift = 0
async function syncClock() {
  const j = await (await fetch(`${BYBIT}/v5/market/time`)).json()
  clockDrift = Number(j.time) - Date.now()
}
function headers(payload) {
  const ts = String(Date.now() + clockDrift)
  const sign = createHmac('sha256', SECRET).update(ts + KEY + RECV + payload).digest('hex')
  return {
    'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV,
    'X-BAPI-SIGN': sign, 'Content-Type': 'application/json',
  }
}
async function bbGet(path, query) {
  const r = await fetch(`${BYBIT}${path}?${query}`, { headers: headers(query) })
  const j = await r.json()
  if (j.retCode !== 0) throw new Error(`${path}: ${j.retCode} ${j.retMsg}`)
  return j.result
}
async function bbPost(path, body) {
  const raw = JSON.stringify(body)
  if (DRY) { log(`DRY POST ${path} ${raw}`); return {} }
  const r = await fetch(`${BYBIT}${path}`, { method: 'POST', body: raw, headers: headers(raw) })
  const j = await r.json()
  if (j.retCode !== 0) throw new Error(`${path}: ${j.retCode} ${j.retMsg} body=${raw}`)
  return j.result
}

// ── журнал ──
const lines = []
function log(msg) {
  const s = `${new Date().toISOString()} ${msg}`
  console.log(s)
  lines.push(s)
}

// ── состояние ──
async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'))
  } catch {
    return {
      startedAt: new Date().toISOString(),
      startEquity: START_EQUITY,
      equity: START_EQUITY,
      salvageLocked: false,
      open: [], // { signalId, symbol, bybitSymbol, scale, side, qty, entry, sl, tp, riskUsd, riskFrac, adx, openedAt }
      closed: [],
      processed: [],
    }
  }
}
async function saveState(st) {
  await mkdir(dirname(STATE_PATH), { recursive: true })
  await writeFile(STATE_PATH, JSON.stringify(st, null, 1), 'utf8')
  const prev = await readFile(LOG_PATH, 'utf8').catch(() => '')
  await writeFile(LOG_PATH, (prev + lines.join('\n') + '\n').slice(-500_000), 'utf8')
}

// ── вселенная топ-30 (как buildUniverse движка, но срез 30) ──
async function top30() {
  const all = await (await fetch(`${BINANCE}/api/v3/ticker/24hr`)).json()
  return new Set(
    all
      .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
      .map((t) => ({ base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
      .filter((r) => r.base && r.base !== 'BTC' && !STABLES.has(r.base) && !LEVERAGED.test(r.base) && r.qv >= QV_MIN)
      .sort((a, b) => b.qv - a.qv)
      .slice(0, TOP_N)
      .map((r) => r.base),
  )
}

// ── инструмент Bybit: маппинг (PEPE → 1000PEPEUSDT и т.п.), шаги цены/кол-ва ──
async function instrument(base) {
  for (const [sym, scale] of [[`${base}USDT`, 1], [`1000${base}USDT`, 1000]]) {
    try {
      const r = await bbGet('/v5/market/instruments-info', `category=linear&symbol=${sym}`)
      const it = r.list?.[0]
      if (it && it.status === 'Trading') {
        return {
          symbol: sym, scale,
          qtyStep: +it.lotSizeFilter.qtyStep, minQty: +it.lotSizeFilter.minOrderQty,
          tickSize: +it.priceFilter.tickSize, maxLev: +it.leverageFilter.maxLeverage,
        }
      }
    } catch {}
  }
  return null
}
const fmtStep = (v, step) => {
  const d = Math.max(0, (String(step).split('.')[1] || '').length)
  return (Math.floor(v / step) * step).toFixed(d)
}

// ── шаг 1: реконсиляция открытых позиций ──
async function reconcile(st) {
  if (!st.open.length) return
  const pos = await bbGet('/v5/position/list', 'category=linear&settleCoin=USDT')
  const live = new Map(pos.list.filter((p) => +p.size > 0).map((p) => [p.symbol + p.side, p]))
  const still = []
  for (const t of st.open) {
    const bbSide = t.side === 'long' ? 'Buy' : 'Sell'
    if (live.has(t.bybitSymbol + bbSide)) {
      // истечение: mid живёт MAX_AGE_DAYS — закрываем рынком (reduce-only)
      if (Date.now() - new Date(t.openedAt).getTime() > MAX_AGE_DAYS * 864e5) {
        log(`EXPIRE ${t.symbol} ${t.side} qty=${t.qty}`)
        await bbPost('/v5/order/create', {
          category: 'linear', symbol: t.bybitSymbol, side: t.side === 'long' ? 'Sell' : 'Buy',
          orderType: 'Market', qty: String(t.qty), reduceOnly: true, timeInForce: 'IOC',
        })
        still.push(t) // PnL заберём на следующем проходе из closed-pnl
      } else still.push(t)
      continue
    }
    // позиции нет — закрылась по SL/TP: забираем реализованный PnL (комиссии внутри).
    // closed-pnl проставляется с задержкой в секунды: пустой ответ ≠ нулевой PnL,
    // ждём следующий проход (до 6 попыток, потом бронируем null и ругаемся в лог).
    try {
      const cp = await bbGet('/v5/position/closed-pnl', `category=linear&symbol=${t.bybitSymbol}&limit=20`)
      const since = new Date(t.openedAt).getTime()
      const rows = (cp.list || []).filter((r) => +r.updatedTime >= since)
      if (!rows.length) throw new Error('closed-pnl ещё не проставлен')
      const pnl = rows.reduce((a, r) => a + +r.closedPnl, 0)
      st.equity = +(st.equity + pnl).toFixed(2)
      st.closed.push({ ...t, closedAt: new Date().toISOString(), pnl: +pnl.toFixed(2) })
      log(`CLOSED ${t.symbol} ${t.side} pnl=$${pnl.toFixed(2)} equity=$${st.equity}`)
    } catch (e) {
      t.reconcileTries = (t.reconcileTries || 0) + 1
      if (t.reconcileTries <= 6) {
        log(`WAIT ${t.bybitSymbol}: ${e.message} (попытка ${t.reconcileTries}/6)`)
        still.push(t)
      } else {
        log(`WARN ${t.bybitSymbol}: PnL так и не получен — бронирую null, эквити НЕ обновлено, сверь руками`)
        st.closed.push({ ...t, closedAt: new Date().toISOString(), pnl: null })
      }
    }
  }
  st.open = still
  if (!st.salvageLocked && st.equity < SALVAGE_X * st.startEquity) {
    st.salvageLocked = true
    log(`SALVAGE: эквити $${st.equity} < ${SALVAGE_X}× старта — риск ${RISK_AHEAD * 100}% навсегда`)
  }
}

// ── шаг 2: сайзинг по политике ──
function riskFraction(st, adx) {
  if (st.salvageLocked) return Math.min(RISK_AHEAD * ADX_TILT(adx), RISK_CAP_TRADE)
  const days = (Date.now() - new Date(st.startedAt).getTime()) / 864e5
  const required = st.startEquity * Math.pow(TARGET_X, Math.min(1, days / YEAR_DAYS))
  const base = st.equity < required ? RISK_BEHIND : RISK_AHEAD
  return Math.min(base * ADX_TILT(adx), RISK_CAP_TRADE)
}

// ── шаг 3: новые входы ──
async function enter(st, signals) {
  const fresh = signals.filter(
    (s) =>
      s.engine === ENGINE && s.horizon === HORIZON && s.status === 'open' &&
      Date.now() - new Date(s.createdAt).getTime() < FRESH_MS &&
      !st.processed.includes(s.id),
  )
  if (!fresh.length) return log('новых сигналов ядра нет')
  const uni = await top30()
  for (const s of fresh) {
    st.processed.push(s.id)
    if (!uni.has(s.base)) { log(`SKIP ${s.base}: вне топ-30`); continue }
    if (st.open.some((t) => t.symbol === s.symbol)) { log(`SKIP ${s.base}: символ уже в позиции (one-way)`); continue }
    const openRisk = st.open.reduce((a, t) => a + t.riskFrac, 0)
    const frac = riskFraction(st, s.indicators?.adx ?? 0)
    if (openRisk + frac > RISK_CAP_TOTAL) { log(`SKIP ${s.base}: кэп открытого риска ${(openRisk * 100).toFixed(0)}%+${(frac * 100).toFixed(0)}%>45%`); continue }
    const inst = await instrument(s.base)
    if (!inst) { log(`SKIP ${s.base}: нет перпа на Bybit`); continue }

    const entry = s.entry * inst.scale
    const sl = s.sl * inst.scale
    const tp = s.tp * inst.scale
    const riskUsd = st.equity * frac
    const stopDist = Math.abs(entry - sl)
    let qty = riskUsd / stopDist
    // levCap: номинал ≤ 10× виртуального эквити
    const maxNotional = LEV_CAP * st.equity
    if (qty * entry > maxNotional) qty = maxNotional / entry
    const qtyStr = fmtStep(qty, inst.qtyStep)
    if (+qtyStr < inst.minQty) { log(`SKIP ${s.base}: qty ${qtyStr} < min ${inst.minQty}`); continue }

    const lev = String(Math.min(LEV_CAP, inst.maxLev))
    try {
      await bbPost('/v5/position/set-leverage', { category: 'linear', symbol: inst.symbol, buyLeverage: lev, sellLeverage: lev })
    } catch (e) {
      if (!/110043/.test(e.message)) log(`WARN set-leverage ${inst.symbol}: ${e.message}`) // 110043 = leverage not modified
    }
    await bbPost('/v5/order/create', {
      category: 'linear', symbol: inst.symbol, side: s.side === 'long' ? 'Buy' : 'Sell',
      orderType: 'Market', qty: qtyStr, timeInForce: 'IOC', positionIdx: 0,
      takeProfit: fmtStep(tp, inst.tickSize), stopLoss: fmtStep(sl, inst.tickSize),
      tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice', tpslMode: 'Full',
    })
    st.open.push({
      signalId: s.id, symbol: s.symbol, bybitSymbol: inst.symbol, scale: inst.scale,
      side: s.side, qty: +qtyStr, entry: s.entry, sl: s.sl, tp: s.tp,
      riskUsd: +riskUsd.toFixed(2), riskFrac: +frac.toFixed(4), adx: s.indicators?.adx ?? null,
      openedAt: new Date().toISOString(),
    })
    log(`ENTER ${s.base} ${s.side} qty=${qtyStr} risk=$${riskUsd.toFixed(2)} (${(frac * 100).toFixed(1)}%, ADX ${s.indicators?.adx}) SL ${s.sl} TP ${s.tp}`)
  }
  if (st.processed.length > 2000) st.processed = st.processed.slice(-1000)
}

// ── прогон ──
async function main() {
  await syncClock()
  const st = await loadState()
  const sig = await (await fetch(`${SIGNALS_URL}?v=${Date.now()}`, { cache: 'no-store' })).json()
  log(`equity=$${st.equity} open=${st.open.length} signalsAt=${sig.generatedAt}${DRY ? ' [DRY]' : ''}${st.salvageLocked ? ' [SALVAGE]' : ''}`)
  await reconcile(st)
  await enter(st, sig.open || [])
  await saveState(st)
}

main().catch(async (e) => {
  log(`FATAL ${e.message}`)
  const prev = await readFile(LOG_PATH, 'utf8').catch(() => '')
  await mkdir(dirname(LOG_PATH), { recursive: true })
  await writeFile(LOG_PATH, (prev + lines.join('\n') + '\n').slice(-500_000), 'utf8')
  process.exit(1)
})
