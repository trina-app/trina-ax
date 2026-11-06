// Demo mode's fences (docs/DECISIONS.md "Demo company: a new hire at 트리나"). A demo server can be open to every network
// its Mac is on, and its demo people's password is public, so whatever a demo person (or anyone who learns another
// account's password) could use to reach the Mac or lock the demo is refused here, whoever asks:
//
// - every endpoint that re-checks the owner's password (owner-reauth: update, restore, transfer ownership, AI
//   connections …) and the admins' speech key, which re-checks a password too;
// - changing a demo person's password (except the very first change from the temporary one, which the seed makes),
//   resetting it, disabling, deleting or promoting a demo person.
// Connected folders, plugin package files and API engines on any address are off through the feature table
// (system/deployment.ts). RouteKit.handle (http/route.ts) calls demoGuard for every endpoint while MYCEL_DEMO is set.
import { API, type Endpoint, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { getUser } from '../auth/users'
import type { AuthInfo } from '../services'

const T = {
  reauth: { ko: '데모 서버에서는 할 수 없어요: 비밀번호를 다시 묻는 관리 작업은 꺼져 있어요.', en: 'Not on a demo server: admin actions that ask for the password again are turned off.', id: 'Tidak bisa di server demo: tindakan admin yang meminta kata sandi lagi dimatikan.', ja: 'デモサーバーではできません。パスワードを再確認する管理操作はオフになっています。', es: 'No en un servidor de demostración: las acciones de administración que vuelven a pedir la contraseña están desactivadas.' },
  persona: { ko: '데모 서버에서는 데모 사람의 비밀번호·역할·계정 상태를 바꿀 수 없어요.', en: "Not on a demo server: the demo people's passwords, roles and accounts cannot be changed.", id: 'Tidak bisa di server demo: kata sandi, peran, dan akun orang demo tidak bisa diubah.', ja: 'デモサーバーでは、デモの人のパスワード・役割・アカウントは変更できません。', es: 'No en un servidor de demostración: no se pueden cambiar las contraseñas, los roles ni las cuentas de las personas de la demostración.' },
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
  if (ep.auth === 'owner-reauth' || ep === API.setSpeechKey) fail('forbidden', T.reauth[i.locale])
  const body = (i.body ?? {}) as Record<string, unknown>
  // the seed's first change, from the temporary password to the demo password, is the only one
  if (ep === API.changePassword && i.auth && isDemoPersona(ctx, i.auth.user.username) && !i.auth.user.mustChangePassword) fail('forbidden', T.persona[i.locale])
  if ((ep === API.resetPassword || ep === API.deleteUser) && personaById(ctx, i.params.id)) fail('forbidden', T.persona[i.locale])
  if (ep === API.updateUser && (body.status !== undefined || body.role !== undefined) && personaById(ctx, i.params.id)) fail('forbidden', T.persona[i.locale])
}
