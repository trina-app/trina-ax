import { API, ApiClient } from '@mycel/shared/api'
import { PASSWORD } from './fixture/seed'
const BASE = 'http://127.0.0.1:19881'
const r = await new ApiClient({ baseUrl: BASE }).call(API.login, { body: { username: 'junho', password: PASSWORD, client: 'web', tokenMode: 'bearer' } })
const api = new ApiClient({ baseUrl: BASE, token: r.token! })
const chat = await api.call(API.createChat, { body: { engine: 'claude-code', model: 'sonnet' } as never })
const sent = await api.call(API.sendMessage, { params: { id: chat.id }, body: { content: process.argv[2]!, attachmentIds: [], clientMessageId: crypto.randomUUID() } })
for (let i = 0; i < 150; i++) { await Bun.sleep(2000); const m = (await api.call(API.listMessages, { params: { id: chat.id }, query: { limit: 10 } })).items.find((x) => x.id === sent.assistantMessage.id); if (m && m.status !== 'streaming') { console.log(m.content.slice(0, 1500)); console.log(JSON.stringify(m.steps.map((s) => s.label))); break } }
