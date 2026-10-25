#!/usr/bin/env node
/**
 * Render the floating widget to a PNG so its design can be reviewed.
 *
 * A topmost layered WinForms window cannot be grabbed from the outside — a
 * screen capture of it comes back black — so `hud.ps1` takes the picture itself
 * via PrintWindow. This script just feeds it a state file and collects the
 * result, and refuses to call it a success when the frame came out empty.
 *
 * Usage:
 *   node scripts/capture-hud.mjs                       # running focus phase
 *   node scripts/capture-hud.mjs --phase=idle
 *   node scripts/capture-hud.mjs --out=my.png --delay=900
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const phase = option('phase', 'focus')
const mode = option('mode', 'pill')
const delayMs = Number(option('delay', '780'))
const outPath = resolve(option('out', join(root, 'preview', 'hud.png')))

const scratch = mkdtempSync(join(tmpdir(), 'orbit-hud-capture-'))
const statePath = join(scratch, 'hud-state.json')
const logPath = join(scratch, 'hud.log')
const scriptPath = join(root, 'lib', 'hud.ps1')

if (!existsSync(scriptPath)) {
  console.error(`hud.ps1 not found at ${scriptPath}; run the build first`)
  process.exit(1)
}

const idle = phase === 'idle'
const state = {
  publishedAt: new Date().toISOString(),
  phase,
  running: !idle,
  remainingSeconds: idle ? 0 : phase === 'focus' ? 18 * 60 + 24 : 5 * 60,
  totalSeconds: idle ? 0 : phase === 'focus' ? 25 * 60 : 5 * 60,
  // An idle widget shows what is coming up, not a finished round's subject.
  subject: idle ? '' : '复习傅里叶级数',
  completedToday: 3,
  nextTitle: '数据结构实验',
  nextMeta: '14:00 · 实验楼 B210',
  nextMinutes: 28,
  eventCount: 7,
  eventsToday: [],
  ownerNames: ['张三'],
  excelError: null,
}
writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
mkdirSync(dirname(outPath), { recursive: true })

const child = spawn(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-File',
    scriptPath,
    '-statePath',
    statePath,
    '-port',
    '19387',
    '-capturePath',
    outPath,
    '-mode',
    mode,
    '-logPath',
    logPath,
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ORBIT_HUD_CAPTURE_DELAY_MS: String(delayMs) } },
)

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

await new Promise((done) => child.on('exit', done))

const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : ''
console.log(`capture: phase=${phase} delay=${delayMs}ms`)
if (log !== '') for (const line of log.split(/\r?\n/)) console.log('  ' + line)

const noise = stderr
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '' && !line.includes('defines no public methods'))
if (noise.length > 0) console.log('  stderr: ' + noise[0])

rmSync(scratch, { recursive: true, force: true })

if (!existsSync(outPath)) {
  console.error('FAILED: no PNG was written')
  process.exit(1)
}
const bytes = statSync(outPath).size
// A few hundred bytes means a blank frame: the same size as the widget area with
// nothing drawn in it.
if (bytes < 1200) {
  console.error(`FAILED: ${outPath} is only ${bytes} B — the frame came out blank`)
  process.exit(1)
}
console.log(`wrote ${outPath} (${bytes} B)`)
