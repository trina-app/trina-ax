// The tools of one turn besides the six file tools: B's remember / forget / ask_user and the browser pane tools
// (desktop window only), plus whatever other components registered in ctx.services.turnTools (C: make_file,
// share_file, artifact, web_fetch). Served over the same MCP connection as the file tools (mcp__team__<name>).
import path from 'node:path'
import { z } from 'zod'
import { AskUserInput, FILE_TOOLS, ForgetInput, RememberInput, uuidv7 } from '@mycel/shared'
import type { BrowserToolName, TurnRequest } from '@mycel/shared/api'
import type { McpContent, TurnToolSet } from '../turns'
import type { TurnTool, TurnToolContext } from '../services'
import { newId } from '../db'
import { PANE_TOOLS, scriptsOf, urlsOf } from '../realtime/browser-tools'
import { browserUrl, isPrivateHost } from '../realtime/private-net'
import { MEMORY_ITEM_MAX } from './prompt'
import { tr } from './i18n'
import type { TurnExec } from './turn'
import { extractUrls, gateUrl, type TurnPerson } from '../tools/url-gate'
import { ToolError } from '../policy/errors'

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: unknown): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }>
}

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

export const B_TOOL_DESCRIPTIONS = {
  remember: 'Remember one lasting fact or preference about the user for future chats (one short sentence, under 300 characters). Only when the user wants it kept. Returns the memory id.',
  forget: 'Forget one memory by its id (the ids are shown in the memories block of your instructions).',
  ask_user: 'Ask the user a question and wait for the answer. Offer options when you can (the user may also type an answer if allowText). Returns {"answer": ...} or {"skipped": true} when the user does not answer in time.',
} as const

export function buildToolSet(exec: TurnExec): TurnToolSet {
  const tools = new Map<string, Tool>()
  const add = (t: Tool) => {
    if (t.name in FILE_TOOLS || tools.has(t.name)) { exec.rt.log.warn('turn tool name taken, skipped', { tool: t.name }); return }
    tools.set(t.name, t)
  }
  for (const t of bTools(exec)) add(t)
  for (const t of exec.rt.ctx.services.turnTools ?? []) {
    try { if (t.available && !t.available({ userId: exec.spec.userId, chatId: exec.spec.chatId, browser: exec.browser })) continue } catch { continue }
    add(wrapRegistered(exec, t))
  }
  if (exec.browser) for (const t of PANE_TOOLS) add(browserTool(exec, t.name as BrowserToolName, t.description, t.inputSchema as unknown as Record<string, unknown>))
  return {
    list: () => [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    has: (n) => tools.has(n),
    async call(name, args) {
      const t = tools.get(name)!
      exec.noteTaint(name, args)
      if (name === 'make_file' && args && typeof args === 'object') {
        // the new file carries what the chat read, and the `source` file it is made from: asked before converting.
        // The images it embeds and its template are only known after parsing; make_file asks again for those
        // (ToolCtx.confirmWidening) before the file is placed.
        const a = args as { output?: unknown; source?: unknown }
        const refusal = typeof a.output === 'string' ? await exec.confirmWidening(a.output, typeof a.source === 'string' ? [a.source] : []) : null
        if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true, summary: 'make_file -> not allowed by the user (wider audience)' }
      }
      const out = await t.call(args)
      exec.afterTool()
      return { content: out.content, isError: out.isError, summary: out.summary ?? `${name} -> ${out.isError ? 'error' : 'ok'}` }
    },
    afterFileTool: (name, _isError, args) => { exec.noteTaint(name, args); exec.noteReads(); exec.afterTool() },
    beforeFileTool: async (name, args) => {
      if (name !== 'write' && name !== 'edit') return null
      const p = (args as { file_path?: unknown } | null)?.file_path
      return typeof p === 'string' ? exec.confirmWidening(p) : null
    },
  }
}

/** The person of this turn for tools that need a server-raised confirmation (web_fetch URLs, design tab 7). */
export function turnPerson(exec: TurnExec): TurnPerson {
  return {
    locale: exec.spec.locale,
    async confirm(question, allow, deny) {
      const answer = await exec.waitForPerson({
        kind: 'ask_user', origin: 'server', requestId: uuidv7(), question, options: [{ label: allow, value: 'allow' }, { label: deny, value: 'deny' }],
        multiple: false, allowText: false, expiresAt: new Date(Date.now() + exec.rt.askUserTimeoutMs()).toISOString(),
      } as TurnRequest, { timeoutMs: exec.rt.askUserTimeoutMs() })
      return answer === 'allow' || (Array.isArray(answer) && answer.length === 1 && answer[0] === 'allow')
    },
    *turnUrls() { for (const s of exec.steps) for (const src of s.sources ?? []) yield src.url },
  }
}

function toolContext(exec: TurnExec): TurnToolContext {
  return {
    turnId: exec.spec.turnId, chatId: exec.spec.chatId, userId: exec.spec.userId, messageId: exec.spec.assistantId, locale: exec.spec.locale,
    signal: exec.abort.signal,
    files: {
      user: exec.livePrincipal(), turnId: exec.spec.turnId, files: exec.files, person: turnPerson(exec),
      // files a tool copies bytes from (make_file's embedded images and template), checked before the new file is placed
      confirmWidening: (target, sources) => exec.confirmWidening(target, sources),
    },
  }
}

function wrapRegistered(exec: TurnExec, t: TurnTool): Tool {
  return {
    name: t.name, description: t.description, inputSchema: t.inputSchema,
    async call(args) {
      const r = await t.call(args, toolContext(exec))
      return { content: r.content, isError: r.isError, ...(r.summary ? { summary: r.summary } : {}) }
    },
  }
}

// ---------------- remember / forget / ask_user ----------------
function bTools(exec: TurnExec): Tool[] {
  const { rt, spec } = exec
  const L = spec.locale
  return [
    {
      name: 'remember', description: B_TOOL_DESCRIPTIONS.remember, inputSchema: schema(RememberInput),
      async call(args) {
        const a = RememberInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const value = a.data.text.replace(/\s+/g, ' ').trim()
        if (!value) return text('Invalid input: text is empty', true)
        if (value.length > MEMORY_ITEM_MAX) return text(`Too long (${value.length} characters). Keep a memory under ${MEMORY_ITEM_MAX} characters.`, true)
        let source: 'ai' | 'user' = 'ai'
        if (exec.tainted) {
          // this conversation has seen outside content: the person confirms before anything is kept (tab 3)
          const answer = await exec.waitForPerson({
            kind: 'ask_user', origin: 'server', requestId: uuidv7(), question: tr('rememberConfirm', L, { text: value }),
            options: [{ label: tr('yes', L), value: 'yes' }, { label: tr('no', L), value: 'no' }], multiple: false, allowText: false,
          } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs() })
          if (answer !== 'yes' && !(Array.isArray(answer) && answer[0] === 'yes')) {
            exec.patchToolStep('remember', () => ({ label: tr('notRemembered', L, { text: value }).slice(0, 500), detail: tr('notAnswered', L) }))
            return { ...text('The user did not confirm, so nothing was remembered. Do not try again unless the user asks.'), summary: 'remember -> not confirmed' }
          }
          source = 'user'
        }
        const id = newId()
        rt.db.query('INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, spec.userId, value, spec.chatId, source, spec.turnId, new Date().toISOString())
        const row = rt.db.query('SELECT id, text, source_chat_id, created_at FROM memories WHERE id = ?').get(id) as { id: string; text: string; source_chat_id: string | null; created_at: string }
        rt.hub.publish(spec.userId, { type: 'memory.changed', data: { change: 'created', memory: rt.store.toMemory(row) } })
        exec.patchToolStep('remember', () => ({ label: tr('remembered', L, { text: value }).slice(0, 500), detail: `memory:${id}` }))
        return { ...text(JSON.stringify({ id })), summary: `remember -> ${id} (${source})` }
      },
    },
    {
      name: 'forget', description: B_TOOL_DESCRIPTIONS.forget, inputSchema: schema(ForgetInput),
      async call(args) {
        const a = ForgetInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const r = rt.db.query('DELETE FROM memories WHERE id = ? AND user_id = ?').run(a.data.id, spec.userId)
        if (!r.changes) return text(`No memory with id ${a.data.id}.`, true)
        rt.hub.publish(spec.userId, { type: 'memory.changed', data: { change: 'deleted', memory: null } })
        return { ...text(JSON.stringify({ ok: true })), summary: `forget -> ${a.data.id}` }
      },
    },
    {
      name: 'ask_user', description: B_TOOL_DESCRIPTIONS.ask_user, inputSchema: schema(AskUserInput),
      async call(args) {
        const a = AskUserInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const request: TurnRequest = {
          kind: 'ask_user', requestId: uuidv7(), question: a.data.question,
          ...(a.data.options ? { options: a.data.options } : {}), ...(a.data.multiple !== undefined ? { multiple: a.data.multiple } : {}),
          ...(a.data.allowText !== undefined ? { allowText: a.data.allowText } : {}),
          expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
        }
        const answer = await exec.waitForPerson(request, { timeoutMs: rt.askUserTimeoutMs() })
        if (answer === null || answer === undefined) {
          exec.patchToolStep('ask_user', () => ({ detail: tr('notAnswered', L) }))
          return { ...text(JSON.stringify({ skipped: true })), summary: 'ask_user -> skipped' }
        }
        exec.patchToolStep('ask_user', () => ({ detail: (Array.isArray(answer) ? answer.join(', ') : String(answer)).slice(0, 4000) }))
        return { ...text(JSON.stringify({ answer })), summary: 'ask_user -> answered' }
      },
    },
  ]
}

// ---------------- browser pane tools ----------------
// Every address the AI opens in the pane goes through the same rules as web_fetch (design tab 7 "프롬프트 주입":
// a GET can carry data out in its address, https://attacker/?d=<secret>): an address that never appeared in the
// conversation, or one with a long query, needs the person to confirm the full URL first, on a card the server raises
// (tools/url-gate.ts). Office-network addresses additionally need the site card below. Addresses written out in code
// the AI runs in the page (javascript_tool) are checked the same way. Links on pages the pane showed are NOT added to
// the "seen" addresses (unlike web_fetch): the AI can put anything on a page it drives (form_input, javascript_tool)
// and read it back, which would launder an address of its own making.
function browserTool(exec: TurnExec, name: BrowserToolName, description: string, inputSchema: Record<string, unknown>): Tool {
  const { rt, spec } = exec
  return {
    name, description, inputSchema,
    async call(rawArgs) {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>
      const person = turnPerson(exec)
      /** null when the address may be opened; otherwise the refusal for the AI */
      const gate = async (href: string): Promise<string | null> => {
        try {
          await gateUrl(rt.db, spec.chatId, href, person)
          return null
        } catch (e) {
          if (e instanceof ToolError) return e.message
          throw e
        }
      }
      for (const url of urlsOf(name, args)) {
        const u = browserUrl(url)
        if (!u.ok) return { ...text(`Cannot open ${url.slice(0, 200)}: ${u.reason}.`, true), summary: `${name} -> refused url (${u.reason})` }
        const host = u.host
        if (!host || !u.href) continue
        // the office-network card shows the full address (up to 2000 characters): no second card for it
        let shownInFull = false
        if (await isPrivateHost(host) && !(exec.allowedHosts.has(host) || rt.siteGranted(spec.userId, host))) {
          const decision = await exec.waitForPerson({ kind: 'browser_site', requestId: uuidv7(), url: url.slice(0, 2000), host, reason: tr('browserSite', spec.locale, { host }) }, { window: spec.windowId, timeoutMs: rt.askUserTimeoutMs() })
          if (decision === 'always') rt.grantSite(spec.userId, host)
          else if (decision === 'once') exec.allowedHosts.add(host)
          else return { ...text(`The user did not allow opening ${host} (an office-network address). Stop and tell the user what you could not do.`, true), summary: `${name} -> site ${host} not allowed` }
          shownInFull = url.length <= 2000
        }
        if (shownInFull) continue
        const refusal = await gate(u.href)
        if (refusal) return { ...text(`Cannot open ${u.href.slice(0, 200)}: ${refusal}.`, true), summary: `${name} -> ${u.href.slice(0, 300)} not allowed (address check)` }
      }
      for (const code of scriptsOf(name, args)) {
        for (const href of new Set(extractUrls(code))) {
          const refusal = await gate(href)
          if (refusal) return { ...text(`The script was not run: it contains the address ${href.slice(0, 200)}, and ${refusal}.`, true), summary: `${name} -> script address ${href.slice(0, 300)} not allowed (address check)` }
        }
      }
      const r = await rt.relay.call({ userId: spec.userId, windowId: spec.windowId!, turnId: spec.turnId, chatId: spec.chatId, tool: name, args, signal: exec.abort.signal })
      const content: McpContent[] = []
      const shared: { path: string; alt?: string }[] = []
      for (const c of r.content) {
        if (c.type === 'text') content.push({ type: 'text', text: c.text })
        else {
          content.push({ type: 'image', data: c.data, mimeType: c.mime })
          if (c.shareToChat) { const p = saveScreenshot(exec, c.data, c.mime); if (p) shared.push({ path: p, alt: 'screenshot' }) }
        }
      }
      if (!r.ok) content.push({ type: 'text', text: `Error: ${r.error ?? 'browser tool failed'}` })
      exec.patchToolStep(name, (s) => (shared.length ? { images: [...(s.images ?? []), ...shared] } : {}))
      if (!content.length) content.push({ type: 'text', text: r.ok ? 'OK' : 'Error' })
      return { content, isError: !r.ok, summary: `${name} -> ${r.ok ? 'ok' : 'error: ' + (r.error ?? '').slice(0, 200)}` }
    },
  }
}

/** Screenshots the AI chose to show: saved in the person's chat attachment folder, shown under the step. */
function saveScreenshot(exec: TurnExec, b64: string, mime: string): string | null {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const rel = path.posix.join('users', exec.spec.userId, '.attachments', exec.spec.chatId, `screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`)
  try {
    exec.rt.files.writeBytes({ user: exec.livePrincipal(), turnId: exec.spec.turnId, files: exec.files }, rel, Buffer.from(b64, 'base64'), new Map(), 'human')
    return rel
  } catch (e) {
    exec.rt.log.warn('saving a shared screenshot failed', { err: e })
    return null
  }
}
