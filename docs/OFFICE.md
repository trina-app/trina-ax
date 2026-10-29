# 사무실 맥 한 대로 시작하기

[English](OFFICE.en.md) · [IT 체크리스트](for-admins.ko.md)

Mac에서 트리나 AX를 실행하고 팀원은 브라우저로 접속합니다. **로그인한 Mac 사용자**로 실행하며 Linux·역할 계정 Mac의 OS 계정 분리와 다릅니다. 로그아웃하면 중단되므로 전용 장비를 사용하세요. 클라우드 AI에는 인터넷이 필요합니다. 파일을 로컬에서 본다고 AI가 오프라인으로 실행되지는 않습니다. 이 방식은 Codex를 제공하지 않습니다.

## 1. 준비물·다운로드

macOS 13 이상, Apple Silicon 또는 Intel, 전용 로그인 계정, FileVault, 인터넷(유선 권장), 허용된 Claude 연결이 필요합니다. Mac 처리 용량의 실측 보장은 없습니다. ZIP에 런타임 도구가 있어 받는 사람은 Git·Go·Bun을 설치하지 않아도 됩니다. 설치기를 실행하기 전에 Claude Code를 별도로 설치하세요. ZIP에는 포함되지 않습니다. 기본 local-login 방식에서는 전용 Mac 사용자로 `claude`를 실행해 허용된 계정으로 로그인하고, `claude auth status`에서 로그인 상태를 확인하세요. 또는 허용된 `claude setup-token` 출력을 보호된 파일에 저장해 `--claude-token-file /path/to/token-file`로 설치기에 전달할 수 있습니다. 개인 구독이 자동으로 팀 사용 권한을 주는 것은 아니므로 계정·요금제의 허용 범위를 확인하세요.

[최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)에서 `TrinaAX-office-<버전>-mac.zip`과 `SHA256SUMS`를 받으세요. 와일드카드의 최신 파일 대신 정확한 파일 이름을 사용합니다. 내부 폴더는 `TrinaAX-office-<버전>/`이고 `office-install.sh`, `app/docs/OFFICE.md`가 있습니다. **PDF는 선택 빌드 산출물로 ZIP에 있다고 보장하지 않습니다.** 포함된 Markdown 또는 온라인 가이드를 읽으세요.

아래 `VERSION`을 실제 받은 버전으로 바꾸세요. 출력한 체크섬을 같은 릴리스의 `SHA256SUMS`와 비교한 뒤 진행합니다.

```sh
# Select the exact ZIP downloaded from the latest release; replace VERSION.
OFFICE_ZIP="$HOME/Downloads/TrinaAX-office-VERSION-mac.zip"
shasum -a 256 "$OFFICE_ZIP"
# Compare with the matching SHA256SUMS from that release before unpacking.
ditto -x -k "$OFFICE_ZIP" "$HOME/Downloads"
OFFICE_DIR="${OFFICE_ZIP%-mac.zip}"
bash "$OFFICE_DIR/office-install.sh" --check-only
bash "$OFFICE_DIR/office-install.sh"
```

체크섬은 손상 확인이며 독립적인 진위 증명은 아닙니다. 릴리스·소스를 검토하세요. `--check-only`는 설치 없이 사전 점검합니다. sudo 없이 기본 `~/TeamAX`에 설치됩니다. 출력된 로컬 첫 설정 링크를 사용하고 토큰은 공개하지 마세요. 인터넷을 통한 첫 설정은 거절됩니다.

## 2. 주소와 첫 설정

터널 옵션 없이 설치하면 출력된 로컬 주소에서 소유자를 만듭니다. LAN에서는 `https://<Mac-IP>:8443`을 쓰며 사무실 인증기관(CA)을 먼저 검증·설치합니다. `~/TeamAX/teamax card`의 지문과 별도 경로로 비교하고 한 대에서 먼저 시험하세요. HTTP 8442는 인증서 배포용이며 로그인 정보를 입력하는 주소가 아닙니다.

선택적인 인터넷 HTTPS 주소는 도메인과 별도로 만든 Cloudflare Tunnel이 필요합니다. 준비된 주소·토큰 파일로 설치 명령에 `--public-host team.example.com --tunnel-token-file /path/to/token-file`을 붙입니다. 운영 담당자가 준비하는 절차이며 호스팅 자동 가입이 아닙니다. 파일을 보호하고 설치 후 전달용 사본을 지우세요. 이후 `~/TeamAX/teamax public-address status`로 확인합니다. 앱 포트를 바꾸면 터널 대상 포트도 바꿔야 합니다. 인증된 다운로드에 캐시 규칙을 적용하지 마세요.

소유자 생성 후 **권한 → AI 연결 → 팀원 초대 → 첫 스킬 → 첫 백업** 순서로 진행합니다. 두 계정의 파일 접근을 확인하고 허용된 Claude 연결을 점검한 뒤 소수 팀원을 초대합니다. [스킬 예제](../examples/README.ko.md)를 복사하고 [백업·복구](BACKUP-RESTORE.md)를 연습하세요. office local-login은 이 Mac의 CLI 연결을 사용하며 Linux 관리형 연결 선택기와 같다고 가정하면 안 됩니다. 새 팀 구독 공유는 기본 켜짐이고 기존 선택은 유지됩니다. 관리형 연결을 쓸 때에는 연결별 동의도 필요합니다. 이 설정이 제공사 약관상 허가는 아닙니다.

## 3. 운영·업데이트·롤백

```sh
~/TeamAX/teamax status
~/TeamAX/teamax logs
~/TeamAX/teamax backup
~/TeamAX/teamax update status
~/TeamAX/teamax update now
```

릴리스 설명을 읽고 암호화한 외부 백업을 검증한 뒤 업데이트하세요. 피드는 `https://updates.trina.app/office/stable.json`이며 사용자가 로그인한 동안 야간 확인합니다. 피드·번들의 서명 확인을 우회하지 마세요. `update pause`·`update resume`으로 조절합니다. 수동 설치는 새 ZIP을 검증한 뒤 같은 홈에 설치기를 다시 실행합니다. 앱 롤백이 DB·팀 파일까지 되돌리지는 않습니다. 데이터 복구에는 호환 버전과 업데이트 전 백업이 필요합니다.

## 4. 백업·복원·제거

`~/TeamAX/teamax archive /Volumes/Backup/trina.tar.zst.age`는 보관 암호를 비공개로 입력받습니다. 암호는 백업과 별도로 보관하세요. `~/TeamAX/teamax restore-archive /path/to/trina.tar.zst.age --replace`는 전체 교체 작업입니다. 현재 백업부터 만들고 [복구 안내](BACKUP-RESTORE.md)를 따르세요. 세션은 종료되고 연결은 재인증이 필요할 수 있습니다. CA 신뢰·로그인·파일 접근을 재확인하세요.

압축을 푼 키트에서 `bash "$OFFICE_DIR/office-uninstall.sh"`로 앱·서비스를 제거하고 자료는 남깁니다. `--delete-data`는 자료도 지우므로 외부 복구본을 확인한 뒤에만 사용하세요. `~/TeamAX`는 임시 데모 폴더처럼 지우면 안 됩니다.

## 5. 문제 해결·클라이언트

- 포트 충돌: 사전 점검의 충돌 안내를 보고 설치 포트와 터널 대상을 함께 변경합니다.
- 로그아웃·잠자기: 전용 계정을 로그인 상태로 유지하고 에너지 설정을 확인합니다.
- 공개 주소 502: 터널이 실제 loopback 앱 포트를 가리키는지 확인합니다.
- 인증서 경고: 지문·호스트 이름·IP를 확인하세요. 경고를 무시하지 마세요.
- AI 불가: Claude 실행 파일 없음, 로그인 없음, 버전 불일치, 제공사·네트워크 실패를 나누어 확인하세요. 키를 로그나 Issues에 붙이지 마세요.

PC·모바일 브라우저 또는 배포된 `Trina-AX-Setup-<버전>-win-x64.exe`를 사용합니다. Mac 데스크톱 DMG는 미배포이며 사무실 ZIP은 서버입니다. [문제 해결](TROUBLESHOOTING.md) · [FAQ](FAQ.ko.md) · [설정·기존 경로](CONFIGURATION.md).
