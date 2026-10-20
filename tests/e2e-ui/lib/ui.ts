// Small helpers over the real web app (Korean UI, the product default): sign in, start a chat with an engine,
// wait for answers, read things back through the same REST API the page uses.
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { countEngineCall, type Account } from './dev'

export async function signIn(page: Page, base: string, who: Account) {
  await page.goto(`${base}/login`)
  await page.getByTestId('login-username').fill(who.username)
  await page.getByTestId('login-password').fill(who.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 20_000 })
}

/** GET/POST through the page's cookie session with the CSRF header the app sends. */
export async function api<T = any>(req: APIRequestContext, base: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const r = await req.fetch(`${base}${path}`, { method, headers: { [CSRF_HEADER]: '1', origin: base }, ...(data !== undefined ? { data } : {}) })
  const text = await r.text()
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${text.slice(0, 400)}`)
  return (text ? JSON.parse(text) : undefined) as T
}

export const lastAnswer = (page: Page): Locator => page.getByTestId('assistant-message').last()

/** Pick the engine in the composer (the menu lists 'Claude' and 'Codex' with "default model"). */
export async function pickEngine(page: Page, engine: 'Claude' | 'Codex') {
  await page.getByTestId('engine-picker').click()
  await page.getByRole('listbox').getByRole('option', { name: new RegExp(`^${engine}\\b`) }).first().click()
  await expect(page.getByTestId('engine-picker')).toContainText(engine)
}

/** id of the last answer on screen (null when there is none): pass it to waitAnswer after starting a new one. */
export async function lastAnswerId(page: Page): Promise<string | null> {
  const n = await page.getByTestId('assistant-message').count()
  return n ? lastAnswer(page).getAttribute('data-message-id') : null
}

/** Type a prompt and send it (counts one real engine call). Returns the id of the answer before it. */
export async function send(page: Page, text: string, engine: 'claude' | 'codex' = 'claude'): Promise<string | null> {
  const prev = await lastAnswerId(page)
  countEngineCall(engine)
  const box = page.getByTestId('composer-input')
  await box.fill(text)
  await page.getByTestId('send').click()
  return prev
}

/** Start a new chat from the home screen; returns the chat id once the URL has it. */
export async function newChat(page: Page, base: string, text: string, engine: 'Claude' | 'Codex' = 'Claude'): Promise<string> {
  await page.goto(`${base}/`)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await pickEngine(page, engine)
  await send(page, text, engine === 'Claude' ? 'claude' : 'codex')
  await page.waitForURL(/\/c\/[0-9a-f-]{36}/, { timeout: 30_000 })
  return /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!
}

/**
 * Wait for a new last answer (its id differs from `prev`, the id before the action that started it) to leave
 * 'streaming'; returns its final status.
 */
export async function waitAnswer(page: Page, prev: string | null, timeout = 240_000): Promise<string> {
  const a = lastAnswer(page)
  await expect(a).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => {
    const id = await a.getAttribute('data-message-id')
    return id !== prev && (await a.getAttribute('data-status')) !== 'streaming' && !(await a.getAttribute('data-message-id'))?.startsWith('local')
  }, { timeout, intervals: [250] }).toBe(true)
  return (await a.getAttribute('data-status')) ?? ''
}

/** Messages of the visible branch, from the server (the truth the screen must match). */
export async function serverMessages(req: APIRequestContext, base: string, chatId: string): Promise<{ id: string; role: string; content: string; status: string }[]> {
  const r = await api<{ items: { id: string; role: string; content: string; status: string }[] }>(req, base, 'GET', `/api/chats/${chatId}/messages?limit=100`)
  return r.items
}

/** Normalise rendered markdown text vs. stored markdown for loose comparisons. */
export const words = (s: string) => s.replace(/[`*_#>|\-\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()

export interface WsEvent { type: string; seq?: number; data?: any }

/** Every JSON frame the page receives on its WebSockets (the realtime protocol of shared/src/api/ws.ts). */
export function recordWs(page: Page): { events: WsEvent[]; sockets: number; closes: number } {
  const rec = { events: [] as WsEvent[], sockets: 0, closes: 0 }
  page.on('websocket', (ws) => {
    rec.sockets++
    ws.on('close', () => rec.closes++)
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') return
      try { rec.events.push(JSON.parse(f.payload)) } catch {}
    })
  })
  return rec
}

/** message.delta events for one answer, in arrival order. */
export const deltasOf = (rec: { events: WsEvent[] }, messageId: string) => rec.events.filter((e) => e.type === 'message.delta' && e.data?.messageId === messageId)

/** id of the last assistant message of a chat (server truth). */
export async function lastAssistantId(req: APIRequestContext, base: string, chatId: string): Promise<string> {
  const ms = await serverMessages(req, base, chatId)
  return ms.filter((m) => m.role === 'assistant').at(-1)!.id
}
