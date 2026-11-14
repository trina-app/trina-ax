// Fills a running Acme demo (`bun run demo:company`, scripts/demo/acme) with what the docs screenshots show: room
// messages, a thread and a DM, a team project, a few chats with real answers (one pinned), a project chat two people
// asked in, a chat shared with Priya (Share…), an AI answer sent to a room from its side chat, and a scheduled task. Everything is fictional, like Acme itself. Run it once after the demo
// starts; a second run adds the same lines again, so start from a fresh data folder instead.
//
//   bun run demo:company --local --data <new folder>       (in another terminal)
//   bun scripts/docs/acme-scene.ts --url http://localhost:19830 --data <the same folder>
//
// The AI answers come from the server's own engine (this computer's Claude Code sign-in, as `bun run demo:company`
// uses), so the chats take a minute or two.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient } from '../../shared/src/api'
import { runPrompt } from '../demo/company/chat-run'

const PASSWORD = 'teamax-demo-1'
const id = () => crypto.randomUUID()

async function signIn(baseUrl: string, username: string, password = PASSWORD): Promise<ApiClient> {
  const r = await new ApiClient({ baseUrl }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl, token: r.token! })
}

export async function dress(baseUrl: string, ownerPassword: string, log: (s: string) => void = console.log) {
  const p = Object.fromEntries(await Promise.all(['dana', 'sam', 'alex', 'jordan', 'priya'].map(async (u) => [u, await signIn(baseUrl, u)] as const)))
  const rooms = (await p.jordan!.call(API.listRooms, {})).items
  const everyone = rooms.find((r) => r.kind === 'all')
  const marketing = rooms.find((r) => r.kind === 'team' && r.name === 'Marketing')
  if (!everyone || !marketing) throw new Error('the Everyone and Marketing rooms are missing: is this the Acme demo?')
  const say = async (who: string, roomId: string, body: string, o: { mentions?: string[]; threadRootId?: string } = {}) =>
    p[who]!.call(API.sendRoomMessage, { params: { id: roomId }, body: { body, mentions: o.mentions ?? [], fileIds: [], clientMessageId: id(), threadRootId: o.threadRootId ?? null } })

  // Everyone: a welcome and a reminder
  await say('dana', everyone.id, 'Welcome Alex Kim, who joins Marketing today! 👋')
  await say('priya', everyone.id, 'Welcome Alex!')
  await say('dana', everyone.id, 'Reminder: Q4 team budgets are due Friday. Put them in your team folder.')
  log('everyone: 3 messages')

  // Marketing: a kickoff with a mention and a thread. Jordan is the person the shots follow: a plain member (the demo's
  // three personas get a demo-only Home)
  const kickoff = await say('sam', marketing.id, 'November campaign kicks off Monday. @Jordan Lee can you draft the launch email this week?', { mentions: ['jordan'] })
  await say('jordan', marketing.id, 'On it. I will start from the brand voice notes.', { threadRootId: kickoff.id })
  await say('alex', marketing.id, 'Happy to help with the subject lines.', { threadRootId: kickoff.id })
  await say('alex', marketing.id, 'Banner drafts are ready for review tomorrow morning.')
  log('marketing: 4 messages, 2 in a thread')

  // A DM
  const dm = await p.sam!.call(API.createRoom, { body: { kind: 'dm', userId: 'jordan' } })
  await say('sam', dm.id, 'Coffee at 3 to go over the campaign?')
  await say('jordan', dm.id, 'Sounds good, see you then.')
  log('dm: sam and jordan')

  // A team project for Marketing (a group is named by its id, which only the owner's list gives)
  const owner = await signIn(baseUrl, 'acme-admin', ownerPassword)
  const group = (await owner.call(API.listGroups, {})).items.find((g) => g.name === 'Marketing')!
  const project = await p.jordan!.call(API.createProject, { body: {
    name: 'November campaign', scope: 'team', participants: [{ subjectType: 'group', subjectId: group.id }],
    instructions: 'Work from groups/Marketing/november-campaign-plan.md and the brand voice. Keep emails under 150 words.',
  } })
  log(`project: ${project.name}`)

  // Jordan's chats with real answers; the first is pinned, one is in the project
  const a = await runPrompt(p.jordan!, 'Summarize the November campaign plan in five bullet points.', { log })
  await p.jordan!.call(API.pinChat, { params: { id: a.chatId } })
  const voice = await runPrompt(p.jordan!, 'What does our brand voice say about exclamation marks?', { log })
  const inProject = await runPrompt(p.jordan!, 'Draft the launch email for the November campaign.', { log })
  await p.jordan!.call(API.updateChat, { params: { id: inProject.chatId }, body: { projectId: project.id } })
  log('jordan: 3 chats, 1 pinned, 1 in the project')

  // A chat started in the team project is shared with its members by default: Jordan asks, then Sam asks in it too, so
  // Jordan's lists show Sam's face on it
  const together = await runPrompt(p.jordan!, 'Which channels does the November campaign use? One line each.', { log, projectId: project.id })
  await runPrompt(p.sam!, 'Which of these channels gets the biggest budget? One line.', { log, chatId: together.chatId })
  log('project: a shared chat with Jordan and Sam')

  // The brand-voice chat (outside projects) shared with Priya by name (Share…); the share's check may ask once first
  let shareKey: string | undefined
  for (let i = 0; i < 3; i++) {
    const r = await p.jordan!.call(API.putChatAudience, { params: { id: voice.chatId }, body: { subjects: [{ subjectType: 'user', subjectId: 'priya' }], ...(shareKey ? { confirmKey: shareKey } : {}) } }) as { status: string; confirmKey?: string }
    if (r.status !== 'confirm') break
    shareKey = r.confirmKey
  }
  await runPrompt(p.priya!, 'Does the same rule apply to subject lines? One line.', { log, chatId: voice.chatId })
  log('jordan: the brand-voice chat shared with Priya, who asked in it')

  // A scheduled task from a template: every Monday, a summary of the week's meeting notes in Jordan's own folder
  try {
    await p.jordan!.call(API.createScheduleFromTemplate, { body: { requestId: id(), templateId: 'weekly-summary', version: 1, sourcePath: 'groups/Marketing/meetings', outputPath: 'users/jordan/weekly-summaries', time: '09:00', weekday: 1 } })
    log('jordan: a weekly scheduled task')
  } catch (e) { log(`scheduled task not made: ${(e as Error).message}`) }

  // Trina's answer in the Marketing room, sent from the room's side chat with Send to room (no note: the side chat has none)
  const side = await p.jordan!.call(API.createChat, { body: { sideRoomId: marketing.id } })
  const started = await p.jordan!.call(API.sendMessage, { params: { id: side.id }, body: { content: 'When does the November campaign start, and which channels does it use? Two lines.', attachmentIds: [], clientMessageId: id() } })
  const answerId = started.assistantMessage!.id
  for (let i = 0; i < 120; i++) {
    const m = (await p.jordan!.call(API.listMessages, { params: { id: side.id }, query: { limit: 20 } })).items.find((x) => x.id === answerId)
    if (m && m.status !== 'streaming') break
    await new Promise((r) => setTimeout(r, 2000))
  }
  // the app asks once more when a member cannot open a file the answer used: say yes, as the person would on the card
  let key: string | undefined
  for (let i = 0; i < 3; i++) {
    const r = await p.jordan!.call(API.shareAnswerToRoom, { params: { id: side.id, messageId: answerId }, body: { roomId: marketing.id, clientMessageId: id(), ...(key ? { confirmKey: key } : {}) } }) as { status?: string; confirmKey?: string }
    if (r.status !== 'confirm') break
    key = r.confirmKey
    if (i === 2) throw new Error('the answer was not sent to the room: it still asks for a confirmation')
  }
  log('marketing: Trina\'s answer sent from the side chat')
}

if (import.meta.main) {
  const i = process.argv.indexOf('--url')
  const d = process.argv.indexOf('--data')
  const url = i > 0 ? process.argv[i + 1] : undefined
  const data = d > 0 ? process.argv[d + 1] : undefined
  if (!url || !data) throw new Error('Usage: bun scripts/docs/acme-scene.ts --url http://localhost:19830 --data <the demo data folder>')
  await dress(url, fs.readFileSync(path.join(data, 'owner-password'), 'utf8').trim())
}
