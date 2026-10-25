#!/usr/bin/env node
/**
 * Repair the running install's own state file, in place.
 *
 * The host half that is *currently* running still has the old code, so its
 * startup heal will not run until the app is restarted. This fixes the values
 * now — using the exact module the plugin ships — so the panel works in the
 * meantime and the restart has nothing left to do.
 *
 * The file is backed up first, and written only when something actually changed.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const { repairPath, repairText } = require('../lib/shared-repair.cjs')

const stateDir = join(tmpdir(), 'orbit-time')
const configPath = join(stateDir, 'config.json')
const runtimePath = join(stateDir, 'runtime.json')

if (!existsSync(configPath)) {
  console.error(`nothing to repair: ${configPath} does not exist`)
  process.exit(1)
}

/** Same rule the host applies: paths get path treatment, other text gets text. */
function healValue(key, value) {
  if (typeof value === 'string') {
    return key === 'path' || key === 'file' || key === 'configuredPath' ? repairPath(value) : repairText(value)
  }
  if (Array.isArray(value)) return value.map((item) => healValue(key, item))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [childKey, child] of Object.entries(value)) out[childKey] = healValue(childKey, child)
    return out
  }
  return value
}

for (const file of [configPath, runtimePath]) {
  if (!existsSync(file)) continue
  const before = readFileSync(file, 'utf8')
  const repaired = JSON.stringify(healValue('', JSON.parse(before)), null, 2)
  if (repaired === JSON.stringify(JSON.parse(before), null, 2)) {
    console.log(`unchanged: ${file}`)
    continue
  }
  copyFileSync(file, `${file}.moirepair.bak`)
  writeFileSync(file, repaired, 'utf8')
  console.log(`repaired:  ${file}  (backup at ${file}.moirepair.bak)`)
  const parsed = JSON.parse(repaired)
  if (Array.isArray(parsed.workbook?.sources)) {
    for (const source of parsed.workbook.sources) console.log(`   source: ${source.path}`)
  }
}
