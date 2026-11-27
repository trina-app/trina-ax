// The Slack channel relay (docs/SLACK.md "Channel relay", integrations/slack/relay.ts) against the fake Slack
// (tests/lib/fake-slack.ts, the team's own app over Socket Mode): who may connect (a team owner or admin in the
// conversation, linked to Slack and in the channel, the app in it too; no guests; team conversations and projects only),
// routing by channel (an unlinked channel's message is dropped, a linked one comes in whatever workspace the outer
// team_id names), loops (our own posts and their echoes never come back, a retry is posted once), threads, mentions,
// edits and deletes both ways, what is not relayed out (an AI answer, files only), a refused post and Retry, the
// guest rule, the states, and the catch-up after a gap. No real Slack is contacted.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { sealSecret } from '../../web/src/lib/seal'
import { credentialsOf } from '../../server/src/credentials/store'
import { slackOf } from '../../server/src/integrations/slack/service'
import { roomsOf } from '../../server/src/rooms/service'
import { messageRow } from '../../server/src/rooms/store'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, teamProject } from './guest-lib'
import { nextTs, startFakeSlack, type FakeSlack } from '../lib/fake-slack'
import { waitFor } from '../lib/wait'

setDefaultTimeout(90_000)
let h: Harness
let fake: FakeSlack
let owner: Client
let ada: { client: Client; id: string }
let mia: { client: Client; id: string }
let team = ''
const CH = 'C0CLIENT'
const cm = () => 'cm-' + crypto.randomUUID()
const relay = () => slackOf(h.ctx).relay

async function messages(c: Client, room = team) { return (await c.call('GET', `/api/rooms/${room}/messages`)).items as any[] }
const appMessages = async (c: Client) => (await messages(c)).filter((m) => m.slackAuthor)
const slackLines = async (c: Client, room = team) => (await messages(c, room)).filter((m) => m.event?.type === 'slack').map((m) => m.event.what)
function say(text: string, o: { user?: string; ts?: string; thread?: string; channel?: string; team?: string; extra?: Record<string, unknown> } = {}) {
  const ts = o.ts ?? nextTs()
  fake.event({ type: 'message', channel_type: 'channel', channel: o.channel ?? CH, user: o.user ?? 'U0EXT', text, ts, ...(o.thread ? { thread_ts: o.thread } : {}), ...o.extra }, o.team ? { team: o.team } : {})
  return ts
}

beforeAll(async () => {
  fake = startFakeSlack()
  fake.scopes.push('channels:history', 'groups:history', 'chat:write.customize')
  fake.users = {
    U0ADA: { name: 'ada.slack', team_id: 'T0ACME' },
    U0EXT: { name: 'Jun at Client', team_id: 'T0CLIENT' },
    U0MIA: { name: 'mia.slack', team_id: 'T0ACME' },
  }
  fake.channels = {
    [CH]: { name: 'client-acme', members: ['U0BOT', 'U0ADA', 'U0EXT'], messages: [] },
    C0NOBOT: { name: 'no-bot', members: ['U0ADA'], messages: [] },
    C0NOADA: { name: 'no-ada', members: ['U0BOT'], messages: [] },
    C0PROJ: { name: 'proj', members: ['U0BOT', 'U0ADA'], messages: [] },
  }
  h = await harness('c-slack-relay')
  owner = await withOwner(h)
  ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  mia = await addMember(h, owner, { username: 'mia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'clients', memberIds: [ada.id, mia.id] })
  team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id).id
  slackOf(h.ctx, { base: fake.url, pollMs: 30, retryMs: 50, timeoutMs: 2000 })
  relay().postGapMs = 0
  relay().historyGapMs = 0
  const seal = async (s: string) => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), s, 'slack.token')
  await owner.call('PUT', '/api/admin/slack/tokens', { botToken: await seal(fake.botToken), appToken: await seal(fake.appToken), clientId: fake.clientId, clientSecret: await seal(fake.clientSecret) })
  await owner.call('POST', '/api/admin/slack/enabled', { enabled: true })
  await fake.connected()
  await waitFor(() => (h.ctx.db.query('SELECT bot_scopes FROM slack_config').get() as { bot_scopes: string | null } | null)?.bot_scopes?.includes('chat:write.customize'))
})
afterAll(async () => { fake?.close(); await h?.close() })

const linkSlack = (userId: string, slackUser: string) => h.ctx.db.query("INSERT OR REPLACE INTO slack_links (id, user_id, team_id, slack_user_id, slack_name, created_at) VALUES (?, ?, 'T0ACME', ?, NULL, ?)").run(crypto.randomUUID(), userId, slackUser, new Date().toISOString())

test('who may connect: a member 403; an admin not linked 409; only channels both are in; the app must be in it; then once', async () => {
  const st = await mia.client.call('GET', `/api/rooms/${team}/slack`)
  expect(st).toMatchObject({ link: null, blocked: 'not_manager', meLinked: false })
  expect((await mia.client.try('POST', `/api/rooms/${team}/slack`, { channelId: CH })).status).toBe(403)
  expect((await mia.client.try('GET', `/api/rooms/${team}/slack/channels`)).status).toBe(403)
  // not in the conversation: 404, an owner too
  expect((await owner.try('GET', `/api/rooms/${team}/slack`)).status).toBe(404)
  const notLinked = await ada.client.try('POST', `/api/rooms/${team}/slack`, { channelId: CH })
  expect([notLinked.status, notLinked.body?.error?.params?.reason]).toEqual([409, 'slack_not_linked'])
  linkSlack(ada.id, 'U0ADA')
  const list = await ada.client.call('GET', `/api/rooms/${team}/slack/channels`)
  expect(list.items.map((c: any) => c.id).sort()).toEqual([CH, 'C0PROJ'])
  const noBot = await ada.client.try('POST', `/api/rooms/${team}/slack`, { channelId: 'C0NOBOT' })
  expect([noBot.status, noBot.body?.error?.params?.reason]).toEqual([409, 'bot_not_in_channel'])
  const noAda = await ada.client.try('POST', `/api/rooms/${team}/slack`, { channelId: 'C0NOADA' })
  expect([noAda.status, noAda.body?.error?.params?.reason]).toEqual([409, 'not_in_channel'])
  expect((await ada.client.try('POST', `/api/rooms/${team}/slack`, { channelId: 'D0ADA' })).status).toBe(400)
  const made = await ada.client.call('POST', `/api/rooms/${team}/slack`, { channelId: CH })
  expect(made.link).toMatchObject({ channelId: CH, channelName: 'client-acme', state: 'active', customName: true, createdBy: { id: ada.id } })
  // everyone in the conversation sees the link (the chip), no per-member check
  expect((await mia.client.call('GET', `/api/rooms/${team}/slack`)).link.channelName).toBe('client-acme')
  expect(await slackLines(mia.client)).toEqual(['connected'])
  const again = await ada.client.try('POST', `/api/rooms/${team}/slack`, { channelId: 'C0PROJ' })
  expect([again.status, again.body?.error?.params?.reason]).toEqual([409, 'linked'])
  // the link is a room app with no address, example or secret
  const apps = await ada.client.call('GET', `/api/rooms/${team}/apps`)
  const app = apps.items.find((a: any) => a.preset === 'slack')
  expect(app.slack).toMatchObject({ channelId: CH, state: 'active' })
  expect((await ada.client.try('GET', `/api/rooms/${team}/apps/${app.id}/address`)).status).toBe(409)
  expect((await ada.client.try('POST', `/api/rooms/${team}/apps/${app.id}/example`)).status).toBe(409)
  expect((await ada.client.try('POST', `/api/rooms/${team}/apps`, { kind: 'other', preset: 'slack' })).status).toBe(409)
  const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.relay_linked'").get() as { detail: string }
  expect(JSON.parse(audit.detail)).toMatchObject({ channel: CH })
})

test('in: a linked channel comes in with the Slack name; once per ts; other channels and our own bot dropped; routed by channel', async () => {
  const ts = say('Hi team, <@U0ADA> can you check the *invoice*? <https://acme.example/x|the doc>')
  const got = await waitFor(async () => (await appMessages(mia.client)).find((m) => m.slackAuthor.name === 'Jun at Client'))
  expect(got.slackAuthor).toMatchObject({ name: 'Jun at Client', external: true })
  expect(got.app).toMatchObject({ kind: 'other', preset: 'slack' })
  // plain text: the mention by the person's Trina name (and a mention here), the link as words; never Markdown
  expect(got.body).toContain('Jun at Client: Hi team, \\@ADA can you check the \\*invoice\\*? the doc (https:\\/\\/acme.example/x)')
  expect(got.mentions).toEqual([ada.id])
  // Slack's retry (another envelope, the same ts), our own bot's post, an unlinked channel: nothing more
  fake.event({ type: 'message', channel_type: 'channel', channel: CH, user: 'U0EXT', text: 'Hi again', ts })
  say('from our own bot', { user: 'U0BOT', extra: { bot_id: 'B0BOT', bot_profile: { app_id: fake.appId, team_id: 'T0ACME' } } })
  say('in a channel nobody linked', { channel: 'C0NOADA' })
  say('a join line', { extra: { subtype: 'channel_join' } })
  // a Slack Connect channel shared with another install: the outer team_id names the other workspace
  say('via the other workspace', { team: 'T0CLIENT' })
  await waitFor(async () => (await appMessages(mia.client)).some((m) => m.body.includes('via the other workspace')))
  await Bun.sleep(150)
  const all = await appMessages(mia.client)
  expect(all.map((m) => m.body.replace(/^[^:]+: /, ''))).toEqual([expect.stringContaining('Hi team'), 'via the other workspace'])
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE body LIKE '%nobody linked%' OR body LIKE '%own bot%'").get()).toEqual({ n: 0 })
  // the AI reads it as someone outside the team
  const { readRoom } = await import('../../server/src/rooms/reader')
  const read = readRoom(h.ctx.db, mia.id, 'UTC', { room: team } as any)
  expect(JSON.stringify(read)).toContain('a person in Slack, not a member of this team')
})

test('in: threads, edits and deletes follow', async () => {
  const root = say('root message')
  const r = await waitFor(async () => (await appMessages(mia.client)).find((m) => m.body.endsWith('root message')))
  say('a reply in Slack', { thread: root })
  await waitFor(async () => (h.ctx.db.query("SELECT 1 FROM room_messages WHERE thread_root_id = ? AND body LIKE '%a reply in Slack%'").get(r.id)))
  // a reply whose first message was never relayed: a normal message that says so
  say('reply to an old thread', { thread: '1600000000.000100' })
  const orphan = await waitFor(async () => (await appMessages(mia.client)).find((m) => m.body.endsWith('reply to an old thread')))
  expect(orphan.slackAuthor.threadElsewhere).toBe(true)
  expect(orphan.threadRootId).toBeUndefined()
  // a message_changed that only counts the thread's replies (same text): not an edit
  fake.event({ type: 'message', subtype: 'message_changed', channel: CH, channel_type: 'channel', ts: nextTs(), message: { type: 'message', user: 'U0EXT', text: 'root message', ts: root, reply_count: 1 } })
  await Bun.sleep(200)
  expect((await appMessages(mia.client)).find((m) => m.id === r.id)!.editedAt).toBeNull()
  // edited, then deleted in Slack
  fake.event({ type: 'message', subtype: 'message_changed', channel: CH, channel_type: 'channel', ts: nextTs(), message: { type: 'message', user: 'U0EXT', text: 'root message (edited)', ts: root, edited: { user: 'U0EXT', ts: nextTs() } } })
  await waitFor(async () => (await appMessages(mia.client)).find((m) => m.id === r.id && m.body.endsWith('(edited)') && m.editedAt))
  fake.event({ type: 'message', subtype: 'message_deleted', channel: CH, channel_type: 'channel', ts: nextTs(), deleted_ts: root, hidden: true })
  await waitFor(() => (messageRow(h.ctx.db, team, r.id)?.deleted_at ?? null))
})

test('out: a person\'s message goes as "Name (Trina)", with its thread, edit and delete; its echo never comes back', async () => {
  const before = fake.of('chat.postMessage').length
  const sent = await mia.client.call('POST', `/api/rooms/${team}/messages`, { body: 'Hello <client> & co', mentions: [], fileIds: [], clientMessageId: cm() })
  const post = await waitFor(() => fake.of('chat.postMessage')[before])
  expect(post.args).toMatchObject({ channel: CH, text: 'Hello &lt;client&gt; &amp; co', link_names: 'false' })
  expect(post.args.username).toMatch(/^MIA \(.+\)$/)
  await waitFor(async () => (await messages(mia.client)).find((m) => m.id === sent.id)?.slackSent === 'ok')
  const row = h.ctx.db.query("SELECT ts FROM slack_relay_messages WHERE room_message_id = ? AND direction = 'out'").get(sent.id) as { ts: string }
  // the echo of our own post: the bot's user, or only the ts we keep
  const n = (await appMessages(mia.client)).length
  say('Hello <client> & co', { user: 'U0BOT', ts: row.ts, extra: { bot_id: 'B0BOT', username: 'MIA (Trina)' } })
  fake.event({ type: 'message', channel: CH, channel_type: 'channel', ts: row.ts, bot_id: 'B0XYZ', subtype: 'bot_message', username: 'MIA (Trina)', text: 'Hello' })
  // the shape a post with \`username\` really comes back in (live check 2026-11-27): bot_message with our bot_id and
  // app_id, no user, no bot_profile; even with a ts not recorded yet (the echo before the post's answer)
  fake.event({ type: 'message', channel: CH, channel_type: 'channel', ts: nextTs(), bot_id: 'B0BOT', app_id: fake.appId, subtype: 'bot_message', username: 'MIA (Trina)', text: 'early echo' })
  // another company's app in the channel is an outside app's message (with the official app, another Trina team's
  // install has our app id but another bot id: relay.ts ownBot)
  fake.event({ type: 'message', channel: CH, channel_type: 'channel', ts: nextTs(), bot_id: 'B0OTHER', app_id: 'A0OTHER', subtype: 'bot_message', username: 'Kim (Trina)', text: 'from the other team' })
  await waitFor(async () => (await appMessages(mia.client)).find((m) => m.body.includes('from the other team')))
  await Bun.sleep(300)
  expect((await appMessages(mia.client)).length).toBe(n + 1)
  expect((await appMessages(mia.client)).find((m) => m.body.includes('from the other team'))!.slackAuthor).toMatchObject({ name: 'Kim (Trina)', bot: true })
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE body LIKE '%early echo%'").get()).toEqual({ n: 0 })
  // edit and delete follow
  await mia.client.call('PATCH', `/api/rooms/${team}/messages/${sent.id}`, { body: 'Hello again', mentions: [] })
  const upd = await waitFor(() => fake.of('chat.update').find((c) => c.args.ts === row.ts))
  expect(upd!.args.text).toBe('Hello again')
  // a reply in the thread of a relayed message goes to that Slack thread; a mention of a linked person is theirs
  const root = (await appMessages(mia.client)).find((m) => m.body.includes('via the other workspace'))!
  const rootTs = (h.ctx.db.query('SELECT ts FROM slack_relay_messages WHERE room_message_id = ?').get(root.id) as { ts: string }).ts
  const k = fake.of('chat.postMessage').length
  await mia.client.call('POST', `/api/rooms/${team}/messages`, { body: '@ADA look', mentions: [ada.id], fileIds: [], threadRootId: root.id, clientMessageId: cm() })
  const reply = await waitFor(() => fake.of('chat.postMessage')[k])
  expect(reply.args).toMatchObject({ thread_ts: rootTs, text: '<@U0ADA> look' })
  await mia.client.call('DELETE', `/api/rooms/${team}/messages/${sent.id}`)
  await waitFor(() => fake.of('chat.delete').find((c) => c.args.ts === row.ts))
})

test('out: an AI answer is not relayed (marked); a refused post says so, Retry sends it; not_in_channel ends the relay', async () => {
  const rooms = roomsOf(h.ctx)
  const k = fake.of('chat.postMessage').length
  const ans = rooms.send(mia.id, team, { body: 'an AI answer', mentions: [], fileIds: [], clientMessageId: cm() } as any, {}, { at: 0, cut: false, scope: null, people: 0, plain: false } as any)
  await Bun.sleep(200)
  expect(fake.of('chat.postMessage').length).toBe(k)
  expect((await messages(mia.client)).find((m) => m.id === ans.id)?.slackSent).toBe('not_relayed')
  // Slack refuses once (another company's policy): failed, then Retry by its author only
  fake.failNext['chat.postMessage'] = { error: 'restricted_action' }
  const m = await mia.client.call('POST', `/api/rooms/${team}/messages`, { body: 'please refuse', mentions: [], fileIds: [], clientMessageId: cm() })
  await waitFor(async () => (await messages(ada.client)).find((x) => x.id === m.id)?.slackSent === 'failed')
  expect((await ada.client.try('POST', `/api/rooms/${team}/slack/messages/${m.id}/retry`)).status).toBe(404)
  expect((await mia.client.try('POST', `/api/rooms/${team}/slack/messages/${m.id}/retry`)).status).toBe(204)
  await waitFor(async () => (await messages(mia.client)).find((x) => x.id === m.id)?.slackSent === 'ok')
  // the app was removed from the channel: the post says not_in_channel, the link is bot_removed with its line
  fake.failNext['chat.postMessage'] = { error: 'not_in_channel' }
  await mia.client.call('POST', `/api/rooms/${team}/messages`, { body: 'nobody hears this', mentions: [], fileIds: [], clientMessageId: cm() })
  await waitFor(async () => (await mia.client.call('GET', `/api/rooms/${team}/slack`)).link.state === 'bot_removed')
  expect(await slackLines(mia.client)).toContain('bot_removed')
  // the recheck sees the app in the channel again: active, with a line
  await relay().recheck()
  expect((await mia.client.call('GET', `/api/rooms/${team}/slack`)).link.state).toBe('active')
  expect(await slackLines(mia.client)).toContain('back')
})

test('channel events: shared with another organization, and the app removed (channel_left)', async () => {
  fake.event({ type: 'channel_shared', channel: CH, connected_team_id: 'T0CLIENT', event_ts: nextTs() })
  await waitFor(async () => (await mia.client.call('GET', `/api/rooms/${team}/slack`)).link.extShared === true)
  expect(await slackLines(mia.client)).toContain('shared')
  fake.event({ type: 'channel_left', channel: CH, actor_id: 'U0ADA', event_ts: nextTs() })
  await waitFor(async () => (await mia.client.call('GET', `/api/rooms/${team}/slack`)).link.state === 'bot_removed')
  // while removed nothing comes in
  say('while the app is out')
  await Bun.sleep(300)
  expect((await appMessages(mia.client)).some((m) => m.body.includes('while the app is out'))).toBe(false)
  await relay().recheck()
  expect((await mia.client.call('GET', `/api/rooms/${team}/slack`)).link.state).toBe('active')
})

test('catch-up after a gap: what came meanwhile, once; more than a page: "may be missing"', async () => {
  const last = (h.ctx.db.query('SELECT last_ts FROM slack_relay_links').get() as { last_ts: string }).last_ts
  const t1 = (Number(last) + 1).toFixed(6), t2 = (Number(last) + 2).toFixed(6)
  fake.channels[CH]!.messages.push({ ts: t1, user: 'U0EXT', text: 'missed one' }, { ts: t2, user: 'U0EXT', text: 'missed two' })
  await relay().catchUp('test')
  const got = (await appMessages(mia.client)).filter((m) => m.body.includes('missed'))
  expect(got.map((m) => m.body.replace(/^[^:]+: /, ''))).toEqual(['missed one', 'missed two'])
  await relay().catchUp('test')
  expect((await appMessages(mia.client)).filter((m) => m.body.includes('missed')).length).toBe(2)
  // more than one page (the fake gives 100; the official app unlisted asks for 15)
  for (let i = 0; i < 120; i++) fake.channels[CH]!.messages.push({ ts: (Number(t2) + 1 + i).toFixed(6), user: 'U0EXT', text: `bulk ${i}` })
  await relay().catchUp('test')
  expect(await slackLines(mia.client)).toContain('missing')
})

test('guests: a conversation with a guest cannot be linked, a guest cannot join a linked project', async () => {
  // a project, its chat room linked, then a guest invited to it: refused
  const p = await teamProject(ada.client, 'client-work')
  const room = (await ada.client.call('POST', `/api/projects/${p.id}/room`)).id as string
  expect((await ada.client.call('POST', `/api/rooms/${room}/slack`, { channelId: 'C0PROJ' })).link.channelName).toBe('proj')
  let refused: unknown = null
  try { await addGuest(h, ada.client, { username: 'gina', place: { kind: 'project', id: p.id } }) } catch (e) { refused = e }
  expect(String((refused as Error)?.message ?? refused)).toContain('slack_relay_guest')
  // disconnected: the guest can come in; a conversation with a guest cannot be linked
  await ada.client.call('DELETE', `/api/rooms/${room}/slack`)
  expect(await slackLines(ada.client, room)).toEqual(['connected', 'disconnected'])
  const gina = await addGuest(h, ada.client, { username: 'gina', place: { kind: 'project', id: p.id } })
  // (the project's people sync puts them in its room; here directly, so the check does not wait for it)
  h.ctx.db.query('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) VALUES (?, ?, ?, 0, 0)').run(room, gina.id, new Date().toISOString())
  expect((await ada.client.call('GET', `/api/rooms/${room}/slack`)).blocked).toBe('guests')
  const r = await ada.client.try('POST', `/api/rooms/${room}/slack`, { channelId: 'C0PROJ' })
  expect([r.status, r.body?.error?.params?.reason]).toEqual([409, 'guests'])
  // a group chat or a DM: room_kind
  const dm = (await ada.client.call('POST', '/api/rooms', { kind: 'dm', userId: mia.id })).id
  expect((await ada.client.call('GET', `/api/rooms/${dm}/slack`)).blocked).toBe('room_kind')
})

test('disconnect via the app\'s Remove: the line, the audit, nothing more comes or goes; history stays', async () => {
  const apps = await ada.client.call('GET', `/api/rooms/${team}/apps`)
  const app = apps.items.find((a: any) => a.preset === 'slack')
  const relayed = () => (h.ctx.db.query("SELECT COUNT(*) n FROM slack_relay_messages").get() as { n: number }).n
  const kept = relayed()
  await ada.client.call('DELETE', `/api/rooms/${team}/apps/${app.id}`)
  expect((await mia.client.call('GET', `/api/rooms/${team}/slack`)).link).toBeNull()
  expect((await slackLines(mia.client)).at(-1)).toBe('disconnected')
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'slack.relay_unlinked'").get()).toEqual({ n: 2 })
  const k = fake.of('chat.postMessage').length
  await mia.client.call('POST', `/api/rooms/${team}/messages`, { body: 'after the end', mentions: [], fileIds: [], clientMessageId: cm() })
  say('after the end in Slack')
  await Bun.sleep(300)
  expect(fake.of('chat.postMessage').length).toBe(k)
  expect(relayed()).toBe(kept)
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE body LIKE '%after the end in Slack%'").get()).toEqual({ n: 0 })
})
