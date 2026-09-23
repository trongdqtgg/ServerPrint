; Xoa task "khoi dong cung Windows" khi nguoi dung GO CAI DAT ung dung.
; Khong xoa khi dang Auto Update (trinh cap nhat cung chay uninstaller cu),
; neu khong se mat cau hinh tu khoi dong sau moi lan cap nhat.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks /Delete /F /TN "LAN Print Autostart"'
  ${endIf}
!macroend
