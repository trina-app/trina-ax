// The one list of system packages on a Linux server (scripts/system/packages.json, docs/DECISIONS.md "One list of system
// packages"): root keeps it in <base>/root/packages.json and records each sync in root/packages.synced (packages.sh
// pk_write_synced; native/cmd/mycel-ctl/sync.go). Admin › System › Diagnostics shows where the sync stands. Read only:
// root/ is root's, the server account reads it.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'

export interface SyncRecord { format: 1; list: string; result: 'ok' | 'incomplete' | 'blocked'; at: string; browser?: string; detail?: string }

const read = (p: string, max: number): Buffer | null => {
  try {
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > max) return null
    return fs.readFileSync(p)
  } catch { return null }
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

type T = Record<Locale, string>
export const SYSTEM_PACKAGES_TEXT = {
  label: { ko: '시스템 패키지', en: 'System packages', id: 'Paket sistem', ja: 'システムパッケージ', es: 'Paquetes del sistema' } as T,
  ok: (at: string, browser: string): T => ({
    ko: `이 버전의 목록대로예요(${at}).${browser ? ` HTML→PDF 브라우저 ${browser}.` : ''}`,
    en: `As this version's list says (${at}).${browser ? ` Headless browser for HTML to PDF: ${browser}.` : ''}`,
    id: `Sesuai daftar versi ini (${at}).${browser ? ` Browser untuk HTML ke PDF: ${browser}.` : ''}`,
    ja: `このバージョンのリストどおりです(${at})。${browser ? `HTML→PDF のブラウザ: ${browser}。` : ''}`,
    es: `Como dice la lista de esta versión (${at}).${browser ? ` Navegador para HTML a PDF: ${browser}.` : ''}`,
  }),
  pending: {
    ko: '아직 이 버전의 목록대로 맞추지 않았어요. 업데이트 시간에 업데이트 타이머가 맞춰요. 지금 하려면: sudo mycel-ctl update',
    en: 'Not yet brought to this version\'s list. The update timer does it in the update window; now: sudo mycel-ctl update',
    id: 'Belum disesuaikan dengan daftar versi ini. Timer pembaruan melakukannya di jendela pembaruan; sekarang: sudo mycel-ctl update',
    ja: 'まだこのバージョンのリストに合わせていません。更新時間に更新タイマーが合わせます。今すぐ: sudo mycel-ctl update',
    es: 'Aún no está como dice la lista de esta versión. El temporizador de actualizaciones lo hace en la ventana de actualización; ahora: sudo mycel-ctl update',
  } as T,
  incomplete: (at: string, detail: string): T => ({
    ko: `${at}에 다 맞추지 못했어요: ${detail}. 몇 시간 뒤 다시 해요. 지금 하려면: sudo mycel-ctl update`,
    en: `The try at ${at} did not finish: ${detail}. It is tried again after some hours; now: sudo mycel-ctl update`,
    id: `Percobaan pada ${at} belum selesai: ${detail}. Dicoba lagi setelah beberapa jam; sekarang: sudo mycel-ctl update`,
    ja: `${at} の実行は完了しませんでした: ${detail}。数時間後にもう一度試します。今すぐ: sudo mycel-ctl update`,
    es: `El intento de ${at} no terminó: ${detail}. Se intenta de nuevo tras unas horas; ahora: sudo mycel-ctl update`,
  }),
  blocked: (detail: string): T => ({
    ko: `관리자가 할 일이 있어요: ${detail}`,
    en: `Needs an administrator: ${detail}`,
    id: `Perlu administrator: ${detail}`,
    ja: `管理者の操作が必要です: ${detail}`,
    es: `Necesita a un administrador: ${detail}`,
  }),
}

/** The diagnostics line, or null on a server without the list. */
export function systemPackagesDiagnostic(rootDir: string | null): { status: 'ok' | 'warn'; text: T } | null {
  const s = systemPackagesState(rootDir)
  if (!s) return null
  const r = s.record
  if (!r || r.list !== s.list) return { status: 'warn', text: SYSTEM_PACKAGES_TEXT.pending }
  if (r.result === 'ok') return { status: 'ok', text: SYSTEM_PACKAGES_TEXT.ok(r.at, r.browser ?? '') }
  if (r.result === 'blocked') return { status: 'warn', text: SYSTEM_PACKAGES_TEXT.blocked(r.detail ?? '') }
  return { status: 'warn', text: SYSTEM_PACKAGES_TEXT.incomplete(r.at, r.detail ?? '') }
}
