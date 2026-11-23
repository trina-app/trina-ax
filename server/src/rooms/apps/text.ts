// The words an app's cards and lines carry (docs/DECISIONS.md "Apps posting in rooms"). Written by the server in the
// team's language when the card is posted (like event lines), so search, push and the AI see what people see. English
// is the source; Slack's own terms where a service's screen is named (owner decision 3 of plan 20261114-1522: "Webhook
// URL", a vendor's "Reveal secret").
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

export const APP_TEXT = {
  // Email (plan 20261123-0421-room-email). Written once into each card in the team's language
  nameEmail: t('이메일', 'Email', 'Email', 'メール', 'Correo', "邮件"),
  mailKind: t('이메일 · 보낸 사람 {from} (확인 안 됨)', 'Email · From {from} (unverified)', 'Email · Dari {from} (belum diverifikasi)', 'メール · 差出人 {from}（未確認）', 'Correo · De {from} (sin verificar)', "邮件 · 发件人 {from}（未验证）"),
  mailNoSubject: t('(제목 없음)', '(no subject)', '(tanpa subjek)', '(件名なし)', '(sin asunto)', "（无主题）"),
  mailNoSender: t('(보낸 사람 없음)', '(no valid sender)', '(pengirim tidak valid)', '(差出人なし)', '(remitente no válido)', "（无有效发件人）"),
  mailAttachments: t('첨부 {n}개는 보관하지 않음: {names}', '{n} attachments not kept: {names}', '{n} lampiran tidak disimpan: {names}', '添付 {n} 件は保存されません: {names}', '{n} adjuntos no guardados: {names}', "{n} 个附件未保存：{names}"),
  mailCut: t('(메일이 길어서 뒷부분은 생략했어요)', '(The mail is long: the rest is not shown.)', '(Email panjang: sisanya tidak ditampilkan.)', '(メールが長いため、残りは表示されません。)', '(El correo es largo: el resto no se muestra.)', "（邮件较长：其余部分未显示。）"),
  mailConfirmLine: t('{provider}에서 이 대화방으로 메일 전달을 확인해 달라고 해요. 앱을 관리하는 사람은 앱 설정에서 코드를 볼 수 있어요.', '{provider} asks to confirm forwarding to this conversation. People who manage its apps see the code in the app\'s settings.', '{provider} meminta konfirmasi penerusan ke percakapan ini. Orang yang mengelola aplikasinya melihat kodenya di pengaturan aplikasi.', '{provider} がこの会話への転送の確認を求めています。アプリを管理する人はアプリの設定でコードを確認できます。', '{provider} pide confirmar el reenvío a esta conversación. Quienes gestionan sus aplicaciones ven el código en los ajustes de la aplicación.', "{provider} 请求确认转发到此对话。管理其应用的人可在应用设置中查看代码。"),
  mailEmailOff: t('관리자가 팀 설정에서 "대화방에서 이메일 받기"를 켜야 해요.', 'An admin must turn on "Let rooms get email" in Team settings.', 'Admin harus mengaktifkan "Izinkan ruang menerima email" di Pengaturan tim.', '管理者がチーム設定で「会話でメールを受け取る」をオンにする必要があります。', 'Un administrador debe activar "Permitir que las salas reciban correo" en Ajustes del equipo.', "管理员必须在团队设置中打开“允许对话接收邮件”。"),
  mailNotConnected: t('이메일은 이 서버가 Trina 서비스에 연결되어 있어야 쓸 수 있어요.', 'Email needs this server to be connected to the Trina service.', 'Email memerlukan server ini terhubung ke layanan Trina.', 'メールを使うには、このサーバーが Trina サービスに接続されている必要があります。', 'El correo necesita que este servidor esté conectado al servicio de Trina.', "邮件需要此服务器连接到 Trina 服务。"),
  mailOneOnly: t('이 대화방에는 이미 이메일 주소가 있어요.', 'This conversation has an email address already.', 'Percakapan ini sudah punya alamat email.', 'この会話にはすでにメールアドレスがあります。', 'Esta conversación ya tiene una dirección de correo.', "此对话已有邮件地址。"),
  // Sentry
  sentryNew: t('새 이슈', 'New issue', 'Masalah baru', '新しい問題', 'Nuevo problema', "新问题"),
  sentryBack: t('이슈가 다시 생겼어요', 'Issue came back', 'Masalah muncul lagi', '問題が再発しました', 'El problema volvió', "问题再次出现"),
  sentryResolvedBy: t('{actor} 님이 해결함', 'Resolved by {actor}', 'Diselesaikan oleh {actor}', '{actor}さんが解決', 'Resuelto por {actor}', "由 {actor} 解决"),
  sentryResolved: t('해결됨', 'Resolved', 'Diselesaikan', '解決済み', 'Resuelto', "已解决"),
  sentryArchived: t('보관됨', 'Archived', 'Diarsipkan', 'アーカイブ済み', 'Archivado', "已归档"),
  sentryAssigned: t('{name} 님에게 배정됨', 'Assigned to {name}', 'Ditugaskan ke {name}', '{name}さんに割り当て', 'Asignado a {name}', "已分配给 {name}"),
  sentryAlert: t('알림 규칙 실행: {rule}', 'Alert fired: {rule}', 'Peringatan aktif: {rule}', 'アラート発生: {rule}', 'Alerta activada: {rule}', "告警触发：{rule}"),
  sentryMetric: t('지표 알림: {status}', 'Metric alert: {status}', 'Peringatan metrik: {status}', 'メトリクスアラート: {status}', 'Alerta de métrica: {status}', "指标告警：{status}"),
  statusUnresolved: t('미해결', 'Unresolved', 'Belum selesai', '未解決', 'Sin resolver', "未解决"),
  // GitHub
  prOpened: t('풀 리퀘스트 열림', 'Pull request opened', 'Pull request dibuka', 'プルリクエストが作成されました', 'Pull request abierta', "拉取请求已创建"),
  prReopened: t('풀 리퀘스트 다시 열림', 'Pull request reopened', 'Pull request dibuka lagi', 'プルリクエストが再オープンされました', 'Pull request reabierta', "拉取请求已重新打开"),
  prReady: t('리뷰 준비됨', 'Ready for review', 'Siap ditinjau', 'レビュー準備完了', 'Lista para revisión', "可以审查了"),
  prMerged: t('풀 리퀘스트 병합됨', 'Pull request merged', 'Pull request digabung', 'プルリクエストがマージされました', 'Pull request fusionada', "拉取请求已合并"),
  prClosed: t('풀 리퀘스트 닫힘', 'Pull request closed', 'Pull request ditutup', 'プルリクエストがクローズされました', 'Pull request cerrada', "拉取请求已关闭"),
  issueOpened: t('이슈 열림', 'Issue opened', 'Isu dibuka', 'イシューが作成されました', 'Incidencia abierta', "议题已创建"),
  issueClosed: t('이슈 닫힘', 'Issue closed', 'Isu ditutup', 'イシューがクローズされました', 'Incidencia cerrada', "议题已关闭"),
  issueReopened: t('이슈 다시 열림', 'Issue reopened', 'Isu dibuka lagi', 'イシューが再オープンされました', 'Incidencia reabierta', "议题已重新打开"),
  checksFailed: t('검사 실패: {workflow}', 'Checks failed: {workflow}', 'Pemeriksaan gagal: {workflow}', 'チェック失敗: {workflow}', 'Comprobaciones fallidas: {workflow}', "检查失败：{workflow}"),
  release: t('릴리스 게시: {tag}', 'Release published: {tag}', 'Rilis diterbitkan: {tag}', 'リリース公開: {tag}', 'Versión publicada: {tag}', "已发布版本：{tag}"),
  pushedOne: t('{branch}에 커밋 1개 푸시', 'Pushed 1 commit to {branch}', 'Mengirim 1 commit ke {branch}', '{branch} に1件のコミットをプッシュ', 'Se envió 1 commit a {branch}', "向 {branch} 推送了 1 个提交"),
  pushedMany: t('{branch}에 커밋 {n}개 푸시', 'Pushed {n} commits to {branch}', 'Mengirim {n} commit ke {branch}', '{branch} に{n}件のコミットをプッシュ', 'Se enviaron {n} commits a {branch}', "向 {branch} 推送了 {n} 个提交"),
  byActor: t('{actor} 님', 'by {actor}', 'oleh {actor}', '{actor}さん', 'por {actor}', "来自 {actor}"),
  statusOpen: t('열림', 'Open', 'Terbuka', 'オープン', 'Abierta', "打开"),
  statusMerged: t('병합됨', 'Merged', 'Digabung', 'マージ済み', 'Fusionada', "已合并"),
  statusClosed: t('닫힘', 'Closed', 'Ditutup', 'クローズ', 'Cerrada', "已关闭"),
  statusFailed: t('실패', 'Failed', 'Gagal', '失敗', 'Fallida', "失败"),
  // Google Forms
  formsNew: t('{form}에 새 응답', 'New response to {form}', 'Tanggapan baru untuk {form}', '{form} への新しい回答', 'Nueva respuesta a {form}', "{form} 有新回复"),
  formsEdited: t('응답이 수정됨', 'Response edited', 'Tanggapan diubah', '回答が編集されました', 'Respuesta editada', "回复已修改"),
  formsEmail: t('이메일: {email}', 'Email: {email}', 'Email: {email}', 'メール: {email}', 'Correo: {email}', "邮箱：{email}"),
  // a Google Forms file-upload answer: how many files (the script sends no names, see roomAppFormsScript)
  formsFiles1: t('파일 1개', '1 file', '1 file', 'ファイル1件', '1 archivo', "1 个文件"),
  formsFilesN: t('파일 {n}개', '{n} files', '{n} file', 'ファイル{n}件', '{n} archivos', "{n} 个文件"),
  formsMore: t('답변 {n}개 더', '{n} more answers', '{n} jawaban lagi', 'ほか{n}件の回答', '{n} respuestas más', "还有 {n} 个回答"),
  // the names an app gets when it is added, in the team's language (Sentry and GitHub keep theirs)
  nameForms: t('Google 설문지', 'Google Forms', 'Google Formulir', 'Google フォーム', 'Formularios de Google', "Google 表单"),
  nameOther: t('다른 앱', 'Other app', 'Aplikasi lain', 'その他のアプリ', 'Otra aplicación', "其他应用"),
  // every app
  status: t('상태: {status}', 'Status: {status}', 'Status: {status}', '状態: {status}', 'Estado: {status}', "状态：{status}"),
  example: t('예시', 'Example', 'Contoh', '例', 'Ejemplo', "示例"),
  exampleTitle: t('{app}의 메시지가 여기에 이렇게 보여요', 'This is how messages from {app} look here', 'Beginilah pesan dari {app} tampil di sini', '{app} からのメッセージはここにこう表示されます', 'Así se ven aquí los mensajes de {app}', "来自 {app} 的消息在这里会这样显示"),
  pausedLine: t('{app}이(가) 오늘 메시지 {cap}개에 도달해 멈췄어요. 내일 다시 시작해요.', '{app} reached {cap} messages today and was paused. It starts again tomorrow.', '{app} mencapai {cap} pesan hari ini dan dijeda. Mulai lagi besok.', '{app} は今日 {cap} 件のメッセージに達したため一時停止しました。明日また始まります。', '{app} llegó a {cap} mensajes hoy y se pausó. Vuelve a empezar mañana.', "{app} 今天已达到 {cap} 条消息，已暂停。明天会重新开始。"),
  resumedLine: t('{name} 님이 오늘 {app}을(를) 다시 켰어요.', '{name} turned {app} back on for today.', '{name} menyalakan {app} lagi untuk hari ini.', '{name}さんが今日の {app} を再開しました。', '{name} volvió a activar {app} por hoy.', "{name} 已在今天重新开启 {app}。"),
  someone: t('누군가', 'Someone', 'Seseorang', '誰か', 'Alguien', "有人"),
  // refusals of the management API
  nameIsPerson: t('이 팀 사람의 이름과 다른 이름을 골라 주세요.', "Pick a name that isn't a person's in this team.", 'Pilih nama yang bukan nama orang di tim ini.', 'このチームの人の名前ではない名前を選んでください。', 'Elija un nombre que no sea el de una persona de este equipo.', "请选择一个不是本团队成员名字的名称。"),
  sentrySecretShape: t('Sentry의 Client Secret 같지 않아요.', "That doesn't look like a Sentry Client Secret.", 'Itu tidak terlihat seperti Client Secret Sentry.', 'Sentry の Client Secret ではないようです。', 'Eso no parece un Client Secret de Sentry.', "这看起来不像 Sentry 的 Client Secret。"),
  noAddress: t('앱이 이 서버에 닿으려면 인터넷 주소가 있어야 하는데 아직 없어요.', "Apps need this server to have an internet address, and it doesn't have one yet.", 'Aplikasi memerlukan alamat internet untuk server ini, dan server ini belum memilikinya.', 'アプリがこのサーバーに届くにはインターネットアドレスが必要ですが、まだありません。', 'Las aplicaciones necesitan que este servidor tenga una dirección de internet, y todavía no la tiene.', "应用需要此服务器有一个互联网地址，但目前还没有。"),
  full: t('이 대화에는 앱이 {max}개 있어요. 하나를 빼야 다른 앱을 추가할 수 있어요.', 'This conversation has {max} apps. Remove one to add another.', 'Percakapan ini punya {max} aplikasi. Hapus satu untuk menambah yang lain.', 'このトークにはアプリが{max}個あります。別のアプリを追加するには1つ削除してください。', 'Esta conversación tiene {max} aplicaciones. Quite una para añadir otra.', "这个聊天已有 {max} 个应用。请先移除一个再添加。"),
  // the hourly limits (429 with retryAfter): how long to wait, never "shortly" when it is most of an hour (QA 2026-11-15)
  addLimit: t('앱은 한 시간에 {n}개까지 추가할 수 있어요. {minutes}분 뒤에 다시 해 주세요.', 'You can add up to {n} apps an hour. Try again in {minutes} min.', 'Anda bisa menambah hingga {n} aplikasi per jam. Coba lagi dalam {minutes} menit.', 'アプリは1時間に{n}個まで追加できます。{minutes}分後にもう一度お試しください。', 'Puede añadir hasta {n} aplicaciones por hora. Inténtelo de nuevo en {minutes} min.', "每小时最多可以添加 {n} 个应用。请在 {minutes} 分钟后重试。"),
  exampleLimit: t('예시는 한 시간에 {n}번까지 보낼 수 있어요. {minutes}분 뒤에 다시 해 주세요.', 'You can show up to {n} examples an hour. Try again in {minutes} min.', 'Anda bisa menampilkan hingga {n} contoh per jam. Coba lagi dalam {minutes} menit.', '例は1時間に{n}回まで表示できます。{minutes}分後にもう一度お試しください。', 'Puede mostrar hasta {n} ejemplos por hora. Inténtelo de nuevo en {minutes} min.', "每小时最多可以显示 {n} 个示例。请在 {minutes} 分钟后重试。"),
  // a pasted secret of the wrong shape, named as the service's own field is (Toss Payments' "Security key", PortOne's
  // "Webhook secret"); Stripe's field is its "Signing secret" (presetSecretShape)
  tossKeyShape: t('토스페이먼츠 보안 키 같지 않아요.', "That doesn't look like a Toss Payments security key.", 'Itu tidak terlihat seperti kunci keamanan Toss Payments.', 'Toss Payments のセキュリティキーではないようです。', 'Eso no parece una clave de seguridad de Toss Payments.', "这看起来不像 Toss Payments 的安全密钥。"),
  portoneSecretShape: t('포트원 웹훅 시크릿 같지 않아요.', "That doesn't look like a PortOne webhook secret.", 'Itu tidak terlihat seperti rahasia webhook PortOne.', 'PortOne の Webhook シークレットではないようです。', 'Eso no parece un secreto de webhook de PortOne.', "这看起来不像 PortOne 的 Webhook 密钥。"),
  notPaused: t('이 앱은 멈춰 있지 않아요.', "This app isn't paused.", 'Aplikasi ini tidak dijeda.', 'このアプリは一時停止していません。', 'Esta aplicación no está en pausa.', "此应用没有暂停。"),
  alreadyResumed: t('오늘은 이미 한 번 다시 켰어요. 내일 다시 시작해요.', 'It was already turned back on once today. It starts again tomorrow.', 'Aplikasi ini sudah dinyalakan lagi sekali hari ini. Mulai lagi besok.', '今日はすでに一度再開しています。明日また始まります。', 'Ya se volvió a activar una vez hoy. Vuelve a empezar mañana.', "今天已经重新开启过一次。明天会重新开始。"),
  teamCap: t('오늘 팀의 앱 메시지가 모두 합쳐 {cap}개에 도달했어요. {time}까지 모든 앱이 멈춰요.', "Your team's apps reached {cap} messages today. All apps are paused until {time}.", 'Aplikasi tim Anda mencapai {cap} pesan hari ini. Semua aplikasi dijeda sampai {time}.', 'チームのアプリは今日合わせて {cap} 件のメッセージに達しました。{time} まですべてのアプリが一時停止します。', 'Las aplicaciones de su equipo llegaron a {cap} mensajes hoy. Todas las aplicaciones están en pausa hasta {time}.', "你们团队的应用今天共达到 {cap} 条消息。所有应用暂停到 {time}。"),
  noSecretForKind: t('이 앱에는 비밀값을 쓸 수 없어요.', "This app doesn't take a secret.", 'Aplikasi ini tidak memakai rahasia.', 'このアプリにはシークレットを設定できません。', 'Esta aplicación no admite un secreto.', "此应用不使用密钥。"),
  // presets (plan 20261114-1522 "Presets"): the vendors' names stay as they are
  notionUpdated: t('페이지가 업데이트됨', 'Page updated', 'Halaman diperbarui', 'ページが更新されました', 'Página actualizada', "页面已更新"),
  notionLinked: t('연결된 항목 {n}개', '{n} linked', '{n} tertaut', 'リンク {n}件', '{n} vinculados', "已关联 {n} 项"),
  paymentReceived: t('결제 완료', 'Payment received', 'Pembayaran diterima', '支払いを受け取りました', 'Pago recibido', "已收到付款"),
  refunded: t('환불됨', 'Refunded', 'Dikembalikan', '返金済み', 'Reembolsado', "已退款"),
  paymentFailed: t('결제 실패', 'Payment failed', 'Pembayaran gagal', '支払いに失敗しました', 'Pago fallido', "付款失败"),
  disputeOpened: t('이의 제기 접수됨', 'Dispute opened', 'Sengketa dibuka', '異議申し立てが開始されました', 'Disputa abierta', "已发起争议"),
  subscriptionEnded: t('구독 종료', 'Subscription ended', 'Langganan berakhir', 'サブスクリプション終了', 'Suscripción finalizada', "订阅已结束"),
  subscriptionNew: t('새 구독', 'New subscription', 'Langganan baru', '新しいサブスクリプション', 'Nueva suscripción', "新订阅"),
  testMode: t('테스트 모드', 'Test mode', 'Mode uji', 'テストモード', 'Modo de prueba', "测试模式"),
  amountFrom: t('{name} 님이 {amount} 결제', '{amount} from {name}', '{amount} dari {name}', '{name}さんから {amount}', '{amount} de {name}', "来自 {name} 的 {amount}"),
  refundedAmount: t('{amount} 환불됨', 'Refunded {amount}', '{amount} dikembalikan', '{amount} を返金', 'Reembolsado: {amount}', "已退款 {amount}"),
  reason: t('사유: {reason}', 'Reason: {reason}', 'Alasan: {reason}', '理由: {reason}', 'Motivo: {reason}', "原因：{reason}"),
  statusSucceeded: t('완료', 'Succeeded', 'Berhasil', '成功', 'Completado', "成功"),
  statusRefunded: t('환불됨', 'Refunded', 'Dikembalikan', '返金済み', 'Reembolsado', "已退款"),
  statusDisputed: t('이의 제기됨', 'Disputed', 'Disengketakan', '異議申し立て中', 'En disputa', "争议中"),
  statusEnded: t('종료됨', 'Ended', 'Berakhir', '終了', 'Finalizada', "已结束"),
  statusActive: t('사용 중', 'Active', 'Aktif', '有効', 'Activa', "有效"),
  statusPaid: t('결제됨', 'Paid', 'Dibayar', '支払い済み', 'Pagado', "已付款"),
  statusPending: t('대기 중', 'Pending', 'Tertunda', '保留中', 'Pendiente', "待处理"),
  statusCancelled: t('취소됨', 'Cancelled', 'Dibatalkan', 'キャンセル済み', 'Cancelado', "已取消"),
  statusFulfilled: t('배송 처리됨', 'Fulfilled', 'Dipenuhi', '発送済み', 'Preparado', "已发货"),
  newOrder: t('새 주문 {order}', 'New order {order}', 'Pesanan baru {order}', '新しい注文 {order}', 'Nuevo pedido {order}', "新订单 {order}"),
  orderOf: t('주문 {order}', 'Order {order}', 'Pesanan {order}', '注文 {order}', 'Pedido {order}', "订单 {order}"),
  orderItemsOne: t('{total} · 상품 1개', '{total} · 1 item', '{total} · 1 barang', '{total} · 1点', '{total} · 1 artículo', "{total} · 1 件商品"),
  orderItemsMany: t('{total} · 상품 {n}개', '{total} · {n} items', '{total} · {n} barang', '{total} · {n}点', '{total} · {n} artículos', "{total} · {n} 件商品"),
  orderLine: t('{title} × {n}', '{n} × {title}', '{n} × {title}', '{title} × {n}', '{n} × {title}', "{title} × {n}"),
  orderPaid: t('주문 결제됨', 'Order paid', 'Pesanan dibayar', '注文の支払いが完了しました', 'Pedido pagado', "订单已付款"),
  orderCancelled: t('주문 취소됨', 'Order cancelled', 'Pesanan dibatalkan', '注文がキャンセルされました', 'Pedido cancelado', "订单已取消"),
  orderFulfilled: t('주문 배송 처리됨', 'Order fulfilled', 'Pesanan dipenuhi', '注文が発送されました', 'Pedido preparado', "订单已发货"),
  newTicket: t('새 티켓 #{id}', 'New ticket #{id}', 'Tiket baru #{id}', '新しいチケット #{id}', 'Nuevo ticket #{id}', "新工单 #{id}"),
  ticketOf: t('티켓 #{id}', 'Ticket #{id}', 'Tiket #{id}', 'チケット #{id}', 'Ticket #{id}', "工单 #{id}"),
  ticketUpdated: t('티켓 #{id} 업데이트됨', 'Ticket #{id} updated', 'Tiket #{id} diperbarui', 'チケット #{id} が更新されました', 'Ticket #{id} actualizado', "工单 #{id} 已更新"),
  fromName: t('보낸 사람: {name}', 'From {name}', 'Dari {name}', '送信者: {name}', 'De {name}', "来自 {name}"),
  // phase 4: Jira, HubSpot, Toss Payments, Channel Talk, PortOne
  jiraNew: t('새 작업 항목 {key}', 'New work item {key}', 'Item kerja baru {key}', '新しい作業項目 {key}', 'Nuevo elemento de trabajo {key}', "新工作项 {key}"),
  jiraItem: t('작업 항목 {key}', 'Work item {key}', 'Item kerja {key}', '作業項目 {key}', 'Elemento de trabajo {key}', "工作项 {key}"),
  jiraMoved: t('{status}(으)로 이동함', 'Moved to {status}', 'Dipindah ke {status}', '{status} に移動', 'Movido a {status}', "已移至 {status}"),
  jiraUpdated: t('작업 항목이 업데이트됨', 'Work item updated', 'Item kerja diperbarui', '作業項目が更新されました', 'Elemento de trabajo actualizado', "工作项已更新"),
  jiraComment: t('새 댓글', 'New comment', 'Komentar baru', '新しいコメント', 'Nuevo comentario', "新评论"),
  jiraCommentBy: t('{name} 님의 새 댓글', 'New comment by {name}', 'Komentar baru dari {name}', '{name}さんの新しいコメント', 'Nuevo comentario de {name}', "{name} 的新评论"),
  hubspotDeal: t('거래', 'Deal', 'Kesepakatan', '取引', 'Negocio', "交易"),
  hubspotContact: t('연락처', 'Contact', 'Kontak', 'コンタクト', 'Contacto', "联系人"),
  hubspotTicket: t('티켓', 'Ticket', 'Tiket', 'チケット', 'Ticket', "工单"),
  hubspotStage: t('단계: {stage}', 'Stage: {stage}', 'Tahap: {stage}', 'ステージ: {stage}', 'Etapa: {stage}', "阶段：{stage}"),
  hubspotUpdated: t('업데이트됨', 'Updated', 'Diperbarui', '更新されました', 'Actualizado', "已更新"),
  paymentCancelled: t('결제 취소됨', 'Payment cancelled', 'Pembayaran dibatalkan', '支払いがキャンセルされました', 'Pago cancelado', "付款已取消"),
  paymentPartCancelled: t('결제 부분 취소됨', 'Payment partly cancelled', 'Pembayaran dibatalkan sebagian', '支払いが一部キャンセルされました', 'Pago cancelado en parte', "付款已部分取消"),
  waitingDeposit: t('입금 대기 중', 'Waiting for the transfer', 'Menunggu transfer', '入金待ち', 'Esperando la transferencia', "等待转账"),
  virtualAccountIssued: t('가상계좌 발급됨', 'Virtual account issued', 'Rekening virtual diterbitkan', 'バーチャル口座を発行しました', 'Cuenta virtual emitida', "已发放虚拟账户"),
  depositReceived: t('입금 완료', 'Transfer received', 'Transfer diterima', '入金されました', 'Transferencia recibida', "已收到转账"),
  paymentOf: t('결제 {id}', 'Payment {id}', 'Pembayaran {id}', '支払い {id}', 'Pago {id}', "付款 {id}"),
  orderIdLine: t('주문 번호: {id}', 'Order ID: {id}', 'ID pesanan: {id}', '注文番号: {id}', 'ID de pedido: {id}', "订单号：{id}"),
  channelNewChat: t('새 상담', 'New chat', 'Chat baru', '新しいチャット', 'Nuevo chat', "新会话"),
  channelChatFrom: t('{name} 님의 새 상담', 'New chat from {name}', 'Chat baru dari {name}', '{name}さんからの新しいチャット', 'Nuevo chat de {name}', "来自 {name} 的新会话"),
  channelCustomer: t('고객 메시지', 'Customer message', 'Pesan pelanggan', 'お客様のメッセージ', 'Mensaje del cliente', "客户消息"),
  channelCustomerFrom: t('{name} 님의 메시지', 'Message from {name}', 'Pesan dari {name}', '{name}さんのメッセージ', 'Mensaje de {name}', "来自 {name} 的消息"),
  channelManager: t('{name} 님의 답장', 'Reply by {name}', 'Balasan dari {name}', '{name}さんの返信', 'Respuesta de {name}', "{name} 的回复"),
  channelManagerAnon: t('상담원 답장', 'Team reply', 'Balasan tim', 'チームの返信', 'Respuesta del equipo', "团队回复"),
  // refusals of the management API (presets)
  presetSecretShape: t('{app}의 서명 시크릿 같지 않아요.', "That doesn't look like {app}'s signing secret.", 'Itu tidak terlihat seperti signing secret {app}.', '{app} の署名シークレットではないようです。', 'Eso no parece el secreto de firma de {app}.', "这看起来不像 {app} 的签名密钥。"),
  zendeskTestSecret: t('이건 Zendesk의 테스트용 시크릿이에요. 웹훅 페이지의 "Reveal secret"에 있는 시크릿을 붙여 넣어 주세요.', "That is Zendesk's test secret. Paste the secret from \"Reveal secret\" on your webhook's page.", 'Itu secret uji milik Zendesk. Tempel secret dari "Reveal secret" di halaman webhook Anda.', 'これは Zendesk のテスト用シークレットです。Webhook のページの「Reveal secret」にあるシークレットを貼り付けてください。', 'Ese es el secreto de prueba de Zendesk. Pegue el secreto de "Reveal secret" en la página de su webhook.', "这是 Zendesk 的测试密钥。请粘贴 webhook 页面上“Reveal secret”中的密钥。"),
  presetNotForKind: t('서비스는 "다른 앱"에만 고를 수 있어요.', 'A service can only be picked for "Other app".', 'Layanan hanya bisa dipilih untuk "Aplikasi lain".', 'サービスは「その他のアプリ」でのみ選べます。', 'Solo se puede elegir un servicio para "Otra aplicación".', "只能为“其他应用”选择服务。"),
  // "Change icon" (docs/decisions/20261116-other-app-icon.md): the refusals of an image or an emoji
  iconNotOther: t('아이콘은 "다른 앱"만 바꿀 수 있어요. 서비스 앱은 그 서비스의 로고를 써요.', 'Only an "Other app" can have its own icon. A service keeps its logo.', 'Hanya "Aplikasi lain" yang bisa punya ikon sendiri. Layanan memakai logonya.', '独自のアイコンを付けられるのは「その他のアプリ」だけです。サービスはそのロゴのままです。', 'Solo una "Otra aplicación" puede tener su propio icono. Un servicio mantiene su logotipo.', "只有“其他应用”可以使用自己的图标。服务会保留它的标志。"),
  iconType: t('PNG, JPEG, WebP 이미지만 쓸 수 있어요. 다른 이미지를 골라 주세요.', 'Use a PNG, JPEG or WebP image. Choose another image.', 'Pakai gambar PNG, JPEG, atau WebP. Pilih gambar lain.', 'PNG、JPEG、WebP の画像を使ってください。別の画像を選んでください。', 'Use una imagen PNG, JPEG o WebP. Elija otra imagen.', "请使用 PNG、JPEG 或 WebP 图片。请选择其他图片。"),
  iconAnimated: t('움직이는 이미지는 쓸 수 없어요.', 'Animated images cannot be used.', 'Gambar bergerak tidak bisa dipakai.', '動く画像は使えません。', 'No se pueden usar imágenes animadas.', "不能使用动态图片。"),
  iconShape: t('이미지는 {min}~{max}px 정사각형이어야 해요. 앱에서 고르면 알아서 잘라 드려요.', 'The image must be a square of {min} to {max} pixels. Choosing it in the app crops it for you.', 'Gambar harus persegi {min} sampai {max} piksel. Memilihnya di aplikasi akan memotongnya otomatis.', '画像は {min}〜{max} ピクセルの正方形にしてください。アプリで選ぶと自動で切り抜きます。', 'La imagen debe ser un cuadrado de {min} a {max} píxeles. Al elegirla en la app se recorta sola.', "图片必须是 {min} 到 {max} 像素的正方形。在应用中选择时会自动裁剪。"),
  iconLimit: t('아이콘은 한 시간에 {n}번까지 바꿀 수 있어요. {minutes}분 뒤에 다시 해 주세요.', 'You can change the icon up to {n} times an hour. Try again in {minutes} min.', 'Anda bisa mengganti ikon hingga {n} kali per jam. Coba lagi dalam {minutes} menit.', 'アイコンは1時間に{n}回まで変更できます。{minutes}分後にもう一度お試しください。', 'Puede cambiar el icono hasta {n} veces por hora. Vuelva a intentarlo en {minutes} min.', "图标每小时最多可更改 {n} 次。请在 {minutes} 分钟后重试。"),
  iconTooBig: t('이미지는 {kb}KB까지 쓸 수 있어요.', 'The image can be at most {kb} KB.', 'Gambar paling besar {kb} KB.', '画像は最大 {kb} KB です。', 'La imagen puede ocupar como máximo {kb} KB.', "图片最大为 {kb} KB。"),
} satisfies Record<string, T>

export type AppTextKey = keyof typeof APP_TEXT
const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es', zh: 'zh-CN' }
/** A count as the locale writes it ("5,000", "5.000"). */
export const appNumber = (n: number, locale: Locale) => new Intl.NumberFormat(TAG[locale] ?? TAG.en).format(n)
/** A text in the locale with {name} filled in (the values are plain text already). */
export function appText(key: AppTextKey, locale: Locale, vars: Record<string, string | number> = {}): string {
  const s = APP_TEXT[key][locale] ?? APP_TEXT[key].en
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
