#!/usr/bin/env node
/**
 * Copy the built plugin into the DSH profile's node_modules.
 *
 * The Cordis Loader resolves a plugin entry by package *name* from the profile
 * directory, so the package has to be resolvable there. A real directory copy is
 * used rather than a workspace link because the profile's pnpm store is DSH's
 * own, and a copy keeps the plugin's dev dependencies (React, react-dom) out of
 * the profile entirely.
 *
 * Usage:
 *   node scripts/sync-profile.mjs                    # default: %USERPROFILE%\.dsh\profiles\desktop
 *   node scripts/sync-profile.mjs <profile dir>      # explicit profile
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profileDir = resolve(args[0] || join(dshHome, 'profiles', 'desktop'))

if (!existsSync(join(profileDir, 'cordis.yml'))) {
  console.error(`sync-profile: ${profileDir} does not look like a dsh profile (no cordis.yml)`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const target = join(profileDir, 'node_modules', pkg.name)

for (const required of ['lib/index.js', 'lib/client.js', 'lib/hud.ps1', 'lib/parse-xlsx.py', 'lib/shared-repair.cjs']) {
  if (!existsSync(join(root, required))) {
    console.error(`sync-profile: ${required} is missing — run the build first`)
    process.exit(1)
  }
}

rmSync(target, { recursive: true, force: true })
mkdirSync(dirname(target), { recursive: true })

// Ship only what the loader needs: the manifest, the two halves, and the two
// runtime assets. No src, no scripts, no node_modules.
cpSync(join(root, 'package.json'), join(target, 'package.json'))
mkdirSync(join(target, 'lib'), { recursive: true })
for (const file of ['index.js', 'client.js', 'hud.ps1', 'parse-xlsx.py', 'shared-repair.cjs']) {
  cpSync(join(root, 'lib', file), join(target, 'lib', file))
}

// The Cordis entry lives in cordis.patch.yml (the profile's patch layer), which
// is what every other plugin entry in this profile uses. Declaring the package
// in package.json as well would invite pnpm to replace this directory with a
// link back into the source checkout.
//
// The entry MUST be wrapped in an `insert:` list. A top-level row is an
// OVERRIDE of an existing entry id, and an id no bundle declares is only
// reported as an unmatched patch — the plugin then silently never mounts.
if (existsSync(join(profileDir, 'cordis.patch.yml'))) {
  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const hasInsert = /^\s*-?\s*insert:/m.test(patch) && patch.includes(pkg.name)
  const looksTopLevel = /^\s*-\s*id:\s*orbit-time\s*$/m.test(patch)
  if (looksTopLevel && !hasInsert) {
    console.error('sync-profile: cordis.patch.yml has a top-level `- id: orbit-time` row.')
    console.error('sync-profile: wrap it in an `insert:` list or the loader will never mount it.')
    process.exitCode = 1
  }
}

console.log(`sync-profile: ${pkg.name}@${pkg.version} -> ${target}`)
console.log('sync-profile: NOTE — this replaces the directory. A running host keeps executing')
console.log('sync-profile: the HOST half it imported at boot, so a host-half change needs an')
console.log('sync-profile: app restart; a client-half change only needs a page refresh.')
