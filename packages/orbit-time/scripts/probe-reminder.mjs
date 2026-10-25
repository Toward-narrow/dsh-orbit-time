#!/usr/bin/env node
/**
 * Probe the reminder scan and toast spawn in isolation, with the same seam the
 * real host uses. Not part of the suite: this exists to diagnose why a rung did
 * not fire, printing what the scan actually sees.
 *
 * Run: node scripts/probe-reminder.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const scratch = mkdtempSync(join(tmpdir(), 'orbit-rem-'))
process.env.DSH_HOME = scratch

const spawns = []
const routes = new Map()
const timers = []
const ctx = {
  get: (name) =>
    name === 'orbitTimeSpawn'
      ? (command, args, options) => {
          spawns.push({ command, args, options })
          return { pid: 1, stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, kill() {}, on() { return this } }
        }
      : undefined,
  logger: { info: (...a) => console.log('  host:', ...a), warn: (...a) => console.log('  host WARN:', ...a), error: (...a) => console.log('  host ERROR:', ...a) },
  webServer: {
    port: 0,
    register(route) {
      routes.set(route.path, route.handler)
      return () => {}
    },
  },
  interval(callback, delay) {
    const handle = setInterval(callback, delay)
    timers.push(handle)
    return () => clearInterval(handle)
  },
  timeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    timers.push(handle)
    return () => clearTimeout(handle)
  },
  effect: () => () => {},
}

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
mod.apply(ctx, {
  profile: { name: '张三' },
  workbook: { path: '', watch: false, sources: [] },
  reminders: { enabled: true, offsetsMinutes: [1, 0], osToast: true, respectQuietHours: false },
  ui: { showFloatingWidget: false },
})

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (!handler) {
    res.writeHead(404).end('{}')
    return
  }
  handler(req, res)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}/api/orbit-time`
const call = async (path, body) => {
  const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return response.json()
}

const pad = (v) => String(v).padStart(2, '0')
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const target = new Date(Date.now() + 110_000)
const created = await call('/events', {
  action: 'add',
  event: { title: '通知探针', date: dayKeyOf(target), start: hhmm(target), person: '张三' },
})
console.log('created:', JSON.stringify({ start: created.event?.start, date: created.event?.date, id: created.event?.id }))

const shifted = await call('/events', { action: 'shift', id: created.event.id, minutes: -1 })
const view = shifted.snapshot.day.events.find((event) => event.id === created.event.id)
console.log('after shift: effectiveStart=', view?.effectiveStart, 'minutesUntilStart=', view?.minutesUntilStart)

const settings = await call('/settings', { settings: { reminders: { offsetsMinutes: [1, 0], osToast: true, respectQuietHours: false } } })
console.log('offsets now:', JSON.stringify(settings.settings.reminders.offsetsMinutes), 'osToast=', settings.settings.reminders.osToast, 'enabled=', settings.settings.reminders.enabled)

for (let i = 0; i < 10; i += 1) {
  await new Promise((done) => setTimeout(done, 1000))
  const feed = (await call('/feed')).feed
  const reminders = feed.filter((entry) => entry.kind === 'reminder')
  console.log(`t+${i + 1}s spawns=${spawns.length} reminders=${reminders.length}`, reminders.map((entry) => entry.title).join(' | '))
  if (reminders.length > 0 && spawns.length > 0) break
}

if (spawns.length > 0) {
  console.log('spawn:', spawns[0].command, JSON.stringify(spawns[0].args.slice(0, 5)), 'stdio=', JSON.stringify(spawns[0].options?.stdio))
}

for (const handle of timers) {
  clearInterval(handle)
  clearTimeout(handle)
}
server.close()
rmSync(scratch, { recursive: true, force: true })
process.exit(0)
