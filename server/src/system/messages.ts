// Diagnostics wording in the three UI languages (English when one is missing). Component G. "What to do about it" lines are written
// for a non-technical owner: what is wrong, then what to try.
import type { Locale } from '@mycel/shared/api'

type T = { ko: string; en: string; id: string }
export const tr = (l: Locale, t: T) => t[l] ?? t.en

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`
/** English singular / plural ("1 rule", "3 rules"); Korean and Indonesian have one form. */
export const enPlural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`

/** How long the server has been up, in the reader's words ("2일 3시간", "5 menit"). */
export function uptimeText(sec: number, l: Locale): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  const u = { ko: { d: '일', h: '시간', m: '분' }, en: { d: ' d', h: ' h', m: ' min' }, id: { d: ' hari', h: ' jam', m: ' menit' } }[l] ?? { d: ' d', h: ' h', m: ' min' }
  return d ? `${d}${u.d} ${h}${u.h}` : h ? `${h}${u.h} ${m}${u.m}` : `${m}${u.m}`
}

/**
 * Progress lines of system jobs (backup, update, restore, export), which the owner reads under the button. The
 * workers report a short step id; this turns it into words ("archive 3/7" keeps its numbers).
 */
const STEPS: Record<string, T> = {
  database: { ko: '데이터베이스 복사 중', en: 'Copying the database', id: 'Menyalin basis data' },
  'team folder': { ko: '팀 폴더 보관 중', en: 'Archiving the team folder', id: 'Mengarsipkan folder tim' },
  'cleaning up': { ko: '오래된 백업 정리 중', en: 'Removing old backups', id: 'Menghapus cadangan lama' },
  done: { ko: '마무리 중', en: 'Finishing', id: 'Menyelesaikan' },
  backup: { ko: '데이터베이스 백업 중', en: 'Backing up the database', id: 'Mencadangkan basis data' },
  download: { ko: '새 버전 내려받는 중', en: 'Downloading the new version', id: 'Mengunduh versi baru' },
  switch: { ko: '새 버전으로 바꾸는 중', en: 'Switching to the new version', id: 'Beralih ke versi baru' },
  check: { ko: '백업 확인 중', en: 'Checking the backup', id: 'Memeriksa cadangan' },
  chats: { ko: '채팅 모으는 중', en: 'Collecting chats', id: 'Mengumpulkan chat' },
  memories: { ko: '메모리 모으는 중', en: 'Collecting memories', id: 'Mengumpulkan memori' },
  files: { ko: '파일 묶는 중', en: 'Packing files', id: 'Mengemas berkas' },
}
export function stepText(l: Locale, step: string | null | undefined): string | null {
  if (!step) return null
  const known = STEPS[step]
  if (known) return tr(l, known)
  const archive = /^archive (\d+)\/(\d+)$/.exec(step)
  if (archive) return tr(l, { ko: `팀 폴더 복원 중 (${archive[1]}/${archive[2]})`, en: `Restoring the team folder (${archive[1]}/${archive[2]})`, id: `Memulihkan folder tim (${archive[1]}/${archive[2]})` })
  return step
}

export const M = {
  server: { ko: '서버', en: 'Server', id: 'Server' },
  serverDetail: (v: string, up: string): T => ({ ko: `버전 ${v}, ${up} 동안 실행 중`, en: `Version ${v}, running for ${up}`, id: `Versi ${v}, berjalan selama ${up}` }),

  relay: { ko: '원격 접속(중계 서버)', en: 'Remote access (relay)', id: 'Akses jarak jauh (relay)' },
  relayOff: { ko: '중계 서버 연결이 설정되지 않았습니다. 사무실 안에서만 접속할 수 있습니다. 관리자 > 시스템 > 연결에서 켤 수 있습니다.', en: 'No relay connection is set up, so the team can only connect from the office network. Turn it on in Admin > System > Connection.', id: 'Koneksi relay belum diatur, jadi tim hanya bisa terhubung dari jaringan kantor. Aktifkan di Admin > Sistem > Koneksi.' },
  relayConnecting: { ko: '중계 서버에 연결하는 중입니다. 몇 분이 지나도 그대로면 인터넷 연결을 확인해 주세요.', en: 'Connecting to the relay. If this stays for a few minutes, check the internet connection.', id: 'Sedang terhubung ke relay. Jika tetap begini beberapa menit, periksa koneksi internet.' },
  relayOffline: { ko: '중계 서버에 연결되지 않습니다. 맥의 인터넷 연결을 확인해 주세요. 사무실 안 직접 연결은 계속 됩니다.', en: 'Cannot reach the relay. Check the Mac\'s internet connection. Direct connections in the office still work.', id: 'Tidak dapat menjangkau relay. Periksa koneksi internet Mac. Koneksi langsung di kantor tetap berfungsi.' },
  relayReplaced: { ko: '다른 맥의 서버가 같은 팀 주소로 연결해 이 서버의 연결을 대신했습니다. 의도한 일이 아니면 팀 키를 바꿔 주세요.', en: 'A server on another Mac connected with this team\'s address and replaced this one. If you did not do this, rotate the team key.', id: 'Server di Mac lain terhubung dengan alamat tim ini dan menggantikan server ini. Jika bukan Anda, ganti kunci tim.' },

  diskTeam: { ko: '디스크 여유 공간(팀 폴더)', en: 'Free disk space (team folder)', id: 'Ruang disk kosong (folder tim)' },
  diskData: { ko: '디스크 여유 공간(서버 데이터)', en: 'Free disk space (server data)', id: 'Ruang disk kosong (data server)' },
  diskLow: (free: number, pct: number): T => ({ ko: `남은 공간 ${gb(free)} (${pct}%). 15% 아래입니다. 휴지통 비우기·오래된 버전 정리로 공간을 늘려 주세요.`, en: `${gb(free)} free (${pct}%), below 15%. Empty the trash or clean up old versions.`, id: `${gb(free)} kosong (${pct}%), di bawah 15%. Kosongkan tempat sampah atau hapus versi lama.` }),
  diskReadOnly: (free: number): T => ({ ko: `남은 공간 ${gb(free)}. 공간이 거의 없어 답변·업로드·파일 저장이 실패할 수 있습니다. 휴지통 비우기·오래된 버전 정리로 바로 공간을 비워 주세요.`, en: `${gb(free)} free. Space is almost gone, so answers, uploads and file saves can fail. Free up space now (empty the trash, clean up old versions).`, id: `${gb(free)} kosong. Ruang hampir habis sehingga jawaban, unggahan, dan penyimpanan berkas bisa gagal. Segera kosongkan ruang.` }),
  diskOk: (free: number, pct: number): T => ({ ko: `${gb(free)} 남음 (${pct}%)`, en: `${gb(free)} free (${pct}%)`, id: `${gb(free)} kosong (${pct}%)` }),

  engineClaude: { ko: 'AI 엔진: Claude Code', en: 'AI engine: Claude Code', id: 'Mesin AI: Claude Code' },
  engineCodex: { ko: 'AI 엔진: Codex', en: 'AI engine: Codex', id: 'Mesin AI: Codex' },
  engineOk: (m: string | null): T => ({ ko: `로그인됨${m ? ` (${m})` : ''}`, en: `Signed in${m ? ` (${m})` : ''}`, id: `Sudah masuk${m ? ` (${m})` : ''}` }),
  engineNotInstalled: { ko: '설치되어 있지 않습니다.', en: 'Not installed.', id: 'Tidak terpasang.' },
  engineNotLoggedIn: { ko: '로그인되어 있지 않습니다. 서버 맥에서 owner가 이 엔진에 다시 로그인해 주세요(Claude Code: `claude`, Codex: `codex login`).', en: 'Not signed in. The owner has to sign this engine in again on the server Mac (Claude Code: `claude`, Codex: `codex login`).', id: 'Belum masuk. Owner perlu memasukkan lagi mesin ini di Mac server (Claude Code: `claude`, Codex: `codex login`).' },
  engineSetupToken: { ko: 'Claude 구독 장기 토큰이 없습니다. owner가 서버 맥에서 `claude setup-token`으로 토큰을 만들고 `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"`으로 저장해야 AI가 답합니다(docs/INSTALL.md 2.4).', en: 'No long-lived Claude subscription token. The owner has to make one with `claude setup-token` on the server Mac and store it with `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"` before the AI can answer (docs/INSTALL.md 2.4).', id: 'Tidak ada token langganan Claude jangka panjang. Owner perlu membuatnya dengan `claude setup-token` di Mac server lalu menyimpannya dengan `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"` agar AI bisa menjawab (docs/INSTALL.md 2.4).' },
  engineSetupTokenExpired: { ko: 'Claude 구독 장기 토큰이 만료되었습니다(1년). owner가 `claude setup-token`으로 새 토큰을 만들어 같은 방법으로 다시 저장해 주세요(docs/INSTALL.md 2.4).', en: 'The long-lived Claude subscription token has expired (one year). The owner has to make a new one with `claude setup-token` and store it the same way (docs/INSTALL.md 2.4).', id: 'Token langganan Claude jangka panjang sudah kedaluwarsa (satu tahun). Owner perlu membuat token baru dengan `claude setup-token` dan menyimpannya dengan cara yang sama (docs/INSTALL.md 2.4).' },
  engineSetupTokenInvalid: { ko: 'Claude 구독 장기 토큰이 거절되었습니다(취소되었거나 잘못 붙여 넣음). owner가 `claude setup-token`으로 새 토큰을 만들어 다시 저장해 주세요(docs/INSTALL.md 2.4).', en: 'The long-lived Claude subscription token was refused (revoked or pasted wrong). The owner has to make a new one with `claude setup-token` and store it again (docs/INSTALL.md 2.4).', id: 'Token langganan Claude jangka panjang ditolak (dicabut atau salah tempel). Owner perlu membuat token baru dengan `claude setup-token` dan menyimpannya lagi (docs/INSTALL.md 2.4).' },
  engineSetupTokenExpiring: (at: string): T => ({ ko: `로그인됨 (setup-token). ${at}에 만료되니 그 전에 새 토큰으로 바꿔 주세요.`, en: `Signed in (setup-token). It expires on ${at}; replace it before then.`, id: `Sudah masuk (setup-token). Kedaluwarsa pada ${at}; ganti sebelum itu.` }),
  subscriptionRejected: { ko: 'Claude 구독 토큰이 거절되었습니다(만료 또는 취소). owner가 서버 맥에서 `claude setup-token`으로 새 토큰을 만들어 다시 연결해야 합니다(docs/INSTALL.md 2.4).', en: 'The Claude subscription token was refused (expired or revoked). The owner has to make a new one with `claude setup-token` on the server Mac and connect it again (docs/INSTALL.md 2.4).', id: 'Token langganan Claude ditolak (kedaluwarsa atau dicabut). Owner perlu membuat token baru dengan `claude setup-token` di Mac server lalu menghubungkannya lagi (docs/INSTALL.md 2.4).' },
  modelProxy: { ko: '모델 프록시', en: 'Model proxy', id: 'Proxy model' },
  modelProxyOk: (port: number): T => ({ ko: `127.0.0.1:${port}에서 동작 중`, en: `Listening on 127.0.0.1:${port}`, id: `Berjalan di 127.0.0.1:${port}` }),
  modelProxyPortInUse: (port: number): T => ({ ko: `모델 프록시 포트 사용 중(127.0.0.1:${port}). 다른 프로그램이 이 포트를 쓰는 동안 Claude가 답하지 않습니다. 10초마다 다시 시도합니다.`, en: `Model proxy port in use (127.0.0.1:${port}). Claude cannot answer while another program holds it; retrying every 10 seconds.`, id: `Port proxy model sedang dipakai (127.0.0.1:${port}). Claude tidak bisa menjawab selama program lain memakainya; dicoba lagi tiap 10 detik.` }),
  modelProxyNotStarted: { ko: '첫 질문 때 시작합니다.', en: 'Starts with the first question.', id: 'Dimulai pada pertanyaan pertama.' },
  engineCodexLogin: { ko: 'Codex는 엔진 계정 전용 로그인이 필요합니다. owner가 서버 맥에서 관리 명령 `admin.js codex-login`을 한 번 실행해, 나오는 주소와 코드로 로그인합니다(docs/INSTALL.md 2.5).', en: 'Codex needs its own engine-account login. The owner runs the admin command `admin.js codex-login` once on the server Mac and signs in with the address and code it prints (docs/INSTALL.md 2.5).', id: 'Codex memerlukan login akun mesin sendiri. Owner menjalankan perintah admin `admin.js codex-login` sekali di Mac server lalu masuk dengan alamat dan kode yang ditampilkan (docs/INSTALL.md 2.5).' },
  engineCheckFailed: { ko: '로그인 상태를 확인하지 못했습니다. 잠시 뒤 다시 확인해 주세요.', en: 'Could not check the sign-in state. Try again in a moment.', id: 'Tidak dapat memeriksa status masuk. Coba lagi sebentar lagi.' },

  queue: { ko: '대기열', en: 'Queue', id: 'Antrean' },
  queueDetail: (r: number, q: number, c: number): T => ({ ko: `실행 중 ${r}개, 대기 ${q}개 (동시 실행 ${c}개까지)`, en: `${r} running, ${q} waiting (up to ${c} at once)`, id: `${r} berjalan, ${q} menunggu (maks ${c} sekaligus)` }),
  queueLong: (q: number): T => ({ ko: `대기 중인 질문이 ${q}개입니다. 오래 걸리면 관리자 > AI 엔진에서 동시 실행 수를 늘려 보세요.`, en: `${enPlural(q, 'question is', 'questions are')} waiting. If this lasts, raise "Answers at the same time" in Admin > AI engines.`, id: `${q} pertanyaan menunggu. Jika berlanjut, naikkan "Jawaban bersamaan" di Admin > Mesin AI.` }),

  firewall: { ko: 'AI 엔진 방화벽(pf)', en: 'AI engine firewall (pf)', id: 'Firewall mesin AI (pf)' },
  firewallOk: (n: number): T => ({ ko: `켜짐, 규칙 ${n}개`, en: `On, ${enPlural(n, 'rule', 'rules')}`, id: `Aktif, ${n} aturan` }),
  firewallDev: { ko: '개발 모드: AI 엔진이 현재 사용자로 실행되어 엔진 계정 방화벽을 쓰지 않습니다.', en: 'Development mode: the AI engine runs as the current user, so the engine-account firewall is not used.', id: 'Mode pengembangan: mesin AI berjalan sebagai pengguna saat ini, firewall akun mesin tidak dipakai.' },
  firewallMissing: { ko: '방화벽 규칙 파일이 없습니다. 메뉴바 앱의 \'방화벽 복구\'(관리자 비밀번호)를 실행해 주세요.', en: 'The firewall rule file is missing. Run "Repair firewall" in the menubar app (admin password).', id: 'Berkas aturan firewall hilang. Jalankan "Perbaiki firewall" di aplikasi menubar (kata sandi admin).' },
  firewallStale: { ko: '방화벽 상태가 15분 넘게 갱신되지 않았습니다. 메뉴바 앱의 \'방화벽 복구\'를 실행해 주세요.', en: 'The firewall status has not been refreshed for over 15 minutes. Run "Repair firewall" in the menubar app.', id: 'Status firewall tidak diperbarui lebih dari 15 menit. Jalankan "Perbaiki firewall" di aplikasi menubar.' },
  firewallOff: (why: string): T => ({ ko: `방화벽이 꺼져 있습니다(${why}). 다른 보안·VPN 앱이 pf를 바꿨을 수 있습니다. 메뉴바 앱의 '방화벽 복구'를 실행해 주세요.`, en: `The firewall is off (${why}). Another security or VPN app may have changed pf. Run "Repair firewall" in the menubar app.`, id: `Firewall mati (${why}). Aplikasi keamanan/VPN lain mungkin mengubah pf. Jalankan "Perbaiki firewall".` }),

  sandbox: { ko: 'AI 엔진 샌드박스', en: 'AI engine sandbox', id: 'Sandbox mesin AI' },
  sandboxOk: { ko: '모든 엔진 실행에 적용됨', en: 'Applied to every engine run', id: 'Diterapkan ke setiap eksekusi mesin' },
  sandboxDev: { ko: '개발 모드: 엔진 실행기를 서버가 직접 띄우며 샌드박스 프로필을 쓰지 않습니다.', en: 'Development mode: the server starts the engine launcher itself without the sandbox profile.', id: 'Mode pengembangan: server menjalankan peluncur mesin tanpa profil sandbox.' },
  sandboxMissing: { ko: '샌드박스 프로필이 없거나 실행기 설정에 빠져 있습니다. 메뉴바 앱에서 \'관리자 비밀번호가 필요한 업데이트\'(설치 다시 하기)를 실행해 주세요.', en: 'The sandbox profile is missing or not used by the launcher. Run the admin-password update (reinstall) from the menubar app.', id: 'Profil sandbox hilang atau tidak dipakai peluncur. Jalankan pembaruan dengan kata sandi admin dari aplikasi menubar.' },

  cronDeny: { ko: '엔진 계정 예약 작업 차단(cron·at)', en: 'Engine account scheduling block (cron, at)', id: 'Blokir penjadwalan akun mesin (cron, at)' },
  cronDenyOk: { ko: '엔진 계정은 예약 작업을 등록할 수 없습니다.', en: 'The engine account cannot schedule jobs.', id: 'Akun mesin tidak dapat menjadwalkan tugas.' },
  cronDenyMissing: { ko: '엔진 계정이 /var/at/cron.deny·at.deny에 없습니다. 샌드박스가 crontab·at 실행을 막고 있지만, 메뉴바 앱의 \'설치 다시 하기\'(관리자 비밀번호)로 보완해 주세요.', en: 'The engine account is not in /var/at/cron.deny / at.deny. The sandbox still blocks crontab and at; run "Reinstall" (admin password) from the menubar app.', id: 'Akun mesin tidak ada di /var/at/cron.deny / at.deny. Sandbox tetap memblokir crontab dan at; jalankan "Pasang ulang" dari aplikasi menubar.' },
  launcher: { ko: 'AI 엔진 실행기', en: 'AI engine launcher', id: 'Peluncur mesin AI' },
  launcherOk: { ko: '연결됨', en: 'Connected', id: 'Terhubung' },
  launcherDown: { ko: '실행기에 연결할 수 없습니다. 맥을 다시 시작하거나 메뉴바 앱의 \'설치 다시 하기\'를 실행해 주세요.', en: 'Cannot reach the engine launcher. Restart the Mac or run "Reinstall" from the menubar app.', id: 'Tidak dapat menjangkau peluncur mesin. Mulai ulang Mac atau jalankan "Pasang ulang" dari aplikasi menubar.' },
  /** the launcher daemon is not running (no socket, or a socket left over from a launcher that ended) */
  launcherNotRunning: (label: string | null, logs: string | null, launchDaemonsDir = '/Library/LaunchDaemons'): T => {
    const l = `${label ?? '<label>'}.launcher`
    const cmd = `sudo launchctl kickstart -k system/${l}`
    // kickstart only reaches a loaded job; one that was booted out (or never loaded) needs bootstrap
    const load = `sudo launchctl bootstrap system ${launchDaemonsDir}/${l}.plist`
    const log = logs ? `${logs}/crash/launcher.log` : ''
    const tail: T = log
      ? { ko: ` 다시 멈추면 ${log}를 확인해 주세요.`, en: ` If it stops again, look at ${log}.`, id: ` Jika berhenti lagi, lihat ${log}.` }
      : { ko: '', en: '', id: '' }
    return {
      ko: `AI 실행기가 실행 중이 아니어서 채팅이 시작되지 않습니다. 서버 맥의 터미널에서 \`${cmd}\`를 실행해 다시 띄워 주세요(관리자 비밀번호). 서비스를 찾을 수 없다고 나오면 \`${load}\`를 실행해 주세요.${tail.ko}`,
      en: `The AI launcher is not running, so chats cannot start. Start it again in Terminal on the server Mac: \`${cmd}\` (asks for an admin password). If that says the service could not be found, run \`${load}\`.${tail.en}`,
      id: `Peluncur AI tidak berjalan, jadi chat tidak bisa dimulai. Jalankan lagi di Terminal Mac server: \`${cmd}\` (meminta kata sandi admin). Jika muncul layanan tidak ditemukan, jalankan \`${load}\`.${tail.id}`,
    }
  },
  launcherDenied: { ko: '서버 계정이 AI 실행기 소켓을 열 수 없습니다(권한). 설치 스크립트를 다시 실행해 폴더 권한을 고쳐 주세요.', en: 'The server account may not open the AI launcher socket (permissions). Run the installer again to repair the folder permissions.', id: 'Akun server tidak boleh membuka soket peluncur AI (izin). Jalankan pemasang lagi untuk memperbaiki izin folder.' },
  launcherTimeout: { ko: 'AI 실행기가 2초 안에 답하지 않았습니다. 잠시 뒤 새로 고침해 보고, 계속되면 실행기를 다시 띄워 주세요.', en: 'The AI launcher did not answer within 2 seconds. Refresh in a moment; if it stays like this, restart the launcher.', id: 'Peluncur AI tidak menjawab dalam 2 detik. Muat ulang sebentar lagi; jika tetap, mulai ulang peluncur.' },

  sockets: { ko: 'AI 엔진 소켓 경로', en: 'AI engine socket paths', id: 'Jalur soket mesin AI' },
  socketsOk: (max: number): T => ({ ko: `모든 소켓 경로가 ${max}바이트 안에 들어갑니다.`, en: `All socket paths fit in ${max} bytes.`, id: `Semua jalur soket muat dalam ${max} byte.` }),
  socketsTooLong: (list: string, max: number, dev: boolean): T => ({
    ko: `소켓 경로가 너무 깁니다: ${list}. 이 시스템의 소켓 경로는 ${max}바이트까지라서 AI 엔진이 시작되지 않습니다. ${dev ? '데이터 폴더를 짧은 경로(기본값 ~/.team-ax-dev)로 옮겨 주세요(TEAM_AX_DEV_DIR).' : 'config/server.json의 engine.runDir·engine.launcherSock을 짧은 경로로 바꿔 주세요.'}`,
    en: `Socket path too long: ${list}. Socket paths can be at most ${max} bytes on this system, so the AI engine cannot start. ${dev ? 'Move the data folder to a shorter path (the default ~/.team-ax-dev; TEAM_AX_DEV_DIR).' : 'Set engine.runDir / engine.launcherSock in config/server.json to a shorter path.'}`,
    id: `Jalur soket terlalu panjang: ${list}. Jalur soket paling panjang ${max} byte di sistem ini, jadi mesin AI tidak bisa mulai. ${dev ? 'Pindahkan folder data ke jalur yang lebih pendek (bawaan ~/.team-ax-dev; TEAM_AX_DEV_DIR).' : 'Ubah engine.runDir / engine.launcherSock di config/server.json ke jalur yang lebih pendek.'}`,
  }),
  socketsTmp: (dir: string): T => ({
    ko: `데이터 폴더(${dir})가 임시 폴더(/tmp 등) 안에 있습니다. 엔진 샌드박스가 이 폴더를 막아 채팅이 실패할 수 있습니다. 홈 폴더 아래 짧은 경로(기본값 ~/.team-ax-dev)로 옮겨 주세요.`,
    en: `The data folder (${dir}) is inside a temporary folder (/tmp or similar). The engine sandbox denies it, so chats can fail. Move it to a short path in your home folder (the default ~/.team-ax-dev).`,
    id: `Folder data (${dir}) ada di dalam folder sementara (/tmp atau sejenisnya). Sandbox mesin menolaknya, jadi chat bisa gagal. Pindahkan ke jalur pendek di folder rumah (bawaan ~/.team-ax-dev).`,
  }),

  lan: { ko: '사무실 직접 연결', en: 'Office direct connection', id: 'Koneksi langsung kantor' },
  lanOk: (port: number): T => ({ ko: `포트 ${port}에서 켜져 있습니다. 데스크톱 앱이 보고한 연결 실패가 없습니다(24시간).`, en: `On, port ${port}. No connection failures reported by the desktop apps (24 h).`, id: `Aktif, port ${port}. Tidak ada kegagalan koneksi yang dilaporkan aplikasi desktop (24 jam).` }),
  lanFailed: (n: number, mismatch: number, port: number): T => {
    const mm: T = mismatch
      ? { ko: ` 그중 ${mismatch}번은 인증서가 달랐습니다: 서버 인증서를 다시 만들었거나 같은 네트워크의 다른 기기가 서버인 척했을 수 있습니다.`, en: ` ${mismatch} of them saw a different certificate: the server certificate was re-created, or another device on the network pretended to be the server.`, id: ` ${mismatch} di antaranya melihat sertifikat lain: sertifikat server dibuat ulang, atau perangkat lain di jaringan menyamar sebagai server.` }
      : { ko: '', en: '', id: '' }
    return {
      ko: `데스크톱 앱이 사무실 안에서 직접 연결에 ${n}번 실패했습니다(24시간, 사람·1시간마다 한 번 셈).${mm.ko} 시스템 설정 > 네트워크 > 방화벽에서 '모든 들어오는 연결 차단'이 꺼져 있는지, 포트 ${port}이 막혀 있지 않은지 확인해 주세요. 그동안 앱은 원격 주소로 계속 연결됩니다.`,
      en: `Desktop apps in the office failed to connect directly ${enPlural(n, 'time', 'times')} (24 h, counted once per person per hour).${mm.en} Check System Settings > Network > Firewall ("Block all incoming connections" must be off) and that port ${port} is not blocked. Meanwhile the apps keep using the remote address.`,
      id: `Aplikasi desktop di kantor gagal terhubung langsung ${n} kali (24 jam, dihitung sekali per orang per jam).${mm.id} Periksa Pengaturan Sistem > Jaringan > Firewall ("Blokir semua koneksi masuk" harus mati) dan pastikan port ${port} tidak diblokir. Sementara itu aplikasi tetap memakai alamat jarak jauh.`,
    }
  },

  backups: { ko: '백업', en: 'Backups', id: 'Cadangan' },
  backupNone: { ko: '아직 백업이 없습니다. 매일 새벽 3시에 자동으로 만들어집니다. 지금 만들려면 \'지금 백업\'을 누르세요.', en: 'No backup yet. One is made every night at 03:00; use "Back up now" to make one now.', id: 'Belum ada cadangan. Dibuat otomatis setiap pukul 03:00; gunakan "Cadangkan sekarang".' },
  backupOld: (h: number): T => ({ ko: `마지막 백업이 ${h}시간 전입니다. 서버가 새벽에 꺼져 있었는지 확인하고 '지금 백업'을 눌러 주세요.`, en: `The last backup is ${enPlural(h, 'hour', 'hours')} old. Check that the server was on overnight and use "Back up now".`, id: `Cadangan terakhir ${h} jam yang lalu. Pastikan server menyala semalam dan gunakan "Cadangkan sekarang".` }),
  backupOk: (when: string, scope: string): T => ({ ko: `마지막 백업 ${when} (${scope})`, en: `Last backup ${when} (${scope})`, id: `Cadangan terakhir ${when} (${scope})` }),
  backupFailed: (msg: string): T => ({ ko: `마지막 백업이 실패했습니다: ${msg}`, en: `The last backup failed: ${msg}`, id: `Cadangan terakhir gagal: ${msg}` }),
  backupNoSpace: { ko: '디스크 공간이 부족해 백업하지 못했습니다(2GB 필요). 휴지통 비우기·오래된 버전 정리로 공간을 늘린 뒤 다시 해 주세요.', en: 'Not enough disk space for a backup (2 GB needed). Free up space (empty the trash, clean up old versions) and try again.', id: 'Ruang disk tidak cukup untuk cadangan (perlu 2 GB). Kosongkan ruang (tempat sampah, versi lama) lalu coba lagi.' },
  restoreFailed: (msg: string): T => ({ ko: `백업 복원이 실패해 기존 데이터를 그대로 두었습니다: ${msg}`, en: `Restoring a backup failed; the existing data was kept: ${msg}`, id: `Pemulihan cadangan gagal; data yang ada dipertahankan: ${msg}` }),
  timeMachine: { ko: 'Time Machine 제외 항목', en: 'Time Machine exclusions', id: 'Pengecualian Time Machine' },
  timeMachineOk: { ko: '비밀값·엔진 폴더가 Time Machine에서 빠져 있습니다.', en: 'Secrets and engine folders are excluded from Time Machine.', id: 'Rahasia dan folder mesin dikecualikan dari Time Machine.' },
  timeMachineMissing: { ko: '비밀값·엔진 폴더가 Time Machine 백업에 들어갈 수 있습니다. 메뉴바 앱의 \'설치 다시 하기\'를 실행해 주세요.', en: 'Secrets or engine folders may be included in Time Machine. Run "Reinstall" from the menubar app.', id: 'Rahasia atau folder mesin mungkin masuk Time Machine. Jalankan "Pasang ulang".' },

  update: { ko: '업데이트', en: 'Updates', id: 'Pembaruan' },
  updateOk: (v: string): T => ({ ko: `버전 ${v}`, en: `Version ${v}`, id: `Versi ${v}` }),
  updateRolledBack: (to: string, why: string): T => ({ ko: `새 버전이 정상적으로 켜지지 않아 ${to}(으)로 되돌렸습니다: ${why}`, en: `The new version did not start properly, so the server went back to ${to}: ${why}`, id: `Versi baru tidak berjalan dengan baik, server kembali ke ${to}: ${why}` }),
  updateDev: { ko: '개발 모드에서는 업데이트를 쓰지 않습니다.', en: 'Updates are not used in development mode.', id: 'Pembaruan tidak dipakai di mode pengembangan.' },
  releaseSig: { ko: '릴리스 서명', en: 'Release signature', id: 'Tanda tangan rilis' },
  releaseUnsigned: { ko: '이 설치본은 릴리스 서명이 없는 개발·시험 빌드입니다(릴리스 서명 키가 아직 없음). 파일 무결성(sha256)만 확인합니다.', en: 'This is an unsigned development/test build (no release signing key yet). Only file integrity (sha256) is checked.', id: 'Ini build pengembangan/uji tanpa tanda tangan (belum ada kunci rilis). Hanya integritas berkas (sha256) yang diperiksa.' },
  releaseSigned: { ko: '서명 확인됨', en: 'Signature verified', id: 'Tanda tangan terverifikasi' },
}
