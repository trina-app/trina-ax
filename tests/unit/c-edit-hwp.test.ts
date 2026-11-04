// edit_hwp through the tool path (the MCP handler, as an engine calls it): an existing .hwpx or .hwp changed and saved
// as a new version (the old one in the file history, the change the person's) or as a new file of the same format,
// never by silently overwriting; the same folder rules as any other save; refusals save nothing. And the AI's plain
// write and edit still refuse .hwp and .hwpx.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { employmentForm, hwpxDoc, onePageForm, para, purchaseForm } from '../lib/hwpx'
import { hwpEmploymentForm, hwpOnePageForm, hwpPurchaseForm, hwpStreams, paragraphs } from '../lib/hwp'
import { makeCApp, sha256hex, type CApp, type Person } from '../lib/c-app'
import { hwpPluginOn } from '../lib/hwp-plugin'

setDefaultTimeout(60_000)

let A: CApp
// filling Hangul documents comes with the HWP plugin: on here (off: plugins-hwp-writing.test.ts)
beforeAll(async () => { A = await makeCApp('c-edit-hwpx'); hwpPluginOn(A.ctx) })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const bytes = (rel: string) => fs.readFileSync(file(rel))
let rpcId = 0
/** one AI turn of `user` (a connection's calls, or with `chat` a chat turn's): its calls share what it read */
function turn(user: Person, o: { chat?: boolean } = {}) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, o.chat ? A.turn(user, A.chat(user)) : null))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
}
const versions = (rel: string) => A.ctx.db.query('SELECT version, sha256, author_id, kind FROM file_versions WHERE path = ? ORDER BY version').all(rel) as { version: number; sha256: string; author_id: string; kind: string }[]
const lastEvent = (rel: string) => A.ctx.db.query('SELECT action, user_id, detail FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1').get(rel) as { action: string; user_id: string; detail: string } | null

describe('a new version of the same file', () => {
  test('read, then fill: the file changes, the old bytes are in its history, the change is the person\'s', async () => {
    const rel = 'groups/marketing/forms/재직증명서.hwpx'
    put(rel, employmentForm())
    const before = bytes(rel)
    const call = turn('alice')
    expect((await call('read', { file_path: rel })).text).toContain('{{발급일}}')
    const r = await call('edit_hwp', { file_path: rel, changes: [{ find: '{{발급일}}', replace: '2026년 11월 3일' }, { cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved a new version of ${rel}; the previous version is in its file history.`)
    expect(r.text).toContain('- change 1, a paragraph: "발급일: {{발급일}}" -> "발급일: 2026년 11월 3일"\n- change 2, table 1, row 1, column 2: was empty, now "홍길동"')
    expect(r.text).toContain('Still in the document: {{입사일}}, {{대표자}}.')
    expect(versions(rel)).toEqual([{ version: 1, sha256: sha256hex(before), author_id: 'alice', kind: 'edit' }])
    const ev = lastEvent(rel)!
    expect([ev.action, ev.user_id, JSON.parse(ev.detail).tool]).toEqual(['update', 'alice', 'edit_hwp'])
    const read = await call('read', { file_path: rel })
    expect(read.text).toContain('발급일: 2026년 11월 3일')
    expect(read.text).toContain('홍길동')
    // the turn knows the version it saved: a second change needs no new read, and is one more version
    const again = await call('edit_hwp', { file_path: rel, changes: [{ find: '{{대표자}}', replace: '김예시' }] })
    expect(again.isError, again.text).toBe(false)
    expect(versions(rel).map((v) => v.version)).toEqual([1, 2])
  })

  test('not read in this turn, or changed by someone after the read: refused, nothing saved', async () => {
    const rel = 'groups/marketing/forms/구매요청.hwpx'
    put(rel, purchaseForm())
    const notRead = await turn('alice')('edit_hwp', { file_path: rel, changes: [{ add_rows: { table: 1, after_row: 3, rows: [['볼펜', '검정', '1', '500', '500']] } }] })
    expect(notRead.isError).toBe(true)
    expect(notRead.text).toContain(`read '${rel}' first`)
    const call = turn('alice')
    await call('read', { file_path: rel })
    const other = purchaseForm()
    put(rel, other) // someone saved the file again (new paragraph ids: other bytes) after this read
    const late = await call('edit_hwp', { file_path: rel, changes: [{ add_rows: { table: 1, after_row: 3, rows: [['볼펜', '검정', '1', '500', '500']] } }] })
    expect(late.isError).toBe(true)
    expect(late.text).toContain('was changed after you read it')
    expect(bytes(rel).equals(Buffer.from(other))).toBe(true)
    expect(versions(rel)).toEqual([])
  })

  test('a change that cannot be applied exactly saves nothing', async () => {
    const rel = 'groups/marketing/forms/재직증명서-2.hwpx'
    put(rel, employmentForm())
    const before = bytes(rel)
    const call = turn('alice')
    await call('read', { file_path: rel })
    const r = await call('edit_hwp', { file_path: rel, changes: [{ find: '{{발급일}}', replace: '오늘' }, { find: '없는 글', replace: 'x' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('change 2: "없는 글" is not in the document. Nothing was saved.')
    expect(bytes(rel).equals(before)).toBe(true)
    expect(versions(rel)).toEqual([])
  })
})

describe('a new file', () => {
  test('output: a new file next to the original, which stays as it was', async () => {
    const rel = 'groups/marketing/forms/재직증명서-원본.hwpx'
    put(rel, employmentForm())
    const before = bytes(rel)
    const call = turn('alice')
    await call('read', { file_path: rel })
    const r = await call('edit_hwp', { file_path: rel, output: 'users/alice/out/재직증명서-홍길동', changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved users/alice/out/재직증명서-홍길동.hwpx; ${rel} is unchanged.`)
    expect(bytes(rel).equals(before)).toBe(true)
    expect(lastEvent('users/alice/out/재직증명서-홍길동.hwpx')!.action).toBe('create')
    expect((await call('read', { file_path: 'users/alice/out/재직증명서-홍길동.hwpx' })).text).toContain('홍길동')
  })

  test('an existing file not read in this turn is kept: the result is a conflict copy', async () => {
    const rel = 'groups/marketing/forms/견본.hwpx'
    put(rel, employmentForm())
    put('users/alice/out/있음.hwpx', purchaseForm())
    const kept = bytes('users/alice/out/있음.hwpx')
    const call = turn('alice')
    await call('read', { file_path: rel })
    const r = await call('edit_hwp', { file_path: rel, output: 'users/alice/out/있음.hwpx', changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain("'users/alice/out/있음.hwpx' was changed by someone else in the meantime, so the result was saved as")
    expect(bytes('users/alice/out/있음.hwpx').equals(kept)).toBe(true)
  })

  test('a new file where more people can see it than the original: refused without a person to ask', async () => {
    const rel = 'groups/marketing/forms/대외비.hwpx'
    put(rel, employmentForm())
    const call = turn('alice')
    await call('read', { file_path: rel })
    const r = await call('edit_hwp', { file_path: rel, output: 'shared/재직증명서.hwpx', changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("more people can read 'shared/재직증명서.hwpx' than the files it is made from")
    expect(fs.existsSync(file('shared/재직증명서.hwpx'))).toBe(false)
  })
})

describe('the folder rules of the person', () => {
  test('read-only: no new version, but a new file in a folder the person may write', async () => {
    const rel = 'projects/falcon/forms/참가신청서.hwpx'
    put(rel, employmentForm())
    const before = bytes(rel)
    const call = turn('bob')
    expect((await call('read', { file_path: rel })).isError).toBe(false)
    const r = await call('edit_hwp', { file_path: rel, changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError).toBe(true)
    expect(bytes(rel).equals(before)).toBe(true)
    expect(versions(rel)).toEqual([])
    const own = await call('edit_hwp', { file_path: rel, output: 'users/bob/참가신청서.hwpx', changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(own.isError, own.text).toBe(false)
  })

  test('a folder the person cannot see: refused as for any read', async () => {
    put('groups/finance/forms/지출결의서.hwpx', employmentForm())
    const r = await turn('alice')('edit_hwp', { file_path: 'groups/finance/forms/지출결의서.hwpx', changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError).toBe(true)
    expect(lastEvent('groups/finance/forms/지출결의서.hwpx')).toBeNull()
  })

  test('under skills/ only after the person confirmed it on the server\'s card: a chat turn without it is refused', async () => {
    const rel = 'skills/서식/재직증명서.hwpx'
    put(rel, employmentForm())
    const before = bytes(rel)
    const call = turn('carol', { chat: true })
    await call('read', { file_path: rel })
    const r = await call('edit_hwp', { file_path: rel, changes: [{ find: '가나다상사', replace: '라마바물산' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("needs the user's confirmation on the server's card")
    expect(bytes(rel).equals(before)).toBe(true)
    expect(versions(rel)).toEqual([])
    // alice may only read skills/: refused before anything is changed
    const alice = turn('alice', { chat: true })
    await alice('read', { file_path: rel })
    expect((await alice('edit_hwp', { file_path: rel, changes: [{ find: '가나다상사', replace: '라마바물산' }] })).isError).toBe(true)
    expect(bytes(rel).equals(before)).toBe(true)
  })
})

describe('refused documents and files', () => {
  test('another kind of file, and a document with scripts: nothing saved', async () => {
    put('users/alice/매크로.hwpx', hwpxDoc([para('본문 {{x}}')], { extra: { 'Scripts/headerScripts': 'function OnDocument_Open() {}' } }))
    const call = turn('alice')
    await call('read', { file_path: 'users/alice/매크로.hwpx' })
    const doc = await call('edit_hwp', { file_path: 'groups/marketing/brand-guidelines.docx', changes: [{ find: 'mint', replace: 'x' }] })
    expect(doc.text).toContain('changes Hangul documents (.hwp and .hwpx) only')
    const before = bytes('users/alice/매크로.hwpx')
    const macro = await call('edit_hwp', { file_path: 'users/alice/매크로.hwpx', changes: [{ find: '{{x}}', replace: 'y' }] })
    expect(macro.isError).toBe(true)
    expect(macro.text).toContain('this .hwpx cannot be changed: it contains scripts (Scripts/); nothing was saved')
    expect(bytes('users/alice/매크로.hwpx').equals(before)).toBe(true)
    expect(versions('users/alice/매크로.hwpx')).toEqual([])
  })

  test('the plain write and edit still refuse a .hwpx, after edit_hwp changed it too', async () => {
    const rel = 'users/alice/양식.hwpx'
    put(rel, employmentForm())
    const call = turn('alice')
    await call('read', { file_path: rel })
    expect((await call('edit_hwp', { file_path: rel, changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })).isError).toBe(false)
    const after = bytes(rel)
    const e = await call('edit', { file_path: rel, old_string: '홍길동', new_string: '김예시' })
    expect(e.isError).toBe(true)
    expect(e.text).toContain('only text files can be edited')
    const w = await call('write', { file_path: rel, content: '# 평문' })
    expect(w.isError).toBe(true)
    expect(w.text).toContain('cannot be written as text')
    expect(bytes(rel).equals(after)).toBe(true)
  })

  test('the tool is listed with its changes', async () => {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })
    const t = r.result.tools.find((x: any) => x.name === 'edit_hwp')
    expect(t.description).toContain('Change the text of an existing Hangul document (.hwp or .hwpx) and save it in the same format')
    expect(Object.keys(t.inputSchema.properties)).toEqual(['file_path', 'changes', 'output'])
  })
})

describe('a .hwp', () => {
  test('read, then fill: a new version of the .hwp (history, the person\'s change); every stream but the section kept', async () => {
    const rel = 'groups/marketing/forms/재직증명서.hwp'
    put(rel, hwpEmploymentForm())
    const before = bytes(rel)
    const call = turn('alice')
    expect((await call('read', { file_path: rel })).text).toContain('{{발급일}}')
    const r = await call('edit_hwp', { file_path: rel, changes: [{ find: '{{발급일}}', replace: '2026년 11월 3일' }, { cell: { next_to: '성명' }, value: '홍길동' }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved a new version of ${rel}; the previous version is in its file history.`)
    expect(r.text).toContain('- change 2, table 1, row 1, column 2: was empty, now "홍길동"')
    expect(versions(rel)).toEqual([{ version: 1, sha256: sha256hex(before), author_id: 'alice', kind: 'edit' }])
    expect([lastEvent(rel)!.action, JSON.parse(lastEvent(rel)!.detail).tool]).toEqual(['update', 'edit_hwp'])
    const now = bytes(rel)
    expect(now.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1')
    const a = hwpStreams(before), b = hwpStreams(now)
    for (const [k, v] of a) if (k !== 'BodyText/Section0') expect(b.get(k)!.equals(v), k).toBe(true)
    expect(paragraphs(now).find((p) => p.text === '홍길동<13>')).toBeTruthy()
    const read = await call('read', { file_path: rel })
    expect(read.text).toContain('발급일: 2026년 11월 3일')
  })

  test('output: a new .hwp next to the original; an output in the other format is refused before any work', async () => {
    const rel = 'groups/marketing/forms/구매요청.hwp'
    put(rel, hwpPurchaseForm())
    const before = bytes(rel)
    const call = turn('alice')
    await call('read', { file_path: rel })
    const r = await call('edit_hwp', { file_path: rel, output: 'users/alice/out/구매요청-볼펜', changes: [{ add_rows: { table: 1, after_row: 3, rows: [['볼펜', '검정', '1', '500', '500']] } }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved users/alice/out/구매요청-볼펜.hwp; ${rel} is unchanged.`)
    expect(bytes(rel).equals(before)).toBe(true)
    expect((await call('read', { file_path: 'users/alice/out/구매요청-볼펜.hwp' })).text).toContain('볼펜')
    const other = await call('edit_hwp', { file_path: rel, output: 'users/alice/out/구매요청.hwpx', changes: [{ find: '토너', replace: '잉크' }] })
    expect(other.isError).toBe(true)
    expect(other.text).toContain("is a .hwp and stays one when it is changed; give output ending in .hwp")
    expect(fs.existsSync(file('users/alice/out/구매요청.hwpx'))).toBe(false)
  })

  test('refused documents save nothing: a script of its own, a distribution-only document; not read first', async () => {
    put('users/alice/스크립트.hwp', hwpEmploymentForm({ flags: 1 | 8 }))
    put('users/alice/배포용.hwp', hwpEmploymentForm({ flags: 1 | 4 }))
    const call = turn('alice')
    const notRead = await call('edit_hwp', { file_path: 'users/alice/스크립트.hwp', changes: [{ find: '{{발급일}}', replace: 'x' }] })
    expect(notRead.text).toContain("read 'users/alice/스크립트.hwp' first")
    for (const [f, why] of [['users/alice/스크립트.hwp', 'this .hwp cannot be changed: it contains scripts (Scripts/); nothing was saved'], ['users/alice/배포용.hwp', 'this .hwp cannot be changed: it is a distribution-only document (배포용); nothing was saved']] as const) {
      const before = bytes(f)
      await call('read', { file_path: f })
      const r = await call('edit_hwp', { file_path: f, changes: [{ find: '{{발급일}}', replace: 'x' }] })
      expect(r.isError).toBe(true)
      expect(r.text).toContain(why)
      expect(bytes(f).equals(before)).toBe(true)
      expect(versions(f)).toEqual([])
    }
  })

  test('rows a one-page form cannot hold: the AI gets the refusal with how many fit, and no version is saved', async () => {
    for (const [rel, form] of [['groups/marketing/forms/교부신청서.hwp', hwpOnePageForm()], ['groups/marketing/forms/교부신청서.hwpx', onePageForm()]] as const) {
      put(rel, form)
      const before = bytes(rel)
      const call = turn('alice')
      await call('read', { file_path: rel })
      const r = await call('edit_hwp', { file_path: rel, changes: [{ cell: { table: 1, row: 2, col: 2 }, value: '홍예시' }, { add_rows: { table: 1, after_row: 3, rows: [['자녀', '홍둘째', ''], ['자녀', '홍셋째', '']] } }] })
      expect(r.isError, rel).toBe(true)
      expect(r.text).toContain('change 2: table 1 fills its page and cannot continue on the next page (it is placed as a character, 글자처럼 취급), so Hangul would cut off its end: ' +
        '2 rows were asked for and about 1 fit. Add at most 1 row, and write the rest on a separate sheet (별지), as such forms usually ask. Nothing was saved.')
      expect(bytes(rel).equals(before)).toBe(true)
      expect(versions(rel)).toEqual([])
      // the one row that fits is saved
      const one = await call('edit_hwp', { file_path: rel, changes: [{ add_rows: { table: 1, after_row: 3, rows: [['자녀', '홍둘째', '']] } }] })
      expect(one.isError, one.text).toBe(false)
      expect(versions(rel).map((v) => v.version)).toEqual([1])
    }
  })

  test('the plain write and edit still refuse a .hwp, after edit_hwp changed it too', async () => {
    const rel = 'users/alice/양식.hwp'
    put(rel, hwpEmploymentForm())
    const call = turn('alice')
    await call('read', { file_path: rel })
    expect((await call('edit_hwp', { file_path: rel, changes: [{ cell: { next_to: '성명' }, value: '홍길동' }] })).isError).toBe(false)
    const after = bytes(rel)
    expect((await call('edit', { file_path: rel, old_string: '홍길동', new_string: '김예시' })).isError).toBe(true)
    expect((await call('write', { file_path: rel, content: '# 평문' })).isError).toBe(true)
    expect(bytes(rel).equals(after)).toBe(true)
  })
})
