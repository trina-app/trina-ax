// Words of the step list under an answer ("Read · shared/fruit.md", "Remembered: …", "Thinking"), in ko / en / id.
// The server stores a label in the language of the person who ran the answer (older readers show it as is); the web
// app redraws it in the language on screen from these same words, so an old chat follows a later language switch
// (docs/DECISIONS.md "언어"). A label is always "<words> + what the AI touched" (a path, a query, a remembered text),
// and only the words are translated. On screen, a path's well-known team folders are said in words (stepPlace).
import type { Locale } from './api/common'
import { BRAND_FOLDER, BRAND_IMAGES_FOLDER, NOTES_FOLDER } from './api/onboarding-packs'
import { TOP_FOLDER_LABELS } from './folder-labels'
import { mediaKind, type MediaKind } from './media'
import { maskSecrets } from './secrets'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

/** Verb of a file / team tool step: "<verb> · <path>". */
export const FILE_STEP_VERB: Record<string, T> = {
  list: t('폴더 보기', 'List', 'Lihat folder', "一覧", "Listar"),
  glob: t('파일 찾기', 'Find files', 'Cari berkas', "ファイルを探す", "Buscar archivos"),
  grep: t('내용 검색', 'Search', 'Cari isi', "検索", "Buscar"),
  read: t('파일 읽기', 'Read', 'Baca berkas', "読み取り", "Leer"),
  write: t('파일 저장', 'Save', 'Simpan berkas', "保存", "Guardar"),
  edit: t('파일 수정', 'Edit', 'Ubah berkas', "編集", "Editar"),
  edit_files: t('여러 파일 수정', 'Edit files', 'Ubah beberapa berkas', "複数のファイルを編集", "Editar archivos"),
  make_file: t('파일 만들기', 'Make file', 'Buat berkas', "ファイルを作成", "Crear archivo"),
  edit_hwp: t('한글 문서 고치기', 'Edit Hangul document', 'Ubah dokumen Hangul', "ハングル文書を編集", "Editar documento Hangul"),
  share_file: t('파일 공유 링크', 'Share link', 'Tautan berkas', "リンクを共有", "Compartir enlace"),
  move_files: t('파일 옮기기', 'Move files', 'Pindahkan berkas', "ファイルを移動", "Mover archivos"),
  copy_files: t('파일 복사', 'Copy files', 'Salin berkas', "ファイルをコピー", "Copiar archivos"),
  rename_file: t('이름 바꾸기', 'Rename', 'Ganti nama', "名前を変更", "Cambiar nombre"),
  delete_files: t('휴지통으로 옮기기', 'Move to trash', 'Pindahkan ke tempat sampah', "ゴミ箱に移動", "Mover a la papelera"),
  artifact: t('아티팩트', 'Artifact', 'Artefak', "アーティファクト", "Artefacto"),
  web_fetch: t('웹 페이지 가져오기', 'Fetch page', 'Ambil halaman', "ページを取得", "Obtener página"),
  save_url: t('파일 받아 저장', 'Download file', 'Unduh berkas', "ファイルをダウンロード", "Descargar archivo"),
  hwp_render: t('한글 문서 쪽 보기', 'View HWP page', 'Lihat halaman HWP', "HWPのページを表示", "Ver página HWP"),
  // the removed search by meaning tool: its steps stay in older chats
  search: t('뜻으로 찾기', 'Search by meaning', 'Cari berdasarkan makna', "意味で検索", "Buscar por significado"),
  knowledge_explore: t('지식 그래프 검색', 'Search knowledge graph', 'Cari di grafik pengetahuan', "ナレッジグラフを検索", "Buscar en el grafo de conocimiento"),
  schedule_create: t('예약 작업 만들기', 'Create scheduled task', 'Buat tugas terjadwal', "定期タスクを作成", "Crear tarea programada"),
  schedule_list: t('예약 작업 보기', 'List scheduled tasks', 'Lihat tugas terjadwal', "定期タスクを一覧表示", "Listar tareas programadas"),
  schedule_delete: t('예약 작업 지우기', 'Delete scheduled task', 'Hapus tugas terjadwal', "定期タスクを削除", "Eliminar tarea programada"),
  drive_search: t('Google Drive 검색', 'Search Google Drive', 'Cari di Google Drive', "Google ドライブを検索", "Buscar en Google Drive"),
  drive_list: t('Google Drive 폴더 보기', 'List Google Drive folder', 'Lihat folder Google Drive', "Google ドライブのフォルダを表示", "Listar carpeta de Google Drive"),
  drive_read: t('Google Drive 파일 읽기', 'Read Google Drive file', 'Baca berkas Google Drive', "Google ドライブのファイルを読む", "Leer archivo de Google Drive"),
  generate_video: t('동영상 만들기', 'Generate video', 'Buat video', "動画を生成", "Generar video"),
  promo_video: t('홍보 영상 만들기', 'Make promo video', 'Buat video promosi', "プロモーション動画を作成", "Crear vídeo promocional"),
  intro_deck: t('회사 소개서 만들기', 'Make company profile', 'Buat profil perusahaan', "会社紹介資料を作成", "Crear presentación corporativa"),
  box_shell: t('개발 환경 명령', 'Dev environment command', 'Perintah lingkungan pengembangan', "開発環境のコマンド", "Comando del entorno de desarrollo"),
  ask_user: t('질문', 'Question', 'Pertanyaan', "質問", "Pregunta"),
  skill: t('스킬 사용', 'Use skill', 'Pakai skill', "スキルを使用", "Usar habilidad"),
  find_skills: t('스킬 찾기', 'Find skills', 'Cari skill', "スキルを探す", "Buscar habilidades"),
  move_skill: t('스킬 옮기기', 'Move skill', 'Pindahkan skill', "スキルを移動", "Mover habilidad"),
  skill_files: t('스킬 폴더 파일', 'Skill folder files', 'Berkas folder skill', "スキルフォルダーのファイル", "Archivos de carpeta de habilidades"),
  find_tools: t('도구 찾기', 'Find tools', 'Cari alat', "ツールを探す", "Buscar herramientas"),
  // no step under an answer (server/src/chat/turn.ts HIDDEN_STEP_TOOLS), but the activity log names it (QA TC-069)
  set_title: t('채팅 이름 짓기', 'Name the chat', 'Beri nama obrolan', "チャットに名前を付ける", "Poner nombre al chat"),
  remember: t('기억하기', 'Remember', 'Ingat', "記憶", "Recordar"),
  forget: t('기억 지우기', 'Forget', 'Lupakan', "忘れる", "Olvidar"),
  connect_service: t('서비스 연결', 'Connect service', 'Hubungkan layanan', "サービスを接続", "Conectar servicio"),
  // the person's own team chat rooms (server/src/chat/room-tools.ts): "대화방 읽기 · 마케팅", "대화방 찾기 "예산""
  rooms: t('대화방 찾기', 'Find in conversations', 'Cari di ruang obrolan', "トークルームを探す", "Buscar en salas de chat"),
  room_read: t('대화방 읽기', 'Read conversation', 'Baca ruang obrolan', "トークルームを読む", "Leer sala de chat"),
  room_file: t('대화방 파일 읽기', 'Read conversation file', 'Baca berkas ruang obrolan', "トークルームのファイルを読む", "Leer archivo de sala de chat"),
  save_room_file: t('대화방 파일 저장', 'Save conversation file', 'Simpan berkas ruang obrolan', "トークルームのファイルを保存", "Guardar archivo de sala de chat"),
  // the AI posts to one of the person's rooms after their yes on its card (server/src/chat/post-to-room.ts): "대화방에
  // 보내기 · #영업팀", the room named by the server once found (the button's words: shared rooms.ts SIDE_CHAT_SEND)
  post_to_room: t('대화방에 보내기', 'Send to room', 'Kirim ke ruang', 'ルームに送る', 'Enviar a la sala'),
  // the AI changes a team project's members after the person's yes on its card (server/src/chat/project-members.ts):
  // "프로젝트 멤버 바꾸기 · 견적"
  change_project_members: t('프로젝트 멤버 바꾸기', 'Change project members', 'Ubah anggota proyek', 'プロジェクトのメンバーを変更', 'Cambiar miembros del proyecto'),
  // a room's own AI session opens one of the room's threads (an id means nothing to the person: the verb alone)
  room_thread: t('스레드 읽기', 'Read thread', 'Baca utas', "スレッドを読む", "Leer hilo"),
  // a room's own AI session finds and reads the shared project chats the asker may view (server/src/chat/room-project-chats.ts):
  // a chat is named ("프로젝트 채팅 읽기 · 견적 회의") only when everyone in the room sees its project, else the words alone
  project_chats: t('프로젝트 채팅 찾기', 'Find project chats', 'Cari obrolan proyek', "プロジェクトのチャットを探す", "Buscar chats del proyecto"),
  project_chat: t('프로젝트 채팅 읽기', 'Read project chat', 'Baca obrolan proyek', "プロジェクトのチャットを読む", "Leer chat del proyecto"),
}

/** Verb of an in-app browser step: "<verb> · <url>". */
export const BROWSER_STEP_VERB: Record<string, T> = {
  preview_start: t('브라우저 열기', 'Open browser', 'Buka browser', "ブラウザーを開く", "Abrir navegador"),
  navigate: t('페이지 열기', 'Open page', 'Buka halaman', "ページを開く", "Abrir página"),
  read_page: t('페이지 읽기', 'Read page', 'Baca halaman', "ページを読む", "Leer página"),
  get_page_text: t('페이지 읽기', 'Read page', 'Baca halaman', "ページを読む", "Leer página"),
  find: t('페이지에서 찾기', 'Find on page', 'Cari di halaman', "ページ内を検索", "Buscar en la página"),
  computer: t('브라우저 조작', 'Use browser', 'Operasikan browser', "ブラウザーを操作", "Usar navegador"),
  form_input: t('양식 채우기', 'Fill form', 'Isi formulir', "フォームに入力", "Rellenar formulario"),
  javascript_tool: t('페이지 스크립트 실행', 'Run page script', 'Jalankan skrip halaman', "ページのスクリプトを実行", "Ejecutar script de página"),
  browser_batch: t('브라우저 여러 단계', 'Browser steps', 'Beberapa langkah browser', "ブラウザーの手順", "Pasos del navegador"),
  resize_window: t('화면 크기 바꾸기', 'Resize', 'Ubah ukuran', "サイズを変更", "Cambiar tamaño"),
  read_console_messages: t('콘솔 보기', 'Read console', 'Baca konsol', "コンソールを読む", "Leer consola"),
  read_network_requests: t('네트워크 보기', 'Read network', 'Baca jaringan', "ネットワークを読む", "Leer red"),
  tabs_context: t('탭 보기', 'List tabs', 'Lihat tab', "タブを一覧表示", "Listar pestañas"),
  tabs_create: t('새 탭', 'New tab', 'Tab baru', "新しいタブ", "Nueva pestaña"),
  tabs_select: t('탭 바꾸기', 'Switch tab', 'Ganti tab', "タブを切り替え", "Cambiar pestaña"),
  tabs_close: t('탭 닫기', 'Close tab', 'Tutup tab', "タブを閉じる", "Cerrar pestaña"),
}
/** A read of a video or an audio file has its own verb ("Watch video · promo.mp4"), chosen by the file's extension. */
export const READ_MEDIA_VERB: Record<MediaKind, T> = {
  video: t('영상 보기', 'Watch video', 'Tonton video', "動画を見る", "Ver video"),
  audio: t('오디오 듣기', 'Listen to audio', 'Dengarkan audio', "音声を聞く", "Escuchar audio"),
}

/** Whether a stored read step was a video or an audio read (by its verb, in any language): the web app's icon. */
export function mediaStepKind(step: { tool?: string; label: string }): MediaKind | null {
  if (step.tool !== 'read') return null
  for (const k of ['video', 'audio'] as const) for (const v of Object.values(READ_MEDIA_VERB[k])) if (step.label === v || step.label.startsWith(v + ' ')) return k
  return null
}

/** Tools that only look things up: the read-only Explore helper's tools (server/src/chat/subagents.ts EXPLORE_TOOLS).
 * A failed call of one changed nothing, so the steps list under an answer that did not fail shows it with the quiet
 * mark even when no later step worked (web/src/components/chat/Steps.tsx stepMark). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list', 'glob', 'grep', 'read', 'knowledge_explore', 'skill', 'find_skills', 'drive_list', 'drive_read', 'drive_search', 'hwp_render', 'web_fetch'])

export const BROWSER_STEP_FALLBACK: T = t('브라우저', 'Browser', 'Browser', "ブラウザー", "Navegador")

/** Whole-label templates ({x} = what the AI touched, never translated). */
export const STEP_TEXT = {
  asked: t('질문: {q}', 'Question: {q}', 'Pertanyaan: {q}', "質問：{q}", "Pregunta: {q}"),
  remembered: t('기억함: {text}', 'Remembered: {text}', 'Diingat: {text}', "記憶しました：{text}", "Recordado: {text}"),
  notRemembered: t('기억하지 않음: {text}', 'Not remembered: {text}', 'Tidak diingat: {text}', "記憶しませんでした：{text}", "No se recordó: {text}"),
  forgot: t('기억 지움', 'Forgot a memory', 'Ingatan dihapus', "メモリを削除しました", "Se olvidó una memoria"),
  notAnswered: t('답하지 않음', 'Not answered', 'Tidak dijawab', "未回答", "Sin respuesta"),
  /** detail of a connect_service step: the person finished the card (or it was connected already), or did not */
  connectConnected: t('연결됨', 'Connected', 'Terhubung', "接続済み", "Conectado"),
  connectNotConnected: t('연결 안 됨', 'Not connected', 'Tidak terhubung', "未接続", "No conectado"),
  webSearch: t('웹 검색: {q}', 'Web search: {q}', 'Cari di web: {q}', "Web検索：{q}", "Búsqueda web: {q}"),
  /** a search still running whose query is not known yet (Codex names it only at the end) */
  webSearchRunning: t('웹 검색 중…', 'Searching the web…', 'Mencari di web…', "Web検索中…", "Buscando en la web…"),
  /** a Codex search that opened (or looked inside) one of its results: it names no query */
  webSearchOpen: t('검색 결과 열기', 'Opening a search result', 'Membuka hasil pencarian', "検索結果を開く", "Abriendo un resultado de búsqueda"),
  /** a Codex search that named nothing (finance, weather, time …) */
  webSearchPlain: t('웹 검색', 'Web search', 'Cari di web', "Web検索", "Búsqueda web"),
  /** detail of a search the team server refused to send (it named an address, not a result of the search) */
  webSearchRefused: t('거절됨: 검색으로는 그 검색의 결과만 열 수 있어요. AI에게 그 주소는 웹 페이지 가져오기(주소 확인 카드)로 열라고 알렸어요.',
    'Refused: a search opens only its own results. The AI was told to fetch the address instead (with the address card).',
    'Ditolak: pencarian hanya membuka hasilnya sendiri. AI diminta mengambil alamat itu dengan Ambil halaman (dengan kartu alamat).',
    "拒否：検索で開けるのはその検索の結果だけです。そのアドレスは「ページを取得」（アドレスの確認カード）で開くようAIに伝えました。",
    "Rechazado: una búsqueda solo abre sus propios resultados. Se indicó a la IA que obtenga la dirección con «Obtener página» (con la tarjeta de dirección)."),
  thinking: t('생각하는 중', 'Thinking', 'Berpikir', "考え中", "Pensando"),
  attachChanged: t('첨부한 뒤 바뀐 파일, 지금 내용으로 읽음 · {path}', 'Attached file changed since it was attached; using the current version · {path}', 'Berkas lampiran berubah sejak dilampirkan; memakai versi terkini · {path}', "添付後にファイルが変更されたため、現在のバージョンを使用します · {path}", "El archivo cambió desde que se adjuntó; se usa la versión actual · {path}"),
  attachMoved: t('첨부한 파일이 옮겨짐 · {path}', 'Attached file moved · {path}', 'Berkas lampiran dipindah · {path}', "添付ファイルが移動しました · {path}", "El archivo adjunto se movió · {path}"),
  attachUnavailable: t('첨부한 팀 파일을 더 이상 쓸 수 없음', 'An attached team file is no longer available', 'Berkas tim yang dilampirkan tidak tersedia lagi', "添付したチームのファイルは利用できなくなりました", "Un archivo adjunto del equipo ya no está disponible"),
  refusedRetry: t('AI가 답하지 않아 다른 모델({model})로 다시 답해요', 'The AI declined; answering again with another model ({model})', 'AI menolak; menjawab ulang dengan model lain ({model})', "AIが拒否したため、別のモデル（{model}）で再回答します", "La IA rechazó la solicitud; se responde de nuevo con otro modelo ({model})"),
  /** the chat's engine was switched off by an admin: this answer uses the team default */
  /** demo mode (server/src/demo/replay.ts): the answer is a recorded real run played again */
  demoReplay: t('데모용으로 미리 준비한 결과예요', 'Prepared in advance for the demo', 'Disiapkan sebelumnya untuk demo', "デモ用に事前に用意した結果です", "Preparado de antemano para la demostración"),
  engineOffDefault: t('{from} 엔진이 꺼져 있어 팀 기본 엔진({to})으로 답해요', '{from} is switched off; answering with the team default ({to})', '{from} dimatikan; menjawab dengan mesin bawaan tim ({to})', "{from}が無効のため、チームの既定（{to}）で回答します", "{from} está desactivado; se responde con el predeterminado del equipo ({to})"),
  /** "다른 AI로 대신 답하기": the chat's engine has no AI connection for the person, the other one has
   * (server/src/credentials/access.ts connectionRoute) */
  engineNoConnection: t('{from}에 쓸 AI 연결이 없어 연결된 {to}로 답해요', 'No AI connection for {from}; answering with {to}, which is connected', 'Tidak ada koneksi AI untuk {from}; menjawab dengan {to} yang terhubung', "{from}用のAI接続がないため、接続済みの{to}で回答します", "No hay conexión de IA para {from}; se responde con {to}, que sí está conectado"),
  /** "다른 AI로 대신 답하기": the Claude subscription limit was hit and the admin allowed the fallback */
  limitFallback: t('{from} 사용 한도에 닿아 {to} 엔진으로 이어서 답해요', '{from} usage limit reached; continuing with {to}', 'Batas pemakaian {from} tercapai; dilanjutkan dengan {to}', "{from}の使用量上限に達したため、{to}で続けます", "Se alcanzó el límite de uso de {from}; se continúa con {to}"),
  credentialSwitchLimit: t('사용 한도에 닿아 다른 AI 연결로 이어서 답해요', 'Usage limit reached; continuing with another AI connection', 'Batas pemakaian tercapai; dilanjutkan dengan koneksi AI lain', "使用量の上限に達したため、別のAI接続で続けます", "Se alcanzó el límite de uso; se continúa con otra conexión de IA"),
  /** a sub-agent's part of the answer (Claude Code's Agent tool); {d} is the AI's own short description of it */
  subtask: t('하위 작업: {d}', 'Sub-task: {d}', 'Subtugas: {d}', "サブタスク：{d}", "Subtarea: {d}"),
  credentialSwitchInvalid: t('AI 연결이 거절되어 다른 연결로 이어서 답해요', 'The AI connection was refused; continuing with another one', 'Koneksi AI ditolak; dilanjutkan dengan koneksi lain', "AI接続が拒否されたため、別の接続で続けます", "Se rechazó la conexión de IA; se continúa con otra"),
  // after a step's own line (" · <these>"): why the call went on without a card (server/src/chat/turn.ts coverStep,
  // chat/schedule-cover.ts). COVER_STEP_KEYS: localizeStep and stepPlace know them at the end of any line
  /** the step of a call a room grant let through, after its own words */
  roomGrantStep: t('항상 허용으로 진행', 'allowed: always in this room', 'diizinkan: selalu di ruang ini', "常に許可で実行", "permitido: siempre en esta sala"),
  /** the step of a call this answer's [이번만 허용] for its folder let through */
  roomOnceStep: t('이번만 허용으로 진행', 'allowed once in this answer', 'diizinkan sekali di jawaban ini', "今回だけ許可で実行", "permitido esta vez en esta respuesta"),
  /** the step of a scheduled run's save or send that its task's card allowed (chat/schedule-cover.ts) */
  scheduleCoverStep: t('예약 작업에서 허용', 'allowed on the scheduled task', 'diizinkan di tugas terjadwal', "定期タスクで許可", "permitido en la tarea programada"),
  /** the step of a call that made a new file in the person's own folder after a room read, with no card */
  ownFolderStep: t('내 폴더라 묻지 않고 저장', 'saved without asking: your own folder', 'disimpan tanpa bertanya: folder Anda sendiri', "自分のフォルダーなので確認せずに保存", "guardado sin preguntar: su propia carpeta"),
} satisfies Record<string, T>
export type StepTextKey = keyof typeof STEP_TEXT

/** The words that may end any step's line after " · ": why the call went on without a card (STEP_TEXT above). */
export const COVER_STEP_KEYS = ['roomGrantStep', 'roomOnceStep', 'scheduleCoverStep', 'ownFolderStep'] as const satisfies readonly StepTextKey[]

/** The word for a step whose tool has no verb of its own, when only the words of a step may show. */
export const STEP_WORDS_OTHER: T = t('작업', 'Step', 'Langkah', "ステップ", "Paso")
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
    case 'glob': return `${verb} "${clip(a.pattern, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'grep': return `${verb} "${clip(a.pattern, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'read': {
      const k = mediaKind(String(a.file_path ?? ''))
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
    case 'share_file': return `${verb} · ${clip(a.path, 90)}`
    case 'move_files': case 'copy_files': return `${verb} · ${clip(a.to_folder, 90)}`
    case 'rename_file': return `${verb} · ${clip(a.path, 90)}`
    case 'skill_files': return `${verb} · ${clip(a.path, 60)}${a.to_folder ? ` → ${clip(a.to_folder, 40)}` : a.new_name ? ` → ${clip(a.new_name, 40)}` : ''}`
    case 'delete_files': {
      // the first item and how many more ("+3": a number, the same in every language)
      const paths = Array.isArray(a.paths) ? [...new Set(a.paths)] : []
      return paths.length ? `${verb} · ${clip(paths[0], 80)}${paths.length > 1 ? ` +${paths.length - 1}` : ''}` : verb!
    }
    case 'artifact': return `${verb} · ${clip(a.title ?? a.key, 80)}`
    case 'web_fetch': return `${verb} · ${clip(a.url, 80)}`
    case 'save_url': return `${verb} · ${clip(a.save_as || a.url, 80)}`
    case 'hwp_render': return `${verb} · ${clip(a.source, 80)}${typeof a.page === 'number' ? ` #${a.page}` : ''}`
    case 'search': case 'drive_search': case 'knowledge_explore': return `${verb} "${clip(a.query, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'schedule_create': return `${verb} · ${clip(a.title, 80)}`
    case 'schedule_delete': return `${verb} · ${clip(a.id, 40)}`
    case 'drive_list': return a.folderId && a.folderId !== 'root' ? `${verb} · ${clip(a.folderId, 60)}` : verb!
    case 'drive_read': return `${verb} · ${clip(a.fileId, 60)}`
    case 'generate_video': return `${verb} · ${clip(a.prompt, 80)}`
    case 'promo_video': case 'intro_deck': return `${verb} · ${clip(a.title, 80)}`
    case 'skill': return `${verb} · ${clip(a.name, 80)}`
    case 'move_skill': return `${verb} · ${clip(a.skill, 60)} → ${clip(a.to === 'group' ? a.group ?? a.to : a.to === 'project' ? a.project ?? a.to : a.to, 40)}`
    case 'find_skills': case 'find_tools': return `${verb} "${clip(a.query, 60)}"`
    // a room the AI passed as an id is named by the server once it is found (the step is patched); "#" tokens by title
    case 'rooms': { const w = roomWord(a.room ?? a.person); return `${verb}${a.query ? ` "${clip(a.query, 60)}"` : ''}${w ? ` · ${clip(w, 60)}` : ''}` }
    case 'room_read': { const w = roomWord(a.room); return w ? `${verb} · ${clip(w, 60)}` : verb! }
    case 'room_file': { const w = roomWord(a.file); return w ? `${verb} · ${clip(w, 60)}` : verb! }
    case 'post_to_room': { const w = roomWord(a.room); return w ? `${verb} · ${clip(w, 60)}` : verb! }
    case 'change_project_members': return a.project ? `${verb} · ${clip(a.project, 60)}` : verb!
    case 'save_room_file': { const w = roomWord(a.file); return w ? `${verb} · ${clip(w, 60)}${a.save_as ? ` → ${clip(a.save_as, 60)}` : ''}` : verb! }
    case 'box_shell': return `${verb} · ${clip(String(a.command ?? '').split('\n')[0], 80)}${a.job ? ' (job)' : a.background ? ' (background)' : ''}`
    case 'ask_user': return stepText('asked', locale, { q: clip(a.question, 120) })
    case 'remember': return stepText('remembered', locale, { text: clip(a.text, 120) })
    case 'forget': return stepText('forgot', locale)
    // the service's name as the AI wrote it, with anything that looks like a key and characters that show nothing left
    // out (emoji joiners and selectors stay; the label is shown and saved); without a name, the verb alone
    case 'connect_service': {
      const name = a.target === 'google_drive' ? 'Google Drive' : typeof a.name === 'string' ? clip(maskSecrets(a.name.replace(/(?![\t\n\r\u200d\ufe0e\ufe0f])[\p{Cc}\p{Cf}\p{DI}\p{Co}]/gu, '')), 60) : ''
      return name ? `${verb} · ${name}` : verb!
    }
    default: return verb ?? tool
  }
}

const LOCALES: Locale[] = ['en', 'ko', 'id', 'ja', 'es']
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The team's well-known folders by name in a step line (docs/DECISIONS.md "W2"): "파일 읽기 · 브랜드 이미지 폴더 ›
 * 홈페이지-6.jpg", not "groups/<team>/브랜드/이미지/홈페이지-6.jpg", which a phone cut before the file's name. */
export const STEP_PLACE = {
  /** groups/<team>/브랜드/이미지/ or shared/브랜드/이미지/ (the brand folder's images folder, named in the team's
   * language) */
  brandImages: t('브랜드 이미지 폴더', 'Brand images folder', 'Folder gambar merek', "ブランド画像フォルダー", "Carpeta de imágenes de marca"),
  /** groups/<team>/브랜드/ or shared/브랜드/ */
  brand: t('브랜드 폴더', 'Brand folder', 'Folder merek', "ブランドフォルダー", "Carpeta de marca"),
  /** groups/<team>/회의록/ or shared/회의록/ */
  notes: t('회의록 폴더', 'Meeting notes folder', 'Folder notulen rapat', "議事録フォルダー", "Carpeta de actas"),
  /** groups/<team>/: the team's folder, by the team's name */
  team: t('{team} 폴더', '{team} folder', 'Folder {team}', "{team}フォルダー", "Carpeta {team}"),
  /** users/<id>/.attachments/<chat>/: what the person attached to the chat */
  attachments: t('첨부한 파일', 'Attachments', 'Lampiran', "添付ファイル", "Adjuntos"),
  /** users/<id>/: an answer only ever reaches the person's own */
  own: t('내 폴더', 'My folder', 'Folder saya', "自分のフォルダー", "Mi carpeta"),
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
  if (top === 'users' && a) return b === '.attachments' && c ? say('attachments', 4) : say('own', 2)
  if (top === 'shared') {
    // the team's start puts the brand and meeting notes folders here since docs/DECISIONS.md "Team folder basics"
    if (a && BRAND_NAMES.has(a)) return b && IMAGES_NAMES.has(b) ? say('brandImages', 3) : say('brand', 2)
    if (a && NOTES_NAMES.has(a)) return say('notes', 2)
    return say('shared', 1)
  }
  return null
}

/** Tools whose step line ends in a team path ("<verb> · <path>"; edit_files adds "+N", hwp_render "#page"). */
const PATH_STEP_TOOLS = new Set(['list', 'glob', 'grep', 'search', 'knowledge_explore', 'read', 'write', 'edit', 'edit_files', 'make_file', 'edit_hwp', 'share_file', 'move_files', 'copy_files', 'rename_file', 'delete_files', 'save_url', 'hwp_render'])

/**
 * A step line (already in the language on screen, localizeStep) with its team path in words, and that path for a
 * tooltip: { label: "파일 읽기 · 브랜드 이미지 폴더 › 홈페이지-6.jpg", path: "groups/Acme/브랜드/이미지/홈페이지-6.jpg" }.
 * Any other line comes back as it is, without `path`.
 */
export function stepPlace(step: { tool?: string }, label: string, locale: Locale): { label: string; path?: string } {
  if (!PATH_STEP_TOOLS.has(step.tool ?? '')) return { label }
  // a call let through without a card ends in " · <why>" (QA 2026-11-11: the 2nd and 3rd saves after one card's
  // "이번만 허용" showed their raw path): the path is before it, and the why stays after the path in words
  const cover = coverWhy(label)?.end ?? null
  const line = cover ? label.slice(0, -cover.length) : label
  const at = line.lastIndexOf(' · ')
  if (at < 0) return { label }
  const tail = line.slice(at + 3)
  const [, path = tail, suffix = ''] = /^(.*?)( \+\d+| #\d+)?$/s.exec(tail) ?? []
  const named = placeName(path, locale)
  return named ? { label: `${line.slice(0, at + 3)}${named}${suffix}${cover ?? ''}`, path } : { label }
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

/** The Korean wording before 0.2.16 (합니다체): steps saved with it still follow the language on screen. Matching only. */
const LEGACY_KO: Partial<Record<StepTextKey, string>> = {
  refusedRetry: 'AI가 답하지 않아 다른 모델({model})로 다시 답합니다',
  engineOffDefault: '{from} 엔진이 꺼져 있어 팀 기본 엔진({to})으로 답합니다',
  limitFallback: '{from} 사용 한도에 닿아 {to} 엔진으로 이어서 답합니다',
  credentialSwitchLimit: '사용 한도에 닿아 다른 AI 연결로 이어서 답합니다',
  credentialSwitchInvalid: 'AI 연결이 거절되어 다른 연결로 이어서 답합니다',
}

/** A whole-label template in any language (or its older Korean wording) -> the same template in `locale`. */
function retemplate(keys: StepTextKey[], label: string, locale: Locale): string | null {
  for (const key of keys) for (const template of [...LOCALES.map((l) => STEP_TEXT[key][l]), LEGACY_KO[key]]) {
    const vars = template === undefined ? null : templateMatch(template, label)
    if (vars) return stepText(key, locale, vars)
  }
  return null
}

/** "<verb in any language><rest>" -> "<verb in `locale`><rest>" (the longest matching verb wins). */
function reverb(verbs: T, label: string, locale: Locale): string | null {
  const known = LOCALES.map((l) => verbs[l]).sort((a, b) => b.length - a.length)
  for (const v of known) {
    if (label === v) return verbs[locale]
    if (label.startsWith(v) && (label[v.length] === ' ')) return verbs[locale] + label.slice(v.length)
  }
  return null
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
  else if (tool === 'engine') label = retemplate(['engineOffDefault', 'engineNoConnection', 'limitFallback', 'credentialSwitchLimit', 'credentialSwitchInvalid'], step.label, locale)
  else if (tool === 'attachment') label = retemplate(['attachChanged', 'attachMoved', 'attachUnavailable'], step.label, locale)
  else if (tool === 'agent') label = retemplate(['subtask'], step.label, locale)
  else if (tool === 'ask_user') label = retemplate(['asked'], step.label, locale)
  else if (tool === 'remember') label = retemplate(['remembered', 'notRemembered'], step.label, locale)
  else if (tool === 'forget') label = retemplate(['forgot'], step.label, locale)
  else if (BROWSER_STEP_VERB[tool] || step.kind === 'browser' || browserTools?.has(tool)) label = reverb(BROWSER_STEP_VERB[tool] ?? BROWSER_STEP_FALLBACK, step.label, locale)
  else if (tool === 'read') label = reverb(READ_MEDIA_VERB.video, step.label, locale) ?? reverb(READ_MEDIA_VERB.audio, step.label, locale) ?? reverb(FILE_STEP_VERB.read!, step.label, locale)
  else if (FILE_STEP_VERB[tool]) label = reverb(FILE_STEP_VERB[tool]!, step.label, locale)
  const details: StepTextKey[] = tool === 'connect_service' ? ['connectConnected', 'connectNotConnected'] : ['notAnswered', 'webSearchRefused']
  const detail = step.detail !== undefined ? (retemplate(details, step.detail, locale) ?? step.detail) : undefined
  // why a call went on without a card, at the end of its line: in the screen's language too
  let out = label ?? step.label
  const why = coverWhy(out)
  if (why) out = `${out.slice(0, -why.end.length)} · ${STEP_TEXT[why.key][locale] ?? STEP_TEXT[why.key].en}`
  return { label: out, ...(detail !== undefined ? { detail } : {}) }
}
