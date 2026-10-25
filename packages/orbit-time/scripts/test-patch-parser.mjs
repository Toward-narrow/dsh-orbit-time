#!/usr/bin/env node
/**
 * Check the patch-layer reader against the real profile file.
 *
 * The reader decides whether the plugin's configuration is understood at all, so
 * it is held to the actual `cordis.patch.yml` rather than to a synthetic fixture:
 * a regression in comment handling or sequence nesting shows up here instead of
 * as a silently empty config after a restart.
 *
 * Run: node scripts/test-patch-parser.mjs [path-to-cordis.patch.yml]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readOrbitTimeConfig, readPatchEntries, scalar, stripComment } from './parse-patch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const patchPath = resolve(process.argv[2] || join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'))

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

console.log('orbit-time patch reader check')
console.log(`  file: ${patchPath}`)

check('comment stripping respects quotes and hashes in plain text', () => {
  if (stripComment('- id: orbit-time') !== '- id: orbit-time') throw new Error('mangled a leading dash')
  if (stripComment('  path: "C:\\\\a\\\\b.xlsx"  # 说明') !== '  path: "C:\\\\a\\\\b.xlsx"  ') {
    throw new Error('kept the inline comment')
  }
  if (stripComment('key: value#notacomment') !== 'key: value#notacomment') {
    throw new Error('stripped a hash that is not a comment')
  }
  if (stripComment('  name: ""  # 注释').trim() !== 'name: ""') throw new Error('mangled an empty string')
  return 'three cases'
})

check('scalars cover the shapes a patch uses', () => {
  const cases = [
    ['[30, 10, 5, 0]', [30, 10, 5, 0]],
    ['["早打卡", "打卡"]', ['早打卡', '打卡']],
    ['"07:00"', '07:00'],
    ['true', true],
    ['false', false],
    ['""', ''],
    ['60', 60],
  ]
  for (const [input, expected] of cases) {
    const actual = scalar(input)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${input} -> ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }
  return `${cases.length} scalars`
})

if (!existsSync(patchPath)) {
  console.log(`  --   ${patchPath} not found; skipping the live-file checks`)
} else {
  const text = readFileSync(patchPath, 'utf8')

  check('every patch entry is either an override with an id or an insert list', () => {
    const entries = readPatchEntries(text)
    if (entries.length === 0) throw new Error('no entries parsed')
    const labels = []
    for (const entry of entries) {
      if (Array.isArray(entry.insert)) {
        if (typeof entry.id === 'string') labels.push(`${entry.id}:group-insert`)
        else labels.push(`insert(${entry.insert.length})`)
        for (const row of entry.insert) {
          if (typeof row.id !== 'string' || row.id === '') throw new Error(`an inserted entry has no id: ${JSON.stringify(row)}`)
          if (typeof row.name !== 'string' || row.name === '') throw new Error(`inserted entry ${row.id} has no name`)
        }
        continue
      }
      if (typeof entry.id !== 'string' || entry.id === '') throw new Error(`a patch has no id: ${JSON.stringify(entry)}`)
      labels.push(entry.id)
    }
    return labels.join(', ')
  })

  const entry = readOrbitTimeConfig(text)
  check('the orbit-time entry is found inside an insert list', () => {
    if (entry === null) throw new Error('not found')
    if (entry.name !== 'dsh-orbit-time') throw new Error(`name is ${entry.name}`)
    if (!entry.config || typeof entry.config !== 'object') throw new Error('config did not parse')
    return `name=${entry.name}`
  })

  check('a top-level entry is reported as an error, not silently accepted', () => {
    // The loader treats a top-level row as an OVERRIDE of an existing entry id
    // and only warns when nothing matches, so this shape must never pass.
    const broken = [
      '- id: orbit-time',
      '  name: dsh-orbit-time',
      '  config:',
      '    profile:',
      '      name: ""',
    ].join('\n')
    let message = ''
    try {
      readOrbitTimeConfig(broken)
    } catch (error) {
      message = error.message
    }
    if (!message.includes('OVERRIDE')) {
      throw new Error('a top-level entry was accepted; the loader would only warn and never mount it')
    }
    return 'refused with an explanation'
  })

  if (entry !== null) {
    check('nested flow values survive', () => {
      const offsets = entry.config.reminders?.offsetsMinutes
      if (JSON.stringify(offsets) !== JSON.stringify([30, 10, 5, 0])) {
        throw new Error(`offsetsMinutes=${JSON.stringify(offsets)}`)
      }
      if (entry.config.workbook?.watch !== true) throw new Error('watch did not parse as true')
      if (entry.config.workbook?.importHorizonDays !== 60) {
        throw new Error(`importHorizonDays=${entry.config.workbook?.importHorizonDays}`)
      }
      return `offsets=${offsets.join(',')} watch=${entry.config.workbook.watch}`
    })

    check('a sequence of maps parses with all of its keys', () => {
      const sources = entry.config.workbook?.sources
      if (!Array.isArray(sources)) throw new Error(`sources is ${typeof sources}`)
      if (sources.length === 0) throw new Error('sources is empty')
      for (const source of sources) {
        if (typeof source.path !== 'string' || source.path === '') throw new Error(`a source has no path: ${JSON.stringify(source)}`)
        if (typeof source.subject !== 'string' || source.subject === '') throw new Error(`source ${source.path} has no subject`)
        if (!Array.isArray(source.timeRules) || source.timeRules.length === 0) {
          throw new Error(`source ${source.path} has no timeRules`)
        }
        for (const rule of source.timeRules) {
          if (!Array.isArray(rule.match) || rule.match.length === 0) throw new Error('a time rule has no match list')
          if (typeof rule.start !== 'string' || !/^\d{2}:\d{2}$/.test(rule.start)) throw new Error(`bad start ${rule.start}`)
          if (typeof rule.end !== 'string' || !/^\d{2}:\d{2}$/.test(rule.end)) throw new Error(`bad end ${rule.end}`)
        }
      }
      return sources.map((source) => `${source.subject} (${source.timeRules.length} rules)`).join(' + ')
    })

    check('the workbook time rules keep their keyword lists', () => {
      const rules = entry.config.workbook?.timeRules
      if (!Array.isArray(rules) || rules.length < 2) throw new Error(`timeRules=${JSON.stringify(rules)}`)
      const labels = rules.map((rule) => rule.match?.[0])
      if (!labels.includes('早打卡')) throw new Error(`no 早打卡 rule: ${labels.join(', ')}`)
      return labels.join(', ')
    })

    check('quoted scalars stay strings', () => {
      if (typeof entry.config.workbook?.weekOneMonday !== 'string') {
        throw new Error(`weekOneMonday is ${typeof entry.config.workbook?.weekOneMonday}`)
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.config.workbook.weekOneMonday)) {
        throw new Error(`weekOneMonday=${entry.config.workbook.weekOneMonday}`)
      }
      if (typeof entry.config.reminders?.quietHours?.from !== 'string') throw new Error('quietHours.from lost its quotes')
      return `weekOneMonday=${entry.config.workbook.weekOneMonday} quiet=${entry.config.reminders.quietHours.from}`
    })

    check('comments never leak into values', () => {
      const json = JSON.stringify(entry)
      for (const marker of ['#', '⚠', '改成你自己']) {
        if (json.includes(marker)) throw new Error(`a comment leaked: ${marker}`)
      }
      return 'clean'
    })
  }
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('all patch reader checks passed')
