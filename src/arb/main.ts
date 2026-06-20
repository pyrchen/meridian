import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/arbitrage.css'
import { registerSW } from 'virtual:pwa-register'
import {
  EXCHANGES,
  fetchAll,
  findOpportunities,
  type ExSnapshot,
  type Opportunity,
} from './exchanges'

registerSW({ immediate: true })

// ─────────────────────────────────────────────────────────────
// Код доступа. Клиентский замок (security-by-obscurity): сравниваем
// SHA-256 введённой фразы с хэшем ниже. Это НЕ серверная защита —
// хэш виден в коде. Меняй фразу: положи сюда sha256 своей, команда в README.
// Дефолтная фраза: "dawn-2026"
const ARB_PASS_SHA256 =
  '830b611571100cd45d48ad528285ef0aa707ae478bf43954a02cd0d38bbc5ac7'
const UNLOCK_KEY = 'meridian-arb-unlock'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function unlock() {
  $('gate').hidden = true
  $('term').hidden = false
  start()
}

function initGate() {
  if (sessionStorage.getItem(UNLOCK_KEY) === '1') {
    unlock()
    return
  }
  const form = $<HTMLFormElement>('gate-form')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const val = $<HTMLInputElement>('gate-pass').value
    const err = $('gate-err')
    if ((await sha256(val)) === ARB_PASS_SHA256) {
      try {
        sessionStorage.setItem(UNLOCK_KEY, '1')
      } catch {}
      unlock()
    } else {
      err.textContent = 'Неверный код'
      $<HTMLInputElement>('gate-pass').value = ''
    }
  })
}

// ─────────────────────────────────────────────────────────────
// Терминал
// HTX режет браузерный CORS из части origin'ов → по умолчанию выключена,
// остаётся опцией-тумблером (включишь — попробует, не выйдет → отметится offline).
const DEFAULT_EXCHANGES = ['binance', 'bybit', 'okx', 'bitget']

const state = {
  ids: EXCHANGES.filter((e) => DEFAULT_EXCHANGES.includes(e.id)).map((e) => e.id),
  timer: 0 as number | ReturnType<typeof setTimeout>,
}

function num(id: string, fallback: number): number {
  const v = parseFloat($<HTMLInputElement>(id).value)
  return Number.isFinite(v) ? v : fallback
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(3)
  if (n >= 0.01) return n.toFixed(5)
  return n.toPrecision(4)
}
function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

function buildExToggles() {
  const box = $('exs')
  box.replaceChildren()
  for (const e of EXCHANGES) {
    const b = document.createElement('button')
    b.className = 'ex-toggle'
    b.type = 'button'
    b.textContent = e.name
    b.setAttribute('aria-pressed', String(state.ids.includes(e.id)))
    b.dataset.ex = e.id
    b.onclick = () => {
      if (state.ids.includes(e.id)) state.ids = state.ids.filter((x) => x !== e.id)
      else state.ids.push(e.id)
      b.setAttribute('aria-pressed', String(state.ids.includes(e.id)))
      scan()
    }
    box.append(b)
  }
}

function setLive(text: string, stale = false) {
  $('live-text').textContent = text
  $('live').classList.toggle('is-stale', stale)
}

function netClass(net: number): string {
  if (net >= 2) return 'up'
  if (net > 0) return 'up'
  if (net === 0) return 'flat'
  return 'down'
}

function render(opps: Opportunity[], snaps: ExSnapshot[], pairs: number) {
  // статусы бирж
  for (const s of snaps) {
    const btn = document.querySelector<HTMLElement>(`.ex-toggle[data-ex="${s.id}"]`)
    if (btn) btn.dataset.status = s.tickers ? 'ok' : 'err'
  }
  const online = snaps.filter((s) => s.tickers).length

  $('s-pairs').textContent = pairs.toLocaleString('ru-RU')
  $('s-opps').textContent = String(opps.length)
  $('s-best').textContent = opps.length ? fmtPct(opps[0].net) : '—'
  $('s-ex').textContent = `${online}/${state.ids.length}`

  const rows = $('rows')
  const empty = $('term-empty')
  if (!opps.length) {
    rows.replaceChildren()
    empty.hidden = false
    empty.textContent = online
      ? 'Возможностей выше порога нет. Снизь «мин. спред» или подключи больше бирж.'
      : 'Биржи недоступны. Проверь соединение и нажми «Сканировать».'
    return
  }
  empty.hidden = true

  const frag = document.createDocumentFragment()
  for (const o of opps.slice(0, 80)) {
    const tr = document.createElement('tr')

    const c = document.createElement('td')
    const coin = document.createElement('span')
    coin.className = 'coin'
    coin.textContent = o.base
    c.append(coin, document.createTextNode(' /USDT'))
    tr.append(c)

    tr.append(venueCell(o.buyEx, o.buyAsk))
    tr.append(venueCell(o.sellEx, o.sellBid))

    const sp = document.createElement('td')
    const pill = document.createElement('span')
    pill.className = 'spread-pill ' + (o.gross >= 3 ? 'hot' : 'up')
    pill.textContent = fmtPct(o.gross)
    sp.append(pill)
    tr.append(sp)

    const net = document.createElement('td')
    net.className = 'net ' + netClass(o.net)
    net.textContent = fmtPct(o.net)
    tr.append(net)

    const cnt = document.createElement('td')
    cnt.textContent = String(o.count)
    tr.append(cnt)

    frag.append(tr)
  }
  rows.replaceChildren(frag)
}

function venueCell(ex: string, price: number): HTMLTableCellElement {
  const td = document.createElement('td')
  const span = document.createElement('span')
  span.className = 'venue'
  const b = document.createElement('b')
  b.textContent = ex
  span.append(b, document.createTextNode(' · ' + fmtPrice(price)))
  td.append(span)
  return td
}

async function scan() {
  if (!state.ids.length) {
    setLive('выбери биржу', true)
    render([], [], 0)
    return
  }
  clearTimeout(state.timer as ReturnType<typeof setTimeout>)
  setLive('сканирование…')
  const fee = num('fee', 0.1)
  const min = num('min', 0.5)
  const max = num('max', 50)

  const snaps = await fetchAll(state.ids)
  const pairs = new Set<string>()
  for (const s of snaps) if (s.tickers) for (const k of s.tickers.keys()) pairs.add(k)

  const opps = findOpportunities(snaps, fee).filter(
    (o) => o.gross >= min && o.gross <= max,
  )
  render(opps, snaps, pairs.size)

  const t = new Date()
  setLive(
    `обновлено ${String(t.getHours()).padStart(2, '0')}:${String(
      t.getMinutes(),
    ).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`,
  )

  if ($<HTMLInputElement>('auto').checked) {
    state.timer = setTimeout(scan, 20_000)
  }
}

function start() {
  buildExToggles()
  $('scan').addEventListener('click', scan)
  for (const id of ['fee', 'min', 'max']) {
    $(id).addEventListener('change', scan)
  }
  $('auto').addEventListener('change', () => {
    if ($<HTMLInputElement>('auto').checked) scan()
    else clearTimeout(state.timer as ReturnType<typeof setTimeout>)
  })
  scan()
}

// запуск после полной инициализации модуля (иначе TDZ при авто-разблокировке)
initGate()
