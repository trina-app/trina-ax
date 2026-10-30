// The AI's tools for the person's scheduled tasks (server/src/chat/schedules.ts): schedule_create, schedule_list,
// schedule_delete. Only the person's own schedules; a schedule made inside a project chat runs in that project; a
// scheduled run itself can't make new schedules (no task that multiplies itself).
// schedule_create asks the person first on a server card (docs/DECISIONS.md "Outbound web channels"): a run happens
// with nobody watching, its message is the AI's text, and that text used to make every address in it "typed by the
// person" (web_fetch without a card, on every run). The card shows the title, the schedule, the whole instruction and
// the addresses in it (long random-looking parts highlighted), and the "allow" team connections the run could send to
// without asking; the person creates it, creates it without those sends, or declines. Only what the card showed is
// carried into runs (schedules.allowed_urls, write_connections).
import { z } from 'zod'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { ToolError } from '../policy/errors'
import { getChatRuntime } from '../chat/runtime'
import { describeSchedule, needsReview, ScheduleInput, zonedParts, type ScheduleInput as ScheduleInputT, type ScheduleRow } from '../chat/schedules'
import { usable } from '../integrations/connections/store'
import type { ToolRegistry } from './registry'
import { extractUrls, opaqueParts, type ConfirmExtra } from './url-gate'

export const SCHEDULE_TOOL_NAMES = ['schedule_create', 'schedule_list', 'schedule_delete'] as const

const CreateInput = z.object({
  title: z.string().max(80).describe('Short name, e.g. "Weekly meeting digest"'),
  prompt: z.string().max(4000).describe('The full instruction to run each time, written so it works without this conversation (name the folders and the output)'),
  repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly']),
  time: z.string().describe('HH:MM, 24-hour, in the team\'s time zone'),
  weekday: z.number().int().min(0).max(6).optional().describe('weekly: 0 = Sunday … 6 = Saturday'),
  day: z.number().int().min(1).max(28).optional().describe('monthly: 1–28'),
  date: z.string().optional().describe('once: YYYY-MM-DD'),
})

function turnInfo(ctx: AppContext, t: ToolCtx): { projectId: string | null; scheduled: boolean } {
  if (!t.turnId) return { projectId: null, scheduled: false }
  const r = ctx.db.query('SELECT c.project_id, t.client_kind FROM turns t JOIN chats c ON c.id = t.chat_id WHERE t.id = ?').get(t.turnId) as { project_id: string | null; client_kind: string | null } | null
  return { projectId: r?.project_id ?? null, scheduled: r?.client_kind === 'schedule' }
}

type L5 = Record<Locale, string>
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)

export const TEXT = {
  reviewQuestion: {
    ko: '이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요. 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인하고 다시 켤지 골라 주세요.\n\n제목: {title}\n일정: {when}',
    en: 'This scheduled task was made without its confirmation card, so it is paused. It runs the instruction below on its own, with nobody watching. Check the instruction and its addresses, then choose whether to resume it.\n\nTitle: {title}\nSchedule: {when}',
    id: 'Tugas terjadwal ini dibuat tanpa kartu konfirmasi, jadi dijeda. Tugas ini menjalankan instruksi di bawah sendiri, tanpa ada yang mengawasi. Periksa instruksi dan alamatnya, lalu pilih apakah akan melanjutkannya.\n\nJudul: {title}\nJadwal: {when}',
    ja: 'この定期タスクは確認カードなしで作成されたため一時停止しています。定期タスクは誰も見ていないときに下の指示をそのまま実行します。指示とアドレスを確認し、再開するか選んでください。\n\nタイトル：{title}\n予定：{when}',
    es: 'Esta tarea programada se creó sin su tarjeta de confirmación, así que está en pausa. Ejecuta la instrucción de abajo por su cuenta, sin que nadie la vigile. Revise la instrucción y sus direcciones y elija si reanudarla.\n\nTítulo: {title}\nHorario: {when}',
  } satisfies L5,
  question: {
    ko: 'AI가 예약 작업을 만들려고 해요. 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인해 주세요.\n\n제목: {title}\n일정: {when}',
    en: 'The AI wants to create a scheduled task. It runs the instruction below on its own, with nobody watching. Check the instruction and its addresses.\n\nTitle: {title}\nSchedule: {when}',
    id: 'AI ingin membuat tugas terjadwal. Tugas ini menjalankan instruksi di bawah sendiri, tanpa ada yang mengawasi. Periksa instruksi dan alamatnya.\n\nJudul: {title}\nJadwal: {when}',
    ja: 'AIが定期タスクを作成しようとしています。定期タスクは誰も見ていないときに下の指示をそのまま実行します。指示とアドレスを確認してください。\n\nタイトル：{title}\n予定：{when}',
    es: 'La IA quiere crear una tarea programada. Ejecuta la instrucción de abajo por su cuenta, sin que nadie la vigile. Revise la instrucción y sus direcciones.\n\nTítulo: {title}\nHorario: {when}',
  } satisfies L5,
  urls: {
    ko: '실행할 때마다 아래 주소 {n}개는 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.',
    en: 'On each run it opens the {n} addresses below without asking. An address can carry data out, so check each one in full.',
    id: 'Setiap kali berjalan, tugas ini membuka {n} alamat di bawah tanpa bertanya. Alamat bisa membawa data keluar, jadi periksa masing-masing secara lengkap.',
    ja: '実行のたびに下の{n}件のアドレスを確認なしで開きます。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください。',
    es: 'En cada ejecución abre sin preguntar las {n} direcciones de abajo. Una dirección puede sacar datos; revise cada una completa.',
  } satisfies L5,
  opaque: {
    ko: '알아보기 어려운 긴 문자열이 있어요(강조 표시). 내용을 실어 보낼 수 있으니 무엇인지 확인해 주세요.',
    en: 'It contains long strings that are hard to read (highlighted). They can carry data; check what they are.',
    id: 'Ada string panjang yang sulit dibaca (disorot). String itu bisa membawa data; periksa isinya.',
    ja: '読み取りにくい長い文字列が含まれています（強調表示）。データを運べるため、内容を確認してください。',
    es: 'Contiene cadenas largas difíciles de leer (resaltadas). Pueden llevar datos; compruebe qué son.',
  } satisfies L5,
  connections: {
    ko: '이 연결 서비스는 AI가 묻지 않고 보내도록 설정돼 있어요: {names}. 이 예약 작업이 여기에 보내도 될지 골라 주세요.',
    en: 'These connected services let the AI send without asking: {names}. Choose whether this scheduled task may send to them.',
    id: 'Layanan terhubung ini membiarkan AI mengirim tanpa bertanya: {names}. Pilih apakah tugas terjadwal ini boleh mengirim ke sana.',
    ja: '次の接続サービスはAIが確認なしで送信できる設定です：{names}。この定期タスクがそこへ送信してよいか選んでください。',
    es: 'Estos servicios conectados permiten que la IA envíe sin preguntar: {names}. Elija si esta tarea programada puede enviarles datos.',
  } satisfies L5,
  labelPrompt: { ko: '지시문', en: 'Instruction', id: 'Instruksi', ja: '指示', es: 'Instrucción' } satisfies L5,
  labelUrls: {
    ko: '실행 때 묻지 않고 여는 주소', en: 'Addresses opened without asking on each run', id: 'Alamat yang dibuka tanpa bertanya setiap kali berjalan',
    ja: '実行時に確認なしで開くアドレス', es: 'Direcciones que abre sin preguntar en cada ejecución',
  } satisfies L5,
  create: { ko: '만들기', en: 'Create', id: 'Buat', ja: '作成する', es: 'Crear' } satisfies L5,
  createWrite: { ko: '만들기(연결 서비스에 보내기 허용)', en: 'Create, may send to those services', id: 'Buat, boleh mengirim ke layanan itu', ja: '作成する（そのサービスへの送信を許可）', es: 'Crear y permitir enviar a esos servicios' } satisfies L5,
  createNoWrite: { ko: '만들기(연결 서비스에는 보내지 않음)', en: 'Create, never send to connected services', id: 'Buat, jangan kirim ke layanan terhubung', ja: '作成する（接続サービスには送信しない）', es: 'Crear sin enviar a servicios conectados' } satisfies L5,
  deny: { ko: '만들지 않기', en: 'Don’t create', id: 'Jangan buat', ja: '作成しない', es: 'No crear' } satisfies L5,
  resume: { ko: '다시 켜기', en: 'Resume', id: 'Lanjutkan', ja: '再開する', es: 'Reanudar' } satisfies L5,
  resumeWrite: { ko: '다시 켜기(연결 서비스에 보내기 허용)', en: 'Resume, may send to those services', id: 'Lanjutkan, boleh mengirim ke layanan itu', ja: '再開する（そのサービスへの送信を許可）', es: 'Reanudar y permitir enviar a esos servicios' } satisfies L5,
  resumeNoWrite: { ko: '다시 켜기(연결 서비스에는 보내지 않음)', en: 'Resume, never send to connected services', id: 'Lanjutkan, jangan kirim ke layanan terhubung', ja: '再開する（接続サービスには送信しない）', es: 'Reanudar sin enviar a servicios conectados' } satisfies L5,
  keep: { ko: '계속 멈춰 두기', en: 'Keep it paused', id: 'Tetap jeda', ja: '一時停止のままにする', es: 'Mantener en pausa' } satisfies L5,
  once: { ko: '{date} {time}에 한 번', en: 'once on {date} at {time}', id: 'sekali pada {date} pukul {time}', ja: '{date} {time}に1回', es: 'una vez el {date} a las {time}' } satisfies L5,
  daily: { ko: '매일 {time}', en: 'every day at {time}', id: 'setiap hari pukul {time}', ja: '毎日 {time}', es: 'todos los días a las {time}' } satisfies L5,
  weekdays: { ko: '평일(월–금) {time}', en: 'every weekday (Mon–Fri) at {time}', id: 'setiap hari kerja (Sen–Jum) pukul {time}', ja: '平日（月〜金） {time}', es: 'cada día laborable (lun–vie) a las {time}' } satisfies L5,
  weekly: { ko: '매주 {weekday} {time}', en: 'every {weekday} at {time}', id: 'setiap {weekday} pukul {time}', ja: '毎週{weekday} {time}', es: 'cada {weekday} a las {time}' } satisfies L5,
  monthly: { ko: '매월 {day}일 {time}', en: 'every month on day {day} at {time}', id: 'setiap bulan tanggal {day} pukul {time}', ja: '毎月{day}日 {time}', es: 'cada mes el día {day} a las {time}' } satisfies L5,
} as const

/** The schedule in the person's language ("매주 월요일 09:00"), for the card. */
export function scheduleWhen(s: Pick<ScheduleInputT, 'repeat' | 'time' | 'weekday' | 'day' | 'date'>, L: Locale): string {
  const weekday = s.weekday === undefined ? '' : new Intl.DateTimeFormat(L, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + s.weekday)))
  return fill(TEXT[s.repeat][L], { time: s.time, date: s.date ?? '', day: String(s.day ?? ''), weekday })
}

/** The schedule card: what the run will do, unattended, and what it may open or send without asking. 'create': the
 * AI's schedule_create; 'review': a task nobody confirmed, shown again to its owner to resume (chat/schedule-review.ts). */
export function scheduleCard(input: Pick<ScheduleInputT, 'title' | 'prompt' | 'repeat' | 'time' | 'weekday' | 'day' | 'date'>, connections: string[], L: Locale, mode: 'create' | 'review' = 'create'): { question: string; urls: string[]; extra: ConfirmExtra } {
  const urls = [...new Set(extractUrls(input.prompt))]
  const promptMarks = opaqueParts(input.prompt)
  // the title is the AI's: one line, so it cannot add lines that look like the server's own
  const lines = [fill(TEXT[mode === 'review' ? 'reviewQuestion' : 'question'][L], { title: input.title.replace(/\s+/g, ' ').trim(), when: scheduleWhen(input, L) })]
  if (urls.length) lines.push(fill(TEXT.urls[L], { n: String(urls.length) }))
  if (promptMarks.length) lines.push(TEXT.opaque[L])
  if (connections.length) lines.push(fill(TEXT.connections[L], { names: connections.join(', ') }))
  const details = [{ label: TEXT.labelPrompt[L], text: input.prompt, ...(promptMarks.length ? { marks: promptMarks } : {}) }]
  if (urls.length) { const t = urls.join('\n'); const m = opaqueParts(t); details.push({ label: TEXT.labelUrls[L], text: t, ...(m.length ? { marks: m } : {}) }) }
  return { question: lines.join('\n\n'), urls, extra: { details } }
}

/** The card's answers: with "allow" team connections the person picks whether runs may send to them. */
export function scheduleOptions(L: Locale, writable: boolean, mode: 'create' | 'review' = 'create'): { label: string; value: string }[] {
  if (mode === 'review') return writable
    ? [{ label: TEXT.resumeWrite[L], value: 'resume_write' }, { label: TEXT.resumeNoWrite[L], value: 'resume' }, { label: TEXT.keep[L], value: 'keep' }]
    : [{ label: TEXT.resume[L], value: 'resume' }, { label: TEXT.keep[L], value: 'keep' }]
  return writable
    ? [{ label: TEXT.createWrite[L], value: 'create_write' }, { label: TEXT.createNoWrite[L], value: 'create' }, { label: TEXT.deny[L], value: 'deny' }]
    : [{ label: TEXT.create[L], value: 'create' }, { label: TEXT.deny[L], value: 'deny' }]
}

/** "allow" team connections this person can use: a run would send to them without anyone asking. */
export function writableConnections(ctx: AppContext, userId: string) {
  return usable(ctx.db, userId).filter((r) => r.scope === 'team' && r.write_policy === 'allow')
}

export function registerScheduleTools(ctx: AppContext, reg: ToolRegistry) {
  const rt = getChatRuntime(ctx)
  const local = (iso: string | null) => {
    if (!iso) return 'not scheduled'
    const p = zonedParts(new Date(iso), rt.timeZone)
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')} (${rt.timeZone})`
  }
  const line = (s: ScheduleRow) => `- ${s.id}: "${s.title}", ${describeSchedule(s)}${s.enabled ? `, next ${local(s.next_run_at)}` : needsReview(s) ? ', paused until the user confirms it again in Settings › Scheduled tasks (it was made without its card)' : ', off'}${s.last_run_at ? `, last ran ${local(s.last_run_at)}` : ''}\n  prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 200)}`

  reg.register({
    name: 'schedule_create',
    description: 'Create a scheduled task for the user: the server sends `prompt` for them on the schedule, each run in a new chat with their access (they see it in their chat list). ' +
      'Use it when the user asks for something recurring or later ("every Monday at 9…", "tomorrow at 8…"). The user confirms it first on a card that shows the title, the schedule and the whole prompt; then confirm the schedule back in plain words. ' +
      'Runs are unattended (no questions, nothing that needs a confirmation), so write the prompt to work on its own. Only web addresses written in the prompt (shown on the card) open in a run without asking.',
    input: CreateInput,
    describe: (a) => `schedule_create ${a.repeat} ${a.time}`,
    async run(a, t) {
      const info = turnInfo(ctx, t)
      if (info.scheduled) throw new ToolError('a scheduled run cannot create scheduled tasks')
      const parsed = ScheduleInput.safeParse({ ...a, projectId: info.projectId ?? undefined })
      if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      // what would be refused anyway is refused before the person is asked
      rt.schedules.check(t.user.id, parsed.data)
      const person = t.person
      if (!person) throw new ToolError('a scheduled task runs with nobody watching, so the user confirms it on a card first; nobody can confirm it here, so it was not created. Ask the user to create it in a chat.')
      const L = person.locale
      const writable = writableConnections(ctx, t.user.id)
      const card = scheduleCard(parsed.data, writable.map((r) => r.name), L)
      const options = scheduleOptions(L, writable.length > 0)
      const answer = person.choose
        ? await person.choose(card.question, options, card.extra)
        : (await person.confirm(card.question, TEXT.create[L], TEXT.deny[L], card.extra)) ? 'create' : null
      if (answer !== 'create' && answer !== 'create_write') throw new ToolError('the user did not allow this scheduled task, so it was not created. Do not try again unless the user asks; tell the user it was not created.')
      const s = rt.schedules.create(t.user.id, parsed.data, new Date(), { allowedUrls: card.urls, writeConnections: answer === 'create_write' ? writable.map((r) => r.id) : [] })
      return { text: `Scheduled "${s.title}": ${describeSchedule(s)}. First run: ${local(s.next_run_at)}. Id ${s.id}. The user can turn it off in Settings › Scheduled tasks.`, summary: `schedule_create ${s.id} ${s.repeat} ${s.time} (confirmed by the user${answer === 'create_write' ? `, may send to ${writable.length} connections` : ''})`, structured: { id: s.id, nextRunAt: s.next_run_at } }
    },
  })
  reg.register({
    name: 'schedule_list',
    description: 'List the user\'s scheduled tasks (id, schedule, next run, prompt).',
    input: z.object({}),
    run(_a, t) {
      const all = rt.schedules.list(t.user.id)
      return { text: all.length ? all.map(line).join('\n') : 'The user has no scheduled tasks.', summary: `schedule_list -> ${all.length}` }
    },
  })
  reg.register({
    name: 'schedule_delete',
    description: 'Delete one of the user\'s scheduled tasks by id (from schedule_list). Ask first unless the user clearly asked to delete it.',
    input: z.object({ id: z.string().min(1).max(64) }),
    describe: (a) => `schedule_delete ${a.id}`,
    run(a, t) {
      if (!rt.schedules.delete(t.user.id, a.id)) throw new ToolError(`no scheduled task ${a.id} of this user`)
      return { text: `Deleted scheduled task ${a.id}.`, summary: `schedule_delete ${a.id}` }
    },
  })
}
