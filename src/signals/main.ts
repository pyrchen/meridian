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
  horizon?: 'scalp' | 'mid' | 'long'
  horizonLabel?: string
  reasons: string[]
  indicators: { rsi: number; adx: number; macdHist: number }
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
    avgR: number
    avgWinDurationH: number
    avgEtaOpenH: number
  }
  open: Signal[]
  closed: Signal[]
}

const state = {
  data: null as SignalsData | null,
  mode: 'futures' as 'futures' | 'spot',
  horizon: 'all' as 'all' | 'scalp' | 'mid' | 'long',
  status: 'open' as 'open' | 'closed' | 'all',
  query: '',
}

function hz(s: Signal): 'scalp' | 'mid' | 'long' {
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
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} дн`
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
  // Фьючерсы — лонг и шорт; Спот — только покупка (лонг), без скальпа (спот = хранение)
  if (state.mode === 'spot') list = list.filter((s) => s.side === 'long' && hz(s) !== 'scalp')
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
  $('s-winrate').textContent = `${s.winRate}%`
  $('s-open').textContent = String(s.open)
  // фактический средний срок до тейка, пока нет закрытых — прогноз по открытым
  $('s-eta').textContent = s.avgWinDurationH
    ? fmtDur(s.avgWinDurationH)
    : '≈' + fmtDur(s.avgEtaOpenH)
  $('s-avgr').textContent = (s.avgR >= 0 ? '+' : '') + s.avgR + 'R'
  $('s-closed').textContent = `${s.wins} / ${s.losses}`
  $('s-universe').textContent = String(state.data!.universeSize)
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
  const spotList = base.filter((s) => s.side === 'long' && hz(s) !== 'scalp')

  seg(
    $('tabs'),
    [
      { key: 'futures', label: 'Фьючерсы', n: base.length },
      { key: 'spot', label: 'Спот · покупка', n: spotList.length },
    ],
    state.mode,
    (k) => {
      state.mode = k as typeof state.mode
      if (state.mode === 'spot' && state.horizon === 'scalp') state.horizon = 'all'
      renderControls()
      renderGrid()
    },
  )

  const modeList = state.mode === 'spot' ? spotList : base
  const n = (k: string) => modeList.filter((s) => hz(s) === k).length
  const hzItems: { key: string; label: string; n?: number }[] = [{ key: 'all', label: 'Все' }]
  if (state.mode === 'futures') hzItems.push({ key: 'scalp', label: 'Скальп', n: n('scalp') })
  hzItems.push({ key: 'mid', label: 'Средне', n: n('mid') }, { key: 'long', label: 'Долго', n: n('long') })
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
  const hzLabels: Record<string, string> = { scalp: 'Скальп · 1ч', mid: 'Средне · 4ч', long: 'Долго · 1д' }
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
    const pnl = s.pnlPct ?? 0
    foot.append(el('span', { class: `pnl ${pnl >= 0 ? 'up' : 'down'}` }, `${pnl >= 0 ? '+' : ''}${pnl}%`))
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
