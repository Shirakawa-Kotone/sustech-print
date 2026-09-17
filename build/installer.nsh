; 南科大云打印 —— 安装包自定义步骤
;
; 这里只做一件事：把 driver/windows 下的驱动脚本接进安装/卸载流程，
; 让用户装完 App 就有一台能用的虚拟打印机，不用再手动跑 PowerShell。
;
; 路径约定：driver/ 由 electron-builder.yml 的 extraResources 落到
;     $INSTDIR\resources\driver\
; 所以下面是 $INSTDIR\resources\driver\windows\...。改 electron-builder.yml
; 里的 to: 时，这里必须同步改，否则安装时会报"找不到驱动脚本"。
;
; 提权：electron-builder.yml 里 nsis.perMachine = true，安装包整体以管理员身份
; 运行，因此下面起的 PowerShell 自带管理员令牌，不会弹第二次 UAC。
; install-printer.ps1 内部有 IsInRole(Administrator) 自检，权限不对会明确报错。
;
; 时序：electron-builder 的 uninstaller.nsh 先 insertmacro customUnInstall
; （第 157 行）再 RMDir /r $INSTDIR（第 187 行），所以卸载时脚本文件仍然在。

!macro customInstall
  ${If} ${FileExists} "$INSTDIR\resources\driver\windows\setup-driver.ps1"
    DetailPrint "正在安装虚拟打印机 SUSTech_Printer ..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\driver\windows\setup-driver.ps1" -Action install'
    Pop $0
    ${If} $0 == 0
      DetailPrint "虚拟打印机安装完成。"
    ${Else}
      DetailPrint "虚拟打印机安装失败，退出码 $0"
      MessageBox MB_ICONEXCLAMATION|MB_OK "虚拟打印机没能装上（退出码 $0）。$\r$\n$\r$\nApp 本身已经装好了，但打印功能暂时用不了。可以手动重试：$\r$\n右键「以管理员身份运行」$\r$\n  $INSTDIR\resources\driver\windows\install-printer.ps1$\r$\n$\r$\n失败原因见日志：$\r$\n  %ProgramData%\SUSTechPrint\driver-setup.log"
    ${EndIf}
  ${Else}
    DetailPrint "没有找到驱动脚本，跳过打印机安装。"
    MessageBox MB_ICONEXCLAMATION|MB_OK "安装包里缺少驱动脚本，虚拟打印机没有安装。$\r$\n$\r$\n预期路径：$\r$\n  $INSTDIR\resources\driver\windows\setup-driver.ps1"
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\resources\driver\windows\setup-driver.ps1"
    DetailPrint "正在删除虚拟打印机 SUSTech_Printer ..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\driver\windows\setup-driver.ps1" -Action uninstall'
    Pop $0
    ${If} $0 == 0
      DetailPrint "虚拟打印机已删除。"
    ${Else}
      ; 卸载阶段不弹窗打断：队列没删干净不该让整个卸载失败，
      ; 把退出码留在"显示详细信息"里就够了。
      DetailPrint "虚拟打印机删除失败，退出码 $0（详见 %ProgramData%\SUSTechPrint\driver-setup.log）"
    ${EndIf}
  ${Else}
    DetailPrint "驱动脚本不存在，跳过打印机清理。"
  ${EndIf}
!macroend
