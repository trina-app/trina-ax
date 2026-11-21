// The folder that holds push secrets (<data>/secrets/push: the Web Push and phone app device rows' key) must be the
// server account's own and closed to everyone else, or no device is registered (push-service.ts safeSecrets answers
// 503 `push_key`). A member's phone only says the team server is unavailable, so the cause goes to the server's log and
// to Admin › System › Diagnostics, in words an admin can act on (QA TC-6929: a data folder left 0755 by hand).
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import { withSupport } from '../system/messages-linux'

type T = Record<Locale, string>

/** What is wrong with the push secrets' folders, or null: the first folder that fails, and why. */
export interface PushSecretsProblem {
  dir: string
  why: 'in_team_folder' | 'link' | 'not_folder' | 'open' | 'owner' | 'unreadable'
  /** the folder's permission bits, e.g. "755" (open) */
  mode?: string
}

/** The data folder, <data>/secrets and <data>/secrets/push (`secrets`): each a real folder of this account with no
 * access for its group or others, and the data folder outside the team folder. A folder not made yet is no problem
 * (`create`: it is made 0700 first, as a registration does). */
export function pushSecretsProblem(o: { dataDir: string; teamRoot: string; secrets: string; create?: boolean }): PushSecretsProblem | null {
  let realData: string, team: string
  try { realData = fs.realpathSync(o.dataDir) } catch { return { dir: o.dataDir, why: 'unreadable' } }
  try { team = fs.realpathSync(o.teamRoot) } catch { return { dir: o.teamRoot, why: 'unreadable' } }
  if (realData === team || realData.startsWith(team + path.sep)) return { dir: o.dataDir, why: 'in_team_folder' }
  for (const dir of [o.dataDir, path.dirname(o.secrets), o.secrets]) {
    if (!fs.existsSync(dir)) {
      if (!o.create) continue
      try { fs.mkdirSync(dir, { mode: 0o700 }) } catch { return { dir, why: 'unreadable' } }
    }
    let st: fs.Stats
    try { st = fs.lstatSync(dir) } catch { return { dir, why: 'unreadable' } }
    if (st.isSymbolicLink()) return { dir, why: 'link' }
    if (!st.isDirectory()) return { dir, why: 'not_folder' }
    if (process.getuid && st.uid !== process.getuid()) return { dir, why: 'owner' }
    if (st.mode & 0o077) return { dir, why: 'open', mode: (st.mode & 0o777).toString(8) }
  }
  return null
}

/** The server log's words for a problem (no secret in them: a folder and its permission bits). */
export function pushSecretsLogLine(p: PushSecretsProblem): string {
  switch (p.why) {
    case 'open': return `push secrets folder ${p.dir} is open to other accounts (mode ${p.mode}); make it 700 (chmod 700) so phones and browsers can register for notifications`
    case 'owner': return `push secrets folder ${p.dir} belongs to another account; give it to the server account (chown) with mode 700`
    case 'link': return `push secrets folder ${p.dir} is a symbolic link; use a real folder with mode 700`
    case 'not_folder': return `push secrets path ${p.dir} is not a folder`
    case 'in_team_folder': return `the data folder ${p.dir} is inside the team folder; push secrets are not kept there`
    default: return `push secrets folder ${p.dir} cannot be read or made`
  }
}

export const PUSH_SECRETS_TEXT = {
  label: { ko: '알림 비밀 폴더', en: 'Notification secrets folder', id: 'Folder rahasia notifikasi', ja: '通知の秘密フォルダー', es: 'Carpeta de secretos de notificaciones', zh: '通知密钥文件夹' } as T,
  /** Admin › System › Diagnostics: what is wrong and what to run, on the server. A hosted team's admin has no shell
   * there: no folder or command, only that support fixes it */
  problem: (p: PushSecretsProblem, hosted = false): T => {
    if (hosted) return withSupport({
      ko: '서버의 알림 비밀 폴더 권한이 맞지 않아 휴대폰과 브라우저가 알림을 등록하지 못해요.',
      en: "The server's notification secrets folder has the wrong permissions, so phones and browsers can't sign up for notifications.",
      id: 'Izin folder rahasia notifikasi di server salah, jadi ponsel dan browser tidak bisa mendaftar notifikasi.',
      ja: 'サーバーの通知の秘密フォルダーの権限が正しくないため、スマホやブラウザーが通知を登録できません。',
      es: 'La carpeta de secretos de notificaciones del servidor tiene permisos incorrectos, así que los teléfonos y navegadores no pueden registrarse para las notificaciones.',
      zh: '服务器的通知密钥文件夹权限不对，所以手机和浏览器无法注册通知。',
    })
    if (p.why === 'open') return {
      ko: `${p.dir} 폴더를 다른 계정도 열 수 있어요(권한 ${p.mode}). 그래서 휴대폰과 브라우저가 알림을 등록하지 못해요. 서버에서 \`chmod 700 ${p.dir}\`을 실행해 주세요.`,
      en: `Other accounts can open ${p.dir} (mode ${p.mode}), so phones and browsers can't sign up for notifications. On the server, run \`chmod 700 ${p.dir}\`.`,
      id: `Akun lain bisa membuka ${p.dir} (mode ${p.mode}), jadi ponsel dan browser tidak bisa mendaftar notifikasi. Di server, jalankan \`chmod 700 ${p.dir}\`.`,
      ja: `${p.dir} を他のアカウントも開けます（権限 ${p.mode}）。そのため、スマホやブラウザーが通知を登録できません。サーバーで \`chmod 700 ${p.dir}\` を実行してください。`,
      es: `Otras cuentas pueden abrir ${p.dir} (permisos ${p.mode}), así que los teléfonos y navegadores no pueden registrarse para las notificaciones. En el servidor, ejecute \`chmod 700 ${p.dir}\`.`,
      zh: `其他账号也能打开 ${p.dir}（权限 ${p.mode}），所以手机和浏览器无法注册通知。请在服务器上运行 \`chmod 700 ${p.dir}\`。`,
    }
    if (p.why === 'owner') return {
      ko: `${p.dir} 폴더가 서버 계정의 것이 아니에요. 그래서 휴대폰과 브라우저가 알림을 등록하지 못해요. 서버 계정에게 넘기고(chown) 권한을 700으로 해 주세요.`,
      en: `${p.dir} belongs to another account, so phones and browsers can't sign up for notifications. Give it to the server account (chown) with mode 700.`,
      id: `${p.dir} milik akun lain, jadi ponsel dan browser tidak bisa mendaftar notifikasi. Berikan ke akun server (chown) dengan mode 700.`,
      ja: `${p.dir} は別のアカウントのものです。そのため、スマホやブラウザーが通知を登録できません。サーバーのアカウントに渡し（chown）、権限を 700 にしてください。`,
      es: `${p.dir} pertenece a otra cuenta, así que los teléfonos y navegadores no pueden registrarse para las notificaciones. Désela a la cuenta del servidor (chown) con permisos 700.`,
      zh: `${p.dir} 属于其他账号，所以手机和浏览器无法注册通知。请把它交给服务器账号（chown），权限设为 700。`,
    }
    return {
      ko: `${p.dir}에 알림 비밀을 둘 수 없어요. 그래서 휴대폰과 브라우저가 알림을 등록하지 못해요. 서버 계정의 실제 폴더(권한 700)로 만들어 주세요.`,
      en: `Notification secrets can't be kept in ${p.dir}, so phones and browsers can't sign up for notifications. Make it a real folder of the server account with mode 700.`,
      id: `Rahasia notifikasi tidak bisa disimpan di ${p.dir}, jadi ponsel dan browser tidak bisa mendaftar notifikasi. Jadikan folder asli milik akun server dengan mode 700.`,
      ja: `${p.dir} に通知の秘密を置けません。そのため、スマホやブラウザーが通知を登録できません。サーバーのアカウントの実際のフォルダー（権限 700）にしてください。`,
      es: `No se pueden guardar los secretos de notificaciones en ${p.dir}, así que los teléfonos y navegadores no pueden registrarse. Conviértala en una carpeta real de la cuenta del servidor con permisos 700.`,
      zh: `无法在 ${p.dir} 中保存通知密钥，所以手机和浏览器无法注册通知。请把它设为服务器账号自己的真实文件夹，权限 700。`,
    }
  },
}
