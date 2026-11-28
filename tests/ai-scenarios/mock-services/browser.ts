// MOCK browser app for the AI scenario flows: one headless Chromium page on made-up sites (a webmail, a form, a company
// board), offered to the AI as a connected app that drives a browser, the way Aside and similar apps are. Nothing here
// leaves this machine: every request of the page is answered from this file (page.route), other hosts get 404.
//
// The pages copy what real rich editors do, because that is where the AI went wrong on 2026-11-28 (an empty mail body):
// the body is a contenteditable inside an iframe, and the page keeps a hidden textarea that it overwrites from the
// editor when the form is sent. A script that writes the hidden field, or a check that searches the whole page for a
// sentence, looks right and sends nothing. Each page shows the outcome where a person would see it (a sent list, a
// receipt, the post itself).
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'

type Json = Record<string, unknown>
export interface WebState {
  /** mails the webmail sent: what the server received (the body as text) */
  sent: { id: string; to: string[]; subject: string; body: string; attachments: string[]; at: string }[]
  /** form receipts */
  forms: { id: string; company: string; person: string; email: string; kind: string; detail: string; at: string }[]
  /** board posts */
  posts: { id: string; board: string; title: string; body: string; at: string }[]
}
export const initialWeb = (): WebState => ({ sent: [], forms: [], posts: [] })

const MAIL = 'mail.gnd-office.example', FORMS = 'forms.gnd-office.example', BOARD = 'board.gnd-office.example'

const STYLE = `<style>body{font:14px -apple-system,"Apple SD Gothic Neo",sans-serif;margin:0;color:#222}header{background:#2f6fde;color:#fff;padding:10px 16px;font-weight:700}
main{padding:12px 16px;max-width:820px}label{display:inline-block;width:80px;color:#555}.row{margin:8px 0;display:flex;align-items:center;gap:6px}
input[type=text],input[type=email],select{flex:1;padding:6px;border:1px solid #bbb}iframe{width:100%;height:200px;border:1px solid #bbb}
.chip{background:#e8eefc;border-radius:10px;padding:2px 8px;margin-right:4px}.status{color:#888;font-size:12px;margin-top:4px}
aside{border:1px solid #ddd;background:#fafafa;padding:8px;margin-top:12px;font-size:13px}button{padding:6px 12px}</style>`
const EDITOR = `<iframe id="editor" title="본문 편집기" srcdoc="<html><body contenteditable='true' style='font:14px sans-serif;min-height:180px;margin:8px'></body></html>"></iframe>`
/** the editor's helpers: the iframe body, its hidden mirror, the autosave line */
const EDITOR_JS = `
const ed = () => document.getElementById('editor').contentDocument.body;
const mirror = document.getElementById('content');
function hook() {
  const b = ed(); if (!b || b.__hooked) return; b.__hooked = true;
  b.addEventListener('input', () => { mirror.value = b.innerHTML; const t = b.innerText.trim(); document.getElementById('autosave').textContent = t ? '자동 저장됨 · "' + t.slice(0, 60) + (t.length > 60 ? '…' : '') + '"' : '자동 저장: (내용 없음)'; });
}
document.getElementById('editor').addEventListener('load', hook); setTimeout(hook, 50);
/** the editor is written into the hidden field when the form goes out (as rich editors do) */
function editorText() { mirror.value = ed().innerHTML; return ed().innerText.trim(); }
async function post(url, data) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); return r.json(); }
`

function composePage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>편지쓰기 - 가나다메일</title>${STYLE}</head><body>
<header>가나다메일 (가상) · 편지쓰기</header><main>
<div class="row"><button id="send">보내기</button><button id="save">임시저장</button><a href="/sent">보낸메일함</a></div>
<div class="row"><label for="to-input">받는사람</label><span id="chips"></span><input type="text" id="to-input" placeholder="주소 입력 후 Enter"></div>
<div class="row"><label for="subject">제목</label><input type="text" id="subject" name="subject"></div>
<div class="row"><label>첨부</label><button id="attach-btn" type="button">파일첨부</button><ul id="attachments" style="margin:0"></ul></div>
<div><label>본문</label>${EDITOR}<textarea name="content" id="content" style="display:none"></textarea><div class="status" id="autosave">자동 저장: (내용 없음)</div></div>
<div class="row" id="error" style="color:#c00"></div>
<aside><b>메모 (나만 보기)</b><div id="memo" contenteditable="true" style="min-height:40px;background:#fff;border:1px solid #ddd;padding:4px"></div></aside>
<aside><b>최근 받는사람</b><div>buyer@lamaba.example · ceo@sajaja.example</div></aside>
</main><script>${EDITOR_JS}
const chips = document.getElementById('chips'), toIn = document.getElementById('to-input');
const valid = (s) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s);
function addChip(v) { v = v.trim().replace(/[,;]$/, ''); if (!valid(v)) return false; const c = document.createElement('span'); c.className = 'chip'; c.dataset.email = v; c.textContent = v; chips.appendChild(c); return true; }
toIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') { if (addChip(toIn.value)) { toIn.value = ''; e.preventDefault(); } } });
toIn.addEventListener('blur', () => { if (addChip(toIn.value)) toIn.value = ''; });
const recipients = () => [...chips.querySelectorAll('.chip')].map((c) => c.dataset.email);
const attachments = () => [...document.querySelectorAll('#attachments li')].map((l) => l.dataset.name);
document.getElementById('send').addEventListener('click', async () => {
  if (valid(toIn.value.trim())) { addChip(toIn.value); toIn.value = ''; }
  const to = recipients();
  if (!to.length) { document.getElementById('error').textContent = '받는사람을 입력해 주세요.'; return; }
  const body = editorText();
  const r = await post('/api/send', { to, subject: document.getElementById('subject').value, body, attachments: attachments() });
  location.href = '/sent?just=' + r.id;
});
document.getElementById('save').addEventListener('click', () => { document.getElementById('autosave').textContent = '임시저장했습니다.'; });
/** the person's own steps on this page (flow events) */
window.__person = {
  attach(name) { const li = document.createElement('li'); li.dataset.name = name; li.textContent = name + ' (첨부됨)'; document.getElementById('attachments').appendChild(li);
    // the editor reloads after an upload, as some webmail editors do: what was typed is gone, the autosave line and the hidden field keep the old text
    const f = document.getElementById('editor'); f.srcdoc = f.srcdoc; },
  prefill(to, subject, memo) { for (const t of to) addChip(t); document.getElementById('subject').value = subject; document.getElementById('memo').innerText = memo; },
};
</script></body></html>`
}

function sentPage(s: WebState, just: string | null): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const rows = [...s.sent].reverse().map((m) => `<li><a href="/sent/${m.id}">${esc(m.subject || '(제목 없음)')}</a> → ${esc(m.to.join(', '))} · 첨부 ${m.attachments.length}개 · ${esc(m.body.slice(0, 40) || '(본문 없음)')}</li>`).join('')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>보낸메일함 - 가나다메일</title>${STYLE}</head><body><header>가나다메일 (가상) · 보낸메일함</header><main>
${just ? '<p><b>메일을 보냈습니다.</b></p>' : ''}<ul>${rows || '<li>보낸 메일이 없습니다.</li>'}</ul><a href="/compose">편지쓰기</a></main></body></html>`
}
function mailView(s: WebState, id: string): string {
  const m = s.sent.find((x) => x.id === id)
  if (!m) return `<!doctype html><html><body>없는 메일입니다.</body></html>`
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(m.subject)} - 보낸메일</title>${STYLE}</head><body><header>가나다메일 (가상) · 보낸메일</header><main>
<p>받는사람: ${esc(m.to.join(', '))}</p><p>제목: ${esc(m.subject || '(제목 없음)')}</p><p>첨부: ${esc(m.attachments.join(', ') || '없음')}</p><hr><div id="body">${esc(m.body) || '<i>(본문 없음)</i>'}</div></main></body></html>`
}

function formPage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>거래처 등록 신청 - 가나다물류 (가상)</title>${STYLE}</head><body>
<header>가나다물류 (가상) · 거래처 등록 신청</header><main>
<div class="row"><label for="company">회사명</label><input type="text" id="company"></div>
<div class="row"><label for="person">담당자</label><input type="text" id="person"></div>
<div class="row"><label for="email">이메일</label><input type="email" id="email"></div>
<div class="row"><label for="kind">구분</label><select id="kind"><option value="">선택</option><option>정기 배송</option><option>단건 배송</option><option>창고 보관</option></select></div>
<div><label>요청 내용</label>${EDITOR}<textarea name="content" id="content" style="display:none"></textarea><div class="status" id="autosave">자동 저장: (내용 없음)</div></div>
<div class="row"><button id="submit">신청하기</button></div><div class="row" id="error" style="color:#c00"></div>
<aside><b>작성 도움말</b><div>요청 내용에는 품목, 물량, 희망 시작일을 적어 주세요.</div></aside>
</main><script>${EDITOR_JS}
document.getElementById('submit').addEventListener('click', async () => {
  const v = (id) => document.getElementById(id).value.trim();
  if (!v('company') || !v('email')) { document.getElementById('error').textContent = '회사명과 이메일은 꼭 적어 주세요.'; return; }
  const r = await post('/api/submit', { company: v('company'), person: v('person'), email: v('email'), kind: v('kind'), detail: editorText() });
  location.href = '/done/' + r.id;
});
window.__person = {};
</script></body></html>`
}
function receiptPage(s: WebState, id: string): string {
  const f = s.forms.find((x) => x.id === id)
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  if (!f) return `<!doctype html><html><body>없는 접수입니다.</body></html>`
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>접수 완료 - 가나다물류 (가상)</title>${STYLE}</head><body><header>가나다물류 (가상) · 접수 완료</header><main>
<p><b>신청이 접수되었습니다. 접수번호 ${f.id}</b></p><h3>접수된 내용</h3><p>회사명: ${esc(f.company)}</p><p>담당자: ${esc(f.person) || '(없음)'}</p><p>이메일: ${esc(f.email)}</p><p>구분: ${esc(f.kind) || '(선택 안 함)'}</p><p>요청 내용: ${esc(f.detail) || '(없음)'}</p></main></body></html>`
}

function writePage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>글쓰기 - 가나다오피스 사내 게시판 (가상)</title>${STYLE}</head><body>
<header>가나다오피스 사내 게시판 (가상) · 글쓰기</header><main>
<div class="row"><label for="board">게시판</label><select id="board"><option value="">선택</option><option>공지</option><option>영업</option><option>자유</option></select></div>
<div class="row"><label for="title">제목</label><input type="text" id="title"></div>
<div><label>내용</label>${EDITOR}<textarea name="content" id="content" style="display:none"></textarea><div class="status" id="autosave">자동 저장: (내용 없음)</div></div>
<div class="row"><button id="publish">등록</button><a href="/posts">목록</a></div><div class="row" id="error" style="color:#c00"></div>
</main><script>${EDITOR_JS}
document.getElementById('publish').addEventListener('click', async () => {
  const title = document.getElementById('title').value.trim(), board = document.getElementById('board').value;
  if (!title || !board) { document.getElementById('error').textContent = '게시판과 제목을 넣어 주세요.'; return; }
  const r = await post('/api/post', { board, title, body: editorText() });
  location.href = '/posts/' + r.id;
});
window.__person = {};
</script></body></html>`
}
function postPage(s: WebState, id: string | null): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const head = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>게시판 - 가나다오피스 (가상)</title>${STYLE}</head><body><header>가나다오피스 사내 게시판 (가상)</header><main>`
  if (!id) return `${head}<ul>${[...s.posts].reverse().map((p) => `<li><a href="/posts/${p.id}">[${esc(p.board)}] ${esc(p.title)}</a></li>`).join('') || '<li>글이 없습니다.</li>'}</ul><a href="/write">글쓰기</a></main></body></html>`
  const p = s.posts.find((x) => x.id === id)
  if (!p) return `${head}없는 글입니다.</main></body></html>`
  return `${head}<p>[${esc(p.board)}] <b>${esc(p.title)}</b></p><p>등록되었습니다.</p><hr><div id="body">${esc(p.body) || '<i>(내용 없음)</i>'}</div><p><a href="/posts">목록</a></p></main></body></html>`
}

const nid = (p: string) => `${p}${Math.floor(1000 + Math.random() * 9000)}`

/** One browser for the mock server; `load`/`save` are the mock services' state file (its `web` part). */
export class MockBrowser {
  private browser: Browser | null = null
  private page: Page | null = null
  constructor(private load: () => { web?: WebState }, private save: (f: (w: WebState) => void) => void) {}

  private async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page
    this.browser ??= await chromium.launch()
    const ctx = await this.browser.newContext({ viewport: { width: 1000, height: 800 }, locale: 'ko-KR' })
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url())
      const html = (b: string) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: b })
      const json = (o: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) })
      const web = () => this.load().web ?? initialWeb()
      const body = () => { try { return JSON.parse(req.postData() ?? '{}') as Json } catch { return {} as Json } }
      if (url.hostname === MAIL) {
        if (req.method() === 'POST' && url.pathname === '/api/send') {
          const b = body(), id = nid('M')
          this.save((w) => { w.sent.push({ id, to: (b.to as string[]) ?? [], subject: String(b.subject ?? ''), body: String(b.body ?? ''), attachments: (b.attachments as string[]) ?? [], at: new Date().toISOString() }) })
          return json({ id })
        }
        if (url.pathname === '/' || url.pathname === '/compose') return html(composePage())
        if (url.pathname === '/sent') return html(sentPage(web(), url.searchParams.get('just')))
        const m = /^\/sent\/([A-Za-z0-9]+)$/.exec(url.pathname)
        if (m) return html(mailView(web(), m[1]!))
      }
      if (url.hostname === FORMS) {
        if (req.method() === 'POST' && url.pathname === '/api/submit') {
          const b = body(), id = nid('V-')
          this.save((w) => { w.forms.push({ id, company: String(b.company ?? ''), person: String(b.person ?? ''), email: String(b.email ?? ''), kind: String(b.kind ?? ''), detail: String(b.detail ?? ''), at: new Date().toISOString() }) })
          return json({ id })
        }
        if (url.pathname === '/' || url.pathname === '/vendor') return html(formPage())
        const m = /^\/done\/([A-Za-z0-9-]+)$/.exec(url.pathname)
        if (m) return html(receiptPage(web(), m[1]!))
      }
      if (url.hostname === BOARD) {
        if (req.method() === 'POST' && url.pathname === '/api/post') {
          const b = body(), id = nid('P')
          this.save((w) => { w.posts.push({ id, board: String(b.board ?? ''), title: String(b.title ?? ''), body: String(b.body ?? ''), at: new Date().toISOString() }) })
          return json({ id })
        }
        if (url.pathname === '/' || url.pathname === '/write') return html(writePage())
        if (url.pathname === '/posts') return html(postPage(web(), null))
        const m = /^\/posts\/([A-Za-z0-9]+)$/.exec(url.pathname)
        if (m) return html(postPage(web(), m[1]!))
      }
      // about:srcdoc frames never reach here; everything else is not on this made-up web
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found (this browser only opens the test sites).' })
    })
    this.page = await ctx.newPage()
    return this.page
  }

  private async frame(p: Page, sel?: unknown): Promise<Frame> {
    if (!sel) return p.mainFrame()
    const want = String(sel)
    const byName = p.frames().find((x) => x !== p.mainFrame() && x.name() === want)
    if (byName) return byName
    const el = await p.$(want).catch(() => null)
    const f = el ? await el.contentFrame() : null
    if (f) return f
    throw new Error(`No frame "${want}" on this page (give the iframe's selector, e.g. "#editor").`)
  }
  private async frameLabel(f: Frame): Promise<string> {
    const el = await f.frameElement().catch(() => null)
    const id = el ? await el.getAttribute('id') : null
    return id ? `#${id}` : f.name() || f.url()
  }
  private async settle(p: Page) { await p.waitForLoadState('domcontentloaded').catch(() => {}); await p.waitForTimeout(150) }
  private async where(p: Page) { return `${p.url()} — ${await p.title().catch(() => '')}` }

  /** the person's own step on the page (flow event page_act) */
  async act(action: string, args: Json): Promise<string> {
    const p = await this.ensure()
    if (action === 'open') { await p.goto(String(args.url)); await this.settle(p); return this.where(p) }
    await p.evaluate(([a, x]) => { const fn = (window as unknown as { __person?: Record<string, (...v: unknown[]) => void> }).__person?.[a as string]; if (!fn) throw new Error(`no person action ${a}`); fn(...(x as unknown[])) }, [action, args.args ?? []] as const)
    await p.waitForTimeout(300)
    return 'done'
  }

  async call(name: string, a: Json): Promise<unknown> {
    const p = await this.ensure()
    switch (name) {
      case 'open_page': {
        await p.goto(String(a.url))
        await this.settle(p)
        const text = await p.evaluate(() => document.body?.innerText ?? '')
        return { page: await this.where(p), text: text.slice(0, 1500) }
      }
      case 'page_text': return { page: await this.where(p), text: (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, 8000) }
      case 'snapshot': {
        const out: string[] = [await this.where(p)]
        for (const f of p.frames()) {
          const items = await f.evaluate(() => {
            const vis = (el: Element) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 }
            const sel = (el: Element) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${(el as HTMLElement).className ? '.' + String((el as HTMLElement).className).split(' ')[0] : ''}`
            const label = (el: Element) => (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || ''
            const list: string[] = []
            for (const el of document.querySelectorAll('a,button,input,select,textarea,iframe,[contenteditable="true"],.chip,#attachments li')) {
              if (!vis(el)) continue
              const h = el as HTMLInputElement
              const val = el.tagName === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? '' : (h.isContentEditable ? h.innerText : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? h.value : el.tagName === 'IFRAME' ? '' : h.innerText).trim()
              list.push(`${sel(el)} <${el.tagName.toLowerCase()}${h.isContentEditable ? ' contenteditable' : ''}> ${label(el).trim()}${val ? ` = "${val.slice(0, 80)}"` : ''}`)
            }
            return list
          }).catch(() => [] as string[])
          if (!items.length) continue
          out.push(f === p.mainFrame() ? '[page]' : `[frame ${await this.frameLabel(f)}]`, ...items)
        }
        return out.join('\n')
      }
      case 'screenshot': {
        const png = await p.screenshot({ type: 'png' })
        return { __content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: await this.where(p) }] }
      }
      case 'click': {
        const f = await this.frame(p, a.frame)
        await f.locator(String(a.selector)).first().click({ timeout: 5000 })
        await this.settle(p)
        return { ok: true, page: await this.where(p) }
      }
      case 'fill': {
        const f = await this.frame(p, a.frame)
        await f.locator(String(a.selector)).first().fill(String(a.text ?? ''), { timeout: 5000 })
        return { ok: true }
      }
      case 'press': {
        const f = await this.frame(p, a.frame)
        await f.locator(String(a.selector)).first().press(String(a.key ?? 'Enter'), { timeout: 5000 })
        await this.settle(p)
        return { ok: true }
      }
      case 'run_script': {
        const f = await this.frame(p, a.frame)
        const v = await f.evaluate(async (code) => {
          // an expression, or a function body with return
          // eslint-disable-next-line no-new-func
          try { return await (new Function(`return (async () => (${code}))()`))() } catch (e) { if (!(e instanceof SyntaxError)) throw e }
          // eslint-disable-next-line no-new-func
          return await (new Function(`return (async () => { ${code} })()`))()
        }, String(a.code ?? ''))
        await this.settle(p)
        return { result: v === undefined ? null : v, page: await this.where(p) }
      }
    }
    return { error: `unknown tool ${name}` }
  }

  async close() { await this.browser?.close().catch(() => {}); this.browser = null; this.page = null }
}

const obj = (props: Json, required: string[] = []) => ({ type: 'object', properties: props, required })
const str = { type: 'string' }
const frame = { type: 'string', description: 'Optional: the frame to act in, by its name or the iframe\'s selector (e.g. "#editor"), as snapshot lists it' }
/** the app's tools, as a browser-driving app offers them (reads first, then the steps that change the page) */
export const BROWSER_TOOLS: { name: string; description: string; inputSchema: Json; readOnly: boolean }[] = [
  { name: 'open_page', description: 'Open a web address in the user\'s browser and return the page\'s visible text.', inputSchema: obj({ url: str }, ['url']), readOnly: true },
  { name: 'page_text', description: 'The visible text of the open page.', inputSchema: obj({}), readOnly: true },
  { name: 'snapshot', description: 'The open page\'s buttons, links, fields and editors (also inside frames), each with a selector and its current value.', inputSchema: obj({}), readOnly: true },
  { name: 'screenshot', description: 'A picture of the open page.', inputSchema: obj({}), readOnly: true },
  { name: 'click', description: 'Click an element by CSS selector.', inputSchema: obj({ selector: str, frame }, ['selector']), readOnly: false },
  { name: 'fill', description: 'Type text into a field or editor by CSS selector (replaces what is there).', inputSchema: obj({ selector: str, text: str, frame }, ['selector', 'text']), readOnly: false },
  { name: 'press', description: 'Press a key (e.g. "Enter") in an element by CSS selector.', inputSchema: obj({ selector: str, key: str, frame }, ['selector', 'key']), readOnly: false },
  { name: 'run_script', description: 'Run JavaScript in the open page (or a frame) and return its result: an expression, or a function body with return.', inputSchema: obj({ code: str, frame }, ['code']), readOnly: false },
]
