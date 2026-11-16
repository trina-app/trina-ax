// Notes the AI gets about a video or audio read (files/media.ts, files/service.ts readMedia), in the person's language:
// why the file could not be read, why its sound was not transcribed. The AI usually passes them on. What the AI must
// send next (a `time` value) stays English in the result itself, like the other tool contracts. The frames follow the
// image notes of vision-text.ts (switch off, API engine, connection, turn budget).
// Members read these through the AI: no "server", "Linux", "Mac server", tool or package names (AI scenario check
// VIEW-08, 2026-11-16: "Linux servers can" became "switch the server to Linux"). Only the *Admin notes, given to an
// owner or admin, may name what to install (tests/unit/media-text.test.ts).
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'

export const MEDIA_TEXT = {
  mac: {
    ko: '여기서는 아직 녹음·영상 파일을 열 수 없어요. 직접 들어 보시고 주요 내용을 알려 주시거나 받아 적은 글을 붙여 주시면 정리해 드릴게요.',
    en: 'Recordings and videos can\'t be opened here yet. If you play the file and tell me the main points, or paste a transcript, I can summarize it.',
    id: 'Rekaman dan video belum bisa dibuka di sini. Kalau Anda memutarnya lalu memberi tahu poin utamanya, atau menempelkan transkripnya, saya bisa merangkumnya.',
    ja: 'ここではまだ録音・動画ファイルを開けません。再生して要点を教えていただくか、書き起こしを貼り付けていただければ、まとめます。',
    es: 'Aquí todavía no se pueden abrir grabaciones ni videos. Si lo reproduce y me cuenta los puntos principales, o pega una transcripción, puedo resumirlo.',
    zh: '这里还不能打开录音和视频文件。您可以播放后告诉我要点，或者粘贴文字稿，我来帮您整理。',
  },
  /** added to `mac` when voice input works on this install */
  macVoice: {
    ko: '마이크 버튼을 눌러 말로 알려 주셔도 돼요.',
    en: 'You can also tell me by voice with the microphone button.',
    id: 'Anda juga bisa memberi tahu saya lewat suara dengan tombol mikrofon.',
    ja: 'マイクボタンを押して、声で伝えていただくこともできます。',
    es: 'También puede decírmelo por voz con el botón del micrófono.',
    zh: '也可以点麦克风按钮，用语音告诉我。',
  },
  noTool: {
    ko: '지금은 여기서 녹음·영상 파일을 열 수 없어요. 직접 들어 보시고 주요 내용을 알려 주시거나 받아 적은 글을 붙여 주시면 정리해 드릴게요. 관리자가 고칠 수도 있어요.',
    en: 'Recordings and videos can\'t be opened here right now. If you play the file and tell me the main points, or paste a transcript, I can summarize it. An admin can also fix this.',
    id: 'Rekaman dan video tidak bisa dibuka di sini saat ini. Kalau Anda memutarnya lalu memberi tahu poin utamanya, atau menempelkan transkripnya, saya bisa merangkumnya. Admin juga dapat memperbaikinya.',
    ja: '現在ここでは録音・動画ファイルを開けません。再生して要点を教えていただくか、書き起こしを貼り付けていただければ、まとめます。管理者が直すこともできます。',
    es: 'Ahora mismo aquí no se pueden abrir grabaciones ni videos. Si lo reproduce y me cuenta los puntos principales, o pega una transcripción, puedo resumirlo. Un administrador también puede solucionarlo.',
    zh: '现在这里打不开录音和视频文件。您可以播放后告诉我要点，或者粘贴文字稿，我来帮您整理。管理员也可以解决这个问题。',
  },
  /** `noTool` for an owner or admin, who can install it */
  noToolAdmin: {
    ko: '지금은 여기서 녹음·영상 파일을 열 수 없어요. {product}가 설치된 컴퓨터에 ffmpeg 패키지가 없어서예요. 설치하면 열 수 있어요.',
    en: 'Recordings and videos can\'t be opened here right now: the ffmpeg package is missing on the computer {product} runs on. Installing it fixes this.',
    id: 'Rekaman dan video tidak bisa dibuka di sini saat ini: paket ffmpeg tidak ada di komputer tempat {product} berjalan. Memasangnya akan memperbaiki ini.',
    ja: '現在ここでは録音・動画ファイルを開けません。{product} が動いているコンピューターに ffmpeg パッケージがないためです。インストールすると開けるようになります。',
    es: 'Ahora mismo aquí no se pueden abrir grabaciones ni videos: falta el paquete ffmpeg en el equipo donde se ejecuta {product}. Instalarlo lo soluciona.',
    zh: '现在这里打不开录音和视频文件：运行 {product} 的电脑上缺少 ffmpeg 软件包。安装后即可打开。',
  },
  tooLarge: {
    ko: '파일이 너무 커서({gb}GB 초과) 읽을 수 없어요. 잘라서 올려 주세요.',
    en: 'The file is too large to read (over {gb} GB). Split it into shorter parts.',
    id: 'Berkas terlalu besar untuk dibaca (lebih dari {gb} GB). Bagi menjadi bagian yang lebih pendek.',
    ja: 'ファイルが大きすぎるため読み取れません（{gb} GB 超）。短く分割してください。',
    es: 'El archivo es demasiado grande para leerlo (más de {gb} GB). Divídalo en partes más cortas.',
    zh: '文件太大，无法读取（超过{gb} GB）。请把它拆成几段较短的文件。',
  },
  tooLong: {
    ko: '파일이 {h}시간보다 길어 읽을 수 없어요.',
    en: 'The file is longer than {h} hours, so it cannot be read.',
    id: 'Berkas lebih panjang dari {h} jam, jadi tidak dapat dibaca.',
    ja: 'ファイルが {h} 時間より長いため読み取れません。',
    es: 'El archivo dura más de {h} horas, por lo que no se puede leer.',
    zh: '文件长度超过{h}小时，无法读取。',
  },
  unsupported: {
    ko: '이 형식의 영상·오디오는 읽을 수 없어요. 여기서 열 수 없는 형식의 트랙이 들어 있을 수도 있어요.',
    en: 'Video or audio in this format cannot be read. The file may also hold a track in a format that cannot be opened here.',
    id: 'Video atau audio dengan format ini tidak dapat dibaca. Berkas mungkin juga berisi trek dengan format yang tidak bisa dibuka di sini.',
    ja: 'この形式の動画・音声は読み取れません。ここでは開けない形式のトラックが含まれている可能性もあります。',
    es: 'No se puede leer video o audio en este formato. El archivo también puede contener una pista en un formato que aquí no se puede abrir.',
    zh: '无法读取这种格式的视频或音频。文件中也可能有这里打不开的格式的音轨或视频轨。',
  },
  damaged: {
    ko: '파일이 손상됐거나 읽을 수 없어요.',
    en: 'The file is damaged or unreadable.',
    id: 'Berkas rusak atau tidak dapat dibaca.',
    ja: 'ファイルが破損しているか、読み取れません。',
    es: 'El archivo está dañado o no se puede leer.',
    zh: '文件已损坏或无法读取。',
  },
  heavy: {
    ko: '파일을 읽는 데 시간이나 메모리가 너무 많이 들어 멈췄어요.',
    en: 'Reading the file took too long or needed too much memory, so it stopped.',
    id: 'Membaca berkas memakan waktu atau memori terlalu banyak, jadi dihentikan.',
    ja: 'ファイルの読み取りに時間またはメモリがかかりすぎたため、停止しました。',
    es: 'Leer el archivo tardó demasiado o necesitó demasiada memoria, por lo que se detuvo.',
    zh: '读取文件用时太长或占用内存太多，已停止。',
  },
  busy: {
    ko: '지금 다른 영상을 읽고 있어요. 잠시 뒤 다시 읽어 주세요.',
    en: 'Other videos are being read right now. Read it again in a moment.',
    id: 'Video lain sedang dibaca saat ini. Baca lagi sebentar lagi.',
    ja: '現在ほかの動画を読み取っています。しばらくしてからもう一度読み取ってください。',
    es: 'Ahora se están leyendo otros videos. Vuelva a leerlo en un momento.',
    zh: '现在正在读取其他视频。请稍后再读取一次。',
  },
  noRoom: {
    ko: '여기에 남은 저장 공간이 부족해 이 파일을 읽을 수 없어요.',
    en: 'There is not enough free storage space to read this file.',
    id: 'Ruang penyimpanan kosong tidak cukup untuk membaca berkas ini.',
    ja: '空きストレージ容量が足りないため、このファイルを読み取れません。',
    es: 'No hay suficiente espacio de almacenamiento libre para leer este archivo.',
    zh: '可用存储空间不足，无法读取这个文件。',
  },
  noAudio: {
    ko: '이 영상에는 소리 트랙이 없어요.',
    en: 'This video has no sound track.',
    id: 'Video ini tidak memiliki trek suara.',
    ja: 'この動画には音声トラックがありません。',
    es: 'Este video no tiene pista de sonido.',
    zh: '这个视频没有声音。',
  },
  noPicture: {
    ko: '이 파일에는 화면이 없고 소리만 있어요.',
    en: 'This file has no picture, only sound.',
    id: 'Berkas ini tidak memiliki gambar, hanya suara.',
    ja: 'このファイルには映像がなく、音声だけです。',
    es: 'Este archivo no tiene imagen, solo sonido.',
    zh: '这个文件只有声音，没有画面。',
  },
  pictureTooLarge: {
    ko: '화면 크기가 너무 커서 장면을 만들지 않았어요.',
    en: 'The picture is too large, so no frames were made.',
    id: 'Gambarnya terlalu besar, jadi tidak ada cuplikan yang dibuat.',
    ja: '映像のサイズが大きすぎるため、場面を作りませんでした。',
    es: 'La imagen es demasiado grande, por lo que no se crearon fotogramas.',
    zh: '画面太大，没有生成截图。',
  },
  voiceOff: {
    ko: '이 팀은 음성 입력이 꺼져 있어 소리를 글로 바꾸지 않았어요. 관리자가 팀 설정 › 음성 입력에서 켤 수 있어요.',
    en: 'Voice input is off for this team, so the sound was not turned into text. An admin can turn it on in Team settings › Voice input.',
    id: 'Input suara nonaktif untuk tim ini, jadi suara tidak diubah menjadi teks. Admin dapat mengaktifkannya di Pengaturan tim › Input suara.',
    ja: 'このチームは音声入力がオフのため、音声をテキストにしませんでした。管理者が「チーム設定 › 音声入力」でオンにできます。',
    es: 'La entrada de voz está desactivada en este equipo, por lo que el sonido no se convirtió en texto. Un administrador puede activarla en Configuración del equipo › Entrada de voz.',
    zh: '这个团队关闭了语音输入，所以声音没有转成文字。管理员可以在“团队设置 › 语音输入”中开启。',
  },
  transcriptsOff: {
    ko: '이 팀은 영상 소리를 글로 바꾸지 않도록 설정돼 있어 소리를 받아쓰지 않았어요. 관리자가 팀 설정 › 음성 입력에서 "영상 소리를 글로 바꾸기"를 켤 수 있어요.',
    en: 'This team does not turn video sound into text, so the sound was not transcribed. An admin can turn on "Turn video sound into text" in Team settings › Voice input.',
    id: 'Tim ini tidak mengubah suara video menjadi teks, jadi suara tidak ditranskripsi. Admin dapat mengaktifkan "Ubah suara video menjadi teks" di Pengaturan tim › Input suara.',
    ja: 'このチームは動画の音声をテキストにしない設定のため、文字起こししませんでした。管理者が「チーム設定 › 音声入力」で「動画の音声をテキストにする」をオンにできます。',
    es: 'Este equipo no convierte el sonido de los videos en texto, por lo que no se transcribió. Un administrador puede activar "Convertir el sonido de los videos en texto" en Configuración del equipo › Entrada de voz.',
    zh: '这个团队不把视频声音转成文字，所以声音没有转写。管理员可以在“团队设置 › 语音输入”中开启“把视频声音转成文字”。',
  },
  transcriptsOffSmall: {
    ko: '여기서는 소리를 글로 바꾸는 데 오래 걸려서 꺼 두었어요. 관리자가 팀 설정 › 음성 입력에서 "영상 소리를 글로 바꾸기"를 켤 수 있어요.',
    en: 'Turning sound into text takes long here, so it is off. An admin can turn on "Turn video sound into text" in Team settings › Voice input.',
    id: 'Mengubah suara menjadi teks memakan waktu lama di sini, jadi dimatikan. Admin dapat mengaktifkan "Ubah suara video menjadi teks" di Pengaturan tim › Input suara.',
    ja: 'ここでは音声をテキストにするのに時間がかかるため、オフにしています。管理者が「チーム設定 › 音声入力」で「動画の音声をテキストにする」をオンにできます。',
    es: 'Convertir el sonido en texto tarda mucho aquí, por eso está desactivado. Un administrador puede activar "Convertir el sonido de los videos en texto" en Configuración del equipo › Entrada de voz.',
    zh: '在这里把声音转成文字很慢，所以已关闭。管理员可以在“团队设置 › 语音输入”中开启“把视频声音转成文字”。',
  },
  noKey: {
    ko: '받아쓰기에 쓸 OpenRouter 키가 없어 소리를 받아쓰지 않았어요. 관리자가 팀 설정 › 음성 입력에서 키를 넣을 수 있어요.',
    en: 'There is no OpenRouter key for transcripts, so the sound was not transcribed. An admin can add it in Team settings › Voice input.',
    id: 'Belum ada kunci OpenRouter untuk transkrip, jadi suara tidak ditranskripsi. Admin dapat menambahkannya di Pengaturan tim › Input suara.',
    ja: '文字起こしに使う OpenRouter キーがないため、文字起こししませんでした。管理者が「チーム設定 › 音声入力」で追加できます。',
    es: 'No hay clave de OpenRouter para las transcripciones, por lo que el sonido no se transcribió. Un administrador puede añadirla en Configuración del equipo › Entrada de voz.',
    zh: '没有用于转写的 OpenRouter 密钥，所以声音没有转写。管理员可以在“团队设置 › 语音输入”中添加。',
  },
  /** {hours}: the plan's free hours a month (credentials/hosted-speech.ts hostedSpeechFreeHours) */
  freeUsed: {
    ko: '이번 달 무료 받아쓰기 {hours}시간을 다 써서 소리를 받아쓰지 않았어요. 다음 달 1일에 다시 생겨요. 관리자가 팀 설정 › 음성 입력에 팀의 OpenRouter 키를 넣으면 바로 이어서 쓸 수 있어요.',
    en: 'This month\'s {hours} free hours of transcription are used up, so the sound was not transcribed. They come back on the 1st. An admin can add the team\'s own OpenRouter key in Team settings › Voice input to go on now.',
    id: '{hours} jam transkripsi gratis bulan ini sudah habis, jadi suara tidak ditranskripsi. Jatahnya kembali tanggal 1. Admin dapat menambahkan kunci OpenRouter tim di Pengaturan tim › Input suara untuk lanjut sekarang.',
    ja: '今月の無料文字起こし{hours}時間を使い切ったため、文字起こししませんでした。来月1日にまた使えます。管理者が「チーム設定 › 音声入力」でチームの OpenRouter キーを追加すれば、すぐに続けられます。',
    es: 'Se agotaron las {hours} horas gratuitas de transcripción de este mes, por lo que el sonido no se transcribió. Vuelven el día 1. Un administrador puede añadir la clave de OpenRouter del equipo en Configuración del equipo › Entrada de voz para seguir ahora.',
    zh: '本月{hours}小时的免费转写时长已用完，所以声音没有转写。每月1日会恢复。管理员可以在“团队设置 › 语音输入”中添加团队自己的 OpenRouter 密钥，马上继续使用。',
  },
  confidential: {
    ko: '기밀 대화에서는 소리를 바깥 서비스로 보내지 않아 받아쓰지 않았어요.',
    en: 'In a confidential chat the sound is not sent to an outside service, so it was not transcribed.',
    id: 'Dalam percakapan rahasia, suara tidak dikirim ke layanan luar, jadi tidak ditranskripsi.',
    ja: '機密チャットでは音声を外部サービスに送らないため、文字起こししませんでした。',
    es: 'En un chat confidencial el sonido no se envía a un servicio externo, por lo que no se transcribió.',
    zh: '在保密对话中，声音不会发送到外部服务，所以没有转写。',
  },
  noWhisper: {
    ko: '여기에는 받아쓰기 도구가 없어 소리를 받아쓰지 않았어요. 관리자가 팀 설정 › 음성 입력에서 무엇이 빠졌는지 볼 수 있어요.',
    en: 'The transcription tool is missing here, so the sound was not transcribed. An admin can see what is missing in Team settings › Voice input.',
    id: 'Alat transkripsi tidak ada di sini, jadi suara tidak ditranskripsi. Admin dapat melihat apa yang kurang di Pengaturan tim › Input suara.',
    ja: 'ここには文字起こしツールがないため、文字起こししませんでした。管理者は「チーム設定 › 音声入力」で足りないものを確認できます。',
    es: 'Aquí falta la herramienta de transcripción, por lo que el sonido no se transcribió. Un administrador puede ver qué falta en Configuración del equipo › Entrada de voz.',
    zh: '这里没有转写工具，所以声音没有转写。管理员可以在“团队设置 › 语音输入”中查看缺少什么。',
  },
  noModel: {
    ko: '음성 인식 모델을 아직 내려받지 않아 소리를 받아쓰지 않았어요. 채팅에서 음성 입력을 처음 쓰면 모델을 내려받아요.',
    en: 'The speech model is not downloaded yet, so the sound was not transcribed. It is downloaded the first time someone uses voice input in chat.',
    id: 'Model suara belum diunduh, jadi suara tidak ditranskripsi. Model diunduh saat input suara pertama kali dipakai di percakapan.',
    ja: '音声認識モデルをまだダウンロードしていないため、文字起こししませんでした。チャットで初めて音声入力を使うとダウンロードされます。',
    es: 'El modelo de voz todavía no se ha descargado, por lo que el sonido no se transcribió. Se descarga la primera vez que alguien usa la entrada de voz en el chat.',
    zh: '语音模型还没有下载，所以声音没有转写。第一次有人在对话中使用语音输入时会下载它。',
  },
  slow: {
    ko: '여기서는 한 번 읽을 때 새 소리를 {min}분까지만 글로 바꿔요.',
    en: 'Here one read turns at most {min} minutes of new sound into text.',
    id: 'Di sini satu kali baca mengubah paling banyak {min} menit suara baru menjadi teks.',
    ja: 'ここでは 1 回の読み取りでテキストにできる新しい音声は {min} 分までです。',
    es: 'Aquí una lectura convierte en texto como máximo {min} minutos de sonido nuevo.',
    zh: '在这里，每次读取最多把{min}分钟的新声音转成文字。',
  },
  connection: {
    ko: '이 연결로는 한 번에 1분 안에 끝나는 만큼만 받아써요.',
    en: 'Over this connection a read transcribes only what fits in about a minute.',
    id: 'Melalui koneksi ini satu kali baca hanya mentranskripsi yang selesai dalam sekitar satu menit.',
    ja: 'この接続では、1 回の読み取りで約 1 分以内に終わる分だけ文字起こしします。',
    es: 'Por esta conexión una lectura solo transcribe lo que cabe en aproximadamente un minuto.',
    zh: '通过这个连接，每次读取只转写大约一分钟内能完成的部分。',
  },
  timeUp: {
    ko: '이번에 읽는 시간 안에 소리를 {from}–{to}까지 글로 바꿨어요. 다시 읽으면 그다음부터 이어서 바꿔요(바꾼 부분은 남아 있어요).',
    en: 'This read had time to turn the sound from {from} to {to} into text. Reading again goes on from there (what was done is kept).',
    id: 'Bacaan ini sempat mengubah suara dari {from} sampai {to} menjadi teks. Membaca lagi akan melanjutkan dari sana (yang sudah selesai disimpan).',
    ja: '今回の読み取り時間内に、{from}–{to} の音声をテキストにしました。もう一度読み取ると、その続きから処理します（済んだ部分は残っています）。',
    es: 'Esta lectura tuvo tiempo de convertir en texto el sonido de {from} a {to}. Al leer de nuevo se sigue desde ahí (lo ya hecho se guarda).',
    zh: '这次读取把{from}到{to}的声音转成了文字。再次读取会从那里继续（已完成的部分会保留）。',
  },
  timeNone: {
    ko: '이번에 읽는 시간 안에는 소리를 글로 바꾸지 못했어요. 장면 없이(frames: 0) 다시 읽으면 소리에 시간을 더 쓸 수 있어요.',
    en: 'This read had no time left to turn the sound into text. Reading again without frames (frames: 0) leaves more time for the sound.',
    id: 'Bacaan ini tidak sempat mengubah suara menjadi teks. Membaca lagi tanpa cuplikan (frames: 0) memberi lebih banyak waktu untuk suara.',
    ja: '今回の読み取り時間内には音声をテキストにできませんでした。場面なし（frames: 0）でもう一度読み取ると、音声により多くの時間を使えます。',
    es: 'Esta lectura no tuvo tiempo de convertir el sonido en texto. Leer de nuevo sin fotogramas (frames: 0) deja más tiempo para el sonido.',
    zh: '这次读取没有剩余时间把声音转成文字。不生成截图再次读取（frames: 0），可以给声音留出更多时间。',
  },
  voiceBusy: {
    ko: '지금 음성 입력이 받아쓰기를 쓰고 있어서 소리를 더 글로 바꾸지 못했어요. 잠시 뒤 다시 읽으면 이어서 바꿔요.',
    en: 'Voice input is using the transcription right now, so no more of the sound was turned into text. Reading again in a moment goes on from there.',
    id: 'Input suara sedang memakai transkripsi, jadi suara tidak diubah lagi menjadi teks. Membaca lagi sebentar lagi akan melanjutkan dari sana.',
    ja: '音声入力が文字起こしを使っているため、これ以上は音声をテキストにできませんでした。しばらくしてからもう一度読み取ると続きから処理します。',
    es: 'La entrada de voz está usando ahora la transcripción, así que no se convirtió más sonido en texto. Al leer de nuevo en un momento se sigue desde ahí.',
    zh: '语音输入正在使用转写功能，所以没有继续把声音转成文字。稍后再次读取会从那里继续。',
  },
  failed: {
    ko: '받아쓰기에 실패했어요({why}).',
    en: 'The transcript failed ({why}).',
    id: 'Transkripsi gagal ({why}).',
    ja: '文字起こしに失敗しました（{why}）。',
    es: 'La transcripción falló ({why}).',
    zh: '转写失败（{why}）。',
  },
  framesSlow: {
    ko: '장면을 만드는 데 시간이 너무 오래 걸려 일부만 보여 줘요.',
    en: 'Making the frames took too long, so only some are shown.',
    id: 'Membuat cuplikan memakan waktu terlalu lama, jadi hanya sebagian yang ditampilkan.',
    ja: '場面の作成に時間がかかりすぎたため、一部だけ表示します。',
    es: 'Crear los fotogramas tardó demasiado, por lo que solo se muestran algunos.',
    zh: '生成截图用时太长，所以只显示了一部分。',
  },
} as const

export type MediaTextKey = keyof typeof MEDIA_TEXT

export function mediaText(db: Database, userId: string, key: MediaTextKey, vars: Record<string, string | number> = {}): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' || u?.locale === 'zh' ? u.locale : 'en'
  const all: Record<string, string | number> = { product: PRODUCT.displayName, ...vars }
  return MEDIA_TEXT[key][locale].replace(/\{(\w+)\}/g, (m, k: string) => (k in all ? String(all[k]) : m))
}

/** a JobFailure's message (OpenRouter refused the key, no credits …) in the person's language, for `failed` */
export function personLocale(db: Database, userId: string): 'ko' | 'en' | 'id' | 'ja' | 'es' | 'zh' {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  return u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' || u?.locale === 'zh' ? u.locale : 'en'
}
