Trina AX 사무실 모드 (맥 한 대 + 같은 네트워크의 데스크 PC들)
=================================================================

자세한 안내: app/docs/OFFICE.md (설치 후 ~/TeamAX/app/docs/OFFICE.md). PDF를 포함한 키트에서는 Trina-AX-사무실모드-설치가이드.pdf도 읽으세요.
데스크 직원용: 포함된 경우 Trina-AX-윈도우-데스크-가이드.pdf; 없으면 OFFICE.md 4·7장 (Edge 앱, AI 브라우저 자리의 데스크톱 앱, 문제 해결)

1. Claude Code는 ZIP에 없습니다. app/versions.json의 claude-code 버전을 별도 설치하세요.
   예: curl -fsSL https://claude.ai/install.sh | bash -s 2.1.305 (받은 키트의 버전 우선).
   기본 local-login은 전용 Mac 사용자로 허용된 계정에 로그인합니다.
     터미널에서  claude  실행 → /login → 구독 계정으로 로그인

2. 최신 릴리스의 정확한 TrinaAX-office-<버전>-mac.zip과 SHA256SUMS를 확인하고 풉니다.
   shasum -a 256 <정확한 ZIP 경로> 결과를 비교하세요. 설치 명령에 --check-only를 먼저 붙여 점검합니다.
   터미널을 열고 (이 폴더를 터미널 창에 끌어다 놓아도 됩니다):
     bash ~/Downloads/TrinaAX-office-<버전>/office-install.sh \
       --public-host team.example.com --tunnel-token-file ~/Downloads/team.example.com.tunnel-token

   인터넷 주소(--public-host)와 연결 토큰 파일은 설치 담당자의 맥(Cloudflare에 로그인하는 맥)에서 미리 만든 것입니다(가이드 2-0). 없으면 두 옵션을 빼고
   설치하고 나중에  ~/TeamAX/teamax public-address set <주소> <토큰 파일>.
   설치가 끝나면 받은 토큰 파일은 지웁니다 (~/TeamAX/config 에 복사됨):
     rm ~/Downloads/team.example.com.tunnel-token
   --app-port 로 앱 포트를 바꿨다면 설치 담당자의 맥에서 public-address.ts set <주소> --port <그 포트> 를 한 번 더.

   관리자 암호(sudo)는 필요 없습니다. ~/TeamAX 에 설치됩니다.
   끝나면 데스크에서 열 주소와 첫 설정 링크가 나오고, 첫 설정 페이지가 이 맥의 브라우저에 열립니다.

3. 데스크 카드를 인쇄합니다 (주소와 인증서 지문이 있는 한 장):
     ~/TeamAX/teamax card     → 열린 페이지를 인쇄(⌘P)

4. 데스크(윈도우)마다:  Edge에서 인터넷 주소(https://team.example.com) → ⋯ → 앱 → 이 사이트를 앱으로 설치
   (인증서 설치 필요 없음). 인터넷이 끊겨도 쓰려는 데스크만 사무실 안 경로를 한 번:
     Edge에서  http://<이 맥의 주소>:8442  → 인증서 받기 → 열기 → 자세히 → 지문이 카드와 같은지 확인
     → 일반 → 인증서 설치 → 현재 사용자 → 신뢰할 수 있는 루트 인증 기관
     (USB로 ~/TeamAX/tls/ca.cer 를 나눠 주면 더 안전합니다)
     그다음  https://<이 맥의 주소>:8443  → ⋯ → 앱 → 이 사이트를 앱으로 설치

5. 데스크톱 앱(선택): Trina-AX-Setup-<버전>-win-x64.exe / Trina-AX-<버전>-mac-universal.dmg 를 이 zip과 같은 폴더에 두고
   설치하면 자동으로 올라갑니다 (팀원은 설정 → 앱에서 내려받음). 다른 폴더(~/Downloads)의 파일은 물어본 뒤에만 올립니다.
   나중에 올리려면:
     ~/TeamAX/teamax desktop add ~/Downloads/Trina-AX-Setup-<버전>-win-x64.exe

명령:  ~/TeamAX/teamax status | info | card | logs | restart | setup-link | reset-link | backup | archive <파일>
       | public-address status | set <주소> <토큰 파일> | off | desktop list | add <설치 파일> | remove <파일>
첫 주: 권한 → AI 연결 → 팀원 초대 → 첫 스킬 → 첫 백업 (OFFICE.md 3·5장의 전체 절차).
구독 공유는 새 팀 기본 켜짐, 저장된 선택은 유지. 연결별 동의와 제공사 약관상 허가는 별개입니다.
Mac DMG는 미배포이며 아래 DMG 단계는 직접 만든 파일이 있을 때만 사용합니다.
업데이트: https://updates.trina.app/office/stable.json (로그인한 동안 야간 확인).
          먼저 외부 암호화 백업을 검증하세요. 앱 롤백은 DB·파일을 되돌리지 않습니다.
          0.1.0에서 처음 한 번만 이 zip으로 office-install.sh 를 실행하면 됩니다 (데이터는 그대로).
          ~/TeamAX/teamax update status | now | pause | resume   (관리자 > 시스템 > 자동 업데이트와 같음)
제거:     bash office-uninstall.sh            (데이터는 남김)
          bash office-uninstall.sh --delete-data


Trina AX office mode (one Mac + the desk PCs on its network). Full offline English runbook: app/docs/OFFICE.en.md. Korean: app/docs/OFFICE.md. PDFs are included only when built; the runbooks contain the steps when PDFs are absent.
  1. Install Claude Code separately using the tested version in app/versions.json; the ZIP does not include it.
     Run claude and /login as the dedicated Mac user with a permitted account; confirm claude auth status.
  2. bash ~/Downloads/TrinaAX-office-<version>/office-install.sh [--public-host <name> --tunnel-token-file <file>]
     (no sudo; installs into ~/TeamAX; the internet address and its connector token come from the owner's Mac)
  3. Print the desk card (~/TeamAX/teamax card): the address and the certificate thumbprint.
  4. Each desk: open https://<internet address> in Edge and install it as an app (no certificate). In-office fallback, once:
     open http://<this Mac>:8442 in Edge, open the certificate, compare Details → Thumbprint with the
     card, install it for the Current User into Trusted Root Certification Authorities (or hand out
     ~/TeamAX/tls/ca.cer on a USB stick), then https://<this Mac>:8443 and Edge ⋯ → Apps → Install this site as an app.
  5. Desktop app (optional): put Trina-AX-Setup-<version>-win-x64.exe / Trina-AX-<version>-mac-universal.dmg in the same folder
     as this zip before installing and they are offered under Settings → Apps (a file elsewhere in ~/Downloads only after
     you answer yes); later: ~/TeamAX/teamax desktop add <file>.
  Updates: automatic from 0.2.0 (every night at 03:00 from https://updates.trina.app, rolled back if the new version
     does not start). Coming from 0.1.0, run this zip's office-install.sh once. ~/TeamAX/teamax update status | now | pause

First week: permissions → AI connection → invite the team → first skill → first backup.
Fresh team subscription sharing is ON; saved choices persist. Connection consent is not provider permission.
Verify the exact ZIP against its release SHA256SUMS, run --check-only first, and keep an encrypted off-host backup.
A Mac desktop DMG is not published; use the DMG steps only with your own verified build. App rollback does not restore data.
Internet is required for cloud AI even when local file browsing works offline.
