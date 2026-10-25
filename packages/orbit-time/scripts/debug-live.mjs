#!/usr/bin/env node
/**
 * Read the running host's `/debug` payload, or wait for the page to report in.
 *
 * The plugin's own routes need a page session, so they answer 401 to a bare
 * script — that is the harness's auth layer, not the plugin refusing. The value
 * of this route is on the page side: open DevTools on the Harness window and run
 *
 *   await (await fetch('/api/orbit-time/debug')).json()
 *
 * If the page cannot reach it either, then the host half is not mounted and the
 * problem is the loader entry.
 *
 * This script therefore explains how to read it and, when a token is supplied,
 * reads it for you:
 *
 *   node scripts/debug-live.mjs <token>
 */
const token = process.argv[2]
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
const url = `${base}/api/orbit-time/debug`

if (token === undefined) {
  console.log('How to read the live diagnostics')
  console.log('')
  console.log('  In the Harness window, open DevTools (Ctrl+Shift+I) and run:')
  console.log('')
  console.log("    copy(JSON.stringify(await (await fetch('/api/orbit-time/debug')).json(), null, 2))")
  console.log('')
  console.log('  What to look for:')
  console.log('    requests  — a path that never increments means the click never left the page')
  console.log('                (a pointer-events or stacking problem), not a failing handler')
  console.log('    uiReports — whether the overlay reported its own layout at all')
  console.log('    clientLayout.roots[].hitAtButton')
  console.log('              — what element is actually painted over the card buttons.')
  console.log('                "ours: button..." is correct; anything else is the blocker')
  console.log('    hud.logTail — what the floating widget did, from the widget side')
  console.log('')
  console.log(`Plain fetch of ${url} returns 401 without a page session; that is expected.`)
  process.exit(0)
}

const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
console.log(`${response.status} ${response.statusText}`)
console.log(await response.text())
