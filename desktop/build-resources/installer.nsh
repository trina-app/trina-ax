; Added to the Windows NSIS installer and uninstaller (electron-builder.config.ts nsis.include).
;
; The app registers the trina-ax:// link handler itself when it starts (desktop/src/main/main.ts,
; app.setAsDefaultProtocolClient): HKCU\Software\Classes\<scheme> with shell\open\command = "<install dir>\<app>.exe" "%1".
; electron-builder's NSIS uninstaller does not know about it (its `protocols` setting only reaches the dmg, Mac App
; Store and Microsoft Store manifests), so after an uninstall the key pointed at an exe that is gone, in a folder the
; user can write to (QA TC-383). The uninstaller removes the key, but only when it still points into this install
; folder: another copy of the app, or another program that took the scheme over, keeps its handler.
; An update runs the old uninstaller too (${isUpdated}); the key stays then, the new app writes the same one.
;
; The scheme is PRODUCT.linkScheme (shared/src/product.ts); tests/unit/e-desktop-common.test.ts keeps them equal.

!define MYCEL_LINK_SCHEME "trina-ax"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    Push $3
    ClearErrors
    ReadRegStr $0 HKCU "Software\Classes\${MYCEL_LINK_SCHEME}\shell\open\command" ""
    ${ifNot} ${Errors}
      ; the command starts with the quoted exe path; compare its first characters with "<install dir>\
      ; (NSIS == ignores case, like Windows paths)
      StrCpy $1 "$\"$INSTDIR\"
      StrLen $2 $1
      StrCpy $3 $0 $2
      ${if} $3 == $1
        DeleteRegKey HKCU "Software\Classes\${MYCEL_LINK_SCHEME}"
      ${endIf}
    ${endIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${endIf}
!macroend
