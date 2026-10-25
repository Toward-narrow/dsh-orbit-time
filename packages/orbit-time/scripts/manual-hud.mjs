#!/usr/bin/env node
/**
 * Manual check for the floating HUD: publish a state file, launch `lib/hud.ps1`
 * the way the host does, and let a person look at the window.
 *
 * This cannot be asserted automatically — a topmost WinForms window is a visual
 * artifact — so it runs the real launcher and reports what it observed: the
 * process stays alive, the state file is re-read, and an action request written
 * by the widget is picked up from the state folder.
 *
 * Usage: node scripts/manual-hud.mjs [seconds]   (default 25)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const holdSeconds = Number(process.argv[2] || 25)

const scratch = mkdtempSync(join(tmpdir(), 'orbit-time-hud-'))
const statePath = join(scratch, 'hud-state.json')
const logPath = join(scratch, 'hud-interactions.log')
const scriptPath = join(root, 'lib', 'hud.ps1')

if (!existsSync(scriptPath)) {
  console.error(`hud.ps1 not found at ${scriptPath}; run the build first`)
  process.exit(1)
}

function writeState(patch) {
  const base = {
    publishedAt: new Date().toISOString(),
    phase: 'focus',
    running: true,
    remainingSeconds: 18 * 60 + 24,
    totalSeconds: 25 * 60,
    subject: '复习傅里叶变换',
    completedToday: 3,
    nextTitle: '数据结构实验',
    nextMeta: '14:00 · 实验楼 B210',
    nextMinutes: 12,
    nextPhase: 'upcoming',
    dayLabel: '今天 周一',
    eventCount: 4,
    eventsToday: [],
    ownerNames: ['张三'],
    excelError: null,
  }
  writeFileSync(statePath, JSON.stringify({ ...base, ...patch }, null, 2), 'utf8')
}

writeState({})
console.log(`orbit-time HUD manual check`)
console.log(`  state:  ${statePath}`)
console.log(`  script: ${scriptPath}`)
console.log(`  holding for ${holdSeconds}s — the widget should be topmost, draggable,`)
console.log(`  and absent from the taskbar. Right-click it for the action menu.`)

const child = spawn(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-File',
    scriptPath,
    '-statePath',
    statePath,
    '-port',
    '19387',
    '-dashboardUrl',
    'http://127.0.0.1:19387/',
    '-logPath',
    logPath,
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
)

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
let exited = false
child.on('exit', (code) => {
  exited = true
  console.log(`  widget exited early with code ${code}`)
})

// Drive the countdown and watch for an action request the person triggers.
const startRemaining = 18 * 60 + 24
let remaining = startRemaining
let injected = false
const tick = setInterval(() => {
  remaining -= 2
  if (remaining < 0) remaining = 25 * 60
  writeState({ remainingSeconds: remaining, subject: '复习傅里叶变换 · 第 ' + Math.ceil(remaining / 60) + ' 分钟' })

  // A few ticks in, write a request the way the widget's Send-Action does and
  // confirm the state folder is watched end to end: request in, response out.
  if (!injected && startRemaining - remaining >= 8) {
    injected = true
    const id = 'manualprobe'
    writeFileSync(join(scratch, `hud-request-${id}.json`), JSON.stringify({ id, action: 'toggle', minutes: 0 }), 'utf8')
    console.log('  injected a synthetic hud-request (the shape Send-Action writes)')
  }

  const requests = readdirSync(scratch).filter((name) => name.startsWith('hud-request-'))
  for (const name of requests) {
    try {
      const payload = JSON.parse(readFileSync(join(scratch, name), 'utf8'))
      console.log(`  action request received: ${JSON.stringify(payload)}`)
      if (payload.id === 'manualprobe') {
        writeFileSync(join(scratch, `hud-response-${payload.id}.json`), JSON.stringify({ ok: true, outcome: 'ok' }), 'utf8')
      }
    } catch (error) {
      console.log(`  unreadable request ${name}: ${error.message}`)
    }
    rmSync(join(scratch, name), { force: true })
  }
}, 2000)

await new Promise((done) => setTimeout(done, holdSeconds * 1000))
clearInterval(tick)

const responsePath = join(scratch, 'hud-response-manualprobe.json')
if (injected) {
  console.log(
    existsSync(responsePath)
      ? '  round trip confirmed: request written, response written back'
      : '  NOTE: the probe request was injected but no response file was found',
  )
}

if (!exited) {
  console.log('  widget was still alive at the end of the hold — killing it')
  child.kill()
}
if (stderr.trim() !== '') {
  console.log('  stderr from the widget:')
  console.log('  ' + stderr.trim().split('\n').slice(0, 12).join('\n  '))
} else {
  console.log('  no stderr from the widget')
}

// The widget's own interaction log is the evidence that it received input: the
// window can look right while every click is being swallowed.
if (existsSync(logPath)) {
  const lines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
  console.log(`  interaction log (${lines.length} lines):`)
  for (const line of lines.slice(-12)) console.log('    ' + line)
} else {
  console.log('  no interaction log was written')
}

rmSync(scratch, { recursive: true, force: true })
console.log('done')
process.exit(0)
