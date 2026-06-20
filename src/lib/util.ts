// Общие типы и утилиты Meridian.

export interface NewsItem {
  id: string
  title: string
  url: string
  source: string
  sourceWeight: number
  category: CategoryKey
  lang: string
  publishedAt: string | null
  summary: string
  image: string | null
  score: number
  sources: number // сколько источников освещают сюжет
  alsoIn: string[]
}

export interface NewsData {
  generatedAt: string
  sourceCount: number
  total: number
  categories: Record<string, NewsItem[]>
}

export type CategoryKey = 'crypto' | 'ai' | 'dev' | 'business'

export interface CatMeta {
  key: CategoryKey | 'all'
  label: string
  accent: string
}

export const CATEGORIES: CatMeta[] = [
  { key: 'all', label: 'Всё', accent: 'var(--first-light)' },
  { key: 'crypto', label: 'Крипта', accent: 'var(--c-crypto)' },
  { key: 'ai', label: 'ИИ', accent: 'var(--c-ai)' },
  { key: 'dev', label: 'Разработка', accent: 'var(--c-dev)' },
  { key: 'business', label: 'Бизнес', accent: 'var(--c-business)' },
]

export function catMeta(key: string): CatMeta {
  return CATEGORIES.find((c) => c.key === key) ?? CATEGORIES[0]
}

// — DOM —
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else node.setAttribute(k, v)
  }
  for (const c of children) node.append(c)
  return node
}

export function escapeHtml(s: string): string {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

// — Русская морфология чисел —
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return ''
  const s = Math.max(0, Math.round((now - d) / 1000))
  if (s < 60) return 'только что'
  const min = Math.round(s / 60)
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`
  const days = Math.round(h / 24)
  if (days === 1) return 'вчера'
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`
  const w = Math.round(days / 7)
  return `${w} ${plural(w, 'неделю', 'недели', 'недель')} назад`
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const WEEKDAYS = [
  'воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота',
]

export function formatToday(d = new Date()): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export function greeting(d = new Date()): { hi: string; em: string } {
  const h = d.getHours()
  if (h >= 5 && h < 12) return { hi: 'Доброе утро', em: '.' }
  if (h >= 12 && h < 18) return { hi: 'Добрый день', em: '.' }
  if (h >= 18 && h < 23) return { hi: 'Добрый вечер', em: '.' }
  return { hi: 'Доброй ночи', em: '.' }
}

export function clockText(d = new Date()): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// уровень transit (1..5) из числа источников
export function transitLevel(sources: number): number {
  if (sources <= 1) return 1
  if (sources === 2) return 2
  if (sources === 3) return 3
  if (sources === 4) return 4
  return 5
}
