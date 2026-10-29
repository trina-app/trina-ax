import type { Database } from 'bun:sqlite'
export const SAFE_OPS_TEXT = {
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
    } as const
  )[code as 'safe_ops_unavailable']
  return key ? safeText(db, userId, key) : message
}
export function safeText(db: Database, userId: string, key: keyof typeof SAFE_OPS_TEXT): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' ? u.locale : 'en'
  return SAFE_OPS_TEXT[key][locale]
}
