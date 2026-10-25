#!/usr/bin/env node
/**
 * End-to-end check of the analyze flow against the workbooks on this machine.
 *
 * Boots the real host half, points DSH_HOME at the live plugin state directory
 * (so the encoding self-heal runs on the real config.json), then drives the
 * routes the panel uses.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const liveState = join(tmpdir(), 'orbit-time')
const useLive = process.argv.includes('--live')
const scratch = useLive ? liveState : mkdtempSync(join(tmpdir(), 'ot-analyze-'))

/**
 * A config layer written the way a broken install actually has it: UTF-8 bytes
 * that were read through a single-byte code page and saved back.
 *
 * The mojibake is *generated* rather than pasted. Only a subset of it is Latin-1
 * — the repair additionally has to undo the Windows-1252 punctuation band — so a
 * hand-copied literal loses exactly the characters that make the test worth
 * running.
 */
const misdecode = (text) => Buffer.from(text, 'utf8').toString('latin1')

const WORKSPACE = 'C:\\Users\\User\\project\\dsh-orbit-time'
const EARLY = `${WORKSPACE}\\示例支部早打卡排班表.xlsx`
const EVENING = `${WORKSPACE}\\示例支部晚自习排班表 (1).xlsx`

const MOJIBAKE_CONFIG = {
  profile: { name: '张三', aliases: [] },
  workbook: {
    path: '',
    importHorizonDays: 400,
    watch: false,
    sources: [
      {
        path: misdecode(EARLY),
        subject: misdecode('示例支部早打卡值班'),
        timeRules: [{ match: [misdecode('早打卡'), misdecode('打卡')], start: '07:00', end: '07:30' }],
      },
      {
        path: misdecode(EVENING),
        subject: misdecode('示例支部晚自习考勤'),
        timeRules: [{ match: [misdecode('晚自习'), misdecode('自习')], start: '19:30', end: '20:50' }],
      },
    ],
    subject: '',
    timeRules: [
      { match: [misdecode('早打卡'), misdecode('打卡')], start: '07:00', end: '07:30' },
      { match: [misdecode('晚自习'), misdecode('自习')], start: '19:30', end: '20:50' },
    ],
    weekOneMonday: '2026-08-31',
  },
}

if (!useLive) {
  // Land the broken values where the host actually looks for them. This is the
  // layer it merges last, which is how a stale config.json reaches a fresh start.
  const { mkdirSync } = await import('node:fs')
  const stateDir = join(scratch, 'storages', 'orbit-time')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(MOJIBAKE_CONFIG, null, 2), 'utf8')
}

process.env.DSH_HOME = scratch

const routes = new Map()
const ctx = {
  logger: { info: (...a) => console.log('  host:', ...a), warn: (...a) => console.log('  host WARN:', ...a), error: (...a) => console.log('  host ERR:', ...a) },
  webServer: { port: 0, register(r) { routes.set(r.path, r.handler); return () => {} } },
  interval: () => () => {},
  timeout: () => () => {},
  effect: () => () => {},
}

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
mod.apply(ctx, {})

const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://x').pathname)
  if (!handler) return res.writeHead(404).end('{}')
  handler(req, res)
})
await new Promise((d) => server.listen(0, '127.0.0.1', d))
const base = `http://127.0.0.1:${server.address().port}/api/orbit-time`

const call = async (path, body) => {
  const response = await fetch(base + path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`)
  }
}

const files = [EARLY, EVENING]

for (const file of files) {
  console.log(`\n===== analyze ${file.split('\\').pop()} =====`)
  const result = await call('/analyze', { path: file, useModel: false })
  if (result.ok !== true) {
    console.log('  FAILED:', result.error)
    continue
  }
  console.log('  file      :', result.file)
  console.log('  layout    :', result.layout, '| sheet:', result.sheet, '| rows:', result.rowCount)
  console.log('  analysis  :', JSON.stringify(result.analysis, null, 2).split('\n').map((l) => '    ' + l).join('\n'))
}

// The config layer deliberately held mojibake paths; a plain import must now
// resolve them and produce real events without the user touching anything.
console.log('\n===== import with the mojibake config in place =====')
const imported = await call('/import', {})
console.log('  ok:', imported.ok, imported.ok ? '' : imported.error)
if (imported.ok) {
  console.log('  imported:', imported.excel.importedCount, 'matched:', imported.excel.matchedCount, 'filtered:', imported.excel.filteredCount)
  for (const source of imported.excel.sources || []) {
    console.log('   ', source.sheet, `[${source.layout}]`, source.rowCount, 'rows ->', source.matchedHere)
  }
  for (const event of (imported.snapshot?.upcoming || []).slice(0, 4)) {
    console.log('   ', event.date, event.effectiveStart || event.start, event.title)
  }
}

console.log('\n===== config.json after heal =====')
const configPath = join(scratch, 'storages', 'orbit-time', 'config.json')
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'))
if (existsSync(configPath)) {
  const config = readConfig()
  console.log('  workbook.path:', JSON.stringify(config.workbook.path))
  for (const source of config.workbook.sources || []) console.log('  source:', JSON.stringify(source.path))
  const text = readFileSync(configPath, 'utf8')
  console.log('  still contains U+00C3 (mojibake tell):', text.includes('\u00C3'))
}

/**
 * The upload path.
 *
 * A dropped or picked file reaches the page as bytes with no path, so the panel
 * sends base64 and the host writes a copy into the state directory before
 * parsing with the same code a pasted path uses. A Chinese file name has to
 * survive that round trip, which is the whole point of doing it this way.
 */
console.log('\n===== upload path (drag / file picker) =====')
const uploadName = '示例支部早打卡排班表.xlsx'
const workbook = readFileSync(EARLY)
const uploaded = await call('/analyze', {
  file: { name: uploadName, base64: workbook.toString('base64') },
  useModel: false,
})
if (uploaded.ok !== true) {
  console.log('  FAILED:', uploaded.error)
} else {
  const saved = join(scratch, 'storages', 'orbit-time', 'uploads', uploadName)
  console.log('  analysed at   :', uploaded.file)
  console.log('  layout / rows :', uploaded.layout, '/', uploaded.rowCount, '| grid:', uploaded.analysis.grid)
  console.log('  summary       :', uploaded.analysis.summary)
  console.log('  name survived :', existsSync(saved) ? 'YES' : 'NO')
  console.log('  config points at the saved copy:', readConfig().workbook.path === saved)
}

const rejected = await call('/analyze', { file: { name: 'notes.txt', base64: Buffer.from('x').toString('base64') } })
console.log('  wrong extension refused:', rejected.ok === true ? 'NO' : 'YES — ' + String(rejected.error).slice(0, 70))

server.close()
if (!useLive) rmSync(scratch, { recursive: true, force: true })
void writeFileSync
process.exit(0)
