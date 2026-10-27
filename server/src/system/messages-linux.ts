// Diagnostics and engine-status wording for a Linux server and for the hosted cloud (docs/DECISIONS.md "클라우드 리눅스
// 서버"). The Mac wording (messages.ts M, admin/engines.ts T) stays exactly as it is: these tables only replace the
// entries that talk about the server Mac, the menubar app, launchctl, pbpaste, /Library, /var/at, Time Machine or pf.
//   linux:  the customer's own Linux server: sudo on the server, systemctl / journalctl, mycel-ctl
//   hosted: the hosted cloud: the customer has no server to log in to; everything points at the admin screens or support
import type { Locale } from '@mycel/shared/api'
import type { HostKind } from './deployment'
import { M, enPlural } from './messages'

type T = { ko: string; en: string; id: string }
type MT = typeof M

/** Support line for the hosted cloud messages ("tell us"). */
const SUPPORT: T = { ko: 'TreeSoop 지원팀(카카오톡 채널·메일)에 알려 주세요.', en: 'Tell TreeSoop support (KakaoTalk channel or mail).', id: 'Beri tahu dukungan TreeSoop (kanal KakaoTalk atau email).' }
const withSupport = (t: T): T => ({ ko: `${t.ko} ${SUPPORT.ko}`, en: `${t.en} ${SUPPORT.en}`, id: `${t.id} ${SUPPORT.id}` })

/** The Linux replacements; `id` = the install id (systemd unit prefix), `base` = the install folder. */
export function linuxMessages(id: string, base: string): Partial<MT> {
  const ctl = 'sudo mycel-ctl'
  return {
    relayOffline: { ko: '중계 서버에 연결되지 않습니다. 서버의 인터넷 연결을 확인해 주세요. 사무실 안 직접 연결은 계속 됩니다.', en: 'Cannot reach the relay. Check the server\'s internet connection. Direct connections still work.', id: 'Tidak dapat menjangkau relay. Periksa koneksi internet server. Koneksi langsung tetap berfungsi.' },
    relayReplaced: { ko: '다른 서버가 같은 팀 주소로 연결해 이 서버의 연결을 대신했습니다. 의도한 일이 아니면 팀 키를 바꿔 주세요.', en: 'Another server connected with this team\'s address and replaced this one. If you did not do this, rotate the team key.', id: 'Server lain terhubung dengan alamat tim ini dan menggantikan server ini. Jika bukan Anda, ganti kunci tim.' },
    engineNotLoggedIn: { ko: '로그인되어 있지 않습니다. 관리자 > AI 엔진에서 다시 연결하거나, 서버에서 owner가 토큰을 다시 저장해 주세요(docs/INSTALL-LINUX.md "AI 연결").', en: 'Not signed in. Connect it again in Admin > AI engines, or the owner stores the token again on the server (docs/INSTALL-LINUX.md).', id: 'Belum masuk. Hubungkan lagi di Admin > Mesin AI, atau owner menyimpan token lagi di server (docs/INSTALL-LINUX.md).' },
    engineSetupToken: {
      ko: `Claude 구독 장기 토큰이 없습니다. owner가 \`claude setup-token\`으로 토큰을 만든 뒤 서버에서 \`sudo ${base}/root/set-claude-token < 토큰파일\`로 저장해야 AI가 답합니다(관리자 화면에서 연결할 수 있으면 그쪽이 먼저, docs/INSTALL-LINUX.md).`,
      en: `No long-lived Claude subscription token. The owner makes one with \`claude setup-token\` and stores it on the server with \`sudo ${base}/root/set-claude-token < token-file\` before the AI can answer (use the admin screen instead where it offers this; docs/INSTALL-LINUX.md).`,
      id: `Tidak ada token langganan Claude jangka panjang. Owner membuatnya dengan \`claude setup-token\` lalu menyimpannya di server dengan \`sudo ${base}/root/set-claude-token < berkas-token\` agar AI bisa menjawab (pakai layar admin bila tersedia; docs/INSTALL-LINUX.md).`,
    },
    engineSetupTokenExpired: { ko: 'Claude 구독 장기 토큰이 만료되었습니다(1년). owner가 `claude setup-token`으로 새 토큰을 만들어 같은 방법으로 다시 저장해 주세요(docs/INSTALL-LINUX.md).', en: 'The long-lived Claude subscription token has expired (one year). The owner has to make a new one with `claude setup-token` and store it the same way (docs/INSTALL-LINUX.md).', id: 'Token langganan Claude jangka panjang sudah kedaluwarsa (satu tahun). Owner perlu membuat token baru dengan `claude setup-token` dan menyimpannya dengan cara yang sama (docs/INSTALL-LINUX.md).' },
    engineSetupTokenInvalid: { ko: 'Claude 구독 장기 토큰이 거절되었습니다(취소되었거나 잘못 붙여 넣음). owner가 `claude setup-token`으로 새 토큰을 만들어 다시 저장해 주세요(docs/INSTALL-LINUX.md).', en: 'The long-lived Claude subscription token was refused (revoked or pasted wrong). The owner has to make a new one with `claude setup-token` and store it again (docs/INSTALL-LINUX.md).', id: 'Token langganan Claude jangka panjang ditolak (dicabut atau salah tempel). Owner perlu membuat token baru dengan `claude setup-token` dan menyimpannya lagi (docs/INSTALL-LINUX.md).' },
    subscriptionRejected: { ko: 'Claude 구독 토큰이 거절되었습니다(만료 또는 취소). owner가 `claude setup-token`으로 새 토큰을 만들어 다시 연결해야 합니다(docs/INSTALL-LINUX.md).', en: 'The Claude subscription token was refused (expired or revoked). The owner has to make a new one with `claude setup-token` and connect it again (docs/INSTALL-LINUX.md).', id: 'Token langganan Claude ditolak (kedaluwarsa atau dicabut). Owner perlu membuat token baru dengan `claude setup-token` lalu menghubungkannya lagi (docs/INSTALL-LINUX.md).' },
    engineCodexLogin: { ko: `Codex는 엔진 계정 전용 로그인이 필요합니다. owner가 서버에서 \`${ctl} codex-login\`을 한 번 실행해, 나오는 주소와 코드로 로그인합니다(docs/INSTALL-LINUX.md).`, en: `Codex needs its own engine-account login. The owner runs \`${ctl} codex-login\` once on the server and signs in with the address and code it prints (docs/INSTALL-LINUX.md).`, id: `Codex memerlukan login akun mesin sendiri. Owner menjalankan \`${ctl} codex-login\` sekali di server lalu masuk dengan alamat dan kode yang ditampilkan (docs/INSTALL-LINUX.md).` },

    firewall: { ko: 'AI 엔진 방화벽(nftables)', en: 'AI engine firewall (nftables)', id: 'Firewall mesin AI (nftables)' },
    firewallMissing: { ko: `방화벽 규칙이 없습니다. 서버에서 \`${ctl} firewall apply\`를 실행해 주세요. 그동안 AI 엔진은 실행되지 않습니다.`, en: `The firewall rules are missing. Run \`${ctl} firewall apply\` on the server. Until then the AI engine does not run.`, id: `Aturan firewall tidak ada. Jalankan \`${ctl} firewall apply\` di server. Sampai itu mesin AI tidak berjalan.` },
    firewallStale: { ko: `방화벽 확인이 15분 넘게 멈췄습니다. \`systemctl status ${id}-firewall.timer\`로 확인해 주세요. 10분이 지나면 AI 엔진이 실행되지 않습니다.`, en: `The firewall check stopped over 15 minutes ago. Look at \`systemctl status ${id}-firewall.timer\`. After 10 minutes the AI engine stops running.`, id: `Pemeriksaan firewall berhenti lebih dari 15 menit. Periksa \`systemctl status ${id}-firewall.timer\`. Setelah 10 menit mesin AI berhenti.` },
    firewallOff: (why: string): T => ({ ko: `방화벽 규칙을 넣지 못했습니다(${why}). 다른 방화벽 도구가 nftables 규칙을 지웠을 수 있습니다. \`${ctl} firewall apply\`를 실행해 주세요.`, en: `The firewall rules could not be loaded (${why}). Another firewall tool may have flushed the nftables rules. Run \`${ctl} firewall apply\`.`, id: `Aturan firewall tidak bisa dimuat (${why}). Alat firewall lain mungkin menghapus aturan nftables. Jalankan \`${ctl} firewall apply\`.` }),
    sandboxMissing: { ko: `엔진 샌드박스(bwrap)가 실행기에 설정되어 있지 않습니다. \`sudo ./install-linux.sh repair\`로 설치를 고쳐 주세요.`, en: 'The engine sandbox (bwrap) is not set up in the launcher. Repair the install with `sudo ./install-linux.sh repair`.', id: 'Sandbox mesin (bwrap) tidak diatur di peluncur. Perbaiki instalasi dengan `sudo ./install-linux.sh repair`.' },
    cronDenyMissing: { ko: '엔진 계정이 /etc/cron.deny·at.deny에 없습니다. 샌드박스 안에는 crontab·at이 없지만 `sudo ./install-linux.sh repair`로 보완해 주세요.', en: 'The engine account is not in /etc/cron.deny / at.deny. The sandbox has no crontab or at, but run `sudo ./install-linux.sh repair` to add it.', id: 'Akun mesin tidak ada di /etc/cron.deny / at.deny. Sandbox tidak punya crontab atau at, tetapi jalankan `sudo ./install-linux.sh repair`.' },
    launcherDown: { ko: `실행기에 연결할 수 없습니다. 서버에서 \`sudo systemctl restart ${id}-launcher\`를 실행해 주세요.`, en: `Cannot reach the engine launcher. Run \`sudo systemctl restart ${id}-launcher\` on the server.`, id: `Tidak dapat menjangkau peluncur mesin. Jalankan \`sudo systemctl restart ${id}-launcher\` di server.` },
    launcherNotRunning: (): T => ({
      ko: `AI 실행기가 실행 중이 아니어서 채팅이 시작되지 않습니다. 서버에서 \`sudo systemctl restart ${id}-launcher\`를 실행해 주세요. 다시 멈추면 \`journalctl -u ${id}-launcher -n 100\`을 확인해 주세요.`,
      en: `The AI launcher is not running, so chats cannot start. Run \`sudo systemctl restart ${id}-launcher\` on the server. If it stops again, look at \`journalctl -u ${id}-launcher -n 100\`.`,
      id: `Peluncur AI tidak berjalan, jadi chat tidak bisa dimulai. Jalankan \`sudo systemctl restart ${id}-launcher\` di server. Jika berhenti lagi, lihat \`journalctl -u ${id}-launcher -n 100\`.`,
    }),
    lanFailed: (n: number, mismatch: number, port: number): T => {
      const mm: T = mismatch
        ? { ko: ` 그중 ${mismatch}번은 인증서가 달랐습니다: 서버 인증서를 다시 만들었거나 같은 네트워크의 다른 기기가 서버인 척했을 수 있습니다.`, en: ` ${mismatch} of them saw a different certificate: the server certificate was re-created, or another device on the network pretended to be the server.`, id: ` ${mismatch} di antaranya melihat sertifikat lain: sertifikat server dibuat ulang, atau perangkat lain di jaringan menyamar sebagai server.` }
        : { ko: '', en: '', id: '' }
      return {
        ko: `데스크톱 앱이 사무실 안에서 직접 연결에 ${n}번 실패했습니다(24시간, 사람·1시간마다 한 번 셈).${mm.ko} 서버의 방화벽(ufw·firewalld 등)에서 포트 ${port}이 열려 있는지 확인해 주세요. 그동안 앱은 원격 주소로 계속 연결됩니다.`,
        en: `Desktop apps in the office failed to connect directly ${enPlural(n, 'time', 'times')} (24 h, counted once per person per hour).${mm.en} Check that port ${port} is open in the server's firewall (ufw, firewalld …). Meanwhile the apps keep using the remote address.`,
        id: `Aplikasi desktop di kantor gagal terhubung langsung ${n} kali (24 jam, dihitung sekali per orang per jam).${mm.id} Pastikan port ${port} terbuka di firewall server (ufw, firewalld …). Sementara itu aplikasi tetap memakai alamat jarak jauh.`,
      }
    },
    launcherDenied: { ko: '서버 계정이 AI 실행기 소켓을 열 수 없습니다(권한). `sudo ./install-linux.sh repair`로 폴더 권한을 고쳐 주세요.', en: 'The server account may not open the AI launcher socket (permissions). Repair the folder permissions with `sudo ./install-linux.sh repair`.', id: 'Akun server tidak boleh membuka soket peluncur AI (izin). Perbaiki izin folder dengan `sudo ./install-linux.sh repair`.' },
  }
}

/** the hosted cloud: no commands, nothing about a machine the team does not have. */
export function hostedMessages(): Partial<MT> {
  return {
    relayOff: withSupport({ ko: '팀 주소(중계) 연결이 설정되어 있지 않습니다.', en: 'The team address (relay) connection is not set up.', id: 'Koneksi alamat tim (relay) belum diatur.' }),
    relayOffline: withSupport({ ko: '팀 주소(중계)에 연결되지 않습니다. 몇 분 뒤에도 그대로면', en: 'The team address (relay) cannot be reached. If this lasts a few minutes,', id: 'Alamat tim (relay) tidak terjangkau. Jika berlangsung beberapa menit,' }),
    relayReplaced: withSupport({ ko: '다른 서버가 같은 팀 주소로 연결해 이 팀의 연결을 대신했습니다.', en: 'Another server connected with this team\'s address and replaced this team\'s connection.', id: 'Server lain terhubung dengan alamat tim ini dan menggantikan koneksi tim ini.' }),
    engineNotLoggedIn: { ko: '로그인되어 있지 않습니다. 관리자 > AI 엔진에서 다시 연결해 주세요.', en: 'Not signed in. Connect it again in Admin > AI engines.', id: 'Belum masuk. Hubungkan lagi di Admin > Mesin AI.' },
    engineSetupToken: { ko: 'AI 계정이 연결되어 있지 않습니다. 관리자 > AI 엔진에서 연결해 주세요.', en: 'No AI account is connected. Connect one in Admin > AI engines.', id: 'Belum ada akun AI yang terhubung. Hubungkan di Admin > Mesin AI.' },
    engineSetupTokenExpired: { ko: 'Claude 연결이 만료되었습니다. 관리자 > AI 엔진에서 다시 연결해 주세요.', en: 'The Claude connection has expired. Connect it again in Admin > AI engines.', id: 'Koneksi Claude kedaluwarsa. Hubungkan lagi di Admin > Mesin AI.' },
    engineSetupTokenInvalid: { ko: 'Claude가 연결을 거절했습니다(취소되었거나 잘못 붙여 넣음). 관리자 > AI 엔진에서 다시 연결해 주세요.', en: 'Claude refused the connection (revoked or pasted wrong). Connect it again in Admin > AI engines.', id: 'Claude menolak koneksi (dicabut atau salah tempel). Hubungkan lagi di Admin > Mesin AI.' },
    subscriptionRejected: { ko: 'Claude 연결이 거절되었습니다(만료 또는 취소). 관리자 > AI 엔진에서 다시 연결해 주세요.', en: 'The Claude connection was refused (expired or revoked). Connect it again in Admin > AI engines.', id: 'Koneksi Claude ditolak (kedaluwarsa atau dicabut). Hubungkan lagi di Admin > Mesin AI.' },
    engineCodexLogin: { ko: 'Codex가 연결되어 있지 않습니다. 관리자 > AI 엔진에서 연결해 주세요.', en: 'Codex is not connected. Connect it in Admin > AI engines.', id: 'Codex belum terhubung. Hubungkan di Admin > Mesin AI.' },
    firewall: { ko: 'AI 엔진 방화벽', en: 'AI engine firewall', id: 'Firewall mesin AI' },
    firewallMissing: withSupport({ ko: '방화벽 규칙이 없어 AI 엔진이 실행되지 않습니다.', en: 'The firewall rules are missing, so the AI engine does not run.', id: 'Aturan firewall tidak ada, jadi mesin AI tidak berjalan.' }),
    firewallStale: withSupport({ ko: '방화벽 확인이 멈췄습니다.', en: 'The firewall check has stopped.', id: 'Pemeriksaan firewall berhenti.' }),
    firewallOff: (): T => withSupport({ ko: '방화벽 규칙을 넣지 못했습니다.', en: 'The firewall rules could not be loaded.', id: 'Aturan firewall tidak bisa dimuat.' }),
    sandboxMissing: withSupport({ ko: '엔진 샌드박스가 설정되어 있지 않습니다.', en: 'The engine sandbox is not set up.', id: 'Sandbox mesin tidak diatur.' }),
    cronDenyMissing: withSupport({ ko: '엔진 계정 예약 작업 차단이 빠져 있습니다.', en: 'The engine account scheduling block is missing.', id: 'Blokir penjadwalan akun mesin tidak ada.' }),
    launcherDown: withSupport({ ko: 'AI 실행기에 연결할 수 없습니다.', en: 'Cannot reach the AI launcher.', id: 'Tidak dapat menjangkau peluncur AI.' }),
    launcherNotRunning: (): T => withSupport({ ko: 'AI 실행기가 실행 중이 아니어서 채팅이 시작되지 않습니다.', en: 'The AI launcher is not running, so chats cannot start.', id: 'Peluncur AI tidak berjalan, jadi chat tidak bisa dimulai.' }),
    launcherDenied: withSupport({ ko: '서버 계정이 AI 실행기에 연결할 수 없습니다(권한).', en: 'The server account may not reach the AI launcher (permissions).', id: 'Akun server tidak boleh menjangkau peluncur AI (izin).' }),
    socketsTooLong: (): T => withSupport({ ko: 'AI 엔진 소켓 경로가 너무 길어 엔진이 시작되지 않습니다.', en: 'An AI engine socket path is too long, so the engine cannot start.', id: 'Jalur soket mesin AI terlalu panjang, jadi mesin tidak bisa mulai.' }),
    backupNone: { ko: '아직 백업이 없습니다. 매일 새벽 자동으로 만들어집니다. 지금 만들려면 \'지금 백업\'을 누르세요.', en: 'No backup yet. One is made automatically every night; use "Back up now" to make one now.', id: 'Belum ada cadangan. Dibuat otomatis setiap malam; gunakan "Cadangkan sekarang".' },
    backupOld: (h: number): T => withSupport({ ko: `마지막 백업이 ${h}시간 전입니다.`, en: `The last backup is ${enPlural(h, 'hour', 'hours')} old.`, id: `Cadangan terakhir ${h} jam yang lalu.` }),
  }
}

/** Linux-only checks (system/ops.ts linuxChecks). */
export const ML = {
  kernel: { ko: '커널 격리', en: 'Kernel isolation', id: 'Isolasi kernel' },
  kernelOk: { ko: 'ptrace 제한·cgroup 위임·사용자 네임스페이스 모두 켜짐', en: 'ptrace restriction, cgroup delegation and user namespaces are all on', id: 'Pembatasan ptrace, delegasi cgroup, dan user namespace semuanya aktif' },
  kernelMissing: (what: string[], hosted: boolean): T => hosted
    ? withSupport({ ko: `빠진 것: ${what.join(', ')}.`, en: `Missing: ${what.join(', ')}.`, id: `Yang kurang: ${what.join(', ')}.` })
    : { ko: `빠진 것: ${what.join(', ')}. 이 서버에서는 턴끼리의 격리가 약해집니다(docs/INSTALL-LINUX.md "요구 사항").`, en: `Missing: ${what.join(', ')}. Turns are less isolated from each other on this server (docs/INSTALL-LINUX.md).`, id: `Yang kurang: ${what.join(', ')}. Isolasi antar giliran lebih lemah di server ini (docs/INSTALL-LINUX.md).` },
  firewallOkLinux: (rules: number, port: number): T => ({ ko: `nftables 규칙 ${rules}개(엔진 계정은 127.0.0.1:${port}만)`, en: `${enPlural(rules, 'nftables rule', 'nftables rules')} (the engine account reaches 127.0.0.1:${port} only)`, id: `${rules} aturan nftables (akun mesin hanya ke 127.0.0.1:${port})` }),
  sandboxLinuxOk: (bwrap: string | null, abi: number | null, seccomp: boolean): T => {
    const parts = [`bwrap${bwrap ? ' ' + bwrap : ''}`, abi ? `Landlock ABI ${abi}` : null, seccomp ? 'seccomp' : null].filter(Boolean).join(', ')
    return { ko: `모든 엔진 실행에 적용됨 (${parts})`, en: `Applied to every engine run (${parts})`, id: `Diterapkan ke setiap eksekusi mesin (${parts})` }
  },
  sandboxNotScoped: (hosted: boolean): T => hosted
    ? withSupport({ ko: '커널이 오래되어 턴끼리의 추상 소켓·시그널을 막지 못합니다.', en: 'The kernel is too old to keep turns\' abstract sockets and signals apart.', id: 'Kernel terlalu lama untuk memisahkan soket abstrak dan sinyal antar giliran.' })
    : { ko: '커널이 6.12보다 오래되어 추상 유닉스 소켓·시그널을 턴끼리 막지 못합니다. 커널을 올리면 해결됩니다.', en: 'The kernel is older than 6.12, so abstract Unix sockets and signals are not kept apart between turns. A newer kernel fixes this.', id: 'Kernel lebih lama dari 6.12, jadi soket Unix abstrak dan sinyal tidak dipisahkan antar giliran. Kernel yang lebih baru memperbaikinya.' },
  sandboxNone: (hosted: boolean): T => hosted
    ? withSupport({ ko: 'AI 엔진이 샌드박스 없이 설정되어 있습니다.', en: 'The AI engine is set up without its sandbox.', id: 'Mesin AI diatur tanpa sandbox.' })
    : { ko: 'AI 엔진 샌드박스(bwrap)가 꺼져 있습니다. `sudo ./install-linux.sh repair`로 설치를 고쳐 주세요.', en: 'The AI engine sandbox (bwrap) is off. Repair the install with `sudo ./install-linux.sh repair`.', id: 'Sandbox mesin AI (bwrap) mati. Perbaiki instalasi dengan `sudo ./install-linux.sh repair`.' },
  sandboxUnknown: { ko: '실행기가 샌드박스 상태를 알려 주지 않았습니다(이전 버전의 실행기). 실행기를 업데이트하면 보입니다.', en: 'The launcher did not report its sandbox (an older launcher). Updating the launcher shows it.', id: 'Peluncur tidak melaporkan sandbox-nya (peluncur versi lama). Memperbarui peluncur akan menampilkannya.' },
  cronAbsent: { ko: 'cron·at이 설치되어 있지 않습니다(엔진 계정이 예약 작업을 등록할 수 없음).', en: 'cron and at are not installed (the engine account cannot schedule jobs).', id: 'cron dan at tidak terpasang (akun mesin tidak dapat menjadwalkan tugas).' },
  storage: { ko: '저장 공간', en: 'Storage', id: 'Penyimpanan' },
  storageOk: (free: number, pct: number): T => ({ ko: `${gb(free)} 남음 (${pct}% 사용)`, en: `${gb(free)} free (${pct}% used)`, id: `${gb(free)} kosong (${pct}% terpakai)` }),
  storageHigh: (free: number, pct: number): T => ({ ko: `${pct}% 사용, ${gb(free)} 남음. 휴지통 비우기·오래된 파일 정리로 공간을 늘려 주세요(관리자 > 시스템 > 저장 공간).`, en: `${pct}% used, ${gb(free)} free. Empty the trash or clean up old files (Admin > System > Storage).`, id: `${pct}% terpakai, ${gb(free)} kosong. Kosongkan tempat sampah atau rapikan berkas lama (Admin > Sistem > Penyimpanan).` }),
  storageFull: (free: number, pct: number): T => ({ ko: `${pct}% 사용, ${gb(free)} 남음. 공간이 거의 없어 저장·업로드·AI의 파일 쓰기가 거부됩니다. 바로 공간을 비워 주세요.`, en: `${pct}% used, ${gb(free)} free. Saves, uploads and the AI's file writes are refused. Free up space now.`, id: `${pct}% terpakai, ${gb(free)} kosong. Penyimpanan, unggahan, dan penulisan berkas AI ditolak. Segera kosongkan ruang.` }),
  updateNeedsRoot: (v: string): T => ({ ko: `새 버전 ${v}은(는) 서버의 관리자 권한이 필요합니다. 서버에서 \`sudo mycel-ctl update\`를 실행하거나 업데이트 타이머를 기다려 주세요.`, en: `The new version ${v} needs administrator rights on the server. Run \`sudo mycel-ctl update\` there, or wait for the update timer.`, id: `Versi baru ${v} memerlukan hak administrator di server. Jalankan \`sudo mycel-ctl update\` di sana, atau tunggu timer pembaruan.` }),
  updateManaged: (v: string): T => ({ ko: `버전 ${v}. 업데이트는 TreeSoop이 점검 시간에 합니다.`, en: `Version ${v}. TreeSoop installs updates during the maintenance window.`, id: `Versi ${v}. TreeSoop memasang pembaruan saat jendela pemeliharaan.` }),
  managedFiles: { ko: '요금제·공지 파일', en: 'Plan and notices files', id: 'Berkas paket dan pengumuman' },
  managedFileBad: (file: string, err: string, hosted: boolean, cmd = file === 'plan.json' ? 'apply-plan' : 'notices-set'): T => hosted
    ? withSupport({ ko: `${file}을(를) 읽지 못해 이전 값을 그대로 씁니다.`, en: `${file} could not be read; the previous values stay.`, id: `${file} tidak bisa dibaca; nilai sebelumnya tetap dipakai.` })
    : { ko: `${file}이(가) 올바르지 않아 이전 값을 그대로 씁니다(${err}). \`sudo mycel-ctl ${cmd}\`으로 다시 넣어 주세요.`, en: `${file} is not valid, so the previous values stay (${err}). Put it again with \`sudo mycel-ctl ${cmd}\`.`, id: `${file} tidak valid, jadi nilai sebelumnya tetap dipakai (${err}). Pasang lagi dengan \`sudo mycel-ctl ${cmd}\`.` },
  storagePlanMismatch: (diskGiB: number, planGiB: number): T => withSupport({ ko: `디스크 크기(${diskGiB.toFixed(0)} GB)가 요금제(${planGiB} GB)와 다릅니다.`, en: `The disk size (${diskGiB.toFixed(0)} GB) differs from the plan (${planGiB} GB).`, id: `Ukuran disk (${diskGiB.toFixed(0)} GB) berbeda dari paket (${planGiB} GB).` }),
}
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`

/** M with the entries for this host replaced (the Mac gets M itself). */
export function hostMessages(host: HostKind, o: { id: string; base: string }): MT {
  if (host === 'mac') return M
  return { ...M, ...linuxMessages(o.id, o.base), ...(host === 'hosted' ? hostedMessages() : {}) } as MT
}

// ---------------- admin/engines.ts status lines ----------------
type ET = Record<Locale, string>
export function engineStatusMessages(host: HostKind, base: string): Record<string, ET> {
  if (host === 'mac') return {}
  const linux: Record<string, ET> = {
    notInstalled: { ko: '서버에 설치되어 있지 않습니다.', en: 'Not installed on the server.', id: 'Belum terpasang di server.' },
    claudeLogin: { ko: '서버에서 owner가 `claude`를 실행해 로그인해야 합니다.', en: 'The owner must sign in by running `claude` on the server.', id: 'Owner harus masuk dengan menjalankan `claude` di server.' },
    codexLogin: { ko: '서버에서 owner가 `codex login`으로 로그인해야 합니다.', en: 'The owner must sign in with `codex login` on the server.', id: 'Owner harus masuk dengan `codex login` di server.' },
    setupToken: {
      ko: `전용 엔진 계정 모드에는 owner의 구독 장기 토큰이 필요합니다: \`claude setup-token\`으로 토큰을 만들고 서버에서 \`sudo ${base}/root/set-claude-token < 토큰파일\`로 저장하세요(secrets/claude-oauth-token, docs/INSTALL-LINUX.md).`,
      en: `The dedicated engine account needs the owner's long-lived subscription token: make one with \`claude setup-token\` and store it on the server with \`sudo ${base}/root/set-claude-token < token-file\` (secrets/claude-oauth-token, docs/INSTALL-LINUX.md).`,
      id: `Akun mesin khusus memerlukan token langganan owner: buat dengan \`claude setup-token\` lalu simpan di server dengan \`sudo ${base}/root/set-claude-token < berkas-token\` (secrets/claude-oauth-token, docs/INSTALL-LINUX.md).`,
    },
    codexDevice: { ko: '전용 엔진 계정의 Codex 로그인이 아직 없습니다. 서버에서 owner가 `sudo mycel-ctl codex-login`을 한 번 실행해 나오는 주소와 코드로 로그인합니다(docs/INSTALL-LINUX.md).', en: 'The engine account has no Codex sign-in yet. On the server the owner runs `sudo mycel-ctl codex-login` once and signs in with the address and code it prints (docs/INSTALL-LINUX.md).', id: 'Akun mesin belum masuk ke Codex. Di server, owner menjalankan `sudo mycel-ctl codex-login` sekali lalu masuk dengan alamat dan kode yang ditampilkan (docs/INSTALL-LINUX.md).' },
  }
  if (host === 'linux') return linux
  return {
    ...linux,
    notInstalled: { ko: '이 팀 서버에 설치되어 있지 않습니다. TreeSoop 지원팀에 알려 주세요.', en: 'Not installed on this team server. Tell TreeSoop support.', id: 'Belum terpasang di server tim ini. Beri tahu dukungan TreeSoop.' },
    claudeLogin: { ko: '관리자 > AI 엔진에서 연결해 주세요.', en: 'Connect it in Admin > AI engines.', id: 'Hubungkan di Admin > Mesin AI.' },
    codexLogin: { ko: '관리자 > AI 엔진에서 연결해 주세요.', en: 'Connect it in Admin > AI engines.', id: 'Hubungkan di Admin > Mesin AI.' },
    setupToken: { ko: 'AI 계정이 연결되어 있지 않습니다. 관리자 > AI 엔진에서 연결해 주세요.', en: 'No AI account is connected. Connect one in Admin > AI engines.', id: 'Belum ada akun AI yang terhubung. Hubungkan di Admin > Mesin AI.' },
    codexDevice: { ko: 'Codex가 연결되어 있지 않습니다. 관리자 > AI 엔진에서 연결해 주세요.', en: 'Codex is not connected. Connect it in Admin > AI engines.', id: 'Codex belum terhubung. Hubungkan di Admin > Mesin AI.' },
  }
}
