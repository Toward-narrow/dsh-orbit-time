#!/usr/bin/env node
/**
 * Run the plugin's `apply()` against a deliberately bare context and report the
 * first thing that throws.
 *
 * The loader treats a failing optional entry as a warning and keeps going, so a
 * thrown `apply()` looks identical to "the plugin is not installed". This strips
 * the contract down to its minimum — `webServer` with just `register`, `timer`,
 * `effect` — and then adds one capability at a time, so the missing piece is
 * named instead of guessed.
 *
 * Run: node scripts/probe-apply.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// Accept an explicit entry path so the copy installed in the live profile can be
// probed directly, which is the only copy that matters when the host is running.
const target = process.argv[2] ? resolve(process.argv[2]) : join(root, 'lib', 'index.js')

const scratch = mkdtempSync(join(tmpdir(), 'orbit-apply-'))
process.env.DSH_HOME = scratch

const mod = await import(pathToFileURL(target).href)
console.log(`entry: ${target}`)
console.log(`dsh home: ${scratch}`)
console.log(`inject: ${mod.inject.join(', ')}`)

function makeCtx(overrides = {}) {
  const registered = []
  const base = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    webServer: {
      port: 0,
      register(route) {
        registered.push(route.path)
        return () => {}
      },
    },
    interval: () => () => {},
    timeout: () => () => {},
    effect: () => () => {},
    get: () => undefined,
  }
  return { ctx: { ...base, ...overrides }, registered }
}

const scenarios = [
  ['minimum contract (webServer.register + timer + effect)', {}],
  ['without ctx.effect', { effect: undefined }],
  ['without ctx.interval', { interval: undefined }],
  ['without ctx.timeout', { timeout: undefined }],
  ['without ctx.get', { get: undefined }],
  ['webServer without register', { webServer: { port: 0 } }],
  ['webServer without port', { webServer: { register: () => () => {} } }],
]

for (const [label, overrides] of scenarios) {
  const { ctx, registered } = makeCtx(overrides)
  const keys = Object.keys(overrides)
  for (const key of keys) {
    if (overrides[key] === undefined) delete ctx[key]
  }
  let outcome
  try {
    const result = mod.apply(ctx, { profile: { name: '张三' }, workbook: { path: '', watch: false, sources: [] } })
    outcome = result === undefined ? 'ok (sync)' : `ok (${typeof result})`
  } catch (error) {
    outcome = `THREW ${error.constructor.name}: ${error.message}`
  }
  console.log(`  ${outcome.startsWith('ok') ? 'ok  ' : 'FAIL'}  ${label} — ${outcome}${registered.length > 0 ? ` (${registered.length} routes)` : ''}`)
}

// Whatever happened above, the state directory the plugin creates is the proof
// that a full apply() got far enough to matter.
const { existsSync, readdirSync } = await import('node:fs')
const stateDir = join(scratch, 'storages', 'orbit-time')
console.log(`\nstate dir created: ${existsSync(stateDir)}`)
if (existsSync(stateDir)) console.log(`  contents: ${readdirSync(stateDir).join(', ') || '(empty)'}`)

rmSync(scratch, { recursive: true, force: true })
