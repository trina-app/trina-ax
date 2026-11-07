// The one list of system packages on a Linux server (scripts/system/packages.json, docs/DECISIONS.md "One list of system
// packages"): root keeps it in <base>/root/packages.json and records each sync in root/packages.synced (packages.sh
// pk_write_synced; native/cmd/mycel-ctl/sync.go). Admin › System › Diagnostics shows where the sync stands. Read only:
// root/ is root's, the server account reads it.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'

export interface SyncRecord { format: 1; list: string; result: 'ok' | 'incomplete' | 'blocked'; at: string; browser?: string; detail?: string; os?: string }

const read = (p: string, max: number): Buffer | null => {
  try {
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > max) return null
    return fs.readFileSync(p)
  } catch { return null }
}

/** Where this system's identity is read (tests pass fixtures). */
export interface OsFiles { osRelease: string; machineId: string }
const OS_FILES: OsFiles = { osRelease: '/etc/os-release', machineId: '/etc/machine-id' }

/** "<ID>-<VERSION_ID>/<machine-id>": the system a sync ran on, the same string as packages.sh pk_os_identity and
 * mycel-ctl's osIdentity. A reimage that keeps the data disk (and root/packages.synced on it) gets a new machine-id.
 * "" when neither file can be read. */
export function osIdentity(files: OsFiles = OS_FILES): string {
  const osr = read(files.osRelease, 64 << 10)?.toString('utf8')
  const mid = read(files.machineId, 4 << 10)?.toString('utf8')
  if (osr === undefined && mid === undefined) return ''
  const field = (k: string) => {
    for (const line of (osr ?? '').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0 && line.slice(0, i) === k) return line.slice(i + 1).replace(/^["']+|["']+$/g, '')
    }
    return ''
  }
  const word = (x: string) => x.replace(/[^A-Za-z0-9._-]/g, '')
  return `${word(field('ID'))}-${word(field('VERSION_ID'))}/${(mid ?? '').replace(/[^0-9a-f]/g, '')}`.slice(0, 128)
}

/** The sync state of rootDir: null on a server from before the list (or not Linux); the record may be missing. */
export function systemPackagesState(rootDir: string | null): { list: string; record: SyncRecord | null } | null {
  if (!rootDir) return null
  const list = read(path.join(rootDir, 'packages.json'), 1 << 20)
  if (!list) return null
  let record: SyncRecord | null = null
  try {
    const r = JSON.parse(read(path.join(rootDir, 'packages.synced'), 64 << 10)?.toString('utf8') ?? 'null') as SyncRecord | null
    if (r && r.format === 1 && typeof r.list === 'string' && ['ok', 'incomplete', 'blocked'].includes(r.result)) record = r
  } catch {}
  return { list: createHash('sha256').update(list).digest('hex'), record }
}

/** Who brings the server to the list next: the update timer (automatic updates on), an administrator (off), or the
 * hosting service's update (hosted: no timer on the team VM). */
export type SyncBy = 'timer' | 'admin' | 'hosted'

type T = Record<Locale, string>
const NEXT: Record<SyncBy, T> = {
  timer: {
    ko: '업데이트 시간에 업데이트 타이머가 해요. 지금 하려면: sudo mycel-ctl update',
    en: 'The update timer does it in the update window; now: sudo mycel-ctl update',
    id: 'Timer pembaruan melakukannya di jendela pembaruan; sekarang: sudo mycel-ctl update',
    ja: '更新時間に更新タイマーが行います。今すぐ: sudo mycel-ctl update',
    es: 'El temporizador de actualizaciones lo hace en la ventana de actualización; ahora: sudo mycel-ctl update',
  },
  admin: {
    ko: '자동 업데이트가 꺼져 있어 저절로는 하지 않아요: sudo mycel-ctl update',
    en: 'Automatic updates are off, so nothing does it by itself: sudo mycel-ctl update',
    id: 'Pembaruan otomatis mati, jadi tidak ada yang melakukannya sendiri: sudo mycel-ctl update',
    ja: '自動更新がオフのため自動では行いません: sudo mycel-ctl update',
    es: 'Las actualizaciones automáticas están apagadas, así que nada lo hace solo: sudo mycel-ctl update',
  },
  hosted: {
    ko: '호스팅 서비스의 다음 업데이트가 해요.',
    en: 'The hosting service\'s next update does it.',
    id: 'Pembaruan berikutnya dari layanan hosting melakukannya.',
    ja: 'ホスティングサービスの次の更新で行います。',
    es: 'La próxima actualización del servicio de alojamiento lo hace.',
  },
}
const join = (a: T, b: T): T => ({ ko: `${a.ko} ${b.ko}`, en: `${a.en} ${b.en}`, id: `${a.id} ${b.id}`, ja: `${a.ja}${b.ja}`, es: `${a.es} ${b.es}` })

export const SYSTEM_PACKAGES_TEXT = {
  label: { ko: '시스템 패키지', en: 'System packages', id: 'Paket sistem', ja: 'システムパッケージ', es: 'Paquetes del sistema' } as T,
  ok: (when: string, browser: string): T => {
    const done: T = {
      ko: `이 버전의 목록대로예요(${when}).`,
      en: `As this version's list says (${when}).`,
      id: `Sesuai daftar versi ini (${when}).`,
      ja: `このバージョンのリストどおりです(${when})。`,
      es: `Como dice la lista de esta versión (${when}).`,
    }
    return browser ? join(done, {
      ko: `HTML→PDF 브라우저 ${browser}.`,
      en: `Headless browser for HTML to PDF: ${browser}.`,
      id: `Browser untuk HTML ke PDF: ${browser}.`,
      ja: `HTML→PDF のブラウザ: ${browser}。`,
      es: `Navegador para HTML a PDF: ${browser}.`,
    }) : done
  },
  pending: (by: SyncBy): T => join({
    ko: '아직 이 버전의 목록대로 맞추지 않았어요.',
    en: 'Not yet brought to this version\'s list.',
    id: 'Belum disesuaikan dengan daftar versi ini.',
    ja: 'まだこのバージョンのリストに合わせていません。',
    es: 'Aún no está como dice la lista de esta versión.',
  }, NEXT[by]),
  incomplete: (when: string, detail: string, by: SyncBy): T => join({
    ko: `${when}에 다 맞추지 못했어요: ${detail}.`,
    en: `The try at ${when} did not finish: ${detail}.`,
    id: `Percobaan pada ${when} belum selesai: ${detail}.`,
    ja: `${when} の実行は完了しませんでした: ${detail}。`,
    es: `El intento de ${when} no terminó: ${detail}.`,
  }, by === 'timer' ? {
    ko: '업데이트 타이머가 몇 시간 뒤 다시 해요. 지금 하려면: sudo mycel-ctl update',
    en: 'The update timer tries again after some hours; now: sudo mycel-ctl update',
    id: 'Timer pembaruan mencoba lagi setelah beberapa jam; sekarang: sudo mycel-ctl update',
    ja: '数時間後に更新タイマーがもう一度試します。今すぐ: sudo mycel-ctl update',
    es: 'El temporizador lo intenta de nuevo tras unas horas; ahora: sudo mycel-ctl update',
  } : NEXT[by]),
  blocked: (detail: string): T => ({
    ko: `관리자가 할 일이 있어요: ${detail}`,
    en: `Needs an administrator: ${detail}`,
    id: `Perlu administrator: ${detail}`,
    ja: `管理者の操作が必要です: ${detail}`,
    es: `Necesita a un administrador: ${detail}`,
  }),
}

/** The diagnostics line, or null on a server without the list. when: a record's time as people read it. */
export function systemPackagesDiagnostic(rootDir: string | null, o: { by: SyncBy; when: (iso: string) => string; os?: OsFiles }): { status: 'ok' | 'warn'; text: T } | null {
  const s = systemPackagesState(rootDir)
  if (!s) return null
  const r = s.record
  // a record of another system (a reimage, an OS upgrade) or from before the "os" field: mycel-ctl syncs again
  if (!r || r.list !== s.list || (r.os ?? '') !== osIdentity(o.os)) return { status: 'warn', text: SYSTEM_PACKAGES_TEXT.pending(o.by) }
  if (r.result === 'ok') return { status: 'ok', text: SYSTEM_PACKAGES_TEXT.ok(o.when(r.at), r.browser ?? '') }
  if (r.result === 'blocked') return { status: 'warn', text: SYSTEM_PACKAGES_TEXT.blocked(r.detail ?? '') }
  return { status: 'warn', text: SYSTEM_PACKAGES_TEXT.incomplete(o.when(r.at), r.detail ?? '', o.by) }
}
