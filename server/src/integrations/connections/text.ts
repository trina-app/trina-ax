// Words people see for external-service connections (docs/INTEGRATIONS.md): the server's confirmation card, API
// refusals and why a connection check failed (lastError, stored as a code and put into words for each reader).
import { BATCH_REFUSED, type Locale } from '@mycel/shared/api'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'
import { KO_PARTICLE_PATTERN, koParticle } from '@mycel/shared/ko-particle'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

export const TEXT = {
  // the card before a call that changes something at the service: {what} is the tool's title (MCP `title`, else its id
  // in words) or, for an HTTP API, what the method does (methodPost …); card-lines.ts
  confirm: t('AI가 {name}에 이 내용을 보내려고 해요: {what}', 'The AI wants to send this to {name}: {what}', 'AI ingin mengirim ini ke {name}: {what}', "AIが{name}に次の内容を送ろうとしています：{what}", "La IA quiere enviar esto a {name}: {what}", "AI 想把这个发送到{name}：{what}"),
  // a demo server's card for a connection its fakes answer (server/src/demo/fakes: Gmail, Higgsfield): first, so the
  // visitor knows nothing leaves (tools.ts gate)
  practiceLead: t('연습용 연결이에요. 실제로는 아무것도 나가지 않아요.', 'This is a practice connection: nothing really goes out.', 'Ini koneksi latihan: tidak ada yang benar-benar dikirim.', "これは練習用の接続です。実際には何も送信されません。", "Esta es una conexión de práctica: en realidad no se envía nada.", "这是练习用的连接：实际上不会发送任何内容。"),
  // an HTTP API call: {what} is what its method does (methodDELETE …), so the sentence names a request, not "this"
  confirmRequest: t('AI가 {name}에 이 요청을 보내려고 해요: {what}', 'The AI wants to send this request to {name}: {what}', 'AI ingin mengirim permintaan ini ke {name}: {what}', "AIが{name}に次のリクエストを送ろうとしています：{what}", "La IA quiere enviar esta solicitud a {name}: {what}", "AI 想向{name}发送这个请求：{what}"),
  // the read card in a shared chat: a tool the service marks read-only whose name holds a change word as a noun
  // (read-mark.ts 'unsure', docs/decisions/20261122-connector-always-allow.md): what happens, in plain words. A call that
  // names one web address says the page ({page}: its host and path, short); else the tool's title ({what})
  unsureReadPage: t('{name}에서 이 페이지를 읽어 와요 · {page}', 'Read this page with {name} · {page}', 'Membaca halaman ini dengan {name} · {page}', "{name}でこのページを読みます · {page}", "Leer esta página con {name} · {page}", "用{name}读取此页面 · {page}"),
  unsureRead: t('{name}에서 읽어 와요: {what}', 'Read from {name}: {what}', 'Membaca dari {name}: {what}', "{name}から読み取ります：{what}", "Leer de {name}: {what}", "从{name}读取：{what}"),
  unsureOnce: t('허용', 'Allow', 'Izinkan', "許可", "Permitir", "允许"),
  unsureAlways: t('항상 허용', 'Always allow', 'Selalu izinkan', "常に許可", "Permitir siempre", "始终允许"),
  unsureNo: t('안 함', 'Don’t allow', 'Jangan izinkan', "許可しない", "No permitir", "不允许"),
  // the line under the read card's buttons: what Always allow covers (this tool, every chat) and where it is undone
  unsureAlwaysNote: t('항상 허용: 앞으로 모든 대화에서 {name}의 “{what}” 도구는 묻지 않고 써요. 설정에서 지울 수 있어요.', 'Always allow: from now on, in every chat, the AI uses {name}\'s {what} without asking. You can remove it in Settings.', 'Selalu izinkan: mulai sekarang, di semua obrolan, AI memakai {what} dari {name} tanpa bertanya. Anda bisa menghapusnya di Pengaturan.', "常に許可：今後はどのチャットでも、AIは確認なしで{name}の{what}を使います。設定で削除できます。", "Permitir siempre: a partir de ahora, en todos los chats, la IA usa {what} de {name} sin preguntar. Puede quitarlo en Configuración.", "始终允许：从现在起，在所有对话中，AI 都会直接使用{name}的{what}，不再询问。你可以在设置中移除。"),
  // "<connector> 전체 항상 허용" (tools.ts cardWithAlways, docs/decisions/20261123-one-always-allow.md): every tool of
  // the connection, for good, in every chat and the person's scheduled runs; and the line added to the note for it
  unsureAlwaysAll: t('{name} 전체 항상 허용', 'Always allow all of {name}', 'Selalu izinkan semua {name}', "{name}をすべて常に許可", "Permitir siempre todo {name}", "始终允许{name}的全部工具"),
  allAlwaysNote: t('{name} 전체 항상 허용: {name}의 모든 도구를 묻지 않고 쓰고, 가져온 내용은 공유 채팅에서도 함께 보여 줘요.', 'Always allow all of {name}: every {name} tool runs without asking, and what it returns shows in shared chats too.', 'Selalu izinkan semua {name}: semua alat {name} dipakai tanpa bertanya, dan hasilnya juga terlihat di obrolan bersama.', "{name}をすべて常に許可：{name}のすべてのツールを確認なしで使い、取得した内容は共有チャットにも表示します。", "Permitir siempre todo {name}: todas las herramientas de {name} se usan sin preguntar, y lo que devuelve también se muestra en los chats compartidos.", "始终允许{name}的全部工具：{name}的所有工具都不再询问，获取的内容也会在共享对话中显示。"),
  // the line under a shared chat's card for a call that acts on the person's own things (tools.ts cardWithAlways)
  actsAlwaysNote: t('항상 허용: 앞으로 모든 대화에서 {name}의 “{what}” 작업은 묻지 않고 해요. 설정에서 지울 수 있어요.', 'Always allow: from now on, in every chat, the AI does {what} in {name} without asking. You can remove it in Settings.', 'Selalu izinkan: mulai sekarang, di semua obrolan, AI melakukan {what} di {name} tanpa bertanya. Anda bisa menghapusnya di Pengaturan.', "常に許可：今後はどのチャットでも、AIは確認なしで{name}の{what}を行います。設定で削除できます。", "Permitir siempre: a partir de ahora, en todos los chats, la IA hace {what} en {name} sin preguntar. Puede quitarlo en Configuración.", "始终允许：从现在起，在所有对话中，AI 会直接在{name}中执行{what}，不再询问。你可以在设置中移除。"),
  // a call that acts on the person's own things (tools.ts gate, Sent.ownAct): what happens in one plain sentence, from the
  // tool's title ({what}); code an app on the computer runs: a generic line, with the AI's own words for it said as the
  // AI's ({title}: the call carries it, so it is never stated as fact; code review)
  actTitled: t('{name}에서 작업을 실행해요 · AI 설명: {title}', 'Run a task in {name} · the AI calls it: {title}', 'Menjalankan tugas di {name} · kata AI: {title}', "{name}で作業を実行します · AIの説明：{title}", "Ejecutar una tarea en {name} · la IA lo llama: {title}", "在{name}中运行任务 · AI 的说明：{title}"),
  actTool: t('{name}에서 “{what}” 작업을 해요', '{what} in {name}', '{what} di {name}', "{name}で{what}をします", "{what} en {name}", "在{name}中{what}"),
  // a shared chat's change card on a team connection (tools.ts gate): why it has no Always allow, in plain words (a team
  // account is everyone's, so a change there is asked each time in a chat other people write in; AB4 F3)
  teamEachTime: t('팀이 함께 쓰는 연결이라, 공유 대화에서는 바꿀 때마다 물어봐요.', 'This connection is shared by the team, so in a shared chat the AI asks before every change.', 'Koneksi ini dipakai bersama oleh tim, jadi di obrolan bersama AI bertanya sebelum setiap perubahan.', "チームで共有している接続なので、共有の会話では変更のたびに確認します。", "Esta conexión la comparte el equipo, así que en un chat compartido la IA pregunta antes de cada cambio.", "这是团队共用的连接，所以在共享对话中，每次更改前 AI 都会询问。"),
  // a long value (code, a page) on a team connection's change card: its length; the whole text is one click away
  longValue: t('(긴 내용 {n}자 · 아래 “보내는 내용 그대로 보기”에서 볼 수 있어요)', '(long, {n} characters · see it in full below)', '(panjang, {n} karakter · lihat lengkapnya di bawah)', "（長い内容 {n}文字 · 下で全体を見られます）", "(largo, {n} caracteres · véalo completo abajo)", "（较长，{n}个字符 · 可在下方查看全部）"),
  runCode: t('{name}에서 작업을 실행해요', 'Run a task in {name}', 'Menjalankan tugas di {name}', "{name}で作業を実行します", "Ejecutar una tarea en {name}", "在{name}中运行任务"),
  nothing: t('(보낼 내용 없음)', '(nothing)', '(tidak ada)', "（なし）", "(nada)", "（无）"),
  // a value on the card's lines (card-lines.ts): an empty text, yes / no, nothing
  valueEmpty: t('(비어 있음)', '(empty)', '(kosong)', "（空）", "(vacío)", "（空）"),
  valueYes: t('예', 'Yes', 'Ya', "はい", "Sí", "是"),
  valueNo: t('아니요', 'No', 'Tidak', "いいえ", "No", "否"),
  valueNone: t('(없음)', '(none)', '(tidak ada)', "（なし）", "(ninguno)", "（无）"),
  // an HTTP API call on the card and in its step: the address it calls, and what its method does
  fieldAddress: t('보내는 곳', 'Sends to', 'Dikirim ke', "送信先", "Se envía a", "发送到"),
  methodGET: t('가져오기', 'Get', 'Ambil', "取得", "Obtener", "获取"),
  methodHEAD: t('확인하기', 'Check', 'Periksa', "確認", "Comprobar", "检查"),
  methodPOST: t('보내기', 'Send', 'Kirim', "送信", "Enviar", "发送"),
  methodPUT: t('바꾸기', 'Replace', 'Ganti', "置き換え", "Reemplazar", "替换"),
  methodPATCH: t('고치기', 'Update', 'Perbarui', "更新", "Actualizar", "更新"),
  methodDELETE: t('지우기', 'Delete', 'Hapus', "削除", "Eliminar", "删除"),
  // the room card after a room read (TurnTool.card): what an HTTP API call does at the service, by its name (QA TC-233)
  cardRead: t('{name}에서 읽어 오기', 'Read from {name}', 'Membaca dari {name}', "{name}から読み取る", "Leer de {name}", "从{name}读取"),
  cardChange: t('{name}에서 무언가 바꾸기', 'Change something in {name}', 'Mengubah sesuatu di {name}', "{name}で何かを変更する", "Cambiar algo en {name}", "在{name}中做更改"),
  ask: t('보낼까요?', 'Send it?', 'Kirim?', "送信しますか？", "¿Enviarlo?", "要发送吗？"),
  checkBelow: t('보낼 내용 전체와 받는 곳을 아래에서 확인해 주세요.', 'Check everything it sends, and where it goes, below.', 'Periksa semua yang dikirim, dan tujuannya, di bawah.', "送信内容全体と送信先を下で確認してください。", "Revise abajo todo lo que envía y a dónde va.", "请在下方查看要发送的全部内容和发送到哪里。"),
  // the card's first line for a team file the call attaches (team-attach.ts): its name, size and place follow
  attachedFile: t('첨부할 팀 파일', 'Team file to attach', 'File tim yang dilampirkan', "添付するチームのファイル", "Archivo del equipo que se adjunta", "要附加的团队文件"),
  sendsLabel: t('보낼 내용', 'What it sends', 'Yang dikirim', "送信内容", "Lo que envía", "发送的内容"),
  // the room card's request for a read (TurnTool.card): it sends nothing of the person's, it reads (QA TC-285)
  readsLabel: t('읽어 올 내용', 'What it reads', 'Yang dibaca', "読み取る内容", "Lo que lee", "读取的内容"),
  yes: t('보내기', 'Send', 'Kirim', "送信", "Enviar", "发送"),
  no: t('보내지 않기', 'Don’t send', 'Jangan kirim', "送信しない", "No enviar", "不发送"),
  // the card's three answers (TC-130): this once, from now on (the person's own choice for this connection), no
  once: t('이번만 보내기', 'Send once', 'Kirim sekali ini', "今回だけ送信", "Enviar esta vez", "发送一次"),
  alwaysAllow: t('항상 허용', 'Always allow', 'Selalu izinkan', "常に許可", "Permitir siempre", "始终允许"),
  // the line under the three buttons: what Always allow covers, and where it is turned off
  alwaysNote: t('항상 허용: 이 내용만이 아니라 {name}의 모든 변경(보내기, 고치기, 지우기)을 앞으로 모든 대화에서 AI가 묻지 않고 해요. 웹페이지나 파일을 읽은 대화에서도 다시 묻지 않아요. 설정 › 커넥터에서 끌 수 있어요.',
    "Always allow every change in {name}, not only this one: from now on, in every chat, Trina sends, edits and deletes in {name} without asking, even after reading web pages or files. You can turn it off in Settings › Connectors.",
    'Selalu izinkan setiap perubahan di {name}, bukan hanya yang ini: mulai sekarang, di semua obrolan, Trina mengirim, mengubah, dan menghapus di {name} tanpa bertanya, bahkan setelah membaca halaman web atau file. Anda bisa mematikannya di Pengaturan › Konektor.',
    "{name}のすべての変更を常に許可（この1件だけではありません）：今後はどのチャットでも、Webページやファイルを読んだ後でも、トリナは確認なしで{name}への送信・編集・削除を行います。設定 › コネクターでオフにできます。",
    "Permitir siempre cada cambio en {name}, no solo este: a partir de ahora, en todos los chats, Trina envía, edita y elimina en {name} sin preguntar, incluso tras leer páginas web o archivos. Puede desactivarlo en Configuración › Conectores.", "始终允许{name}中的所有更改，不只是这一次：从现在起，在所有对话中，即使读过网页或文件，Trina 也会直接在{name}中发送、编辑和删除，不再询问。你可以在“设置 › 连接器”中关闭。"),
  // the card's first line in a chat that read something from outside, for a connection that asks anyway: why the card
  // has no Always allow (TC-328)
  outsideAsksOnce: t('이 대화는 바깥 내용(웹 페이지, 다른 사람의 파일, 서비스의 답 등)을 읽었어요. 그래서 여기서는 바꿀 때마다 물어요.',
    'This chat has read something from outside (a web page, someone else\'s file, a service\'s answer), so here the AI asks before every change.',
    'Obrolan ini sudah membaca sesuatu dari luar (halaman web, file orang lain, jawaban layanan), jadi di sini AI bertanya sebelum setiap perubahan.',
    "このチャットは外部の内容（ウェブページ、他の人のファイル、サービスの応答など）を読みました。そのため、ここでは変更のたびに確認します。",
    "Este chat leyó algo de fuera (una página web, un archivo de otra persona, la respuesta de un servicio), así que aquí la IA pregunta antes de cada cambio.", "这个对话读过外部内容（网页、别人的文件、服务的回答），所以这里 AI 每次更改前都会先询问。"),
  // the card's first line when it asks only because the chat read something from outside (TC-328)
  outsideAsks: t('이 대화는 바깥 내용(웹 페이지, 다른 사람의 파일, 서비스의 답 등)을 읽었어요. 그래서 묻지 않고 보내기가 켜져 있어도 보내기 전에 물어요.',
    'This chat has read something from outside (a web page, someone else\'s file, a service\'s answer), so the AI asks before sending, even though sending without asking is on.',
    'Obrolan ini sudah membaca sesuatu dari luar (halaman web, file orang lain, jawaban layanan), jadi AI bertanya sebelum mengirim, walaupun kirim tanpa bertanya sedang aktif.',
    "このチャットは外部の内容（ウェブページ、他の人のファイル、サービスの応答など）を読みました。そのため、確認なしの送信がオンでも、送信前に確認します。",
    "Este chat leyó algo de fuera (una página web, un archivo de otra persona, la respuesta de un servicio), así que la IA pregunta antes de enviar, aunque enviar sin preguntar esté activado.", "这个对话读过外部内容（网页、别人的文件、服务的回答），所以即使已打开“不询问直接发送”，AI 发送前也会先询问。"),
  // API refusals
  personalOff: t('팀 설정에서 개인 연결 추가가 꺼져 있어요.', 'Your team turned off adding personal connections.', 'Tim Anda mematikan penambahan koneksi pribadi.', "チームが個人接続の追加を無効にしました。", "Su equipo desactivó la posibilidad de añadir conexiones personales.", "你的团队已关闭添加个人连接。"),
  tooMany: t('연결은 {n}개까지 만들 수 있어요.', 'You can have at most {n} connections.', 'Paling banyak {n} koneksi.', "接続は最大{n}件です。", "Puede tener como máximo {n} conexiones.", "最多只能有{n}个连接。"),
  // a person's own connections that work, at the most (service.ts MAX_PERSONAL); waiting ones do not count
  tooManyWorking: t('작동하는 내 연결은 {n}개까지 만들 수 있어요.', 'You can have at most {n} working connections of your own.', 'Paling banyak {n} koneksi pribadi yang berfungsi.', "使える個人接続は最大{n}件です。", "Puede tener como máximo {n} conexiones propias que funcionan.", "最多只能有{n}个可用的个人连接。"),
  // MAX_PERSONAL_WAITING connections wait for their first sign-in and none may make room for a new one (each was tried in
  // the last hour, or has its own app, which never goes: service.ts makeRoom). True in both cases: sign in to one or
  // remove one.
  tooManyWaiting: t('첫 로그인을 기다리는 연결이 {n}개 있어요. 더 추가하려면 그중 하나에 로그인하거나 하나를 지워 주세요.', '{n} connections are still waiting for their first sign-in. To add another, sign in to one of them or remove one.', 'Ada {n} koneksi yang masih menunggu login pertama. Untuk menambah lagi, login ke salah satunya atau hapus satu.', "最初のログインを待っている接続が{n}件あります。追加するには、どれかにログインするか1件削除してください。", "Hay {n} conexiones que aún esperan su primer inicio de sesión. Para añadir otra, inicie sesión en una de ellas o elimine una.", "有{n}个连接还在等待首次登录。要再添加，请登录其中一个或删除一个。"),
  slugTaken: t('이 짧은 이름은 이미 쓰고 있어요.', 'This short name is already in use.', 'Nama pendek ini sudah dipakai.', "この短縮名は使用されています。", "Este nombre corto ya está en uso.", "这个简称已被使用。"),
  keyNeedsKeyAuth: t('키는 API 키 방식에서만 넣을 수 있어요.', 'A key can only be set when the connection uses an API key.', 'Kunci hanya bisa diisi bila koneksi memakai kunci API.', "キーを設定できるのはAPIキーを使う接続のみです。", "Solo se puede establecer una clave cuando la conexión usa una clave de API.", "只有使用 API 密钥的连接才能设置密钥。"),
  allowTeamOnly: t('"묻지 않고 실행"은 팀 연결에서만 고를 수 있어요.', '"Run without asking" is for team connections only.', '"Jalankan tanpa bertanya" hanya untuk koneksi tim.', "「確認なしで実行」はチームの接続でのみ選べます。", "\"Ejecutar sin preguntar\" solo está disponible para conexiones del equipo.", "“不询问直接运行”仅适用于团队连接。"),
  accessTeamOnly: t('사용할 사람은 공용 연결에서만 정할 수 있어요.', 'Who may use it is set on team connections only.', 'Siapa yang boleh memakai hanya diatur pada koneksi tim.', "利用者を設定できるのはチームの接続のみです。", "Solo se puede definir quién la usa en las conexiones del equipo.", "只有团队连接可以设置谁能使用。"),
  badHeader: t('이 헤더 이름은 쓸 수 없어요.', 'This header name cannot be used.', 'Nama header ini tidak bisa dipakai.', "このヘッダー名は使用できません。", "No se puede usar este nombre de encabezado.", "不能使用这个标头名称。"),
  oauthMcpOnly: t('로그인 방식은 MCP 서버 연결에서만 쓸 수 있어요.', 'Sign-in is for MCP server connections only.', 'Login hanya untuk koneksi server MCP.', "ログインはMCPサーバー接続専用です。", "El inicio de sesión es solo para conexiones a servidores MCP.", "登录仅适用于 MCP 服务器连接。"),
  // your own app at the service (oauthClient, docs/INTEGRATIONS.md "Your own app")
  oauthHttpNeedsApp: t('API에 로그인하려면 서비스에서 만든 앱의 Client ID와 로그인 주소, 토큰 주소가 필요해요.', 'Signing in at an API needs your own app at the service: its client ID, sign-in address and token address.', 'Login di API memerlukan aplikasi Anda sendiri di layanan itu: client ID, alamat login, dan alamat token.', "APIにログインするには、サービスで作成したアプリのクライアントID、ログインアドレス、トークンアドレスが必要です。", "Para iniciar sesión en una API se necesita su propia aplicación en el servicio: su ID de cliente, su dirección de inicio de sesión y su dirección de token.", "在 API 登录需要你在该服务上有自己的应用：它的客户端 ID、登录地址和令牌地址。"),
  appNeedsOauth: t('앱(Client ID)은 로그인 방식에서만 넣을 수 있어요.', 'An app (client ID) can only be set for sign-in.', 'Aplikasi (client ID) hanya bisa diisi untuk login.', "アプリ（クライアントID）を設定できるのはログイン方式のみです。", "Una aplicación (ID de cliente) solo se puede configurar para el inicio de sesión.", "只有登录方式才能设置应用（客户端 ID）。"),
  appTokenMoved: t('서비스가 알려 준 토큰 주소({host})가 처음 로그인할 때와 달라요. 그 주소로는 Client Secret을 보내지 않아요. 맞는 주소라면 Client Secret을 다시 넣어 저장해 주세요.', 'The token address the service names ({host}) is not the one found at the first sign-in, so the client secret is not sent there. If it is right, enter the client secret again and save.', 'Alamat token yang disebut layanan ({host}) berbeda dari yang ditemukan saat login pertama, jadi client secret tidak dikirim ke sana. Bila benar, masukkan client secret lagi lalu simpan.', "サービスが示すトークンアドレス（{host}）が最初のログイン時と異なるため、クライアントシークレットは送信しません。正しい場合は、クライアントシークレットを入力し直して保存してください。", "La dirección de token que indica el servicio ({host}) no es la que se encontró en el primer inicio de sesión, así que el secreto de cliente no se envía allí. Si es correcta, introduzca el secreto de cliente de nuevo y guarde.", "服务给出的令牌地址（{host}）与第一次登录时找到的不同，所以没有把客户端密钥发送过去。如果它是正确的，请重新输入客户端密钥并保存。"),
  appTokenMovedMember: t('서비스가 알려 준 토큰 주소({host})가 처음 로그인할 때와 달라서 로그인을 멈췄어요. 관리자에게 알려 주세요.', 'The token address the service names ({host}) is not the one found at the first sign-in, so signing in stopped. Tell your admin.', 'Alamat token yang disebut layanan ({host}) berbeda dari yang ditemukan saat login pertama, jadi login dihentikan. Beri tahu admin Anda.', "サービスが示すトークンアドレス（{host}）が最初のログイン時と異なるため、ログインを停止しました。管理者に知らせてください。", "La dirección de token que indica el servicio ({host}) no es la que se encontró en el primer inicio de sesión, así que se detuvo el inicio de sesión. Avise a su administrador.", "服务给出的令牌地址（{host}）与第一次登录时找到的不同，所以登录已停止。请告诉你的管理员。"),
  appHidden: t('Client ID와 권한 범위에 보이지 않는 글자나 방향을 바꾸는 글자는 넣을 수 없어요.', 'The client ID and scopes cannot hold invisible or direction-changing characters.', 'Client ID dan cakupan tidak boleh memuat karakter tak terlihat atau pengubah arah.', "クライアントIDとスコープには、見えない文字や向きを変える文字は使えません。", "El ID de cliente y los permisos no pueden contener caracteres invisibles o que cambien la dirección.", "客户端 ID 和权限范围不能包含不可见字符或改变文字方向的字符。"),
  notOauth: t('이 연결은 로그인 방식이 아니에요.', 'This connection does not use sign-in.', 'Koneksi ini tidak memakai login.', "この接続はログインを使用しません。", "Esta conexión no usa inicio de sesión.", "这个连接不使用登录。"),
  keyLineBreak: t('키에는 줄바꿈을 넣을 수 없어요.', 'A key cannot contain line breaks.', 'Kunci tidak boleh berisi baris baru.', "キーに改行は含められません。", "Una clave no puede contener saltos de línea.", "密钥不能包含换行。"),
  unknownSubjects: t('없는 부서나 사람이에요: {list}', 'No such group or person: {list}', 'Grup atau orang tidak ada: {list}', "該当するグループまたはメンバーがいません：{list}", "No existe este grupo o persona: {list}", "没有这个小组或人员：{list}"),
  toolUnknown: t('이 서비스가 지금 알려 준 도구 목록에 없는 도구예요. "다시 확인"을 누른 뒤 다시 해 주세요.', 'The service does not list this tool now. Choose "Check again" and try again.', 'Layanan tidak mencantumkan alat ini sekarang. Pilih "Periksa lagi" lalu coba lagi.', "このサービスは現在このツールを提供していません。「再確認」を押してからもう一度お試しください。", "El servicio no ofrece esta herramienta ahora. Elija «Comprobar de nuevo» e inténtelo otra vez.", "服务现在没有列出这个工具。请选择“重新检查”后再试。"),
  toolsMcpOnly: t('도구를 하나씩 켜고 끄는 것은 MCP 서버 연결에서만 할 수 있어요.', 'Single tools can be turned on and off for MCP server connections only.', 'Alat satu per satu hanya bisa dinyalakan dan dimatikan untuk koneksi server MCP.', "ツールを個別にオン・オフできるのはMCPサーバー接続のみです。", "Solo se pueden activar y desactivar herramientas una a una en conexiones a servidores MCP.", "只有 MCP 服务器连接可以单独打开或关闭工具。"),
  // an admin's request to a member to connect a service as their own connection (requests.ts)
  requestNotice: t('관리자가 {name} 연결을 요청했어요(주소: {host}). 이 주소가 정말 {name}의 주소인지 확인한 뒤 내 키나 로그인으로 연결해 주세요.', 'An admin asked you to connect {name} at {host}. Check that {host} is really {name}\'s address before you connect it with your own key or sign-in.', 'Admin meminta Anda menghubungkan {name} di {host}. Pastikan {host} memang alamat {name} sebelum menghubungkannya dengan kunci atau login Anda sendiri.', "管理者が{name}（{host}）の接続を依頼しました。{host}が本当に{name}のアドレスか確認してから、ご自身のキーまたはログインで接続してください。", "Un administrador le pidió conectar {name} en {host}. Compruebe que {host} es de verdad la dirección de {name} antes de conectarlo con su propia clave o inicio de sesión.", "管理员请你连接位于{host}的{name}。用你自己的密钥或登录连接之前，请确认{host}确实是{name}的地址。"),
  // signing in again to a member's own connection while the team has them off (service.ts authorize, QA TC-2930)
  personalOffSignIn: t('팀에서 개인 연결을 꺼 두어서 지금은 다시 로그인할 수 없어요. 이 연결은 대화에서 쓰이지 않아요.', 'Your team has turned off personal connections, so you cannot sign in again now. This connection is not used in chats.', 'Tim Anda mematikan koneksi pribadi, jadi Anda tidak bisa login lagi sekarang. Koneksi ini tidak dipakai di obrolan.', "チームが個人接続を無効にしているため、今はもう一度ログインできません。この接続はチャットでは使われません。", "Su equipo desactivó las conexiones personales, así que ahora no puede volver a iniciar sesión. Esta conexión no se usa en los chats.", "你的团队已关闭个人连接，所以现在无法重新登录。这个连接不会在对话中使用。"),
  requestPersonalOff: t('지금은 직원이 개인 연결을 추가할 수 없어요. 먼저 팀 설정에서 "직원이 개인 연결을 추가할 수 있음"을 켜 주세요.', 'Members cannot add their own connections now. First turn on "Members can add their own connections" in Team settings.', 'Anggota tidak bisa menambah koneksi sendiri sekarang. Nyalakan dulu "Anggota dapat menambah koneksi pribadi" di Pengaturan tim.', "現在、メンバーは個人接続を追加できません。先にチーム設定で「メンバーによる個人接続の追加を許可」をオンにしてください。", "Ahora los miembros no pueden añadir sus propias conexiones. Active primero «Los miembros pueden añadir sus propias conexiones» en la configuración del equipo.", "成员现在不能添加自己的连接。请先在“团队设置”中打开“成员可以添加自己的连接”。"),
  requestNoUser: t('이 팀에서 쓰고 있는 계정이 아니에요.', 'This is not an active account of the team.', 'Ini bukan akun aktif di tim.', "このチームの有効なアカウントではありません。", "No es una cuenta activa del equipo.", "这不是团队中的有效账号。"),
  requestGuest: t('게스트에게는 연결을 요청할 수 없어요.', "Guests can't be asked to connect a service.", 'Tamu tidak bisa diminta menghubungkan layanan.', "ゲストには接続を依頼できません。", "No se puede pedir a un invitado que conecte un servicio.", "不能请访客连接服务。"),
  requestNoName: t('보이는 글자가 있는 이름을 넣어 주세요.', 'Enter a name with at least one visible character.', 'Masukkan nama dengan setidaknya satu karakter yang terlihat.', "表示できる文字を含む名前を入力してください。", "Introduzca un nombre con al menos un carácter visible.", "请输入至少包含一个可见字符的名称。"),
  requestDuplicate: t('이 사람에게 같은 주소로 보낸 요청이 아직 기다리고 있어요.', 'A request for this address is already waiting for this person.', 'Permintaan untuk alamat ini sudah menunggu orang ini.', "このアドレスへの依頼がすでにこの人の返答を待っています。", "Ya hay una solicitud para esta dirección esperando a esta persona.", "这个地址已有一个请求在等这个人处理。"),
  requestTooMany: t('한 사람에게 요청은 {n}개까지 기다릴 수 있어요.', 'At most {n} requests can wait for one person.', 'Paling banyak {n} permintaan bisa menunggu satu orang.', "1人に対して待機できる依頼は最大{n}件です。", "Como máximo {n} solicitudes pueden esperar a una persona.", "一个人最多只能有{n}个等待中的请求。"),
  requestTooManyTeam: t('요청은 한꺼번에 {n}개까지 기다릴 수 있어요.', 'At most {n} requests can wait at once.', 'Paling banyak {n} permintaan bisa menunggu sekaligus.', "同時に待機できる依頼は最大{n}件です。", "Como máximo {n} solicitudes pueden esperar a la vez.", "同时最多只能有{n}个等待中的请求。"),
  requestDone: t('이미 연결된 요청이에요.', 'This request is already connected.', 'Permintaan ini sudah terhubung.', "この依頼はすでに接続済みです。", "Esta solicitud ya está conectada.", "这个请求已经连接。"),
  requestDeclined: t('거절된 요청이에요.', 'This request was declined.', 'Permintaan ini ditolak.', "この依頼は辞退されました。", "Esta solicitud fue rechazada.", "这个请求已被拒绝。"),
  requestWithdrawn: t('철회된 요청이에요.', 'This request was withdrawn.', 'Permintaan ini ditarik.', "この依頼は取り下げられました。", "Esta solicitud fue retirada.", "这个请求已被撤回。"),
  requestExpired: t('기한이 지난 요청이에요.', 'This request has expired.', 'Permintaan ini sudah kedaluwarsa.', "この依頼は期限切れです。", "Esta solicitud ha caducado.", "这个请求已过期。"),
  requestBusy: t('이 요청을 지금 연결하고 있어요. 잠시 뒤에 다시 확인해 주세요.', 'This request is being connected right now. Check again in a moment.', 'Permintaan ini sedang dihubungkan. Periksa lagi sebentar lagi.', "この依頼は現在接続中です。しばらくしてから確認してください。", "Esta solicitud se está conectando ahora. Vuelva a comprobarlo en un momento.", "这个请求正在连接中。请稍后再查看。"),
  // an admin's template: each member connects the service with their own key or sign-in (templates.ts)
  fromTemplate: t('팀이 정한 항목이라 바꿀 수 없어요. 키나 로그인, 쓰기 규칙만 바꿀 수 있어요.', 'Your team set this, so it cannot be changed here. You can change your key or sign-in and the write rule.', 'Tim Anda yang mengatur ini, jadi tidak bisa diubah di sini. Anda bisa mengubah kunci atau login dan aturan tulis.', "チームが設定した項目のため、ここでは変更できません。変更できるのはキーまたはログインと書き込みルールです。", "Lo configuró su equipo, así que no se puede cambiar aquí. Puede cambiar su clave o inicio de sesión y la regla de escritura.", "这是你的团队设置的，所以不能在这里更改。你可以更改你的密钥或登录，以及写入规则。"),
  templateTooMany: t('템플릿은 {n}개까지 만들 수 있어요.', 'There can be at most {n} templates.', 'Paling banyak {n} templat.', "テンプレートは最大{n}件です。", "Puede haber como máximo {n} plantillas.", "最多只能有{n}个模板。"),
  templateNameHidden: t('이름에 보이지 않는 글자, 방향을 바꾸는 글자, 큰따옴표(")나 제어 문자는 넣을 수 없어요.', 'A template\'s name cannot hold invisible or direction-changing characters, a double quote (") or control characters.', 'Nama templat tidak boleh memuat karakter tak terlihat atau pengubah arah, tanda kutip ganda (") atau karakter kontrol.', "テンプレート名には、見えない文字や向きを変える文字、二重引用符（\"）、制御文字は使えません。", 'El nombre de una plantilla no puede contener caracteres invisibles o que cambien la dirección, comillas dobles (") ni caracteres de control.', "模板名称不能包含不可见字符、改变文字方向的字符、双引号（\"）或控制字符。"),
  templateNotesHidden: t('메모에 보이지 않는 글자나 방향을 바꾸는 글자는 넣을 수 없어요.', 'Notes cannot hold invisible or direction-changing characters.', 'Catatan tidak boleh memuat karakter tak terlihat atau pengubah arah.', 'メモには、見えない文字や向きを変える文字は使えません。', 'Las notas no pueden contener caracteres invisibles o que cambien la dirección.', "备注不能包含不可见字符或改变文字方向的字符。"),
  addressNoQuery: t('여러 사람이 함께 쓰는 주소에는 ?로 시작하는 부분(쿼리)을 넣을 수 없어요. 거기 키가 있으면 모두에게 가요. 키는 각자 자기 연결에 넣어요.', 'An address many people use cannot have a query (the part after ?): a key there would reach everyone. Each person adds their own key to their connection.', 'Alamat yang dipakai banyak orang tidak boleh memiliki kueri (bagian setelah ?): kunci di sana akan sampai ke semua orang. Setiap orang menambahkan kuncinya sendiri ke koneksinya.', "複数の人が使うアドレスにはクエリ（?以降の部分）を含められません。そこにキーがあると全員に届きます。キーは各自の接続に入れてください。", "Una dirección que usan varias personas no puede tener una consulta (la parte después de ?): una clave ahí llegaría a todos. Cada persona agrega su propia clave a su conexión.", "很多人使用的地址不能带查询部分（? 后面的部分）：放在那里的密钥会被所有人用到。每个人在自己的连接中添加自己的密钥。"),
  requestAddressKey: t('이 주소에 키가 들어 있는 것 같아요. 키는 빼 주세요. 키는 그 사람이 직접 넣어요.', 'This address seems to hold a key. Leave the key out: the member adds their own.', 'Alamat ini tampaknya berisi kunci. Hapus kuncinya: anggota menambahkan kuncinya sendiri.', "このアドレスにはキーが含まれているようです。キーは外してください。キーはメンバー本人が入れます。", "Esta dirección parece contener una clave. Quítela: el miembro agrega la suya.", "这个地址里好像有密钥。请去掉密钥：成员会添加自己的。"),
  templateChanged: t('이 템플릿이 바뀌었어요. 다시 확인하고 연결해 주세요.', 'This template changed. Check it and connect again.', 'Templat ini berubah. Periksa lalu hubungkan lagi.', "このテンプレートが変更されました。確認してからもう一度接続してください。", "Esta plantilla cambió. Revísela y conéctese de nuevo.", "这个模板已更改。请查看后重新连接。"),
  templateNotForYou: t('이 템플릿은 나에게 공유되지 않았어요.', 'This template is not shared with you.', 'Templat ini tidak dibagikan kepada Anda.', "このテンプレートはあなたに共有されていません。", "Esta plantilla no está compartida con usted.", "这个模板没有共享给你。"),
  templateNoKeyAuth: t('템플릿은 API 키나 로그인을 쓰는 서비스에만 만들 수 있어요.', 'A template is for a service that uses an API key or sign-in.', 'Templat untuk layanan yang memakai kunci API atau login.', "テンプレートはAPIキーまたはログインを使うサービス用です。", "Una plantilla es para un servicio que usa una clave de API o inicio de sesión.", "模板用于使用 API 密钥或登录的服务。"),
  // the page the browser lands on after signing in at the service (the app watches the sign-in by itself)
  callbackTitle: t('로그인', 'Sign-in', 'Login', "ログイン", "Iniciar sesión", "登录"),
  callbackOk: t('로그인했어요. 이 창을 닫고 앱으로 돌아가세요.', 'Signed in. You can close this window and go back to the app.', 'Sudah login. Anda bisa menutup jendela ini dan kembali ke aplikasi.', "ログインしました。このウィンドウを閉じてアプリに戻ってください。", "Sesión iniciada. Puede cerrar esta ventana y volver a la aplicación.", "已登录。你可以关闭这个窗口，回到应用。"),
  // a return no sign-in here may finish: the address was used or ran out, or this browser is not the starter's for a
  // sign-in started on the web or the phone (one started in the desktop app finishes in the app: callbackHeld)
  callbackFail: t('이 링크는 만료됐어요. 앱으로 돌아가서 연결을 다시 눌러 주세요.', 'This link expired. Go back to the app and press Connect again.', 'Tautan ini sudah kedaluwarsa. Kembali ke aplikasi dan tekan Hubungkan lagi.', "このリンクは期限切れです。アプリに戻って、もう一度「接続」を押してください。", "Este enlace caducó. Vuelva a la aplicación y pulse Conectar de nuevo.", "这个链接已过期。请回到应用，再按一次“连接”。"),
  // a sign-in started in the desktop app, answered in a browser without the starter's session: the app on this computer
  // finishes it with the one-time code in the button's link (service.ts hold, routes/integrations.ts)
  callbackHeldTitle: t('{product} 앱으로 돌아가서 마치세요', 'Go back to {product} to finish', 'Kembali ke {product} untuk menyelesaikan', "{product} に戻って完了してください", "Vuelva a {product} para terminar", "回到 {product} 完成连接"),
  callbackHeld: t('{name} 연결이 거의 끝났어요. 아래 버튼을 눌러 앱으로 돌아가면 끝나요. 다시 로그인할 필요는 없어요.', 'Connecting {name} is almost done. Press the button to go back to the app and finish. You don’t need to sign in again.', 'Menghubungkan {name} hampir selesai. Tekan tombol untuk kembali ke aplikasi dan menyelesaikannya. Anda tidak perlu login lagi.', "{name} の接続はもうすぐ完了します。ボタンを押してアプリに戻ると完了します。もう一度ログインする必要はありません。", "La conexión de {name} casi está lista. Pulse el botón para volver a la aplicación y terminar. No necesita iniciar sesión otra vez.", "{name} 快连接好了。按下按钮回到应用即可完成，不需要再次登录。"),
  callbackHeldWho: t('연결할 {product} 계정: {person} (@{username})', '{product} account it joins: {person} (@{username})', 'Akun {product} yang dihubungkan: {person} (@{username})', "接続先の {product} アカウント：{person}（@{username}）", "Cuenta de {product} a la que se une: {person} (@{username})", "要连接的 {product} 账号：{person}（@{username}）"),
  callbackHeldOwnApp: t('이 링크는 내 컴퓨터의 {product} 앱에서만 여세요. 다른 사람에게 보내지 마세요. 내 계정이 아니면 이 창을 닫으세요.', 'Open this link only in your own {product} app. Don’t send it to anyone. If this is not your account, close this window.', 'Buka tautan ini hanya di aplikasi {product} milik Anda. Jangan kirim ke siapa pun. Jika ini bukan akun Anda, tutup jendela ini.', "このリンクは自分の {product} アプリでだけ開いてください。誰にも送らないでください。自分のアカウントでなければ、このウィンドウを閉じてください。", "Abra este enlace solo en su propia aplicación {product}. No se lo envíe a nadie. Si no es su cuenta, cierre esta ventana.", "只在你自己的 {product} 应用中打开这个链接，不要发给任何人。如果这不是你的账号，请关闭这个窗口。"),
  // the return page's headings and its one next step on the web
  callbackOkTitle: t('연결됐어요', 'Connected', 'Terhubung', "接続しました", "Conectado", "已连接"),
  callbackNotTitle: t('연결하지 못했어요', 'Not connected', 'Tidak terhubung', "接続できませんでした", "No se conectó", "未连接"),
  callbackOtherTitle: t('이 브라우저에서는 마칠 수 없어요', 'This browser can’t finish it', 'Browser ini tidak bisa menyelesaikannya', "このブラウザーでは完了できません", "Este navegador no puede terminarlo", "这个浏览器无法完成"),
  callbackOpenConnectors: t('커넥터 열기', 'Open Connectors', 'Buka Konektor', "コネクタを開く", "Abrir conectores", "打开连接器"),
  callbackBackToApp: t('앱으로 돌아가기', 'Back to the app', 'Kembali ke aplikasi', "アプリに戻る", "Volver a la aplicación", "返回应用"),
  // the return came to a browser signed in to the team as someone else than who started: refused (service.ts callback)
  callbackOtherAccount: t('이 브라우저는 다른 사람 계정으로 로그인돼 있어요. 여기서 로그아웃하거나, 앱으로 돌아가서 연결을 다시 눌러 주세요.', 'This browser is signed in as someone else. Sign out here, or go back to the app and press Connect again.', 'Browser ini login sebagai orang lain. Keluar di sini, atau kembali ke aplikasi dan tekan Hubungkan lagi.', "このブラウザーは別の人のアカウントでログインしています。ここでログアウトするか、アプリに戻ってもう一度「接続」を押してください。", "Este navegador tiene la sesión iniciada con otra persona. Cierre la sesión aquí, o vuelva a la aplicación y pulse Conectar de nuevo.", "这个浏览器登录的是别人的账号。请在这里退出登录，或者回到应用再按一次“连接”。"),
  // the same sign-in's return opened again while it waits for the app: never a second code
  callbackHanded: t('이 연결은 앱에서 마치기를 기다리고 있어요. 처음 열린 페이지에서 ‘앱으로 돌아가기’를 누르거나, 앱으로 돌아가서 연결을 다시 눌러 주세요.', 'This connection is waiting for the app. Press “Back to the app” on the first page that opened, or go back to the app and press Connect again.', 'Koneksi ini menunggu aplikasi. Tekan “Kembali ke aplikasi” di halaman pertama yang terbuka, atau kembali ke aplikasi dan tekan Hubungkan lagi.', "この接続はアプリでの完了を待っています。最初に開いたページで「アプリに戻る」を押すか、アプリに戻ってもう一度「接続」を押してください。", "Esta conexión espera a la aplicación. Pulse «Volver a la aplicación» en la primera página que se abrió, o vuelva a la aplicación y pulse Conectar de nuevo.", "这个连接正在等待应用完成。请在最先打开的页面上按“返回应用”，或者回到应用再按一次“连接”。"),
  // a sign-in the service did not finish (CallbackResult.reason): what happened, in plain words, and what to do; never
  // the service's own answer
  callbackClient: t('서비스가 이 앱의 Client ID나 Secret을 받아들이지 않았어요. 이 창을 닫고, 연결 편집의 고급에서 Secret을 확인한 뒤 다시 로그인해 주세요.', 'The service did not accept this app’s Client ID or Secret. Close this window, check the Secret under Advanced when you edit the connection, then sign in again.', 'Layanan tidak menerima Client ID atau Secret aplikasi ini. Tutup jendela ini, periksa Secret di Lanjutan saat mengedit koneksi, lalu login lagi.', "サービスがこのアプリのクライアントIDまたはシークレットを受け付けませんでした。このウィンドウを閉じ、接続の編集の「詳細設定」でシークレットを確認してから、もう一度ログインしてください。", "El servicio no aceptó el ID de cliente ni el secreto de esta aplicación. Cierre esta ventana, revise el secreto en Avanzado al editar la conexión y vuelva a iniciar sesión.", "服务没有接受这个应用的客户端 ID 或密钥。请关闭这个窗口，编辑连接时在“高级”中检查密钥，然后重新登录。"),
  callbackClientTemplate: t('서비스가 이 연결에 쓰는 앱의 Client ID나 Secret을 받아들이지 않았어요. 이 창을 닫고, 이 연결을 설정한 사람에게 Client ID와 Secret을 확인해 달라고 요청해 주세요.', 'The service did not accept the Client ID or Secret of the app this connection uses. Close this window and ask the person who set up this connection to check its Client ID and Secret.', 'Layanan tidak menerima Client ID atau Secret aplikasi yang dipakai koneksi ini. Tutup jendela ini dan minta orang yang menyiapkan koneksi ini untuk memeriksa Client ID dan Secret-nya.', "サービスが、この接続で使うアプリのクライアントIDまたはシークレットを受け付けませんでした。このウィンドウを閉じ、この接続を設定した人にクライアントIDとシークレットの確認を依頼してください。", "El servicio no aceptó el ID de cliente ni el secreto de la aplicación que usa esta conexión. Cierre esta ventana y pida a quien configuró esta conexión que revise su ID de cliente y su secreto.", "服务没有接受这个连接所用应用的客户端 ID 或密钥。请关闭这个窗口，请设置这个连接的人检查它的客户端 ID 和密钥。"),
  // the person chose Cancel or Deny at the service (its answer "access_denied"): stopped, not refused (QA TC-3859)
  callbackDenied: t('서비스 화면에서 로그인이 취소됐어요. 연결하려면 이 창을 닫고 앱에서 다시 로그인해 주세요.', 'The sign-in was stopped at the service. To connect, close this window and sign in again from the app.', 'Login dihentikan di layanan. Untuk menghubungkan, tutup jendela ini lalu login lagi dari aplikasi.', "サービス側でログインが中止されました。接続するには、このウィンドウを閉じてアプリからもう一度ログインしてください。", "El inicio de sesión se detuvo en el servicio. Para conectar, cierre esta ventana y vuelva a iniciar sesión desde la aplicación.", "登录在该服务中被取消了。要连接的话，请关闭这个窗口，从应用重新登录。"),
  callbackChanged: t('로그인하는 동안 연결 설정이 바뀌었어요. 이 창을 닫고 앱에서 다시 로그인해 주세요.', 'The connection’s settings changed while you were signing in. Close this window and sign in again from the app.', 'Pengaturan koneksi berubah saat Anda login. Tutup jendela ini lalu login lagi dari aplikasi.', "ログイン中に接続の設定が変更されました。このウィンドウを閉じて、アプリからもう一度ログインしてください。", "La configuración de la conexión cambió mientras iniciaba sesión. Cierre esta ventana y vuelva a iniciar sesión desde la aplicación.", "登录期间连接的设置被更改了。请关闭这个窗口，从应用重新登录。"),
  callbackCancelled: t('앱에서 이 로그인을 취소했어요. 이 창을 닫고, 연결하려면 앱에서 다시 연결해 주세요.', 'This sign-in was cancelled in the app. Close this window; to connect, connect again from the app.', 'Login ini dibatalkan di aplikasi. Tutup jendela ini; untuk menghubungkan, hubungkan lagi dari aplikasi.', "このサインインはアプリでキャンセルされました。このウィンドウを閉じ、接続するにはアプリからもう一度接続してください。", "Este inicio de sesión se canceló en la aplicación. Cierre esta ventana; para conectar, vuelva a conectar desde la aplicación.", "这次登录已在应用中取消。请关闭此窗口；如需连接，请在应用中重新连接。"),
  // the sign-in window was allowed after its 10 minutes (service.ts FLOW_TTL) ran out
  callbackExpired: t('로그인 시간이 지났어요. 이 창을 닫고 앱에서 다시 연결해 주세요.', 'The sign-in expired. Close this window and connect again from the app.', 'Waktu login sudah habis. Tutup jendela ini lalu hubungkan lagi dari aplikasi.', "ログインの有効期限が切れました。このウィンドウを閉じて、アプリからもう一度接続してください。", "El inicio de sesión caducó. Cierre esta ventana y vuelva a conectar desde la aplicación.", "登录已过期。请关闭这个窗口，从应用重新连接。"),
  callbackExchange: t('서비스가 로그인을 마무리하지 못했어요. 이 창을 닫고 앱에서 다시 로그인해 주세요.', 'The service did not finish the sign-in. Close this window and sign in again from the app.', 'Layanan tidak menyelesaikan login. Tutup jendela ini lalu login lagi dari aplikasi.', "サービスがログインを完了できませんでした。このウィンドウを閉じて、アプリからもう一度ログインしてください。", "El servicio no terminó el inicio de sesión. Cierre esta ventana y vuelva a iniciar sesión desde la aplicación.", "服务没有完成登录。请关闭这个窗口，从应用重新登录。"),
  // the sign-in worked at the service, but the person already has as many working connections of their own as they may
  // (service.ts MAX_PERSONAL): nothing is stored
  callbackLimit: t('이미 작동하는 내 연결이 {n}개라 더 연결할 수 없어요. 하나를 지운 뒤 앱에서 다시 로그인해 주세요.', 'You already have {n} working connections of your own, the most you can have. Remove one, then sign in again from the app.', 'Anda sudah punya {n} koneksi pribadi yang berfungsi, jumlah maksimum. Hapus satu, lalu login lagi dari aplikasi.', "使える個人接続がすでに上限の{n}件あります。1件削除してから、アプリでもう一度ログインしてください。", "Ya tiene {n} conexiones propias que funcionan, el máximo. Elimine una y vuelva a iniciar sesión desde la aplicación.", "你已有 {n} 个可用的个人连接，已达上限。请删除一个后，再从应用中重新登录。"),
  // why a check failed (lastError)
  unreachable: t('서비스에 연결하지 못했어요. 주소를 확인해 주세요.', 'Could not reach the service. Check the address.', 'Tidak dapat menghubungi layanan. Periksa alamatnya.', "サービスに接続できませんでした。アドレスを確認してください。", "No se pudo conectar con el servicio. Revise la dirección.", "无法连接到服务。请检查地址。"),
  timeout: t('서비스가 30초 안에 답하지 않았어요.', 'The service did not answer within 30 seconds.', 'Layanan tidak menjawab dalam 30 detik.', "サービスが30秒以内に応答しませんでした。", "El servicio no respondió en 30 segundos.", "服务在30秒内没有回应。"),
  // its tools/list kept coming but did not end in time (mcp.ts MCP_LIST_TIMEOUT_MS)
  list_timeout: t('서비스가 90초 안에 도구 목록을 다 보내지 않았어요.', 'The service did not send its whole tool list within 90 seconds.', 'Layanan tidak mengirim seluruh daftar alatnya dalam 90 detik.', "サービスが90秒以内にツール一覧をすべて送信しませんでした。", "El servicio no envió su lista completa de herramientas en 90 segundos.", "服务没有在90秒内发送完整的工具列表。"),
  // a tool call that sent nothing for mcp.ts MCP_CALL_IDLE_MS (a call past MCP_CALL_TIMEOUT_MS marks nothing: service.ts statusOf)
  call_idle: t('서비스의 도구가 5분 동안 아무것도 보내지 않아 호출을 멈췄어요.', 'A tool of the service sent nothing for 5 minutes, so the call was stopped.', 'Alat layanan tidak mengirim apa pun selama 5 menit, jadi panggilan dihentikan.', "サービスのツールが5分間何も送信しなかったため、呼び出しを停止しました。", "Una herramienta del servicio no envió nada durante 5 minutos, así que se detuvo la llamada.", "服务的工具 5 分钟内没有发送任何内容，因此已停止调用。"),
  // a call past MCP_CALL_TIMEOUT_MS: the AI is told; never stored on the connection (service.ts statusOf), the words are
  // here because every Reason has them
  call_timeout: t('서비스의 도구가 15분 안에 끝나지 않아 호출을 멈췄어요.', 'A tool of the service did not finish within 15 minutes, so the call was stopped.', 'Alat layanan tidak selesai dalam 15 menit, jadi panggilan dihentikan.', "サービスのツールが15分以内に終わらなかったため、呼び出しを停止しました。", "Una herramienta del servicio no terminó en 15 minutos, así que se detuvo la llamada.", "服务的工具没有在 15 分钟内完成，因此已停止调用。"),
  private_address: t('사내망이나 이 서버의 주소에는 연결할 수 없어요. 인터넷의 공개 주소를 넣어 주세요.', 'Addresses on the office network or of this server cannot be used. Use a public internet address.', 'Alamat di jaringan kantor atau server ini tidak bisa dipakai. Pakai alamat publik di internet.', "社内ネットワークやこのサーバーのアドレスは使用できません。公開インターネットアドレスを使ってください。", "No se pueden usar direcciones de la red interna ni de este servidor. Use una dirección pública de internet.", "不能使用办公室网络或这台服务器上的地址。请使用公网地址。"),
  blocked_port: t('https 기본 포트(443)만 쓸 수 있어요.', 'Only the standard https port (443) can be used.', 'Hanya port https standar (443) yang bisa dipakai.', "標準のhttpsポート（443）のみ使用できます。", "Solo se puede usar el puerto https estándar (443).", "只能使用标准 https 端口（443）。"),
  tls: t('서비스의 보안 인증서를 확인하지 못했어요.', 'The service’s security certificate could not be verified.', 'Sertifikat keamanan layanan tidak dapat diverifikasi.', "サービスのセキュリティ証明書を確認できませんでした。", "No se pudo verificar el certificado de seguridad del servicio.", "无法验证服务的安全证书。"),
  refused: t('서비스가 키나 로그인을 받아 주지 않았어요(HTTP {status}). 키를 다시 넣거나 다시 로그인해 주세요.', 'The service did not accept the key or sign-in (HTTP {status}). Enter the key again or sign in again.', 'Layanan tidak menerima kunci atau login (HTTP {status}). Masukkan kunci lagi atau login ulang.', "サービスがキーまたはログインを受け付けませんでした（HTTP {status}）。キーを再入力するか、再ログインしてください。", "El servicio no aceptó la clave o el inicio de sesión (HTTP {status}). Introduzca la clave de nuevo o vuelva a iniciar sesión.", "服务没有接受密钥或登录（HTTP {status}）。请重新输入密钥或重新登录。"),
  // a 403 insufficient_scope (refusal.ts scope): the sign-in works but lacks a permission the service needs
  scope: t('로그인에 서비스가 필요로 하는 권한이 모두 들어 있지 않아요(HTTP {status}). 다시 로그인하고 요청하는 권한을 허용하거나, 그 권한이 있는 키를 넣어 주세요.', 'The sign-in does not have all the access the service needs (HTTP {status}). Sign in again and allow the access it asks for, or enter a key that has that access.', 'Login ini tidak punya semua akses yang dibutuhkan layanan (HTTP {status}). Login ulang dan izinkan akses yang diminta, atau masukkan kunci yang punya akses itu.', "このログインには、サービスが必要とするアクセス権がすべて含まれていません（HTTP {status}）。再ログインして求められるアクセスを許可するか、そのアクセス権のあるキーを入力してください。", "El inicio de sesión no tiene todo el acceso que necesita el servicio (HTTP {status}). Vuelva a iniciar sesión y permita el acceso que solicita, o introduzca una clave que tenga ese acceso.", "这次登录没有服务需要的全部权限（HTTP {status}）。请重新登录并允许它请求的权限，或输入拥有该权限的密钥。"),
  // any other 403 (refusal.ts no_access): signed in, but the service does not let this account use it (GitLab's MCP
  // server for an account without a top-level group). Signing in again cannot fix it, so it never says to; {said} is
  // the service's words, sanitized and cut (refusal.ts cleanSaid); no_access_bare when it said nothing usable
  no_access: t('로그인은 됐지만 서비스가 이 계정의 사용을 허용하지 않아요(HTTP {status}). 서비스의 답: “{said}” 계정이나 조직의 소유자에게 켜 달라고 요청해 주세요. 켜면 다시 쓸 수 있어요.', 'Signed in, but the service does not let this account use it (HTTP {status}). The service said: “{said}” Ask the account’s or organization’s owner to turn it on; then it works again.', 'Sudah login, tetapi layanan tidak mengizinkan akun ini memakainya (HTTP {status}). Kata layanan: “{said}” Minta pemilik akun atau organisasi untuk mengaktifkannya; setelah itu bisa dipakai lagi.', "ログインはできていますが、サービスがこのアカウントでの利用を許可していません（HTTP {status}）。サービスからの返答：「{said}」 アカウントまたは組織の所有者に有効にしてもらってください。有効になれば再び使えます。", "La sesión está iniciada, pero el servicio no permite que esta cuenta lo use (HTTP {status}). El servicio dijo: “{said}” Pida al propietario de la cuenta o de la organización que lo active; después volverá a funcionar.", "已登录，但服务不允许这个账号使用它（HTTP {status}）。服务的回复：“{said}” 请让账号或组织的所有者开启它；开启后即可再次使用。"),
  no_access_bare: t('로그인은 됐지만 서비스가 이 계정의 사용을 허용하지 않아요(HTTP {status}). 계정이나 조직의 소유자에게 켜 달라고 요청해 주세요. 켜면 다시 쓸 수 있어요.', 'Signed in, but the service does not let this account use it (HTTP {status}). Ask the account’s or organization’s owner to turn it on; then it works again.', 'Sudah login, tetapi layanan tidak mengizinkan akun ini memakainya (HTTP {status}). Minta pemilik akun atau organisasi untuk mengaktifkannya; setelah itu bisa dipakai lagi.', "ログインはできていますが、サービスがこのアカウントでの利用を許可していません（HTTP {status}）。アカウントまたは組織の所有者に有効にしてもらってください。有効になれば再び使えます。", "La sesión está iniciada, pero el servicio no permite que esta cuenta lo use (HTTP {status}). Pida al propietario de la cuenta o de la organización que lo active; después volverá a funcionar.", "已登录，但服务不允许这个账号使用它（HTTP {status}）。请让账号或组织的所有者开启它；开启后即可再次使用。"),
  no_secret: t('키가 아직 없어요. 키를 넣어 주세요.', 'There is no key yet. Enter the key.', 'Belum ada kunci. Masukkan kuncinya.', "キーがありません。入力してください。", "Aún no hay clave. Introdúzcala.", "还没有密钥。请输入密钥。"),
  sign_in: t('서비스에 로그인해 주세요.', 'Sign in at the service.', 'Silakan login di layanan.', "サービスにログインしてください。", "Inicie sesión en el servicio.", "请在服务上登录。"),
  redirect: t('서비스가 다른 주소로 넘기려고 했어요(HTTP {status}). 넘어가는 주소를 직접 넣어 주세요.', 'The service tried to send us to another address (HTTP {status}). Enter that address instead.', 'Layanan mencoba mengalihkan ke alamat lain (HTTP {status}). Masukkan alamat itu langsung.', "サービスが別のアドレスに転送しようとしました（HTTP {status}）。そのアドレスを代わりに入力してください。", "El servicio intentó redirigir a otra dirección (HTTP {status}). Introduzca esa dirección en su lugar.", "服务想把我们转到另一个地址（HTTP {status}）。请改为输入那个地址。"),
  http_status: t('서비스가 오류로 답했어요(HTTP {status}).', 'The service answered with an error (HTTP {status}).', 'Layanan menjawab dengan galat (HTTP {status}).', "サービスがエラーを返しました（HTTP {status}）。", "El servicio respondió con un error (HTTP {status}).", "服务返回了错误（HTTP {status}）。"),
  not_mcp: t('이 주소는 MCP 서버처럼 답하지 않았어요.', 'This address did not answer like an MCP server.', 'Alamat ini tidak menjawab seperti server MCP.', "このアドレスはMCPサーバーとして応答しませんでした。", "Esta dirección no respondió como un servidor MCP.", "这个地址的回应不像 MCP 服务器。"),
  too_large: t('서비스의 답이 너무 커요(1MB 넘음).', 'The service’s answer is too large (over 1 MB).', 'Jawaban layanan terlalu besar (lebih dari 1 MB).', "サービスの応答が大きすぎます（1 MB超）。", "La respuesta del servicio es demasiado grande (más de 1 MB).", "服务的回答太大了（超过1 MB）。"),
  oauth_unsupported: t('이 서비스는 이런 앱의 로그인을 받지 않아요. API 키로 연결해 보세요.', 'This service does not offer sign-in to apps like this one. Try an API key instead.', 'Layanan ini tidak menyediakan login untuk aplikasi seperti ini. Coba pakai kunci API.', "このサービスはこの種類のアプリ向けログインを提供していません。代わりにAPIキーをお試しください。", "Este servicio no ofrece inicio de sesión para aplicaciones como esta. Pruebe con una clave de API.", "这个服务不支持像这样的应用登录。请改用 API 密钥试试。"),
  // a sign-in server without dynamic client registration (oauth.ts register): an own app is needed
  oauth_no_registration: t('이 서비스는 앱을 스스로 등록하게 해 주지 않아요. 서비스에서 앱을 만들어 "내 앱으로 로그인"에 Client ID를 넣거나, API 키로 연결해 보세요.', 'This service does not let apps register themselves. Make an app at the service and enter its client ID under "Sign in with my own app", or try an API key instead.', 'Layanan ini tidak mengizinkan aplikasi mendaftar sendiri. Buat aplikasi di layanan itu dan masukkan client ID-nya di "Login dengan aplikasi saya", atau coba pakai kunci API.', "このサービスはアプリの自動登録を受け付けていません。サービスでアプリを作成して「自分のアプリでログイン」にクライアントIDを入力するか、APIキーをお試しください。", "Este servicio no permite que las aplicaciones se registren solas. Cree una aplicación en el servicio e introduzca su ID de cliente en «Iniciar sesión con mi propia aplicación», o pruebe con una clave de API.", "这个服务不允许应用自行注册。请在该服务上创建一个应用，并在“用我自己的应用登录”中输入它的客户端 ID，或改用 API 密钥试试。"),
  oauth_no_registration_member: t('이 서비스는 팀이 서비스에 만든 앱으로만 로그인할 수 있어요. 관리자에게 알려 주세요.', 'This service signs in only through an app your team made there. Tell your admin.', 'Layanan ini hanya bisa login melalui aplikasi yang dibuat tim Anda di sana. Beri tahu admin Anda.', "このサービスには、チームがそこで作成したアプリでのみログインできます。管理者に知らせてください。", "Este servicio solo permite iniciar sesión con una aplicación que su equipo creó allí. Avise a su administrador.", "这个服务只能通过你的团队在那里创建的应用登录。请告诉你的管理员。"),
  // a listed service that signs in only through the team's own app (shared/src/service-catalog.ts teamApp: Asana,
  // HubSpot, Box), connected by its address without one: nothing is registered or opened; an admin sets it up as a
  // template in Admin (docs/INTEGRATIONS.md "Services that need the team's own app")
  oauth_needs_team_app: t('{name}은(는) 팀에서 만든 앱으로만 로그인할 수 있어요. 관리자가 관리자 › 연결한 서비스에서 한 번 설정하면 각자 자기 계정으로 로그인할 수 있어요.', "{name} signs in only through an app your team makes there. An admin sets it up once in Admin › Connected apps, then everyone signs in with their own account.", '{name} hanya bisa login melalui aplikasi yang dibuat tim Anda di sana. Admin menyiapkannya sekali di Admin › Aplikasi terhubung, lalu setiap orang login dengan akunnya sendiri.', "{name} には、チームがそこで作成したアプリでのみログインできます。管理者が 管理 › 連携サービス で一度設定すると、各自が自分のアカウントでログインできます。", "{name} solo permite iniciar sesión con una aplicación que su equipo crea allí. Un administrador la configura una vez en Administración › Apps conectadas y luego cada persona inicia sesión con su propia cuenta.", "{name} 只能通过你的团队在那里创建的应用登录。管理员在 管理 › 已连接的应用 中设置一次后，每个人都用自己的账号登录。"),
  // the service refused the app this server registered for itself, or its sign-in page refused it, and no client
  // metadata document helped (oauth.ts register, preflight): it lets only apps it approved sign in (Figma, Canva).
  // Nothing on this team can fix it, and no API key is asked for (those services take none)
  oauth_approved_apps_only: t('이 서비스는 승인한 앱만 로그인할 수 있게 하는데, 이 앱은 아직 승인받지 못했어요. 서비스 쪽에서만 바꿀 수 있어서 지금은 여기서 연결할 수 없어요.',
    'This service lets only apps it has approved sign in, and it has not approved this one yet. Only the service can change that, so for now it cannot be connected here.',
    'Layanan ini hanya mengizinkan login dari aplikasi yang sudah disetujuinya, dan aplikasi ini belum disetujui. Hanya layanan itu yang bisa mengubahnya, jadi untuk sekarang layanan ini belum bisa dihubungkan di sini.',
    "このサービスは承認したアプリだけにログインを許可しており、このアプリはまだ承認されていません。変更できるのはサービス側だけのため、今はここで接続できません。",
    "Este servicio solo permite iniciar sesión a las aplicaciones que ha aprobado, y todavía no ha aprobado esta. Solo el servicio puede cambiarlo, así que por ahora no se puede conectar aquí.", "这项服务只允许它批准过的应用登录，而这个应用还没有获得批准。只有该服务能改变这一点，所以目前无法在这里连接。"),
  // the service refused every app for the team's https address but takes one on the person's computer (Canva, Intercom,
  // Square: oauth.ts loopbackClient), and this sign-in came from the web or the phone app: the desktop app connects it.
  // {name}: the connection's name
  oauth_desktop_only: t('{name}은(는) 컴퓨터에 설치한 앱에서만 로그인할 수 있어요. 트리나 데스크톱 앱을 열고 거기서 연결해 주세요.',
    '{name} only lets you sign in from an app on your computer. Open the Trina desktop app and connect it there.',
    '{name} hanya mengizinkan login dari aplikasi di komputer Anda. Buka aplikasi desktop Trina dan hubungkan di sana.',
    "{name}には、パソコンにインストールしたアプリからしかログインできません。トリナのデスクトップアプリを開いて、そこで接続してください。",
    "{name} solo permite iniciar sesión desde una aplicación instalada en su ordenador. Abra la aplicación de escritorio de Trina y conéctelo allí.",
    "{name}只允许从电脑上安装的应用登录。请打开 Trina 桌面应用，在那里连接。"),
  // the registration answered 429 (oauth.ts register): too many apps registered there just now
  oauth_busy: t('서비스가 지금 너무 바빠요. 몇 분 뒤에 다시 연결해 주세요.', 'The service is too busy right now. Try connecting again in a few minutes.', 'Layanan sedang terlalu sibuk. Coba hubungkan lagi beberapa menit lagi.', "サービスが現在混み合っています。数分後にもう一度接続してください。", "El servicio está demasiado ocupado ahora. Vuelva a conectarlo en unos minutos.", "服务现在太忙了。请过几分钟再连接。"),
  oauth_failed: t('로그인을 마치지 못했어요. 다시 시도해 주세요.', 'Signing in did not finish. Try again.', 'Login tidak selesai. Coba lagi.', "ログインを完了できませんでした。再試行してください。", "No se completó el inicio de sesión. Vuelva a intentarlo.", "登录没有完成。请重试。"),
  // an app on the person's computer (local.ts): the reasons its check stored, and the refusals of its API
  local_offline: t('이 연결은 추가한 컴퓨터의 데스크톱 앱에서만 쓸 수 있어요. 그 컴퓨터에서 열어 확인해 주세요.', 'This works only from the desktop app on the computer where you added it. Open it there to check it.', 'Ini hanya berfungsi dari aplikasi desktop di komputer tempat Anda menambahkannya. Buka di sana untuk memeriksanya.', "これは、追加したパソコンのデスクトップアプリからのみ使えます。そのパソコンで開いて確認してください。", "Solo funciona desde la aplicación de escritorio en el ordenador donde la añadió. Ábrala allí para comprobarla.", "只能在添加它的那台电脑上的桌面应用中使用。请在那台电脑上打开并检查。"),
  local_declined: t('이 컴퓨터에서 연결하지 않았어요(취소를 눌렀어요). 다시 확인을 누르면 다시 물어봐요.', 'It is not connected on this computer: Cancel was chosen. Press Check again to be asked again.', 'Belum terhubung di komputer ini: Batal dipilih. Tekan Periksa lagi agar ditanya lagi.', "このパソコンでは接続されていません（キャンセルが選ばれました）。「再確認」を押すと、もう一度確認します。", "No está conectada en este ordenador: se eligió Cancelar. Pulse Volver a comprobar para que se lo vuelva a preguntar.", "在这台电脑上没有连接：选择了取消。按“重新检查”会再次询问。"),
  // the desktop app's "Connect this program?" was still open when the check stopped waiting (local.ts 'unconfirmed')
  local_confirm: t('데스크톱 앱에서 확인을 기다리고 있어요. 거기서 연결을 눌러 주세요.', 'Waiting for you to confirm in the desktop app. Press Connect there.', 'Menunggu konfirmasi Anda di aplikasi desktop. Tekan Hubungkan di sana.', "デスクトップアプリでの確認を待っています。そこで「接続」を押してください。", "Esperando su confirmación en la aplicación de escritorio. Pulse Conectar allí.", "正在等待你在桌面应用中确认。请在那里按“连接”。"),
  local_failed: t('이 컴퓨터에서 프로그램을 시작하지 못했어요. 명령을 확인한 뒤 다시 확인을 눌러 주세요.', 'The program could not start on this computer. Check the command, then press Check again.', 'Program tidak dapat dimulai di komputer ini. Periksa perintahnya, lalu tekan Periksa lagi.', "このパソコンでプログラムを起動できませんでした。コマンドを確認してから「再確認」を押してください。", "El programa no pudo iniciarse en este ordenador. Revise el comando y pulse Volver a comprobar.", "程序无法在这台电脑上启动。请检查命令，然后按“重新检查”。"),
  // the desktop app found no program by that name on the computer (LocalResult.cause not_found): install it
  local_missing: t('{name}이(가) 이 컴퓨터에 설치되어 있지 않아요. 설치한 다음 다시 확인을 눌러 주세요.', '{name} isn’t installed on this computer. Install it, then press Check again.', '{name} belum terpasang di komputer ini. Pasang dulu, lalu tekan Periksa lagi.', '{name}はこのパソコンにインストールされていません。インストールしてから「再確認」を押してください。', '{name} no está instalado en este ordenador. Instálelo y pulse Volver a comprobar.', '这台电脑上没有安装 {name}。安装后请按“重新检查”。'),
  // the program is on a network share or a device path (\\server\share\x.exe): the desktop app never starts one
  // (programs.ts windowsShare; local.ts causeOf). The connection keeps its command, so the fix is to add it again
  local_share: t('{name}의 프로그램이 네트워크 경로(\\\\로 시작)에 있어요. 이 컴퓨터에 있는 프로그램만 실행할 수 있어요. 이 컴퓨터의 폴더로 복사한 다음, 이 연결을 삭제하고 그 경로로 다시 추가해 주세요.',
    '{name}’s program is on a network path (it starts with \\\\). Only programs on this computer can run: copy it to a folder on this computer, then delete this connection and add it again with that path.',
    'Program {name} ada di jalur jaringan (diawali \\\\). Hanya program di komputer ini yang bisa dijalankan: salin ke folder di komputer ini, lalu hapus koneksi ini dan tambahkan lagi dengan jalur itu.',
    '{name}のプログラムはネットワーク上のパス（\\\\で始まる）にあります。このパソコンにあるプログラムしか実行できません。このパソコンのフォルダーにコピーしてから、この接続を削除し、そのパスでもう一度追加してください。',
    'El programa de {name} está en una ruta de red (empieza por \\\\). Solo se pueden ejecutar programas de este ordenador: cópielo a una carpeta de este ordenador, elimine esta conexión y vuelva a añadirla con esa ruta.',
    '{name} 的程序在网络路径上（以 \\\\ 开头）。只能运行这台电脑上的程序：请把它复制到这台电脑上的文件夹，然后删除这个连接，用那个路径重新添加。'),
  // a kind of file Windows does not start here (.ps1, .js, .vbs …: programs.ts launchFor)
  local_unsupported: t('{name}의 프로그램은 Windows가 여기서 실행하지 않는 종류의 파일이에요. .exe, .com, .cmd, .bat 프로그램만 실행할 수 있어요. 이 연결을 삭제하고 프로그램의 .exe로 다시 추가해 주세요.',
    '{name}’s program is a kind of file Windows doesn’t start here. Only .exe, .com, .cmd and .bat programs can run: delete this connection and add it again with the program’s .exe.',
    'Program {name} adalah jenis file yang tidak dijalankan Windows di sini. Hanya program .exe, .com, .cmd, dan .bat yang bisa dijalankan: hapus koneksi ini dan tambahkan lagi dengan file .exe programnya.',
    '{name}のプログラムは、Windowsがここで起動しない種類のファイルです。.exe、.com、.cmd、.batのプログラムだけが実行できます。この接続を削除し、プログラムの.exeでもう一度追加してください。',
    'El programa de {name} es un tipo de archivo que Windows no inicia aquí. Solo se pueden ejecutar programas .exe, .com, .cmd y .bat: elimine esta conexión y vuelva a añadirla con el .exe del programa.',
    '{name} 的程序是 Windows 在这里不会启动的文件类型。只能运行 .exe、.com、.cmd 和 .bat 程序：请删除这个连接，用程序的 .exe 重新添加。'),
  // a batch file (.cmd, .bat that is not an npm shim) whose command holds what cmd.exe reads even in quotes: {chars} is
  // BATCH_REFUSED, the list programs.ts refuses (QA TC-9008)
  local_unsafe: t('{name}의 프로그램은 배치 파일(.cmd, .bat)인데, 명령에 Windows가 배치 파일에 안전하게 넘길 수 없는 문자가 있어요: {chars}. 이 연결을 삭제하고 그 문자 없이, 또는 프로그램의 .exe로 다시 추가해 주세요.',
    '{name}’s program is a batch file (.cmd or .bat), and its command has a character Windows can’t pass to one safely: {chars}. Delete this connection and add it again without that character, or with the program’s .exe.',
    'Program {name} adalah file batch (.cmd atau .bat), dan perintahnya berisi karakter yang tidak bisa diteruskan Windows dengan aman: {chars}. Hapus koneksi ini dan tambahkan lagi tanpa karakter itu, atau dengan file .exe programnya.',
    '{name}のプログラムはバッチファイル（.cmd、.bat）で、コマンドにWindowsが安全に渡せない文字が含まれています：{chars}。この接続を削除し、その文字を使わずに、またはプログラムの.exeでもう一度追加してください。',
    'El programa de {name} es un archivo por lotes (.cmd o .bat) y su comando tiene un carácter que Windows no puede pasarle de forma segura: {chars}. Elimine esta conexión y vuelva a añadirla sin ese carácter o con el .exe del programa.',
    '{name} 的程序是批处理文件（.cmd 或 .bat），它的命令里有 Windows 无法安全传给它的字符：{chars}。请删除这个连接，不用那个字符重新添加，或者改用程序的 .exe。'),
  localOff: t('팀에서 내 컴퓨터의 앱 연결을 꺼 두었어요. 관리자에게 알려 주세요.', 'Your team turned off apps on your computer. Tell your admin.', 'Tim Anda menonaktifkan aplikasi di komputer Anda. Beri tahu admin Anda.', "チームで「パソコンのアプリ」がオフになっています。管理者に知らせてください。", "Su equipo desactivó las aplicaciones de su ordenador. Avise a su administrador.", "你的团队关闭了“电脑上的应用”。请告诉管理员。"),
  localFixed: t('내 컴퓨터의 앱에는 바꿀 주소, 키, 로그인이 없어요.', 'An app on your computer has no address, key or sign-in to change.', 'Aplikasi di komputer Anda tidak punya alamat, kunci, atau login untuk diubah.', "パソコンのアプリには、変更できるアドレス、キー、ログインがありません。", "Una aplicación de su ordenador no tiene dirección, clave ni inicio de sesión que cambiar.", "电脑上的应用没有可以更改的地址、密钥或登录。"),
  localHidden: t('보이지 않는 문자가 들어 있어요. 다시 입력해 주세요.', 'It has characters that cannot be seen. Type it again.', 'Ada karakter yang tidak terlihat. Ketik ulang.', "見えない文字が含まれています。もう一度入力してください。", "Contiene caracteres que no se ven. Escríbalo de nuevo.", "其中有看不见的字符。请重新输入。"),
  // the same reasons for someone who cannot fix them (reasonText): a member on a team connection, or on a connection made
  // from a team template for its address (QA TC-235). No admin is named (members never see who the admins are)
  addressMember: t('서비스에 연결하지 못했어요. 관리자에게 알려 주세요.', 'Could not reach the service. Tell your admin.', 'Tidak dapat menghubungi layanan. Beri tahu admin Anda.', "サービスに接続できませんでした。管理者に知らせてください。", "No se pudo conectar con el servicio. Avise a su administrador.", "无法连接到服务。请告诉你的管理员。"),
  keyMember: t('이 서비스에 쓰는 팀의 키나 로그인이 안 돼요. 관리자에게 알려 주세요.', "The team's key or sign-in for this service is not working. Tell your admin.", 'Kunci atau login tim untuk layanan ini tidak berfungsi. Beri tahu admin Anda.', "このサービスに使うチームのキーまたはログインが機能していません。管理者に知らせてください。", "La clave o el inicio de sesión del equipo para este servicio no funciona. Avise a su administrador.", "团队用于这个服务的密钥或登录无法使用。请告诉你的管理员。"),
  key_unsafe: t('서버의 키 보관 폴더를 쓸 수 없어요. 관리자에게 알려 주세요.', 'The server’s key folder cannot be used. Tell your admin.', 'Folder kunci server tidak bisa dipakai. Beri tahu admin Anda.', "サーバーのキーフォルダーを使用できません。管理者に知らせてください。", "No se puede usar la carpeta de claves del servidor. Avise a su administrador.", "服务器的密钥文件夹无法使用。请告诉你的管理员。"),
}
export type TextKey = keyof typeof TEXT

/** A call's argument names in words on the card (card-lines.ts fieldWord), by the name's letters alone ("email_address",
 * "emailAddress" and "Email-Address" are one). A name not here is said as its own words ("page_id" -> "Page id"). */
const RECIPIENT_WORD = t('받는 사람', 'Recipient', 'Penerima', "宛先", "Destinatario", "收件人")
const CONTENT_WORD = t('내용', 'Content', 'Isi', "内容", "Contenido", "内容")
export const FIELD_WORDS: Record<string, T> = {
  to: RECIPIENT_WORD, recipient: RECIPIENT_WORD, recipients: RECIPIENT_WORD, email: RECIPIENT_WORD, emails: RECIPIENT_WORD, emailaddress: RECIPIENT_WORD, emailaddresses: RECIPIENT_WORD,
  cc: t('참조', 'Cc', 'Cc', "CC", "CC", "抄送"),
  bcc: t('숨은 참조', 'Bcc', 'Bcc', "BCC", "CCO", "密送"),
  subject: t('제목', 'Subject', 'Subjek', "件名", "Asunto", "主题"),
  title: t('제목', 'Title', 'Judul', "タイトル", "Título", "标题"),
  name: t('이름', 'Name', 'Nama', "名前", "Nombre", "名称"),
  body: CONTENT_WORD, text: CONTENT_WORD, content: CONTENT_WORD, contents: CONTENT_WORD, message: CONTENT_WORD, markdown: CONTENT_WORD, html: CONTENT_WORD, plaintext: CONTENT_WORD,
  description: t('설명', 'Description', 'Deskripsi', "説明", "Descripción", "描述"),
  summary: t('요약', 'Summary', 'Ringkasan', "要約", "Resumen", "摘要"),
  channel: t('채널', 'Channel', 'Saluran', "チャンネル", "Canal", "频道"),
  url: t('주소', 'Address', 'Alamat', "アドレス", "Dirección", "地址"), link: t('링크', 'Link', 'Tautan', "リンク", "Enlace", "链接"),
  date: t('날짜', 'Date', 'Tanggal', "日付", "Fecha", "日期"),
  due: t('마감일', 'Due date', 'Tenggat', "期限", "Fecha límite", "截止日期"), duedate: t('마감일', 'Due date', 'Tenggat', "期限", "Fecha límite", "截止日期"),
  assignee: t('담당자', 'Assignee', 'Penanggung jawab', "担当者", "Responsable", "负责人"), assignees: t('담당자', 'Assignees', 'Penanggung jawab', "担当者", "Responsables", "负责人"),
  priority: t('우선순위', 'Priority', 'Prioritas', "優先度", "Prioridad", "优先级"),
  status: t('상태', 'Status', 'Status', "ステータス", "Estado", "状态"),
  tags: t('태그', 'Tags', 'Tag', "タグ", "Etiquetas", "标签"), labels: t('라벨', 'Labels', 'Label', "ラベル", "Etiquetas", "标签"),
  note: t('메모', 'Note', 'Catatan', "メモ", "Nota", "备注"), notes: t('메모', 'Notes', 'Catatan', "メモ", "Notas", "备注"), comment: t('댓글', 'Comment', 'Komentar', "コメント", "Comentario", "评论"),
  project: t('프로젝트', 'Project', 'Proyek', "プロジェクト", "Proyecto", "项目"),
  parent: t('넣을 곳', 'Where it goes', 'Tempat tujuan', "追加先", "Dónde va", "放到哪里"),
  folder: t('폴더', 'Folder', 'Folder', "フォルダー", "Carpeta", "文件夹"),
}
/** A mail call's argument names in words, only on a Google Workspace library connection's card (card-lines.ts fieldWord
 * `extra`): another service's `thread_id` (a chat thread) or `references` keeps its own words. */
export const MAIL_FIELD_WORDS: Record<string, T> = {
  threadid: t('메일 대화', 'Conversation', 'Percakapan', "メールのやり取り", "Conversación", "邮件会话"),
  inreplyto: t('답장할 메일', 'Reply to', 'Balasan untuk', "返信先のメール", "En respuesta a", "回复的邮件"),
  references: t('이전 메일', 'Earlier mail', 'Email sebelumnya', "以前のメール", "Correos anteriores", "之前的邮件"),
}
/** What the step under an answer and the card before a change call a Google Workspace library tool, in the person's
 * language (card-lines.ts toolTitle), in place of the library's English title ("Search Gmail Messages"). Gmail only for
 * now: Calendar, Docs and Sheets keep the library's title. tests/unit/google-tool-titles.test.ts: every Gmail tool of
 * google-apps/catalog.ts in every language. */
export const GOOGLE_TOOL_WORDS: Record<string, T> = {
  search_gmail_messages: t('메일 찾기', 'Search mail', 'Cari email', 'メールを検索', 'Buscar correo', '搜索邮件'),
  get_gmail_message_content: t('메일 읽기', 'Read a message', 'Baca email', 'メールを読む', 'Leer un mensaje', '阅读邮件'),
  get_gmail_messages_content_batch: t('메일 여러 통 읽기', 'Read messages', 'Baca beberapa email', '複数のメールを読む', 'Leer varios mensajes', '阅读多封邮件'),
  get_gmail_thread_content: t('메일 대화 읽기', 'Read a conversation', 'Baca percakapan', 'メールのやり取りを読む', 'Leer una conversación', '阅读邮件会话'),
  get_gmail_threads_content_batch: t('메일 대화 여러 개 읽기', 'Read conversations', 'Baca beberapa percakapan', '複数のやり取りを読む', 'Leer varias conversaciones', '阅读多个邮件会话'),
  get_gmail_attachment_content: t('첨부 파일 읽기', 'Read an attachment', 'Baca lampiran', '添付ファイルを読む', 'Leer un adjunto', '阅读附件'),
  list_gmail_labels: t('라벨 보기', 'List labels', 'Lihat label', 'ラベルを見る', 'Ver etiquetas', '查看标签'),
  list_gmail_filters: t('필터 보기', 'List filters', 'Lihat filter', 'フィルタを見る', 'Ver filtros', '查看过滤器'),
  send_gmail_message: t('메일 보내기', 'Send email', 'Kirim email', 'メールを送信', 'Enviar correo', '发送邮件'),
  draft_gmail_message: t('임시 보관함에 저장', 'Save a draft', 'Simpan draf', '下書きを保存', 'Guardar un borrador', '保存草稿'),
  modify_gmail_message_labels: t('라벨 바꾸기', 'Change labels', 'Ubah label', 'ラベルを変更', 'Cambiar etiquetas', '更改标签'),
  batch_modify_gmail_message_labels: t('여러 메일 라벨 바꾸기', 'Change labels on several messages', 'Ubah label beberapa email', '複数のメールのラベルを変更', 'Cambiar etiquetas de varios mensajes', '更改多封邮件的标签'),
  manage_gmail_label: t('라벨 관리', 'Manage a label', 'Kelola label', 'ラベルを管理', 'Gestionar una etiqueta', '管理标签'),
  manage_gmail_filter: t('필터 관리', 'Manage a filter', 'Kelola filter', 'フィルタを管理', 'Gestionar un filtro', '管理过滤器'),
}
/** a library tool's own words in `L` (GOOGLE_TOOL_WORDS), or null for a tool not listed there */
export const googleToolWord = (name: string, L: Locale): string | null =>
  Object.hasOwn(GOOGLE_TOOL_WORDS, name) ? GOOGLE_TOOL_WORDS[name]![L] ?? GOOGLE_TOOL_WORDS[name]!.en : null
/** What the step and the card call a tool of the demo's Higgsfield (demo/fakes/higgsfield.ts HIGGSFIELD_TOOLS), in the
 * person's language (demo re-test 11-22: "Higgsfield · Generate image" in a Korean chat). Only on a demo server whose
 * fakes answer that connection (tools.ts practiceRow); a real Higgsfield connection keeps the service's own titles.
 * tests/unit/google-tool-titles.test.ts: every fake tool in every language. */
export const DEMO_HIGGSFIELD_TOOL_WORDS: Record<string, T> = {
  generate_image: t('이미지 만들기', 'Generate image', 'Buat gambar', '画像を生成', 'Generar imagen', '生成图片'),
  generate_video: t('영상 만들기', 'Generate video', 'Buat video', '動画を生成', 'Generar video', '生成视频'),
  job_display: t('작업 보기', 'Get job', 'Lihat pekerjaan', 'ジョブを表示', 'Ver trabajo', '查看任务'),
  show_generations: t('만든 이미지 보기', 'List generations', 'Lihat hasil buatan', '生成履歴を見る', 'Ver creaciones', '查看生成记录'),
  balance: t('크레딧 보기', 'Balance', 'Lihat saldo', 'クレジットを見る', 'Ver saldo', '查看余额'),
}
/** a demo Higgsfield tool's words in `L` (DEMO_HIGGSFIELD_TOOL_WORDS), or null for a tool not listed there */
export const demoHiggsfieldToolWord = (name: string, L: Locale): string | null =>
  Object.hasOwn(DEMO_HIGGSFIELD_TOOL_WORDS, name) ? DEMO_HIGGSFIELD_TOOL_WORDS[name]![L] ?? DEMO_HIGGSFIELD_TOOL_WORDS[name]!.en : null
/** a reason a connection check failed (integrations.last_error holds "<reason>", "<reason>:<status>" or, for no_access,
 * "no_access:<status>:<the service's words>": refusal.ts codeParts) */
export type Reason = 'unreachable' | 'timeout' | 'list_timeout' | 'call_idle' | 'call_timeout' | 'private_address' | 'blocked_port' | 'tls' | 'refused' | 'scope' | 'no_access' | 'no_secret' | 'sign_in' | 'redirect'
  | 'http_status' | 'not_mcp' | 'too_large' | 'oauth_unsupported' | 'oauth_no_registration' | 'oauth_no_registration_member' | 'oauth_needs_team_app' | 'oauth_approved_apps_only' | 'oauth_desktop_only' | 'oauth_busy' | 'oauth_failed' | 'key_unsafe' | 'local_offline' | 'local_declined' | 'local_confirm' | 'local_failed' | 'local_missing' | 'local_share' | 'local_unsupported' | 'local_unsafe'

/** a placeholder and a Korean particle mark right after it ("{name}은(는)"), as the web app's i18n format reads them */
const PARTICLE_AFTER = new RegExp(`\\{(\\w+)\\}(${KO_PARTICLE_PATTERN})?`, 'g')

export const say = (key: TextKey, locale: Locale, vars: Record<string, string | number> = {}) =>
  // no second honorific after a name that has one ("{by}님이" with 대표님, shared/src/honorific.ts); a Korean particle
  // after a value in the form the value takes when read aloud ("Canva는", "Intercom은": shared/src/ko-particle.ts)
  dropDoubleHonorifics(TEXT[key][locale] ?? TEXT[key].en, vars).replace(PARTICLE_AFTER, (all, k: string, mark?: string) => {
    if (!(k in vars)) return all
    const v = String(vars[k])
    return v + (mark ? (locale === 'ko' ? koParticle(v, mark) : mark) : '')
  })

/** Reasons whose fix is the connection's address (or that read as such: a reason this server does not know). */
const ADDRESS_REASONS: ReadonlySet<string> = new Set<Reason>(['unreachable', 'private_address', 'blocked_port', 'redirect', 'not_mcp'])
/** Reasons whose fix is the connection's key or sign-in. */
const KEY_REASONS: ReadonlySet<string> = new Set<Reason>(['refused', 'scope', 'no_secret', 'sign_in', 'oauth_unsupported', 'oauth_no_registration', 'oauth_needs_team_app', 'oauth_approved_apps_only', 'oauth_desktop_only', 'oauth_failed'])

/**
 * The stored code in words ("refused:401" -> "The service did not accept the key ... (HTTP 401)"), for a reader who can
 * fix it (`name`: the connection's, for a reason that names it). `can`: what this reader can change (store.ts view): the address (whoever manages the connection, not on one
 * made from a team template) and the key or sign-in (whoever manages it). A reason only someone else can fix says what
 * happened and "Tell your admin." instead of "Check the address" (QA TC-235).
 */
export function reasonText(code: string | null, locale: Locale, can: { address: boolean; key: boolean } = { address: true, key: true }, name?: string): string | null {
  if (!code) return null
  // as refusal.ts codeParts (not imported: the web app's mock server reads this file, and refusal.ts reaches the chat code)
  const [reason, status, ...rest] = code.split(':')
  const said = rest.join(':')
  const known = !!reason && reason in TEXT
  if (!can.address && (!known || ADDRESS_REASONS.has(reason!))) return say('addressMember', locale)
  if (!can.key && KEY_REASONS.has(reason!)) return say('keyMember', locale)
  if (!known) return say('unreachable', locale)
  const key = reason === 'no_access' && !said ? 'no_access_bare' : reason as TextKey
  return say(key, locale, { status: status || '?', ...(said ? { said } : {}), ...(name ? { name } : {}), ...(reason === 'local_unsafe' ? { chars: BATCH_REFUSED.join(' ') } : {}) })
}
