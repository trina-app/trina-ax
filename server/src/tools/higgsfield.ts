// generate_video: a short AI video from a text prompt through the team's Higgsfield API account
// (https://docs.higgsfield.ai: POST /<model endpoint> → request_id; poll status_url until completed / failed / nsfw /
// canceled; the result is at video.url). Registered only when an admin has put the key pair into
// <data>/secrets/higgsfield.key ("<key id>:<key secret>", 0600). Every generation costs the team money and sends the
// prompt to Higgsfield, so the person confirms each one on a card (raised by the server, not the AI); a per-person daily
// cap guards against loops. The video is saved into the team folder like a make_file result.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import { placeProduced } from './make-file'
import { inSkills } from '../skills/guard'
import type { ToolRegistry } from './registry'
import { resolveTarget } from './web-fetch'

export const HIGGSFIELD_API = 'https://api.higgsfield.ai'
/** testing only: a local stand-in for the API (its result URLs may then be http / local too) */
const apiBase = () => process.env.MYCEL_HIGGSFIELD_API ?? HIGGSFIELD_API
export const DEFAULT_VIDEO_ENDPOINT = 'alibaba/happy-horse/text-to-video'
const POLL_MS = 5000
const WAIT_MAX_MS = 15 * 60_000
const DOWNLOAD_MAX = 200 * 1024 * 1024
const DAILY_DEFAULT = 10

export const GenerateVideoInput = z.object({
  prompt: z.string().min(3).max(2000).describe('What the video shows, in English: subject, action, setting, camera move, lighting, style'),
  duration: z.number().int().min(3).max(15).default(5).describe('Seconds (3–15, default 5)'),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).default('16:9'),
  resolution: z.enum(['720p', '1080p']).default('720p'),
  save_as: z.string().max(300).optional().describe('Team path for the .mp4 (default: users/<you>/videos/<short name>.mp4)'),
})

export const TEXT = {
  confirm: {
    ko: 'AI가 Higgsfield로 영상을 만들려고 합니다. 팀 계정의 크레딧이 쓰이고, 아래 설명이 Higgsfield로 보내집니다.\n\n길이 {duration}초 · {aspect} · {resolution}\n\n{prompt}',
    en: 'The AI wants to make a video with Higgsfield. This uses the team account\'s credits, and the description below is sent to Higgsfield.\n\n{duration} s · {aspect} · {resolution}\n\n{prompt}',
    id: 'AI ingin membuat video dengan Higgsfield. Ini memakai kredit akun tim, dan deskripsi di bawah dikirim ke Higgsfield.\n\n{duration} dtk · {aspect} · {resolution}\n\n{prompt}', ja: "AIがHiggsfieldで動画を作成しようとしています。チームアカウントのクレジットを使用し、下の説明をHiggsfieldに送信します。\n\n{duration} s · {aspect} · {resolution}\n\n{prompt}", es: "La IA quiere crear un video con Higgsfield. Se usarán créditos de la cuenta del equipo y se enviará a Higgsfield la descripción siguiente.\n\n{duration} s · {aspect} · {resolution}\n\n{prompt}",
  },
  allow: { ko: '만들기', en: 'Make it', id: 'Buat', ja: "作成", es: "Crear" },
  deny: { ko: '취소', en: 'Cancel', id: 'Batal', ja: "キャンセル", es: "Cancelar" },
} satisfies Record<string, Record<Locale, string>>

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)

/** "<key id>:<key secret>" from <data>/secrets/higgsfield.key, or null (not set up). */
export function higgsfieldKey(dataDir: string): string | null {
  try {
    const k = fs.readFileSync(path.join(dataDir, 'secrets', 'higgsfield.key'), 'utf8').trim()
    return /^[^:\s]+:[^:\s]+$/.test(k) ? k : null
  } catch { return null }
}

export interface HiggsfieldResult { requestId: string; videoUrl: string }
type Status = { status?: string; request_id?: string; video?: { url?: string }; error?: unknown }

/** Submit, then poll until a terminal status. */
export async function runHiggsfield(o: { key: string; endpoint: string; body: Record<string, unknown>; idempotencyKey: string; fetchFn?: typeof fetch; pollMs?: number; waitMaxMs?: number; signal?: AbortSignal }): Promise<HiggsfieldResult> {
  const f = o.fetchFn ?? fetch
  const headers = { Authorization: `Key ${o.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }
  const sub = await f(`${apiBase()}/${o.endpoint}`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': o.idempotencyKey }, body: JSON.stringify(o.body), signal: o.signal })
  const first = await sub.json().catch(() => ({})) as Status & { status_url?: string; detail?: unknown }
  if (!sub.ok) throw new ToolError(`Higgsfield refused the request (HTTP ${sub.status}${sub.status === 401 || sub.status === 403 ? ': the team\'s API key is wrong or has no access to this model' : ''}): ${JSON.stringify(first.detail ?? first.error ?? first).slice(0, 300)}`)
  const id = first.request_id
  if (!id) throw new ToolError('Higgsfield did not return a request id')
  const statusUrl = `${apiBase()}/requests/${encodeURIComponent(id)}/status`
  const until = Date.now() + (o.waitMaxMs ?? WAIT_MAX_MS)
  let s: Status = first
  while (true) {
    if (s.status === 'completed') {
      const url = s.video?.url
      if (!url) throw new ToolError('Higgsfield finished but returned no video URL')
      return { requestId: id, videoUrl: url }
    }
    if (s.status === 'failed') throw new ToolError(`Higgsfield could not make the video (not charged): ${JSON.stringify(s.error ?? 'no reason given').slice(0, 300)}`)
    if (s.status === 'nsfw') throw new ToolError('Higgsfield\'s content moderation rejected the prompt or the result (not charged). Change the description.')
    if (s.status === 'canceled') throw new ToolError('the Higgsfield request was canceled')
    if (Date.now() > until) throw new ToolError(`the video was not ready in time (request ${id}); it may still finish in the Higgsfield console`)
    await new Promise((r) => setTimeout(r, o.pollMs ?? POLL_MS))
    if (o.signal?.aborted) throw new ToolError('stopped')
    const r = await f(statusUrl, { headers, signal: o.signal })
    s = await r.json().catch(() => ({ status: 'unknown' })) as Status
    if (!r.ok && r.status !== 404) throw new ToolError(`Higgsfield status check failed (HTTP ${r.status})`)
  }
}

/** The result file: https only, a public address, at most 200 MB. */
export async function downloadVideo(url: string, dst: string, fetchFn: typeof fetch = fetch, check?: (u: string) => Promise<unknown>): Promise<number> {
  if (!check && !url.startsWith('https://')) throw new ToolError('the video address is not https')
  await (check ?? ((u: string) => resolveTarget(u)))(url)
  const res = await fetchFn(url)
  if (!res.ok) throw new ToolError(`could not download the video (HTTP ${res.status})`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length > DOWNLOAD_MAX) throw new ToolError('the video is larger than 200 MB')
  fs.writeFileSync(dst, buf)
  return buf.length
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video'

export function registerHiggsfield(ctx: AppContext, reg: ToolRegistry): boolean {
  const dataDir = ctx.engineConfig.dataDir
  if (!higgsfieldKey(dataDir)) return false
  const endpoint = process.env.MYCEL_HIGGSFIELD_VIDEO_ENDPOINT ?? DEFAULT_VIDEO_ENDPOINT
  const daily = Number(process.env.MYCEL_HIGGSFIELD_DAILY ?? DAILY_DEFAULT)
  reg.register({
    name: 'generate_video',
    description: 'Make a short AI video (3–15 s) from a text description with the team\'s Higgsfield account, and save the .mp4 in the team folder. ' +
      'Each video costs the team credits and the person confirms it first; the description is sent to Higgsfield, so never put personal, patient or confidential information in it. ' +
      'Write the prompt in English (subject, action, setting, camera move, lighting, style). Takes one to a few minutes.',
    input: GenerateVideoInput,
    describe: (a) => `generate_video ${a.duration}s ${a.aspect_ratio} ${a.resolution}`,
    async run(a, t) {
      const key = higgsfieldKey(dataDir)
      if (!key) throw new ToolError('Higgsfield is not set up on this server')
      if (!t.person) throw new ToolError('this tool only works inside a chat turn (the person confirms each video)')
      // skills/ is for team skills and rules (skills/guard.ts): refused before any credits are spent
      if (a.save_as && inSkills(a.save_as.replace(/^\/+/, ''))) throw new ToolError('videos cannot be saved under skills/ (team skills and rules); pick another folder')
      const used = (ctx.db.query("SELECT count(*) AS n FROM tool_events WHERE user_id = ? AND tool = 'generate_video' AND ok = 1 AND at >= ?")
        .get(t.user.id, new Date(Date.now() - 24 * 3600_000).toISOString()) as { n: number }).n
      if (used >= daily) throw new ToolError(`daily video limit reached (${daily} per person per 24 hours)`)
      const L = t.person.locale
      const ok = await t.person.confirm(fill(TEXT.confirm[L], { duration: String(a.duration), aspect: a.aspect_ratio, resolution: a.resolution, prompt: a.prompt }), TEXT.allow[L], TEXT.deny[L])
      if (!ok) throw new ToolError('the person did not allow this video; ask what to change')
      const r = await runHiggsfield({ key, endpoint, idempotencyKey: `${t.turnId ?? 'x'}-${Bun.hash(a.prompt + a.duration + a.aspect_ratio + a.resolution)}`, body: { prompt: a.prompt, duration: a.duration, aspect_ratio: a.aspect_ratio, resolution: a.resolution } })
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-hf-'))
      try {
        const tmp = path.join(work, 'video.mp4')
        const size = await downloadVideo(r.videoUrl, tmp, fetch, process.env.MYCEL_HIGGSFIELD_API ? async () => {} : undefined)
        const target = (a.save_as?.replace(/\.mp4$/i, '') ?? `users/${t.user.id}/videos/${slug(a.prompt)}`) + '.mp4'
        const made = await placeProduced(ctx, componentC(ctx).files, t, target.split('/').filter(Boolean), tmp, 'generate_video')
        return {
          text: `Saved the video: ${made.path} (${(size / 1048576).toFixed(1)} MB, ${a.duration} s, ${a.aspect_ratio}, ${a.resolution}). Higgsfield request ${r.requestId}.`,
          summary: `generate_video -> ${made.path} (${size} B, request ${r.requestId})`,
          structured: { path: made.path, size, requestId: r.requestId },
        }
      } finally { fs.rmSync(work, { recursive: true, force: true }) }
    },
  })
  return true
}
