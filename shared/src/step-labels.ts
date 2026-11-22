// Words of the step list under an answer ("Read · shared/fruit.md", "Remembered: …", "Thinking"), in ko / en / id.
// The server stores a label in the language of the person who ran the answer (older readers show it as is); the web
// app redraws it in the language on screen from these same words, so an old chat follows a later language switch
// (docs/DECISIONS.md "언어"). A label is always "<words> + what the AI touched" (a path, a query, a remembered text),
// and only the words are translated. On screen, a path's well-known team folders are said in words (stepPlace).
import type { Locale } from './api/common'
import { BRAND_FOLDER, BRAND_IMAGES_FOLDER, NOTES_FOLDER } from './api/onboarding-packs'
import { ownFolderLabel, ownFolderWord, TOP_FOLDER_LABELS } from './folder-labels'
import { mediaKind, type MediaKind } from './media'
import { parsePlace } from './places'
import { maskSecrets } from './secrets'
import { trustedServiceName } from './service-catalog'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

/** Verb of a file / team tool step: "<verb> · <path>". */
export const FILE_STEP_VERB: Record<string, T> = {
  list: t('폴더 보기', 'List', 'Lihat folder', "一覧", "Listar", "查看文件夹"),
  glob: t('파일 찾기', 'Find files', 'Cari berkas', "ファイルを探す", "Buscar archivos", "查找文件"),
  grep: t('내용 검색', 'Search', 'Cari isi', "検索", "Buscar", "搜索"),
  read: t('파일 읽기', 'Read', 'Baca berkas', "読み取り", "Leer", "读取"),
  write: t('파일 저장', 'Save', 'Simpan berkas', "保存", "Guardar", "保存"),
  edit: t('파일 수정', 'Edit', 'Ubah berkas', "編集", "Editar", "编辑"),
  edit_files: t('여러 파일 수정', 'Edit files', 'Ubah beberapa berkas', "複数のファイルを編集", "Editar archivos", "编辑多个文件"),
  make_file: t('파일 만들기', 'Make file', 'Buat berkas', "ファイルを作成", "Crear archivo", "创建文件"),
  edit_hwp: t('한글 문서 고치기', 'Edit Hangul document', 'Ubah dokumen Hangul', "ハングル文書を編集", "Editar documento Hangul", "编辑韩文（HWP）文档"),
  stamp_pdf: t('PDF에 이미지 찍기', 'Stamp PDF', 'Bubuhkan gambar ke PDF', "PDFに画像を押す", "Estampar en PDF", "在PDF上盖图"),
  edit_pdf: t('PDF 고치기', 'Edit PDF', 'Ubah PDF', "PDFを編集", "Editar PDF", "编辑PDF"),
  merge_pdfs: t('PDF 합치기', 'Merge PDFs', 'Gabungkan PDF', "PDFを結合", "Combinar PDF", "合并PDF"),
  split_pdf: t('PDF 나누기', 'Split PDF', 'Pisahkan PDF', "PDFを分割", "Dividir PDF", "拆分PDF"),
  resize_images: t('사진 크기 줄이기', 'Resize photos', 'Perkecil foto', "写真を縮小", "Reducir fotos", "缩小照片"),
  unzip_file: t('압축 풀기', 'Unzip', 'Ekstrak zip', "ZIPを展開", "Descomprimir", "解压缩"),
  make_zip: t('압축 파일 만들기', 'Make a zip', 'Buat zip', "ZIPを作成", "Crear zip", "创建压缩包"),
  query_data: t('데이터 계산', 'Calculate data', 'Hitung data', "データを集計", "Calcular datos", "计算数据"),
  share_file: t('파일 공유 링크', 'Share link', 'Tautan berkas', "リンクを共有", "Compartir enlace", "分享链接"),
  move_files: t('파일 옮기기', 'Move files', 'Pindahkan berkas', "ファイルを移動", "Mover archivos", "移动文件"),
  copy_files: t('파일 복사', 'Copy files', 'Salin berkas', "ファイルをコピー", "Copiar archivos", "复制文件"),
  rename_file: t('이름 바꾸기', 'Rename', 'Ganti nama', "名前を変更", "Cambiar nombre", "重命名"),
  rename_files: t('이름 여러 개 바꾸기', 'Rename files', 'Ganti nama berkas', "複数の名前を変更", "Cambiar nombres", "批量重命名"),
  delete_files: t('휴지통으로 옮기기', 'Move to trash', 'Pindahkan ke tempat sampah', "ゴミ箱に移動", "Mover a la papelera", "移到回收站"),
  artifact: t('화면 만들기', 'Make a page', 'Buat halaman', "画面を作成", "Crear una página", "制作页面"),
  web_fetch: t('웹 페이지 가져오기', 'Fetch page', 'Ambil halaman', "ページを取得", "Obtener página", "获取网页"),
  save_url: t('파일 받아 저장', 'Download file', 'Unduh berkas', "ファイルをダウンロード", "Descargar archivo", "下载文件"),
  // a Gmail attachment or a Drive file saved as the original file (server/src/tools/save-connector-file.ts)
  save_connector_file: t('원본 파일 저장', 'Save original file', 'Simpan berkas asli', "元のファイルを保存", "Guardar archivo original", "保存原始文件"),
  hwp_render: t('한글 문서 쪽 보기', 'View Hangul document page', 'Lihat halaman dokumen Hangul', "ハングル文書のページを表示", "Ver página del documento Hangul", "查看韩文（HWP）文档页面"),
  // the removed search by meaning tool and the removed knowledge graph's tool (docs/DECISIONS.md, 2026-11-11): their
  // steps stay in older chats
  search: t('뜻으로 찾기', 'Search by meaning', 'Cari berdasarkan makna', "意味で検索", "Buscar por significado", "按含义搜索"),
  knowledge_explore: t('자료 지도에서 찾기', 'Search the file map', 'Cari di peta berkas', "資料マップで探す", "Buscar en el mapa de archivos", "在文件地图中搜索"),
  schedule_create: t('예약 작업 만들기', 'Create scheduled task', 'Buat tugas terjadwal', "定期タスクを作成", "Crear tarea programada", "创建定时任务"),
  schedule_list: t('예약 작업 보기', 'List scheduled tasks', 'Lihat tugas terjadwal', "定期タスクを一覧表示", "Listar tareas programadas", "查看定时任务"),
  schedule_delete: t('예약 작업 지우기', 'Delete scheduled task', 'Hapus tugas terjadwal', "定期タスクを削除", "Eliminar tarea programada", "删除定时任务"),
  drive_search: t('Google Drive 검색', 'Search Google Drive', 'Cari di Google Drive', "Google ドライブを検索", "Buscar en Google Drive", "搜索Google Drive"),
  drive_list: t('Google Drive 폴더 보기', 'List Google Drive folder', 'Lihat folder Google Drive', "Google ドライブのフォルダを表示", "Listar carpeta de Google Drive", "查看Google Drive文件夹"),
  drive_read: t('Google Drive 파일 읽기', 'Read Google Drive file', 'Baca berkas Google Drive', "Google ドライブのファイルを読む", "Leer archivo de Google Drive", "读取Google Drive文件"),
  // the free-roam demo's banner words, drawn on the server (server/src/tools/demo-banner.ts): never a Higgsfield step
  change_banner_text: t('배너 글자 바꾸기', 'Change banner text', 'Ubah teks banner', "バナーの文字を変更", "Cambiar texto del banner", "更改横幅文字"),
  generate_video: t('동영상 만들기', 'Generate video', 'Buat video', "動画を生成", "Generar video", "生成视频"),
  comment_docx: t('워드 메모 달기', 'Add Word comments', 'Tambah komentar Word', "Wordにコメントを追加", "Añadir comentarios en Word", "添加 Word 批注"),
  edit_office: t('오피스 파일 고치기', 'Edit Office file', 'Ubah berkas Office', "Officeファイルを編集", "Editar archivo de Office", "编辑 Office 文件"),
  promo_video: t('홍보 영상 만들기', 'Make promo video', 'Buat video promosi', "プロモーション動画を作成", "Crear vídeo promocional", "制作宣传视频"),
  promo_video_versions: t('홍보 영상 버전 보기', 'View promo video versions', 'Lihat versi video promosi', 'プロモーション動画のバージョンを見る', 'Ver versiones del vídeo promocional', '查看宣传视频版本'),
  save_promo_video: t('홍보 영상 파일로 저장', 'Save promo video as a file', 'Simpan video promosi sebagai berkas', "プロモーション動画をファイルに保存", "Guardar el vídeo promocional como archivo", "将宣传视频保存为文件"),
  intro_deck: t('회사 소개서 만들기', 'Make company profile', 'Buat profil perusahaan', "会社紹介資料を作成", "Crear presentación corporativa", "制作公司介绍"),
  box_shell: t('개발 환경 명령', 'Dev environment command', 'Perintah lingkungan pengembangan', "開発環境のコマンド", "Comando del entorno de desarrollo", "开发环境命令"),
  ask_user: t('질문', 'Question', 'Pertanyaan', "質問", "Pregunta", "提问"),
  skill: t('스킬 사용', 'Use skill', 'Pakai skill', "スキルを使用", "Usar habilidad", "使用技能"),
  find_skills: t('스킬 찾기', 'Find skills', 'Cari skill', "スキルを探す", "Buscar habilidades", "查找技能"),
  move_skill: t('스킬 옮기기', 'Move skill', 'Pindahkan skill', "スキルを移動", "Mover habilidad", "移动技能"),
  skill_files: t('스킬 폴더 파일', 'Skill folder files', 'Berkas folder skill', "スキルフォルダーのファイル", "Archivos de carpeta de habilidades", "技能文件夹文件"),
  find_tools: t('쓸 수 있는 기능 찾기', 'Find features', 'Cari fitur', "使える機能を探す", "Buscar funciones", "查找功能"),
  // the next part of a long answer of a connected service (server/src/integrations/connections/tools.ts)
  connection_result: t('이어서 읽기', 'Read on', 'Baca lanjutan', "続きを読む", "Seguir leyendo", "继续阅读"),
  // no step under an answer (server/src/chat/turn.ts HIDDEN_STEP_TOOLS), but the activity log names it (QA TC-069)
  set_title: t('채팅 이름 짓기', 'Name the chat', 'Beri nama obrolan', "チャットに名前を付ける", "Poner nombre al chat", "给对话命名"),
  remember: t('기억하기', 'Remember', 'Ingat', "記憶", "Recordar", "记住"),
  forget: t('기억 지우기', 'Forget', 'Lupakan', "忘れる", "Olvidar", "忘记"),
  connect_service: t('서비스 연결', 'Connect service', 'Hubungkan layanan', "サービスを接続", "Conectar servicio", "连接服务"),
  // the person's own team chat rooms (server/src/chat/room-tools.ts): "대화방 읽기 · 마케팅", "대화방 찾기 "예산""
  rooms: t('대화 찾기', 'Find in conversations', 'Cari di percakapan', "トークを探す", "Buscar en conversaciones", "在聊天中查找"),
  room_read: t('대화 읽기', 'Read conversation', 'Baca percakapan', "トークを読む", "Leer conversación", "读取聊天"),
  // reading Slack with the bot token (server/src/integrations/slack/read.ts)
  slack_read_thread: t('Slack 스레드 읽기', 'Read Slack thread', 'Baca utas Slack', "Slackのスレッドを読む", "Leer hilo de Slack", "读取Slack话题"),
  slack_read_channel: t('Slack 채널 읽기', 'Read Slack channel', 'Baca kanal Slack', "Slackのチャンネルを読む", "Leer canal de Slack", "读取Slack频道"),
  room_file: t('대화 파일 읽기', 'Read conversation file', 'Baca berkas percakapan', "トークのファイルを読む", "Leer archivo de conversación", "读取聊天文件"),
  chat_file: t('채팅 파일 읽기', 'Read chat file', 'Baca berkas obrolan', 'チャットのファイルを読む', 'Leer archivo del chat', '读取对话文件'),
  save_room_file: t('대화 파일 저장', 'Save conversation file', 'Simpan berkas percakapan', "トークのファイルを保存", "Guardar archivo de conversación", "保存聊天文件"),
  restore_chat_file: t('채팅 파일 되돌리기', 'Restore chat file', 'Pulihkan berkas obrolan', 'チャットのファイルを戻す', 'Restaurar archivo del chat', '恢复对话文件'),
  save_chat_file: t('채팅 파일 저장', 'Save chat file', 'Simpan berkas obrolan', 'チャットのファイルを保存', 'Guardar archivo del chat', '保存对话文件'),
  // a finished file from the chat's work folder into the team folder (server/src/chat/work-file-tool.ts)
  save_work_file: t('작업 결과 저장', 'Save work file', 'Simpan berkas kerja', '作業ファイルを保存', 'Guardar archivo de trabajo', '保存工作文件'),
  // the AI posts to one of the person's rooms after their yes on its card (server/src/chat/post-to-room.ts): "대화방에
  // 보내기 · #영업팀", the room named by the server once found (the button's words: shared rooms.ts SIDE_CHAT_SEND)
  post_to_room: t('대화에 보내기', 'Send to conversation', 'Kirim ke percakapan', 'トークに送る', 'Enviar a la conversación', "发送到聊天"),
  // the AI shares the person's own files with teammates after their yes on its card (server/src/chat/share-with-person.ts)
  share_with_person: t('파일 공유', 'Share files', 'Bagikan berkas', 'ファイルを共有', 'Compartir archivos', '共享文件'),
  stop_sharing: t('공유 중지', 'Stop sharing', 'Berhenti membagikan', '共有を停止', 'Dejar de compartir', '停止共享'),
  // the AI shares a folder in the person's own files, or stops (server/src/chat/share-folder.ts)
  share_folder: t('폴더 공유', 'Share folder', 'Bagikan folder', 'フォルダを共有', 'Compartir carpeta', '共享文件夹'),
  // the files shared with the person, listed when the AI asks (server/src/chat/shared-with-me-tool.ts), and what they have
  // open now (server/src/chat/looking-at.ts)
  shared_with_me: t('공유받은 파일 확인', 'Check files shared with you', 'Periksa berkas yang dibagikan kepada Anda', '共有されたファイルを確認', 'Ver archivos compartidos con usted', '查看共享给你的文件'),
  // the comments under answers in this chat (server/src/chat/answer-comments.ts)
  answer_comments: t('스레드 답글 읽기', 'Read thread replies', 'Baca balasan utas', 'スレッドの返信を読む', 'Leer respuestas del hilo', '读取话题回复'),
  // the folders the person's AI can see, each with its access (server/src/chat/my-folders.ts): never a hidden one
  my_folders: t('열 수 있는 폴더 확인', 'Check the folders open to you', 'Periksa folder yang bisa Anda buka', '開けるフォルダーを確認', 'Ver las carpetas que puede abrir', '查看你能打开的文件夹'),
  looking_at: t('열어 둔 화면 확인', 'Check what you have open', 'Periksa yang sedang Anda buka', '開いている画面を確認', 'Ver lo que tiene abierto', '查看你打开的内容'),
  // the AI changes a team project's members after the person's yes on its card (server/src/chat/project-members.ts):
  // "프로젝트 멤버 바꾸기 · 견적"
  change_project_members: t('프로젝트 멤버 바꾸기', 'Change project members', 'Ubah anggota proyek', 'プロジェクトのメンバーを変更', 'Cambiar miembros del proyecto', "更改项目成员"),
  // the AI looks up who can open a file, a folder or the chat (server/src/chat/who-can-open.ts); never a path or a name
  who_can_open: t('누가 볼 수 있는지 확인', 'Check who can open it', 'Periksa siapa yang bisa membuka', '開ける人を確認', 'Comprobar quién puede abrirlo', '查看谁可以打开'),
  change_folder_access: t('폴더 권한 바꾸기', 'Change folder access', 'Ubah akses folder', 'フォルダのアクセスを変更', 'Cambiar el acceso a la carpeta', '更改文件夹权限'),
}

/** Verb of an in-app browser step: "<verb> · <url>". */
export const BROWSER_STEP_VERB: Record<string, T> = {
  preview_start: t('브라우저 열기', 'Open browser', 'Buka browser', "ブラウザーを開く", "Abrir navegador", "打开浏览器"),
  navigate: t('페이지 열기', 'Open page', 'Buka halaman', "ページを開く", "Abrir página", "打开网页"),
  read_page: t('페이지 읽기', 'Read page', 'Baca halaman', "ページを読む", "Leer página", "读取网页"),
  get_page_text: t('페이지 읽기', 'Read page', 'Baca halaman', "ページを読む", "Leer página", "读取网页"),
  find: t('페이지에서 찾기', 'Find on page', 'Cari di halaman', "ページ内を検索", "Buscar en la página", "在网页中查找"),
  computer: t('브라우저 조작', 'Use browser', 'Operasikan browser', "ブラウザーを操作", "Usar navegador", "操作浏览器"),
  form_input: t('양식 채우기', 'Fill form', 'Isi formulir', "フォームに入力", "Rellenar formulario", "填写表单"),
  javascript_tool: t('페이지에서 동작 실행', 'Run an action on the page', 'Jalankan aksi di halaman', "ページで操作を実行", "Ejecutar una acción en la página", "在网页上执行操作"),
  browser_batch: t('브라우저 여러 단계', 'Browser steps', 'Beberapa langkah browser', "ブラウザーの手順", "Pasos del navegador", "浏览器步骤"),
  resize_window: t('화면 크기 바꾸기', 'Resize', 'Ubah ukuran', "サイズを変更", "Cambiar tamaño", "调整大小"),
  read_console_messages: t('페이지 오류 보기', 'Check page errors', 'Periksa galat halaman', "ページのエラーを確認", "Revisar errores de la página", "检查网页错误"),
  read_network_requests: t('페이지 통신 보기', 'Check page traffic', 'Periksa lalu lintas halaman', "ページの通信を確認", "Revisar el tráfico de la página", "检查网页流量"),
  tabs_context: t('탭 보기', 'List tabs', 'Lihat tab', "タブを一覧表示", "Listar pestañas", "查看标签页"),
  tabs_create: t('새 탭', 'New tab', 'Tab baru', "新しいタブ", "Nueva pestaña", "新标签页"),
  tabs_select: t('탭 바꾸기', 'Switch tab', 'Ganti tab', "タブを切り替え", "Cambiar pestaña", "切换标签页"),
  tabs_close: t('탭 닫기', 'Close tab', 'Tutup tab', "タブを閉じる", "Cerrar pestaña", "关闭标签页"),
}
/** A read of a video or an audio file has its own verb ("Watch video · promo.mp4"), chosen by the file's extension. */
export const READ_MEDIA_VERB: Record<MediaKind, T> = {
  video: t('영상 보기', 'Watch video', 'Tonton video', "動画を見る", "Ver video", "观看视频"),
  audio: t('오디오 듣기', 'Listen to audio', 'Dengarkan audio', "音声を聞く", "Escuchar audio", "收听音频"),
}

/** A read of a deck's slides as pictures (read with pages or as_images of a .pptx) says which slides: "View slides 3–5 ·
 * launch.pptx", as a video read says "Watch video" (QA TC-6943). The numbers follow the verb in every language. */
export const READ_SLIDES_VERB: T = t('슬라이드 보기', 'View slides', 'Lihat slide', "スライドを見る", "Ver diapositivas", "查看幻灯片")
/** The artifact tool's change, read and restore of a page (server/src/tools/artifact.ts), instead of "Make a page" */
export const ARTIFACT_ACTION_VERB: Record<'edit' | 'read' | 'restore', T> = {
  edit: t('화면 고치기', 'Edit a page', 'Ubah halaman', "画面を編集", "Editar una página", "编辑页面"),
  read: t('화면 보기', 'View a page', 'Lihat halaman', "画面を見る", "Ver una página", "查看页面"),
  restore: t('화면 되돌리기', 'Restore a page', 'Pulihkan halaman', "画面を戻す", "Restaurar una página", "恢复页面"),
}

/** Was this stored read step a look at a deck's slides (by its verb, in any language)? The web app's icon. */
export function slidesStep(step: { tool?: string; label: string }): boolean {
  if (step.tool !== 'read') return false
  return Object.values(READ_SLIDES_VERB).some((v) => step.label === v || step.label.startsWith(v + ' '))
}

/** "3", "1-5", "1-3,7" -> "3", "1–5", "1–3, 7" (what the AI asked for, not checked here; at most 30 characters) */
const slideNumbers = (pages: unknown) => (typeof pages === 'string' ? clip(pages.replace(/\s+/g, '').replace(/[^\d,-]/g, '').replace(/-/g, '–').replace(/,/g, ', '), 30) : '')

/** Whether a stored read step was a video or an audio read (by its verb, in any language): the web app's icon. */
export function mediaStepKind(step: { tool?: string; label: string }): MediaKind | null {
  if (step.tool !== 'read') return null
  for (const k of ['video', 'audio'] as const) for (const v of Object.values(READ_MEDIA_VERB[k])) if (step.label === v || step.label.startsWith(v + ' ')) return k
  return null
}

/** Tools that only look things up: the read-only Explore helper's tools (server/src/chat/subagents.ts EXPLORE_TOOLS).
 * A failed call of one changed nothing, so the steps list under an answer that did not fail shows it with the quiet
 * mark even when no later step worked (web/src/components/chat/Steps.tsx stepMark). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list', 'glob', 'grep', 'read', 'skill', 'find_skills', 'drive_list', 'drive_read', 'drive_search', 'hwp_render', 'web_fetch'])
/** Removed tools that only looked things up (search by meaning, the knowledge graph's knowledge_explore): never offered
 * any more, but their steps in older chats keep the quiet mark of a read-only step (Steps.tsx stepMark). */
export const REMOVED_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['search', 'knowledge_explore'])

export const BROWSER_STEP_FALLBACK: T = t('브라우저', 'Browser', 'Browser', "ブラウザー", "Navegador", "浏览器")

/** Whole-label templates ({x} = what the AI touched, never translated). */
export const STEP_TEXT = {
  asked: t('질문: {q}', 'Question: {q}', 'Pertanyaan: {q}', "質問：{q}", "Pregunta: {q}", "提问：{q}"),
  remembered: t('기억함: {text}', 'Remembered: {text}', 'Diingat: {text}', "記憶しました：{text}", "Recordado: {text}", "已记住：{text}"),
  notRemembered: t('기억하지 않음: {text}', 'Not remembered: {text}', 'Tidak diingat: {text}', "記憶しませんでした：{text}", "No se recordó: {text}", "未记住：{text}"),
  /** remember while its card waits for the person's yes (a chat that read other people's content) */
  rememberAsking: t('기억할지 묻는 중: {text}', 'Asking whether to remember: {text}', 'Menanyakan apakah perlu diingat: {text}', "記憶するか確認中：{text}", "Preguntando si recordar: {text}", "正在询问是否记住：{text}"),
  /** remember of a password, key, token or code: never kept, and its value never shown */
  notRememberedSecret: t('기억하지 않음: 비밀번호나 키 같은 비밀 정보', 'Not remembered: a password, key or other secret', 'Tidak diingat: kata sandi, kunci, atau rahasia lain', "記憶しませんでした：パスワードやキーなどの秘密情報", "No se recordó: una contraseña, clave u otro secreto", "未记住：密码、密钥等机密信息"),
  /** remember with `replaces`: an existing memory changed in place */
  rememberUpdated: t('기억 고침: {text}', 'Memory updated: {text}', 'Ingatan diperbarui: {text}', "記憶を更新しました：{text}", "Memoria actualizada: {text}", "已更新记忆：{text}"),
  /** forget, with the text of the memory it removed */
  forgotText: t('잊음: {text}', 'Forgot: {text}', 'Dilupakan: {text}', "忘れました：{text}", "Olvidado: {text}", "已忘记：{text}"),
  forgot: t('기억 지움', 'Forgot a memory', 'Ingatan dihapus', "メモリを削除しました", "Se olvidó una memoria", "已删除一条记忆"),
  notAnswered: t('답하지 않음', 'Not answered', 'Tidak dijawab', "未回答", "Sin respuesta", "未回答"),
  /** detail of a connect_service step: the person finished the card (or it was connected already), or did not */
  connectConnected: t('연결됨', 'Connected', 'Terhubung', "接続済み", "Conectado", "已连接"),
  connectNotConnected: t('연결 안 됨', 'Not connected', 'Tidak terhubung', "未接続", "No conectado", "未连接"),
  webSearch: t('웹 검색: {q}', 'Web search: {q}', 'Cari di web: {q}', "Web検索：{q}", "Búsqueda web: {q}", "网页搜索：{q}"),
  /** a search still running whose query is not known yet (Codex names it only at the end) */
  webSearchRunning: t('웹 검색 중…', 'Searching the web…', 'Mencari di web…', "Web検索中…", "Buscando en la web…", "正在搜索网页…"),
  /** a Codex search that opened (or looked inside) one of its results: it names no query */
  webSearchOpen: t('검색 결과 열기', 'Opening a search result', 'Membuka hasil pencarian', "検索結果を開く", "Abriendo un resultado de búsqueda", "正在打开搜索结果"),
  /** a Codex search that named nothing (finance, weather, time …) */
  webSearchPlain: t('웹 검색', 'Web search', 'Cari di web', "Web検索", "Búsqueda web", "网页搜索"),
  /** detail of a search the team server refused to send (it named an address, not a result of the search) */
  webSearchRefused: t('거절됨: 검색으로는 그 검색의 결과만 열 수 있어요. AI에게 그 주소는 웹 페이지 가져오기(주소 확인 카드)로 열라고 알렸어요.',
    'Refused: a search opens only its own results. The AI was told to fetch the address instead (with the address card).',
    'Ditolak: pencarian hanya membuka hasilnya sendiri. AI diminta mengambil alamat itu dengan Ambil halaman (dengan kartu alamat).',
    "拒否：検索で開けるのはその検索の結果だけです。そのアドレスは「ページを取得」（アドレスの確認カード）で開くようAIに伝えました。",
    "Rechazado: una búsqueda solo abre sus propios resultados. Se indicó a la IA que obtenga la dirección con «Obtener página» (con la tarjeta de dirección).", "已拒绝：搜索只能打开它自己的结果。已告诉AI改用“获取网页”（带地址卡片）打开该地址。"),
  thinking: t('생각하는 중', 'Thinking', 'Berpikir', "考え中", "Pensando", "思考中"),
  attachChanged: t('첨부한 뒤 바뀐 파일, 지금 내용으로 읽음 · {path}', 'Attached file changed since it was attached; using the current version · {path}', 'Berkas lampiran berubah sejak dilampirkan; memakai versi terkini · {path}', "添付後にファイルが変更されたため、現在のバージョンを使用します · {path}", "El archivo cambió desde que se adjuntó; se usa la versión actual · {path}", "附件在添加后已更改，使用当前版本 · {path}"),
  attachMoved: t('첨부한 파일이 옮겨짐 · {path}', 'Attached file moved · {path}', 'Berkas lampiran dipindah · {path}', "添付ファイルが移動しました · {path}", "El archivo adjunto se movió · {path}", "附件已移动 · {path}"),
  attachUnavailable: t('첨부한 팀 파일을 더 이상 쓸 수 없음', 'An attached team file is no longer available', 'Berkas tim yang dilampirkan tidak tersedia lagi', "添付したチームのファイルは利用できなくなりました", "Un archivo adjunto del equipo ya no está disponible", "添加的团队文件已不可用"),
  refusedRetry: t('AI가 답하지 않아 다른 AI로 다시 답해요', 'The AI declined; trying again with another AI', 'AI menolak; mencoba lagi dengan AI lain', "AIが回答しなかったため、別のAIでもう一度回答します", "La IA no respondió; se intenta de nuevo con otra IA", "AI拒绝回答，正在用另一个AI重试"),
  /** the chat's engine was switched off by an admin: this answer uses the team default */
  /** demo mode (server/src/demo/replay.ts): the answer is a recorded real run played again */
  /** a fresh session's history did not fit: the older part was summarized first (server/src/chat/history-summary.ts) */
  historySummary: t('이 채팅 앞부분 요약', 'Summary of the earlier part of this chat', 'Ringkasan bagian awal obrolan ini', "このチャットの前半の要約", "Resumen de la parte anterior de este chat", "此对话前面部分的摘要"),
  demoReplay: t('데모용으로 미리 준비한 결과예요', 'Prepared in advance for the demo', 'Disiapkan sebelumnya untuk demo', "デモ用に事前に用意した結果です", "Preparado de antemano para la demostración", "为演示提前准备的结果"),
  // plain words (QA TC-7050: "the chosen AI is off; … default AI" read as jargon)
  engineOffDefault: t('이 채팅에서 고른 AI가 꺼져 있어서 팀이 평소 쓰는 AI가 대신 답해요', "The AI picked for this chat is turned off, so your team's usual AI is answering", 'AI yang dipilih untuk obrolan ini dimatikan, jadi AI yang biasa dipakai tim Anda yang menjawab', 'このチャットで選んだAIがオフになっているため、チームでいつも使うAIが代わりに答えます', 'La IA elegida para este chat está apagada, así que responde la IA que su equipo usa normalmente', '这个对话选的AI已关闭，所以由你们团队平常用的AI来回答'),
  /** "다른 AI로 대신 답하기": the chat's engine has no AI connection for the person, the other one has
   * (server/src/credentials/access.ts connectionRoute) */
  engineNoConnection: t('고른 AI에 연결된 계정이 없어 다른 AI로 답해요', 'The chosen AI has no account connected; answering with another AI', 'AI yang dipilih tidak punya akun terhubung; menjawab dengan AI lain', "選んだAIにアカウントが接続されていないため、別のAIで回答します", "La IA elegida no tiene una cuenta conectada; se responde con otra IA", "所选AI没有连接账号，改用另一个AI回答"),
  /** "다른 AI로 대신 답하기": the Claude subscription limit was hit and the admin allowed the fallback */
  limitFallback: t('사용 한도에 닿아 다른 AI로 이어서 답해요', 'Usage limit reached; continuing with another AI', 'Batas pemakaian tercapai; dilanjutkan dengan AI lain', "使用量の上限に達したため、別のAIで続けます", "Se alcanzó el límite de uso; se continúa con otra IA", "已达到用量上限，换用另一个AI继续回答"),
  /** the conversation got too long for the AI: the same answer goes on in a fresh session (server/src/chat/context-recover.ts) */
  contextRecover: t('대화가 길어져서 AI가 정리하고 이어서 답해요', 'The conversation got long, so the AI made room and is continuing', 'Percakapan makin panjang, jadi AI merapikannya dan melanjutkan', "会話が長くなったため、AIが整理して回答を続けます", "La conversación se alargó, así que la IA hizo espacio y continúa", "对话变长了，AI整理后继续回答"),
  credentialSwitchLimit: t('사용 한도에 닿아 다른 AI 계정으로 이어서 답해요', 'Usage limit reached; continuing with another AI account', 'Batas pemakaian tercapai; dilanjutkan dengan akun AI lain', "使用量の上限に達したため、別のAIアカウントで続けます", "Se alcanzó el límite de uso; se continúa con otra cuenta de IA", "已达到用量上限，换用另一个AI账号继续回答"),
  /** a dev-environment command that runs as a long job, or in the background (box_shell job / background) */
  jobSuffix: t('오래 걸리는 작업', 'long task', 'tugas panjang', "時間のかかる作業", "tarea larga", "耗时任务"),
  backgroundSuffix: t('뒤에서 실행', 'in the background', 'di latar belakang', "バックグラウンドで実行", "en segundo plano", "后台运行"),
  /** a sub-agent's part of the answer (Claude Code's Agent tool); {d} is the AI's own short description of it */
  subtask: t('하위 작업: {d}', 'Sub-task: {d}', 'Subtugas: {d}', "サブタスク：{d}", "Subtarea: {d}", "子任务：{d}"),
  credentialSwitchInvalid: t('AI 계정이 거절되어 다른 계정으로 이어서 답해요', 'The AI account was refused; continuing with another one', 'Akun AI ditolak; dilanjutkan dengan akun lain', "AIアカウントが拒否されたため、別のアカウントで続けます", "Se rechazó la cuenta de IA; se continúa con otra", "AI账号被拒绝，换用另一个账号继续回答"),
  // after a step's own line (" · <these>"): why the call went on without a card (server/src/chat/turn.ts coverStep,
  // chat/schedule-cover.ts). COVER_STEP_KEYS: localizeStep and stepPlace know them at the end of any line
  /** the step of a call a room grant let through, after its own words */
  roomGrantStep: t('항상 허용으로 진행', 'allowed: always in this conversation', 'diizinkan: selalu di percakapan ini', "常に許可で実行", "permitido: siempre en esta conversación", "已允许：在此聊天中始终允许"),
  /** the step of a call this answer's [이번만 허용] for its folder let through */
  roomOnceStep: t('이번만 허용으로 진행', 'allowed once in this answer', 'diizinkan sekali di jawaban ini', "今回だけ許可で実行", "permitido esta vez en esta respuesta", "已允许：本次回答中允许一次"),
  /** the step of a scheduled run's save or send that its task's card allowed (chat/schedule-cover.ts) */
  scheduleCoverStep: t('예약 작업에서 허용', 'allowed on the scheduled task', 'diizinkan di tugas terjadwal', "定期タスクで許可", "permitido en la tarea programada", "已在定时任务中允许"),
  /** the step of a call that made a new file in the person's own folder after a room read, with no card */
  ownFolderStep: t('내 폴더라 묻지 않고 저장', 'saved without asking: your own folder', 'disimpan tanpa bertanya: folder Anda sendiri', "自分のフォルダーなので確認せずに保存", "guardado sin preguntar: su propia carpeta", "未询问直接保存：你自己的文件夹"),
  /** the step of a dev-environment command after a room read with no card: its changes in the person's own folder keep
   * versions and go to the trash (server devenv/track.ts withOwnFolderWindow) */
  ownUndoStep: t('내 폴더 변경은 되돌릴 수 있어 묻지 않고 실행', 'ran without asking: changes in your folder can be undone', 'dijalankan tanpa bertanya: perubahan di folder Anda bisa dibatalkan', "自分のフォルダーの変更は元に戻せるため確認せずに実行", "ejecutado sin preguntar: los cambios en su carpeta se pueden deshacer", "未询问直接运行：你文件夹里的更改可以撤销"),
  /** the step of a call the person allowed on a card for the same file or recipients earlier in this chat
   * (server chat/card-approvals.ts) */
  chatOnceStep: t('이 대화에서 허용한 대로 진행', 'allowed earlier in this chat', 'diizinkan sebelumnya di chat ini', "このチャットで許可済み", "permitido antes en este chat", "已在此聊天中允许过"),
} satisfies Record<string, T>
export type StepTextKey = keyof typeof STEP_TEXT

/** Steps whose line is someone's own words after a template (a question, a memory, a sub-task) or the server's notice. */
const TEXT_STEP_TOOLS = new Set(['ask_user', 'remember', 'forget', 'agent', 'refusal', 'demo_replay', 'engine', 'attachment'])

/** The words that may end any step's line after " · ": why the call went on without a card (STEP_TEXT above). */
export const COVER_STEP_KEYS = ['roomGrantStep', 'roomOnceStep', 'scheduleCoverStep', 'ownFolderStep', 'ownUndoStep', 'chatOnceStep'] as const satisfies readonly StepTextKey[]

/** The word for a step whose tool has no verb of its own, when only the words of a step may show. */
export const STEP_WORDS_OTHER: T = t('작업', 'Step', 'Langkah', "ステップ", "Paso", "步骤")

/**
 * A tool id that is one of ours with something stuck on its end ("post_to_room_placeholder", a name an engine made up
 * for a tool it had not loaded yet: QA TC-v2f-A2 showed "Post to room placeholder") reads as that tool's own words.
 */
function knownPrefixVerb(tool: string, locale: Locale): string | null {
  const last = tool.slice(0, 200).split('__').filter(Boolean).at(-1) ?? ''
  // only a made-up tail on one of our names: an outside tool that merely starts like ours ("list_issues") keeps its own words
  const m = /^(.+)_(placeholder|stub|dummy|tool|deferred)$/i.exec(last)
  return m && FILE_STEP_VERB[m[1]!] ? FILE_STEP_VERB[m[1]!]![locale] ?? null : null
}

/**
 * A tool's id as words, for a tool without words of its own (docs/DECISIONS.md "Plain words in errors, cards and
 * steps"): "create_task" -> "Create task", "getPageText" -> "Get page text", "my_notion__create_page" -> "Create page";
 * an all-capitals word keeps its capitals ("export_PDF" -> "Export PDF"). Never the id as it is; '' when it holds no
 * letter or digit.
 */
export function readableToolName(id: string): string {
  // a tool's name is short; anything longer (an AI's text, call_tool's name before its check) is cut first, and the
  // patterns stay linear
  const last = id.slice(0, 200).split('__').filter(Boolean).at(-1) ?? ''
  const words = last.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, '$1 ').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * A step's words alone, without what it touched (a path, an address, a query, a remembered text): the verb of its tool,
 * else a word for its kind. The steps of a chat's answers from before it was shared, as everyone but the person whose
 * answer it was sees them (server/src/chat/store.ts viewSteps, docs/DECISIONS.md "Shared project chats").
 */
export function stepWords(step: { kind: string; tool?: string }, locale: Locale): string {
  const pick = (x: T) => x[locale] ?? x.en
  const tool = step.tool
  const verb = tool && Object.hasOwn(FILE_STEP_VERB, tool) ? FILE_STEP_VERB[tool] : tool && Object.hasOwn(BROWSER_STEP_VERB, tool) ? BROWSER_STEP_VERB[tool] : undefined
  if (verb) return pick(verb)
  if (step.kind === 'thinking') return pick(STEP_TEXT.thinking)
  if (step.kind === 'web_search') return pick(STEP_TEXT.webSearchPlain)
  if (step.kind === 'browser') return pick(BROWSER_STEP_FALLBACK)
  return pick(STEP_WORDS_OTHER)
}
/** A tool of ours (one with words of its own), whose name says nothing about the person: a connection's tool is named
 * after the connection (mcp__…__<slug>__<tool>), so where only a step's words may show, its name goes too. */
export const knownStepTool = (tool: string): boolean => Object.hasOwn(FILE_STEP_VERB, tool) || Object.hasOwn(BROWSER_STEP_VERB, tool)

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all)
export const stepText = (key: StepTextKey, locale: Locale, vars: Record<string, string> = {}) => fill(STEP_TEXT[key][locale] ?? STEP_TEXT[key].en, vars)

const clip = (s: unknown, n = 80) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > n ? v.slice(0, n - 1) + '…' : v
}

/** A room as the AI named it, for a step line: a "#" token's title (#[마케팅](room:<id>) -> 마케팅), else as given. */
const roomWord = (v: unknown) => {
  const s = String(v ?? '')
  const m = /^#\[([^\[\]\n]{1,80})\]\(room:[0-9a-f-]{36}\)$/.exec(s.trim())
  if (m) return m[1]!
  // a bare id means nothing to the person: the verb alone until the server names the room
  return /^(room:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim()) ? '' : s.replace(/^#/, '')
}

/** A glob step in words (QA b3s TC-b3s-8: the step showed the pattern itself, 매출 with two wildcard folders): the folder it looks in (its path
 * and the pattern's folders before the first wildcard), then the kind of file by its extension (".xlsx") or the name it
 * looks for without the wildcards ("배너"); no wildcard characters. A pattern with no wildcard is a name and shows as one. */
export function globLabel(verb: string, pattern: unknown, folder: unknown): string {
  const p = String(pattern ?? '').trim()
  const wild = /[*?[\]{}]/
  if (!wild.test(p)) return `${verb} "${clip(p, 60)}"${folder ? ` · ${clip(folder, 50)}` : ''}`
  const segs = p.split('/').filter(Boolean)
  const fixed: string[] = []
  for (const x of segs) { if (wild.test(x)) break; fixed.push(x) }
  const place = [String(folder ?? '').replace(/\/+$/, ''), ...fixed].filter(Boolean).join('/')
  const last = segs.length > fixed.length ? segs.at(-1)! : ''
  // "*.xlsx", "*.{png,jpg}": the kinds; else the name's own letters ("*배너*" -> 배너)
  const exts = /^\*+\.(?:\{([\w,]+)\}|(\w+))$/.exec(last)
  const what = exts ? (exts[1] ?? exts[2]!).split(',').filter(Boolean).slice(0, 3).map((e) => `.${e}`).join(', ')
    : last.replace(/[*?[\]{}]/g, ' ').replace(/\s+/g, ' ').trim()
  const quoted = what && !exts ? `"${clip(what, 40)}"` : what
  return [verb, place ? clip(place, 60) : '', quoted].filter(Boolean).join(' · ')
}

/** Short human label of a tool step ('Search "invoice" · finance/'). Never the raw input. */
export function stepLabel(tool: string, input: unknown, locale: Locale, browserTools: ReadonlySet<string>): string {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (browserTools.has(tool)) {
    const verb = (BROWSER_STEP_VERB[tool] ?? BROWSER_STEP_FALLBACK)[locale]
    const url = typeof a.url === 'string' ? ` · ${clip(a.url, 60)}` : ''
    return verb + url
  }
  const verb = FILE_STEP_VERB[tool]?.[locale]
  switch (tool) {
    case 'list': return `${verb} · ${clip(a.path || '/', 80)}`
    case 'glob': return globLabel(verb!, a.pattern, a.path)
    case 'grep': return `${verb} "${clip(a.pattern, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'read': {
      const k = mediaKind(String(a.file_path ?? ''))
      if (!k && /\.pptx$/i.test(String(a.file_path ?? '').trim()) && (a.pages !== undefined || a.as_images === true)) {
        const n = slideNumbers(a.pages)
        return `${READ_SLIDES_VERB[locale]}${n ? ` ${n}` : ''} · ${clip(a.file_path, 90)}`
      }
      return `${k ? READ_MEDIA_VERB[k][locale] : verb} · ${clip(a.file_path, 90)}`
    }
    case 'write': case 'edit': return `${verb} · ${clip(a.file_path, 90)}`
    case 'edit_files': {
      // the first file and how many more ("+29": a number, the same in every language)
      const files = Array.isArray(a.file_paths) ? [...new Set(a.file_paths)] : []
      return files.length ? `${verb} · ${clip(files[0], 80)}${files.length > 1 ? ` +${files.length - 1}` : ''}` : verb!
    }
    case 'make_file': return `${verb} · ${clip(a.output, 90)}`
    case 'edit_hwp': return `${verb} · ${clip(a.output ?? a.file_path, 90)}`
    case 'stamp_pdf': case 'edit_pdf': case 'split_pdf': return `${verb} · ${clip(a.file_path, 90)}`
    case 'make_zip': case 'resize_images': case 'query_data': {
      if (tool === 'make_zip' && typeof a.output === 'string' && a.output) return `${verb} · ${clip(a.output, 90)}`
      // the first photo (query_data: the first data file) and how many more ("+2"), as merge_pdfs
      const paths = Array.isArray(a.paths) ? a.paths.filter((p: unknown) => typeof p === 'string') as string[] : []
      return paths.length ? `${verb} · ${clip(paths[0], 80)}${paths.length > 1 ? ` +${paths.length - 1}` : ''}` : verb!
    }
    case 'merge_pdfs': {
      // the first file and how many more ("+2": a number, the same in every language)
      const files = Array.isArray(a.files) ? a.files.map((f: unknown) => (typeof f === 'string' ? f : (f as { path?: string } | null)?.path ?? '')) : []
      return files.length ? `${verb} · ${clip(files[0], 80)}${files.length > 1 ? ` +${files.length - 1}` : ''}` : verb!
    }
    case 'share_file': case 'unzip_file': return `${verb} · ${clip(a.path, 90)}`
    case 'move_files': case 'copy_files': return `${verb} · ${clip(a.to_folder, 90)}`
    case 'rename_file': return `${verb} · ${clip(a.path, 90)}`
    case 'rename_files': {
      // the folder of a pattern, else the first file and how many more ("+3": a number, the same in every language)
      const items = Array.isArray(a.renames) ? a.renames.map((r: unknown) => (r as { path?: string } | null)?.path ?? '') : []
      return typeof a.folder === 'string' ? `${verb} · ${clip(a.folder || '/', 90)}` : items.length ? `${verb} · ${clip(items[0], 80)}${items.length > 1 ? ` +${items.length - 1}` : ''}` : verb!
    }
    case 'skill_files': return `${verb} · ${clip(a.path, 60)}${a.to_folder ? ` → ${clip(a.to_folder, 40)}` : a.new_name ? ` → ${clip(a.new_name, 40)}` : ''}`
    case 'delete_files': {
      // the first item and how many more ("+3": a number, the same in every language)
      const paths = Array.isArray(a.paths) ? [...new Set(a.paths)] : []
      return paths.length ? `${verb} · ${clip(paths[0], 80)}${paths.length > 1 ? ` +${paths.length - 1}` : ''}` : verb!
    }
    case 'artifact': {
      const act = a.action === 'read' || a.action === 'restore' ? ARTIFACT_ACTION_VERB[a.action][locale] : a.action === 'update' || a.action === 'rewrite' ? ARTIFACT_ACTION_VERB.edit[locale] : verb
      return `${act} · ${clip(a.title ?? a.key, 80)}${a.action === 'restore' && typeof a.version === 'number' ? ` · v${a.version}` : ''}`
    }
    case 'web_fetch': return `${verb} · ${clip(a.url, 80)}`
    case 'save_url': return `${verb} · ${clip(a.save_as || a.url, 80)}`
    case 'save_connector_file': return a.save_as ? `${verb} · ${clip(a.save_as, 80)}` : verb!
    case 'hwp_render': return `${verb} · ${clip(a.source, 80)}${typeof a.page === 'number' ? ` #${a.page}` : ''}`
    case 'search': case 'drive_search': case 'knowledge_explore': return `${verb} "${clip(a.query, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'schedule_create': return `${verb} · ${clip(a.title, 80)}`
    // a schedule, a Drive file or folder by its id means nothing to the person: the words alone (the server names a
    // schedule by its title once it knows it, tools/schedules.ts)
    case 'schedule_delete': return verb!
    case 'drive_list': case 'drive_read': return verb!
    case 'generate_video': return `${verb} · ${clip(a.prompt, 80)}`
    // the headline on one line: a line break, real or written as the two letters "\n", is a space here
    case 'change_banner_text': { const h = typeof a.headline === 'string' ? a.headline.replace(/(?:\\+r)?\\+n|\r?\n|<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim() : ''; return h ? `${verb} · ${clip(h, 80)}` : verb! }
    case 'comment_docx': return `${verb} · ${clip(a.file_path, 80)}`
    case 'edit_office': return `${verb} · ${clip(a.output ?? a.file_path, 80)}`
    case 'promo_video': case 'intro_deck': return `${verb} · ${clip(a.title, 80)}`
    case 'save_promo_video': return a.save_as ? `${verb} · ${clip(a.save_as, 80)}` : verb!
    case 'skill': return `${verb} · ${clip(a.name, 80)}`
    case 'move_skill': return `${verb} · ${clip(a.skill, 60)} → ${clip(a.to === 'group' ? a.group ?? a.to : a.to === 'project' ? a.project ?? a.to : a.to, 40)}`
    case 'find_skills': case 'find_tools': return `${verb} "${clip(a.query, 60)}"`
    // a room the AI passed as an id is named by the server once it is found (the step is patched); "#" tokens by title
    case 'rooms': { const w = roomWord(a.room ?? a.person); return `${verb}${a.query ? ` "${clip(a.query, 60)}"` : ''}${w ? ` · ${clip(w, 60)}` : ''}` }
    case 'room_read': { const w = roomWord(a.room); return w ? `${verb} · ${clip(w, 60)}` : verb! }
    case 'room_file': { const w = roomWord(a.file); return w ? `${verb} · ${clip(w, 60)}` : verb! }
    case 'chat_file': case 'answer_comments': return verb!
    case 'post_to_room': { const w = roomWord(a.room); return w ? `${verb} · ${clip(w, 60)}` : verb! }
    case 'change_project_members': return a.project ? `${verb} · ${clip(a.project, 60)}` : verb!
    // the folder by its own name (its last part): the path stays out of the step
    case 'change_folder_access': { const f = typeof a.folder === 'string' ? a.folder.replace(/\/+$/, '').split('/').pop() : ''; return f ? `${verb} · ${clip(f, 60)}` : verb! }
    case 'save_room_file': { const w = roomWord(a.file); return w ? `${verb} · ${clip(w, 60)}${a.save_as ? ` → ${clip(a.save_as, 60)}` : ''}` : verb! }
    case 'save_chat_file': return a.save_as ? `${verb} → ${clip(a.save_as, 60)}` : verb!
    // the file by its own name (never a server path), and where it goes
    case 'save_work_file': { const n = clip(String(a.path ?? '').split('/').pop(), 60); return a.save_as ? `${verb} · ${n} → ${clip(a.save_as, 60)}` : `${verb} · ${n}` }
    // "<the AI's plain description, else the verb> · <command>": the web app shows the words alone and the command when
    // the step is opened (localizeStep); an app that does not shows the whole line
    case 'box_shell': return `${shellDescription(a.description) || verb} · ${clip(shellWorkWords(String(a.command ?? '').split('\n')[0]!, locale), 80)}${a.job ? ` (${STEP_TEXT.jobSuffix[locale]})` : a.background ? ` (${STEP_TEXT.backgroundSuffix[locale]})` : ''}`
    case 'ask_user': return stepText('asked', locale, { q: clip(a.question, 120) })
    case 'remember': return stepText('remembered', locale, { text: clip(a.text, 120) })
    case 'forget': return stepText('forgot', locale)
    // the service's name as the AI wrote it, with anything that looks like a key and characters that show nothing left
    // out (emoji joiners and selectors stay; the label is shown and saved); without a name, the verb alone
    case 'connect_service': {
      // the name the card may use (service-catalog.ts trustedServiceName): the list's name only at its official address,
      // the address's host for a listed or look-alike name anywhere else, so the step never says "Notion" for a card
      // that is not Notion's (QA TC-135 retest)
      // an admin's template by id: the card shows the template's own name, which the AI's input does not hold, so the
      // verb alone until the card closes (the outcome's patch then adds the template's name)
      const raw = typeof a.name === 'string' && !a.template ? a.name : ''
      const shown = raw ? trustedServiceName(raw, typeof a.url === 'string' ? a.url : null).name : ''
      const name = a.target === 'google_drive' ? 'Google Drive' : shown ? clip(maskSecrets(shown.replace(/(?![\t\n\r\u200d\ufe0e\ufe0f])[\p{Cc}\p{Cf}\p{DI}\p{Co}]/gu, '')), 60) : ''
      return name ? `${verb} · ${name}` : verb!
    }
    default: return verb ?? knownPrefixVerb(tool, locale) ?? (readableToolName(tool) || STEP_WORDS_OTHER[locale])
  }
}


/** Plain words for a dev-environment command without a description of its own, by what the command does (the steps
 * of answers from before box_shell had `description` too). People are not developers: never the command itself. */
export const SHELL_KIND_WORDS = {
  install: t('프로그램 설치', 'Install tools', 'Pasang program', "ツールをインストール", "Instalar herramientas", "安装工具"),
  make: t('결과물 만들기', 'Make the result', 'Buat hasilnya', "成果物を作成", "Crear el resultado", "生成结果"),
  download: t('내려받기', 'Download', 'Unduh', "ダウンロード", "Descargar", "下载"),
  change: t('파일 바꾸기', 'Change files', 'Ubah berkas', "ファイルを変更", "Cambiar archivos", "修改文件"),
  check: t('파일 확인', 'Check files', 'Periksa berkas', "ファイルを確認", "Revisar archivos", "检查文件"),
  wait: t('기다리기', 'Wait', 'Menunggu', "待機", "Esperar", "等待"),
  run: t('작업 실행', 'Run a task', 'Jalankan tugas', "作業を実行", "Ejecutar una tarea", "执行任务"),
} satisfies Record<string, T>
export type ShellKind = keyof typeof SHELL_KIND_WORDS

/** What a shell command does, roughly, from its parts (split at && || ; | and new lines). Anything that changes or
 * removes files (rm, mv, a "> file" redirect, sed -i, find -delete…) is said as such first, whatever else the command
 * does; then an install, making something (a render, a build), a download, a pause, a look at files (only programs that
 * read, with no redirect or command substitution); else "run". The words are the server's own: a room card asks with
 * them, never with the AI's description (docs/AGENTS/plan/20261122-0156-step-labels-plain.md). */
export function shellKind(command: string): ShellKind {
  const c = command.slice(0, 4000)
  // a redirect into a file (not 2>&1 or > /dev/null), sed -i, find -delete / -exec, tee: it writes
  const quiet = c.replace(/(?<!\d)\d?>{1,2}\s*(?:\/dev\/null\b|&\d)/g, '')
  if (/>/.test(quiet.replace(/<<-?\s*['"]?\w+['"]?/g, '')) || /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/.test(c) || /\bsort\b[^|;&\n]*\s-o\b/.test(c) || /\bsed\s+(?:-\w*\s+)*-i/.test(c)) return 'change'
  const parts = c.split(/&&|\|\||[;|\n]/).map((p) => p.trim()
    // leading VAR=value assignments, export / env / sudo / time / exec in front of the program
    .replace(/^(?:(?:export|env|sudo|time|exec|nohup|command)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)*/, '')
    .replace(/^(?:sudo|time|exec|nohup|command)\s+/, '')).filter(Boolean)
  const progs = parts.map((p) => { const ws = p.split(/\s+/); return { p, w: ws[0]!.replace(/^.*\//, '').toLowerCase(), args: ws.slice(1).map((x) => x.toLowerCase()) } })
  const change = new Set(['rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'ln', 'truncate', 'dd', 'tee', 'touch', 'unlink', 'shred', 'rsync', 'kill', 'pkill', 'killall'])
  // (a program run by another: xargs rm, timeout 60 rm …)
  if (progs.some(({ w, args }) => change.has(w) || (['xargs', 'timeout', 'nice', 'watch', 'parallel', 'flock'].includes(w) && args.some((x) => change.has(x.replace(/^.*\//, '')))) || (w === 'git' && ['push', 'commit', 'reset', 'rm', 'mv', 'checkout', 'clean', 'restore', 'rebase', 'merge'].includes(args[0] ?? '')))) return 'change'
  const has = (re: RegExp) => progs.some(({ p }) => re.test(p))
  if (has(/^(?:npm|pnpm|yarn|bun|deno)\s+(?:i|install|add|ci)\b|^(?:pip3?|uv|pipx|poetry)\s+(?:install|add|sync)\b|^(?:python3?\s+-m\s+pip|uv\s+pip)\s+install\b|^(?:apt(?:-get)?|brew|apk|dnf|yum|cargo|gem|go)\s+(?:install|add|get)\b|^npx\s+\S+\s+install\b/i)) return 'install'
  // making something: the program itself, or a runner's script / tool named so (npx hyperframes render, npm run build)
  const makers = new Set(['ffmpeg', 'make', 'tsc', 'vite', 'webpack', 'pandoc', 'libreoffice', 'soffice', 'magick', 'convert', 'remotion', 'hyperframes'])
  const makeWord = /^(?:render|build|export|compile|bundle|remotion|hyperframes)$/
  if (progs.some(({ w, args }) => makers.has(w) || (['npx', 'bunx', 'pnpm', 'yarn', 'npm', 'bun', 'deno'].includes(w) && args.slice(0, 3).some((x) => makeWord.test(x))))) return 'make'
  if (has(/^(?:wget|git\s+(?:clone|pull|fetch)|curl\b.*(?:\s-[A-Za-z]*[oO]\b|--output|--remote-name))/i)) return 'download'
  const busy = progs.filter(({ w }) => !['cd', 'mkdir', 'set', 'source', '.', 'true', 'export'].includes(w))
  if (busy.length && busy.every(({ w }) => w === 'sleep')) return 'wait'
  const look = new Set(['ls', 'find', 'wc', 'du', 'df', 'cat', 'head', 'tail', 'stat', 'file', 'tree', 'grep', 'rg', 'test', '[', 'which', 'pwd', 'md5sum', 'sha256sum', 'shasum', 'ffprobe', 'identify', 'sort', 'uniq', 'jq', 'echo', 'printf', 'cut', 'tr'])
  const real = busy.filter(({ w }) => w !== 'sleep')
  if (real.length && !/\$\(|`/.test(c) && real.every(({ w }) => look.has(w))) return 'check'
  return 'run'
}

/** Does this text read as a shell command rather than words for a person? */
const commandLike = (s: string) => /[|;&`$<>{}\\]|(?:^|\s)--?[A-Za-z]|^\s*(?:cd|ls|npm|npx|pnpm|yarn|bun|node|python3?|pip3?|sh|bash|curl|wget|git|find|sleep|export|rm|mkdir|cp|mv|cat|echo|ffmpeg|sudo)\s/i.test(s) || /\b[A-Za-z_][A-Za-z0-9_]*=\S/.test(s)

/** The AI's plain description of a command (box_shell `description`) as it may show in a step line: one line, at most
 * 60 characters, without "$TRINA_WORK"-like paths or "NAME=value" settings, and without " · " (the line's divider);
 * '' when nothing is left or it reads like a command itself. */
export function shellDescription(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = maskSecrets(v.slice(0, 300))
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\$\{?TRINA_[A-Z_]+\}?(?:\/[^\s"'`]*)?/g, '')
    .replace(/\s*·\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s || commandLike(s)) return ''
  return clip(s, 60)
}

/** The plain words for a dev-environment command (a step line, a card's question): the AI's description of it, else the
 * words for the command's kind. Never the command. */
export function shellWords(description: unknown, command: string, locale: Locale): string {
  const kind = SHELL_KIND_WORDS[shellKind(command)]
  return shellDescription(description) || (kind[locale] ?? kind.en)
}

/** The words a dev-environment command's step line shows (localizeStep): the description it was saved with, else the
 * plain words for the command's kind; and the command for the step's opened part. Old lines ("<verb> · <command>"),
 * bare commands and lines without a command all come here. */
function shellStepLine(line: string, locale: Locale): { words: string; command: string } {
  const verbs = new Set(Object.values(FILE_STEP_VERB.box_shell!))
  const at = line.indexOf(' · ')
  const head = at < 0 ? line : line.slice(0, at)
  const command = at < 0 ? '' : line.slice(at + 3)
  const kindWords = (c: string) => shellWords('', c, locale)
  if (verbs.has(head)) return { words: kindWords(command), command }
  if (at < 0 && commandLike(head)) return { words: kindWords(head), command: head }
  const said = shellDescription(head)
  return said ? { words: said, command } : { words: kindWords(command || head), command: command || head }
}

const LOCALES: Locale[] = ['en', 'ko', 'id', 'ja', 'es', 'zh']
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The team's well-known folders by name in a step line (docs/DECISIONS.md "W2"): "파일 읽기 · 브랜드 이미지 폴더 ›
 * 홈페이지-6.jpg", not "groups/<team>/브랜드/이미지/홈페이지-6.jpg", which a phone cut before the file's name. */
export const STEP_PLACE = {
  /** groups/<team>/브랜드/이미지/ or shared/브랜드/이미지/ (the brand folder's images folder, named in the team's
   * language) */
  brandImages: t('브랜드 이미지 폴더', 'Brand images folder', 'Folder gambar merek', "ブランド画像フォルダー", "Carpeta de imágenes de marca", "品牌图片文件夹"),
  /** groups/<team>/브랜드/ or shared/브랜드/ */
  brand: t('브랜드 폴더', 'Brand folder', 'Folder merek', "ブランドフォルダー", "Carpeta de marca", "品牌文件夹"),
  /** groups/<team>/회의록/ or shared/회의록/ */
  notes: t('회의록 폴더', 'Meeting notes folder', 'Folder notulen rapat', "議事録フォルダー", "Carpeta de actas", "会议记录文件夹"),
  /** groups/<team>/: the team's folder, by the team's name */
  team: t('{team} 폴더', '{team} folder', 'Folder {team}', "{team}フォルダー", "Carpeta {team}", "{team}文件夹"),
  /** users/<id>/.attachments/<chat>/: what the person attached to the chat */
  attachments: t('첨부한 파일', 'Attachments', 'Lampiran', "添付ファイル", "Adjuntos", "附件"),
  /** chat:files/…: the files of this chat (shared/src/places.ts) */
  chatFiles: t('이 채팅', 'This chat', 'Chat ini', "このチャット", "Este chat", "此对话"),
  /** chat:work/…: the chat's work folder ($TRINA_WORK) */
  work: t('작업 폴더', 'Work folder', 'Folder kerja', "作業フォルダー", "Carpeta de trabajo", "工作文件夹"),
  /** users/<id>/: an answer only ever reaches the person's own */
  own: t('내 폴더', 'My folder', 'Folder saya', "自分のフォルダー", "Mi carpeta", "我的文件夹"),
  /** shared/: the whole team's, by the name the file screen gives it (shared/src/folder-labels.ts) */
  shared: TOP_FOLDER_LABELS.shared,
} satisfies Record<string, T>

const nfcSet = (names: Record<Locale, string>) => new Set(Object.values(names).map((n) => n.normalize('NFC')))
const BRAND_NAMES = nfcSet(BRAND_FOLDER)
const IMAGES_NAMES = nfcSet(BRAND_IMAGES_FOLDER)
const NOTES_NAMES = nfcSet(NOTES_FOLDER)

/** A team path with its well-known folder in words ("브랜드 이미지 폴더 › 홈페이지-6.jpg"), or null for any other path
 * (a web address, a folder these words do not name). The folder names match in any language, as a team's folders are
 * named in the team's language and the screen may be in another. */
export function placeName(path: string, locale: Locale): string | null {
  // a chat place (chat:files/<id>/<name>, chat:work/<path>): its words, never the file id; $TRINA_WORK/… (box_shell's
  // spelling of the work folder) reads the same as chat:work/… (QA TC-6937)
  const place = parsePlace(WORK_VAR.test(path.trim()) ? `chat:work${path.trim().replace(WORK_VAR, '')}` : path)
  if (place) {
    if (place.kind === 'chatFiles') return [STEP_PLACE.chatFiles[locale] ?? STEP_PLACE.chatFiles.en, ...(place.name ? [place.name] : [])].join(' › ')
    if (place.kind === 'work') return [STEP_PLACE.work[locale] ?? STEP_PLACE.work.en, ...(place.rel ? place.rel.split('/') : [])].join(' › ')
    return null
  }
  const segs = path.normalize('NFC').replace(/^\/+|\/+$/g, '').split('/')
  if (segs.some((s) => !s)) return null
  const say = (key: keyof typeof STEP_PLACE, from: number, vars: Record<string, string> = {}) =>
    [fill(STEP_PLACE[key][locale] ?? STEP_PLACE[key].en, vars), ...segs.slice(from)].join(' › ')
  const [top, a, b, c] = segs
  if (top === 'groups' && a) {
    if (b && BRAND_NAMES.has(b)) return c && IMAGES_NAMES.has(c) ? say('brandImages', 4) : say('brand', 3)
    if (b && NOTES_NAMES.has(b)) return say('notes', 3)
    return say('team', 2, { team: a })
  }
  // the own folder by the name it has on this server ("내 파일": folder-labels.ts ownFolderLabel)
  if (top === 'users' && a) return b === '.attachments' && c ? say('attachments', 4) : ownFolderWord() === 'files' ? [ownFolderLabel(locale), ...segs.slice(2)].join(' › ') : say('own', 2)
  if (top === 'shared') {
    // the team's start puts the brand and meeting notes folders here since docs/DECISIONS.md "Team folder basics"
    if (a && BRAND_NAMES.has(a)) return b && IMAGES_NAMES.has(b) ? say('brandImages', 3) : say('brand', 2)
    if (a && NOTES_NAMES.has(a)) return say('notes', 2)
    return say('shared', 1)
  }
  return null
}

/** box_shell's spelling of the work folder: $TRINA_WORK, ${TRINA_WORK} */
const WORK_VAR = /^(?:\$TRINA_WORK|\$\{TRINA_WORK\})(?=\/|$)/i

/** a file id (a UUID) as a path segment: never shown in a worded path (QA TC-7048) */
const ID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHAT_PLACE_QUOTED = /(['"`])chat:(files|work)\/([^'"`\n]*)\1/gi
const CHAT_PLACE_BARE = /(^|[\s(=,:\[])chat:(files|work)\/([^\s'"`,;)\]]*)/gi
/** One chat place in words: "This chat › 견적서.pdf", "Work folder › out › a.png"; a file id never shown */
function chatPlaceSaid(kind: string, rest: string, locale: Locale): string {
  const key = kind.toLowerCase() === 'work' ? 'work' : 'chatFiles'
  const segs = rest.split('/').filter((x) => x && !ID_SEG.test(x))
  return [STEP_PLACE[key][locale] ?? STEP_PLACE[key].en, ...segs].join(' › ')
}

/**
 * Any text a person sees beside a step (its line, its error detail) with every chat place in words (QA TC-7048):
 * "No file 'chat:files/<id>/견적서.pdf' …" reads "No file 'This chat › 견적서.pdf' …". A quoted place may hold spaces; a
 * bare one ends at a space. Text without a chat place comes back as it is.
 */
export function chatPlaceWords(text: string, locale: Locale): string {
  if (!/chat:(files|work)\//i.test(text)) return text
  return text
    .replace(CHAT_PLACE_QUOTED, (_all, q: string, kind: string, rest: string) => `${q}${chatPlaceSaid(kind, rest, locale)}${q}`)
    .replace(CHAT_PLACE_BARE, (_all, pre: string, kind: string, rest: string) => `${pre}${chatPlaceSaid(kind, rest, locale)}`)
}

/**
 * A command line with the work folder in words (QA TC-6937): the leading `cd "$TRINA_WORK" &&` goes (a command starts
 * there anyway), and "$TRINA_WORK/out/frame1.png" reads "Work folder › out › frame1.png" (quotes kept as written).
 */
export function shellWorkWords(command: string, locale: Locale): string {
  const w = STEP_PLACE.work[locale] ?? STEP_PLACE.work.en
  return chatPlaceWords(command
    .replace(/^\s*cd\s+(["']?)(?:\$TRINA_WORK|\$\{TRINA_WORK\})(?![\w])\/?\1\s*(?:&&|;)\s*/i, '')
    // a file id in the path is left out (QA TC-7048: "Work folder › .. › files › 01a2005b-… › qa_demo.mp4")
    .replace(/(?:\$TRINA_WORK|\$\{TRINA_WORK\})(?![\w])((?:\/[^\s"'`;|&<>()]*)?)/gi, (_all, rest: string) => [w, ...rest.split('/').filter((x) => x && !ID_SEG.test(x))].join(' › ')), locale)
}

/** Tools whose step line ends in a team path ("<verb> · <path>"; edit_files adds "+N", hwp_render "#page"). */
const PATH_STEP_TOOLS = new Set(['list', 'glob', 'grep', 'search', 'knowledge_explore', 'read', 'write', 'edit', 'edit_files', 'make_file', 'edit_hwp', 'edit_office', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'query_data', 'share_file', 'move_files', 'copy_files', 'rename_file', 'delete_files', 'save_url', 'hwp_render', 'rename_files'])

/**
 * A step line (already in the language on screen, localizeStep) with its team path in words, and that path for a
 * tooltip: { label: "파일 읽기 · 브랜드 이미지 폴더 › 홈페이지-6.jpg", path: "groups/Acme/브랜드/이미지/홈페이지-6.jpg" }.
 * Any other line comes back as it is, without `path`.
 */
export function stepPlace(step: { tool?: string }, label: string, locale: Locale): { label: string; path?: string } {
  const r = toolPlace(step, label, locale)
  // whatever is left of a chat place or a box_shell variable in a tool's line (a tool whose line is not a path, a path
  // cut short), in words: never "chat:files/<id>/", "chat:work/" or "$TRINA_WORK" (QA TC-r2u-09/12/23). Not in the
  // words of a question, a memory or a sub-task, which are someone's own
  return TEXT_STEP_TOOLS.has(step.tool ?? '') ? r : { ...r, label: plainPlaces(r.label, locale) }
}

/** chat:files/<id>/, chat:work/ and $TRINA_WORK inside a step line, in words. ($TRINA_TEAM is not: a file tool takes it as
 * a folder of that name, so a line shows it as written.) */
function plainPlaces(label: string, locale: Locale): string {
  if (!/chat:|\$\{?TRINA_WORK/i.test(label)) return label
  const files = STEP_PLACE.chatFiles[locale] ?? STEP_PLACE.chatFiles.en
  const work = STEP_PLACE.work[locale] ?? STEP_PLACE.work.en
  return shellWorkWords(label
    .replace(/\bchat:files\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?)?/gi, `${files} › `)
    .replace(/\bchat:work\/?/gi, `${work} › `), locale)
    .replace(/ › (?=\s|$)/g, '')
}

function toolPlace(step: { tool?: string }, label: string, locale: Locale): { label: string; path?: string } {
  // a command saved before its line said the work folder in words
  if (step.tool === 'box_shell') {
    const at = label.indexOf(' · ')
    return { label: at < 0 ? label : label.slice(0, at + 3) + shellWorkWords(label.slice(at + 3), locale) }
  }
  if (!PATH_STEP_TOOLS.has(step.tool ?? '')) return { label: chatPlaceWords(label, locale) }
  // a call let through without a card ends in " · <why>" (QA 2026-11-11: the 2nd and 3rd saves after one card's
  // "이번만 허용" showed their raw path): the path is before it, and the why stays after the path in words
  const cover = coverWhy(label)?.end ?? null
  const line = cover ? label.slice(0, -cover.length) : label
  const at = line.lastIndexOf(' · ')
  if (at < 0) return { label: chatPlaceWords(label, locale) }
  const tail = line.slice(at + 3)
  const [, path = tail, suffix = ''] = /^(.*?)( \+\d+| #\d+)?$/s.exec(tail) ?? []
  const named = placeName(path, locale)
  // a chat place is the chat's own: no tooltip with its inner path and file id (QA TC-7048)
  if (named && parsePlace(path)) return { label: `${line.slice(0, at + 3)}${named}${suffix}${cover ?? ''}` }
  if (named) return { label: `${line.slice(0, at + 3)}${named}${suffix}${cover ?? ''}`, path }
  // a chat place the line names some other way (cut short, or after "->"): in words all the same
  const worded = chatPlaceWords(label, locale)
  return worded !== label ? { label: worded } : { label }
}

/** The " · <why>" a line ends in when its call went on without a card (COVER_STEP_KEYS, in any language), with its key,
 * or null. */
function coverWhy(label: string): { end: string; key: (typeof COVER_STEP_KEYS)[number] } | null {
  for (const key of COVER_STEP_KEYS) for (const l of LOCALES) {
    const end = ` · ${STEP_TEXT[key][l]}`
    if (label.endsWith(end) && label.length > end.length) return { end, key }
  }
  return null
}

/** "Remembered: {text}" -> /^Remembered: ([\s\S]*)$/ with the names of the captured parts. */
function templateMatch(template: string, label: string): Record<string, string> | null {
  const names: string[] = []
  const re = new RegExp('^' + template.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part)
    if (!m) return escape(part)
    names.push(m[1]!)
    return '([\\s\\S]*)'
  }).join('') + '$')
  const hit = re.exec(label)
  if (!hit) return null
  return Object.fromEntries(names.map((n, i) => [n, hit[i + 1] ?? '']))
}

/** Earlier wordings: the Korean before 0.2.16 (합니다체), and every language before the plain-words pass (engine names,
 * model ids; docs/DECISIONS.md "Plain words in errors, cards and steps"). Steps saved with them still follow the
 * language on screen, in today's words (a model id or an engine name they held is left out). Matching only. */
const LEGACY: Partial<Record<StepTextKey, readonly string[]>> = {
  refusedRetry: ['AI가 답하지 않아 다른 모델({model})로 다시 답합니다', 'AI가 답하지 않아 다른 모델({model})로 다시 답해요', 'The AI declined; answering again with another model ({model})', 'AI menolak; menjawab ulang dengan model lain ({model})', "AIが拒否したため、別のモデル（{model}）で再回答します", "La IA rechazó la solicitud; se responde de nuevo con otro modelo ({model})"],
  engineOffDefault: ['고른 AI를 지금 쓸 수 없어 팀 기본 AI로 답해요', "The chosen AI is off; answering with the team's default AI", 'AI yang dipilih sedang mati; menjawab dengan AI bawaan tim', "選んだAIは今使えないため、チームの既定のAIで回答します", "La IA elegida está desactivada; se responde con la IA predeterminada del equipo", "所选AI已关闭，改用团队默认AI回答", '{from} 엔진이 꺼져 있어 팀 기본 엔진({to})으로 답합니다', '{from} 엔진이 꺼져 있어 팀 기본 엔진({to})으로 답해요', '{from} is switched off; answering with the team default ({to})', '{from} dimatikan; menjawab dengan mesin bawaan tim ({to})', "{from}が無効のため、チームの既定（{to}）で回答します", "{from} está desactivado; se responde con el predeterminado del equipo ({to})"],
  engineNoConnection: ['{from}에 쓸 AI 연결이 없어 연결된 {to}로 답해요', 'No AI connection for {from}; answering with {to}, which is connected', 'Tidak ada koneksi AI untuk {from}; menjawab dengan {to} yang terhubung', "{from}用のAI接続がないため、接続済みの{to}で回答します", "No hay conexión de IA para {from}; se responde con {to}, que sí está conectado"],
  limitFallback: ['{from} 사용 한도에 닿아 {to} 엔진으로 이어서 답합니다', '{from} 사용 한도에 닿아 {to} 엔진으로 이어서 답해요', '{from} usage limit reached; continuing with {to}', 'Batas pemakaian {from} tercapai; dilanjutkan dengan {to}', "{from}の使用量上限に達したため、{to}で続けます", "Se alcanzó el límite de uso de {from}; se continúa con {to}"],
  credentialSwitchLimit: ['사용 한도에 닿아 다른 AI 연결로 이어서 답합니다', '사용 한도에 닿아 다른 AI 연결로 이어서 답해요', 'Usage limit reached; continuing with another AI connection', 'Batas pemakaian tercapai; dilanjutkan dengan koneksi AI lain', "使用量の上限に達したため、別のAI接続で続けます", "Se alcanzó el límite de uso; se continúa con otra conexión de IA"],
  credentialSwitchInvalid: ['AI 연결이 거절되어 다른 연결로 이어서 답합니다', 'AI 연결이 거절되어 다른 연결로 이어서 답해요', 'The AI connection was refused; continuing with another one', 'Koneksi AI ditolak; dilanjutkan dengan koneksi lain', "AI接続が拒否されたため、別の接続で続けます", "Se rechazó la conexión de IA; se continúa con otra"],
}
/** Verbs before the plain-words pass, in every language: a stored step that starts with one is said with today's verb. */
const LEGACY_VERBS: Record<string, readonly string[]> = {
  artifact: ['아티팩트', 'Artifact', 'Artefak', "アーティファクト", "Artefacto"],
  knowledge_explore: ['지식 그래프 검색', 'Search knowledge graph', 'Cari di grafik pengetahuan', "ナレッジグラフを検索", "Buscar en el grafo de conocimiento"],
  find_tools: ['도구 찾기', 'Find tools', 'Cari alat', "ツールを探す", "Buscar herramientas"],
  hwp_render: ['View HWP page', 'Lihat halaman HWP', "HWPのページを表示", "Ver página HWP"],
  javascript_tool: ['페이지 스크립트 실행', 'Run page script', 'Jalankan skrip halaman', "ページのスクリプトを実行", "Ejecutar script de página"],
  read_console_messages: ['콘솔 보기', 'Read console', 'Baca konsol', "コンソールを読む", "Leer consola"],
  read_network_requests: ['네트워크 보기', 'Read network', 'Baca jaringan', "ネットワークを読む", "Leer red"],
}

/** A whole-label template in any language (or its older Korean wording) -> the same template in `locale`. */
function retemplate(keys: StepTextKey[], label: string, locale: Locale): string | null {
  for (const key of keys) for (const template of [...LOCALES.map((l) => STEP_TEXT[key][l]), ...(LEGACY[key] ?? [])]) {
    const vars = template === undefined ? null : templateMatch(template, label)
    if (vars) return stepText(key, locale, vars)
  }
  return null
}

/** "<verb in any language><rest>" -> "<verb in `locale`><rest>" (the longest matching verb wins; `older`: earlier
 * wordings of the same verb). */
function reverb(verbs: T, label: string, locale: Locale, older: readonly string[] = []): string | null {
  const known = [...LOCALES.map((l) => verbs[l]), ...older].sort((a, b) => b.length - a.length)
  for (const v of known) {
    if (label === v) return verbs[locale]
    if (label.startsWith(v) && (label[v.length] === ' ')) return verbs[locale] + label.slice(v.length)
  }
  return null
}

/** box_shell's " (job)" / " (background)" ending in any language (English in every language before): the line
 * without it, and which one it was. */
function shellEnding(label: string): { line: string; key: 'jobSuffix' | 'backgroundSuffix' | null } {
  for (const [key, old] of [['jobSuffix', 'job'], ['backgroundSuffix', 'background']] as const) {
    for (const w of [old, ...LOCALES.map((l) => STEP_TEXT[key][l])]) {
      if (label.endsWith(` (${w})`)) return { line: label.slice(0, -w.length - 3), key }
    }
  }
  return { line: label, key: null }
}

/** A step whose card ran out without an answer (a question, or remember's "may I keep this?"): its detail says so, in
 * whatever language the answer ran in. Not a success, so the web app gives it a mark of its own (Steps.tsx stepMark). */
export function unansweredStep(step: { tool?: string; detail?: string }): boolean {
  return (step.tool === 'ask_user' || step.tool === 'remember') && step.detail !== undefined && LOCALES.some((l) => STEP_TEXT.notAnswered[l] === step.detail)
}

/**
 * A stored step (label written in whatever language the answer ran in) in the language on screen. Steps whose label
 * is not one of these templates (an engine's own words, a newer server's label) keep their label.
 */
export function localizeStep(step: { kind: string; tool?: string; label: string; detail?: string }, locale: Locale, browserTools?: ReadonlySet<string>): { label: string; detail?: string } {
  const tool = step.tool ?? ''
  let label: string | null = null
  if (step.kind === 'thinking') label = retemplate(['thinking'], step.label, locale)
  else if (step.kind === 'web_search') label = retemplate(['webSearch', 'webSearchRunning', 'webSearchOpen', 'webSearchPlain'], step.label, locale)
  else if (tool === 'refusal') label = retemplate(['refusedRetry'], step.label, locale)
  else if (tool === 'demo_replay') label = retemplate(['demoReplay'], step.label, locale)
  else if (tool === 'history_summary') label = retemplate(['historySummary'], step.label, locale)
  else if (tool === 'engine') label = retemplate(['engineOffDefault', 'engineNoConnection', 'limitFallback', 'credentialSwitchLimit', 'credentialSwitchInvalid'], step.label, locale)
  else if (tool === 'attachment') label = retemplate(['attachChanged', 'attachMoved', 'attachUnavailable'], step.label, locale)
  else if (tool === 'context') label = retemplate(['contextRecover'], step.label, locale)
  else if (tool === 'agent') label = retemplate(['subtask'], step.label, locale)
  else if (tool === 'ask_user') label = retemplate(['asked'], step.label, locale)
  else if (tool === 'remember') label = retemplate(['remembered', 'notRemembered', 'rememberAsking', 'rememberUpdated', 'notRememberedSecret'], step.label, locale)
  else if (tool === 'forget') label = retemplate(['forgotText', 'forgot'], step.label, locale)
  else if (BROWSER_STEP_VERB[tool] || step.kind === 'browser' || browserTools?.has(tool)) label = reverb(BROWSER_STEP_VERB[tool] ?? BROWSER_STEP_FALLBACK, step.label, locale, LEGACY_VERBS[tool])
  else if (tool === 'read') label = reverb(READ_MEDIA_VERB.video, step.label, locale) ?? reverb(READ_MEDIA_VERB.audio, step.label, locale) ?? reverb(READ_SLIDES_VERB, step.label, locale) ?? reverb(FILE_STEP_VERB.read!, step.label, locale)
  else if (tool === 'artifact') label = reverb(ARTIFACT_ACTION_VERB.edit, step.label, locale) ?? reverb(ARTIFACT_ACTION_VERB.read, step.label, locale) ?? reverb(ARTIFACT_ACTION_VERB.restore, step.label, locale) ?? reverb(FILE_STEP_VERB.artifact!, step.label, locale, LEGACY_VERBS[tool])
  else if (tool !== 'box_shell' && FILE_STEP_VERB[tool]) label = reverb(FILE_STEP_VERB[tool]!, step.label, locale, LEGACY_VERBS[tool])
  const details: StepTextKey[] = tool === 'connect_service' ? ['connectConnected', 'connectNotConnected'] : ['notAnswered', 'webSearchRefused']
  let detail = step.detail !== undefined ? (retemplate(details, step.detail, locale) ?? step.detail) : undefined
  // a dev-environment command: plain words on the line (the AI's description, else what kind of command it is), and the
  // command itself only in the opened part (people are not developers); its " (job)" / " (background)" ending (English
  // in every language before) in the language on screen, and why it went on without a card after it
  if (tool === 'box_shell' && step.kind === 'tool') {
    const why = coverWhy(step.label)
    const { line, key } = shellEnding(why ? step.label.slice(0, -why.end.length) : step.label)
    const tail = key ? ` (${STEP_TEXT[key][locale] ?? STEP_TEXT[key].en})` : ''
    const shown = shellStepLine(line, locale)
    label = `${shown.words}${tail}${why ? ` · ${STEP_TEXT[why.key][locale] ?? STEP_TEXT[why.key].en}` : ''}`
    if (shown.command) detail = detail ? `${shown.command}\n\n${detail}` : shown.command
    return { label, ...(detail !== undefined ? { detail } : {}) }
  }
  // why a call went on without a card, at the end of a tool's line: in the screen's language too (not in the words of
  // a question, a memory or a sub-task, which are the AI's or the person's)
  let out = label ?? step.label
  const why = step.kind === 'tool' && !TEXT_STEP_TOOLS.has(tool) ? coverWhy(out) : null
  if (why) out = `${out.slice(0, -why.end.length)} · ${STEP_TEXT[why.key][locale] ?? STEP_TEXT[why.key].en}`
  return { label: out, ...(detail !== undefined ? { detail } : {}) }
}
