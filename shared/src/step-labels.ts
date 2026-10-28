// Words of the step list under an answer ("Read · shared/fruit.md", "Remembered: …", "Thinking"), in ko / en / id.
// The server stores a label in the language of the person who ran the answer (older readers show it as is); the web
// app redraws it in the language on screen from these same words, so an old chat follows a later language switch
// (docs/DECISIONS.md "언어"). A label is always "<words> + what the AI touched" (a path, a query, a remembered text),
// and only the words are translated.
import type { Locale } from './api/common'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string): T => ({ ko, en, id })

/** Verb of a file / team tool step: "<verb> · <path>". */
export const FILE_STEP_VERB: Record<string, T> = {
  list: t('폴더 보기', 'List', 'Lihat folder'),
  glob: t('파일 찾기', 'Find files', 'Cari berkas'),
  grep: t('내용 검색', 'Search', 'Cari isi'),
  read: t('파일 읽기', 'Read', 'Baca berkas'),
  write: t('파일 저장', 'Save', 'Simpan berkas'),
  edit: t('파일 수정', 'Edit', 'Ubah berkas'),
  make_file: t('파일 만들기', 'Make file', 'Buat berkas'),
  share_file: t('파일 공유 링크', 'Share link', 'Tautan berkas'),
  move_files: t('파일 옮기기', 'Move files', 'Pindahkan berkas'),
  copy_files: t('파일 복사', 'Copy files', 'Salin berkas'),
  rename_file: t('이름 바꾸기', 'Rename', 'Ganti nama'),
  artifact: t('아티팩트', 'Artifact', 'Artefak'),
  web_fetch: t('웹 페이지 가져오기', 'Fetch page', 'Ambil halaman'),
  ask_user: t('질문', 'Question', 'Pertanyaan'),
  remember: t('기억하기', 'Remember', 'Ingat'),
  forget: t('기억 지우기', 'Forget', 'Lupakan'),
}

/** Verb of an in-app browser step: "<verb> · <url>". */
export const BROWSER_STEP_VERB: Record<string, T> = {
  preview_start: t('브라우저 열기', 'Open browser', 'Buka browser'),
  navigate: t('페이지 열기', 'Open page', 'Buka halaman'),
  read_page: t('페이지 읽기', 'Read page', 'Baca halaman'),
  get_page_text: t('페이지 읽기', 'Read page', 'Baca halaman'),
  find: t('페이지에서 찾기', 'Find on page', 'Cari di halaman'),
  computer: t('브라우저 조작', 'Use browser', 'Operasikan browser'),
  form_input: t('양식 채우기', 'Fill form', 'Isi formulir'),
  javascript_tool: t('페이지 스크립트 실행', 'Run page script', 'Jalankan skrip halaman'),
  browser_batch: t('브라우저 여러 단계', 'Browser steps', 'Beberapa langkah browser'),
  resize_window: t('화면 크기 바꾸기', 'Resize', 'Ubah ukuran'),
  read_console_messages: t('콘솔 보기', 'Read console', 'Baca konsol'),
  read_network_requests: t('네트워크 보기', 'Read network', 'Baca jaringan'),
  tabs_context: t('탭 보기', 'List tabs', 'Lihat tab'),
  tabs_create: t('새 탭', 'New tab', 'Tab baru'),
  tabs_select: t('탭 바꾸기', 'Switch tab', 'Ganti tab'),
  tabs_close: t('탭 닫기', 'Close tab', 'Tutup tab'),
}
export const BROWSER_STEP_FALLBACK: T = t('브라우저', 'Browser', 'Browser')

/** Whole-label templates ({x} = what the AI touched, never translated). */
export const STEP_TEXT = {
  asked: t('질문: {q}', 'Question: {q}', 'Pertanyaan: {q}'),
  remembered: t('기억함: {text}', 'Remembered: {text}', 'Diingat: {text}'),
  notRemembered: t('기억하지 않음: {text}', 'Not remembered: {text}', 'Tidak diingat: {text}'),
  forgot: t('기억 지움', 'Forgot a memory', 'Ingatan dihapus'),
  notAnswered: t('답하지 않음', 'Not answered', 'Tidak dijawab'),
  webSearch: t('웹 검색: {q}', 'Web search: {q}', 'Cari di web: {q}'),
  thinking: t('생각하는 중', 'Thinking', 'Berpikir'),
  attachChanged: t('첨부한 뒤 바뀐 파일, 지금 내용으로 읽음 · {path}', 'Attached file changed since it was attached; using the current version · {path}', 'Berkas lampiran berubah sejak dilampirkan; memakai versi terkini · {path}'),
  attachMoved: t('첨부한 파일이 옮겨짐 · {path}', 'Attached file moved · {path}', 'Berkas lampiran dipindah · {path}'),
  attachUnavailable: t('첨부한 팀 파일을 더 이상 쓸 수 없음', 'An attached team file is no longer available', 'Berkas tim yang dilampirkan tidak tersedia lagi'),
  refusedRetry: t('AI가 답하지 않아 다른 모델({model})로 다시 답합니다', 'The AI declined; answering again with another model ({model})', 'AI menolak; menjawab ulang dengan model lain ({model})'),
  /** the chat's engine was switched off by an admin: this answer uses the team default */
  engineOffDefault: t('{from} 엔진이 꺼져 있어 팀 기본 엔진({to})으로 답합니다', '{from} is switched off; answering with the team default ({to})', '{from} dimatikan; menjawab dengan mesin bawaan tim ({to})'),
  /** "Claude 한도에 닿으면 Codex로 넘기기": the subscription limit was hit and the admin allowed the fallback */
  limitFallback: t('{from} 사용 한도에 닿아 {to} 엔진으로 이어서 답합니다', '{from} usage limit reached; continuing with {to}', 'Batas pemakaian {from} tercapai; dilanjutkan dengan {to}'),
  credentialSwitchLimit: t('사용 한도에 닿아 다른 AI 연결로 이어서 답합니다', 'Usage limit reached; continuing with another AI connection', 'Batas pemakaian tercapai; dilanjutkan dengan koneksi AI lain'),
  credentialSwitchInvalid: t('AI 연결이 거절되어 다른 연결로 이어서 답합니다', 'The AI connection was refused; continuing with another one', 'Koneksi AI ditolak; dilanjutkan dengan koneksi lain'),
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
    case 'ask_user': return stepText('asked', locale, { q: clip(a.question, 120) })
    case 'remember': return stepText('remembered', locale, { text: clip(a.text, 120) })
    case 'forget': return stepText('forgot', locale)
    default: return verb ?? tool
  }
}

const LOCALES: Locale[] = ['en', 'ko', 'id']
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
  else if (step.kind === 'web_search') label = retemplate(['webSearch'], step.label, locale)
  else if (tool === 'refusal') label = retemplate(['refusedRetry'], step.label, locale)
  else if (tool === 'engine') label = retemplate(['engineOffDefault', 'limitFallback', 'credentialSwitchLimit', 'credentialSwitchInvalid'], step.label, locale)
  else if (tool === 'attachment') label = retemplate(['attachChanged', 'attachMoved', 'attachUnavailable'], step.label, locale)
  else if (tool === 'ask_user') label = retemplate(['asked'], step.label, locale)
  else if (tool === 'remember') label = retemplate(['remembered', 'notRemembered'], step.label, locale)
  else if (tool === 'forget') label = retemplate(['forgot'], step.label, locale)
  else if (BROWSER_STEP_VERB[tool] || step.kind === 'browser' || browserTools?.has(tool)) label = reverb(BROWSER_STEP_VERB[tool] ?? BROWSER_STEP_FALLBACK, step.label, locale)
  else if (FILE_STEP_VERB[tool]) label = reverb(FILE_STEP_VERB[tool]!, step.label, locale)
  const detail = step.detail !== undefined ? (retemplate(['notAnswered'], step.detail, locale) ?? step.detail) : undefined
  return { label: label ?? step.label, ...(detail !== undefined ? { detail } : {}) }
}
