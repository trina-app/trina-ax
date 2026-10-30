// A scripted stand-in for the Anthropic Messages API (api.anthropic.com) for runs of the REAL Claude Code binary:
// nothing leaves the machine and nothing is spent. Every request is recorded (model, tool names, system text, the
// first and last user message), and each is answered from a script by kind and round:
//   kind   'main'  the parent session (its system prompt holds `mainMarker`)
//          'child' a sub-agent (its first user message, the Agent prompt, holds a CHILD-<n> marker)
//          'other' anything else Claude Code asks (titles, summaries ...): a short text
//   round  the number of assistant messages already in the request (0 = the first request of that conversation)
// A reply is text, tool calls (tool_use blocks), an HTTP error or a refusal. Used by tests/engine/lockdown-claude-subagents.ts.

export type FakeReply =
  | { text: string }
  | { tools: { name: string; input: Record<string, unknown>; id?: string }[]; text?: string }
  | { status: number; error: string }
  | { refusal: true }

export interface FakeRequest {
  at: number
  path: string
  kind: 'main' | 'child' | 'other'
  /** CHILD-<n> of a child request */
  child: string | null
  round: number
  model: string
  tools: string[]
  /** server tools (type web_search_*) */
  serverTools: string[]
  system: string
  firstUser: string
  lastUser: unknown
  headers: Record<string, string>
}

export interface FakeScript {
  mainMarker: string
  reply(r: FakeRequest): FakeReply
}

const blockText = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'tool_result' ? blockText(b.content) : '')).join('\n') : ''

export function startFakeAnthropic(script: FakeScript, o: { port?: number } = {}) {
  const seen: FakeRequest[] = []
  let ids = 0
  const enc = new TextEncoder()
  const ev = (type: string, d: Record<string, unknown>) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`)
  const server = Bun.serve({
    port: o.port ?? 0, hostname: '127.0.0.1', idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url)
      let body: any = {}
      try { body = JSON.parse(await req.text()) } catch {}
      if (u.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 42 })
      const messages: any[] = Array.isArray(body.messages) ? body.messages : []
      const system = blockText(body.system)
      const firstUser = blockText(messages.find((m) => m?.role === 'user')?.content)
      const child = /CHILD-\d+/.exec(firstUser)?.[0] ?? null
      const kind: FakeRequest['kind'] = child ? 'child' : system.includes(script.mainMarker) ? 'main' : 'other'
      const tools = (body.tools ?? []) as any[]
      const r: FakeRequest = {
        at: Date.now(), path: u.pathname, kind, child, round: messages.filter((m) => m?.role === 'assistant').length,
        model: String(body.model ?? ''), tools: tools.filter((t) => !t?.type || t.type === 'custom').map((t) => String(t.name)),
        serverTools: tools.filter((t) => t?.type && t.type !== 'custom').map((t) => `${t.type}:${t.name}`),
        system, firstUser, lastUser: messages.at(-1)?.content, headers: Object.fromEntries(req.headers),
      }
      seen.push(r)
      const reply: FakeReply = kind === 'other' ? { text: 'ok' } : script.reply(r)
      if ('status' in reply) return Response.json({ type: 'error', error: { type: reply.status === 429 ? 'rate_limit_error' : 'api_error', message: reply.error } }, { status: reply.status })
      const model = r.model || 'claude-sonnet-4-5'
      const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      const msgId = `msg_fake_${++ids}`
      const blocks: any[] = []
      if ('refusal' in reply) blocks.push({ type: 'text', text: '' })
      else {
        if (reply.text) blocks.push({ type: 'text', text: reply.text })
        if ('tools' in reply) for (const t of reply.tools) blocks.push({ type: 'tool_use', id: t.id ?? `toolu_fake_${++ids}`, name: t.name, input: t.input })
      }
      const stop = 'refusal' in reply ? 'refusal' : blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
      if (!body.stream) return Response.json({ id: msgId, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stop, stop_sequence: null, usage })
      return new Response(new ReadableStream({
        start(ctl) {
          ctl.enqueue(ev('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
          blocks.forEach((b, index) => {
            if (b.type === 'text') {
              ctl.enqueue(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }))
              for (const part of b.text.match(/[\s\S]{1,16}/g) ?? []) ctl.enqueue(ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } }))
            } else {
              ctl.enqueue(ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }))
              ctl.enqueue(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }))
            }
            ctl.enqueue(ev('content_block_stop', { index }))
          })
          ctl.enqueue(ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }))
          ctl.enqueue(ev('message_stop', {}))
          ctl.close()
        },
      }), { headers: { 'content-type': 'text/event-stream', 'request-id': `req_fake_${ids}` } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, port: server.port, seen, stop: () => server.stop(true) }
}
