// Words people see for external-service connections (docs/INTEGRATIONS.md): the server's confirmation card, API
// refusals and why a connection check failed (lastError, stored as a code and put into words for each reader).
import type { Locale } from '@mycel/shared/api'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

export const TEXT = {
  // the card before a call that changes something at the service: {what} is the tool's title (MCP `title`, else its id
  // in words) or, for an HTTP API, what the method does (methodPost …); card-lines.ts
  confirm: t('AI가 {name}에 이 내용을 보내려고 해요: {what}', 'The AI wants to send this to {name}: {what}', 'AI ingin mengirim ini ke {name}: {what}', "AIが{name}に次の内容を送ろうとしています：{what}", "La IA quiere enviar esto a {name}: {what}", "AI 想把这个发送到{name}：{what}"),
  // an HTTP API call: {what} is what its method does (methodDELETE …), so the sentence names a request, not "this"
  confirmRequest: t('AI가 {name}에 이 요청을 보내려고 해요: {what}', 'The AI wants to send this request to {name}: {what}', 'AI ingin mengirim permintaan ini ke {name}: {what}', "AIが{name}に次のリクエストを送ろうとしています：{what}", "La IA quiere enviar esta solicitud a {name}: {what}", "AI 想向{name}发送这个请求：{what}"),
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
  requestPersonalOff: t('지금은 직원이 개인 연결을 추가할 수 없어요. 먼저 팀 설정에서 "직원이 개인 연결을 추가할 수 있음"을 켜 주세요.', 'Members cannot add their own connections now. First turn on "Members can add their own connections" in Team settings.', 'Anggota tidak bisa menambah koneksi sendiri sekarang. Nyalakan dulu "Anggota dapat menambah koneksi pribadi" di Pengaturan tim.', "現在、メンバーは個人接続を追加できません。先にチーム設定で「メンバーによる個人接続の追加を許可」をオンにしてください。", "Ahora los miembros no pueden añadir sus propias conexiones. Active primero «Los miembros pueden añadir sus propias conexiones» en la configuración del equipo.", "成员现在不能添加自己的连接。请先在“团队设置”中打开“成员可以添加自己的连接”。"),
  requestNoUser: t('이 팀에서 쓰고 있는 계정이 아니에요.', 'This is not an active account of the team.', 'Ini bukan akun aktif di tim.', "このチームの有効なアカウントではありません。", "No es una cuenta activa del equipo.", "这不是团队中的有效账号。"),
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
  callbackFail: t('로그인을 마치지 못했어요. 이 창을 닫고, 이 브라우저에서 같은 계정으로 로그인한 뒤 앱에서 다시 시작해 주세요.', 'The sign-in could not be completed. Close this window, sign in to the same team account in this browser, then start again from the app.', 'Login tidak dapat diselesaikan. Tutup jendela ini, login ke akun tim yang sama di browser ini, lalu mulai lagi dari aplikasi.', "ログインを完了できませんでした。このウィンドウを閉じ、このブラウザーで同じチームアカウントにログインしてから、アプリでやり直してください。", "No se pudo completar el inicio de sesión. Cierre esta ventana, inicie sesión en la misma cuenta del equipo en este navegador y vuelva a empezar desde la aplicación.", "无法完成登录。请关闭这个窗口，在这个浏览器中登录同一个团队账号，然后从应用重新开始。"),
  // a sign-in the service did not finish (CallbackResult.reason): what happened, in plain words, and what to do; never
  // the service's own answer
  callbackClient: t('서비스가 이 앱의 Client ID나 Secret을 받아들이지 않았어요. 이 창을 닫고, 연결 편집의 고급에서 Secret을 확인한 뒤 다시 로그인해 주세요.', 'The service did not accept this app’s Client ID or Secret. Close this window, check the Secret under Advanced when you edit the connection, then sign in again.', 'Layanan tidak menerima Client ID atau Secret aplikasi ini. Tutup jendela ini, periksa Secret di Lanjutan saat mengedit koneksi, lalu login lagi.', "サービスがこのアプリのクライアントIDまたはシークレットを受け付けませんでした。このウィンドウを閉じ、接続の編集の「詳細設定」でシークレットを確認してから、もう一度ログインしてください。", "El servicio no aceptó el ID de cliente ni el secreto de esta aplicación. Cierre esta ventana, revise el secreto en Avanzado al editar la conexión y vuelva a iniciar sesión.", "服务没有接受这个应用的客户端 ID 或密钥。请关闭这个窗口，编辑连接时在“高级”中检查密钥，然后重新登录。"),
  callbackClientTemplate: t('서비스가 이 연결에 쓰는 앱의 Client ID나 Secret을 받아들이지 않았어요. 이 창을 닫고, 이 연결을 설정한 사람에게 Client ID와 Secret을 확인해 달라고 요청해 주세요.', 'The service did not accept the Client ID or Secret of the app this connection uses. Close this window and ask the person who set up this connection to check its Client ID and Secret.', 'Layanan tidak menerima Client ID atau Secret aplikasi yang dipakai koneksi ini. Tutup jendela ini dan minta orang yang menyiapkan koneksi ini untuk memeriksa Client ID dan Secret-nya.', "サービスが、この接続で使うアプリのクライアントIDまたはシークレットを受け付けませんでした。このウィンドウを閉じ、この接続を設定した人にクライアントIDとシークレットの確認を依頼してください。", "El servicio no aceptó el ID de cliente ni el secreto de la aplicación que usa esta conexión. Cierre esta ventana y pida a quien configuró esta conexión que revise su ID de cliente y su secreto.", "服务没有接受这个连接所用应用的客户端 ID 或密钥。请关闭这个窗口，请设置这个连接的人检查它的客户端 ID 和密钥。"),
  callbackDenied: t('서비스에서 접근을 허용하지 않았어요. 연결하려면 이 창을 닫고 앱에서 다시 로그인해 주세요.', 'Access was not allowed at the service. To connect, close this window and sign in again from the app.', 'Akses tidak diizinkan di layanan. Untuk menghubungkan, tutup jendela ini lalu login lagi dari aplikasi.', "サービスでアクセスが許可されませんでした。接続するには、このウィンドウを閉じてアプリからもう一度ログインしてください。", "No se permitió el acceso en el servicio. Para conectar, cierre esta ventana y vuelva a iniciar sesión desde la aplicación.", "服务没有允许访问。要连接的话，请关闭这个窗口，从应用重新登录。"),
  callbackChanged: t('로그인하는 동안 연결 설정이 바뀌었어요. 이 창을 닫고 앱에서 다시 로그인해 주세요.', 'The connection’s settings changed while you were signing in. Close this window and sign in again from the app.', 'Pengaturan koneksi berubah saat Anda login. Tutup jendela ini lalu login lagi dari aplikasi.', "ログイン中に接続の設定が変更されました。このウィンドウを閉じて、アプリからもう一度ログインしてください。", "La configuración de la conexión cambió mientras iniciaba sesión. Cierre esta ventana y vuelva a iniciar sesión desde la aplicación.", "登录期间连接的设置被更改了。请关闭这个窗口，从应用重新登录。"),
  callbackCancelled: t('앱에서 이 로그인을 취소했어요. 이 창을 닫고, 연결하려면 앱에서 다시 연결해 주세요.', 'This sign-in was cancelled in the app. Close this window; to connect, connect again from the app.', 'Login ini dibatalkan di aplikasi. Tutup jendela ini; untuk menghubungkan, hubungkan lagi dari aplikasi.', "このサインインはアプリでキャンセルされました。このウィンドウを閉じ、接続するにはアプリからもう一度接続してください。", "Este inicio de sesión se canceló en la aplicación. Cierre esta ventana; para conectar, vuelva a conectar desde la aplicación.", "这次登录已在应用中取消。请关闭此窗口；如需连接，请在应用中重新连接。"),
  callbackExchange: t('서비스가 로그인을 마무리하지 못했어요. 이 창을 닫고 앱에서 다시 로그인해 주세요.', 'The service did not finish the sign-in. Close this window and sign in again from the app.', 'Layanan tidak menyelesaikan login. Tutup jendela ini lalu login lagi dari aplikasi.', "サービスがログインを完了できませんでした。このウィンドウを閉じて、アプリからもう一度ログインしてください。", "El servicio no terminó el inicio de sesión. Cierre esta ventana y vuelva a iniciar sesión desde la aplicación.", "服务没有完成登录。请关闭这个窗口，从应用重新登录。"),
  callbackLogin: t('팀 계정에 로그인', 'Sign in to the team account', 'Login ke akun tim', "チームアカウントにログイン", "Iniciar sesión en la cuenta del equipo", "登录团队账号"),
  // why a check failed (lastError)
  unreachable: t('서비스에 연결하지 못했어요. 주소를 확인해 주세요.', 'Could not reach the service. Check the address.', 'Tidak dapat menghubungi layanan. Periksa alamatnya.', "サービスに接続できませんでした。アドレスを確認してください。", "No se pudo conectar con el servicio. Revise la dirección.", "无法连接到服务。请检查地址。"),
  timeout: t('서비스가 30초 안에 답하지 않았어요.', 'The service did not answer within 30 seconds.', 'Layanan tidak menjawab dalam 30 detik.', "サービスが30秒以内に応答しませんでした。", "El servicio no respondió en 30 segundos.", "服务在30秒内没有回应。"),
  // its tools/list kept coming but did not end in time (mcp.ts MCP_LIST_TIMEOUT_MS)
  list_timeout: t('서비스가 90초 안에 도구 목록을 다 보내지 않았어요.', 'The service did not send its whole tool list within 90 seconds.', 'Layanan tidak mengirim seluruh daftar alatnya dalam 90 detik.', "サービスが90秒以内にツール一覧をすべて送信しませんでした。", "El servicio no envió su lista completa de herramientas en 90 segundos.", "服务没有在90秒内发送完整的工具列表。"),
  private_address: t('사내망이나 이 서버의 주소에는 연결할 수 없어요. 인터넷의 공개 주소를 넣어 주세요.', 'Addresses on the office network or of this server cannot be used. Use a public internet address.', 'Alamat di jaringan kantor atau server ini tidak bisa dipakai. Pakai alamat publik di internet.', "社内ネットワークやこのサーバーのアドレスは使用できません。公開インターネットアドレスを使ってください。", "No se pueden usar direcciones de la red interna ni de este servidor. Use una dirección pública de internet.", "不能使用办公室网络或这台服务器上的地址。请使用公网地址。"),
  blocked_port: t('https 기본 포트(443)만 쓸 수 있어요.', 'Only the standard https port (443) can be used.', 'Hanya port https standar (443) yang bisa dipakai.', "標準のhttpsポート（443）のみ使用できます。", "Solo se puede usar el puerto https estándar (443).", "只能使用标准 https 端口（443）。"),
  tls: t('서비스의 보안 인증서를 확인하지 못했어요.', 'The service’s security certificate could not be verified.', 'Sertifikat keamanan layanan tidak dapat diverifikasi.', "サービスのセキュリティ証明書を確認できませんでした。", "No se pudo verificar el certificado de seguridad del servicio.", "无法验证服务的安全证书。"),
  refused: t('서비스가 키나 로그인을 받아 주지 않았어요(HTTP {status}). 키를 다시 넣거나 다시 로그인해 주세요.', 'The service did not accept the key or sign-in (HTTP {status}). Enter the key again or sign in again.', 'Layanan tidak menerima kunci atau login (HTTP {status}). Masukkan kunci lagi atau login ulang.', "サービスがキーまたはログインを受け付けませんでした（HTTP {status}）。キーを再入力するか、再ログインしてください。", "El servicio no aceptó la clave o el inicio de sesión (HTTP {status}). Introduzca la clave de nuevo o vuelva a iniciar sesión.", "服务没有接受密钥或登录（HTTP {status}）。请重新输入密钥或重新登录。"),
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
  oauth_failed: t('로그인을 마치지 못했어요. 다시 시도해 주세요.', 'Signing in did not finish. Try again.', 'Login tidak selesai. Coba lagi.', "ログインを完了できませんでした。再試行してください。", "No se completó el inicio de sesión. Vuelva a intentarlo.", "登录没有完成。请重试。"),
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
/** a reason a connection check failed (integrations.last_error holds "<reason>" or "<reason>:<status>") */
export type Reason = 'unreachable' | 'timeout' | 'list_timeout' | 'private_address' | 'blocked_port' | 'tls' | 'refused' | 'no_secret' | 'sign_in' | 'redirect'
  | 'http_status' | 'not_mcp' | 'too_large' | 'oauth_unsupported' | 'oauth_no_registration' | 'oauth_no_registration_member' | 'oauth_failed' | 'key_unsafe'

export const say = (key: TextKey, locale: Locale, vars: Record<string, string | number> = {}) =>
  // no second honorific after a name that has one ("{by}님이" with 대표님, shared/src/honorific.ts)
  dropDoubleHonorifics(TEXT[key][locale] ?? TEXT[key].en, vars).replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all))

/** Reasons whose fix is the connection's address (or that read as such: a reason this server does not know). */
const ADDRESS_REASONS: ReadonlySet<string> = new Set<Reason>(['unreachable', 'private_address', 'blocked_port', 'redirect', 'not_mcp'])
/** Reasons whose fix is the connection's key or sign-in. */
const KEY_REASONS: ReadonlySet<string> = new Set<Reason>(['refused', 'no_secret', 'sign_in', 'oauth_unsupported', 'oauth_no_registration', 'oauth_failed'])

/**
 * The stored code in words ("refused:401" -> "The service did not accept the key ... (HTTP 401)"), for a reader who can
 * fix it. `can`: what this reader can change (store.ts view): the address (whoever manages the connection, not on one
 * made from a team template) and the key or sign-in (whoever manages it). A reason only someone else can fix says what
 * happened and "Tell your admin." instead of "Check the address" (QA TC-235).
 */
export function reasonText(code: string | null, locale: Locale, can: { address: boolean; key: boolean } = { address: true, key: true }): string | null {
  if (!code) return null
  const [reason, status] = code.split(':')
  const known = !!reason && reason in TEXT
  if (!can.address && (!known || ADDRESS_REASONS.has(reason!))) return say('addressMember', locale)
  if (!can.key && KEY_REASONS.has(reason!)) return say('keyMember', locale)
  if (!known) return say('unreachable', locale)
  return say(reason as TextKey, locale, { status: status ?? '?' })
}
