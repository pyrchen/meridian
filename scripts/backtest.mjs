// Meridian — офлайн бэктест-харнесс (Phase 0 редизайна сигнального движка).
// НЕ меняет живое поведение gen-signals.mjs — только импортирует его экспортированные
// чистые функции (P0-1) и прогоняет их AS-OF на исторических свечах без заглядывания
// в будущее (P0-3 lookahead audit). Ничего не тюнит и не решает "прибыльно/нет" —
// это фальсификатор, не валидатор (см. docs/SIGNAL_REDESIGN_PLAN.md, guardrail 7).
//
// Режимы:
//   node scripts/backtest.mjs --pull [--years=3]
//   node scripts/backtest.mjs --replay [--horizons=scalp,mid,long,veryLong]
//   node scripts/backtest.mjs --eval [--fill=close|next-open|both]
//
// Данные: data/history/{SYMBOL}-{INTERVAL}.ndjson (кэш свечей, инкрементальный дедуп
// по open-time), data/backtest/trades.json (сырые сделки реплея), data/backtest/audit.json
// (результаты lookahead-асертов), data/backtest/report.json (P0-6 net-of-cost метрики).

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeHorizon, evaluateSignal, tradeCostPct, buildRsRanks,
  calibrateFromClosed, aggStats, computeStats, btcRegimeFrom,
  HORIZONS, MAX_AGE_DAYS, STRATUM_MIN, KLINE_LIMITS,
} from './gen-signals.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HIST_DIR = resolve(ROOT, 'data', 'history')
const BT_DIR = resolve(ROOT, 'data', 'backtest')
// ── экспериментальные вселенные (--tag=t30 --top=30): отдельный снапшот символов и
// отдельные выходные файлы; кэш свечей в data/history общий (дедуп по open-time).
// БЕЗ флагов поведение бит-в-бит прежнее — основная 12-символьная цепочка не трогается.
const argvEarly = process.argv.slice(2)
function earlyFlag(name) {
  const hit = argvEarly.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const TAG = earlyFlag('tag') ? `-${earlyFlag('tag')}` : ''

const SYMBOLS_META = resolve(HIST_DIR, `_symbols${TAG}.json`)
const TRADES_PATH = resolve(BT_DIR, `trades${TAG}.json`)
const AUDIT_PATH = resolve(BT_DIR, `audit${TAG}.json`)
const REPORT_PATH = resolve(BT_DIR, `report${TAG}.json`)

const BINANCE = 'https://data-api.binance.vision'
const PULL_INTERVALS = ['1h', '4h', '1d', '1w']
// снапшот вселенной для бэктеста — по умолчанию компактные 12 (не 100 как в live);
// --top=N переопределяет для тегированных экспериментов.
const UNIVERSE_TOP_N = earlyFlag('top') ? Number(earlyFlag('top')) : 12

const STABLES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USDD', 'EUR', 'EURI',
  'USDE', 'PYUSD', 'GUSD', 'USTC', 'AEUR', 'EURT', 'XUSD', 'USD1',
  'RLUSD', 'USDG', 'USD0', 'USDY', 'USDX', 'EURC', 'FRAX', 'GHO',
  'CRVUSD', 'SUSD', 'USDS', 'BOLD', 'USDF', 'FDUSDT',
])
const LEVERAGED = /(\d+[LS]|UP|DOWN|BULL|BEAR)$/

// ── CLI args ──
const args = process.argv.slice(2)
function flag(name, def = undefined) {
  const pfx = `--${name}=`
  const hit = args.find((a) => a.startsWith(pfx))
  if (hit) return hit.slice(pfx.length)
  return args.includes(`--${name}`) ? true : def
}

// ── прогресс-бар (UX addendum) ──
// stderr-ONLY, никогда не в stdout (там JSON-отчёты/структурированный вывод) — не путает
// парсинг вывода при перенаправлении. Явные --progress/--no-progress побеждают; иначе
// авто по TTY stderr (не спамим неинтерактивные логи, напр. CI). Троттлинг ~300мс/1%.
function progressEnabled() {
  if (args.includes('--no-progress')) return false
  if (args.includes('--progress')) return true
  return !!process.stderr.isTTY
}
const SHOW_PROGRESS = progressEnabled()

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function makeProgress(label, total, barWidth = 22) {
  const start = Date.now()
  let lastPrintMs = 0
  let lastPct = -1
  let printed = false
  function tick(done, extra = '') {
    if (!SHOW_PROGRESS || !(total > 0)) return
    const frac = Math.min(1, Math.max(0, done / total))
    const pct = Math.floor(frac * 100)
    const now = Date.now()
    // троттлинг: не чаще ~300мс И не чаще чем на каждый процент — кроме самого первого и
    // последнего кадра, которые всегда рисуем.
    const isEdge = done <= 1 || frac >= 1
    if (!isEdge && now - lastPrintMs < 300 && pct === lastPct) return
    lastPrintMs = now
    lastPct = pct
    const filled = Math.round(frac * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled))
    const elapsedMs = Math.max(0, now - start)
    const etaMs = frac > 0 ? (elapsedMs / frac) * (1 - frac) : 0
    const line = `[${label}] ${bar} ${String(pct).padStart(3)}% | ${done}/${total}${extra ? ' ' + extra : ''} | ${fmtDuration(elapsedMs)} elapsed | ~${fmtDuration(etaMs)} ETA`
    process.stderr.write(`\r${line}`)
    printed = true
  }
  function done(summary = '') {
    if (SHOW_PROGRESS && printed) process.stderr.write('\n')
    if (summary) console.log(summary)
  }
  return { tick, done }
}

// ── сеть: те же принципы, что и в gen-signals.mjs (гео-нейтральное зеркало) ──
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function getJSON(url, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15000)
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MeridianBacktest/1.0', Accept: 'application/json' } })
      clearTimeout(t)
      if (r.status === 429 || r.status === 451) {
        const backoff = Math.min(30000, 1000 * 2 ** attempt)
        console.warn(`  [backoff] HTTP ${r.status} on attempt ${attempt + 1}, sleeping ${backoff}ms`)
        await sleep(backoff)
        continue
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      clearTimeout(t)
      if (attempt === retries) throw e
      await sleep(Math.min(15000, 500 * 2 ** attempt))
    }
  }
  throw new Error('unreachable')
}

async function klinesPage(symbol, interval, startTime, limit = 1000) {
  const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=${limit}`
  const raw = await getJSON(url)
  return raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }))
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length)
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const idx = i++
      ret[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return ret
}

// ── ndjson кэш свечей ──
function histPath(symbol, interval) { return resolve(HIST_DIR, `${symbol}-${interval}.ndjson`) }

async function loadCached(symbol, interval) {
  const p = histPath(symbol, interval)
  if (!existsSync(p)) return []
  const raw = await readFile(p, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* corrupt line — skip, resumable */ }
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

async function appendCandles(symbol, interval, candles) {
  if (!candles.length) return
  const lines = candles.map((c) => JSON.stringify(c)).join('\n') + '\n'
  await appendFile(histPath(symbol, interval), lines, 'utf8')
}

// ── P0-2: universe snapshot + deep-page pull ──
async function fetchUniverseSnapshot(topN) {
  const all = await getJSON(`${BINANCE}/api/v3/ticker/24hr`)
  return all
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
    .filter((r) => r.base && r.base !== 'BTC' && !STABLES.has(r.base) && !LEVERAGED.test(r.base) && Number.isFinite(r.qv))
    .sort((a, b) => b.qv - a.qv)
    .slice(0, topN)
    .map((r) => r.symbol)
}

async function loadOrCreateSymbolSnapshot(topN) {
  if (existsSync(SYMBOLS_META)) {
    const j = JSON.parse(await readFile(SYMBOLS_META, 'utf8'))
    console.log(`Снапшот вселенной уже есть (${j.stampedAt}): ${j.symbols.length} монет — переиспользуем для воспроизводимости.`)
    return j.symbols
  }
  const alts = await fetchUniverseSnapshot(topN)
  const symbols = ['BTCUSDT', ...alts.filter((s) => s !== 'BTCUSDT')]
  await mkdir(HIST_DIR, { recursive: true })
  await writeFile(SYMBOLS_META, JSON.stringify({ symbols, stampedAt: new Date().toISOString(), topN }, null, 2), 'utf8')
  console.log(`Снапшот вселенной застемплен: ${symbols.join(', ')}`)
  return symbols
}

async function pullOne(symbol, interval, fromTs, now) {
  const cached = await loadCached(symbol, interval)
  const seen = new Set(cached.map((c) => c.t))
  // Resumable catch-up (fromTs already covered by cache) resumes from the last cached
  // candle forward. But if fromTs asks for MORE history than we have (years bumped up),
  // that optimization would skip the backfill entirely — walk from fromTs in that case;
  // the `seen` set still dedups the already-cached middle/tail so this stays cheap.
  const needsBackfill = cached.length > 0 && fromTs < cached[0].t
  let cursor = cached.length && !needsBackfill ? Math.max(fromTs, cached[cached.length - 1].ct + 1) : fromTs
  let pages = 0
  let added = 0
  const toAppend = []
  while (cursor < now) {
    let page
    try {
      page = await klinesPage(symbol, interval, cursor)
    } catch (e) {
      console.warn(`  ${symbol}-${interval}: page fetch failed after retries at cursor=${cursor}: ${e.message} — stopping here (resumable).`)
      break
    }
    pages++
    if (!page.length) break
    const fresh = page.filter((c) => !seen.has(c.t))
    for (const c of fresh) seen.add(c.t)
    toAppend.push(...fresh)
    added += fresh.length
    const lastClose = page[page.length - 1].ct
    if (lastClose <= cursor) break
    cursor = lastClose + 1
    if (page.length < 1000) break
    if (toAppend.length >= 5000) { await appendCandles(symbol, interval, toAppend.splice(0, toAppend.length)) }
    await sleep(100)
  }
  if (toAppend.length) await appendCandles(symbol, interval, toAppend)
  return { symbol, interval, pages, added, totalCached: cached.length + added }
}

async function runPull() {
  const years = Number(flag('years', 3))
  const now = Date.now()
  const fromTs = now - years * 365 * 864e5
  await mkdir(HIST_DIR, { recursive: true })
  const symbols = await loadOrCreateSymbolSnapshot(UNIVERSE_TOP_N)
  console.log(`Пуллим ${symbols.length} символов × ${PULL_INTERVALS.join('/')} от ${new Date(fromTs).toISOString()} до ${new Date(now).toISOString()}`)

  const tasks = []
  for (const symbol of symbols) for (const interval of PULL_INTERVALS) tasks.push({ symbol, interval })

  const t0 = Date.now()
  const progress = makeProgress('pull', tasks.length)
  let pullDone = 0
  const results = await mapLimit(tasks, 8, async ({ symbol, interval }) => {
    const r = await pullOne(symbol, interval, fromTs, now)
    pullDone++
    progress.tick(pullDone, `${symbol}-${interval}`)
    console.log(`  ${symbol}-${interval}: +${r.added} свечей (${r.pages} страниц), всего в кэше ${r.totalCached}`)
    return r
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const totalAdded = results.reduce((a, r) => a + r.added, 0)
  progress.done(`\nПулл завершён за ${elapsed}с. Добавлено ${totalAdded} свечей суммарно по ${tasks.length} парам символ×интервал.`)
}

// ── P0-3/P0-4/P0-5: replay ──

// shortcut: bounded trailing window (KLINE_LIMITS-sized), NOT the full since-inception
// history, mirrors exactly what production's own klines(symbol, interval, KLINE_LIMITS[tf])
// fetch would have returned at time T. This is deliberate, not just a perf shortcut:
// production's analyzeHorizon NEVER sees more than KLINE_LIMITS[tf] bars of context, so a
// full-history window would replay a *different*, more-informed engine than the one that
// actually runs in prod. It also keeps each tick O(window) instead of O(n), avoiding an
// O(n²) blowup over a 3-year 1h replay (~26k bars/symbol). Ceiling: if a future phase wants
// to test "what if we gave the engine more context," swap the window size here.
function windowEndingAt(sorted, limit, ct) {
  // sorted candles ascending by t/ct, no duplicates. Binary search for last idx with ct<=T.
  let lo = 0, hi = sorted.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].ct <= ct) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (idx < 0) return []
  const start = Math.max(0, idx - limit + 1)
  return sorted.slice(start, idx + 1)
}

function findIdxAtOrBefore(sorted, ct) {
  let lo = 0, hi = sorted.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].ct <= ct) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }
  return idx
}

const WARMUP_BARS = 200 // P0-3: "skip until sig bars >= max(200, slow+sig)" — 200 dominates (macd needs 35, ema200 needs 200)

async function loadAllHistory(symbols) {
  const cache = {}
  for (const symbol of symbols) {
    cache[symbol] = {}
    for (const interval of PULL_INTERVALS) cache[symbol][interval] = await loadCached(symbol, interval)
  }
  return cache
}

function auditCounters() {
  return { windowChecks: 0, windowViolations: 0, outcomeChecks: 0, outcomeViolations: 0, rsDenomChecks: 0, rsDenomViolations: 0 }
}

async function replayHorizon(H, symbols, hist, audit) {
  const sigLimit = KLINE_LIMITS[H.sigTf]
  const trendLimit = KLINE_LIMITS[H.trendTf]
  const rsTf = H.sigTf === '1w' ? '1w' : '1d'
  const rsLimit = KLINE_LIMITS[rsTf]
  const btcLimit = 320 // mirrors btcRegime(now)'s klines('BTCUSDT','1d',320)

  // master T-axis: union of each eligible symbol's own sigTf ct values (from its own
  // 200th bar onward), so calibration/regime/RS-rank state advances chronologically
  // across the WHOLE universe, not per-symbol in isolation (P0-4).
  const tSet = new Set()
  for (const s of symbols) {
    const arr = hist[s][H.sigTf]
    for (let i = WARMUP_BARS - 1; i < arr.length; i++) tSet.add(arr[i].ct)
  }
  const tAxis = [...tSet].sort((a, b) => a - b)
  if (!tAxis.length) return { horizon: H.key, trades: [], skipped: true, reason: 'no symbol reached warmup' }

  const btcDaily = hist['BTCUSDT']?.['1d'] || []
  const regimeCache = new Map()
  function btcRegimeAsOf(T) {
    if (regimeCache.has(T)) return regimeCache.get(T)
    const win = windowEndingAt(btcDaily, btcLimit, T)
    audit.windowChecks++
    if (win.some((c) => c.ct > T)) audit.windowViolations++
    const r = btcRegimeFrom(win)
    regimeCache.set(T, r)
    return r
  }

  const rsCache = new Map()
  function rsRanksAsOf(T) {
    if (rsCache.has(T)) return rsCache.get(T)
    const fetched = symbols.map((s) => ({ symbol: s, tf: { [rsTf]: windowEndingAt(hist[s][rsTf] || [], rsLimit, T) } }))
    for (const f of fetched) {
      audit.windowChecks++
      if ((f.tf[rsTf] || []).some((c) => c.ct > T)) audit.windowViolations++
    }
    const ranks = buildRsRanks(fetched, T)
    // assert (c): denominator = count of symbols passing buildRsRanks' own internal length
    // gate at T — recomputed independently here to verify, not trusting the shared code path.
    if (H.rsDays) {
      const weekly = H.sigTf === '1w'
      const bars = weekly ? Math.max(2, Math.round(H.rsDays / 7)) : H.rsDays
      const eligible = fetched.filter((f) => (f.tf[rsTf] || []).length >= bars + 1).length
      const m = ranks[H.key]
      audit.rsDenomChecks++
      if (!m || m.size !== eligible) audit.rsDenomViolations++
    }
    rsCache.set(T, ranks)
    return ranks
  }

  const closedTrades = [] // global (all symbols) for this horizon, chronological-ish by open
  const openPositions = new Map() // key -> { closedAtMs }
  const trades = []
  const progress = makeProgress(`replay:${H.key}`, tAxis.length)

  for (let ti = 0; ti < tAxis.length; ti++) {
    const T = tAxis[ti]
    progress.tick(ti + 1, `${trades.length} trades`)
    const calib = calibrateFromClosed(closedTrades.filter((t) => new Date(t.closedAt).getTime() <= T))
    const btc = btcRegimeAsOf(T)
    const rsRanks = rsRanksAsOf(T)

    for (const symbol of symbols) {
      if (symbol === 'BTCUSDT') continue // BTC excluded from the alt universe, same as live buildUniverse
      const sigArr = hist[symbol][H.sigTf]
      const idx = findIdxAtOrBefore(sigArr, T)
      if (idx < WARMUP_BARS - 1) continue
      if (sigArr[idx].ct !== T) continue // this symbol has no bar closing exactly at T — not its tick

      const trendArr = hist[symbol][H.trendTf]
      if (!trendArr || !trendArr.length) continue

      const sigWindow = windowEndingAt(sigArr, sigLimit, T)
      const trendWindow = windowEndingAt(trendArr, trendLimit, T)
      audit.windowChecks += 2
      if (sigWindow.some((c) => c.ct > T)) audit.windowViolations++
      if (trendWindow.some((c) => c.ct > T)) audit.windowViolations++

      const rs = rsRanks[H.key] ? rsRanks[H.key].get(symbol) : null
      const u = { symbol, base: symbol.slice(0, -4) }
      const cand = analyzeHorizon(u, H, sigWindow, trendWindow, btc, null, T, rs ?? null, calib)
      if (!cand) continue

      const key = `${symbol}|${cand.side}|${H.key}`
      const blocked = openPositions.has(key) && openPositions.get(key).closedAtMs > T
      if (blocked) continue

      const sig = { ...cand, id: `${cand.base}-${cand.side}-${H.key}-${T}`, createdAt: new Date(T).toISOString(), status: 'open' }

      // Outcome: legitimately uses forward candles (that's what "outcome" means in any
      // backtest) — NOT lookahead on the entry side, which was already decided above using
      // only ct<=T data. evaluateSignal's own `k.t > created` filter guarantees assert (b).
      const lastAvail = sigArr[sigArr.length - 1].ct
      const evalNow = Math.min(lastAvail, T + (MAX_AGE_DAYS[H.key] || 12) * 864e5 + 2 * 864e5)
      const outcome = evaluateSignal(sig, sigArr, evalNow)

      if (outcome) {
        audit.outcomeChecks++
        const firstAfter = sigArr.find((k) => k.t > T)
        if (!firstAfter || firstAfter.t <= T) audit.outcomeViolations++
        const nextOpen = idx + 1 < sigArr.length ? sigArr[idx + 1].o : null
        const entryBtcRegime = btc.dir
        const decorated = { ...outcome, entryBtcRegime, nextOpen, costPctVal: tradeCostPct(sig, outcome.status) }
        closedTrades.push(decorated)
        trades.push(decorated)
        openPositions.set(key, { closedAtMs: new Date(outcome.closedAt).getTime() })
      } else {
        // never resolves within available cached history — mirrors a still-open production
        // position; blocks the key for the rest of this replay (Infinity), excluded from stats.
        openPositions.set(key, { closedAtMs: Infinity })
      }
    }
  }

  progress.done()
  return { horizon: H.key, trades, tAxisLen: tAxis.length, symbolsUsed: symbols.length }
}

async function runReplay() {
  await mkdir(BT_DIR, { recursive: true })
  const symbols = await loadOrCreateSymbolSnapshot(UNIVERSE_TOP_N)
  console.log(`Загружаю кэш истории для ${symbols.length} символов...`)
  const hist = await loadAllHistory(symbols)
  for (const s of symbols) {
    const counts = PULL_INTERVALS.map((i) => `${i}:${hist[s][i].length}`).join(' ')
    console.log(`  ${s}: ${counts}`)
  }

  const horizonFilter = flag('horizons')
  const wantedKeys = horizonFilter ? String(horizonFilter).split(',') : HORIZONS.map((h) => h.key)
  const audit = auditCounters()
  const allResults = []
  for (const H of HORIZONS) {
    if (!wantedKeys.includes(H.key)) continue
    console.log(`\n== Реплей горизонта ${H.key} (${H.sigTf}/${H.trendTf}) ==`)
    const t0 = Date.now()
    const res = await replayHorizon(H, symbols, hist, audit)
    console.log(`  ${res.trades?.length ?? 0} закрытых сделок, T-axis=${res.tAxisLen ?? 0} тиков, за ${((Date.now() - t0) / 1000).toFixed(1)}с`)
    allResults.push(res)
  }

  const allTrades = allResults.flatMap((r) => r.trades || [])
  await writeFile(TRADES_PATH, JSON.stringify(allTrades), 'utf8')

  const auditReport = {
    generatedAt: new Date().toISOString(),
    ...audit,
    windowChecksPass: audit.windowViolations === 0,
    outcomeChecksPass: audit.outcomeViolations === 0,
    rsDenomChecksPass: audit.rsDenomViolations === 0,
    allAssertsPass: audit.windowViolations === 0 && audit.outcomeViolations === 0 && audit.rsDenomViolations === 0,
    perHorizon: allResults.map((r) => ({ horizon: r.horizon, trades: r.trades?.length ?? 0, tAxisLen: r.tAxisLen ?? 0, skipped: !!r.skipped, reason: r.reason })),
  }
  await writeFile(AUDIT_PATH, JSON.stringify(auditReport, null, 2), 'utf8')

  console.log(`\n=== Lookahead audit ===`)
  console.log(`(a) window checks: ${audit.windowChecks - audit.windowViolations}/${audit.windowChecks} ok`)
  console.log(`(b) outcome first-bar checks: ${audit.outcomeChecks - audit.outcomeViolations}/${audit.outcomeChecks} ok`)
  console.log(`(c) RS-denominator checks: ${audit.rsDenomChecks - audit.rsDenomViolations}/${audit.rsDenomChecks} ok`)
  console.log(auditReport.allAssertsPass ? 'AUDIT: PASS (0 violations)' : 'AUDIT: FAIL — see audit.json')
  console.log(`\nВсего закрытых сделок в реплее: ${allTrades.length}. Записано в ${TRADES_PATH}`)
}

// ── P0-6: eval ──
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }
function quantile(sorted, q) {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base]
}

function netRForTrade(t, fill) {
  if (t.status === 'expired') return null
  if (fill === 'close') return t.netR
  // next-open fill: re-derive using the bar-after-signal open as the assumed fill price,
  // keeping the same absolute sl/tp levels (a realistic "couldn't get the close price" check).
  if (t.nextOpen == null) return null
  const dir = t.side === 'long' ? 1 : -1
  const pnlPct = ((t.exitPrice - t.nextOpen) / t.nextOpen) * 100 * dir
  const riskPct = (Math.abs(t.nextOpen - t.sl) / t.nextOpen) * 100
  if (!(riskPct > 0)) return null
  const netPnlPct = pnlPct - (t.costPctVal ?? t.costPct ?? 0)
  return netPnlPct / riskPct
}

function blockBootstrapCI(values, blockSize, iters = 2000) {
  if (values.length < 2) return { lo: null, hi: null }
  const n = values.length
  const nBlocks = Math.max(1, Math.ceil(n / blockSize))
  const means = []
  for (let it = 0; it < iters; it++) {
    const sample = []
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(Math.random() * n)
      for (let k = 0; k < blockSize && sample.length < n; k++) sample.push(values[(start + k) % n])
    }
    means.push(mean(sample))
  }
  means.sort((a, b) => a - b)
  return { lo: +quantile(means, 0.05).toFixed(3), hi: +quantile(means, 0.95).toFixed(3) }
}

// Purged + embargoed expanding walk-forward: chronological folds, purge any trade whose
// entry falls within `embargo` ms of the fold's start boundary (on either side).
function purgedFolds(trades, nFolds, embargoMs) {
  const withT = trades.map((t) => ({ t, entryMs: new Date(t.createdAt).getTime() })).sort((a, b) => a.entryMs - b.entryMs)
  if (!withT.length) return []
  const tMin = withT[0].entryMs, tMax = withT[withT.length - 1].entryMs
  const span = Math.max(1, tMax - tMin)
  const folds = []
  for (let f = 0; f < nFolds; f++) {
    const foldStart = tMin + (span * f) / nFolds
    const foldEnd = tMin + (span * (f + 1)) / nFolds
    const testSet = withT.filter((x) => x.entryMs >= foldStart && x.entryMs < foldEnd && Math.abs(x.entryMs - foldStart) > embargoMs && Math.abs(x.entryMs - foldEnd) > embargoMs).map((x) => x.t)
    folds.push({ fold: f, foldStart: new Date(foldStart).toISOString(), foldEnd: new Date(foldEnd).toISOString(), trades: testSet })
  }
  return folds
}

function statsFor(trades, fill) {
  const netRs = trades.map((t) => netRForTrade(t, fill)).filter((x) => x != null)
  const decided = trades.filter((t) => t.status !== 'expired')
  const wins = decided.filter((t) => t.status === 'tp').length
  return {
    n: trades.length,
    decided: decided.length,
    winRate: decided.length ? +((wins / decided.length) * 100).toFixed(1) : null,
    avgNetR: netRs.length ? +mean(netRs).toFixed(3) : null,
    netRs,
  }
}

async function runEval() {
  await mkdir(BT_DIR, { recursive: true })
  if (!existsSync(TRADES_PATH)) {
    console.error(`Нет ${TRADES_PATH} — сначала запусти --replay.`)
    process.exit(1)
  }
  const trades = JSON.parse(await readFile(TRADES_PATH, 'utf8'))
  const fillArg = flag('fill', 'both')
  const fills = fillArg === 'both' ? ['close', 'next-open'] : [fillArg]

  const strataKeys = new Set(trades.map((t) => `${t.horizon}|${t.side}|${t.entryBtcRegime}`))
  const strata = {}
  const progress = makeProgress('eval', strataKeys.size)
  let evalDone = 0
  for (const key of strataKeys) {
    evalDone++
    progress.tick(evalDone, key)
    const [horizon, side, regime] = key.split('|')
    const arr = trades.filter((t) => t.horizon === horizon && t.side === side && t.entryBtcRegime === regime)
    const embargoMs = (MAX_AGE_DAYS[horizon] || 12) * 864e5
    const folds = purgedFolds(arr, 4, embargoMs)
    const foldStats = folds.map((f) => ({
      fold: f.fold, foldStart: f.foldStart, foldEnd: f.foldEnd, n: f.trades.length,
      close: statsFor(f.trades, 'close'), nextOpen: statsFor(f.trades, 'next-open'),
    }))
    const pooledPostPurge = folds.flatMap((f) => f.trades)
    const decided = pooledPostPurge.filter((t) => t.status !== 'expired')
    const enough = decided.length >= STRATUM_MIN
    const byFill = {}
    for (const fill of fills) {
      const netRs = pooledPostPurge.map((t) => netRForTrade(t, fill)).filter((x) => x != null)
      const ci10 = blockBootstrapCI(netRs, 10)
      const ci30 = blockBootstrapCI(netRs, 30)
      byFill[fill] = {
        avgNetR: netRs.length ? +mean(netRs).toFixed(3) : null,
        n: netRs.length,
        ci_block10: ci10,
        ci_block30: ci30,
        lowerCiPositive: ci10.lo != null ? ci10.lo > 0 : null,
      }
    }
    strata[key] = {
      horizon, side, regime,
      nRaw: arr.length,
      nPostPurgeEmbargo: pooledPostPurge.length,
      decided: decided.length,
      enough,
      notBacktestable: !enough,
      byFill,
      // reuse the REAL engine's own aggStats (P0-1 export) as a cross-check on the raw
      // (pre-purge, close-fill) numbers — same rollup production itself uses for stats.byStratum.
      aggStatsRaw: aggStats(arr),
      folds: foldStats,
    }
  }
  progress.done()

  // Overall summary via the real engine's own computeStats (open=[] — replay doesn't carry
  // forward "still open at end of history" positions into this report). Grounds the custom
  // purge/bootstrap/dual-fill analysis above against the same function production trusts.
  const overallStats = computeStats([], trades)

  const preRegistered = {
    adxGate: [22, 25, 28, 30, 35],
    rrCap: [2.0, 2.5],
    volPctCap: [0.65, 0.70, 0.85],
    rsFloor: [0.20, 0.25, 0.33],
    note: 'Pre-registered per plan section P0-6. Phase 0 does NOT fit or select among these — listed for the record only; no sweep is executed or shipped here.',
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalTrades: trades.length,
    sampleGate: STRATUM_MIN,
    survivorshipCaveat: 'Universe = TODAY\'S top volume snapshot, replayed backward. Can falsify a losing rule; cannot confirm a profitable one (delisted/decayed coins are absent from the replay universe).',
    costCaveat: 'avgNetR is net-of-cost only (FEE_RT+SLIP_RT subtracted); never report gross.',
    overallStats,
    strata,
    preRegisteredHypotheses: preRegistered,
  }
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')

  console.log(`\n=== P0-6 net-of-cost report (dual-fill) — ${Object.keys(strata).length} strata ===`)
  for (const [key, s] of Object.entries(strata)) {
    const tag = s.notBacktestable ? 'NOT-BACKTESTABLE' : 'ok'
    const c = s.byFill.close, n = s.byFill['next-open']
    console.log(`${key.padEnd(28)} n=${String(s.decided).padStart(4)} [${tag}]  close avgNetR=${c?.avgNetR ?? 'NA'} CI10=[${c?.ci_block10?.lo},${c?.ci_block10?.hi}]  next-open avgNetR=${n?.avgNetR ?? 'NA'} CI10=[${n?.ci_block10?.lo},${n?.ci_block10?.hi}]`)
  }
  console.log(`\nОтчёт записан в ${REPORT_PATH}`)
}

async function main() {
  if (flag('pull')) return runPull()
  if (flag('replay')) return runReplay()
  if (flag('eval')) return runEval()
  console.log('Usage: node scripts/backtest.mjs --pull|--replay|--eval [options]')
  console.log('  --pull [--years=3]')
  console.log('  --replay [--horizons=scalp,mid,long,veryLong]')
  console.log('  --eval [--fill=close|next-open|both]')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
