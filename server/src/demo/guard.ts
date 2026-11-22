// Demo mode's fences (docs/DECISIONS.md "Demo company: a new hire at 트리나"). A demo server can be open to every network
// its Mac is on, and its demo people's password is public, so whatever a demo person (or anyone who learns another
// account's password) could use to reach the Mac or lock the demo is refused here, whoever asks:
//
// - every endpoint that re-checks the owner's password (owner-reauth: update, restore, transfer ownership, AI
//   transfer …) and the admins' speech key and API engine, which re-check a password too; and the team's AI
//   connections (add, replace a key, start a sign-in): they ask for no password any more, but a demo has no AI of
//   its own to connect;
// - changing a demo person's password (except the very first change from the temporary one, which the seed makes),
//   resetting it, disabling, deleting or promoting a demo person.
// Connected folders, plugin package files and API engines on any address are off through the feature table
// (system/deployment.ts). RouteKit.handle (http/route.ts) calls demoGuard for every endpoint while MYCEL_DEMO is set.
//
// A free-roam demo (DemoFile.kind "freeRoam", docs/decisions/20261119-demo-free-roam-a.md) is one visitor's instance with
// the real AI, so it fences much more: by endpoint (FREE_ROAM_FENCE below, refused before the request's body is read:
// http/route.ts), by off-contract route (every raw route but the web app's, its WebSocket and the app links:
// freeRoamRawFenced), by the turn's tools (chat/tools.ts, freeRoamToolFenced) and by size (uploads: freeRoamBody).
import { API, API_GROUPS, type Endpoint, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { isFreeRoam } from '../app-config'
import { getUser } from '../auth/users'
import type { AuthInfo } from '../services'
import { PANE_TOOLS } from '../realtime/browser-tools'
import { addUploadedBytes, uploadedBytes, uploadFileMaxOf, uploadTotalMaxOf } from './free-roam'

const T = {
  reauth: { ko: '데모 서버에서는 할 수 없어요: 비밀번호를 다시 묻는 관리 작업은 꺼져 있어요.', en: 'Not on a demo server: admin actions that ask for the password again are turned off.', id: 'Tidak bisa di server demo: tindakan admin yang meminta kata sandi lagi dimatikan.', ja: 'デモサーバーではできません。パスワードを再確認する管理操作はオフになっています。', es: 'No en un servidor de demostración: las acciones de administración que vuelven a pedir la contraseña están desactivadas.', zh: '演示服务器上无法操作：需要再次输入密码的管理操作已关闭。' },
  ai: { ko: '데모 서버에서는 팀의 AI 연결을 바꿀 수 없어요.', en: "Not on a demo server: the team's AI connections cannot be changed.", id: 'Tidak bisa di server demo: koneksi AI tim tidak bisa diubah.', ja: 'デモサーバーでは、チームのAI接続は変更できません。', es: 'No en un servidor de demostración: las conexiones de IA del equipo no se pueden cambiar.', zh: '演示服务器上无法操作：不能更改团队的AI连接。' },
  persona: { ko: '데모 서버에서는 데모 사람의 비밀번호·역할·계정 상태를 바꿀 수 없어요.', en: "Not on a demo server: the demo people's passwords, roles and accounts cannot be changed.", id: 'Tidak bisa di server demo: kata sandi, peran, dan akun orang demo tidak bisa diubah.', ja: 'デモサーバーでは、デモの人のパスワード・役割・アカウントは変更できません。', es: 'No en un servidor de demostración: no se pueden cambiar las contraseñas, los roles ni las cuentas de las personas de la demostración.', zh: '演示服务器上无法操作：不能更改演示人员的密码、角色和账号。' },
} as const

/** Is this username one of the demo people? Only while MYCEL_DEMO is set. */
export function isDemoPersona(ctx: AppContext, username: string | null | undefined): boolean {
  const d = ctx.config.demo
  if (!d || !username) return false
  const u = username.toLowerCase()
  return d.personas.some((p) => p.username.toLowerCase() === u)
}

const personaById = (ctx: AppContext, id: unknown) => typeof id === 'string' && isDemoPersona(ctx, getUser(ctx.db, id)?.username)

/** Refuse what a demo server must not do (see the head of this file). No-op without MYCEL_DEMO. */
export function demoGuard(ctx: AppContext, ep: Endpoint, i: { params: Record<string, string>; body: unknown; auth: AuthInfo | null; locale: Locale }): void {
  if (!ctx.config.demo) return
  if (ep.auth === 'owner-reauth' || ep.auth === 'admin-reauth' || ep === API.setSpeechKey) fail('forbidden', T.reauth[i.locale])
  if (ep === API.createCredential || ep === API.replaceCredentialSecret || ep === API.startCredentialLogin) fail('forbidden', T.ai[i.locale])
  const body = (i.body ?? {}) as Record<string, unknown>
  // the seed's first change, from the temporary password to the demo password, is the only one
  if (ep === API.changePassword && i.auth && isDemoPersona(ctx, i.auth.user.username) && !i.auth.user.mustChangePassword) fail('forbidden', T.persona[i.locale])
  if ((ep === API.resetPassword || ep === API.deleteUser) && personaById(ctx, i.params.id)) fail('forbidden', T.persona[i.locale])
  if (ep === API.updateUser && (body.status !== undefined || body.role !== undefined) && personaById(ctx, i.params.id)) fail('forbidden', T.persona[i.locale])
}

// ---------------- free roam (docs/decisions/20261119-demo-free-roam-a.md) ----------------

/** what a free-roam fence is about: the words the visitor gets, and params.area for a screen that words it itself */
export type FenceArea = 'account' | 'invite' | 'admin' | 'connect' | 'background' | 'heavy' | 'usage' | 'skills'
const FENCE_TEXT: Record<FenceArea, Record<Locale, string>> = {
  account: { ko: '데모에서는 계정과 로그인을 바꿀 수 없어요.', en: "Not in the demo: accounts and sign-in can't be changed.", id: 'Tidak tersedia di demo: akun dan cara masuk tidak bisa diubah.', ja: 'デモでは、アカウントとログインは変更できません。', es: 'No en la demostración: las cuentas y el inicio de sesión no se pueden cambiar.', zh: '演示中不可用：不能更改账号和登录。' },
  invite: { ko: '데모에서는 사람을 초대할 수 없어요.', en: "Not in the demo: inviting people isn't available.", id: 'Tidak tersedia di demo: mengundang orang tidak bisa dilakukan.', ja: 'デモでは、人を招待することはできません。', es: 'No en la demostración: no se puede invitar a personas.', zh: '演示中不可用：不能邀请他人。' },
  admin: { ko: '데모에서는 팀 관리 화면을 쓸 수 없어요.', en: "Not in the demo: the team's admin pages are off.", id: 'Tidak tersedia di demo: halaman admin tim dimatikan.', ja: 'デモでは、チームの管理画面は使えません。', es: 'No en la demostración: las páginas de administración del equipo están desactivadas.', zh: '演示中不可用：团队管理页面已关闭。' },
  connect: { ko: '데모에서는 새 서비스를 연결할 수 없어요.', en: "Not in the demo: connecting new services isn't available.", id: 'Tidak tersedia di demo: menghubungkan layanan baru tidak bisa dilakukan.', ja: 'デモでは、新しいサービスは接続できません。', es: 'No en la demostración: no se pueden conectar servicios nuevos.', zh: '演示中不可用：不能连接新服务。' },
  background: { ko: '데모에서는 예약 작업과 휴대폰·기기 연결을 쓸 수 없어요.', en: "Not in the demo: scheduled tasks, phones and devices aren't available.", id: 'Tidak tersedia di demo: tugas terjadwal, ponsel, dan perangkat tidak bisa dipakai.', ja: 'デモでは、予約タスクとスマートフォン・デバイスの接続は使えません。', es: 'No en la demostración: las tareas programadas, los teléfonos y los dispositivos no están disponibles.', zh: '演示中不可用：定时任务、手机和设备连接。' },
  usage: { ko: '데모에서는 사용량과 AI 엔진·모델을 볼 수 없어요.', en: "Not in the demo: usage and the AI's engine and model aren't shown.", id: 'Tidak tersedia di demo: pemakaian serta mesin dan model AI tidak ditampilkan.', ja: 'デモでは、使用量とAIのエンジン・モデルは表示されません。', es: 'No en la demostración: el uso y el motor y el modelo de la IA no se muestran.', zh: '演示中不可用：不显示用量以及AI的引擎和模型。' },
  skills: { ko: '데모에서는 이 컴퓨터의 스킬을 팀에 가져올 수 없어요.', en: "Not in the demo: bringing skills from this computer isn't available.", id: 'Tidak tersedia di demo: membawa skill dari komputer ini tidak bisa dilakukan.', ja: 'デモでは、このコンピューターのスキルをチームに持ち込むことはできません。', es: 'No en la demostración: no se pueden traer habilidades desde este equipo.', zh: '演示中不可用：不能从这台电脑带入技能。' },
  heavy: { ko: '데모에서는 개발 환경, 음성 입력, 큰 작업을 쓸 수 없어요.', en: "Not in the demo: the dev environment, voice input and heavy work aren't available.", id: 'Tidak tersedia di demo: lingkungan pengembangan, input suara, dan pekerjaan berat tidak bisa dipakai.', ja: 'デモでは、開発環境・音声入力・重い処理は使えません。', es: 'No en la demostración: el entorno de desarrollo, la entrada de voz y los trabajos pesados no están disponibles.', zh: '演示中不可用：开发环境、语音输入和大型任务。' },
}
const UPLOAD_TEXT: Record<Locale, (each: string, all: string) => string> = {
  ko: (each, all) => `데모에서는 파일 하나에 ${each}, 모두 합쳐 ${all}까지 올릴 수 있어요.`,
  en: (each, all) => `In the demo a file can be up to ${each}, and all uploads together up to ${all}.`,
  id: (each, all) => `Di demo, satu file paling besar ${each}, dan semua unggahan bersama paling besar ${all}.`,
  ja: (each, all) => `デモでは、ファイル1つにつき${each}、合計${all}までアップロードできます。`,
  es: (each, all) => `En la demostración, cada archivo puede tener hasta ${each} y todas las subidas juntas hasta ${all}.`,
  zh: (each, all) => `演示中每个文件最大${each}，所有上传合计最多${all}。`,
}
const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`

/** endpoint names (keys of API) a free-roam demo refuses, by area. Admin routes (/api/admin/…, and every endpoint for
 * admins or the owner) and whole groups (FENCED_GROUPS) come on top. The decision record lists them with the reason. */
const NAMED: Record<FenceArea, readonly (keyof typeof API)[]> = {
  account: ['setup', 'login', 'changePassword', 'passwordResetInfo', 'completePasswordReset', 'appSignIn', 'redeemAppSignIn',
    'startGoogleSignIn', 'redeemGoogleSignIn', 'connectGoogle', 'disconnectGoogle',
    'requestAccountDeletion', 'cancelAccountDeletion'],
  invite: ['inviteInfo', 'acceptInvite', 'createGuestInvite', 'guestInviteLimit'],
  admin: [],
  connect: [
    'requestAiAccess', 'tellAiNotReady', 'sealingKey', 'myCredentials', 'createMyCredential', 'deleteMyCredential', 'startMyCredentialLogin',
    'getMyCredentialLogin', 'myCredentialLoginSlot', 'cancelMyCredentialLogin', 'submitMyCredentialLoginCode',
    'authorizeDrive', 'driveFlow', 'completeDriveFlow', 'claimDriveFlow', 'cancelDriveFlow', 'disconnectDrive',
    'authorizeGoogleApp', 'googleAppFlow', 'completeGoogleAppFlow', 'cancelGoogleAppFlow', 'updateGoogleApp', 'disconnectGoogleApp',
    'createIntegration', 'updateIntegration', 'deleteIntegration', 'createLocalIntegration', 'updateLocalIntegration', 'refreshIntegration',
    'authorizeIntegration', 'setIntegrationTool', 'integrationFlow', 'cancelIntegrationFlow', 'completeIntegrationRequest',
    'declineIntegrationRequest', 'connectIntegrationTemplate', 'askService', 'withdrawService',
  ],
  background: ['createScheduleFromTemplate', 'updateSchedule', 'runScheduleNow', 'scheduleEditCard', 'editSchedule', 'confirmScheduleReview',
    'subscribePush', 'unsubscribePush', 'registerPushDevice', 'removePushDevice', 'labelPushDevice', 'unregisterPushDevice',
    'connectInfo', 'lanFailure', 'reportMyComputer'],
  heavy: ['transcribe', 'transcribePiece', 'renderPromoVideo'],
  // QA TC-5578: GET /api/me/usage answered the engine, the model and the cost in US dollars of the real AI account
  // behind the demo; GET /api/engines names the engine and model too (the composer shows no picker without it)
  usage: ['myUsage', 'chatEngines'],
  // the free-roam audit (QA TC-5613): "Bring my skills" reads a folder of the visitor's own computer into the team
  // (members suggest them; owners' and admins' createSkillShare is fenced as an admin endpoint)
  skills: ['contributeSkills'],
}
/** whole groups of the contract (API_GROUPS) a free-roam demo refuses, but for the reads named in FENCE_KEEP */
const FENCED_GROUPS: Partial<Record<keyof typeof API_GROUPS, FenceArea>> = {
  DEV_ENV: 'heavy', PLUGINS: 'admin', CONNECTED: 'admin', OFFICE_UPDATE: 'admin', HANDOVER: 'admin', TEAM_LINKS: 'invite',
  REMOTE_MCP: 'connect', SLACK: 'connect', ROOM_APPS: 'connect', LOCAL_APPS: 'background', BROWSER: 'background',
}
/** reads of a fenced group that stay: a screen shows "not connected" or the room's app list as it is */
const FENCE_KEEP = new Set<string>(['mySlack', 'listRoomApps', 'roomAppIcon'])

const FREE_ROAM_FENCE: ReadonlyMap<Endpoint, FenceArea> = (() => {
  const m = new Map<Endpoint, FenceArea>()
  const api = API as unknown as Record<string, Endpoint>
  for (const [area, names] of Object.entries(NAMED) as [FenceArea, readonly string[]][]) {
    for (const n of names) {
      const ep = api[n]
      if (!ep) throw new Error(`free-roam fence: no endpoint ${n}`)
      m.set(ep, area)
    }
  }
  for (const [g, area] of Object.entries(FENCED_GROUPS) as [keyof typeof API_GROUPS, FenceArea][]) {
    for (const [n, ep] of Object.entries(API_GROUPS[g] as Record<string, Endpoint>)) if (!FENCE_KEEP.has(n)) m.set(ep, area)
  }
  for (const ep of Object.values(api)) {
    if (m.has(ep)) continue
    if (ep.path.startsWith('/api/admin/') || ep.auth === 'admin' || ep.auth === 'admin-reauth' || ep.auth === 'owner' || ep.auth === 'owner-reauth') m.set(ep, 'admin')
  }
  return m
})()

/** Which area a free-roam demo refuses this endpoint for, or null (the tests list them; the decision record names them). */
export function freeRoamFenceOf(ep: Endpoint): FenceArea | null { return FREE_ROAM_FENCE.get(ep) ?? null }

/** the uploads a free-roam demo counts and caps (one file, all of the instance) */
const UPLOADS = new Set<Endpoint>([API.upload, API.uploadAttachment, API.uploadRoomFile, API.createUploadSession])

/**
 * Before the body is read (http/route.ts), on a free-roam demo only: a fenced endpoint is refused whoever asks (403
 * forbidden, params.reason "demo_fenced" and params.area), and an upload whose announced length is over the file limit
 * ends here too (413, params.reason "demo_upload").
 */
export function freeRoamFence(ctx: AppContext, ep: Endpoint, i: { locale: Locale; contentLength: string | null }): void {
  if (!isFreeRoam(ctx.config)) return
  const area = freeRoamFenceOf(ep)
  if (area) fail('forbidden', FENCE_TEXT[area][i.locale] ?? FENCE_TEXT[area].en, { params: { reason: 'demo_fenced', area } })
  if (UPLOADS.has(ep) && ep !== API.createUploadSession && i.contentLength !== null) {
    // a multipart body holds its form fields and boundaries besides the file: a little room for them
    if (Number(i.contentLength) > uploadFileMaxOf(ctx.config.demo!) + 64 * 1024) uploadRefused(ctx, i.locale)
  }
}

function uploadRefused(ctx: AppContext, locale: Locale): never {
  const d = ctx.config.demo!
  const each = uploadFileMaxOf(d), all = uploadTotalMaxOf(d)
  return fail('payload_too_large', (UPLOAD_TEXT[locale] ?? UPLOAD_TEXT.en)(mb(each), mb(all)), { params: { reason: 'demo_upload', fileMax: each, totalMax: all } })
}

/**
 * After the body is read, on a free-roam demo only: an upload's real size against the file limit and the instance's
 * total (counted here and kept across restarts: demo/free-roam.ts uploadedBytes); and the account fields of the
 * person's own profile: their name and e-mail stay as seeded.
 */
export function freeRoamBody(ctx: AppContext, ep: Endpoint, i: { body: unknown; locale: Locale }): void {
  if (!isFreeRoam(ctx.config)) return
  const body = (i.body ?? {}) as Record<string, unknown>
  if ((ep === API.updateMe && (body.name !== undefined || body.email !== undefined)) || (ep === API.updateMyProfile && body.name !== undefined)) {
    fail('forbidden', FENCE_TEXT.account[i.locale] ?? FENCE_TEXT.account.en, { params: { reason: 'demo_fenced', area: 'account' } })
  }
  if (!UPLOADS.has(ep)) return
  const size = ep === API.createUploadSession ? Number(body.size) : Number((body.file as { size?: unknown } | undefined)?.size)
  if (!Number.isFinite(size) || size < 0) return
  const d = ctx.config.demo!
  if (size > uploadFileMaxOf(d) || uploadedBytes(ctx) + size > uploadTotalMaxOf(d)) uploadRefused(ctx, i.locale)
  addUploadedBytes(ctx, size)
}

/** Off-contract routes (RouteKit.raw) a free-roam demo answers 404: every one but the web app's, its WebSocket and the
 * app links. That is every sign-in callback (integrations, Google apps, Drive, Slack), the room apps' webhooks and the
 * remote MCP server with its OAuth routes. */
const RAW_KEPT = new Set(['web', 'ws', 'app-links'])
export function freeRoamRawFenced(ctx: AppContext, module: string): boolean {
  return isFreeRoam(ctx.config) && !RAW_KEPT.has(module)
}

/**
 * The turn tools a free-roam demo never offers (chat/tools.ts add), by why. Everything else of the registry is offered as
 * on any server (the full table with reasons: docs/decisions/20261119-demo-free-roam-a.md). The model proxy refuses a
 * request that names a tool the turn was not given (proxy/model-proxy.ts checkToolNames), so a tool left out here
 * cannot be called through a sub-agent or an older engine either.
 */
export const FREE_ROAM_REFUSED_TOOLS: Readonly<Record<string, string>> = {
  connect_service: 'connecting new services',
  schedule_create: 'scheduled tasks run in the background', schedule_list: 'scheduled tasks', schedule_delete: 'scheduled tasks',
  web_fetch: 'the visitor would choose what this machine fetches', save_url: 'the same: a download from any address',
  promo_video: 'heavy work (a video render)', save_promo_video: 'heavy work (an MP4 render)',
  box_shell: 'the dev environment',
}
/** the browser pane tools (the desktop app's in-app browser: device work, and pages of addresses the visitor picks) */
const PANE = new Set<string>(PANE_TOOLS.map((t) => t.name))
export function freeRoamToolFenced(ctx: AppContext, name: string): boolean {
  return isFreeRoam(ctx.config) && (name in FREE_ROAM_REFUSED_TOOLS || PANE.has(name))
}
/** intro_deck's site reader (step "read": pages of addresses the visitor names) is off; its other steps stay */
export function freeRoamToolCallRefused(ctx: AppContext, name: string, args: unknown): boolean {
  return isFreeRoam(ctx.config) && name === 'intro_deck' && (args as { step?: unknown } | null)?.step === 'read'
}
