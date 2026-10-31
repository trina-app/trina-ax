// Words of the step list under an answer ("Read · shared/fruit.md", "Remembered: …", "Thinking"), in ko / en / id.
// The server stores a label in the language of the person who ran the answer (older readers show it as is); the web
// app redraws it in the language on screen from these same words, so an old chat follows a later language switch
// (docs/DECISIONS.md "언어"). A label is always "<words> + what the AI touched" (a path, a query, a remembered text),
// and only the words are translated.
import type { Locale } from './api/common'

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
  make_file: t('파일 만들기', 'Make file', 'Buat berkas', "ファイルを作成", "Crear archivo"),
  share_file: t('파일 공유 링크', 'Share link', 'Tautan berkas', "リンクを共有", "Compartir enlace"),
  move_files: t('파일 옮기기', 'Move files', 'Pindahkan berkas', "ファイルを移動", "Mover archivos"),
  copy_files: t('파일 복사', 'Copy files', 'Salin berkas', "ファイルをコピー", "Copiar archivos"),
  rename_file: t('이름 바꾸기', 'Rename', 'Ganti nama', "名前を変更", "Cambiar nombre"),
  artifact: t('아티팩트', 'Artifact', 'Artefak', "アーティファクト", "Artefacto"),
  web_fetch: t('웹 페이지 가져오기', 'Fetch page', 'Ambil halaman', "ページを取得", "Obtener página"),
  hwp_render: t('한글 문서 쪽 보기', 'View HWP page', 'Lihat halaman HWP', "HWPのページを表示", "Ver página HWP"),
  search: t('뜻으로 찾기', 'Search by meaning', 'Cari berdasarkan makna', "意味で検索", "Buscar por significado"),
  schedule_create: t('예약 작업 만들기', 'Create scheduled task', 'Buat tugas terjadwal', "定期タスクを作成", "Crear tarea programada"),
  schedule_list: t('예약 작업 보기', 'List scheduled tasks', 'Lihat tugas terjadwal', "定期タスクを一覧表示", "Listar tareas programadas"),
  schedule_delete: t('예약 작업 지우기', 'Delete scheduled task', 'Hapus tugas terjadwal', "定期タスクを削除", "Eliminar tarea programada"),
  drive_search: t('Google Drive 검색', 'Search Google Drive', 'Cari di Google Drive', "Google ドライブを検索", "Buscar en Google Drive"),
  drive_list: t('Google Drive 폴더 보기', 'List Google Drive folder', 'Lihat folder Google Drive', "Google ドライブのフォルダを表示", "Listar carpeta de Google Drive"),
  drive_read: t('Google Drive 파일 읽기', 'Read Google Drive file', 'Baca berkas Google Drive', "Google ドライブのファイルを読む", "Leer archivo de Google Drive"),
  generate_video: t('동영상 만들기', 'Generate video', 'Buat video', "動画を生成", "Generar video"),
  run_code: t('코드 실행', 'Run code', 'Jalankan kode', "コードを実行", "Ejecutar código"),
  ask_user: t('질문', 'Question', 'Pertanyaan', "質問", "Pregunta"),
  remember: t('기억하기', 'Remember', 'Ingat', "記憶", "Recordar"),
  forget: t('기억 지우기', 'Forget', 'Lupakan', "忘れる", "Olvidar"),
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
export const BROWSER_STEP_FALLBACK: T = t('브라우저', 'Browser', 'Browser', "ブラウザー", "Navegador")

/** Whole-label templates ({x} = what the AI touched, never translated). */
export const STEP_TEXT = {
  asked: t('질문: {q}', 'Question: {q}', 'Pertanyaan: {q}', "質問：{q}", "Pregunta: {q}"),
  remembered: t('기억함: {text}', 'Remembered: {text}', 'Diingat: {text}', "記憶しました：{text}", "Recordado: {text}"),
  notRemembered: t('기억하지 않음: {text}', 'Not remembered: {text}', 'Tidak diingat: {text}', "記憶しませんでした：{text}", "No se recordó: {text}"),
  forgot: t('기억 지움', 'Forgot a memory', 'Ingatan dihapus', "メモリを削除しました", "Se olvidó una memoria"),
  notAnswered: t('답하지 않음', 'Not answered', 'Tidak dijawab', "未回答", "Sin respuesta"),
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
  refusedRetry: t('AI가 답하지 않아 다른 모델({model})로 다시 답합니다', 'The AI declined; answering again with another model ({model})', 'AI menolak; menjawab ulang dengan model lain ({model})', "AIが拒否したため、別のモデル（{model}）で再回答します", "La IA rechazó la solicitud; se responde de nuevo con otro modelo ({model})"),
  /** the chat's engine was switched off by an admin: this answer uses the team default */
  engineOffDefault: t('{from} 엔진이 꺼져 있어 팀 기본 엔진({to})으로 답합니다', '{from} is switched off; answering with the team default ({to})', '{from} dimatikan; menjawab dengan mesin bawaan tim ({to})', "{from}が無効のため、チームの既定（{to}）で回答します", "{from} está desactivado; se responde con el predeterminado del equipo ({to})"),
  /** "Claude 한도에 닿으면 Codex로 넘기기": the subscription limit was hit and the admin allowed the fallback */
  limitFallback: t('{from} 사용 한도에 닿아 {to} 엔진으로 이어서 답합니다', '{from} usage limit reached; continuing with {to}', 'Batas pemakaian {from} tercapai; dilanjutkan dengan {to}', "{from}の使用量上限に達したため、{to}で続けます", "Se alcanzó el límite de uso de {from}; se continúa con {to}"),
  credentialSwitchLimit: t('사용 한도에 닿아 다른 AI 연결로 이어서 답합니다', 'Usage limit reached; continuing with another AI connection', 'Batas pemakaian tercapai; dilanjutkan dengan koneksi AI lain', "使用量の上限に達したため、別のAI接続で続けます", "Se alcanzó el límite de uso; se continúa con otra conexión de IA"),
  /** a sub-agent's part of the answer (Claude Code's Agent tool); {d} is the AI's own short description of it */
  subtask: t('하위 작업: {d}', 'Sub-task: {d}', 'Subtugas: {d}', "サブタスク：{d}", "Subtarea: {d}"),
  credentialSwitchInvalid: t('AI 연결이 거절되어 다른 연결로 이어서 답합니다', 'The AI connection was refused; continuing with another one', 'Koneksi AI ditolak; dilanjutkan dengan koneksi lain', "AI接続が拒否されたため、別の接続で続けます", "Se rechazó la conexión de IA; se continúa con otra"),
} satisfies Record<string, T>
export type StepTextKey = keyof typeof STEP_TEXT

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all)
export const stepText = (key: StepTextKey, locale: Locale, vars: Record<string, string> = {}) => fill(STEP_TEXT[key][locale] ?? STEP_TEXT[key].en, vars)

const clip = (s: unknown, n = 80) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > n ? v.slice(0, n - 1) + '…' : v
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
    case 'read': case 'write': case 'edit': return `${verb} · ${clip(a.file_path, 90)}`
    case 'make_file': return `${verb} · ${clip(a.output, 90)}`
    case 'share_file': return `${verb} · ${clip(a.path, 90)}`
    case 'move_files': case 'copy_files': return `${verb} · ${clip(a.to_folder, 90)}`
    case 'rename_file': return `${verb} · ${clip(a.path, 90)}`
    case 'artifact': return `${verb} · ${clip(a.title ?? a.key, 80)}`
    case 'web_fetch': return `${verb} · ${clip(a.url, 80)}`
    case 'hwp_render': return `${verb} · ${clip(a.source, 80)}${typeof a.page === 'number' ? ` #${a.page}` : ''}`
    case 'search': case 'drive_search': return `${verb} "${clip(a.query, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'schedule_create': return `${verb} · ${clip(a.title, 80)}`
    case 'schedule_delete': return `${verb} · ${clip(a.id, 40)}`
    case 'drive_list': return a.folderId && a.folderId !== 'root' ? `${verb} · ${clip(a.folderId, 60)}` : verb!
    case 'drive_read': return `${verb} · ${clip(a.fileId, 60)}`
    case 'generate_video': return `${verb} · ${clip(a.prompt, 80)}`
    case 'run_code': {
      const first = String(a.code ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? ''
      return `${verb} · ${a.lang === 'python' ? 'python3' : 'bash'}${first ? ` · ${clip(first, 70)}` : ''}`
    }
    case 'ask_user': return stepText('asked', locale, { q: clip(a.question, 120) })
    case 'remember': return stepText('remembered', locale, { text: clip(a.text, 120) })
    case 'forget': return stepText('forgot', locale)
    default: return verb ?? tool
  }
}

const LOCALES: Locale[] = ['en', 'ko', 'id', 'ja', 'es']
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

/** A whole-label template in any language -> the same template in `locale`. */
function retemplate(keys: StepTextKey[], label: string, locale: Locale): string | null {
  for (const key of keys) for (const l of LOCALES) {
    const vars = templateMatch(STEP_TEXT[key][l], label)
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
  else if (tool === 'engine') label = retemplate(['engineOffDefault', 'limitFallback', 'credentialSwitchLimit', 'credentialSwitchInvalid'], step.label, locale)
  else if (tool === 'attachment') label = retemplate(['attachChanged', 'attachMoved', 'attachUnavailable'], step.label, locale)
  else if (tool === 'agent') label = retemplate(['subtask'], step.label, locale)
  else if (tool === 'ask_user') label = retemplate(['asked'], step.label, locale)
  else if (tool === 'remember') label = retemplate(['remembered', 'notRemembered'], step.label, locale)
  else if (tool === 'forget') label = retemplate(['forgot'], step.label, locale)
  else if (BROWSER_STEP_VERB[tool] || step.kind === 'browser' || browserTools?.has(tool)) label = reverb(BROWSER_STEP_VERB[tool] ?? BROWSER_STEP_FALLBACK, step.label, locale)
  else if (FILE_STEP_VERB[tool]) label = reverb(FILE_STEP_VERB[tool]!, step.label, locale)
  const detail = step.detail !== undefined ? (retemplate(['notAnswered', 'webSearchRefused'], step.detail, locale) ?? step.detail) : undefined
  return { label: label ?? step.label, ...(detail !== undefined ? { detail } : {}) }
}
