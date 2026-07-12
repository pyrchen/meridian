// Meridian — банкролл-симулятор поверх сделок офлайн-харнесса (scripts/backtest.mjs).
// Отвечает на вопрос "сколько денег сделает $1000, торгуя сигналы движка" — event-driven
// реплей закрытых сделок trades.json с фиксированной долей риска от ТЕКУЩЕГО капитала,
// кэпами на плечо и суммарный открытый риск, funding-хэйркатом для фьючерсных лонгов.
//
// ЧЕСТНОСТЬ: сам симулятор ничего не тюнит. Отбор конфига — только на train-окне
// (--sweep), подтверждение — на holdout; финальные цифры наследуют survivorship-каветы
// исходного харнесса (вселенная = сегодняшний топ по объёму, отыгранный назад).
//
// Режимы:
//   node scripts/bankroll.mjs --run   [--trades=path] [--strata=mid:long,mid:short,...]
//        [--risk=0.02] [--fill=next-open|close] [--start=1000] [--riskCap=0.10]
//        [--levCap=3] [--fundingPerDay=0.03] [--from=ISO] [--to=ISO] [--curve=path] [--json]
//   node scripts/bankroll.mjs --sweep [--trades=path] [--split=2025-01-15] [--json]
//        прогоняет ПРЕДЗАРЕГИСТРИРОВАННУЮ матрицу конфигов на train, сортирует по
//        log-growth train, показывает holdout КАЖДОГО конфига (не только победителя).

import { readFile, writeFile } from 'node:fs/promises'

// ── CLI ──
const args = process.argv.slice(2)
function flag(name, def = undefined) {
  const pfx = `--${name}=`
  const hit = args.find((a) => a.startsWith(pfx))
  if (hit) return hit.slice(pfx.length)
  return args.includes(`--${name}`) ? true : def
}

const TRADES_PATH = String(flag('trades', 'data/backtest/trades.json'))
const START_EQUITY = Number(flag('start', 1000))

// ── загрузка и нормализация сделок ──
// Одна сделка = один закрытый исход реального реплея. Для fill=next-open пересчитываем
// pnl от открытия следующего бара (реалистичный филл), сохраняя абсолютные sl/tp —
// та же логика, что netRForTrade в backtest.mjs.
function normalizeTrade(t, fill, fundingPerDayPct) {
  if (!['tp', 'sl', 'expired'].includes(t.status)) return null
  const dir = t.side === 'long' ? 1 : -1
  let entryPx
  if (fill === 'next-open') {
    if (t.nextOpen == null) return null
    entryPx = t.nextOpen
  } else {
    entryPx = t.entry
  }
  const pnlPct = ((t.exitPrice - entryPx) / entryPx) * 100 * dir
  const riskDistPct = (Math.abs(entryPx - t.sl) / entryPx) * 100
  if (!(riskDistPct > 0)) return null
  const cost = t.costPctVal ?? t.costPct ?? 0
  // страховка от latent-hazard (verify:recompute): сделка с exitMs<=entryMs сломала бы
  // event-ordering (свой exit раньше своего entry) — в данных таких нет, но отсекаем.
  if (new Date(t.closedAt).getTime() <= new Date(t.createdAt).getTime()) return null
  // funding: консервативно — лонг платит, шорту НЕ начисляем (кредитовать шорт не будем)
  const funding = t.side === 'long' ? fundingPerDayPct * ((t.durationH ?? 0) / 24) : 0
  const netPnlPct = pnlPct - cost - funding
  return {
    key: `${t.horizon}:${t.side}`,
    side: t.side,
    regime: t.entryBtcRegime ?? null,
    entryMs: new Date(t.createdAt).getTime(),
    exitMs: new Date(t.closedAt).getTime(),
    netPnlPct,
    riskDistPct,
    netR: netPnlPct / riskDistPct,
    maeR: t.maeR ?? null, // max adverse excursion в R — для проверки ликвидации при плече
    adx: t.indicators?.adx ?? null,
    status: t.status,
    symbol: t.symbol,
  }
}

// ── политика уверенности: риск на сделку из ADX-тиров (полу-Келли, обучено на train) ──
// tiers: [{minAdx, risk}], отсортированы по minAdx убыв.; risk=0 → сделку пропускаем.
export function riskFromPolicy(policy, trade) {
  if (trade.adx == null) return policy.fallbackRisk ?? 0
  for (const tier of policy.tiers) if (trade.adx >= tier.minAdx) return tier.risk
  return 0
}

// ── режим --allin --lev=X: каждая ставка — вся эквити как маржа под плечом X ──
// Одна позиция за раз (маржа занята целиком); ликвидация — когда adverse-движение
// достигает (100/X − maintMarginPct)% ДО выхода по стопу/тейку: восстанавливаем из
// maeR × riskDistPct. Ликвидация изолированной all-in позиции = обнуление счёта.
export function simulateAllIn(rawTrades, cfg) {
  const trades = []
  for (const t of rawTrades) {
    const n = normalizeTrade(t, cfg.fill, cfg.fundingPerDay)
    if (!n) continue
    if (cfg.strata && !cfg.strata.has(n.key)) continue
    trades.push(n)
  }
  trades.sort((a, b) => a.entryMs - b.entryMs)
  const liqAdversePct = (100 / cfg.lev) - cfg.maintMarginPct // % движения цены до ликвидации
  let equity = cfg.start
  let nextFreeMs = -Infinity
  let taken = 0, skippedBusy = 0, liquidated = false
  let peak = equity, maxDD = 0
  const log = []
  for (const t of trades) {
    if (t.entryMs < nextFreeMs) { skippedBusy++; continue }
    taken++
    nextFreeMs = t.exitMs
    const maePct = t.maeR != null ? t.maeR * t.riskDistPct : null
    if ((maePct != null && maePct >= liqAdversePct) || t.netPnlPct <= -liqAdversePct) {
      // ликвидация до выхода: маржа (= вся эквити) сгорает
      log.push({ t: t.entryMs, ev: 'LIQUIDATED', symbol: t.symbol, maePct: maePct?.toFixed(2), needPct: liqAdversePct.toFixed(2) })
      equity = 0
      liquidated = true
      break
    }
    equity *= 1 + (cfg.lev * t.netPnlPct) / 100
    if (equity <= 0) { equity = 0; liquidated = true; break }
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDD) maxDD = dd
  }
  return {
    lev: cfg.lev, taken, skippedBusy, liquidated,
    final: +equity.toFixed(2),
    mult: +(equity / cfg.start).toFixed(4),
    maxDDPct: +(maxDD * 100).toFixed(1),
    liqAdversePct: +liqAdversePct.toFixed(2),
    events: log,
  }
}

// ── ядро: event-driven симуляция ──
// cfg: { strata:Set|null, risk, riskCap, levCap, fill, fundingPerDay, fromMs, toMs }
export function simulate(rawTrades, cfg) {
  const trades = []
  for (const t of rawTrades) {
    const n = normalizeTrade(t, cfg.fill, cfg.fundingPerDay)
    if (!n) continue
    if (cfg.strata && !cfg.strata.has(n.key)) continue
    // regimeAlign: торгуем только по направлению BTC-режима на момент входа (поле
    // entryBtcRegime вычислено харнессом из данных <=T — без заглядывания). Правило
    // предзарегистрировано из опубликованного report.json: шорт против режима -0.21R.
    if (cfg.regimeAlign) {
      if (n.side === 'long' && n.regime === 'down') continue
      if (n.side === 'short' && n.regime === 'up') continue
    }
    if (cfg.fromMs != null && n.entryMs < cfg.fromMs) continue
    if (cfg.toMs != null && n.entryMs >= cfg.toMs) continue
    // purge: сделка, закрывающаяся ЗА границей окна, реализует исход на данных вне окна —
    // при отборе конфига на train это утечка holdout-периода в train-метрику. Выкидываем.
    if (cfg.purgeSpan && cfg.toMs != null && n.exitMs >= cfg.toMs) continue
    trades.push(n)
  }
  if (!trades.length) return { taken: 0, skippedRiskCap: 0, final: cfg.start, curve: [], empty: true }

  // события: exit раньше entry при равном времени (освобождаем риск-бюджет до входа)
  const events = []
  trades.forEach((t, i) => {
    events.push({ ms: t.entryMs, kind: 1, i }) // 1=entry
    events.push({ ms: t.exitMs, kind: 0, i }) // 0=exit
  })
  events.sort((a, b) => a.ms - b.ms || a.kind - b.kind)

  let equity = cfg.start
  let openRiskFrac = 0
  let openNotional = 0
  const open = new Map() // i -> { notional, riskFrac }
  const curve = [{ ms: events[0].ms, eq: equity }]
  let taken = 0
  let skippedRiskCap = 0
  let busted = false
  let wins = 0
  let decidedTaken = 0
  const takenNetRs = []
  const levSamples = []

  for (const ev of events) {
    const t = trades[ev.i]
    if (ev.kind === 0) {
      const pos = open.get(ev.i)
      if (!pos) continue
      equity += (pos.notional * t.netPnlPct) / 100
      openRiskFrac -= pos.riskFrac
      openNotional -= pos.notional
      open.delete(ev.i)
      curve.push({ ms: ev.ms, eq: equity })
      if (equity <= 0) { busted = true; break }
    } else {
      if (busted) continue
      // политика уверенности (если задана) выбирает риск на сделку; 0 = пропуск
      const tradeRisk = cfg.policy ? riskFromPolicy(cfg.policy, t) : cfg.risk
      if (!(tradeRisk > 0)) { continue }
      // риск-кэп: суммарный открытый риск не превышает cfg.riskCap
      if (openRiskFrac + tradeRisk > cfg.riskCap + 1e-9) { skippedRiskCap++; continue }
      let riskAmt = equity * tradeRisk
      let notional = riskAmt / (t.riskDistPct / 100)
      // кэп плеча: и на позицию, и на суммарный нотионал (маржа)
      const maxPosNotional = equity * cfg.levCap
      const maxTotalNotional = equity * cfg.levCap
      const room = Math.max(0, maxTotalNotional - openNotional)
      const cap = Math.min(maxPosNotional, room)
      if (notional > cap) {
        notional = cap
        riskAmt = notional * (t.riskDistPct / 100)
      }
      if (notional <= 0) { skippedRiskCap++; continue }
      const riskFrac = riskAmt / equity
      open.set(ev.i, { notional, riskFrac })
      openRiskFrac += riskFrac
      openNotional += notional
      levSamples.push(notional / equity) // имплицитное плечо позиции — для отчёта агента
      taken++
      takenNetRs.push(t.netR)
      if (t.status !== 'expired') {
        decidedTaken++
        if (t.status === 'tp') wins++
      }
    }
  }
  // незакрытые к концу истории позиции (busted-прерывание) — уже учтены не будут; при
  // нормальном завершении все exit-события отработаны, open пуст.

  const final = equity
  const spanMs = curve.length > 1 ? curve[curve.length - 1].ms - curve[0].ms : 0
  const years = spanMs / (365.25 * 864e5)
  const cagr = years > 0.05 && final > 0 ? Math.pow(final / cfg.start, 1 / years) - 1 : null

  // maxDD по кривой
  let peak = -Infinity
  let maxDD = 0
  for (const p of curve) {
    if (p.eq > peak) peak = p.eq
    const dd = peak > 0 ? (peak - p.eq) / peak : 0
    if (dd > maxDD) maxDD = dd
  }

  return {
    taken, skippedRiskCap, busted,
    final: +final.toFixed(2),
    mult: +(final / cfg.start).toFixed(3),
    logGrowth: final > 0 ? +Math.log(final / cfg.start).toFixed(4) : -Infinity,
    cagrPct: cagr != null ? +(cagr * 100).toFixed(1) : null,
    maxDDPct: +(maxDD * 100).toFixed(1),
    winRatePct: decidedTaken ? +((wins / decidedTaken) * 100).toFixed(1) : null,
    avgNetR: takenNetRs.length ? +(takenNetRs.reduce((a, b) => a + b, 0) / takenNetRs.length).toFixed(3) : null,
    spanDays: +(spanMs / 864e5).toFixed(0),
    leverage: levSamples.length ? (() => { const s = [...levSamples].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +s[s.length - 1].toFixed(2) } })() : null,
    curve,
  }
}

// ── календарные годовые доходности из кривой ──
export function yearlyReturns(curve) {
  if (curve.length < 2) return []
  const out = []
  const firstYear = new Date(curve[0].ms).getUTCFullYear()
  const lastYear = new Date(curve[curve.length - 1].ms).getUTCFullYear()
  const eqAt = (ms) => {
    let lo = 0, hi = curve.length - 1, idx = 0
    while (lo <= hi) { const m = (lo + hi) >> 1; if (curve[m].ms <= ms) { idx = m; lo = m + 1 } else hi = m - 1 }
    return curve[idx].eq
  }
  for (let y = firstYear; y <= lastYear; y++) {
    const a = Math.max(curve[0].ms, Date.UTC(y, 0, 1))
    const b = Math.min(curve[curve.length - 1].ms, Date.UTC(y + 1, 0, 1))
    if (b <= a) continue
    const ea = eqAt(a), eb = eqAt(b)
    if (ea > 0) out.push({ year: y, retPct: +((eb / ea - 1) * 100).toFixed(1), partial: a > Date.UTC(y, 0, 1) || b < Date.UTC(y + 1, 0, 1) })
  }
  return out
}

// ── block-bootstrap CI на итоговый множитель ──
// Ресэмплим последовательность пофакторных изменений эквити между exit-событиями
// (кривая пишется на каждом выходе) блоками по `block`, восстанавливаем Π(1+r).
// Приближение: игнорирует path-эффекты riskCap-скипов; для CI на порядок величины ок.
export function bootstrapMultCI(curve, block = 20, iters = 2000, seed = 1234567) {
  const rets = []
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1].eq, b = curve[i].eq
    if (a > 0) rets.push(b / a - 1)
  }
  if (rets.length < 10) return null
  // детерминированный LCG — воспроизводимость без Math.random
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  const n = rets.length
  const nBlocks = Math.max(1, Math.ceil(n / block))
  const mults = []
  for (let it = 0; it < iters; it++) {
    let logSum = 0
    let count = 0
    for (let bI = 0; bI < nBlocks && count < n; bI++) {
      const start = Math.floor(rnd() * n)
      for (let k = 0; k < block && count < n; k++, count++) {
        const r = rets[(start + k) % n]
        logSum += Math.log(Math.max(1e-9, 1 + r))
      }
    }
    mults.push(Math.exp(logSum))
  }
  mults.sort((a, b) => a - b)
  const q = (p) => mults[Math.min(mults.length - 1, Math.floor(p * mults.length))]
  return { block, iters, p5: +q(0.05).toFixed(3), p25: +q(0.25).toFixed(3), median: +q(0.5).toFixed(3), p75: +q(0.75).toFixed(3), p95: +q(0.95).toFixed(3) }
}

// ── роллинг-окна: распределение доходностей за 1д/30д/183д/365д ──
// Кривая — ступенчатая функция; сэмплируем ежедневно, окно скользит по дням.
export function rollingReturns(curve, windowDays) {
  if (curve.length < 2) return null
  const startMs = curve[0].ms
  const endMs = curve[curve.length - 1].ms
  const days = Math.floor((endMs - startMs) / 864e5)
  if (days < windowDays + 1) return null
  // ежедневные значения equity (степ-интерполяция)
  const daily = new Array(days + 1)
  let ci = 0
  for (let d = 0; d <= days; d++) {
    const ms = startMs + d * 864e5
    while (ci + 1 < curve.length && curve[ci + 1].ms <= ms) ci++
    daily[d] = curve[ci].eq
  }
  const rets = []
  for (let d = 0; d + windowDays <= days; d++) {
    const a = daily[d], b = daily[d + windowDays]
    if (a > 0) rets.push((b / a - 1) * 100)
  }
  if (!rets.length) return null
  rets.sort((x, y) => x - y)
  const q = (p) => {
    const pos = (rets.length - 1) * p
    const base = Math.floor(pos)
    const rest = pos - base
    return rets[base + 1] !== undefined ? rets[base] + rest * (rets[base + 1] - rets[base]) : rets[base]
  }
  return {
    windowDays,
    n: rets.length,
    p10: +q(0.10).toFixed(2),
    median: +q(0.5).toFixed(2),
    p90: +q(0.90).toFixed(2),
    worst: +rets[0].toFixed(2),
    best: +rets[rets.length - 1].toFixed(2),
    pctPositive: +((rets.filter((r) => r > 0).length / rets.length) * 100).toFixed(1),
  }
}

// ── предзарегистрированная матрица (--sweep) ──
// Наборы страт объявлены ДО прогона, из уже опубликованного per-stratum отчёта report.json
// (это prior knowledge, не подгонка): скальпы ~0, mid/long несут эдж, veryLong n=3 мусор.
const STRATA_SETS = {
  S1_all: null,
  S2_noVeryLong: new Set(['scalp:long', 'scalp:short', 'mid:long', 'mid:short', 'long:long']),
  S3_midLong: new Set(['mid:long', 'mid:short', 'long:long']),
  S4_midLongScalpShort: new Set(['mid:long', 'mid:short', 'long:long', 'scalp:short']),
  S5_midOnly: new Set(['mid:long', 'mid:short']),
}
const RISK_LEVELS = [0.005, 0.01, 0.02, 0.03, 0.05]

function baseCfg(overrides = {}) {
  return {
    start: START_EQUITY,
    risk: 0.02,
    riskCap: Number(flag('riskCap', 0.10)),
    levCap: Number(flag('levCap', 3)),
    fill: String(flag('fill', 'next-open')),
    fundingPerDay: Number(flag('fundingPerDay', 0.03)),
    strata: null,
    fromMs: null,
    toMs: null,
    ...overrides,
  }
}

async function main() {
  const raw = JSON.parse(await readFile(TRADES_PATH, 'utf8'))

  if (flag('sweep')) {
    const splitISO = String(flag('split', '2025-01-15'))
    const splitMs = new Date(splitISO).getTime()
    const rows = []
    for (const [setName, strata] of Object.entries(STRATA_SETS)) {
      for (const risk of RISK_LEVELS) {
        for (const regimeAlign of [false, true]) {
          if (regimeAlign && !['S3_midLong', 'S5_midOnly'].includes(setName)) continue // ось объявлена только для mid/long-наборов
        const train = simulate(raw, baseCfg({ strata, risk, toMs: splitMs, purgeSpan: true, regimeAlign }))
        const hold = simulate(raw, baseCfg({ strata, risk, fromMs: splitMs, regimeAlign }))
        rows.push({
          set: setName + (regimeAlign ? '+ra' : ''), risk,
          train: { mult: train.mult, cagrPct: train.cagrPct, maxDDPct: train.maxDDPct, taken: train.taken, logGrowth: train.logGrowth },
          holdout: { mult: hold.mult, cagrPct: hold.cagrPct, maxDDPct: hold.maxDDPct, taken: hold.taken, logGrowth: hold.logGrowth },
        })
        }
      }
    }
    rows.sort((a, b) => (b.train.logGrowth ?? -1e9) - (a.train.logGrowth ?? -1e9))
    if (flag('json')) {
      console.log(JSON.stringify({ split: splitISO, trades: TRADES_PATH, fill: flag('fill', 'next-open'), rows }, null, 1))
    } else {
      console.log(`sweep: ${TRADES_PATH}  split=${splitISO}  fill=${flag('fill', 'next-open')}  funding=${flag('fundingPerDay', 0.03)}%/day`)
      console.log('set                        risk   TRAIN mult  cagr%   dd%   n  | HOLDOUT mult  cagr%   dd%   n')
      for (const r of rows) {
        console.log(
          `${r.set.padEnd(26)} ${String(r.risk).padEnd(6)} ${String(r.train.mult).padStart(9)} ${String(r.train.cagrPct ?? '—').padStart(6)} ${String(r.train.maxDDPct).padStart(5)} ${String(r.train.taken).padStart(4)}  |  ${String(r.holdout.mult).padStart(9)} ${String(r.holdout.cagrPct ?? '—').padStart(6)} ${String(r.holdout.maxDDPct).padStart(5)} ${String(r.holdout.taken).padStart(4)}`,
        )
      }
    }
    return
  }

  if (flag('allin')) {
    const strataArg = flag('strata')
    const strata = strataArg ? new Set(String(strataArg).split(',')) : null
    const levs = String(flag('lev', '5,10,20,50')).split(',').map(Number)
    const out = levs.map((lev) => simulateAllIn(raw, {
      start: START_EQUITY, lev, strata,
      fill: String(flag('fill', 'next-open')),
      fundingPerDay: Number(flag('fundingPerDay', 0.03)),
      maintMarginPct: Number(flag('maint', 1.0)),
    }))
    console.log(JSON.stringify(out, null, 1))
    return
  }

  if (flag('run')) {
    const strataArg = flag('strata')
    const strata = strataArg ? new Set(String(strataArg).split(',')) : null
    const cfg = baseCfg({
      strata,
      risk: Number(flag('risk', 0.02)),
      regimeAlign: !!flag('regimeAlign', false),
      policy: flag('policy') ? JSON.parse(await readFile(String(flag('policy')), 'utf8')) : null,
      fromMs: flag('from') ? new Date(String(flag('from'))).getTime() : null,
      toMs: flag('to') ? new Date(String(flag('to'))).getTime() : null,
    })
    const res = simulate(raw, cfg)
    const windows = [1, 30, 183, 365].map((w) => rollingReturns(res.curve, w)).filter(Boolean)
    const out = {
      trades: TRADES_PATH,
      cfg: { ...cfg, strata: strata ? [...strata] : 'all' },
      result: { ...res, curve: undefined },
      yearly: yearlyReturns(res.curve),
      bootstrapMult: bootstrapMultCI(res.curve),
      rollingReturns: windows,
    }
    if (flag('curve')) await writeFile(String(flag('curve')), JSON.stringify(res.curve), 'utf8')
    console.log(JSON.stringify(out, null, 1))
    return
  }

  console.log('Usage: node scripts/bankroll.mjs --run|--sweep [options] (см. шапку файла)')
}

main().catch((err) => { console.error(err); process.exit(1) })
