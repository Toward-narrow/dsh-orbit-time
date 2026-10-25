#!/usr/bin/env node
/**
 * One-shot build + install for Orbit Time.
 *
 *   node build.mjs              build both halves, then install into the profile
 *   node build.mjs --no-install build only
 *
 * Regenerating `lib/client.js` is enough for client-half changes to reach a
 * running DSH — its HMR watcher re-stamps the plugin revision by mtime, so a
 * page reload picks the new bundle up. Loader *entries* are read once at host
 * start, so a new plugin or a config change needs an app restart.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, 'packages', 'orbit-time')
const install = !process.argv.includes('--no-install')

function run(label, script, args = []) {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(process.execPath, [script, ...args], { cwd: pkgDir, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

run('client half', join(pkgDir, 'scripts', 'build-client.mjs'))
run('host half', join(pkgDir, 'scripts', 'build-host.mjs'))
if (install) run('install into profile', join(pkgDir, 'scripts', 'sync-profile.mjs'))

console.log('\ndone.')
if (install) {
  console.log('The host reads its loader entries at startup: restart DeepSeek Harness')
  console.log('if this was the first install or you changed cordis.patch.yml.')
  console.log('Client-half changes only need a page refresh.')
}
void resolve
