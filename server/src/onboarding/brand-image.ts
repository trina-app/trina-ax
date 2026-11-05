// brand_image: one brand photo for the welcome steps' first result, made with Higgsfield on Trina's image key
// (docs/DECISIONS.md "N — The first result is the company's card news"). Only when the website gave the card news too
// few usable pictures; never in an ordinary chat:
//   - offered only in a chat the first result started (onboarding_result_chats), only to that chat's owner, only while
//     the team has photos left (BRAND_IMAGES_PER_TEAM, counted over the team's whole life, rows that did not fail), and
//     only when the server has the key: the hosting service's (credentials/hosted-image.ts, tenant command
//     hosted-image-key-set) or, on a development or own server, <data>/secrets/higgsfield-onboarding.key;
//   - a row is written before the request goes out (one synchronous step with the count), so two calls at once cannot
//     both take the last photo; a failed request gives its photo back;
//   - the model is the cheapest one that kept to "no people, no text" in our test (z_image, 0.15 credits a picture,
//     2048 px; Soul 2.0 at 0.12 put words on a laptop screen, Soul Location a person); the server adds those rules to
//     every prompt; no reference images, nothing from the team's files is sent, only the AI's English description;
//   - the result is fetched over https with the hardened download (tools/download.ts: public addresses, pinned, size
//     cap), made into a 1,600 px JPEG (isolated ffmpeg) and saved into the team's brand images folder as a file the
//     turn produced (placeProduced: folder rules, version history, the turn's limits).
// No card asks the person first (unlike generate_video, whose credits are the team's): the photos are Trina's, capped
// per team, and a card in the middle of the first result would only stop it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { newId } from '../db'
import { ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import { placeProduced } from '../tools/make-file'
import { downloadToFile } from '../tools/download'
import { egressOf } from '../tools/egress'
import { toolRegistry } from '../tools/registry'
import { credentialsOf } from '../credentials/store'
import { readHostedImageKey, type HiggsfieldToken } from '../credentials/hosted-image'
import { downsize, imageKind } from './brand-assets'
import { resultChatOf } from './welcome-result'
import { imageSize } from '../uploads/image'

export const BRAND_IMAGE_TOOL = 'brand_image'
/** Brand photos a team may get from the welcome steps, in all. */
export const BRAND_IMAGES_PER_TEAM = 4
export const HIGGSFIELD_DEV_API = 'https://fnf-api-gw.higgsfield.ai/fnf'
/** testing only: a local stand-in for the API */
const apiBase = () => process.env.MYCEL_HIGGSFIELD_ONBOARDING_API ?? HIGGSFIELD_DEV_API
/** Z Image (Tongyi-MAI): 0.15 credits a picture on 2026-11-05, the cheapest that kept to the rules in our test */
export const BRAND_IMAGE_MODEL = 'z_image'
export const BRAND_IMAGE_CREDITS = 0.15
const POLL_MS = 2500
const WAIT_MAX_MS = 4 * 60_000
const DOWNLOAD_MAX = 30 * 1024 * 1024
/** what every prompt ends with: the photo is a background for text panels, never a person or a sign */
export const PROMPT_RULES = 'Photorealistic, premium editorial photography, natural light, clean composition with calm empty space. No people, no faces, no hands, no text, no letters, no numbers, no logos, no signage, no watermarks, no screens showing text.'

export const BrandImageInput = z.object({
  prompt: z.string().min(20).max(1200).describe('The photo in English: the scene and subject for this card\'s message, the setting, light, and the brand colours as accents. Never people or text.'),
  aspect_ratio: z.enum(['1:1', '4:3', '3:4', '16:9']).default('1:1').describe('1:1 for a full card or a half card; 4:3 or 16:9 for a wide strip'),
  name: z.string().min(1).max(60).optional().describe('A short file name without extension, in the team language (e.g. "공장-에너지")'),
})

/** The image key: the hosting service's first, else the development or own server's file. */
export function brandImageKey(ctx: AppContext): HiggsfieldToken | null {
  try {
    const hosted = readHostedImageKey(credentialsOf(ctx))
    if (hosted) return hosted
  } catch { /* no vault: the file below */ }
  try {
    const raw = fs.readFileSync(path.join(ctx.engineConfig.dataDir, 'secrets', 'higgsfield-onboarding.key'), 'utf8')
    const v = JSON.parse(raw) as { token?: unknown; workspace?: unknown }
    return typeof v.token === 'string' && v.token && typeof v.workspace === 'string' && v.workspace ? { token: v.token.trim(), workspace: v.workspace.trim() } : null
  } catch { return null }
}

/** Photos the team has used (made, or being made now). */
export function brandImagesUsed(db: AppContext['db']): number {
  try { return (db.query("SELECT count(*) AS n FROM onboarding_images WHERE status != 'failed'").get() as { n: number }).n } catch { return BRAND_IMAGES_PER_TEAM }
}

type Job = { id?: string; status?: string; result_url?: string | null; detail?: unknown }

/** A failure the service will not charge for: it refused the request or said the job failed. Its photo is given back;
 * any other failure after the service took the job (stopped, timed out, the download or the save failed) keeps it:
 * the job may still finish and be charged. */
export class NotCharged extends ToolError {}
/** Each request to the service gives up after this long (the poll as a whole: WAIT_MAX_MS). */
const REQUEST_MS = 30_000
const withTimeout = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS))

/** Submit one picture and wait for it: the result's address. */
export async function runBrandImage(o: { key: HiggsfieldToken; prompt: string; aspect: string; fetchFn?: typeof fetch; pollMs?: number; waitMaxMs?: number; signal?: AbortSignal }): Promise<{ jobId: string; url: string }> {
  const f = o.fetchFn ?? fetch
  const headers = { Authorization: `Bearer ${o.key.token}`, 'hf-workspace-id': o.key.workspace, 'Content-Type': 'application/json', Accept: 'application/json' }
  let sub: Response
  // no answer to the submit: the service may still have taken it, so it is not given back (a ToolError, not NotCharged)
  try { sub = await f(`${apiBase()}/developer/v2alpha/images/${BRAND_IMAGE_MODEL}/generations`, { method: 'POST', headers, body: JSON.stringify({ params: { prompt: o.prompt, aspect_ratio: o.aspect } }), signal: withTimeout(o.signal) }) } catch { throw new ToolError('the photo service did not answer; make the card without a new photo') }
  const first = await sub.json().catch(() => ({})) as Job
  if (!sub.ok) throw new NotCharged(`the photo service refused the request (HTTP ${sub.status}${sub.status === 401 || sub.status === 403 ? ': the image key is not valid any more' : ''}); make the card without a new photo`)
  const id = first.id
  if (!id) throw new NotCharged('the photo service did not return a job id; make the card without a new photo')
  const until = Date.now() + (o.waitMaxMs ?? WAIT_MAX_MS)
  for (;;) {
    // a local stand-in for the API (tests) answers at once
    await new Promise((r) => setTimeout(r, o.pollMs ?? (process.env.MYCEL_HIGGSFIELD_ONBOARDING_API ? 50 : POLL_MS)))
    if (o.signal?.aborted) throw new ToolError('stopped')
    let s: Job = {}
    try { s = await (await f(`${apiBase()}/developer/v2alpha/jobs/${encodeURIComponent(id)}`, { headers, signal: withTimeout(o.signal) })).json().catch(() => ({})) as Job } catch { /* asked again next round */ }
    if (s.status === 'completed' && s.result_url) return { jobId: id, url: s.result_url }
    if (s.status && ['failed', 'nsfw', 'canceled', 'cancelled'].includes(s.status)) throw new NotCharged(`the photo could not be made (${s.status}, not charged); change the description or make the card without it`)
    if (Date.now() > until) throw new ToolError('the photo was not ready in time; make the card without it')
  }
}

const slug = (s: string) => s.normalize('NFC').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 50) || 'brand-photo'

/** The chat of a turn, the chat's first-result marking, and whether it is the caller's. */
function markedChat(ctx: AppContext, t: Pick<ToolCtx, 'turnId' | 'user'>): { chatId: string; imagesFolder: string } {
  const turn = t.turnId ? ctx.db.query('SELECT chat_id, user_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string; user_id: string } | null : null
  const mark = turn ? resultChatOf(ctx.db, turn.chat_id) : null
  if (!turn || !mark || mark.userId !== t.user.id || turn.user_id !== t.user.id) throw new ToolError('brand_image only works in the welcome steps\' first result')
  return { chatId: turn.chat_id, imagesFolder: mark.imagesFolder }
}

export async function makeBrandImage(ctx: AppContext, a: z.output<typeof BrandImageInput>, t: ToolCtx): Promise<{ text: string; summary: string; structured: Record<string, unknown> }> {
  const { chatId, imagesFolder } = markedChat(ctx, t)
  const key = brandImageKey(ctx)
  if (!key) throw new ToolError('no image key on this server; make the cards with the pictures there are')
  // the count and the reservation in one synchronous step
  const id = newId()
  const reserved = ctx.db.transaction(() => {
    if (brandImagesUsed(ctx.db) >= BRAND_IMAGES_PER_TEAM) return false
    ctx.db.query("INSERT INTO onboarding_images (id, chat_id, user_id, status, model, prompt, created_at) VALUES (?,?,?,'running',?,?,?)")
      .run(id, chatId, t.user.id, BRAND_IMAGE_MODEL, a.prompt.slice(0, 300), new Date().toISOString())
    return true
  })()
  if (!reserved) throw new ToolError(`this team's ${BRAND_IMAGES_PER_TEAM} brand photos are used; make the cards with the pictures there are`)
  const end = (status: 'done' | 'failed' | 'lost', p: string | null = null) => ctx.db.query('UPDATE onboarding_images SET status = ?, path = ?, credits = ?, ended_at = ? WHERE id = ?')
    .run(status, p, status === 'failed' ? null : BRAND_IMAGE_CREDITS, new Date().toISOString(), id)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-brand-'))
  try {
    const prompt = `${a.prompt.trim().replace(/\s+/g, ' ')} ${PROMPT_RULES}`
    const r = await runBrandImage({ key, prompt, aspect: a.aspect_ratio, signal: t.signal })
    const tmp = path.join(work, 'photo')
    const test = !!process.env.MYCEL_HIGGSFIELD_ONBOARDING_API
    await downloadToFile(r.url, tmp, { httpsOnly: !test, maxBytes: DOWNLOAD_MAX, blockedIps: () => egressOf(ctx).ips, signal: t.signal, ...(test ? { testAllow: () => true } : {}) })
    const bytes = fs.readFileSync(tmp)
    const kind = imageKind(bytes)
    const size = kind ? imageSize(bytes) : null
    if (!kind || !size) throw new ToolError('the photo service sent something that is not a picture; make the card without it')
    const small = await downsize({ bytes, ext: kind, width: size.width, height: size.height })
    const out = path.join(work, small ? 'photo.jpg' : `photo.${kind}`)
    fs.writeFileSync(out, small?.bytes ?? bytes)
    const name = `${slug(a.name ?? 'brand-photo')}.${small ? 'jpg' : kind}`
    const made = await placeProduced(ctx, componentC(ctx).files, t, [...imagesFolder.split('/').filter(Boolean), name], out, BRAND_IMAGE_TOOL)
    end('done', made.path)
    const used = brandImagesUsed(ctx.db)
    const dims = small ? `${small.width}×${small.height}` : `${size.width}×${size.height}`
    return {
      text: `Saved the brand photo: ${made.path} (${dims}). Use it with <img src="/${made.path}">. ${used} of ${BRAND_IMAGES_PER_TEAM} brand photos of this team are used.`,
      summary: `${BRAND_IMAGE_TOOL} -> ${made.path} (${BRAND_IMAGE_MODEL}, job ${r.jobId})`,
      structured: { path: made.path, jobId: r.jobId, used },
    }
  } catch (e) {
    // given back only when the service will not charge it; anything else after it took the job still counts, or a
    // loop of stop and send again would buy photos without end
    end(e instanceof NotCharged ? 'failed' : 'lost')
    throw e
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** Registered on every server; offered to a turn only in a first-result chat of its person, with the key and photos
 * left (the listing is decided when the turn starts; every call checks again). */
export function registerBrandImage(ctx: AppContext): void {
  const reg = toolRegistry(ctx.files)
  if (reg.has(BRAND_IMAGE_TOOL)) return
  reg.register({
    name: BRAND_IMAGE_TOOL,
    description: `Make one brand photo for the welcome card news (only in this chat; at most ${BRAND_IMAGES_PER_TEAM} for the team in all) and save it in the team's brand images folder. ` +
      'Use it only when the brand folder has fewer than 3 usable photos. Write the prompt in English: the scene for one card\'s message, its setting and light, with the brand colours as accents. ' +
      'Never people, faces, hands, text, numbers or logos (the server adds these rules). Takes about half a minute.',
    input: BrandImageInput,
    describe: (a) => `${BRAND_IMAGE_TOOL} ${a.aspect_ratio}`,
    run: (a, t) => makeBrandImage(ctx, a, t),
  })
  ;(ctx.services.turnTools ??= []).push({
    name: BRAND_IMAGE_TOOL,
    get description() { return reg.describeTool(BRAND_IMAGE_TOOL)!.description },
    get inputSchema() { return reg.describeTool(BRAND_IMAGE_TOOL)!.inputSchema },
    available: ({ userId, chatId }) => resultChatOf(ctx.db, chatId)?.userId === userId && brandImagesUsed(ctx.db) < BRAND_IMAGES_PER_TEAM && !!brandImageKey(ctx),
    async call(args, t) {
      const r = await reg.call(BRAND_IMAGE_TOOL, args, t.files)
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}), summary: r.summary }
    },
  })
}
