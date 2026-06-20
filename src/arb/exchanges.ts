// Адаптеры публичных market-data API бирж для клиентского арбитражного сканера.
// Берём только биржи, разрешающие CORS из браузера и отдающие bid/ask по ВСЕМ
// спот-парам одним запросом (проверено research-агентом). KuCoin / Gate / MEXC
// блокируют CORS → в статике без прокси недоступны; Coinbase не даёт all-tickers
// с bid/ask. Сравниваем по USDT-парам — единый, ликвидный знаменатель.

export interface Quote {
  bid: number // лучшая цена покупки у нас → по ней мы ПРОДАЁМ
  ask: number // лучшая цена продажи у нас → по ней мы ПОКУПАЕМ
  last: number
}

export interface ExMeta {
  id: string
  name: string
  url: string
  parse: (raw: unknown) => Map<string, Quote>
}

const TIMEOUT = 9000

export async function getJSON(url: string): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

// Левериджные токены и битые тикеры — мимо.
const EXCLUDE = /(\d+[LS]|UP|DOWN|BULL|BEAR|3L|3S|5L|5S)$/

function put(m: Map<string, Quote>, base: string, bid: number, ask: number, last: number) {
  base = base.toUpperCase()
  if (!base || EXCLUDE.test(base)) return
  bid = +bid
  ask = +ask
  last = +last || (bid + ask) / 2
  if (!(bid > 0) || !(ask > 0)) return
  if (ask < bid) return // перекрещенный/битый стакан
  m.set(base, { bid, ask, last })
}

export const EXCHANGES: ExMeta[] = [
  {
    id: 'binance',
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/bookTicker',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      for (const t of raw as any[]) {
        if (typeof t.symbol !== 'string' || !t.symbol.endsWith('USDT')) continue
        put(m, t.symbol.slice(0, -4), t.bidPrice, t.askPrice, 0)
      }
      return m
    },
  },
  {
    id: 'bybit',
    name: 'Bybit',
    url: 'https://api.bybit.com/v5/market/tickers?category=spot',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      const list = (raw as any)?.result?.list ?? []
      for (const t of list) {
        if (typeof t.symbol !== 'string' || !t.symbol.endsWith('USDT')) continue
        put(m, t.symbol.slice(0, -4), t.bid1Price, t.ask1Price, t.lastPrice)
      }
      return m
    },
  },
  {
    id: 'okx',
    name: 'OKX',
    url: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      for (const t of (raw as any)?.data ?? []) {
        if (typeof t.instId !== 'string' || !t.instId.endsWith('-USDT')) continue
        put(m, t.instId.slice(0, -5), t.bidPx, t.askPx, t.last)
      }
      return m
    },
  },
  {
    id: 'bitget',
    name: 'Bitget',
    url: 'https://api.bitget.com/api/v2/spot/market/tickers',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      for (const t of (raw as any)?.data ?? []) {
        if (typeof t.symbol !== 'string' || !t.symbol.endsWith('USDT')) continue
        put(m, t.symbol.slice(0, -4), t.bidPr, t.askPr, t.lastPr)
      }
      return m
    },
  },
  {
    id: 'htx',
    name: 'HTX',
    url: 'https://api.huobi.pro/market/tickers',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      for (const t of (raw as any)?.data ?? []) {
        if (typeof t.symbol !== 'string' || !t.symbol.endsWith('usdt')) continue
        put(m, t.symbol.slice(0, -4), t.bid, t.ask, t.close)
      }
      return m
    },
  },
  {
    id: 'kraken',
    name: 'Kraken',
    url: 'https://api.kraken.com/0/public/Ticker',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      const res = (raw as any)?.result ?? {}
      const NORM: Record<string, string> = { XBT: 'BTC', XDG: 'DOGE' }
      for (const [key, t] of Object.entries(res) as [string, any][]) {
        if (!key.endsWith('USDT') || key.includes('.')) continue
        const base = NORM[key.slice(0, -4)] || key.slice(0, -4)
        put(m, base, t.b?.[0], t.a?.[0], t.c?.[0])
      }
      return m
    },
  },
  {
    id: 'cryptocom',
    name: 'Crypto.com',
    url: 'https://api.crypto.com/exchange/v1/public/get-tickers',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      const arr = (raw as any)?.result?.data ?? (raw as any)?.result ?? []
      for (const t of arr) {
        if (typeof t.i !== 'string' || !t.i.endsWith('_USDT')) continue
        // i=instrument, b=bid, k=ask, a=last
        put(m, t.i.slice(0, -5), t.b, t.k, t.a)
      }
      return m
    },
  },
  {
    id: 'bitmart',
    name: 'BitMart',
    url: 'https://api-cloud.bitmart.com/spot/quotation/v3/tickers',
    parse: (raw) => {
      const m = new Map<string, Quote>()
      const arr = (raw as any)?.data ?? []
      // row: [symbol, last, v24, qv24, open, high, low, fluct, bid, bidSz, ask, askSz, ts]
      for (const row of arr) {
        const sym = row[0]
        if (typeof sym !== 'string' || !sym.endsWith('_USDT')) continue
        put(m, sym.slice(0, -5), row[8], row[10], row[1])
      }
      return m
    },
  },
]

export interface ExSnapshot {
  id: string
  name: string
  tickers: Map<string, Quote> | null
  error?: string
}

export async function fetchAll(ids: string[]): Promise<ExSnapshot[]> {
  const chosen = EXCHANGES.filter((e) => ids.includes(e.id))
  return Promise.all(
    chosen.map(async (e): Promise<ExSnapshot> => {
      try {
        const raw = await getJSON(e.url)
        const tickers = e.parse(raw)
        if (!tickers.size) throw new Error('пустой ответ')
        return { id: e.id, name: e.name, tickers }
      } catch (err) {
        return {
          id: e.id,
          name: e.name,
          tickers: null,
          error: err instanceof Error ? err.message : 'ошибка',
        }
      }
    }),
  )
}

export interface Opportunity {
  base: string
  buyEx: string
  buyAsk: number
  sellEx: string
  sellBid: number
  gross: number // спред до комиссий, %
  net: number // после двух тейкер-комиссий, %
  count: number // на скольких биржах есть пара
}

export function findOpportunities(
  snaps: ExSnapshot[],
  feePct: number,
): Opportunity[] {
  // base → [{exName, q}]
  const byBase = new Map<string, { ex: string; q: Quote }[]>()
  for (const s of snaps) {
    if (!s.tickers) continue
    for (const [base, q] of s.tickers) {
      ;(byBase.get(base) ?? byBase.set(base, []).get(base)!).push({
        ex: s.name,
        q,
      })
    }
  }

  const out: Opportunity[] = []
  for (const [base, rows] of byBase) {
    if (rows.length < 2) continue
    let buy = rows[0]
    let sell = rows[0]
    for (const r of rows) {
      if (r.q.ask < buy.q.ask) buy = r
      if (r.q.bid > sell.q.bid) sell = r
    }
    if (buy.ex === sell.ex) continue // покупка и продажа на одной бирже — не арбитраж
    const gross = ((sell.q.bid - buy.q.ask) / buy.q.ask) * 100
    if (!Number.isFinite(gross)) continue
    out.push({
      base,
      buyEx: buy.ex,
      buyAsk: buy.q.ask,
      sellEx: sell.ex,
      sellBid: sell.q.bid,
      gross,
      net: gross - 2 * feePct,
      count: rows.length,
    })
  }
  out.sort((a, b) => b.net - a.net)
  return out
}
