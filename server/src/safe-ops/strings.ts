import type { Database } from 'bun:sqlite'
import { ToolError } from '../policy/errors'
export const SAFE_OPS_TEXT = {
  searchLimit: {
    ja: "検索入力の上限に達しました。フォルダーやファイル形式を絞って再検索してください。",
    es: "Se alcanzó el límite de archivos de entrada de la búsqueda. Limita la carpeta o el tipo de archivo y vuelve a buscar.",
    ko: '검색 입력 한도에 도달했습니다. 폴더나 파일 형식을 좁혀 다시 검색해 주세요.',
    en: 'The search input limit was reached. Narrow the folder or file type and search again.',
    id: 'Batas masukan pencarian tercapai. Persempit folder atau jenis berkas lalu cari lagi.',
  },
  searchBusy: {
    ja: "検索が進行中のため、生成ファイルを登録できません。検索が終了してから再試行してください。",
    es: "No se puede registrar el archivo generado mientras la búsqueda está en curso. Vuelve a intentarlo cuando termine.",
    ko: '검색이 진행 중이어서 생성 파일을 등록할 수 없습니다. 검색이 끝난 후 다시 시도해 주세요.',
    en: 'A search is in progress and prevents registering this generated file. Try again after it finishes.',
    id: 'Berkas yang dihasilkan belum dapat didaftarkan karena pencarian sedang berlangsung. Coba lagi setelah pencarian selesai.',
  },
  destination: {
    ja: "生成ファイルは skills 以外の既存フォルダーに保存してください。",
    es: "Guarda los archivos generados en una carpeta existente fuera de skills.",
    ko: '생성 파일은 skills 밖의 기존 폴더에 저장해 주세요.',
    en: 'Save generated files in an existing folder outside skills.',
    id: 'Simpan berkas yang dihasilkan di folder yang sudah ada di luar skills.',
  },
  conflict: {
    ja: "承認後に別のファイルが保存先を使用しました。上書きはしていません。再試行すると別の競合コピーを作成します。",
    es: "Otro archivo ocupó el destino después de la aprobación. No se sobrescribió. Vuelve a intentarlo para crear una copia de conflicto separada.",
    ko: '승인 후 저장 위치에 다른 파일이 생겼습니다. 덮어쓰지 않았습니다. 다시 시도하면 별도의 충돌 사본을 만듭니다.',
    en: 'Another file claimed the destination after approval. It was not overwritten. Retry to create an explicit conflict copy.',
    id: 'Berkas lain memakai tujuan setelah persetujuan. Berkas itu tidak ditimpa. Coba lagi untuk membuat salinan konflik terpisah.',
  },
  quarantined: {
    ja: "この生成ファイルはダウンロード専用です。安全な処理経路が検証されるまで、索引作成、テキスト抽出、アプリ内プレビューは利用できません。",
    es: "Este archivo generado solo se puede descargar. La indexación, la extracción de texto y la vista previa en la aplicación están desactivadas hasta que se verifique un procesamiento seguro.",
    ko: '이 생성 파일은 다운로드 전용입니다. 안전한 소비 경로가 검증될 때까지 색인, 텍스트 추출 및 앱 내 미리보기를 제공하지 않습니다.',
    en: 'This generated file is download-only. Indexing, text extraction and in-app previews are disabled until a safe consumer is qualified.',
    id: 'Berkas yang dihasilkan ini hanya dapat diunduh. Pengindeksan, ekstraksi teks, dan pratinjau dalam aplikasi dinonaktifkan sampai pemroses aman terverifikasi.',
  },
  workflow: {
    ja: "この返答で安全なPowerPointの上限（元ファイル32個、1ファイル32 MiB、返答ごとの保存上限）に達しました。新しいメッセージで続けてください。ファイルは保存していません。",
    es: "Esta respuesta alcanzó un límite de PowerPoint seguro (como máximo 32 archivos de origen, 32 MiB por archivo y el límite de escritura de la respuesta). Envía un mensaje nuevo para continuar. No se guardó nada.",
    ko: "이 답에서 안전한 PowerPoint 한도(원본 파일 32개, 파일 하나 32 MiB, 답 하나의 저장 한도)에 도달했어요. 새 메시지로 이어서 요청해 주세요. 파일은 저장하지 않았어요.",
    en: "This reply reached a safe PowerPoint limit (at most 32 source files, 32 MiB per file and the reply's write limit). Send a new message to continue. Nothing was saved.",
    id: "Balasan ini mencapai batas PowerPoint aman (paling banyak 32 berkas sumber, 32 MiB per berkas, dan batas penulisan balasan). Kirim pesan baru untuk melanjutkan. Tidak ada berkas yang disimpan.",
  },
  imageLimit: {
    ja: "対応していない画像形式またはサイズです。8 MiB 以下の PNG、JPEG、WebP、HEIC 画像を使用してください。",
    es: "Formato o tamaño de imagen no compatible. Usa imágenes PNG, JPEG, WebP o HEIC de hasta 8 MiB.",
    ko: "이미지 형식 또는 크기를 지원하지 않습니다. PNG, JPEG, WebP, HEIC 형식의 8 MiB 이하 이미지를 사용하세요.",
    en: "Unsupported image format or size. Use PNG, JPEG, WebP or HEIC images up to 8 MiB.",
    id: "Format atau ukuran gambar tidak didukung. Gunakan gambar PNG, JPEG, WebP, atau HEIC hingga 8 MiB.",
  },
  input: {
    ja: "対応していないプレゼンテーション内容です。生のマークアップ、リンク、独自属性を含まない Markdown を使用し、メタデータはタイトル・作成者・日付のみ指定してください。",
    es: "Contenido de presentación no compatible. Usa Markdown sin marcado sin procesar, enlaces ni atributos personalizados; los metadatos solo pueden incluir título, autor y fecha.",
    ko: "지원하지 않는 발표 자료 내용입니다. 원시 마크업, 링크, 사용자 지정 속성 없이 Markdown을 사용하고 메타데이터는 제목·작성자·날짜만 지정하세요.",
    en: "Unsupported presentation content. Use Markdown without raw markup, links or custom attributes; metadata may contain only title, author and date.",
    id: "Konten presentasi tidak didukung. Gunakan Markdown tanpa markup mentah, tautan, atau atribut khusus; metadata hanya boleh berisi judul, penulis, dan tanggal.",
  },
  source: {
    ja: "PowerPoint の原稿は Markdown またはテキストファイルである必要があります。",
    es: "El archivo de origen de PowerPoint debe ser Markdown o texto.",
    ko: "PowerPoint 원본은 Markdown 또는 텍스트 파일이어야 합니다.",
    en: "The PowerPoint source must be a Markdown or text file.",
    id: "Sumber PowerPoint harus berupa berkas Markdown atau teks.",
  },
  sourceChanged: {
    ja: "元ファイルが変更されたか、安全な読み取り上限を超えています。ファイルを確認して再度読み込んでください。",
    es: "El archivo de origen cambió o supera el límite de lectura segura. Comprueba el archivo y vuelve a leerlo.",
    ko: "원본 파일이 변경되었거나 안전한 읽기 한도를 초과했습니다. 파일을 확인하고 다시 읽어 주세요.",
    en: "The source changed or exceeds the safe read limit. Check the file and read it again.",
    id: "Sumber berubah atau melampaui batas baca aman. Periksa berkas dan baca kembali.",
  },
  sourceMount: {
    ja: "このマウントされたフォルダーは、安全な画像・PowerPoint 変換の検証対象外です。",
    es: "Esta carpeta montada no está verificada para la conversión segura de imágenes o PowerPoint.",
    ko: "이 연결 폴더는 안전한 이미지·PowerPoint 변환을 지원하지 않습니다.",
    en: "This mounted folder is not qualified for safe image/PowerPoint conversion.",
    id: "Folder terpasang ini belum memenuhi syarat konversi gambar/PowerPoint yang aman.",
  },
  failed: {
    ja: "安全な上限内でファイルを変換できませんでした。ファイルは保存していません。",
    es: "No se pudo convertir el archivo dentro de los límites de seguridad. No se guardó nada.",
    ko: "안전 한도 내에서 파일을 변환하지 못했습니다. 파일을 저장하지 않았습니다.",
    en: "The file could not be converted within the safety limits. Nothing was saved.",
    id: "Berkas tidak dapat dikonversi dalam batas keamanan. Tidak ada berkas yang disimpan.",
  },
  busy: {
    ja: "安全な変換処理を実行中です。しばらくしてから再試行してください。",
    es: "El conversor seguro está ocupado. Vuelve a intentarlo en unos instantes.",
    ko: "안전 변환기를 사용 중입니다. 잠시 후 다시 시도하세요.",
    en: "The safe converter is busy. Try again shortly.",
    id: "Konverter aman sedang sibuk. Coba lagi sebentar.",
  },
  external: {
    ja: "この機密文書の会話では、外部ツールとウェブ検索は利用できません。",
    es: "Las herramientas externas y la búsqueda web están desactivadas en esta conversación sobre documentos confidenciales.",
    ko: "기밀 문서 대화에서는 외부 도구와 웹 검색을 사용할 수 없습니다.",
    en: "External tools and web search are disabled in this confidential-document conversation.",
    id: "Alat eksternal dan pencarian web dinonaktifkan dalam percakapan dokumen rahasia ini.",
  },
  changed: {
    ja: "送信前に権限または元ファイルが変更されました。ファイルを再度読み込んでください。",
    es: "El acceso o el archivo de origen cambió antes de la entrega. Vuelve a leer el archivo.",
    ko: "전달 전에 권한이나 원본 파일이 변경되었습니다. 파일을 다시 읽어 주세요.",
    en: "Access or the source file changed before delivery. Read the file again.",
    id: "Akses atau berkas sumber berubah sebelum dikirim. Baca kembali berkas tersebut.",
  },
  unavailable: {
    ja: "このサーバーでは安全なPowerPoint変換を使えません。標準インストーラーで設定したLinuxサーバー（systemd、bubblewrap、委任された変換グループ）で安全な処理1Aを有効にする必要があります。ファイルは保存していません。",
    es: "La conversión segura de PowerPoint no está disponible en este servidor: necesita las operaciones seguras 1A en un servidor Linux configurado con el instalador estándar (systemd, bubblewrap y un grupo de conversión delegado). No se guardó nada.",
    ko: "이 서버에서는 안전한 PowerPoint 변환을 쓸 수 없어요. 표준 설치기로 설치한 리눅스 서버(systemd, bubblewrap, 위임된 변환기 그룹)에서 안전 작업 1A를 켜야 해요. 파일은 저장하지 않았어요.",
    en: "Safe PowerPoint conversion is not available on this server: it needs safe operations 1A on a Linux server set up by the standard installer (systemd, bubblewrap and a delegated converter group). Nothing was saved.",
    id: "Konversi PowerPoint aman tidak tersedia di server ini: diperlukan operasi aman 1A di server Linux yang dipasang dengan installer standar (systemd, bubblewrap, dan grup konverter yang didelegasikan). Tidak ada berkas yang disimpan.",
  },
  cleanup: {
    ja: "以前の安全なPowerPoint処理の後片付けが完了していないため、このサーバーでは新しい処理を止めています。管理者がサーバーを確認する必要があります（docs/SAFE-OPS-1A.md「Workflow admission and recovery」）。ファイルは保存していません。",
    es: "Un trabajo seguro de PowerPoint anterior no terminó su limpieza, así que los nuevos están en pausa en este servidor. Un administrador debe revisar el servidor (docs/SAFE-OPS-1A.md, «Workflow admission and recovery»). No se guardó nada.",
    ko: "이전 안전 PowerPoint 작업의 정리가 끝나지 않아 이 서버에서 새 작업을 멈췄어요. 관리자가 서버를 확인해야 해요(docs/SAFE-OPS-1A.md \"Workflow admission and recovery\"). 파일은 저장하지 않았어요.",
    en: "A previous safe PowerPoint job could not finish cleaning up, so new ones are paused on this server. An administrator needs to check the server (docs/SAFE-OPS-1A.md, \"Workflow admission and recovery\"). Nothing was saved.",
    id: "Pekerjaan PowerPoint aman sebelumnya belum selesai dibersihkan, jadi pekerjaan baru dihentikan sementara di server ini. Administrator perlu memeriksa server (docs/SAFE-OPS-1A.md, \"Workflow admission and recovery\"). Tidak ada berkas yang disimpan.",
  },
  hourLimit: {
    ja: "安全なPowerPoint処理は1人あたり1時間に8回までです（変換を始める前に止まった試行は数えません）。約{minutes}分後にもう一度作成できます。ファイルは保存していません。",
    es: "Alcanzaste el límite de 8 trabajos seguros de PowerPoint por hora (los intentos que se detuvieron antes de convertir no cuentan). Podrás crear otro en unos {minutes} min. No se guardó nada.",
    ko: "안전한 PowerPoint 작업은 한 사람당 1시간에 8번까지 할 수 있어요(변환을 시작하기 전에 멈춘 시도는 세지 않아요). 약 {minutes}분 뒤에 다시 만들 수 있어요. 파일은 저장하지 않았어요.",
    en: "You have reached the limit of 8 safe PowerPoint jobs per hour (tries that stopped before converting anything do not count). You can make another in about {minutes} min. Nothing was saved.",
    id: "Anda sudah mencapai batas 8 pekerjaan PowerPoint aman per jam (percobaan yang berhenti sebelum konversi tidak dihitung). Anda dapat membuat lagi dalam sekitar {minutes} menit. Tidak ada berkas yang disimpan.",
  },
  turnLimit: {
    ja: "1回の返答で実行できる安全なPowerPoint処理は4回までです。新しいメッセージでもう一度依頼してください。ファイルは保存していません。",
    es: "Una respuesta puede ejecutar como máximo 4 trabajos seguros de PowerPoint. Envía un mensaje nuevo para intentarlo otra vez. No se guardó nada.",
    ko: "한 번의 답에서는 안전한 PowerPoint 작업을 4번까지 할 수 있어요. 새 메시지로 다시 요청해 주세요. 파일은 저장하지 않았어요.",
    en: "One reply can run at most 4 safe PowerPoint jobs. Send a new message to try again. Nothing was saved.",
    id: "Satu balasan dapat menjalankan paling banyak 4 pekerjaan PowerPoint aman. Kirim pesan baru untuk mencoba lagi. Tidak ada berkas yang disimpan.",
  },
  budget: {
    ja: "この返答で使える1時間あたりの安全な変換量（変換24ステップ、CPU 10分、ファイル512 MiB）を使い切りました。新しいメッセージで依頼するか、約{minutes}分待ってください。ファイルは保存していません。",
    es: "Esta respuesta agotó su cuota horaria de conversión segura (24 pasos de conversión, 10 minutos de CPU y 512 MiB de archivos). Envía un mensaje nuevo o espera unos {minutes} min. No se guardó nada.",
    ko: "이 답에서 쓸 수 있는 1시간 안전 변환량(변환 단계 24개, CPU 10분, 파일 512 MiB)을 다 썼어요. 새 메시지로 요청하거나 약 {minutes}분 뒤에 다시 시도해 주세요. 파일은 저장하지 않았어요.",
    en: "This reply used up its hourly safe conversion budget (24 conversion steps, 10 CPU minutes and 512 MiB of files). Send a new message, or wait about {minutes} min. Nothing was saved.",
    id: "Balasan ini sudah menghabiskan jatah konversi aman per jam (24 langkah konversi, 10 menit CPU, dan 512 MiB berkas). Kirim pesan baru, atau tunggu sekitar {minutes} menit. Tidak ada berkas yang disimpan.",
  },
  notReadyGroup: {
    ja: "安全なPowerPointは有効ですが、このサーバーはまだ準備ができていません。サーバーとAIエンジンが、メモリとCPUの上限がある資源グループに入っていません。管理者がサーバーで`sudo mycel-ctl safe-ops on`を実行してください。ファイルは保存していません。",
    es: "PowerPoint seguro está activado, pero este servidor no está listo: el servidor y los motores de IA no están dentro de un grupo de recursos con límites de memoria y CPU. Un administrador debe ejecutar `sudo mycel-ctl safe-ops on` en el servidor para configurarlo. No se guardó nada.",
    ko: "안전한 PowerPoint가 켜져 있지만 이 서버는 아직 준비되지 않았어요. 서버와 AI 엔진을 메모리·CPU 한도가 있는 자원 그룹으로 묶어야 해요. 관리자가 서버에서 `sudo mycel-ctl safe-ops on`을 실행하면 돼요. 파일은 저장하지 않았어요.",
    en: "Safe PowerPoint is turned on, but this server is not ready: the server and the AI engines are not inside a resource group with memory and CPU limits. An administrator runs `sudo mycel-ctl safe-ops on` on the server to set it up. Nothing was saved.",
    id: "PowerPoint aman sudah aktif, tetapi server ini belum siap: server dan mesin AI belum berada dalam grup sumber daya dengan batas memori dan CPU. Administrator menjalankan `sudo mycel-ctl safe-ops on` di server untuk menyiapkannya. Tidak ada berkas yang disimpan.",
  },
  notReadyPrograms: {
    ja: "安全なPowerPointは有効ですが、このサーバーはまだ準備ができていません。実行する変換プログラム（pandoc と mycel-safeops）が管理者（root）所有のコピーとしてインストールされていません。管理者がサーバーで`sudo mycel-ctl safe-ops on`を実行するか、インストーラーで更新してください。ファイルは保存していません。",
    es: "PowerPoint seguro está activado, pero este servidor no está listo: los programas de conversión que ejecuta (pandoc y mycel-safeops) no están instalados como copias propiedad del administrador (root). Un administrador debe ejecutar `sudo mycel-ctl safe-ops on` en el servidor o actualizar la instalación con el instalador. No se guardó nada.",
    ko: "안전한 PowerPoint가 켜져 있지만 이 서버는 아직 준비되지 않았어요. 변환 프로그램(pandoc, mycel-safeops)이 관리자(root) 소유 사본으로 설치되어 있지 않아요. 관리자가 서버에서 `sudo mycel-ctl safe-ops on`을 실행하거나 설치기로 업데이트하면 돼요. 파일은 저장하지 않았어요.",
    en: "Safe PowerPoint is turned on, but this server is not ready: the converter programs it runs (pandoc and mycel-safeops) are not installed as administrator-owned (root) copies. An administrator runs `sudo mycel-ctl safe-ops on` on the server, or updates the install with the installer. Nothing was saved.",
    id: "PowerPoint aman sudah aktif, tetapi server ini belum siap: program konversi yang dijalankannya (pandoc dan mycel-safeops) belum terpasang sebagai salinan milik administrator (root). Administrator menjalankan `sudo mycel-ctl safe-ops on` di server, atau memperbarui instalasi dengan installer. Tidak ada berkas yang disimpan.",
  },
  groupMemory: {
    ja: "現在、サーバーの資源グループに安全な変換に必要な空きメモリ（640 MiB）がありません。数分後にもう一度お試しください。ファイルは保存していません。",
    es: "Ahora mismo, el grupo de recursos del servidor no tiene suficiente memoria libre para una conversión segura (necesita 640 MiB). Inténtalo de nuevo en unos minutos. No se guardó nada.",
    ko: "지금은 서버 자원 그룹의 여유 메모리가 부족해서 안전 변환을 시작할 수 없어요(640 MiB 필요). 몇 분 뒤 다시 시도해 주세요. 파일은 저장하지 않았어요.",
    en: "The server's resource group is short of free memory for a safe conversion right now (it needs 640 MiB free). Try again in a few minutes. Nothing was saved.",
    id: "Grup sumber daya server saat ini kekurangan memori bebas untuk konversi aman (perlu 640 MiB). Coba lagi dalam beberapa menit. Tidak ada berkas yang disimpan.",
  },
  template: {
    ja: "アップロードした PowerPoint テンプレートには対応していません。組み込みレイアウトを使用してください。",
    es: "Las plantillas de PowerPoint subidas no son compatibles. Usa los diseños incluidos.",
    ko: "업로드한 PowerPoint 템플릿은 지원하지 않습니다. 기본 제공 레이아웃을 사용하세요.",
    en: "Uploaded PowerPoint templates are not supported. Use the bundled layouts.",
    id: "Templat PowerPoint yang diunggah belum didukung. Gunakan tata letak bawaan.",
  },
  limit: {
    ja: "プレゼンテーションが安全な上限（30 スライド、20 画像、100,000 文字）を超えています。ファイルは保存していません。",
    es: "La presentación supera los límites de seguridad (30 diapositivas, 20 imágenes, 100.000 caracteres). No se guardó nada.",
    ko: "발표 자료의 안전 한도(슬라이드 30장, 이미지 20개, 텍스트 100,000자)를 초과했습니다. 파일을 저장하지 않았습니다.",
    en: "The presentation exceeds the safety limits (30 slides, 20 images, 100,000 text characters). Nothing was saved.",
    id: "Presentasi melampaui batas keamanan (30 slide, 20 gambar, 100.000 karakter). Tidak ada berkas yang disimpan.",
  },
}
/** A 1A refusal whose localized text needs numbers (minutes until the hourly limit frees a slot). The English message
 * stays in the tool log; the person and the AI get SAFE_OPS_TEXT in their language with `vars` filled in. */
export class SafeOpsError extends ToolError {
  constructor(message: string, code: string, readonly vars: Record<string, string | number> = {}) {
    super(message, code)
  }
}
/** Tool error code -> SAFE_OPS_TEXT key: each refusal has its own words (QA 2026-10-30 B3: one text used to cover
 * "hourly limit" and "cleanup failed", and the person could not tell which, or when to try again). */
export const SAFE_ERROR_KEYS = {
  safe_ops_unavailable: 'unavailable',
  safe_ops_not_ready_group: 'notReadyGroup',
  safe_ops_not_ready_programs: 'notReadyPrograms',
  safe_ops_group_memory: 'groupMemory',
  safe_ops_limit: 'limit',
  safe_ops_failed: 'failed',
  safe_ops_busy: 'busy',
  safe_ops_search_busy: 'searchBusy',
  safe_ops_image_limit: 'imageLimit',
  safe_ops_quarantined: 'quarantined',
  safe_ops_conflict: 'conflict',
  safe_ops_destination: 'destination',
  safe_ops_workflow: 'workflow',
  safe_ops_cleanup: 'cleanup',
  safe_ops_hour_limit: 'hourLimit',
  safe_ops_turn_limit: 'turnLimit',
  safe_ops_budget: 'budget',
  safe_ops_changed: 'changed',
} as const satisfies Record<string, keyof typeof SAFE_OPS_TEXT>
export function safeErrorText(db: Database, userId: string, code: string, message: string, vars?: Record<string, string | number>): string {
  const key = SAFE_ERROR_KEYS[code as keyof typeof SAFE_ERROR_KEYS]
  return key ? safeText(db, userId, key, vars) : message
}
/** The localized text of a ToolError for the person and the AI (registry / file service). */
export function toolErrorText(db: Database, userId: string, e: ToolError): string {
  return safeErrorText(db, userId, e.code, e.message, e instanceof SafeOpsError ? e.vars : undefined)
}
export function safeText(db: Database, userId: string, key: keyof typeof SAFE_OPS_TEXT, vars: Record<string, string | number> = {}): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' ? u.locale : 'en'
  return SAFE_OPS_TEXT[key][locale].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
