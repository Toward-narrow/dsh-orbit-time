#!/usr/bin/env node
/**
 * Reproduce the Cordis loader's resolution of the `orbit-time` entry.
 *
 * The loader imports a plugin entry by package name with the profile directory
 * as the base. When that fails, the host logs it and carries on, so the only
 * visible symptom is "the plugin is not there". This runs the same import two
 * ways — bare specifier from the profile base, and direct file URL — and prints
 * the exact error, which is what the host log would say.
 *
 * Run: node scripts/probe-entry.mjs
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')
const installed = join(profileDir, 'node_modules', 'dsh-orbit-time')

console.log(`profile:   ${profileDir}`)
console.log(`installed: ${installed}  (exists: ${existsSync(installed)})`)

function report(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      console.log(`  ok    ${label}${value === undefined ? '' : ' — ' + value}`)
      return value
    })
    .catch((error) => {
      console.log(`  FAIL  ${label}: ${error.constructor.name}: ${error.message}`)
      if (error.code) console.log(`        code: ${error.code}`)
      return null
    })
}

console.log('\n--- package resolution ---')
const require_ = createRequire(join(profileDir, 'package.json'))
await report('require.resolve from the profile base', () => require_.resolve('dsh-orbit-time'))
await report('manifest is readable', () => {
  const manifest = require_('dsh-orbit-time/package.json')
  return `${manifest.name}@${manifest.version} type=${manifest.type} main=${manifest.main}`
})
await report('manifest declares dsh.client', () => {
  const manifest = require_('dsh-orbit-time/package.json')
  if (!manifest.dsh?.client) throw new Error('no dsh.client declaration')
  return JSON.stringify(manifest.dsh.client)
})

console.log('\n--- host half import ---')
const manifest = require_('dsh-orbit-time/package.json')
const entryUrl = pathToFileURL(join(installed, manifest.main)).href
console.log(`  entry url: ${entryUrl}`)

const direct = await report('import() the entry file directly', async () => {
  const mod = await import(entryUrl)
  const shape = []
  if (typeof mod.apply === 'function') shape.push('apply')
  if (Array.isArray(mod.inject)) shape.push(`inject=${mod.inject.join(',')}`)
  if (typeof mod.name === 'string') shape.push(`name=${mod.name}`)
  if (typeof mod.default === 'object' && mod.default !== null) shape.push('has default')
  if (shape.length === 0) throw new Error(`module exposes nothing usable: ${Object.keys(mod).join(',')}`)
  return shape.join(' ')
})

await report('import() by bare specifier (what the loader does)', async () => {
  // A bare specifier only resolves through Node's resolver when the importing
  // module's base URL is inside the profile tree, which is exactly the case the
  // loader creates.
  const probeFile = join(profileDir, `.__orbit_probe_${process.pid}.mjs`)
  const { writeFileSync, rmSync } = await import('node:fs')
  writeFileSync(probeFile, `const mod = await import('dsh-orbit-time')\nexport default Object.keys(mod)\n`, 'utf8')
  try {
    const mod = await import(pathToFileURL(probeFile).href)
    return `exports: ${(mod.default || []).join(', ')}`
  } finally {
    rmSync(probeFile, { force: true })
  }
})

if (direct !== null) {
  console.log('\n--- the plugin contract, as the loader would read it ---')
  const mod = await import(entryUrl)
  await report('inject lists services the host must provide', () => {
    return mod.inject.join(', ')
  })
  await report('apply is callable with an empty config', () => {
    if (typeof mod.apply !== 'function') throw new Error('apply is missing')
    return `${mod.apply.length} declared parameter(s)`
  })
  await report('the runtime assets are next to the entry', async () => {
    const { existsSync: exists } = await import('node:fs')
    const missing = ['hud.ps1', 'parse-xlsx.py', 'client.js'].filter((file) => !exists(join(installed, 'lib', file)))
    if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
    return 'hud.ps1, parse-xlsx.py, client.js'
  })
  await report('hud.ps1 carries the UTF-8 BOM PowerShell 5.1 needs', async () => {
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(join(installed, 'lib', 'hud.ps1'))
    if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) throw new Error('no BOM; Chinese strings would be mojibake')
    return 'EF BB BF'
  })
  await report('python resolves and imports openpyxl', async () => {
    const { spawnSync } = await import('node:child_process')
    const python =
      process.env.DSH_PYTHON ||
      join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
    if (!existsSync(python)) throw new Error(`no python at ${python}`)
    const result = spawnSync(python, ['-c', 'import openpyxl;print(openpyxl.__version__)'], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
    return `openpyxl ${result.stdout.trim()}`
  })
}

void resolve
