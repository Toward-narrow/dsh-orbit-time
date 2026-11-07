#!/usr/bin/env node
/**
 * A stand-in for a course site, for testing the network reader end to end.
 *
 * It has the four properties that make a real site hard, in miniature:
 * every page but the login needs a session cookie; the deadline list is rendered
 * *and* fetched as JSON (so both readers have something to find); the same
 * deadline appears twice (so de-duplication is exercised); and the login is a
 * form that a browser must fill, not an endpoint that accepts a password.
 *
 * Used by `scripts/test-netddl.mjs`; can also be run by hand:
 *   node scripts/fixtures/mock-course-site.mjs 4180
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2]) || 0
export const DEMO_USER = 'demo'
export const DEMO_PASSWORD = 'secret'

const COURSES = [
  { id: '1', tid: '1001', name: '数据结构', school: '示例大学' },
  { id: '2', tid: '1002', name: '操作系统', school: '示例大学' },
]

const DEADLINES = {
  '1': [
    { name: '第一章 单元测验', due: '2026-11-20 23:30', kind: '测验' },
    { name: '第二章 作业', due: '2026-11-28 23:59', kind: '作业' },
  ],
  '2': [{ name: '进程调度实验报告', due: '2026-12-05 22:00', kind: '作业' }],
}

const STYLE = `body{font:15px/1.7 "Microsoft YaHei UI",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#222}
a{color:#0b62d6} .card{border:1px solid #e3e6ea;border-radius:10px;padding:14px 18px;margin:12px 0}
.muted{color:#888;font-size:13px} button{padding:8px 18px;font-size:14px} label{display:block;margin:10px 0 4px}
input{padding:8px 10px;width:260px;font-size:14px}`

const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`

function loggedIn(req) {
  return /(?:^|;\s*)SESSION=demo(?:;|$)/.test(req.headers.cookie ?? '')
}

function loginPage() {
  return page(
    '示例课程平台 · 登录',
    `<h1>示例课程平台</h1><p class="muted">演示用站点，账号 demo / secret</p>
     <form method="post" action="/login" id="login-form">
       <label>邮箱 / 手机号</label><input type="text" name="username" placeholder="请输入账号" />
       <label>密码</label><input type="password" name="password" placeholder="请输入密码" />
       <div style="margin:16px 0"><button type="submit">登 录</button></div>
     </form>`,
  )
}

/**
 * A login shipped the way icourse163 ships one: the visible form is nested in an
 * iframe, and the outer document carries an off-screen copy of the same fields.
 * Filling the copy looks correct in the DOM and does nothing on screen, which is
 * exactly the failure `fillLogin` must not repeat.
 */
function iframeLoginPage() {
  return page(
    '示例课程平台 · 登录',
    `<h1>示例课程平台</h1><p class="muted">演示用站点，账号 demo / secret（表单在内嵌框架里）</p>
     <div style="position:relative;width:420px;height:280px">
       <iframe src="/login-widget" title="登录" style="width:420px;height:280px;border:1px solid #e3e6ea"></iframe>
     </div>
     <form id="decoy" style="position:absolute;left:-9000px;top:0">
       <input type="text" name="username" placeholder="账号" />
       <input type="password" name="password" placeholder="密码" />
       <button type="submit">登录</button>
     </form>`,
  )
}

function loginWidget() {
  return page(
    '登录',
    `<h1 style="font-size:18px">账号登录</h1>
     <form method="post" action="/login" target="_top" id="login-form">
       <label>邮箱 / 手机号</label><input type="text" name="username" placeholder="请输入账号" />
       <label>密码</label><input type="password" name="password" placeholder="请输入密码" />
       <div style="margin:16px 0"><button type="submit">登 录</button></div>
     </form>`,
  )
}

async function readForm(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(body)
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    const form = await readForm(req)
    if (form.get('username') === DEMO_USER && form.get('password') === DEMO_PASSWORD) {
      // A session cookie with Max-Age, because that is what a real site sets and
      // what makes it survive the browser being closed — the property under test.
      send(302, '', { 'set-cookie': 'SESSION=demo; Path=/; Max-Age=86400; HttpOnly', location: '/courses' })
      return
    }
    send(401, loginPage().replace('</h1>', '</h1><p style="color:#c00">账号或密码不对</p>'))
    return
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Public pages, so the reader can meet a login form in an iframe and a page
  // with no login form at all without a session.
  if (url.pathname === '/iframe-login') {
    send(200, iframeLoginPage())
    return
  }

  if (url.pathname === '/login-widget') {
    send(200, loginWidget())
    return
  }

  if (url.pathname === '/plain') {
    send(200, page('没有登录', '<h1>公开页面</h1><p class="muted">这里没有登录表单。</p>'))
    return
  }

  if (!loggedIn(req) && url.pathname !== '/') {
    send(302, '', { location: '/' })
    return
  }

  if (url.pathname === '/') {
    send(200, loginPage())
    return
  }

  if (url.pathname === '/courses') {
    const cards = COURSES.map(
      (course) => `<div class="card"><a href="/course/${course.id}?tid=${course.tid}">${course.name}</a>
        <div class="muted">${course.school} · 学期 ${course.tid}</div></div>`,
    ).join('')
    send(200, page('我的课程', `<h1>我的课程</h1>${cards}`))
    return
  }

  const courseMatch = /^\/course\/(\d+)$/.exec(url.pathname)
  if (courseMatch !== null) {
    const course = COURSES.find((entry) => entry.id === courseMatch[1])
    if (course === undefined) {
      send(404, page('没有这门课', '<h1>没有这门课</h1>'))
      return
    }
    const rows = (DEADLINES[course.id] ?? [])
      .map(
        (row) => `<div class="card"><div>${row.name}</div>
          <div class="muted">${row.kind} · 截止时间：${row.due}</div>
          <div class="muted">状态：未提交</div></div>`,
      )
      .join('')
    // The same list is fetched as JSON after load, exactly as a real SPA does.
    send(
      200,
      page(
        `${course.name} · 测验与作业`,
        `<h1>${course.name}</h1><h2>测验与作业</h2><div id="list">${rows}</div>
         <p class="muted">正在同步…</p>
         <script>
           window.__CALLED__ = false
           setTimeout(async () => {
             const response = await fetch('/api/course/${course.id}/deadlines', { headers: { accept: 'application/json' } })
             const data = await response.json()
             window.__CALLED__ = data.list.length
             document.querySelector('.muted:last-of-type').textContent = '已同步 ' + data.list.length + ' 条'
           }, 300)
         </script>`,
      ),
    )
    return
  }

  const apiMatch = /^\/api\/course\/(\d+)\/deadlines$/.exec(url.pathname)
  if (apiMatch !== null) {
    const rows = (DEADLINES[apiMatch[1]] ?? []).map((row) => ({
      name: row.name,
      // Epoch milliseconds, which is what every real endpoint sends.
      deadline: new Date(`${row.due.replace(' ', 'T')}:00+08:00`).getTime(),
    }))
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 0, result: { list: rows } }))
    return
  }

  send(404, page('404', '<h1>404</h1>'))
})

export function startMockSite(port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: address.port, base: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('mock-course-site.mjs')) {
  const site = await startMockSite(PORT)
  console.log(`mock course site: ${site.base}  (demo / secret)`)
}
