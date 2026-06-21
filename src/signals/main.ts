import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/arbitrage.css'
import '../styles/signals.css'
import { registerSW } from 'virtual:pwa-register'
import { setupGate } from '../lib/gate'
import { el, timeAgo } from '../lib/util'

registerSW({ immediate: true })

const BASE = import.meta.env.BASE_URL
const NS = 'http://www.w3.org/2000/svg'
const $ = (id: string) => document.getElementById(id) as HTMLElement

interface Signal {
  id: string
  symbol: string
  base: string
  side: 'long' | 'short'
  markets: string[]
  entry: number
  sl: number
  tp: number
  riskPct: number
  targetPct: number
  strength: number
  etaHours: number
  posSizePct?: number
  riskBudgetPct?: number
  rsRank?: number | null
  horizon?: 'scalp' | 'mid' | 'long' | 'veryLong'
  horizonLabel?: string
  reasons: string[]
  indicators: { rsi: number; adx: number; macdHist: number; plusDI?: number; minusDI?: number; volPct?: number | null }
  news?: { title: string; source: string; url: string; publishedAt: string }[] | null
  newsSentiment?: 'pos' | 'neg' | 'neutral' | null
  newsCount?: number
  spark?: number[]
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
}

interface Stratum {
  horizon: string
  side: string
  closedTotal: number
  decided: number
  winRate: number
  netWinRate: number
  avgR: number
  avgNetR: number
  totalNetPnlPct: number
  enough: boolean
}

interface SignalsData {
  generatedAt: string
  universeSize: number
  stats: {
    open: number
    closedTotal: number
    wins: number
    losses: number
    winRate: number
    netWinRate?: number
    avgR: number
    avgNetR?: number
    totalPnlPct?: number
    totalNetPnlPct?: number
    avgWinDurationH: number
    avgEtaOpenH: number
    sampleGate?: number
    byStratum?: Stratum[]
  }
  open: Signal[]
  closed: Signal[]
}

const state = {
  data: null as SignalsData | null,
  mode: 'futures' as 'futures' | 'spot',
  horizon: 'all' as 'all' | 'scalp' | 'mid' | 'long' | 'veryLong',
  status: 'open' as 'open' | 'closed' | 'all',
  query: '',
}

function hz(s: Signal): 'scalp' | 'mid' | 'long' | 'veryLong' {
  return s.horizon || 'mid'
}

// ── форматирование ──
function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.01) return n.toFixed(6)
  return n.toPrecision(4)
}
function fmtDur(h: number): string {
  if (!h || h <= 0) return '—'
  if (h < 24) return `${Math.round(h)} ч`
  const d = h / 24
  if (d < 30) return `${d < 10 ? d.toFixed(1) : Math.round(d)} дн`
  const mo = d / 30.44
  return `${mo < 10 ? mo.toFixed(1) : Math.round(mo)} мес`
}

// деньги от базы $100: профит$ = % хода × плечо (база ровно 100)
const LEVS = [1, 5, 10, 25, 50]
function money(n: number): string {
  const v = Math.abs(n)
  return (n < 0 ? '−$' : '+$') + (v >= 100 ? v.toFixed(0) : v.toFixed(1))
}

function openProgress(s: Signal): number | null {
  const last = s.spark?.[s.spark.length - 1]
  if (!last || !s.entry || !s.tp || s.entry === s.tp) return null
  const p =
    s.side === 'long'
      ? ((last - s.entry) / (s.tp - s.entry)) * 100
      : ((s.entry - last) / (s.entry - s.tp)) * 100
  return Math.round(p * 10) / 10
}

async function load() {
  try {
    const res = await fetch(`${BASE}data/signals.json?v=${Date.now()}`, { cache: 'no-cache' })
    if (!res.ok) throw new Error(String(res.status))
    state.data = (await res.json()) as SignalsData
    renderAll()
  } catch {
    if (state.data) return
    $('grid').replaceChildren()
    showEmpty('Сигналы ещё не готовы. Анализатор запускается по расписанию (каждые ~30 мин) — загляни чуть позже.')
  }
}

function scoped(): Signal[] {
  const d = state.data
  if (!d) return []
  let list: Signal[] =
    state.status === 'open' ? d.open : state.status === 'closed' ? d.closed : [...d.open, ...d.closed]
  // Рынок берём из markets сигнала: фьючерсы — всё с 'futures'; спот — всё с 'spot'
  // (сверхдолгосрок — только спот, скальп — только фьючерсы).
  list = list.filter((s) => (s.markets || ['futures']).includes(state.mode))
  if (state.horizon !== 'all') list = list.filter((s) => hz(s) === state.horizon)
  const q = state.query.trim().toLowerCase()
  if (q) list = list.filter((s) => s.base.toLowerCase().includes(q))
  return list
}

function renderAll() {
  renderStats()
  renderControls()
  renderGrid()
}

function renderStats() {
  const s = state.data!.stats
  // винрейт и R показываем НЕТТО (после комиссий+проскальзывания) — честный ориентир,
  // брутто прячем в подсказку
  const netWr = s.netWinRate ?? s.winRate
  const wr = $('s-winrate')
  wr.textContent = `${netWr}%`
  wr.title = `брутто ${s.winRate}% · нетто учитывает комиссию + проскальзывание`
  setLabel(wr, 'винрейт нетто')
  $('s-open').textContent = String(s.open)
  // фактический средний срок до тейка, пока нет закрытых — прогноз по открытым
  $('s-eta').textContent = s.avgWinDurationH
    ? fmtDur(s.avgWinDurationH)
    : '≈' + fmtDur(s.avgEtaOpenH)
  const netR = s.avgNetR ?? s.avgR
  const ar = $('s-avgr')
  ar.textContent = (netR >= 0 ? '+' : '') + netR + 'R'
  ar.title = `брутто ${s.avgR}R`
  setLabel(ar, 'средний R нетто')
  $('s-closed').textContent = `${s.wins} / ${s.losses}`
  $('s-universe').textContent = String(state.data!.universeSize)
  renderStrata()
}

function setLabel(valueEl: HTMLElement, text: string) {
  const lbl = valueEl.nextElementSibling
  if (lbl && lbl.tagName === 'SPAN') lbl.textContent = text
}

// разбивка по стратам (горизонт × сторона): нетто-винрейт/R, с гейтом по выборке
function renderStrata() {
  const host = document.getElementById('strata')
  if (!host) return
  const s = state.data!.stats
  const rows = (s.byStratum || []).filter((r) => r.closedTotal > 0)
  if (!rows.length) {
    host.replaceChildren()
    return
  }
  const hzL: Record<string, string> = { scalp: 'Скальп', mid: 'Средне', long: 'Долго', veryLong: 'Сверхдолго' }
  const frag = document.createDocumentFragment()
  const head = el('div', { class: 'strat-row strat-head' })
  head.append(el('span', {}, 'Страта'), el('span', {}, 'сделок'), el('span', {}, 'винрейт нетто'), el('span', {}, 'ср. R нетто'))
  frag.append(head)
  for (const r of rows) {
    const row = el('div', { class: 'strat-row' })
    const name = `${hzL[r.horizon] || r.horizon} · ${r.side === 'long' ? 'лонг' : 'шорт'}`
    row.append(el('span', { class: 'strat-name' }, name))
    row.append(el('span', {}, `${r.decided}`))
    if (!r.enough) {
      const need = (s.sampleGate || 50) - r.decided
      row.append(el('span', { class: 'strat-wait' }, `мало данных`))
      row.append(el('span', { class: 'strat-wait' }, `ещё ~${need > 0 ? need : 0}`))
    } else {
      row.append(el('span', { class: r.netWinRate >= 50 ? 'up' : 'down' }, `${r.netWinRate}%`))
      row.append(el('span', { class: r.avgNetR >= 0 ? 'up' : 'down' }, `${r.avgNetR >= 0 ? '+' : ''}${r.avgNetR}R`))
    }
    frag.append(row)
  }
  host.replaceChildren(frag)
}

function seg(
  host: HTMLElement,
  items: { key: string; label: string; n?: number }[],
  active: string,
  onPick: (k: string) => void,
) {
  host.replaceChildren()
  for (const it of items) {
    const b = el('button', { 'aria-selected': String(active === it.key) }, it.label)
    if (it.n != null) b.append(el('span', { class: 'n' }, String(it.n)))
    b.onclick = () => onPick(it.key)
    host.append(b)
  }
}

function baseByStatus(): Signal[] {
  const d = state.data!
  return state.status === 'open' ? d.open : state.status === 'closed' ? d.closed : [...d.open, ...d.closed]
}

function renderControls() {
  const d = state.data!
  const base = baseByStatus()
  const spotList = base.filter((s) => (s.markets || ['futures']).includes('spot'))
  const futuresList = base.filter((s) => (s.markets || ['futures']).includes('futures'))

  seg(
    $('tabs'),
    [
      { key: 'futures', label: 'Фьючерсы', n: futuresList.length },
      { key: 'spot', label: 'Спот · покупка', n: spotList.length },
    ],
    state.mode,
    (k) => {
      state.mode = k as typeof state.mode
      if (state.mode === 'spot' && state.horizon === 'scalp') state.horizon = 'all'
      if (state.mode === 'futures' && state.horizon === 'veryLong') state.horizon = 'all'
      renderControls()
      renderGrid()
    },
  )

  const modeList = state.mode === 'spot' ? spotList : futuresList
  const n = (k: string) => modeList.filter((s) => hz(s) === k).length
  const hzItems: { key: string; label: string; n?: number }[] = [{ key: 'all', label: 'Все' }]
  if (state.mode === 'futures') hzItems.push({ key: 'scalp', label: 'Скальп', n: n('scalp') })
  hzItems.push({ key: 'mid', label: 'Средне', n: n('mid') }, { key: 'long', label: 'Долго', n: n('long') })
  if (state.mode === 'spot') hzItems.push({ key: 'veryLong', label: 'Сверхдолго', n: n('veryLong') })
  seg($('hz'), hzItems, state.horizon, (k) => {
    state.horizon = k as typeof state.horizon
    renderControls()
    renderGrid()
  })

  seg(
    $('sides'),
    [
      { key: 'open', label: 'Открытые', n: d.open.length },
      { key: 'closed', label: 'Закрытые', n: d.closed.length },
      { key: 'all', label: 'Все' },
    ],
    state.status,
    (k) => {
      state.status = k as typeof state.status
      renderControls()
      renderGrid()
    },
  )

  const q = $('q') as HTMLInputElement
  if (!q.oninput) {
    q.oninput = (e) => {
      state.query = (e.target as HTMLInputElement).value
      renderGrid()
    }
  }
}

function renderGrid() {
  const grid = $('grid')
  const items = scoped()
  if (!items.length) {
    grid.replaceChildren()
    showEmpty(state.query ? 'Ничего не найдено.' : 'В этой вкладке пока пусто.')
    return
  }
  $('empty').hidden = true
  const frag = document.createDocumentFragment()
  items.forEach((s, i) => frag.append(card(s, i)))
  grid.replaceChildren(frag)
}

// ── мини-график с уровнями (SVG) ──
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e as SVGElement
}
function chart(s: Signal): HTMLElement {
  const wrap = el('div', { class: 'sig-chart' })
  const pts = s.spark
  if (!pts || pts.length < 3) return wrap
  const W = 300
  const H = 92
  const lo = Math.min(...pts, s.sl, s.tp)
  const hi = Math.max(...pts, s.sl, s.tp)
  const rng = hi - lo || 1
  const X = (i: number) => (i / (pts.length - 1)) * W
  const Y = (v: number) => +(H - 2 - ((v - lo) / rng) * (H - 4)).toFixed(1)
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'chart-svg' })

  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v)}`).join(' ')
  svg.append(svgEl('path', { d: `${path} L${W} ${H} L0 ${H} Z`, class: `ch-area ${s.side}` }))
  svg.append(svgEl('path', { d: path, class: `ch-line ${s.side}`, 'vector-effect': 'non-scaling-stroke' }))

  const lvl = (v: number, cls: string) =>
    svgEl('line', {
      x1: 0,
      y1: Y(v),
      x2: W,
      y2: Y(v),
      class: `ch-lvl ${cls}`,
      'vector-effect': 'non-scaling-stroke',
    })
  svg.append(lvl(s.entry, 'entry'), lvl(s.sl, 'sl'), lvl(s.tp, 'tp'))
  svg.append(svgEl('circle', { cx: W, cy: Y(pts[pts.length - 1]), r: 3, class: 'ch-dot' }))
  wrap.append(svg)

  // подписи уровней справа
  const tags = el('div', { class: 'ch-tags' })
  tags.append(el('span', { class: 'ch-tag tp' }, 'TP ' + fmtPrice(s.tp)))
  tags.append(el('span', { class: 'ch-tag sl' }, 'SL ' + fmtPrice(s.sl)))
  wrap.append(tags)
  return wrap
}

function card(s: Signal, i: number): HTMLElement {
  const isOpen = s.status === 'open'
  const spot = state.mode === 'spot'
  const c = el('article', { class: `sig-card ${s.side}${isOpen ? '' : ' closed'}` })
  c.style.animationDelay = `${Math.min(i * 18, 300)}ms`

  // шапка
  const head = el('div', { class: 'sig-head' })
  const coin = el('div', { class: 'sig-coin' }, s.base)
  coin.append(el('span', {}, ' /USDT'))
  head.append(coin)
  if (spot) {
    head.append(el('span', { class: 'badge long' }, 'Покупка'))
  } else {
    head.append(el('span', { class: `badge ${s.side}` }, s.side === 'long' ? 'Лонг' : 'Шорт'))
  }
  const hzLabels: Record<string, string> = {
    scalp: 'Скальп · 1ч',
    mid: 'Средне · 4ч',
    long: 'Долго · 1д',
    veryLong: 'Сверхдолго · 1н',
  }
  head.append(el('span', { class: 'hz-badge' }, hzLabels[hz(s)]))
  const str = el('div', { class: 'sig-strength' })
  str.append(el('b', {}, String(s.strength)))
  str.append(el('span', {}, 'сила'))
  head.append(str)
  c.append(head)

  // график — только в режиме фьючерсов
  if (!spot) c.append(chart(s))

  // уровни
  const lv = el('div', { class: 'sig-levels' })
  lv.append(levelCell(spot ? 'Покупка' : 'Вход', fmtPrice(s.entry), ''))
  lv.append(levelCell(spot ? 'Защита' : 'Стоп', fmtPrice(s.sl), `−${s.riskPct}%`, 'sl'))
  lv.append(levelCell(spot ? 'Цель' : 'Тейк', fmtPrice(s.tp), `+${s.targetPct}%`, 'tp'))
  c.append(lv)

  // профит от базы $100 (спот — без плеча, фьючерсы — по плечам)
  c.append(profitBlock(s, spot))

  // прогноз срока / факт
  const eta = el('div', { class: 'sig-eta' })
  if (isOpen) {
    eta.append(el('span', { class: 'eta-k' }, 'Ориентир до цели'))
    eta.append(el('span', { class: 'eta-v' }, '≈ ' + fmtDur(s.etaHours)))
  } else if (s.status === 'tp') {
    eta.append(el('span', { class: 'eta-k' }, 'Цель достигнута'))
    eta.append(el('span', { class: 'eta-v up' }, 'за ' + fmtDur(s.durationH || 0)))
  } else if (s.status === 'sl') {
    eta.append(el('span', { class: 'eta-k' }, 'Сработал стоп'))
    eta.append(el('span', { class: 'eta-v down' }, 'через ' + fmtDur(s.durationH || 0)))
  } else {
    eta.append(el('span', { class: 'eta-k' }, 'Истёк без срабатывания'))
    eta.append(el('span', { class: 'eta-v' }, fmtDur(s.durationH || 0)))
  }
  c.append(eta)

  // прогресс к цели по текущей цене (открытые)
  if (isOpen) {
    const prog = openProgress(s)
    if (prog !== null) {
      const wrap = el('div', { class: 'open-prog' })
      const row = el('div', { class: 'open-prog-row' })
      row.append(el('span', { class: 'mfe-k' }, 'Прогресс к цели'))
      const cls = prog >= 100 ? ' up' : prog < 0 ? ' down' : ''
      row.append(el('span', { class: `open-prog-val${cls}` }, `${prog}%`))
      wrap.append(row)
      const bar = el('div', { class: 'open-prog-bar' })
      const fill = el('div', { class: `open-prog-fill${prog < 0 ? ' neg' : ''}` })
      fill.style.width = `${Math.max(0, Math.min(100, prog))}%`
      bar.append(fill)
      wrap.append(bar)
      c.append(wrap)
    }
  }

  // как далеко цена дошла к цели + макс. просадка до закрытия (стоп/истёкшие)
  if (!isOpen && (s.status === 'sl' || s.status === 'expired') && (s.toTpPct != null || s.maeR != null)) {
    const mfe = el('div', { class: 'sig-mfe' })
    if (s.toTpPct != null) {
      mfe.append(el('span', { class: 'mfe-k' }, 'Дошёл до цели'))
      mfe.append(el('span', { class: 'mfe-v' }, `${s.toTpPct}%`))
    }
    if (s.maeR != null) {
      mfe.append(el('span', { class: 'mfe-k' }, 'Макс. просадка'))
      mfe.append(el('span', { class: 'mfe-v down' }, `${s.maeR}R`))
    }
    c.append(mfe)
  }

  // причины
  const why = el('ul', { class: 'sig-why' })
  for (const r of s.reasons.slice(0, spot ? 3 : 5)) why.append(el('li', {}, r))
  c.append(why)

  // новостной фон
  if (s.newsCount && s.news && s.news.length) {
    const nb = el('div', { class: `news ${s.newsSentiment || 'neutral'}` })
    const senti =
      s.newsSentiment === 'pos' ? 'позитивный' : s.newsSentiment === 'neg' ? 'негативный' : 'нейтральный'
    nb.append(el('div', { class: 'news-h' }, `📰 Новостной фон: ${senti} · ${s.newsCount}`))
    for (const it of s.news.slice(0, 2)) {
      nb.append(el('a', { class: 'news-i', href: it.url, target: '_blank', rel: 'noopener' }, it.title))
    }
    c.append(nb)
  }

  // подвал
  const foot = el('div', { class: 'sig-foot' })
  if (isOpen) {
    foot.append(el('span', {}, `сигнал ${timeAgo(s.createdAt)}`))
    foot.append(el('span', { class: 'mkt' }, `RSI ${s.indicators.rsi} · ADX ${s.indicators.adx}`))
  } else {
    const label = s.status === 'tp' ? 'Тейк' : s.status === 'sl' ? 'Стоп' : 'Истёк'
    foot.append(el('span', { class: `outcome ${s.status}` }, label))
    foot.append(el('span', {}, timeAgo(s.closedAt!)))
    // показываем PnL нетто (после комиссий), брутто — в подсказке
    const net = s.netPnlPct != null
    const pnl = net ? s.netPnlPct! : s.pnlPct ?? 0
    const pnlEl = el('span', { class: `pnl ${pnl >= 0 ? 'up' : 'down'}` }, `${pnl >= 0 ? '+' : ''}${pnl}%${net ? ' нетто' : ''}`)
    if (net) pnlEl.title = `брутто ${s.pnlPct}%`
    foot.append(pnlEl)
  }
  c.append(foot)
  return c
}

function levelCell(label: string, value: string, sub: string, cls = ''): HTMLElement {
  const d = el('div', { class: `lvl ${cls}` })
  d.append(el('span', {}, label))
  d.append(el('b', {}, value))
  if (sub) d.append(document.createTextNode(' '), el('em', {}, sub))
  return d
}

// профит/убыток от базы $100. Спот — 1× без плеча; фьючерсы — таблица по плечам.
// При плече L: профит$ = targetPct × L, убыток$ = riskPct × L. Если riskPct × L ≥ 100 —
// стоп лежит за ликвидацией (позицию вынесет раньше), помечаем «ликвид.».
// Внизу — совет по размеру: сколько $ ставить, чтобы рисковать ~1% от $100.
function sizingRow(s: Signal): HTMLElement | null {
  if (s.posSizePct == null) return null
  const row = el('div', { class: 'pnl100-size' })
  row.append(el('span', {}, `Размер при риске ${s.riskBudgetPct ?? 1}%`))
  row.append(el('b', {}, `$${s.posSizePct} из $100`))
  return row
}

function profitBlock(s: Signal, spot: boolean): HTMLElement {
  const wrap = el('div', { class: 'sig-pnl100' })
  const tgt = s.targetPct || 0
  const rsk = s.riskPct || 0
  if (spot) {
    wrap.append(el('div', { class: 'pnl100-h' }, 'Со $100 на споте'))
    const row = el('div', { class: 'pnl100-spot' })
    row.append(el('span', { class: 'up' }, 'к цели ' + money(tgt)))
    row.append(el('span', { class: 'down' }, 'к защите ' + money(-rsk)))
    wrap.append(row)
    const sz = sizingRow(s)
    if (sz) wrap.append(sz)
    return wrap
  }
  wrap.append(el('div', { class: 'pnl100-h' }, 'Профит со $100 · плечо'))
  const grid = el('div', { class: 'pnl100-grid' })
  grid.append(el('span', { class: 'th' }, 'Плечо'), el('span', { class: 'th' }, 'Цель'), el('span', { class: 'th' }, 'Стоп'))
  for (const L of LEVS) {
    grid.append(el('span', { class: 'lev' }, L + '×'))
    grid.append(el('span', { class: 'up' }, money(tgt * L)))
    if (rsk * L >= 100) grid.append(el('span', { class: 'down liq' }, 'ликвид.'))
    else grid.append(el('span', { class: 'down' }, money(-rsk * L)))
  }
  wrap.append(grid)
  const sz = sizingRow(s)
  if (sz) wrap.append(sz)
  return wrap
}

function showEmpty(msg: string) {
  const e = $('empty')
  e.hidden = false
  e.textContent = msg
}

function setLive() {
  const d = state.data
  $('live-text').textContent = d ? `обновлено ${timeAgo(d.generatedAt)}` : 'нет данных'
}

function tick() {
  load().then(setLive)
}

setupGate(() => {
  $('app').hidden = false
  tick()
  setInterval(tick, 5 * 60 * 1000)
})
