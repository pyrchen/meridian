import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/news.css'
import { registerSW } from 'virtual:pwa-register'
import {
  CATEGORIES,
  catMeta,
  clockText,
  el,
  formatToday,
  greeting,
  timeAgo,
  transitLevel,
  type CategoryKey,
  type NewsData,
  type NewsItem,
} from '../lib/util'

registerSW({ immediate: true })

const BASE = import.meta.env.BASE_URL
const READ_KEY = 'meridian-read'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const state = {
  data: null as NewsData | null,
  cat: 'all' as CategoryKey | 'all',
  query: '',
  read: loadRead(),
}

function loadRead(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]'))
  } catch {
    return new Set()
  }
}
function markRead(id: string) {
  state.read.add(id)
  try {
    // храним последние 800 прочитанных
    localStorage.setItem(READ_KEY, JSON.stringify([...state.read].slice(-800)))
  } catch {}
}

// ── загрузка данных ──
async function load() {
  try {
    const res = await fetch(`${BASE}data/news.json?v=${Date.now()}`, {
      cache: 'no-cache',
    })
    if (!res.ok) throw new Error(String(res.status))
    state.data = (await res.json()) as NewsData
    renderAll()
  } catch (err) {
    if (state.data) return // уже что-то показано
    showState(
      'Лента недоступна',
      'Не удалось загрузить новости. Проверь соединение — последняя версия покажется из кэша, как только появится сеть.',
    )
  }
}

// ── выборки ──
function allItems(): NewsItem[] {
  const d = state.data
  if (!d) return []
  const seen = new Set<string>()
  const merged: NewsItem[] = []
  for (const list of Object.values(d.categories)) {
    for (const it of list) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      merged.push(it)
    }
  }
  return merged.sort((a, b) => b.score - a.score)
}

function scoped(): NewsItem[] {
  const d = state.data
  if (!d) return []
  let items = state.cat === 'all' ? allItems() : d.categories[state.cat] ?? []
  const q = state.query.trim().toLowerCase()
  if (q) {
    items = items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        it.summary.toLowerCase().includes(q) ||
        it.source.toLowerCase().includes(q),
    )
  }
  return items
}

function topStory(): NewsItem | null {
  return allItems()[0] ?? null
}

// ── рендер ──
function renderAll() {
  renderHero()
  renderTabs()
  renderFeed()
  renderFooter()
}

function renderHero() {
  const g = greeting()
  const greetEl = $('greet')
  greetEl.textContent = g.hi
  greetEl.append(el('em', {}, g.em))
  $('today').textContent = formatToday()
  tickClock()

  const d = state.data
  if (d) {
    const n = d.total
    $('tally').textContent = `${n} сюжетов · ${d.sourceCount} источников`
  }

  const top = topStory()
  const lede = $<HTMLAnchorElement>('lede')
  if (!top) {
    lede.hidden = true
    return
  }
  lede.hidden = false
  lede.href = top.url
  const cm = catMeta(top.category)
  const chip = $('lede-chip')
  chip.textContent = cm.label
  chip.style.setProperty('--accent', cm.accent)
  $('lede-title').textContent = top.title
  $('lede-sum').textContent = top.summary
  $('lede-src').textContent =
    top.source + (top.alsoIn.length ? ` + ещё ${top.alsoIn.length}` : '')
  $('lede-ago').textContent = timeAgo(top.publishedAt)
  renderTransit($('lede-transit'), top.sources)

  const img = $<HTMLImageElement>('lede-img')
  if (top.image) {
    img.src = top.image
    img.hidden = false
    img.onerror = () => lede.classList.add('lede--noimg')
    lede.classList.remove('lede--noimg')
  } else {
    img.hidden = true
    lede.classList.add('lede--noimg')
  }
  lede.onclick = () => markRead(top.id)
}

function renderTabs() {
  const wrap = $('tabs')
  wrap.replaceChildren()
  const d = state.data
  for (const cm of CATEGORIES) {
    const count =
      cm.key === 'all'
        ? allItems().length
        : (d?.categories[cm.key]?.length ?? 0)
    const tab = el('button', {
      class: 'tab',
      role: 'tab',
      'aria-selected': String(state.cat === cm.key),
    })
    tab.style.setProperty('--accent', cm.accent)
    if (cm.key !== 'all') tab.append(el('span', { class: 'tab__tick' }))
    tab.append(document.createTextNode(cm.label))
    tab.append(el('span', { class: 'tab__n' }, String(count)))
    tab.onclick = () => {
      state.cat = cm.key
      renderTabs()
      renderFeed()
      $('grid').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    wrap.append(tab)
  }

  // строка поиска (один раз)
  if (!document.getElementById('search-box')) {
    const box = el('label', { class: 'search', id: 'search-box' })
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>'
    const input = el('input', {
      type: 'search',
      placeholder: 'Поиск…',
      'aria-label': 'Поиск по новостям',
    }) as HTMLInputElement
    input.oninput = () => {
      state.query = input.value
      renderFeed()
    }
    box.append(input)
    wrap.append(box)
  } else {
    wrap.append(document.getElementById('search-box')!)
  }
}

function renderFeed() {
  const grid = $('grid')
  const items = scoped()
  if (!items.length) {
    grid.replaceChildren()
    showState(
      state.query ? 'Ничего не найдено' : 'Пусто',
      state.query
        ? 'По запросу нет новостей. Попробуй другое слово или сними фильтр.'
        : 'В этой категории пока нет свежих сюжетов.',
    )
    return
  }
  hideState()
  const frag = document.createDocumentFragment()
  items.forEach((it, i) => frag.append(card(it, i)))
  grid.replaceChildren(frag)
}

function card(it: NewsItem, i: number): HTMLElement {
  const cm = catMeta(it.category)
  const a = el('a', {
    class: 'card' + (state.read.has(it.id) ? ' is-read' : ''),
    href: it.url,
    target: '_blank',
    rel: 'noopener',
  })
  a.style.setProperty('--accent', cm.accent)
  a.style.animationDelay = `${Math.min(i * 22, 360)}ms`

  const main = el('div', { class: 'card__main' })

  const eyebrow = el('div', { class: 'card__eyebrow' })
  const chip = el('span', { class: 'chip' }, cm.label)
  eyebrow.append(chip)
  eyebrow.append(transit(it.sources))
  main.append(eyebrow)

  main.append(el('div', { class: 'card__title' }, it.title))
  if (it.summary) main.append(el('p', { class: 'card__sum' }, it.summary))

  const foot = el('div', { class: 'card__foot' })
  foot.append(el('span', { class: 'src' }, it.source))
  if (it.alsoIn.length)
    foot.append(
      el('span', { class: 'ago' }, `+${it.alsoIn.length} источн.`),
    )
  const ago = timeAgo(it.publishedAt)
  if (ago) foot.append(el('span', { class: 'ago' }, ago))
  main.append(foot)

  a.append(main)

  if (it.image) {
    const img = el('img', {
      class: 'card__thumb',
      alt: '',
      loading: 'lazy',
    }) as HTMLImageElement
    img.src = it.image
    img.onerror = () => img.remove()
    a.append(img)
  }

  a.addEventListener('click', () => {
    markRead(it.id)
    a.classList.add('is-read')
  })
  return a
}

function transit(sources: number): HTMLElement {
  const hint = `${sources} ${sources === 1 ? 'источник освещает' : sources < 5 ? 'источника освещают' : 'источников освещают'} сюжет`
  const t = el('span', { class: 'transit', role: 'img', 'aria-label': hint, title: hint })
  renderTransit(t, sources)
  return t
}
function renderTransit(node: HTMLElement, sources: number) {
  const lvl = transitLevel(sources)
  node.dataset.lvl = String(lvl)
  const hint = `${sources} ${sources === 1 ? 'источник освещает' : sources < 5 ? 'источника освещают' : 'источников освещают'} сюжет`
  node.title = hint
  node.setAttribute('aria-label', hint)
  node.replaceChildren()
  for (let k = 0; k < 5; k++) node.append(el('i'))
  if (sources > 1)
    node.append(el('span', { class: 'transit__label' }, `${sources}×`))
}

function renderFooter() {
  const d = state.data
  if (!d) return
  $('src-count').textContent = String(d.sourceCount)
  $('updated').textContent = timeAgo(d.generatedAt) || 'только что'
}

function showState(title: string, body: string) {
  const s = $('state')
  s.hidden = false
  s.replaceChildren(el('h3', {}, title), el('p', {}, body))
}
function hideState() {
  $('state').hidden = true
}

// ── часы ──
function tickClock() {
  $('clock').innerHTML = `◷ <b>${clockText()}</b>`
}
setInterval(tickClock, 30_000)

// ── тема ──
$('theme').addEventListener('click', () => {
  const root = document.documentElement
  const next = root.dataset.theme === 'light' ? 'dark' : 'light'
  root.dataset.theme = next
  try {
    localStorage.setItem('meridian-theme', next)
  } catch {}
})

$('refresh').addEventListener('click', () => {
  $('refresh').classList.add('spin')
  load().finally(() => $('refresh').classList.remove('spin'))
})

// первая отрисовка каркаса + загрузка
;(function boot() {
  const g = greeting()
  $('greet').textContent = g.hi
  $('greet').append(el('em', {}, g.em))
  $('today').textContent = formatToday()
  tickClock()
  // скелетоны
  const grid = $('grid')
  for (let i = 0; i < 6; i++) grid.append(el('div', { class: 'skeleton' }))
  load()
})()
