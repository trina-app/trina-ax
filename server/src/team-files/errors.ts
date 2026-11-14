import { SAFE_OPS_TEXT } from '../safe-ops/strings'
// Policy / tool errors -> HTTP errors for the file screen. "No access" and "not found" stay the same not_found
// (hidden folders must not leak); read-only is forbidden; name problems are validation with the reason in `fields`.
import type { Locale } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { Denied, ToolError } from '../policy/errors'
import { TEXT as CHAT_TEXT } from '../chat/i18n'

type Msg = Record<Locale, string>
export const MSG = {
  readOnly: { ko: '읽기 전용이라 바꿀 수 없어요.', en: 'This is read-only for you.', id: 'Ini hanya bisa dibaca oleh Anda.', ja: "この項目は読み取り専用のため、変更できません。", es: "Solo tiene permiso de lectura.", zh: "你对此只有只读权限。" },
  badName: { ko: '이름에 쓸 수 없는 글자나 형식이 있어요.', en: 'The name contains characters or a form that is not allowed.', id: 'Nama berisi karakter atau bentuk yang tidak diizinkan.', ja: "名前に使用できない文字または形式が含まれています。", es: "El nombre contiene caracteres o un formato no permitido.", zh: "名称中包含不允许的字符或格式。" },
  nearDuplicate: { ko: '거의 같은 이름(대소문자·글자 모양만 다름)이 이미 있어요. 그 이름을 쓰거나 다른 이름을 골라 주세요.', en: 'An item with almost the same name (differs only by case or character form) exists. Use that name or pick a clearly different one.', id: 'Sudah ada item dengan nama hampir sama (hanya beda huruf besar/kecil atau bentuk karakter).', ja: "大文字・小文字や文字の形式だけが異なる、ほぼ同じ名前の項目が存在します。その名前を使うか、明確に異なる名前を選んでください。", es: "Existe un elemento con un nombre casi igual (solo cambia el uso de mayúsculas o la forma de los caracteres). Use ese nombre o elija uno claramente distinto.", zh: "已有一个名称几乎相同的项目（只有大小写或字符形式不同）。请使用那个名称，或换一个明显不同的名称。" },
  exists: { ko: '같은 이름이 이미 있어요.', en: 'An item with this name already exists.', id: 'Item dengan nama ini sudah ada.', ja: "同名の項目が存在します。", es: "Ya existe un elemento con este nombre.", zh: "已有同名的项目。" },
  isFolder: { ko: '폴더예요. 파일을 골라 주세요.', en: 'This is a folder; pick a file.', id: 'Ini folder; pilih berkas.', ja: "これはフォルダーです。ファイルを選んでください。", es: "Es una carpeta; elija un archivo.", zh: "这是文件夹，请选择文件。" },
  notFolder: { ko: '폴더가 아니에요.', en: 'This is not a folder.', id: 'Ini bukan folder.', ja: "これはフォルダーではありません。", es: "No es una carpeta.", zh: "这不是文件夹。" },
  tooLarge: { ko: '파일이 너무 커요.', en: 'The file is too large.', id: 'Berkas terlalu besar.', ja: "ファイルが大きすぎます。", es: "El archivo es demasiado grande.", zh: "文件太大。" },
  unsafe: { ko: '이 경로는 안전하게 다룰 수 없어요(링크·이상한 이름).', en: 'This path cannot be handled safely (link or unusual name).', id: 'Jalur ini tidak dapat ditangani dengan aman.', ja: "このパスは安全に処理できません（リンクまたは特殊な名前）。", es: "Esta ruta no se puede procesar de forma segura (enlace o nombre inusual).", zh: "无法安全处理此路径（链接或特殊名称）。" },
  notText: { ko: '텍스트 파일만 여기서 저장할 수 있어요.', en: 'Only text files can be saved here.', id: 'Hanya berkas teks yang dapat disimpan di sini.', ja: "ここに保存できるのはテキストファイルのみです。", es: "Aquí solo se pueden guardar archivos de texto.", zh: "这里只能保存文本文件。" },
  hiddenInside: { ko: '안에 내가 볼 수 없거나 바꿀 수 없는 폴더가 있어서 할 수 없어요.', en: 'It contains folders you cannot see or change.', id: 'Di dalamnya ada folder yang tidak bisa Anda lihat atau ubah.', ja: "閲覧または変更できないフォルダーが含まれています。", es: "Contiene carpetas que no puede ver o modificar.", zh: "其中包含你无法查看或更改的文件夹。" },
  projectFolderStays: { ko: '프로젝트 폴더는 프로젝트 안에만 둘 수 있어요. 대신 파일을 복사해 주세요.', en: "A project's folder stays in Projects. Copy its files instead.", id: 'Folder proyek tetap berada di Proyek. Salin berkasnya saja.', ja: "プロジェクトのフォルダーはプロジェクトの中にしか置けません。代わりにファイルをコピーしてください。", es: "La carpeta de un proyecto se queda en Proyectos. Copia sus archivos en su lugar.", zh: "项目的文件夹必须留在“项目”中。请改为复制其中的文件。" },
  protectedFolder: { ko: '이 폴더는 옮기거나 지울 수 없어요.', en: 'This folder cannot be moved or deleted.', id: 'Folder ini tidak dapat dipindah atau dihapus.', ja: "このフォルダーは移動・削除できません。", es: "Esta carpeta no se puede mover ni eliminar.", zh: "此文件夹不能移动或删除。" },
  intoItself: { ko: '폴더를 자기 안으로 옮길 수 없어요.', en: 'A folder cannot be moved into itself.', id: 'Folder tidak dapat dipindah ke dalam dirinya sendiri.', ja: "フォルダーを自分自身の中に移動することはできません。", es: "Una carpeta no puede moverse dentro de sí misma.", zh: "文件夹不能移动到它自己里面。" },
  noBlob: { ko: '이 버전의 내용이 남아 있지 않아요.', en: 'The content of this version is no longer kept.', id: 'Isi versi ini sudah tidak disimpan.', ja: "このバージョンの内容はもう保持されていません。", es: "El contenido de esta versión ya no se conserva.", zh: "此版本的内容已不再保留。" },
  diskFull: { ko: '서버 저장 공간이 부족해요.', en: 'The server is running out of disk space.', id: 'Ruang disk server hampir habis.', ja: "サーバーのディスク容量が不足しています。", es: "El servidor se está quedando sin espacio en disco.", zh: "服务器磁盘空间快用完了。" },
  tooManySessions: { ko: '진행 중인 큰 업로드가 너무 많아요. 끝나거나 취소된 뒤 다시 해 주세요.', en: 'Too many unfinished large uploads. Finish or cancel some first.', id: 'Terlalu banyak unggahan besar yang belum selesai.', ja: "未完了の大容量アップロードが多すぎます。先にいくつか完了またはキャンセルしてください。", es: "Hay demasiadas cargas grandes sin terminar. Complete o cancele algunas primero.", zh: "未完成的大文件上传太多。请先完成或取消一些。" },
  missingChunks: { ko: '아직 받지 못한 조각이 있어요.', en: 'Some chunks have not arrived yet.', id: 'Beberapa potongan belum diterima.', ja: "まだ届いていないチャンクがあります。", es: "Aún no han llegado algunos fragmentos.", zh: "部分分块还没有到达。" },
  checksum: { ko: '받은 파일의 sha256이 맞지 않아요. 처음부터 다시 올려 주세요.', en: 'The sha256 of the received file does not match. Upload it again.', id: 'sha256 berkas tidak cocok. Unggah ulang.', ja: "受信したファイルのsha256が一致しません。再アップロードしてください。", es: "El sha256 del archivo recibido no coincide. Vuelva a subirlo.", zh: "收到的文件的 sha256 不匹配。请重新上传。" },
  chunkSize: { ko: '조각 크기가 맞지 않아요.', en: 'Wrong chunk size.', id: 'Ukuran potongan salah.', ja: "チャンクのサイズが正しくありません。", es: "Tamaño de fragmento incorrecto.", zh: "分块大小错误。" },
  incompleteUpload: { ko: '파일이 다 도착하지 않았어요. 다시 올려 주세요.', en: 'The file did not arrive whole. Upload it again.', id: 'Berkas tidak diterima utuh. Unggah ulang.', ja: "ファイルが完全に届きませんでした。再アップロードしてください。", es: "El archivo no llegó completo. Vuelva a subirlo.", zh: "文件没有完整到达。请重新上传。" },
  expired: { ko: '24시간 동안 받은 조각이 없어서 업로드가 끝났어요. 다시 시작해 주세요.', en: 'Nothing arrived for 24 hours, so this upload ended. Start it again.', id: 'Tidak ada yang masuk selama 24 jam, jadi unggahan ini berakhir. Mulai lagi.', ja: "24時間何も届かなかったため、このアップロードは終了しました。もう一度始めてください。", es: "No llegó nada en 24 horas, así que esta carga terminó. Vuelva a empezarla.", zh: "24小时内没有收到任何内容，此次上传已结束。请重新开始。" },
  expiredMax: { ko: '업로드는 시작하고 7일 안에 끝내야 해요. 7일이 지나서 이 업로드가 끝났어요. 다시 시작해 주세요.', en: 'An upload has to finish within 7 days of its start. This one passed 7 days and ended. Start it again.', id: 'Unggahan harus selesai dalam 7 hari sejak dimulai. Unggahan ini melewati 7 hari dan berakhir. Mulai lagi.', ja: "アップロードは開始から7日以内に終える必要があります。7日を過ぎたため、このアップロードは終了しました。もう一度始めてください。", es: "Una carga debe terminar en los 7 días desde que empezó. Esta pasó los 7 días y terminó. Vuelva a empezarla.", zh: "上传必须在开始后7天内完成。此次上传已超过7天并已结束。请重新开始。" },
  uploadLost: { ko: '이 업로드는 더 이어서 할 수 없어요. 다시 시작해 주세요.', en: 'This upload cannot go on. Start it again.', id: 'Unggahan ini tidak bisa dilanjutkan. Mulai lagi.', ja: "このアップロードは続けられません。もう一度始めてください。", es: "Esta carga no puede continuar. Vuelva a empezarla.", zh: "此次上传无法继续。请重新开始。" },
  notChat: { ko: '내 채팅이 아니에요.', en: 'Not one of your chats.', id: 'Bukan obrolan Anda.', ja: "自分のチャットではありません。", es: "No es uno de sus chats.", zh: "这不是你的对话。" },
  // a file from the computer in a shared project chat goes into the project folder (uploads/shared-chat.ts): only for
  // someone who may write there; while safe operations are on, shared chats are read-only (chat/shared.ts chatFor)
  sharedUploadReadOnly: { ko: "이 프로젝트 폴더에 쓸 권한이 없어서 컴퓨터의 파일을 올리지 못했어요. 팀 폴더에 있는 파일은 '팀 파일에서 추가'로 붙일 수 있어요. 쓰기 권한이 필요하면 관리자에게 요청해 주세요.", en: "You can't add files to this project's folder, so a file from your computer can't be attached here. Files already in the team folder can be attached with \"Add from team files\". To get write access, ask an admin.", id: "Anda tidak bisa menambah berkas ke folder proyek ini, jadi berkas dari komputer tidak bisa dilampirkan di sini. Berkas yang sudah ada di folder tim bisa dilampirkan dengan \"Tambah dari berkas tim\". Untuk mendapat akses tulis, minta admin.", ja: "このプロジェクトのフォルダーに書き込む権限がないため、パソコンのファイルは添付できません。チームのフォルダーにあるファイルは「チームのファイルから追加」で添付できます。書き込み権限が必要な場合は管理者に依頼してください。", es: "No puede añadir archivos a la carpeta de este proyecto, así que aquí no se puede adjuntar un archivo de su equipo. Los archivos que ya están en la carpeta del equipo se pueden adjuntar con «Añadir desde archivos del equipo». Para tener permiso de escritura, pídalo a un administrador.", zh: "你不能向此项目的文件夹添加文件，因此这里不能添加电脑上的文件作为附件。团队文件夹中已有的文件可以通过“从团队文件添加”添加为附件。如需写入权限，请联系管理员。" },
  sharedChatSafeOps: CHAT_TEXT.sharedChatSafeOps,
  completing: { ko: '업로드를 마무리하는 중이라 취소할 수 없어요.', en: 'The upload is being finished and cannot be canceled now.', id: 'Unggahan sedang diselesaikan dan tidak dapat dibatalkan.', ja: "アップロードの完了処理中のため、今はキャンセルできません。", es: "La carga se está finalizando y no se puede cancelar ahora.", zh: "上传正在收尾，现在无法取消。" },
  ruleFolder: { ko: '부서·프로젝트 폴더나 권한 규칙이 걸린 폴더(또는 그런 폴더가 든 폴더)는 관리자만 옮기거나 이름을 바꾸거나 지울 수 있어요.', en: 'Group, project and rule folders (and folders that contain one) can only be moved, renamed or deleted by an admin.', id: 'Folder grup, proyek, dan folder berizin (atau yang berisi folder tersebut) hanya dapat dipindah, diganti nama, atau dihapus oleh admin.', ja: "グループやプロジェクトのフォルダー、および権限ルールが設定されたフォルダー（またはそれらを含むフォルダー）を移動・名前変更・削除できるのは管理者のみです。", es: "Solo un administrador puede mover, cambiar el nombre o eliminar carpetas de grupos o proyectos y carpetas con reglas de permisos, o carpetas que las contengan.", zh: "小组、项目和带规则的文件夹（以及包含它们的文件夹）只能由管理员移动、重命名或删除。" },
  projectSkillsOn: { ko: '이 폴더를 projects/로 옮기면 안의 스킬이 이 프로젝트 채팅에서 켜져요.', en: 'Moved into projects/, the skills in this folder start to count in this project\'s chats.', id: 'Jika dipindah ke projects/, skill di folder ini mulai dipakai di chat proyek ini.', ja: "このフォルダーをprojects/に移動すると、中のスキルがこのプロジェクトのチャットで有効になります。", es: "Si se mueve a projects/, las habilidades de esta carpeta empiezan a usarse en los chats de este proyecto.", zh: "移到 projects/ 后，此文件夹中的技能会开始在该项目的对话中生效。" },
  ruleFolderToUsers: { ko: '부서·프로젝트 폴더나 권한 규칙이 걸린 폴더는 개인 폴더(users/) 안으로 옮길 수 없어요.', en: 'Group, project and rule folders cannot be moved into a personal folder (users/).', id: 'Folder grup, proyek, dan folder berizin tidak dapat dipindah ke folder pribadi (users/).', ja: "グループやプロジェクトのフォルダー、および権限ルールが設定されたフォルダーは個人フォルダー（users/）に移動できません。", es: "Las carpetas de grupos o proyectos y carpetas con reglas de permisos no pueden moverse a una carpeta personal (users/).", zh: "小组、项目和带规则的文件夹不能移到个人文件夹（users/）中。" },
  audienceNarrowed: { ko: '개인 폴더로 옮기면 지금 이 항목을 보는 다른 사람들이 더 이상 볼 수 없어요. 확인한 뒤 다시 시도해 주세요.', en: 'Moving this into your personal folder means the other people who can see it now will lose it. Confirm to continue.', id: 'Memindahkan ini ke folder pribadi membuat orang lain yang kini bisa melihatnya kehilangan akses. Konfirmasi untuk melanjutkan.', ja: "個人フォルダーに移動すると、現在閲覧できるほかの人がアクセスできなくなります。確認して続けてください。", es: "Al moverlo a su carpeta personal, las demás personas que ahora pueden verlo perderán el acceso. Confirme para continuar.", zh: "移到你的个人文件夹后，现在能看到它的其他人将看不到它。请确认后继续。" },
  audienceWidened: { ko: '개인 폴더에서 옮기면 지금은 볼 수 없는 다른 사람들도 이 항목을 보게 돼요. 확인한 뒤 다시 시도해 주세요.', en: 'Moving this out of your personal folder means more people will see it. Confirm to continue.', id: 'Memindahkan ini keluar dari folder pribadi membuat lebih banyak orang bisa melihatnya. Konfirmasi untuk melanjutkan.', ja: "個人フォルダーから移動すると、閲覧できる人が増えます。確認して続けてください。", es: "Al sacarlo de su carpeta personal, más personas podrán verlo. Confirme para continuar.", zh: "移出你的个人文件夹后，会有更多人看到它。请确认后继续。" },
  folderInTrash: { ko: '이 버전의 폴더가 휴지통에 있어요. 휴지통에서 폴더를 먼저 되돌린 뒤 버전을 되돌려 주세요.', en: 'The folder of this version is in the trash. Restore the folder from the trash first, then the version.', id: 'Folder versi ini ada di tempat sampah. Pulihkan foldernya dulu, lalu versinya.', ja: "このバージョンのフォルダーはゴミ箱にあります。先にフォルダーをゴミ箱から復元し、その後バージョンを復元してください。", es: "La carpeta de esta versión está en la papelera. Restaure primero la carpeta y después la versión.", zh: "此版本所在的文件夹在回收站中。请先从回收站恢复文件夹，再恢复此版本。" },
  noPreview: { ko: '\uc774 \ud30c\uc77c\uc740 \ubbf8\ub9ac \ubcfc \uc218 \uc5c6\uc2b5\ub2c8\ub2e4. \ub0b4\ub824\ubc1b\uc544 \uc5f4\uc5b4 \uc8fc\uc138\uc694.', en: 'This file cannot be previewed. Download it to open it.', id: 'Berkas ini tidak bisa dipratinjau. Unduh untuk membukanya.', ja: "このファイルはプレビューできません。ダウンロードして開いてください。", es: "Este archivo no admite vista previa. Descárguelo para abrirlo.", zh: "此文件无法预览。请下载后打开。" },
  previewBusy: { ko: '\uc0ac\uc9c4 \ubbf8\ub9ac\ubcf4\uae30\ub97c \ub9cc\ub4dc\ub294 \uc0ac\ub78c\uc774 \ub9ce\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ub4a4\uc5d0 \ub2e4\uc2dc \uc2dc\ub3c4\ud558\uc138\uc694.', en: 'Many photo previews are being made now. Try again in a moment.', id: 'Banyak pratinjau foto sedang dibuat. Coba lagi sebentar lagi.', ja: "多数の写真のプレビューを作成中です。しばらくしてから再試行してください。", es: "Se están generando muchas vistas previas de fotos. Vuelva a intentarlo en un momento.", zh: "正在生成大量照片预览。请稍后再试。" },
  pluginManaged: { ko: '플러그인이 관리하는 파일이라 여기서 바꿀 수 없어요. 관리 > 플러그인에서 업데이트하거나, 다른 폴더로 복사해 사본을 고쳐 주세요.', en: 'A plugin manages this, so it cannot be changed here. Update the plugin in Admin > Plugins, or copy it to another folder and edit the copy.', id: 'Ini dikelola plugin sehingga tidak dapat diubah di sini. Perbarui plugin di Admin > Plugin, atau salin ke folder lain lalu ubah salinannya.', ja: "プラグインが管理しているため、ここでは変更できません。管理 > プラグインで更新するか、別のフォルダーにコピーしてコピーを編集してください。", es: "Lo administra un complemento, así que no se puede cambiar aquí. Actualice el complemento en Administración > Complementos, o cópielo a otra carpeta y edite la copia.", zh: "此内容由插件管理，不能在这里更改。请在“管理 > 插件”中更新插件，或把它复制到其他文件夹后编辑副本。" },
  embedNarrower: { ko: '이 파일은 페이지를 볼 수 있는 사람 중 일부가 볼 수 없어서 페이지 미리보기에 넣지 않아요.', en: 'Some people who can see the page cannot see this file, so it is not put into the page preview.', id: 'Sebagian orang yang bisa melihat halaman ini tidak bisa melihat berkas ini, jadi berkas tidak dimasukkan ke pratinjau halaman.', ja: "このページを閲覧できる人の一部はこのファイルを閲覧できないため、ページのプレビューには入れません。", es: "Algunas personas que pueden ver la página no pueden ver este archivo, así que no se incluye en la vista previa de la página.", zh: "能看到此页面的部分人看不到这个文件，因此它不会放进页面预览中。" },
  projectThere: { ko: '다른 프로젝트가 그 자리의 폴더를 쓰고 있어요(폴더 하나에 프로젝트 하나). 다른 이름이나 다른 곳을 골라 주세요.', en: 'Another project uses the folder at that place (one project per folder). Pick another name or place.', id: 'Proyek lain memakai folder di tempat itu (satu proyek per folder). Pilih nama atau tempat lain.', ja: "その場所のフォルダーは別のプロジェクトが使っています（1つのフォルダーに1つのプロジェクト）。別の名前か場所を選んでください。", es: "Otro proyecto usa la carpeta de ese lugar (un proyecto por carpeta). Elija otro nombre u otro lugar.", zh: "该位置的文件夹已被另一个项目使用（一个文件夹只能对应一个项目）。请换一个名称或位置。" },
  htmlPdfNotHtml: { ko: 'HTML 파일만 PDF로 저장할 수 있어요.', en: 'Only an HTML file can be saved as a PDF.', id: 'Hanya berkas HTML yang dapat disimpan sebagai PDF.', ja: "PDFとして保存できるのはHTMLファイルだけです。", es: "Solo un archivo HTML se puede guardar como PDF.", zh: "只有 HTML 文件可以保存为 PDF。" },
  htmlPdfUnavailable: { ko: '이 서버에는 HTML을 PDF로 만드는 브라우저가 없어요. 관리자에게 알려 주세요.', en: 'This server has no browser to turn HTML into a PDF. Let your admin know.', id: 'Server ini tidak punya peramban untuk mengubah HTML menjadi PDF. Beri tahu admin Anda.', ja: "このサーバーにはHTMLをPDFにするブラウザーがありません。管理者に知らせてください。", es: "Este servidor no tiene un navegador para convertir HTML en PDF. Avise a su administrador.", zh: "此服务器没有可以把 HTML 转成 PDF 的浏览器。请告诉管理员。" },
  htmlPdfBusy: { ko: '지금 PDF를 만드는 사람이 많아요. 잠시 뒤에 다시 해 주세요.', en: 'Many PDFs are being made right now. Try again in a moment.', id: 'Banyak PDF sedang dibuat sekarang. Coba lagi sebentar lagi.', ja: "現在、多くのPDFを作成中です。しばらくしてから再試行してください。", es: "Ahora se están creando muchos PDF. Vuelva a intentarlo en un momento.", zh: "正在生成大量 PDF。请稍后再试。" },
  htmlPdfPages: { ko: '페이지가 너무 길어서 PDF로 만들 수 없어요(200쪽까지). 나눠서 저장해 주세요.', en: 'The page is too long to make a PDF (200 pages at most). Split it and save each part.', id: 'Halaman terlalu panjang untuk dijadikan PDF (maksimal 200 halaman). Pisahkan lalu simpan tiap bagian.', ja: "ページが長すぎるためPDFにできません（最大200ページ）。分割して保存してください。", es: "La página es demasiado larga para crear un PDF (200 páginas como máximo). Divídala y guarde cada parte.", zh: "页面太长，无法生成 PDF（最多200页）。请拆分后分别保存。" },
  htmlPdfTooLarge: { ko: '페이지가 너무 커서 PDF로 만들 수 없어요.', en: 'The page is too large to make a PDF.', id: 'Halaman terlalu besar untuk dijadikan PDF.', ja: "ページが大きすぎるためPDFにできません。", es: "La página es demasiado grande para crear un PDF.", zh: "页面太大，无法生成 PDF。" },
  htmlPdfTimeout: { ko: 'PDF를 만드는 데 시간이 너무 오래 걸려서 멈췄어요.', en: 'Making the PDF took too long and was stopped.', id: 'Pembuatan PDF terlalu lama dan dihentikan.', ja: "PDFの作成に時間がかかりすぎたため停止しました。", es: "Crear el PDF tardó demasiado y se detuvo.", zh: "生成 PDF 用时太长，已停止。" },
  htmlPdfCrossSite: { ko: 'PDF는 이 앱에서만 만들 수 있어요.', en: 'PDFs can only be made from this app.', id: 'PDF hanya dapat dibuat dari aplikasi ini.', ja: "PDFはこのアプリからのみ作成できます。", es: "Los PDF solo se pueden crear desde esta aplicación.", zh: "只能从此应用生成 PDF。" },
  htmlPdfWider: { ko: '이 페이지에 들어가는 파일 중 이 폴더를 보는 사람 모두가 볼 수는 없는 파일이 있어서 여기에 저장하지 않았어요.', en: 'Some files in this page cannot be seen by everyone who sees this folder, so the PDF was not saved here.', id: 'Beberapa berkas di halaman ini tidak bisa dilihat semua orang yang melihat folder ini, jadi PDF tidak disimpan di sini.', ja: "このページに含まれるファイルの一部は、このフォルダーを見るすべての人が閲覧できるわけではないため、PDFをここに保存しませんでした。", es: "Algunos archivos de esta página no los pueden ver todas las personas que ven esta carpeta, así que el PDF no se guardó aquí.", zh: "此页面中的部分文件不是所有能看到此文件夹的人都能看到，因此 PDF 没有保存到这里。" },
  htmlPdfFailed: { ko: '이 페이지를 PDF로 만들지 못했어요.', en: 'This page could not be made into a PDF.', id: 'Halaman ini tidak dapat dijadikan PDF.', ja: "このページをPDFにできませんでした。", es: "No se pudo crear un PDF de esta página.", zh: "无法把此页面生成为 PDF。" },
  restoreTaken: { ko: '같은 이름이 있어 되돌릴 수 없어요.', en: 'Cannot restore: the name is taken.', id: 'Tidak dapat dipulihkan: nama sudah dipakai.', ja: "同じ名前が使用されているため復元できません。", es: "No se puede restaurar: el nombre ya está en uso.", zh: "无法恢复：名称已被使用。" },
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
    // a skill pack's managed copy (server/src/plugins/manager.ts); the caller could write here, so naming it is fine
    if (m.startsWith('managed by the plugin')) return httpError('forbidden', 'pluginManaged', locale, undefined, { reason: 'plugin_managed' })
    // the policy text names the existing sibling: it never goes into `fields` (only a fixed reason does), so even a
    // future change to the clash check cannot put a hidden name into an HTTP answer
    if (m.includes('already exists with almost the same name')) return httpError('conflict', 'nearDuplicate', locale, { [field]: 'an item with almost the same name already exists' })
    if (m.startsWith('not a folder')) return httpError('validation', 'notFolder', locale, { [field]: m })
    if (/symbolic link|hard-linked|not a regular file|path changed|resolves outside|ambiguous|cannot open folder/.test(m)) return httpError('conflict', 'unsafe', locale, { [field]: m })
    return httpError('validation', 'badName', locale, { [field]: m })
  }
  if (e instanceof ToolError) {
    if (e.code === 'safe_ops_quarantined') return new HttpError('unavailable', SAFE_OPS_TEXT.quarantined[locale], {params:{reason:'quarantined'}})
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
