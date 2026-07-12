// Meridian — mc-x10.mjs: Монте-Карло финальной «Политики X10 v1» (см. docs/X10_POLICY.md).
// Промоушен верифицированного mc-combo.mjs (волна 2, вердикт скептика CONFIRMED,
// бит-в-бит репродукция); изменены ТОЛЬКО этот заголовок и блок путей (repo-relative).
// Запуск из корня репо: node scripts/mc-x10.mjs  (~2 мин, N=20000, LOO 19 месяцев)
// Требует data/backtest/trades-t30.json (node scripts/backtest.mjs --pull|--replay --tag=t30 --top=30).
// mc-combo.mjs
// ONE preregistered combined betting policy (adxTilt AND salvage = "combo") tested on the
// Meridian Monte Carlo, plus its robustness sibling (comboRobust, softer adx weights, NOT for
// selection), against the two already-registered building-block policies (ladder, adxTilt) and
// the plain salvage policy, with paired significance tests (McNemar, same 20000 paths per row,
// common random numbers) and a leave-one-calendar-month-out robustness sweep on the combo row.
//
// Methodology is copied EXACTLY from mc-policies-v2.mjs (itself copied exactly from
// mc-frontier-supplement.mjs for the core bootstrap/rng/liquidation machinery):
//   - makeRng                : identical LCG
//   - normalizeTrade         : identical trade filter/derivation (incl. adx + strata key)
//   - buildMonths            : identical (recent window createdAt>=2025-01-15, per-stratum
//                               calendar-month buckets Jan-2025..tape's last month, lastMs
//                               computed over ALL raw trades not just recent)
//   - synthPath              : identical (12-slot monthly block bootstrap onto a synthetic
//                               year starting SYNTH0=2026-01-01)
//   - dsSeed / per-path seed : identical hash + formula, SAME dataset name string 't30-S5' as
//                               the reference, so per-path seeds (and therefore the guard
//                               reproduction) match bit-for-bit. Reused unchanged for the LOO
//                               drops too (same dsSeed, same per-path seed formula each time --
//                               only the resampled month pool differs per drop).
//   - ladder(fH,fL)          : identical formula (log10 interpolation 1x->10x over 365d)
//   - buildEvents/simulate   : identical state machine (entry/exit event list, liquidation
//                               model, riskCap enforcement, LEV_CAP, bust-at-zero-equity)
//   - percentile/summarize   : identical
//
// Strata: S5 = {mid:long, mid:short} ONLY (task does not request S3). N=20000 per row.
//
// Ground rules honored: no repo source files touched, no git writes; this file and its results
// JSON are the only outputs, both under the scratchpad directory given in the task.

import { readFile, writeFile } from 'node:fs/promises'

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const RESULTS_PATH = `${REPO}/data/backtest/mc-x10-results.json`

const START = 1000, CUT_MS = Date.UTC(2025, 0, 15), FUNDING_PER_DAY = 0.03
const MAINT_PCT = 1.0, LEV_CAP = 10, MONTH_MS = 30.4375 * 864e5
const SYNTH0 = Date.UTC(2026, 0, 1), TARGET = 10, N = 20000
const S5 = new Set(['mid:long', 'mid:short'])
const DS_NAME = 't30-S5'

const GUARDS = {
  'R0:ladder': { expected: 0.0814, tol: 0.008 },
  'R1:adxTilt': { expected: 0.09035, tol: 0.008 },
}

// ---------------------------------------------------------------------------
// Reference methodology (copied exactly)
// ---------------------------------------------------------------------------

function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

function normalizeTrade(t) {
  if (!['tp', 'sl', 'expired'].includes(t.status)) return null
  const dir = t.side === 'long' ? 1 : -1
  if (t.nextOpen == null) return null
  const entryPx = t.nextOpen
  const pnlPct = ((t.exitPrice - entryPx) / entryPx) * 100 * dir
  const riskDistPct = (Math.abs(entryPx - t.sl) / entryPx) * 100
  if (!(riskDistPct > 0)) return null
  const cost = t.costPctVal ?? t.costPct ?? 0
  const entryMs = new Date(t.createdAt).getTime(), exitMs = new Date(t.closedAt).getTime()
  if (exitMs <= entryMs) return null
  const funding = t.side === 'long' ? FUNDING_PER_DAY * ((t.durationH ?? 0) / 24) : 0
  const netPnlPct = pnlPct - cost - funding
  const adx = t.indicators?.adx ?? null
  const key = `${t.horizon}:${t.side}`
  return { entryMs, exitMs, netPnlPct, riskDistPct, maeR: t.maeR ?? null, adx, key }
}

function buildMonths(rawAll, strata) {
  const recent = rawAll.filter((t) => new Date(t.createdAt).getTime() >= CUT_MS && strata.has(`${t.horizon}:${t.side}`))
  const lastMs = Math.max(...rawAll.map((t) => new Date(t.createdAt).getTime()))
  const months = []
  for (let y = 2025, m = 0; ; ) {
    const start = Date.UTC(y, m, 1)
    if (start > lastMs) break
    if (Date.UTC(y, m + 1, 1) > CUT_MS) months.push({ startMs: start, norm: [] })
    m++; if (m === 12) { m = 0; y++ }
  }
  const monthOf = (ms) => months.find((mo, i) => ms >= mo.startMs && (i + 1 === months.length || ms < months[i + 1].startMs))
  for (const t of recent) {
    const n = normalizeTrade(t)
    if (!n) continue
    const mo = monthOf(n.entryMs)
    if (mo) mo.norm.push({ ...n, offMs: n.entryMs - mo.startMs, durMs: n.exitMs - n.entryMs })
  }
  return months
}

function synthPath(months, rnd) {
  const norm = []
  for (let slot = 0; slot < 12; slot++) {
    const mo = months[Math.floor(rnd() * months.length)]
    const slotStart = SYNTH0 + slot * MONTH_MS
    for (const t of mo.norm) norm.push({ ...t, entryMs: slotStart + t.offMs, exitMs: slotStart + t.offMs + t.durMs })
  }
  norm.sort((a, b) => a.entryMs - b.entryMs)
  return norm
}

const ladderRisk = (fH, fL) => (eq, d) => (eq / START) < Math.pow(TARGET, Math.min(Math.max(d, 0), 365) / 365) ? fH : fL

function buildEvents(trades) {
  const events = []
  for (let i = 0; i < trades.length; i++) {
    events.push({ ms: trades[i].entryMs, kind: 1, i })
    events.push({ ms: trades[i].exitMs, kind: 0, i })
  }
  events.sort((a, b) => a.ms - b.ms || a.kind - b.kind)
  return events
}

function simulate(trades, events, decide, riskCap) {
  let equity = START, openRiskFrac = 0, openNotional = 0
  const open = new Array(trades.length)
  let busted = false, tradesTaken = 0, peak = START, maxDD = 0
  for (const ev of events) {
    const t = trades[ev.i]
    if (ev.kind === 0) {
      const pos = open[ev.i]
      if (!pos) continue
      if (pos.liq) equity -= pos.margin
      else equity += (pos.notional * t.netPnlPct) / 100
      openRiskFrac -= pos.riskFrac; openNotional -= pos.notional; open[ev.i] = undefined
      if (equity > peak) peak = equity
      const eqForDD = Math.max(equity, 0)
      const dd = (peak - eqForDD) / peak
      if (dd > maxDD) maxDD = dd
      if (equity <= 0) { busted = true; equity = 0; break }
    } else {
      if (busted) continue
      const elapsedDays = (ev.ms - SYNTH0) / 864e5
      const tradeRisk = decide(t, equity, elapsedDays)
      if (!(tradeRisk > 0)) continue
      if (openRiskFrac + tradeRisk > riskCap + 1e-9) continue
      let riskAmt = equity * tradeRisk
      let notional = riskAmt / (t.riskDistPct / 100)
      const room = Math.max(0, equity * LEV_CAP - openNotional)
      const cap = Math.min(equity * LEV_CAP, room)
      if (notional > cap) { notional = cap; riskAmt = notional * (t.riskDistPct / 100) }
      if (notional <= 0) continue
      const riskFrac = riskAmt / equity, impliedLev = notional / equity
      let liq = false, margin = 0
      if (impliedLev > 1) {
        const liqAdversePct = 100 / impliedLev - MAINT_PCT
        const maePct = t.maeR != null ? t.maeR * t.riskDistPct : null
        if ((maePct != null && maePct >= liqAdversePct) || -t.netPnlPct >= liqAdversePct) { liq = true; margin = equity }
      }
      open[ev.i] = { notional, riskFrac, liq, margin }
      openRiskFrac += riskFrac; openNotional += notional
      tradesTaken++
    }
  }
  return { finalMult: equity / START, tradesTaken, maxDDPct: maxDD * 100 }
}

function percentile(sortedArr, p) {
  const n = sortedArr.length
  if (n === 0) return NaN
  if (n === 1) return sortedArr[0]
  const idx = p * (n - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  if (lo === hi) return sortedArr[lo]
  const frac = idx - lo
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac
}

function summarize(finalArr, ddArr, tradesArr) {
  const nA = finalArr.length
  const sortedFinal = Float64Array.from(finalArr).sort()
  const sortedDD = Float64Array.from(ddArr).sort()
  let cTen = 0, cFive = 0, cTwo = 0, cBust = 0, sumTrades = 0
  for (let i = 0; i < nA; i++) {
    const v = finalArr[i]
    if (v >= 10) cTen++
    if (v >= 5) cFive++
    if (v >= 2) cTwo++
    if (v <= 0.1) cBust++
    sumTrades += tradesArr[i]
  }
  const pTenX = cTen / nA
  return {
    pTenX,
    seTenX: Math.sqrt(pTenX * (1 - pTenX) / nA),
    pFiveX: cFive / nA,
    pTwoX: cTwo / nA,
    pBust: cBust / nA,
    median: percentile(sortedFinal, 0.5),
    p90: percentile(sortedFinal, 0.9),
    medianMaxDDPct: percentile(sortedDD, 0.5),
    avgTradesTaken: sumTrades / nA,
  }
}

function hashName(name) { return [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 17) }

// ---------------------------------------------------------------------------
// Policy definitions (exact task spec)
// ---------------------------------------------------------------------------

const EFFECTIVE_CAP = 0.30   // adxTilt/combo per-trade effective risk cap
const SALVAGE_FRAC = 0.15    // salvage trigger: equity < 0.15*START at an entry decision
const SALVAGE_RISK = 0.02    // salvage locked risk (permanent for rest of path)
const PORTFOLIO_RISK_CAP = 0.45 // riskCap=0.45 per ladder(fH=0.15,...) spec (=3*fH), shared by all rows

function adxMultiplierTilt(adx) {
  if (adx == null) return 1.0
  if (adx >= 45) return 1.5
  if (adx >= 38) return 1.0
  return 0.5
}
function adxMultiplierRobust(adx) {
  if (adx == null) return 1.0
  if (adx >= 45) return 1.25
  if (adx >= 38) return 1.0
  return 0.75
}

// R0: baseline ladder(fH=0.15, fL=0.02, riskCap=0.45)
function makeR0() {
  const base = ladderRisk(0.15, 0.02)
  const decide = (trade, eq, d) => base(eq, d)
  return { name: 'R0:ladder', params: { fH: 0.15, fL: 0.02, riskCap: PORTFOLIO_RISK_CAP }, riskCap: PORTFOLIO_RISK_CAP, makeDecide: () => decide }
}

// R1: adxTilt -- ladder risk multiplied by w(adx), tiers 45/38, per-trade cap 0.30
function makeR1() {
  const base = ladderRisk(0.15, 0.02)
  const decide = (trade, eq, d) => Math.min(base(eq, d) * adxMultiplierTilt(trade.adx), EFFECTIVE_CAP)
  return {
    name: 'R1:adxTilt',
    params: { fH: 0.15, fL: 0.02, riskCap: PORTFOLIO_RISK_CAP, effCap: EFFECTIVE_CAP, tiers: '>=45:1.5,>=38:1.0,else:0.5,null:1.0' },
    riskCap: PORTFOLIO_RISK_CAP,
    makeDecide: () => decide,
  }
}

// R2: salvage -- once equity < 0.15*START at an entry decision, risk locks to 0.02 permanently
function makeR2() {
  const base = ladderRisk(0.15, 0.02)
  return {
    name: 'R2:salvage',
    params: { fH: 0.15, fL: 0.02, riskCap: PORTFOLIO_RISK_CAP, salvageFrac: SALVAGE_FRAC, salvageRisk: SALVAGE_RISK },
    riskCap: PORTFOLIO_RISK_CAP,
    makeDecide: () => {
      let locked = false
      return (trade, eq, d) => {
        if (!locked && eq < SALVAGE_FRAC * START) locked = true
        return locked ? SALVAGE_RISK : base(eq, d)
      }
    },
  }
}

// R3: combo -- adxTilt AND salvage simultaneously; salvage lock overrides everything once triggered
function makeR3() {
  const base = ladderRisk(0.15, 0.02)
  return {
    name: 'R3:combo',
    params: {
      fH: 0.15, fL: 0.02, riskCap: PORTFOLIO_RISK_CAP, effCap: EFFECTIVE_CAP,
      tiers: '>=45:1.5,>=38:1.0,else:0.5,null:1.0', salvageFrac: SALVAGE_FRAC, salvageRisk: SALVAGE_RISK,
    },
    riskCap: PORTFOLIO_RISK_CAP,
    makeDecide: () => {
      let locked = false
      return (trade, eq, d) => {
        if (!locked && eq < SALVAGE_FRAC * START) locked = true
        if (locked) return SALVAGE_RISK
        return Math.min(base(eq, d) * adxMultiplierTilt(trade.adx), EFFECTIVE_CAP)
      }
    },
  }
}

// R4: comboRobust -- combo with softer tier weights 1.25/1.0/0.75 (same 45/38 boundaries).
// Robustness slice only -- not used for selection or paired tests.
function makeR4() {
  const base = ladderRisk(0.15, 0.02)
  return {
    name: 'R4:comboRobust',
    params: {
      fH: 0.15, fL: 0.02, riskCap: PORTFOLIO_RISK_CAP, effCap: EFFECTIVE_CAP,
      tiers: '>=45:1.25,>=38:1.0,else:0.75,null:1.0', salvageFrac: SALVAGE_FRAC, salvageRisk: SALVAGE_RISK,
    },
    riskCap: PORTFOLIO_RISK_CAP,
    makeDecide: () => {
      let locked = false
      return (trade, eq, d) => {
        if (!locked && eq < SALVAGE_FRAC * START) locked = true
        if (locked) return SALVAGE_RISK
        return Math.min(base(eq, d) * adxMultiplierRobust(trade.adx), EFFECTIVE_CAP)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Main sweep (R0..R4, N=20000, shared per-path CRN trade tape)
// ---------------------------------------------------------------------------

function runMainSweep(months, policies, dsSeed) {
  const nPol = policies.length
  const finalArr = Array.from({ length: nPol }, () => new Array(N))
  const ddArr = Array.from({ length: nPol }, () => new Array(N))
  const tradesArr = Array.from({ length: nPol }, () => new Array(N))
  const t0 = Date.now()
  for (let p = 0; p < N; p++) {
    const rnd = makeRng((123456789 + p * 2654435761 + dsSeed) >>> 0)
    const path = synthPath(months, rnd)
    const events = buildEvents(path)
    for (let k = 0; k < nPol; k++) {
      const pol = policies[k]
      const decide = pol.makeDecide()
      const r = simulate(path, events, decide, pol.riskCap)
      finalArr[k][p] = r.finalMult
      ddArr[k][p] = r.maxDDPct
      tradesArr[k][p] = r.tradesTaken
    }
    if ((p + 1) % 5000 === 0) console.log(`  [main] path ${p + 1}/${N} (${((Date.now() - t0) / 1000).toFixed(1)}s elapsed)`)
  }
  const rows = []
  for (let k = 0; k < nPol; k++) {
    const pol = policies[k]
    const stats = summarize(finalArr[k], ddArr[k], tradesArr[k])
    rows.push({ policy: pol.name, params: pol.params, ...stats })
    console.log(`  [main] ${pol.name.padEnd(16)} pTenX=${stats.pTenX.toFixed(4)}±${stats.seTenX.toFixed(4)}  p5x=${stats.pFiveX.toFixed(4)}  p2x=${stats.pTwoX.toFixed(4)}  pBust=${stats.pBust.toFixed(4)}  med=${stats.median.toFixed(3)}  p90=${stats.p90.toFixed(3)}  medDD=${stats.medianMaxDDPct.toFixed(2)}%  avgTrades=${stats.avgTradesTaken.toFixed(1)}`)
  }
  console.log(`[main] sweep done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { rows, finalArr }
}

// ---------------------------------------------------------------------------
// Paired McNemar tests (same 20000 paths, binary indicator per path per policy)
// ---------------------------------------------------------------------------

function indicatorsFor(finalArr) {
  const n = finalArr.length
  const ten = new Uint8Array(n), two = new Uint8Array(n), bust = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = finalArr[i]
    ten[i] = v >= 10 ? 1 : 0
    two[i] = v >= 2 ? 1 : 0
    bust[i] = v <= 0.1 ? 1 : 0
  }
  return { ten, two, bust }
}

// baseLabel/baseInd = the "vs" comparator; testLabel/testInd = the row under test.
// n10 = base hit, test missed (base=1,test=0); n01 = base missed, test hit (base=0,test=1).
// chi2 uses Yates continuity correction: (|n01-n10|-1)^2 / (n01+n10) (matches R's mcnemar.test
// default correct=TRUE). z = sign(n01-n10) * sqrt(chi2): positive => test rate > base rate.
function mcnemarTest(testLabel, testInd, baseLabel, baseInd, metric) {
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0
  const n = testInd.length
  for (let i = 0; i < n; i++) {
    const b = baseInd[i], t = testInd[i]
    if (b === 1 && t === 1) n11++
    else if (b === 1 && t === 0) n10++
    else if (b === 0 && t === 1) n01++
    else n00++
  }
  const denom = n01 + n10
  let chi2 = 0, z = 0
  if (denom > 0) {
    chi2 = Math.pow(Math.abs(n01 - n10) - 1, 2) / denom
    z = Math.sign(n01 - n10) * Math.sqrt(chi2)
  }
  return {
    comparison: `${testLabel} vs ${baseLabel}`,
    metric,
    n11, n10, n01, n00,
    discordantCounts: `n01(base0/test1)=${n01}, n10(base1/test0)=${n10}`,
    chi2: Number(chi2.toFixed(6)),
    z: Number(z.toFixed(6)),
  }
}

// ---------------------------------------------------------------------------
// Leave-one-calendar-month-out robustness sweep on R3 (combo)
// ---------------------------------------------------------------------------

function runLOODrop(loMonths, dsSeed, policyFactory) {
  const finalArr = new Array(N)
  for (let p = 0; p < N; p++) {
    const rnd = makeRng((123456789 + p * 2654435761 + dsSeed) >>> 0)
    const path = synthPath(loMonths, rnd)
    const events = buildEvents(path)
    const pol = policyFactory()
    const decide = pol.makeDecide()
    const r = simulate(path, events, decide, pol.riskCap)
    finalArr[p] = r.finalMult
  }
  let cTen = 0, cBust = 0
  for (let i = 0; i < N; i++) {
    if (finalArr[i] >= 10) cTen++
    if (finalArr[i] <= 0.1) cBust++
  }
  return { pTenX: cTen / N, pBust: cBust / N }
}

function monthLabel(startMs) {
  const d = new Date(startMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Loading tape: data/backtest/trades-t30.json ...`)
  const rawT30 = JSON.parse(await readFile(`${REPO}/data/backtest/trades-t30.json`, 'utf8'))
  console.log(`  ${rawT30.length} raw trades loaded.`)

  const anomalies = []

  console.log(`Building months for S5 {mid:long, mid:short} ...`)
  const months = buildMonths(rawT30, S5)
  const totalNorm = months.reduce((a, m) => a + m.norm.length, 0)
  console.log(`  ${months.length} month buckets (${monthLabel(months[0].startMs)}..${monthLabel(months[months.length - 1].startMs)}), ${totalNorm} normalized trades.`)
  for (const mo of months) {
    if (mo.norm.length === 0) anomalies.push(`Month bucket ${monthLabel(mo.startMs)} has 0 normalized S5 trades (contributes an empty slot whenever drawn by the bootstrap).`)
  }

  const dsSeed = hashName(DS_NAME)
  console.log(`dsSeed('${DS_NAME}') = ${dsSeed}`)

  const policies = [makeR0(), makeR1(), makeR2(), makeR3(), makeR4()]
  console.log(`Running main sweep: 5 policies (R0..R4) x N=${N} paths, shared CRN trade tape ...`)
  const { rows, finalArr } = runMainSweep(months, policies, dsSeed)

  // --- guard check ---
  const r0Row = rows.find((r) => r.policy === 'R0:ladder')
  const r1Row = rows.find((r) => r.policy === 'R1:adxTilt')
  const g0diff = Math.abs(r0Row.pTenX - GUARDS['R0:ladder'].expected)
  const g1diff = Math.abs(r1Row.pTenX - GUARDS['R1:adxTilt'].expected)
  const g0pass = g0diff <= GUARDS['R0:ladder'].tol
  const g1pass = g1diff <= GUARDS['R1:adxTilt'].tol
  const guardReproduction = {
    'R0:ladder': { expected: GUARDS['R0:ladder'].expected, got: r0Row.pTenX, diff: g0diff, tol: GUARDS['R0:ladder'].tol, pass: g0pass },
    'R1:adxTilt': { expected: GUARDS['R1:adxTilt'].expected, got: r1Row.pTenX, diff: g1diff, tol: GUARDS['R1:adxTilt'].tol, pass: g1pass },
    overallPass: g0pass && g1pass,
  }
  console.log(`GUARD R0:ladder  expected=${GUARDS['R0:ladder'].expected} got=${r0Row.pTenX.toFixed(4)} diff=${g0diff.toFixed(4)} tol=${GUARDS['R0:ladder'].tol} => ${g0pass ? 'PASS' : 'FAIL'}`)
  console.log(`GUARD R1:adxTilt expected=${GUARDS['R1:adxTilt'].expected} got=${r1Row.pTenX.toFixed(4)} diff=${g1diff.toFixed(4)} tol=${GUARDS['R1:adxTilt'].tol} => ${g1pass ? 'PASS' : 'FAIL'}`)

  let pairedTests = []
  let looCombo = null
  let halted = false

  if (!guardReproduction.overallPass) {
    halted = true
    anomalies.push(`GUARD FAILURE: R0 or R1 pTenX reproduction exceeded tolerance. Per instructions, halting before paired tests and LOO. guardReproduction=${JSON.stringify(guardReproduction)}`)
    console.log(`GUARD FAILED -- halting before paired tests and LOO, per instructions.`)
  } else {
    // --- paired McNemar tests on the shared 20000-path CRN tape ---
    const idxR0 = policies.findIndex((p) => p.name === 'R0:ladder')
    const idxR1 = policies.findIndex((p) => p.name === 'R1:adxTilt')
    const idxR2 = policies.findIndex((p) => p.name === 'R2:salvage')
    const idxR3 = policies.findIndex((p) => p.name === 'R3:combo')
    const ind0 = indicatorsFor(finalArr[idxR0])
    const ind1 = indicatorsFor(finalArr[idxR1])
    const ind2 = indicatorsFor(finalArr[idxR2])
    const ind3 = indicatorsFor(finalArr[idxR3])

    pairedTests = [
      mcnemarTest('R3', ind3.ten, 'R0', ind0.ten, '10x'),   // (a)
      mcnemarTest('R3', ind3.ten, 'R1', ind1.ten, '10x'),   // (b)
      mcnemarTest('R3', ind3.bust, 'R1', ind1.bust, 'bust'), // (c)
      mcnemarTest('R2', ind2.bust, 'R0', ind0.bust, 'bust'), // (d)
      mcnemarTest('R3', ind3.two, 'R0', ind0.two, '2x'),    // (e)
    ]
    console.log(`Paired McNemar tests:`)
    for (const pt of pairedTests) console.log(`  ${pt.comparison.padEnd(10)} [${pt.metric}]  ${pt.discordantCounts}  chi2=${pt.chi2}  z=${pt.z}`)

    // --- LOO: drop each single calendar month from the bootstrap pool, R3 (combo) only ---
    console.log(`LOO sweep: dropping each of ${months.length} months, R3(combo) only, N=${N} each ...`)
    const looRows = []
    const tLoo0 = Date.now()
    for (let i = 0; i < months.length; i++) {
      const label = monthLabel(months[i].startMs)
      const loMonths = months.filter((_, idx) => idx !== i)
      const r = runLOODrop(loMonths, dsSeed, makeR3)
      looRows.push({ droppedMonth: label, nTradesInDroppedMonth: months[i].norm.length, pTenX: r.pTenX, pBust: r.pBust })
      console.log(`  [LOO] drop ${label} (n=${months[i].norm.length}) -> pTenX=${r.pTenX.toFixed(4)} pBust=${r.pBust.toFixed(4)} (${((Date.now() - tLoo0) / 1000).toFixed(1)}s elapsed)`)
    }
    const pTenXVals = looRows.map((r) => r.pTenX)
    const pBustVals = looRows.map((r) => r.pBust)
    looCombo = {
      policy: 'R3:combo',
      N,
      monthsInPool: months.length,
      rows: looRows,
      envelope: {
        pTenX: { min: Math.min(...pTenXVals), max: Math.max(...pTenXVals) },
        pBust: { min: Math.min(...pBustVals), max: Math.max(...pBustVals) },
      },
    }
    console.log(`LOO envelope: pTenX [${looCombo.envelope.pTenX.min.toFixed(4)}, ${looCombo.envelope.pTenX.max.toFixed(4)}]  pBust [${looCombo.envelope.pBust.min.toFixed(4)}, ${looCombo.envelope.pBust.max.toFixed(4)}]`)
  }

  const output = {
    guardReproduction,
    halted,
    rows,
    pairedTests,
    looCombo,
    scriptPath: SCRIPT_PATH,
    resultsPath: RESULTS_PATH,
    N,
    tape: 'data/backtest/trades-t30.json',
    strata: 'S5',
    dsName: DS_NAME,
    dsSeed,
    anomalies,
    generatedAt: new Date().toISOString(),
  }
  await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2), 'utf8')
  console.log(`\nWrote results to ${RESULTS_PATH}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exitCode = 1
})
