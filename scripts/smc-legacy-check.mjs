// Проверка: имели ли «дисплейные» SMC-функции v3-focus предсказательную силу?
//
// В gen-signals.mjs есть findOrderBlock / findFVG / liquiditySweep. Phase 1 сняла их со скора
// с формулировкой «на данных не дискриминировали победителей», но при этом объяснила плохой
// результат как mixed-engine confound — то есть вопрос остался открытым, а функции остались
// висеть в reasons. Здесь он закрывается: пересчитываем их флаги AS-OF момента сигнала на
// чистой книге v3-focus (trades-smcbase.json) и смотрим netR в разрезе каждого флага.
//
// Это одновременно калибровка ожиданий для нового слоя: если примитивная версия SMC даёт
// ноль, а новая — заметный плюс, разница обязана объясняться качеством реализации, а не
// магией самой аббревиатуры.
//
//   node scripts/smc-legacy-check.mjs [--tag=smcbase]

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KLINE_LIMITS } from './gen-signals.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HIST = resolve(__dirname, '..', 'data', 'history')
const BT = resolve(__dirname, '..', 'data', 'backtest')

const args = process.argv.slice(2)
const TAG = (args.find((a) => a.startsWith('--tag=')) || '--tag=smcbase').slice(6)

// ── Копии дисплейных функций из gen-signals.mjs (строки ~346-396) ──
// Копии, а не импорт: они там не экспортируются, а править живой движок ради замера нельзя.
// Логика скопирована дословно; любое расхождение сделало бы замер бессмысленным.
function findOrderBlock(candles, side, lookback = 50) {
  const f = candles.slice(-lookback)
  if (f.length < 15) return null
  const last = f[f.length - 1]
  for (let i = f.length - 4; i >= 5; i--) {
    const c = f[i]
    const n1 = f[i + 1], n2 = f[i + 2], n3 = f[i + 3]
    if (!n1 || !n2 || !n3) continue
    if (side === 'long' && c.c < c.o) {
      if ((n1.c + n2.c + n3.c) / 3 > c.h * 1.005 && last.c >= c.l && last.c <= c.h * 1.02) return { high: c.h, low: c.l }
    } else if (side === 'short' && c.c > c.o) {
      if ((n1.c + n2.c + n3.c) / 3 < c.l * 0.995 && last.c >= c.l * 0.98 && last.c <= c.h) return { high: c.h, low: c.l }
    }
  }
  return null
}

function findFVG(candles, side) {
  const f = candles.slice(-30)
  if (f.length < 5) return null
  const last = f[f.length - 1]
  for (let i = f.length - 2; i >= 2; i--) {
    if (side === 'long') {
      if (f[i].l - f[i - 2].h > 0 && last.c >= f[i - 2].h && last.c <= f[i].l) return { mid: (f[i - 2].h + f[i].l) / 2 }
    } else {
      if (f[i - 2].l - f[i].h > 0 && last.c <= f[i - 2].l && last.c >= f[i].h) return { mid: (f[i - 2].l + f[i].h) / 2 }
    }
  }
  return null
}

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

async function loadCandles(symbol, tf) {
  const p = resolve(HIST, `${symbol}-${tf}.ndjson`)
  if (!existsSync(p)) return null
  const out = []
  for (const line of (await readFile(p, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* битая строка */ }
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

function windowEndingAt(sorted, limit, ct) {
  let lo = 0, hi = sorted.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].ct <= ct) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (idx < 0) return []
  return sorted.slice(Math.max(0, idx - limit + 1), idx + 1)
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const f3 = (n) => +n.toFixed(3)

function report(name, withF, without) {
  const wr = (a) => (a.length ? (a.filter((t) => t.status === 'tp').length / a.length) * 100 : 0)
  const d = mean(withF.map((t) => t.netR)) - mean(without.map((t) => t.netR))
  console.log(
    `${name.padEnd(18)} есть: n=${String(withF.length).padStart(4)} WR=${wr(withF).toFixed(1)}% avgNetR=${String(f3(mean(withF.map((t) => t.netR)))).padStart(7)}  |  ` +
      `нет: n=${String(without.length).padStart(4)} WR=${wr(without).toFixed(1)}% avgNetR=${String(f3(mean(without.map((t) => t.netR)))).padStart(7)}  |  ` +
      `разница ${d >= 0 ? '+' : ''}${f3(d)}`,
  )
}

async function main() {
  const path = resolve(BT, `trades-${TAG}.json`)
  if (!existsSync(path)) { console.error(`Нет ${path}`); process.exit(1) }
  const trades = JSON.parse(await readFile(path, 'utf8')).filter((t) => t.status !== 'expired')
  console.log(`Решённых сделок: ${trades.length} (тег ${TAG})\n`)

  const cache = new Map()
  const flagged = []
  for (const t of trades) {
    const key = `${t.symbol}|${t.timeframe}`
    if (!cache.has(key)) cache.set(key, await loadCandles(t.symbol, t.timeframe))
    const all = cache.get(key)
    if (!all) continue
    const T = new Date(t.createdAt).getTime()
    const win = windowEndingAt(all, KLINE_LIMITS[t.timeframe] || 330, T)
    if (win.length < 60) continue
    flagged.push({
      ...t,
      ob: !!findOrderBlock(win, t.side),
      fvg: !!findFVG(win, t.side),
      sweep: liquiditySweep(win, t.side),
    })
  }
  console.log(`Пересчитано флагов на: ${flagged.length} сделок\n`)

  console.log('=== Разрез по каждому дисплейному флагу ===')
  for (const f of ['ob', 'fvg', 'sweep']) {
    report(f, flagged.filter((t) => t[f]), flagged.filter((t) => !t[f]))
  }

  console.log('\n=== Разрез по числу совпавших флагов ===')
  for (let k = 0; k <= 3; k++) {
    const a = flagged.filter((t) => (t.ob ? 1 : 0) + (t.fvg ? 1 : 0) + (t.sweep ? 1 : 0) === k)
    if (!a.length) continue
    const wr = (a.filter((t) => t.status === 'tp').length / a.length) * 100
    console.log(`флагов ${k}: n=${String(a.length).padStart(4)} WR=${wr.toFixed(1)}% avgNetR=${f3(mean(a.map((t) => t.netR)))}`)
  }

  console.log('\n=== То же по стратам ===')
  const strata = {}
  for (const t of flagged) (strata[`${t.horizon}:${t.side}`] ||= []).push(t)
  for (const [k, arr] of Object.entries(strata)) {
    console.log(`\n${k} (n=${arr.length})`)
    for (const f of ['ob', 'fvg', 'sweep']) report('  ' + f, arr.filter((t) => t[f]), arr.filter((t) => !t[f]))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
