#Requires -Version 5.1
<#
.SYNOPSIS
    南科大云打印 —— Windows 虚拟打印机卸载脚本。

.DESCRIPTION
    删除本方案注册的打印队列和端口，可选删除落盘目录。

    本脚本只会操作「SUSTech_Printer」这一个队列，以及 %ProgramData%\SUSTechPrint\spool\out.pdf
    这一个端口。联创（vendor）驱动遗留的 `????????` 队列和端口不会被触碰（脚本里有硬性防护）。

.PARAMETER PrinterName
    队列显示名，默认「SUSTech_Printer」。必须与 install-printer.ps1 的默认值和
    App 的 lib/paths.mjs 里 PRINTER_NAME 一致 —— 否则不带参数执行会去删一个不存在的队列，
    真正的队列却留了下来。

.PARAMETER SpoolDir
    落盘目录，默认 %ProgramData%\SUSTechPrint\spool。

.PARAMETER KeepSpool
    保留落盘目录（以及里面的 out.pdf / processing / done / failed 等）。
    默认**不保留**，即连目录一起删掉；如果你还想留下没上传完的作业，加这个开关。

.PARAMETER KeepConfig
    保留 %ProgramData%\SUSTechPrint 下的其它文件（driver-token、driver.log 等）。
    只有在删除落盘目录时才需要关心：不加此开关时，如果 spool 删完目录变空，
    整个 SUSTechPrint 目录会被一并删除。默认不删父目录，见下方说明。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall-printer.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall-printer.ps1 -KeepSpool

.NOTES
    需要管理员权限。可重复执行：已经卸载干净时不会报错。
#>
[CmdletBinding()]
param(
    [string] $PrinterName = 'SUSTech_Printer',
    [string] $SpoolDir    = (Join-Path $env:ProgramData 'SUSTechPrint\spool'),
    [switch] $KeepSpool,
    [switch] $KeepConfig
)

$ErrorActionPreference = 'Stop'

# 联创（vendor）驱动留下来的队列/端口，绝对不要碰。
$VendorPrinterName = '????????'

$ConfigDir = Split-Path -Parent $SpoolDir
$PortFile  = Join-Path $SpoolDir 'out.pdf'

function Write-Title([string] $Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}
function Write-Step([string] $Text) { Write-Host "   ... $Text" }
function Write-Ok([string] $Text)   { Write-Host "   [OK] $Text" -ForegroundColor Green }
function Write-Warn([string] $Text) { Write-Host "   [!!] $Text" -ForegroundColor Yellow }
function Write-Bad([string] $Text)  { Write-Host "   [XX] $Text" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 0. 权限检查
# ---------------------------------------------------------------------------

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Bad '需要管理员权限才能删除打印机队列和端口。'
    Write-Host ''
    Write-Host '   请以管理员身份运行 PowerShell，再执行：' -ForegroundColor Yellow
    Write-Host "     powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -ForegroundColor White
    Write-Host ''
    exit 1
}

# 硬性防护：无论如何都不允许把 vendor 队列当成目标。
if ($PrinterName -eq $VendorPrinterName) {
    Write-Host ''
    Write-Bad "拒绝执行：$VendorPrinterName 是联创驱动遗留的队列，本脚本不会删除它。"
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '南科大云打印 —— Windows 虚拟打印机卸载' -ForegroundColor White
Write-Host "   队列名   : $PrinterName"
Write-Host "   端口文件 : $PortFile"
Write-Host "   落盘目录 : $SpoolDir$(if ($KeepSpool) { '（保留）' } else { '（将删除）' })"

# ---------------------------------------------------------------------------
# 1. 删队列
# ---------------------------------------------------------------------------

Write-Title '删除打印队列'

$printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if ($printer) {
    # 如果它正好是默认打印机，先改回「Microsoft Print to PDF」，避免系统没有默认打印机。
    try {
        # 用 Where-Object 而不是 -Filter "Name='...'"：WQL 对中文名和特殊字符不友好。
        $cim = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -eq $PrinterName }
        if ($cim -and $cim.Default) {
            $fallback = Get-Printer -Name 'Microsoft Print to PDF' -ErrorAction SilentlyContinue
            if ($fallback) {
                (New-Object -ComObject WScript.Network).SetDefaultPrinter('Microsoft Print to PDF')
                Write-Ok '本队列原为默认打印机，已把默认打印机改回「Microsoft Print to PDF」'
            }
        }
    }
    catch {
        Write-Warn "恢复默认打印机失败：$($_.Exception.Message)"
    }

    Write-Step "删除队列「$PrinterName」"
    Remove-Printer -Name $PrinterName -ErrorAction Stop
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue) {
        Write-Bad "队列「$PrinterName」仍存在，请关闭所有打印窗口后重试。"
        exit 1
    }
    Write-Ok "已删除队列「$PrinterName」"
}
else {
    Write-Ok "队列「$PrinterName」不存在，跳过"
}

# ---------------------------------------------------------------------------
# 2. 删端口
# ---------------------------------------------------------------------------

Write-Title '删除打印机端口'

if (Get-PrinterPort -Name $PortFile -ErrorAction SilentlyContinue) {
    Write-Step '删除端口'
    $lastError = $null
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Remove-PrinterPort -Name $PortFile -ErrorAction Stop
            $lastError = $null
            break
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds 400
        }
    }
    if ($lastError) {
        Write-Bad "端口删除失败：$($lastError.Exception.Message)"
        exit 1
    }
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-PrinterPort -Name $PortFile -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-PrinterPort -Name $PortFile -ErrorAction SilentlyContinue) {
        Write-Bad "端口「$PortFile」仍存在。"
        exit 1
    }
    Write-Ok '已删除端口'
}
else {
    Write-Ok '端口不存在，跳过'
}

# ---------------------------------------------------------------------------
# 3. 落盘目录
# ---------------------------------------------------------------------------

Write-Title '清理落盘目录'

if ($KeepSpool) {
    Write-Ok "按 -KeepSpool 保留：$SpoolDir"
}
elseif (Test-Path -LiteralPath $SpoolDir) {
    Remove-Item -LiteralPath $SpoolDir -Recurse -Force -ErrorAction Stop
    Write-Ok "已删除 $SpoolDir"
}
else {
    Write-Ok '落盘目录不存在，跳过'
}

# 令牌和日志留在 ConfigDir 下，默认不动 —— 里面可能还有 driver-token / driver.log。
if (-not $KeepConfig -and -not $KeepSpool) {
    $left = @(Get-ChildItem -LiteralPath $ConfigDir -Force -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Write-Warn "$ConfigDir 下还有其它文件，已保留："
        foreach ($f in $left) { Write-Host "         $($f.Name)" }
        Write-Host '        （driver-token / driver.log 属于桌面 App，本脚本不删除。）'
    }
}

# ---------------------------------------------------------------------------
# 4. 结果校验
# ---------------------------------------------------------------------------

Write-Title '校验卸载结果'

$stillPrinter = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
$stillPort    = Get-PrinterPort -Name $PortFile -ErrorAction SilentlyContinue

if ($stillPrinter -or $stillPort) {
    Write-Bad '卸载未完成，队列或端口仍然存在。'
    exit 1
}
Write-Ok '本方案的队列与端口均已移除'

# 明确确认 vendor 队列安然无恙。
$vendor = Get-Printer -Name $VendorPrinterName -ErrorAction SilentlyContinue
if ($vendor) {
    Write-Ok "联创遗留队列「$VendorPrinterName」仍在（驱动 $($vendor.DriverName)，端口 $($vendor.PortName)）"
    $vendorPort = Get-PrinterPort -Name $VendorPrinterName -ErrorAction SilentlyContinue
    if ($vendorPort) { Write-Ok "联创遗留端口「$VendorPrinterName」仍在" }
    else { Write-Warn "联创遗留端口「$VendorPrinterName」未找到 —— 可能是原本就没有，请人工确认。" }
}
else {
    Write-Warn "未找到联创遗留队列「$VendorPrinterName」。本脚本从未删除它，请人工确认其状态。"
}

Write-Host ''
Write-Host '----------------------------------------------------------------' -ForegroundColor Green
Write-Host ' 卸载完成' -ForegroundColor Green
Write-Host '----------------------------------------------------------------' -ForegroundColor Green
Write-Host "   已移除队列 : $PrinterName"
Write-Host "   已移除端口 : $PortFile"
Write-Host "   落盘目录   : $(if ($KeepSpool) { '已保留' } else { '已删除' }) $SpoolDir"
Write-Host ''

exit 0
