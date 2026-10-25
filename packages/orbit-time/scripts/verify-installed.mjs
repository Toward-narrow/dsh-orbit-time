#!/usr/bin/env node
/**
 * Assert that the fixes a user is waiting on actually reached the profile copy.
 *
 * Markers in a built bundle are the cheapest honest evidence that "I fixed it"
 * means "the file the app will load contains the fix" — a rebuild that was never
 * synced looks identical from the source side.
 *
 * Run: node scripts/verify-installed.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const installed = join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-orbit-time')

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

function read(relative) {
  const full = join(installed, relative)
  if (!existsSync(full)) throw new Error(`missing ${full}`)
  return readFileSync(full, 'utf8')
}

console.log('installed profile copy')
console.log(`  path: ${installed}`)

check('the client half carries the overlay interactivity fix', () => {
  const client = read('lib/client.js')
  const needed = [
    ['.ot-float-shell,', 'the overlay roots restate pointer-events'],
    ['debug/client', 'the page reports its own clicks and layout'],
    ['describeOverlayHost', 'the ancestor chain is inspected on mount'],
    ['hitAtButton', 'the element painted over the buttons is reported'],
    ['function collapse()', 'collapsing does not depend on the host'],
    ['ot-confirm', 'the import confirmation is an in-panel bar, not a toast'],
    ['describePlanSkips', 'the bar says what will not be imported'],
    ['ot-notice-stack', 'the notice stack is clamped inside its containing block'],
  ]
  const missing = needed.filter(([needle]) => !client.includes(needle)).map(([, label]) => label)
  if (missing.length > 0) throw new Error(`missing: ${missing.join('; ')}`)
  return `${needed.length} markers, ${(client.length / 1024).toFixed(0)} kB`
})

check('the host half carries the diagnostics and the in-flight fix', () => {
  const host = read('lib/index.js')
  const needed = [
    ["route('/debug'", 'the debug route exists'],
    ["route('/debug/client'", 'the UI report route exists'],
    ['isCurrent', 'an event can be told apart from the next one'],
    ['正在进', 'prep describes a running event as running'],
    ['readHudLogTail', 'the widget log is exposed'],
    ['prepareStateDir', 'state lives in the harness home, not os.tmpdir()'],
    ['adoptLegacyState', 'an older temp state directory is migrated'],
    ['manualEvents: runtime.manualEvents', 'hand-added rows are persisted'],
    ['carriedCount', 'an unreadable roster keeps the rows it had'],
    ['summarizeImportPlan', 'the confirmation can count what it will import'],
  ]
  const missing = needed.filter(([needle]) => !host.includes(needle)).map(([, label]) => label)
  if (missing.length > 0) throw new Error(`missing: ${missing.join('; ')}`)
  return `${needed.length} markers, ${(host.length / 1024).toFixed(0)} kB`
})

check('the widget script is the three-state capsule', () => {
  const hud = read('lib/hud.ps1')
  const needed = [
    ['$script:pillWidth = 232', 'the pill is 232 px wide at 100%'],
    ['$script:miniSize = 56', 'the minimal state is 56 px'],
    ['Draw-Clock', 'digits are laid out on one advance'],
    ['Draw-Control', 'the window controls are drawn, not typed'],
    ['function Show-Mini', 'the minimise transition exists'],
    ['function Show-Pill', 'the restore transition exists'],
    ['function Close-Hud', 'the close transition exists'],
    ['hud-mode.json', 'the state is persisted between launches'],
    ['-keepClosed', 'the host can ask before resurrecting it'],
    ['Get-UiScale', 'the display scale is read'],
    ['GraphicsUnit]::Pixel', 'fonts scale exactly once'],
    ['PW_RENDERFULLCONTENT', 'the capture path uses PrintWindow'],
    ['logPath', 'interactions are logged'],
  ]
  const missing = needed.filter(([needle]) => !hud.includes(needle)).map(([, label]) => label)
  if (missing.length > 0) throw new Error(`missing: ${missing.join('; ')}`)
  if (!hud.includes('$colonAlpha')) throw new Error('the colon fade is gone')
  for (const target of ['min', 'expand', 'close', 'miniclose', 'minigrow']) {
    if (!hud.includes(`'${target}'`)) throw new Error(`the ${target} hit target is gone`)
  }
  return `${needed.length} markers`
})

check('both halves are newer than the last build', () => {
  const local = readFileSync(join(root, 'lib', 'client.js'))
  const copy = readFileSync(join(installed, 'lib', 'client.js'))
  if (!local.equals(copy)) throw new Error('client.js in the profile differs from the build — run sync-profile.mjs')
  return 'in sync'
})

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('the profile copy contains every fix')
