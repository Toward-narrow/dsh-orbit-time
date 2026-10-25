#!/usr/bin/env node
/**
 * Stage the host half's runtime assets into `lib/`.
 *
 * `hud.ps1` is served to Windows PowerShell 5.1, which decodes a BOM-less file
 * as the ANSI code page: the Chinese UI strings would arrive as mojibake. So the
 * staged copy is always written **with** a UTF-8 BOM, and the source stays
 * BOM-free for clean diffs.
 *
 * `repair.cjs` is a plain copy. It is authored under `src/shared/` because the
 * client build inlines the same file, but the host imports it from `lib/` — the
 * profile install copies only `lib/`, so a host import that reached outside the
 * package would resolve in the checkout and fail once installed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src', 'host')
const sharedSrcDir = join(root, 'src', 'shared')
const libDir = join(root, 'lib')

mkdirSync(libDir, { recursive: true })

const BOM = '\uFEFF'
let staged = 0

for (const file of ['hud.ps1', 'parse-xlsx.py']) {
  const from = join(srcDir, file)
  if (!existsSync(from)) {
    console.error(`build-host: missing ${from}`)
    process.exitCode = 1
    continue
  }
  const to = join(libDir, file)
  if (file.endsWith('.ps1')) {
    const body = readFileSync(from, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    writeFileSync(to, BOM + body, 'utf8')
  } else {
    copyFileSync(from, to)
  }
  staged += 1
}

for (const [from, to] of [['repair.cjs', 'shared-repair.cjs']]) {
  const source = join(sharedSrcDir, from)
  if (!existsSync(source)) {
    console.error(`build-host: missing ${source}`)
    process.exitCode = 1
    continue
  }
  copyFileSync(source, join(libDir, to))
  staged += 1
}

console.log(`build-host: staged ${staged} runtime asset(s) into ${libDir}`)
