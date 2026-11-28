// MOCK connected services for the AI scenario flows: Notion, Google Sheets, Google Docs, Google Slides, Linear and a
// mailbox ("Gmail"), each a tiny MCP server (Streamable HTTP, JSON answers) with made-up data in one state file. The
// team server connects to them as ordinary MCP connections (kind mcp, a bearer key), so the AI reaches them through the
// product's real connection path: listing, the card before a change, the always-allow switch. None of this is the
// real service; the report marks every flow that uses it "mocked".
//
//   bun tests/ai-scenarios/mock-services/server.ts --port 19875 --state <file> --key <bearer>
// A connection needs a public https address (integrations/connections/net.ts), so the CLI puts a cloudflared quick
// tunnel in front of it (tunnel.ts). Only fictional data passes through it.
import fs from 'node:fs'
import { BROWSER_TOOLS, initialWeb, MockBrowser, type WebState } from './browser'

type Json = Record<string, unknown>
/** a mail the AI drafts or sends; attachments by base64 or by link (a team file's share link) */
interface Mail { id: string; to: string; subject: string; body: string; attachments?: { filename: string; bytes?: number; link?: string }[] }
/** the attachment of inbox mail m2: a one-page PDF (made-up order sheet), as Gmail would hand it back */
const ORDER_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 88>>stream
BT /F1 12 Tf 20 150 Td (Order sheet - Lamaba Cafe) Tj 0 -24 Td (A4 paper 25 boxes, 2026-12) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`)
interface Tool { name: string; description: string; inputSchema: Json; readOnly: boolean; run(a: Json, s: State): unknown | Promise<unknown> }
export interface State {
  notion: { pages: { id: string; title: string; body: string; updatedBy?: string }[]; db: { id: string; client: string; status: string; amount: number }[] }
  sheets: { sheets: { id: string; title: string; rows: (string | number)[][] }[] }
  docs: { docs: { id: string; title: string; body: string }[] }
  slides: { decks: { id: string; title: string; slides: { title: string; body: string }[] }[] }
  linear: { issues: { id: string; title: string; state: string; comments: string[] }[] }
  mail: { inbox: { id: string; from: string; subject: string; body: string; date: string; attachments?: { id: string; filename: string; mime: string }[] }[]; drafts: Mail[]; sent: Mail[] }
  /** what the mock browser's made-up sites received (browser.ts): mails sent, forms, posts */
  web: WebState
  calls: { service: string; tool: string; args: Json; at: string }[]
}

export function initialState(): State {
  return {
    notion: {
      pages: [
        { id: 'p-sales-wiki', title: '영업 위키', body: '# 영업 위키 (가상)\n- 연간 계약 단가 하한: 복사용지 27,000원\n- 토요일 배송: 퀵만, 배송비 별도\n- 견적 유효기간: 30일' },
        { id: 'p-lamaba', title: '라마바카페 거래 메모', body: '담당: 이소라\n상태: 견적 협의 중\n다음 할 일: 수정 견적서 발송' },
      ],
      db: [
        { id: 'r1', client: '라마바카페', status: '협의 중', amount: 3780000 },
        { id: 'r2', client: '사아자 베이커리', status: '계약', amount: 1240000 },
        { id: 'r3', client: '차카타 학원', status: '제안', amount: 960000 },
      ],
    },
    sheets: { sheets: [{ id: 's-orders', title: '2026 주문 현황', rows: [['월', '거래처', '금액'], ['2026-10', '라마바카페', 1450000], ['2026-10', '사아자 베이커리', 620000], ['2026-11', '라마바카페', 1530000]] }] },
    docs: { docs: [{ id: 'd-proposal', title: '라마바카페 연간계약 제안 (초안)', body: '1. 제안 배경\n라마바카페의 월 사무용품 구매를 한 번에 맡습니다.\n2. 조건\n복사용지 27,000원, 월말 정산.' }] },
    slides: { decks: [{ id: 'k-intro', title: '가나다오피스 소개', slides: [{ title: '회사 소개', body: '사무용품 유통 (가상)' }, { title: '서비스', body: '정기 납품, 익일 배송' }] }] },
    linear: { issues: [{ id: 'ENG-12', title: '견적서 PDF에 직인 자동 삽입', state: 'Todo', comments: [] }, { id: 'ENG-13', title: '거래처 목록 CSV 정리', state: 'In Progress', comments: [] }] },
    mail: {
      inbox: [
        { id: 'm1', from: 'buyer@lamaba.example', subject: 'RE: 수정 견적서', body: '안녕하세요. 27,000원이면 연간 계약 진행하겠습니다. 다만 첫 달은 20박스가 아니라 25박스로 부탁드립니다. 계약서 수정본 보내주세요.', date: '2026-11-16' },
        { id: 'm2', from: 'buyer@lamaba.example', subject: '12월 주문서 첨부', body: '12월 주문서 첨부드립니다. 확인 부탁드려요.', date: '2026-11-16', attachments: [{ id: 'a1', filename: '주문서-2026-12.pdf', mime: 'application/pdf' }] },
      ],
      drafts: [],
      sent: [],
    },
    web: initialWeb(),
    calls: [],
  }
}

function attachmentsOf(a: Json): Mail['attachments'] {
  const files = Array.isArray(a.attachments) ? (a.attachments as Json[]).map((x) => ({ filename: String(x.filename ?? 'file'), bytes: Buffer.from(String(x.content_base64 ?? ''), 'base64').length })) : []
  const links = Array.isArray(a.links) ? (a.links as unknown[]).map((l) => ({ filename: String(l).split('/').pop() ?? 'link', link: String(l) })) : []
  return [...files, ...links]
}
const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`
const obj = (props: Json, required: string[] = []) => ({ type: 'object', properties: props, required })
const str = { type: 'string' }

export const SERVICES: Record<string, { title: string; tools: Tool[] }> = {
  notion: {
    title: 'Notion (mock)',
    tools: [
      { name: 'search', description: 'Search Notion pages by words in the title or text.', inputSchema: obj({ query: str }, ['query']), readOnly: true,
        run: (a, s) => s.notion.pages.filter((p) => `${p.title}\n${p.body}`.includes(String(a.query ?? ''))).map((p) => ({ id: p.id, title: p.title })) },
      { name: 'get_page', description: 'Read one Notion page.', inputSchema: obj({ page_id: str }, ['page_id']), readOnly: true,
        run: (a, s) => s.notion.pages.find((p) => p.id === a.page_id) ?? { error: 'no such page' } },
      { name: 'update_page', description: 'Replace the text of a Notion page.', inputSchema: obj({ page_id: str, body: str }, ['page_id', 'body']), readOnly: false,
        run: (a, s) => { const p = s.notion.pages.find((x) => x.id === a.page_id); if (!p) return { error: 'no such page' }; p.body = String(a.body); return { ok: true } } },
      { name: 'create_page', description: 'Make a new Notion page.', inputSchema: obj({ title: str, body: str }, ['title', 'body']), readOnly: false,
        run: (a, s) => { const p = { id: id('p'), title: String(a.title), body: String(a.body) }; s.notion.pages.push(p); return { id: p.id } } },
      { name: 'query_database', description: 'List the rows of the "거래처 파이프라인" database.', inputSchema: obj({}), readOnly: true, run: (_a, s) => s.notion.db },
      { name: 'update_row', description: 'Change the status or amount of a row of the "거래처 파이프라인" database.', inputSchema: obj({ row_id: str, status: str, amount: { type: 'number' } }, ['row_id']), readOnly: false,
        run: (a, s) => { const r = s.notion.db.find((x) => x.id === a.row_id); if (!r) return { error: 'no such row' }; if (a.status) r.status = String(a.status); if (typeof a.amount === 'number') r.amount = a.amount; return r } },
    ],
  },
  sheets: {
    title: 'Google Sheets (mock)',
    tools: [
      { name: 'list_spreadsheets', description: 'List the spreadsheets.', inputSchema: obj({}), readOnly: true, run: (_a, s) => s.sheets.sheets.map((x) => ({ id: x.id, title: x.title })) },
      { name: 'read_sheet', description: 'Read all rows of a spreadsheet.', inputSchema: obj({ spreadsheet_id: str }, ['spreadsheet_id']), readOnly: true,
        run: (a, s) => s.sheets.sheets.find((x) => x.id === a.spreadsheet_id)?.rows ?? { error: 'no such spreadsheet' } },
      { name: 'update_cell', description: 'Set one cell (row and column count from 1, row 1 is the header).', inputSchema: obj({ spreadsheet_id: str, row: { type: 'number' }, column: { type: 'number' }, value: str }, ['spreadsheet_id', 'row', 'column', 'value']), readOnly: false,
        run: (a, s) => { const sh = s.sheets.sheets.find((x) => x.id === a.spreadsheet_id); if (!sh) return { error: 'no such spreadsheet' }; const r = Number(a.row) - 1, c = Number(a.column) - 1; while (sh.rows.length <= r) sh.rows.push([]); sh.rows[r]![c] = isNaN(Number(a.value)) ? String(a.value) : Number(a.value); return { ok: true } } },
      { name: 'append_rows', description: 'Add rows at the end.', inputSchema: obj({ spreadsheet_id: str, rows: { type: 'array', items: { type: 'array', items: {} } } }, ['spreadsheet_id', 'rows']), readOnly: false,
        run: (a, s) => { const sh = s.sheets.sheets.find((x) => x.id === a.spreadsheet_id); if (!sh) return { error: 'no such spreadsheet' }; sh.rows.push(...(a.rows as (string | number)[][])); return { rows: sh.rows.length } } },
      { name: 'create_spreadsheet', description: 'Make a new spreadsheet from rows (the first row is the header).', inputSchema: obj({ title: str, rows: { type: 'array', items: { type: 'array', items: {} } } }, ['title', 'rows']), readOnly: false,
        run: (a, s) => { const x = { id: id('s'), title: String(a.title), rows: a.rows as (string | number)[][] }; s.sheets.sheets.push(x); return { id: x.id } } },
    ],
  },
  docs: {
    title: 'Google Docs (mock)',
    tools: [
      { name: 'list_documents', description: 'List the documents.', inputSchema: obj({}), readOnly: true, run: (_a, s) => s.docs.docs.map((d) => ({ id: d.id, title: d.title })) },
      { name: 'read_document', description: 'Read a document.', inputSchema: obj({ document_id: str }, ['document_id']), readOnly: true, run: (a, s) => s.docs.docs.find((d) => d.id === a.document_id) ?? { error: 'no such document' } },
      { name: 'replace_text', description: 'Replace text in a document.', inputSchema: obj({ document_id: str, find: str, replace: str }, ['document_id', 'find', 'replace']), readOnly: false,
        run: (a, s) => { const d = s.docs.docs.find((x) => x.id === a.document_id); if (!d) return { error: 'no such document' }; if (!d.body.includes(String(a.find))) return { error: 'text not found' }; d.body = d.body.split(String(a.find)).join(String(a.replace)); return { ok: true } } },
      { name: 'create_document', description: 'Make a new document.', inputSchema: obj({ title: str, body: str }, ['title', 'body']), readOnly: false,
        run: (a, s) => { const d = { id: id('d'), title: String(a.title), body: String(a.body) }; s.docs.docs.push(d); return { id: d.id } } },
    ],
  },
  slides: {
    title: 'Google Slides (mock)',
    tools: [
      { name: 'list_presentations', description: 'List the presentations.', inputSchema: obj({}), readOnly: true, run: (_a, s) => s.slides.decks.map((d) => ({ id: d.id, title: d.title })) },
      { name: 'read_presentation', description: 'Read a presentation.', inputSchema: obj({ presentation_id: str }, ['presentation_id']), readOnly: true, run: (a, s) => s.slides.decks.find((d) => d.id === a.presentation_id) ?? { error: 'no such presentation' } },
      { name: 'create_presentation', description: 'Make a presentation from slides (title and body each).', inputSchema: obj({ title: str, slides: { type: 'array', items: obj({ title: str, body: str }) } }, ['title', 'slides']), readOnly: false,
        run: (a, s) => { const d = { id: id('k'), title: String(a.title), slides: a.slides as { title: string; body: string }[] }; s.slides.decks.push(d); return { id: d.id } } },
    ],
  },
  linear: {
    title: 'Linear (mock)',
    tools: [
      { name: 'list_issues', description: 'List the issues.', inputSchema: obj({}), readOnly: true, run: (_a, s) => s.linear.issues },
      { name: 'create_issue', description: 'Make an issue.', inputSchema: obj({ title: str }, ['title']), readOnly: false,
        run: (a, s) => { const n = { id: `ENG-${14 + s.linear.issues.length}`, title: String(a.title), state: 'Todo', comments: [] }; s.linear.issues.push(n); return n } },
      { name: 'add_comment', description: 'Comment on an issue.', inputSchema: obj({ issue_id: str, body: str }, ['issue_id', 'body']), readOnly: false,
        run: (a, s) => { const n = s.linear.issues.find((x) => x.id === a.issue_id); if (!n) return { error: 'no such issue' }; n.comments.push(String(a.body)); return { ok: true } } },
      { name: 'set_state', description: 'Move an issue to Todo, In Progress or Done.', inputSchema: obj({ issue_id: str, state: str }, ['issue_id', 'state']), readOnly: false,
        run: (a, s) => { const n = s.linear.issues.find((x) => x.id === a.issue_id); if (!n) return { error: 'no such issue' }; n.state = String(a.state); return n } },
    ],
  },
  gmail: {
    title: 'Gmail (mock)',
    tools: [
      { name: 'list_inbox', description: 'List the latest mails in the inbox (with their attachments\' names).', inputSchema: obj({}), readOnly: true, run: (_a, s) => s.mail.inbox.map(({ body: _b, ...m }) => m) },
      { name: 'read_mail', description: 'Read one mail.', inputSchema: obj({ mail_id: str }, ['mail_id']), readOnly: true, run: (a, s) => s.mail.inbox.find((m) => m.id === a.mail_id) ?? { error: 'no such mail' } },
      { name: 'get_attachment', description: 'Get the file attached to a mail (the file itself comes back).', inputSchema: obj({ mail_id: str, attachment_id: str }, ['mail_id', 'attachment_id']), readOnly: true,
        run: (a, s) => {
          const at = s.mail.inbox.find((m) => m.id === a.mail_id)?.attachments?.find((x) => x.id === a.attachment_id)
          if (!at) return { error: 'no such attachment' }
          return { __content: [{ type: 'resource', resource: { uri: `mock://mail/${a.mail_id}/${at.id}/${encodeURIComponent(at.filename)}`, mimeType: at.mime, blob: ORDER_PDF.toString('base64') } }, { type: 'text', text: `${at.filename} (${ORDER_PDF.length} bytes)` }] }
        } },
      { name: 'create_draft', description: 'Save a mail draft. attachments: files as {filename, content_base64}; links: links to put in the mail (e.g. a shared file link).', inputSchema: obj({ to: str, subject: str, body: str, attachments: { type: 'array', items: obj({ filename: str, content_base64: str }) }, links: { type: 'array', items: str } }, ['to', 'subject', 'body']), readOnly: false,
        run: (a, s) => { const d: Mail = { id: id('dr'), to: String(a.to), subject: String(a.subject), body: String(a.body), attachments: attachmentsOf(a) }; s.mail.drafts.push(d); return { draft_id: d.id, attachments: d.attachments?.length ?? 0 } } },
      { name: 'send_mail', description: 'Send a mail (or a saved draft by draft_id). attachments: files as {filename, content_base64}; links: links to put in the mail.', inputSchema: obj({ to: str, subject: str, body: str, draft_id: str, attachments: { type: 'array', items: obj({ filename: str, content_base64: str }) }, links: { type: 'array', items: str } }), readOnly: false,
        run: (a, s) => { const d = a.draft_id ? s.mail.drafts.find((x) => x.id === a.draft_id) : { id: id('m'), to: String(a.to), subject: String(a.subject), body: String(a.body), attachments: attachmentsOf(a) }; if (!d) return { error: 'no such draft' }; s.mail.sent.push({ ...d, id: id('sent') }); return { sent: true, attachments: d.attachments?.length ?? 0 } } },
    ],
  },
  /** an app on the person's computer that drives their browser (as Aside and the like do), on made-up sites only */
  browser: {
    title: 'Web Pilot (mock)',
    tools: BROWSER_TOOLS.map((t) => ({ ...t, run: (a: Json) => browserOf().call(t.name, a) })),
  },
}

/** the shared meeting-notes page of FL-28 (fictional) */
const NOTES_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>주간 영업 회의 - AI 회의록</title></head><body>
<h1>주간 영업 회의 (2026-11-16)</h1><p>참석: 이소라, Daniel Kim, 박민호 (가상의 회의)</p>
<h2>요약</h2><ul><li>라마바카페 연간 계약: 27,000원으로 확정, 계약서 금요일 발송</li><li>사아자 베이커리 미수금 620,000원 12/5까지 입금</li><li>신제품 샘플 30개는 금요일 오전 Daniel이 전달</li></ul>
<h2>할 일</h2><ol><li>이소라: 계약서 최종본 발송 (11/20)</li><li>Daniel: 샘플 전달 (11/20 오전)</li><li>박민호: 결제 조건 확인 (11/19)</li></ol>
</body></html>`

/** the one mock browser of this process (started on its first call) */
let browser: MockBrowser | null = null
let stateFile = ''
function browserOf(): MockBrowser {
  browser ??= new MockBrowser(
    () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State,
    (f) => { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State; s.web ??= initialWeb(); f(s.web); fs.writeFileSync(stateFile, JSON.stringify(s, null, 1)) },
  )
  return browser
}

function arg(n: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

if (import.meta.main) {
  const port = Number(arg('port') ?? 19875)
  const file = arg('state')!
  stateFile = file
  const key = arg('key')!
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initialState(), null, 1))
  const load = (): State => JSON.parse(fs.readFileSync(file, 'utf8'))
  const save = (s: State) => fs.writeFileSync(file, JSON.stringify(s, null, 1))
  Bun.serve({
    port, hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      // a public page, as a meeting-notes service (Tiro-style) shares one: no key, any query (utm …) ignored
      const note = /^\/pub\/notes\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1]
      if (note) return new Response(NOTES_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      // a meeting-notes service's share link, /s/<id> (flow FL-28)
      if (req.method === 'GET' && /^\/s\/[A-Za-z0-9]{8,40}\/?$/.test(url.pathname)) return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>일요일 회의록</title></head><body><h1>일요일 회의록 (11/15)</h1><ul><li>라마바카페 연간계약: 단가 27,000원 확정, 계약서 최종본 금요일까지 (민호)</li><li>샘플 전달: 금요일 오전 (다니엘)</li><li>박람회 부스 신청: 11/25 마감 (하나)</li></ul></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      // the person's own step on the mock browser's page (flow event page_act): with the key, never from the AI's tools
      if (url.pathname === '/browser/act' && req.method === 'POST') {
        if (req.headers.get('authorization') !== `Bearer ${key}`) return new Response('unauthorized', { status: 401 })
        const b = await req.json() as { action: string } & Json
        try { return Response.json({ ok: true, result: await browserOf().act(b.action, b) }) } catch (e) { return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 }) }
      }
      const svc = /^\/([a-z]+)\/mcp$/.exec(url.pathname)?.[1]
      const def = svc ? SERVICES[svc] : undefined
      if (!def) return new Response('not found', { status: 404 })
      if (req.headers.get('authorization') !== `Bearer ${key}`) return new Response('unauthorized', { status: 401 })
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const msg = await req.json() as { id?: number | string; method: string; params?: Json }
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: msg.id, result }, { headers: { 'Mcp-Session-Id': 'mock' } })
      if (msg.id === undefined) return new Response(null, { status: 202 })
      if (msg.method === 'initialize') return reply({ protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: def.title, version: '1.0' } })
      if (msg.method === 'ping') return reply({})
      if (msg.method === 'tools/list') return reply({ tools: def.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly } })) })
      if (msg.method === 'tools/call') {
        const name = String(msg.params?.name), args = (msg.params?.arguments ?? {}) as Json
        const t = def.tools.find((x) => x.name === name)
        if (!t) return reply({ content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true })
        const s = load()
        let out: unknown
        try { out = await t.run(args, s) } catch (e) { return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message.split('\n')[0] : String(e) }], isError: true }) }
        // the browser writes what its sites received to the file itself: read it again before adding the call
        const after = svc === 'browser' ? load() : s
        after.calls.push({ service: svc!, tool: name, args, at: new Date().toISOString() })
        save(after)
        const special = (out as { __content?: unknown[] } | null)?.__content
        return reply({ content: special ?? [{ type: 'text', text: JSON.stringify(out) }] })
      }
      return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
    },
  })
  // `mocks down` stops this process by its pid: the headless browser goes with it
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void (browser?.close() ?? Promise.resolve()).finally(() => process.exit(0)) })
  console.log(`[mock-services] on 127.0.0.1:${port}, state ${file}`)
}
