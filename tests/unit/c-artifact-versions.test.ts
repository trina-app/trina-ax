// A page's versions (scenario QA S-033): the AI reads a page it did not make in this session and changes it on its key,
// restores an earlier version, every version says who asked for it, a person restores one from the panel (POST
// /api/artifacts/:id/restore), and a turn's message lists the chat's pages. Plus the render check's words
// (tools/artifact-check.ts) and, where this machine has the locked-down browser, the check itself (S-102).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { makeHandler } from '../../server/src/mcp/protocol'
import { componentC } from '../../server/src/team-files/component'
import { checkPage, checkPathOf, pageCheckSummary, pageCheckText, pageCheckUnavailable, type PageCheck } from '../../server/src/tools/artifact-check'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { localizeStep, stepLabel } from '../../shared/src/step-labels'

setDefaultTimeout(30_000)

let A: CApp
// the browser check is its own test below: the tool calls here run without it (no browser), so they stay fast
beforeAll(async () => { process.env.MYCEL_HTML_PDF_BROWSER = 'none'; A = await makeCApp('c-artifact-versions') })
afterAll(async () => { delete process.env.MYCEL_HTML_PDF_BROWSER; await A.close() })

let rpcId = 0
async function call(user: Person, turnId: string | null, args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, turnId))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'artifact', arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}
/** a running turn with its answer message, as a chat turn has (a version made in it is the AI's) */
function answerTurn(user: Person, chatId: string): string {
  const turn = A.turn(user, chatId)
  const msg = uuidv7()
  A.ctx.db.query("INSERT INTO messages (id, chat_id, role, content, turn_id, status) VALUES (?, ?, 'assistant', '', ?, 'streaming')").run(msg, chatId, turn)
  A.ctx.db.query('UPDATE turns SET message_id = ? WHERE id = ?').run(msg, turn)
  return turn
}
const PAGE = '<!doctype html><html><body><h1 style="font-size:16px">연말 행사</h1><p>장소: 미정</p></body></html>'

describe('page versions', () => {
  test('read, update on the same key, restore; who asked; the message lists the pages', async () => {
    const chat = A.chat('alice')
    const t1 = answerTurn('alice', chat)
    expect((await call('alice', t1, { action: 'create', key: 'event', type: 'html', title: '연말 행사 안내', content: PAGE })).text).toContain('version 1')
    // create and rewrite need a type; update, read and restore do not
    expect((await call('alice', t1, { action: 'create', key: 'x', content: 'a' })).text).toContain('needs "type"')
    // a later turn that did not make the page reads it, then changes it on its key
    const t2 = answerTurn('alice', chat)
    const r = await call('alice', t2, { action: 'read', key: 'event' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain("Page 'event' (html, \"연말 행사 안내\"): version 1 (1 version here) (the newest)")
    expect(r.text).toContain('asked by Trina for Alice Kim')
    expect(r.text).toContain('<h1 style="font-size:16px">연말 행사</h1>')
    expect((await call('alice', t2, { action: 'update', key: 'event', edits: [{ old: 'font-size:16px', new: 'font-size:28px' }] })).text).toContain('version 2')
    expect((await call('alice', t2, { action: 'update', key: 'event', edits: [{ old: '장소: 미정', new: '장소: 3층 대회의실' }] })).text).toContain('version 3')
    // a wrong "old" says to read the page
    expect((await call('alice', t2, { action: 'update', key: 'event', edits: [{ old: 'nope', new: 'x' }] })).text).toContain('Read the page')
    // an earlier version by its number, and its versions
    const v2 = await call('alice', t2, { action: 'read', key: 'event', version: 2 })
    expect(v2.text).toContain('version 2 (3 versions here) (an earlier version; the newest is v3')
    expect(v2.text).toContain('font-size:28px')
    expect(v2.text).toContain('장소: 미정')
    expect((await call('alice', t2, { action: 'read', key: 'event', version: 9 })).isError).toBe(true)
    // restore: a new newest version with that content; nothing deleted
    const rs = await call('alice', t2, { action: 'restore', key: 'event', version: 1 })
    expect(rs.text).toContain('saved as version 4')
    expect(rs.text).toContain('version 1 brought back as the newest')
    expect((await call('alice', t2, { action: 'restore', key: 'event' })).text).toContain('restore needs "version"')
    const list = await A.json(`/api/chats/${chat}/artifacts`, { as: 'alice' })
    const vs = list.body.items[0].versions
    expect(vs.map((v: any) => [v.version, v.byName, v.ai ?? false, v.restoredFrom ?? null])).toEqual([[4, 'Alice Kim', true, 1], [3, 'Alice Kim', true, null], [2, 'Alice Kim', true, null], [1, 'Alice Kim', true, null]])
    const v4 = await A.json(`/api/artifacts/${vs[0].id}`, { as: 'alice' })
    expect(v4.body.content).toBe(PAGE)
    // the turn's message lists the chat's pages by key
    const block = componentC(A.ctx).artifacts.pagesBlock('alice', chat)
    expect(block).toContain('<chat_pages>')
    expect(block).toContain('- key "event" (html, "연말 행사 안내"): 4 versions, the newest v4 asked by Trina for Alice Kim')
    expect(componentC(A.ctx).artifacts.pagesBlock('alice', A.chat('alice'))).toBe('')
  })

  test('a new key is plain; server-built pages (a promo video) are neither listed nor restored as pages', async () => {
    const chat = A.chat('alice')
    const t = answerTurn('alice', chat)
    expect((await call('alice', t, { action: 'create', key: 'a "b"', type: 'html', content: '<p>x</p>' })).text).toContain('may have only letters')
    await call('alice', t, { action: 'create', key: 'promo-video', type: 'html', title: 'Promo', content: '<p>v</p>' })
    await call('alice', t, { action: 'rewrite', key: 'promo-video', content: '<p>v2</p>' })
    expect((await call('alice', t, { action: 'restore', key: 'promo-video', version: 1 })).text).toContain('kept by its own tool')
    expect(componentC(A.ctx).artifacts.pagesBlock('alice', chat)).toBe('')
    const v1 = (await A.json(`/api/chats/${chat}/artifacts`, { as: 'alice' })).body.items[0].versions[1]
    expect((await A.json(`/api/artifacts/${v1.id}/restore`, { method: 'POST', as: 'alice', headers: { 'x-mycel-csrf': '1' } })).status).toBe(409)
  })

  test('a person restores a version in the panel; others cannot; the people of a shared chat are told', async () => {
    const chat = A.chat('alice')
    const t = answerTurn('alice', chat)
    await call('alice', t, { action: 'create', key: 'p', type: 'html', title: 'P', content: '<p>one</p>' })
    await call('alice', t, { action: 'rewrite', key: 'p', content: '<p>two</p>' })
    const first = (await A.json(`/api/chats/${chat}/artifacts`, { as: 'alice' })).body.items[0].versions[1]
    expect(first.version).toBe(1)
    // someone who does not see the chat gets the 404 of a missing one
    expect((await A.json(`/api/artifacts/${first.id}/restore`, { method: 'POST', as: 'bob' })).status).toBe(404)
    // a chat shared with bob: alice restores, bob is told
    A.ctx.db.query("UPDATE chats SET people_shared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(chat)
    A.ctx.db.query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_at) VALUES (?, 'user', 'bob', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(chat)
    A.hub.clear()
    const r = await A.json(`/api/artifacts/${first.id}/restore`, { method: 'POST', as: 'alice', headers: { 'x-mycel-csrf': '1' } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ key: 'p', version: 3, byName: 'Alice Kim', restoredFrom: 1 })
    expect(r.body.ai).toBeUndefined()
    expect(A.hub.of('artifact.updated', 'alice').length).toBe(1)
    expect(A.hub.of('artifact.updated', 'bob')[0]!.data).toMatchObject({ chatId: chat, key: 'p', status: 'done', artifact: { version: 3 } })
    expect((await A.json(`/api/artifacts/${r.body.id}`, { as: 'bob' })).body.content).toBe('<p>one</p>')
    // bob restores too (he may continue the chat)
    const b = await A.json(`/api/artifacts/${first.id}/restore`, { method: 'POST', as: 'bob', headers: { 'x-mycel-csrf': '1' } })
    expect(b.body).toMatchObject({ version: 4, byName: 'Bob Lee', restoredFrom: 1 })
    // the AI's read names a person's restore as theirs
    const t2 = answerTurn('alice', chat)
    expect((await call('alice', t2, { action: 'read', key: 'p' })).text).toContain('asked by Bob Lee (restored it in the panel)')
  })
})

describe('step words', () => {
  test('read and restore have their own words, in every language on screen', () => {
    expect(stepLabel('artifact', { action: 'read', key: 'event' }, 'ko', new Set())).toBe('화면 보기 · event')
    expect(stepLabel('artifact', { action: 'restore', key: 'event', version: 2 }, 'en', new Set())).toBe('Restore a page · event · v2')
    expect(stepLabel('artifact', { action: 'create', key: 'event', title: '행사' }, 'en', new Set())).toBe('Make a page · 행사')
    expect(stepLabel('artifact', { action: 'update', key: 'event', edits: [] }, 'ko', new Set())).toBe('화면 고치기 · event')
    expect(localizeStep({ kind: 'artifact', tool: 'artifact', label: '화면 고치기 · event' }, 'ja').label).toBe('画面を編集 · event')
    expect(localizeStep({ kind: 'artifact', tool: 'artifact', label: '화면 보기 · event' }, 'en').label).toBe('View a page · event')
    expect(localizeStep({ kind: 'artifact', tool: 'artifact', label: 'Restore a page · event · v2' }, 'ko').label).toBe('화면 되돌리기 · event · v2')
    expect(localizeStep({ kind: 'artifact', tool: 'artifact', label: 'Make a page · x' }, 'ko').label).toBe('화면 만들기 · x')
  })
})

describe('render check', () => {
  test('addresses: a relative path is a team path from the root, "/vendor/" is this server\'s library', () => {
    expect(checkPathOf('https://page-check.invalid/~page/images/a%20b.png')).toEqual({ path: 'images/a b.png', vendor: false })
    expect(checkPathOf('https://page-check.invalid/~page/vendor/x.js')).toEqual({ path: 'vendor/x.js', vendor: false })
    expect(checkPathOf('https://page-check.invalid/vendor/tailwind.js')).toEqual({ path: 'tailwind.js', vendor: true })
    expect(checkPathOf('https://page-check.invalid/shared/x.png')).toEqual({ path: 'shared/x.png', vendor: false })
    // the URL parser takes "..": never above the team root
    expect(checkPathOf('https://page-check.invalid/~page/%2e%2e/%2e%2e/x')).toEqual({ path: 'x', vendor: false })
    expect(checkPathOf('https://page-check.invalid/~page/a%2Fb')).toBeNull()
    expect(checkPathOf('https://cdn.example.com/x.js')).toBeNull()
  })

  test('the words the AI reads', () => {
    const ok: PageCheck = { status: 'checked', problems: [], more: 0, empty: false, textChars: 120, ms: 900 }
    expect(pageCheckText(ok)).toBe('Opened in a browser: no errors, and it shows 120 characters of text.')
    expect(pageCheckSummary(ok)).toBe('check ok')
    const bad: PageCheck = { status: 'checked', problems: ["Uncaught SyntaxError: Identifier 'top' has already been declared (line 12)"], more: 0, empty: true, textChars: 0, ms: 900 }
    expect(pageCheckText(bad)).toContain('- The page shows nothing')
    expect(pageCheckText(bad)).toContain("- Uncaught SyntaxError: Identifier 'top' has already been declared (line 12)")
    expect(pageCheckText(bad)).toContain('before you tell the person it is done')
    expect(pageCheckSummary(bad)).toBe('check empty errors 1')
    const no: PageCheck = { status: 'unchecked', reason: 'it took longer than 5 s' }
    expect(pageCheckText(no)).toContain('Not checked in a browser (it took longer than 5 s). Do not say you opened or checked the page')
    expect(pageCheckSummary(no)).toBe('check skipped')
  })

  test('the tool says when it could not check (no browser here)', async () => {
    const chat = A.chat('alice')
    const r = await call('alice', answerTurn('alice', chat), { action: 'create', key: 'd', type: 'html', content: '<p>x</p>' })
    expect(r.text).toContain('saved as version 1')
    expect(r.text).toContain('Not checked in a browser (')
    // other types are not opened
    expect((await call('alice', answerTurn('alice', chat), { action: 'create', key: 'm', type: 'markdown', content: '# x' })).text).not.toContain('browser')
  })

  // the real browser: only where this machine has it and the isolation (a Linux server, a Mac with the HyperFrames
  // chrome-headless-shell); elsewhere the test says so and passes
  test('a real browser finds the duplicate declaration, an empty page and a web script', async () => {
    // (the other tests here run with MYCEL_HTML_PDF_BROWSER=none)
    delete process.env.MYCEL_HTML_PDF_BROWSER
    let why: string | null
    try { why = pageCheckUnavailable() } finally { process.env.MYCEL_HTML_PDF_BROWSER = 'none' }
    if (why) { console.log(`page check skipped: ${why}`); return }
    delete process.env.MYCEL_HTML_PDF_BROWSER
    try { await realChecks() } finally { process.env.MYCEL_HTML_PDF_BROWSER = 'none' }
  })
})

async function realChecks() {
  {
    const asset = () => null
    const dup = await checkPage({ html: '<!doctype html><html><body><div id="a">sales</div><script>let top = 3; document.getElementById("a").textContent = top</script></body></html>', asset, shared: false, workBase: A.data, timeoutMs: 15_000 })
    expect(dup.status).toBe('checked')
    if (dup.status !== 'checked') return
    expect(dup.problems.join('\n')).toContain("Identifier 'top' has already been declared")
    const empty = await checkPage({ html: '<!doctype html><html><body><div id="root"></div><script>throw new Error("boom")</script></body></html>', asset, shared: false, workBase: A.data, timeoutMs: 15_000 })
    expect(empty).toMatchObject({ status: 'checked', empty: true })
    expect((empty as any).problems.join('\n')).toContain('boom')
    const web = await checkPage({ html: '<!doctype html><html><body><p>hello there</p><script src="https://cdn.example.com/chart.js"></script></body></html>', asset, shared: false, workBase: A.data, timeoutMs: 15_000 })
    expect(web).toMatchObject({ status: 'checked', empty: false })
    expect((web as any).problems.join('\n')).toContain('does not load: the preview reaches no web address')
    const good = await checkPage({ html: '<!doctype html><html><body><h1>Dashboard</h1><canvas id="c" width="300" height="200"></canvas><script>const ctx = document.getElementById("c").getContext("2d"); ctx.fillRect(0,0,10,10)</script></body></html>', asset, shared: false, workBase: A.data })
    expect(good).toMatchObject({ status: 'checked', problems: [], empty: false })
    // the preview's sandbox and policy: no storage, no eval
    const storage = await checkPage({ html: '<!doctype html><html><body><p>hi</p><script>localStorage.setItem("a","1")</script></body></html>', asset, shared: false, workBase: A.data, timeoutMs: 15_000 })
    expect((storage as any).problems.join('\n')).toContain('SecurityError')
    const ev = await checkPage({ html: '<!doctype html><html><body><p>hi</p><script>eval("1+1")</script></body></html>', asset, shared: false, workBase: A.data, timeoutMs: 15_000 })
    expect((ev as any).problems.join('\n')).toContain('EvalError')
    console.log(`page check took ${(good as any).ms} ms`)
  }
}
