// comment_docx (AI flow check FL-21 step 3, QA TC-3818): Word comments added to an existing .docx next to the paragraph
// that holds the given text (server/src/files/docx-comment.ts in the office worker, tools/comment-docx.ts). The body's
// text stays exactly as it was, the comments read back through the normal reader (docx-extra), and the file is saved
// like edit_hwp saves: read first, a new version in place, the wider-audience check for a new file, never skills/.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { which } from '../../server/src/config'
import { addDocxComments, docxParagraphs } from '../../server/src/files/docx-comment'
import { docxExtraText } from '../../server/src/files/ooxml'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { outsideContentTool } from '../../server/src/chat/team-content-tools'
import { COMMENT_DOCX_DESCRIPTION } from '../../server/src/tools/comment-docx'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(90_000)
const pandoc = which('pandoc')
const withPandoc = pandoc ? test : test.skip

function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
const CONTRACT = '# 물품공급계약서\n\n제1조 (목적) 이 계약은 사무용품 공급에 관한 사항을 정한다.\n\n제3조 (대금) 을은 매월 말일 기준으로 정산하여 익월 말일까지 지급한다.\n\n제4조 (납품) 갑은 영업일 기준 3일 이내에 납품한다.\n'
/** the document without a comments part, its content type and relationship (as Word saves one that never had comments) */
function withoutComments(b: Uint8Array): Uint8Array {
  const entries = readZip(b).filter((e) => e.name !== 'word/comments.xml').map((e) => {
    if (e.name !== '[Content_Types].xml' && e.name !== 'word/_rels/document.xml.rels') return e
    const t = new TextDecoder().decode(e.data).replace(/<(Override|Relationship)\b[^>]*comments[^>]*\/>/g, '')
    return { name: e.name, data: new TextEncoder().encode(t) }
  })
  return writeZip(entries)
}
const part = (bytes: Uint8Array, name: string) => { const e = readZip(bytes).find((x) => x.name === name); return e ? new TextDecoder().decode(e.data) : null }
const bodyText = (bytes: Uint8Array) => docxParagraphs(part(bytes, 'word/document.xml')!).map((p) => p.text)

describe('Word comments in the document (docx-comment.ts)', () => {
  withPandoc('a comment next to the paragraph with the text: the comments part made, the body text unchanged, read back with its author and anchor', () => {
    const before = withoutComments(docx(CONTRACT))
    expect(part(before, 'word/comments.xml')).toBeNull()
    expect(part(before, '[Content_Types].xml')).not.toContain('comments')
    const r = addDocxComments(before, [{ on: '제3조 (대금)', text: '정산일 재확인 필요' }], 'Dana Choi', '2026-11-16T09:00:00Z')
    expect(r.added).toEqual([{ on: '제3조 (대금)', paragraph: '제3조 (대금) 을은 매월 말일 기준으로 정산하여 익월 말일까지 지급한다.' }])
    expect(bodyText(r.file)).toEqual(bodyText(before))
    expect(part(r.file, '[Content_Types].xml')).toContain('PartName="/word/comments.xml"')
    expect(part(r.file, 'word/_rels/document.xml.rels')).toContain('relationships/comments" Target="comments.xml"')
    const extra = docxExtraText(r.file)
    expect(extra).toContain('- Comment by Dana Choi, 2026-11-16 on "제3조 (대금) 을은 매월 말일 기준으로 정산하여 익월 말일까지 지급한다.":')
    expect(extra).toContain('정산일 재확인 필요')
    // the other parts are copied as they were
    const names = (b: Uint8Array) => readZip(b).map((e) => e.name).sort()
    expect(names(r.file)).toEqual([...names(before), 'word/comments.xml'].sort())
  })

  withPandoc('a second round adds to the comments part with a new id; text is escaped; a multi-line comment keeps its lines', () => {
    // pandoc's file has an empty, self-closed comments part
    const one = addDocxComments(docx(CONTRACT), [{ on: '제1조', text: 'A' }], 'Dana', '2026-11-16T09:00:00Z').file
    const two = addDocxComments(one, [{ on: '제4조', text: '<b>&"x"</b>\n둘째 줄' }], 'Bob', '2026-11-16T10:00:00Z').file
    const c = part(two, 'word/comments.xml')!
    expect(c.match(/<w:comment /g)!.length).toBe(2)
    expect(c).toContain('w:id="0"')
    expect(c).toContain('w:id="1"')
    expect(c).toContain('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;')
    expect(docxExtraText(two)).toMatch(/Comment by Bob[\s\S]*<b>&"x"<\/b>\n\s*둘째 줄/)
    // the content type and relationship are not added twice
    expect(part(two, '[Content_Types].xml')!.match(/comments\.xml/g)!.length).toBe(1)
  })

  withPandoc('text in no paragraph, or in several without occurrence: refused, nothing made', () => {
    expect(() => addDocxComments(docx(CONTRACT), [{ on: '제9조', text: 'x' }], 'D', 'd')).toThrow(/is not in the text of any one paragraph/)
    expect(() => addDocxComments(docx(CONTRACT), [{ on: '기준', text: 'x' }], 'D', 'd')).toThrow(/is in 2 paragraphs; give occurrence/)
    const r = addDocxComments(docx(CONTRACT), [{ on: '기준', text: 'x', occurrence: 2 }], 'D', 'd')
    expect(r.added[0]!.paragraph).toContain('제4조')
  })

  test('not a Word document: refused with words', () => {
    expect(() => addDocxComments(new Uint8Array(Buffer.from('nope')), [{ on: 'a', text: 'b' }], 'D', 'd')).toThrow(/not a Word document/)
  })

  test('the AI is told it can add comments and that tracked changes cannot be made; a team-content tool', () => {
    expect(COMMENT_DOCX_DESCRIPTION).toContain('Add Word comments')
    expect(COMMENT_DOCX_DESCRIPTION).toContain('Tracked changes (suggested edits) cannot be made here')
    expect(outsideContentTool('comment_docx')).toBe(false)
  })
})

let h: Harness
let bob: TestSocket
const put = (rel: string, data: string | Uint8Array) => { const p = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const read = (rel: string) => new Uint8Array(fs.readFileSync(path.join(h.team, ...rel.split('/'))))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('comment_docx: saved like edit_hwp', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-comment-docx', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
    bob = await h.ws('bob', { windowId: 'win-comment-docx-bob' })
    await bob.next('hello')
    if (pandoc) put('shared/contracts/계약서.docx', docx(CONTRACT))
  })
  afterAll(async () => { bob?.close(); await h?.close() })

  async function turn(content: string) {
    const chat = await h.api('bob').call(API.createChat, { body: {} })
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const done = await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 75_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string }
  }
  const call = { tool: 'comment_docx', args: { file_path: 'shared/contracts/계약서.docx', comments: [{ on: '제3조', text: '정산일 재확인 필요' }] }, sayResult: true }

  withPandoc('not read in this turn: refused, the file unchanged', async () => {
    const before = read('shared/contracts/계약서.docx')
    const r = await turn(fake(call))
    expect(r.content).toContain('first (with read) before adding comments')
    expect(Buffer.from(read('shared/contracts/계약서.docx')).equals(Buffer.from(before))).toBe(true)
  })

  withPandoc('read, then commented: a new version of the same file, the comment in it, the old one in its history', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/계약서.docx' } }, call))
    expect(r.content).toContain('Saved a new version of shared/contracts/계약서.docx with the comments')
    expect(r.content).toContain('comment 1 next to: "제3조 (대금)')
    expect(docxExtraText(read('shared/contracts/계약서.docx'))).toContain('정산일 재확인 필요')
    const versions = h.ctx.db.query('SELECT count(*) AS n FROM file_versions WHERE path = ?').get('shared/contracts/계약서.docx') as { n: number }
    expect(versions.n).toBeGreaterThan(0)
  })

  withPandoc('a skills folder as output is refused', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/계약서.docx' } }, { ...call, args: { ...call.args, output: 'skills/x/계약서.docx' } }))
    expect(r.content).toContain('cannot be saved in a skills folder')
  })
})
