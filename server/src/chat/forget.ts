// What a permanently deleted chat leaves outside the DB (linux-runtime L18): the engine session stash (the server's,
// <data>/sessions/<chatId>) and the engine's working folder <agent root>/<chatId>. In production that folder belongs to
// the engine account (700): the server cannot remove it, so it asks the launcher (op `forget`, native/cmd/mycel-launcher
// /ops.go). Dev and office mode run the engine as the server's own user: the folder is removed directly as before.
//
// Called only after the chat's rows are gone (ChatRuntime.purgeTrash: the trash past its retention; auth/sweeper.ts:
// the chats of an account deleted past the retention). A chat that still exists, in the trash or not, is never
// forgotten. Best effort: a failed or unanswered forget never blocks the purge. The ids that did not go are kept in
// the settings key `chat.forgetPending` (at most 500) and tried again with every hourly purge run and once shortly
// after start; the launcher's own daily sweep removes chat folders nobody used for 30 days, so what falls off the
// list still goes.
import fs from 'node:fs'
import path from 'node:path'
import type { AppContext } from '../context'
import { getSetting, setSetting } from '../admin/settings'
import { launcherForget } from '../native'

export const FORGET_PENDING_KEY = 'chat.forgetPending'
export const MAX_FORGET_PENDING = 500
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The launcher that owns the engine folders: engine.launcherSock, else the production path; null in dev (the server
 * started its own launcher as its own user and removes the folders itself). */
export function launcherSockOf(ctx: AppContext): string | null {
  if (ctx.config.engine.launcherSock) return ctx.config.engine.launcherSock
  return ctx.config.mode === 'prod' ? path.join(ctx.engineConfig.runDir, 'launcher.sock') : null
}

/** Forget function (tests replace it). */
let forgetOne: (sock: string, chatId: string) => Promise<{ ok: boolean; message?: string }> = launcherForget
export function setLauncherForgetForTests(f: typeof forgetOne | null) { forgetOne = f ?? launcherForget }

const pending = (ctx: AppContext): string[] => {
  const v = getSetting<unknown>(ctx.db, FORGET_PENDING_KEY)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && CHAT_ID_RE.test(x)) : []
}
const savePending = (ctx: AppContext, ids: string[]) => setSetting(ctx.db, FORGET_PENDING_KEY, [...new Set(ids)].slice(-MAX_FORGET_PENDING))
const chatExists = (ctx: AppContext, id: string) => !!ctx.db.query('SELECT 1 FROM chats WHERE id = ?').get(id)

/** Remove what the purged chats left outside the DB. Never throws; the promise ends when the launcher answered (or
 * the ids were put on the retry list). */
export function forgetPurgedChats(ctx: AppContext, chatIds: string[]): Promise<void> {
  const ids = chatIds.filter((id) => CHAT_ID_RE.test(id) && !chatExists(ctx, id))
  for (const id of ids) {
    try { fs.rmSync(path.join(ctx.config.dataDir, 'sessions', id), { recursive: true, force: true }) } catch (e) { ctx.log.warn('chat session stash not removed', { chat: id, err: e }) }
    // dev / office: the engine runs as this user. Production: EACCES here, the launcher removes it below.
    try { fs.rmSync(path.join(ctx.engineConfig.agentRoot, id), { recursive: true, force: true }) } catch {}
  }
  const sock = launcherSockOf(ctx)
  if (!sock || !ids.length) return Promise.resolve()
  return forgetThroughLauncher(ctx, sock, ids)
}

/** The ids a launcher did not take earlier, again (hourly with the purge, and once after start). */
export function retryPendingForgets(ctx: AppContext): Promise<void> {
  const sock = launcherSockOf(ctx)
  const ids = pending(ctx).filter((id) => !chatExists(ctx, id))
  if (!sock || !ids.length) return Promise.resolve()
  return forgetThroughLauncher(ctx, sock, ids)
}

async function forgetThroughLauncher(ctx: AppContext, sock: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!
    let r: { ok: boolean; message?: string }
    try { r = await forgetOne(sock, id) } catch (e) { r = { ok: false, message: String((e as Error)?.message ?? e) } }
    // each step reads and writes the list at once (no await in between): parallel runs cannot lose an id
    if (r.ok || /bad chat id/.test(r.message ?? '')) {
      savePending(ctx, pending(ctx).filter((x) => x !== id))
      continue
    }
    ctx.log.warn('launcher did not forget a deleted chat; tried again later', { chat: id, message: r.message })
    // the launcher is down: keep this one and the rest for later instead of waiting for each in turn
    const rest = /unreachable|closed|ECONNREFUSED|ENOENT|timeout/i.test(r.message ?? '') ? ids.slice(i) : [id]
    savePending(ctx, [...pending(ctx), ...rest])
    if (rest.length > 1) return
  }
}
