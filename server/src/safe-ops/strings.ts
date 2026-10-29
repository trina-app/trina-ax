import type { Database } from 'bun:sqlite'
export const SAFE_OPS_TEXT = {
  searchLimit: {
    ja: "検索入力の上限に達しました。フォルダーやファイル形式を絞って再検索してください。",
    es: "Se alcanzó el límite de archivos de entrada de la búsqueda. Limita la carpeta o el tipo de archivo y vuelve a buscar.",
    ko: '검색 입력 한도에 도달했습니다. 폴더나 파일 형식을 좁혀 다시 검색해 주세요.',
    en: 'The search input limit was reached. Narrow the folder or file type and search again.',
    id: 'Batas masukan pencarian tercapai. Persempit folder atau jenis berkas lalu cari lagi.',
  },
  searchBusy: {
    ja: "検索でこのファイルの内容を使用中です。検索が終了してから再試行してください。",
    es: "Una búsqueda está utilizando el contenido de este archivo. Vuelve a intentarlo cuando termine.",
    ko: '검색이 이 파일의 내용을 사용 중입니다. 검색이 끝난 후 다시 시도해 주세요.',
    en: 'A search is using these file contents. Try again after it finishes.',
    id: 'Pencarian sedang menggunakan isi berkas ini. Coba lagi setelah selesai.',
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
    ja: "安全な処理の上限に達したか、後処理が完了していません。後で再試行するか、管理者にお問い合わせください。",
    es: "Se alcanzó el límite del flujo de trabajo seguro o la limpieza está incompleta. Vuelve a intentarlo más tarde o contacta con el administrador.",
    ko: '안전 작업 한도에 도달했거나 정리가 완료되지 않았습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.',
    en: 'The safe workflow limit was reached or cleanup is incomplete. Retry later or contact the administrator.',
    id: 'Batas alur kerja aman tercapai atau pembersihan belum selesai. Coba lagi nanti atau hubungi administrator.',
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
  fallback: {
    ja: "画像を直接送信できません。利用可能な場合は OCR テキストを表示します。",
    es: "No se pueden enviar los píxeles de la imagen. A continuación se incluye el texto OCR, si está disponible.",
    ko: "이미지를 직접 전달할 수 없습니다. 가능한 경우 OCR 텍스트를 제공합니다.",
    en: "Image pixels are unavailable. OCR text, if available, follows.",
    id: "Piksel gambar tidak tersedia. Teks OCR disertakan jika tersedia.",
  },
  image: {
    ja: "画像を設定済みの AI 提供元に送信します。元ファイルと読み取り範囲を記録します。",
    es: "Los píxeles de la imagen se envían al proveedor de modelos configurado. Se conservan el origen y el alcance de lectura.",
    ko: "이미지를 설정된 AI 제공자에게 전달합니다. 원본과 읽기 범위를 기록합니다.",
    en: "Image pixels are sent to the configured model provider. Source and read scope are retained.",
    id: "Piksel gambar dikirim ke penyedia model yang dikonfigurasi. Sumber dan cakupan baca dicatat.",
  },
  unavailable: {
    ja: "安全な画像・PowerPoint 変換には、検証済みの Linux 変換環境が必要です。ファイルは保存していません。",
    es: "La conversión segura de imágenes o PowerPoint requiere un conversor Linux verificado. No se guardó nada.",
    ko: "안전한 이미지·PowerPoint 변환에는 검증된 Linux 변환기가 필요합니다. 파일을 저장하지 않았습니다.",
    en: "Safe image/PowerPoint conversion requires a qualified Linux converter. Nothing was saved.",
    id: "Konversi gambar/PowerPoint yang aman memerlukan konverter Linux yang terverifikasi. Tidak ada berkas yang disimpan.",
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
export function safeErrorText(db: Database, userId: string, code: string, message: string): string {
  const key = (
    {
      safe_ops_unavailable: 'unavailable',
      safe_ops_limit: 'limit',
      safe_ops_failed: 'failed',
      safe_ops_busy: 'busy',
      safe_ops_search_busy: 'searchBusy',
      safe_ops_image_limit: 'imageLimit',
      safe_ops_quarantined: 'quarantined',
      safe_ops_conflict: 'conflict',
      safe_ops_destination: 'destination',
      safe_ops_workflow: 'workflow',
      safe_ops_changed: 'changed',
    } as const
  )[code as 'safe_ops_unavailable']
  return key ? safeText(db, userId, key) : message
}
export function safeText(db: Database, userId: string, key: keyof typeof SAFE_OPS_TEXT): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' ? u.locale : 'en'
  return SAFE_OPS_TEXT[key][locale]
}
