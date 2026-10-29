Trina AX office / 트리나 AX 사무실 설치
=====================================

Read app/docs/OFFICE.md (한국어) or app/docs/OFFICE.en.md (English).
Online: https://github.com/trina-app/trina-ax/blob/main/docs/OFFICE.md
PDF guides are optional build outputs, not guaranteed in this ZIP.
PDF는 선택 산출물이며 ZIP에 포함된다고 보장하지 않습니다.

1. Use a dedicated macOS 13+ Mac and an authorized Claude connection.
   전용 Mac과 목적에 맞게 허용된 Claude 연결을 사용하세요. 개인 구독이 자동으로 팀 이용 허가를 주지 않습니다.
2. Verify the exact TrinaAX-office-<version>-mac.zip against that release's SHA256SUMS.
   Unpack it, then run from TrinaAX-office-<version>:
     bash office-install.sh --check-only
     bash office-install.sh
   Optional prepared tunnel: --public-host team.example.com --tunnel-token-file /path/to/token-file
   No sudo. Installs into ~/TeamAX. Keep the printed local setup token private.
3. Create the owner locally, then permissions → AI connection → invite team → first skill → first backup.
   로컬 소유자 생성 후 권한 → AI 연결 → 팀원 초대 → 첫 스킬 → 첫 백업.
4. Print ~/TeamAX/teamax card; compare the CA fingerprint before trusting the LAN address.
   Prefer the prepared HTTPS public address when configured. Cloud AI still requires internet.
5. Optional Windows client: Trina-AX-Setup-<version>-win-x64.exe from the release.
   A Mac desktop DMG is not currently published. This ZIP is the Mac server.

Fresh teams allow subscription sharing by default; existing settings persist. Personal connections take priority
in managed mode, and connection-level consent still applies. Provider permission is separate. Office local-login
uses this Mac's CLI connection; do not assume managed connection routing.

Status: ~/TeamAX/teamax status
Backup: ~/TeamAX/teamax backup
Encrypted off-host archive: ~/TeamAX/teamax archive /Volumes/Backup/trina.tar.zst.age
Updates: https://updates.trina.app — ~/TeamAX/teamax update status | now | pause | resume
Read release notes and verify a backup before updating. App rollback does not restore database/files.
Uninstall: bash office-uninstall.sh (keeps data). --delete-data removes data; verify recovery first.
Logout stops office mode. This is not the dedicated-account Linux/role-account Mac isolation boundary.
