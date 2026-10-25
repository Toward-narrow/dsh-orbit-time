#!/usr/bin/env node
/**
 * Check whether the Orbit Time host half is mounted in the running DSH host.
 *
 * Two independent signals, because neither is sufficient alone:
 *
 *   1. The state directory. `apply()` creates it as its very first action, so
 *      its existence proves the module actually executed. Its location is
 *      printed rather than assumed: the plugin prefers `$DSH_HOME/storages`, and
 *      falls back to a `.state` directory beside the installed package when the
 *      host does not export DSH_HOME.
 *   2. The floating-widget process. A `powershell.exe` running `hud.ps1` out of
 *      this package can only exist because the host half spawned it.
 *
 * A GET against the plugin's own routes is deliberately NOT used: the harness
 * answers unauthenticated requests with 401 before route matching, so it cannot
 * distinguish "route missing" from "route present but unauthenticated". The same
 * applies to `/plugins/<pkg>/client.js`, which 404s for every plugin here.
 *
 * Run: node scripts/check-live.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
void here
void resolve

const pkgName = 'dsh-orbit-time'
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')
const installed = join(profileDir, 'node_modules', pkgName)

console.log(`dsh home:   ${dshHome}`)
console.log(`installed:  ${installed}`)

let healthy = true

// ---------------------------------------------------------------- state dir

console.log('\n--- state directory ---')
const durable = join(dshHome, 'storages', 'orbit-time')
const legacy = join(tmpdir(), 'orbit-time')

/**
 * Both locations, with the freshness of the file that proves a host is writing.
 *
 * Printing only "the first directory that exists" was actively misleading: an
 * install can have an empty durable directory left over from an older version
 * *and* a live one in temp, and the summary then named the dead one. What matters
 * is which directory the running host is writing, and that is the newest
 * `runtime.json` / `config.json` mtime.
 */
function describeStateDir(dir) {
  if (!existsSync(dir)) return { dir, exists: false, files: [], newest: 0 }
  const files = readdirSync(dir)
  let newest = 0
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    try {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
    } catch {
      /* ignore */
    }
  }
  return { dir, exists: true, files, newest }
}

const states = [describeStateDir(durable), describeStateDir(legacy)]
for (const state of states) {
  const label = state.dir === durable ? 'durable' : 'legacy   (os temp)'
  if (!state.exists) {
    console.log(`  ${label}: ${state.dir}  (absent)`)
    continue
  }
  const stamp = state.newest > 0 ? new Date(state.newest).toISOString() : 'no .json yet'
  console.log(`  ${label}: ${state.dir}`)
  console.log(`    ${state.files.length} entries · newest json ${stamp}`)
}

const living = states.filter((state) => state.exists && state.newest > 0).sort((left, right) => right.newest - left.newest)[0]
if (living === undefined) {
  if (states.every((state) => !state.exists)) {
    console.log('  apply() creates this on mount, so the host half has not run.')
    healthy = false
  } else {
    console.log('  neither location holds a state file yet — nothing recorded since the last start.')
  }
} else if (living.dir === legacy) {
  console.log('  -> the running host is writing to the LEGACY temp location.')
  console.log('     Windows clears that directory, which is how schedules disappeared.')
  console.log(`     Restart DeepSeek Harness: it migrates into ${durable} and writes there from then on.`)
  healthy = false
} else {
  console.log(`  -> the running host is writing to the durable location (${durable}).`)
}

/**
 * What the live host last wrote down.
 *
 * `runtime.json` is readable without the web server's auth, so this is the one
 * place that can answer "does my timeline actually hold both rosters?" without a
 * browser. The shape of the file also names the host generation: `manualEvents`
 * is only written by the current build, so its absence is proof that an older
 * host half is still running (it needs an app restart, not a page refresh).
 */
if (living !== undefined) {
  const runtimePath = join(living.dir, 'runtime.json')
  if (existsSync(runtimePath)) {
    try {
      const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
      const events = Array.isArray(runtime.events) ? runtime.events : []
      const titles = [...new Set(events.map((event) => event.title).filter(Boolean))]
      console.log('')
      console.log('--- last written schedule ---')
      console.log(`  ${events.length} event(s) · ${titles.length} roster label(s)`)
      for (const title of titles) console.log(`    ${title}`)
      const dates = events.map((event) => event.date).filter(Boolean).sort()
      if (dates.length > 0) console.log(`  span: ${dates[0]} → ${dates[dates.length - 1]}`)
      const generation = Array.isArray(runtime.manualEvents) ? 'current build (manualEvents present)' : 'OLDER build (no manualEvents key)'
      console.log(`  state file written by: ${generation}`)
      if (Array.isArray(runtime.manualEvents) === false) {
        console.log('  -> an older host half is still running: quit and relaunch DeepSeek Harness.')
        healthy = false
      }
    } catch (error) {
      console.log(`  runtime.json unreadable: ${error.message}`)
    }
  }
}

// ---------------------------------------------------------------- HUD process

console.log('\n--- floating widget process ---')
let processes = []
try {
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  )
  const parsed = JSON.parse(raw)
  processes = Array.isArray(parsed) ? parsed : [parsed]
} catch (error) {
  console.log(`  could not query processes: ${error.message}`)
}

const hud = processes.filter((row) => typeof row.CommandLine === 'string' && row.CommandLine.includes('hud.ps1'))
if (hud.length === 0) {
  console.log('  no hud.ps1 process is running.')
  console.log('  (expected when ui.showFloatingWidget is false, or off Windows)')
} else {
  for (const row of hud) {
    console.log(`  pid ${row.ProcessId} since ${row.CreationDate}`)
    const stateAt = /-statePath\s+(\S+)/.exec(row.CommandLine)
    const portAt = /-port\s+(\d+)/.exec(row.CommandLine)
    const urlAt = /-dashboardUrl\s+(\S+)/.exec(row.CommandLine)
    console.log(`    statePath:    ${stateAt ? stateAt[1] : '(none)'}`)
    console.log(`    port:         ${portAt ? portAt[1] : '(none)'}`)
    console.log(`    dashboardUrl: ${urlAt ? urlAt[1] : '(none)'}`)
    if (stateAt !== null) {
      const alive = existsSync(stateAt[1])
      console.log(`    state file exists: ${alive}${alive ? '' : '   <-- the widget shows 宿主未响应'}`)
      if (!alive) healthy = false
    }
  }
}

console.log(healthy ? '\nOK — the host half is mounted and its widget is bridged.' : '\nNOT HEALTHY — see the notes above.')
process.exit(healthy ? 0 : 1)
