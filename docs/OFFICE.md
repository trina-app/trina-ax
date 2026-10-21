# 사무실 모드: 치과 설치 가이드 (맥 미니 한 대 + 데스크 PC 10대)

치과·병원·작은 사무실에서 **맥 미니 한 대**가 Team AX를 돌리고, **윈도우 데스크 PC 10대 정도**가 Edge로 접속하는
구성입니다. 중계 서버(`<팀>.treesoop.com`)도, 운영 설치(역할 계정)도 필요 없습니다.

- AI는 **그 맥에 로그인된 Claude Code**(원장님/소유자의 Claude 구독)로 돕니다. 엔진은 개발 모드와 같은 구성입니다:
  권한 함수, 엔진 잠금(lockdown), macOS 샌드박스(`engine.sb`). DEV 배너는 나오지 않고, Codex는 쓰지 않습니다.
- **기본 경로: 인터넷 주소** (예: `https://exampleteam.example.com`). 데스크는 Edge로 이 주소를 열기만 하면 됩니다
  (**인증서 설치 없음**, 사무실 밖·휴대폰에서도). 맥 미니의 `cloudflared`(Cloudflare Tunnel)가 바깥으로 연결을 열어
  두므로 공유기 포트 열기·고정 IP가 필요 없습니다. 자세히: [9장 인터넷 주소](#9-인터넷-주소-cloudflare-tunnel).
- **사무실 안 대체 경로**: `https://<맥 IP>:8443`. 인터넷이 끊겨도 됩니다. 인증서는 맥이 처음 한 번 만드는 **사무실 전용
  인증 기관(CA)**이 서명하고, 이 경로를 쓰는 데스크만 이 CA를 **한 번** 설치합니다.
- 관리자 암호(sudo) 없이 설치됩니다. 모든 것이 `~/TeamAX`에 들어갑니다.
- 같은 내용의 인쇄용 PDF: `Team-AX-치과-설치가이드.pdf`(zip 안, `docs/office/`).

> English summary: one Mac runs Team AX as the signed-in user with that Mac's Claude Code login (dev mode's engine
> setup, no DEV banner, no Codex). Main path: an internet address (`https://app.example.com`) through a Cloudflare
> Tunnel: the bundled cloudflared runs as a second LaunchAgent and delivers it to the loopback app port; desks just
> open it (public certificate, nothing to install). The address is made on the owner's Mac with
> `bun scripts/office/public-address.ts set <name> --cert <cloudflared cert.pem>` and given to the Mac with
> `office-install.sh --public-host <name> --tunnel-token-file <file>` or later `teamax public-address set|off|status`.
> In-office fallback: `https://<mac IP>:8443` after installing the office CA once (thumbprint from the desk card
> printed on the Mac, `teamax card`). The first-run setup is refused over the internet. No sudo, no relay. Bundle:
> `bun run build:office`; control: `~/TeamAX/teamax`.

## 1. 준비물

| | |
|---|---|
| 맥 미니 | macOS 13 이상(Apple Silicon 또는 Intel). **Team AX 전용**으로 두고 개인 자료·다른 프로그램을 두지 마세요 |
| FileVault | 켜 두세요(시스템 설정 → 개인정보 보호 및 보안 → FileVault). 환자 자료가 디스크에 암호화되어 저장됩니다 |
| Claude Code | 맥 미니의 그 사용자 계정에서 설치·로그인되어 있어야 합니다(원장님 구독 계정) |
| 네트워크 | 인터넷 연결(유선 권장). 사무실 안 대체 경로도 쓰려면 공유기에서 맥 미니 주소를 **고정(DHCP 예약)** |
| 인터넷 주소 | 원장님(주인) 맥에서 미리 만든 **연결 토큰 파일**(`exampleteam.example.com.tunnel-token`, [9장 ①·②](#9-인터넷-주소-cloudflare-tunnel)). 공유기 설정은 필요 없음 |
| zip 파일 | `TeamAX-office-0.1.0-mac.zip` (USB·AirDrop로 맥 미니의 `다운로드` 폴더에) |
| 데스크 | 윈도우 10/11 + Edge. 데스크마다 직원 윈도우 계정으로 하면 됩니다(관리자 암호 필요 없음) |
| 그 밖에 | 프린터(데스크 카드 1장), 외장 디스크(주 1회 보관용), 가능하면 UPS |

맥 미니에는 git·Go·Node·Homebrew·GitHub 접근이 **필요 없습니다**. zip 하나에 프로그램이 모두 들어 있습니다.

## 2. 맥 미니 설치 (15분)

맥 미니에서 **AI가 쓸 Claude 로그인이 있는 그 사용자**로 로그인한 뒤, 터미널을 열고 한 줄씩 붙여 넣습니다.

```sh
claude auth status
```
확인: `"loggedIn": true`. 아니면 `claude` 실행 → `/login` → 구독 계정으로 로그인. (Claude Code가 없으면
`curl -fsSL https://claude.ai/install.sh | bash` 후 터미널을 다시 열기.)

연결 토큰 파일(9장)을 AirDrop·USB로 맥 미니의 `다운로드` 폴더에 받아 둔 뒤:

```sh
cd ~/Downloads && ditto -x -k TeamAX-office-0.1.0-mac.zip .
bash ~/Downloads/TeamAX-office-0.1.0/office-install.sh \
  --public-host exampleteam.example.com --tunnel-token-file ~/Downloads/exampleteam.example.com.tunnel-token
rm ~/Downloads/exampleteam.example.com.tunnel-token
```
확인: 마지막에 `=== 설치 끝 / installed: 0.1.0 ===`, 그 위에 `https://exampleteam.example.com 답함 / answers`,
**인터넷 주소**, 사무실 안 대체 경로(**데스크 주소** `https://192.168.x.x:8443`, **인증서 받는 곳**
`http://192.168.x.x:8442`, **인증서 지문**), **첫 설정 링크**가 나오고, 첫 설정 페이지가 맥 미니의 브라우저에 열립니다.
토큰은 `~/TeamAX/config/tunnel-token`(600)에 복사되므로 받은 파일은 지웁니다. 인터넷 주소 없이 설치하려면 두 옵션을
빼면 됩니다(나중에 `teamax public-address set`).

설치기가 하는 일: macOS·프로세서·Claude 로그인·포트·토큰 확인 → `~/TeamAX/app`에 프로그램 복사 → 설정
`~/TeamAX/config/office.env` → LaunchAgent `app.team-ax.office` 시작 → 서버가 답할 때까지 기다림 → 인터넷 주소가 있으면
두 번째 LaunchAgent `app.team-ax.office.tunnel`(번들의 `cloudflared`) 시작 → 주소·지문·링크 출력.
`--check-only`를 붙이면 확인만 하고 아무것도 바꾸지 않습니다. 포트가 다른 프로그램에 잡혀 있으면 설치 전에 멈추고
`--lan-port`·`--app-port`·`--helper-port`로 다른 번호를 고르라고 알려 줍니다.

> **앱 포트(`--app-port`)를 바꿨다면**: Cloudflare 터널도 그 포트를 가리켜야 합니다. 원장님 맥에서
> `bun scripts/office/public-address.ts set exampleteam.example.com --port <새 포트> --cert <cert 파일>`을 한 번 더 실행하세요
> (맥 미니는 다시 할 일이 없음). 안 하면 인터넷 주소가 **502**를 내고, 설치기·`teamax public-address status`가 이 명령을
> 그대로 알려 줍니다. 지금 앱 포트: `teamax public-address status`의 `app port`.

### 이 맥이 꺼지지 않게 (한 번, 관리자 암호 필요)

```sh
sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
```
확인: `pmset -g | grep -E ' sleep|autorestart'` → `sleep 0`, `autorestart 1`. (화면 꺼짐은 괜찮습니다.)

- **방화벽**: macOS 방화벽이 켜져 있으면 "bun이 들어오는 연결을 허용하겠습니까?" → **허용**. 설치기가 방화벽이 켜져 있으면
  미리 허용하는 명령도 보여 줍니다.
- **공유기 DHCP 예약**(사무실 안 대체 경로를 쓸 때): 맥 미니의 IP(설치기가 보여 준 주소)를 공유기 관리 화면에서
  고정합니다. 대체 경로의 Edge 앱과 로그인은 그 IP에 묶여 있어서, IP가 바뀌면 대체 경로를 쓰는 데스크만 다시 로그인하고
  앱을 다시 설치해야 합니다. 인터넷 주소는 맥 미니의 IP와 상관없습니다.

### 데스크 카드 인쇄

```sh
~/TeamAX/teamax card
```
열린 페이지를 인쇄(⌘P)합니다. 카드에는 인증서 받는 곳, **인증서 지문**, 데스크 주소가 있습니다. 이 카드는 맥 미니에서 만든
것이라 네트워크로 바뀔 수 없습니다. 데스크 직원은 인증서를 설치하기 전에 **이 카드의 지문과** 비교합니다.

## 3. 첫 설정 (소유자 계정)

맥 미니에 열린 페이지(`http://localhost:47830/setup?token=…`; 다시 보려면 `~/TeamAX/teamax setup-link`)에서:
(첫 설정은 **맥 미니에서**(또는 사무실 안 대체 경로의 데스크에서)만 됩니다. 인터넷 주소는 첫 설정 전에도 **로그인 화면만**
보여 주고, 설정 요청은 토큰이 맞아도 거부합니다.)

1. **팀 이름**: 예) `OO치과`.
2. **팀 언어**: **한국어** (브라우저가 한국어면 처음부터 한국어로 열립니다). 팀원 화면과 AI 답변의 기본 언어입니다.
3. **소유자 계정**: 원장님 이름, 아이디, 비밀번호(10자 이상, 아이디가 들어가면 안 됨). 이 계정이 팀원·폴더 권한을 관리합니다.

확인: 홈 화면이 열리고 오른쪽 위에 원장님 이름이 보입니다.

그다음 **관리자 → 멤버**에서 데스크마다 **초대 링크**를 만듭니다(메일 발송 없음, 링크 복사). 맥 미니에서 만들면 링크는
인터넷 주소(`https://exampleteam.example.com/invite/…`; 인터넷 주소가 없으면 데스크 주소 `https://192.168.x.x:8443/…`)로
나옵니다. 메신저 등으로 각 데스크에 전달합니다.
초대 대신 **직접 추가**(임시 비밀번호, 첫 로그인 때 바꾸기)도 됩니다.

## 4. 데스크 PC 10대 연결 (PC마다 2분)

### 기본: 인터넷 주소

1. Edge에서 `https://exampleteam.example.com` (카드 맨 위의 인터넷 주소). 확인: 경고 없이 자물쇠, 로그인 화면.
2. Edge 오른쪽 위 **⋯ → 앱 → 이 사이트를 앱으로 설치** → 설치.
3. 받은 초대 링크를 Edge에서 열어 가입. 확인: 채팅에서 "안녕하세요"를 보내면 답이 옵니다.

인증서 설치는 필요 없습니다(Cloudflare의 공인 인증서). 집·휴대폰에서도 같은 주소입니다.

### 사무실 안 대체 경로 (인터넷이 끊겼을 때)

인터넷이 끊겨도 쓰려는 데스크만 아래를 한 번 해 둡니다. 로그인은 주소마다 따로입니다(앱도 주소마다 하나).

### ① 인증서 설치 (처음 한 번)

1. Edge 주소창에 카드의 **인증서 받는 곳**을 `http://`까지 그대로 입력: `http://192.168.x.x:8442`
   (Edge가 https로 바꿔 열려다 실패하면 `http://`를 다시 확인하세요.)
2. **윈도우용 인증서 받기(.cer)**. Edge가 "안전하게 다운로드할 수 없습니다"라고 하면 **⋯ → 유지**(이 페이지가 http라서
   나오는 안내입니다).
3. 받은 파일을 엽니다 → 인증서 창 **자세히** 탭 → **지문**. 값이 **카드의 지문과 같은지** 확인합니다(대소문자·띄어쓰기 무시,
   적어도 앞 8자리와 끝 8자리). **다르면 설치하지 말고** 원장님께 알립니다.
4. **일반** 탭 → **인증서 설치…** → **현재 사용자** → 다음 → **모든 인증서를 다음 저장소에 저장** → 찾아보기 →
   **신뢰할 수 있는 루트 인증 기관** → 확인 → 다음 → 마침.
5. "보안 경고" 창의 지문이 카드와 같으면 **예**.

더 안전한 방법: 맥 미니의 `~/TeamAX/tls/ca.cer`를 **USB**로 복사해 데스크에서 바로 열면 1~2단계가 필요 없습니다(네트워크를
거치지 않음). 3~5단계는 같습니다. 한 PC를 여러 윈도우 계정이 쓰면 계정마다 4~5단계를 하거나, PC 관리자가 4단계에서
**로컬 컴퓨터**를 고릅니다(이때는 보안 경고 창이 나오지 않으므로 3단계 확인이 꼭 필요합니다).

### ② Edge 주소

Edge를 **모두 닫았다가** 다시 열고 카드의 데스크 주소 `https://192.168.x.x:8443`. 확인: 주소창에 경고 없이 자물쇠가
보이고 로그인 화면이 나옵니다.

### ③ 앱으로 설치

Edge 오른쪽 위 **⋯ → 앱 → 이 사이트를 앱으로 설치** → 설치. 바탕화면·작업 표시줄에 Team AX 아이콘이 생기고 별도 창으로
열립니다. (Chrome: ⋮ → 전송, 저장, 공유 → 페이지를 앱으로 설치)

### ④ 초대 링크로 가입

받은 초대 링크를 Edge에서 엽니다 → 이름·아이디·비밀번호 → 가입. 다음부터는 바탕화면 아이콘으로 열고 로그인합니다.
확인: 채팅에서 "안녕하세요"를 보내면 답이 옵니다.

데스크 직원용 안내(인쇄용): `Team-AX-윈도우-데스크-가이드.pdf`(zip 안, `docs/office/windows-guide.html`): Edge 앱 설치,
데스크톱 앱, 문제 해결(530, 로그인, 비밀번호 재설정 링크, 캐시), 하지 말 것. 데스크는 **Edge 앱이 기본**이고, 데스크톱 앱
(`Team-AX-Setup-<버전>-x64.exe`)은 AI가 웹사이트를 직접 열어야 하는 자리에만 설치합니다([부록 C](#부록-c-윈도우-데스크톱-앱-키트)).

## 5. 매일 운영

**꺼지지 않게**
- Team AX는 맥 미니 사용자가 **로그인해 있는 동안** 돌고, 멈추면 스스로 다시 켜집니다. 화면이 잠겨 있어도 됩니다.
  **로그아웃하지 마세요.**
- 정전·재시동 뒤: FileVault가 켜져 있으면 맥 미니 앞에서 **암호를 한 번** 입력해야 합니다(그러면 Team AX가 스스로 켜집니다).
  FileVault와 자동 로그인은 함께 쓸 수 없습니다. 환자 자료가 있으므로 FileVault + 암호 한 번을 권장합니다.
- 상태 보기: `~/TeamAX/teamax status` (확인: `running`, 주소마다 `answers`).

**백업**
- **매일 밤 자동 백업**(14일 보관)이 맥 미니 디스크에 생깁니다: `~/TeamAX/data/backups/`(DB)와
  `~/TeamAX/team/.system/backups/`(팀 폴더). 관리자 → 시스템 → 백업에서 보고 "지금 백업"을 누를 수 있습니다.
  터미널: `~/TeamAX/teamax backup`.
- **맥 미니가 고장·도난되면 같은 디스크의 백업도 사라집니다.** 그래서 외장 디스크에 하나 더 둡니다:
  1. **Time Machine (권장, 자동)**: 외장 디스크를 꽂고 시스템 설정 → 일반 → Time Machine → 백업 디스크 추가 →
     **백업 암호화** 켜기. `~/TeamAX` 전체(인증서 포함)가 매시간 백업됩니다.
  2. **암호화 보관본 (주 1회, 다른 맥으로 옮길 때도 이것)**:
     ```sh
     ~/TeamAX/teamax archive /Volumes/<디스크 이름>/teamax-$(date +%F).age
     ```
     암호(8자 이상)를 두 번 묻습니다. 확인: `보관본을 만들었습니다 … 암호화됨`. 암호를 잊으면 열 수 없습니다.

## 6. 업데이트

새 zip을 맥 미니에 풀고 같은 명령을 다시 실행합니다:
```sh
cd ~/Downloads && ditto -x -k TeamAX-office-<새 버전>-mac.zip .
bash ~/Downloads/TeamAX-office-<새 버전>/office-install.sh
```
`app/`만 바뀌고(이전 것은 `app.previous`) 데이터·팀 폴더·인증서·설정은 그대로입니다. 데스크는 할 일이 없습니다
(로그인도 유지). 확인: `팀이 이미 설정되어 있습니다`, `=== 설치 끝 / installed: <새 버전> ===`.

## 7. 문제 해결

| 증상 | 할 일 |
|---|---|
| 인터넷 주소: Cloudflare 오류 **530 / 1033** | 터널에 연결된 맥 미니가 없음: 맥 미니가 꺼졌거나, 로그아웃했거나, 인터넷이 끊김(또는 토큰이 다른 터널 것). 맥 미니에서 `teamax public-address status`(`cloudflared running`), `teamax logs`(끝에 `tunnel.log`) |
| 인터넷 주소: Cloudflare 오류 **502** | 터널은 연결됐지만 맥 미니의 앱 포트가 아닌 곳을 가리킴(설치 때 `--app-port`를 바꾼 경우) 또는 Team AX 서버가 멈춤. `teamax public-address status`가 알려 주는 대로: 원장님 맥에서 `public-address.ts set <이름> --port <app port>`; 서버가 멈췄으면 `teamax restart` |
| 인터넷 주소: 403 "not open to your network" | 허용 목록(`TEAMAX_PUBLIC_ALLOW_FROM`·`TEAMAX_PUBLIC_COUNTRIES`, 9장)에 그 네트워크가 없음 |
| 첫 설정 "인터넷 주소에서 할 수 없습니다" | 정상. 맥 미니에서 `teamax setup-link`의 `http://localhost…` 링크로 |
| 데스크: "연결이 비공개로 설정되어 있지 않습니다" | 인증서를 **신뢰할 수 있는 루트 인증 기관**에 넣었는지, Edge를 모두 닫았다 열었는지, 카드의 주소인지 |
| 데스크: 아예 안 열림 | 같은 네트워크인지, 맥 미니에서 `teamax status`, 맥 방화벽에서 bun 허용, IP가 바뀌지 않았는지(`teamax info`) |
| 403 "office network" | 다른 네트워크(VPN·게스트 Wi-Fi)에서 접속함. 맥 미니와 같은 사무실 네트워크에서 |
| 421 "Misdirected request" | 카드에 없는 주소·이름으로 접속함. `teamax info`의 주소를 쓰세요 |
| 지문이 카드와 다름 | 설치하지 말고 USB로 `ca.cer`를 옮겨 설치. 누군가 네트워크에서 바꿔치기했을 수 있습니다 |
| 채팅이 "엔진을 쓸 수 없음" | 맥 미니에서 `claude auth status`(만료 시 `claude` → `/login`), `teamax logs`(서버 로그 포함) |
| 비밀번호 잊음 | 팀원: 관리자 → 멤버 → 재설정 링크. 원장님: 맥 미니에서 `~/TeamAX/teamax reset-link` |
| 공유기를 바꿔 주소 대역이 달라짐 (예: 192.168.0.x → 192.168.1.x) | 인증서가 새 대역을 이름에 넣지 못합니다. `teamax stop` → `mv ~/TeamAX/tls ~/TeamAX/tls.old` → `teamax start` → 새 카드 인쇄 → 데스크마다 인증서 다시 설치 |
| 포트가 이미 쓰이는 중 | 설치기의 안내대로 `--lan-port 9443` 등 다른 번호 |

명령 모음(`~/TeamAX/teamax …`): `status`, `info`(주소·지문, `~/TeamAX/ADDRESSES.txt`와 같음), `card`, `logs [n]`,
`start` / `stop` / `restart`, `setup-link`, `reset-link [--username U]`, `backup`, `archive <파일>`,
`restore-archive <파일> [--replace]`, `public-address set <이름> <토큰 파일>` / `off` / `status`. 설정은 `~/TeamAX/config/office.env`를 고친 뒤 `teamax restart`
(`config/server.json`은 시작마다 다시 쓰이므로 고치지 마세요). 제거: `bash office-uninstall.sh`(데이터는 남김,
`--delete-data`는 전부 지움).

## 8. 보안 메모

**인터넷 주소를 열었을 때 (꼭 읽기)**
- 로그인 화면이 **인터넷 전체에** 보입니다. 원장님·관리자 비밀번호는 **길고 다른 곳에 쓰지 않는 것**(예: 단어 4개 + 숫자,
  16자 이상)으로 정하세요. 팀원도 10자 이상(서버가 강제)이며, 퇴사자는 바로 **관리자 → 멤버 → 비활성**.
- **2단계 인증(2FA)은 아직 없습니다.** 대신 로그인 시도 제한이 **접속한 사람의 실제 IP**(Cloudflare가 알려 주는
  `CF-Connecting-IP`) 기준과 계정 기준(15분에 10번)으로 걸립니다. 로그인·실패·제한은 **관리자 → 기록**에 줄마다 IP와 함께
  남고, 인터넷 주소로 들어온 것은 **인터넷** 표시가 붙습니다(줄을 누르면 전체 내용). 초대·재설정 링크를 맞혀 보는 시도도
  IP별로 막힙니다.
- 인터넷에는 버전을 알려 주지 않습니다(`/api/health`는 로그인 전엔 `ok`와 시각만).
- **첫 설정(소유자 계정 만들기)은 인터넷 주소로 할 수 없습니다**(맥 미니 또는 사무실 안 데스크만). 설치 직후 누군가
  먼저 소유자가 되는 일이 없습니다.
- 인터넷 주소는 https만입니다(http는 https로 보냄, HSTS). 로그인 쿠키는 `__Host-`·Secure·HttpOnly, 다른 사이트에서 온
  요청(Origin이 다른 것)은 403입니다. 맥 미니의 앱 포트는 그대로 `127.0.0.1`에만 열려 있고, 들어오는 포트를 공유기에서
  열지 않습니다(cloudflared가 바깥으로 연결).
- 환자 자료가 **Cloudflare를 거쳐** 갑니다(Cloudflare가 TLS를 끝내고 맥 미니까지는 터널 안). 이것이 안 되는 자료라면
  인터넷 주소를 끄고(`teamax public-address off`) 사무실 안 경로만 쓰세요.
- 더 좁히려면 `~/TeamAX/config/office.env`에 `TEAMAX_PUBLIC_COUNTRIES=KR`(한국에서만) 또는
  `TEAMAX_PUBLIC_ALLOW_FROM=<치과 공인 IP>/32`(IPv4만; 이때 IPv6 손님은 거부) → `teamax restart`. 기본은 꺼짐.
- (선택, Cloudflare 대시보드) http 요청은 지금도 서버가 https로 돌려보내지만, Cloudflare에서 먼저 막으면 더 좋습니다.
  존 전체 설정인 "Always Use HTTPS"는 **꼭대기 웹사이트에도 적용**되므로, 그 이름만 대상으로 **Rules → Redirect Rules**
  (호스트 = 그 이름, http → https)와 **Security → WAF → Rate limiting**(경로 `/api/auth/login`, IP당 분당 10번 정도)을
  만드세요. 둘 다 다른 이름·꼭대기에는 영향이 없습니다. 스크립트는 존 설정을 바꾸지 않습니다.

**사무실 모드가 지키는 것**
- 폴더 권한과 채팅 비공개는 운영 모드와 **같은 권한 함수**가 모든 파일 접근(AI 도구 포함)에서 판단합니다. AI는 질문한
  사람이 볼 수 있는 파일만 봅니다([PERMISSIONS.md](PERMISSIONS.md)).
- **엔진 잠금**: Claude Code 자체 도구(셸·파일·웹)는 꺼져 있고 Team AX 도구만 씁니다. **macOS 샌드박스**(`engine.sb`)가
  엔진이 그 채팅 폴더 밖(`/Users`, 다른 채팅, 서버 데이터, 인증서 키)을 못 읽게 막습니다.
- 데이터(DB, 팀 폴더, 백업)는 **치과의 그 맥 미니에만** 있습니다. 중계 서버를 거치지 않습니다.
- **환자 자료는 AI에게 묻는 요청의 일부로만 Anthropic(Claude)에 전송됩니다**: 질문 내용과 AI가 그 질문에 답하려고 읽은
  파일 내용. 다른 AI 회사(Codex 등)는 사무실 모드에서 쓰지 않습니다.
- 사무실 네트워크에는 **https만** 열리고, **맥 미니와 같은 사무실 대역**(예: 192.168.1.0/24)에서 온 연결만 받습니다(VPN·다른
  대역은 403). 평문 앱 포트는 맥 미니 안(`127.0.0.1`)에서만. 인증서 페이지(8442)는 인증서와 안내만 주고 API가 없습니다.
  서버는 자기 주소로 온 요청만 받습니다(다른 Host는 421). 로그인 쿠키는 `__Host-`·Secure·HttpOnly, 로그인 시도 제한은
  데스크의 실제 IP 기준.
- 사무실 CA는 **이름 제한**이 걸려 있어 **이 맥 미니의 이름과 사무실 대역의 주소만** 보증할 수 있습니다. CA 키가 새더라도
  은행·포털, 다른 `.local` 기기, 다른 대역의 차트 서버·NAS·공유기를 데스크에 사칭할 수 없습니다. CA 키(`tls/ca.key`, 600)는
  맥 밖으로 나가지 않습니다.
- 인증서 페이지는 평문 http라서 **지문을 보여 주지 않습니다**. 데스크는 맥 미니에서 인쇄한 카드와 비교합니다(또는 USB).

**운영 설치가 나중에 더하는 것**
- 엔진이 **별도 계정**(`_axagent`)으로 돌아 OS 계정 경계가 하나 더 생기고, **pf 방화벽**이 엔진의 네트워크를 모델 프록시 하나로
  막습니다. 사무실 모드의 엔진은 맥 미니 사용자 계정으로 돌고(샌드박스 안), 외부 https에 직접 나갈 수 있습니다.
- 그래서 지금은 **Team AX 전용 맥 미니, 개인 자료 없음, FileVault 켜기, 맥 미니 사용자 암호는 원장님만**을 권장합니다.
- 서명·공증된 앱이 아닙니다(설치기가 다운로드 격리 표시를 지웁니다).

## 9. 인터넷 주소 (Cloudflare Tunnel)

구성: 데스크 → `https://<이름>` → Cloudflare(공인 인증서) → 터널 → 맥 미니의 `cloudflared`(LaunchAgent
`app.team-ax.office.tunnel`) → `http://127.0.0.1:47830`(앱 포트). 서버는 이 길로 온 요청만(앱 포트 + 루프백 + Host가 그
이름) https로 다루고, 손님 IP를 `CF-Connecting-IP`에서 읽습니다. 그 밖의 경로에서는 그 헤더를 무시합니다.

### ① 원장님 맥에서 처음 한 번 준비

맥 미니가 아니라 **Cloudflare 계정에 로그인할 수 있는 원장님(주인) 맥**에서 합니다. 필요한 것: Bun, 이 저장소, 그 도메인의
Cloudflare 자격 증명 하나.

```sh
gh repo clone potenlab/team-ax ~/team-ax && cd ~/team-ax && bun install   # 이미 있으면: git pull && bun install
```

자격 증명은 둘 중 하나:
- **cloudflared 인증서(cert.pem)**: `brew install cloudflared` → `cloudflared tunnel login` → 브라우저에서 그 도메인
  (`example.com`)을 고름 → `~/.cloudflared/cert.pem`이 생김. 알아보기 쉽게
  `mv ~/.cloudflared/cert.pem ~/.cloudflared/cert-dentist-almanac.pem`. (이미 `cert.pem`이 있으면 `tunnel login`이
  거부하므로 먼저 그 파일 이름을 바꿔 두세요. 도메인마다 cert 파일이 하나씩입니다.)
- **API 토큰**: Cloudflare 대시보드 → My Profile → API Tokens → Create Token → Custom: **Zone · DNS · Edit**(그 존만) +
  **Account · Cloudflare Tunnel · Edit**. 토큰 한 줄을 파일에 저장(`chmod 600`)하고 `--cert` 대신 `--api-token-file <파일>`.

### ② 주소와 연결 토큰 만들기

```sh
cd ~/team-ax
bun scripts/office/public-address.ts set exampleteam.example.com --cert ~/.cloudflared/cert-dentist-almanac.pem
```
확인: 마지막에 `https://exampleteam.example.com → tunnel … → http://127.0.0.1:47830`, `connector token: …(600; not
shown)`. 맥 미니를 `--app-port`로 다른 포트에 설치했다면 `--port <그 포트>`를 붙입니다.
- 그 이름의 존을 찾고, **존 꼭대기(`example.com`)는 거부**(`--allow-apex`가 없으면), 그 이름에 터널 CNAME이 아닌
  기록(웹사이트·메일 등)이 하나라도 있으면 **아무것도 바꾸지 않고 거부**합니다. 다른 이름·기록은 건드리지 않습니다.
- 그 이름이 가리키는 터널이 있으면 다시 쓰고, 없으면 `teamax-<이름>` 터널을 만듭니다(설정이 Cloudflare에 있는 원격 관리형).
  터널 설정: 그 이름 → `http://127.0.0.1:47830`(Host 헤더 = 그 이름), 마지막은 `http_status:404`.
- 그 이름의 **프록시 CNAME 하나만** 만들거나 고칩니다. 연결 토큰을 `~/.config/teamax-office/<이름>.tunnel-token`(600,
  `--token-out`으로 바꿈)에 씁니다. 토큰은 화면·로그에 나오지 않습니다.
- 자격 증명: `--cert`(cloudflared `cert.pem`, 한 존용 API 토큰이 들어 있음) 또는 `--api-token-file`(Zone:DNS:Edit +
  Account:Cloudflare Tunnel:Edit 권한의 API 토큰 한 줄). `--dry-run`은 할 일만 보여 줍니다. `status <이름>`은 기록·터널·연결 수.

### ③ 맥 미니에 넣기

토큰 파일을 AirDrop·USB로 옮긴 뒤 설치기에 `--public-host <이름> --tunnel-token-file <파일>`(2장),
또는 이미 설치된 맥 미니에서:
```sh
~/TeamAX/teamax public-address set exampleteam.example.com ~/Downloads/exampleteam.example.com.tunnel-token
rm ~/Downloads/exampleteam.example.com.tunnel-token
```
확인: `인터넷 주소가 답합니다 / the internet address answers`. `teamax public-address status`: `answers`, 터널 id,
`cloudflared running`, `app port`. 서버가 새 이름을 쓰도록 한 번 다시 켜집니다(몇 초). 답이 없으면 명령이 실패(종료 코드 1)로
끝나고 이유(502: 포트, 530: 연결 없음)와 고칠 명령을 보여 줍니다.

### ④ 주소 바꾸기 (명령 두 개)

예: `exampleteam.example.com` → `teamax.새도메인.com` (새 도메인이면 ①처럼 그 도메인의 cert.pem부터)
1. 원장님 맥: `bun scripts/office/public-address.ts set teamax.새도메인.com --cert <그 도메인의 cert.pem>`
   (앱 포트를 바꿨다면 `--port <포트>`)
2. 맥 미니: 토큰 파일을 옮기고 `~/TeamAX/teamax public-address set teamax.새도메인.com <토큰 파일>` → 받은 파일 `rm`

그다음:
- **데스크 카드 다시 인쇄**: 맥 미니에서 `~/TeamAX/teamax card`.
- **데스크마다** (로그인·앱은 주소마다 따로): 옛 앱 제거(Edge **⋯ → 앱 → 앱 관리** → 옛 Team AX → **제거**; 남겨 두면 오류
  530만 보이는 "Team AX"와 새 "Team AX 1"이 함께 생김) → 새 주소를 Edge로 열어 **앱으로 설치** → 다시 로그인. 채팅·파일은
  그대로입니다.
- **아직 안 쓴 초대·재설정 링크**는 옛 주소로 만들어졌습니다. 관리자 → 멤버에서 새로 만들거나, 링크의 주소 부분만 새 주소로
  바꿔 보내도 됩니다(`/invite/…` 뒷부분은 그대로 유효).
- 옛 이름 정리(원장님 맥):
  `bun scripts/office/public-address.ts remove exampleteam.example.com --cert ~/.cloudflared/cert-dentist-almanac.pem`
  (그 이름의 CNAME과, 다른 이름이 쓰지 않으면 그 터널과 토큰 파일을 지움. 터널 CNAME이 아닌 기록은 지우지 않음.
  `--keep-tunnel`이면 터널은 남기고 그 이름의 규칙만 뺌. 어느 쪽이든 계정의 다른 원격 관리 터널에 그 이름의 규칙이 남아
  있으면 함께 뺌. `set`도 이름을 다른 터널로 옮길 때 옛 터널의 그 이름 규칙을 뺌: 이름 하나는 터널 하나에만.)

### ⑤ 끄기

맥 미니에서 `~/TeamAX/teamax public-address off`(cloudflared 멈춤, 토큰 지움, 사무실 안 경로는 그대로; 원장님 맥에서 할
`remove` 명령을 그 이름으로 보여 줌), 그다음 원장님 맥에서 그 `remove`. 업데이트(새 zip)는 인터넷 주소 설정과 토큰을 그대로
둡니다.

**한도**: 요청 하나는 Cloudflare 무료 요금제의 100 MB를 넘지 않습니다. 50 MB가 넘는 파일은 웹 앱이 8 MB 조각으로 올립니다
(120 MB 시험 통과). Cloudflare는 100초 동안 답이 없는 요청을 끊지만, 긴 작업은 이미 작업(job)과 WebSocket으로 갑니다.

## 부록 A. 번들 만들기 (개발 맥에서)

```sh
bun install
bun run build:office        # = ARCHS="arm64 amd64" bash native/build.sh && web 빌드 && bun scripts/build-office.ts
# → dist/office/TeamAX-office-<버전>-mac.zip  (약 170 MB)
bun docs/install/build-pdf.ts --office   # docs/office/Team-AX-치과-설치가이드.pdf (zip에 함께 들어감)
# 데스크톱 앱 설치 파일도 zip 옆에: --with-desktop (desktop dist:win + dist:mac을 빌드) 또는 --desktop-prebuilt (desktop/release에 있는 것)
TEAMAX_KIT_TEAM=exampleteam.example.com TEAMAX_KIT_LOCALE=ko bun scripts/build-office.ts --with-desktop
# → dist/office/Team-AX-Setup-<버전>-x64.exe, dist/office/Team-AX-<버전>-mac-universal.dmg
```
bun·ripgrep·pandoc·cloudflared(2026.10.0, Cloudflare 서명)는 GitHub 릴리스에서 버전과 SHA-256을 고정해 받습니다(`scripts/build-office.ts`의 `DOWNLOADS`,
`dist/cache/`에 보관). zip에는 이 문서(`app/docs/OFFICE.md`)와 PDF가 들어갑니다.

## 부록 B. 운영 설치(역할 계정)로 옮기기

운영 설치(`scripts/install-macos.sh`)도 같은 자료 구조를 씁니다: `data/app.db` + `team/`. 옮기는 길은 암호화 보관본입니다:

1. 사무실 모드에서 `teamax archive <파일>`.
2. 운영 설치에서 `_axserver`로 `admin.js restore-archive --in <파일> --to <새 폴더> --password-stdin`
   → 그 안의 `db/app.sqlite`를 `data/app.db`로, `team/`을 `team/`으로(서버를 멈춘 상태에서, 소유자 `_axserver`).

사무실 모드 보관본 → 새로 설치한 사무실 모드 복원은 시험했습니다(팀원 로그인·파일 확인). 운영 설치로의 복원은 아직 시험하지
않았습니다(OWNER-TODO). 운영 설치는 자기 LAN 인증서를 쓰므로 데스크는 그때 다시 연결해야 합니다. 새 맥으로 옮길 때도
보관본에는 CA가 없으므로 데스크는 새 인증서를 설치합니다(같은 CA를 쓰려면 `~/TeamAX/tls/`를 따로 옮기세요).

## 부록 C. 윈도우 데스크톱 앱 (키트)

데스크 대부분은 Edge 앱이면 됩니다. AI가 웹사이트를 직접 열어 읽고 클릭해야 하는 자리만 데스크톱 앱을 씁니다(앱 안
브라우저 창, 사이트마다 묻기). 그 치과용 설치 파일은 개발 맥에서 만듭니다(맥에서 윈도우용으로 빌드됨, wine 필요 없음):

```sh
cd desktop
TEAMAX_KIT_TEAM=exampleteam.example.com TEAMAX_KIT_LOCALE=ko bun run dist:win
# → desktop/release/Team-AX-Setup-<버전>-win-x64.exe (약 110 MB)
```

- `TEAMAX_KIT_TEAM`: 첫 화면 "팀 주소를 입력하세요"에 그 주소가 **미리 채워집니다**(직원은 `연결`만). 제안일 뿐이라 같은
  검사(https, `/api/health`)를 거치고, 저장된 팀이 있으면 나오지 않습니다. `TEAMAX_KIT_LOCALE=ko`: 팀 화면이 언어를
  알려 주기 전(첫 화면·메뉴)부터 한국어. 둘 다 `dist/kit.json`으로 앱 안에 들어갑니다(`desktop/src/common/kit.ts`). 빼면
  일반 설치 파일(빈 주소, 영어로 시작).
- 설치 파일은 **사용자별 원클릭 NSIS**(`%LOCALAPPDATA%\Programs`, 관리자 암호·UAC 없음, 바탕 화면·시작 메뉴 바로 가기, 설치
  뒤 바로 실행)입니다. **서명이 없어** SmartScreen "Windows의 PC 보호" → `추가 정보` → `실행`이 필요합니다.
- 주소는 `exampleteam.example.com` 그대로 또는 `https://`를 붙여 입력해도 됩니다. 맥 미니가 꺼져 Cloudflare가 530을 내면
  "팀 서버에 연결할 수 없어요"로 나옵니다(주소가 틀렸다는 뜻이 아님).

### 설정 → 앱에서 내려받게 하기

팀원은 **설정 → 앱 → 데스크톱 앱**에서 설치 파일을 내려받습니다(로그인한 사람만, 이 컴퓨터용이 맨 위, 윈도우는
SmartScreen `추가 정보 → 실행`, 맥은 `시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기` 안내가 함께 나옴). "아직 팀
서버에 올라온 데스크톱 앱이 없어요"가 나오면 맥 미니에 설치 파일이 아직 없는 것입니다. 올리는 길은 둘입니다:

- **설치할 때 자동으로**: `Team-AX-Setup-<버전>-x64.exe`(윈도우)·`Team-AX-<버전>-mac-universal.dmg`(맥)를 office zip과 같은
  폴더(보통 `~/Downloads`)에 두고 `office-install.sh`를 실행(또는 다시 실행)하면, 압축을 푼 폴더와 그 옆에서 찾아 플랫폼마다
  가장 새 버전을 올리고 무엇을 올렸는지 출력합니다(`--no-desktop`으로 끔, `--check-only`는 실제 실행과 같은 판단으로 올릴
  파일만 보여 줌). zip 옆이 아닌 `~/Downloads`는 그 플랫폼 파일이 zip 옆에 없을 때만 보고, **물어본 뒤에만** 올립니다(예전
  파일이나 엉뚱한 파일이 모두가 받는 앱이 되지 않게). `--with-desktop`으로 만든 zip에는 `desktop.sha256`이 들어 있어, 그때는
  목록의 파일(이름과 SHA-256이 같은 것)만 올리고 나머지는 건너뛴다고 알려 줍니다.
- **명령으로**:
  ```sh
  ~/TeamAX/teamax desktop add ~/Downloads/Team-AX-Setup-0.1.0-x64.exe   # 검사 → data/downloads에 복사 → 목록 갱신
  ~/TeamAX/teamax desktop list                                           # 올라간 것 (버전, 크기, 서명 여부)
  ~/TeamAX/teamax desktop remove Team-AX-Setup-0.1.0-x64.exe
  ```
  `.exe`는 NSIS 설치 파일인지, `.dmg`는 디스크 이미지인지, 그리고 **끝까지 다 있는지**(설치 파일 머리에 적힌 길이와 비교:
  복사·내려받기가 중간에 끊긴 파일은 거절) 확인하고 받습니다. 버전은 파일 이름에서 읽고, 이름에 없으면 `--version 0.2.0`.
  같은 플랫폼의 이전 버전은 지워집니다(둘 다 두려면 `--keep`). 서버를 다시 시작할 필요는 없습니다. 파일은
  `~/TeamAX/data/downloads/`(폴더 700, 파일 600)에 있고 `index.json`이 목록입니다. 서버는 **목록에 있는 파일만** 내줍니다
  (폴더에 다른 파일·링크가 있어도 안 보임).
- **서명**: `서명 확인됨`은 실제 검사가 통과했을 때만입니다(윈도우: `osslsigncode verify`, 맥: Gatekeeper
  `spctl -a -t open --context context:primary-signature`). 인증서가 붙어 있기만 하거나 ad-hoc 서명인 파일은 `서명 있음(확인 안
  됨)`이고, 설정 → 앱은 SmartScreen·Gatekeeper 단계를 계속 보여 줍니다. 지금 빌드는 서명하지 않으므로 `서명 없음`.
- **맥 dmg**: `-mac-universal.dmg`(인텔·애플 실리콘 모두)를 올리세요. `-mac-arm64.dmg`를 올리면 설정 → 앱에 "Apple Silicon(M1
  이후) 맥 전용"이 붙고, 같은 버전이면 universal이 우선입니다.

개발 맥에서 zip과 설치 파일을 함께 만들려면 `bun scripts/build-office.ts --with-desktop`(부록 A): 설치 파일은 zip 안이 아니라
**zip 옆** `dist/office/`에 놓입니다(각 110–200 MB). 세 파일을 같은 폴더로 보내면 됩니다. 내려받기는 Cloudflare 인터넷 주소로도
되고(이어받기 가능), Cloudflare가 복사본을 저장하지 않습니다(`Cache-Control: private`, `Vary: Cookie, Authorization`).
**Cloudflare 대시보드에서 이 이름에 "Cache Everything"·Edge Cache TTL 같은 캐시 규칙을 걸지 마세요**: 그런 규칙은 `private`를
무시하고 `.exe`/`.dmg`를 확장자로 캐시해 로그인 없이 내줄 수 있습니다. 영역 전체에 캐시 규칙이 꼭 필요하면 `/downloads/*`를
우회(Bypass cache)하는 Cache Rule을 먼저 두세요.

## 알려진 한계

- **윈도우 실제 PC에서의 인증서 설치·Edge 앱 설치는 시험하지 못했습니다.** 같은 인증서 체인을 macOS 신뢰 평가, OpenSSL,
  Node, Linux Chromium(CA를 신뢰 목록에 넣고, 인증서 고정 없이: 보안 연결·서비스 워커·PWA 설치 가능)으로 확인했습니다.
  첫 데스크에서 위 4장을 따라 해 보고 나머지 9대를 진행하세요. 어떤 데스크가 인증서를 거부하면 `~/TeamAX/tls`를 옮겨 두고
  `office.env`에 `TEAMAX_CA_CONSTRAINTS=0`, `teamax restart`(새 CA, 이름 제한 없음, 데스크 재설치).
- IPv4만 씁니다(IPv6 주소는 인증서·접속 대상에 넣지 않음). VPN(Tailscale 등) 주소도 빼며, 필요하면 `TEAMAX_INCLUDE_VPN=1`과
  `TEAMAX_ALLOW_FROM=<CIDR,…>`(또는 `any`).
- 맥 이름을 바꾸면 `.local` 주소가 인증서에서 빠집니다(IP 주소는 계속 됨). 이름까지 쓰려면 위 "주소 대역" 항목처럼 새 CA.
- PDF 글자 추출은 `pdftotext`(Homebrew `poppler`)가 있을 때만 됩니다. docx·pptx는 번들의 pandoc으로 됩니다.
- 맥 사용자가 로그아웃하면 멈춥니다(LaunchAgent, cloudflared도). 운영 설치는 LaunchDaemon이라 로그인 없이 돕니다.
- 인터넷 주소: 2FA 없음(8장). 허용 목록은 IPv4 CIDR과 나라(`CF-IPCountry`)만, 사람별 허용(Cloudflare Access 등)은 나중.
  같은 맥의 다른 프로그램은 앱 포트에 그 이름으로 요청해 IP를 꾸밀 수 있습니다(계정별 로그인 제한은 그대로). 그래서 인터넷
  주소로 온 기록의 IP는 그 맥의 다른 프로그램만큼만 믿을 수 있습니다: 맥 미니에 다른 사용자 계정·프로그램을 두지 마세요.
- 실제 윈도우 PC·Edge로 인터넷 주소 앱 설치는 아직 확인하지 않았습니다(공인 인증서라 일반 웹사이트와 같음).
- 윈도우 데스크톱 앱(부록 C)은 맥에서 교차 빌드만 했고 실제 윈도우 PC에서 설치·실행해 보지 않았습니다. 서명이 없어
  SmartScreen 경고가 나오고, 회사 정책이 서명 없는 프로그램을 막는 PC에서는 쓸 수 없습니다(그 자리는 Edge 앱).
