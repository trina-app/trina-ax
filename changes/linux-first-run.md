- **First setup removes its code.** Once the owner account is made, the server deletes the setup code the installer left
  for the administrator (`<install folder>/setup/code`), not only its own copy. Running the installer again removes a
  code an older server left behind.
- **A link only this computer can open says so.** An invite, password reset or team link made while the app is open at
  this computer's own address (for example `http://127.0.0.1:47820` through an SSH tunnel) now shows that other
  computers can't open it, and to set the team address in Admin › System › Connection first.
- The install guides name the AI page as the app does: Admin › AI accounts (관리자 › AI 계정).
