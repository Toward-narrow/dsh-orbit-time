#!/usr/bin/env node
/**
 * Inspect a workbook through the same parser the plugin uses, without importing
 * anything into the running host. Prints the detected sheet, header row, column
 * mapping, and the first rows — the fastest way to see why a schedule did or did
 * not match.
 *
 * Usage:
 *   node scripts/inspect-workbook.mjs <file.xlsx> [ownerName ...]
 *   node scripts/inspect-workbook.mjs <file.xlsx> 张三 --rows=20
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const python =
  process.env.DSH_PYTHON ||
  join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')

const args = process.argv.slice(2)
const options = {}
const rest = []
for (const arg of args) {
  const match = /^--([a-zA-Z]+)=(.*)$/.exec(arg)
  if (match) options[match[1]] = match[2]
  else rest.push(arg)
}

const target = rest[0]
if (target === undefined || target === '') {
  console.error('usage: node scripts/inspect-workbook.mjs <file.xlsx> [ownerName ...] [--rows=12] [--sheet=名称]')
  process.exit(1)
}
if (!existsSync(target)) {
  console.error(`not found: ${resolve(target)}`)
  process.exit(1)
}
if (!existsSync(python)) {
  console.error(`python not found at ${python}; set DSH_PYTHON to override`)
  process.exit(1)
}

const owners = rest.slice(1)
const previewRows = Number(options.rows || 12)

const payload = { previewRows }
if (options.sheet !== undefined) payload.sheet = options.sheet
if (options.headerRow !== undefined) payload.headerRow = Number(options.headerRow)

const result = spawnSync(python, [join(root, 'lib', 'parse-xlsx.py'), resolve(target), JSON.stringify(payload)], {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(result.stdout)
} catch {
  console.error('parser produced unreadable output:')
  console.error((result.stdout || '').slice(0, 800))
  console.error(result.stderr.slice(0, 800))
  process.exit(1)
}

if (parsed.ok !== true) {
  console.error(`parse failed: ${parsed.error}`)
  process.exit(1)
}

const NEGATION = /(不含|不包括|不参与|无需|不用|排除|除|非|not\s|exclude)/i
function matchesOwner(field, names) {
  const haystack = String(field ?? '').toLowerCase().replace(/\s+/g, '')
  if (haystack === '') return false
  for (const name of names) {
    const needle = name.toLowerCase().replace(/\s+/g, '')
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      const before = haystack.slice(0, at)
      const boundary = Math.max(before.lastIndexOf('、'), before.lastIndexOf(','), before.lastIndexOf('，'), before.lastIndexOf('/'), before.lastIndexOf('|'))
      if (!NEGATION.test(before.slice(boundary + 1))) return true
      from = at + needle.length
    }
  }
  return false
}

console.log(`file:        ${parsed.file}`)
console.log(`sheets:      ${parsed.sheets.join(' | ')}`)
console.log(`chosen:      ${parsed.sheet}  (header row ${parsed.headerRow}, ${parsed.rowCount} data rows)`)
console.log(`mapping:     ${Object.entries(parsed.mapping).map(([field, header]) => `${field}=${header}`).join('  ')}`)
if (parsed.unmapped.length > 0) console.log(`unmapped:    ${parsed.unmapped.join(' | ')}`)
for (const warning of parsed.warnings) console.log(`warning:     ${warning}`)

if (owners.length > 0) {
  const matched = parsed.rows.filter((row) => matchesOwner(row.person, owners) || matchesOwner(row.teacher, owners) || matchesOwner(row.notes, owners))
  console.log(`\nowner filter ${owners.join(' / ')}: ${matched.length} of ${parsed.rows.length} rows match`)
  const unmatchedSamples = [...new Set(parsed.rows.filter((row) => !matched.includes(row)).map((row) => row.person))].slice(0, 12)
  if (unmatchedSamples.length > 0) {
    console.log(`  names seen in skipped rows: ${unmatchedSamples.map((name) => JSON.stringify(name)).join(', ')}`)
  }
}

console.log(`\nfirst ${Math.min(previewRows, parsed.rows.length)} rows:`)
const width = { row: 5, date: 11, start: 6, end: 6, title: 26, person: 26 }
for (const row of parsed.rows.slice(0, previewRows)) {
  const mark = owners.length === 0 ? ' ' : matchesOwner(row.person, owners) || matchesOwner(row.teacher, owners) || matchesOwner(row.notes, owners) ? '✓' : '·'
  console.log(
    `  ${mark} ${String(row._row).padStart(width.row)}  ${(row.date || '(无日期)').padEnd(width.date)} ${(row.start || '--:--').padEnd(width.start)} ${(row.end || '--:--').padEnd(width.end)} ${String(row.title || row.course || '').slice(0, width.title).padEnd(width.title)} ${String(row.person || '').slice(0, width.person)}`,
  )
}

const allNames = [...new Set(parsed.rows.map((row) => row.person).filter((name) => name !== ''))]
console.log(`\ndistinct names (${allNames.length}): ${allNames.slice(0, 40).map((name) => JSON.stringify(name)).join(', ')}`)
