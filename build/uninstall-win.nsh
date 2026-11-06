; ============================================================
; 灵感笔记 Windows 卸载额外清理
; deleteAppDataOnUninstall 只删除主数据目录 idea-note-local，
; 这里补删登录态镜像目录 flomo-local / 灵感笔记，
; 保证卸载后重新安装必须重新登录。
; ============================================================
!macro customUnInstall
  RMDir /r "$APPDATA\flomo-local"
  RMDir /r "$APPDATA\灵感笔记"
  RMDir /r "$APPDATA\idea-note-local"
!macroend
