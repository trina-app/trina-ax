# 리눅스 서버에 설치하기 (자체 설치)

같은 코드를 세 가지로 쓴다: **Team AX Cloud**(우리가 호스팅, 가장 쉬움), **자기 리눅스 서버**(이 문서, 무료), **사무실 맥 미니**
(`docs/OFFICE.md`). 호스팅도 이 문서와 같은 설치 키트(`install-linux.sh` + 리눅스 번들)를 `--hosted`로 쓴다.

릴리스 키트와 설치기는 공개되어 있습니다. [GitHub Releases](https://github.com/trina-app/trina-ax/releases)에서
게시된 버전과 파일을 확인하세요. 이 문서는 설치 절차를 설명하며 모든 배포판·장비에서의 동작 보장은 아닙니다.

v0.2.3은 GitHub Releases에서만 배포하며 트리나 업데이트 피드는 아직 운영하지 않습니다. 아래 피드 기반 자동 업데이트 설명은 운영자가 유효한 피드를 제공한 경우에만 적용됩니다. 현재는 새 릴리스 키트와 설치기를 사용하세요.

## 1. 이런 경우에 씀

- 회사 서버나 클라우드 VM(우리 호스팅이 아닌 곳)에 팀 서버를 직접 둘 때. 파일을 회사 서버에 보관하려는 경우. 단, AI가 읽는 문맥은 모델 제공사로 전송된다.
- 맥 미니 없이 리눅스 한 대로 팀(약 20명까지)을 받을 때.
- 한 서버 = 한 팀이다. 여러 팀이면 팀마다 VM(또는 LXC 컨테이너)을 하나씩 둔다.

## 2. 요구 사항

| 항목 | 값 |
|---|---|
| OS | 데비안 13(권장), 데비안 12, 우분투 24.04. 우분투 22.04·RHEL 계열은 받지 않음(설치 점검이 거부) |
| CPU | amd64(SSE4.2 이상) 또는 arm64 |
| 메모리 | 4 GB 이상 권장(2 GB면 동시 실행 1) |
| 디스크 | 20 GB 이상(팀 파일 + 버전 기록 + 휴지통 + 로컬 백업) |
| 커널 | 6.12 이상 권장. 그 미만은 턴끼리 추상 소켓·시그널을 막지 못함(진단이 경고) |
| 기타 | systemd(PID 1), cgroup v2, 인터넷(설치·업데이트·AI 모델) |

설치 전에 바꾸지 않고 확인만 한다:

```sh
sudo ./install-linux.sh check --from .
```

## 3. 키트 받기와 확인

릴리스 키트는 GitHub Releases에 있다(태그 `v<버전>`마다 amd64·arm64 키트, `SHA256SUMS`와 서명).

```sh
V=0.2.3   # 받을 버전
curl -fLO https://github.com/trina-app/trina-ax/releases/download/v$V/TrinaAX-server-$V-linux-amd64.tar.gz   # arm64면 linux-arm64
tar xzf TrinaAX-server-$V-linux-amd64.tar.gz && cd TrinaAX-server-$V-linux-amd64
./app/$V/root/mycel-ctl verify-bundle ./app/$V      # 릴리스 서명 확인(공개 키 내장)
```

설치기도 같은 확인을 한다(`--allow-unsigned`가 아니면 서명 없는 묶음을 받지 않음).

### 3a. 소스에서 키트 만들기 (릴리스가 없을 때, 개발용)

키트를 만들 리눅스 기계에서(설치할 서버와 같은 아키텍처). 2026-10-28 Lightsail 데비안 13(2 vCPU, 4 GB)에서 확인했다.
2 vCPU에서 whisper 빌드가 약 10분, 키트 만들기가 몇 분 걸린다.

```sh
sudo apt-get install -y git curl unzip ca-certificates xz-utils zstd build-essential cmake
# Go(native/go.mod의 버전, 예: 1.27.x)는 https://go.dev/dl/ 에서 /usr/local/go로, Bun은 고정 버전으로:
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.12"
export PATH=$HOME/.bun/bin:/usr/local/go/bin:$PATH

git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile
ARCHS=amd64 bash native/build.sh                                   # arm64면 ARCHS=arm64
bash scripts/linux/build-whisper.sh --arch amd64 --out dist/whisper   # 음성 받아쓰기(없으면 --no-whisper)
bun run build:web                                                  # 웹 앱. 빠뜨리면 키트에 앱 화면이 없다
bun scripts/build-bundle.ts --os linux --arch amd64 --version 0.2.2-dev.1 --whisper-dir dist/whisper --out dist/linux
cd dist/linux && sudo ./install-linux.sh install --from . --allow-unsigned --engine claude
```

- 직접 만든 키트는 서명이 없으므로 `--allow-unsigned`가 필요하고, 진단이 그렇다고 알린다.
- 스캔 PDF·사진의 글자 읽기(OCR, `mycel-ocr`)는 지금 macOS에서만 빌드된다. 리눅스 서버는 글자가 들어 있는 PDF·문서만 읽는다.

## 4. 설치

```sh
sudo ./install-linux.sh install --from . --engine claude --engine codex
```

- 계정 `axserver`(서버)·`axagent`(AI 엔진)을 시스템 계정으로 만든다. 모든 파일은 `/var/lib/mycel` 아래.
- 필요한 패키지(bubblewrap, nftables, poppler-utils, tesseract-ocr(kor, eng), ffmpeg …)를 apt로 설치한다(`--skip-apt`로 끔).
- 엔진 바이너리는 공식 주소에서 받아 고정된 SHA-256과 비교한다(번들에 넣지 않음).
- 방화벽(nftables)을 먼저 넣고, 실패하면 설치를 멈춘다: AI 엔진 계정은 `127.0.0.1:<모델 프록시 포트>` 말고는 아무 데도 못 나간다.
- systemd 유닛: `mycel-firewall.timer`, `mycel-launcher.service`, `mycel-server.service`, `mycel-update.timer`.
- 마지막 줄이 `installed …`이면 성공. 실패하면 이유를 출력하고 1로 끝난다.

자주 쓰는 옵션: `--id ID`(한 서버에 시험 설치를 하나 더), `--port N`(기본 47820), `--proxy-port N`(기본 47821),
`--tls-port N`(사무실 안 직접 연결, 기본 끔), `--no-auto-update`, `--plan FILE`(요금제 파일, 아래 9장).

## 5. 첫 설정

서버에는 화면이 없으므로 SSH 터널로 연다.

```sh
sudo cat /var/lib/mycel/setup/code                      # 설치 코드(서버가 읽는 data/setup-token과 같은 값)
ssh -L 47820:127.0.0.1:47820 <서버>                     # 내 PC에서
# 브라우저: http://127.0.0.1:47820/setup?token=<설치 코드>
```

팀 이름, 언어, owner 계정을 만든다. **팀 시간대는 이 브라우저의 시간대로 정해진다**(관리자 › 설정 › 팀 시간대에서 바꿈).
오늘·이번 달 사용량, 예약 작업, 야간 백업이 이 시간대를 따른다(서버 자체는 보통 UTC로 돈다).

## 6. AI 연결

- owner가 브라우저에서 **관리자 › AI 연결**로 연결한다: Claude(구독의 `claude setup-token` 붙여 넣기 또는 Anthropic API
  키), Codex(ChatGPT 기기 로그인 또는 OpenAI API 키). 진짜 토큰·키는 서버의 열쇠로 봉인되고 AI 엔진에는 가지 않는다(모델
  프록시가 요청마다 바꿔 끼움). 자체 설치는 네 종류를 다 쓸 수 있고(구독을 팀이 함께 쓸 때의 약관 안내가 화면에 뜸),
  `server.json`의 `engine.credentialKinds`로 좁힐 수 있다. 호스팅도 기본으로 네 종류를 지원하지만 실제 허용 범위는 운영 설정과 제공사 약관을 따릅니다.
- CLI 대체(브라우저 연결이 안 될 때만): `sudo /var/lib/mycel/root/set-claude-token < 토큰파일`(표준 입력만),
  Codex는 `sudo mycel-ctl codex-login`. 다음 시작 때 AI 연결로 옮겨진다.
- 팀 API 엔진(OpenAI 호환, 실험 단계)은 관리자 › AI 엔진 › API 엔진. 자체 설치는 사내 주소(예: 로컬 Ollama)도 된다.

## 7. 팀원 연결

- 중계: `https://<팀>.trina.app`(관리자 › 시스템 › 연결). 서버는 밖으로만 연결하므로 열 포트가 없다. 공식 중계는
  등록이 닫혀 있어(작업 증명만으로는 `registration_closed`) 계정 콘솔의 공식 중계 애드온에서 받은 **연결 코드**를 함께
  넣는다. 자체 중계(`self-relay`)는 코드 없이 된다.
- 사무실 안 직접 연결: 설치 때 `--tls-port 8443`. 서버의 방화벽(ufw·firewalld)에서 그 포트를 연다.

## 8. 업데이트

현재 공개 Trina 피드는 미운영입니다. 새 GitHub Release 키트의 체크섬·서명을 확인하고 기존 설치를 백업한 뒤 설치기를 다시 실행하세요. 아래 자동화는 운영자가 유효한 피드를 제공하는 경우의 동작입니다.

- **앱만 바뀌는 릴리스**: 서버가 스스로 적용한다(`server.json`의 `update.auto: true`, 설치기가 자체 설치에 켬). 팀 시간대의
  업데이트 창(관리자 › 설정 › 업데이트 시간, 기본 03:00–05:00) 안에서, 답변이 하나도 돌지 않을 때만. 새 버전이 켜지지 않으면
  bootstrap이 이전 버전으로 되돌리고, 그 버전은 7일 동안 자동으로 다시 시도하지 않는다. 피드의 단계적 배포(`rollout`)를 따른다.
- **root 부분(실행기·샌드박스·유닛)이 바뀌는 릴리스**: 관리자 › 시스템 › 업데이트에 "관리자 권한 필요"가 보이고 진단이 경고한다.
  `mycel-update.timer`(매일 04:30 ± 90분)가 처리하거나 직접 `sudo mycel-ctl update`.
- 끄기: 설치 때 `--no-auto-update`(타이머 끔), `server.json`의 `update.auto`를 `false`(앱 자동 업데이트 끔).
- 릴리스는 버전 태그로 나간다(`docs/RELEASE-CI.md`): 피드의 `server/<채널>.json` + `.sig`, 버전마다 업데이트 묶음과 kit.
  `needsRoot`(root 부분이 바뀌었는지)는 배포 스크립트가 두 채널의 현재 버전과 비교해 정한다.

## 9. 요금제 파일(선택)과 자원 한도

자체 설치는 요금제 파일이 없어도 된다(인원 제한 없음, 동시 실행은 관리자가 1–16). 파일을 두면 서버와 실행기가 따른다:

```json
{ "format": 1, "plan": "team", "maxConcurrency": 3, "memoryMiB": 4096, "cpuCores": 2, "diskGiB": 50,
  "maxActiveMembers": 12, "readMaxMiB": 128, "localBackupRetentionDays": 7 }
```

`sudo mycel-ctl apply-plan < plan.json`(root 소유 `/var/lib/mycel/root/plan.json`, 서버 계정은 읽기만). 바로 반영되고
재시작이 필요 없다. 동시 실행 = min(관리자 설정, `maxConcurrency`), 인원(활성 계정) = `maxActiveMembers`까지(넘으면 409
`plan_limit`), 로컬 백업 보존일 = `localBackupRetentionDays`. 스키마는 `shared/src/cloud-protocol/files.ts`의 `PlanFile` 하나다
(Team AX Cloud가 더 쓰는 `display`·`links`는 관리자 › 시스템 › 요금제 카드에 보인다). 파일이 있으면 그 카드가 생긴다.

리눅스에서는 요금제 파일이 없어도 서버의 보조 프로그램이 코어를 다 쓰지 않는다(ripgrep 2스레드, 받아쓰기 최대 4스레드,
의미 검색 모델 2스레드, 32 MB 넘는 엑셀·한글 파일은 서버 안에서 읽지 않음). 대기열은 팀 max(10, 4×동시 실행), 한 사람 3개까지.

## 10. 저장 공간·백업과 복원

- 관리자 › 시스템 › 저장 공간: 디스크 사용률과 항목별 크기(팀 파일, 파일 기록, 휴지통, 백업, 모델, 서버 데이터, 앱, 기타).
  80%가 넘으면 owner·관리자에게 하루 한 번 알린다. 남은 공간이 max(512 MB, 2%) 아래로 내려가면 저장·업로드·AI의 파일 쓰기를
  받지 않는다(507). 휴지통 비우기, 파일 기록 보존일 줄이기(관리자 › 설정)로 공간을 만든다.
- 로컬 백업: 매일 팀 시간대 03:00 이후, `/var/lib/mycel/team/.system/backups`(DB는 `data/backups`), 14일.
- 다른 곳에 두기(권장): `admin.js archive`로 age 암호화 아카이브를 만들어 서버 밖에 보관한다(비밀값 제외).
- 오래된 기록 정리: 도구 기록(감사 보존일, 기본 90일), 파일 활동(1년 이상), 턴(400일, 채팅마다 마지막 턴은 남김)은 자동으로 지운다.

## 11. 문제 해결

- 관리자 › 시스템 › 진단: 방화벽(nftables), 실행기, 샌드박스(bwrap·Landlock·seccomp), 커널 격리(ptrace_scope·cgroup·사용자
  네임스페이스), 저장 공간, 백업, 업데이트. 고칠 명령을 함께 보여 준다.
- `sudo mycel-ctl status`, `journalctl -u mycel-server -u mycel-launcher -n 200`.
- 자주 보는 실패:
  - 우분투 24.04에서 샌드박스 실패: AppArmor가 사용자 네임스페이스를 막음. 설치기가 bwrap 전용 프로필을 넣는다(`repair`로 다시).
  - 컨테이너 안 설치: `nesting=1`이 없으면 bwrap의 `/proc` 마운트가 실패한다. 호스트 설정이 필요하다.
  - "방화벽 확인이 멈췄습니다": `systemctl status mycel-firewall.timer`. 다른 도구가 nftables를 비웠으면 `sudo mycel-ctl firewall apply`.
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
