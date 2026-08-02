// Рендер одной сделки в SVG-свечник: свечи вокруг входа, уровни entry/SL/TP, отметка выхода.
// Нужен для визуальной проверки решений SMC-слоя — цифры показывают, что слой сделал,
// но не показывают, осмысленно ли это выглядит на графике.
//
//   node scripts/smc-chart.mjs --symbol=SOLUSDT --tf=1h --at=2024-03-05T12:00:00Z \
//     --entry=142.5 --sl=139.2 --tp=150.8 --side=long --out=chart.svg [--before=60] [--after=40]
//
// Данные берутся из data/history/{SYMBOL}-{TF}.ndjson — того же кэша, на котором идёт реплей,
// поэтому нарисованное совпадает с тем, что видел движок.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HIST = resolve(__dirname, '..', 'data', 'history')

const args = process.argv.slice(2)
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}

const W = 1100
const H = 520
const PAD = { l: 12, r: 78, t: 34, b: 26 }

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])

export async function loadCandles(symbol, tf) {
  const p = resolve(HIST, `${symbol}-${tf}.ndjson`)
  if (!existsSync(p)) throw new Error(`нет истории: ${p}`)
  const out = []
  for (const line of (await readFile(p, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* битая строка — пропускаем */ }
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

export function renderSvg({ candles, entryIdx, entry, sl, tp, side, title, exitIdx, zones = [] }) {
  const n = candles.length
  if (!n) throw new Error('пустое окно свечей')
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b

  // Шкала цены включает и уровни сделки — иначе стоп/тейк уедут за край картинки.
  const prices = [...candles.map((c) => c.h), ...candles.map((c) => c.l), entry, sl, tp].filter(Number.isFinite)
  let lo = Math.min(...prices)
  let hi = Math.max(...prices)
  const padP = (hi - lo) * 0.06 || hi * 0.01
  lo -= padP; hi += padP
  const y = (p) => PAD.t + ih - ((p - lo) / (hi - lo)) * ih
  const cw = iw / n
  const x = (i) => PAD.l + i * cw + cw / 2

  const parts = []
  parts.push(`<rect width="${W}" height="${H}" fill="#0e1116"/>`)
  parts.push(`<text x="${PAD.l}" y="20" fill="#e6edf3" font-family="ui-monospace,monospace" font-size="13">${esc(title)}</text>`)

  // Горизонтальная сетка
  for (let k = 0; k <= 4; k++) {
    const p = lo + ((hi - lo) * k) / 4
    parts.push(`<line x1="${PAD.l}" y1="${y(p).toFixed(1)}" x2="${W - PAD.r}" y2="${y(p).toFixed(1)}" stroke="#1e2530" stroke-width="1"/>`)
    parts.push(`<text x="${W - PAD.r + 6}" y="${(y(p) + 4).toFixed(1)}" fill="#6e7781" font-family="ui-monospace,monospace" font-size="10">${p.toPrecision(6)}</text>`)
  }

  // SMC-зоны (ордер-блок, имбаланс) — прямоугольники под свечами
  for (const z of zones) {
    const yTop = y(Math.max(z.top, z.bottom))
    const yBot = y(Math.min(z.top, z.bottom))
    const x0 = x(Math.max(0, z.from ?? 0)) - cw / 2
    const x1 = x(Math.min(n - 1, z.to ?? n - 1)) + cw / 2
    parts.push(`<rect x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${Math.max(1, yBot - yTop).toFixed(1)}" fill="${z.color || '#3b82f6'}" opacity="0.16"/>`)
    if (z.label) parts.push(`<text x="${(x0 + 4).toFixed(1)}" y="${(yTop - 3).toFixed(1)}" fill="${z.color || '#3b82f6'}" font-family="ui-monospace,monospace" font-size="9">${esc(z.label)}</text>`)
  }

  // Свечи
  candles.forEach((c, i) => {
    const up = c.c >= c.o
    const col = up ? '#26a69a' : '#ef5350'
    const cx = x(i)
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(c.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`)
    const yo = y(c.o), yc = y(c.c)
    const bw = Math.max(1, cw * 0.62)
    parts.push(`<rect x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}" fill="${col}"/>`)
  })

  // Уровни сделки
  const lvl = (p, col, label, dash) =>
    `<line x1="${PAD.l}" y1="${y(p).toFixed(1)}" x2="${W - PAD.r}" y2="${y(p).toFixed(1)}" stroke="${col}" stroke-width="1.2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` +
    `<text x="${W - PAD.r + 6}" y="${(y(p) - 3).toFixed(1)}" fill="${col}" font-family="ui-monospace,monospace" font-size="10">${label}</text>`
  parts.push(lvl(entry, '#e6edf3', 'entry', '4 3'))
  parts.push(lvl(sl, '#ef5350', 'SL', null))
  parts.push(lvl(tp, '#26a69a', 'TP', null))

  // Вертикали входа и выхода
  if (entryIdx != null && entryIdx >= 0 && entryIdx < n) {
    parts.push(`<line x1="${x(entryIdx).toFixed(1)}" y1="${PAD.t}" x2="${x(entryIdx).toFixed(1)}" y2="${H - PAD.b}" stroke="#f0b429" stroke-width="1" stroke-dasharray="3 3"/>`)
    parts.push(`<text x="${(x(entryIdx) + 4).toFixed(1)}" y="${PAD.t + 11}" fill="#f0b429" font-family="ui-monospace,monospace" font-size="10">вход (${esc(side)})</text>`)
  }
  if (exitIdx != null && exitIdx >= 0 && exitIdx < n) {
    parts.push(`<line x1="${x(exitIdx).toFixed(1)}" y1="${PAD.t}" x2="${x(exitIdx).toFixed(1)}" y2="${H - PAD.b}" stroke="#8b949e" stroke-width="1" stroke-dasharray="2 4"/>`)
    parts.push(`<text x="${(x(exitIdx) + 4).toFixed(1)}" y="${PAD.t + 24}" fill="#8b949e" font-family="ui-monospace,monospace" font-size="10">выход</text>`)
  }

  const first = new Date(candles[0].t).toISOString().slice(0, 16).replace('T', ' ')
  const last = new Date(candles[n - 1].t).toISOString().slice(0, 16).replace('T', ' ')
  parts.push(`<text x="${PAD.l}" y="${H - 8}" fill="#6e7781" font-family="ui-monospace,monospace" font-size="10">${first} … ${last} · ${n} свечей</text>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

async function main() {
  const symbol = flag('symbol')
  const tf = flag('tf', '1h')
  const at = flag('at')
  if (!symbol || !at) {
    console.log('Usage: node scripts/smc-chart.mjs --symbol=SOLUSDT --tf=1h --at=<ISO> --entry=.. --sl=.. --tp=.. --side=long --out=chart.svg')
    process.exit(1)
  }
  const before = Number(flag('before', 60))
  const after = Number(flag('after', 40))
  const all = await loadCandles(symbol, tf)
  const atMs = new Date(at).getTime()

  let idx = all.findIndex((c) => c.t >= atMs)
  if (idx < 0) idx = all.length - 1
  const from = Math.max(0, idx - before)
  const to = Math.min(all.length, idx + after)
  const win = all.slice(from, to)

  const svg = renderSvg({
    candles: win,
    entryIdx: idx - from,
    entry: Number(flag('entry')),
    sl: Number(flag('sl')),
    tp: Number(flag('tp')),
    side: flag('side', 'long'),
    exitIdx: flag('exitAt') ? all.slice(from, to).findIndex((c) => c.t >= new Date(flag('exitAt')).getTime()) : null,
    title: `${symbol} ${tf} · ${flag('side', 'long')} · ${at}`,
  })
  const out = flag('out', 'chart.svg')
  await writeFile(out, svg, 'utf8')
  console.log(`Записано: ${out} (${win.length} свечей)`)
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isEntry) main().catch((e) => { console.error(e.message); process.exit(1) })
