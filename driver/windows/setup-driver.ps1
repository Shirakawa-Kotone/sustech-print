<#
.SYNOPSIS
    安装包调用驱动安装/卸载的入口。

.DESCRIPTION
    NSIS 安装包（build/installer.nsh）通过这个脚本去驱动
    install-printer.ps1 / uninstall-printer.ps1。之所以要中间加这一层，
    而不是让 NSIS 直接调原脚本：

      1. 原脚本用 Write-Host 输出。经 nsExec 重定向后中文会变成问号，
         用户看不到失败原因。这里把输出整段收成字符串，再以 UTF-8
         写进日志文件，出问题让人直接打开就能看。
      2. 原脚本用 exit 1 报错。这里把退出码原样透传给 NSIS，
         安装包才能判断"驱动到底装上了没有"。
      3. 原脚本要求管理员权限，而 perMachine 安装包本身就以管理员身份
         运行（见 electron-builder.yml 的 nsis.perMachine），
         所以这里不需要也不会再弹第二次 UAC。

    安装完成后本脚本随 App 一起留在
        $INSTDIR\resources\driver\windows\
    需要手工重试时直接：

        powershell -ExecutionPolicy Bypass -File setup-driver.ps1 -Action install
        powershell -ExecutionPolicy Bypass -File setup-driver.ps1 -Action uninstall

.NOTES
    本文件必须以 UTF-8 with BOM 保存。PowerShell 5.1 读无 BOM 的 .ps1 时
    会按系统 ANSI 代码页解码，中文会变乱码 —— 这个坑在
    driver/windows/REPORT.md 里已经踩过一次。
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall')]
    [string] $Action
)

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $PSCommandPath
if ($Action -eq 'install') {
    $target = Join-Path $here 'install-printer.ps1'
}
else {
    $target = Join-Path $here 'uninstall-printer.ps1'
}

$logDir  = Join-Path $env:ProgramData 'SUSTechPrint'
$logFile = Join-Path $logDir 'driver-setup.log'

function Write-SetupLog([string] $Text) {
    try {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        Add-Content -LiteralPath $logFile -Value $Text -Encoding UTF8
    }
    catch {
        # 日志写不进去不该影响安装本身
    }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-SetupLog ''
Write-SetupLog "================ $stamp  [$Action] ================"

<#
    删掉本程序自己登记的「开机自动启动」项。

    App 是用 Electron 的 setLoginItemSettings 写的 HKCU Run，键名由 Electron
    按应用名生成（实测是 electron.app.南科大云打印），脚本和 NSIS 都不该写死它。
    这里改成按「值里引用了本程序」来匹配，只删自己的、绝不碰别人的启动项。

    不做这一步的话，卸载之后会留下一条指向已删除 exe 的登录项。
#>
function Remove-OwnLoginItems {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $props = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' }
    foreach ($p in $props) {
        $value = [string] $p.Value
        if ($value -like '*sustech-print*' -or $value -like '*南科大云打印*') {
            Remove-ItemProperty -Path $runKey -Name $p.Name -ErrorAction SilentlyContinue
            Write-SetupLog "已删除开机自启项：$($p.Name) = $value"
            Write-Host "[setup-driver] 已删除开机自启项：$($p.Name)"
        }
    }
}

if (-not (Test-Path -LiteralPath $target)) {
    Write-SetupLog "找不到 $target"
    Write-Host "找不到 $target" -ForegroundColor Red
    exit 2
}

Write-SetupLog "执行：$target"

# 用子进程跑原脚本，而不是 & 直接调：
#   原脚本用 exit N 结束，直接用 & 调有可能把本脚本一起带走；
#   开子进程则退出码干净、输出好收。
# 这个调用形式与 driver/windows/REPORT.md 里验证过的一致。
$out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $target *>&1 | Out-String
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }

Write-SetupLog $out
Write-SetupLog "---------------- exit=$code ----------------"

# 同时回显给安装包的控制台（nsExec 会收进"显示详细信息"里）
Write-Host $out
Write-Host "[setup-driver] $Action exit=$code"
Write-Host "[setup-driver] 完整日志：$logFile"

# 卸载时顺手把开机自启项收掉（只在卸载时做，安装时不能碰）
if ($Action -eq 'uninstall') {
    Remove-OwnLoginItems

    # 再把"首次启动已处理过"的标记删掉。
    # 留着它会出问题：卸载已经删了登录项，重装后首次启动看到标记还在，
    # 就不会再把开机自启打开 —— 用户会觉得"重装之后自启失效了"。
    # 标记在**每用户**的配置目录里（App 现在把私有数据放那儿）。
    # 卸载程序是提权运行的，但 UAC 提权不换用户，所以 $env:LOCALAPPDATA
    # 仍然指向执行卸载的那个用户。
    $userConfigDir = Join-Path $env:LOCALAPPDATA 'SUSTechPrint'
    $marker = Join-Path $userConfigDir 'autostart-initialized'
    if (Test-Path -LiteralPath $marker) {
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        Write-SetupLog "已删除首次启动标记：$marker"
        Write-Host "[setup-driver] 已删除首次启动标记"
    }
    # 老版本把它放在 %ProgramData% 下，一并清掉
    $legacyMarker = Join-Path $logDir 'autostart-initialized'
    if (Test-Path -LiteralPath $legacyMarker) {
        Remove-Item -LiteralPath $legacyMarker -Force -ErrorAction SilentlyContinue
        Write-SetupLog "已删除老版本残留的首次启动标记：$legacyMarker"
    }
}

exit $code
