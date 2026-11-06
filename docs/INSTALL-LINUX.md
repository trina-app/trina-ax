# 리눅스 서버에 설치하기 (자체 설치)

같은 코드를 세 가지로 쓴다: **Trina AX 호스팅**(별도 서비스), **자기 리눅스 서버**(이 문서, 무료), **사무실 맥 미니**
(`docs/OFFICE.md`). 호스팅도 이 문서와 같은 설치 키트(`install-linux.sh` + 리눅스 번들)를 `--hosted`로 쓴다.

릴리스 키트와 설치기는 공개되어 있습니다. [GitHub Releases](https://github.com/trina-app/trina-ax/releases)에서
게시된 버전과 파일을 확인하세요. 이 문서는 설치 절차를 설명하며 모든 배포판·장비에서의 동작 보장은 아닙니다.

현재 버전은 [최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)에서 확인하세요. GitHub Releases와 트리나 업데이트 피드(`https://updates.trina.app`, 2026-10-29부터 운영)에서 배포합니다. 설치된 서버는 피드의 `server/stable.json`(서명됨)에서 업데이트를 받습니다(8장).

[English](INSTALL-LINUX.en.md) · 전용 서버나 VM에서 설치하세요. **systemd가 PID 1이고 cgroup v2가 필요합니다. 일반 Docker 컨테이너는 운영 설치 대상이 아닙니다.**

## 1. 이런 경우에 씀

- 회사 서버나 클라우드 VM(우리 호스팅이 아닌 곳)에 팀 서버를 직접 둘 때. 파일을 회사 서버에 보관하려는 경우. 단, AI가 읽는 문맥은 모델 제공사로 전송된다.
- 맥 미니 없이 리눅스 한 대로 팀 서버를 운영할 때(처리 인원 실측 보장 아님).
- 한 서버 = 한 팀이다. 여러 팀이면 팀마다 VM(또는 LXC 컨테이너)을 하나씩 둔다.

## 2. 요구 사항

| 항목 | 값 |
|---|---|
| OS | 데비안 13(권장), 데비안 12, 우분투 24.04. 우분투 22.04·RHEL 계열은 받지 않음(설치 점검이 거부) |
| CPU | amd64(SSE4.2 이상) 또는 arm64 |
| 메모리 | 4 GB 이상 권장(2 GB면 동시 실행 1) |
| 디스크 | 20 GB 이상(팀 파일 + 버전 기록 + 휴지통 + 로컬 백업, 앱 약 1–1.5 GB: 8장 "보관하는 버전") |
| 커널 | 6.12 이상 권장. 그 미만은 턴끼리 추상 소켓·시그널을 막지 못함(진단이 경고) |
| 기타 | systemd(PID 1), cgroup v2, 인터넷(설치·업데이트·AI 모델) |

**서버의 공인 주소:** 서버는 시작할 때와 30분마다 릴리스 피드(`https://updates.trina.app/ip`)에 IPv4·IPv6로 한 번씩 물어 자기 공인 주소를 알아 둡니다. AI가 여는 웹 주소가 그 주소(서버 앞의 공유기·NAT로 되돌아오는 길)면 거절합니다. 그 주소를 모르는 동안(인터넷이 없거나 피드로 나가는 연결이 막힌 서버)에는 AI가 여는 모든 웹 주소를 사람에게 묻고, 예약 작업은 웹 주소를 열지 못합니다. 피드에 묻지 않게 하려면 `/etc/default/mycel`에 `MYCEL_EXIT_ADDRESS_CHECK=off`를 넣으세요(그러면 계속 묻습니다).

**HWP/HWPX 미리보기:** 선택해서 설치하는 '한글 문서 미리보기' 플러그인입니다. 관리 > 플러그인의 공식 목록에서 설치하면 서버가 고정된 빌드를 릴리스 피드(업데이트를 받는 주소)에서 https로 받으므로, 서버에서 그 주소로 나가는 연결이 열려 있어야 합니다. 기본 릴리스 키트에는 rhwp 실행 파일을 포함하지 않습니다. Debian 12는 제품 지원 대상이지만 HWP 미리보기는 사용할 수 없고, 관리 화면에 '이 서버에서는 쓸 수 없어요'로 보입니다(glibc 2.36; 고정 렌더러는 2.39 필요). AI의 한글 문서 만들기·채우기도 이 플러그인과 함께 켜지므로 Debian 12에서는 쓸 수 없습니다. 원본 다운로드와 기존 글자 읽기는 유지됩니다. OS 최소 지원 버전은 바꾸지 않습니다. 실행 조건과 한계는 [HWP 런타임 안내](../resources/hwp/README.md)를 참고하세요.

**PDF의 한글·일본어·중국어:** AI가 만드는 PDF는 키트에 든 Noto Sans CJK 글꼴(`app/<버전>/fonts/`, OFL-1.1, 고지는 `licenses/noto-sans-cjk/`)로 그립니다. 리눅스 서버에는 이 글자들을 그릴 글꼴이 없어서, 0.2.15까지는 PDF의 한글이 빈 네모로 나왔습니다. 서버에 글꼴 꾸러미를 따로 설치할 필요는 없고, 이미 설치한 서버도 평소 업데이트로 글꼴을 받습니다(root 단계·apt 없음). 그 전에 만든 PDF는 다시 만들어야 합니다. 글꼴 때문에 키트가 약 32 MB(풀면 40 MB) 커졌습니다.

설치 전에 바꾸지 않고 확인만 한다:

```sh
sudo ./install-linux.sh check --from .
```

## 3. 키트 받기와 확인

릴리스 키트는 GitHub Releases에 있다(태그 `v<버전>`마다 amd64·arm64 키트, `SHA256SUMS`와 서명).

빈 다운로드 폴더에서 최신 버전을 한 번만 선택해 모든 파일에 같은 버전을 사용합니다.

```sh
V=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/trina-app/trina-ax/releases/latest)
V=${V##*/v}
ARCH=amd64 # use arm64 for an ARM server
BASE="https://github.com/trina-app/trina-ax/releases/download/v$V"
KIT="TrinaAX-server-$V-linux-$ARCH.tar.gz"
curl -fLO "$BASE/$KIT"
curl -fLO "$BASE/SHA256SUMS"
python3 - "$KIT" <<'CHECK'
import hashlib, pathlib, sys
name = sys.argv[1]
entries = {parts[1].lstrip('*'): parts[0] for line in pathlib.Path('SHA256SUMS').read_text().splitlines() if len(parts := line.split()) == 2}
assert name in entries, 'Artifact missing from SHA256SUMS'
assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == entries[name], 'Checksum mismatch'
print('Checksum OK')
CHECK
tar xzf "$KIT"
cd "TrinaAX-server-$V-linux-$ARCH"
./app/$V/root/mycel-ctl verify-bundle "./app/$V"
sudo ./install-linux.sh check --from .
```

체크섬은 전송 손상을 확인하며 독립적인 진위 보증은 아닙니다. 번들 검증기는 내장 릴리스 서명을 확인하고 설치기도 재확인합니다. 공개 릴리스에 `--allow-unsigned`를 쓰지 마세요. 실행 전에 소스와 배포 신뢰 경로를 확인하세요.

### 3a. 소스에서 키트 만들기 (릴리스가 없을 때, 개발용)

키트를 만들 리눅스 기계에서(설치할 서버와 같은 아키텍처). 2026-10-28 Lightsail 데비안 13(2 vCPU, 4 GB)에서 확인했다.
2 vCPU에서 whisper 빌드가 약 10분, 키트 만들기가 몇 분 걸린다.

```sh
sudo apt-get install -y git curl unzip ca-certificates xz-utils zstd build-essential cmake
# Go(native/go.mod의 버전, 예: 1.27.x)는 https://go.dev/dl/ 에서 /usr/local/go로, Bun은 고정 버전으로:
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.12"
export PATH=$HOME/.bun/bin:/usr/local/go/bin:$PATH

git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile --ignore-scripts                    # 패키지 설치 스크립트 없이: Node.js가 필요 없다
ARCHS=amd64 bash native/build.sh                                   # arm64면 ARCHS=arm64
bash scripts/linux/build-whisper.sh --arch amd64 --out dist/whisper   # 음성 받아쓰기(없으면 --no-whisper)
bun run build:web                                                  # 웹 앱. 빠뜨리면 키트에 앱 화면이 없다
bun scripts/build-bundle.ts --os linux --arch amd64 --version 0.2.9-dev.1 --whisper-dir dist/whisper --out dist/linux
cd dist/linux && sudo ./install-linux.sh install --from . --allow-unsigned --engine claude
```

- `--ignore-scripts`: 서버 키트에는 패키지 설치 스크립트(Electron·Windows 설치 파일·CUDA 내려받기)가 필요 없다. 의미 검색의
  onnxruntime·sharp 리눅스 파일은 패키지에 들어 있다. 이 옵션 없이 `bun install`이 `node: command not found`
  (`electron-winstaller` exited with 127)로 멈추면, bun이 `node` 대신 쓰는 `/tmp/bun-node-*/node`가 지워진 bun을 가리키는
  것이다(이전 빌드의 bun을 지운 경우, 2026-10-30 QA). `--ignore-scripts`로 다시 하거나 그 폴더를 지운다.
- 직접 만든 키트는 서명이 없으므로 `--allow-unsigned`가 필요하고, 진단이 그렇다고 알린다. 이 설정은 repair·update에도 남으므로
  서명된 릴리스로 옮긴 뒤에는 `sudo mycel-ctl allow-unsigned off`(설치기는 `--require-signed`)로 되돌린다. 켜져 있는 동안
  `sudo mycel-ctl status`와 관리자 › 진단이 경고한다.
- Linux 서버는 글자 인식(OCR)을 하지 않는다. AI가 사진·스캔 PDF 페이지를 읽으면 이미지를 직접 보고(관리자 > 팀 설정 "이미지·PDF 페이지·영상 장면을 AI에게 보내기", 기본 켜짐), 스캔 문서와 사진은 글자로 검색되지 않는다. Claude Code의 검색과 같다.
- AI는 영상·오디오 파일을 배포판의 ffmpeg·ffprobe(`ffmpeg` 패키지 5.1 이상, 다른 패키지와 함께 apt로 설치, 키트에 넣지 않음)로 읽는다. 장면과, 팀 설정 › 음성 입력에서 허용하면 받아쓰기. 디코더가 사람들이 올린 파일을 읽으므로 Debian·Ubuntu 보안 업데이트를 켜 둔다(예: `unattended-upgrades` 패키지; ffmpeg 보안 수정이 이 길로 온다). ffmpeg가 없으면 AI가 이 서버에서는 영상을 읽을 수 없다고 말한다.

소스 빌드 버전은 예시입니다. 소스의 버전에서 고유한 개발 버전을 정하세요. 공식 릴리스 설치·업데이트에는 서명 확인을 우회하지 마세요.

## 4. 설치

```sh
sudo ./install-linux.sh install --from . --engine claude --engine codex
```

- 계정 `axserver`(서버)·`axagent`(AI 엔진)을 시스템 계정으로 만든다. 모든 파일은 `/var/lib/mycel` 아래.
- 필요한 패키지(bubblewrap, nftables, poppler-utils, ffmpeg, libheif-examples …)를 apt로 설치한다(`--skip-apt`로 끔). tesseract는 더 이상 설치하지 않는다(이미 있어도 쓰지 않음).
- 엔진 바이너리는 공식 주소에서 받아 고정된 SHA-256과 비교한다(번들에 넣지 않음).
- 방화벽(nftables)을 먼저 넣고, 실패하면 설치를 멈춘다: AI 엔진 계정은 `127.0.0.1:<모델 프록시 포트>` 말고는 아무 데도 못 나간다.
- systemd 유닛: `mycel-firewall.timer`, `mycel-launcher.service`, `mycel-server.service`, `mycel-update.timer`.
- 마지막 줄이 `installed …`이면 성공. 실패하면 이유를 출력하고 1로 끝난다.

자주 쓰는 옵션: `--id ID`(한 서버에 시험 설치를 하나 더. systemd 자체 그룹 이름인 `system`·`user`·`machine`·`capsule`은 쓸 수 없다), `--port N`(기본 47820), `--proxy-port N`(기본 47821),
`--tls-port N`(사무실 안 직접 연결, 기본 끔), `--no-auto-update`, `--plan FILE`(요금제 파일, 아래 9장).

공개 주소와 연동(7장 "공개 주소"):

- `--public-host HOST`: 팀의 공개 주소 `https://HOST`(`server.json`의 `tunnel.host`). `none`이면 지운다.
- `--app-connectors`: 팀원이 자기 Claude(Claude Code, Claude Desktop, claude.ai)를 이 서버에 연결한다(앱 커넥터,
  `https://HOST/mcp`). 공개 주소가 있어야 한다. `--no-app-connectors`로 끈다.
- `--google-drive-client FILE`: 개인 Google Drive 연결용 OAuth 클라이언트(`docs/GOOGLE-DRIVE.md`). Google Cloud에서 받은
  JSON을 그대로 주면 된다.

`repair`와 `update`는 `--public-host`와 `--app-connectors`를 기억한다. Drive 클라이언트 파일은 기억하지 않고, 설치된 파일을
그대로 둔다. 잘못된 값은 아무것도 바꾸기 전에 거절한다.

## 5. 첫 설정

서버에는 화면이 없으므로 SSH 터널로 연다.

```sh
sudo cat /var/lib/mycel/setup/code                      # 설치 코드(서버가 읽는 data/setup-token과 같은 값)
ssh -L 47820:127.0.0.1:47820 <서버>                     # 내 PC에서
# 브라우저: http://127.0.0.1:47820/setup?token=<설치 코드>
```

팀 이름, 언어, owner 계정을 만든다. **팀 시간대는 이 브라우저의 시간대로 정해진다**(관리자 › 설정 › 팀 시간대에서 바꿈).
오늘·이번 달 사용량, 예약 작업, 야간 백업이 이 시간대를 따른다(서버 자체는 보통 UTC로 돈다).

첫 주: **권한 → AI 연결 → 팀원 초대 → 첫 스킬 → 첫 백업**.

1. 관리자 → 그룹·폴더 권한에서 접근 범위를 정하고 두 계정으로 확인합니다.
2. 아래 6장에서 허용된 AI 연결을 등록합니다. 새 팀은 회사 연결 하나를 팀 전체가 쓰는 설정이 기본 켜짐이며 기존 선택은 유지됩니다. 개인 연결이 우선이고 연결별 동의가 필요합니다. 설정은 제공사 약관상 허가가 아닙니다.
3. 7장의 HTTPS 주소를 준비한 뒤 관리자 → 멤버에서 초대 링크를 만들어 소수 팀원에게 전달합니다.
4. 파일 화면에서 팀장이 `skills/회의-정리/SKILL.md`를 만들고 아래 예시를 저장합니다. 새 채팅에서 `/`로 골라 가상 회의록의 출처·결과를 비교합니다.
5. 10장의 백업·보관본과 복구 연습을 완료합니다.

```md
---
name: 회의-정리
description: 허용된 회의록의 결정과 할 일을 정리합니다.
---
읽을 수 있는 회의록만 사용하세요. 결정·담당·기한을 표로 정리하세요.
없는 정보는 확인 필요로 표시하고 출처 파일을 적으세요.
사람이 검토할 초안을 내 개인 폴더에 저장하세요.
```

## 6. AI 연결

- owner가 브라우저에서 **관리자 › AI 제공자**로 연결한다: Claude(구독은 "Claude 구독 연결" 버튼으로 브라우저에서 승인하고 코드를 붙여 넣기,
  또는 `claude setup-token` 토큰 붙여 넣기; 또는 Anthropic API 키), Codex(ChatGPT 기기 로그인 또는 OpenAI API 키). 진짜 토큰·키는 서버의 열쇠로 봉인되고 AI 엔진에는 가지 않는다(모델
  프록시가 요청마다 바꿔 끼움). 자체 설치는 네 종류를 다 쓸 수 있고(구독을 팀이 함께 쓸 때의 약관 안내가 화면에 뜸),
  `server.json`의 `engine.credentialKinds`로 좁힐 수 있다. 호스팅도 기본으로 네 종류를 지원하지만 실제 허용 범위는 운영 설정과 제공사 약관을 따릅니다.
- CLI 대체(브라우저 연결이 안 될 때만): `sudo /var/lib/mycel/root/set-claude-token < 토큰파일`(표준 입력만),
  Codex는 `sudo mycel-ctl codex-login`. 다음 시작 때 AI 연결로 옮겨진다.
- 팀 API 엔진(OpenAI 호환, 실험 단계)은 관리자 › AI 제공자 › API 엔진. 자체 설치는 사내 주소(예: 로컬 Ollama)도 된다.

## 7. 팀원 연결

- 중계: `https://<팀>.trina.app`(관리자 › 시스템 › 연결). 서버는 밖으로만 연결하므로 열 포트가 없다. 공식 중계는
  등록이 닫혀 있어(작업 증명만으로는 `registration_closed`) 계정 콘솔의 공식 중계 애드온에서 받은 **연결 코드**를 함께
  넣는다. 자체 중계(`self-relay`)는 코드 없이 된다.
- 사무실 안 직접 연결: 설치 때 `--tls-port 8443`. 서버의 방화벽(ufw·firewalld)에서 그 포트를 연다.
- 공개 주소: Cloudflare Tunnel 같은 터널이 `https://<HOST>`를 `127.0.0.1:47820`(`--port`)으로 보낸다. 터널(cloudflared와
  그 토큰)은 설치기 밖에서 만든다. 그다음 `sudo ./install-linux.sh repair --public-host <HOST>`. 앱 커넥터와 Google Drive도
  쓰면 같은 줄에 `--app-connectors --google-drive-client client_secret.json`을 붙인다. Drive 클라이언트의 승인된 리디렉션
  URI는 `https://<HOST>/api/integrations/google-drive/callback`이어야 한다.

## 8. 업데이트

트리나 업데이트 피드(`https://updates.trina.app`)는 2026-10-29부터 운영한다. 서버는 피드의 `server/stable.json`(서명됨)에서 새 버전을 받는다. 2026-10-29 실제 시험에서 리눅스 서버가 피드로 0.2.4에서 0.2.5로 업데이트했다. 피드 없이 업데이트하려면 새 GitHub Release 키트의 체크섬·서명을 확인하고 기존 설치를 백업한 뒤 설치기를 다시 실행한다.

- **앱만 바뀌는 릴리스**: 서버가 스스로 적용한다(`server.json`의 `update.auto: true`, 설치기가 자체 설치에 켬). 팀 시간대의
  업데이트 창(관리자 › 설정 › 업데이트 시간, 기본 03:00–05:00) 안에서, 답변이 하나도 돌지 않을 때만. 새 버전이 켜지지 않으면
  bootstrap이 이전 버전으로 되돌리고, 그 버전은 7일 동안 자동으로 다시 시도하지 않는다. 피드의 단계적 배포(`rollout`, 아래)를 따른다.
- **root 부분(실행기·샌드박스·유닛, root가 따로 두는 1A 프로그램 `mycel-safeops`·`pandoc`)이 바뀌는 릴리스**: 관리자 › 시스템 › 업데이트에 "관리자 권한 필요"가 보이고 진단이 경고한다.
  `mycel-update.timer`가 15분마다 확인하고, 팀 시간대의 업데이트 시간(관리자 › 설정 › 업데이트 시간, 비었으면 03:00–05:00)
  안에서 진행 중인 답변이 없을 때만 설치한다. 답변이 돌고 있으면 끊지 않고 조용해질 때까지 기다린다(한 번에 최대 1시간,
  업데이트 시간이 끝나면 다음 날). 사흘 동안 그런 때가 없으면 다음 업데이트 시간에 최대 10분 기다린 뒤 설치한다. 업데이트
  시간 밖의 확인은 네트워크 없이 바로 끝난다. 바로 하려면 `sudo mycel-ctl update`. 피드의 `rootSince`(그 릴리스와 같은 root
  부분을 가진 가장 오래된 릴리스)보다 root 부분(`root/VERSION`)이 오래된 서버는 root 업데이트로 받고(root 릴리스를 건너뛴
  서버), 그보다 새롭거나 같은 서버는 앱 업데이트로 스스로 받는다.
  - 설치가 실패하거나 bootstrap이 되돌린 버전은 타이머가 한동안 다시 시도하지 않는다(`root/update-failed.json`). root
    부분을 넣은 뒤 앱이 실패하면 처음엔 20시간(다음 날 업데이트 시간에 다시), 같은 버전이 연달아 실패하면 44시간, 92시간,
    최대 7일. root 부분을 넣기 전에 실패하면(내려받기가 끊김, 해시가 다름, 디스크가 참) 1시간부터 두 배씩 최대 20시간이고,
    조용한 때를 기다린 사흘은 이어서 센다. 그사이 확인마다 내려받고 다시 시작하지 않는다. 그 버전은 서버의 앱 업데이트도
    건드리지 않고 타이머가 다시 시도한다. `sudo mycel-ctl status`에(앱이 0.2.19 이상이면 관리자 › 진단에도) 언제 다시
    시도하는지 보인다. `sudo mycel-ctl update`(root 부분이 이미 들어가 있으면 관리자 › 시스템 › 업데이트에서 바로 하는 업데이트도)는
    기다리지 않고 바로 다시 시도하고, 더 새 릴리스가 나오거나 업데이트가 되면 기다림이 끝난다.
  - 되돌려진 앱이 업데이트 시간을 알려 주지 못하는 옛 버전(0.2.18 이하)이면, root 부분 버전(`root/VERSION`)의 앱
    폴더에 있는 `admin.js`가 팀의 업데이트 시간과 시간대를 읽는다(읽기만). 그것도 안 되면 root가 마지막으로 받아 둔 시간,
    그다음은 `/etc/default/<id>`의 `MYCEL_TEAM_TZ`(없으면 서버 시계)로 03:00–05:00이다.
- **Dev environment helper (`root/mycel-boxd`)**: the kit has this program. The installer and `mycel-ctl update` put it in
  `/var/lib/mycel/root/`, root-owned, like `mycel-sandbox`. It runs only from there, never from a version folder. The file
  alone changes nothing: the dev environment stays off without `MYCEL_DEV_ENV=1` and the `mycel-boxd.service` unit
  (`scripts/dev-env/TRIAL.md`). A hosted server gets the file and no unit. `install-trial.sh` runs there only if the
  team's plan includes the dev environment (`root/dev-env.json`, root-owned), and boxd then caps each box at that file's
  values. On a server with the unit, `mycel-ctl update` restarts the unit only when the program changed, before the team server restarts. The
  restart stops the boxes that run; each starts again at its next use. A service that an administrator stopped stays
  stopped. A failed restart does not stop the update, and neither does a boxd that does not answer or says that boxes are
  not available: the result has a note. The update to the first release with this file runs the older `mycel-ctl`, which
  does not know the restart: run the new `scripts/dev-env/install-trial.sh` once after that update. It sees that the
  service runs a program other than the file and restarts it.
- **더 오래된 릴리스로 내려가지 않음**: `mycel-update.timer`와 `--version` 없는 `sudo mycel-ctl update`는 피드의 버전이 지금 돌고 있는 앱보다 새로울 때만 설치한다(서버의 앱 업데이트와 같은 버전 순서. 0.2.18-pre.1 같은 사전 릴리스가 돌면 0.2.17 피드는 건너뛰고 그렇게 적는다). 일부러 되돌리려면 버전을 준다: `sudo mycel-ctl update --version <버전>`(더 새 root 부분은 그대로 둔다).
- **단계적 배포**: 새 stable 릴리스는 모든 서버에 같은 밤 가지 않는다. 피드가 게시된 뒤 첫날 약 10%, 둘째 날 약 50%, 셋째
  날부터 모든 서버가 자동 업데이트로 받는다. 나쁜 릴리스가 닿는 팀이 적어진다. 서버마다 설치 id(`MYCEL_INSTALL_ID`, 없으면
  앱이 만든 id)와 릴리스마다 새로 정하는 값으로 차례가 정해지고, 각 서버가 피드의 서명된 `publishedAt`부터 스스로 센다. 서버의
  앱 업데이트, `mycel-update.timer`, 사무실 맥이 같은 규칙을 쓴다. 차례가 오면 그다음 업데이트 시간에 설치한다. 설치 id를 읽을
  수 없는 서버는 마지막 차례(100%)다. 앞 릴리스의 단계가 끝나기 전에 낸 릴리스는 그 단계를 이어서, 몇 시간 간격으로 여러 번 내도 첫 릴리스 뒤 이틀 안에 모든 서버에 닿는다. beta 채널, 급한 릴리스(`urgent`), 관리자가 직접 하는 업데이트(관리자 › 시스템 ›
  업데이트, `sudo mycel-ctl update`)는 기다리지 않는다. 차례를 기다리는 동안 `sudo mycel-ctl status`가 "this server's turn comes
  at …"을 보여 주고, 앱의 업데이트 상태(`GET /api/admin/update`)에 `turnAt`이 있다. 이 규칙을 모르는 0.4.0-beta.2 이하 서버는
  예전처럼 바로 받는다.
- 끄기·켜기: `sudo mycel-ctl auto-update off|on`(타이머와 `server.json`의 `update.auto`를 함께 바꾸고 답변이 없을 때 서버를
  다시 시작한다. 설치 때는 `--no-auto-update`/`--auto-update`). repair·update는 이 플래그가 없으면 지금 타이머 상태를 그대로
  둔다. 꺼져 있으면 `sudo mycel-ctl status`와 관리자 › 진단이 경고한다.
- **관리자 홈의 안내**: 새 버전이 나오면 소유자의 관리자 › 홈에 "새 버전 … 오늘 밤 03:00–05:00에 자동으로 설치돼요"처럼 언제 설치되는지 나온다(팀 시간대의 업데이트 시간). 자동 업데이트가 꺼져 있으면 같은 줄에 "지금 설치" 버튼이 있고, root 권한이 필요한 릴리스는 업데이트 타이머가 설치한다고만 나온다. 업데이트가 관리자에게 남기는 할 일(예: HWP 플러그인 켜기)도 관리자 › 홈에 버튼과 함께 나오고, "필요 없어요"로 끌 수 있다.
- **보관하는 버전**: 업데이트마다 버전 폴더 하나(`app/versions/<버전>`, 압축을 푼 크기 약 540 MB)가 생긴다. 서버가 켜진 지
  10분 뒤(bootstrap이 새 버전을 확인한 뒤)와 그 뒤 매시간, 되돌리기에 쓰는 것만 남기고 지운다. 서버 계정이 하므로 root 단계가 없다.
  - 남김: 지금 버전(`app/current`), 이전 버전(`app/state.json`의 `previous`. 관리자 › 시스템 › 업데이트 "되돌리기"와, 지금
    버전이 확인을 통과하지 못할 때 bootstrap이 돌아가는 곳), 받아 두고 아직 적용하지 않은 가장 새 버전, 하루 안에 바뀐 버전
    폴더(`mycel-ctl update`나 설치기가 막 넣고 전환하려는 것).
  - 지움: 그 밖의 버전 폴더, 끊긴 업데이트가 남긴 `.staging-*`·`*.partial`(하루 지난 것), `current`가 가리키지 않는 엔진 폴더
    `app/engines/<이름>/<sha12>`(설치기로 엔진을 바꾸고 하루 뒤). 링크는 따라가지 않고, 버전 이름이 아닌 것은 그대로 둔다.
    지울 폴더는 먼저 `.prune-<hex>`로 이름을 바꾼 뒤 지우고, 지우다 끊겨 남은 것은 하루 뒤에 지운다.
    그사이 바뀌었는데 원래 이름으로 돌릴 수 없는 폴더는 `.prune-hold-<hex>`로 남기고(지우지 않음), 이름을 바꾸거나 지울 때까지 진단에 보인다.
    다른 계정 소유 폴더(예: 중간에 멈춘 설치기가 남긴 root 폴더)는 진단에 알리고 root가 지우도록 남긴다.
    마운트 지점이거나 안에 마운트 지점이 있는 폴더는 지우지 않는다.
  - 업데이트가 진행 중(`state.json`의 `pending`)이면 그 회차는 건너뛴다.
  - 그래서 `app/`은 보통 1–1.5 GB다(버전 2–3개와 엔진). 진단(관리자 › 시스템 › 진단)의 "보관 중인 버전" 줄에 남긴 버전과 크기가 보인다.
  - 지금 하기: `trina_admin prune-versions --dry-run`(지울 것만 JSON으로 보여 줌, root로도 됨), `trina_admin prune-versions`(10장의 `trina_admin`, root로는 안 됨).
  - 0.2.16으로 처음 업데이트하면 그동안 쌓인 버전이 업데이트 10분 뒤 한 번에 지워진다. 시험(데비안 13 컨테이너)에서 버전 9개, 4.5 GB, 파일 약 4만 개에
    5초 걸렸다. 디스크가 느린 서버에서는 수십 초 걸릴 수 있고, 그동안 서버는 평소처럼 답한다.
  - 설치기로 더 오래된 키트를 넣은 경우(`older`, 지금 버전은 그대로) 그 버전은 하루 동안만 남는다. 그 안에 `admin.js switch <버전>`으로 바꾼다.
- 릴리스는 버전 태그로 나간다(`docs/RELEASE-CI.md`): 피드의 `server/<채널>.json` + `.sig`, 버전마다 업데이트 묶음과 kit.
  배포 스크립트가 root 부분을 두 채널의 현재 버전과 비교해 `rootSince`를 정한다. `needsRoot`는 `rootSince`를 모르는 0.2.18
  이하 서버를 위해 `rootSince`가 0.2.18보다 새로우면 켜 둔다(그런 서버의 앱이 root 부분 없이 새 앱을 받지 않도록).

### 8a. Windows 앱 (Windows app)

Windows 데스크톱 앱은 자기 팀 서버의 `/downloads/latest.yml`만 보고 업데이트한다(4시간마다, 앱을 닫을 때 설치). 리눅스 서버는
켜진 지 15분 뒤(업데이트 뒤에도 다시 켜짐)와 그 뒤 6시간마다 지금 돌고 있는 릴리스의 Windows 설치 파일과 `latest.yml`을
`data/downloads`에 넣는다. 설정 › 앱에도 그 파일이 보이고, 관리자 › 시스템 › 진단의 "Windows 앱" 줄에 마지막 결과가 보인다.
자동 업데이트를 끈 서버(`--no-auto-update`, `update.auto: false`)는 켜질 때만(곧 직접 업데이트한 뒤에만) 피드를 본다.

- 출처: 서버 피드와 같은 곳의 `office/<채널>.json`(서명됨). 서명, 두 파일의 크기·SHA-256, `latest.yml`이 그 설치 파일을 가리키는지
  확인한다. 서버보다 새 버전의 앱은 서버가 그 릴리스를 받은 뒤에 넣는다.
- Windows 설치 파일은 하나만 둔다(약 110 MB, 예전 것은 지움). 받고 나서 남는 공간이 팀 폴더의 쓰기 여유분(512 MB와 디스크의 2% 중
  큰 쪽)보다 적어지면 받지 않는다. 손으로 넣은 더 새 버전은 그대로 둔다.
- 이미 깔린 Windows 앱은 따로 할 일이 없다. 다음 확인 때 새 버전을 받는다.
- 지금 하기: `trina_admin desktop-refresh`(10장의 `trina_admin`, 결과는 JSON, root로는 안 됨). 받은 파일이 맞지 않던 버전은 하루
  뒤에 다시 시도하고, `--force`는 바로 다시 한다.
- 인터넷이 없는 서버: 다른 컴퓨터에서 서버 채널의 `https://updates.trina.app/office/stable.json`(beta 채널은 `beta.json`)과
  거기 적힌 Windows 설치 파일, `latest.yml`(`office/<버전>/`)을 받아 서버 계정이 읽을 수 있는 한 폴더에 두고
  `trina_admin desktop-refresh --from /전체/경로`(상대 경로는 안 됨: `trina_admin`은 `/`에서 돈다). 똑같이 확인한다. 그 릴리스가
  서버보다 새로우면 넣지 않으니(`ahead`) 서버를 먼저 업데이트한다. 결과가 `offered`·`current`·`newer`(직접 올린 더 새 설치 파일)가
  아니면 0이 아닌 값으로 끝난다.
- 채널이 이미 더 새 릴리스로 넘어갔으면 서버는 자기 릴리스의 서명된 매니페스트(`office/<버전>/<채널>.json`, 0.2.19부터 릴리스마다
  피드에 남김)를 대신 쓴다.
- 사무실 모드(맥)는 자기 업데이트 에이전트가 같은 일을 한다. 호스팅 서비스의 팀 서버는 켜질 때마다(서비스의 업데이트가 다시 켬)
  한 번만 자기 피드에서 받고, 결과는 진단에 보인다.

## 9. 요금제 파일(선택)과 자원 한도

자체 설치는 요금제 파일이 없어도 된다(인원 제한 없음, 동시 실행은 관리자가 1–16). 파일을 두면 서버와 실행기가 따른다:

```json
{ "format": 1, "plan": "team", "maxConcurrency": 3, "memoryMiB": 4096, "cpuCores": 2, "diskGiB": 50,
  "maxActiveMembers": 12, "readMaxMiB": 128, "localBackupRetentionDays": 7 }
```

`sudo mycel-ctl apply-plan < plan.json`(root 소유 `/var/lib/mycel/root/plan.json`, 서버 계정은 읽기만). 바로 반영되고
재시작이 필요 없다. 동시 실행 = min(관리자 설정, `maxConcurrency`), 인원(활성 계정) = `maxActiveMembers`까지(넘으면 409
`plan_limit`), 로컬 백업 보존일 = `localBackupRetentionDays`. 스키마는 `shared/src/cloud-protocol/files.ts`의 `PlanFile` 하나다
(Trina AX Cloud가 더 쓰는 `display`·`links`는 관리자 › 시스템 › 요금제 카드에 보인다). 파일이 있으면 그 카드가 생긴다.

리눅스에서는 요금제 파일이 없어도 서버의 보조 프로그램이 코어를 다 쓰지 않는다(ripgrep 2스레드, 받아쓰기 최대 4스레드,
의미 검색 모델 2스레드, 32 MB 넘는 엑셀·한글 파일은 서버 안에서 읽지 않음). 대기열은 팀 max(10, 4×동시 실행), 한 사람 3개까지.

Voice input is off by default. In Admin › Team settings › Voice input, pick OpenRouter (the team's API key; audio goes
to OpenRouter) or this server (whisper.cpp; on 2 vCPU a 2 s clip takes 10–38 s). On small servers, use OpenRouter. The
server account can reach public https hosts (openrouter.ai), so the firewall needs no change.

### 9a. 안전한 PowerPoint(1A, 선택)

기밀 문서용 PowerPoint 만들기(`docs/SAFE-OPS-1A.md`)는 기본으로 꺼져 있다. 켜기·끄기·상태:

```sh
sudo mycel-ctl safe-ops on       # 확인 → root 소유 변환 프로그램 → MYCEL_SAFE_OPS_1A=1 → 자원 그룹 한도 → 재시작
sudo mycel-ctl safe-ops status   # 준비됐는지, 아니면 무엇이 빠졌는지
sudo mycel-ctl safe-ops off
```

- 서버와 AI 엔진은 늘 `mycel.slice` 한 그룹에서 돈다. 1A가 켜져 있는 동안만 이 그룹에 한도가 붙는다:
  메모리 `min(4 GiB, 서버 메모리 − 512 MiB)`, 스왑 없음, 작업 512개, CPU 최대 4개. 큰 서버에서도 1A를 켠 동안에는 팀 전체가
  이 안에서 돈다. 메모리가 2304 MiB보다 적은 서버는 켜지 않는다.
- 1A 작업은 root 소유 실행 파일만 돌린다. 설치기와 `mycel-ctl update`가 `mycel-safeops`·`pandoc`의 root 소유 사본을
  `/var/lib/mycel/root/safe-ops/`에 둔다(검증된 키트·묶음에서만). `--allow-unsigned`로 설치한 서버에 사본이 없으면 키트로
  `sudo ./install-linux.sh update --from <키트>`를 실행한다.
- 켜고 끌 때 서버와 실행기가 다시 시작된다(진행 중인 답은 멈춘다). 1A 작업을 한 채팅은 끈 뒤에도 웹·커넥터·브라우저 없이
  남는다. 1A 작업을 하지 않은 채팅은 끄면 원래대로 돌아온다.
- 관리자 › 시스템 › 진단의 "안전한 PowerPoint(1A)"가 준비 상태나 빠진 것과 고칠 명령을 보여 준다.

## 10. 저장 공간·백업과 복원

- 관리자 › 시스템 › 저장 공간: 디스크 사용률과 항목별 크기(팀 파일, 파일 기록, 휴지통, 백업, 모델, 서버 데이터, 앱, 기타).
  "앱"은 보관 중인 버전과 엔진이다. 오래된 버전은 서버가 지운다(8장 "보관하는 버전").
  80%가 넘으면 owner·관리자에게 하루 한 번 알린다. 남은 공간이 max(512 MB, 2%) 아래로 내려가면 저장·업로드·AI의 파일 쓰기를
  받지 않는다(507). 휴지통 비우기, 파일 기록 보존일 줄이기(관리자 › 설정)로 공간을 만든다.
- 로컬 백업: 매일 팀 시간대 03:00 이후, `/var/lib/mycel/team/.system/backups`(DB는 `data/backups`), 14일.
- 다른 곳에 두기(권장): `admin.js archive`로 age 암호화 아카이브를 만들어 서버 밖에 보관한다(비밀값 제외).
- 오래된 기록 정리: 도구 기록(감사 보존일, 기본 90일), 파일 활동(1년 이상), 턴(400일, 채팅마다 마지막 턴은 남김)은 자동으로 지운다.

### 백업·복구 명령 (기본 설치)

```sh
trina_admin() (
  cd / && sudo -u axserver env MYCEL_CONFIG=/var/lib/mycel/config/server.json \
    /var/lib/mycel/app/current/bin/bun /var/lib/mycel/app/current/server/src/admin.js "$@"
)
trina_admin backup --scope full
trina_admin list-backups
trina_admin archive --out /var/lib/mycel/data/off-host.tar.zst.age --password-stdin
```

암호는 8자 이상이며 비공개 터미널에서 echo를 끄거나 암호 관리자에서 표준 입력으로 전달하고 EOF로 끝내세요. 명령 인자·로그에 넣지 마세요. `encrypted: true`를 확인하고 mode 600 보관본을 보호된 외부 저장소로 복사해 양쪽 SHA-256을 비교합니다. 암호는 별도로 보관합니다.

- DB만 복원: 현재 백업 후 관리자 → 시스템 → 백업 → 복원(암호 확인), 또는 `trina_admin stage-restore --backup ID`. `sudo systemctl restart mycel-server` 뒤 모든 사용자가 다시 로그인합니다. 팀 파일은 그대로이며 이전 DB는 `data/backups/before-restore-*`에 남습니다.
- 파일만 복구: `trina_admin restore-team --backup ID --to /var/lib/mycel/data/recovered-team`. 새 폴더로 복구하며 전체·증분 백업 묶음이 모두 필요합니다. 비교 후 필요한 파일만 앱으로 되돌립니다.
- 보관본 연습: `trina_admin restore-archive --in /var/lib/mycel/data/off-host.tar.zst.age --to /var/lib/mycel/data/recovery-drill --password-stdin`. 새 폴더의 `db/app.sqlite`와 `team/`을 확인합니다. 추출 자체는 서버나 세션을 바꾸지 않습니다.
- 새 서버: 호환 버전을 설치하고 새 폴더에 추출한 뒤 서비스를 멈추고 운영자가 DB·팀 파일을 올바른 소유권으로 배치해야 합니다. 설정·서비스·CA·비밀 키는 보관본에 없으므로 새 설치에서 준비하고 연결을 재인증합니다. 이 전체 새 장비 복구는 검증되지 않았습니다.

앱 롤백은 DB·팀 파일을 되돌리지 않습니다. 업데이트 전 백업과 호환 버전을 사용하세요. 복구 뒤 SQLite 무결성, 알려진 파일, 두 계정의 권한, 스킬, 진단·백업 일정을 확인하고 새 백업을 만듭니다. 실행 중인 DB를 단순 `cp`로 백업하지 마세요.

## 11. 문제 해결

- 관리자 › 시스템 › 진단: 방화벽(nftables), 실행기, 샌드박스(bwrap·Landlock·seccomp), 커널 격리(ptrace_scope·cgroup·사용자
  네임스페이스), 안전한 PowerPoint(1A를 켰을 때), 저장 공간, 백업, 업데이트. 고칠 명령을 함께 보여 준다.
- `sudo mycel-ctl status`, `journalctl -u mycel-server -u mycel-launcher -n 200`.
- 자주 보는 실패:
  - 우분투 24.04에서 샌드박스 실패: AppArmor가 사용자 네임스페이스를 막음. 설치기가 bwrap 전용 프로필을 넣는다(`repair`로 다시).
  - 컨테이너 안 설치: `nesting=1`이 없으면 bwrap의 `/proc` 마운트가 실패한다. 호스트 설정이 필요하다.
  - "방화벽 확인이 멈췄어요": `systemctl status mycel-firewall.timer`. 다른 도구가 nftables를 비웠으면 `sudo mycel-ctl firewall apply`.
  - 커널이 오래됨(6.12 미만): 진단 "커널 격리"·"샌드박스"가 경고. 배포판 커널을 올린다.

## 12. 보안 모델(요약)

- AI 엔진은 턴마다 bwrap 샌드박스에서 돈다: 자기 채팅 폴더만 보이고, 실행할 수 있는 것은 엔진과 도구 다리뿐(Landlock), 다른 턴의
  프로세스는 보이지 않으며(pid 네임스페이스), 위험한 시스템 호출은 막힌다(seccomp). 팀 파일은 서버가 권한 함수로 거른 결과만 준다.
- 엔진 계정의 네트워크는 nftables로 `127.0.0.1:<모델 프록시 포트>`뿐이다. 진짜 AI 자격 증명은 서버에만 있다.
- 이 서버에서 하지 말 것: 엔진 계정(`axagent`)에 다른 일 시키기, nftables 표 지우기, `kernel.yama.ptrace_scope`를 0으로.

## 13. 제거

```sh
sudo ./install-linux.sh uninstall              # 앱·실행기·유닛 삭제, 데이터(data/ team/ config/ secrets/)는 남김
sudo ./install-linux.sh uninstall --purge      # 전부 삭제, 계정도 삭제
```

제거하면 `/etc/default/<id>`의 `MYCEL_SAFE_OPS_1A` 줄도 지운다(다시 설치하면 1A는 꺼진 채로 시작한다). 그 파일의 다른 줄은 남는다.
