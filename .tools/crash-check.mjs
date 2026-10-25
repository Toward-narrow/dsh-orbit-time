#!/usr/bin/env node
/**
 * Prove the panel's error boundary works, end to end.
 *
 * The failure this guards against is a blank window: a throw inside a render
 * unmounts the whole React tree, and the harness has no boundary of its own. So
 * this deliberately reintroduces the exact bug that did it (`now.getHours()` on
 * the panel's millisecond clock), mounts the bundle in a real browser, clicks the
 * button that used to blank the page, and requires a crash card to appear.
 *
 * Run: node .tools/crash-check.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const pkg = join(repo, 'packages', 'orbit-time')
const bundle = join(pkg, 'lib', 'client.js')
const harness = join(repo, '.cache', 'click-harness.html')

const fixed = "var now = new Date(typeof props.now === 'number' ? props.now : Date.now())"
const broken = 'var now = props.now || new Date()'
const original = readFileSync(bundle, 'utf8')
if (!original.includes(fixed)) {
  console.log('MARKER NOT FOUND — build the client first (node build.mjs)')
  process.exit(1)
}

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

try {
  writeFileSync(bundle, original.replace(fixed, broken), 'utf8')
  spawnSync(process.execPath, [join(here, 'browser-click.mjs')], { encoding: 'utf8', windowsHide: true })
  const browser = browsers.find((candidate) => existsSync(candidate))
  if (browser === undefined) {
    console.log('no Edge/Chrome found — cannot prove the boundary here')
    process.exit(0)
  }
  const dump = spawnSync(browser, ['--headless=new', '--disable-gpu', '--virtual-time-budget=6000', '--dump-dom', pathToFileURL(harness).href], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90_000,
  })
  const host = /<div id="host">([\s\S]*?)<\/div><pre id="log">/.exec(dump.stdout || '')
  const inside = host === null ? '' : host[1]
  const message = /ot-crash-msg">([^<]{0,140})/.exec(inside)
  console.log('crash card shown:', inside.includes('ot-crash-card') ? 'yes' : 'NO')
  console.log('card says:', message === null ? '(nothing)' : message[1])
  console.log('panel content kept:', inside.length, 'chars')
  process.exitCode = inside.includes('ot-crash-card') ? 0 : 1
} finally {
  writeFileSync(bundle, original, 'utf8')
  console.log('bundle restored')
}
