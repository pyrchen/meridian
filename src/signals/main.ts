/* ─────────────────────────────────────────────────────────────────────────
   Meridian · экран «Сигналы» — рабочая станция в одном окне.

   Каркас: слева поток (открытые / закрытая книга), в центре — ценовой график
   ВЫБРАННОЙ сделки с её уровнями, снизу — аналитика книги во вкладках,
   справа — карточка выбранного. Страница не скроллится: скроллятся списки.

   Доменные правила (не менять без причины):
   · любая цифра прибыли — нетто (netR / netPnlPct), брутто только рядом и мельче;
   · любая средняя — с размером выборки и 95%-интервалом;
   · срезы ниже sampleGate помечены как неизмеримые, но не спрятаны;
   · книги движков не смешиваются; сигналы без поля engine не показываются вовсе.
   ───────────────────────────────────────────────────────────────────────── */

import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/signals.css'
import { registerSW } from 'virtual:pwa-register'
import { setupGate } from '../lib/gate'
import { el, timeAgo } from '../lib/util'

registerSW({ immediate: true })

const BASE = import.meta.env.BASE_URL
const NS = 'http://www.w3.org/2000/svg'
const HOUR = 3_600_000
const DAY = 86_400_000
const $ = (id: string) => document.getElementById(id) as HTMLElement

/* ── типы данных (public/data/signals.json) ───────────────────────────── */

interface Signal {
  id: string
  symbol: string
  base: string
  side: 'long' | 'short'
  markets?: string[]
  entry: number
  sl: number
  tp: number
  tp2?: number
  atr?: number
  riskPct: number
  targetPct: number
  rr?: number
  strength: number
  etaHours: number
  posSizePct?: number
  riskBudgetPct?: number
  horizon?: 'scalp' | 'mid' | 'long' | 'veryLong'
  reasons: string[]
  indicators: {
    rsi: number
    adx: number
    macdHist: number
    plusDI?: number
    minusDI?: number
    volPct?: number | null
  }
  news?: { title: string; source: string; url: string; publishedAt: string }[] | null
  newsSentiment?: 'pos' | 'neg' | 'neutral' | null
  newsCount?: number
  spark?: number[]
  scoreBreakdown?: { trend: number; regime: number; rs: number; base: number; total: number }
  cohortWeek?: string
  engine?: string
  timeframe: string
  createdAt: string
  status: 'open' | 'tp' | 'sl' | 'expired'
  exitPrice?: number
  closedAt?: string
  durationH?: number
  pnlPct?: number
  r?: number
  netPnlPct?: number
  netR?: number
  costPct?: number
  toTpPct?: number | null
  maeR?: number | null
  entryBtcRegime?: 'up' | 'down' | 'flat'
}

interface SignalsData {
  generatedAt: string
  universeSize: number
  stats: { sampleGate?: number; avgEtaOpenH: number }
  open: Signal[]
  closed: Signal[]
}

type Panel = 'book' | 'strata' | 'dist' | 'weeks'
type Status = 'open' | 'closed' | 'tp' | 'sl'

interface Kline {
  t: number
  o: number
  h: number
  l: number
  c: number
}

const ENGINE_V3 = 'v3-focus'
const ENGINE_V2 = 'v2-harness'
const GATE_FALLBACK = 50

const state = {
  data: null as SignalsData | null,
  status: 'open' as Status,
  horizon: 'all' as 'all' | 'scalp' | 'mid',
  side: 'all' as 'all' | 'long' | 'short',
  period: 'all' as 'all' | 'week' | 'month' | 'quarter',
  engine: 'v3' as 'all' | 'v3' | 'v2',
  panel: 'book' as Panel,
  unit: 'R' as 'R' | '$',
  riskUsd: 25,
  selOpen: null as string | null,
  selClosed: null as string | null,
  prices: new Map<string, number>(),
  klines: new Map<string, Kline[] | null>(),
  hover: null as number | null,
}

/* ── утилиты ──────────────────────────────────────────────────────────── */

const isModern = (s: Signal) => s.engine === ENGINE_V3 || s.engine === ENGINE_V2
// Бакет для ФИЛЬТРА горизонта: v3-focus торгует только скальп (1ч) и средне (4ч),
// поэтому фильтр в шапке — двухпозиционный. Легаси-книга v2-harness несёт ещё
// long/veryLong (1д/1н) — при фильтре «средне» они тоже попадают в срез.
const hz = (s: Signal): 'scalp' | 'mid' => (s.horizon === 'scalp' ? 'scalp' : 'mid')
// Реальный горизонт — для меток и разбивки по стратам. Схлопывать long/veryLong в
// «средне» здесь нельзя: это смешает 4-часовые сделки с суточными/недельными в одной
// средней и соврёт про размер эджа (см. domain-правило вверху файла).
const HZ_LABEL: Record<string, string> = { scalp: 'скальп', mid: 'средне', long: 'долго', veryLong: 'сверхдолго' }
const hzKey = (s: Signal): string => s.horizon ?? 'mid'
const hzLabel = (s: Signal): string => HZ_LABEL[hzKey(s)] ?? 'средне'
// Часы в свече по интервалу Binance — используется для оффсета окна и запасной
// реконструкции графика из spark[]. Без этой таблицы легаси-сделки на 1д/1н коротали
// с шагом в 1ч, и график расходился с реальным таймфреймом сделки.
const INTERVAL_HOURS: Record<string, number> = {
  '1h': 1, '2h': 2, '4h': 4, '6h': 6, '8h': 8, '12h': 12, '1d': 24, '3d': 72, '1w': 168,
}
const ms = (iso: string) => new Date(iso).getTime()
const decided = (s: Signal) => s.status === 'tp' || s.status === 'sl'
const netOf = (s: Signal) => s.netR ?? s.r ?? 0

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 10) return n.toFixed(2)
  if (n >= 1) return n.toFixed(3)
  if (n >= 0.01) return n.toFixed(4)
  return n.toPrecision(3)
}
function sgn(v: number, d = 2): string {
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d)
}
function fmtDur(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '—'
  if (h < 1) return '<1 ч'
  if (h < 48) return `${Math.round(h)} ч`
  return `${Math.round(h / 24)} дн`
}
function fmtDay(t: number): string {
  const d = new Date(t)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
}
function fmtDT(t: number): string {
  const d = new Date(t)
  return `${fmtDay(t)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e
}
function gate(): number {
  return state.data?.stats.sampleGate ?? GATE_FALLBACK
}
function unitK(): number {
  return state.unit === 'R' ? 1 : state.riskUsd
}
function unitSuffix(): string {
  return state.unit === 'R' ? 'R' : '$'
}

/* ── срез ─────────────────────────────────────────────────────────────── */

function engMatch(s: Signal): boolean {
  if (state.engine === 'v3') return s.engine === ENGINE_V3
  if (state.engine === 'v2') return s.engine === ENGINE_V2
  return true
}
function periodMatch(s: Signal): boolean {
  if (state.period === 'all') return true
  const age = (Date.now() - ms(s.createdAt)) / DAY
  return age <= (state.period === 'week' ? 7 : state.period === 'month' ? 30 : 90)
}
function sliceMatch(s: Signal): boolean {
  return (
    engMatch(s) &&
    periodMatch(s) &&
    (state.horizon === 'all' || hz(s) === state.horizon) &&
    (state.side === 'all' || s.side === state.side)
  )
}
function closedSlice(): Signal[] {
  return (state.data?.closed ?? []).filter(sliceMatch)
}
function openSlice(): Signal[] {
  return (state.data?.open ?? [])
    .filter(sliceMatch)
    .sort((a, b) => b.strength - a.strength)
}

/* ── статистика среза ─────────────────────────────────────────────────── */

interface Stats {
  n: number
  mean: number
  ci: number
  grossMean: number
  wrNet: number
  wrGross: number
  cum: number
  maxDD: number
  curve: { t: number; cum: number; peak: number }[]
}

function statsOf(closed: Signal[]): Stats {
  const dec = closed.filter(decided)
  const n = dec.length
  const mean = n ? dec.reduce((a, s) => a + netOf(s), 0) / n : 0
  const sd =
    n > 1 ? Math.sqrt(dec.reduce((a, s) => a + (netOf(s) - mean) ** 2, 0) / (n - 1)) : 0
  const ci = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0
  const grossMean = n ? dec.reduce((a, s) => a + (s.r ?? 0), 0) / n : 0
  const wins = dec.filter((s) => s.status === 'tp').length
  const netWins = dec.filter((s) => netOf(s) > 0).length

  const sorted = closed
    .filter((s) => s.closedAt)
    .slice()
    .sort((a, b) => ms(a.closedAt!) - ms(b.closedAt!))
  let cum = 0
  let peak = 0
  let maxDD = 0
  const curve = sorted.map((s) => {
    cum += netOf(s)
    peak = Math.max(peak, cum)
    maxDD = Math.min(maxDD, cum - peak)
    return { t: ms(s.closedAt!), cum, peak }
  })

  return {
    n,
    mean,
    ci,
    grossMean,
    wrNet: n ? Math.round((netWins / n) * 100) : 0,
    wrGross: n ? Math.round((wins / n) * 100) : 0,
    cum,
    maxDD,
    curve,
  }
}

/* ── выбранная сделка ─────────────────────────────────────────────────── */

interface Sel {
  sig: Signal
  isOpen: boolean
  last: number
  best: number
  worst: number
  mfeR: number
  maeR: number
  fromMs: number
  toMs: number
}

function currentSel(): Sel | null {
  if (state.status === 'open') {
    const list = openSlice()
    const s = list.find((x) => x.id === state.selOpen) ?? list[0]
    if (!s) return null
    const risk = Math.abs(s.entry - s.sl) || 1
    const last = state.prices.get(s.symbol) ?? s.spark?.[s.spark.length - 1] ?? s.entry
    const kl = state.klines.get(klKey(s)) ?? null
    let best = last
    let worst = last
    if (kl && kl.length) {
      const after = kl.filter((k) => k.t >= ms(s.createdAt))
      const src = after.length ? after : kl
      const hi = Math.max(...src.map((k) => k.h))
      const lo = Math.min(...src.map((k) => k.l))
      best = s.side === 'long' ? hi : lo
      worst = s.side === 'long' ? lo : hi
    }
    const dir = s.side === 'long' ? 1 : -1
    return {
      sig: s,
      isOpen: true,
      last,
      best,
      worst,
      mfeR: (dir * (best - s.entry)) / risk,
      maeR: (dir * (worst - s.entry)) / risk,
      fromMs: ms(s.createdAt),
      toMs: Date.now(),
    }
  }
  const list = closedList()
  const s = list.find((x) => x.id === state.selClosed) ?? list[0]
  if (!s) return null
  const risk = Math.abs(s.entry - s.sl) || 1
  const dir = s.side === 'long' ? 1 : -1
  const toTp = (s.toTpPct ?? 0) / 100
  const best = s.entry + (s.tp - s.entry) * toTp
  const maeR = s.maeR ?? 0
  const worst = s.entry + dir * maeR * risk
  return {
    sig: s,
    isOpen: false,
    last: s.exitPrice ?? s.entry,
    best,
    worst,
    mfeR: toTp * 2.5,
    maeR,
    fromMs: ms(s.createdAt),
    toMs: s.closedAt ? ms(s.closedAt) : Date.now(),
  }
}

function closedList(): Signal[] {
  let list = closedSlice()
  if (state.status === 'tp') list = list.filter((s) => s.status === 'tp')
  if (state.status === 'sl') list = list.filter((s) => s.status === 'sl')
  return list
    .slice()
    .sort((a, b) => ms(b.closedAt ?? b.createdAt) - ms(a.closedAt ?? a.createdAt))
    .slice(0, 200)
}

/* ── свечи с биржи ────────────────────────────────────────────────────── */
// Свечей нет в signals.json (там только spark[44] — закрытия). Тянем реальные
// klines с публичного эндпоинта Binance, тем же источником, что и цены.
// Офлайн/отказ → рисуем линию закрытий из spark и честно это подписываем.

function klKey(s: Signal): string {
  return `${s.symbol}|${s.timeframe}|${s.closedAt ?? 'open'}`
}

async function fetchKlines(s: Signal): Promise<void> {
  const key = klKey(s)
  if (state.klines.has(key)) return
  state.klines.set(key, null)
  // Берём реальный таймфрейм сделки: у легаси-книги (v2-harness) это может быть
  // 1д/1н, не только 1ч/4ч. Раньше здесь была двоичная развилка 1h/4h, которая
  // тянула для суточных/недельных сделок 4-часовые свечи — график не совпадал
  // с тем таймфреймом, на котором сделка была принята.
  const interval = s.timeframe || (hz(s) === 'scalp' ? '1h' : '4h')
  const stepH = INTERVAL_HOURS[interval] ?? 4
  const limit = 120
  const endMs = s.closedAt ? ms(s.closedAt) + 14 * stepH * HOUR : Date.now()
  const url =
    `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(s.symbol)}` +
    `&interval=${interval}&limit=${limit}&endTime=${Math.min(endMs, Date.now())}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(String(res.status))
    const raw = (await res.json()) as unknown[][]
    const bars: Kline[] = raw.map((k) => ({
      t: Number(k[0]),
      o: parseFloat(String(k[1])),
      h: parseFloat(String(k[2])),
      l: parseFloat(String(k[3])),
      c: parseFloat(String(k[4])),
    }))
    state.klines.set(key, bars)
  } catch {
    state.klines.set(key, [])
  }
  renderChart()
  renderDetail()
}

async function fetchPrices(): Promise<void> {
  const d = state.data
  if (!d || !d.open.length) return
  const symbols = [...new Set(d.open.map((s) => s.symbol))]
  try {
    const q = encodeURIComponent(JSON.stringify(symbols))
    const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${q}`, {
      cache: 'no-store',
    })
    if (!res.ok) return
    const rows = (await res.json()) as { symbol: string; price: string }[]
    for (const r of rows) state.prices.set(r.symbol, parseFloat(r.price))
    renderList()
    renderChart()
    renderDetail()
  } catch {
    /* офлайн — остаёмся на spark */
  }
}

/* ── управление ───────────────────────────────────────────────────────── */

function segButtons(
  host: HTMLElement,
  items: { key: string; label: string; n?: number }[],
  active: string,
  pick: (k: string) => void,
  kind: 'tab' | 'chip',
) {
  host.replaceChildren()
  for (const it of items) {
    const b = el('button', kind === 'tab' ? { 'aria-selected': String(active === it.key), role: 'tab' } : { 'aria-pressed': String(active === it.key) }, it.label)
    if (it.n != null) b.append(el('b', {}, String(it.n)))
    b.onclick = () => pick(it.key)
    host.append(b)
  }
}

function renderControls() {
  const closed = closedSlice()
  const open = openSlice()

  segButtons(
    $('status'),
    [
      { key: 'open', label: 'Открытые', n: open.length },
      { key: 'closed', label: 'Закрытые', n: closed.length },
      { key: 'tp', label: '▲ Тейк', n: closed.filter((s) => s.status === 'tp').length },
      { key: 'sl', label: '▼ Стоп', n: closed.filter((s) => s.status === 'sl').length },
    ],
    state.status,
    (k) => {
      state.status = k as Status
      state.hover = null
      renderAll()
    },
    'tab',
  )

  const group = (
    host: HTMLElement,
    label: string,
    items: [string, string][],
    active: string,
    pick: (k: string) => void,
  ) => {
    host.replaceChildren(el('span', {}, label))
    const box = el('div', { style: 'display:flex;gap:2px' })
    for (const [key, text] of items) {
      const b = el('button', { 'aria-pressed': String(active === key) }, text)
      b.onclick = () => pick(key)
      box.append(b)
    }
    host.append(box)
  }

  group($('f-horizon'), 'горизонт', [['all', 'все'], ['scalp', 'скальп'], ['mid', 'средне']], state.horizon, (k) => {
    state.horizon = k as typeof state.horizon
    renderAll()
  })
  group($('f-side'), 'сторона', [['all', 'все'], ['long', '▲ лонг'], ['short', '▼ шорт']], state.side, (k) => {
    state.side = k as typeof state.side
    renderAll()
  })
  group(
    $('f-period'),
    'период',
    [['all', 'всё'], ['week', 'нед'], ['month', 'мес'], ['quarter', '90д']],
    state.period,
    (k) => {
      state.period = k as typeof state.period
      renderAll()
    },
  )
  group(
    $('f-engine'),
    'движок',
    [['v3', ENGINE_V3], ['v2', ENGINE_V2], ['all', 'обе книги']],
    state.engine,
    (k) => {
      state.engine = k as typeof state.engine
      renderAll()
    },
  )

  segButtons(
    $('panel-tabs'),
    [
      { key: 'book', label: 'Книга' },
      { key: 'strata', label: 'Страты' },
      { key: 'dist', label: 'Распред.' },
      { key: 'weeks', label: 'Недели' },
    ],
    state.panel,
    (k) => {
      state.panel = k as Panel
      renderPanel()
      renderControls()
    },
    'tab',
  )

  const unit = $('unit')
  unit.replaceChildren()
  for (const u of ['R', '$'] as const) {
    const b = el('button', { 'aria-pressed': String(state.unit === u) }, u)
    b.onclick = () => {
      state.unit = u
      renderAll()
    }
    unit.append(b)
  }

  $('slice').textContent = `в срезе: ${closed.length} закрытых · ${open.length} открытых · порог выборки ${gate()}`
}

/* ── список ───────────────────────────────────────────────────────────── */

function pathBar(s: Signal, last: number): HTMLElement {
  const long = s.side === 'long'
  const span = Math.abs(s.tp - s.sl) || 1
  const at = (p: number) => Math.max(0, Math.min(1, (long ? p - s.sl : s.sl - p) / span)) * 100
  const e = at(s.entry)
  const now = at(last)
  const box = el('div', { class: 'path' })
  box.append(el('div', { class: 'path__axis' }))
  const zone = el('div', { class: 'path__zone' })
  zone.style.left = `${Math.min(e, now)}%`
  zone.style.width = `${Math.abs(now - e)}%`
  zone.style.background = now >= e ? 'var(--up)' : 'var(--down)'
  box.append(zone, el('div', { class: 'path__sl' }), el('div', { class: 'path__tp' }))
  const entry = el('div', { class: 'path__entry' })
  entry.style.left = `${e}%`
  const dot = el('div', { class: 'path__now' })
  dot.style.left = `${now}%`
  box.append(entry, dot)
  return box
}

function renderList() {
  const host = $('list')
  host.replaceChildren()

  if (state.status === 'open') {
    $('list-title').textContent = 'Открытые сигналы'
    const items = openSlice()
    $('list-count').textContent = String(items.length)
    if (!items.length) {
      host.append(
        el(
          'div',
          { class: 'empty' },
          'Открытых сигналов в этом срезе нет. Гейты v3-focus жёсткие — паузы в неделю-две нормальны.',
        ),
      )
      return
    }
    const sel = currentSel()
    for (const s of items) {
      const last = state.prices.get(s.symbol) ?? s.spark?.[s.spark.length - 1] ?? s.entry
      const long = s.side === 'long'
      const move = ((last - s.entry) / s.entry) * 100 * (long ? 1 : -1)
      const leftH = Math.max(0, s.etaHours - (Date.now() - ms(s.createdAt)) / HOUR)
      const b = el('button', {
        class: 'row',
        'aria-current': String(sel?.sig.id === s.id),
      })
      const top = el('div', { class: 'row__top' })
      top.append(
        el('b', { class: 'row__base' }, s.base),
        el('span', { class: `row__side ${long ? 'up' : 'down'}` }, long ? '▲ЛОНГ' : '▼ШОРТ'),
        el('span', { class: 'row__hz' }, `${hzLabel(s)} · ${s.timeframe}`),
        el('span', { class: 'row__score' }, String(s.strength)),
      )
      const foot = el('div', { class: 'row__foot' })
      foot.append(
        el('span', { class: move >= 0 ? 'up' : 'down' }, `${move >= 0 ? '▲ +' : '▼ −'}${Math.abs(move).toFixed(2)}%`),
        el('span', {}, `${fmtDur(leftH)} осталось`),
      )
      b.append(top, pathBar(s, last), foot)
      b.onclick = () => selectOpen(s)
      host.append(b)
    }
    return
  }

  $('list-title').textContent = 'Закрытая книга'
  const items = closedList()
  $('list-count').textContent = `${items.length} / ${closedSlice().length}`
  if (!items.length) {
    host.append(el('div', { class: 'empty' }, 'В этом срезе закрытых сделок нет.'))
    return
  }
  const sel = currentSel()
  for (const s of items) {
    const net = netOf(s)
    const w = Math.min(50, (Math.abs(net) / 2.6) * 50)
    const b = el('button', { class: 'crow', 'aria-current': String(sel?.sig.id === s.id) })
    const left = el('div', {})
    left.append(
      el('b', {}, s.base),
      el('div', { class: 'crow__sub' }, `${s.side === 'long' ? '▲' : '▼'} ${hzLabel(s)}`),
    )
    const mid = el('div', {})
    const bar = el('div', { class: 'crow__bar' })
    const fill = el('i', {})
    fill.style.left = `${net >= 0 ? 50 : 50 - w}%`
    fill.style.width = `${w}%`
    fill.style.background = net >= 0 ? 'var(--up)' : 'var(--down)'
    bar.append(fill)
    const label =
      `${fmtDay(ms(s.closedAt ?? s.createdAt))} · ${fmtDur(s.durationH ?? 0)} · ` +
      `${s.status === 'tp' ? 'TP' : s.status === 'sl' ? 'SL' : 'exp'}` +
      (s.status !== 'tp' && s.toTpPct != null ? ` · →${s.toTpPct}%` : '')
    mid.append(bar, el('div', { class: 'crow__meta' }, label))
    const right = el('div', {})
    const r = el('div', { class: `crow__r ${net >= 0 ? 'up' : 'down'}` }, sgn(net * unitK(), state.unit === 'R' ? 2 : 1) + unitSuffix())
    right.append(r, el('div', { class: 'crow__gross' }, `бр. ${sgn(s.r ?? 0, 2)}R`))
    b.append(left, mid, right)
    b.onclick = () => selectClosed(s)
    host.append(b)
  }
}

function selectOpen(s: Signal) {
  state.selOpen = s.id
  state.hover = null
  void fetchKlines(s)
  renderList()
  renderChart()
  renderDetail()
}
function selectClosed(s: Signal) {
  state.selClosed = s.id
  state.hover = null
  void fetchKlines(s)
  renderList()
  renderChart()
  renderDetail()
}

/* ── ценовой график ───────────────────────────────────────────────────── */

function barsFor(sel: Sel): { bars: Kline[]; real: boolean } {
  const kl = state.klines.get(klKey(sel.sig))
  if (kl && kl.length) return { bars: kl, real: true }
  const sp = sel.sig.spark ?? []
  if (sp.length < 3) return { bars: [], real: false }
  const stepH = INTERVAL_HOURS[sel.sig.timeframe] ?? 1
  const end = sel.toMs
  const bars: Kline[] = sp.map((c, i) => ({
    t: end - (sp.length - 1 - i) * stepH * HOUR,
    o: i ? sp[i - 1] : c,
    h: Math.max(c, i ? sp[i - 1] : c),
    l: Math.min(c, i ? sp[i - 1] : c),
    c,
  }))
  return { bars, real: false }
}

function renderChart() {
  const head = $('px-head')
  const host = $('px')
  head.replaceChildren()
  host.replaceChildren()

  const sel = currentSel()
  if (!sel) {
    host.append(el('div', { class: 'empty' }, 'Нечего показать: в этом срезе нет сделок.'))
    return
  }
  const s = sel.sig
  const long = s.side === 'long'
  const { bars, real } = barsFor(sel)

  /* шапка */
  const move = ((sel.last - s.entry) / s.entry) * 100 * (long ? 1 : -1)
  const moveCls = move >= 0 ? 'up' : 'down'
  head.append(
    el('b', { class: 'px__base' }, s.base),
    el('span', { class: 'px__pair' }, '/USDT'),
    el('span', { class: `px__side ${long ? 'up' : 'down'}` }, long ? '▲ЛОНГ' : '▼ШОРТ'),
    el('span', { class: 'px__tf' }, `${s.timeframe} · ${hzLabel(s)}`),
    el('span', { class: 'sig__hr' }),
    el('b', { class: `px__last ${moveCls}` }, fmtPrice(sel.last)),
    el(
      'span',
      { class: `px__chg ${moveCls}` },
      `${move >= 0 ? '▲ +' : '▼ −'}${Math.abs(move).toFixed(2)}% ${sel.isOpen ? 'от входа' : 'итог'}`,
    ),
    el('span', { class: 'sig__spacer' }),
  )
  const legend = el('div', { class: 'px__legend' })
  const leg = (color: string, label: string, v: number) => {
    const sp = el('span', {})
    const i = el('i', {})
    i.style.background = color
    sp.append(i, document.createTextNode(`${label} ${fmtPrice(v)}`))
    return sp
  }
  legend.append(
    leg('var(--text)', 'вход', s.entry),
    leg('var(--down)', 'стоп', s.sl),
    leg('var(--up)', 'тейк', s.tp),
  )
  head.append(legend)

  if (!bars.length) {
    host.append(el('div', { class: 'empty' }, 'Свечи недоступны офлайн, а spark в данных пуст.'))
    return
  }

  /* геометрия */
  const W = 1000
  const H = 420
  const PLOT = 944
  const PAD = 20
  let lo = Math.min(s.sl, s.tp)
  let hi = Math.max(s.sl, s.tp)
  for (const b of bars) {
    lo = Math.min(lo, b.l)
    hi = Math.max(hi, b.h)
  }
  const padV = (hi - lo) * 0.06
  lo -= padV
  hi += padV
  const Y = (v: number) => +(PAD + ((hi - v) / (hi - lo)) * (H - PAD * 2)).toFixed(1)
  const bw = PLOT / bars.length
  const body = Math.max(1.4, bw * 0.62)

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' })
  root.setAttribute('aria-label', `${s.base} ${long ? 'лонг' : 'шорт'}: цена, вход, стоп, тейк`)

  const yEntry = Y(s.entry)
  const ySl = Y(s.sl)
  const yTp = Y(s.tp)
  const yLast = Y(sel.last)

  /* зоны за уровнями */
  root.append(
    svg('rect', { x: 0, y: long ? 0 : yTp, width: W, height: long ? yTp : H - yTp, fill: 'var(--up-soft)' }),
    svg('rect', { x: 0, y: long ? ySl : 0, width: W, height: long ? H - ySl : ySl, fill: 'var(--down-soft)' }),
  )

  /* сетка */
  const gridVals: number[] = []
  for (let i = 0; i <= 5; i++) gridVals.push(lo + ((hi - lo) * i) / 5)
  for (const v of gridVals) {
    root.append(
      svg('line', { x1: 0, y1: Y(v), x2: W, y2: Y(v), stroke: 'var(--hair)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    )
  }

  /* свечи */
  bars.forEach((b, i) => {
    const cx = i * bw + bw / 2
    const color = b.c >= b.o ? 'var(--up)' : 'var(--down)'
    const yTop = Y(Math.max(b.o, b.c))
    const yBot = Y(Math.min(b.o, b.c))
    root.append(
      svg('line', { x1: cx, y1: Y(b.h), x2: cx, y2: Y(b.l), stroke: color, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
      svg('rect', { x: cx - body / 2, y: yTop, width: body, height: Math.max(1, yBot - yTop), fill: color }),
    )
  })

  /* уровни сделки */
  root.append(
    svg('line', { x1: 0, y1: yEntry, x2: W, y2: yEntry, stroke: 'var(--text)', 'stroke-width': 1, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke' }),
    svg('line', { x1: 0, y1: ySl, x2: W, y2: ySl, stroke: 'var(--down)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    svg('line', { x1: 0, y1: yTp, x2: W, y2: yTp, stroke: 'var(--up)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
  )

  /* момент входа */
  let entryIdx = bars.findIndex((b) => b.t >= sel.fromMs)
  if (entryIdx < 0) entryIdx = bars.length - 1
  const entryX = entryIdx * bw
  root.append(
    svg('line', { x1: entryX, y1: 0, x2: entryX, y2: H, stroke: 'var(--hair-2)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
  )

  /* курсор */
  if (state.hover != null && bars[state.hover]) {
    const hx = state.hover * bw + bw / 2
    root.append(
      svg('line', { x1: hx, y1: 0, x2: hx, y2: H, stroke: 'var(--hair-2)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    )
  }

  const hit = svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' })
  hit.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor(x / bw)))
    if (i !== state.hover) {
      state.hover = i
      renderChart()
    }
  })
  hit.addEventListener('pointerleave', () => {
    state.hover = null
    renderChart()
  })
  root.append(hit)
  host.append(root)

  /* подписи справа: сеточные, но не под бейджами уровней */
  const taken = [yEntry, ySl, yTp, yLast]
  const top = (y: number) => `${((y / H) * 100).toFixed(2)}%`
  for (const v of gridVals) {
    const y = Y(v)
    if (taken.some((ty) => Math.abs(ty - y) < 13)) continue
    const tag = el('span', { class: 'px__tag px__tag--grid' }, fmtPrice(v))
    tag.style.top = top(y)
    host.append(tag)
  }
  const tag = (cls: string, y: number, text: string) => {
    const e = el('span', { class: `px__tag ${cls}` }, text)
    e.style.top = top(y)
    host.append(e)
  }
  tag('px__tag--entry', yEntry, fmtPrice(s.entry))
  tag('px__tag--sl', ySl, fmtPrice(s.sl))
  tag('px__tag--tp', yTp, fmtPrice(s.tp))
  tag('px__tag--last', yLast, fmtPrice(sel.last))

  /* MAE / MFE — фактический ход сделки */
  const note = (cls: string, y: number, text: string) => {
    const e = el('span', { class: `px__note ${cls}` }, text)
    e.style.top = top(y)
    host.append(e)
  }
  if (real || !sel.isOpen) {
    note('up', Y(sel.best), `MFE ${sgn(sel.mfeR)}R · ${fmtPrice(sel.best)}`)
    note('down', Y(sel.worst), `MAE ${sgn(sel.maeR)}R · ${fmtPrice(sel.worst)}`)
  }

  const mark = el('span', { class: 'px__entrymark' }, `вход ${fmtDT(sel.fromMs)}`)
  mark.style.left = `${((entryX / W) * 100).toFixed(2)}%`
  host.append(mark)

  const times = el('div', { class: 'px__times' })
  const step = Math.max(1, Math.floor(bars.length / 4))
  for (let i = 0; i < bars.length; i += step) times.append(el('span', {}, fmtDT(bars[i].t)))
  host.append(times)

  if (!real) {
    host.append(
      el('div', { class: 'px__fallback' }, 'свечи недоступны — линия закрытий из spark[44]'),
    )
  }

  if (state.hover != null && bars[state.hover]) {
    const b = bars[state.hover]
    const risk = Math.abs(s.entry - s.sl) || 1
    const rNow = ((long ? b.c - s.entry : s.entry - b.c) / risk)
    const tip = el('dl', { class: 'px__tip' })
    tip.append(
      el('dt', {}, fmtDT(b.t)),
      el('dd', {}, `O ${fmtPrice(b.o)}  H ${fmtPrice(b.h)}`),
      el('dd', {}, `L ${fmtPrice(b.l)}  C ${fmtPrice(b.c)}`),
      el('dd', { class: rNow >= 0 ? 'up' : 'down' }, `${sgn(rNow)}R · ${sgn(rNow * state.riskUsd, 0)}$`),
    )
    const hx = state.hover * bw + bw / 2
    tip.style.left = `${Math.min(92, Math.max(8, (hx / W) * 100))}%`
    host.append(tip)
  }
}

/* ── нижняя аналитика ─────────────────────────────────────────────────── */

function renderPanel() {
  const host = $('panel')
  host.replaceChildren()
  const closed = closedSlice()
  const st = statsOf(closed)
  const k = unitK()
  const u = unitSuffix()
  const d1 = state.unit === 'R' ? 1 : 0
  const d2 = state.unit === 'R' ? 2 : 1

  $('dd').textContent = `макс. просадка ${(st.maxDD * k).toFixed(d1)}${u}`

  if (state.panel === 'book') {
    const W = 1000
    const H = 172
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' })
    root.setAttribute('aria-label', 'Накопленный нетто-результат закрытой книги')
    const pts = st.curve
    if (pts.length > 1) {
      const t0 = pts[0].t
      const t1 = pts[pts.length - 1].t
      const vals = pts.map((p) => p.cum).concat(pts.map((p) => p.peak), [0])
      const lo = Math.min(...vals)
      const hi = Math.max(...vals)
      const rng = hi - lo || 1
      const X = (p: { t: number }) => 10 + ((p.t - t0) / (t1 - t0 || 1)) * (W - 20)
      const Y = (v: number) => +(H - 26 - ((v - lo) / rng) * (H - 58)).toFixed(1)
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)} ${Y(p.cum)}`).join(' ')
      const peak = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)} ${Y(p.peak)}`).join(' ')
      const back = pts.slice().reverse().map((p) => `L${X(p).toFixed(1)} ${Y(p.cum)}`).join(' ')
      root.append(
        svg('line', { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: 'var(--hair)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
        svg('path', { d: `${peak} ${back} Z`, fill: 'var(--down-soft)' }),
        svg('path', { d: peak, fill: 'none', stroke: 'var(--hair-2)', 'stroke-width': 1, 'stroke-dasharray': '2 4', 'vector-effect': 'non-scaling-stroke' }),
        svg('path', { d: line, fill: 'none', stroke: 'var(--text)', 'stroke-width': 1.4, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }),
        svg('circle', { cx: X(pts[pts.length - 1]), cy: Y(pts[pts.length - 1].cum), r: 2.5, fill: 'var(--text)' }),
      )
    }
    host.append(root)
    const head = el('div', { class: 'eq__head' })
    head.append(
      el('b', { class: `eq__total ${st.cum >= 0 ? 'up' : 'down'}` }, sgn(st.cum * k, d1) + u),
      el('span', { class: 'eq__avg' }, `средний нетто ${sgn(st.mean * k, d2)}${u} ± ${(st.ci * k).toFixed(d2)} (95%)`),
    )
    const foot = el('div', { class: 'eq__foot' })
    foot.append(
      el('span', {}, pts.length ? fmtDay(pts[0].t) : '—'),
      el(
        'span',
        {},
        `n=${st.n} решённых · винрейт нетто ${st.wrNet}% · брутто ${st.wrGross}% / ${sgn(st.grossMean)}R`,
      ),
      el('span', {}, pts.length ? fmtDay(pts[pts.length - 1].t) : '—'),
    )
    host.append(head, foot)
    return
  }

  if (state.panel === 'strata') {
    const groups = new Map<string, Signal[]>()
    for (const s of closed) {
      const key = `${hzKey(s)}:${s.side}`
      const g = groups.get(key)
      if (g) g.push(s)
      else groups.set(key, [s])
    }
    const rows = [...groups.entries()]
      .map(([key, arr]) => {
        const [h, side] = key.split(':')
        const dec = arr.filter(decided)
        const avg = dec.length ? dec.reduce((a, x) => a + netOf(x), 0) / dec.length : 0
        const nw = dec.filter((x) => netOf(x) > 0).length
        return {
          name: `${HZ_LABEL[h] ?? h} · ${side === 'long' ? 'лонг' : 'шорт'}`,
          dec: dec.length,
          avg,
          wr: dec.length ? Math.round((nw / dec.length) * 100) : 0,
          enough: dec.length >= gate(),
        }
      })
      .sort((a, b) => b.dec - a.dec)
    const maxAbs = Math.max(0.3, ...rows.map((r) => Math.abs(r.avg)))
    const box = el('div', { class: 'strata' })
    for (const r of rows) {
      const row = el('div', { class: `stratum${r.enough ? '' : ' stratum--thin'}` })
      const bar = el('div', { class: 'stratum__bar' })
      const fill = el('i', {})
      const w = (Math.abs(r.avg) / maxAbs) * 48
      fill.style.left = `${r.avg >= 0 ? 50 : 50 - w}%`
      fill.style.width = `${w.toFixed(1)}%`
      fill.style.background = r.enough ? (r.avg >= 0 ? 'var(--up)' : 'var(--down)') : 'var(--faint)'
      bar.append(el('u', {}), el('s', {}), fill)
      const right = el('div', {})
      right.append(
        el('div', { class: `stratum__val ${r.enough ? (r.avg >= 0 ? 'up' : 'down') : ''}` }, `${r.avg >= 0 ? '▲ ' : '▼ '}${sgn(r.avg)}R`),
        el(
          'div',
          { class: 'stratum__note' },
          r.enough
            ? `${r.dec} решённых · ВР ${r.wr}%`
            : `${r.dec} решённых — мало данных, нужно ещё ${Math.max(0, gate() - r.dec)}`,
        ),
      )
      row.append(el('span', {}, r.name), bar, right)
      box.append(row)
    }
    host.append(box)
    return
  }

  if (state.panel === 'dist') {
    const lo = -1.5
    const hi = 3
    const step = 0.25
    const bins: number[] = new Array(Math.round((hi - lo) / step)).fill(0)
    for (const s of closed) {
      const i = Math.max(0, Math.min(bins.length - 1, Math.floor((netOf(s) - lo) / step)))
      bins[i]++
    }
    const maxC = Math.max(1, ...bins)
    const box = el('div', { class: 'hist' })
    const barsBox = el('div', { class: 'hist__bars' })
    bins.forEach((c, i) => {
      const x0 = lo + i * step
      const b = el('i', { title: `${x0.toFixed(2)}…${(x0 + step).toFixed(2)}R · ${c}` })
      b.style.height = c ? `${Math.max(3, (c / maxC) * 100)}%` : '0'
      b.style.background = x0 + step <= 0 ? 'var(--down)' : 'var(--up)'
      barsBox.append(b)
    })
    const axis = el('div', { class: 'hist__axis' })
    for (const v of [-1, 0, 1, 2]) {
      const sp = el('span', {}, `${v > 0 ? '+' : ''}${v}R`)
      sp.style.left = `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`
      axis.append(sp)
    }
    const dec = closed.filter(decided)
    const losers = dec.filter((s) => netOf(s) <= 0).length
    const foot = el('div', {})
    foot.append(
      axis,
      el(
        'div',
        { class: 'hist__note' },
        `n=${closed.length} закрытых · проигрышей ${losers} из ${dec.length} решённых. Край даёт правый хвост, а не частота.`,
      ),
    )
    box.append(barsBox, foot)
    host.append(box)
    return
  }

  /* недели */
  const wk = new Map<string, { sum: number; n: number }>()
  for (const s of closed) {
    const key = s.cohortWeek ?? '—'
    const g = wk.get(key)
    if (g) {
      g.sum += netOf(s)
      g.n++
    } else wk.set(key, { sum: netOf(s), n: 1 })
  }
  const keys = [...wk.keys()].sort().slice(-16)
  const maxWk = Math.max(0.5, ...keys.map((key) => Math.abs(wk.get(key)!.sum)))
  const box = el('div', { class: 'weeks' })
  const grid = el('div', { class: 'weeks__grid' })
  for (const key of keys) {
    const g = wk.get(key)!
    const up = g.sum >= 0
    const cell = el('div', { class: 'weeks__cell', title: `${key} · ${sgn(g.sum)}R · ${g.n}` })
    cell.style.background = up ? 'var(--up-soft)' : 'var(--down-soft)'
    if (Math.abs(g.sum) / maxWk > 0.45) cell.style.borderColor = up ? 'var(--up)' : 'var(--down)'
    cell.append(
      el('b', { class: up ? 'up' : 'down' }, sgn(g.sum * k, d1)),
      el('span', {}, String(g.n)),
    )
    grid.append(cell)
  }
  box.append(
    grid,
    el(
      'div',
      { class: 'weeks__foot' },
      keys.length
        ? `${keys[0].slice(5)} → ${keys[keys.length - 1].slice(5)} · нетто-R за неделю входа и число сделок`
        : 'нет данных',
    ),
  )
  host.append(box)
}

/* ── карточка справа ──────────────────────────────────────────────────── */

function factRow(pairs: [string, string, string?][]): HTMLElement {
  const box = el('div', { class: 'facts' })
  for (const [k, v, cls] of pairs) {
    const f = el('div', { class: 'fact' })
    f.append(el('span', {}, k), el('b', { class: cls ?? '' }, v))
    box.append(f)
  }
  return box
}

function renderDetail() {
  const host = $('detail')
  host.replaceChildren()
  const sel = currentSel()
  if (!sel) {
    host.append(el('div', { class: 'empty' }, 'Выбери сделку в списке слева.'))
    return
  }
  const s = sel.sig
  const long = s.side === 'long'
  const k = unitK()
  const u = unitSuffix()
  const d2 = state.unit === 'R' ? 2 : 1

  const top = el('div', { class: 'detail__top' })
  top.append(
    el('b', { class: 'detail__base' }, s.base),
    el('span', { class: `detail__side ${long ? 'up' : 'down'}` }, long ? '▲ ЛОНГ' : '▼ ШОРТ'),
  )
  if (sel.isOpen) {
    top.append(el('b', { class: 'detail__head' }, `${s.strength} / сила`))
  } else {
    const net = netOf(s)
    top.append(el('b', { class: `detail__head ${net >= 0 ? 'up' : 'down'}` }, sgn(net * k, d2) + u))
  }
  host.append(top)

  const meta = sel.isOpen
    ? `${s.engine} · ${s.timeframe} · ${fmtDT(ms(s.createdAt))} · ${s.cohortWeek ?? '—'}` +
      (s.newsCount ? ` · новости ${s.newsCount} (${s.newsSentiment ?? 'neutral'})` : '')
    : `${s.engine} · ${s.timeframe} · ${fmtDT(ms(s.createdAt))} → ${fmtDT(ms(s.closedAt ?? s.createdAt))} · ${s.cohortWeek ?? '—'}`
  host.append(el('div', { class: 'detail__meta' }, meta))

  if (sel.isOpen) {
    const leftH = Math.max(0, s.etaHours - (Date.now() - ms(s.createdAt)) / HOUR)
    host.append(
      factRow([
        ['риск', `−${s.riskPct}% · 1R`, 'down'],
        ['цель', `+${s.targetPct}% · ${(s.rr ?? s.targetPct / s.riskPct).toFixed(1)}R`, 'up'],
        ['срок жизни', fmtDur(leftH)],
        ['размер', s.posSizePct != null ? `$${s.posSizePct} / 100` : '—'],
        ['MFE', `${sgn(sel.mfeR)}R`, 'up'],
        ['MAE', `${sgn(sel.maeR)}R`, 'down'],
      ]),
    )

    const bd = s.scoreBreakdown
    if (bd) {
      const tot = Math.max(1, bd.trend + bd.regime + bd.rs)
      const sec = el('div', { class: 'sec' })
      sec.append(el('span', {}, 'Состав скора'), el('em', {}, `${bd.trend} + ${bd.regime} + ${bd.rs} = ${bd.total}`))
      const bar = el('div', { class: 'score' })
      const seg = (v: number, color: string) => {
        const i = el('div', {})
        i.style.width = `${((v / tot) * 100).toFixed(1)}%`
        i.style.background = color
        return i
      }
      bar.append(seg(bd.trend, 'var(--text)'), seg(bd.regime, 'var(--dim)'), seg(bd.rs, 'var(--faint)'))
      const legend = el('div', { class: 'score__legend' })
      legend.append(
        el('span', {}, `тренд ${bd.trend}`),
        el('span', {}, `режим ${bd.regime}`),
        el('span', {}, `RS ${bd.rs}`),
      )
      host.append(sec, bar, legend)
    }

    const secWhy = el('div', { class: 'sec' })
    secWhy.append(el('span', {}, 'Почему этот сигнал'))
    const ul = el('ul', { class: 'why' })
    for (const r of s.reasons.slice(0, 5)) ul.append(el('li', {}, r))
    host.append(secWhy, ul)

    const ind = s.indicators
    const inds = el('div', { class: 'inds' })
    const pairs: [string, string][] = [
      ['RSI', String(ind.rsi)],
      ['ADX', String(ind.adx)],
      ['+DI/−DI', `${ind.plusDI ?? '—'} / ${ind.minusDI ?? '—'}`],
      ['MACD-h', String(ind.macdHist)],
      ['ATR', s.atr != null ? String(s.atr) : '—'],
      ['R:R', `${(s.targetPct / (s.riskPct || 1)).toFixed(1)}:1`],
    ]
    for (const [key, v] of pairs) {
      const cell = el('div', { class: 'ind' })
      cell.append(el('span', {}, key), el('b', {}, v))
      inds.append(cell)
    }
    host.append(inds)

    if (s.news && s.news.length) {
      const secNews = el('div', { class: 'sec' })
      secNews.append(el('span', {}, 'Новостной фон'))
      const ulN = el('ul', { class: 'why' })
      for (const it of s.news.slice(0, 2)) {
        const li = el('li', {})
        li.append(el('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title))
        ulN.append(li)
      }
      host.append(secNews, ulN)
    }
    return
  }

  const btc = { up: 'рост', down: 'падение', flat: 'боковик' } as const
  host.append(
    factRow([
      ['исход', s.status === 'tp' ? 'TP' : s.status === 'sl' ? 'SL' : 'EXP'],
      ['брутто', `${sgn(s.r ?? 0)}R`],
      ['нетто %', `${sgn(s.netPnlPct ?? 0, 1)}%`, (s.netPnlPct ?? 0) >= 0 ? 'up' : 'down'],
      ['издержки', s.costPct != null ? `${s.costPct}%` : '—'],
      ['в позиции', fmtDur(s.durationH ?? 0)],
      ['дошёл до цели', s.toTpPct != null ? `${s.toTpPct}%` : '—'],
      ['MAE', s.maeR != null ? `${s.maeR}R` : '—', 'down'],
      ['BTC при входе', s.entryBtcRegime ? btc[s.entryBtcRegime] : '—'],
    ]),
  )
  const note =
    s.status === 'tp'
      ? 'Тейк взят. Средняя сделка книги — тонкий плюс, один результат ничего не доказывает.'
      : s.status === 'sl'
        ? 'Стоп по плану. При винрейте около трети такие сделки — основная масса книги, а не сбой.'
        : 'Истёк без срабатывания: за отведённый срок цена не дошла ни до стопа, ни до тейка.'
  host.append(el('p', { class: 'detail__note' }, note))
}

/* ── сборка ───────────────────────────────────────────────────────────── */

function renderBookLine() {
  const st = statsOf(closedSlice())
  const k = unitK()
  const d1 = state.unit === 'R' ? 1 : 0
  $('book-line').textContent =
    `книга ${sgn(st.cum * k, d1)}${unitSuffix()} · n=${st.n} · винрейт нетто ${st.wrNet}%`
}

function renderAll() {
  if (!state.data) return
  renderControls()
  renderBookLine()
  renderList()
  const sel = currentSel()
  if (sel) void fetchKlines(sel.sig)
  renderChart()
  renderPanel()
  renderDetail()
}

async function load() {
  try {
    const res = await fetch(`${BASE}data/signals.json?v=${Date.now()}`, { cache: 'no-cache' })
    if (!res.ok) throw new Error(String(res.status))
    const raw = (await res.json()) as SignalsData
    // Доредизайновая книга (без штампа engine) в интерфейс не попадает — одна отсечка.
    state.data = { ...raw, open: raw.open.filter(isModern), closed: raw.closed.filter(isModern) }
    renderAll()
    void fetchPrices()
  } catch {
    if (state.data) return
    $('list').replaceChildren(
      el('div', { class: 'empty' }, 'Данные не загрузились. Анализатор пишет их по расписанию (~30 мин).'),
    )
  }
}

function setLive() {
  $('live-text').textContent = state.data ? `обновлено ${timeAgo(state.data.generatedAt)}` : 'нет данных'
}

function initTheme() {
  const btn = $('theme-btn') as HTMLButtonElement
  const html = document.documentElement
  const sync = () => {
    const light = html.dataset.theme === 'light'
    btn.textContent = light ? '◑' : '☀'
    btn.title = light ? 'Тёмная тема' : 'Светлая тема'
  }
  btn.onclick = () => {
    const next = html.dataset.theme === 'light' ? 'dark' : 'light'
    html.dataset.theme = next
    try {
      localStorage.setItem('meridian-theme', next)
    } catch {
      /* приватный режим */
    }
    sync()
  }
  sync()
}

// стрелки ходят по списку, не трогая фокус-навигацию по кнопкам
function initKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT') return
    const rows = [...$('list').querySelectorAll<HTMLButtonElement>('.row, .crow')]
    if (!rows.length) return
    const idx = rows.findIndex((r) => r.getAttribute('aria-current') === 'true')
    const next = Math.max(0, Math.min(rows.length - 1, (idx < 0 ? 0 : idx) + (e.key === 'ArrowDown' ? 1 : -1)))
    e.preventDefault()
    rows[next].click()
    rows[next].focus({ preventScroll: false })
  })
}

function tick() {
  void load().then(setLive)
}

initTheme()
initKeys()

setupGate(() => {
  $('app').hidden = false
  tick()
  setInterval(tick, 5 * 60 * 1000)
  setInterval(() => void fetchPrices(), 30_000)
})
