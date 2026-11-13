// "Always allow" on every card (server/src/chat/always-allow.ts, docs/DECISIONS.md "Always allow on every card"; the
// owner, 2026-11-13: "항상 허용을 눌렀으면 안해야하는거 아니야?"). Covered: where it applies (the person's own app only: never
// a scheduled run, a Slack question, a restricted turn or a confidential chat; the team's switch off: as before, the
// rows kept), the card (the "Always allow" answer before the no, buttons for three, the note), picking it (kept for
// that person and kind only, audited once; the next card of that kind is not raised, another kind's is), Settings
// (listed among the allowances, deleted by its own person only, another person's or a made-up id: 404).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, CARD_ALWAYS_KINDS, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { ALWAYS_VALUE, alwaysHere, alwaysOn, dropAlways, keepAlways, listAlways, withAlways, type AlwaysPlace } from '../../server/src/chat/always-allow'
import { updateTeamSettings } from '../../server/src/admin/settings'

setDefaultTimeout(60_000)
let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-always-allow', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'carol']) { socks[u] = await h.ws(u, { windowId: `win-aa-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h.close() })

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const abs = (rel: string) => path.join(h.team, rel)
type Ask = TurnRequest & { requestId: string; options?: { label: string; value: string }[] }
/** one answer in the person's own chat, from their app; each card answered with `answer` */
async function turn(user: string, content: string, answer: string) {
  const chatId = (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
    for (const f of socks[user]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
      seen.add(f.data.request.requestId)
      cards.push(f.data.request as Ask)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer } })
    }
    const done = socks[user]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') return { cards, content: done.data.message.content as string }
    await Bun.sleep(50)
  }
}
const values = (c: Ask) => c.options?.map((o) => o.value)

const place = (o: Partial<AlwaysPlace> = {}): AlwaysPlace => ({ db: h.ctx.db, userId: 'alice', chatId: 'chat-always', turnId: 'turn-1', locale: 'en', clientKind: 'web', ...o })
const YES_NO = [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]
const clear = () => h.ctx.db.query('DELETE FROM card_always_allow').run()

describe('where it applies', () => {
  test('the person\'s own app: offered; a scheduled run, a Slack question, a restricted turn: never', () => {
    clear()
    for (const k of ['web', 'desktop', 'mobile']) expect(alwaysHere(place({ clientKind: k }), 'remember'), k).toBe('offer')
    for (const k of ['schedule', 'slack', null]) expect(alwaysHere(place({ clientKind: k }), 'remember'), String(k)).toBeNull()
    expect(alwaysHere(place({ restricted: true }), 'remember')).toBeNull()
    expect(alwaysHere(null, 'remember')).toBeNull()
    // on for alice: also never in a scheduled run (nobody there chose anything now)
    keepAlways(h.ctx.db, 'alice', 'remember', null)
    expect(alwaysHere(place(), 'remember')).toBe('on')
    expect(alwaysHere(place({ clientKind: 'schedule' }), 'remember')).toBeNull()
  })

  test('the team\'s switch off: no "Always allow" and the rows are ignored, kept; on again, they count', () => {
    clear()
    keepAlways(h.ctx.db, 'alice', 'video', null)
    updateTeamSettings(h.ctx.db, { roomAlwaysAllow: false })
    try {
      expect(alwaysOn(h.ctx.db, 'alice', 'video')).toBe(false)
      expect(alwaysHere(place(), 'video')).toBeNull()
      expect(listAlways(h.ctx.db, 'alice')).toHaveLength(1)
    } finally { updateTeamSettings(h.ctx.db, { roomAlwaysAllow: true }) }
    expect(alwaysOn(h.ctx.db, 'alice', 'video')).toBe(true)
  })
})

describe('the card', () => {
  test('offered: "Always allow" before the no, as buttons, with the note; picking it keeps it once (audited) and answers yes', async () => {
    clear()
    const seen: { options: { label: string; value: string }[]; extra: { buttons?: true; note?: string } }[] = []
    const v = await withAlways(place(), 'delete_files', YES_NO, 'yes', async (options, extra) => { seen.push({ options, extra }); return ALWAYS_VALUE })
    expect(v).toBe('yes')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.options).toEqual([{ label: 'Yes', value: 'yes' }, { label: 'Always allow', value: ALWAYS_VALUE }, { label: 'No', value: 'no' }])
    expect(seen[0]!.extra.buttons).toBe(true)
    expect(seen[0]!.extra.note).toContain("Trina won't ask about this kind of change again")
    const audits = () => h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'ai.always_allow' AND actor_id = 'alice'").all() as { detail: string }[]
    expect(audits().filter((a) => JSON.parse(a.detail).kind === 'delete_files' && JSON.parse(a.detail).on === true)).toHaveLength(1)
    // the next card of this kind: not raised; another kind's still is; another person's still is
    let asked = 0
    expect(await withAlways(place(), 'delete_files', YES_NO, 'yes', async () => { asked++; return 'no' })).toBe('yes')
    expect(asked).toBe(0)
    expect(await withAlways(place(), 'project_members', YES_NO, 'yes', async () => { asked++; return 'no' })).toBe('no')
    expect(await withAlways(place({ userId: 'bob' }), 'delete_files', YES_NO, 'yes', async () => { asked++; return 'no' })).toBe('no')
    expect(asked).toBe(2)
    // keeping it again adds no second audit row
    keepAlways(h.ctx.db, 'alice', 'delete_files', null)
    expect(audits().filter((a) => JSON.parse(a.detail).kind === 'delete_files' && JSON.parse(a.detail).on === true)).toHaveLength(1)
  })

  test('the card\'s own answers stay as they were: yes, no and no answer pass through; four answers are not buttons', async () => {
    clear()
    expect(await withAlways(place(), 'remember', YES_NO, 'yes', async () => 'yes')).toBe('yes')
    expect(await withAlways(place(), 'remember', YES_NO, 'yes', async () => null)).toBeNull()
    expect(alwaysOn(h.ctx.db, 'alice', 'remember')).toBe(false)
    const three = [{ label: 'Send', value: 'send' }, { label: 'Send with files', value: 'send_files' }, { label: 'No', value: 'no' }]
    let extra: { buttons?: true } = {}
    await withAlways(place(), 'post_to_room', three, 'send', async (_o, e) => { extra = e; return 'no' })
    expect(extra.buttons).toBeUndefined()
  })
})

describe('Settings › 트리나에게 허용한 것', () => {
  test('listed among the allowances; deleted by its own person only; a made-up kind or another person\'s: 404', async () => {
    clear()
    keepAlways(h.ctx.db, 'alice', 'remember', null)
    keepAlways(h.ctx.db, 'alice', 'skill_save', null)
    const items = (await h.api('alice').call(API.listAiAllowances)).items
    expect(items.filter((i) => i.kind === 'card').map((i) => i.id).sort()).toEqual(['card:remember', 'card:skill_save'])
    expect((await h.api('bob').call(API.listAiAllowances)).items.filter((i) => i.kind === 'card')).toEqual([])
    expect((await h.req('bob', '/api/ai-allowances/card:remember', { method: 'DELETE', headers: { 'x-mycel-csrf': '1' } })).status).toBe(404)
    expect((await h.req('alice', '/api/ai-allowances/card:not_a_kind', { method: 'DELETE', headers: { 'x-mycel-csrf': '1' } })).status).toBe(404)
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: 'card:remember' } })
    expect(alwaysOn(h.ctx.db, 'alice', 'remember')).toBe(false)
    expect(alwaysOn(h.ctx.db, 'alice', 'skill_save')).toBe(true)
    expect(dropAlways(h.ctx.db, 'alice', 'card:remember')).toBe(false)
  })

  test('every kind has its plain words in every language of the app', async () => {
    const { DICTS } = await import('../../web/src/i18n')
    for (const [lang, dict] of Object.entries(DICTS)) for (const k of CARD_ALWAYS_KINDS) expect((dict as Record<string, string>)[`allowances.card.${k}`], `${lang} ${k}`).toBeTruthy()
  })
})

// review of #678: each kind's card in a real answer: offered on the first card, then no card (TC-579, TC-580)
describe('in a real answer, once picked: no card', () => {
  test('move_files: a copy into a folder more people see', async () => {
    try {
      for (const n of [1, 2]) { fs.mkdirSync(path.dirname(abs(`users/alice/aa-move-${n}.md`)), { recursive: true }); fs.writeFileSync(abs(`users/alice/aa-move-${n}.md`), 'note\n') }
      const first = await turn('alice', fake({ tool: 'copy_files', args: { paths: ['users/alice/aa-move-1.md'], to_folder: 'shared' } }, { say: 'done' }), '__always')
      expect(first.cards.map(values)).toEqual([['allow', '__always', 'deny']])
      expect(fs.existsSync(abs('shared/aa-move-1.md'))).toBe(true)
      const next = await turn('alice', fake({ tool: 'copy_files', args: { paths: ['users/alice/aa-move-2.md'], to_folder: 'shared' } }, { say: 'done' }), 'deny')
      expect(next.cards).toEqual([])
      expect(fs.existsSync(abs('shared/aa-move-2.md'))).toBe(true)
    } finally { clear() }
  })

  test('save_wider: what a group file says, saved where the whole team sees it', async () => {
    try {
      const read = { tool: 'read', args: { file_path: 'groups/marketing/campaign-brief.md' } }
      const first = await turn('alice', fake(read, { tool: 'write', args: { file_path: 'shared/aa-wider-1.md', content: 'from the brief\n' } }, { say: 'done' }), '__always')
      expect(first.cards.map(values)).toEqual([['save', '__always', 'skip']])
      expect(fs.existsSync(abs('shared/aa-wider-1.md'))).toBe(true)
      const next = await turn('alice', fake(read, { tool: 'write', args: { file_path: 'shared/aa-wider-2.md', content: 'again\n' } }, { say: 'done' }), 'skip')
      expect(next.cards).toEqual([])
      expect(fs.existsSync(abs('shared/aa-wider-2.md'))).toBe(true)
    } finally { clear() }
  })

  test('skill_save: a team skill saved by an admin', async () => {
    const skill = (n: number) => ({ tool: 'write', args: { file_path: `skills/aa-skill-${n}/SKILL.md`, content: `---\nname: aa-skill-${n}\ndescription: test skill ${n}\n---\nDo the thing.\n` } })
    try {
      const first = await turn('carol', fake(skill(1), { say: 'done' }), '__always')
      expect(first.cards.map(values)).toEqual([['save', '__always', 'skip']])
      expect(fs.existsSync(abs('skills/aa-skill-1/SKILL.md'))).toBe(true)
      const next = await turn('carol', fake(skill(2), { say: 'done' }), 'skip')
      expect(next.cards).toEqual([])
      expect(fs.existsSync(abs('skills/aa-skill-2/SKILL.md'))).toBe(true)
    } finally { clear() }
  })
})
