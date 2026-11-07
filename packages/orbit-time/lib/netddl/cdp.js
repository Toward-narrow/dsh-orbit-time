/**
 * Orbit Time — a browser the plugin can drive, with no dependencies.
 *
 * Everything the network reader needs from a page — a logged-in session, the
 * text a person would read, the XHR payloads the page fetched, and the ability
 * to *stay* logged in — only exists inside a real browser. So this drives the
 * Edge (or Chrome) that is already on the machine over the DevTools protocol,
 * which costs one WebSocket and no npm package.
 *
 * Two decisions worth knowing about:
 *
 *  - The profile lives on disk (`--user-data-dir`), so a login survives a
 *    restart of the harness, a reboot, and the user closing the window.
 *  - The browser is *headful* unless the caller asks otherwise. A headless
 *    Chromium is the first thing a course site's fingerprinting checks, and the
 *    one moment the user must interact — the login — needs a window anyway.
 *    Callers that only scrape can minimise it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Where Windows and macOS normally put the two Chromium browsers. */
const CANDIDATES = [
  ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'Edge'],
  ['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'Edge'],
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Chrome'],
  ['C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'Chrome'],
  ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'],
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
]

/** A browser exe to drive, or null when none is installed. */
export function findBrowser(preferred) {
  if (typeof preferred === 'string' && preferred !== '' && existsSync(preferred)) {
    return { exe: preferred, label: '自定义' }
  }
  for (const [exe, label] of CANDIDATES) {
    if (existsSync(exe)) return { exe, label }
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** True when the child exited within `ms`. */
function waitForExit(proc, ms) {
  if (proc.exitCode !== null && proc.exitCode !== undefined) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(false), ms)
    proc.once('exit', () => done(true))
  })
}

/**
 * Kill a browser and its helpers.
 *
 * Chromium's renderer and network processes are children of the browser process,
 * but on Windows a plain `kill()` only reaches the parent and the survivors keep
 * the profile directory locked — which shows up later as a cookie database that
 * "lost" the session. `taskkill /T` takes the tree.
 */
function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* a browser that is already gone needs no help */
  }
}

function readPortFile(userDataDir) {
  try {
    const path = join(userDataDir, 'DevToolsActivePort')
    if (!existsSync(path)) return null
    const [portLine, pathLine] = readFileSync(path, 'utf8').split('\n')
    const port = Number(portLine)
    if (!Number.isInteger(port) || port <= 0) return null
    return { port, wsPath: (pathLine ?? '').trim() }
  } catch {
    return null
  }
}

async function probePort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const info = await response.json()
    return typeof info.webSocketDebuggerUrl === 'string' ? info : null
  } catch {
    return null
  }
}

/**
 * The WebSocket constructor.
 *
 * Node 22+ and Electron 44+ both expose it globally; the guard exists so an
 * ancient host fails with a sentence instead of `WebSocket is not a function`
 * thirty lines down.
 */
function webSocketCtor() {
  const ctor = globalThis.WebSocket ?? null
  if (ctor === null) {
    throw new Error('这个 Node 没有内置 WebSocket（需要 Node 22+ / Electron 44+），爬不了网页。')
  }
  return ctor
}

/**
 * Open a debugging WebSocket with a deadline.
 *
 * A browser whose main process is wedged still answers `/json/version` but never
 * completes the WebSocket handshake; without a deadline the login request would
 * sit there forever instead of failing with something the panel can show.
 */
function openDebugSocket(url, failure, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new (webSocketCtor())(url)
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      finish(reject, new Error(`${failure}（${timeoutMs} ms 没响应）`))
    }, timeoutMs)
    ws.addEventListener('open', () => finish(resolve, ws), { once: true })
    ws.addEventListener('error', () => finish(reject, new Error(failure)), { once: true })
  })
}

/** One request/response channel to a browser and its targets. */
export class CdpBrowser {
  constructor(options) {
    this.ws = options.ws
    this.exe = options.exe ?? ''
    this.label = options.label ?? ''
    this.userDataDir = options.userDataDir
    this.headless = options.headless === true
    this.port = options.port ?? 0
    this.proc = options.proc ?? null
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    this.sessions = new Map()

    this.ws.addEventListener('message', (event) => this.handleMessage(event.data))
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('浏览器连接断开了'))
      this.pending.clear()
    })
  }

  handleMessage(raw) {
    let message = null
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result ?? {})
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch {
        /* a listener must never take the channel down */
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('浏览器已经关掉了'))
    const id = ++this.nextId
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs} ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Open a tab and return a session bound to it. */
  async page(options = {}) {
    const target = await this.send('Target.createTarget', { url: 'about:blank' })
    const attached = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const session = new PageSession(this, attached.sessionId, target.targetId, options)
    await session.init()
    this.sessions.set(session.id, session)
    return session
  }

  async windowFor(targetId) {
    try {
      const { windowId, bounds } = await this.send('Browser.getWindowForTarget', { targetId })
      return { windowId, bounds }
    } catch {
      return null
    }
  }

  /** 'minimized' while scraping, 'normal' when the user has to type a password. */
  async setWindowState(targetId, state) {
    const found = await this.windowFor(targetId)
    if (found === null) return false
    try {
      const bounds = found.bounds && found.bounds.width > 0 ? { width: found.bounds.width, height: found.bounds.height } : { width: 1280, height: 900 }
      await this.send('Browser.setWindowBounds', { windowId: found.windowId, bounds: { ...bounds, windowState: state } })
      if (state === 'normal') await this.send('Target.activateTarget', { targetId })
      return true
    } catch {
      return false
    }
  }

  async close() {
    /**
     * Order matters: `send()` refuses to write once `closed` is set, so setting
     * the flag first meant `Browser.close` was never delivered and every close
     * fell through to killing the process — which is also why the cookie database
     * was never flushed.
     */
    try {
      await this.send('Browser.close', {}, undefined, 3000)
    } catch {
      /* the process may already be gone */
    }
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    if (this.proc !== null && this.proc.pid !== undefined) {
      const exited = await waitForExit(this.proc, 3000)
      if (!exited) killTree(this.proc.pid)
    }
  }
}

/**
 * Open (or re-open) a browser on a profile directory.
 *
 * Reusing the running instance is the whole point: the cookies in that profile
 * are the login. A stale `DevToolsActivePort` from a crash is detected by
 * probing it, not by trusting the file.
 */
export async function openBrowser(options = {}) {
  const userDataDir = options.userDataDir
  if (typeof userDataDir !== 'string' || userDataDir === '') throw new Error('没有给浏览器档案目录。')
  mkdirSync(userDataDir, { recursive: true })
  const headless = options.headless === true
  const modePath = join(userDataDir, '.orbit-mode')
  const wantedMode = headless ? 'headless' : 'headful'

  const running = readPortFile(userDataDir)
  const info = running === null ? null : await probePort(running.port)
  if (info !== null) {
    const knownMode = existsSync(modePath) ? readFileSync(modePath, 'utf8').trim() : ''
    if (knownMode === '' || knownMode === wantedMode) {
      const ws = await openDebugSocket(info.webSocketDebuggerUrl, '连不上已经开着的浏览器')
      return new CdpBrowser({ ws, exe: info.Browser ?? '', label: '已在运行', userDataDir, headless, port: running.port })
    }
    // A headful window is holding the profile and this caller wants headless (or
    // the reverse). Chrome cannot serve two modes from one profile.
    await closeBrowserAt(info.webSocketDebuggerUrl)
  }

  const found = options.exe !== undefined ? { exe: options.exe, label: options.label ?? '自定义' } : findBrowser(options.preferredExe)
  if (found === null) throw new Error('这台机器上没找到 Edge 或 Chrome，装一个再来。')

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=Translate,msEdgeSidebarV2,msEdgeCollections',
    '--window-size=1280,900',
    '--window-position=80,60',
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')
  if (typeof options.extraArgs === 'object' && Array.isArray(options.extraArgs)) args.push(...options.extraArgs)

  const logPath = join(userDataDir, '..', 'browser.log')
  let stdio = 'ignore'
  try {
    const fd = openSync(logPath, 'a')
    stdio = ['ignore', fd, fd]
  } catch {
    /* a log we cannot write is not a reason to refuse to work */
  }
  const proc = spawn(found.exe, args, { detached: true, stdio, windowsHide: !options.showConsole })
  proc.unref()
  try {
    appendFileSync(logPath, `\n=== ${new Date().toISOString()} ${found.label} ${wantedMode} ===\n${found.exe} ${args.join(' ')}\n`)
  } catch {
    /* diagnostics are best-effort */
  }

  const deadline = Date.now() + (Number(options.launchTimeoutMs) || 25_000)
  while (Date.now() < deadline) {
    await sleep(150)
    const port = readPortFile(userDataDir)
    if (port === null) continue
    const version = await probePort(port.port)
    if (version === null) continue
    writeFileSync(modePath, wantedMode, 'utf8')
    const ws = await openDebugSocket(version.webSocketDebuggerUrl, '浏览器起来了但连不上调试端口')
    return new CdpBrowser({ ws, exe: found.exe, label: found.label, userDataDir, headless, port: port.port, proc })
  }
  throw new Error(`浏览器没能起来（${found.label}）。看看 ${logPath} 里最后几行。`)
}

async function closeBrowserAt(wsUrl) {
  try {
    const ws = new (webSocketCtor())(wsUrl)
    await new Promise((resolve) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', resolve, { once: true })
      setTimeout(resolve, 1500)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }))
    await sleep(600)
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  } catch {
    /* it was already gone */
  }
}

/** Page-side helper, kept as a real function so the syntax is checked here. */
function summariseDocument() {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (node) => {
    if (node === null || node === undefined) return false
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const box = node.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  const body = document.body
  // `innerText` on a *detached* clone degrades to `textContent`, which glues every
  // block together and turns "第一章 单元测验" + "截止时间：…" into one unreadable
  // line. Read the live body: it keeps the line breaks a person sees, and already
  // leaves out scripts, styles and hidden nodes.
  const text = body === null ? '' : (body.innerText || '').replace(/\n{3,}/g, '\n\n')
  const links = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.length >= 400) break
    const label = clean(anchor.innerText).slice(0, 120)
    const href = anchor.getAttribute('href') || ''
    if (href === '' || href.startsWith('javascript:')) continue
    /**
     * The surrounding card is often the only place the course name lives: a
     * deadline page links a score badge whose text is "0 .00分", and the model
     * cannot tell which course that is without the card's text.
     */
    let context = ''
    const card = anchor.closest('li, article, tr, section, .card, .item, .course, .m-course, .u-course, [class*="course"]')
    if (card !== null) {
      context = clean(card.innerText).slice(0, 180)
      // The score badge often sits in a small card that omits the course title;
      // one or two parents up is where the title lives.
      let parent = card.parentElement
      for (let depth = 0; parent !== null && depth < 2; depth += 1, parent = parent.parentElement) {
        const parentText = clean(parent.innerText)
        if (parentText.length > context.length && parentText.length <= 400 && parentText.includes(label)) {
          context = parentText.slice(0, 180)
          break
        }
      }
    }
    if (context === '') {
      let parent = anchor.parentElement
      for (let depth = 0; parent !== null && depth < 3; depth += 1, parent = parent.parentElement) {
        const parentText = clean(parent.innerText)
        if (parentText.length > label.length && parentText.length <= 300) {
          context = parentText.slice(0, 180)
          break
        }
      }
    }
    links.push({ href, label, context })
  }
  const inputs = []
  for (const input of document.querySelectorAll('input, textarea')) {
    if (inputs.length >= 40) break
    inputs.push({
      type: clean(input.getAttribute('type') || 'text'),
      name: clean(input.getAttribute('name')),
      id: clean(input.getAttribute('id')),
      placeholder: clean(input.getAttribute('placeholder')),
      visible: visible(input),
    })
  }
  const buttons = []
  for (const button of document.querySelectorAll('button, [role=button], input[type=submit], a')) {
    if (buttons.length >= 80) break
    const label = clean(button.innerText || button.getAttribute('value'))
    if (label === '' || label.length > 24) continue
    if (!visible(button)) continue
    buttons.push(label)
  }
  const clickables = []
  for (const node of document.querySelectorAll('button, [role=button], a, [class*="tab"], [class*="nav"], [class*="course"], [class*="item"], span, div')) {
    if (clickables.length >= 80) break
    const label = clean(node.innerText)
    if (label === '' || label.length > 30) continue
    if (!visible(node) || node.querySelectorAll('*').length > 4) continue
    const style = window.getComputedStyle(node)
    const isClickable = node.matches('button, a, [role=button], [class*="tab"], [class*="nav"], [class*="course"], [class*="item"]') || style.cursor === 'pointer'
    if (!isClickable) continue
    if (clickables.some((entry) => entry.label === label)) continue
    clickables.push({ label, tag: node.tagName.toLowerCase() })
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text: text.slice(0, 60_000),
    links,
    inputs,
    buttons: [...new Set(buttons)],
    clickables,
  }
}

/**
 * Fill a login form and submit it, using the DOM a real login page has.
 *
 * Deliberately forgiving: the fields are chosen by type and by the words around
 * them, not by vendor selectors. Anything this cannot do — a slider captcha, an
 * SMS code — is left for the person in front of the window, which is why the
 * returned object says what it actually filled rather than claiming a login.
 *
 * "Visible" means *on screen*, not merely `display:block`. icourse163 ships a
 * second copy of its login form parked at `x=-9400` behind the iframe that is
 * really on screen: filling that copy dispatches every event correctly and the
 * person sees nothing happen. A field only counts when its box intersects the
 * viewport, which also rules out the hidden tab copies of the same widget.
 */
function fillLoginForm(payload) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const setValue = (field, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(field, value)
    else field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    field.dispatchEvent(new Event('blur', { bubbles: true }))
  }
  const rendered = (node) => {
    for (let current = node; current !== null; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    }
    return true
  }
  const inViewport = (node) => {
    const box = node.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    return box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
  }
  const usable = (node) => rendered(node) && inViewport(node)

  const password = [...document.querySelectorAll('input[type=password]')].find(usable) ?? null
  const inputs = [...document.querySelectorAll('input')].filter((node) => usable(node) && node !== password && !/password|hidden|submit|checkbox|radio/i.test(node.getAttribute('type') || 'text'))
  const userHint = /(user|account|login|email|phone|mobile|tel|mail|账号|帐号|邮箱|手机)/i
  const user = inputs.find((node) => userHint.test(`${node.getAttribute('name')} ${node.getAttribute('id')} ${node.getAttribute('placeholder')}`)) ?? inputs[0] ?? null

  const filled = { user: false, password: false, submitted: false, submit: '' }
  if (user !== null && payload.username) {
    setValue(user, payload.username)
    filled.user = true
  }
  if (password !== null && payload.password) {
    setValue(password, payload.password)
    filled.password = true
  }

  const labelOf = (node) => clean(node.innerText || node.getAttribute('value') || '').replace(/\s+/g, '')
  // Exact labels, because "手机号登录" and "邮箱登录" are tabs that switch forms,
  // not buttons that submit the visible one. Chinese login buttons are routinely
  // spaced out ("登 录"); comparing without the spaces is what makes them match.
  const wanted = /^(登录|登入|立即登录|登录注册|登录[|/]注册|log\s*in|sign\s*in|提交|确定)$/i
  const isDisabled = (node) =>
    node.disabled === true ||
    node.getAttribute('aria-disabled') === 'true' ||
    /(?:^|\s)(?:disabled|btndisabled|is-disabled|u-btn-disabled)(?:\s|$)/i.test(String(node.className || ''))
  const candidates = [...document.querySelectorAll('button, input[type=submit], [role=button], a, span, div')]
    .filter((node) => usable(node) && node.children.length <= 2)
    .filter((node) => {
      const label = labelOf(node)
      if (label === '' || label.length > 16) return false
      if (!wanted.test(label)) return false
      if (/(手机号登录|邮箱登录|爱课程登录|校园用户登录|去注册|忘记密码)/.test(label)) return false
      return true
    })
    .sort((left, right) => {
      const rank = (node) =>
        node.tagName === 'BUTTON' || node.tagName === 'INPUT'
          ? 0
          : node.tagName === 'A' || node.getAttribute('role') === 'button'
            ? 1
            : node.tagName === 'SPAN'
              ? 2
              : 3
      const delta = rank(left) - rank(right)
      if (delta !== 0) return delta
      return left.querySelectorAll('*').length - right.querySelectorAll('*').length
    })
  const submit = candidates.find((node) => !isDisabled(node)) ?? candidates[0] ?? null
  const clickTarget = submit === null ? null : submit.closest('button, input[type=submit], [role=button]') ?? submit
  if (clickTarget !== null && filled.user && filled.password) {
    clickTarget.click()
    filled.submitted = true
    filled.submit = labelOf(clickTarget) || labelOf(submit)
  } else if (candidates.length === 0 && filled.user && filled.password && password !== null && password.form !== null) {
    // No button this reader recognises: a form still submits itself.
    if (typeof password.form.requestSubmit === 'function') password.form.requestSubmit()
    else password.form.submit()
    filled.submitted = true
  }
  return filled
}

/** Page-side test: this document has a password field a person could actually type into. */
function loginPasswordProbe() {
  return `(() => {
    const rendered = (node) => {
      for (let current = node; current !== null; current = current.parentElement) {
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
      }
      return true
    }
    const inViewport = (node) => {
      const box = node.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return false
      return box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight
    }
    return [...document.querySelectorAll('input[type=password]')].some((node) => rendered(node) && inViewport(node))
  })()`
}

/** Two URLs naming the same frame, ignoring the hash and allowing query drift. */
function sameDocumentUrl(left, right) {
  const strip = (value) => String(value ?? '').split('#')[0]
  const a = strip(left)
  const b = strip(right)
  if (a === '' || b === '') return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/**
 * The registrable site of a URL, best-effort.
 *
 * Used for one decision only: whether an iframe may be handed the person's
 * credentials. A login widget hosted on the site's own domain (or a recognisable
 * SSO host) gets them; an unrelated ad frame does not.
 */
function registrableSite(value) {
  try {
    const host = new URL(value).hostname.toLowerCase()
    if (host === '' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host
    const parts = host.split('.')
    return parts.length <= 2 ? host : parts.slice(-2).join('.')
  } catch {
    return ''
  }
}

/**
 * One tab.
 *
 * `captured` is the payload archive: every JSON-ish XHR/fetch response the page
 * made while it was open. That is what lets the JSON reader work on a site whose
 * API nobody documented — the page already asked the right questions.
 */
export class PageSession {
  constructor(browser, sessionId, targetId, options) {
    this.browser = browser
    this.id = sessionId
    this.targetId = targetId
    this.captured = []
    /**
     * 60 was enough for a fixture and not for icourse163: the login and homepage
     * alone can emit that many tracking/JSON responses, and then the course-list
     * payload — the one the reader actually needs — is silently dropped.
     */
    this.maxPayloads = Number(options.maxPayloads) || 160
    this.captureGeneration = 0
    this.maxBodyBytes = Number(options.maxBodyBytes) || 2_000_000
    this.pendingBodies = []
    this.working = false
    this.offs = []
    this.disposed = false
    this.fullText = ''
    /**
     * Default execution contexts by context id.
     *
     * A login form is not always in the document the browser lands on: icourse163
     * puts the visible one inside a `reg.icourse163.org` iframe while the outer
     * document keeps an off-screen copy. The contexts are what let `fillLogin`
     * reach the iframe without pretending a cross-origin document is same-origin.
     */
    this.contexts = new Map()
    this.mainFrameId = ''
    this.currentUrl = ''
  }

  async init() {
    // Listen before enabling Runtime: the contexts that already exist are
    // reported as soon as it is enabled, and those are exactly the ones an iframe
    // login needs.
    this.offs.push(
      this.browser.onEvent((message) => {
        if (message.sessionId !== this.id) return
        if (message.method === 'Runtime.executionContextCreated') {
          const context = message.params?.context
          if (context?.auxData?.isDefault === true) this.contexts.set(context.id, context)
          return
        }
        if (message.method === 'Runtime.executionContextDestroyed') {
          this.contexts.delete(message.params.executionContextId)
          return
        }
        if (message.method === 'Runtime.executionContextsCleared') {
          this.contexts.clear()
          return
        }
        if (message.method === 'Network.responseReceived') {
          const { requestId, response, type } = message.params
          if (type !== 'XHR' && type !== 'Fetch') return
          const mime = String(response.mimeType || '')
          const url = String(response.url || '')
          const interesting = mime.includes('json') || /\.rpc\b|\.do\b|api|graphql/i.test(url)
          if (!interesting) return
          this.pendingBodies.push({ requestId, url, status: response.status, mime })
          void this.pump()
        } else if (message.method === 'Page.javascriptDialogOpening') {
          // A stray alert/beforeunload blocks every later command.
          void this.browser.send('Page.handleJavaScriptDialog', { accept: true }, this.id).catch(() => {})
        }
      }),
    )
    await this.browser.send('Page.enable', {}, this.id)
    await this.browser.send('Runtime.enable', {}, this.id)
    await this.browser.send('Network.enable', {}, this.id)
  }

  async pump() {
    if (this.working) return
    this.working = true
    try {
      while (this.pendingBodies.length > 0 && this.captured.length < this.maxPayloads) {
        const entry = this.pendingBodies.shift()
        const generation = this.captureGeneration
        try {
          const body = await this.browser.send('Network.getResponseBody', { requestId: entry.requestId }, this.id, 10_000)
          // A body fetched for the previous page must not land in the new page's
          // archive after a navigation cleared it.
          if (generation !== this.captureGeneration) continue
          const text = typeof body.body === 'string' ? body.body : ''
          if (text.length === 0 || text.length > this.maxBodyBytes) continue
          if (!/^\s*[[{]/.test(text)) continue
          this.captured.push({ url: entry.url, status: entry.status, mime: entry.mime, body: text })
        } catch {
          /* body evicted before we asked: nothing to read */
        }
      }
      if (this.captured.length >= this.maxPayloads) this.pendingBodies.length = 0
    } finally {
      this.working = false
    }
  }

  async evaluate(expression, options = {}) {
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise !== false,
      userGesture: options.userGesture === true,
    }
    if (options.contextId !== undefined) params.contextId = options.contextId
    const result = await this.browser.send('Runtime.evaluate', params, this.id, Number(options.timeoutMs) || 30_000)
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面里的脚本报错了'
      throw new Error(String(detail).slice(0, 300))
    }
    return result.result ? result.result.value : undefined
  }

  /** Evaluate inside one frame's default context (an iframe, usually). */
  evaluateInContext(contextId, expression, options = {}) {
    return this.evaluate(expression, { ...options, contextId })
  }

  /** Navigate and give the page a chance to finish its own requests. */
  async navigate(url, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || 30_000
    /**
     * Payloads belong to the page that fetched them. Keeping the previous page's
     * bodies let a 60-entry cap fill up during login and silently hide the course
     * list the reader was about to ask for; they also made `since` necessary.
     * A navigation starts a new archive; callers read it from zero.
     */
    this.captured = []
    this.pendingBodies = []
    this.captureGeneration += 1
    const before = 0
    // A cached body of the *previous* page is the single easiest way to read the
    // wrong deadlines, so the text cache dies with the navigation.
    this.fullText = ''
    this.contexts.clear()
    this.mainFrameId = ''
    this.currentUrl = url
    const result = await this.browser.send('Page.navigate', { url }, this.id, timeoutMs)
    if (result.errorText) throw new Error(`打不开 ${url}：${result.errorText}`)
    await this.waitReady(timeoutMs)
    // Hash-only routes ("#/learn/testlist") do not fire a load event at all; the
    // settle window is what lets the SPA swap its content in.
    await sleep(Number(options.settleMs) || 1200)
    return { url, capturedBefore: before, captured: this.captured.slice(before) }
  }

  async waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState', { timeoutMs: 5000 })
        if (state === 'complete' || state === 'interactive') return true
      } catch {
        /* navigating: the execution context is momentarily gone */
      }
      await sleep(200)
    }
    return false
  }

  /** Poll a boolean expression until it is true. */
  async waitFor(expression, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || 20_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate(expression, { timeoutMs: 5000 })) === true) return true
      } catch {
        /* context gone; keep polling */
      }
      await sleep(Number(options.intervalMs) || 300)
    }
    return false
  }

  /**
   * Wait for an SPA to stop growing.
   *
   * `document.readyState` is "complete" long before icourse163's personal center
   * paints its course cards, and a fixed settle window either misses them or
   * wastes seconds on every page. Text size stable across a quiet window is the
   * cheap generic signal; the caller still gets whatever it captured if it never
   * settles.
   */
  async waitForSettled(options = {}) {
    const timeoutMs = Number(options.timeoutMs) || 8000
    const quietMs = Number(options.quietMs) || 900
    const deadline = Date.now() + timeoutMs
    let lastLength = -1
    let stableSince = 0
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate(`(() => ({ ready: document.readyState, length: (document.body ? document.body.innerText : '').length }))()`, { timeoutMs: 3000 })
        if (state && state.ready === 'complete' && typeof state.length === 'number') {
          if (state.length === lastLength) {
            if (stableSince === 0) stableSince = Date.now()
            if (Date.now() - stableSince >= quietMs) return true
          } else {
            lastLength = state.length
            stableSince = Date.now()
          }
        }
      } catch {
        /* between documents */
      }
      await sleep(250)
    }
    return false
  }

  async summary() {
    const data = await this.evaluate(`(${summariseDocument.toString()})()`)
    const summary = data !== null && typeof data === 'object' ? data : {}
    // The text is the big field, and the caller usually reads it separately.
    // Keeping it out of this object means a caller that only wants the links does
    // not drag 60 kB through the protocol as a property.
    this.fullText = typeof summary.text === 'string' ? summary.text : ''
    const { text, ...rest } = summary
    void text
    return rest
  }

  async text() {
    const data = await this.evaluate(`(${summariseDocument.toString()})().text`)
    return typeof data === 'string' && data !== '' ? data : this.fullText
  }

  /** Frames below the main one, each marked with whether its `<iframe>` is on screen. */
  async childFrames() {
    let tree = null
    try {
      tree = await this.browser.send('Page.getFrameTree', {}, this.id, 10_000)
    } catch {
      return []
    }
    if (tree?.frameTree?.frame?.id) this.mainFrameId = tree.frameTree.frame.id
    const shown = await this.visibleFrameIds()
    const list = Array.isArray(shown?.list) ? shown.list : []
    const byKey = shown?.byKey ?? {}
    const frames = []
    let directIndex = 0
    const walk = (node, depth) => {
      for (const child of node?.childFrames ?? []) {
        const frame = child.frame ?? {}
        let iframe = null
        if (frame.name && byKey[frame.name]) iframe = byKey[frame.name]
        else if (frame.url) iframe = list.find((entry) => entry.src !== '' && sameDocumentUrl(entry.src, frame.url)) ?? null
        // An iframe with neither a name nor a matching src is still the nth direct
        // child in both trees; DOM order is the only handle left.
        if (iframe === null && depth === 0) iframe = list[directIndex] ?? null
        if (depth === 0) directIndex += 1
        frames.push({
          frameId: frame.id ?? '',
          name: frame.name ?? '',
          url: frame.url ?? '',
          visible: iframe?.visible === true,
          mapped: iframe !== null,
        })
        walk(child, depth + 1)
      }
    }
    walk(tree?.frameTree, 0)
    return frames
  }

  /**
   * Which `<iframe>` elements are actually on screen.
   *
   * The login widget on icourse163 keeps its inactive tabs at `x=-9400` instead of
   * `display:none`, so a rect check has to include the viewport intersection; a
   * plain "has size" test calls the hidden copies visible.
   */
  async visibleFrameIds() {
    try {
      return await this.evaluate(`(() => {
        const list = []
        const byKey = {}
        for (const frame of document.querySelectorAll('iframe')) {
          const box = frame.getBoundingClientRect()
          let shown = box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight
          if (shown) {
            for (let node = frame; node !== null; node = node.parentElement) {
              const style = getComputedStyle(node)
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { shown = false; break }
            }
          }
          const entry = { id: frame.id || '', name: frame.name || '', src: frame.src || '', visible: shown }
          list.push(entry)
          if (entry.id) byKey[entry.id] = entry
          if (entry.name) byKey[entry.name] = entry
        }
        return { list, byKey }
      })()`, { timeoutMs: 8000 })
    } catch {
      return { list: [], byKey: {} }
    }
  }

  /** Child-frame execution contexts, visible (then unknown) frames first. */
  async loginContexts() {
    const frames = await this.childFrames()
    const byId = new Map(frames.map((frame) => [frame.frameId, frame]))
    const score = (frame) => (frame === null ? 0 : frame.visible === true ? 2 : frame.mapped === false ? 1 : 0)
    return [...this.contexts.values()]
      .filter((context) => context.auxData?.frameId && context.auxData.frameId !== this.mainFrameId)
      .map((context) => ({ id: context.id, origin: context.origin ?? '', frame: byId.get(context.auxData.frameId) ?? null }))
      .sort((left, right) => score(right.frame) - score(left.frame))
  }

  /** True when this document, or a visible child frame, has an on-screen password field. */
  async hasLoginForm() {
    const probe = loginPasswordProbe()
    try {
      if ((await this.evaluate(probe, { timeoutMs: 5000 })) === true) return true
    } catch {
      /* the page may be between two documents */
    }
    let entries = []
    try {
      entries = await this.loginContexts()
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (entry.frame !== null && entry.frame.mapped === true && entry.frame.visible !== true) continue
      try {
        if ((await this.evaluateInContext(entry.id, probe, { timeoutMs: 5000 })) === true) return true
      } catch {
        /* the frame went away; keep looking */
      }
    }
    return false
  }

  async waitForLoginForm(timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.hasLoginForm()) return true
      await sleep(350)
    }
    return false
  }

  /** Click the page's own "登录" entry when the form is behind a modal or route. */
  async openLoginEntry() {
    const clicked = await this.evaluate(`(() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim()
      const rendered = (node) => {
        for (let current = node; current !== null; current = current.parentElement) {
          const style = getComputedStyle(current)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        }
        return true
      }
      const inViewport = (node) => {
        const box = node.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) return false
        return box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight
      }
      const labelOf = (node) => clean(node.innerText || node.getAttribute('value') || '').replace(/\\s+/g, '')
      const wanted = /^(登录|登入|立即登录|登录注册|登录[|/]注册|sign\\s*in|log\\s*in)$/i
      const nodes = [...document.querySelectorAll('button, [role=button], a, span, div')]
        .filter((node) => rendered(node) && inViewport(node) && node.children.length <= 2)
        .filter((node) => wanted.test(labelOf(node)))
        .sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)
      const target = nodes[0] ?? null
      if (target === null) return ''
      target.click()
      return labelOf(target)
    })()`, { userGesture: true, timeoutMs: 8000 })
    return typeof clicked === 'string' ? clicked : ''
  }

  /**
   * Fill the visible login form, wherever it lives.
   *
   * The top document is tried first, then visible child frames. A submit that
   * destroys its context is treated as a submit: that is what navigating away from
   * a login form looks like from the driver's side.
   */
  async fillLogin(username, password) {
    const payload = JSON.stringify({ username: String(username ?? ''), password: String(password ?? '') })
    const expression = `(${fillLoginForm.toString()})(${payload})`
    let fallback = null
    try {
      const main = await this.evaluate(expression, { userGesture: true, timeoutMs: 20_000 })
      if (main !== null && typeof main === 'object') {
        if (main.submitted === true) return { ...main, frame: 'main' }
        fallback = { ...main, frame: 'main' }
      }
    } catch {
      /* the top document navigated while we were filling */
    }

    let entries = []
    try {
      entries = await this.loginContexts()
    } catch {
      entries = []
    }
    const topSite = registrableSite(this.currentUrl)
    const probe = loginPasswordProbe()
    for (const entry of entries) {
      if (entry.frame !== null && entry.frame.mapped === true && entry.frame.visible !== true) continue
      const frameUrl = entry.frame?.url || entry.origin
      /**
       * Do not hand a password to every visible ad frame. A login widget on the
       * site's own domain is the normal case (icourse163's `reg.` host shares the
       * registrable site); a third-party host still qualifies when its URL names a
       * login/SSO path, which is what the common providers use.
       */
      if (topSite !== '') {
        const frameSite = registrableSite(frameUrl)
        const loginish = /(login|signin|sign-in|passport|auth|sso|account|member|reg)/i.test(frameUrl)
        if (frameSite !== '' && frameSite !== topSite && !loginish) continue
      }
      // A frame without a usable password field never receives the credentials.
      let hasPassword = false
      try {
        hasPassword = (await this.evaluateInContext(entry.id, probe, { timeoutMs: 3000 })) === true
      } catch {
        hasPassword = false
      }
      if (!hasPassword) continue
      try {
        const result = await this.evaluateInContext(entry.id, expression, { userGesture: true, timeoutMs: 20_000 })
        if (result !== null && typeof result === 'object') {
          if (result.submitted === true) return { ...result, frame: frameUrl }
          if (result.password === true && (fallback === null || fallback.password !== true)) fallback = { ...result, frame: frameUrl }
        }
      } catch (error) {
        if (/context|destroyed|navigat|disposed/i.test(String(error?.message ?? error))) {
          return { user: true, password: true, submitted: true, frame: frameUrl, navigated: true }
        }
      }
    }
    return fallback ?? { user: false, password: false, submitted: false, frame: 'main' }
  }

  /**
   * The site's own refusal line, if it has drawn one.
   *
   * Without this a wrong password looks identical to "the person is still typing
   * the SMS code" for the whole three-minute timeout. The patterns are deliberately
   * about *submission results*, not form labels, so a help sentence containing
   * "登录" cannot end the wait.
   */
  async loginFeedback() {
    const probe = `(() => {
      const text = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
      const match = /(账号或密码错误|账号或密码不对|用户名或密码错误|手机号或密码错误|密码错误|密码不正确|账号不存在|验证码错误|登录失败|请重新登录)/.exec(text)
      return match ? match[0] : ''
    })()`
    try {
      const main = await this.evaluate(probe, { timeoutMs: 3000 })
      if (typeof main === 'string' && main !== '') return main
    } catch {
      /* the page may be between documents */
    }
    let entries = []
    try {
      entries = await this.loginContexts()
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (entry.frame !== null && entry.frame.mapped === true && entry.frame.visible !== true) continue
      try {
        const text = await this.evaluateInContext(entry.id, probe, { timeoutMs: 3000 })
        if (typeof text === 'string' && text !== '') return text
      } catch {
        /* the frame went away */
      }
    }
    return ''
  }

  async clickText(pattern, options = {}) {
    const source = String(pattern)
    const limit = Number(options.limit) || 1
    return this.evaluate(
      `(() => {
        const rx = new RegExp(${JSON.stringify(source)})
        const visible = (node) => { const b = node.getBoundingClientRect(); const s = getComputedStyle(node); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
        const rank = (node) => node.tagName === 'BUTTON' || node.tagName === 'INPUT' ? 0 : node.tagName === 'A' || node.getAttribute('role') === 'button' ? 1 : node.tagName === 'SPAN' ? 2 : 3
        const nodes = [...document.querySelectorAll('button, [role=button], a, input[type=submit], span, div')]
          .filter((node) => visible(node) && node.children.length <= 2 && rx.test((node.innerText || node.value || '').trim()) && (node.innerText || '').trim().length <= 20)
          // A container div with the same text as the link inside it does not
          // navigate the SPA when clicked programmatically; the link does.
          .sort((left, right) => rank(left) - rank(right) || left.querySelectorAll('*').length - right.querySelectorAll('*').length)
        const picked = nodes.slice(0, ${limit})
        for (const node of picked) node.click()
        return picked.map((node) => (node.innerText || node.value || '').trim())
      })()`,
      { userGesture: true },
    )
  }

  /** Click a visible control/tab by its text; returns the labels it clicked. */
  async clickLabel(label, options = {}) {
    const wanted = String(label ?? '').trim()
    if (wanted === '') return []
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return this.clickText(`^${escaped}`, options)
  }

  async screenshot(path) {    try {
      const { data } = await this.browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, this.id, 20_000)
      writeFileSync(path, Buffer.from(data, 'base64'))
      return path
    } catch {
      return ''
    }
  }

  async bringToFront() {
    await this.browser.setWindowState(this.targetId, 'normal')
    try {
      await this.browser.send('Page.bringToFront', {}, this.id)
    } catch {
      /* not fatal */
    }
  }

  async minimize() {
    return this.browser.setWindowState(this.targetId, 'minimized')
  }

  async close() {
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId })
    } catch {
      /* ignore */
    }
    this.dispose()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs) off()
    this.offs = []
    this.browser.sessions.delete(this.id)
  }
}
