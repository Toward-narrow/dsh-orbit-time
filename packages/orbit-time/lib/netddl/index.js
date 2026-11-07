/**
 * Orbit Time — the network schedule reader.
 *
 * The job: "log in once, then tell me every deadline I owe." It is split from the
 * browser driver and the parsers so the pieces can be tested apart, and it owns
 * exactly four things:
 *
 *   1. a **session** — one persistent browser profile per install, so a login
 *      survives a restart;
 *   2. a **login bridge** — automatic form filling when possible, and a window
 *      the person finishes by hand when the site insists (captcha, SMS, QR);
 *   3. **reading** — course lists and deadline pages, from both the rendered text
 *      and the JSON the page itself fetched;
 *   4. a **credential vault** — passwords encrypted with Windows DPAPI, never in
 *      plain text, never in the schedule config, never in a log.
 *
 * Nothing here talks to DSH. The host wires it to routes; the CLI wires it to a
 * terminal; both get the same behaviour.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { openBrowser, findBrowser } from './cdp.js'
import { parseDeadlineText, parseDeadlineJson, dedupeItems, normaliseText } from './parse.js'

export { findBrowser }

/** Login URLs and page shapes the built-in platforms know about. */
export const PLATFORMS = {
  icourse163: {
    id: 'icourse163',
    label: '中国大学MOOC',
    home: 'https://www.icourse163.org/',
    /**
     * The homepage only *links* to a login dialog; its own document has no usable
     * password field. The dedicated page has the visible form, in the URS iframe
     * the site embeds from `reg.icourse163.org`.
     */
    login: 'https://www.icourse163.org/member/login.htm',
    courses: 'https://www.icourse163.org/home.htm#/home/course',
    courseLink: /\/learn\/[A-Za-z0-9]+-\d+/,
    /**
     * `memberBean.getUserInfoWithCreate.rpc` answers `{code:0, result:{id,...}}`
     * for a signed-in member and `{code:0, result:null}` for a visitor — both
     * verified against the live site. It needs the `NTESSTUDYSI` cookie as
     * `csrfKey` and a form-encoded body.
     *
     * Do not switch this to `memberBean.getMocMember.rpc`: that endpoint answers
     * `code:-2 / 尚未登录` even for a logged-in session (observed at 18:35 with the
     * account's homepage showing 个人中心 and 退出), which is exactly what made the
     * first successful login look like a timeout.
     */
    probe: { path: 'memberBean.getUserInfoWithCreate.rpc', form: {} },
    termDto: { path: 'courseBean.getMocTermDto.rpc' },
    consent: '^(同意|我同意|同意并继续|接受|知道了)$',
  },
  generic: {
    id: 'generic',
    label: '任意网页',
    home: '',
    login: '',
    courses: '',
    courseLink: null,
    consent: '^(同意|我同意|同意并继续|接受|知道了|允许|Allow)$',
  },
}

const CAPTURE_LIMIT = 6
const IDLE_CLOSE_MS = 15 * 60_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowStamp() {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function slug(text, fallback = 'page') {
  const cleaned = String(text ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned === '' ? fallback : cleaned
}

/**
 * Run PowerShell with a script on argv and a secret on stdin.
 *
 * The secret goes through the child's stdin, never through its command line:
 * an argument would sit in the process table for anyone on the machine to read.
 */
function runPowerShell(script, stdin) {
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: error?.message ?? String(error), stdout: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => resolve({ ok: false, error: error?.message ?? String(error), stdout }))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, stdout: stdout.replace(/\r?\n$/, ''), stderr })
      else resolve({ ok: false, error: stderr.trim() || `powershell 退出码 ${code}`, stdout })
    })
    try {
      child.stdin.end(String(stdin ?? ''), 'utf8')
    } catch {
      /* the close handler reports the failure */
    }
  })
}

const ENCRYPT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$secret = [Console]::In.ReadToEnd()',
  'if ([string]::IsNullOrEmpty($secret)) { throw "空密码" }',
  '$secure = ConvertTo-SecureString -String $secret -AsPlainText -Force',
  'ConvertFrom-SecureString -SecureString $secure',
].join('\n')

const DECRYPT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$hex = [Console]::In.ReadToEnd()',
  '$secure = ConvertTo-SecureString -String $hex.Trim()',
  '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
].join('\n')

/**
 * Password storage.
 *
 * DPAPI (`ConvertFrom-SecureString` with no key) ties the ciphertext to this
 * Windows account on this machine: copying the file to another box yields
 * nothing. If PowerShell is unavailable, the vault degrades to "do not remember"
 * rather than to a plain-text file.
 */
function createVault(root) {
  const path = join(root, 'credentials.json')

  function readAll() {
    try {
      if (!existsSync(path)) return {}
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && typeof parsed.accounts === 'object' ? parsed.accounts : {}
    } catch {
      return {}
    }
  }

  function writeAll(accounts) {
    mkdirSync(root, { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, accounts }, null, 2), 'utf8')
  }

  return {
    path,
    async save(id, username, password) {
      const encrypted = await runPowerShell(ENCRYPT_SCRIPT, password)
      if (!encrypted.ok) return { ok: false, error: encrypted.error }
      const accounts = readAll()
      accounts[id] = { username: String(username ?? ''), dpapi: encrypted.stdout.trim(), savedAt: new Date().toISOString() }
      writeAll(accounts)
      return { ok: true }
    },
    async load(id) {
      const entry = readAll()[id]
      if (entry === undefined || typeof entry.dpapi !== 'string' || entry.dpapi === '') return null
      const plain = await runPowerShell(DECRYPT_SCRIPT, entry.dpapi)
      if (!plain.ok) return { username: entry.username, password: '', error: plain.error }
      return { username: entry.username, password: plain.stdout }
    },
    list() {
      const accounts = readAll()
      return Object.entries(accounts).map(([id, entry]) => ({ id, username: entry.username ?? '', savedAt: entry.savedAt ?? '' }))
    },
    forget(id) {
      const accounts = readAll()
      delete accounts[id]
      writeAll(accounts)
    },
  }
}

/**
 * Build the reader.
 *
 * @param {object} options
 * @param {string} options.stateDir  the plugin's state directory.
 * @param {object} [options.logger]  anything with `info`/`warn`.
 * @param {string} [options.browserExe] force one browser.
 * @param {boolean} [options.headless] hide the window (tests).
 */
export function createWebDdl(options = {}) {
  const stateDir = String(options.stateDir ?? '')
  if (stateDir === '') throw new Error('网络日程需要一个状态目录。')
  const root = join(stateDir, 'webddl')
  const profileDir = join(root, 'browser')
  const captureDir = join(root, 'captures')
  const log = options.logger ?? {}
  const vault = createVault(root)
  mkdirSync(captureDir, { recursive: true })

  let browser = null
  let page = null
  let idleTimer = null
  let lastError = ''
  /** What the last successful login taught us, for `status()`. */
  const sessions = new Map()

  function note(message) {
    lastError = ''
    try {
      log.info?.(`[orbit-time] ${message}`)
    } catch {
      /* logging must not break a pull */
    }
  }

  function warn(message) {
    lastError = message
    try {
      log.warn?.(`[orbit-time] ${message}`)
    } catch {
      /* ignore */
    }
  }

  function touch() {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void close().catch(() => {})
    }, IDLE_CLOSE_MS)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  /**
   * One browser mode for this whole reader, decided once.
   *
   * It used to be decided per call: `login()` asked for a window and everything
   * else asked for none, so "检查登录" and "打开登录窗口" — one button apart —
   * each closed the other's browser and relaunched it in the other mode. The last
   * one to launch won, and when that was the hidden one the login sat waiting for
   * a person to type into a window that was never drawn.
   */
  const headlessMode = options.headless === true

  /**
   * One browser operation at a time.
   *
   * Two clicks can arrive from the panel before the first one returns (the buttons
   * disable on the next render, not this one), and two reads sharing one tab
   * interleave their navigations. Queuing makes the second one wait instead of
   * fighting: `status()` stays outside the queue because it touches no browser.
   */
  let operationChain = Promise.resolve()
  function serial(task) {
    const run = operationChain.then(task, task)
    operationChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async function ensureBrowser() {
    if (browser !== null && browser.closed !== true) {
      // A browser in the other mode can only be a leftover from a config change;
      // replace it here, between operations, never inside one.
      if (browser.headless === headlessMode) return browser
      await browser.close().catch(() => {})
      browser = null
      page = null
    }
    browser = await openBrowser({ userDataDir: profileDir, headless: headlessMode, exe: options.browserExe })
    note(`浏览器已就绪：${browser.label}（${headlessMode ? '无窗口' : '有窗口'}）`)
    return browser
  }

  async function ensurePage() {
    const running = await ensureBrowser()
    if (page !== null && page.disposed !== true && page.browser === running) {
      try {
        // A tab the person closed leaves the JavaScript handle alive but the
        // target gone; navigating it fails and the browser shows about:blank.
        await running.send('Target.getTargetInfo', { targetId: page.targetId }, undefined, 3000)
        return page
      } catch {
        /* the target is gone; fall through and open a fresh tab */
      }
    }
    if (page !== null) {
      try {
        page.dispose()
      } catch {
        /* a page on a dead browser has nothing left to clean */
      }
      page = null
    }
    page = await running.page()
    return page
  }

  async function resetPage() {
    if (page !== null) {
      try {
        await page.close()
      } catch {
        /* ignore */
      }
    }
    page = null
  }

  /**
   * Close the browser. The profile keeps the cookies, so "closed" costs nothing
   * but a relaunch, and leaving a window open forever does not feel like a tool.
   */
  async function close() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    const running = browser
    browser = null
    page = null
    if (running !== null) await running.close().catch(() => {})
  }

  // ---- page helpers --------------------------------------------------------

  async function dismissConsent(target, platformId) {
    const platform = PLATFORMS[platformId] ?? PLATFORMS.generic
    try {
      const clicked = await target.clickText(platform.consent, { limit: 1 })
      if (Array.isArray(clicked) && clicked.length > 0) {
        await sleep(400)
        return clicked[0]
      }
    } catch {
      /* a page without that dialog is the normal case */
    }
    return ''
  }

  /** The in-page RPC call every icourse163 read uses. */
  async function callRpc(target, path, form, csrf) {
    const payload = JSON.stringify({ path, form: form ?? {}, csrf: csrf ?? '' })
    return target.evaluate(
      `(async () => {
        const args = ${payload}
        const cookie = (name) => (document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')) || [])[1] || ''
        const key = args.csrf || cookie('NTESSTUDYSI')
        const response = await fetch('/web/j/' + args.path + '?csrfKey=' + encodeURIComponent(key), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: new URLSearchParams(args.form).toString(),
        })
        const text = await response.text()
        let json = null
        try { json = JSON.parse(text) } catch {}
        return { status: response.status, json, text: text.slice(0, 200000) }
      })()`,
      { timeoutMs: 25_000 },
    )
  }

  /**
   * The header's "个人中心" link carries the member id only when signed in.
   * Used as a second signal when the account RPC is unavailable or inconclusive.
   */
  async function profileLinkVisible(target) {
    try {
      const summary = await target.summary()
      const links = Array.isArray(summary.links) ? summary.links : []
      return links.some((link) => /\/home\.htm\?userId=\d+/.test(String(link.href ?? '')))
    } catch {
      return null
    }
  }

  async function isLoggedIn(platformId, target) {
    const platform = PLATFORMS[platformId] ?? PLATFORMS.generic
    if (platformId === 'icourse163') {
      let code = null
      try {
        const answer = await callRpc(target, platform.probe.path, platform.probe.form)
        code = answer?.json?.code
        const result = answer?.json?.result
        if (code === 0 && result !== null && result !== undefined) return true
        if (code === 1 || code === -2) {
          // A definitive "not signed in" from the account API, unless the page
          // itself already shows the member's personal link (e.g. a stale API
          // response during a redirect).
          const dom = await profileLinkVisible(target)
          return dom === true
        }
      } catch {
        /* the DOM fallback below still has a chance */
      }
      const dom = await profileLinkVisible(target)
      if (dom !== null) return dom
      return typeof code === 'number' ? false : null
    }
    // A generic site: the honest signal is "the page no longer asks for a
    // password". That is weak — a public page also has no password field — so the
    // result is only trusted inside `login()`, which starts on the login page.
    // `hasLoginForm` is used rather than the top document's inputs because a
    // login iframe keeps its password field out of the outer DOM.
    try {
      const hasPassword = await target.hasLoginForm()
      return hasPassword ? false : true
    } catch {
      return null
    }
  }

  // ---- reading -------------------------------------------------------------

  /**
   * Read whatever is on screen *now*.
   *
   * `since` is the number of payloads the tab had already captured, so a read
   * after a login does not count the login page's own requests as this page's.
   */
  async function harvest(target, { course = '', platform = '', url = '', horizonDays = 180, since = 0 } = {}) {
    const text = await target.text()
    const summary = await target.summary()
    const context = { course, platform, url: summary.url || url, horizonDays, pastDays: 1 }
    const payloads = target.captured.slice(Number(since) || 0)
    const fromText = parseDeadlineText(text, context)
    const fromJson = parseDeadlineJson(payloads, context)
    return {
      title: summary.title ?? '',
      finalUrl: summary.url ?? url,
      text,
      chars: text.length,
      payloads,
      summary,
      fromText,
      fromJson,
    }
  }

  /** Everything one page offers: its text, its payloads, and where it was. */
  async function readPage(target, { course = '', platform = '', url = '', horizonDays = 180, settleMs = 1200 } = {}) {
    const nav = await target.navigate(url, { settleMs })
    const result = await harvest(target, { course, platform, url, horizonDays, since: nav.capturedBefore })
    // The caller often needs to read payloads that arrive *after* this page (a
    // tab click); exposing the mark is what keeps a stale login-page payload from
    // being mistaken for the course list.
    return { ...result, capturedBefore: nav.capturedBefore }
  }

  function saveCapture(label, payload, extra = {}) {
    try {
      const path = join(captureDir, `${nowStamp()}-${slug(label)}.json`)
      writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), label, ...extra, payload }, null, 1), 'utf8')
      // Keep the folder small: six files is enough to diagnose the last attempt.
      const files = readdirSync(captureDir)
        .map((name) => ({ name, at: statSync(join(captureDir, name)).mtimeMs }))
        .sort((left, right) => right.at - left.at)
      for (const file of files.slice(CAPTURE_LIMIT)) {
        try {
          unlinkSync(join(captureDir, file.name))
        } catch {
          /* ignore */
        }
      }
      return path
    } catch {
      return ''
    }
  }

  function screenshot(target, label) {
    const path = join(captureDir, `${nowStamp()}-${slug(label)}.png`)
    return target.screenshot(path).catch(() => '')
  }

  // ---- public surface ------------------------------------------------------

  async function status() {
    const found = findBrowser(options.browserExe)
    return {
      ok: true,
      /**
       * The shape the page can rely on. Bumped when the login flow changes in a
       * way an older host would silently get wrong (iframe forms, saved
       * credentials): the panel can then say "restart the app" instead of letting
       * a refresh run the new client against the old host.
       */
      api: 3,
      stateDir: root,
      profileDir,
      credentialFile: vault.path,
      credentials: vault.list(),
      browser: {
        found: found !== null,
        exe: found?.exe ?? '',
        label: found?.label ?? '',
        running: browser !== null && browser.closed !== true,
        headless: browser?.headless ?? null,
        /** The mode this install runs in, whether or not a browser is up. */
        mode: headlessMode ? 'headless' : 'headful',
        port: browser?.port ?? 0,
      },
      sessions: [...sessions.values()],
      lastError,
      idleCloseMinutes: Math.round(IDLE_CLOSE_MS / 60_000),
    }
  }

  /**
   * Open a window the person can log in through.
   *
   * With a username and password the form is filled and submitted; whatever the
   * site does next (captcha, SMS, QR code) happens in front of the user, and the
   * wait is what turns "I logged in" into an answer. The window is brought to the
   * front on purpose: a login the user cannot see is a login they cannot finish.
   *
   * The fields are optional in a second sense: with both empty, the DPAPI vault's
   * saved account is used, so "记住密码" actually saves a step on the next click.
   * A typed username still wins, because the person may be switching accounts.
   */
  async function login(input = {}) {
    const platformId = PLATFORMS[input.platform] !== undefined ? input.platform : 'generic'
    const platform = PLATFORMS[platformId]
    const loginUrl = typeof input.url === 'string' && input.url.trim() !== '' ? input.url.trim() : platform.login || platform.home
    if (loginUrl === '') throw new Error('要给一个登录页地址。')
    const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 180_000

    let username = typeof input.username === 'string' ? input.username.trim() : ''
    let password = typeof input.password === 'string' ? input.password : ''
    let usedSaved = false
    let credentialNote = ''
    if (username === '' || password === '') {
      let saved = null
      try {
        saved = await vault.load(platformId)
      } catch (error) {
        credentialNote = `读记住的密码失败（${error?.message ?? error}）。`
      }
      if (saved !== null) {
        if (saved.error) credentialNote = `记住的密码解不开（${saved.error}），要先手动填一次。`
        const savedUser = String(saved.username ?? '').trim()
        const savedPass = String(saved.password ?? '')
        if (username === '' && password === '' && savedUser !== '' && savedPass !== '') {
          username = savedUser
          password = savedPass
          usedSaved = true
        } else if (username !== '' && password === '' && savedUser === username && savedPass !== '') {
          // The panel clears the password after a successful login but keeps the
          // username that was typed. Clicking again must reuse the saved password
          // instead of filling a username with an empty password and stopping.
          password = savedPass
          usedSaved = true
        }
      }
    }

    /**
     * A headless install can still log in *with* credentials — the form fill needs
     * nobody. What it cannot do is ask a person for anything, so a login with no
     * credentials (scan a QR, type the SMS code, drag the slider) would sit there
     * until the timeout, looking exactly like a hang. Refuse that up front.
     */
    const hasCredentials = username !== ''
    const passwordMissing = hasCredentials && password === ''
    if (headlessMode && !hasCredentials) {
      return {
        ok: false,
        loggedIn: false,
        needsHuman: false,
        headless: true,
        note:
          '这台机器配置成无窗口浏览器（netddl.headless = true），没法人工扫码或输验证码，所以没打开登录窗口。' +
          '填上账号密码再点一次（能自动填表），或者把 cordis.patch.yml 里那条改成 false 再重启 DeepSeek Harness。',
      }
    }

    await ensureBrowser()
    const target = await ensurePage()
    touch()
    await target.bringToFront()
    const started = Date.now()
    const read = await readPage(target, { platform: platformId, url: loginUrl, settleMs: 1200 })
    void read
    const dismissed = await dismissConsent(target, platformId)

    /**
     * Wait for the form instead of typing into whatever happened to be rendered
     * first. icourse163's form arrives in an iframe; other sites open it from a
     * "登录" link. Both need a moment, and both are missed by a fixed sleep.
     */
    let formReady = await target.waitForLoginForm(10_000)
    let entryClicked = ''
    if (!formReady) {
      entryClicked = await target.openLoginEntry()
      if (entryClicked !== '') {
        await sleep(700)
        formReady = await target.waitForLoginForm(8000)
      }
    }

    let filled = null
    if (hasCredentials) {
      filled = await target.fillLogin(username, password)
      await sleep(1200)
      if (filled?.submitted !== true && entryClicked === '') {
        // A modal can still be opening; one more click of its entry is cheap, and
        // a second fill is what turns a slow login page into a successful login.
        entryClicked = await target.openLoginEntry()
        if (entryClicked !== '') {
          await sleep(600)
          filled = await target.fillLogin(username, password)
        }
      }
    }

    /**
     * Credentials were given but no password field ever appeared. Waiting the full
     * three minutes here is the "卡在这里了" report, so hand the page back to the
     * person — the window is already open and focused.
     *
     * An already-logged-in profile is the exception: the login URL redirects to
     * the homepage, which has no form but needs none.
     */
    const alreadyLoggedIn = platformId === 'icourse163' ? await isLoggedIn(platformId, target).catch(() => null) : null
    if (hasCredentials && (filled === null || filled.password !== true) && alreadyLoggedIn !== true) {
      const summary = await target.summary().catch(() => null)
      return {
        ok: false,
        platform: platformId,
        loggedIn: false,
        needsHuman: true,
        needsVisibleWindow: true,
        headless: browser?.headless === true,
        filled,
        dismissed,
        usedSaved,
        credentialNote,
        passwordMissing,
        formReady,
        entryClicked,
        waitedMs: Date.now() - started,
        url: summary?.url ?? loginUrl,
        title: summary?.title ?? '',
        screenshot: await screenshot(target, 'login-no-form'),
        note:
          (passwordMissing
            ? '只填了账号，没有可用的密码。在面板补上密码，或者两栏都留空用记住的账号。'
            : headlessMode
              ? '没找到能自动填的登录表单，而且这台机器是无窗口模式，没法人工登录。把 netddl.headless 改成 false 再试。'
              : '页面里没找到能自动填的登录表单。登录窗口还开着：在窗口里手动登录，然后回到面板点「检查登录」。') +
          (passwordMissing && !headlessMode ? '窗口也开着，可以直接在里面登录。' : '') +
          (credentialNote ? ' ' + credentialNote : ''),
      }
    }

    let loggedIn = alreadyLoggedIn
    let checkNote = ''
    let feedback = ''
    if (loggedIn !== true) loggedIn = await isLoggedIn(platformId, target)
    while (loggedIn !== true && Date.now() - started < timeoutMs) {
      await sleep(1500)
      const state = await isLoggedIn(platformId, target).catch(() => null)
      if (state === null) checkNote = '登录态暂时判断不出来'
      loggedIn = state
      if (loggedIn !== true) {
        // The site draws its own refusal ("账号或密码错误") in the visible frame.
        // Waiting the full timeout after that is the same "stuck" feeling as no
        // window at all, only slower.
        feedback = await target.loginFeedback().catch(() => '')
        if (feedback !== '') break
      }
    }

    const summary = await target.summary().catch(() => null)
    const shot = loggedIn === true ? '' : await screenshot(target, 'login')
    const result = {
      ok: loggedIn === true,
      platform: platformId,
      loggedIn: loggedIn === true,
      needsHuman: loggedIn !== true,
      // What actually got drawn, not what was asked for: the panel uses this to
      // stop saying "窗口已经打开" when there is no window.
      headless: browser?.headless === true,
      filled,
      dismissed,
      usedSaved,
      credentialNote,
      passwordMissing,
      formReady,
      entryClicked,
      feedback,
      waitedMs: Date.now() - started,
      url: summary?.url ?? loginUrl,
      title: summary?.title ?? '',
      screenshot: shot,
      note:
        loggedIn === true
          ? '登录成功，这把浏览器档案会记住它。' + (usedSaved ? '（用的是记住的账号）' : '')
          : feedback !== ''
            ? `站点说「${feedback}」。窗口还开着：改一下密码 / 验证码再点登录，或者回面板重新填一次。`
            : checkNote ||
              (headlessMode
                ? '没等到登录成功。无窗口模式下看不到页面：如果这个站点要扫码 / 验证码，是过不去的；把 netddl.headless 改成 false 再登一次。'
                : '没等到登录成功。窗口还开着：扫码 / 短信验证 / 看清码后点登录，再回到面板点「检查登录」。'),
    }

    if (loggedIn === true) {
      sessions.set(platformId, { platform: platformId, loggedIn: true, at: new Date().toISOString() })
      const typedCredentials =
        typeof input.username === 'string' && input.username.trim() !== '' && typeof input.password === 'string' && input.password !== ''
      if (input.remember !== false && typedCredentials) {
        const saved = await vault.save(platformId, input.username, input.password)
        result.remembered = saved.ok === true
        if (!saved.ok) result.rememberNote = `密码没有存下来：${saved.error}`
      } else if (usedSaved) {
        result.remembered = true
      }
    }
    return result
  }

  /** Ask the site whether the saved session is still good. */
  async function check(input = {}) {
    const platformId = PLATFORMS[input.platform] !== undefined ? input.platform : 'icourse163'
    const platform = PLATFORMS[platformId]
    const url = typeof input.url === 'string' && input.url.trim() !== '' ? input.url.trim() : platform.courses || platform.home
    /**
     * "Check" must not *start* a browser: a click on it used to launch one, and a
     * window appearing because someone asked whether they are logged in is both
     * surprising and the first half of the mode fight that used to break logins.
     */
    if ((browser === null || browser.closed === true) && (page === null || page.disposed === true)) {
      return {
        ok: true,
        platform: platformId,
        loggedIn: null,
        unknown: true,
        note: '浏览器没在跑。点「打开登录窗口」登录，或直接「抓」——抓的时候会顺手确认登录态。',
        at: new Date().toISOString(),
      }
    }
    const target = await ensurePage()
    touch()
    if (url !== '') {
      await target.navigate(url, { settleMs: 800 })
      await dismissConsent(target, platformId)
    }
    const loggedIn = await isLoggedIn(platformId, target)
    const entry = { platform: platformId, loggedIn: loggedIn === true, unknown: loggedIn === null, at: new Date().toISOString() }
    sessions.set(platformId, entry)
    return { ok: true, ...entry }
  }

  /**
   * The courses on the account.
   *
   * Two sources, because neither is enough on its own: the account API knows the
   * names but not the URLs (icourse163 learn links carry a school slug that the
   * ids do not contain), and the rendered page knows the URLs but not always the
   * term. Matching them by term id gives both.
   */
  async function listCourses(input = {}) {
    const platformId = input.platform === 'icourse163' ? 'icourse163' : 'generic'
    if (platformId !== 'icourse163') return { ok: true, courses: [], note: '任意网页没有「课程列表」这一步，直接抓一个地址就行。' }
    const platform = PLATFORMS.icourse163
    const target = await ensurePage()
    touch()
    const read = await readPage(target, { platform: platformId, url: platform.courses, settleMs: 2200 })
    await dismissConsent(target, platformId)
    const loggedIn = await isLoggedIn(platformId, target)
    if (loggedIn === false) {
      return { ok: false, needsLogin: true, courses: [], error: '还没登录。先点「打开登录窗口」，登录完再回来。', url: read.finalUrl, title: read.title }
    }

    /**
     * The page has two tabs — MOOC课程 and SPOC课程 — and each tab fetches its own
     * `getMyLearnedCoursePanelList.rpc`. Reading only the DOM anchors is what
     * produced a fake course named "73 .22分" (the score link, not the course):
     * the card's title is not in an anchor. The payload has the name, the course
     * id, and the term id; the page's links supply the school slug.
     */
    const termNow = Date.now()
    const asLinks = (summary) => (summary?.links ?? []).map((link) => ({ ...link, href: absoluteUrl(link.href, summary?.url || read.finalUrl) }))
    const links = asLinks(read.summary)
    const pageSlug = slugFromLinks(links)
    const courses = []
    const seen = new Set()

    const dayOf = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    const courseRows = (entry) => {
      try {
        const json = JSON.parse(entry.body)
        const list = json?.result?.result ?? json?.result
        return Array.isArray(list) ? list.filter((row) => row !== null && typeof row === 'object') : []
      } catch {
        return []
      }
    }

    const addRows = (rows, prefix, pageLinks) => {
      for (const row of rows) {
        const courseId = String(row.id ?? row.termPanel?.courseId ?? '').trim()
        const termId = String(row.termPanel?.id ?? row.termId ?? '').trim()
        const name = String(row.name ?? row.courseName ?? '').trim()
        if (courseId === '' || name === '') continue
        const key = `${prefix}|${courseId}|${termId}`
        if (seen.has(key)) continue
        seen.add(key)
        const startMs = Number(row.termPanel?.startTime)
        const endMs = Number(row.termPanel?.endTime)
        const slug = slugFromLinks(pageLinks, courseId) || pageSlug
        courses.push({
          id: courseId,
          courseId,
          termId,
          name: name.slice(0, 80),
          url: slug === '' ? '' : `https://www.icourse163.org${prefix === 'spoc' ? '/spoc' : ''}/learn/${slug}-${courseId}`,
          source: 'api',
          ended: Number.isFinite(endMs) && endMs > 0 && endMs < termNow,
          termStart: dayOf(startMs),
          termEnd: dayOf(endMs),
        })
      }
    }

    const payloads = async (fragment, from, timeoutMs = 7000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = target.captured.slice(from).filter((entry) => entry.url.includes(fragment))
        if (found.length > 0 || Date.now() >= deadline) return found
        await sleep(300)
      }
    }

    const moocPayloads = await payloads('getMyLearnedCoursePanelList', read.capturedBefore)
    for (const entry of moocPayloads.slice(-1)) addRows(courseRows(entry), '', links)

    const beforeSpoc = target.captured.length
    const clicked = await target.clickText('^SPOC课程', { limit: 1 }).catch(() => [])
    const spocClicked = Array.isArray(clicked) && clicked.length > 0
    if (spocClicked) {
      await target.waitFor('location.hash.includes("spocCourse")', { timeoutMs: 8000 }).catch(() => false)
      const spocPayloads = await payloads('getMyLearnedCoursePanelList', beforeSpoc)
      const summary = await target.summary().catch(() => null)
      const spocLinks = asLinks(summary ?? { links: [] })
      for (const entry of spocPayloads.slice(-1)) addRows(courseRows(entry), 'spoc', spocLinks)
    }

    // Fallback for a page whose account API did not answer: keep the links, but
    // de-duplicate by course id so the score link cannot become a course row.
    if (courses.length === 0) {
      for (const link of links) {
        if (!platform.courseLink.test(link.href)) continue
        const parsed = parseCourseUrl(link.href)
        if (parsed.courseId === '') continue
        if (seen.has(`page|${parsed.courseId}`)) continue
        seen.add(`page|${parsed.courseId}`)
        courses.push({
          id: parsed.courseId,
          courseId: parsed.courseId,
          termId: parsed.termId,
          name: (link.label || parsed.courseName || '未命名课程').slice(0, 80),
          url: withoutHash(link.href),
          source: 'page',
          ended: false,
          termStart: '',
          termEnd: '',
        })
      }
    }

    if (courses.length === 0) {
      const shot = await screenshot(target, 'courses-empty')
      return {
        ok: false,
        courses: [],
        needsLogin: loggedIn !== true,
        error: '没找到课程。可能是登录态过期，也可能是「我的课程」还没渲染出来。',
        url: read.finalUrl,
        title: read.title,
        screenshot: shot,
      }
    }
    return { ok: true, courses, url: read.finalUrl, title: read.title, loggedIn: loggedIn !== false, spocClicked }
  }

  /**
   * Read every selected course's deadline page.
   *
   * Each course is read twice over: the rendered text (what a person sees) and
   * the term API (what the page would ask for anyway) — plus the payloads the
   * page fetched while open. The union is de-duplicated by title and instant.
   */
  async function pull(input = {}) {
    const platformId = input.platform === 'icourse163' ? 'icourse163' : 'generic'
    const horizonDays = Number(input.horizonDays) > 0 ? Number(input.horizonDays) : 180
    const wanted = Array.isArray(input.courses) ? input.courses : []
    if (wanted.length === 0) throw new Error('先选至少一门课。')

    const target = await ensurePage()
    touch()
    const notes = []
    const items = []
    const courses = []
    const maxCourses = Math.min(wanted.length, Number(input.maxCourses) > 0 ? Number(input.maxCourses) : 40)

    for (const course of wanted.slice(0, maxCourses)) {
      const name = String(course.name ?? '').trim() || '未命名课程'
      const record = { name, url: '', items: 0, error: '', screenshot: '' }
      try {
        if (platformId === 'icourse163') {
          const fromApi = await readTermApi(target, course, name, horizonDays).catch(() => ({ items: [], url: '' }))
          if (fromApi.items.length > 0) {
            // Every deadline on this course's pages belongs to this course; the
            // JSON reader's nearest-"name" heuristic can otherwise label a row
            // with its chapter name, which then survives de-duplication.
            for (const item of fromApi.items) item.course = name
            items.push(...fromApi.items)
            record.items += fromApi.items.length
            record.url = fromApi.url
          }
          if (typeof course.url === 'string' && course.url !== '') {
            const settleMs = Number(input.settleMs) || 2200
            const opened = await readPage(target, { course: name, platform: platformId, url: withoutHash(course.url), horizonDays, settleMs })
            await dismissConsent(target, platformId)
            let read = null
            /**
             * Go to the test list through the course's own tab. A cold visit to
             * `#/learn/testlist` is replaced by the SPA's announcement route; the
             * tab click, after the course shell has loaded, renders the full list.
             */
            const clickedTab = await target.clickText('^测验与作业$', { limit: 1 }).catch(() => [])
            if (Array.isArray(clickedTab) && clickedTab.length > 0) {
              await target.waitFor('location.hash.includes("testlist")', { timeoutMs: 10_000 }).catch(() => false)
              await sleep(2200)
              read = await harvest(target, { course: name, platform: platformId, url: testListUrl(course.url), horizonDays, since: opened.capturedBefore })
            } else {
              read = await readPage(target, { course: name, platform: platformId, url: testListUrl(course.url), horizonDays, settleMs })
              // The same redirect can happen on the fallback: click once more.
              if (/\/learn\/announce/.test(read.finalUrl)) {
                const retry = await target.clickText('^测验与作业$', { limit: 1 }).catch(() => [])
                if (Array.isArray(retry) && retry.length > 0) {
                  await target.waitFor('location.hash.includes("testlist")', { timeoutMs: 10_000 }).catch(() => false)
                  await sleep(2200)
                  read = await harvest(target, { course: name, platform: platformId, url: testListUrl(course.url), horizonDays, since: opened.capturedBefore })
                }
              }
            }
            const parsed = dedupeItems([...read.fromText, ...read.fromJson], { platform: platformId })
            for (const item of parsed) {
              item.course = name
              items.push(item)
            }
            record.items += parsed.length
            record.url = read.finalUrl
            if (parsed.length === 0) {
              notes.push(`${name}：页面上没读到截止时间（${read.chars} 字，${read.payloads.length} 个 JSON 响应）`)
              record.screenshot = await screenshot(target, `empty-${name}`)
            }
            if (read.payloads.length > 0) {
              record.raw = saveCapture(`course-${name}`, read.payloads.map((entry) => ({ url: entry.url, body: entry.body.slice(0, 200_000) })), { course: name, url: read.finalUrl })
            }
          }
        } else {
          const read = await readPage(target, { course: name, platform: 'generic', url: course.url, horizonDays, settleMs: Number(input.settleMs) || 1600 })
          const parsed = dedupeItems([...read.fromText, ...read.fromJson], { platform: 'generic' })
          items.push(...parsed)
          record.items = parsed.length
          record.url = read.finalUrl
        }
      } catch (error) {
        record.error = error?.message ?? String(error)
        notes.push(`${name}：${record.error}`)
      }
      courses.push(record)
    }

    const merged = dedupeItems(items, { platform: platformId })
    if (merged.length === 0) {
      const shot = await screenshot(target, 'pull-empty')
      notes.push(`一个截止时间也没读出来。页面截图在 ${shot || '（截图失败）'}，原始 JSON 在 ${captureDir}。`)
    }
    return {
      ok: merged.length > 0,
      platform: platformId,
      items: merged,
      courses,
      notes,
      captureDir,
      truncated: wanted.length > maxCourses,
      at: new Date().toISOString(),
    }
  }

  async function readTermApi(target, course, name, horizonDays) {
    const courseId = String(course.courseId ?? '').trim()
    const termId = String(course.termId ?? '').trim()
    if (courseId === '' || termId === '') return { items: [], url: '' }
    const answer = await callRpc(target, PLATFORMS.icourse163.termDto.path, { courseId, termId })
    if (answer?.json === null || answer?.json === undefined) return { items: [], url: '' }
    const payload = [{ url: `rpc:${PLATFORMS.icourse163.termDto.path}`, body: JSON.stringify(answer.json) }]
    const items = parseDeadlineJson(payload, { course: name, platform: 'icourse163', url: '', horizonDays, pastDays: 1 })
    if (items.length > 0) saveCapture(`term-${name}`, payload, { course: name, courseId, termId })
    return { items, url: '' }
  }

  /**
   * Read one arbitrary URL, optionally logging in first.
   *
   * This is the "any page you give me" half: paste a URL, and if it wants a
   * username and password the form is filled the same way a course site's is.
   */
  async function readUrl(input = {}) {
    const url = String(input.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('要一个 http(s) 地址。')
    const horizonDays = Number(input.horizonDays) > 0 ? Number(input.horizonDays) : 180
    const target = await ensurePage()
    touch()

    let loginNote = ''
    let loggedIn = null
    let read = null

    if (typeof input.username === 'string' && input.username !== '') {
      await target.navigate(url, { settleMs: 900 })
      await dismissConsent(target, 'generic')
      const before = target.captured.length
      const filled = await target.fillLogin(input.username, input.password ?? '')
      if (filled.submitted) {
        await sleep(2200)
        // Where the form landed is the page worth reading: a login page itself has
        // no timetable on it.
        const landed = await target.evaluate('location.href').catch(() => url)
        loginNote = `已自动填写并提交账号密码，落在 ${landed === url ? '原页面（可能是弹窗登录）' : landed}`
        if (input.remember !== false) {
          const saved = await vault.save(input.vaultId ?? 'generic', input.username, input.password ?? '')
          loginNote += saved.ok ? '；密码已用 DPAPI 加密保存' : `；密码没能保存（${saved.error}）`
        }
        loggedIn = await isLoggedIn('generic', target)
        read = await harvest(target, { course: input.label ?? '', platform: 'generic', url: landed, horizonDays, since: before })
      } else {
        loginNote = '页面上没找到可提交的登录表单，按原样读取'
      }
    }

    if (read === null) read = await readPage(target, { course: input.label ?? '', platform: 'generic', url, horizonDays, settleMs: Number(input.settleMs) || 1600 })

    const items = dedupeItems([...read.fromText, ...read.fromJson], { platform: 'generic' })
    const notes = []
    if (items.length === 0) notes.push(`这个页面没读到日期：${read.chars} 字、${read.payloads.length} 个 JSON 响应。`)
    if (read.payloads.length > 0) {
      saveCapture(`url-${slug(read.title)}`, read.payloads.map((entry) => ({ url: entry.url, body: entry.body.slice(0, 200_000) })), { url: read.finalUrl })
    }
    const shot = items.length === 0 ? await screenshot(target, 'url-empty') : ''
    return {
      ok: items.length > 0,
      items,
      notes,
      loginNote,
      loggedIn,
      page: { title: read.title, url: read.finalUrl, chars: read.chars, payloads: read.payloads.length, screenshot: shot },
    }
  }

  async function logout() {
    await close()
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, error: `档案目录删不掉：${error?.message ?? error}` }
    }
    for (const id of [...sessions.keys()]) sessions.delete(id)
    return { ok: true, note: '浏览器档案已清空，下次要重新登录。' }
  }

  /**
   * The public surface.
   *
   * Everything that touches the browser goes through `serial()`; `status()`,
   * `vault` and the parsers do not, because the panel polls status while a login
   * is running and a queue there would freeze the whole card.
   */
  return {
    PLATFORMS,
    status,
    login: (input) => serial(() => login(input)),
    check: (input) => serial(() => check(input)),
    listCourses: (input) => serial(() => listCourses(input)),
    pull: (input) => serial(() => pull(input)),
    readUrl: (input) => serial(() => readUrl(input)),
    logout: () => serial(() => logout()),
    close: () => serial(() => close()),
    vault,
    _internals: { parseDeadlineText, parseDeadlineJson, dedupeItems, normaliseText, root, captureDir, headlessMode },
  }
}

/** Pull `courseId` / `termId` out of `https://…/learn/SCHOOL-12345?tid=678`. */
export function parseCourseUrl(url) {
  const text = String(url ?? '')
  const match = /\/learn\/([A-Za-z0-9_]+?)-(\d+)/.exec(text)
  const tid = /[?&]tid=(\d+)/.exec(text)
  return {
    courseName: match !== null ? match[1] : '',
    courseId: match !== null ? match[2] : '',
    termId: tid !== null ? tid[1] : '',
  }
}

function absoluteUrl(href, base) {
  try {
    return new URL(String(href ?? ''), base).href
  } catch {
    return String(href ?? '')
  }
}

function withoutHash(url) {
  return String(url ?? '').split('#')[0]
}

/**
 * The school slug from the course links on the page.
 *
 * The account API sends ids, not the `SCHOOL` slug the learn URL needs; the page
 * still renders a `/spoc/learn/SCHOOL-<id>` or `/course/SCHOOL-<id>` link per
 * card, which is where the slug comes from. Matching by course id first avoids
 * giving the first course every other course's slug.
 */
function slugFromLinks(links, courseId = '') {
  const list = Array.isArray(links) ? links : []
  for (const link of list) {
    const href = String(link.href ?? '')
    if (courseId !== '' && !href.includes(`-${courseId}`)) continue
    const match = /(?:^|\/)(?:spoc\/)?(?:learn|course)\/([A-Za-z0-9]+)-\d+/.exec(href)
    if (match !== null) return match[1]
  }
  for (const link of list) {
    const match = /\/university\/([A-Za-z0-9]+)/.exec(String(link.href ?? ''))
    if (match !== null) return match[1]
  }
  return ''
}

/** The "测验与作业" tab of a learn URL. */
export function testListUrl(url) {
  const base = String(url ?? '').split('#')[0]
  return `${base}#/learn/testlist`
}
