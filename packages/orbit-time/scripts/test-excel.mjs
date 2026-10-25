#!/usr/bin/env node
/**
 * Excel pipeline check: generate a realistic roster workbook, run
 * `lib/parse-xlsx.py` over it through the same spawn path the host uses, and
 * assert the normalization and owner filtering behave as designed.
 *
 * Run: node scripts/test-excel.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const PYTHON =
  process.env.DSH_PYTHON ||
  join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')

if (!existsSync(PYTHON)) {
  console.error(`python not found at ${PYTHON}; set DSH_PYTHON to override`)
  process.exit(1)
}

const failures = []
function check(label, fn) {
  try {
    const detail = fn()
    console.log(`  ok   ${label}${detail === undefined ? '' : ' — ' + detail}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}: ${error.message}`)
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'orbit-time-excel-'))
const workbook = join(workDir, 'sample-schedule.xlsx')

function runPython(script, args) {
  const result = spawnSync(PYTHON, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    // The parser pins its own stdout to UTF-8; the fixture generators print the
    // path they wrote, which is Chinese in this repo's own fixtures.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.error) throw result.error
  return result
}

console.log('orbit-time Excel pipeline check')
console.log(`  python: ${PYTHON}`)

check('sample workbook generated', () => {
  const result = runPython(join(root, 'scripts', 'make-sample.py'), [workbook])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  if (!existsSync(workbook)) throw new Error('workbook missing')
  return workbook
})

let parsed = null
check('parser returns a well-formed payload', () => {
  const result = runPython(join(root, 'lib', 'parse-xlsx.py'), [workbook, JSON.stringify({ previewRows: 4 })])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  parsed = JSON.parse(result.stdout)
  if (parsed.ok !== true) throw new Error(parsed.error || 'ok was not true')
  return `sheet=${parsed.sheet} headerRow=${parsed.headerRow} rows=${parsed.rowCount}`
})

check('header row detected below the title block', () => {
  if (parsed.headerRow !== 3) throw new Error(`expected header row 3, got ${parsed.headerRow}`)
  const texts = parsed.headers.map((header) => header.text).join(',')
  if (!texts.includes('姓名')) throw new Error(`headers look wrong: ${texts}`)
  return texts
})

check('columns mapped to stable fields', () => {
  const expected = {
    date: '日期',
    start: '开始时间',
    end: '结束时间',
    title: '事项',
    person: '姓名',
    location: '地点',
    notes: '备注',
  }
  for (const [field, header] of Object.entries(expected)) {
    if (parsed.mapping[field] !== header) {
      throw new Error(`field ${field} mapped to ${JSON.stringify(parsed.mapping[field])}, expected ${header}`)
    }
  }
  return Object.entries(parsed.mapping).map(([k, v]) => `${k}=${v}`).join(' ')
})

check('the wrong sheet was not chosen', () => {
  if (parsed.sheet !== '总课表') throw new Error(`chose ${parsed.sheet}`)
  if (!parsed.sheets.includes('说明')) throw new Error('second sheet not reported')
  return parsed.sheets.join(' / ')
})

check('dates and times normalized to ISO/HH:MM', () => {
  for (const row of parsed.rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error(`bad date ${JSON.stringify(row.date)} on row ${row._row}`)
    if (row.start !== '' && !/^\d{2}:\d{2}$/.test(row.start)) throw new Error(`bad start ${JSON.stringify(row.start)} on row ${row._row}`)
  }
  return `${parsed.rows.length} rows normalized`
})

check('a time-only cell with a stray date prefix is split', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '高等数学 A')
  if (!row) throw new Error('高等数学 A row missing')
  if (row.start !== '09:00') throw new Error(`start is ${row.start}`)
  return `${row.date} ${row.start}-${row.end}`
})

check('native datetime cells parse', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '线性代数')
  if (!row) throw new Error('线性代数 row missing')
  if (row.start !== '13:30' || row.end !== '15:00') throw new Error(`${row.start}-${row.end}`)
  return `${row.start}-${row.end}`
})

check('上午/下午 prefixes convert to 24h', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '教研活动')
  if (!row) throw new Error('教研活动 row missing')
  if (row.start !== '09:30') throw new Error(`start is ${row.start}`)
  return row.start
})

check('merged date block carries the date forward', () => {
  const training = parsed.rows.filter((candidate) => String(candidate.title).startsWith('集中培训'))
  if (training.length !== 3) throw new Error(`expected 3 training rows, got ${training.length}`)
  const dates = new Set(training.map((row) => row.date))
  if (dates.size !== 1) throw new Error(`training rows disagree on the date: ${[...dates].join(', ')}`)
  const borrowed = training.filter((row) => row._warnings.some((warning) => warning.includes('沿用')))
  if (borrowed.length !== training.length - 1) {
    throw new Error(`expected 2 rows to inherit the date, got ${borrowed.length}`)
  }
  return `${[...dates][0]} across ${training.length} rows`
})

check('a missing end time is left open for the host to derive', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '客户拜访')
  if (!row) throw new Error('客户拜访 row missing')
  if (row.end !== '') throw new Error(`end should be empty, got ${row.end}`)
  return 'end empty'
})

check('unmapped columns are preserved per row', () => {
  if (!parsed.unmapped.includes('签到码')) throw new Error(`签到码 was not reported unmapped: ${JSON.stringify(parsed.unmapped)}`)
  const row = parsed.rows.find((candidate) => candidate.title === '高等数学 A')
  if (!row.extras || row.extras['签到码'] !== 'MATH-01') {
    throw new Error(`extras missing the unmapped column: ${JSON.stringify(row.extras)}`)
  }
  return JSON.stringify(row.extras)
})

check('mapped columns carry their own values', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '高等数学 A')
  if (row.notes !== '带上次作业') throw new Error(`notes is ${JSON.stringify(row.notes)}`)
  if (row.location !== '三教 305') throw new Error(`location is ${JSON.stringify(row.location)}`)
  return `${row.location} / ${row.notes}`
})

// ---------------------------------------------------------------- host filtering

/**
 * Mirror of the host's owner matcher, including its negation guard, so the
 * filter rule is asserted here rather than only inside the host closure.
 */
const NEGATION = /(不含|不包括|不参与|无需|不用|排除|除|非|not\s|exclude)/i
function matchesOwner(ownerField, names) {
  const haystack = String(ownerField ?? '').toLowerCase().replace(/\s+/g, '')
  if (haystack === '') return false
  for (const name of names) {
    const needle = name.toLowerCase().replace(/\s+/g, '')
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      const before = haystack.slice(0, at)
      const boundary = Math.max(
        before.lastIndexOf('、'),
        before.lastIndexOf(','),
        before.lastIndexOf('，'),
        before.lastIndexOf('/'),
        before.lastIndexOf('|'),
      )
      const context = before.slice(boundary + 1)
      if (!NEGATION.test(context)) return true
      from = at + needle.length
    }
  }
  return false
}

check('owner filter keeps only 张三 rows', () => {
  const names = ['张三']
  const kept = parsed.rows.filter((row) => matchesOwner(row.person, names))
  const dropped = parsed.rows.filter((row) => !matchesOwner(row.person, names))
  const titles = kept.map((row) => row.title)
  if (titles.includes('晚自习辅导')) throw new Error('a row belonging to someone else was kept')
  if (kept.length !== 8) throw new Error(`expected 8 kept, got ${kept.length}: ${titles.join(' / ')}`)
  if (dropped.length !== 3) throw new Error(`expected 3 dropped, got ${dropped.length}`)
  return `${kept.length} kept / ${dropped.length} dropped`
})

check('separator variants all match one owner', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '项目周会')
  if (!matchesOwner(row.person, ['张三'])) throw new Error(`comma-separated roster missed: ${row.person}`)
  const training = parsed.rows.find((candidate) => candidate.title === '集中培训 · 第一讲')
  if (!matchesOwner(training.person, ['张三'])) throw new Error(`、-separated roster missed: ${training.person}`)
  return 'both separators matched'
})

check('a mention in the notes column still counts', () => {
  const row = parsed.rows.find((candidate) => candidate.title === '教研活动')
  if (!matchesOwner(row.notes, ['张三'])) throw new Error(`notes mention missed: ${row.notes}`)
  const notaRow = parsed.rows.find((candidate) => candidate.title === '集中培训 · 复盘')
  if (matchesOwner(notaRow.notes, ['张三'])) throw new Error('a negative note should not match')
  return 'notes fallback works'
})

/* ---------------------------------------------------------------------------
 * Merged weekday headers.
 *
 * The 「第N周」 shape puts one *merged* cell per weekday — "周一" spanning the
 * two duty slots underneath it — so only the header's first column carries text
 * while both columns carry names. Reading just the header columns loses every
 * second person, which is indistinguishable from "this roster does not include
 * you". These checks pin the whole-slot behaviour down.
 * ------------------------------------------------------------------------- */

const WEEK_ROSTER = join(workDir, 'week-roster.xlsx')
let weekParsed = null

check('merged-weekday roster generated', () => {
  const result = runPython(join(root, 'scripts', 'make-week-roster.py'), [WEEK_ROSTER, '5'])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  if (!existsSync(WEEK_ROSTER)) throw new Error('workbook missing')
  return WEEK_ROSTER
})

check('the merged-weekday roster parses through the same spawn path', () => {
  const result = runPython(join(root, 'lib', 'parse-xlsx.py'), [
    WEEK_ROSTER,
    JSON.stringify({ timeRules: [{ match: ['晚自习'], start: '19:30', end: '20:50' }], weekOneMonday: '2026-08-31', previewRows: 8 }),
  ])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  weekParsed = JSON.parse(result.stdout)
  if (weekParsed.ok !== true) throw new Error(weekParsed.error || 'ok was not true')
  if (weekParsed.layout !== 'matrixWeek') throw new Error(`expected matrixWeek, got ${weekParsed.layout}`)
  return `layout=${weekParsed.layout} rows=${weekParsed.rowCount}`
})

check('a name in the second slot of a merged weekday is read', () => {
  // The fixture puts each week's name one slot further right, so reading only
  // the header column finds week 1 and loses every later week: 4 of 5 records
  // would be missing. All five must be here.
  if (weekParsed.rowCount !== 20) throw new Error(`expected 20 records (5 weeks x 4 weekdays), got ${weekParsed.rowCount}`)
  const people = new Set(weekParsed.rows.map((row) => row.person))
  for (let week = 1; week <= 5; week += 1) {
    const name = `值班员${week}号`
    if (!people.has(name)) throw new Error(`dropped from the sheet: ${name}`)
  }
  return `${weekParsed.rowCount} records, weeks 1-5 all present`
})

check('the second slot keeps its own weekday, not its neighbour’s', () => {
  // Week 2's name sits in the *second* column under 周一. A width-1 read drops
  // it; a read that let the span run past the next merge smears it onto 周二.
  const rows = weekParsed.rows.filter((row) => row.person === '值班员2号')
  if (rows.length !== 4) throw new Error(`expected 4 weekday slots, got ${rows.length}`)
  // Ordered by date, not by name: 周一/周二/周三/周四 sorted as strings would be
  // 周一/周三/周二/周四, because Chinese collation is by code point here.
  const ordered = [...rows].sort((left, right) => left.date.localeCompare(right.date))
  const weekdays = ordered.map((row) => row.weekday).join('/')
  if (weekdays !== '周一/周二/周三/周四') throw new Error(`weekdays were ${weekdays}`)
  const monday = ordered[0]
  if (monday.date !== '2026-09-07') throw new Error(`week 2 Monday should be 2026-09-07, got ${monday.date}`)
  return `4 slots, ${weekdays}, Monday=${monday.date}`
})

check('the first slot is not duplicated by the wider read', () => {
  // Week 1's names sit in each weekday's first column and must appear once each.
  const rows = weekParsed.rows.filter((row) => row.person === '值班员1号')
  if (rows.length !== 4) throw new Error(`expected 4 weekday slots, got ${rows.length}`)
  const monday = rows.find((row) => row.weekday === '周一')
  if (monday.date !== '2026-08-31') throw new Error(`week 1 Monday should be 2026-08-31, got ${monday.date}`)
  return `4 slots, Monday=${monday.date}`
})

/* ---------------------------------------------------------------------------
 * What the duty *is*.
 *
 * A roster says who is on duty and never what the duty is; the answer is in the
 * prose beside the grid ("点名时间：19：30 20：50", "①一人负责两个班的晚自习考勤").
 * Ignoring it produces entries labelled from the file name, which is how a
 * study-hall roll call ends up announced as a morning check-in: the title, the
 * clock, and the sheet's own wording all disagree and nothing notices.
 * ------------------------------------------------------------------------- */

const PROSE_ROSTER = join(workDir, 'week-roster-prose.xlsx')
let proseParsed = null

check('roster with prose beside the grid generated', () => {
  const result = runPython(join(root, 'scripts', 'make-week-roster.py'), [PROSE_ROSTER, '5', 'prose'])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  return PROSE_ROSTER
})

check('the sheet prose is reported, and the grid columns are not mistaken for it', () => {
  const result = runPython(join(root, 'lib', 'parse-xlsx.py'), [
    PROSE_ROSTER,
    JSON.stringify({ subject: '晚自习考勤', weekOneMonday: '2026-08-31', previewRows: 4 }),
  ])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  proseParsed = JSON.parse(result.stdout)
  if (proseParsed.ok !== true) throw new Error(proseParsed.error || 'ok was not true')
  const notes = proseParsed.sheetNotes || []
  if (!notes.some((line) => line.includes('点名时间'))) throw new Error(`the clock line was missed: ${JSON.stringify(notes)}`)
  if (!notes.some((line) => line.includes('一人负责两个班'))) throw new Error(`the duty line was missed: ${JSON.stringify(notes)}`)
  for (const line of notes) {
    if (/^第?\s*\d*\s*周|^周[一二三四五六日天]$/.test(line)) throw new Error(`structure leaked into the prose: ${line}`)
    if (line.includes('值班员')) throw new Error(`a duty cell leaked into the prose: ${line}`)
  }
  return notes.join(' / ')
})

check('a matrix entry carries the duty text as its note', () => {
  const row = proseParsed.rows[0]
  if (typeof row.notes !== 'string' || !row.notes.includes('点名时间')) {
    throw new Error(`note did not carry the sheet prose: ${JSON.stringify(row.notes)}`)
  }
  return row.notes
})

check('an explicit note wins over the sheet prose', () => {
  const result = runPython(join(root, 'lib', 'parse-xlsx.py'), [
    PROSE_ROSTER,
    JSON.stringify({ note: '按点名册点名，核实后同步到在线文档。', weekOneMonday: '2026-08-31' }),
  ])
  const withNote = JSON.parse(result.stdout)
  if (withNote.note !== '按点名册点名，核实后同步到在线文档。') throw new Error(`note was ${JSON.stringify(withNote.note)}`)
  if (withNote.rows[0].notes !== withNote.note) throw new Error('records did not take the explicit note')
  return withNote.note
})

check('the time rule may come from the sheet prose itself', () => {
  // No subject, no time in the file name, and a rule set that only knows the
  // sheet's own wording: the window still lands, because the prose is read.
  const result = runPython(join(root, 'lib', 'parse-xlsx.py'), [
    PROSE_ROSTER,
    JSON.stringify({ timeRules: [{ match: ['晚自习'], start: '19:30', end: '20:50' }], weekOneMonday: '2026-08-31' }),
  ])
  const parsed = JSON.parse(result.stdout)
  if (parsed.rows[0].start !== '19:30' || parsed.rows[0].end !== '20:50') {
    throw new Error(`prose did not supply the time: ${parsed.rows[0].start}-${parsed.rows[0].end}`)
  }
  return `${parsed.rows[0].start}-${parsed.rows[0].end}`
})

check('a window that contradicts the sheet it was pointed at is reported', () => {
  // The rule's keyword matches (so this file is *given* a window), but the sheet
  // itself states a different clock: 07:00–07:30 on a sheet that says 19:30/20:50
  // is the "study-hall roll call announced as a morning check-in" shape.
  const result = runPython(join(root, 'lib', 'parse-xlsx.py'), [
    PROSE_ROSTER,
    JSON.stringify({
      subject: '早打卡值班',
      timeRules: [{ match: ['教室'], start: '07:00', end: '07:30' }],
      weekOneMonday: '2026-08-31',
    }),
  ])
  const parsed = JSON.parse(result.stdout)
  const warning = (parsed.warnings || []).find((line) => line.includes('07:00') && line.includes('19:30'))
  if (warning === undefined) throw new Error(`no mismatch warning; warnings were ${JSON.stringify(parsed.warnings)}`)
  return warning
})

check('a sheet with no stated clock is not accused of contradicting one', () => {
  const warnings = (weekParsed.warnings || []).filter((line) => line.includes('对不上') || line.includes('没有时间规则匹配'))
  if (warnings.length > 0) throw new Error(`false positive: ${warnings.join(' / ')}`)
  return 'quiet on a sheet that states no time'
})

rmSync(workDir, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('all Excel pipeline checks passed')
