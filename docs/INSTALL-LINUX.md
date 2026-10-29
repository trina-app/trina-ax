# 리눅스에 직접 설치하기

[English](INSTALL-LINUX.en.md) · [IT 체크리스트](for-admins.ko.md)

전용 서버나 VM을 사용하세요. **systemd가 PID 1이어야 하고 cgroup v2가 필요합니다. 일반 Docker 컨테이너는 운영 설치 대상이 아닙니다.** 점검을 우회하지 마세요. 로컬 데모는 별도의 개발 환경입니다.

## 1. 요구 사항

| 항목 | 요구 사항 |
|---|---|
| OS | Debian 13 권장, Debian 12 또는 Ubuntu 24.04. Ubuntu 22.04·RHEL 계열은 설치기가 거절 |
| CPU | SSE4.2 이상 amd64 또는 arm64 |
| 메모리·디스크 | RAM 4 GB 권장(2 GB는 동시 실행 1), 디스크 최소 20 GB + 파일·기록·백업 공간 |
| 커널 | 6.12 이상 권장. 이전 커널의 격리 한계는 진단에 표시 |
| 도구·접근 | sudo, curl, tar, 체크섬 확인용 Python 3, 설치·업데이트·AI용 인터넷 |
| 운영 | 담당자, 허용된 AI 계정, HTTPS 주소 계획, 외부 백업 장소 |

설치 요구 사항이며 처리 인원 실측 보장은 아닙니다. 설치 하나가 팀 하나입니다.

HWP/HWPX 텍스트 추출은 지원합니다. 실험용 시각 미리보기는 소스에 포함됐지만 기본 꺼짐이며 기본 릴리스에는 실행 도구가 포함되지 않습니다. Debian 12는 시각 미리보기를 지원하지 않습니다(glibc 2.36, 고정 렌더러는 2.39 필요). 원본 다운로드와 텍스트 추출은 유지됩니다. [런타임 한계와 출시 조건](../resources/hwp/README.md)을 확인하세요.

## 2. 다운로드 → 확인 → 사전 점검

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

## 3. 설치

```sh
sudo ./install-linux.sh install --from . --engine claude --engine codex
sudo mycel-ctl status
```

`axserver`·`axagent` 계정, `/var/lib/mycel` 설치 경로, 샌드박스·방화벽과 systemd 유닛을 구성합니다. 엔진은 고정 버전으로 내려받습니다. 앱 포트는 기본 loopback 47820입니다. `--id`·`--port`·`--proxy-port`·`--no-auto-update`는 고급 옵션입니다. 유지보수 시 같은 설치 식별자를 쓰세요.

## 4. 첫 설정

담당자 PC에서 `ssh -L 47820:127.0.0.1:47820 <서버>`로 터널을 엽니다. 서버의 `/var/lib/mycel/setup/code`를 관리자 권한으로 로컬에서 확인하고 비공개로 보관하세요. loopback 설정 화면에 입력해 소유자·팀 이름·언어를 만들고 시간대를 확인합니다.

**권한 → AI 연결 → 팀원 초대 → 첫 스킬 → 첫 백업** 순서로 진행하세요.

1. 관리 → 그룹·폴더에서 자료 접근 범위를 정하고 두 계정으로 확인합니다.
2. 소유자가 관리 → AI 연결에서 허용된 Claude·Codex 계정 또는 API 키를 연결합니다. 새 팀 구독 공유는 기본 켜짐, 저장된 기존 선택은 유지, 개인 연결 우선이며 연결별 동의가 필요합니다. 제공사 약관상 허가는 별개입니다. 연결 등록은 HTTPS에서 하세요.
3. 초대 전에 HTTPS 주소를 준비합니다. 별도 터널·프록시가 `127.0.0.1:47820`에 연결되게 하고 `sudo ./install-linux.sh repair --public-host team.example.com`으로 등록합니다. 터널 자격 증명은 설치기 밖에서 관리합니다. 공식 중계는 발급받은 연결 코드가 필요하며 무료 주소 신청 기능이 아닙니다.
4. 소수 팀원을 초대하고 [스킬 예제](../examples/README.ko.md)를 복사한 뒤 결과를 원본과 비교합니다.
5. 백업을 만들고 [복구 연습](BACKUP-RESTORE.md)을 합니다.

## 5. 업데이트·롤백

[최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)의 관리자 조치를 읽고 전체 백업·암호화 외부 보관본을 만든 뒤 진단을 확인하세요. 서명된 피드는 `https://updates.trina.app/server/stable.json`입니다. 앱 업데이트는 설정된 시간대에 실행 중인 답변이 없을 때 적용할 수 있습니다. root 변경은 타이머나 `sudo mycel-ctl update`가 처리합니다. 이후 상태·로그인·허용된 파일 열기를 확인하세요.

수동 업데이트는 새 키트를 위 순서로 검증한 뒤 `sudo ./install-linux.sh update --from .`을 실행합니다. 시작 실패 시 앱 롤백이 가능하지만 DB 마이그레이션·파일 변경까지 되돌리지 않습니다. 이전 바이너리가 미래 DB를 항상 읽는다고 가정하지 마세요. 필요하면 호환 버전과 검증한 업데이트 전 백업으로 복구합니다.

## 6. 백업·복원·제거

[백업·복원 안내](BACKUP-RESTORE.md)는 DB만 복원하기, 팀 파일, 암호화 보관본, 소유권과 새 장비 복구 한계를 설명합니다. 같은 디스크의 백업만으로 재해 복구가 되지는 않습니다.

```sh
sudo ./install-linux.sh uninstall
```

서비스·앱을 제거하되 데이터를 남깁니다. 외부 복구본을 검증한 뒤에만 `uninstall --purge`로 데이터·계정까지 지울 수 있습니다. 설치 식별자와 경로를 먼저 확인하세요.

## 7. 문제 해결·FAQ

관리 → 시스템 → 진단과 `sudo mycel-ctl status`를 확인하세요. `journalctl -u mycel-server -u mycel-launcher -n 100`은 로컬에서 확인하고 공유 전 가리세요. systemd가 없으면 적절한 VM으로 옮기세요. Ubuntu 샌드박스·AppArmor 문제는 격리를 끄지 말고 설치기로 복구하세요. [문제 해결](TROUBLESHOOTING.md) · [FAQ](FAQ.ko.md) · [설정](CONFIGURATION.md).

서명 없는 소스 빌드는 개발용 고급 경로입니다. 소스 버전에서 고유한 `-dev` 버전을 정하고 폐기 가능한 호스트에서만 명시적으로 허용하세요. 일반 업데이트 방식이 아닙니다. [개발 안내](DEVELOPMENT.md).
