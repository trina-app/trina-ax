// Policy / tool errors -> HTTP errors for the file screen. "No access" and "not found" stay the same not_found
// (hidden folders must not leak); read-only is forbidden; name problems are validation with the reason in `fields`.
import type { Locale } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { Denied, ToolError } from '../policy/errors'

type Msg = Record<Locale, string>
export const MSG = {
  readOnly: { ko: '읽기 전용이라 바꿀 수 없습니다.', en: 'This is read-only for you.', id: 'Ini hanya bisa dibaca oleh Anda.', ja: "この項目は読み取り専用のため、変更できません。", es: "Solo tiene permiso de lectura." },
  badName: { ko: '이름에 쓸 수 없는 글자나 형식이 있습니다.', en: 'The name contains characters or a form that is not allowed.', id: 'Nama berisi karakter atau bentuk yang tidak diizinkan.', ja: "名前に使用できない文字または形式が含まれています。", es: "El nombre contiene caracteres o un formato no permitido." },
  nearDuplicate: { ko: '거의 같은 이름(대소문자·글자 모양만 다름)이 이미 있습니다. 그 이름을 쓰거나 다른 이름을 고르세요.', en: 'An item with almost the same name (differs only by case or character form) exists. Use that name or pick a clearly different one.', id: 'Sudah ada item dengan nama hampir sama (hanya beda huruf besar/kecil atau bentuk karakter).', ja: "大文字・小文字や文字の形式だけが異なる、ほぼ同じ名前の項目が存在します。その名前を使うか、明確に異なる名前を選んでください。", es: "Existe un elemento con un nombre casi igual (solo cambia el uso de mayúsculas o la forma de los caracteres). Use ese nombre o elija uno claramente distinto." },
  exists: { ko: '같은 이름이 이미 있습니다.', en: 'An item with this name already exists.', id: 'Item dengan nama ini sudah ada.', ja: "同名の項目が存在します。", es: "Ya existe un elemento con este nombre." },
  isFolder: { ko: '폴더입니다. 파일을 고르세요.', en: 'This is a folder; pick a file.', id: 'Ini folder; pilih berkas.', ja: "これはフォルダーです。ファイルを選んでください。", es: "Es una carpeta; elija un archivo." },
  notFolder: { ko: '폴더가 아닙니다.', en: 'This is not a folder.', id: 'Ini bukan folder.', ja: "これはフォルダーではありません。", es: "No es una carpeta." },
  tooLarge: { ko: '파일이 너무 큽니다.', en: 'The file is too large.', id: 'Berkas terlalu besar.', ja: "ファイルが大きすぎます。", es: "El archivo es demasiado grande." },
  unsafe: { ko: '이 경로는 안전하게 다룰 수 없습니다(링크·이상한 이름).', en: 'This path cannot be handled safely (link or unusual name).', id: 'Jalur ini tidak dapat ditangani dengan aman.', ja: "このパスは安全に処理できません（リンクまたは特殊な名前）。", es: "Esta ruta no se puede procesar de forma segura (enlace o nombre inusual)." },
  notText: { ko: '텍스트 파일만 여기서 저장할 수 있습니다.', en: 'Only text files can be saved here.', id: 'Hanya berkas teks yang dapat disimpan di sini.', ja: "ここに保存できるのはテキストファイルのみです。", es: "Aquí solo se pueden guardar archivos de texto." },
  hiddenInside: { ko: '안에 내가 볼 수 없거나 바꿀 수 없는 폴더가 있어서 할 수 없습니다.', en: 'It contains folders you cannot see or change.', id: 'Di dalamnya ada folder yang tidak bisa Anda lihat atau ubah.', ja: "閲覧または変更できないフォルダーが含まれています。", es: "Contiene carpetas que no puede ver o modificar." },
  protectedFolder: { ko: '이 폴더는 옮기거나 지울 수 없습니다.', en: 'This folder cannot be moved or deleted.', id: 'Folder ini tidak dapat dipindah atau dihapus.', ja: "このフォルダーは移動・削除できません。", es: "Esta carpeta no se puede mover ni eliminar." },
  intoItself: { ko: '폴더를 자기 안으로 옮길 수 없습니다.', en: 'A folder cannot be moved into itself.', id: 'Folder tidak dapat dipindah ke dalam dirinya sendiri.', ja: "フォルダーを自分自身の中に移動することはできません。", es: "Una carpeta no puede moverse dentro de sí misma." },
  noBlob: { ko: '이 버전의 내용이 남아 있지 않습니다.', en: 'The content of this version is no longer kept.', id: 'Isi versi ini sudah tidak disimpan.', ja: "このバージョンの内容はもう保持されていません。", es: "El contenido de esta versión ya no se conserva." },
  diskFull: { ko: '서버 저장 공간이 부족합니다.', en: 'The server is running out of disk space.', id: 'Ruang disk server hampir habis.', ja: "サーバーのディスク容量が不足しています。", es: "El servidor se está quedando sin espacio en disco." },
  tooManySessions: { ko: '진행 중인 큰 업로드가 너무 많습니다. 끝나거나 취소된 뒤 다시 하세요.', en: 'Too many unfinished large uploads. Finish or cancel some first.', id: 'Terlalu banyak unggahan besar yang belum selesai.', ja: "未完了の大容量アップロードが多すぎます。先にいくつか完了またはキャンセルしてください。", es: "Hay demasiadas cargas grandes sin terminar. Complete o cancele algunas primero." },
  missingChunks: { ko: '아직 받지 못한 조각이 있습니다.', en: 'Some chunks have not arrived yet.', id: 'Beberapa potongan belum diterima.', ja: "まだ届いていないチャンクがあります。", es: "Aún no han llegado algunos fragmentos." },
  checksum: { ko: '받은 파일의 sha256이 맞지 않습니다. 처음부터 다시 올려 주세요.', en: 'The sha256 of the received file does not match. Upload it again.', id: 'sha256 berkas tidak cocok. Unggah ulang.', ja: "受信したファイルのsha256が一致しません。再アップロードしてください。", es: "El sha256 del archivo recibido no coincide. Vuelva a subirlo." },
  chunkSize: { ko: '조각 크기가 맞지 않습니다.', en: 'Wrong chunk size.', id: 'Ukuran potongan salah.', ja: "チャンクのサイズが正しくありません。", es: "Tamaño de fragmento incorrecto." },
  expired: { ko: '업로드가 만료되었습니다(24시간). 다시 시작하세요.', en: 'This upload expired (24 h). Start again.', id: 'Unggahan kedaluwarsa (24 jam).', ja: "このアップロードは期限切れです（24時間）。やり直してください。", es: "Esta carga venció (24 h). Vuelva a empezar." },
  notChat: { ko: '내 채팅이 아닙니다.', en: 'Not one of your chats.', id: 'Bukan obrolan Anda.', ja: "自分のチャットではありません。", es: "No es uno de sus chats." },
  completing: { ko: '업로드를 마무리하는 중이라 취소할 수 없습니다.', en: 'The upload is being finished and cannot be canceled now.', id: 'Unggahan sedang diselesaikan dan tidak dapat dibatalkan.', ja: "アップロードの完了処理中のため、今はキャンセルできません。", es: "La carga se está finalizando y no se puede cancelar ahora." },
  ruleFolder: { ko: '그룹·프로젝트 폴더나 권한 규칙이 걸린 폴더(또는 그런 폴더가 든 폴더)는 관리자만 옮기거나 이름을 바꾸거나 지울 수 있습니다.', en: 'Group, project and rule folders (and folders that contain one) can only be moved, renamed or deleted by an admin.', id: 'Folder grup, proyek, dan folder berizin (atau yang berisi folder tersebut) hanya dapat dipindah, diganti nama, atau dihapus oleh admin.', ja: "グループやプロジェクトのフォルダー、および権限ルールが設定されたフォルダー（またはそれらを含むフォルダー）を移動・名前変更・削除できるのは管理者のみです。", es: "Solo un administrador puede mover, cambiar el nombre o eliminar carpetas de grupos o proyectos y carpetas con reglas de permisos, o carpetas que las contengan." },
  ruleFolderToUsers: { ko: '그룹·프로젝트 폴더나 권한 규칙이 걸린 폴더는 개인 폴더(users/) 안으로 옮길 수 없습니다.', en: 'Group, project and rule folders cannot be moved into a personal folder (users/).', id: 'Folder grup, proyek, dan folder berizin tidak dapat dipindah ke folder pribadi (users/).', ja: "グループやプロジェクトのフォルダー、および権限ルールが設定されたフォルダーは個人フォルダー（users/）に移動できません。", es: "Las carpetas de grupos o proyectos y carpetas con reglas de permisos no pueden moverse a una carpeta personal (users/)." },
  audienceNarrowed: { ko: '개인 폴더로 옮기면 지금 이 항목을 보는 다른 사람들이 더 이상 볼 수 없습니다. 확인한 뒤 다시 시도하세요.', en: 'Moving this into your personal folder means the other people who can see it now will lose it. Confirm to continue.', id: 'Memindahkan ini ke folder pribadi membuat orang lain yang kini bisa melihatnya kehilangan akses. Konfirmasi untuk melanjutkan.', ja: "個人フォルダーに移動すると、現在閲覧できるほかの人がアクセスできなくなります。確認して続けてください。", es: "Al moverlo a su carpeta personal, las demás personas que ahora pueden verlo perderán el acceso. Confirme para continuar." },
  folderInTrash: { ko: '이 버전의 폴더가 휴지통에 있습니다. 휴지통에서 폴더를 먼저 되돌린 뒤 버전을 되돌리세요.', en: 'The folder of this version is in the trash. Restore the folder from the trash first, then the version.', id: 'Folder versi ini ada di tempat sampah. Pulihkan foldernya dulu, lalu versinya.', ja: "このバージョンのフォルダーはゴミ箱にあります。先にフォルダーをゴミ箱から復元し、その後バージョンを復元してください。", es: "La carpeta de esta versión está en la papelera. Restaure primero la carpeta y después la versión." },
  noPreview: { ko: '\uc774 \ud30c\uc77c\uc740 \ubbf8\ub9ac \ubcfc \uc218 \uc5c6\uc2b5\ub2c8\ub2e4. \ub0b4\ub824\ubc1b\uc544 \uc5f4\uc5b4 \uc8fc\uc138\uc694.', en: 'This file cannot be previewed. Download it to open it.', id: 'Berkas ini tidak bisa dipratinjau. Unduh untuk membukanya.', ja: "このファイルはプレビューできません。ダウンロードして開いてください。", es: "Este archivo no admite vista previa. Descárguelo para abrirlo." },
  previewBusy: { ko: '\uc0ac\uc9c4 \ubbf8\ub9ac\ubcf4\uae30\ub97c \ub9cc\ub4dc\ub294 \uc0ac\ub78c\uc774 \ub9ce\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ub4a4\uc5d0 \ub2e4\uc2dc \uc2dc\ub3c4\ud558\uc138\uc694.', en: 'Many photo previews are being made now. Try again in a moment.', id: 'Banyak pratinjau foto sedang dibuat. Coba lagi sebentar lagi.', ja: "多数の写真のプレビューを作成中です。しばらくしてから再試行してください。", es: "Se están generando muchas vistas previas de fotos. Vuelva a intentarlo en un momento." },
  restoreTaken: { ko: '같은 이름이 있어 되돌릴 수 없습니다.', en: 'Cannot restore: the name is taken.', id: 'Tidak dapat dipulihkan: nama sudah dipakai.', ja: "同じ名前が使用されているため復元できません。", es: "No se puede restaurar: el nombre ya está en uso." },
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
      case 'too_large': return httpError('payload_too_large', 'tooLarge', locale)
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
