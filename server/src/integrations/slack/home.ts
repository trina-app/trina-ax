// The app's Home tab in Slack (docs/SLACK.md "The Home tab"): what the app does, how to ask, whether this Slack
// account is linked, where to get help, and that AI answers can be wrong. Slack's Marketplace guidelines: support
// information on the Home tab, help reachable in the app, the AI-accuracy note. Published with `views.publish` (bot
// token, no extra scope) when a person opens the tab (`app_home_opened`, tab `home`). Static words plus the person's
// link state: no Slack message, no file, nothing of another person. Every value from Slack or the team is plain text.
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { plain } from './text'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

export const HOME_TEXT = {
  title: t('{product}에 오신 걸 환영해요', 'Welcome to {product}', 'Selamat datang di {product}', "{product}へようこそ", "Le damos la bienvenida a {product}", "欢迎使用{product}"),
  what: t('팀의 {product} AI에게 Slack에서 물어볼 수 있어요. 질문은 묻는 사람의 계정과 권한으로 답하고, 전체 답은 {product}의 내 대화에도 남아요.', 'Ask your team\'s {product} AI from Slack. Each question is answered as you, with your own permissions, and the full answer is also in your chat in {product}.', 'Tanyakan AI {product} tim Anda dari Slack. Setiap pertanyaan dijawab sebagai Anda, dengan izin Anda sendiri, dan jawaban lengkapnya juga ada di obrolan Anda di {product}.', "チームの{product} AIにSlackから質問できます。質問はあなたのアカウントと権限で回答され、回答の全文は{product}のあなたのチャットにも残ります。", "Pregunte a la IA de {product} de su equipo desde Slack. Cada pregunta se responde como usted, con sus propios permisos, y la respuesta completa también queda en su chat de {product}.", "在 Slack 里向团队的{product} AI 提问。每个问题都以你的身份、按你自己的权限回答，完整回答也会保存在你在{product}中的聊天里。"),
  howTitle: t('물어보는 방법', 'How to ask', 'Cara bertanya', "質問のしかた", "Cómo preguntar", "如何提问"),
  how: t('• 이 앱의 메시지 탭에서 바로 물어보세요.\n• 채널에서는 `@{bot}`을 붙여 물어보세요. 앱을 먼저 채널에 초대해야 해요: `/invite @{bot}`\n• 채널의 답은 나에게만 보이고, *채널에 올리기*로 스레드에 공유할 수 있어요.\n• 같은 스레드에서 이어서 물으면 같은 대화로 이어져요.', '• Ask in this app\'s Messages tab.\n• In a channel, mention `@{bot}` with your question. Invite the app to the channel first: `/invite @{bot}`\n• In a channel the answer is shown to you only; *Post to channel* shares it in the thread.\n• Ask again in the same thread to continue the same chat.', '• Tanyakan di tab Pesan aplikasi ini.\n• Di kanal, sebut `@{bot}` bersama pertanyaan Anda. Undang aplikasi ke kanal dulu: `/invite @{bot}`\n• Di kanal, jawaban hanya terlihat oleh Anda; *Kirim ke kanal* membagikannya di utas.\n• Tanyakan lagi di utas yang sama untuk melanjutkan obrolan yang sama.', "• このアプリの「メッセージ」タブで質問できます。\n• チャンネルでは `@{bot}` を付けて質問してください。先にアプリをチャンネルに招待します：`/invite @{bot}`\n• チャンネルでの回答はあなたにだけ表示されます。*チャンネルに投稿* でスレッドに共有できます。\n• 同じスレッドで続けて質問すると、同じチャットの続きになります。", "• Pregunte en la pestaña Mensajes de esta aplicación.\n• En un canal, mencione `@{bot}` con su pregunta. Primero invite la aplicación al canal: `/invite @{bot}`\n• En un canal la respuesta solo la ve usted; *Publicar en el canal* la comparte en el hilo.\n• Pregunte de nuevo en el mismo hilo para seguir el mismo chat.", "• 在这个应用的“消息”标签页里直接提问。\n• 在频道里，提问时提及 `@{bot}`。请先把应用邀请到频道：`/invite @{bot}`\n• 在频道里，回答只有你能看到；用 *发布到频道* 可以把它分享到话题中。\n• 在同一个话题里继续提问，会接着同一个聊天。"),
  linkedTitle: t('내 계정', 'Your account', 'Akun Anda', "あなたのアカウント", "Su cuenta", "你的账号"),
  linked: t('이 Slack 계정은 {product} 계정 *{name}*과(와) 연결돼 있어요. 연결은 {product}의 설정 › 커넥터에서 끊을 수 있어요.', 'This Slack account is linked to the {product} account *{name}*. You can unlink it in Settings › Connectors in {product}.', 'Akun Slack ini tertaut ke akun {product} *{name}*. Anda bisa memutuskannya di Pengaturan › Konektor {product}.', "このSlackアカウントは{product}アカウント *{name}* と連携しています。連携は{product}の設定 › コネクターで解除できます。", "Esta cuenta de Slack está vinculada a la cuenta de {product} *{name}*. Puede desvincularla en Configuración › Conectores de {product}.", "这个 Slack 账号已关联到{product}账号 *{name}*。你可以在{product}的“设置 › 连接器”中取消关联。"),
  unlinked: t('아직 {product} 계정과 연결하지 않았어요. 처음 물어보면 나에게만 보이는 연결 링크가 와요. {product}의 설정 › 커넥터에서 *Slack으로 로그인*으로 연결할 수도 있어요.', 'This Slack account is not linked to a {product} account yet. The first time you ask, you get a link only you can see. You can also link it in Settings › Connectors in {product} with *Sign in with Slack*.', 'Akun Slack ini belum tertaut ke akun {product}. Saat pertama bertanya, Anda mendapat tautan yang hanya bisa Anda lihat. Anda juga bisa menautkannya di Pengaturan › Konektor {product} dengan *Masuk dengan Slack*.', "このSlackアカウントはまだ{product}アカウントと連携していません。最初に質問すると、あなたにだけ見える連携リンクが届きます。{product}の設定 › コネクターで *Slackでサインイン* から連携することもできます。", "Esta cuenta de Slack todavía no está vinculada a una cuenta de {product}. La primera vez que pregunte recibirá un enlace que solo usted ve. También puede vincularla en Configuración › Conectores de {product} con *Iniciar sesión con Slack*.", "这个 Slack 账号还没有关联{product}账号。第一次提问时，你会收到一个只有你能看到的关联链接。也可以在{product}的“设置 › 连接器”中用 *使用 Slack 登录* 关联。"),
  openSettings: t('{product} 설정 열기', 'Open {product} settings', 'Buka pengaturan {product}', "{product}の設定を開く", "Abrir la configuración de {product}", "打开{product}设置"),
  readsTitle: t('읽는 것', 'What it reads', 'Yang dibaca', "読むもの", "Qué lee", "它会读取什么"),
  reads: t('물어본 스레드와, 앱이 초대된 채널 중 나도 들어가 있는 채널만 읽어요. Slack 검색은 하지 않고, 나 대신 Slack을 읽지 않아요. Slack 데이터로 AI를 학습시키지 않아요.', 'Only the thread you ask in, and channels the app was invited to that you are in too. It has no Slack search and never reads Slack as you. Slack data is never used to train AI models.', 'Hanya utas tempat Anda bertanya, dan kanal tempat aplikasi diundang yang juga Anda ikuti. Tidak ada pencarian Slack dan tidak pernah membaca Slack sebagai Anda. Data Slack tidak pernah dipakai untuk melatih model AI.', "質問したスレッドと、アプリが招待されていてあなたも参加しているチャンネルだけを読みます。Slack検索はせず、あなたとしてSlackを読むこともありません。SlackのデータをAIの学習に使うことはありません。", "Solo el hilo donde pregunta y los canales a los que se invitó a la aplicación y en los que usted también está. No busca en Slack ni lee Slack como usted. Los datos de Slack nunca se usan para entrenar modelos de IA.", "只读取你提问的话题，以及应用被邀请、你也在其中的频道。它没有 Slack 搜索，也从不以你的身份读取 Slack。Slack 数据从不用于训练 AI 模型。"),
  helpTitle: t('도움', 'Help', 'Bantuan', "ヘルプ", "Ayuda", "帮助"),
  helpOwn: t('팀의 {product} 오너나 관리자에게 물어보세요.', 'Ask your team\'s {product} owner or an admin.', 'Tanyakan pemilik atau admin {product} tim Anda.', "チームの{product}のオーナーか管理者にお問い合わせください。", "Pregunte a la persona propietaria o a un administrador de {product} de su equipo.", "请联系你团队的{product}所有者或管理员。"),
  helpOfficial: t('팀의 {product} 오너나 관리자에게 묻거나, {product} 지원팀에 연락하세요: {url}', 'Ask your team\'s {product} owner or an admin, or contact {product} support: {url}', 'Tanyakan pemilik atau admin {product} tim Anda, atau hubungi dukungan {product}: {url}', "チームの{product}のオーナーか管理者に問い合わせるか、{product}サポートにご連絡ください：{url}", "Pregunte a la persona propietaria o a un administrador de {product} de su equipo, o contacte con el soporte de {product}: {url}", "请联系你团队的{product}所有者或管理员，或联系{product}支持：{url}"),
  disclaimer: t('AI 답은 틀릴 수 있어요. 중요한 답은 직접 확인해 주세요.', 'AI answers can be wrong. Check important ones before you rely on them.', 'Jawaban AI bisa salah. Periksa jawaban penting sebelum Anda mengandalkannya.', "AIの回答は間違っていることがあります。重要な回答は、頼る前に確認してください。", "Las respuestas de la IA pueden ser incorrectas. Compruebe las importantes antes de confiar en ellas.", "AI 的回答可能有误。重要的回答请先核实再使用。"),
} as const
export type HomeKey = keyof typeof HOME_TEXT

const sayHome = (key: HomeKey, locale: Locale, params: Record<string, string> = {}) => {
  const all: Record<string, string> = { product: PRODUCT.displayName, ...params }
  return (HOME_TEXT[key][locale] ?? HOME_TEXT[key].en).replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? m)
}

/** the hosting service's public help page (the official app's support); '' when this edition has no hosted service */
export const officialSupportUrl = (): string => (SERVICE_HOSTS.accountHost ? `https://${SERVICE_HOSTS.accountHost}/help` : '')

export interface HomeInput {
  locale: Locale
  /** the bot's name as people find it in Slack (`@name`) */
  bot: string
  /** the Trina account this Slack user is linked to (its display name), or null */
  linkedAs: string | null
  /** where the team's app opens (the address links in Slack use), or null */
  origin: string | null
  official: boolean
}

/** The Home tab's view (Slack's `home` view, Block Kit). Names are plain text; only our own words carry mrkdwn. */
export function homeView(o: HomeInput): { type: 'home'; blocks: unknown[] } {
  const L = o.locale
  const bot = plain(o.bot).replace(/[`*_~]/g, '')
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } })
  const head = (text: string) => ({ type: 'header', text: { type: 'plain_text', text: text.slice(0, 150) } })
  const account = o.linkedAs
    ? sayHome('linked', L, { name: plain(o.linkedAs).replace(/[`*_~]/g, '') })
    : sayHome('unlinked', L)
  const url = officialSupportUrl()
  const help = o.official && url ? sayHome('helpOfficial', L, { url: `<${url}|${url.replace(/^https:\/\//, '')}>` }) : sayHome('helpOwn', L)
  const blocks: unknown[] = [
    head(sayHome('title', L)),
    section(sayHome('what', L)),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `:warning: ${sayHome('disclaimer', L)}` }] },
    { type: 'divider' },
    head(sayHome('howTitle', L)),
    section(sayHome('how', L, { bot })),
    head(sayHome('linkedTitle', L)),
    section(account),
    ...(o.origin ? [{ type: 'actions', elements: [{ type: 'button', action_id: 'home_settings', text: { type: 'plain_text', text: sayHome('openSettings', L).slice(0, 75) }, url: `${o.origin}/settings/connectors` }] }] : []),
    head(sayHome('readsTitle', L)),
    section(sayHome('reads', L)),
    { type: 'divider' },
    head(sayHome('helpTitle', L)),
    section(help),
  ]
  return { type: 'home', blocks }
}
