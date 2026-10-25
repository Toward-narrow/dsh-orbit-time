#!/usr/bin/env node
/**
 * Where the schedule is stored, and what an upgrade does with the old copy.
 *
 * The failure this pins down: the host resolved its state directory from
 * `$DSH_HOME` alone, which the desktop app does not export to plugin code, so the
 * state landed in `os.tmpdir()`. Windows clears that directory (Storage Sense,
 * disk cleanup), taking the imported schedule with it — "导入的日程过几天就没了".
 *
 * The checks, run against a scratch home and a scratch temp root so nothing real
 * is touched:
 *
 *   1. no $DSH_HOME + a populated legacy temp directory  -> state moves to
 *      <home>/.dsh/storages/orbit-time and the old data is carried over;
 *   2. an explicit $DSH_HOME                              -> that directory is
 *      used and nothing is adopted from temp.
 *
 * Run: node scripts/test-state-location.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const moduleUrl = pathToFileURL(join(root, 'lib', 'index.js')).href

const failures = []
function check(label, fn) {
  try {
    console.log(`  ok   ${label} — ${fn()}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}: ${error.message}`)
  }
}

function makeCtx() {
  return {
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
    webServer: { port: 0, register: () => () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    effect: () => () => {},
  }
}

/** A scratch world: its own home, and its own temp root. */
function scratchWorld() {
  const base = mkdtempSync(join(tmpdir(), 'orbit-migrate-'))
  const home = join(base, 'home')
  const temp = join(base, 'temp')
  mkdirSync(home, { recursive: true })
  mkdirSync(temp, { recursive: true })
  return { base, home, temp }
}

/** Seed the legacy temp state the way the old build left it. */
function seedLegacy(temp) {
  const dir = join(temp, 'orbit-time')
  mkdirSync(join(dir, 'uploads'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ profile: { name: '张三' } }), 'utf8')
  writeFileSync(
    join(dir, 'runtime.json'),
    JSON.stringify({ events: [{ id: 'ev_1', title: '示例支部早打卡值班', date: '2026-10-28', start: '07:00', end: '07:30' }] }),
    'utf8',
  )
  writeFileSync(join(dir, 'uploads', '示例支部早打卡排班表.xlsx'), 'legacy-bytes', 'utf8')
  return dir
}

function withEnv(overrides, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const module = await import(moduleUrl)

// ------------------------------------------------------- 1 · default home migrates

{
  const world = scratchWorld()
  const legacyDir = seedLegacy(world.temp)
  const routes = new Map()
  const ctx = makeCtx()
  ctx.webServer.register = (route) => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  }
  withEnv({ DSH_HOME: undefined, USERPROFILE: world.home, TEMP: world.temp, TMP: world.temp }, () => {
    module.apply(ctx, { profile: { name: '张三' }, workbook: { path: '', watch: false, sources: [] }, ui: { showFloatingWidget: false } })
  })
  const durable = join(world.home, '.dsh', 'storages', 'orbit-time')

  check('a default home keeps state under ~/.dsh/storages/orbit-time', () => {
    if (!existsSync(durable)) throw new Error(`missing ${durable}`)
    return durable.replace(world.home, '~')
  })

  check('the previous temp state is carried over, not abandoned', () => {
    const config = JSON.parse(readFileSync(join(durable, 'config.json'), 'utf8'))
    if (config.profile?.name !== '张三') throw new Error('config.json was not migrated')
    const runtime = JSON.parse(readFileSync(join(durable, 'runtime.json'), 'utf8'))
    if (!Array.isArray(runtime.events) || runtime.events.length !== 1) throw new Error('runtime.json was not migrated')
    const uploads = readdirSync(join(durable, 'uploads'))
    if (uploads.length !== 1) throw new Error(`uploads has ${uploads.length} entries`)
    return `${runtime.events.length} event(s) + 1 upload copied from ${legacyDir.replace(world.temp, '<temp>')}`
  })

  check('the migrated schedule is what the host reports', () => {
    const handler = routes.get('/api/orbit-time/health')
    if (handler === undefined) throw new Error('/health is not registered')
    let payload = null
    const res = {
      writeHead() {},
      end(body) {
        payload = JSON.parse(String(body))
      },
    }
    handler({ method: 'GET', url: '/api/orbit-time/health' }, res)
    if (payload.stateDir !== durable) throw new Error(`health says ${payload.stateDir}`)
    if (payload.events !== 1) throw new Error(`health reports ${payload.events} events`)
    return `${payload.events} event(s), stateDir reported`
  })

  rmSync(world.base, { recursive: true, force: true })
}

// ------------------------------------------------------- 2 · explicit home does not

{
  const world = scratchWorld()
  const explicit = join(world.base, 'explicit-home')
  seedLegacy(world.temp)
  withEnv({ DSH_HOME: explicit, USERPROFILE: world.home, TEMP: world.temp, TMP: world.temp }, () => {
    module.apply(makeCtx(), { workbook: { path: '', watch: false, sources: [] }, ui: { showFloatingWidget: false } })
  })
  const dir = join(explicit, 'storages', 'orbit-time')
  check('an explicit DSH_HOME uses its own directory and adopts nothing', () => {
    if (!existsSync(dir)) throw new Error(`missing ${dir}`)
    if (existsSync(join(dir, 'runtime.json'))) throw new Error('it adopted another install\'s runtime.json')
    if (existsSync(join(dir, 'config.json'))) throw new Error('it adopted another install\'s config.json')
    return 'clean state directory'
  })
  rmSync(world.base, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('state-location checks passed')
