// Отчёт по SMC-слою: разбирает парные записи (базовый исход + исход слоя на ОДНОМ и том же
// сигнале) и считает метрики раздела 5 спеки docs/SMC_ENGINE_SPEC.md.
//
// Зачем отдельный скрипт, а не цифры внутри харнеса: сравнение avgNetR базы и слоя само по
// себе невалидно — слой, отменивший 90% сигналов и взявший лучшие 10%, покажет прекрасный
// средний R и почти нулевую суммарную прибыль. Решает вопрос бухгалтерия контрфактов:
// для каждого отменённого сигнала мы ЗНАЕМ, чем он закончился бы, потому что базовый исход
// считается всегда, независимо от решения слоя.
//
//   node scripts/smc-report.mjs [--tag=smcbase]

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BT_DIR = resolve(__dirname, '..', 'data', 'backtest')

const args = process.argv.slice(2)
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const TAG = flag('tag', 'smcbase')

const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0)
const f3 = (n) => (Number.isFinite(n) ? +n.toFixed(3) : null)

// Диспозиции из спеки. `taken*` — сделка состоялась, `skipped*` — нет.
const TAKEN = new Set(['taken_as_is', 'taken_improved', 'taken_deferred'])
const SKIPPED = new Set(['skipped_unfilled', 'skipped_veto'])

function pick(rec, ...names) {
  for (const n of names) if (rec[n] != null) return rec[n]
  return null
}

function normalise(rec) {
  // Терпимо к именованию: реализацию писал отдельный агент, а ломать отчёт из-за синонима
  // поля — плохой размен.
  return {
    disposition: pick(rec, 'disposition', 'action', 'smcAction'),
    horizon: pick(rec, 'horizon') || 'mid',
    side: pick(rec, 'side'),
    baseNetR: pick(rec, 'baseNetR', 'baseR', 'netR_base'),
    smcNetR: pick(rec, 'smcNetR', 'smcR', 'netR_smc'),
    baseNetPnlPct: pick(rec, 'baseNetPnlPct', 'baseNetPnl'),
    smcNetPnlPct: pick(rec, 'smcNetPnlPct', 'smcNetPnl'),
    baseStatus: pick(rec, 'baseStatus'),
    smcStatus: pick(rec, 'smcStatus'),
  }
}

function block(title, rows) {
  console.log(`\n=== ${title} ===`)
  for (const [k, v] of rows) console.log(`${String(k).padEnd(42)} ${v}`)
}

async function main() {
  const path = resolve(BT_DIR, `smc-${TAG}.json`)
  if (!existsSync(path)) {
    console.error(`Нет ${path} — сначала прогони харнес с --smc=refine --tag=${TAG}.`)
    process.exit(1)
  }
  const raw = JSON.parse(await readFile(path, 'utf8'))
  const records = (Array.isArray(raw) ? raw : raw.records || raw.signals || []).map(normalise)
  if (!records.length) {
    console.error('Файл прочитан, но записей нет — проверь формат вывода харнеса.')
    process.exit(1)
  }

  // 1) Диспозиции
  const byDisp = {}
  for (const r of records) (byDisp[r.disposition || 'unknown'] ||= []).push(r)
  block(
    'Диспозиции',
    Object.entries(byDisp)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, v]) => [k, `${v.length}  (${((v.length / records.length) * 100).toFixed(1)}%)`]),
  )

  // 2) Контрфакты по отменённым: что база заработала бы на сигналах, которые слой не взял.
  // Отрицательная сумма по veto = вето полезно. Положительная = слой режет прибыль.
  const vetoed = (byDisp.skipped_veto || []).filter((r) => r.baseNetR != null)
  const unfilled = (byDisp.skipped_unfilled || []).filter((r) => r.baseNetR != null)
  block('Контрфакты по невзятым сигналам', [
    ['вето: n', vetoed.length],
    ['вето: Σ baseNetR (избежано)', f3(sum(vetoed.map((r) => r.baseNetR)))],
    ['вето: avg baseNetR', f3(mean(vetoed.map((r) => r.baseNetR)))],
    ['лимитник не заполнен: n', unfilled.length],
    ['лимитник не заполнен: Σ baseNetR (упущено)', f3(sum(unfilled.map((r) => r.baseNetR)))],
    ['лимитник не заполнен: avg baseNetR', f3(mean(unfilled.map((r) => r.baseNetR)))],
  ])

  // 3) Дельта на пересечении — сигналы, взятые ОБОИМИ. Свободна от эффекта отбора:
  // состав одинаков, разница только в стопе/цели/цене входа.
  const both = records.filter((r) => TAKEN.has(r.disposition) && r.baseNetR != null && r.smcNetR != null)
  const dBase = sum(both.map((r) => r.baseNetR))
  const dSmc = sum(both.map((r) => r.smcNetR))
  block('Дельта на пересечении (взяты обоими)', [
    ['n', both.length],
    ['Σ baseNetR', f3(dBase)],
    ['Σ smcNetR', f3(dSmc)],
    ['дельта', f3(dSmc - dBase)],
    ['avg baseNetR', f3(mean(both.map((r) => r.baseNetR)))],
    ['avg smcNetR', f3(mean(both.map((r) => r.smcNetR)))],
  ])

  // Разбивка дельты по типу вмешательства — какой из механизмов реально работает.
  for (const d of ['taken_as_is', 'taken_improved', 'taken_deferred']) {
    const arr = both.filter((r) => r.disposition === d)
    if (!arr.length) continue
    const b = sum(arr.map((r) => r.baseNetR))
    const s = sum(arr.map((r) => r.smcNetR))
    console.log(`  ${d.padEnd(20)} n=${String(arr.length).padStart(4)}  Σbase=${f3(b)}  Σsmc=${f3(s)}  дельта=${f3(s - b)}`)
  }

  // 4) Итог по потокам. Главная цифра вердикта — суммарный netR, а не средний:
  // средний растёт от простого сокращения потока и сам по себе ничего не доказывает.
  const baseAll = records.filter((r) => r.baseNetR != null)
  const smcAll = records.filter((r) => TAKEN.has(r.disposition) && r.smcNetR != null)
  const baseTotal = sum(baseAll.map((r) => r.baseNetR))
  const smcTotal = sum(smcAll.map((r) => r.smcNetR))
  const flowDrop = baseAll.length ? (1 - smcAll.length / baseAll.length) * 100 : 0
  block('Итог по потокам', [
    ['база: сделок', baseAll.length],
    ['база: Σ netR', f3(baseTotal)],
    ['база: avg netR', f3(mean(baseAll.map((r) => r.baseNetR)))],
    ['SMC: сделок', smcAll.length],
    ['SMC: Σ netR', f3(smcTotal)],
    ['SMC: avg netR', f3(mean(smcAll.map((r) => r.smcNetR)))],
    ['изменение Σ netR', f3(smcTotal - baseTotal)],
    ['сокращение потока', `${flowDrop.toFixed(1)}%`],
  ])

  // 5) Вердикт по критерию спеки: рост суммарного netR при падении потока не более чем вдвое.
  const better = smcTotal > baseTotal
  const flowOk = flowDrop <= 50
  const verdict = better && flowOk ? 'УЛУЧШЕНИЕ' : better && !flowOk ? 'РОСТ ПРИ ОБВАЛЕ ПОТОКА — не засчитывается' : 'УХУДШЕНИЕ'
  block('Вердикт', [
    ['суммарный netR вырос', better ? 'да' : 'нет'],
    ['поток сократился не более чем вдвое', flowOk ? 'да' : `нет (${flowDrop.toFixed(1)}%)`],
    ['ИТОГ', verdict],
  ])

  // По горизонтам и сторонам — чтобы увидеть, не держится ли общий плюс одним срезом.
  console.log('\n=== По стратам ===')
  const strata = {}
  for (const r of records) (strata[`${r.horizon}:${r.side}`] ||= []).push(r)
  for (const [key, arr] of Object.entries(strata)) {
    const b = arr.filter((r) => r.baseNetR != null)
    const s = arr.filter((r) => TAKEN.has(r.disposition) && r.smcNetR != null)
    console.log(
      `${key.padEnd(14)} база n=${String(b.length).padStart(4)} Σ=${String(f3(sum(b.map((r) => r.baseNetR)))).padStart(9)} | ` +
        `SMC n=${String(s.length).padStart(4)} Σ=${String(f3(sum(s.map((r) => r.smcNetR)))).padStart(9)} | ` +
        `дельта ${f3(sum(s.map((r) => r.smcNetR)) - sum(b.map((r) => r.baseNetR)))}`,
    )
  }

  const out = {
    generatedAt: null, // проставляется вызывающим — скрипт детерминирован
    tag: TAG,
    records: records.length,
    dispositions: Object.fromEntries(Object.entries(byDisp).map(([k, v]) => [k, v.length])),
    counterfactual: {
      vetoSumBaseNetR: f3(sum(vetoed.map((r) => r.baseNetR))),
      vetoN: vetoed.length,
      unfilledSumBaseNetR: f3(sum(unfilled.map((r) => r.baseNetR))),
      unfilledN: unfilled.length,
    },
    intersection: { n: both.length, sumBase: f3(dBase), sumSmc: f3(dSmc), delta: f3(dSmc - dBase) },
    totals: {
      baseN: baseAll.length, baseSumNetR: f3(baseTotal),
      smcN: smcAll.length, smcSumNetR: f3(smcTotal),
      deltaSumNetR: f3(smcTotal - baseTotal), flowDropPct: +flowDrop.toFixed(1),
    },
    verdict,
  }
  const outPath = resolve(BT_DIR, `smc-report-${TAG}.json`)
  await writeFile(outPath, JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nОтчёт записан в ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
