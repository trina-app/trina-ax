# 사무실 모드 (office mode): 맥 한 대 + 같은 네트워크의 데스크 PC들

치과·병원·작은 사무실에서 **맥 미니 한 대**가 Team AX를 돌리고, 같은 사무실 네트워크의 **윈도우 데스크 PC 10대 정도**가
Edge(또는 Chrome)로 접속하는 구성입니다. 중계 서버(`<팀>.treesoop.com`)도, 운영 설치(역할 계정)도 필요 없습니다.

- AI는 **그 맥에 로그인된 Claude Code**(원장님/소유자의 Claude 구독)로 돕니다. 개발 모드와 같은 엔진 구성입니다:
  권한 함수, 엔진 잠금(lockdown), macOS 샌드박스(`engine.sb`). 다만 DEV 배너는 나오지 않습니다.
- 데스크는 `https://<맥 주소>:8443`으로 들어옵니다. 인증서는 그 맥이 처음 한 번 만드는 **사무실 전용 인증 기관(CA)**이
  서명하고, 데스크마다 이 CA를 **한 번만** 설치합니다.
- 관리자 암호(sudo) 없이 설치됩니다. 모든 것이 `~/TeamAX`에 들어갑니다.

> English summary: one Mac runs Team AX as the signed-in user with that Mac's Claude Code login (dev mode's engine
> setup without the DEV banner); desks on the office network use `https://<mac>:8443` after installing the office CA
> once (helper page on `http://<mac>:8442`). No sudo, no relay. Bundle: `bun run build:office`; install:
> `bash office-install.sh`; control: `~/TeamAX/teamax`.

## 0. 준비물

| | |
|---|---|
| 서버 맥 | 맥 미니 권장(Apple Silicon 또는 Intel), macOS 13 이상. **Team AX 전용**으로 두고 개인 자료를 두지 마세요 |
| FileVault | 켜 두세요(시스템 설정 → 개인정보 보호 및 보안 → FileVault). 환자 자료가 디스크에 암호화되어 저장됩니다 |
| Claude Code | 그 맥의 그 사용자 계정에서 설치·로그인: 터미널에서 `curl -fsSL https://claude.ai/install.sh \| bash` → `claude` → `/login` |
| 네트워크 | 데스크와 같은 사무실 네트워크(유선 권장). 공유기에서 맥 주소 고정(DHCP 예약) |
| 데스크 | 윈도우 10/11 + Edge 또는 Chrome. 인증서 설치에 PC 관리자 암호가 있으면 "로컬 컴퓨터", 없으면 "현재 사용자" |

맥 미니에는 git·Go·Node·Homebrew·GitHub 접근이 **필요 없습니다**. zip 하나에 bun, ripgrep, pandoc, 네이티브 도우미
(arm64·x64 둘 다), 웹 앱, 서버가 다 들어 있습니다. (PDF 글자 추출만 Homebrew의 `poppler`가 있을 때 됩니다: 알려진 한계.)

## 1. 번들 만들기 (개발 맥에서, 한 번)

```sh
bun install
bun run build:office        # = ARCHS="arm64 amd64" bash native/build.sh && web 빌드 && bun scripts/build-office.ts
# → dist/office/TeamAX-office-<버전>-mac.zip  (약 130 MB)
```

bun·ripgrep·pandoc은 GitHub 릴리스에서 버전과 SHA-256을 고정해 받습니다(`scripts/build-office.ts`의 `DOWNLOADS`,
`dist/cache/`에 보관하므로 두 번째부터는 오프라인으로도 됩니다). zip을 USB·AirDrop·메일로 맥 미니에 옮깁니다.

## 2. 맥 미니에 설치

맥 미니에서, **AI가 쓸 Claude 로그인이 있는 그 사용자로** 로그인한 상태에서:

```sh
# 1) Claude Code 로그인 확인 (안 되어 있으면 claude 실행 → /login)
claude auth status

# 2) zip 풀기 (다운로드 폴더에 있다고 가정; Finder에서 더블클릭해도 됩니다)
cd ~/Downloads && ditto -x -k TeamAX-office-0.1.0-mac.zip .

# 3) 설치 (sudo 아님)
bash ~/Downloads/TeamAX-office-0.1.0/office-install.sh
```

설치기가 하는 일: macOS 버전·프로세서·Claude 로그인을 확인 → `~/TeamAX/app`에 이 맥의 프로세서용 프로그램만 복사(다운로드
격리 표시 제거) → `~/TeamAX/config/office.env` → LaunchAgent `app.team-ax.office` 설치·시작 → 서버가 답할 때까지 기다림 →
**데스크용 주소, 인증서 페이지 주소, CA 지문, 첫 설정 링크**를 출력하고 첫 설정 페이지를 이 맥의 브라우저에 엽니다.

옵션: `--lan-port 8443`(데스크용 https), `--helper-port 8442`(인증서 페이지, `0`=끔), `--app-port 47830`(이 맥 안에서만),
`--prefix ~/TeamAX`, `--no-open`, `--check-only`(확인만 하고 아무것도 바꾸지 않음).

### 첫 설정 (소유자 계정, 한 번)

열린 페이지(`http://localhost:47830/setup?token=…`)에서 팀 이름·언어·소유자 계정을 만듭니다. 링크를 다시 보려면
`~/TeamAX/teamax setup-link`. 그다음 **관리자 → 사람**에서 데스크마다 초대 링크를 만들어 전달합니다(메일 발송 없음).
초대 링크는 데스크용 주소(`https://<IP>:8443/invite/…`)로 만들어집니다.

## 3. 데스크(윈도우) 연결: PC마다 한 번

1. Edge에서 `http://<맥 IP>:8442` 를 엽니다(설치 끝에 출력된 "인증서 설치 페이지"). 이 페이지는 인증서와 안내만 줍니다.
2. **윈도우용 인증서 받기(.cer)** → 파일 열기 → **인증서 설치…** → 저장소 위치 **로컬 컴퓨터**(관리자 암호) 또는
   **현재 사용자** → **모든 인증서를 다음 저장소에 저장** → 찾아보기 → **신뢰할 수 있는 루트 인증 기관** → 마침.
3. 보안 경고 창의 **지문(sha1)**이 페이지(그리고 `~/TeamAX/teamax info`)의 SHA-1과 같은지 확인하고 **예**.
4. Edge를 모두 닫았다 열고 `https://<맥 IP>:8443` → 로그인(초대 링크로 만든 계정).
5. 바탕화면 아이콘: Edge **⋯ → 앱 → 이 사이트를 앱으로 설치**. (Chrome: ⋮ → 전송, 저장, 공유 → 페이지를 앱으로 설치)
   이후에는 일반 프로그램처럼 창으로 열립니다(PWA: https + 신뢰된 인증서에서 설치 가능함을 확인했습니다).

주소는 IP(`https://192.168.x.x:8443`)를 권장합니다. `https://<맥 이름>.local:8443`도 인증서에 들어 있지만 네트워크에 따라
윈도우가 `.local` 이름을 못 찾을 수 있습니다. 맥 이름은 시스템 설정 → 일반 → 공유 → 로컬 호스트 이름.

휴대폰·다른 맥: 같은 페이지의 `.crt`와 안내(아이폰: 프로파일 설치 후 **인증서 신뢰 설정**에서 켜기).

**Team AX 데스크톱 앱(Electron)은 이번 시범에 필요 없습니다.** CA를 윈도우에 설치하면 데스크톱 앱도 `192.168.x.x:8443`
주소를 받습니다(주소 검사 시험 있음, 윈도우에서 직접 확인은 안 함). 시범은 Edge 앱 설치로 하세요.

## 4. 계속 켜 두기

LaunchAgent는 **이 사용자가 로그인해 있는 동안** 돌고, 죽으면 다시 켜집니다(`KeepAlive`). 서버가 죽으면 감시 프로세스가
2초부터 최대 30초 간격으로 다시 띄웁니다. 화면이 잠겨 있어도 돕니다. 이 맥에서 한 번만 하세요:

1. **잠자기 끄기·정전 뒤 자동 켜짐** (관리자 암호 필요; 설치기는 실행하지 않고 보여만 줍니다):
   `sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1`
   (디스플레이 잠자기는 괜찮습니다.)
2. **공유기에서 DHCP 예약**으로 맥 IP 고정. IP가 바뀌면 30초 안에 새 인증서를 자동으로 만들고 서버를 다시 띄웁니다
   (CA는 그대로라 데스크는 다시 설치할 필요 없음). 다만 데스크가 쓰는 주소가 바뀌므로 고정이 편합니다.
3. **정전·재시동 뒤 로그인**: FileVault가 켜져 있으면 맥이 켜진 뒤 누군가 그 맥 앞에서 암호를 한 번 입력해야 합니다
   (입력하면 그 사용자로 로그인되고 Team AX가 스스로 켜집니다). 자동 로그인은 FileVault와 함께 쓸 수 없습니다.
   환자 자료가 있으므로 **FileVault 켜기 + 정전 뒤 암호 한 번**을 권장합니다. UPS가 있으면 더 좋습니다.
4. **방화벽**: macOS 방화벽이 켜져 있으면 처음 시작할 때 "bun이 들어오는 연결을 허용하겠습니까?"가 뜹니다 → **허용**.
   설치기가 방화벽이 켜져 있으면 미리 허용하는 sudo 명령도 보여 줍니다.
5. 다른 사람이 이 맥에 로그인하거나 로그아웃하지 않게 하세요(로그아웃하면 Team AX가 멈춥니다).

## 5. 백업

- **매일 밤 자동 백업**(03시 이후, 14일 보관, 7일마다 전체·그 사이 증분)은 사무실 모드에서도 그대로 돕니다. 위치는 같은 디스크:
  `~/TeamAX/data/backups/`(DB)와 `~/TeamAX/team/.system/backups/`(팀 폴더). 관리자 → 시스템 → 백업에서 보고 "지금 백업".
  터미널: `~/TeamAX/teamax backup`.
- **외장 디스크 보관**(디스크 고장·도난 대비, 주 1회 권장): 외장 디스크를 꽂고
  ```sh
  ~/TeamAX/teamax archive /Volumes/<디스크 이름>/teamax-$(date +%F).tar.zst.age
  ```
  암호(8자 이상)를 두 번 묻고, DB + 팀 폴더 전체를 **암호화**(age)해서 한 파일로 씁니다. 암호를 잃으면 못 엽니다.
- **Time Machine**(선택): 외장 디스크에 Time Machine을 켜면 `~/TeamAX`도 함께 백업됩니다. "백업 암호화"를 켜세요
  (`~/TeamAX/tls/ca.key`가 들어갑니다).
- **복원**(새 맥이나 새로 설치한 곳으로): 설치 후 첫 설정을 하지 않은 상태에서
  ```sh
  ~/TeamAX/teamax restore-archive /Volumes/<디스크>/teamax-2026-10-21.tar.zst.age
  ```
  이미 팀이 있는 설치에 덮으려면 `--replace`(이전 `data/app.db`와 `team/`은 옆에 `*.before-restore-<시각>`으로 남습니다).
  보관본에는 인증서(CA)가 없으므로 새 맥이면 새 CA가 생기고 데스크에 인증서를 다시 설치해야 합니다. 같은 CA를 쓰려면
  `~/TeamAX/tls/`를 따로 옮기세요(그 안의 `ca.key`는 비밀입니다).

## 6. 명령 (`~/TeamAX/teamax`)

| 명령 | |
|---|---|
| `status` | 실행 중인지, 이 맥·데스크 주소·인증서 페이지가 답하는지 |
| `info` | 데스크 주소, 인증서 페이지, CA 지문(SHA-256, 윈도우 SHA-1) — `~/TeamAX/ADDRESSES.txt`와 같음 |
| `logs [n]` | 감시 프로세스 로그(`~/TeamAX/logs/office.log`); 서버 로그는 `~/TeamAX/logs/server/` (14일) |
| `start` / `stop` / `restart` | LaunchAgent 켜기/끄기/다시 |
| `setup-link` | 첫 설정 링크(아직 설정 전일 때) |
| `reset-link [--username U]` | 비밀번호 재설정 링크(24시간). 소유자 비밀번호를 잊었을 때도 |
| `backup` / `archive <파일>` / `restore-archive <파일> [--replace]` | 위 5장 |

설정 바꾸기: `~/TeamAX/config/office.env`를 고친 뒤 `teamax restart`(포트, 인증서 페이지 끄기 `TEAMAX_HELPER_PORT=0`).
`config/server.json`은 시작할 때마다 다시 쓰이므로 고치지 마세요.

## 7. 업데이트와 제거

- **업데이트**: 새 zip을 풀고 `bash office-install.sh`를 다시 실행. `app/`만 바뀌고(이전 것은 `app.previous`) `data/`·`team/`·
  `tls/`·`config/`는 그대로입니다. 포트·이름 등 설정도 이전 값을 씁니다. 같은 CA를 유지하므로 데스크는 할 일이 없습니다.
- **제거**: `bash office-uninstall.sh` → LaunchAgent와 프로그램만 지우고 데이터·팀 폴더·CA는 남김.
  `--delete-data`는 `~/TeamAX` 전체를 지웁니다("delete" 입력 확인).

## 8. 보안: 이 모드가 지키는 것과 아직 아닌 것

**지키는 것**
- 폴더 권한과 채팅 비공개는 운영 모드와 **같은 권한 함수**가 모든 파일 접근(AI 도구 포함)에서 판단합니다. AI는 질문한
  사람이 볼 수 있는 파일만 봅니다([PERMISSIONS.md](PERMISSIONS.md)).
- **엔진 잠금**: Claude Code의 자체 도구(셸·파일·웹)는 꺼져 있고 Team AX 도구만 씁니다. **macOS 샌드박스**(`engine.sb`)가
  엔진이 그 채팅 폴더 밖(`/Users`, 다른 채팅, 서버 데이터, 이 맥 사용자의 다른 파일)을 못 읽게 막습니다.
- 데이터(DB, 팀 폴더, 백업)는 **병원의 그 맥에만** 있습니다. 중계 서버를 거치지 않습니다. 환자 자료는 **AI에 묻는 요청의
  일부로만** Anthropic(Claude)에 전송됩니다(질문 내용과 AI가 그 질문을 위해 읽은 파일 내용).
- 사무실 네트워크에는 **https만** 열립니다. 평문 http 앱 포트는 `127.0.0.1`(그 맥 안)만. 8442 인증서 페이지는 인증서와
  안내 세 경로만 주고 API는 없습니다. 서버는 자기 이름·주소로 온 요청만 받습니다(다른 Host는 421: DNS 리바인딩 차단).
  로그인 쿠키는 `__Host-`·Secure·HttpOnly, 로그인 시도 제한은 데스크의 실제 IP 기준.
- 사무실 CA는 **이름 제한**이 걸려 있어(.local, 이 맥 이름, 사설 IP 대역만) CA 키가 새더라도 은행·포털 같은 공개 사이트를
  데스크에 사칭할 수 없습니다. CA 키(`~/TeamAX/tls/ca.key`, 600)는 맥 밖으로 나가지 않고, 엔진 샌드박스가 접근을 막습니다.

**아직 아닌 것(운영 설치가 더하는 것)**
- 엔진이 **이 맥 사용자 계정으로** 돕니다(샌드박스 안). 운영 설치는 엔진을 별도 계정(`_axagent`)으로 돌려 OS 계정 경계를
  하나 더 두고, **pf 방화벽**으로 엔진의 네트워크를 모델 프록시 하나로 막습니다. 사무실 모드의 엔진은 Anthropic 등
  외부 https(443)에 직접 나갈 수 있습니다(샌드박스가 파일은 막지만 네트워크 목적지는 막지 않음).
- 엔진 계정 분리가 없으므로 같은 사용자의 다른 프로그램(이 맥에서 쓰는 브라우저 등)과 같은 권한입니다.
  그래서 **Team AX 전용 맥, 개인 자료 없음, FileVault 켜기**를 권장합니다.
- 서명·공증된 앱이 아닙니다(설치기가 다운로드 격리 표시를 지웁니다).

## 9. 운영 설치(역할 계정)로 옮기기

운영 설치(`scripts/install-macos.sh`)는 같은 자료 구조를 씁니다: `data/app.db` + `team/` (위치만
`/Library/Application Support/mycel/`). 옮기는 길은 암호화 보관본입니다:

1. 사무실 모드에서 `teamax archive <파일>`.
2. 운영 설치 후 `_axserver`로 `admin.js restore-archive --in <파일> --to <새 폴더> --password-stdin`
   → 그 안의 `db/app.sqlite`를 `data/app.db`로, `team/`을 `team/`으로(서버를 멈춘 상태에서, 소유자 `_axserver`, 700/600).

사무실 모드 → 새 사무실 모드 복원은 시험했습니다(위 5장). 운영 설치로의 복원은 운영 설치에서 채팅이 되기 전(OWNER-TODO 1)이라
아직 시험하지 않았습니다. 운영 설치에는 사무실 CA가 없고 자기 LAN 인증서를 만들므로 데스크는 그때 다시 연결해야 합니다.

## 10. 문제 해결

| 증상 | 할 일 |
|---|---|
| 데스크에서 "연결이 비공개로 설정되어 있지 않습니다" | 인증서를 "신뢰할 수 있는 루트 인증 기관"에 설치했는지, 브라우저를 완전히 닫았다 열었는지. 주소가 `teamax info`에 있는지 |
| 데스크에서 아예 안 열림 | 같은 네트워크인지, `teamax status`, 맥 방화벽 허용, IP가 바뀌지 않았는지(DHCP 예약) |
| 421 "Misdirected request" | 인증서에 없는 이름으로 접속함. `teamax info`의 주소를 쓰세요 |
| 채팅이 "엔진을 쓸 수 없음" | 그 맥에서 `claude auth status`(로그인 만료 시 `claude` → `/login`), `teamax logs` |
| 설치기가 "longer than macOS allows" | 설치 폴더 경로가 너무 김(소켓 경로 104바이트 제한). 기본 `~/TeamAX`를 쓰거나 `--run-dir` |
| 인증서 페이지 포트를 쓰고 싶지 않음 | `office.env`에 `TEAMAX_HELPER_PORT=0` 후 `teamax restart`, `~/TeamAX/tls/ca.cer`를 USB로 나눠 줌 |

## 알려진 한계

- 윈도우 실제 PC에서의 CA 설치·Edge 앱 설치는 이 저장소에서 자동 시험하지 못했습니다. 맥에서 같은 체인을 macOS 신뢰 평가,
  OpenSSL, Node, Chromium(인증서 고정 플래그)으로 확인했고, Chromium에서 PWA 설치 가능(설치 오류 없음)을 확인했습니다.
  CA의 이름 제한은 Chrome/Edge·윈도우·macOS·Firefox가 지원합니다. 만약 어떤 데스크가 인증서를 거부하면
  `~/TeamAX/tls`를 비우고 `office.env`에 `TEAMAX_CA_CONSTRAINTS=0`을 넣고 `teamax restart`(새 CA, 데스크 재설치).
- PDF 글자 추출은 `pdftotext`(Homebrew `poppler`)가 있을 때만 됩니다. docx·pptx는 번들의 pandoc으로 됩니다.
- 공인 IPv6 주소는 인증서에 넣지 않습니다(CA 이름 제한). 데스크는 IPv4나 `.local`을 쓰세요.
- 맥 사용자가 로그아웃하면 멈춥니다(LaunchAgent). 운영 설치는 LaunchDaemon이라 로그인 없이 돕니다.
- 인증서 페이지와 터미널 안내는 한국어·영어만(인도네시아어 없음).
