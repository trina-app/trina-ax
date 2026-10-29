import type { Database } from 'bun:sqlite'
export const SAFE_OPS_TEXT = {
  searchLimit: {
    ko: '검색 입력 한도에 도달했습니다. 폴더나 파일 형식을 좁혀 다시 검색해 주세요.',
    en: 'The search input limit was reached. Narrow the folder or file type and search again.',
    id: 'Batas masukan pencarian tercapai. Persempit folder atau jenis berkas lalu cari lagi.',
  },
  searchBusy: {
    ko: '검색이 이 파일의 내용을 사용 중입니다. 검색이 끝난 후 다시 시도해 주세요.',
    en: 'A search is using these file contents. Try again after it finishes.',
    id: 'Pencarian sedang menggunakan isi berkas ini. Coba lagi setelah selesai.',
  },
  destination: {
    ko: '생성 파일은 skills 밖의 기존 폴더에 저장해 주세요.',
    en: 'Save generated files in an existing folder outside skills.',
    id: 'Simpan berkas yang dihasilkan di folder yang sudah ada di luar skills.',
  },
  conflict: {
    ko: '승인 후 저장 위치에 다른 파일이 생겼습니다. 덮어쓰지 않았습니다. 다시 시도하면 별도의 충돌 사본을 만듭니다.',
    en: 'Another file claimed the destination after approval. It was not overwritten. Retry to create an explicit conflict copy.',
    id: 'Berkas lain memakai tujuan setelah persetujuan. Berkas itu tidak ditimpa. Coba lagi untuk membuat salinan konflik terpisah.',
  },
  quarantined: {
    ko: '이 생성 파일은 다운로드 전용입니다. 안전한 소비 경로가 검증될 때까지 색인, 텍스트 추출 및 앱 내 미리보기를 제공하지 않습니다.',
    en: 'This generated file is download-only. Indexing, text extraction and in-app previews are disabled until a safe consumer is qualified.',
    id: 'Berkas yang dihasilkan ini hanya dapat diunduh. Pengindeksan, ekstraksi teks, dan pratinjau dalam aplikasi dinonaktifkan sampai pemroses aman terverifikasi.',
  },
  workflow: {
    ko: '안전 작업 한도에 도달했거나 정리가 완료되지 않았습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.',
    en: 'The safe workflow limit was reached or cleanup is incomplete. Retry later or contact the administrator.',
    id: 'Batas alur kerja aman tercapai atau pembersihan belum selesai. Coba lagi nanti atau hubungi administrator.',
  },
  imageLimit: {
    ko: "이미지 형식 또는 크기를 지원하지 않습니다. PNG, JPEG, WebP, HEIC 형식의 8 MiB 이하 이미지를 사용하세요.",
    en: "Unsupported image format or size. Use PNG, JPEG, WebP or HEIC images up to 8 MiB.",
    id: "Format atau ukuran gambar tidak didukung. Gunakan gambar PNG, JPEG, WebP, atau HEIC hingga 8 MiB.",
  },
  input: {
    ko: "지원하지 않는 발표 자료 내용입니다. 원시 마크업, 링크, 사용자 지정 속성 없이 Markdown을 사용하고 메타데이터는 제목·작성자·날짜만 지정하세요.",
    en: "Unsupported presentation content. Use Markdown without raw markup, links or custom attributes; metadata may contain only title, author and date.",
    id: "Konten presentasi tidak didukung. Gunakan Markdown tanpa markup mentah, tautan, atau atribut khusus; metadata hanya boleh berisi judul, penulis, dan tanggal.",
  },
  source: {
    ko: "PowerPoint 원본은 Markdown 또는 텍스트 파일이어야 합니다.",
    en: "The PowerPoint source must be a Markdown or text file.",
    id: "Sumber PowerPoint harus berupa berkas Markdown atau teks.",
  },
  sourceChanged: {
    ko: "원본 파일이 변경되었거나 안전한 읽기 한도를 초과했습니다. 파일을 확인하고 다시 읽어 주세요.",
    en: "The source changed or exceeds the safe read limit. Check the file and read it again.",
    id: "Sumber berubah atau melampaui batas baca aman. Periksa berkas dan baca kembali.",
  },
  sourceMount: {
    ko: "이 연결 폴더는 안전한 이미지·PowerPoint 변환을 지원하지 않습니다.",
    en: "This mounted folder is not qualified for safe image/PowerPoint conversion.",
    id: "Folder terpasang ini belum memenuhi syarat konversi gambar/PowerPoint yang aman.",
  },
  failed: {
    ko: "안전 한도 내에서 파일을 변환하지 못했습니다. 파일을 저장하지 않았습니다.",
    en: "The file could not be converted within the safety limits. Nothing was saved.",
    id: "Berkas tidak dapat dikonversi dalam batas keamanan. Tidak ada berkas yang disimpan.",
  },
  busy: {
    ko: "안전 변환기를 사용 중입니다. 잠시 후 다시 시도하세요.",
    en: "The safe converter is busy. Try again shortly.",
    id: "Konverter aman sedang sibuk. Coba lagi sebentar.",
  },
  external: {
    ko: "기밀 문서 대화에서는 외부 도구와 웹 검색을 사용할 수 없습니다.",
    en: "External tools and web search are disabled in this confidential-document conversation.",
    id: "Alat eksternal dan pencarian web dinonaktifkan dalam percakapan dokumen rahasia ini.",
  },
  changed: {
    ko: "전달 전에 권한이나 원본 파일이 변경되었습니다. 파일을 다시 읽어 주세요.",
    en: "Access or the source file changed before delivery. Read the file again.",
    id: "Akses atau berkas sumber berubah sebelum dikirim. Baca kembali berkas tersebut.",
  },
  fallback: {
    ko: "이미지를 직접 전달할 수 없습니다. 가능한 경우 OCR 텍스트를 제공합니다.",
    en: "Image pixels are unavailable. OCR text, if available, follows.",
    id: "Piksel gambar tidak tersedia. Teks OCR disertakan jika tersedia.",
  },
  image: {
    ko: "이미지를 설정된 AI 제공자에게 전달합니다. 원본과 읽기 범위를 기록합니다.",
    en: "Image pixels are sent to the configured model provider. Source and read scope are retained.",
    id: "Piksel gambar dikirim ke penyedia model yang dikonfigurasi. Sumber dan cakupan baca dicatat.",
  },
  unavailable: {
    ko: "안전한 이미지·PowerPoint 변환에는 검증된 Linux 변환기가 필요합니다. 파일을 저장하지 않았습니다.",
    en: "Safe image/PowerPoint conversion requires a qualified Linux converter. Nothing was saved.",
    id: "Konversi gambar/PowerPoint yang aman memerlukan konverter Linux yang terverifikasi. Tidak ada berkas yang disimpan.",
  },
  template: {
    ko: "업로드한 PowerPoint 템플릿은 지원하지 않습니다. 기본 제공 레이아웃을 사용하세요.",
    en: "Uploaded PowerPoint templates are not supported. Use the bundled layouts.",
    id: "Templat PowerPoint yang diunggah belum didukung. Gunakan tata letak bawaan.",
  },
  limit: {
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
  const locale = u?.locale === 'ko' || u?.locale === 'id' ? u.locale : 'en'
  return SAFE_OPS_TEXT[key][locale]
}
