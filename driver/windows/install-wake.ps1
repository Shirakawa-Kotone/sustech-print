#Requires -Version 5.1
<#
.SYNOPSIS
    南科大云打印 —— 「打印时唤醒上传进程」的安装/卸载脚本。

.DESCRIPTION
    桌面客户端现在**不常驻**了：关掉窗口一段时间就整个退出，空闲内存 0。
    于是需要有人告诉它"有活干了"，本脚本负责把这个钩子装到系统里。

    钩子是一个计划任务（SUSTechPrint-Wake），它有两个触发器：

      1. **打印事件**：Microsoft-Windows-PrintService/Operational 里的事件 307
         （"文档已打印"）。作业一完成就触发，延迟是秒级的。
         这个日志默认是**关闭**的，所以安装时要用 wevtutil 打开（卸载时会还原）。

      2. **每分钟兜底**：万一事件日志被组策略关掉、或者 307 没发出来，
         最坏也就晚一分钟进队列。

    任务动作是这么一串（全部参数都是 ASCII 或者由 XML 以 UTF-16 承载，
    所以不存在 .cmd 文件的代码页问题 —— 这也是为什么这里不生成 .cmd）：

        cmd.exe /c if exist "<spool>\out.pdf" (
            set "ELECTRON_RUN_AS_NODE=1" & "<App>.exe" "<app.asar>\desktop\worker.mjs" --wake )

    - 先用 `if exist` 挡一道：绝大多数分钟级触发连进程都不用起，几毫秒就结束，
      不会白白每分钟去连一次校园网。真正的判断逻辑在 worker.mjs 里还有一份
      （它一发现 spool 是空的就直接退出）。
    - ELECTRON_RUN_AS_NODE=1 让那个 Electron 二进制**以纯 node 方式**跑起来：
      实测算上服务一共 54 MB，没有 Chromium 进程。为一份 PDF 启动整个 Chromium
      是没道理的。
    - cmd 会**等**worker 结束，所以不存在"任务结束了子进程被一起干掉"的问题。

.PARAMETER Action
    install 或 uninstall。只跑 -SelfTest 时可以省略 —— 早期版本把它标成必填，
    结果 `install-wake.ps1 -SelfTest` 会卡在交互式补参提示上（非交互会话里直接报错）。

.PARAMETER AppExe
    客户端可执行文件。默认按"本脚本所在位置往上三层就是安装目录"来推断
    （$INSTDIR\resources\driver\windows\install-wake.ps1）。

.PARAMETER SpoolDir
    落盘目录，默认 %ProgramData%\SUSTechPrint\spool。必须与
    install-printer.ps1 的 -SpoolDir 一致。

.PARAMETER TaskName
    计划任务名，默认 SUSTechPrint-Wake。

.PARAMETER LogonType
    任务的登录方式，默认 **S4U**（"不管用户是否登录都运行"）。

    为什么默认 S4U：另一种 Interactive（"只在用户登录时运行"）会把任务跑在用户的
    交互会话里，而任务动作是 `cmd.exe` —— 控制台程序，于是**每次打印、以及每分钟
    的兜底触发都会在屏幕上闪一下黑框**（实测：任务运行期间确实新建了 conhost）。
    S4U 把进程放到 session 0，那里根本没有桌面，窗口无从谈起。

    代价是 S4U 下弹不出气泡通知（没有桌面）。无头进程本来就没界面，
    失败信息写进 driver.log 也够用了。
    注册失败时（例如账户缺少"作为批处理作业登录"权限）会自动退回 Interactive。

.PARAMETER NoEventLog
    不去动 Windows 的打印事件日志（只有每分钟兜底那条触发器）。

.PARAMETER SelfTest
    只跑内置自检，不碰系统。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install-wake.ps1 -Action install
    powershell -ExecutionPolicy Bypass -File install-wake.ps1 -Action uninstall

.NOTES
    install 需要管理员权限（要写计划任务和事件日志配置）。
    本文件必须以 UTF-8 with BOM 保存 —— PowerShell 5.1 读无 BOM 的 .ps1 时会按
    系统 ANSI 代码页解码，中文全变乱码。这个坑 driver/windows/REPORT.md 里记着。
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall')]
    [string] $Action = '',

    [string] $AppExe   = '',
    [string] $SpoolDir = (Join-Path $env:ProgramData 'SUSTechPrint\spool'),
    [string] $TaskName = 'SUSTechPrint-Wake',
    [ValidateSet('Interactive', 'S4U', 'Auto')]
    [string] $LogonType = 'Auto',
    [switch] $NoEventLog,
    [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'

$PrintLog = 'Microsoft-Windows-PrintService/Operational'
# 安装时如果这个日志本来是关的，我们把它打开 —— 卸载要还原回去，所以把原状态记在这里。
$StateFile = Join-Path (Split-Path -Parent $SpoolDir) 'wake-state.json'

function Write-Step([string] $Text) { Write-Host "   ... $Text" }
function Write-Ok([string] $Text)   { Write-Host "   [OK] $Text" -ForegroundColor Green }
function Write-Warn([string] $Text) { Write-Host "   [!!] $Text" -ForegroundColor Yellow }
function Write-Bad([string] $Text)  { Write-Host "   [XX] $Text" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 路径推断
# ---------------------------------------------------------------------------

$WorkerRel = 'resources\app.asar\desktop\worker.mjs'

<#
    从本脚本的位置倒推安装目录。

    打包后本脚本在
        $INSTDIR\resources\driver\windows\install-wake.ps1
    所以往上数三层就是 $INSTDIR。用位置推断而不是写死
    "$env:ProgramFiles\sustech-print"，是因为安装目录允许用户自定义。
#>
function Get-InstallDir([string] $ScriptPath) {
    $dir = Split-Path -Parent $ScriptPath          # ...\resources\driver\windows
    $dir = Split-Path -Parent $dir                 # ...\resources\driver
    $dir = Split-Path -Parent $dir                 # ...\resources
    return (Split-Path -Parent $dir)               # $INSTDIR
}

<#
    在安装目录里找客户端主程序。

    不写死 "南科大云打印.exe"：那个名字来自 electron-builder 的 productName，
    将来改个显示名这里就废了。改成"最大的那个非卸载程序 exe" —— 主程序带整个
    Electron 运行时，一定是最大的。
#>
function Find-AppExe([string] $Dir) {
    $candidates = Get-ChildItem -LiteralPath $Dir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike 'Uninstall*' -and $_.Name -notlike 'unins*' }
    if (-not $candidates) { return '' }
    return ($candidates | Sort-Object Length -Descending | Select-Object -First 1).FullName
}

# ---------------------------------------------------------------------------
# 计划任务定义
# ---------------------------------------------------------------------------

<#
    生成任务的 XML。

    用 XML 而不是 New-ScheduledTaskTrigger 那一套 Cmdlet，是因为事件触发器
    在 Cmdlet 里要绕一大圈 CIM 才能建出来，而且没法方便地控制 Hidden /
    MultipleInstancesPolicy 这些细节。XML 是 Task Scheduler 的原生格式，一次说清。
#>
function New-WakeTaskXml(
    [string] $Exe,
    [string] $Worker,
    [string] $SpoolFile,
    [string] $UserId,
    [string] $LogonKind
) {
    # 动作：cmd 先看一眼 out.pdf 在不在，在才把无头 worker 拉起来（并等它跑完）
    $arguments = '/c if exist "' + $SpoolFile + '" (set "ELECTRON_RUN_AS_NODE=1" & "' +
        $Exe + '" "' + $Worker + '" --wake)'

    # 事件订阅本身要作为 XML 文本嵌进去，所以把尖括号转义掉
    $subscription =
        '<QueryList><Query Id="0" Path="' + $PrintLog + '">' +
        '<Select Path="' + $PrintLog + '">*[System[(EventID=307)]]</Select>' +
        '</Query></QueryList>'
    $subscription = $subscription.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')

    $esc = { param($s) ([string]$s).Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;') }

    $eventTrigger = ''
    if (-not $NoEventLog) {
        $eventTrigger = @"
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>$subscription</Subscription>
      <Delay>PT1S</Delay>
    </EventTrigger>
"@
    }

    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>南科大云打印：打印时按需唤醒上传进程（平时不常驻，空闲不占内存）</Description>
  </RegistrationInfo>
  <Triggers>
$eventTrigger    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(& $esc $UserId)</UserId>
      <LogonType>$LogonKind</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>$(& $esc $arguments)</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

# ---------------------------------------------------------------------------
# 事件日志开关
# ---------------------------------------------------------------------------

function Get-PrintLogEnabled {
    # 用 2>$null 而不是 2>&1：$ErrorActionPreference='Stop' 时把原生命令的 stderr
    # 并进管道会变成 NativeCommandError，读不到状态反而抛异常。
    try { $out = & wevtutil.exe gl $PrintLog 2>$null } catch { return $null }
    foreach ($line in $out) {
        if ("$line" -match '^\s*enabled:\s*(\S+)') { return ($matches[1] -eq 'true') }
    }
    return $null
}

function Set-PrintLogEnabled([bool] $On) {
    $value = if ($On) { 'true' } else { 'false' }
    & wevtutil.exe sl $PrintLog "/e:$value" | Out-Null
}

function Save-State([hashtable] $State) {
    try {
        $dir = Split-Path -Parent $StateFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        ($State | ConvertTo-Json) | Set-Content -LiteralPath $StateFile -Encoding UTF8
    }
    catch {
        Write-Warn "状态文件写不进去（卸载时不会还原事件日志设置）：$($_.Exception.Message)"
    }
}

function Load-State {
    try {
        if (Test-Path -LiteralPath $StateFile) {
            return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json)
        }
    }
    catch { }
    return $null
}

# ---------------------------------------------------------------------------
# 主体
# ---------------------------------------------------------------------------

function Invoke-Install {
    if (-not $AppExe) {
        $instDir = Get-InstallDir $PSCommandPath
        $AppExe = Find-AppExe $instDir
        Write-Step "安装目录：$instDir"
    }
    if (-not $AppExe -or -not (Test-Path -LiteralPath $AppExe)) {
        Write-Bad "找不到客户端主程序（-AppExe 可以手工指定），跳过按需唤醒安装。"
        return 1
    }

    $instDir = Split-Path -Parent $AppExe
    $worker = Join-Path $instDir $WorkerRel

    # 注意：**不能**用 Test-Path 去验 $worker。
    #
    # worker.mjs 躺在 app.asar **里面**，而 asar 对操作系统来说只是一个普通文件 ——
    # Test-Path 'C:\...\app.asar\desktop\worker.mjs' 永远返回 False。
    # （实测踩到：明明打进去了，安装时却报"找不到无头工作进程"，于是按需唤醒被
    # 静默跳过，用户打印后什么都不会发生。）所以只验 asar 这个文件在不在，
    # 里面的路径交给下面的冒烟测试去证。
    $asar = Join-Path $instDir 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) {
        Write-Bad "找不到应用归档：$asar"
        return 1
    }
    if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
        Write-Bad "找不到客户端主程序：$AppExe"
        return 1
    }

    $spoolFile = Join-Path $SpoolDir 'out.pdf'
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Auto = 先试 S4U（不会有黑框），失败再退回 InteractiveToken
    $preferred = if ($LogonType -eq 'Interactive') { @('InteractiveToken') }
    elseif ($LogonType -eq 'S4U') { @('S4U') }
    else { @('S4U', 'InteractiveToken') }

    Write-Step "主程序   : $AppExe"
    Write-Step "工作进程 : $worker"
    Write-Step "监视文件 : $spoolFile"
    Write-Step "运行账户 : $userId"

    # 事件日志：先记下原状态，再打开
    if (-not $NoEventLog) {
        $before = Get-PrintLogEnabled
        if ($before -eq $null) {
            Write-Warn "读不到 $PrintLog 的状态，只用每分钟兜底那条触发器。"
        }
        elseif ($before) {
            Write-Ok "打印事件日志已经是打开的，无需改动。"
            Save-State @{ eventLogWasEnabled = $true; changed = $false }
        }
        else {
            Set-PrintLogEnabled $true
            if ((Get-PrintLogEnabled) -eq $true) {
                Write-Ok "已打开打印事件日志（作业一完成就触发，秒级）"
                Save-State @{ eventLogWasEnabled = $false; changed = $true }
            }
            else {
                Write-Warn "打开打印事件日志失败，只剩每分钟兜底那条触发器。"
            }
        }
    }

    # 冒烟测试：真的按计划任务那套方式跑一次 worker。
    #
    # 这是唯一能证明"asar 里的脚本路径可用 + ELECTRON_RUN_AS_NODE 生效"的办法。
    # 没有待处理作业时它 60 ms 左右就退出，写不了什么东西，装完顺手验一下很划算。
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        $proc = Start-Process -FilePath $AppExe -ArgumentList @("`"$worker`"", '--wake') `
            -NoNewWindow -Wait -PassThru -ErrorAction Stop
        if ($proc.ExitCode -eq 0) {
            Write-Ok '冒烟测试通过：无头上传进程能正常启动并退出'
        }
        else {
            Write-Warn "冒烟测试退出码 $($proc.ExitCode)（任务仍然会注册，但打印可能不会自动上传）"
        }
    }
    catch {
        Write-Warn "冒烟测试跑不起来：$($_.Exception.Message)"
    }
    finally {
        Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }

    $task = $null
    foreach ($kind in $preferred) {
        $xml = New-WakeTaskXml -Exe $AppExe -Worker $worker -SpoolFile $spoolFile `
            -UserId $userId -LogonKind $kind
        try {
            Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force -ErrorAction Stop | Out-Null
        }
        catch {
            Write-Warn "以 $kind 注册失败：$($_.Exception.Message)"
            continue
        }
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            if ($kind -eq 'S4U') { Write-Ok "以 S4U 注册（跑在 session 0，用户看不到任何窗口）" }
            else { Write-Warn "退回 InteractiveToken 注册：会在每次触发时闪一下黑框" }
            break
        }
    }

    if (-not $task) {
        Write-Bad "计划任务注册失败：$TaskName"
        return 1
    }
    Write-Ok "已注册计划任务：$TaskName（$($task.Triggers.Count) 个触发器）"
    return 0
}

function Invoke-Uninstall {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok "已删除计划任务：$TaskName"
    }
    else {
        Write-Step "计划任务不存在，跳过：$TaskName"
    }

    # 只在"当初是我们打开的"时候才关掉，别去动用户本来就有意开着的日志
    $state = Load-State
    if ($state -and $state.changed -eq $true -and -not $NoEventLog) {
        Set-PrintLogEnabled $false
        Write-Ok "已还原打印事件日志为原来的关闭状态"
    }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    return 0
}

<#
    自检：只验"生成的 XML 对不对"，不碰系统。
    这段逻辑不能跑在真实机器上试错 —— 一个转义写错，任务会静默地什么都不做，
    而用户只会看到"打印了但云队列里没有"。所以把可验证的部分都拿出来验。
#>
function Invoke-SelfTest {
    $script:testFail = 0
    function Check([string] $Name, [bool] $Ok) {
        if ($Ok) { Write-Host "  [PASS] $Name" -ForegroundColor Green }
        else { Write-Host "  [FAIL] $Name" -ForegroundColor Red; $script:testFail++ }
    }

    Check '倒推安装目录' ((Get-InstallDir 'C:\App\resources\driver\windows\install-wake.ps1') -eq 'C:\App')

    $xml = New-WakeTaskXml -Exe 'C:\App\南科大云打印.exe' -Worker 'C:\App\w.mjs' `
        -SpoolFile 'C:\ProgramData\SUSTechPrint\spool\out.pdf' `
        -UserId 'PC\user' -LogonKind 'InteractiveToken'

    $parsed = $null
    try { $parsed = [xml] $xml } catch { }
    Check 'XML 能解析' ($null -ne $parsed)
    Check '是 Task 根节点' ($parsed.Task.version -eq '1.2')
    Check '含事件触发器' ($xml -match '<EventTrigger>')
    Check '含 307 订阅' ($xml -match 'EventID=307')
    Check '含每分钟兜底' ($xml -match '<Interval>PT1M</Interval>')
    Check '含 ELECTRON_RUN_AS_NODE' ($xml -match 'ELECTRON_RUN_AS_NODE=1')
    Check '含 --wake' ($xml -match '--wake')
    Check '动作是 cmd.exe' ($parsed.Task.Actions.Exec.Command -eq 'cmd.exe')
    Check '隐藏窗口' ($parsed.Task.Settings.Hidden -eq 'true')
    Check '不重复运行' ($parsed.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew')
    Check '电池下也运行' ($parsed.Task.Settings.DisallowStartIfOnBatteries -eq 'false')
    Check '账号带转义' ($parsed.Task.Principals.Principal.UserId -eq 'PC\user')
    $xmlS4u = New-WakeTaskXml -Exe 'C:\App\a.exe' -Worker 'C:\App\w.mjs' `
        -SpoolFile 'C:\p\out.pdf' -UserId 'PC\user' -LogonKind 'S4U'
    Check 'S4U 会写进 XML' ($xmlS4u -match '<LogonType>S4U</LogonType>')
    # 中文路径必须原样进 XML（UTF-16 承载，不经代码页），否则任务一跑就找不到程序
    Check '中文路径未损坏' ($xml -match '南科大云打印\.exe')
    # 参数里嵌了引号，转义错了任务会静默什么都不做
    Check '参数内的引号已转义' ($parsed.Task.Actions.Exec.Arguments -match 'if exist "C:\\ProgramData')
    # asar 内的路径 Test-Path 看不见，脚本必须用 asar 文件本身来判断
    # 刻意**不**在这里断言"源码里没有对 asar 内路径做 Test-Path"：
    # 那种自省断言会被注释本身命中（实测：注释里写了一句 "不能用 Test-Path 验 $worker"
    # 就让自检红了），脆弱且没有价值。真正证明这件事的是 -Action install 里的冒烟测试 ——
    # 它真的会把 worker 跑一遍，路径不可用就直接失败。

    if ($script:testFail -gt 0) { Write-Host "`n$($script:testFail) 项未通过" -ForegroundColor Red; return 1 }
    Write-Host "`n全部通过" -ForegroundColor Green
    return 0
}

if ($SelfTest) { exit (Invoke-SelfTest) }
if ($Action -eq 'install') { exit (Invoke-Install) }
if ($Action -eq 'uninstall') { exit (Invoke-Uninstall) }

Write-Host ''
Write-Host '  用法：install-wake.ps1 -Action install|uninstall [-LogonType Auto|S4U|Interactive]' -ForegroundColor Yellow
Write-Host '        install-wake.ps1 -SelfTest        （只校验任务定义，不碰系统）' -ForegroundColor Yellow
Write-Host ''
exit 2
