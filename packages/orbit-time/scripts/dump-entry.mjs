/** Print the parsed `orbit-time` entry — diagnostics for the profile config. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readOrbitTimeConfig } from './parse-patch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
void here

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const path = resolve(process.argv[2] || join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'))
console.log(`file: ${path}`)
console.log(JSON.stringify(readOrbitTimeConfig(readFileSync(path, 'utf8')), null, 1))
