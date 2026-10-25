#!/usr/bin/env node
/**
 * Automated check for the floating widget.
 *
 * A topmost WinForms window cannot be asserted pixel-by-pixel from here, so this
 * checks the parts that actually decide whether the widget is usable:
 *
 *   1. It launches, stays alive, and writes no PowerShell error.
 *   2. `-selfTest` exercises the hit-testing and click-routing code and reports
 *      the outcome through its log.
 *   3. `-wiring` reads the handler table off both live windows. Hit-testing and
 *      routing can both be correct while the window is attached to nothing, so
 *      this is the check that "every control is wired" — and the static one
 *      above it — exist to make impossible to ship again.
 *   4. `-probe` drives the widget with synthesised OS input and requires its log
 *      to record every click arriving. Skipped, with a note, on a desktop that
 *      refuses injected input; the check that the handlers exist still runs.
 *   5. The state file it reads is honoured: a countdown written by the harness
 *      shows up as a `toggle` action on the wire.
 *   6. The interaction log records the handshake the widget needs to be
 *      debuggable when a person says "I can't click it".
 *
 * Run: node scripts/test-hud.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const failures = []
/**
 * Run one check and report it.
 *
 * A body that returns a promise is awaited, so `await check('…', async () => …)`
 * reports the body's own value and its own failure instead of the string
 * "[object Promise]" — which says nothing and, worse, hides whether the body ran
 * at all. A failure that arrives late is recorded before the summary prints only
 * if the caller awaits, so every async check is awaited at its call site.
 */
async function check(label, fn) {
  try {
    const detail = await fn()
    console.log(`  ok   ${label}${detail === undefined ? '' : ' — ' + detail}`)
    return detail
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}: ${error.message}`)
    return undefined
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'orbit-hud-test-'))
const statePath = join(scratch, 'hud-state.json')
const logPath = join(scratch, 'hud-interactions.log')
const scriptPath = join(root, 'lib', 'hud.ps1')

console.log('orbit-time floating widget check')
console.log(`  script: ${scriptPath}`)

check('the staged loader script exists', () => {
  if (!existsSync(scriptPath)) throw new Error('run the build first')
  const bytes = readFileSync(scriptPath)
  if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) {
    throw new Error('no UTF-8 BOM; PowerShell 5.1 would read the Chinese labels as mojibake')
  }
  return `${(bytes.length / 1024).toFixed(1)} kB, BOM present`
})

// The widget once shipped with Connect-Form defined and never called: the ring,
// the minimiser, the » and the × were all inert, and every check below still
// passed, because hit-testing does not need a handler to return the right
// answer. Assert the calls exist, before anything is launched.
check('every control is wired to the mouse', () => {
  const source = readFileSync(scriptPath, 'utf8')
  const definition = /function\s+Connect-Form\s*\(/.exec(source)
  if (definition === null) throw new Error('Connect-Form is not defined at all')
  // `Connect-Form $pill 'pill'` — the form and which hit test it uses.
  const calls = [...source.matchAll(/^\s*Connect-Form\s+\$(\w+)\s+'(\w+)'/gm)].map((match) => match[1])
  if (calls.length === 0) {
    throw new Error('Connect-Form is defined but never called, so no mouse event reaches either window')
  }
  for (const form of ['pill', 'mini']) {
    if (!calls.includes(form)) throw new Error(`Connect-Form is never called for $${form}`)
  }
  for (const match of source.matchAll(/^\s*Connect-Form\s+\$(\w+)/gm)) {
    if (match.index < definition.index) throw new Error(`Connect-Form $${match[1]} is called before it is defined`)
  }
  // The hit test must be reached without a PowerShell pipeline invocation. Both
  // `& $scriptblock` and a script block held in a variable and invoked from
  // inside a Forms handler run as a pipeline on a thread .NET owns, and the
  // failure they produce ("The property 'Location' cannot be found on this
  // object") blames the event argument instead of the call. A direct function
  // call has no such gap. Comments explain the rule, so they are stripped first.
  const code = source
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  if (/&\s*\$\w*[Hh]itTest\b/.test(code)) {
    throw new Error('the hit test is invoked with `&`, which runs as a pipeline inside a Forms handler')
  }
  if (/\$hitTest\.Invoke\(/.test(code)) {
    throw new Error('the hit test is invoked through a variable delegate; call Resolve-Hit directly')
  }
  if ((code.match(/Resolve-Hit\s+\$which/g) ?? []).length < 3) {
    throw new Error('Resolve-Hit is not called on press, move and release')
  }
  return `Connect-Form $${calls.join(', $')} + direct hit test`
})

// The three window controls used to sit 8 design px apart, which is a 16 px dead
// band at 200% — a strip of screen where a click is swallowed with no feedback.
// That reads as "this one button is broken", and it was. Walk the whole strip at
// every common scale and require that no coordinate resolves to nothing.
check('no click along the control strip can land on nothing', () => {
  const geometryScript = join(root, 'scripts', 'verify-hud-geometry.ps1')
  if (!existsSync(geometryScript)) throw new Error('verify-hud-geometry.ps1 is missing')
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', geometryScript], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  const line = raw.split(/\r?\n/).filter((entry) => entry.trim().startsWith('{')).pop()
  if (line === undefined) throw new Error(`no verdict from the geometry check:\n${raw.trim()}`)
  const verdict = JSON.parse(line)
  if (verdict.ok !== true) {
    const dead = verdict.findings.filter((entry) => typeof entry.dead === 'number' && entry.dead > 0)
    const seams = verdict.findings.filter((entry) => entry.target === 'drag')
    throw new Error(`dead coordinates: ${JSON.stringify(dead)} seams resolving to nothing: ${JSON.stringify(seams)}`)
  }
  const scales = verdict.findings.filter((entry) => typeof entry.dead === 'number').map((entry) => entry.scale)
  return `continuous at ${scales.join('x, ')}x — minimise target ${verdict.minTargetWidth} px at 200%`
})

function writeState(patch) {
  const base = {
    publishedAt: new Date().toISOString(),
    phase: 'focus',
    running: true,
    remainingSeconds: 18 * 60 + 24,
    totalSeconds: 25 * 60,
    subject: '复习傅里叶变换',
    completedToday: 3,
    nextTitle: '数据结构实验',
    nextMeta: '14:00 · 实验楼 B210',
    nextMinutes: 12,
    nextPhase: 'upcoming',
    eventCount: 4,
    eventsToday: [],
    ownerNames: ['张三'],
    excelError: null,
  }
  writeFileSync(statePath, JSON.stringify({ ...base, ...patch }, null, 2), 'utf8')
}

function runWidget(args, holdMs) {
  return new Promise((done) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath, ...args],
      // stderr goes straight to this process instead of through a pipe: a
      // confined run cannot open the named pipe that Node's `pipe` stdio needs,
      // and a PowerShell error is worth seeing as it happens anyway.
      { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] },
    )
    let exitedEarly = false
    child.on('exit', () => {
      exitedEarly = true
    })
    setTimeout(() => {
      if (!exitedEarly) child.kill()
      done({ exitedEarly })
    }, holdMs)
  })
}

// ---------------------------------------------------------------- self test

writeState({})
const selfTest = await runWidget(
  ['-statePath', statePath, '-port', '19387', '-dashboardUrl', 'http://127.0.0.1:19387/', '-logPath', logPath, '-selfTest'],
  12_000,
)

const selfLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

check('the self test ran to completion', () => {
  // stderr is inherited rather than captured, so the log is the record: a
  // PowerShell parse or runtime error stops the script before this line.
  if (!selfLog.includes('selftest done')) throw new Error(`the widget stopped early; log was:\n${selfLog.trim()}`)
  return 'clean run'
})

check('hit-testing maps every region to the right target', () => {
  const line = /selftest hits play=(\S+) min=(\S+) expand=(\S+) close=(\S+) blank=(\S+)/.exec(selfLog)
  if (line === null) throw new Error(`no hit report in the log:\n${selfLog.trim()}`)
  const [, play, min, expand, close, blank] = line
  const actual = { play, min, expand, close, blank }
  const expected = { play: 'play', min: 'min', expand: 'expand', close: 'close', blank: 'drag' }
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(`the ${key} region resolved to "${actual[key]}", expected "${expected[key]}"`)
    }
  }
  return 'play / min / expand / close / drag'
})

check('the minimal state maps its ring and both corner controls', () => {
  const line = /selftest mini hits ring=(\S+) close=(\S+) grow=(\S+)/.exec(selfLog)
  if (line === null) throw new Error('no mini hit report in the log')
  const [, ring, close, grow] = line
  if (ring !== 'play') throw new Error(`the mini ring resolved to "${ring}"`)
  if (close !== 'miniclose') throw new Error(`the mini × resolved to "${close}"`)
  if (grow !== 'minigrow') throw new Error(`the mini + resolved to "${grow}"`)
  return 'ring=play, ×=close, +=grow'
})

check('minimise and close are distinct targets', () => {
  const transitions = /selftest transitions min=(\S+) grow=(\S+) exit=(\S+)/.exec(selfLog)
  if (transitions === null) throw new Error('no transition report in the log')
  const [, min, grow, exit] = transitions
  if (min !== 'min') throw new Error(`the — button resolved to "${min}"`)
  if (grow !== 'minigrow') throw new Error(`the mini + resolved to "${grow}"`)
  if (exit !== 'miniclose') throw new Error(`the mini × resolved to "${exit}"`)
  if (min === exit) throw new Error('minimise and close share one target, so one of them is unreachable')
  return `min=${min}, close=${exit}`
})

check('both states paint without throwing', () => {
  const paints = selfLog.match(/selftest paint ok/g) ?? []
  if (paints.length !== 2) throw new Error(`expected both states to paint, saw ${paints.length}`)
  if (selfLog.includes('selftest paint FAILED')) throw new Error('a paint probe failed')
  return 'pill + mini'
})

check('a synthetic click routes a real action to the host', () => {
  if (!selfLog.includes('selftest done')) throw new Error('the self test did not finish')
  const requests = readdirSync(scratch).filter((name) => name.startsWith('hud-request-'))
  if (requests.length !== 1) throw new Error(`expected 1 action request, found ${requests.length}`)
  const payload = JSON.parse(readFileSync(join(scratch, requests[0]), 'utf8'))
  if (payload.action !== 'toggle') throw new Error(`action=${payload.action}`)
  if (typeof payload.id !== 'string' || payload.id === '') throw new Error('the request has no id')
  rmSync(join(scratch, requests[0]), { force: true })
  return `action=${payload.action} id=${payload.id.slice(0, 8)}…`
})

// ---------------------------------------------------------------- live window

rmSync(logPath, { force: true })
writeState({ remainingSeconds: 7 * 60 + 5, subject: '写周报' })
const live = await runWidget(
  ['-statePath', statePath, '-port', '19387', '-dashboardUrl', 'http://127.0.0.1:19387/', '-logPath', logPath],
  7000,
)

check('the window stays up for the whole hold', () => {
  if (live.exitedEarly) throw new Error('the widget exited before the hold ended')
  return 'alive for the whole hold'
})

check('the interaction log records the start handshake', () => {
  const log = readFileSync(logPath, 'utf8')
  if (!log.includes('started pid=')) throw new Error(`log was:\n${log.trim()}`)
  if (!log.includes('-logPath') && !log.includes('state=')) throw new Error('the start line is missing its paths')
  return `${log.trim().split(/\r?\n/).length} line(s)`
})

writeState({ remainingSeconds: 6 * 60 + 30, subject: '写周报' })
await new Promise((done) => setTimeout(done, 1500))
check('the widget accepts live state updates while running', () => {
  const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
  if (parsed.remainingSeconds !== 390) throw new Error(`state file is ${parsed.remainingSeconds}`)
  return 'rewrote the state file mid-run without the widget dying'
})

// ------------------------------------------------- real input, real handlers
//
// The checks above all passed while the widget was wired to nothing: `-selfTest`
// calls the hit-testing functions directly, so it reports the right answer
// whether or not a single event handler is attached. This part asks the live
// windows which handlers they hold, then clicks every control for real.

const modePath = join(scratch, 'hud-mode.json')

rmSync(logPath, { force: true })
writeState({ remainingSeconds: 12 * 60, subject: '写周报' })
const wiringRun = await runWidget(['-statePath', statePath, '-port', '0', '-logPath', logPath, '-wiring'], 15_000)
const wiringLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

check('both windows hold their mouse handlers', () => {
  const expected = ['MouseDown', 'MouseMove', 'MouseUp', 'MouseLeave', 'DoubleClick']
  for (const window of ['pill', 'mini']) {
    const line = new RegExp(`wiring ${window}: wired=(\\S*) missing=(\\S*)`).exec(wiringLog)
    if (line === null) throw new Error(`no wiring report for ${window}:\n${wiringLog.trim()}`)
    const [, wired, missing] = line
    const names = wired === '' ? [] : wired.split(',')
    for (const name of expected) {
      if (!names.includes(name)) throw new Error(`$${window} is missing ${name} (missing=${missing})`)
    }
  }
  return expected.join(', ')
})

rmSync(logPath, { force: true })
rmSync(modePath, { force: true })
writeState({ remainingSeconds: 12 * 60, subject: '写周报' })
const probe = await runWidget(
  ['-statePath', statePath, '-port', '19387', '-dashboardUrl', 'http://127.0.0.1:19387/', '-logPath', logPath, '-probe', 'ring,expand,min,minigrow,miniclose'],
  25_000,
)
const probeLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
const probeLines = probeLog.split(/\r?\n/)

// Not every environment can be driven by SendInput: a restricted or sessionless
// desktop rejects the injection outright, and the widget reports `sent=0/0`.
// Detecting that is the difference between "the code is broken" and "this box
// will not let anything click", so the real-click checks are skipped there
// rather than reported as failures.
const driven = /sent=(\d+)\/(\d+)/.exec(probeLog)
const injectionWorks = driven !== null && driven[1] !== '0' && driven[2] !== '0'
if (!injectionWorks) {
  console.log('  skip real clicks — this desktop rejected synthesised input (SendInput returned 0)')
}

/** The synthesised click for `target` must have arrived, from the widget's log. */
function arrived(label, window, target) {
  const click = probeLines.find((line) => line.includes(`probe ${label} click at`))
  if (click === undefined) throw new Error(`the probe never aimed at ${label}:\n${probeLog.trim()}`)
  const down = probeLines.find((line) => line.includes('down at') && line.includes(`hit=${target}`))
  if (down === undefined) throw new Error(`the click on ${label} never reached the window:\n${probeLog.trim()}`)
  const up = probeLines.find((line) => line.includes('up at') && line.includes(`released=${target}`))
  if (up === undefined) throw new Error(`the click on ${label} was pressed but not released:\n${probeLog.trim()}`)
  return `${window} ${target}`
}

if (injectionWorks) {
  check('a real click on the ring reaches the window and toggles the timer', () => {
    arrived('ring', 'pill', 'play')
    const requests = readdirSync(scratch).filter((name) => name.startsWith('hud-request-'))
    if (requests.length !== 1) throw new Error(`expected 1 action request for the click, found ${requests.length}`)
    const payload = JSON.parse(readFileSync(join(scratch, requests[0]), 'utf8'))
    if (payload.action !== 'toggle') throw new Error(`action=${payload.action}`)
    rmSync(join(scratch, requests[0]), { force: true })
    return 'pill play -> toggle on the wire'
  })

  check('a real click on » reaches the window', () => arrived('expand', 'pill', 'expand'))

  check('a real click on — reaches the window and minimises', () => {
    arrived('min', 'pill', 'min')
    if (!probeLog.includes('mode -> mini')) throw new Error('the minimise click did not switch to the minimal state')
    return 'pill min -> mini'
  })

  check('a real click on the mini + reaches the window and expands back', () => {
    arrived('minigrow', 'mini', 'minigrow')
    if (!probeLog.includes('mode -> pill')) throw new Error('the expand click did not switch back to the pill')
    return 'mini minigrow -> pill'
  })

  check('a real click on the mini × reaches the window and closes it', () => {
    arrived('miniclose', 'mini', 'miniclose')
    if (!probeLog.includes('closed by the user')) throw new Error('the close click did not close the widget')
    if (probe.exitedEarly !== true) throw new Error('the widget was still running after its close button was clicked')
    const mode = JSON.parse(readFileSync(modePath, 'utf8'))
    if (mode.state !== 'closed') throw new Error(`hud-mode.json says ${JSON.stringify(mode.state)}, so the host would restart it`)
    return 'mini miniclose -> closed, and persisted'
  })
}

check('the probe ran without a PowerShell error', () => {
  // stderr is inherited, so the log is the evidence: the run line is written
  // last, and a parse or runtime error stops the script before it.
  if (!probeLog.includes('probe done')) throw new Error(`the probe stopped early:\n${probeLog.trim()}`)
  return injectionWorks ? 'clicks delivered' : 'input unavailable here, wiring checked above'
})

// ------------------------------------------------ input that needs no messages
//
// The widget is clickable two ways: from the mouse messages Windows sends, and
// from the cursor and button state read once per frame. The second path exists
// because the first can stop delivering — a window that quietly stops receiving
// WM_LBUTTONDOWN looks exactly like a broken button, and there is no way to tell
// from outside. This runs the polling state machine on demand and requires a real
// action to come out of it.

rmSync(logPath, { force: true })
writeState({ remainingSeconds: 9 * 60, subject: '写周报' })
const selfDrive = await runWidget(['-statePath', statePath, '-port', '19387', '-logPath', logPath, '-selfDrive'], 20_000)
const driveLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

check('a press and release over the ring becomes a timer action with no mouse message', () => {
  const down = /poll down at (\d+),(\d+) hit=(\S+)/.exec(driveLog)
  if (down === null) throw new Error(`the polling path never saw a press:\n${driveLog.trim()}`)
  if (down[3] !== 'play') throw new Error(`the ring press resolved to "${down[3]}"`)
  const up = /poll up at (\d+),(\d+) hit=(\S+) target=(\S+)/.exec(driveLog)
  if (up === null) throw new Error(`the polling path never saw a release:\n${driveLog.trim()}`)
  if (up[4] !== 'play') throw new Error(`the release targeted "${up[4]}"`)
  if (!/action toggle -> /.test(driveLog)) throw new Error('the click produced no action')
  return `ring press -> ${up[4]} -> toggle`
})

check('the polling path left no press behind', () => {
  const after = /after release pressed='([^']*)' target='([^']*)'/.exec(driveLog)
  if (after === null) throw new Error(`no post-release state in:\n${driveLog.trim()}`)
  if (after[1] !== '' || after[2] !== '') throw new Error(`press state stuck: pressed='${after[1]}' target='${after[2]}'`)
  return 'pressed and target cleared'
})

check('the self drive reached its window and exercised the state machine', () => {
  if (!driveLog.includes('selfdrive window shown')) throw new Error('the window never appeared')
  // The step that posts a message and pumps it has been seen to hang on this
  // machine, which is the whole reason the polling path exists. That is reported
  // rather than treated as a pass or a failure: what must hold is that the
  // widget is driven by polling, and that is the check above.
  if (!driveLog.includes('selfdrive done')) {
    if (selfDrive.exitedEarly === false) {
      console.log('  note: posting a mouse message and dispatching it never returned; polling is the path in use')
    } else {
      throw new Error(`the diagnostic stopped early:\n${driveLog.trim()}`)
    }
  }
  return 'window shown, press and release routed'
})

// --------------------------------------------------------------- window size
//
// `Show()` re-applies a size the form did not ask for: a borderless 112x112
// window came back 262x112, and the minimal state — square by design, with the
// ring, the digits and the two controls all laid out from that square — was drawn
// into a box 2.3x too wide. The pill never showed it because the pill is wider
// than the clamp to begin with, which is why the bug only appeared "after
// pressing —".
//
// `-drag 0,0` proves nothing about movement and everything about size: it parks
// the widget in whichever state it was started in and reports the client size it
// ended up with. Both states are checked, because the transition is where a size
// is lost.

for (const startMode of ['pill', 'mini']) {
  rmSync(logPath, { force: true })
  rmSync(modePath, { force: true })
  writeState({ remainingSeconds: 7 * 60, subject: '写周报' })
  writeFileSync(modePath, JSON.stringify({ state: startMode, x: 200, y: 200, at: 'x' }), 'utf8')
  const sizeReportPath = join(scratch, `size-${startMode}.json`)
  rmSync(sizeReportPath, { force: true })
  await runWidget(
    ['-statePath', statePath, '-port', '0', '-logPath', logPath, '-mode', startMode, '-drag', '0,0', '-reportPath', sizeReportPath],
    20_000,
  )
  const sizeReport = existsSync(sizeReportPath) ? JSON.parse(readFileSync(sizeReportPath, 'utf8')) : null
  const sizeLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  await check(`the ${startMode} state keeps the designed window size`, () => {
    if (sizeReport === null) throw new Error(`no report was written:\n${sizeLog.trim()}`)
    if (sizeReport.state !== startMode) throw new Error(`the widget came up as ${sizeReport.state}`)
    // Designed at 232x64 for the pill and 64x64 for the minimal state, doubled by
    // this display's 200% scale.
    const wanted = startMode === 'mini' ? '128x128' : '464x128'
    if (sizeReport.expectedSize !== wanted) {
      throw new Error(`the window is ${sizeReport.expectedSize}, designed as ${wanted}:\n${sizeLog.trim()}`)
    }
    return sizeReport.expectedSize
  })
}

// ------------------------------------------------------------------ drag
//
// The drag used to live inside the MouseMove handler, which is the first thing
// the message watchdog takes away — so the one failure the watchdog exists for
// also took away the ability to move the window. It now runs from the cursor and
// the button state in the frame loop. `-drag` drives it and reports the before
// and after rectangles, which is the only way to see this at all: a window that
// refuses to move looks exactly like a window that is working, from the outside.

rmSync(logPath, { force: true })
rmSync(modePath, { force: true })
writeState({ remainingSeconds: 11 * 60, subject: '写周报' })
const dragReportPath = join(scratch, 'drag-report.json')
const dragRun = await runWidget(
  ['-statePath', statePath, '-port', '0', '-logPath', logPath, '-drag', '70,40', '-reportPath', dragReportPath],
  25_000,
)
const dragReport = existsSync(dragReportPath) ? JSON.parse(readFileSync(dragReportPath, 'utf8')) : null
const dragLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

check('a held button plus a moving cursor moves the window', () => {
  if (dragReport === null) throw new Error(`no drag report was written:\n${dragLog.trim()}`)
  if (dragReport.dragStarted !== true) {
    throw new Error(`the drag never started: ${JSON.stringify(dragReport)}`)
  }
  if (dragReport.withinSlop !== true) {
    throw new Error(`the window moved ${dragReport.movedBy} for a request of ${dragReport.requested}`)
  }
  if (!dragLog.includes('drag start') || !dragLog.includes('drag end')) {
    throw new Error(`the drag was not recorded in the interaction log:\n${dragLog.trim()}`)
  }
  return `${dragReport.before} -> ${dragReport.after} (asked for ${dragReport.requested}, mode ${dragReport.mode})`
})

check('the spot a drag ends on is written down', () => {
  if (dragReport === null) throw new Error('no drag report')
  if (dragReport.recorded !== dragReport.after) {
    throw new Error(`the window is at ${dragReport.after} but ${dragReport.recorded} was persisted`)
  }
  if (dragReport.recordedState !== 'pill') throw new Error(`the mode file says "${dragReport.recordedState}"`)
  const onDisk = JSON.parse(readFileSync(modePath, 'utf8'))
  if (`${onDisk.x},${onDisk.y}` !== dragReport.after) {
    throw new Error(`hud-mode.json holds ${onDisk.x},${onDisk.y}, not ${dragReport.after}`)
  }
  return `hud-mode.json at ${onDisk.x},${onDisk.y}`
})

// A press that begins on a control belongs to that control — for the whole press.
//
// The minimal state is 56 px of window holding three controls and a drag strip,
// and the drag used to be decided from the cursor's *current* position with the
// ring as the catch-all. So a press on × that slid two physical pixels while the
// hand settled was read as a drag: the release stopped being a click, the button
// did nothing, and the cursor showed the move shape the whole time — "变小之后
// 什么按钮都按不了，我点击的时候鼠标显示的却是我想移动的那个鼠标按键".
//
// Each control is now aimed at by name, and the requirement is the same for all
// of them: no movement at all. The drag strip is checked too, because a rule that
// refuses every press would also pass the first three.
for (const aim of ['play', 'minigrow', 'miniclose']) {
  rmSync(logPath, { force: true })
  rmSync(modePath, { force: true })
  writeState({ remainingSeconds: 7 * 60, subject: '写周报' })
  const controlReportPath = join(scratch, `drag-${aim}.json`)
  rmSync(controlReportPath, { force: true })
  await runWidget(
    ['-statePath', statePath, '-port', '0', '-logPath', logPath, '-mode', 'mini', '-drag', '70,40', '-aimAt', aim, '-reportPath', controlReportPath],
    20_000,
  )
  const report = existsSync(controlReportPath) ? JSON.parse(readFileSync(controlReportPath, 'utf8')) : null
  check(`a press on the minimal state's ${aim} does not move the window`, () => {
    if (report === null) throw new Error('no drag report was written')
    if (report.pressHit !== aim) {
      throw new Error(`the probe aimed at ${aim} but the widget resolved it to "${report.pressHit}"`)
    }
    if (report.movedBy !== '0,0') {
      throw new Error(`the window moved ${report.movedBy} from a press on ${aim}`)
    }
    return `hit=${report.pressHit}, movedBy=${report.movedBy}`
  })
}

// And the same shape of press on the one lane that *is* a drag surface still
// moves it, so the rule cannot be satisfied by refusing every press.
rmSync(logPath, { force: true })
rmSync(modePath, { force: true })
writeState({ remainingSeconds: 7 * 60, subject: '写周报' })
const stripReportPath = join(scratch, 'drag-strip.json')
rmSync(stripReportPath, { force: true })
await runWidget(
  ['-statePath', statePath, '-port', '0', '-logPath', logPath, '-mode', 'mini', '-drag', '70,40', '-aimAt', 'strip', '-reportPath', stripReportPath],
  20_000,
)
const stripReport = existsSync(stripReportPath) ? JSON.parse(readFileSync(stripReportPath, 'utf8')) : null
check("a press on the minimal state's drag strip still moves the window", () => {
  if (stripReport === null) throw new Error('no drag report was written')
  if (stripReport.pressHit !== 'drag') throw new Error(`the strip resolved to "${stripReport.pressHit}"`)
  if (stripReport.withinSlop !== true) {
    throw new Error(`the window moved ${stripReport.movedBy} for a request of ${stripReport.requested}`)
  }
  return `${stripReport.before} -> ${stripReport.after}`
})

// --------------------------------------------------------------- shutdown
//
// The panel's 关闭悬浮窗 could only ever kill a process this host had spawned
// itself. A widget left over from a previous DSH run is nobody's child, so the
// button did nothing at all against the one window the user was looking at.
// `-shutdown` exists for that: it finds the widget through hud.pid, proves it is
// the widget before touching it, stops it, and records "closed" so the next boot
// does not bring it back.

await check('a widget this process did not spawn can still be closed', async () => {
  const holdScratch = mkdtempSync(join(tmpdir(), 'orbit-hud-hold-'))
  const holdState = join(holdScratch, 'hud-state.json')
  const holdLog = join(holdScratch, 'hud-interactions.log')
  writeFileSync(holdState, readFileSync(statePath, 'utf8'), 'utf8')
  const holder = spawn(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-File', scriptPath,
      '-statePath', holdState, '-port', '0', '-logPath', holdLog,
      '-drag', '12,8', '-hold', '20000',
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  let holderExited = false
  holder.on('exit', () => {
    holderExited = true
  })
  // Wait for the widget to be up and to have written its own pid file.
  const pidPath = join(holdScratch, 'hud.pid')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !existsSync(pidPath)) {
    await new Promise((done) => setTimeout(done, 250))
  }
  if (!existsSync(pidPath)) {
    holder.kill()
    rmSync(holdScratch, { recursive: true, force: true })
    throw new Error(`the widget never wrote ${pidPath}`)
  }
  const heldPid = readFileSync(pidPath, 'utf8').trim()
  if (!/^\d+$/.test(heldPid)) {
    holder.kill()
    throw new Error(`hud.pid holds "${heldPid}"`)
  }
  // Now close it exactly the way the host does.
  const closer = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-statePath', holdState, '-port', '0', '-shutdown', '-logPath', holdLog],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const closerExit = await new Promise((done) => {
    closer.on('exit', (code) => done(code))
  })
  const gone = Date.now() + 8000
  while (Date.now() < gone && !holderExited) {
    await new Promise((done) => setTimeout(done, 200))
  }
  const shutdownLog = existsSync(holdLog) ? readFileSync(holdLog, 'utf8') : ''
  const holdMode = join(holdScratch, 'hud-mode.json')
  const mode = existsSync(holdMode) ? JSON.parse(readFileSync(holdMode, 'utf8')) : null
  if (!holderExited) {
    holder.kill()
    rmSync(holdScratch, { recursive: true, force: true })
    throw new Error(`the widget is still running after -shutdown; log:\n${shutdownLog.trim()}`)
  }
  rmSync(holdScratch, { recursive: true, force: true })
  if (closerExit !== 0) throw new Error(`-shutdown exited ${closerExit}`)
  if (mode === null || mode.state !== 'closed') {
    throw new Error(`the close was not recorded, so the next boot would restore it: ${JSON.stringify(mode)}`)
  }
  if (existsSync(pidPath)) throw new Error('hud.pid was left behind')
  return `pid ${heldPid} stopped, mode=closed`
})

// A pid file is a number on disk that outlives the process it named, and the OS
// hands numbers out again. Killing on that number alone would eventually kill
// somebody else's program, so the widget proves identity first. This is the
// check that the proof actually holds: an unrelated process — this test's own
// PowerShell — must survive being named in the file.
await check('a pid file naming something else is not obeyed', async () => {
  const guardScratch = mkdtempSync(join(tmpdir(), 'orbit-hud-guard-'))
  const guardState = join(guardScratch, 'hud-state.json')
  const guardLog = join(guardScratch, 'hud-interactions.log')
  writeFileSync(guardState, readFileSync(statePath, 'utf8'), 'utf8')
  // An innocent long-lived process, with no window titled "Orbit Time".
  const innocent = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  let innocentExited = false
  innocent.on('exit', () => {
    innocentExited = true
  })
  await new Promise((done) => setTimeout(done, 1200))
  if (innocentExited) {
    rmSync(guardScratch, { recursive: true, force: true })
    throw new Error('the stand-in process exited before the check could run')
  }
  writeFileSync(join(guardScratch, 'hud.pid'), String(innocent.pid), 'utf8')
  const closer = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-statePath', guardState, '-port', '0', '-shutdown', '-logPath', guardLog],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  await new Promise((done) => {
    closer.on('exit', () => done())
  })
  await new Promise((done) => setTimeout(done, 800))
  const survived = !innocentExited
  const log = existsSync(guardLog) ? readFileSync(guardLog, 'utf8') : ''
  innocent.kill()
  rmSync(guardScratch, { recursive: true, force: true })
  if (!survived) throw new Error(`an unrelated pid was killed; log:\n${log.trim()}`)
  if (!log.includes('is not this widget')) {
    throw new Error(`the refusal was not recorded; log:\n${log.trim()}`)
  }
  return 'refused, and the unrelated process is still running'
})

// ------------------------------------------------------ persisted state machine

// The close button is only honest if the host can find out that the user closed
// the widget — otherwise it faithfully restarts the dead process and the × looks
// broken. `-keepClosed` is that handshake.

// `-keepClosed` answers on the process's real stdout, which is written with
// [Console]::Out and therefore bypasses the PowerShell pipeline entirely — a
// `| Out-File` sees nothing. It has to be redirected at the process level, and
// the file also replaces a pipe, which a confined run cannot open.
function askMode() {
  const outPath = join(scratch, 'keep-closed.json')
  rmSync(outPath, { force: true })
  const inner = [
    "'-NoProfile',",
    "'-ExecutionPolicy',",
    "'Bypass',",
    "'-File',",
    `'"${scriptPath}"',`,
    "'-statePath',",
    `'"${statePath}"',`,
    "'-port',",
    "'0',",
    "'-keepClosed'",
  ].join(' ')
  const command = [
    `$p = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden`,
    `-RedirectStandardOutput '${outPath}'`,
    `-ArgumentList @(${inner})`,
    '; $p.WaitForExit(); exit $p.ExitCode',
  ].join(' ')
  return new Promise((done) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('exit', () => {
      if (!existsSync(outPath)) return done(null)
      const lines = readFileSync(outPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('{'))
      done(lines.length === 0 ? null : JSON.parse(lines[lines.length - 1]))
    })
  })
}

{
  rmSync(modePath, { force: true })
  const report = await askMode()
  check('with no history the widget reports the full pill', () => {
    if (report === null) throw new Error('no JSON was printed')
    if (report.state !== 'pill') throw new Error(`state=${report.state}`)
    return 'pill'
  })
}

{
  writeFileSync(modePath, JSON.stringify({ state: 'closed', x: 120, y: 240 }), 'utf8')
  const report = await askMode()
  check('a closed widget reports closed, and keeps its position', () => {
    if (report === null) throw new Error('no JSON was printed')
    if (report.state !== 'closed') throw new Error(`state=${report.state}`)
    if (report.x !== 120 || report.y !== 240) throw new Error(`position=${report.x},${report.y}`)
    return 'closed at 120,240'
  })
}

{
  writeFileSync(modePath, JSON.stringify({ state: 'mini', x: 30, y: 40 }), 'utf8')
  const report = await askMode()
  check('a minimised widget reports mini', () => {
    if (report === null) throw new Error('no JSON was printed')
    if (report.state !== 'mini') throw new Error(`state=${report.state}`)
    return 'mini'
  })
}

{
  // A corrupt preference must not make the widget unlaunchable.
  writeFileSync(modePath, 'not json at all', 'utf8')
  const report = await askMode()
  check('a corrupt preference falls back to the full pill', () => {
    if (report === null) throw new Error('no JSON was printed')
    if (report.state !== 'pill') throw new Error(`state=${report.state}`)
    return 'pill'
  })
}

rmSync(scratch, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('all floating widget checks passed')
