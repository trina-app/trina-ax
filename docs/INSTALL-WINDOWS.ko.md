# 윈도우 PC에 설치하기 (WSL2)

[English](INSTALL-WINDOWS.md) · [리눅스 서버](INSTALL-LINUX.md) · [IT 점검표](for-admins.ko.md)

늘 켜 두는 윈도우 PC 한 대를 팀 서버로 쓸 수 있습니다. 윈도우가 PC 안에서 작은 데비안 리눅스(WSL2, Windows
Subsystem for Linux)를 돌리고, 그 리눅스 안에서 일반 [리눅스 서버](INSTALL-LINUX.md)가 돌아갑니다. 스크립트 하나가
전부 설정합니다. 리눅스 장비에 설치한 서버와 같은 서버이고, 업데이트, 백업, AI 샌드박스도 같습니다. 스크립트는
리눅스를 윈도우와 떼어 놓기도 합니다. 리눅스에서 윈도우 프로그램을 실행할 수 없고, PC의 드라이브도 리눅스에서 보이지
않습니다([스크립트가 리눅스에서 바꾸는 것](#스크립트가-리눅스에서-바꾸는-것) 참고).

새로 나온 방식입니다. 리눅스 서버(0.20.2)를 메모리 8 GB인 윈도우 11 PC에 손으로 설치해 동작을 확인했습니다(2026-11-27:
설치, AI 샌드박스, 문서, 실제 AI 답변). **스크립트 자체는 아직 윈도우에서 실행해 보지 않았습니다.** 곧 QA에서 실행하고,
그때 이 줄을 고칩니다. 전용 리눅스 서버나 VM이 있는 팀이라면 그쪽이 여전히 먼저입니다.

## 한눈에 보는 순서

1. [요구 사항](#요구-사항)을 확인합니다.
2. 서버를 맡을 윈도우 계정(관리자 계정)으로 윈도우에 로그인합니다.
3. [설치 스크립트를 실행](#설치-스크립트-실행)합니다. 처음에는 윈도우가 한 번 다시 시작되고, 스크립트가 알아서 이어 갑니다.
4. 이 PC에서 설정 화면을 열고 owner와 팀을 만듭니다([첫 설정](#첫-설정)).
5. 팀원이 접속할 수 있게 https 주소를 붙입니다([다른 컴퓨터와 휴대폰에서 접속](#다른-컴퓨터와-휴대폰에서-접속)).

## 요구 사항

| 항목 | 요구 사항 |
|---|---|
| 윈도우 | 윈도우 11(권장), 또는 업데이트를 받은 윈도우 10 22H2(빌드 19045). Home, Pro, Enterprise 모두 됩니다 |
| 프로세서 | 64비트(x64 또는 ARM64). BIOS/UEFI에서 가상화(Intel VT-x, AMD-V / SVM)가 켜져 있어야 합니다. 대부분의 PC는 켜져 있습니다 |
| 메모리 | **16 GB 권장, 최소 8 GB.** 시험에서 문서를 다루는 AI 답변 한 번에 리눅스가 최대 2.4 GB를 썼습니다. 8 GB에서는 PC로 다른 일을 하기 느립니다 |
| 디스크 | C: 드라이브에 20 GB 이상 여유, 그리고 팀 파일과 백업을 둘 공간 |
| 계정 | 윈도우 관리자 계정. 서버는 그 계정에 속하고, 그 계정이 로그인해 있는 동안 돌아갑니다 |
| 네트워크 | 다운로드, 업데이트, AI 제공사에 필요한 인터넷 |
| 전원 | PC를 켜 두고 전원에 연결해 둡니다. 전원 연결 시 절전을 끌지는 스크립트가 먼저 묻습니다 |

systemd가 켜진 WSL2에는 Microsoft의 최신 WSL(2.4.4 이상)이 필요합니다. 스크립트가 설치하거나 업데이트합니다.
윈도우 10은 더 이상 Microsoft의 정기 업데이트를 받지 않으니 윈도우 11을 권합니다.

## 설치 스크립트 실행

1. **Windows PowerShell을 관리자 권한으로** 엽니다. 시작 메뉴에서 `PowerShell`을 입력하고 **Windows PowerShell**을
   오른쪽 클릭한 뒤 **관리자 권한으로 실행**을 누릅니다.
2. 최신 릴리스의 스크립트를 받아 실행합니다.

   ```powershell
   cd $env:USERPROFILE\Downloads
   $V = (Invoke-RestMethod https://api.github.com/repos/trina-app/trina-ax/releases/latest).tag_name
   Invoke-WebRequest "https://raw.githubusercontent.com/trina-app/trina-ax/$V/scripts/windows/install-wsl-server.ps1" -OutFile install-wsl-server.ps1
   powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1
   ```

   평범한 텍스트 파일입니다. 무엇을 하는지 보고 싶으면 먼저 메모장으로 열어 보세요. `-WhatIf`를 붙이면 바꿀 것을
   모두 보여 주기만 하고 아무것도 바꾸지 않습니다.
   `powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1 -WhatIf`

3. 묻는 말에 답합니다. 새 PC에서는 15–40분 걸리고, 대부분은 서버 패키지 설치 시간입니다. 창을 닫지 마세요.

스크립트가 하는 일을 순서대로 적었습니다. 언제든 다시 실행해도 됩니다. 끝난 단계는 건너뜁니다.

1. **이 PC를 점검합니다**: 윈도우 버전, 64비트, 메모리, 가상화, 디스크 여유, 그리고 이 창이 윈도우에 로그인한
   계정으로 실행 중인지. 빠진 것이 있으면 알기 쉬운 메시지와 함께 멈춥니다.
2. **윈도우 기능 두 개를 켭니다**: 가상 머신 플랫폼(Virtual Machine Platform)과 Linux용 Windows 하위 시스템. 처음에는
   **한 번 다시 시작**해야 합니다. 스크립트가 묻고 다시 시작하며, 다시 로그인하면 새 창에서 알아서 이어 갑니다(일회용
   작업 "Continue the Trina AX setup after the restart"). 창이 뜨지 않으면 같은 명령을 다시 실행하세요.
3. **WSL을 설치하거나 업데이트하고**, 리눅스가 쓸 메모리를 `%UserProfile%\.wslconfig`에 정합니다([메모리](#메모리)
   참고). 이미 있는 `.wslconfig`는 그대로 둡니다. 메모리 줄이 없을 때만, 사본(`.wslconfig.trina-backup-<날짜>`)을
   만든 뒤 한 줄을 넣습니다.
4. **데비안을 `TrinaAX`라는 이름의 WSL 배포판으로 설치하고** `/etc/wsl.conf`를 설정합니다([아래](#스크립트가-리눅스에서-바꾸는-것)).
   다른 이름은 `-Distro <이름>`. 다른 WSL 배포판은 건드리지 않습니다. 처음에는 윈도우가 "Welcome to WSL" 창을 띄울 수
   있습니다. 닫으면 됩니다.
5. **curl과 Python 3를 설치합니다.** 새 데비안에는 둘 다 없고, 다운로드와 그 확인에 필요합니다.
6. **서버 키트를 받아 리눅스 안내와 똑같이 확인합니다**([키트 받기와 확인](INSTALL-LINUX.md#3-키트-받기와-확인)):
   릴리스 `SHA256SUMS`의 체크섬, 키트 서명(`mycel-ctl verify-bundle`), 설치기의 점검. 어떤 확인도 건너뛰지 않고
   서명 없는 키트는 설치하지 않습니다. 그다음 일반 설치기(`install-linux.sh install`, Claude Code와 Codex 포함)를
   실행합니다. 푼 키트는 나중의 복구를 위해 리눅스 안 `/root/trina-ax-kit`에 남습니다. 설치가 중간에 멈춘 뒤(설치는
   됐지만 서버가 응답하지 않음) 다시 실행하면 새로 설치하지 않고 복구(`install-linux.sh repair`)합니다.
7. **서버가 계속 돌게 합니다**: "Keep the Trina AX server running" 작업(작업 스케줄러, TrinaAX 폴더)이 로그인할 때
   시작해 리눅스를 켜 둡니다([계속 켜 두기](#계속-켜-두기) 참고). 전원에 연결된 동안 이 PC가 절전 모드로 들어가지 않게
   할지 묻습니다.
8. `http://127.0.0.1:47820`에서 **서버를 확인하고** 설정 화면을 열지 묻습니다.

옵션: `-Version 0.21.0`(최신 대신 지정한 릴리스), `-Engine claude`(Claude Code만), `-MemoryGB 6`(메모리 한도),
`-KeepAwake Yes|No`, `-OpenSetup Yes|No`(질문에 미리 답하기).
`-KitPath <TrinaAX-server-...-linux-amd64.tar.gz> -SumsPath <SHA256SUMS>`는 내려받는 대신 이 PC에 있는 키트를
설치합니다(예: 시험용 서명된 pre-release). 다운로드와 똑같이 확인하고, 서명 없는 키트는 거부합니다.

스크립트 자체는 릴리스 소스에서 받습니다. 스크립트가 받아 설치하는 것(키트)은 리눅스와 같이 릴리스 서명으로
확인합니다.

## 첫 설정

스크립트가 `http://127.0.0.1:47820/setup`을 열고 일회용 설정 코드를 클립보드에 넣어 줍니다. 화면의 설정 코드 칸에
붙여 넣으세요. (주소에 넣지 않는 이유: 주소는 브라우저의 명령줄에 남고, PC의 다른 프로그램이 그것을 읽을 수 있습니다.)
코드를 직접 보려면(남에게 보이지 마세요):

```powershell
wsl -d TrinaAX --cd / -u root -- cat /var/lib/mycel/setup/code
```

owner, 팀 이름, 언어를 만들고 팀 시간대를 확인합니다. 그다음은 리눅스 안내의 [첫 설정](INSTALL-LINUX.md#5-첫-설정)
목록을 따릅니다: 권한, AI 연결, 팀 초대, 첫 스킬, 첫 백업.

## 다른 컴퓨터와 휴대폰에서 접속

서버는 이 PC(`127.0.0.1`)에서만 응답합니다. 동료와 휴대폰 앱이 쓰려면 다른 직접 설치 서버와 마찬가지로 **https
주소**가 필요합니다: `127.0.0.1:47820`에 닿는 터널이나 리버스 프록시, 그리고 휴대폰이 믿는 인증서. 리눅스 안내의
[첫 설정](INSTALL-LINUX.md#5-첫-설정) 3단계처럼, 리눅스 안에서 설정합니다.

```powershell
wsl -d TrinaAX --cd / -u root -- bash -c "cd /root/trina-ax-kit && ./install-linux.sh repair --public-host team.example.com"
```

터널 프로그램은 리눅스 안(`wsl -d TrinaAX --cd / -u root`)에서도, 윈도우에서도(`127.0.0.1:47820`으로 서버에 닿습니다) 돌릴
수 있습니다. PC의 포트를 사무실 네트워크에 여는 방법(WSL 미러 네트워킹, `netsh portproxy`)은 필요 없고 여기서 다루지
않습니다. https가 생기지 않습니다.

## 스크립트가 리눅스에서 바꾸는 것

`TrinaAX` 배포판의 `/etc/wsl.conf`(원래 파일은 `/etc/wsl.conf.trina-backup`으로 남김):

| 설정 | 이유 |
|---|---|
| `[boot] systemd=true` | 서버의 서비스가 systemd로 돕니다 |
| `[interop] enabled=false`, `appendWindowsPath=false` | AI의 명령을 포함해 리눅스 프로그램이 윈도우 프로그램(`cmd.exe`, `powershell.exe`)을 실행할 수 없습니다. 실행되면 내 윈도우 계정으로, AI 샌드박스 밖에서 돌게 됩니다 |
| `[automount] enabled=false`, `mountFsTab=false` | C: 드라이브와 다른 드라이브를 리눅스에 붙이지 않습니다(`/mnt/c` 없음). 리눅스의 어떤 것도 PC의 파일을 읽거나 바꿀 수 없습니다. 그래서 여기 명령은 `--cd /`로 시작합니다. 없으면 WSL이 지금 윈도우 폴더를 옮길 수 없다고 경고합니다 |
| `[user] default=root` | 여기 명령과 파일 탐색기의 `\\wsl.localhost\TrinaAX`가 root를 씁니다. 배포판에 다른 사용자는 없습니다 |

윈도우에서 리눅스로는 여전히 닿습니다(`wsl.exe`, 파일 탐색기, `127.0.0.1:47820`). 막힌 것은 반대 방향뿐입니다. 스크립트는
자기 단계와 `-KitPath` 키트를 C: 드라이브가 아니라 `wsl.exe`를 통해 리눅스에 넣습니다.

## 윈도우에서 다르게 동작하는 것

서버는 WSL의 기본 네트워크 모드(NAT)에서 돕니다. 스크립트는 WSL의 미러 네트워킹을 켜지 않습니다. 미러 모드가 더해 주는
것(사무실 네트워크가 WSL에 닿는 것)은 데스크톱 앱의 LAN 직접 연결만 쓰는데, 그것도 더 필요한 것이 있습니다(아래). 이 PC에서는
`localhost` 대신 `127.0.0.1`을 쓰세요. WSL은 IPv4를 넘겨 주는데 브라우저는 `localhost`를 IPv6로 먼저 시도할 수 있습니다.

| 기능 | 윈도우(WSL)에서 |
|---|---|
| 이 PC의 브라우저 | `http://127.0.0.1:47820`. 윈도우가 WSL 안의 서버로 넘겨 줍니다 |
| 이 PC의 데스크톱 앱 | 앱 첫 화면에 `http://127.0.0.1:47820`을 붙여 넣으세요(`http://`는 이 PC 자신의 주소에만 받습니다). 초대 링크나 **앱에서 열기**는 `127.0.0.1` 주소를 넘기지 않으니 붙여 넣으세요 |
| 동료 컴퓨터, 휴대폰 앱 | https 주소가 필요합니다([위](#다른-컴퓨터와-휴대폰에서-접속)): 공식 릴레이(나가는 연결만 써서 WSL에서도 됨) 또는 `127.0.0.1:47820`으로 가는 터널. 휴대폰 앱은 공인 인증서의 https가 필요합니다 |
| Canva, Intercom, Square 로그인(데스크톱 앱의 Microsoft 포함) | 데스크톱 앱으로 합니다. 브라우저가 있는 PC의 `127.0.0.1`에서 앱이 로그인 결과를 받습니다. 이 PC든 다른 PC든 데스크톱 앱에서 로그인하면 됩니다. 웹만으로는 리눅스와 같이 데스크톱 앱을 쓰라고 안내합니다 |
| 다른 MCP 커넥터 로그인 | 브라우저가 서버 주소로 돌아옵니다. 이 PC에서는 `127.0.0.1`로, 다른 사람은 https 주소로. 클라이언트 메타데이터(CIMD)를 쓰는 커넥터는 https 주소가 필요합니다 |
| Google 드라이브, Google 로그인, Slack | https 주소가 필요합니다(Google과 Slack은 `https://` 돌아올 주소만 받음). 리눅스와 같습니다 |
| GitHub | 공용 GitHub 앱은 트리나 도메인의 팀 주소로만 돌아옵니다. 자기 주소의 서버는 자기 GitHub 앱이 필요합니다 |
| Claude, ChatGPT 로그인 | 됩니다. Claude는 코드를 붙여 넣고, ChatGPT는 기기 코드로 로그인합니다(이 PC로 돌아오지 않음) |
| 데스크톱 앱의 LAN 직접 연결(`--tls-port`) | **WSL에서는 안 됩니다.** 인증서에 PC의 LAN 주소가 아니라 WSL 내부 주소가 들어가고, NAT 모드에서는 사무실 네트워크가 WSL에 닿지 못합니다. https 주소를 쓰세요 |
| 업데이트 | 서버는 팀의 업데이트 시간(관리자 › 팀 설정, 기본 03:00–05:00)에 스스로 업데이트합니다. 밤에 꺼져 있거나 로그아웃된 PC는 업데이트되지 않습니다. PC가 켜져 있는 시간으로 바꾸거나 `wsl -d TrinaAX --cd / -u root -- mycel-ctl update`를 실행하세요. 업데이트는 서버 서비스만 다시 시작하고, 윈도우나 WSL은 다시 시작하지 않습니다 |
| 영상(HyperFrames) | 리눅스 메모리가 3.5 GB 이상이면 제공됩니다(스크립트 한도는 5 GB 이상). 렌더 하나에 약 1 GB. 서버는 리눅스가 보는 메모리, 곧 `.wslconfig` 한도로 자기 한도를 정합니다 |
| 백업 | 다른 모든 것처럼 C: 드라이브의 리눅스 디스크 안에 있습니다([백업](#백업)) |
| 디스크 여유 | 서버의 여유 공간 점검은 C: 드라이브가 아니라 리눅스 디스크(최대 1 TB)를 봅니다. C:는 직접 지켜보세요. C:가 차면 리눅스도 쓰지 못합니다. 리눅스 디스크는 파일을 지워도 줄어들지 않습니다 |

## 계속 켜 두기

- **로그인 상태**: WSL은 리눅스를 쓰는 마지막 창이 닫히고 15초쯤 지나면 리눅스를 멈춥니다. 서버 자체의 서비스는
  세지 않습니다. "Keep the Trina AX server running" 작업이 계정이 로그인해 있는 동안 보이지 않는 연결 하나를 열어
  둡니다. **화면 잠금은 괜찮습니다. 로그아웃하면 서버가 멈추고**, 다시 시작한 뒤 로그인하기 전까지도 멈춰 있습니다.
- **윈도우 업데이트 뒤**: 윈도우는 업데이트로 다시 시작한 뒤 로그인 화면에서 기다립니다. 설정 › 계정 › 로그인 옵션 ›
  **업데이트 후 내 로그인 정보를 사용하여 자동으로 설정 완료**를 켜고, 업데이트가 있던 다음 날 서버를 확인하세요.
  사용 시간을 정해 두면 업무 시간 밖에 다시 시작합니다.
- **절전**: PC가 절전 중이면 서버가 응답하지 못합니다. 스크립트가 "전원 연결 시 절전 안 함"으로 바꿀 수 있습니다(화면은
  여전히 꺼집니다). 노트북이라면 덮개를 닫을 때의 동작도 정하세요(제어판 › 전원 옵션 › 덮개를 닫으면 수행되는 작업
  선택 › 전원 연결 시 아무 것도 안 함).
- **멈춰 있는 동안**에는 서버의 어떤 것도 돌지 않습니다. 예약 작업, 휴대폰 알림, 릴레이가 기다리고, 하루 백업은 리눅스가
  다시 돌면 따라잡습니다.
- **확인**: `wsl -l -v`에 `TrinaAX`가 `Running`으로 보이고, `wsl -d TrinaAX --cd / -u root -- mycel-ctl status`가 서버 상태를
  보여 줍니다.
- **잠시 멈추기**: 작업 스케줄러(TrinaAX 폴더)에서 작업을 사용 안 함으로 바꾸고 `wsl --terminate TrinaAX`를 실행합니다.
  다시 켜려면 작업을 사용으로 바꾸거나 로그아웃 후 다시 로그인합니다.

## 메모리

`.wslconfig`에 따로 적지 않으면 WSL은 PC 메모리의 절반까지 리눅스에 줍니다. 파일에 한도가 없으면 스크립트가 적습니다:
8 GB PC는 5 GB, 12 GB는 6 GB, 16 GB는 8 GB, 24 GB는 12 GB, 32 GB 이상은 16 GB. 바꾸려면
`%UserProfile%\.wslconfig`의 `[wsl2]` 아래 `memory=` 줄을 고치고 `wsl --shutdown`을 실행하세요(작업이 1분 안에
서버를 다시 켭니다). 답변이 실패하거나 LibreOffice 페이지가 시간 초과되면 리눅스 메모리를 늘리거나 16 GB PC를 쓰세요.

## 데이터가 있는 곳

서버의 모든 것(팀 파일, 대화 기록, 데이터베이스, 백업, AI 연결)은 리눅스 배포판의 가상 디스크 안에 있습니다.
`%LocalAppData%\wsl\` 아래 폴더의 `ext4.vhdx` 파일이고, 팀이 파일을 더할수록 커집니다.

- **`wsl --unregister TrinaAX`는 그 디스크와 팀의 모든 데이터를 그 자리에서 영구히 지웁니다.** 다른 곳에 사본이
  없으면 쓰고 있는 서버에서 절대 실행하지 마세요.
- 디스크 정리 도구로 그 폴더를 지우지 말고, 클라우드와 동기화되는 폴더(OneDrive)에 두지 마세요. 열려 있는 디스크
  파일의 동기화 사본은 백업이 아닙니다.
- 윈도우를 초기화하거나 다시 설치해도 지워집니다.

## 백업

앱 안의 백업(관리자 › 시스템 › 백업)은 같은 가상 디스크 안에 있습니다. 실수는 막아 주지만 PC 고장은 막지 못합니다.
[백업과 복원](BACKUP-RESTORE.md#make-a-backup-now)처럼, 암호화한 아카이브를 정기적으로 PC 밖에 복사하세요.

```powershell
wsl -d TrinaAX --cd / -u root
```

리눅스 안에서 그 문서의 Linux 명령(`trina_admin backup --scope full`, `trina_admin archive --out
/var/lib/mycel/data/off-host.tar.zst.age --password-stdin`)을 실행합니다. 리눅스에서는 C: 드라이브가 보이지 않으니
윈도우에서 복사합니다. 파일 탐색기에서 `\\wsl.localhost\TrinaAX\var\lib\mycel\data\`(또는 탐색 창의 **Linux ›
TrinaAX**)를 열고 `off-host.tar.zst.age`를 다른 디스크나 저장소에 복사한 뒤, 양쪽의 SHA-256을 비교하고(윈도우에서는
`Get-FileHash`) 리눅스에서 지웁니다.

```sh
rm /var/lib/mycel/data/off-host.tar.zst.age
```

파일 탐색기는 리눅스 파일을 root(배포판의 기본 사용자)로 엽니다. 비밀 정보를 포함해 모든 것을 읽고 바꿀 수 있습니다.
이 파일만 복사하고 그 창을 열어 두지 마세요.

서버를 멈춘 상태에서 리눅스 디스크 전체를 복사할 수도 있습니다: 작업을 사용 안 함으로 바꾸고
`wsl --terminate TrinaAX`, 그다음 `wsl --export TrinaAX D:\TrinaAX-backup.tar`(비밀 정보가 들어 있으니 PC만큼
안전하게 보관하세요). `wsl --import`로 다시 배포판을 만들 수 있습니다.

## 업데이트

서버는 리눅스와 같이 릴리스 피드에서 스스로 업데이트합니다([업그레이드와 롤백](INSTALL-LINUX.en.md#upgrade-and-rollback)).
WSL은 윈도우 업데이트(또는 `wsl --update`)로 업데이트됩니다. 리눅스 안내([요구 사항](INSTALL-LINUX.en.md#requirements))
처럼 데비안 보안 업데이트를 켜 두세요. 예:
`wsl -d TrinaAX --cd / -u root -- apt-get install -y unattended-upgrades`.

## 제거와 되돌리기

설치가 중간에 멈췄다면 스크립트를 다시 실행하세요. 끝난 단계는 건너뜁니다. 설치기가 돌기 전에 멈췄다면 새로 받아 다시
시작하고, 설치기가 돈 뒤에 멈췄다면 남겨 둔 키트로 복구합니다.

**데이터는 두고** 서버만 제거(리눅스 설치기의 uninstall, 나중에 다시 설치하면 데이터를 다시 찾습니다):

```powershell
wsl -d TrinaAX --cd / -u root -- bash -c "cd /root/trina-ax-kit && ./install-linux.sh uninstall"
```

PC 밖 백업을 만들고 확인한 뒤 **전부** 제거:

```powershell
Unregister-ScheduledTask -TaskPath '\TrinaAX\' -TaskName 'Keep the Trina AX server running' -Confirm:$false
wsl --unregister TrinaAX            # 팀의 모든 데이터가 든 리눅스 디스크를 지웁니다
Remove-Item -Recurse "$env:ProgramData\TrinaAX"
```

그다음, 원래대로 돌리고 싶다면:

- `.wslconfig`: 사본 `%UserProfile%\.wslconfig.trina-backup-<날짜>`를 되돌려 놓거나, 스크립트가 `[wsl2]` 아래에 넣은
  두 줄을 지웁니다(스크립트가 만든 파일이면 파일째).
- 절전: 설정 › 시스템 › 전원 › 화면 및 절전, 또는 `powercfg /change standby-timeout-ac 30`.
- 윈도우 기능: 켜 둬도 됩니다(다른 프로그램도 WSL을 씁니다). 끄려면 Windows 기능에서 "가상 머신 플랫폼"과 "Linux용
  Windows 하위 시스템"을 끄고 다시 시작합니다.

## 문제 해결

| 보이는 것 | 할 일 |
|---|---|
| `Virtualization is off in this PC's firmware` | BIOS/UEFI 설정으로 다시 시작해 Intel VT-x 또는 AMD-V / SVM을 켭니다 |
| WSL의 `0x80370102` 또는 `0x8007019e` | 가상화나 WSL 기능이 꺼져 있습니다. 스크립트를 다시 실행하고 다시 시작하라고 하면 따릅니다 |
| `This window runs as ..., but ... is signed in` | 서버를 맡을 관리자 계정으로 윈도우에 로그인하세요. 다른 계정의 비밀번호로 권한만 올리지 마세요 |
| 다운로드에서 설치가 멈춤 | github.com, deb.debian.org, downloads.claude.ai, updates.trina.app에 인터넷으로 닿아야 합니다. 회사 프록시는 [HTTP 프록시 뒤에서](INSTALL-LINUX.en.md#behind-an-http-proxy)를 보세요 |
| `wsl -d TrinaAX --cd ~`가 사용자 이름을 물음 | 데비안의 첫 시작입니다. 닫거나 사용자를 만드세요. 서버에는 필요 없습니다. 여기 명령은 `-u root`로 실행합니다 |
| 서버가 얼마 뒤 멈춤 | 작업이 돌고 있나요(작업 스케줄러 › TrinaAX)? 계속 로그인해 있나요? PC가 절전에 들어가지 않았나요? |
| 설치기 경고 `this kernel offers no Landlock` | WSL을 업데이트(`wsl --update`)하고 스크립트를 다시 실행합니다. (0.20까지는 설치기가 WSL에 없는 파일을 읽어서 Landlock이 되는데도 경고했습니다) |
| `mycel-ctl status`에서 Claude 연결이 경고 | 구독이 사용 한도가 풀리기를 기다리는 중입니다. 스스로 돌아옵니다 |

더 보기: `wsl -d TrinaAX --cd / -u root -- mycel-ctl status`, 관리자 › 시스템 › 진단, 리눅스 안내의
[문제 해결](INSTALL-LINUX.en.md#troubleshooting-and-faq), [문제 해결](TROUBLESHOOTING.md).
