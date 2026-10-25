#!/usr/bin/env node
/**
 * Verify the configured profile produces the schedule you expect.
 *
 * Boots the real host half with the profile's `orbit-time` config, serves it on
 * an ephemeral port, imports every configured workbook, and prints what landed â€”
 * without waiting for an app restart. This is the honest answer to "will it
 * work once I restart?".
 *
 * State is written to a scratch DSH_HOME by default so the running profile is
 * untouched. Pass --state=profile to use the real one.
 *
 * Usage:
 *   node scripts/verify-profile.mjs [--state=profile] [--owner=å¼ ä¸‰]
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readOrbitTimeConfig } from './parse-patch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const useProfileState = args.includes('--state=profile')
const ownerArg = (args.find((arg) => arg.startsWith('--owner=')) || '').slice(8)

const realHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profileDir = join(realHome, 'profiles', 'desktop')
const patchPath = join(profileDir, 'cordis.patch.yml')

if (!existsSync(patchPath)) {
  console.error(`no profile patch layer at ${patchPath}`)
  process.exit(1)
}

const entry = readOrbitTimeConfig(readFileSync(patchPath, 'utf8'))
if (entry === null) {
  console.error('no orbit-time entry found in the patch layer')
  process.exit(1)
}

const config = { ...(entry.config || {}) }
if (ownerArg !== '') {
  config.profile = { ...(config.profile || {}), name: ownerArg }
}

const scratchHome = useProfileState ? realHome : mkdtempSync(join(tmpdir(), 'orbit-time-verify-'))
process.env.DSH_HOME = scratchHome

const routes = new Map()
const timerHandles = []
const ctx = {
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
    timerHandles.push(handle)
    return () => clearInterval(handle)
  },
  timeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    timerHandles.push(handle)
    return () => clearTimeout(handle)
  },
  effect: () => () => {},
}

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
mod.apply(ctx, config)

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
  const response = await fetch(base + path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return response.json()
}

console.log(`state:  ${scratchHome}${useProfileState ? '  (the real profile state!)' : '  (scratch)'}`)
console.log(`owner:  ${JSON.stringify((config.profile && config.profile.name) || '')} / ${JSON.stringify((config.profile && config.profile.aliases) || [])}`)
const sources = (config.workbook && config.workbook.sources) || []
console.log(`sources: ${sources.length}`)
for (const source of sources) {
  const ok = existsSync(source.path)
  console.log(`  ${ok ? 'âœ“' : 'âœ—'} ${source.path}`)
}

console.log('\n--- import ---')
const imported = await call('/import', {})
if (imported.ok !== true) {
  console.error(`import failed: ${imported.error}`)
} else {
  const excel = imported.excel
  console.log(`imported ${excel.importedCount} events (matched ${excel.matchedCount}, filtered ${excel.filteredCount}, past ${excel.pastCount})`)
  for (const source of excel.sources || []) {
    console.log(`  ${source.sheet}  [${source.layout}]  ${source.rowCount} rows -> ${source.matchedHere} kept`)
  }
  for (const warning of excel.warnings || []) console.log(`  warn: ${warning}`)
  if ((excel.failures || []).length > 0) {
    for (const failure of excel.failures) console.log(`  FAILED: ${failure.path}: ${failure.error}`)
  }
}

const snapshot = await call('/snapshot')
console.log(`\n--- today ${snapshot.day.dayKey} (${snapshot.day.stats.label}) ---`)
if (snapshot.day.events.length === 0) {
  console.log('  (no events today)')
} else {
  for (const event of snapshot.day.events) {
    console.log(
      `  ${(event.effectiveStart || '--:--').padEnd(5)}-${(event.effectiveEnd || '--:--').padEnd(5)} ${event.phase.padEnd(8)} ${event.title}` +
        (event.classroom ? ` @${event.classroom}` : '') +
        (event.owner ? `  [${event.owner}]` : ''),
    )
  }
}

console.log('\n--- upcoming ---')
for (const event of snapshot.upcoming || []) {
  console.log(`  ${event.date} ${event.effectiveStart || '--:--'}  ${event.title}  (${event.minutesUntilStart} min)`)
  // The note is what the duty *is*; printing it here is the difference between
  // "抓到 6 条" and "抓到的是不是那件事".
  if (event.notes) console.log(`      ${event.notes}`)
}

const dated = (imported.excel && imported.excel.importedCount) || 0
const undated = (snapshot.day.undated || []).length
console.log(`\nevents=${dated}  today=${snapshot.day.events.length}  undated=${undated}`)
if (dated === 0) {
  console.log('\nNOTHING MATCHED. Set profile.name to the exact spelling used in the roster cells.')
}

for (const handle of timerHandles) {
  clearInterval(handle)
  clearTimeout(handle)
}
// `close()` is asynchronous, and the plugin persists its state on an 800 ms
// timer: deleting the scratch directory (or exiting) while those handles are
// still live is what produced libuv's `!(handle->flags & UV_HANDLE_CLOSING)`
// assertion on the way out. Drain both, then say what to do next.
await new Promise((done) => {
  server.close(done)
  setTimeout(done, 400)
})
await new Promise((done) => setTimeout(done, 900))
if (!useProfileState) rmSync(scratchHome, { recursive: true, force: true })
// Explicit exit after the drain: fetch's keep-alive sockets and the host's own
// persistence timer can otherwise hold the event loop open forever, and the user
// is left with a script that printed everything and never returned.
process.exit(dated === 0 ? 1 : 0)
