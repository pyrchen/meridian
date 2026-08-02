// Контактный лист: несколько сделок на одной HTML-странице, каждая — свечной график
// с уровнями. Нужен для визуальной проверки решений SMC-слоя: SVG по одному инструмент
// чтения не показывает, а страницу можно открыть браузером и снять скриншотом.
//
//   node scripts/smc-contactsheet.mjs --trades=data/backtest/trades-smcbase.json \
//     --out=sheet.html [--n=12] [--filter=tp|sl] [--horizon=mid] [--sort=netR|-netR] [--before=60] [--after=40]
//
// Отбор детерминирован (сортировка + срез), без случайности — чтобы лист воспроизводился.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCandles, renderSvg } from './smc-chart.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const args = process.argv.slice(2)
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

function findIdx(candles, ms) {
  let i = candles.findIndex((c) => c.t >= ms)
  return i < 0 ? candles.length - 1 : i
}

async function main() {
  const tradesPath = resolve(ROOT, flag('trades', 'data/backtest/trades-smcbase.json'))
  if (!existsSync(tradesPath)) { console.error(`Нет ${tradesPath}`); process.exit(1) }
  let trades = JSON.parse(await readFile(tradesPath, 'utf8'))
  if (!Array.isArray(trades)) trades = trades.records || trades.trades || trades.signals || []

  const fStatus = flag('filter')
  const fHorizon = flag('horizon')
  if (fStatus) trades = trades.filter((t) => t.status === fStatus)
  if (fHorizon) trades = trades.filter((t) => t.horizon === fHorizon)

  const sortKey = flag('sort', '-netR')
  const desc = sortKey.startsWith('-')
  const key = desc ? sortKey.slice(1) : sortKey
  trades.sort((a, b) => (desc ? (b[key] ?? 0) - (a[key] ?? 0) : (a[key] ?? 0) - (b[key] ?? 0)))

  const n = num(flag('n'), 12)
  const before = num(flag('before'), 60)
  const after = num(flag('after'), 40)
  const picked = trades.slice(0, n)
  if (!picked.length) { console.error('После фильтров не осталось сделок'); process.exit(1) }

  const cache = new Map()
  const blocks = []
  for (const t of picked) {
    const ck = `${t.symbol}|${t.timeframe}`
    if (!cache.has(ck)) {
      try { cache.set(ck, await loadCandles(t.symbol, t.timeframe)) } catch { cache.set(ck, null) }
    }
    const all = cache.get(ck)
    if (!all) continue
    const iEntry = findIdx(all, new Date(t.createdAt).getTime())
    const from = Math.max(0, iEntry - before)
    const to = Math.min(all.length, iEntry + after)
    const win = all.slice(from, to)
    if (win.length < 10) continue
    const iExit = t.closedAt ? findIdx(win, new Date(t.closedAt).getTime()) : null

    let svg
    try {
      svg = renderSvg({
        candles: win, entryIdx: iEntry - from, entry: t.entry, sl: t.sl, tp: t.tp,
        side: t.side, exitIdx: iExit, title: `${t.symbol} ${t.timeframe} ${t.side}`,
      })
    } catch { continue }

    const cls = t.status === 'tp' ? 'tp' : t.status === 'sl' ? 'sl' : 'exp'
    const disp = t.disposition ? ` · ${t.disposition}` : ''
    const rr = t.netR != null ? `netR ${t.netR}` : ''
    const smc = t.smcNetR != null ? ` · smcNetR ${t.smcNetR}` : ''
    blocks.push(
      `<figure class="${cls}"><figcaption>` +
        `<b>${t.symbol}</b> ${t.timeframe} ${t.side} · ${t.horizon || ''} · ` +
        `<span class="st">${t.status || ''}</span> ${rr}${smc}${disp}<br>` +
        `<span class="dim">${t.createdAt} → ${t.closedAt || '—'} · entry ${t.entry} · SL ${t.sl} · TP ${t.tp}</span>` +
        `</figcaption>${svg}</figure>`,
    )
  }

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Контактный лист сделок</title><style>
body{margin:0;background:#0d1117;color:#e6edf3;font:13px/1.5 ui-monospace,Consolas,monospace}
h1{font-size:16px;padding:14px 18px;margin:0;border-bottom:1px solid #21262d}
.grid{display:flex;flex-direction:column;gap:18px;padding:18px}
figure{margin:0;border:1px solid #21262d;border-radius:8px;overflow:hidden;background:#0e1116}
figure.tp{border-left:3px solid #3fb950} figure.sl{border-left:3px solid #f85149}
figure.exp{border-left:3px solid #8b949e}
figcaption{padding:9px 13px;border-bottom:1px solid #21262d;font-size:12px}
.dim{color:#8b949e} .st{color:#d29922}
svg{display:block;width:100%;height:auto}
</style></head><body><h1>Сделок: ${blocks.length} · источник ${flag('trades', 'trades-smcbase.json')}${fStatus ? ` · фильтр ${fStatus}` : ''}${fHorizon ? ` · ${fHorizon}` : ''} · сортировка ${sortKey}</h1>
<div class="grid">${blocks.join('')}</div></body></html>`

  const out = resolve(ROOT, flag('out', 'sheet.html'))
  await writeFile(out, html, 'utf8')
  console.log(`Записано: ${out} — ${blocks.length} графиков`)
}

main().catch((e) => { console.error(e); process.exit(1) })
