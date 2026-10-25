#!/usr/bin/env node
/**
 * One-off refactor: qualify the HUD's geometry and font variables with `script:`.
 *
 * The values moved into script scope so Scale-Ui() can rescale them after the
 * display DPI is known. PowerShell resolves a bare `$name` to the enclosing
 * scope at read time, but assigning a bare `$name` inside a function would
 * create a local shadow instead — so every reference has to be explicit.
 *
 * Run: node scripts/qualify-hud-vars.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, '..', 'src', 'host', 'hud.ps1')

const NAMES = [
  'pillWidth',
  'pillHeight',
  'pillCorner',
  'miniSize',
  'miniCorner',
  'miniRingSize',
  'miniRingX',
  'ringSize',
  'ringStroke',
  'ringX',
  'ringY',
  'hitPlay',
  'hitMin',
  'hitExpand',
  'hitClose',
  'hitMiniRing',
  'hitMiniClose',
  'hitMiniGrow',
  'fontTime',
  'fontSubject',
  'fontMeta',
  'fontMini',
  'fontGlyph',
  'fontGlyphSmall',
  'pillPath',
  'miniPath',
  'uiScale',
]

const source = readFileSync(target, 'utf8')
const lines = source.split(/\r?\n/)
const counts = new Map()
let changed = 0

const result = lines.map((line) => {
  // Leave the definitions inside Scale-Ui / the script-scope declarations alone.
  if (/^\s*\$script:/.test(line)) return line
  let output = line
  for (const name of NAMES) {
    // `$name` not already qualified, not `$script:name`, not a longer identifier.
    const pattern = new RegExp(`(?<!\\$script:)(?<![\\w:$])\\$${name}(?![\\w])`, 'g')
    const hits = output.match(pattern)
    if (hits === null) continue
    counts.set(name, (counts.get(name) ?? 0) + hits.length)
    output = output.replace(pattern, `$script:${name}`)
  }
  if (output !== line) changed += 1
  return output
})

writeFileSync(target, result.join('\r\n'), 'utf8')

console.log(`qualified references on ${changed} line(s)`)
for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  $${name} -> $script:${name}`)
}
