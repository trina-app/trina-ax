// One prompt in a new chat, run to the end through the public REST API, as the person the client is signed in as.
// Used by record.ts (the real AI) and by the seed of the demo's past chats (replays). The server's own safety cards
// (saving a scheduled task, say) are answered with the option that goes ahead, as the person would on the card; a
// question the AI itself asks is skipped (the scenarios are written so it has none).
import crypto from 'node:crypto'
import { API, type ApiClient, type Message, type OpenTurnRequest } from '../../../shared/src/api'

/** the option of a server card that goes ahead (make, save, allow …), else the first */
export function goAhead(options: { label: string; value: string }[]): string | null {
  if (!options.length) return null
  const yes = options.find((o) => /만들|저장|허용|예약|확인|계속|진행|예\b|allow|create|save|yes|ok|confirm/i.test(`${o.label} ${o.value}`))
  return (yes ?? options[0]!).value
}

export interface RunResult { chatId: string; message: Message; cards: string[] }

export async function runPrompt(api: ApiClient, prompt: string, o: { timeoutMs?: number; log?: (s: string) => void; pollMs?: number } = {}): Promise<RunResult> {
  const chat = await api.call(API.createChat, { body: {} })
  const started = await api.call(API.sendMessage, { params: { id: chat.id }, body: { content: prompt, attachmentIds: [], clientMessageId: crypto.randomUUID() } })
  const id = started.assistantMessage.id
  const until = Date.now() + (o.timeoutMs ?? 15 * 60_000)
  const answered = new Set<string>()
  const cards: string[] = []
  while (Date.now() < until) {
    await Bun.sleep(o.pollMs ?? 1500)
    const open = (await api.call(API.listTurnRequests, { params: { id: chat.id } })).items as OpenTurnRequest[]
    for (const r of open) {
      const req = r.request
      if (answered.has(req.requestId) || req.kind !== 'ask_user') continue
      answered.add(req.requestId)
      const answer = req.origin === 'server' ? goAhead(req.options ?? []) : null
      cards.push(`${req.origin === 'server' ? 'server' : 'ai'}: ${req.question.slice(0, 120)} -> ${answer ?? 'skipped'}`)
      o.log?.(`card in ${chat.id}: ${req.question.slice(0, 80)} -> ${answer ?? 'skipped'}`)
      await api.call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: req.requestId, answer } })
    }
    const page = await api.call(API.listMessages, { params: { id: chat.id }, query: { limit: 50 } })
    const m = page.items.find((x) => x.id === id)
    if (m && m.status !== 'streaming') return { chatId: chat.id, message: m, cards }
  }
  throw new Error(`no answer within the time limit for: ${prompt.slice(0, 60)}`)
}
