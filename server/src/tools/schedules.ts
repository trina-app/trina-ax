// The AI's tools for the person's scheduled tasks (server/src/chat/schedules.ts): schedule_create, schedule_list,
// schedule_delete. Only the person's own schedules; a schedule made inside a project chat runs in that project; a
// scheduled run itself can't make new schedules (no task that multiplies itself).
// schedule_create asks the person first on a server card (docs/DECISIONS.md "Outbound web channels"): a run happens
// with nobody watching, its message is the AI's text, and that text used to make every address in it "typed by the
// person" (web_fetch without a card, on every run). The card shows the title, the schedule, the whole instruction and
// the addresses in it (long random-looking parts highlighted; an address with a query over 200 characters listed
// apart, its query highlighted, as one runs never open: it always needs a person), and the "allow" team connections
// the task names that a run could send to without asking (taskConnections: never every one the person can use); the
// person creates it, creates it without those sends, or declines. Only what the card showed is carried into runs
// (schedules.allowed_urls, write_connections).
import { z } from 'zod'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { ToolError } from '../policy/errors'
import { getChatRuntime } from '../chat/runtime'
import { describeSchedule, inputTiming, needsReview, ScheduleInput, zonedParts, type ScheduleInput as ScheduleInputT, type ScheduleRow, type ScheduleRow as ScheduleRowT } from '../chat/schedules'
import { namesTemplate } from '../integrations/connections/schedule-needs'
import { redactorFor } from '../integrations/connections/redact'
import { usable, type Row } from '../integrations/connections/store'
import { egressOf, egressSettled } from './egress'
import type { ToolRegistry } from './registry'
import { extractUrls, MAX_UNCONFIRMED_QUERY, opaqueParts, typedUrls, type ConfirmExtra, type TurnPerson } from './url-gate'
import { asksFor, ownWords, SCHEDULE_ASK } from '../chat/shared-actions'
import { isGuestUser } from '../credentials/guest-ai'
import { cardSources, cleanPins, makeSaveFolder, MAX_PINS, MAX_SOURCES, resolveSaveFolder, saveFolderChanged, resolveSources, rowSends, rowSources, scopeKey, sourceForAi, sourceText, withRules, type PersonalSend, type SaveFolder, type SaveLapse, type ScopeSource } from '../chat/schedule-scope'
import type { Database } from 'bun:sqlite'
import { MAX_EVERY_MINUTES, REPEATS, timingOf, type TimingSource } from '../chat/schedule-timing'
import { Audiences, isSharedRow } from '../chat/shared'
import type { ChatRow } from '../chat/store'

export const SCHEDULE_TOOL_NAMES = ['schedule_create', 'schedule_list', 'schedule_delete'] as const

/** Schedules run in the team's time zone (chat/schedules.ts); "Now:" in the instructions is in the person's device zone
 * when it differs (QA TC-4549, chat/prompt.ts timeLine), so the AI converts the person's time to the team's. */
export const SCHEDULE_TIME_DESCRIPTION = 'HH:MM, 24-hour, in the team\'s time zone (convert a time the user gives in their own device zone, when the instructions name one)'

const CreateInput = z.object({
  title: z.string().max(80).describe('Short name, e.g. "Weekly meeting digest"'),
  prompt: z.string().max(4000).describe('The full instruction to run each time, written so it works without this conversation (name the folders and the output)'),
  repeat: z.enum(REPEATS).describe('once; daily; weekdays (Mon–Fri); weekly (one or more days: weekdays); monthly (day 1–31 or "last"); interval (every N minutes: every_minutes, e.g. 60 = every hour, counted from date + time); cron (any other pattern: cron). Any frequency the user asks for is fine.'),
  time: z.string().optional().describe(`${SCHEDULE_TIME_DESCRIPTION}. Every kind but cron needs it; for interval it is when the counting starts`),
  weekday: z.number().int().min(0).max(6).optional().describe('weekly, one day: 0 = Sunday … 6 = Saturday'),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe('weekly, several days: e.g. [1, 4] = Monday and Thursday'),
  day: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional().describe('monthly: 1–31 (a month without that day has no run), or "last" for the last day of the month'),
  date: z.string().optional().describe('once: YYYY-MM-DD; interval: the day counting starts (default today)'),
  every_minutes: z.number().int().min(1).max(MAX_EVERY_MINUTES).optional().describe('interval: minutes between runs (60 = hourly, 180 = every 3 hours)'),
  cron: z.string().max(200).optional().describe('cron: five fields "minute hour day-of-month month day-of-week" in the team\'s time zone, e.g. "*/15 9-18 * * 1-5" (every 15 minutes in working hours on weekdays) or "0 18 L * *" (18:00 on the last day of the month; L = last day)'),
  connections: z.array(z.string().max(200)).max(20).optional().describe('Only when a run must call tools of a connected service that change something there (post a message, upload, add a record: any tool whose description says it changes something at the service): those connections, by their names under "Connected services": team connections set to send without asking, or the user\'s own (personal) connections, which also need send_to. Leave it out otherwise.'),
  send_to: z.array(z.object({
    connection: z.string().max(200).describe('one of the user\'s own connections in `connections`'),
    to: z.array(z.string().max(500)).min(1).max(MAX_PINS).describe('exactly where runs may send: a page or database id, an e-mail address, a channel id or name, a webhook address'),
  })).max(10).optional().describe('For the user\'s own (personal) connections: the only recipients runs may send to; a run sends nowhere else. The card shows them.'),
  save_to: z.string().max(1000).optional().describe('Only when runs must save files in a team folder that more people can see than what they read (e.g. "shared/weekly-reports"): that existing folder. After the user\'s yes on the card, runs may make NEW files there and in its sub-folders without asking (never change, replace, move or delete existing files; never skills or instruction files), at most 20 per run. Leave it out for the user\'s own folder, where runs always may save.'),
  reads: z.array(z.string().max(1000)).max(MAX_SOURCES).optional().describe('The places runs read whose content may go into save_to although fewer people can see them: "my folder", team folder paths, and rooms as #[name](room:<id>) or their ids. A run that read anything else that fewer people can see does not save there. Rooms listed here also let a run that read them send to the user\'s own connections at their pinned recipients (never to a team connection after a room read).'),
})

/** An address a run opens while the server does not know its exit address (url-gate.ts: a plain one the card listed):
 * no long random-looking part, no user name or password, a site name rather than a number. */
const plainUrl = (u: string) => {
  try { const x = new URL(u); return !opaqueParts(u).length && !x.username && !x.password && !/^[\d.]+$|^\[/.test(x.hostname) } catch { return false }
}

/** The turn's project, whether it is a scheduled run, and the shared chat it is in (null: the person's own chat). */
function turnInfo(ctx: AppContext, t: ToolCtx): { projectId: string | null; scheduled: boolean; sharedChat: string | null } {
  if (!t.turnId) return { projectId: null, scheduled: false, sharedChat: null }
  const r = ctx.db.query('SELECT c.id, c.project_id, c.shared_at, c.people_shared_at, t.client_kind FROM turns t JOIN chats c ON c.id = t.chat_id WHERE t.id = ?').get(t.turnId) as { id: string; project_id: string | null; shared_at: string | null; people_shared_at: string | null; client_kind: string | null } | null
  return { projectId: r?.project_id ?? null, scheduled: r?.client_kind === 'schedule', sharedChat: r && isSharedRow(r) ? r.id : null }
}

/** In a shared chat the person's other tasks are theirs alone (their titles and instructions): schedule_list and
 * schedule_delete there see only the tasks made in that chat, whose runs post there. */
const visibleIn = (sharedChat: string | null) => (s: ScheduleRow) => sharedChat === null || s.chat_id === sharedChat

type L5 = Record<Locale, string>
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)

export const TEXT = {
  reviewQuestion: {
    ko: '이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요. 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인하고 다시 켤지 골라 주세요.\n\n제목: {title}\n일정: {when}',
    en: 'This scheduled task was made without its confirmation card, so it is paused. It runs the instruction below on its own, with nobody watching. Check the instruction and its addresses, then choose whether to resume it.\n\nTitle: {title}\nSchedule: {when}',
    id: 'Tugas terjadwal ini dibuat tanpa kartu konfirmasi, jadi dijeda. Tugas ini menjalankan instruksi di bawah sendiri, tanpa ada yang mengawasi. Periksa instruksi dan alamatnya, lalu pilih apakah akan melanjutkannya.\n\nJudul: {title}\nJadwal: {when}',
    ja: 'この定期タスクは確認カードなしで作成されたため一時停止しています。定期タスクは誰も見ていないときに下の指示をそのまま実行します。指示とアドレスを確認し、再開するか選んでください。\n\nタイトル：{title}\n予定：{when}',
    es: 'Esta tarea programada se creó sin su tarjeta de confirmación, así que está en pausa. Ejecuta la instrucción de abajo por su cuenta, sin que nadie la vigile. Revise la instrucción y sus direcciones y elija si reanudarla.\n\nTítulo: {title}\nHorario: {when}',
    zh: '此定时任务创建时没有经过确认卡片，因此已暂停。它会在无人看管的情况下自动执行下面的指令。请检查指令和其中的地址，然后选择是否恢复。\n\n标题：{title}\n时间：{when}',
  } satisfies L5,
  /** "수정" in Settings (chat/schedule-edit.ts): the edited task, as it will run */
  editQuestion: {
    ko: '예약 작업을 이렇게 바꿀까요? 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인해 주세요.\n\n제목: {title}\n일정: {when}',
    en: 'Change this scheduled task to the following? It runs the instruction below on its own, with nobody watching. Check the instruction and its addresses.\n\nTitle: {title}\nSchedule: {when}',
    id: 'Ubah tugas terjadwal ini menjadi seperti berikut? Tugas ini menjalankan instruksi di bawah sendiri, tanpa ada yang mengawasi. Periksa instruksi dan alamatnya.\n\nJudul: {title}\nJadwal: {when}',
    ja: 'この定期タスクを次のように変更しますか？定期タスクは誰も見ていないときに下の指示をそのまま実行します。指示とアドレスを確認してください。\n\nタイトル：{title}\n予定：{when}',
    es: '¿Cambiar esta tarea programada a lo siguiente? Ejecuta la instrucción de abajo por su cuenta, sin que nadie la vigile. Revise la instrucción y sus direcciones.\n\nTítulo: {title}\nHorario: {when}',
    zh: '要把此定时任务改成下面这样吗？它会在无人看管的情况下自动执行下面的指令。请检查指令和其中的地址。\n\n标题：{title}\n时间：{when}',
  } satisfies L5,
  project: { ko: '프로젝트: {name}', en: 'Project: {name}', id: 'Proyek: {name}', ja: 'プロジェクト：{name}', es: 'Proyecto: {name}', zh: '项目：{name}' } satisfies L5,
  question: {
    ko: 'AI가 예약 작업을 만들려고 해요. 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인해 주세요.\n\n제목: {title}\n일정: {when}',
    en: 'The AI wants to create a scheduled task. It runs the instruction below on its own, with nobody watching. Check the instruction and its addresses.\n\nTitle: {title}\nSchedule: {when}',
    id: 'AI ingin membuat tugas terjadwal. Tugas ini menjalankan instruksi di bawah sendiri, tanpa ada yang mengawasi. Periksa instruksi dan alamatnya.\n\nJudul: {title}\nJadwal: {when}',
    ja: 'AIが定期タスクを作成しようとしています。定期タスクは誰も見ていないときに下の指示をそのまま実行します。指示とアドレスを確認してください。\n\nタイトル：{title}\n予定：{when}',
    es: 'La IA quiere crear una tarea programada. Ejecuta la instrucción de abajo por su cuenta, sin que nadie la vigile. Revise la instrucción y sus direcciones.\n\nTítulo: {title}\nHorario: {when}',
    zh: 'AI 想创建一个定时任务。它会在无人看管的情况下自动执行下面的指令。请检查指令和其中的地址。\n\n标题：{title}\n时间：{when}',
  } satisfies L5,
  urls: {
    ko: '실행할 때마다 아래 주소 {n}개는 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.',
    en: 'On each run it opens the {n} addresses below without asking. An address can carry data out, so check each one in full.',
    id: 'Setiap kali berjalan, tugas ini membuka {n} alamat di bawah tanpa bertanya. Alamat bisa membawa data keluar, jadi periksa masing-masing secara lengkap.',
    ja: '実行のたびに下の{n}件のアドレスを確認なしで開きます。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください。',
    es: 'En cada ejecución abre sin preguntar las {n} direcciones de abajo. Una dirección puede sacar datos; revise cada una completa.',
    zh: '每次运行时，它会不经询问打开下面的{n}个地址。地址可能会把数据带出去，请完整检查每一个地址。',
  } satisfies L5,
  urlsBlocked: {
    ko: '아래 주소 {n}개는 지금 이 서버에서는 실행 때 열 수 없어요. 팀 서버가 아직 자기 공인 주소를 몰라서 주소마다 사람이 확인해야 하는데, 실행 중에는 확인할 사람이 없어요. 서버가 공인 주소를 알게 되면 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.',
    en: 'On this server, runs cannot open the {n} addresses below yet: the team server does not know its own public address, so each address needs a person to confirm it, and nobody is there during a run. Once the server knows its public address, runs open them without asking. An address can carry data out, so check each one in full.',
    id: 'Di server ini, tugas belum bisa membuka {n} alamat di bawah saat berjalan: server tim belum mengetahui alamat publiknya sendiri, jadi setiap alamat perlu dikonfirmasi seseorang, dan tidak ada yang mengawasi saat tugas berjalan. Setelah server mengetahuinya, tugas membuka alamat itu tanpa bertanya. Alamat bisa membawa data keluar, jadi periksa masing-masing secara lengkap.',
    ja: 'このサーバーでは、実行時に下の{n}件のアドレスをまだ開けません。チームサーバーが自分の公開アドレスを把握していないため、アドレスごとに人の確認が必要ですが、実行中は確認する人がいません。サーバーが公開アドレスを把握すると、確認なしで開きます。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください。',
    es: 'En este servidor, las ejecuciones aún no pueden abrir las {n} direcciones de abajo: el servidor del equipo no conoce su propia dirección pública, así que cada dirección necesita que alguien la confirme, y durante una ejecución no hay nadie. Cuando el servidor conozca su dirección pública, las ejecuciones las abrirán sin preguntar. Una dirección puede sacar datos; revise cada una completa.',
    zh: '在此服务器上，运行时还不能打开下面的{n}个地址：团队服务器还不知道自己的公网地址，所以每个地址都需要有人确认，而运行时没有人在场。服务器知道自己的公网地址后，运行时会不经询问打开它们。地址可能会把数据带出去，请完整检查每一个地址。',
  } satisfies L5,
  /** one address: English and Spanish say it in the singular; Korean, Indonesian, Japanese and Chinese count it like the rest */
  urlsOne: {
    ko: '실행할 때마다 아래 주소 1개는 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.',
    en: 'On each run it opens the address below without asking. An address can carry data out, so check it in full.',
    id: 'Setiap kali berjalan, tugas ini membuka 1 alamat di bawah tanpa bertanya. Alamat bisa membawa data keluar, jadi periksa alamat itu secara lengkap.',
    ja: '実行のたびに下の1件のアドレスを確認なしで開きます。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください。',
    es: 'En cada ejecución abre sin preguntar la dirección de abajo. Una dirección puede sacar datos; revísela completa.',
    zh: '每次运行时，它会不经询问打开下面的1个地址。地址可能会把数据带出去，请完整检查这个地址。',
  } satisfies L5,
  urlsBlockedOne: {
    ko: '아래 주소 1개는 지금 이 서버에서는 실행 때 열 수 없어요. 팀 서버가 아직 자기 공인 주소를 몰라서 이 주소를 사람이 확인해야 하는데, 실행 중에는 확인할 사람이 없어요. 서버가 공인 주소를 알게 되면 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.',
    en: 'On this server, runs cannot open the address below yet: the team server does not know its own public address, so the address needs a person to confirm it, and nobody is there during a run. Once the server knows its public address, runs open it without asking. An address can carry data out, so check it in full.',
    id: 'Di server ini, tugas belum bisa membuka 1 alamat di bawah saat berjalan: server tim belum mengetahui alamat publiknya sendiri, jadi alamat itu perlu dikonfirmasi seseorang, dan tidak ada yang mengawasi saat tugas berjalan. Setelah server mengetahuinya, tugas membuka alamat itu tanpa bertanya. Alamat bisa membawa data keluar, jadi periksa alamat itu secara lengkap.',
    ja: 'このサーバーでは、実行時に下の1件のアドレスをまだ開けません。チームサーバーが自分の公開アドレスを把握していないため、このアドレスには人の確認が必要ですが、実行中は確認する人がいません。サーバーが公開アドレスを把握すると、確認なしで開きます。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください。',
    es: 'En este servidor, las ejecuciones aún no pueden abrir la dirección de abajo: el servidor del equipo no conoce su propia dirección pública, así que la dirección necesita que alguien la confirme, y durante una ejecución no hay nadie. Cuando el servidor conozca su dirección pública, las ejecuciones la abrirán sin preguntar. Una dirección puede sacar datos; revísela completa.',
    zh: '在此服务器上，运行时还不能打开下面的1个地址：团队服务器还不知道自己的公网地址，所以这个地址需要有人确认，而运行时没有人在场。服务器知道自己的公网地址后，运行时会不经询问打开它。地址可能会把数据带出去，请完整检查这个地址。',
  } satisfies L5,
  /** addresses with a query over MAX_UNCONFIRMED_QUERY characters: a person must confirm each one every time
   * (url-gate.ts ③), and nobody is there during a run, so runs never open them */
  longQuery: {
    ko: '주소 뒤에 긴 내용({max}자 넘는 쿼리)이 붙은 아래 주소 {n}개는 실행 때 열지 않아요(강조 표시). 이런 주소는 늘 사람이 확인해야 하는데, 실행 중에는 확인할 사람이 없어요.',
    en: 'Runs never open the {n} addresses with a long query (over {max} characters, highlighted below): such an address always needs a person to confirm it, and nobody is there during a run.',
    id: 'Tugas tidak pernah membuka {n} alamat dengan kueri panjang (lebih dari {max} karakter, disorot di bawah) saat berjalan: alamat seperti itu selalu perlu dikonfirmasi seseorang, dan tidak ada yang mengawasi saat tugas berjalan.',
    ja: '長いクエリ（{max}文字超、下で強調表示）が付いた{n}件のアドレスは実行時に開きません。このようなアドレスは毎回人の確認が必要ですが、実行中は確認する人がいません。',
    es: 'Las ejecuciones nunca abren las {n} direcciones con una consulta larga (más de {max} caracteres, resaltadas abajo): una dirección así siempre necesita que alguien la confirme, y durante una ejecución no hay nadie.',
    zh: '运行时永远不会打开下面{n}个带有长查询（超过{max}个字符，已高亮）的地址：这类地址每次都需要有人确认，而运行时没有人在场。',
  } satisfies L5,
  longQueryOne: {
    ko: '주소 뒤에 긴 내용({max}자 넘는 쿼리)이 붙은 아래 주소 1개는 실행 때 열지 않아요(강조 표시). 이런 주소는 늘 사람이 확인해야 하는데, 실행 중에는 확인할 사람이 없어요.',
    en: 'Runs never open the address with a long query (over {max} characters, highlighted below): such an address always needs a person to confirm it, and nobody is there during a run.',
    id: 'Tugas tidak pernah membuka 1 alamat dengan kueri panjang (lebih dari {max} karakter, disorot di bawah) saat berjalan: alamat seperti itu selalu perlu dikonfirmasi seseorang, dan tidak ada yang mengawasi saat tugas berjalan.',
    ja: '長いクエリ（{max}文字超、下で強調表示）が付いた1件のアドレスは実行時に開きません。このようなアドレスは毎回人の確認が必要ですが、実行中は確認する人がいません。',
    es: 'Las ejecuciones nunca abren la dirección con una consulta larga (más de {max} caracteres, resaltada abajo): una dirección así siempre necesita que alguien la confirme, y durante una ejecución no hay nadie.',
    zh: '运行时永远不会打开下面这个带有长查询（超过{max}个字符，已高亮）的地址：这类地址每次都需要有人确认，而运行时没有人在场。',
  } satisfies L5,
  opaque: {
    ko: '알아보기 어려운 긴 문자열이 있어요(강조 표시). 내용을 실어 보낼 수 있으니 무엇인지 확인해 주세요.',
    en: 'It contains long strings that are hard to read (highlighted). They can carry data; check what they are.',
    id: 'Ada string panjang yang sulit dibaca (disorot). String itu bisa membawa data; periksa isinya.',
    ja: '読み取りにくい長い文字列が含まれています（強調表示）。データを運べるため、内容を確認してください。',
    es: 'Contiene cadenas largas difíciles de leer (resaltadas). Pueden llevar datos; compruebe qué son.',
    zh: '其中包含难以看懂的长字符串（已高亮）。它们可能夹带数据，请确认是什么。',
  } satisfies L5,
  connections: {
    ko: '이 연결 서비스는 AI가 묻지 않고 보내도록 설정돼 있어요: {names}. 이 예약 작업이 여기에 보내도 될지 골라 주세요.',
    en: 'These connected services let the AI send without asking: {names}. Choose whether this scheduled task may send to them.',
    id: 'Layanan terhubung ini membiarkan AI mengirim tanpa bertanya: {names}. Pilih apakah tugas terjadwal ini boleh mengirim ke sana.',
    ja: '次の接続サービスはAIが確認なしで送信できる設定です：{names}。この定期タスクがそこへ送信してよいか選んでください。',
    es: 'Estos servicios conectados permiten que la IA envíe sin preguntar: {names}. Elija si esta tarea programada puede enviarles datos.',
    zh: '这些已连接的服务允许 AI 不经询问发送内容：{names}。请选择此定时任务是否可以向它们发送。',
  } satisfies L5,
  labelPrompt: { ko: '지시문', en: 'Instruction', id: 'Instruksi', ja: '指示', es: 'Instrucción', zh: '指令' } satisfies L5,
  labelUrls: {
    ko: '실행 때 묻지 않고 여는 주소', en: 'Addresses opened without asking on each run', id: 'Alamat yang dibuka tanpa bertanya setiap kali berjalan',
    ja: '実行時に確認なしで開くアドレス', es: 'Direcciones que abre sin preguntar en cada ejecución', zh: '每次运行时不经询问打开的地址',
  } satisfies L5,
  labelUrlsLongQuery: {
    ko: '실행 때 열지 않는 주소(긴 쿼리)', en: 'Addresses runs never open (long query)', id: 'Alamat yang tidak pernah dibuka saat berjalan (kueri panjang)',
    ja: '実行時に開かないアドレス（長いクエリ）', es: 'Direcciones que las ejecuciones nunca abren (consulta larga)', zh: '运行时永远不会打开的地址（长查询）',
  } satisfies L5,
  labelUrlsBlocked: {
    ko: '지시문의 주소(지금은 실행 때 열 수 없음)', en: 'Addresses in the instruction (runs cannot open them yet)', id: 'Alamat dalam instruksi (belum bisa dibuka saat berjalan)',
    ja: '指示内のアドレス（実行時はまだ開けません）', es: 'Direcciones de la instrucción (las ejecuciones aún no pueden abrirlas)', zh: '指令中的地址（运行时还不能打开）',
  } satisfies L5,
  create: { ko: '만들기', en: 'Create', id: 'Buat', ja: '作成する', es: 'Crear', zh: '创建' } satisfies L5,
  createWrite: { ko: '만들기(연결 서비스에 보내기 허용)', en: 'Create, may send to those services', id: 'Buat, boleh mengirim ke layanan itu', ja: '作成する（そのサービスへの送信を許可）', es: 'Crear y permitir enviar a esos servicios', zh: '创建，允许向这些服务发送' } satisfies L5,
  createNoWrite: { ko: '만들기(연결 서비스에는 보내지 않음)', en: 'Create, never send to connected services', id: 'Buat, jangan kirim ke layanan terhubung', ja: '作成する（接続サービスには送信しない）', es: 'Crear sin enviar a servicios conectados', zh: '创建，从不向已连接的服务发送' } satisfies L5,
  deny: { ko: '만들지 않기', en: 'Don’t create', id: 'Jangan buat', ja: '作成しない', es: 'No crear', zh: '不创建' } satisfies L5,
  resume: { ko: '다시 켜기', en: 'Resume', id: 'Lanjutkan', ja: '再開する', es: 'Reanudar', zh: '恢复' } satisfies L5,
  resumeWrite: { ko: '다시 켜기(연결 서비스에 보내기 허용)', en: 'Resume, may send to those services', id: 'Lanjutkan, boleh mengirim ke layanan itu', ja: '再開する（そのサービスへの送信を許可）', es: 'Reanudar y permitir enviar a esos servicios', zh: '恢复，允许向这些服务发送' } satisfies L5,
  resumeNoWrite: { ko: '다시 켜기(연결 서비스에는 보내지 않음)', en: 'Resume, never send to connected services', id: 'Lanjutkan, jangan kirim ke layanan terhubung', ja: '再開する（接続サービスには送信しない）', es: 'Reanudar sin enviar a servicios conectados', zh: '恢复，从不向已连接的服务发送' } satisfies L5,
  save: { ko: '바꾸기', en: 'Save changes', id: 'Simpan perubahan', ja: '変更する', es: 'Guardar cambios', zh: '保存更改' } satisfies L5,
  saveWrite: { ko: '바꾸기(연결 서비스에 보내기 허용)', en: 'Save, may send to those services', id: 'Simpan, boleh mengirim ke layanan itu', ja: '変更する（そのサービスへの送信を許可）', es: 'Guardar y permitir enviar a esos servicios', zh: '保存，允许向这些服务发送' } satisfies L5,
  saveNoWrite: { ko: '바꾸기(연결 서비스에는 보내지 않음)', en: 'Save, never send to connected services', id: 'Simpan, jangan kirim ke layanan terhubung', ja: '変更する（接続サービスには送信しない）', es: 'Guardar sin enviar a servicios conectados', zh: '保存，从不向已连接的服务发送' } satisfies L5,
  dontSave: { ko: '바꾸지 않기', en: 'Don’t change', id: 'Jangan ubah', ja: '変更しない', es: 'No cambiar', zh: '不更改' } satisfies L5,
  keep: { ko: '계속 멈춰 두기', en: 'Keep it paused', id: 'Tetap jeda', ja: '一時停止のままにする', es: 'Mantener en pausa', zh: '保持暂停' } satisfies L5,
  /** the save folder the card allows (chat/schedule-scope.ts), its readers now and the places that may go there */
  saveLine: {
    ko: '새 파일 저장: {folder} (지금 {n}명이 볼 수 있어요). 넣어도 되는 내용: {sources}',
    en: 'Saves new files in: {folder} ({n} people can see it now). Content that may go there: {sources}',
    id: 'Menyimpan file baru di: {folder} (sekarang {n} orang dapat melihatnya). Isi yang boleh masuk: {sources}',
    ja: '新しいファイルの保存先：{folder}（今{n}人が見られます）。入れてよい内容：{sources}',
    es: 'Guarda archivos nuevos en: {folder} (ahora lo pueden ver {n} personas). Contenido que puede ir ahí: {sources}',
    zh: '新文件保存到：{folder}（现在有{n}人能看到）。可能放到那里的内容：{sources}',
  } satisfies L5,
  saveLineBare: {
    ko: '새 파일 저장: {folder} (지금 {n}명이 볼 수 있어요).',
    en: 'Saves new files in: {folder} ({n} people can see it now).',
    id: 'Menyimpan file baru di: {folder} (sekarang {n} orang dapat melihatnya).',
    ja: '新しいファイルの保存先：{folder}（今{n}人が見られます）。',
    es: 'Guarda archivos nuevos en: {folder} (ahora lo pueden ver {n} personas).',
    zh: '新文件保存到：{folder}（现在有{n}人能看到）。',
  } satisfies L5,
  /** a save folder that is not there yet: made when the person says yes (chat/schedule-scope.ts makeSaveFolder) */
  newFolder: {
    ko: '새 폴더, 만들기를 누르면 생겨요. ', en: 'a new folder, made when you create the task; ', id: 'folder baru, dibuat saat Anda membuat tugas ini; ',
    ja: '新しいフォルダー、作成すると作られます。', es: 'una carpeta nueva, se crea al crear la tarea; ', zh: '新文件夹，创建任务时建立；',
  } satisfies L5,
  /** rooms a run may read (no save folder). Read only: a run never posts to a room (post_to_room refuses in a scheduled
   * run, chat/post-to-room.ts), so the line says nothing of sending; a send after reading one goes only to the person's
   * own connections the sendsLine pins (QA on dev 1565b39f1: "읽고 보내도 되는" promised a post to the room) */
  roomsLine: {
    ko: '읽을 수 있는 대화: {rooms}', en: 'Conversations it may read: {rooms}', id: 'Percakapan yang boleh dibaca: {rooms}',
    ja: '読んでよいトーク：{rooms}', es: 'Conversaciones que puede leer: {rooms}', zh: '它可以读取的对话：{rooms}',
  } satisfies L5,
  /** the person's own connections and the recipients the card pins */
  sendsLine: { ko: '보낼 수 있는 곳: {list}', en: 'Where it may send: {list}', id: 'Tempat yang boleh dikirimi: {list}', ja: '送信してよい先：{list}', es: 'Adónde puede enviar: {list}', zh: '它可以发送到：{list}' } satisfies L5,
  /** the person's own folder, as the app names it (web scheduled.sourceMineFiles; shared/folder-labels.ts OWN_FILES_LABEL) */
  sourceMine: { ko: '내 파일', en: 'my files', id: 'file saya', ja: '自分のファイル', es: 'mis archivos', zh: '我的文件' } satisfies L5,
  sourceRoom: { ko: '#{name} 대화', en: '#{name} conversation', id: 'percakapan #{name}', ja: '#{name}のトーク', es: 'conversación #{name}', zh: '#{name} 对话' } satisfies L5,
  sourceRoot: { ko: '팀 폴더 맨 위', en: 'the top of the team folder', id: 'bagian atas folder tim', ja: 'チームフォルダーの最上位', es: 'la raíz de la carpeta del equipo', zh: '团队文件夹的最上层' } satisfies L5,
  /** "다시 확인" after the save permission lapsed (chat/schedule-review.ts) */
  recheckQuestion: {
    ko: '이 예약 작업의 저장 허용을 멈춰 뒀어요: {why}. 그동안 결과는 내 파일에 저장해요. 아래 폴더에 다시 새 파일을 저장해도 될지 골라 주세요.\n\n제목: {title}\n일정: {when}',
    en: 'Saving for this scheduled task is paused: {why}. Meanwhile its results go to My files. Choose whether it may save new files in the folder below again.\n\nTitle: {title}\nSchedule: {when}',
    id: 'Penyimpanan untuk tugas terjadwal ini dijeda: {why}. Sementara itu hasilnya masuk ke File saya. Pilih apakah tugas ini boleh menyimpan file baru di folder di bawah lagi.\n\nJudul: {title}\nJadwal: {when}',
    ja: 'この定期タスクの保存の許可を一時停止しています：{why}。その間、結果は自分のファイルに保存されます。下のフォルダーに再び新しいファイルを保存してよいか選んでください。\n\nタイトル：{title}\n予定：{when}',
    es: 'El guardado de esta tarea programada está en pausa: {why}. Mientras tanto, sus resultados van a Mis archivos. Elija si puede volver a guardar archivos nuevos en la carpeta de abajo.\n\nTítulo: {title}\nHorario: {when}',
    zh: '此定时任务的保存已暂停：{why}。在此期间，它的结果会放到“我的文件”。请选择是否允许它再次把新文件保存到下面的文件夹。\n\n标题：{title}\n时间：{when}',
  } satisfies L5,
  lapse_folder: { ko: '저장 폴더가 옮겨졌거나, 이름이 바뀌었거나, 지워졌어요', en: 'the save folder was moved, renamed or deleted', id: 'folder simpan dipindahkan, diganti namanya, atau dihapus', ja: '保存先フォルダーが移動、名前変更、または削除されました', es: 'la carpeta de guardado se movió, se renombró o se eliminó', zh: '保存文件夹已被移动、重命名或删除' } satisfies L5,
  lapse_rules: { ko: '저장 폴더의 권한 설정이 바뀌었어요', en: 'the save folder\'s permissions changed', id: 'izin folder simpan berubah', ja: '保存先フォルダーの権限が変わりました', es: 'cambiaron los permisos de la carpeta de guardado', zh: '保存文件夹的权限已更改' } satisfies L5,
  lapse_access: { ko: '저장 폴더에 쓸 권한이 없어졌어요', en: 'you can no longer write in the save folder', id: 'Anda tidak bisa lagi menulis di folder simpan', ja: '保存先フォルダーに書き込む権限がなくなりました', es: 'ya no puede escribir en la carpeta de guardado', zh: '你已无法写入保存文件夹' } satisfies L5,
  resave: { ko: '다시 허용', en: 'Allow again', id: 'Izinkan lagi', ja: 'もう一度許可する', es: 'Permitir de nuevo', zh: '再次允许' } satisfies L5,
  leaveLapsed: { ko: '그대로 두기', en: 'Leave it', id: 'Biarkan', ja: 'そのままにする', es: 'Dejarlo así', zh: '暂不处理' } satisfies L5,
  once: { ko: '{date} {time}에 한 번', en: 'once on {date} at {time}', id: 'sekali pada {date} pukul {time}', ja: '{date} {time}に1回', es: 'una vez el {date} a las {time}', zh: '{date} {time}（一次）' } satisfies L5,
  daily: { ko: '매일 {time}', en: 'every day at {time}', id: 'setiap hari pukul {time}', ja: '毎日 {time}', es: 'todos los días a las {time}', zh: '每天 {time}' } satisfies L5,
  weekdays: { ko: '평일(월–금) {time}', en: 'every weekday (Mon–Fri) at {time}', id: 'setiap hari kerja (Sen–Jum) pukul {time}', ja: '平日（月〜金） {time}', es: 'cada día laborable (lun–vie) a las {time}', zh: '每个工作日（周一至周五） {time}' } satisfies L5,
  weekly: { ko: '매주 {weekday} {time}', en: 'every {weekday} at {time}', id: 'setiap {weekday} pukul {time}', ja: '毎週{weekday} {time}', es: 'cada {weekday} a las {time}', zh: '每{weekday} {time}' } satisfies L5,
  monthly: { ko: '매월 {day}일 {time}', en: 'every month on day {day} at {time}', id: 'setiap bulan tanggal {day} pukul {time}', ja: '毎月{day}日 {time}', es: 'cada mes el día {day} a las {time}', zh: '每月{day}日 {time}' } satisfies L5,
  /** day 29–31: a month without that day has no run (chat/schedule-timing.ts) */
  monthlyLate: { ko: '매월 {day}일 {time} ({day}일이 없는 달은 건너뛰어요)', en: 'every month on day {day} at {time} (skipped in months without a day {day})', id: 'setiap bulan tanggal {day} pukul {time} (dilewati pada bulan tanpa tanggal {day})', ja: '毎月{day}日 {time}（{day}日がない月は実行しません）', es: 'cada mes el día {day} a las {time} (se salta en los meses sin día {day})', zh: '每月{day}日 {time}（没有{day}日的月份跳过）' } satisfies L5,
  monthlyLast: { ko: '매월 마지막 날 {time}', en: 'on the last day of every month at {time}', id: 'setiap hari terakhir bulan pukul {time}', ja: '毎月末日 {time}', es: 'el último día de cada mes a las {time}', zh: '每月最后一天 {time}' } satisfies L5,
  intervalMinutes: { ko: '{start}부터 {n}분마다', en: 'every {n} minutes, from {start}', id: 'setiap {n} menit, mulai {start}', ja: '{start}から{n}分ごと', es: 'cada {n} minutos, desde el {start}', zh: '从{start}起每{n}分钟' } satisfies L5,
  intervalHours: { ko: '{start}부터 {n}시간마다', en: 'every {n} hours, from {start}', id: 'setiap {n} jam, mulai {start}', ja: '{start}から{n}時間ごと', es: 'cada {n} horas, desde el {start}', zh: '从{start}起每{n}小时' } satisfies L5,
  intervalDays: { ko: '{start}부터 {n}일마다', en: 'every {n} days, from {start}', id: 'setiap {n} hari, mulai {start}', ja: '{start}から{n}日ごと', es: 'cada {n} días, desde el {start}', zh: '从{start}起每{n}天' } satisfies L5,
  /** a cron schedule, as written (its five fields in the team's time zone) */
  cron: { ko: '반복 일정(cron) {cron}', en: 'on the cron schedule {cron}', id: 'dengan jadwal cron {cron}', ja: 'cronスケジュール {cron}', es: 'con el horario cron {cron}', zh: '按 cron 计划 {cron}' } satisfies L5,
  /** a task made in a shared chat: its runs post there (docs/decisions/20261118-shared-schedules-any-frequency.md) */
  sharedChat: {
    ko: '실행할 때마다 예약 작업의 지시문과 결과가 이 공유 채팅에 올라가요. 지금 {n}명이 이 채팅을 볼 수 있어요. 실행은 내 권한으로 하고, 이 채팅의 일부 사람이 열 수 없는 곳은 읽지 않아요.',
    en: 'Each run posts the task\'s instruction and its result in this shared chat, which {n} people can see now. Runs work with your access and skip places some people here cannot open.',
    id: 'Setiap kali berjalan, instruksi tugas dan hasilnya diposting di obrolan bersama ini, yang sekarang dapat dilihat {n} orang. Tugas berjalan dengan akses Anda dan melewati tempat yang tidak bisa dibuka sebagian orang di sini.',
    ja: '実行のたびに、タスクの指示と結果がこの共有チャットに投稿されます。今{n}人がこのチャットを見られます。実行はあなたの権限で行われ、ここにいる一部の人が開けない場所は読みません。',
    es: 'Cada ejecución publica la instrucción de la tarea y su resultado en este chat compartido, que ahora pueden ver {n} personas. Las ejecuciones usan su acceso y omiten los lugares que algunas personas de aquí no pueden abrir.',
    zh: '每次运行都会把任务的指令和结果发到这个共享对话中，现在有{n}人能看到它。运行使用你的权限，并跳过这里有些人打不开的地方。',
  } satisfies L5,
} as const

export type CardMode = 'create' | 'review' | 'edit' | 'recheck'

/** What the card says about saving and sending, in words (chat/schedule-scope.ts): the save folder with how many can
 * read it now and the places whose content may go there; the rooms a run may read (no save folder; never a post to them);
 * the person's own connections with the recipients they are pinned to. */
export interface CardScope { save?: { folder: string; readers: number; sources: string[]; create?: boolean } | null; rooms?: string[]; sends?: { name: string; pins: string[] }[] }

const quoted = (v: string) => `'${v.replace(/\s+/g, ' ').trim()}'`
/** The card's lines for a CardScope (none for an empty one). */
export function scopeLines(scope: CardScope | undefined, L: Locale): string[] {
  const lines: string[] = []
  if (!scope) return lines
  if (scope.save) {
    const v = { folder: scope.save.folder, n: String(scope.save.readers), sources: scope.save.sources.join(', ') }
    const line = fill(TEXT[scope.save.sources.length ? 'saveLine' : 'saveLineBare'][L], v)
    // a new folder: said inside the one bracket after the folder ("… (새 폴더, 만들기를 누르면 생겨요. 지금 5명이 …)")
    const at = line.indexOf(v.folder) + v.folder.length
    const open = scope.save.create ? /^\s?[(（]/.exec(line.slice(at)) : null
    lines.push(open ? `${line.slice(0, at + open[0].length)}${TEXT.newFolder[L]}${line.slice(at + open[0].length)}` : line)
  } else if (scope.rooms?.length) lines.push(fill(TEXT.roomsLine[L], { rooms: scope.rooms.join(', ') }))
  if (scope.sends?.length) lines.push(fill(TEXT.sendsLine[L], { list: scope.sends.map((x) => `${x.name.replace(/\s+/g, ' ').trim()} · ${x.pins.map(quoted).join(', ')}`).join('; ') }))
  return lines
}

/** The words for a task's save folder, places and pinned connections on its card, as the person reads them now. */
export function cardScope(db: Database, userId: string, L: Locale, save: SaveFolder | null, sources: readonly ScopeSource[], sends: readonly { name: string; pins: string[] }[]): CardScope {
  const words = { mine: TEXT.sourceMine[L], root: TEXT.sourceRoot[L], room: TEXT.sourceRoom[L] }
  const names = sources.map((x) => sourceText(db, x, userId, words))
  return {
    save: save ? { folder: save.folder, readers: save.readers, sources: names, ...(save.create ? { create: true } : {}) } : null,
    rooms: save ? [] : names,
    sends: [...sends],
  }
}

/** The schedule in the person's language ("매주 월요일 09:00"), for the card: a row, ScheduleInput's fields or a
 * Timing (chat/schedule-timing.ts). */
export function scheduleWhen(src: TimingSource, L: Locale): string {
  const s = timingOf(src)
  const dayName = (n: number) => new Intl.DateTimeFormat(L, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + n)))
  // several days of the week as the language lists them ("월요일 및 목요일", "Monday and Thursday")
  const weekday = new Intl.ListFormat(L, { type: 'conjunction' }).format((s.weekdays ?? []).map(dayName))
  // a one-time task's day in the person's words ("Nov 10, 2026"), not the stored form (QA TC-092; the Scheduled pages
  // do the same, web/src/lib/scheduleText.ts onceDate); read and shown in UTC, so it is never shifted
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date ?? '')
  const date = m ? new Intl.DateTimeFormat(L, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))) : s.date ?? ''
  if (s.repeat === 'interval') {
    const n = s.everyMinutes ?? 0
    const key = n % 1440 === 0 ? 'intervalDays' : n % 60 === 0 ? 'intervalHours' : 'intervalMinutes'
    return fill(TEXT[key][L], { n: String(key === 'intervalDays' ? n / 1440 : key === 'intervalHours' ? n / 60 : n), start: `${date} ${s.time}` })
  }
  if (s.repeat === 'cron') return fill(TEXT.cron[L], { cron: `"${s.cron ?? ''}"` })
  if (s.repeat === 'monthly' && (s.day === 'last' || (typeof s.day === 'number' && s.day > 28))) return fill(TEXT[s.day === 'last' ? 'monthlyLast' : 'monthlyLate'][L], { time: s.time, day: String(s.day) })
  return fill(TEXT[s.repeat][L], { time: s.time, date, day: String(s.day ?? ''), weekday })
}

/** The schedule card: what the run will do, unattended, and what it may open or send without asking. 'create': the
 * AI's schedule_create; 'review': a task nobody confirmed, shown again to its owner to resume (chat/schedule-review.ts);
 * 'edit': the person changed a task in Settings (chat/schedule-edit.ts), with the project it runs in, if any.
 * `urlsOpen`: can a run open addresses without a person on this server now? Not while it does not know its own exit
 * address (tools/egress.ts egressOf): then every address needs a person, and the card says so instead of promising. */
export function scheduleCard(input: Pick<ScheduleInputT, 'title' | 'prompt'> & TimingSource, connections: string[], L: Locale, mode: CardMode = 'create', o: { urlsOpen?: boolean; project?: string | null; scope?: CardScope; why?: SaveLapse; sharedWith?: number } = {}): { question: string; urls: string[]; longQuery: string[]; extra: ConfirmExtra } {
  const open = o.urlsOpen !== false
  const urls = [...new Set(extractUrls(input.prompt))]
  // a query over MAX_UNCONFIRMED_QUERY characters always needs a person (url-gate.ts ③): runs never open such an
  // address, wherever it came from, so the card lists them apart with their query highlighted instead of promising them
  const longQuery = urls.filter((u) => new URL(u).search.slice(1).length > MAX_UNCONFIRMED_QUERY)
  const opens = urls.filter((u) => !longQuery.includes(u))
  const promptMarks = opaqueParts(input.prompt)
  // the title is the AI's: one line, so it cannot add lines that look like the server's own
  const head = fill(TEXT[mode === 'review' ? 'reviewQuestion' : mode === 'edit' ? 'editQuestion' : mode === 'recheck' ? 'recheckQuestion' : 'question'][L], { title: input.title.replace(/\s+/g, ' ').trim(), when: scheduleWhen(input, L), why: TEXT[`lapse_${o.why ?? 'folder'}`][L] })
  // an edit can move the task into a project (its folder and instructions); the project's name is one line too
  const lines = [o.project ? `${head}\n${fill(TEXT.project[L], { name: o.project.replace(/\s+/g, ' ').trim() })}` : head]
  if (opens.length) lines.push(fill(TEXT[opens.length === 1 ? (open ? 'urlsOne' : 'urlsBlockedOne') : open ? 'urls' : 'urlsBlocked'][L], { n: String(opens.length) }))
  if (longQuery.length) lines.push(fill(TEXT[longQuery.length === 1 ? 'longQueryOne' : 'longQuery'][L], { n: String(longQuery.length), max: String(MAX_UNCONFIRMED_QUERY) }))
  if (promptMarks.length) lines.push(TEXT.opaque[L])
  if (connections.length) lines.push(fill(TEXT.connections[L], { names: connections.join(', ') }))
  lines.push(...scopeLines(o.scope, L))
  // made in a shared chat: its runs post there, for everyone who sees it
  if (o.sharedWith !== undefined) lines.push(fill(TEXT.sharedChat[L], { n: String(o.sharedWith) }))
  const details = [{ label: TEXT.labelPrompt[L], text: input.prompt, ...(promptMarks.length ? { marks: promptMarks } : {}) }]
  if (opens.length) { const t = opens.join('\n'); const m = opaqueParts(t); details.push({ label: TEXT[open ? 'labelUrls' : 'labelUrlsBlocked'][L], text: t, ...(m.length ? { marks: m } : {}) }) }
  if (longQuery.length) {
    const t = longQuery.join('\n')
    // the query first, so the whole of it is highlighted (a random-looking part inside it is part of that mark)
    details.push({ label: TEXT.labelUrlsLongQuery[L], text: t, marks: [...new Set([...longQuery.map((u) => new URL(u).search), ...opaqueParts(t)])] })
  }
  return { question: lines.join('\n\n'), urls, longQuery, extra: { details } }
}

/** The card's answers: with "allow" team connections or pinned own connections the person picks whether runs may send
 * to them (the save folder holds for both); "다시 확인" of a lapsed save folder: allow it again, or leave it. */
export function scheduleOptions(L: Locale, writable: boolean, mode: CardMode = 'create'): { label: string; value: string }[] {
  if (mode === 'recheck') return [{ label: TEXT.resave[L], value: 'resave' }, { label: TEXT.leaveLapsed[L], value: 'keep' }]
  if (mode === 'edit') return writable
    ? [{ label: TEXT.saveWrite[L], value: 'save_write' }, { label: TEXT.saveNoWrite[L], value: 'save' }, { label: TEXT.dontSave[L], value: 'cancel' }]
    : [{ label: TEXT.save[L], value: 'save' }, { label: TEXT.dontSave[L], value: 'cancel' }]
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

/** The "allow" team connections a task names: the only ones its card offers and its runs may send to. Named = its
 * title or instruction has the connection's whole name (the rule for a template named in an instruction,
 * integrations/connections/schedule-needs.ts namesTemplate: too short or everyday a name never matches), or it is in
 * `also` (ids: the ones schedule_create's `connections` listed; for an edit, the ones the task may already send to).
 * A connection the person can use but the task never names is not on the card: a news briefing is not asked about
 * sending to an image service. */
export function taskConnections(writable: Row[], task: { title: string; prompt: string }, also: ReadonlySet<string> = new Set()): Row[] {
  const text = `${task.title}\n${task.prompt}`
  return writable.filter((r) => also.has(r.id) || namesTemplate(text, r.name))
}

/** schedule_create's `connections`: each one an "allow" team connection by its name, slug or tool key (team_<slug>),
 * ignoring case; `unknown` = the names that are none of them (refused before the card). */
export function listedConnections(writable: Row[], names: readonly string[]): { ids: Set<string>; unknown: string[] } {
  const ids = new Set<string>()
  const unknown: string[] = []
  for (const raw of names) {
    const n = raw.trim().toLowerCase()
    if (!n) continue
    const hits = writable.filter((r) => r.name.trim().toLowerCase() === n || r.slug.toLowerCase() === n || `team_${r.slug}`.toLowerCase() === n)
    if (hits.length) for (const r of hits) ids.add(r.id)
    else unknown.push(raw.trim())
  }
  return { ids, unknown }
}

/** The person's own connections a run could send to at pinned recipients (Q2 a): personal, theirs, usable now, not set
 * to refuse changes from the AI. */
export function ownConnections(ctx: AppContext, userId: string): Row[] {
  return usable(ctx.db, userId).filter((r) => r.scope === 'personal' && r.owner_user_id === userId && r.write_policy !== 'deny')
}
const isNamed = (r: Row, raw: string) => { const n = raw.trim().toLowerCase(); return !!n && (r.name.trim().toLowerCase() === n || r.slug.toLowerCase() === n || `my_${r.slug}`.toLowerCase() === n) }
const said = (v: string) => `"${v.replace(/\s+/g, ' ').slice(0, 80)}"`

/** A personal send with what the card shows of it. */
export type CardSend = PersonalSend & { name: string; version: number }

/**
 * schedule_create's own connections, send_to, save_to and reads, checked before the card: a ToolError says why nothing
 * was made. `ownNames`: the names in `connections` that are no "allow" team connection (one of the person's own each, or
 * refused). Returns the save folder, the places that go on the card (cardSources) and the pinned own connections.
 */
export function createScope(ctx: AppContext, userId: string, a: { save_to?: string; reads?: string[]; send_to?: { connection: string; to: string[] }[] }, ownNames: readonly string[], team: readonly Row[]): { save: SaveFolder | null; sources: ScopeSource[]; sends: CardSend[]; unknown: string[] } {
  const own = ownConnections(ctx, userId)
  const unknown: string[] = []
  const listedOwn = new Map<string, Row>()
  for (const n of ownNames) {
    const hit = own.filter((r) => isNamed(r, n))
    if (hit.length === 1) listedOwn.set(hit[0]!.id, hit[0]!)
    else unknown.push(n.trim())
  }
  const sends = new Map<string, CardSend>()
  for (const st of a.send_to ?? []) {
    const hit = own.filter((r) => isNamed(r, st.connection))
    if (hit.length !== 1) {
      const isTeam = team.some((r) => r.name.trim().toLowerCase() === st.connection.trim().toLowerCase() || r.slug.toLowerCase() === st.connection.trim().toLowerCase() || `team_${r.slug}`.toLowerCase() === st.connection.trim().toLowerCase())
      throw new ToolError(isTeam
        ? `send_to names the team connection ${said(st.connection)}: send_to is only for the user's own connections (a team connection set to send without asking is named in \`connections\` alone, and the team's settings decide where it sends). Nothing was created.`
        : `send_to names ${said(st.connection)}, which is not one of the user's own connections${own.length ? ` (${own.slice(0, 20).map((r) => r.name).join(', ')})` : ' (they have none)'}. Nothing was created.`)
    }
    const r = hit[0]!
    const pins = cleanPins([...(sends.get(r.id)?.pins ?? []), ...st.to])
    if (!pins.length) throw new ToolError(`send_to for ${r.name} names no recipient. Nothing was created.`)
    sends.set(r.id, { connectionId: r.id, pins, name: r.name, version: r.version })
  }
  for (const r of listedOwn.values()) {
    if (!sends.has(r.id)) throw new ToolError(`${r.name} is the user's own connection: a run sends to it only at recipients the card pins, so give them in send_to ({"connection": "${r.name}", "to": ["<page id, address or channel>"]}). Nothing was created.`)
  }
  // a folder the AI names that is not there yet is made on the person's yes (the card says so)
  const save = a.save_to?.trim() ? resolveSaveFolder(ctx, userId, a.save_to, { allowNew: true }) : null
  const res = resolveSources(ctx, userId, a.reads ?? [])
  if (res.unknown.length) throw new ToolError(`reads names ${res.unknown.map(said).join(', ')}: not "my folder", a team folder the user may read, or a room they are in (#[name](room:<id>) or its id). Nothing was created.`)
  if (!save && res.sources.some((x) => x.type !== 'room')) throw new ToolError('reads without save_to takes rooms only (the rooms a run may read before it sends): folders matter only for a save folder. Nothing was created.')
  return { save, sources: cardSources(ctx.db, ctx.files.rules(), res.sources, save?.folder ?? null, userId), sends: [...sends.values()], unknown }
}

/** A task's save folder, places and pinned own connections as its edit or review card shows them now (chat/schedule-
 * edit.ts, chat/schedule-review.ts): `folder` the save folder to use (undefined: the task's own; null: none), `keep` the
 * keys of the places to keep (undefined: all; a key the task does not have is refused). The folder is checked again
 * (ToolError: it cannot be one now); own connections that are gone or set to refuse are left out. */
export function taskScope(ctx: AppContext, s: Pick<ScheduleRowT, 'user_id' | 'save_folder' | 'save_sources' | 'personal_sends'>, o: { folder?: string | null; keep?: readonly string[] } = {}): { save: SaveFolder | null; sources: ScopeSource[]; sends: CardSend[]; badKeep: boolean } {
  const userId = s.user_id
  const folder = o.folder === undefined ? s.save_folder ?? null : o.folder
  const save = folder ? resolveSaveFolder(ctx, userId, folder) : null
  const current = rowSources(s)
  const keys = new Set(current.map(scopeKey))
  const badKeep = !!o.keep?.some((k) => !keys.has(k))
  const kept = o.keep ? current.filter((x) => o.keep!.includes(scopeKey(x))) : current
  const own = ownConnections(ctx, userId)
  const sends = rowSends(s).flatMap((x) => { const r = own.find((c) => c.id === x.connectionId); return r ? [{ ...x, name: r.name, version: r.version }] : [] })
  return { save, sources: cardSources(ctx.db, ctx.files.rules(), withRules(ctx.db, ctx.files.rules(), kept), save?.folder ?? null, userId), sends, badKeep }
}

/** What an edit or review card binds its answer to of the scope: the folder as it is on disk with its rules and readers,
 * the places, the own connections with their versions and pins. */
export function scopeBinding(x: { save: SaveFolder | null; sources: readonly ScopeSource[]; sends: readonly CardSend[] }) {
  return {
    save: x.save ? [x.save.folder, x.save.folderId, x.save.rule, x.save.readers] : null,
    sources: x.sources.map((y) => `${scopeKey(y)}:${'rule' in y ? y.rule ?? '' : ''}`).sort(),
    sends: x.sends.map((y) => `${y.connectionId}:${y.version}:${y.pins.join('\u0001')}`).sort(),
  }
}

/** What the AI is told the task may do (the answer of schedule_create), in English. */
function scopeNote(db: Database, userId: string, save: SaveFolder | null, sources: readonly ScopeSource[], sends: readonly CardSend[], made = false): string {
  const parts: string[] = []
  if (save) {
    const from = sources.map((x) => sourceForAi(db, x, userId))
    parts.push(` Save folder: ${save.folder}${made ? ' (a new folder, made now)' : ''}. Its runs may save NEW files there and in its sub-folders without asking (at most 20 per run; never change existing files); content from ${from.length ? from.join(', ') : 'nothing that fewer people can see'} may go there.`)
  } else {
    // the AI told a person their reports save in a team folder the tool had refused (AI scenario check SCH-02)
    parts.push(` No save folder was set: its runs save files in the user's own folder, and in a team folder only where that needs no confirmation card. Tell the user that, never another save place.`)
    if (sources.length) parts.push(` Its runs may read ${sources.length === 1 ? 'that room' : 'those rooms'} and still send to the connections the card allowed.`)
  }
  if (sends.length) parts.push(` It may send to ${sends.map((x) => `${x.name} only at ${x.pins.map((p) => `'${p}'`).join(', ')}`).join('; ')}.`)
  return parts.join('')
}

/**
 * A task the person asked for in their own words is made without its card (docs/decisions/20261123-do-then-undo.md,
 * replacing the registry's "keep as is"; ChatGPT's Tasks do the same): the step then says it was made, with Pause and
 * Delete. Only when nothing about it reaches anyone the person did not see or name: the person's own message of this
 * turn (not sent for them, quoted lines left out) says when it runs or asks for a schedule, in a turn they watch from
 * their app (not Slack, a draft or a run), after no room read; the task sends nowhere (no connection it may send to,
 * no pinned recipient, no save folder or places for one); every address in it is one the person typed in this chat and
 * none has a random-looking part or a long query; and no guest sees the shared chat it runs in. Anything else: the card
 * (a task that sends to others with nobody watching stays on the floor).
 */
/** Words of a task that send, post or share (then it keeps its card) */
const SENDS_IN_TASK = /\b(send|post|share|e-?mail|mail|message|notify|forward|invite|publish|upload|tweet|slack|kirim|enviar|compartir)\b|\uBCF4\uB0B4|\uC62C\uB824|\uACF5\uC720|\uC804\uB2EC|\uAC8C\uC2DC|\u9001|\u5171\u6709|\u53D1|\u5206\u4EAB/iu
const REPEAT_WORDS = new RegExp(['\uB9E4\uC77C', '\uB9E4\uC8FC', '\uB9E4\uB2EC', '\uB9E4\uC6D4', '\uB9E4\uB144', '\uD3C9\uC77C', '\uB9C8\uB2E4', '\u6BCE\u65E5', '\u6BCE\u9031', '\u6BCE\u6708', '\u6BCE\u671D', '\u5B9A\u671F', '\u6BCF\u5929', '\u6BCF\u5468', '\u6BCF\u6708', '\u5B9A\u65F6', '\\b(every|daily|weekly|monthly|hourly|weekdays|setiap|cada|todos los)\\b'].join('|'), 'iu')
const ONCE_WORDS = new RegExp(['\uB0B4\uC77C', '\uBAA8\uB808', '\u660E\u65E5', '\u660E\u5929', '\\b(tomorrow|besok|ma\u00F1ana)\\b'].join('|'), 'iu')
const TIME_CUE = new RegExp(['\\d', '\uC544\uCE68', '\uC800\uB141', '\uC624\uC804', '\uC624\uD6C4', '\uC810\uC2EC', '\u671D', '\u591C', '\u65E9\u4E0A', '\u665A\u4E0A', '\\b(morning|evening|noon|night|pagi|sore|malam|tarde|noche)\\b'].join('|'), 'iu')

export function askedInOwnWords(ctx: AppContext, turnId: string | null | undefined, userId: string, person: TurnPerson, task: { prompt: string; title: string }, o: { sends: boolean; urls: readonly string[]; longQuery: number; sharedChat: ChatRow | null }): boolean {
  if (!turnId || person.unattended || !person.allSitesHere?.() || person.roomsSeen) return false
  // only in the person's own chat (a shared chat's runs post there, for its people), never for a task that says to send
  if (o.sends || o.longQuery || o.sharedChat || SENDS_IN_TASK.test(`${task.title}\n${task.prompt}`)) return false
  const m = ctx.db.query('SELECT m.content, m.auto_sent, t.chat_id FROM turns t JOIN messages m ON m.id = t.user_message_id WHERE t.id = ?').get(turnId) as { content: string | null; auto_sent: number | null; chat_id: string } | null
  const said = ownWords(m?.content ?? '')
  // (a repeat word, or "tomorrow" with a time: a bare "tomorrow" in a message is no schedule)
  if (!m || m.auto_sent || !asksFor(SCHEDULE_ASK, said) || !(REPEAT_WORDS.test(said) || (ONCE_WORDS.test(said) && TIME_CUE.test(said)))) return false
  if (opaqueParts(`${task.title}\n${task.prompt}`).length) return false
  if (o.urls.length) {
    const typed = typedUrls(ctx.db, m.chat_id, userId)
    if (!o.urls.every((u) => typed.has(u))) return false
  }
  if (o.sharedChat) {
    try { if (new Audiences(ctx.db, ctx.files).ofChat(o.sharedChat).some((id) => isGuestUser(ctx.db, id))) return false } catch { return false }
  }
  return true
}

export function registerScheduleTools(ctx: AppContext, reg: ToolRegistry) {
  const rt = getChatRuntime(ctx)
  const local = (iso: string | null) => {
    if (!iso) return 'not scheduled'
    const p = zonedParts(new Date(iso), rt.timeZone)
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')} (${rt.timeZone})`
  }
  const line = (s: ScheduleRow) => `- ${s.id}: "${s.title}", ${describeSchedule(s)}${s.enabled ? `, next ${local(s.next_run_at)}` : needsReview(s) ? ', paused until the user confirms it again on the Scheduled page (it was made without its card)' : ', off'}${s.last_run_at ? `, last ran ${local(s.last_run_at)}` : ''}\n  prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 200)}`

  reg.register({
    name: 'schedule_create',
    description: 'Create a scheduled task for the user: the server sends `prompt` for them on the schedule, each run in a new chat with their access (they see it in their chat list); a task made in a shared chat runs in that chat instead, as the user, and reads its messages like any turn there. ' +
      'Use it when the user asks for something recurring or later ("every Monday at 9…", "tomorrow at 8…"). The user confirms it first on a card that shows the title, the schedule and the whole prompt; then confirm the schedule back in plain words. ' +
      'Runs are unattended (no questions, nothing that needs a confirmation), so write the prompt to work on its own. Only web addresses written in the prompt (shown on the card) open in a run without asking. ' +
      'A run sends or changes something at a connected service only when the task names that connection (in `connections`, or its name in the title or prompt) and the user allows it on the card; name one only when runs need to send there.',
    input: CreateInput,
    describe: (a) => `schedule_create ${a.repeat} ${a.repeat === 'cron' ? a.cron ?? '' : a.time ?? ''}`,
    async run(input, t) {
      const info = turnInfo(ctx, t)
      if (info.scheduled) throw new ToolError('a scheduled run cannot create scheduled tasks')
      // made in a shared chat: its runs post there, as this person (Schedules.start), for everyone who sees it then
      const shared = info.sharedChat ? ctx.db.query('SELECT * FROM chats WHERE id = ?').get(info.sharedChat) as ChatRow | null : null
      // the person's stored connection keys are hidden in the title and the prompt the AI wrote, before the card shows
      // them and before they are saved, as in the answer and the steps (redact.ts; QA TC-2981). A run uses the stored
      // connection, never a key written in its prompt.
      const hide = redactorFor(ctx, t.user.id).hide
      const { every_minutes: everyMinutes, ...rest } = input
      const a = { ...rest, title: hide(input.title), prompt: hide(input.prompt) }
      const parsed = ScheduleInput.safeParse({ ...a, ...(everyMinutes !== undefined ? { everyMinutes } : {}), projectId: info.projectId ?? undefined })
      if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      // what would be refused anyway is refused before the person is asked
      rt.schedules.check(t.user.id, parsed.data)
      const writable = writableConnections(ctx, t.user.id)
      // a connection a run could never send to is refused before the person is asked, so the AI can say so; a name that is
      // the person's own connection needs its recipients (send_to), pinned on the card (Q2 a)
      const listed = listedConnections(writable, a.connections ?? [])
      const scope = createScope(ctx, t.user.id, a, listed.unknown, writable)
      if (scope.unknown.length) {
        const them = scope.unknown.map(said).join(', ')
        const can = writable.length ? `: ${writable.slice(0, 20).map((r) => r.name).join(', ')}${writable.length > 20 ? ` and ${writable.length - 20} more` : ''}` : ', and this user has none'
        throw new ToolError(`a scheduled run sends only to the user's team connections set to send without asking${can}, and to the user's own connections at the recipients given in send_to. ${them} ${scope.unknown.length === 1 ? 'is' : 'are'} not one of them, so nothing was created. If the task needs one of those, use its exact name; otherwise leave it out and tell the user that runs cannot send there (they can do that in a chat).`)
      }
      const person = t.person
      if (!person) throw new ToolError('a scheduled task runs with nobody watching, so the user confirms it on a card first; nobody can confirm it here, so it was not created. Ask the user to create it in a chat.')
      const L = person.locale
      // only the connections the task names are offered (never every "allow" one the person can use)
      const offered = taskConnections(writable, parsed.data, listed.ids)
      // the card says what a run can open on this server (right after a start, once the exit address check has had a moment)
      await egressSettled(ctx)
      // (while it does not know its exit address, a run still opens the plain addresses the card lists: url-gate.ts gateUrl,
      // docs/decisions/20261123-do-then-undo.md; only a marked one would wait for a person)
      const urlsOpen = egressOf(ctx).known || extractUrls(parsed.data.prompt).every(plainUrl)
      const timing = inputTiming(parsed.data, new Date(), rt.timeZone)
      const card = scheduleCard({ ...parsed.data, ...timing }, offered.map((r) => r.name), L, 'create', { urlsOpen, scope: cardScope(ctx.db, t.user.id, L, scope.save, scope.sources, scope.sends),
        ...(shared ? { sharedWith: new Audiences(ctx.db, ctx.files).ofChat(shared).length } : {}) })
      const options = scheduleOptions(L, offered.length > 0 || scope.sends.length > 0)
      // the person's own words asked for it and it sends nowhere: made without the card, undone from its step
      const quiet = askedInOwnWords(ctx, t.turnId, t.user.id, person, parsed.data, { sends: offered.length > 0 || scope.sends.length > 0 || !!scope.save || scope.sources.length > 0, urls: card.urls, longQuery: card.longQuery.length, sharedChat: shared })
      const answer = quiet ? 'create' : person.choose
        ? await person.choose(card.question, options, card.extra)
        : (await person.confirm(card.question, TEXT.create[L], TEXT.deny[L], card.extra)) ? 'create' : null
      if (answer !== 'create' && answer !== 'create_write') throw new ToolError('the user did not allow this scheduled task, so it was not created. Do not try again unless the user asks; tell the user it was not created.')
      // the card may have waited: its save folder must still be the one it showed (the same folder on disk, the same rules)
      let save = scope.save
      if (scope.save && !scope.save.create) {
        let now: SaveFolder | null = null
        try { now = resolveSaveFolder(ctx, t.user.id, scope.save.folder) } catch { now = null }
        if (!now || now.folderId !== scope.save.folderId || now.rule !== scope.save.rule) throw saveFolderChanged(scope.save.folder)
      }
      // and the own connections it pinned are still the person's, as the card showed them
      if (answer === 'create_write' && scope.sends.length) {
        const now = ownConnections(ctx, t.user.id)
        const gone = scope.sends.filter((x) => !now.some((r) => r.id === x.connectionId && r.version === x.version))
        if (gone.length) throw new ToolError(`${gone.map((x) => x.name).join(', ')} changed while the card was open, so nothing was created. Tell the user; ask again to show the card as it is now.`)
      }
      // a new save folder the card showed is made now, on the yes, as the person; then kept as an existing one is, and
      // recorded once the task is stored (taken away again when it is not)
      const made = scope.save?.create ? makeSaveFolder(ctx, t.user, scope.save, t.turnId) : null
      if (made) save = made.save
      const sends = answer === 'create_write' ? offered : []
      const own = answer === 'create_write' ? scope.sends : []
      let s: ScheduleRow
      try {
        s = rt.schedules.create(t.user.id, parsed.data, new Date(), { allowedUrls: card.urls, writeConnections: sends.map((r) => r.id), save, sources: scope.sources, personalSends: own.map((x) => ({ connectionId: x.connectionId, pins: x.pins })) }, { chatId: shared?.id ?? null })
      } catch (e) { made?.drop(); throw e }
      made?.record()
      // made without its card: its runs send, post and share nothing (schedules.quiet, chat/explicit-send.ts quietRun)
      if (quiet) {
        try { ctx.db.query('UPDATE schedules SET quiet = 1 WHERE id = ?').run(s.id) } catch (e) {
          // not marked: the task goes again, so no unmarked task made without its card is left to run
          rt.schedules.delete(t.user.id, s.id)
          throw new ToolError(`the scheduled task could not be saved (${e instanceof Error ? e.message : 'error'}), so it was not created. Tell the user to try again.`)
        }
      }
      const blocked = !urlsOpen && card.urls.length > card.longQuery.length ? ' This server does not know its own public internet address yet, so its runs cannot open the web addresses in the prompt until it does (the card said so); tell the user.' : ''
      const longQuery = card.longQuery.length ? ` Its runs never open ${card.longQuery.length === 1 ? 'the address' : `the ${card.longQuery.length} addresses`} with a query over ${MAX_UNCONFIRMED_QUERY} characters: such an address always needs a person to confirm it (the card said so); tell the user.` : ''
      const sendNote = sends.length ? ` Its runs may send to ${sends.map((r) => r.name).join(', ')} without asking.` : offered.length || scope.sends.length ? ' The user chose that its runs never send to connected services; tell the user if the task needs that.' : ''
      const scopeText = scopeNote(ctx.db, t.user.id, save, scope.sources, own, !!scope.save?.create)
      const here = shared ? ' Its runs are turns in this shared chat, as this user: they read this chat\'s messages, post their results here, and skip places some people here cannot open.' : ''
      const quietNote = quiet ? ' It was made without a confirmation card because the user asked for it in their own words; the step under your answer shows it with Pause and Delete buttons. Say in one short sentence that it is made, when it first runs, and that they can pause or delete it there.' : ''
      return { text: `Scheduled "${s.title}": ${describeSchedule(s)}. First run: ${local(s.next_run_at)}. Id ${s.id}. The user can turn it off on the Scheduled page.${quietNote}${here}${blocked}${longQuery}${sendNote}${scopeText}`, summary: `schedule_create ${s.id} ${timingOf(s).repeat} ${s.time}${shared ? ' in a shared chat' : ''} (${quiet ? 'asked in the user\'s own words, no card' : 'confirmed by the user'}${sends.length ? `, may send to ${sends.length} connections` : ''}${scope.save ? ', save folder' : ''}${own.length ? `, ${own.length} pinned own connections` : ''})`, structured: { id: s.id, nextRunAt: s.next_run_at }, stepScheduled: { id: s.id, title: s.title, nextRunAt: s.next_run_at, ...(quiet ? { quiet: true as const } : {}) } }
    },
  })
  reg.register({
    name: 'schedule_list',
    description: 'List the user\'s scheduled tasks (id, schedule, next run, prompt). In a shared chat: only the tasks made in this chat.',
    input: z.object({}),
    run(_a, t) {
      const here = turnInfo(ctx, t).sharedChat
      const all = rt.schedules.list(t.user.id).filter(visibleIn(here))
      return { text: all.length ? all.map(line).join('\n') : here ? 'No scheduled task of the user posts in this shared chat (their other tasks are listed only in a chat only they see).' : 'The user has no scheduled tasks.', summary: `schedule_list -> ${all.length}${here ? ' (this shared chat)' : ''}` }
    },
  })
  reg.register({
    name: 'schedule_delete',
    description: 'Delete one of the user\'s scheduled tasks by id (from schedule_list). Ask first unless the user clearly asked to delete it.',
    input: z.object({ id: z.string().min(1).max(64) }),
    describe: (a) => `schedule_delete ${a.id}`,
    run(a, t) {
      const info = turnInfo(ctx, t)
      // a run deletes no task (a task that removes itself or another one; security review of #1353, L2)
      if (info.scheduled) throw new ToolError('a scheduled run cannot delete scheduled tasks; the user deletes them on the Scheduled page or in a chat')
      const here = info.sharedChat
      const s = rt.schedules.get(t.user.id, a.id)
      // in a shared chat only a task made there (the same answer as for one that is not there)
      if (!s || !visibleIn(here)(s) || !rt.schedules.delete(t.user.id, a.id)) throw new ToolError(`no scheduled task ${a.id} of this user${here ? ' made in this shared chat (other tasks are deleted on the Scheduled page or in a chat only they see)' : ''}`)
      return { text: `Deleted scheduled task ${a.id}.`, summary: `schedule_delete ${a.id}` }
    },
  })
}
