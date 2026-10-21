// Route module "office-update" — owner: component G. Office mode automatic updates in Admin > System
// (docs/OFFICE.md "자동 업데이트"): the state the installation's update LaunchAgent keeps in <home>/update/, and
// two actions for owners and admins: "update now" (a request file + launchctl kickstart of <label>.update; the agent
// stops and restarts this server, so the work never runs inside it: the server only writes update/request.json and
// asks launchd to start the agent, and never touches app/) and automatic updates off / on. "now" re-asks the password.
// Contract: shared/src/api/office-update.ts. Outside office mode the status is null and the actions are refused.
import fs from 'node:fs'
import path from 'node:path'
import { API, type Locale, type OfficeUpdateStatus } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { msg } from '../auth/messages'
import type { AppConfig } from '../app-config'
import { fail } from '../http/errors'
import { loadSettings } from '../office/settings'
import { readUpdateState, requestUpdate, updateLabel, updateView, writeUpdateSettings } from '../office/update'
import type { RouteModule } from './module'

const T = {
  notOffice: { ko: '자동 업데이트는 사무실 모드 설치에서만 씁니다.', en: 'Automatic updates are part of an office mode installation.', id: 'Pembaruan otomatis hanya untuk instalasi mode kantor.' },
  noAgent: { ko: '이 설치에는 자동 업데이트가 아직 없습니다. 서버 맥에서 새 zip의 office-install.sh를 한 번 실행하세요.', en: 'This installation has no automatic updates yet. Run office-install.sh from the new zip once on the server Mac.', id: 'Instalasi ini belum punya pembaruan otomatis. Jalankan office-install.sh dari zip baru sekali di Mac server.' },
  running: { ko: '업데이트가 이미 진행 중입니다.', en: 'An update is already running.', id: 'Pembaruan sedang berjalan.' },
}
const tr = (l: Locale, m: Record<Locale, string>) => m[l] ?? m.en

/** <home> of an office installation: the supervisor starts the server with --config <home>/config/server.json */
export function officeHomeOf(cfg: Pick<AppConfig, 'office' | 'configFile'>): string | null {
  if (!cfg.office || !cfg.configFile) return null
  const home = path.dirname(path.dirname(cfg.configFile))
  return fs.existsSync(path.join(home, 'config', 'office.env')) && fs.existsSync(path.join(home, 'app')) ? home : null
}

/** Test hook: the kickstart (tests record it instead of calling launchctl). */
export const officeUpdateHooks: { kickstart: ((label: string) => void) | null } = { kickstart: null }

function kickstart(label: string) {
  if (officeUpdateHooks.kickstart) return officeUpdateHooks.kickstart(label)
  const uid = process.getuid?.() ?? 0
  Bun.spawn(['launchctl', 'kickstart', `gui/${uid}/${label}`], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
}

export const officeUpdateRoutes: RouteModule = {
  name: 'office-update',
  owner: 'G',
  register(kit, ctx) {
    const view = (home: string): OfficeUpdateStatus => updateView(home)

    kit.handle(API.officeUpdateStatus, () => {
      const home = officeHomeOf(ctx.config)
      return home ? view(home) : null
    })

    kit.handle(API.officeUpdateAction, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      const home = officeHomeOf(ctx.config)
      if (!home) fail('conflict', tr(locale, T.notOffice))
      const v = view(home!)
      if (body.action === 'now') {
        // the password again, like the owner's update and restore: this restarts the office's server
        if (!body.password || !(await ctx.services.sessions.verifyPassword(auth.user.id, body.password, c.get('info')))) {
          fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
        }
        if (!v.agentInstalled) fail('conflict', tr(locale, T.noAgent))
        if (readUpdateState(home!).running) fail('busy', tr(locale, T.running))
        requestUpdate(home!, auth.user.username)
        kickstart(updateLabel(loadSettings(home!)))
      } else {
        writeUpdateSettings(home!, { paused: body.action === 'pause' })
      }
      audit(ctx.db, { actor: auth.user.id, action: `office_update.${body.action}`, target: null, detail: { version: v.current, channel: v.channel } })
      ctx.log.info('office update', { action: body.action, user: auth.user.id })
      return view(home!)
    })
  },
}
