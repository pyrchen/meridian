import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/arbitrage.css'
import '../styles/signals.css'
import { registerSW } from 'virtual:pwa-register'
import { setupGate } from '../lib/gate'
import { el, timeAgo } from '../lib/util'

registerSW({ immediate: true })

const BASE = import.meta.env.BASE_URL
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
  reasons: string[]
  indicators: { rsi: number; adx: number; macdHist: number }
  timeframe: string
  createdAt: string
  status: 'open' | 'tp' | 'sl' | 'expired'
  exitPrice?: number
  closedAt?: string
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
    totalPnlPct: number
  }
  open: Signal[]
  closed: Signal[]
}

const state = {
  data: null as SignalsData | null,
  tab: 'open' as 'open' | 'closed' | 'all',
  side: 'all' as 'all' | 'long' | 'short',
  query: '',
}

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.01) return n.toFixed(6)
  return n.toPrecision(4)
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
    showEmpty(
      'Сигналы ещё не готовы. Анализатор запускается по расписанию (каждые ~30 мин) — загляни чуть позже.',
    )
  }
}

function scoped(): Signal[] {
  const d = state.data
  if (!d) return []
  let list: Signal[] =
    state.tab === 'open' ? d.open : state.tab === 'closed' ? d.closed : [...d.open, ...d.closed]
  if (state.side !== 'all') list = list.filter((s) => s.side === state.side)
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
  $('s-avgr').textContent = (s.avgR >= 0 ? '+' : '') + s.avgR + 'R'
  $('s-closed').textContent = `${s.wins}W / ${s.losses}L`
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

function renderControls() {
  const d = state.data!
  seg(
    $('tabs'),
    [
      { key: 'open', label: 'Открытые', n: d.open.length },
      { key: 'closed', label: 'Закрытые', n: d.closed.length },
      { key: 'all', label: 'Все', n: d.open.length + d.closed.length },
    ],
    state.tab,
    (k) => {
      state.tab = k as typeof state.tab
      renderControls()
      renderGrid()
    },
  )
  seg(
    $('sides'),
    [
      { key: 'all', label: 'Все' },
      { key: 'long', label: 'Лонг' },
      { key: 'short', label: 'Шорт' },
    ],
    state.side,
    (k) => {
      state.side = k as typeof state.side
      renderControls()
      renderGrid()
    },
  )
  if (!($('q') as HTMLInputElement).oninput) {
    ;($('q') as HTMLInputElement).oninput = (e) => {
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
    showEmpty(
      state.query ? 'Ничего не найдено.' : 'В этой вкладке пока пусто.',
    )
    return
  }
  $('empty').hidden = true
  const frag = document.createDocumentFragment()
  items.forEach((s, i) => frag.append(card(s, i)))
  grid.replaceChildren(frag)
}

function card(s: Signal, i: number): HTMLElement {
  const isOpen = s.status === 'open'
  const c = el('article', { class: `sig-card ${s.side}${isOpen ? '' : ' closed'}` })
  c.style.animationDelay = `${Math.min(i * 20, 320)}ms`

  // шапка
  const head = el('div', { class: 'sig-head' })
  const coin = el('div', { class: 'sig-coin' }, s.base)
  coin.append(el('span', {}, ' /USDT'))
  head.append(coin)
  head.append(el('span', { class: `badge ${s.side}` }, s.side === 'long' ? 'Лонг' : 'Шорт'))
  for (const mk of s.markets)
    head.append(el('span', { class: 'mkt' }, mk === 'spot' ? 'спот' : 'фьюч'))
  const str = el('div', { class: 'sig-strength' })
  str.append(el('b', {}, String(s.strength)))
  str.append(el('span', {}, 'сила'))
  head.append(str)
  c.append(head)

  // уровни
  const lv = el('div', { class: 'sig-levels' })
  lv.append(levelCell('Вход', fmt(s.entry), ''))
  lv.append(levelCell('Стоп', fmt(s.sl), `−${s.riskPct}%`, 'sl'))
  lv.append(levelCell('Тейк', fmt(s.tp), `+${s.targetPct}%`, 'tp'))
  c.append(lv)

  // причины (до 4)
  const why = el('ul', { class: 'sig-why' })
  for (const r of s.reasons.slice(0, 4)) why.append(el('li', {}, r))
  c.append(why)

  // подвал
  const foot = el('div', { class: 'sig-foot' })
  if (isOpen) {
    foot.append(el('span', {}, `сигнал ${timeAgo(s.createdAt)}`))
    foot.append(el('span', { class: 'mkt' }, `RSI ${s.indicators.rsi} · ADX ${s.indicators.adx}`))
  } else {
    const label = s.status === 'tp' ? 'Тейк взят' : s.status === 'sl' ? 'Стоп' : 'Истёк'
    foot.append(el('span', { class: `outcome ${s.status}` }, label))
    foot.append(el('span', {}, timeAgo(s.closedAt!)))
    const pnl = s.pnlPct ?? 0
    foot.append(
      el('span', { class: `pnl ${pnl >= 0 ? 'up' : 'down'}` }, `${pnl >= 0 ? '+' : ''}${pnl}%`),
    )
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
  setInterval(tick, 5 * 60 * 1000) // подтягиваем свежие сигналы каждые 5 мин
})
