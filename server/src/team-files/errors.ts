// Policy / tool errors -> HTTP errors for the file screen. "No access" and "not found" stay the same not_found
// (hidden folders must not leak); read-only is forbidden; name problems are validation with the reason in `fields`.
import type { Locale } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { Denied, ToolError } from '../policy/errors'

type Msg = Record<Locale, string>
export const MSG = {
  readOnly: { ko: '읽기 전용이라 바꿀 수 없습니다.', en: 'This is read-only for you.', id: 'Ini hanya bisa dibaca oleh Anda.' },
  badName: { ko: '이름에 쓸 수 없는 글자나 형식이 있습니다.', en: 'The name contains characters or a form that is not allowed.', id: 'Nama berisi karakter atau bentuk yang tidak diizinkan.' },
  nearDuplicate: { ko: '거의 같은 이름(대소문자·글자 모양만 다름)이 이미 있습니다. 그 이름을 쓰거나 다른 이름을 고르세요.', en: 'An item with almost the same name (differs only by case or character form) exists. Use that name or pick a clearly different one.', id: 'Sudah ada item dengan nama hampir sama (hanya beda huruf besar/kecil atau bentuk karakter).' },
  exists: { ko: '같은 이름이 이미 있습니다.', en: 'An item with this name already exists.', id: 'Item dengan nama ini sudah ada.' },
  isFolder: { ko: '폴더입니다. 파일을 고르세요.', en: 'This is a folder; pick a file.', id: 'Ini folder; pilih berkas.' },
  notFolder: { ko: '폴더가 아닙니다.', en: 'This is not a folder.', id: 'Ini bukan folder.' },
  tooLarge: { ko: '파일이 너무 큽니다.', en: 'The file is too large.', id: 'Berkas terlalu besar.' },
  unsafe: { ko: '이 경로는 안전하게 다룰 수 없습니다(링크·이상한 이름).', en: 'This path cannot be handled safely (link or unusual name).', id: 'Jalur ini tidak dapat ditangani dengan aman.' },
  notText: { ko: '텍스트 파일만 여기서 저장할 수 있습니다.', en: 'Only text files can be saved here.', id: 'Hanya berkas teks yang dapat disimpan di sini.' },
  hiddenInside: { ko: '안에 내가 볼 수 없거나 바꿀 수 없는 폴더가 있어서 할 수 없습니다.', en: 'It contains folders you cannot see or change.', id: 'Di dalamnya ada folder yang tidak bisa Anda lihat atau ubah.' },
  protectedFolder: { ko: '이 폴더는 옮기거나 지울 수 없습니다.', en: 'This folder cannot be moved or deleted.', id: 'Folder ini tidak dapat dipindah atau dihapus.' },
  intoItself: { ko: '폴더를 자기 안으로 옮길 수 없습니다.', en: 'A folder cannot be moved into itself.', id: 'Folder tidak dapat dipindah ke dalam dirinya sendiri.' },
  noBlob: { ko: '이 버전의 내용이 남아 있지 않습니다.', en: 'The content of this version is no longer kept.', id: 'Isi versi ini sudah tidak disimpan.' },
  diskFull: { ko: '서버 저장 공간이 부족합니다.', en: 'The server is running out of disk space.', id: 'Ruang disk server hampir habis.' },
  tooManySessions: { ko: '진행 중인 큰 업로드가 너무 많습니다. 끝나거나 취소된 뒤 다시 하세요.', en: 'Too many unfinished large uploads. Finish or cancel some first.', id: 'Terlalu banyak unggahan besar yang belum selesai.' },
  missingChunks: { ko: '아직 받지 못한 조각이 있습니다.', en: 'Some chunks have not arrived yet.', id: 'Beberapa potongan belum diterima.' },
  checksum: { ko: '받은 파일의 sha256이 맞지 않습니다. 처음부터 다시 올려 주세요.', en: 'The sha256 of the received file does not match. Upload it again.', id: 'sha256 berkas tidak cocok. Unggah ulang.' },
  chunkSize: { ko: '조각 크기가 맞지 않습니다.', en: 'Wrong chunk size.', id: 'Ukuran potongan salah.' },
  expired: { ko: '업로드가 만료되었습니다(24시간). 다시 시작하세요.', en: 'This upload expired (24 h). Start again.', id: 'Unggahan kedaluwarsa (24 jam).' },
  notChat: { ko: '내 채팅이 아닙니다.', en: 'Not one of your chats.', id: 'Bukan obrolan Anda.' },
  completing: { ko: '업로드를 마무리하는 중이라 취소할 수 없습니다.', en: 'The upload is being finished and cannot be canceled now.', id: 'Unggahan sedang diselesaikan dan tidak dapat dibatalkan.' },
  ruleFolder: { ko: '그룹·프로젝트 폴더나 권한 규칙이 걸린 폴더(또는 그런 폴더가 든 폴더)는 관리자만 옮기거나 이름을 바꾸거나 지울 수 있습니다.', en: 'Group, project and rule folders (and folders that contain one) can only be moved, renamed or deleted by an admin.', id: 'Folder grup, proyek, dan folder berizin (atau yang berisi folder tersebut) hanya dapat dipindah, diganti nama, atau dihapus oleh admin.' },
  ruleFolderToUsers: { ko: '그룹·프로젝트 폴더나 권한 규칙이 걸린 폴더는 개인 폴더(users/) 안으로 옮길 수 없습니다.', en: 'Group, project and rule folders cannot be moved into a personal folder (users/).', id: 'Folder grup, proyek, dan folder berizin tidak dapat dipindah ke folder pribadi (users/).' },
  audienceNarrowed: { ko: '개인 폴더로 옮기면 지금 이 항목을 보는 다른 사람들이 더 이상 볼 수 없습니다. 확인한 뒤 다시 시도하세요.', en: 'Moving this into your personal folder means the other people who can see it now will lose it. Confirm to continue.', id: 'Memindahkan ini ke folder pribadi membuat orang lain yang kini bisa melihatnya kehilangan akses. Konfirmasi untuk melanjutkan.' },
  folderInTrash: { ko: '이 버전의 폴더가 휴지통에 있습니다. 휴지통에서 폴더를 먼저 되돌린 뒤 버전을 되돌리세요.', en: 'The folder of this version is in the trash. Restore the folder from the trash first, then the version.', id: 'Folder versi ini ada di tempat sampah. Pulihkan foldernya dulu, lalu versinya.' },
  restoreTaken: { ko: '같은 이름이 있어 되돌릴 수 없습니다.', en: 'Cannot restore: the name is taken.', id: 'Tidak dapat dipulihkan: nama sudah dipakai.' },
} satisfies Record<string, Msg>
export type MsgKey = keyof typeof MSG

type Params = Record<string, string | number | boolean>
export const httpError = (code: ConstructorParameters<typeof HttpError>[0], key: MsgKey, locale: Locale, fields?: Record<string, string>, params?: Params) =>
  new HttpError(code, MSG[key][locale], { ...(fields ? { fields } : {}), ...(params ? { params } : {}) })

/** Thrown by the file services (which don't know the caller's language); the route layer localizes it. */
export class FileError extends Error {
  constructor(readonly code: ConstructorParameters<typeof HttpError>[0], readonly key: MsgKey, readonly fields?: Record<string, string>, readonly params?: Params) {
    super(MSG[key].en)
    this.name = 'FileError'
  }
}
export function fileError(code: FileError['code'], key: MsgKey, fields?: Record<string, string>, params?: Params): never { throw new FileError(code, key, fields, params) }

/** Translate a policy / file-tool error into an HttpError (other errors pass through). */
export function toHttp(e: unknown, locale: Locale, field = 'path'): unknown {
  if (e instanceof HttpError) return e
  if (e instanceof FileError) return httpError(e.code, e.key, locale, e.fields, e.params)
  if (e instanceof Denied) {
    const m = e.message
    if (m.startsWith('not found or no access')) return new HttpError('not_found')
    if (m.startsWith('read-only')) return httpError('forbidden', 'readOnly', locale)
    // the policy text names the existing sibling: it never goes into `fields` (only a fixed reason does), so even a
    // future change to the clash check cannot put a hidden name into an HTTP answer
    if (m.includes('already exists with almost the same name')) return httpError('conflict', 'nearDuplicate', locale, { [field]: 'an item with almost the same name already exists' })
    if (m.startsWith('not a folder')) return httpError('validation', 'notFolder', locale, { [field]: m })
    if (/symbolic link|hard-linked|not a regular file|path changed|resolves outside|ambiguous|cannot open folder/.test(m)) return httpError('conflict', 'unsafe', locale, { [field]: m })
    return httpError('validation', 'badName', locale, { [field]: m })
  }
  if (e instanceof ToolError) {
    switch (e.code) {
      case 'not_found': return new HttpError('not_found')
      case 'is_folder': return httpError('validation', 'isFolder', locale, { [field]: e.message })
      case 'not_folder': return httpError('validation', 'notFolder', locale, { [field]: e.message })
      case 'conflict': return new HttpError('conflict', e.message)
    }
    if (/too large/.test(e.message)) return httpError('payload_too_large', 'tooLarge', locale)
    return new HttpError('bad_request', e.message)
  }
  return e
}

/** Run fn, translating policy errors. */
export async function mapErrors<T>(locale: Locale, fn: () => T | Promise<T>, field?: string): Promise<T> {
  try { return await fn() } catch (e) { throw toHttp(e, locale, field) }
}
