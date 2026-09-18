#Requires -Version 5.1
<#
.SYNOPSIS
    南科大云打印 —— Windows 虚拟打印机安装脚本。

.DESCRIPTION
    注册一个名为「SUSTech_Printer」的本地打印队列，它的端口直接指向
    %ProgramData%\SUSTechPrint\spool\out.pdf。桌面 App（或 watch-spool.ps1）
    监听这个文件，把它 POST 到本地 API 再上传到云打印队列。

    本脚本不需要自定义端口监视器、不需要 C++ DLL、不需要驱动签名、不需要 Ghostscript：
    Windows 自带的「Microsoft Print To PDF」驱动接受「一个普通文件路径」作为端口名，
    每打印一个作业就把该文件干净地重写一遍（清空 + 写入一份完整 PDF）。

    幂等策略：**能复用就复用**。
    如果队列和端口已经存在且配置一致，脚本只重新应用一遍设置，不删除重建 ——
    因为删除文件端口时假脱机服务会异步清理端口指向的目录，可能把还没被取走的
    out.pdf 一起删掉。要强制删除重建请显式加 -Force。

.PARAMETER PrinterName
    队列显示名，默认「SUSTech_Printer」。必须与 App 里 lib/paths.mjs 的 PRINTER_NAME 一致。
    用下划线而不是空格是为了跟 macOS 端保持一致 —— macOS 的 CUPS/lpadmin 拒绝空白字符。
    Windows 本身允许空格，所以这里传空格也能装上，但那样两个平台的名字就不一样了。

.PARAMETER SpoolDir
    落盘目录，默认 %ProgramData%\SUSTechPrint\spool。

.PARAMETER SetDefault
    把「SUSTech_Printer」设为系统默认打印机。默认不设置 —— 一旦设为默认，
    本机所有打印都会落到这个队列里，通常不是用户想要的。

.PARAMETER Force
    强制删除并重建队列与端口。注意：重新创建文件端口可能导致 spool 目录里
    尚未被取走的 out.pdf 被假脱机服务清掉，除非你确定没有待处理的作业。

.PARAMETER RequirePdf
    如果找不到「Microsoft Print To PDF」驱动则直接报错退出，不使用 PostScript 兜底驱动。

.PARAMETER PurgeSpool
    安装时删除已有的 out.pdf（可能残留上一个作业）。默认保留，只提示。

.PARAMETER TestPage
    安装完成后打印一张测试页，用来确认端口真的能落盘。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install-printer.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install-printer.ps1 -SetDefault -TestPage

.NOTES
    需要管理员权限。可重复执行（幂等）：重复执行不会报错，也不会产生重复的队列或端口。
#>
[CmdletBinding()]
param(
    [string] $PrinterName = 'SUSTech_Printer',
    [string] $SpoolDir    = (Join-Path $env:ProgramData 'SUSTechPrint\spool'),
    [switch] $SetDefault,
    [switch] $Force,
    [switch] $RequirePdf,
    [switch] $PurgeSpool,
    [switch] $TestPage
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 首选：直接把打印作业渲染成 PDF。
$PreferredDriver = 'Microsoft Print To PDF'
# 兜底：Windows 自带的 inbox PostScript 驱动。注意它产出的是 PostScript，不是 PDF。
$FallbackDriver  = 'MS Publisher Color Printer'

# 联创（vendor）驱动留下来的队列，绝对不要碰。名字就是 8 个问号。
$VendorPrinterName = '????????'

$ConfigDir = Split-Path -Parent $SpoolDir
$TokenFile = Join-Path $ConfigDir 'driver-token'
# 端口名 = 输出文件的绝对路径。
$PortFile  = Join-Path $SpoolDir 'out.pdf'
$LocalApi  = 'http://127.0.0.1:8787'

# ---------------------------------------------------------------------------
# 输出小工具（统一走 Write-Host，方便控制台着色，也方便被 6>&1 捕获）
# ---------------------------------------------------------------------------

function Write-Title([string] $Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}
function Write-Step([string] $Text) { Write-Host "   ... $Text" }
function Write-Ok([string] $Text)   { Write-Host "   [OK] $Text" -ForegroundColor Green }
function Write-Warn([string] $Text) { Write-Host "   [!!] $Text" -ForegroundColor Yellow }
function Write-Bad([string] $Text)  { Write-Host "   [XX] $Text" -ForegroundColor Red }

function Stop-WithError([string] $Text) {
    Write-Host ''
    Write-Bad $Text
    Write-Host ''
    exit 1
}

function Test-PrinterExists([string] $Name) {
    return [bool](Get-Printer -Name $Name -ErrorAction SilentlyContinue)
}
function Test-PortExists([string] $Name) {
    return [bool](Get-PrinterPort -Name $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# 0. 权限检查
# ---------------------------------------------------------------------------

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Bad '需要管理员权限才能注册打印机端口和队列。'
    Write-Host ''
    Write-Host '   请这样操作：' -ForegroundColor Yellow
    Write-Host '     1. 开始菜单搜索「PowerShell」；'
    Write-Host '     2. 右键 →「以管理员身份运行」；'
    Write-Host '     3. 在打开的窗口里执行：'
    Write-Host ''
    Write-Host "        powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -ForegroundColor White
    Write-Host ''
    exit 1
}

# 防御：万一有人把队列名/端口名传成了 vendor 的名字，直接拒绝。
if ($PrinterName -eq $VendorPrinterName) {
    Stop-WithError "拒绝执行：$PrinterName 是联创驱动遗留的队列，本脚本不会去动它。"
}
if ($PortFile -eq $VendorPrinterName) {
    Stop-WithError '拒绝执行：端口名与联创驱动遗留端口冲突。'
}

Write-Host ''
Write-Host '南科大云打印 —— Windows 虚拟打印机安装' -ForegroundColor White
Write-Host "   队列名   : $PrinterName"
Write-Host "   落盘目录 : $SpoolDir"
Write-Host "   端口文件 : $PortFile"
Write-Host "   本地 API : $LocalApi"

# ---------------------------------------------------------------------------
# 1. 驱动探测（先探测，再动手）
# ---------------------------------------------------------------------------

Write-Title '检查打印驱动'

function Test-PrinterDriver([string] $Name) {
    return [bool](Get-PrinterDriver -Name $Name -ErrorAction SilentlyContinue)
}

$hasPreferred = Test-PrinterDriver $PreferredDriver
$hasFallback  = Test-PrinterDriver $FallbackDriver

if ($hasPreferred) {
    Write-Ok "找到首选驱动：$PreferredDriver（直接产出 PDF）"
    $driverName  = $PreferredDriver
    $driverIsPdf = $true
}
elseif ($hasFallback) {
    if ($RequirePdf) {
        Stop-WithError "找不到「$PreferredDriver」驱动，且已指定 -RequirePdf，安装中止。`n       请在「设置 → 应用 → 可选功能」里添加「Microsoft Print to PDF」。"
    }
    Write-Warn "找不到「$PreferredDriver」驱动，回退到「$FallbackDriver」。"
    Write-Warn '注意：这个驱动产出的是 PostScript（%!PS-Adobe），不是 PDF，'
    Write-Warn '      桌面 App 与 watch-spool.ps1 都按 PDF 解析，因此打印结果可能无法上传。'
    Write-Warn '      建议先安装「Microsoft Print to PDF」可选功能。'
    $driverName  = $FallbackDriver
    $driverIsPdf = $false
}
else {
    Stop-WithError "既没有「$PreferredDriver」，也没有「$FallbackDriver」驱动，无法安装。`n       请在「设置 → 应用 → 可选功能」里添加「Microsoft Print to PDF」。"
}

# ---------------------------------------------------------------------------
# 2. 检查已有队列 / 端口，决定「复用」还是「删除重建」
# ---------------------------------------------------------------------------

Write-Title '检查已有队列与端口'

$existingPrinter = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
$existingPort    = Get-PrinterPort -Name $PortFile -ErrorAction SilentlyContinue

$wasDefault = $false
if ($existingPrinter) {
    # 用 Where-Object 而不是 -Filter "Name='...'"：WQL 对中文名和特殊字符不友好。
    $cim = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -eq $PrinterName }
    if ($cim -and $cim.Default) { $wasDefault = $true }
}

$reuseExisting = $false
$recreateReason = ''

if ($Force) {
    $recreateReason = '指定了 -Force'
}
elseif ($existingPrinter -and $existingPort) {
    if ($existingPrinter.DriverName -ne $driverName) {
        $recreateReason = "已有队列的驱动是「$($existingPrinter.DriverName)」，与目标驱动「$driverName」不一致"
    }
    elseif ($existingPrinter.PortName -ne $PortFile) {
        $recreateReason = "已有队列的端口是「$($existingPrinter.PortName)」，与目标端口不一致"
    }
    else {
        $reuseExisting = $true
    }
}
elseif ($existingPrinter -and -not $existingPort) {
    $recreateReason = '队列存在但端口缺失'
}
elseif (-not $existingPrinter -and $existingPort) {
    # 端口在、队列不在：直接复用这个端口，避免删除端口触发假脱机服务清理目录。
    Write-Ok "端口已存在，复用：$PortFile"
    Write-Ok "队列不存在，将新建：$PrinterName"
}

if ($reuseExisting) {
    Write-Ok "队列「$PrinterName」与端口已存在且配置一致，直接复用（不删除，避免清空 spool 目录）"
    Write-Ok "   驱动：$($existingPrinter.DriverName)   端口：$($existingPrinter.PortName)"
}
elseif ($recreateReason) {
    Write-Warn "将删除并重建：$recreateReason"

    if ($existingPrinter) {
        Write-Step "删除已存在的队列「$PrinterName」"
        Remove-Printer -Name $PrinterName -ErrorAction Stop
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 250
            if (-not (Test-PrinterExists $PrinterName)) { break }
        }
        if (Test-PrinterExists $PrinterName) {
            Stop-WithError "队列「$PrinterName」删除后仍然存在，可能有作业正在打印。请关闭打印窗口后重试。"
        }
        Write-Ok '已删除旧队列'
    }

    if ($existingPort) {
        Write-Step '删除已存在的端口'
        Write-Warn '注意：删除「文件端口」时假脱机服务可能异步清掉端口指向的目录，'
        Write-Warn '      包括还没被取走的 out.pdf。请确认当前没有待处理的作业。'
        $lastError = $null
        for ($i = 0; $i -lt 30; $i++) {
            try {
                Remove-PrinterPort -Name $PortFile -ErrorAction Stop
                $lastError = $null
                break
            }
            catch {
                # 假脱机服务偶尔还握着这个端口，等一会儿再试。
                $lastError = $_
                Start-Sleep -Milliseconds 400
            }
        }
        if ($lastError) { Stop-WithError "端口删除失败：$($lastError.Exception.Message)" }
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 250
            if (-not (Test-PortExists $PortFile)) { break }
        }
        if (Test-PortExists $PortFile) { Stop-WithError "端口删除后仍然存在：$PortFile" }
        Write-Ok '已删除旧端口'
    }
}
else {
    Write-Ok '没有同名队列或端口，全新安装'
}

# ---------------------------------------------------------------------------
# 3. 建立落盘目录
# ---------------------------------------------------------------------------

Write-Title '准备落盘目录'

# 先把 %ProgramData%\SUSTechPrint 建出来：桌面 App 会把 api-port / driver-token /
# driver.log 写在这里，spool 只是它的子目录。
if (-not (Test-Path -LiteralPath $ConfigDir)) {
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    Write-Ok "已创建 $ConfigDir"
}
else {
    Write-Ok "配置目录已存在：$ConfigDir"
}

if (-not (Test-Path -LiteralPath $SpoolDir)) {
    New-Item -ItemType Directory -Force -Path $SpoolDir | Out-Null
    Write-Ok "已创建 $SpoolDir"
}
else {
    Write-Ok "目录已存在：$SpoolDir"
}

# 只给「落盘目录」$SpoolDir 授权，不给它的父目录。
#
# 为什么是这里：假脱机服务以 SYSTEM 身份往 out.pdf 里写，而打印机队列是按
# 整台机器注册的 —— 任何用户打印都要落到同一个文件上，所以这个目录必须
# 机器级共享。
#
# App 自己的东西（api-port / driver-token / 加密后的密码）**不在这里**了，
# 它们搬到了每用户私有的 %LOCALAPPDATA%\SUSTechPrint，见 lib/paths.mjs。
# 老版本曾经把它们放在这个父目录，结果因为 C:\ProgramData 默认给 Users 的
# 权限是 `(CI)(WD,AD,WEA,WA)` —— (CI) 只管子目录、管不到已存在的文件 ——
# 出现了「管理员建的文件普通用户改不动」，直接表现成白窗口和"保存密码没有权限"。
#
# 授权要带 OI+CI（作用于目录本身，加上已有的和以后新建的文件），否则会重演
# 「SYSTEM 建了 out.pdf，普通用户改不动」这类属主冲突。
try {
    $acl  = Get-Acl -LiteralPath $SpoolDir
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        'Users', 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $SpoolDir -AclObject $acl
    Write-Ok "已授权 Users 组读写 $SpoolDir"
}
catch {
    Stop-WithError "设置落盘目录权限失败：$($_.Exception.Message)`n       权限没设上，打印作业可能写不进去。"
}

# 递归刷到已存在的文件上。用 SID 而不是 "Users"，免得受系统语言影响。
& icacls $SpoolDir /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "icacls 递归授权返回 $LASTEXITCODE（老文件可能仍是旧权限）"
}
else {
    Write-Ok '已把权限递归同步到落盘目录下已有的文件'
}

# 清掉老版本留在这个父目录里的应用私有数据，免得两处各有一份、分不清哪份是活的。
$legacy = @('api-port', 'api', 'driver-token', 'driver.log', 'credentials.bin', 'autostart-initialized')
$removed = @()
foreach ($name in $legacy) {
    $p = Join-Path $ConfigDir $name
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $p)) { $removed += $name }
    }
}
if ($removed.Count -gt 0) {
    Write-Ok ("已清理老版本残留的应用数据：" + ($removed -join '、'))
}

$existingPdf = Get-Item -LiteralPath $PortFile -ErrorAction SilentlyContinue
if ($existingPdf -and $existingPdf.Length -gt 0) {
    if ($PurgeSpool) {
        Remove-Item -LiteralPath $PortFile -Force
        Write-Ok '已按 -PurgeSpool 删除残留的 out.pdf'
    }
    else {
        Write-Warn ("目录里已有 out.pdf（{0:N0} 字节，{1:yyyy-MM-dd HH:mm:ss}）" -f $existingPdf.Length, $existingPdf.LastWriteTime)
        Write-Warn '如果它没有被上传过，可能是一个残留作业；要清掉请加 -PurgeSpool。'
    }
}

# ---------------------------------------------------------------------------
# 4. 注册端口 + 队列
# ---------------------------------------------------------------------------

Write-Title '注册端口与打印队列'

if (Test-PortExists $PortFile) {
    Write-Ok "端口已存在，复用：$PortFile"
}
else {
    Write-Step "注册端口：$PortFile"
    $portCreated = $false
    for ($i = 0; $i -lt 10; $i++) {
        try {
            Add-PrinterPort -Name $PortFile -ErrorAction Stop
            $portCreated = $true
            break
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $portCreated) { Stop-WithError "注册端口失败：$PortFile" }
    Write-Ok '端口已注册'
}

if (Test-PrinterExists $PrinterName) {
    Write-Ok "队列已存在，复用：$PrinterName"
}
else {
    Write-Step "注册队列：$PrinterName（驱动 $driverName）"
    Add-Printer -Name $PrinterName -DriverName $driverName -PortName $PortFile -ErrorAction Stop
    Write-Ok '队列已注册'
}

# 队列设置：不共享、不发布、不保留已打印文档。
Write-Step '应用队列设置'
Set-Printer -Name $PrinterName -Shared $false -Published $false -KeepPrintedJobs $false -ErrorAction Stop
Write-Ok '不共享 / 不发布 / 不保留已打印文档'

try {
    Set-Printer -Name $PrinterName -PrintProcessor 'winprint' -ErrorAction Stop
    Write-Ok '打印处理器：winprint'
}
catch {
    Write-Warn "设置打印处理器失败（通常无妨）：$($_.Exception.Message)"
}

try {
    Set-PrintConfiguration -PrinterName $PrinterName -Collate $false -ErrorAction Stop | Out-Null
}
catch {
    Write-Warn "写入默认打印配置失败（通常无妨）：$($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 5. 默认打印机（可选）
# ---------------------------------------------------------------------------

if ($SetDefault) {
    Write-Title '设置默认打印机'
    try {
        (New-Object -ComObject WScript.Network).SetDefaultPrinter($PrinterName)
        Write-Ok "「$PrinterName」已设为系统默认打印机"
    }
    catch {
        Write-Warn "设置默认打印机失败：$($_.Exception.Message)"
    }
}
elseif ($wasDefault -and -not $reuseExisting) {
    Write-Warn '原来的队列是系统默认打印机，现已删除；系统会自动挑选新的默认打印机。'
}

# ---------------------------------------------------------------------------
# 6. 可选：打印测试页
# ---------------------------------------------------------------------------

if ($TestPage) {
    Write-Title '打印测试页'
    $before    = Get-Item -LiteralPath $PortFile -ErrorAction SilentlyContinue
    $beforeLen = 0
    if ($before) { $beforeLen = $before.Length }

    # 注意：PrintTestPage 是 Win32_Printer 上的 WMI 方法，Get-CimInstance 的结果
    # 本身没有这个方法（Get-WmiObject 才有），所以走 Invoke-CimMethod。
    try {
        $cim = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $PrinterName }
        $rc  = (Invoke-CimMethod -InputObject $cim -MethodName PrintTestPage).ReturnValue
        if ($rc -ne 0) { Write-Warn "PrintTestPage 返回 $rc（非 0 表示可能失败）" }
    }
    catch {
        Write-Warn "调用 PrintTestPage 失败：$($_.Exception.Message)"
    }

    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $now = Get-Item -LiteralPath $PortFile -ErrorAction SilentlyContinue
        if ($now -and $now.Length -gt 0 -and $now.Length -ne $beforeLen) { $ok = $true; break }
    }
    if ($ok) {
        $now = Get-Item -LiteralPath $PortFile
        Write-Ok ("测试页已落盘：{0:N0} 字节" -f $now.Length)
    }
    else {
        Write-Warn '等待 30 秒仍未看到 out.pdf 变化，请检查打印队列里是否有卡住的作业。'
    }
}

# ---------------------------------------------------------------------------
# 7. 结果校验 + 成功提示
# ---------------------------------------------------------------------------

Write-Title '校验安装结果'

$printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if (-not $printer) { Stop-WithError "安装后找不到队列「$PrinterName」，安装失败。" }
$port = Get-PrinterPort -Name $PortFile -ErrorAction SilentlyContinue
if (-not $port) { Stop-WithError "安装后找不到端口「$PortFile」，安装失败。" }

Write-Ok "队列：$($printer.Name)  |  驱动：$($printer.DriverName)  |  端口：$($printer.PortName)"
Write-Ok "端口：$($port.Name)"

$tokenState = '尚未生成（桌面 App 首次启动时会写入）'
if (Test-Path -LiteralPath $TokenFile) { $tokenState = '已存在' }

# ---------------------------------------------------------------------------
# 6. 按需唤醒
# ---------------------------------------------------------------------------
#
# 队列只是"把作业写成 out.pdf"，真正上传的是桌面 App。而 App 现在不常驻了
# （关窗口空闲一会儿就整个退出，空闲内存 0），所以得给它装一个"有活干了"的钩子 ——
# 打印事件触发 + 每分钟兜底的计划任务。见 install-wake.ps1 的说明。
#
# 失败不让整个安装失败：队列已经装好了，最多是"打印后要手动开一下客户端"，
# 那也比回滚掉一台能用的打印机强。
Write-Title '安装按需唤醒（打印时自动叫起上传进程）'

$wakeScript = Join-Path $PSScriptRoot 'install-wake.ps1'
if (Test-Path -LiteralPath $wakeScript) {
    $wakeOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wakeScript `
        -Action install -SpoolDir $SpoolDir *>&1 | Out-String
    $wakeCode = $LASTEXITCODE
    if ($null -eq $wakeCode) { $wakeCode = 0 }
    Write-Host $wakeOut
    if ($wakeCode -eq 0) {
        Write-Ok '已装好：打印时会自动上传，平时不占内存'
    }
    else {
        Write-Warn "按需唤醒没装上（退出码 $wakeCode）。打印后需要手动打开一次客户端才会进云队列。"
        Write-Warn "可以手工重试： powershell -ExecutionPolicy Bypass -File `"$wakeScript`" -Action install"
    }
}
else {
    Write-Warn "找不到 install-wake.ps1，跳过按需唤醒安装：$wakeScript"
}

Write-Host ''
Write-Host '----------------------------------------------------------------' -ForegroundColor Green
Write-Host ' 安装完成' -ForegroundColor Green
Write-Host '----------------------------------------------------------------' -ForegroundColor Green
Write-Host "   打印机名称 : $PrinterName"
Write-Host "   落盘路径   : $PortFile"
Write-Host "   驱动       : $driverName"
Write-Host "   本地 API   : $LocalApi"
Write-Host "   令牌文件   : $TokenFile（$tokenState）"
Write-Host ''
Write-Host '   现在可以在 Word / 浏览器里选择这个打印机；每打印一份，'
Write-Host '   out.pdf 就会被重写成这一份的内容，由系统唤醒的上传进程取走上云。'
Write-Host '   （客户端平时不常驻，空闲不占内存。）'
Write-Host ''
if (-not $driverIsPdf) {
    Write-Warn '当前使用的是 PostScript 兜底驱动，落盘文件不是 PDF，上传大概率会失败。'
    Write-Host ''
}
if (-not $SetDefault) {
    Write-Host '   （未设为默认打印机；如需设为默认，加 -SetDefault 重新执行。）' -ForegroundColor DarkGray
    Write-Host ''
}

exit 0
