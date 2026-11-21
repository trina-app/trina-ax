// AI engine status for the admin screen ("관리자: AI 엔진", tab 5): installed? which version? logged in? lockdown
// test passed for this version? which models? Checks run the CLIs with short timeouts and never call a model.
//
// Auth modes: local-login (dev / office: the engine runs as the current user with the owner's own `claude` /
// `codex` login) and managed (production, cloud, Linux: the team's AI connections behind the model proxy, Admin > AI
// connections; an engine is "signed in" when the team has a usable connection of its family). agent-own is how an
// older prod server without managed mode is shown.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineId, EngineStatus, Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { allowedCredentialKinds, anthropicGateway, gatewayModelIds, REPO_ROOT, type AppConfig } from '../app-config'
import { findCodexBin } from '../config'
import { openRouterKey } from '../credentials/validate'
import { teamCredentialSummary } from '../credentials/resolve'
import { credentialsOf } from '../credentials/store'
import { resolveLayout } from '../system/layout'
import { codexCatalogFor, CODEX_COMPATIBLE_VERSIONS } from '../engine/codex'
import { codexLoginState, type CodexLoginState } from '../native'
import { CODEX_PROD_BETA } from '../chat/engines'
import { readApiEngine, redact } from '../engine/api-agent'
import { isLocalApiAddress } from '../engine/api-context'
import { apiEngineFetch } from '../system/egress'
import { hostKind, type HostKind } from '../system/deployment'
import { engineStatusMessages } from '../system/messages-linux'

export const ENGINE_LABELS: Record<EngineId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', api: 'API' }
export const CLAUDE_MODELS = [
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'haiku', label: 'Claude Haiku' },
]
/** Claude Code's model choices (Admin > AI engines, the team default, the composer): the aliases, or with an
 * Anthropic-compatible gateway its model ids, the default first (the proxy forwards no other) */
export function claudeModels(config: Pick<AppConfig, 'engine'>): { id: string; label: string }[] {
  const g = anthropicGateway(config)
  return g ? gatewayModelIds(g).map((id) => ({ id, label: id })) : CLAUDE_MODELS
}
/** status checks are cached this long (GET /api/admin/engines); POST .../check always runs */
const CACHE_MS = 10 * 60_000

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

/** Run a CLI with a hard timeout; output capped at 64 KB. */
export async function runCli(cmd: string, args: string[], o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  let p: ReturnType<typeof Bun.spawn>
  try {
    p = Bun.spawn([cmd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...o.env } })
  } catch (e) {
    return { code: null, stdout: '', stderr: '', timedOut: false, error: (e as Error).message }
  }
  let timedOut = false
  const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL') }, o.timeoutMs ?? 15_000)
  const read = async (s: ReadableStream<Uint8Array> | null | undefined | number) => {
    if (!s || typeof s === 'number') return ''
    const txt = await new Response(s).text()
    return txt.slice(0, 64 * 1024)
  }
  const [stdout, stderr, code] = await Promise.all([read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>), p.exited])
  clearTimeout(t)
  return { code: timedOut ? null : code, stdout, stderr, timedOut }
}

export const T: Record<string, Record<Locale, string>> = {
  notInstalled: { ko: '서버 맥에 설치되어 있지 않아요.', en: 'Not installed on the server Mac.', id: 'Belum terpasang di Mac server.', ja: "サーバーのMacにインストールされていません。", es: "No está instalado en el Mac del servidor.", zh: "服务器Mac上没有安装。" },
  apiNotSet: { ko: '아직 설정하지 않았어요. 아래에서 API 주소·모델·키를 넣어 주세요.', en: 'Not set up yet. Enter the API address, model and key below.', id: 'Belum diatur. Masukkan alamat API, model, dan kunci di bawah.', ja: "未設定です。下にAPIアドレス、モデル、キーを入力してください。", es: "Aún no está configurado. Introduzca abajo la dirección de la API, el modelo y la clave.", zh: "还没有设置。请在下面填写API地址、模型和密钥。" },
  // plain words, no status code: the code is in the server's log (QA TC-6925)
  apiKey: { ko: '제공자가 이 API 키를 받지 않았어요. 키를 확인하거나 새로 만들어 다시 저장해 주세요.', en: "The provider didn't accept this API key. Check the key, or make a new one, and save it again.", id: 'Penyedia tidak menerima kunci API ini. Periksa kuncinya, atau buat yang baru, lalu simpan lagi.', ja: "プロバイダーがこのAPIキーを受け付けませんでした。キーを確認するか、新しく作って保存し直してください。", es: "El proveedor no aceptó esta clave de API. Revise la clave o cree una nueva y vuelva a guardarla.", zh: "服务商不接受这个API密钥。请检查密钥，或新建一个后重新保存。" },
  apiModel: { ko: '이 제공자에 모델 "{model}"이 없어요. 모델 이름을 확인해 주세요.', en: 'The provider has no model "{model}". Check the model name.', id: 'Penyedia tidak punya model "{model}". Periksa nama model.', ja: "プロバイダーにモデル\"{model}\"がありません。モデル名を確認してください。", es: "El proveedor no tiene el modelo \"{model}\". Revise el nombre del modelo.", zh: "服务商没有模型“{model}”。请检查模型名称。" },
  apiModelUnchecked: { ko: '주소와 키는 맞아요. 제공자가 모델 목록을 주지 않아서 모델 이름은 확인하지 못했어요.', en: 'The address and key work. The provider gives no model list, so the model name was not checked.', id: 'Alamat dan kunci berfungsi. Penyedia tidak memberi daftar model, jadi nama model belum diperiksa.', ja: "アドレスとキーは有効です。プロバイダーがモデル一覧を提供していないため、モデル名は確認していません。", es: "La dirección y la clave funcionan. El proveedor no ofrece una lista de modelos, por lo que no se comprobó el nombre del modelo.", zh: "地址和密钥可以用。服务商不提供模型列表，所以没有检查模型名称。" },
  apiKeyUnchecked: { ko: '주소와 모델은 맞아요. 제공자가 키 확인 주소를 주지 않아서 키는 확인하지 못했어요.', en: 'The address and model work. The provider has no key check address, so the key was not checked.', id: 'Alamat dan model berfungsi. Penyedia tidak punya alamat pemeriksaan kunci, jadi kunci belum diperiksa.', ja: "アドレスとモデルは有効です。プロバイダーにキー確認用アドレスがないため、キーは確認していません。", es: "La dirección y el modelo funcionan. El proveedor no ofrece una dirección para verificar la clave, por lo que no se comprobó.", zh: "地址和模型可以用。服务商没有检查密钥的地址，所以没有检查密钥。" },
  apiUnreachable: { ko: 'API 주소에 연결하지 못했어요. 주소를 확인한 뒤 다시 확인을 눌러 주세요.', en: 'The API address could not be reached. Check the address, then try Check again.', id: 'Alamat API tidak bisa dihubungi. Periksa alamatnya, lalu klik Cek lagi.', ja: "APIアドレスに接続できませんでした。アドレスを確認してから「再確認」を押してください。", es: "No se pudo conectar con la dirección de la API. Revise la dirección y pulse «Volver a comprobar».", zh: "无法连接API地址。请检查地址，然后点“重新检查”。" },
  apiOllamaNotRunning: { ko: "Ollama가 켜져 있지 않아요. 서버 컴퓨터에서 Ollama 앱을 연 뒤 다시 확인을 눌러 주세요.", en: "Ollama isn't running on the server's computer. Open the Ollama app there, then try Check again.", id: "Ollama tidak berjalan di komputer server. Buka aplikasi Ollama di sana, lalu klik Cek lagi.", ja: "サーバーのコンピューターで Ollama が動いていません。そこで Ollama アプリを開いてから「再確認」を押してください。", es: "Ollama no se está ejecutando en el ordenador del servidor. Abra allí la aplicación Ollama y pulse «Volver a comprobar».", zh: "服务器电脑上的 Ollama 没有运行。请在那台电脑上打开 Ollama 应用，然后点“重新检查”。" },
  apiLocalNotRunning: { ko: "이 주소에서 응답하는 프로그램이 없어요. 서버 컴퓨터에서 모델 프로그램(예: LM Studio)을 켠 뒤 다시 확인을 눌러 주세요.", en: "Nothing answers at this address on the server's computer or network. Start the model program there (for example LM Studio), then try Check again.", id: "Tidak ada yang menjawab di alamat ini pada komputer atau jaringan server. Jalankan program modelnya di sana (misalnya LM Studio), lalu klik Cek lagi.", ja: "サーバーのコンピューターやネットワークのこのアドレスで応答するものがありません。そこでモデルのプログラム（例：LM Studio）を起動してから「再確認」を押してください。", es: "Nada responde en esta dirección del ordenador o la red del servidor. Inicie allí el programa del modelo (por ejemplo LM Studio) y pulse «Volver a comprobar».", zh: "服务器电脑或网络上的这个地址没有任何程序响应。请在那里启动模型程序（例如 LM Studio），然后点“重新检查”。" },
  apiHttp: { ko: 'API 주소가 오류를 보냈어요(HTTP {status}). 주소를 확인해 주세요.', en: 'The API address sent back an error (HTTP {status}). Check the address.', id: 'Alamat API mengirim galat (HTTP {status}). Periksa alamatnya.', ja: "APIアドレスからエラーが返されました（HTTP {status}）。アドレスを確認してください。", es: "La dirección de la API devolvió un error (HTTP {status}). Revise la dirección.", zh: "API地址返回了错误（HTTP {status}）。请检查地址。" },
  claudeLogin: { ko: '서버 맥에서 팀장이 `claude`를 실행해 로그인해야 해요.', en: 'The owner must sign in by running `claude` on the server Mac.', id: 'Owner harus masuk dengan menjalankan `claude` di Mac server.', ja: "オーナーがサーバーのMacで`claude`を実行してログインする必要があります。", es: "El propietario debe iniciar sesión ejecutando `claude` en el Mac del servidor.", zh: "所有者需要在服务器Mac上运行`claude`来登录。" },
  codexLogin: { ko: '서버 맥에서 팀장이 `codex login`으로 로그인해야 해요.', en: 'The owner must sign in with `codex login` on the server Mac.', id: 'Owner harus masuk dengan `codex login` di Mac server.', ja: "オーナーがサーバーのMacで`codex login`を実行してログインする必要があります。", es: "El propietario debe iniciar sesión con `codex login` en el Mac del servidor.", zh: "所有者需要在服务器Mac上用`codex login`登录。" },
  setupToken: { ko: '전용 엔진 계정 모드에는 팀장의 구독 장기 토큰이 필요해요: 서버 맥에서 `claude setup-token`으로 토큰을 만들고 `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"`으로 저장해 주세요(secrets/claude-oauth-token, docs/INSTALL.md 2.4).', en: 'The dedicated engine account needs the owner\'s long-lived subscription token: make one with `claude setup-token` on the server Mac and store it with `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"` (secrets/claude-oauth-token, docs/INSTALL.md 2.4).', id: 'Akun mesin khusus memerlukan token langganan owner: buat dengan `claude setup-token` di Mac server lalu simpan dengan `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"` (secrets/claude-oauth-token, docs/INSTALL.md 2.4).', ja: "専用エンジンアカウントにはオーナーの長期サブスクリプショントークンが必要です。サーバーのMacで`claude setup-token`を実行して作成し、`pbpaste | sudo \"/Library/Application Support/mycel/root/set-claude-token\"`で保存してください（secrets/claude-oauth-token、docs/INSTALL.md 2.4）。", es: "La cuenta dedicada del motor necesita el token de suscripción de larga duración del propietario: créelo con `claude setup-token` en el Mac del servidor y guárdelo con `pbpaste | sudo \"/Library/Application Support/mycel/root/set-claude-token\"` (secrets/claude-oauth-token, docs/INSTALL.md 2.4).", zh: "专用引擎账号需要所有者的长期订阅令牌：在服务器Mac上用`claude setup-token`生成一个，再用`pbpaste | sudo \"/Library/Application Support/mycel/root/set-claude-token\"`保存（secrets/claude-oauth-token，docs/INSTALL.md 2.4）。" },
  setupTokenExpired: { ko: 'Claude 구독 장기 토큰이 만료됐어요(1년). `claude setup-token`으로 새 토큰을 만들어 다시 저장해 주세요.', en: 'The long-lived Claude subscription token has expired (one year). Make a new one with `claude setup-token` and store it again.', id: 'Token langganan Claude sudah kedaluwarsa (satu tahun). Buat yang baru dengan `claude setup-token` lalu simpan lagi.', ja: "Claudeの長期サブスクリプショントークンが期限切れです（1年）。`claude setup-token`で新しく作成して保存し直してください。", es: "El token de suscripción de larga duración de Claude venció (un año). Cree otro con `claude setup-token` y guárdelo de nuevo.", zh: "Claude长期订阅令牌已过期（一年）。请用`claude setup-token`生成新的令牌并重新保存。" },
  setupTokenInvalid: { ko: 'Claude가 구독 장기 토큰을 거절했어요(취소되었거나 잘못 붙여 넣음). `claude setup-token`으로 새 토큰을 만들어 다시 저장해 주세요.', en: 'Claude refused the long-lived subscription token (revoked or pasted wrong). Make a new one with `claude setup-token` and store it again.', id: 'Claude menolak token langganan (dicabut atau salah tempel). Buat yang baru dengan `claude setup-token` lalu simpan lagi.', ja: "Claudeが長期サブスクリプショントークンを拒否しました（取り消されたか、貼り付けが不正確です）。`claude setup-token`で新しく作成して保存し直してください。", es: "Claude rechazó el token de suscripción de larga duración (revocado o mal pegado). Cree otro con `claude setup-token` y guárdelo de nuevo.", zh: "Claude拒绝了长期订阅令牌（已撤销或粘贴有误）。请用`claude setup-token`生成新的令牌并重新保存。" },
  codexDevice: { ko: '전용 엔진 계정의 Codex 로그인이 아직 없어요. 서버 맥에서 팀장이 관리 명령 `admin.js codex-login`을 한 번 실행해 나오는 주소와 코드로 로그인해요(docs/INSTALL.md 2.5).', en: 'The engine account has no Codex sign-in yet. On the server Mac the owner runs the admin command `admin.js codex-login` once and signs in with the address and code it prints (docs/INSTALL.md 2.5).', id: 'Akun mesin belum masuk ke Codex. Di Mac server, owner menjalankan perintah admin `admin.js codex-login` sekali lalu masuk dengan alamat dan kode yang ditampilkan (docs/INSTALL.md 2.5).', ja: "エンジンアカウントはまだCodexにログインしていません。オーナーがサーバーのMacで管理コマンド`admin.js codex-login`を一度実行し、表示されたアドレスとコードでログインしてください（docs/INSTALL.md 2.5）。", es: "La cuenta del motor aún no inició sesión en Codex. El propietario debe ejecutar una vez `admin.js codex-login` en el Mac del servidor e iniciar sesión con la dirección y el código indicados (docs/INSTALL.md 2.5).", zh: "引擎账号还没有登录Codex。所有者在服务器Mac上运行一次管理命令`admin.js codex-login`，然后用显示的地址和代码登录（docs/INSTALL.md 2.5）。" },
  codexCatalog: { ko: 'Codex 모델 목록(잠금 카탈로그 model_catalog.json)이 엔진 폴더에 없어요. 설치 스크립트를 다시 실행해 주세요.', en: 'The Codex model list (locked catalog model_catalog.json) is missing from the engine folder. Run the installer again.', id: 'Daftar model Codex (katalog terkunci model_catalog.json) tidak ada di folder mesin. Jalankan installer lagi.', ja: "エンジンフォルダーにCodexモデル一覧（固定カタログmodel_catalog.json）がありません。インストーラーを再実行してください。", es: "Falta la lista de modelos de Codex (catálogo fijo model_catalog.json) en la carpeta del motor. Vuelva a ejecutar el instalador.", zh: "引擎文件夹里缺少Codex模型列表（锁定目录model_catalog.json）。请重新运行安装程序。" },
  launcherDown: { ko: '실행기(엔진 계정 데몬)가 답하지 않아요.', en: 'The launcher (engine account daemon) does not answer.', id: 'Launcher (daemon akun mesin) tidak menjawab.', ja: "ランチャー（エンジンアカウントのデーモン）が応答しません。", es: "El lanzador (servicio de la cuenta del motor) no responde.", zh: "启动器（引擎账号守护进程）没有响应。" },
  companyKey: { ko: '회사 키 모드인데 회사 API 키가 없어요.', en: 'Company-key mode is on but no company API key is stored.', id: 'Mode kunci perusahaan aktif tetapi belum ada kunci API.', ja: "会社キーモードが有効ですが、会社のAPIキーが保存されていません。", es: "El modo de clave de empresa está activo, pero no hay ninguna clave de API de empresa guardada.", zh: "已开启公司密钥模式，但没有保存公司API密钥。" },
  managedLimited: { ko: 'AI 연결이 사용 한도에 닿았어요. 한도가 풀리면 다시 쓸 수 있어요.', en: 'The AI connections have reached their limit. They work again when the limit ends.', id: 'Koneksi AI mencapai batasnya. Koneksi bisa dipakai lagi saat batas berakhir.', ja: "AI接続が使用上限に達しました。上限が解除されると再び使えます。", es: "Las conexiones de IA alcanzaron su límite. Volverán a funcionar cuando termine el límite.", zh: "AI连接已达到用量上限。上限结束后可以再次使用。" },
  // shown only on Admin › AI providers (pages/admin/Engines.tsx EngineRow), right above the 'Add account' button
  managedNone: { ko: "이 엔진에 AI 계정이 아직 없어요. 아래 '계정 추가'로 추가해 주세요.", en: "This engine has no AI account yet. Add one with 'Add account' below.", id: "Mesin ini belum punya akun AI. Tambahkan dengan 'Tambah akun' di bawah.", ja: "このエンジンにはまだAIアカウントがありません。下の「アカウントを追加」で追加してください。", es: "Este motor aún no tiene ninguna cuenta de IA. Añada una con «Añadir cuenta» más abajo.", zh: "这个引擎还没有AI账号。请点下方的“添加账号”添加。" },
  managedNoneDetail: { ko: "이 엔진의 AI 계정을 지금 쓸 수 없어요(거절·만료·한도). 아래에서 계정을 확인하거나 '계정 추가'로 새로 추가해 주세요.", en: "This engine's AI accounts cannot be used now (refused, expired or at their limit). Check them below, or add one with 'Add account'.", id: "Akun AI mesin ini tidak bisa dipakai sekarang (ditolak, kedaluwarsa, batas). Periksa di bawah, atau tambahkan dengan 'Tambah akun'.", ja: "このエンジンのAIアカウントは現在使えません（拒否、期限切れ、上限到達）。下で確認するか、「アカウントを追加」で追加してください。", es: "Las cuentas de IA de este motor no se pueden usar ahora (rechazadas, vencidas o con el límite alcanzado). Revíselas más abajo o añada una con «Añadir cuenta».", zh: "这个引擎的AI账号现在无法使用（被拒绝、已过期、达到上限）。请在下方检查，或点“添加账号”添加。" },
  // every account of this engine is only switched off (Admin › AI providers): not refused, expired or at a limit
  managedAllOff: { ko: "이 엔진의 AI 계정이 모두 꺼져 있어요. 아래 계정의 ⋯ 메뉴에서 '켜기'를 눌러 주세요.", en: "This engine's AI accounts are all switched off. Switch one on below with ⋯ › Switch on.", id: "Semua akun AI mesin ini dimatikan. Nyalakan salah satunya di bawah lewat ⋯ › Nyalakan.", ja: "このエンジンのAIアカウントはすべてオフになっています。下のアカウントの ⋯ ›「オンにする」でどれかをオンにしてください。", es: "Todas las cuentas de IA de este motor están desactivadas. Active una más abajo con ⋯ › Activar.", zh: "这个引擎的AI账号都已关闭。请在下方账号的 ⋯ › “开启”中开启一个。" },
  version: { ko: '아직 검증하지 않은 버전이에요(고정 버전: {pinned}; 잠금 시험을 통과한 버전: {tested}).', en: 'This version has not been tested (pinned: {pinned}; lockdown-tested: {tested}).', id: 'Versi ini belum diuji (versi yang dikunci: {pinned}; lulus uji penguncian: {tested}).', ja: "このバージョンは未検証です（固定：{pinned}、制限テスト済み：{tested}）。", es: "Esta versión no se ha probado (fijada: {pinned}; con restricciones verificadas: {tested}).", zh: "这个版本还没有测试过（固定版本：{pinned}；已通过锁定测试：{tested}）。" },
  lockdown: { ko: '이 버전의 엔진 잠금 시험이 실패했어요.', en: 'The engine lockdown test failed for this version.', id: 'Uji penguncian mesin gagal untuk versi ini.', ja: "このバージョンのエンジン制限テストに失敗しました。", es: "Falló la prueba de restricciones del motor para esta versión.", zh: "这个版本的引擎锁定测试失败了。" },
  // a check that failed: a plain line by reason with the provider's name (failedCheck), never the engine's output; the
  // output itself, cleaned (supportDetail), is the status's errorDetail behind the card's "Show details"
  checkFailed: { ko: '{name} 상태를 지금 확인하지 못했어요. 잠시 후 다시 확인을 눌러 주세요.', en: "Couldn't check {name} right now. Try Check again in a moment.", id: 'Tidak dapat memeriksa {name} saat ini. Klik Cek lagi sebentar lagi.', ja: "今は{name}の状態を確認できませんでした。しばらくしてから「再確認」を押してください。", es: "No se pudo comprobar {name} en este momento. Pulse «Volver a comprobar» dentro de un momento.", zh: "暂时无法检查{name}。请稍后点“重新检查”。" },
  checkTimeout: { ko: '{name} 확인이 너무 오래 걸렸어요. 잠시 후 다시 확인을 눌러 주세요.', en: 'Checking {name} took too long. Try Check again in a moment.', id: 'Pemeriksaan {name} terlalu lama. Klik Cek lagi sebentar lagi.', ja: "{name}の確認に時間がかかりすぎました。しばらくしてから「再確認」を押してください。", es: "La comprobación de {name} tardó demasiado. Pulse «Volver a comprobar» dentro de un momento.", zh: "检查{name}用时太长。请稍后点“重新检查”。" },
  checkNetwork: { ko: '인터넷에 연결되지 않아 {name} 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 확인을 눌러 주세요.', en: "Couldn't check {name} because there is no internet connection. Check the connection, then try Check again.", id: 'Tidak dapat memeriksa {name} karena tidak ada koneksi internet. Periksa koneksinya, lalu klik Cek lagi.', ja: "インターネットに接続できないため、{name}を確認できませんでした。接続を確認してから「再確認」を押してください。", es: "No se pudo comprobar {name} porque no hay conexión a internet. Revise la conexión y pulse «Volver a comprobar».", zh: "没有网络连接，无法检查{name}。请检查网络，然后点“重新检查”。" },
}
const t = (k: keyof typeof T, l: Locale, vars: Record<string, string> = {}) => T[k]![l].replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')
/** t() with the entries that name the server Mac replaced for a Linux server or the hosted cloud */
const hostT = (env: EngineEnv): typeof t => {
  const over = env.host && env.host !== 'mac' ? engineStatusMessages(env.host, env.base ?? '') : {}
  return (k, l, vars = {}) => (over[k]?.[l] ?? T[k]![l]).replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')
}

/** The longest errorDetail (the cleaned engine output behind the card's "Show details") */
export const SUPPORT_DETAIL_MAX = 600
// The rules of supportDetail, in order. A secret field is a name that ENDS in a secret word, with any prefix
// (refreshToken, x-api-key, OPENAI_API_KEY), so usage counts such as input_tokens stay; a quoted value goes whole.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:)?\/\/[^\s/@:"'`]+(?::[^\s/@"'`]*)?@/gi
// a PEM private key, whole (it spans lines), before any other rule
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
// cookies and (proxy-)authorization of any scheme (Basic, Bearer, Digest…): to the end of the line
const COOKIE_LINE = /\b((?:set-)?cookie|(?:proxy-)?authorization)\b(["']?\s*[:=])[^\n]*/gi
// well-known token shapes even without a field name (Slack, GitHub, GitLab, Google, AWS); the separator or length is
// required, so words such as "ghost" stay
const TOKEN_PREFIX = /\b(?:xox[abprs]-|gh[pousr]_|github_pat_|glpat-)[-_A-Za-z0-9]+|\bAIza[-_A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{12,}/g
const SECRET_PAIR = /\b([A-Za-z0-9_-]*(?:pass|password|passphrase|passwd|pwd|token|secret|key|apikey|auth|authorization|credential|credentials|cookie))(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|(?:(?:Bearer|Basic)\s+)?(?![{\s])[^\s"',}&;]+)/gi
const AUTH_SCHEME: readonly [RegExp, string][] = [
  [/\bBearer\s+[^\s"',}&;]+/gi, 'Bearer [hidden]'],
  [/\bBasic\s+[A-Za-z0-9+/=._~-]{6,}/gi, 'Basic [hidden]'],
]
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const HOME_PATHS: readonly RegExp[] = [
  // Windows first (C:/Users/… would otherwise leave "C:"): either slash, a name with spaces up to the next slash or quote
  /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/"'`\n]+/gi,
  /(?:\/private)?\/var\/root\b/g,
  /(?<![\w.~-])\/root\b/g,
  /\/(?:Users|home)\/[^/\s"'`]+/g,
]
const mixedCase = (m: string) => /[a-z]/.test(m) && /[A-Z]/.test(m)
/** token-like runs: 20+ characters with a digit or mixed case (snake_case words such as content_block_start stay
 * readable), and mixed-case base64-like runs of 24+ */
const maskRuns = (s: string) => s
  .replace(/[A-Za-z0-9_-]{20,}/g, (m) => (/\d/.test(m) || mixedCase(m) ? '[hidden]' : m))
  .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, (m) => (mixedCase(m) ? '[hidden]' : m))
/**
 * An engine's raw output, for support only (never the card's line): the key, credentials in addresses, secret fields,
 * Authorization schemes, cookies, emails and token-like runs masked, home folders shown as ~, cut to
 * SUPPORT_DETAIL_MAX. undefined when nothing is left.
 */
export function supportDetail(raw: string | null | undefined, key: string | null = null): string | undefined {
  let s = (raw ?? '').trim()
  if (!s) return undefined
  s = redact(s.replace(PEM_KEY, '[private key hidden]'), key)
    .replace(TOKEN_PREFIX, '[hidden]')
    .replace(URL_CREDENTIALS, '$1//[hidden]@')
    .replace(COOKIE_LINE, '$1$2 [hidden]')
    .replace(SECRET_PAIR, '$1$2[hidden]')
  for (const [re, to] of AUTH_SCHEME) s = s.replace(re, to)
  s = s.replace(EMAIL, '[email]')
  const home = os.homedir()
  if (home && home.length > 1) s = s.split(home).join('~')
  for (const re of HOME_PATHS) s = s.replace(re, '~')
  s = maskRuns(s)
  return s.length > SUPPORT_DETAIL_MAX ? `${s.slice(0, SUPPORT_DETAIL_MAX)}…` : s
}

/** Why a check failed, from what the engine printed: a reason the card can say plainly, or 'unknown'. */
export type CheckFailure = 'timeout' | 'network' | 'signed_out' | 'unknown'
const NETWORK_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|network (?:error|is unreachable)|unable to connect|socket hang up/i
const SIGNED_OUT_RE = /not logged in|not signed in|please run \/login|invalid api key|authentication_error|authentication failed|oauth token (?:has )?expired|"loggedIn"\s*:\s*false/i
export function classifyFailure(r: Pick<RunResult, 'timedOut' | 'stdout' | 'stderr' | 'error'>): CheckFailure {
  if (r.timedOut) return 'timeout'
  const text = `${r.error ?? ''}\n${r.stderr}\n${r.stdout}`
  if (NETWORK_RE.test(text)) return 'network'
  if (SIGNED_OUT_RE.test(text)) return 'signed_out'
  return 'unknown'
}

/**
 * A failed CLI check as the card shows it: the plain line for its reason, with the provider's name; a sign-in problem
 * is the engine's own sign-in line (`signIn`) when there is one. The output goes to errorDetail, cleaned.
 */
export function failedCheck(name: string, r: RunResult, locale: Locale, tr: typeof t = t, signIn?: 'claudeLogin' | 'codexLogin'): { status: 'error' | 'not_logged_in'; detail: string; errorDetail?: string } {
  const why = classifyFailure(r)
  const errorDetail = supportDetail(r.error || r.stderr || r.stdout)
  const extra = errorDetail ? { errorDetail } : {}
  if (why === 'signed_out' && signIn) return { status: 'not_logged_in', detail: tr(signIn, locale), ...extra }
  const k = why === 'timeout' ? 'checkTimeout' : why === 'network' ? 'checkNetwork' : 'checkFailed'
  return { status: 'error', detail: tr(k, locale, { name }), ...extra }
}

export interface EngineEnv {
  mode: 'dev' | 'prod'
  authMode: 'local-login' | 'managed'
  claudeBin: string
  codexBin: string
  dataDir: string
  /** <install base>/secrets (the installer's 700 folder, kept out of Time Machine); the diagnostics read the same */
  secretsDir: string
  /** versions.json (pinned engine versions); null = no pin check */
  versionsFile: string | null
  /** Codex model catalog sources, first existing wins */
  codexCatalogs: string[]
  /** prod: the engine account's Codex login, asked of the launcher (the server account cannot read it). null = the
   * launcher did not answer. Absent (dev): `codex login status` of the owner's own login. */
  codexLogin?: () => Promise<CodexLoginState | null>
  /** managed: the team's AI connections of a family (usable now / all) */
  credentials?: (family: 'anthropic' | 'openai') => { total: number; usable: number; reasons?: string[]; limitedUntil?: string | null }
  /** the server's database */
  db?: import('bun:sqlite').Database
  /** which machine the status lines talk about (deployment.ts hostKind; absent = the Mac wording) and the install base */
  host?: HostKind
  base?: string
  /** Claude Code's models (claudeModels); absent = the aliases */
  claudeModels?: { id: string; label: string }[]
  /** the server's log: a refused API key's HTTP status goes here, never on the card (QA TC-6925) */
  log?: import('../log').Logger
}

export function engineEnv(ctx: AppContext): EngineEnv {
  const prod = ctx.config.mode === 'prod'
  const vf = path.join(REPO_ROOT, 'versions.json')
  // prod: the installer's engine only (the launcher allows nothing else) and its locked catalog next to it
  const codexBin = prod ? ctx.config.engine.codexBin ?? '' : findCodexBin(ctx.config.engine.codexBin) ?? ''
  const sock = ctx.config.engine.launcherSock ?? path.join(ctx.engineConfig.runDir, 'launcher.sock')
  return {
    mode: ctx.config.mode,
    authMode: ctx.config.engine.authMode,
    claudeBin: ctx.config.engine.claudeBin ?? ctx.engineConfig.claudeBin,
    codexBin,
    dataDir: ctx.config.dataDir,
    secretsDir: resolveLayout(ctx.config).secretsDir,
    versionsFile: fs.existsSync(vf) ? vf : null,
    codexCatalogs: prod ? [codexCatalogFor(codexBin)] : [
      path.join(ctx.config.dataDir, 'codex-catalog.json'), // written by chat/engines.ts from the owner's models_cache
      path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'models_cache.json'),
    ],
    ...(prod && ctx.config.engine.authMode !== 'managed' ? { codexLogin: () => codexLoginState(sock) } : {}),
    ...(ctx.config.engine.authMode === 'managed' ? { credentials: (family: 'anthropic' | 'openai') => teamCredentialSummary(ctx.db, family, allowedCredentialKinds(ctx.config)) } : {}),
    db: ctx.db,
    host: hostKind(ctx.config), base: resolveLayout(ctx.config).base,
    claudeModels: claudeModels(ctx.config),
    log: ctx.log,
  }
}

/** auth mode as shown to the admin */
export function shownAuthMode(env: EngineEnv): EngineStatus['authMode'] {
  if (env.authMode === 'managed') return 'managed'
  return env.mode === 'prod' ? 'agent-own' : 'local-login'
}

function pinned(env: EngineEnv, id: EngineId): string | null {
  if (!env.versionsFile) return null
  try { const v = JSON.parse(fs.readFileSync(env.versionsFile, 'utf8')); return typeof v[id === 'claude-code' ? 'claude-code' : 'codex-cli'] === 'string' ? v[id === 'claude-code' ? 'claude-code' : 'codex-cli'] : null } catch { return null }
}

/** `<data>/engine/lockdown-<engine>.json` { ok, version } written by the lockdown regression run. */
function lockdownResult(env: EngineEnv, id: EngineId): { ok: boolean; version: string | null } | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'engine', `lockdown-${id}.json`), 'utf8'))
    return typeof v.ok === 'boolean' ? { ok: v.ok, version: typeof v.version === 'string' ? v.version : null } : null
  } catch { return null }
}

export function codexModels(env: EngineEnv): { id: string; label: string }[] {
  for (const f of env.codexCatalogs) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (!Array.isArray(j.models)) continue
      return j.models.filter((m: any) => typeof m?.slug === 'string' && m.visibility !== 'hide').map((m: any) => ({ id: m.slug, label: typeof m.display_name === 'string' ? m.display_name : m.slug }))
    } catch {}
  }
  return []
}

// keep a prerelease suffix (0.164.0-alpha.1): the admin sees the real version, and the exact pin and
// compatible checks do not take a prerelease for the tested release
const versionOf = (s: string) => /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(s)?.[1] ?? null

export async function checkEngine(id: EngineId, env: EngineEnv, enabled: boolean, locale: Locale): Promise<EngineStatus> {
  if (id === 'api') return checkApiEngine(env, enabled, locale)
  const t = hostT(env) // Linux / the hosted cloud wording (system/messages-linux.ts); the Mac's stays as above
  const base = { id, label: ENGINE_LABELS[id], enabled, authMode: shownAuthMode(env), checkedAt: new Date().toISOString(),
    ...(id === 'codex' && env.mode === 'prod' && CODEX_PROD_BETA && env.authMode !== 'managed' ? { beta: true } : {}) }
  const bin = id === 'claude-code' ? env.claudeBin : env.codexBin
  const v = await runCli(bin, ['--version'], { timeoutMs: 10_000 })
  const version = v.code === 0 ? versionOf(v.stdout + v.stderr) : null
  const models = id === 'claude-code' ? env.claudeModels ?? CLAUDE_MODELS : codexModels(env)
  if (!version) {
    const missing = v.error || v.code === 127 || /ENOENT|not found|No such file/i.test(v.error ?? v.stderr)
    // a timeout is not "not installed" (a first start after a long idle can take over 10 s): an error, kept in the picker
    if (missing) return { ...base, installed: false, version: null, status: 'not_installed', detail: t('notInstalled', locale), models }
    const f = failedCheck(ENGINE_LABELS[id], v, locale, t)
    return { ...base, installed: false, version: null, status: 'error', detail: f.detail, ...(f.errorDetail ? { errorDetail: f.errorDetail } : {}), models }
  }
  const out = (status: EngineStatus['status'], detail: string | null, errorDetail?: string): EngineStatus => ({ ...base, installed: true, version, status, detail, ...(errorDetail ? { errorDetail } : {}), models })
  if (id === 'codex' && env.mode === 'prod' && !models.length) return out('error', t('codexCatalog', locale))

  // login
  const mode = shownAuthMode(env)
  if (mode === 'managed') {
    // the team's AI connections of this engine's family (Admin > AI connections): none, or none usable now
    const c = env.credentials?.(id === 'claude-code' ? 'anthropic' : 'openai') ?? { total: 0, usable: 0 }
    if (!c.usable) {
      // connections that only wait for a limit to end (rate or usage limit) are set up, not signed out; one that was
      // refused, expired or needs a new sign-in still is a problem
      const why = c.reasons ?? []
      const waiting = why.some((w) => w === 'limited' || w === 'over_limit') && !why.some((w) => w === 'invalid' || w === 'needs_reconnect' || w === 'expired')
      if (waiting) return { ...out('limited', t('managedLimited', locale)), limitedUntil: c.limitedUntil ?? null }
      // every account switched off by hand: say so, not the refused / expired / limit reasons
      const allOff = c.total > 0 && why.length === c.total && why.every((w) => w === 'disabled')
      return out('not_logged_in', t(!c.total ? 'managedNone' : allOff ? 'managedAllOff' : 'managedNoneDetail', locale))
    }
  } else if (id === 'claude-code') {
    if (mode === 'agent-own') {
      // an installed server that is not in managed mode (hand-set local-login): the engine account has no login of its own
      return out('not_logged_in', t('setupToken', locale))
    } else {
      const s = await runCli(bin, ['auth', 'status', '--json'], { timeoutMs: 15_000 })
      let logged: boolean | null = null
      try { logged = JSON.parse(s.stdout).loggedIn === true } catch {}
      if (logged === null) {
        // not the JSON it should print (an older or broken engine, no network, a timeout): a plain line, never its output
        const f = failedCheck(ENGINE_LABELS[id], s, locale, t, 'claudeLogin')
        return out(f.status, f.detail, f.errorDetail)
      }
      if (!logged) return out('not_logged_in', t('claudeLogin', locale))
    }
  } else if (env.codexLogin) {
    // the engine account's own login (<agent root>/codex-auth), as the launcher sees it; never a token
    const s = await env.codexLogin()
    if (!s) return out('error', t('launcherDown', locale))
    if (!s.loggedIn) return out('not_logged_in', t('codexDevice', locale))
  } else {
    const s = await runCli(bin, ['login', 'status'], { timeoutMs: 15_000 })
    const text = s.stdout + s.stderr
    if (s.code !== 0 || !/logged in/i.test(text) || /not logged in/i.test(text)) return out('not_logged_in', mode === 'agent-own' ? t('codexDevice', locale) : t('codexLogin', locale))
  }

  // pinned version + lockdown regression result
  const pin = pinned(env, id)
  const compatible = id === 'codex' && CODEX_COMPATIBLE_VERSIONS.some(v => v === version)
  const lock = lockdownResult(env, id)
  if (lock && !lock.ok && (lock.version === null || lock.version === version)) return out('lockdown_failed', t('lockdown', locale))
  if (pin && pin !== version && !compatible) {
    const tested = [...new Set([pin, ...(id === 'codex' ? CODEX_COMPATIBLE_VERSIONS : [])])].join(', ')
    return out('version_unsupported', t('version', locale, { pinned: pin, tested }))
  }
  return out('ok', null)
}

/** The model ids of a provider's list that name `model`: as is, Gemini's "models/<id>", Ollama's "<id>:latest". */
export function modelListed(ids: string[], model: string): boolean {
  const norm = (m: string) => m.replace(/^models\//, '').replace(/:latest$/, '')
  const want = norm(model)
  return ids.some((id) => id === model || norm(id) === want)
}

/**
 * The API engine (engine/api-agent.ts), without a model call: configured? does the address answer? does the provider
 * accept the key (GET /models; OpenRouter lists models without a key, so its GET /key)? is the model in the provider's
 * list? A provider without a list is "ok" with a note that the model was not checked.
 */
async function checkApiEngine(env: EngineEnv, enabled: boolean, locale: Locale): Promise<EngineStatus> {
  const conf = readApiEngine(env.dataDir)
  let provider: string | undefined
  try { provider = conf ? new URL(conf.baseUrl).host : undefined } catch {}
  const keyless = !!conf && !conf.key && isLocalApiAddress(conf.baseUrl)
  const base = { id: 'api' as const, label: conf ? `${conf.label} (API)` : ENGINE_LABELS.api, enabled, authMode: 'api-key' as const, ...(provider ? { provider } : {}), ...(keyless ? { keyless } : {}), checkedAt: new Date().toISOString(), version: null,
    models: conf ? [{ id: conf.model, label: conf.label }] : [] }
  if (!conf) return { ...base, installed: false, status: 'not_installed', detail: t('apiNotSet', locale) }
  // "No key needed" never next to a refused key (a gateway on the network that does want one)
  const out = (status: EngineStatus['status'], detail: string | null, errorDetail?: string): EngineStatus => {
    const { keyless: _k, ...rest } = base as typeof base & { keyless?: boolean }
    return { ...(status === 'not_logged_in' ? rest : base), installed: true, status, detail, ...(errorDetail ? { errorDetail } : {}) }
  }
  try {
    // Anthropic's model list wants x-api-key (its OpenAI-compatible chat endpoint takes the Bearer header): a refused
    // list would leave a working Claude API engine out of the composer (admin/engine-choice.ts readyEngines)
    const anthropic = /^https:\/\/api\.anthropic\.com\//.test(conf.baseUrl + '/')
    const openrouter = /^https:\/\/openrouter\.ai\//.test(conf.baseUrl + '/')
    const headers: Record<string, string> = conf.key ? { Authorization: `Bearer ${conf.key}`, ...(anthropic ? { 'x-api-key': conf.key, 'anthropic-version': '2023-06-01' } : {}) } : {}
    const get = (p: string) => apiEngineFetch(fetch, { publicCheck: conf.setBy === 'admin' })(`${conf.baseUrl}${p}`, { headers, signal: AbortSignal.timeout(10_000) })
    // OpenRouter: GET /key (older servers: /auth/key); neither there = the key is not checked, and the card says so
    let keyUnchecked = false
    if (openrouter) {
      const k = await openRouterKey(get)
      if (k === 'refused') {
        env.log?.warn('api engine: key refused', { provider, check: 'key' })
        return out('not_logged_in', t('apiKey', locale))
      }
      keyUnchecked = k === 'unchecked'
    }
    // Anthropic's list comes in pages (20 by default)
    const r = await get(anthropic ? '/models?limit=1000' : '/models')
    if (r.status === 401 || r.status === 403) {
      env.log?.warn('api engine: key refused', { provider, status: r.status })
      return out('not_logged_in', t('apiKey', locale))
    }
    // no list here (404, 405): the address and key are not proven wrong, the model is not checked
    if (r.status === 404 || r.status === 405) return out('ok', t('apiModelUnchecked', locale))
    if (!r.ok) return out('error', t('apiHttp', locale, { status: String(r.status) }))
    let ids: string[] = []
    let more = false
    try {
      const j = await r.json() as { data?: { id?: unknown }[]; models?: { name?: unknown; id?: unknown }[]; has_more?: unknown }
      const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []
      ids = list.map((m: any) => (typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : '')).filter(Boolean)
      more = j.has_more === true
    } catch {}
    if (!ids.length || (more && !modelListed(ids, conf.model))) return out('ok', t('apiModelUnchecked', locale))
    if (!modelListed(ids, conf.model)) return out('error', t('apiModel', locale, { model: conf.model.slice(0, 100) }))
    return out('ok', keyUnchecked ? t('apiKeyUnchecked', locale) : null)
  } catch (e) {
    const err = e as Error
    const why = err?.cause instanceof Error ? `${err.message}: ${err.cause.message}` : String(err?.message ?? e)
    // the provider's own words go behind "Show details" (cleaned of the key); the card says what to do
    const slow = err?.name === 'TimeoutError' || /timed? ?out/i.test(why)
    // nothing listens at an address on this computer or the local network (Ollama or LM Studio not started): say so,
    // and what to start (QA TC-4827: the card said only "could not be reached")
    const notRunning = !slow && /ECONNREFUSED|unable to connect|connection refused/i.test(why) && isLocalApiAddress(conf.baseUrl)
    return out('error', slow ? t('checkTimeout', locale, { name: conf.label || ENGINE_LABELS.api }) : notRunning ? t(/:11434(\/|$)/.test(conf.baseUrl) ? 'apiOllamaNotRunning' : 'apiLocalNotRunning', locale) : t('apiUnreachable', locale), supportDetail(why, conf.key))
  }
}

/** Per-context cache of the last check of each engine. */
export class EngineStatusCache {
  private last = new Map<EngineId, { at: number; status: EngineStatus; locale: Locale }>()
  private inflight = new Map<EngineId, Promise<EngineStatus>>()
  /** bumped by forget: a check that started before is not kept (it read the setup that changed) */
  private gen = new Map<EngineId, number>()
  constructor(private env: () => EngineEnv) {}

  /** Drop one engine's last check (its setup changed); a check running now is not kept, the next read checks again. */
  forget(id: EngineId) {
    this.last.delete(id); this.inflight.delete(id)
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1)
  }

  /** The last check's status, without checking. */
  peek(id: EngineId): EngineStatus['status'] | null { return this.last.get(id)?.status.status ?? null }

  async get(id: EngineId, enabled: boolean, locale: Locale, force = false): Promise<EngineStatus> {
    const c = this.last.get(id)
    if (!force && c && Date.now() - c.at < CACHE_MS && c.locale === locale) return { ...c.status, enabled }
    const g = this.gen.get(id) ?? 0
    let p = this.inflight.get(id)
    if (!p) {
      const mine: Promise<EngineStatus> = checkEngine(id, this.env(), enabled, locale).finally(() => { if (this.inflight.get(id) === mine) this.inflight.delete(id) })
      this.inflight.set(id, (p = mine))
    }
    const s = await p
    if ((this.gen.get(id) ?? 0) === g) this.last.set(id, { at: Date.now(), status: s, locale })
    return { ...s, enabled }
  }
}

/** One cache per server, shared by Admin > AI engines and the composer's engine list (admin/engine-choice.ts). A change
 * of the team's AI connections (credentials/store.ts connectionsChanged) drops the two engines that use them. */
const caches = new WeakMap<AppContext, EngineStatusCache>()
export function engineStatusCache(ctx: AppContext): EngineStatusCache {
  let c = caches.get(ctx)
  if (!c) {
    const cache = new EngineStatusCache(() => engineEnv(ctx))
    credentialsOf(ctx).changeListeners.add(() => { cache.forget('claude-code'); cache.forget('codex') })
    caches.set(ctx, (c = cache))
  }
  return c
}
