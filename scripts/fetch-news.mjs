// Meridian news scraper.
// Запускается в GitHub Actions по расписанию (и при деплое): тянет RSS-фиды из
// scripts/sources.json, нормализует, кластеризует похожие сюжеты (для оценки
// «значимости» по числу источников), ранжирует и пишет public/data/news.json.
//
// Зависимости: rss-parser (devDependency). Сетевой доступ — server-side, поэтому
// CORS браузера здесь не мешает.

import Parser from 'rss-parser'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SOURCES_PATH = resolve(__dirname, 'sources.json')
const OUT_PATH = resolve(ROOT, 'public', 'data', 'news.json')

// --- настройки ранжирования ---
const PER_CATEGORY = 70 // сколько новостей оставляем в категории
const MAX_AGE_HOURS = 96 // старше — отбрасываем
const HALF_LIFE_HOURS = 20 // период полураспада «свежести»
const SIM_THRESHOLD = 0.28 // порог Жаккара для объединения сюжетов

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent':
      'MeridianNewsBot/1.0 (+https://github.com; personal news digest)',
    Accept:
      'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'creator'],
    ],
  },
})

const STOPWORDS = new Set([
  // EN
  'the','a','an','and','or','for','from','with','this','that','will','have','has',
  'are','was','were','its','his','her','their','they','you','your','our','out','about',
  'into','over','after','before','what','when','how','why','who','new','now','says','said',
  'amid','more','than','but','not','can','could','would','should','may','might','one','two',
  // RU
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его',
  'но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от',
  'меня','еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг','ли','если','уже',
  'или','ни','быть','был','него','до','вас','будет','для','про','это','этот','эта','как-то',
])

function normalizeTokens(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[«»"'`’“”(),.:;!?\-—–\/\\|\[\]{}]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  )
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

function hashId(url, title) {
  return createHash('sha1')
    .update((url || '') + '|' + (title || ''))
    .digest('hex')
    .slice(0, 16)
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractImage(item) {
  // media:content / media:thumbnail / enclosure / первый <img> в контенте
  const mc = item.mediaContent
  if (Array.isArray(mc)) {
    for (const m of mc) {
      const u = m?.$?.url
      if (u && /^https?:\/\//.test(u)) return u
    }
  } else if (mc?.$?.url) {
    return mc.$.url
  }
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url
  if (item.enclosure?.url && /^image\//.test(item.enclosure.type || ''))
    return item.enclosure.url
  if (item.enclosure?.url && /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.url))
    return item.enclosure.url
  const html = item.contentEncoded || item['content:encoded'] || item.content || ''
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i)
  if (m && /^https?:\/\//.test(m[1])) return m[1]
  return null
}

function cleanSummary(item) {
  const raw =
    item.contentSnippet ||
    stripHtml(item.summary || item.content || item.contentEncoded || '')
  let s = stripHtml(raw)
  // HN/агрегаторы кладут в description служебный мусор — заголовок самодостаточен
  if (/Comments URL:|Article URL:/i.test(s)) return ''
  s = s.replace(/^\s*(Read more|Continue reading).*$/i, '').trim()
  if (s.length <= 300) return s
  return s.slice(0, 297).replace(/\s+\S*$/, '') + '…'
}

const FEED_TIMEOUT = 12000

// Своя загрузка с жёстким abort — rss-parser.parseURL иногда не прерывает
// зависший сокет, из-за чего Promise.allSettled может не завершиться (CI-hang).
async function fetchText(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FEED_TIMEOUT)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'MeridianNewsBot/1.0 (+https://github.com; personal news digest)',
        Accept:
          'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function fetchSource(src) {
  try {
    const xml = await fetchText(src.url)
    const feed = await parser.parseString(xml)
    const items = (feed.items || []).map((it) => {
      const url = (it.link || it.guid || '').trim()
      const title = stripHtml(it.title || '').trim()
      const publishedAt = it.isoDate || it.pubDate || null
      return {
        id: hashId(url, title),
        title,
        url,
        source: src.name,
        sourceWeight: src.weight ?? 5,
        category: src.category,
        lang: src.lang || 'en',
        publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
        summary: cleanSummary(it),
        image: extractImage(it),
      }
    })
    console.log(`  ✓ ${src.name}: ${items.length}`)
    return items
  } catch (err) {
    console.warn(`  ✗ ${src.name} (${src.url}): ${err.message}`)
    return []
  }
}

function recencyScore(publishedAt, now) {
  if (!publishedAt) return 0.15
  const ageH = (now - new Date(publishedAt).getTime()) / 3.6e6
  if (ageH < 0) return 1
  return Math.exp(-ageH / HALF_LIFE_HOURS)
}

// Кластеризация похожих заголовков → один сюжет, освещённый N источниками.
function clusterByTitle(items) {
  const clusters = [] // { tokens, members: [item] }
  for (const it of items) {
    const tokens = normalizeTokens(it.title)
    let best = null
    let bestSim = 0
    for (const c of clusters) {
      const sim = jaccard(tokens, c.tokens)
      if (sim > bestSim) {
        bestSim = sim
        best = c
      }
    }
    if (best && bestSim >= SIM_THRESHOLD) {
      best.members.push(it)
      // расширяем словарь кластера
      for (const t of tokens) best.tokens.add(t)
    } else {
      clusters.push({ tokens, members: [it] })
    }
  }
  return clusters
}

function rankCategory(items, now) {
  // фильтр по возрасту + дедуп по URL
  const seenUrl = new Map()
  const fresh = []
  for (const it of items) {
    if (!it.title || !it.url) continue
    if (it.publishedAt) {
      const ageH = (now - new Date(it.publishedAt).getTime()) / 3.6e6
      if (ageH > MAX_AGE_HOURS) continue
    }
    const key = it.url.replace(/[?#].*$/, '').toLowerCase()
    const prev = seenUrl.get(key)
    if (!prev || it.sourceWeight > prev.sourceWeight) seenUrl.set(key, it)
  }
  for (const it of seenUrl.values()) fresh.push(it)

  const clusters = clusterByTitle(fresh)
  const maxCluster = Math.max(1, ...clusters.map((c) => c.members.length))

  const scored = []
  for (const c of clusters) {
    const distinctSources = new Set(c.members.map((m) => m.source)).size
    // лучший представитель кластера = свежайший от самого авторитетного источника
    const rep = c.members
      .slice()
      .sort(
        (a, b) =>
          b.sourceWeight - a.sourceWeight ||
          (new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)),
      )[0]
    const corroboration = (distinctSources - 1) / Math.max(1, maxCluster - 1)
    const score =
      0.4 * recencyScore(rep.publishedAt, now) +
      0.35 * (rep.sourceWeight / 10) +
      0.25 * corroboration
    scored.push({
      ...rep,
      score: Number(score.toFixed(4)),
      sources: distinctSources,
      alsoIn: [...new Set(c.members.map((m) => m.source))].filter(
        (s) => s !== rep.source,
      ),
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, PER_CATEGORY)
}

async function main() {
  // последний рубеж против зависания (на случай нештатной сети в CI)
  const watchdog = setTimeout(() => {
    console.error('Watchdog: сбор превысил 100с — аварийный выход')
    process.exit(1)
  }, 100_000)

  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'))
  const enabled = sources.filter((s) => s.enabled !== false)
  console.log(`Fetching ${enabled.length} feeds…`)

  const settled = await Promise.allSettled(enabled.map(fetchSource))
  const all = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))

  const now = Date.now()
  const byCat = {}
  for (const it of all) (byCat[it.category] ||= []).push(it)

  const categories = {}
  for (const [cat, items] of Object.entries(byCat)) {
    categories[cat] = rankCategory(items, now)
  }

  const total = Object.values(categories).reduce((n, a) => n + a.length, 0)
  const out = {
    generatedAt: new Date(now).toISOString(),
    sourceCount: enabled.length,
    total,
    categories,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(out), 'utf8')
  console.log(`\nWrote ${total} items across ${Object.keys(categories).length} categories → ${OUT_PATH}`)

  clearTimeout(watchdog)
  process.exit(0) // undici keep-alive pool иначе может задержать выход
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
