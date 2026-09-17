#Requires -Version 5.1
<#
.SYNOPSIS
    南科大云打印 —— 落盘文件监听器（可选兜底方案）。

.DESCRIPTION
    扫描 %ProgramData%\SUSTechPrint\spool\out.pdf，等它「写完」之后 POST 到本地 API，
    然后把它挪走。判断「写完」的条件是两个：
      1. 文件大小连续 StablePolls 次轮询都没有变化；
      2. 文件末尾是 PDF 的结束标记 %%EOF。
    两个条件都满足才认为作业完整，避免把半个文件传上去。

    **正常情况下不需要这个脚本**：桌面 App（Electron）自己会监听 spool 目录并上传。
    只有在「用户不想装桌面 App」或者「App 的监听坏了」时才用它兜底。
    注意：不要和桌面 App 同时运行，否则同一份作业可能被上传两次。

    本地 API 的地址不是固定的：桌面 App 在 127.0.0.1 上绑一个**随机空闲端口**，
    并把真实端口写进 %LOCALAPPDATA%\SUSTechPrint\api-port（JSON）。
    因此本脚本**每次提交前都会重新读一遍** api-port，绝不缓存 —— App 每次重启
    端口都会变。读不到 api-port 时才退回 127.0.0.1:8787（手动跑开发服务器的场景）。

.PARAMETER SpoolDir
    落盘目录，默认 %ProgramData%\SUSTechPrint\spool。

.PARAMETER ConfigDir
    配置目录，默认 %LOCALAPPDATA%\SUSTechPrint（api-port / driver-token / driver.log 都在这里，每用户一份）。

.PARAMETER ApiBase
    强制指定 API 基址（测试/调试用）。默认空 = 自动从 api-port 发现。

.PARAMETER ApiPortFile
    api-port 文件路径，默认 <ConfigDir>\api-port。

.PARAMETER TokenFile
    驱动令牌文件，默认 <ConfigDir>\driver-token（一行 64 个十六进制字符）。

.PARAMETER PollMs
    轮询间隔毫秒，默认 1000。

.PARAMETER StablePolls
    需要连续多少次「大小不变」才算稳定，默认 2（即至少观察 3 次）。

.PARAMETER RetrySeconds
    可重试失败（未登录 / 网络不通 / 服务端 5xx）后，隔多少秒再试一次，默认 30。

.PARAMETER Once
    只处理一轮（把当前能处理的处理完）就退出，方便配合任务计划程序。

.PARAMETER SkipExisting
    启动时如果 out.pdf 已经存在，跳过它而不是上传。默认会上传（避免丢作业），
    但会在日志里明确提示这是一个「启动前就存在」的文件。

.PARAMETER LogFile
    日志文件，默认 <ConfigDir>\driver.log。传空字符串可关闭写文件。
    注意这个文件是**桌面 App 和驱动脚本共用**的，所以本脚本写进去的每一行都以
    `[sustech-print]` 开头，方便和 App 的日志区分。

.PARAMETER SelfTest
    只跑内置自检（单元测试），不进入监听循环。用于验证判断逻辑是否正确。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File watch-spool.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File watch-spool.ps1 -Once

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File watch-spool.ps1 -SelfTest

.NOTES
    本脚本不需要管理员权限（spool 目录已授权 Users 可读写）。
    本地 API 约定：POST /api/driver/print，裸 body，头部 x-driver-token / content-type /
    x-file-name（百分号编码的 UTF-8 文件名）。
#>
[CmdletBinding()]
param(
    [string] $SpoolDir     = (Join-Path $env:ProgramData 'SUSTechPrint\spool'),
    [string] $ConfigDir    = (Join-Path $env:LOCALAPPDATA 'SUSTechPrint'),
    [string] $ApiBase      = '',
    [string] $ApiUrlFile   = '',
    [string] $ApiPortFile  = '',
    [string] $TokenFile    = '',
    [int]    $PollMs       = 1000,
    [int]    $StablePolls  = 2,
    [int]    $RetrySeconds = 30,
    [switch] $Once,
    [switch] $SkipExisting,
    [switch] $RecoverProcessing,
    [string] $LogFile      = '',
    [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'

# 参数默认值在脚本体里解析，这样 -ConfigDir 能一次性影响 api-port / driver-token / driver.log。
if (-not $ApiUrlFile)  { $ApiUrlFile  = Join-Path $ConfigDir 'api' }
if (-not $ApiPortFile) { $ApiPortFile = Join-Path $ConfigDir 'api-port' }
if (-not $TokenFile)   { $TokenFile   = Join-Path $ConfigDir 'driver-token' }
if (-not $LogFile)     { $LogFile     = Join-Path $ConfigDir 'driver.log' }

# 读不到 api-port 时的开发兜底地址。
$FallbackApiBase = 'http://127.0.0.1:8787'

$PortFile      = Join-Path $SpoolDir 'out.pdf'
$ProcessingDir = Join-Path $SpoolDir 'processing'
$DoneDir       = Join-Path $SpoolDir 'done'
$PendingDir    = Join-Path $SpoolDir 'pending'
$FailedDir     = Join-Path $SpoolDir 'failed'

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------

function Write-Log {
    <#
        控制台输出带颜色、好读；写进 driver.log 的行统一加 [sustech-print] 前缀，
        因为这个文件是桌面 App 和驱动脚本共用的，必须能区分来源。
    #>
    param(
        [Parameter(Mandatory)] [string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'OK')] [string] $Level = 'INFO'
    )

    $color = 'Gray'
    switch ($Level) {
        'OK'    { $color = 'Green' }
        'WARN'  { $color = 'Yellow' }
        'ERROR' { $color = 'Red' }
    }
    Write-Host ("{0} [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message) -ForegroundColor $color

    if ($LogFile -and $LogFile.Length -gt 0) {
        try {
            $dir = Split-Path -Parent $LogFile
            if ($dir -and -not (Test-Path -LiteralPath $dir)) {
                New-Item -ItemType Directory -Force -Path $dir | Out-Null
            }
            # 简易轮转：超过 2 MB 就改成 .1
            if ((Test-Path -LiteralPath $LogFile) -and
                (Get-Item -LiteralPath $LogFile).Length -gt 2MB) {
                $bak = "$LogFile.1"
                if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }
                Move-Item -LiteralPath $LogFile -Destination $bak -Force
            }
            $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            Add-Content -LiteralPath $LogFile -Value "[sustech-print] [$Level] $stamp $Message" -Encoding UTF8
        }
        catch {
            # 日志写不进去不能影响主流程
        }
    }
}

function Ensure-Directory([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 纯函数区（-SelfTest 会直接测这些）
# ---------------------------------------------------------------------------

function Get-ApiBase {
    <#
        解析本地 API 基址。**每次提交前都要重新调用**，因为 App 每次重启都会换端口。

        覆盖顺序（刻意和 macOS 的 driver/macos/sustech-print 保持一致）：
          1) -ApiBase 显式指定
          2) <ConfigDir>\api        —— 直接写一行 URL 的旧约定
          3) <ConfigDir>\api-port   —— App 用随机端口时写的 JSON
          4) http://127.0.0.1:8787  —— 手动跑开发服务器的兜底

        返回 hashtable：Base / Source
          Source = override | api-file | api-port | fallback
    #>
    param(
        [string] $Override = '',
        [string] $UrlFile  = '',
        [string] $PortFile = ''
    )

    if ($Override -and $Override.Trim().Length -gt 0) {
        return @{ Base = $Override.Trim().TrimEnd('/'); Source = 'override' }
    }

    # 2) 直接写一行 URL 的 api 文件
    if ($UrlFile -and (Test-Path -LiteralPath $UrlFile)) {
        try {
            $first = Get-Content -LiteralPath $UrlFile -TotalCount 1 -ErrorAction Stop
            if ($first) {
                $u = ([string]$first).Trim()
                if ($u -match '^https?://') {
                    return @{ Base = $u.TrimEnd('/'); Source = 'api-file' }
                }
            }
        }
        catch {
            # 读不了就当没有，继续往下走
        }
    }

    # 3) api-port JSON
    if ($PortFile -and (Test-Path -LiteralPath $PortFile)) {
        try {
            $raw = Get-Content -LiteralPath $PortFile -Raw -ErrorAction Stop
            if ($raw -and $raw.Trim().Length -gt 0) {
                $j = $raw | ConvertFrom-Json
                if ($j -and $j.port) {
                    $port = 0
                    [void][int]::TryParse([string]$j.port, [ref]$port)
                    if ($port -gt 0 -and $port -le 65535) {
                        $h = '127.0.0.1'
                        if ($j.host) {
                            $cand = ([string]$j.host).Trim()
                            # 0.0.0.0 / :: 不是可连接的地址，换成回环地址（和 macOS 一致）
                            if ($cand -and $cand -ne '0.0.0.0' -and $cand -ne '::' -and $cand -ne '[::]') {
                                $h = $cand
                            }
                        }
                        return @{ Base = ('http://{0}:{1}' -f $h, $port); Source = 'api-port' }
                    }
                }
            }
        }
        catch {
            # JSON 坏了，或者 App 正写到一半 —— 当作没读到，走兜底。
        }
    }

    return @{ Base = $FallbackApiBase; Source = 'fallback' }
}

function Get-DriverToken {
    <#  读令牌文件。读不到（App 还没写过）就返回 $null，不抛异常。 #>
    param([string] $Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        if ($null -eq $raw) { return $null }
        $tok = ([string]$raw).Trim()
        if ($tok.Length -eq 0) { return $null }
        return $tok
    }
    catch { return $null }
}

function Get-SpoolFileState {
    <#
        读取 spool 文件当前状态，返回 hashtable：
          Exists / Length / HeaderOk / HasEof / Tail
        HeaderOk：开头是 %PDF-
        HasEof  ：结尾是 %%EOF（允许后面跟空白/换行）
        文件被独占打开时返回 Exists=$true, Length=-1（视为「还不能读 / 还没写完」）。
    #>
    param([Parameter(Mandatory)] [string] $Path)

    $state = @{ Exists = $false; Length = -1; HeaderOk = $false; HasEof = $false; Tail = '' }

    if (-not (Test-Path -LiteralPath $Path)) { return $state }
    $state.Exists = $true

    $fs = $null
    try {
        # FileShare.ReadWrite：假脱机服务可能还开着它，我们不抢独占锁。
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                                     [System.IO.FileAccess]::Read,
                                     [System.IO.FileShare]::ReadWrite)
    }
    catch {
        return $state   # 被独占占用 —— 作业还在写，未就绪
    }

    try {
        $len = $fs.Length
        $state.Length = $len
        if ($len -lt 8) { return $state }

        $headLen = [Math]::Min(8, $len)
        $headBuf = New-Object byte[] $headLen
        [void]$fs.Seek(0, [System.IO.SeekOrigin]::Begin)
        [void]$fs.Read($headBuf, 0, $headLen)
        $state.HeaderOk = ([System.Text.Encoding]::ASCII.GetString($headBuf, 0, $headLen)).StartsWith('%PDF-')

        $take = [Math]::Min(2048, $len)
        $tailBuf = New-Object byte[] $take
        [void]$fs.Seek(-$take, [System.IO.SeekOrigin]::End)
        $read = $fs.Read($tailBuf, 0, $take)
        $tail = [System.Text.Encoding]::ASCII.GetString($tailBuf, 0, $read)
        $state.Tail = $tail
        $state.HasEof = [regex]::IsMatch($tail, '%%EOF\s*$')
    }
    finally {
        $fs.Dispose()
    }

    return $state
}

function Test-SpoolFileReady {
    <#
        纯判定逻辑：
          - 文件存在且可读（Length >= 0）、非空
          - 本次大小 == 上次大小 → 稳定计数 +1，否则清零
          - 稳定计数 >= RequiredStable 且 末尾是 %%EOF → 就绪
        返回 hashtable：Ready / StableCount / Length
    #>
    param(
        [Parameter(Mandatory)] [hashtable] $State,
        [int] $PreviousLength = -1,
        [int] $StableCount    = 0,
        [int] $RequiredStable = 2
    )

    if (-not $State.Exists -or $State.Length -lt 0) {
        return @{ Ready = $false; StableCount = 0; Length = -1 }
    }
    if ($State.Length -eq 0) {
        return @{ Ready = $false; StableCount = 0; Length = 0 }
    }

    if ($State.Length -eq $PreviousLength) { $stable = $StableCount + 1 } else { $stable = 0 }

    $ready = ($stable -ge $RequiredStable) -and $State.HasEof
    return @{ Ready = $ready; StableCount = $stable; Length = $State.Length }
}

function Get-SpoolFileStamp {
    <#  用「大小 + 最后写入时间」给文件打一个指纹，用来判断文件是否被新作业重写过。 #>
    param([Parameter(Mandatory)] [string] $Path)
    try {
        $fi = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
        if (-not $fi) { return $null }
        return ('{0}|{1}' -f $fi.Length, $fi.LastWriteTimeUtc.Ticks)
    }
    catch { return $null }
}

function Get-PercentEncodedFileName {
    <#  x-file-name 用百分号编码的 UTF-8，服务端会 decodeURIComponent。 #>
    param([Parameter(Mandatory)] [string] $Name)
    return [System.Uri]::EscapeDataString($Name)
}

function Get-DefaultSpoolFileName {
    param([datetime] $When = (Get-Date))
    return ('云打印-{0}.pdf' -f $When.ToString('yyyyMMdd-HHmmss'))
}

function ConvertTo-DriverResponse {
    <#
        把「HTTP 状态码 + 响应体」翻译成统一的判定结果（纯函数，便于单测）：
          Outcome = ok | not-logged-in | retryable | unauthorized | failed
    #>
    param(
        [Parameter(Mandatory)] [int]    $Status,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Body
    )

    $json = $null
    if ($Body -and $Body.Trim().Length -gt 0) {
        try { $json = $Body | ConvertFrom-Json } catch { $json = $null }
    }

    if ($Status -eq 401) {
        return @{ Outcome = 'unauthorized'; Status = 401; Message = '驱动令牌缺失或错误（HTTP 401）'; Body = $Body }
    }

    if ($json) {
        if ($json.ok -eq $false -and $json.reason -eq 'not-logged-in') {
            # 服务端明确说是「没登录」—— 这是预期内的正常业务结果，不是崩溃。
            $msg = if ($json.message) { [string]$json.message } else { '本地客户端尚未登录' }
            return @{ Outcome = 'not-logged-in'; Status = $Status; Message = $msg; Body = $Body }
        }
        if ($json.ok -eq $true) {
            $reason = if ($json.reason) { [string]$json.reason } else { 'ok' }
            return @{ Outcome = 'ok'; Status = $Status; Message = "上传成功（$reason）"; Body = $Body }
        }
        if ($json.ok -eq $false) {
            $retryable = ($json.retryable -eq $true)
            $msg = if ($json.message) { [string]$json.message } else { "服务端返回 ok=false（reason=$($json.reason)）" }
            return @{
                Outcome = $(if ($retryable) { 'retryable' } else { 'failed' })
                Status  = $Status
                Message = $msg
                Body    = $Body
            }
        }
    }

    if ($Status -ge 200 -and $Status -lt 300) {
        return @{ Outcome = 'ok'; Status = $Status; Message = "HTTP $Status（响应体不是 JSON，按成功处理）"; Body = $Body }
    }
    if ($Status -ge 500) {
        return @{ Outcome = 'retryable'; Status = $Status; Message = "服务端错误 HTTP $Status"; Body = $Body }
    }
    return @{ Outcome = 'failed'; Status = $Status; Message = "请求失败 HTTP $Status"; Body = $Body }
}

# ---------------------------------------------------------------------------
# 等待文件写完
# ---------------------------------------------------------------------------

function Wait-SpoolFileReady {
    <#  轮询直到「大小稳定 + %%EOF」或者超时。返回 $true/$false。 #>
    param(
        [Parameter(Mandatory)] [string] $Path,
        [int] $RequiredStable = 2,
        [int] $DelayMs        = 1000,
        [int] $TimeoutMs      = 120000
    )

    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $prevLen  = -1
    $stable   = 0

    while ((Get-Date) -lt $deadline) {
        $state   = Get-SpoolFileState -Path $Path
        $verdict = Test-SpoolFileReady -State $state -PreviousLength $prevLen `
                                       -StableCount $stable -RequiredStable $RequiredStable
        if ($verdict.Ready) { return $true }

        $prevLen = $verdict.Length
        $stable  = $verdict.StableCount
        Start-Sleep -Milliseconds $DelayMs
    }
    return $false
}

# ---------------------------------------------------------------------------
# 与本地 API 通信
# ---------------------------------------------------------------------------

function Read-WebResponse {
    <#  把 .NET 的响应对象拆成 (状态码, 响应体)，再交给 ConvertTo-DriverResponse 判定。 #>
    param([Parameter(Mandatory)] $Response)

    $status = 0
    $body   = ''
    try {
        $status = [int]$Response.StatusCode
        $sr = New-Object System.IO.StreamReader($Response.GetResponseStream())
        try { $body = $sr.ReadToEnd() } finally { $sr.Dispose() }
    }
    catch {
        $body = ''
    }
    finally {
        try { $Response.Close() } catch { }
    }

    return ConvertTo-DriverResponse -Status $status -Body $body
}

function Send-PdfToLocalApi {
    <#  裸 body POST 一个 PDF，返回 ConvertTo-DriverResponse 的结构。 #>
    param(
        [Parameter(Mandatory)] [string] $Base,
        [Parameter(Mandatory)] [string] $Token,
        [Parameter(Mandatory)] [byte[]] $Bytes,
        [Parameter(Mandatory)] [string] $FileName
    )

    $uri = "$($Base.TrimEnd('/'))/api/driver/print"
    [System.Net.ServicePointManager]::Expect100Continue = $false

    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method           = 'POST'
    $req.ContentType      = 'application/pdf'
    $req.ContentLength    = $Bytes.Length
    $req.Timeout          = 300000
    $req.ReadWriteTimeout = 300000
    $req.Headers.Add('x-driver-token', $Token)
    $req.Headers.Add('x-file-name', (Get-PercentEncodedFileName $FileName))

    try {
        $stream = $req.GetRequestStream()
        try { $stream.Write($Bytes, 0, $Bytes.Length) }
        finally { $stream.Dispose() }
    }
    catch [System.Net.WebException] {
        $we = $_.Exception
        if ($we.Response) { return (Read-WebResponse -Response $we.Response) }
        return @{ Outcome = 'retryable'; Status = 0; Message = "连不上本地 API（$Base）：$($we.Message)"; Body = '' }
    }
    catch {
        return @{ Outcome = 'retryable'; Status = 0; Message = "请求发送失败：$($_.Exception.Message)"; Body = '' }
    }

    try {
        return (Read-WebResponse -Response $req.GetResponse())
    }
    catch [System.Net.WebException] {
        $we = $_.Exception
        if ($we.Response) { return (Read-WebResponse -Response $we.Response) }
        return @{ Outcome = 'retryable'; Status = 0; Message = "连不上本地 API（$Base）：$($we.Message)"; Body = '' }
    }
}

function Get-DriverStatus {
    param([string] $Base, [string] $Token)
    $uri = "$($Base.TrimEnd('/'))/api/driver/status"
    [System.Net.ServicePointManager]::Expect100Continue = $false
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = 'GET'
    $req.Headers.Add('x-driver-token', $Token)
    $req.Timeout = 10000
    try {
        $resp = $req.GetResponse()
        try {
            $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
            return ($body | ConvertFrom-Json)
        }
        finally { $resp.Close() }
    }
    catch [System.Net.WebException] {
        $we = $_.Exception
        if ($we.Response) {
            $s = [int]$we.Response.StatusCode
            $we.Response.Close()
            return [pscustomobject]@{ ok = $false; httpStatus = $s; reason = 'http-error' }
        }
        return [pscustomobject]@{ ok = $false; httpStatus = 0; reason = 'unreachable'; message = $we.Message }
    }
}

# ---------------------------------------------------------------------------
# 认领 / 归档 / 上传
# ---------------------------------------------------------------------------

function Move-SpoolFileAside {
    <#
        把文件挪到目标目录并唯一命名。优先原子 rename；被占用时退化成「复制 + 删除」。
        返回新路径；失败返回 $null。
    #>
    param(
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $TargetDir,
        [string] $FileName
    )

    Ensure-Directory $TargetDir
    if (-not $FileName) { $FileName = Get-DefaultSpoolFileName }
    $target = Join-Path $TargetDir $FileName

    $i = 1
    while (Test-Path -LiteralPath $target) {
        $base   = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
        $target = Join-Path $TargetDir ("{0}-{1}.pdf" -f $base, $i)
        $i++
    }

    try {
        [System.IO.File]::Move($Source, $target)
        return $target
    }
    catch {
        try {
            [System.IO.File]::Copy($Source, $target, $false)
            Remove-Item -LiteralPath $Source -Force -ErrorAction Stop
            return $target
        }
        catch {
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
            return $null
        }
    }
}

function Submit-ClaimedFile {
    <#
        上传一个已认领的文件，并按结果归档。返回 Outcome 字符串。

        API 基址在这里**重新解析一次**（api-port 每次 App 重启都会变，不能缓存）。
    #>
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Token,
        [int] $RetrySeconds = 30
    )

    $name  = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    $bytes = $null
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
    }
    catch {
        Write-Log "读取文件失败：$Path —— $($_.Exception.Message)" 'ERROR'
        return 'failed'
    }

    $resolved = Get-ApiBase -Override $ApiBase -UrlFile $ApiUrlFile -PortFile $ApiPortFile
    $base     = $resolved.Base
    if ($resolved.Source -eq 'fallback') {
        Write-Log "读不到 $ApiPortFile（App 可能从未启动过），退回开发兜底地址 $base" 'WARN'
    }

    Write-Log "上传 $name.pdf（$([Math]::Round($bytes.Length / 1KB, 1)) KB）→ $base/api/driver/print"

    $result = Send-PdfToLocalApi -Base $base -Token $Token -Bytes $bytes -FileName "$name.pdf"

    switch ($result.Outcome) {
        'ok' {
            $dst = Move-SpoolFileAside -Source $Path -TargetDir $DoneDir -FileName "$name.pdf"
            Write-Log "上传成功：$($result.Message)；已归档到 $(if ($dst) { $dst } else { '（归档失败）' })" 'OK'
            return 'ok'
        }
        'not-logged-in' {
            $dst = Move-SpoolFileAside -Source $Path -TargetDir $PendingDir -FileName "$name.pdf"
            Write-Log "客户端未登录，暂不上传：$($result.Message)；文件留待重试：$(if ($dst) { $dst } else { $Path })" 'WARN'
            return 'not-logged-in'
        }
        'retryable' {
            $dst = Move-SpoolFileAside -Source $Path -TargetDir $PendingDir -FileName "$name.pdf"
            Write-Log "暂时失败，${RetrySeconds}s 后重试：$($result.Message)；文件：$(if ($dst) { $dst } else { $Path })" 'WARN'
            return 'retryable'
        }
        'unauthorized' {
            $dst = Move-SpoolFileAside -Source $Path -TargetDir $PendingDir -FileName "$name.pdf"
            Write-Log "驱动令牌无效：$($result.Message)。请确认桌面 App 已启动并写入了 $TokenFile；文件：$(if ($dst) { $dst } else { $Path })" 'WARN'
            return 'unauthorized'
        }
        default {
            $dst = Move-SpoolFileAside -Source $Path -TargetDir $FailedDir -FileName "$name.pdf"
            Write-Log "上传失败（不再重试）：$($result.Message)；已移到 $(if ($dst) { $dst } else { $Path })" 'ERROR'
            return 'failed'
        }
    }
}

function Invoke-PendingRetry {
    <#  重试 pending 目录里积压的文件。返回本轮补传成功的个数。 #>
    param(
        [Parameter(Mandatory)] [string] $Token,
        [int] $RetrySeconds = 30
    )

    if (-not (Test-Path -LiteralPath $PendingDir)) { return 0 }

    $ok = 0
    $files = @(Get-ChildItem -LiteralPath $PendingDir -Filter '*.pdf' -File -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime)
    foreach ($f in $files) {
        if ((Submit-ClaimedFile -Path $f.FullName -Token $Token -RetrySeconds $RetrySeconds) -eq 'ok') {
            $ok++
        }
        else {
            break   # 第一个就失败，多半还是没登录 / 服务没起，继续试没意义
        }
    }
    return $ok
}

# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

function Invoke-WatchOnce {
    param(
        [string] $Token,
        [bool]   $TokenPresent,
        [int]    $RetrySeconds,
        [string] $IgnoreStamp = ''
    )

    if (-not (Test-Path -LiteralPath $PortFile)) { return 0 }

    # -SkipExisting：启动时已经存在的那一份，只要内容没被新作业重写过就一直跳过。
    if ($IgnoreStamp -and ((Get-SpoolFileStamp -Path $PortFile) -eq $IgnoreStamp)) {
        return 0
    }

    $pre = Get-SpoolFileState -Path $PortFile
    if ($pre.Exists -and $pre.Length -gt 0) {
        Write-Log "发现落盘文件（$($pre.Length) 字节），等待它写完……"
    }

    if (-not (Wait-SpoolFileReady -Path $PortFile -RequiredStable $StablePolls -DelayMs $PollMs)) {
        $post = Get-SpoolFileState -Path $PortFile
        if ($post.Exists -and $post.Length -gt 0 -and -not $post.HasEof) {
            Write-Log "等待超时：文件 $($post.Length) 字节但结尾不是 %%EOF，作业可能还在打印或被中断；下一轮继续等。" 'WARN'
        }
        else {
            Write-Log '等待超时：文件尚未就绪。' 'WARN'
        }
        return 0
    }

    # 先认领（挪出 spool 根目录），再上传 —— 这样新作业可以安全地重写 out.pdf。
    $claimed = Move-SpoolFileAside -Source $PortFile -TargetDir $ProcessingDir
    if (-not $claimed) {
        Write-Log "无法认领 $PortFile（可能被假脱机服务占用），下一轮再试。" 'WARN'
        return 0
    }
    Write-Log "已认领作业 → $claimed"

    if (-not $TokenPresent) {
        $dst = Move-SpoolFileAside -Source $claimed -TargetDir $PendingDir -FileName ([System.IO.Path]::GetFileName($claimed))
        Write-Log "还没有驱动令牌文件（$TokenFile）—— 桌面 App 从未启动过。文件已保留在 $(if ($dst) { $dst } else { $claimed })，App 启动并写入令牌后会自动重试。" 'WARN'
        return 0
    }

    if ((Submit-ClaimedFile -Path $claimed -Token $Token -RetrySeconds $RetrySeconds) -eq 'ok') {
        return 1
    }
    return 0
}

function Invoke-WatchLoop {
    Write-Log '南科大云打印 —— 落盘监听器启动'
    Write-Log "   spool      : $PortFile"
    Write-Log "   api 文件   : $ApiUrlFile（若存在则优先于 api-port）"
    Write-Log "   api-port   : $ApiPortFile"
    Write-Log "   令牌文件   : $TokenFile"
    Write-Log "   轮询间隔   : ${PollMs}ms；就绪条件：连续 $StablePolls 次大小不变且末尾为 %%EOF"

    Ensure-Directory $SpoolDir

    # -RecoverProcessing：上一次被强杀时可能把作业留在了 processing\ 里。
    # 默认不做（桌面 App 自己会在启动时回收），避免和 App 同时运行时重复上传。
    if ($RecoverProcessing -and (Test-Path -LiteralPath $ProcessingDir)) {
        $orphans = @(Get-ChildItem -LiteralPath $ProcessingDir -Filter '*.pdf' -File -ErrorAction SilentlyContinue)
        foreach ($o in $orphans) {
            $to = Join-Path $SpoolDir $o.Name
            if (Test-Path -LiteralPath $to) { $to = Join-Path $SpoolDir ('recovered-' + $o.Name) }
            try {
                [System.IO.File]::Move($o.FullName, $to)
                Write-Log "回收上次中断的作业：$($o.Name) → $to" 'WARN'
            }
            catch {
                Write-Log "回收 $($o.Name) 失败：$($_.Exception.Message)" 'WARN'
            }
        }
    }

    # 启动时探一次 API，把「能不能连上 / 登录没登录」讲清楚，省得用户猜。
    $probe = Get-ApiBase -Override $ApiBase -UrlFile $ApiUrlFile -PortFile $ApiPortFile
    Write-Log ("   本地 API   : {0}（来源：{1}）" -f $probe.Base, $probe.Source)
    if ($probe.Source -eq 'fallback') {
        Write-Log "既没有 $ApiUrlFile 也没有 $ApiPortFile。如果桌面 App 正在运行，说明它没写这两个文件；这里退回开发兜底地址 $($probe.Base)。" 'WARN'
    }
    $probeToken = Get-DriverToken -Path $TokenFile
    if ($probeToken) {
        $st = Get-DriverStatus -Base $probe.Base -Token $probeToken
        if ($st.ok -eq $true) {
            Write-Log ("   API 状态   : ok，loggedIn={0}，打印机={1}" -f $st.loggedIn, $st.printerName)
        }
        else {
            Write-Log ("   API 状态   : 探测失败（httpStatus={0} reason={1}）。这不影响监听，稍后每次上传都会重试。" -f $st.httpStatus, $st.reason) 'WARN'
        }
    }
    else {
        Write-Log "   令牌文件   : 不存在 —— 桌面 App 从未启动过；捕获到的作业会先排到 pending\ 等它启动。" 'WARN'
    }

    # -SkipExisting：把启动时就存在的那一份的指纹记下来，之后只要它没被重写过就一直跳过。
    $ignoreStamp = ''
    if ($SkipExisting) {
        $st = Get-SpoolFileState -Path $PortFile
        if ($st.Exists) {
            $ignoreStamp = Get-SpoolFileStamp -Path $PortFile
            Write-Log "按 -SkipExisting 忽略启动时已存在的 $PortFile（$($st.Length) 字节）；它被新作业重写后才会被处理。" 'WARN'
        }
    }

    $lastRetry      = [datetime]::MinValue
    $lastTokenWarn  = [datetime]::MinValue

    while ($true) {
        try {
            $token    = Get-DriverToken -Path $TokenFile
            $hasToken = ($null -ne $token -and $token.Length -gt 0)

            if (-not $hasToken) {
                # 每 5 分钟提醒一次，而不是只提醒一次就永远沉默。
                if (((Get-Date) - $lastTokenWarn).TotalMinutes -ge 5) {
                    $lastTokenWarn = Get-Date
                    Write-Log "读不到驱动令牌（$TokenFile）。这通常说明桌面 App 从未在这台机器上启动过 —— 它是唯一会创建该文件的程序。捕获到的作业会先留在 pending\ 里；App 启动后会自动补传。" 'WARN'
                }
                $token = ''
            }

            if ($hasToken -and ((Get-Date) - $lastRetry).TotalSeconds -ge $RetrySeconds) {
                $lastRetry = Get-Date
                $n = Invoke-PendingRetry -Token $token -RetrySeconds $RetrySeconds
                if ($n -gt 0) { Write-Log "pending 队列补传成功 $n 个" 'OK' }
            }

            [void](Invoke-WatchOnce -Token $token -TokenPresent $hasToken `
                                    -RetrySeconds $RetrySeconds -IgnoreStamp $ignoreStamp)

            if ($Once) {
                Write-Log '（-Once）本轮结束，退出。'
                return
            }
        }
        catch {
            Write-Log "本轮出错（不退出）：$($_.Exception.Message)" 'ERROR'
            if ($Once) { throw }
        }

        Start-Sleep -Milliseconds $PollMs
    }
}

# ---------------------------------------------------------------------------
# 自检（-SelfTest）：只测纯逻辑，不碰真实 API
# ---------------------------------------------------------------------------

$script:SelfTestPass = 0
$script:SelfTestFail = 0

function Assert-True {
    param([string] $Name, [bool] $Condition, [string] $Detail = '')
    if ($Condition) {
        $script:SelfTestPass++
        Write-Host "   [PASS] $Name" -ForegroundColor Green
    }
    else {
        $script:SelfTestFail++
        Write-Host "   [FAIL] $Name  $Detail" -ForegroundColor Red
    }
}

function Invoke-SelfTest {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('spt-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    try {
        Write-Host ''
        Write-Host '== watch-spool.ps1 自检' -ForegroundColor Cyan

        # ---------------------------------------------------------------
        Write-Host ' -- Get-ApiBase（动态端口发现）'
        Assert-True '没有 api-port 且没有 -ApiBase → 退回 8787' `
            ((Get-ApiBase -PortFile (Join-Path $tmp 'nope')).Base -eq 'http://127.0.0.1:8787')
        Assert-True '退回时 Source=fallback' `
            ((Get-ApiBase -PortFile (Join-Path $tmp 'nope')).Source -eq 'fallback')

        $ap = Join-Path $tmp 'api-port'
        Set-Content -LiteralPath $ap -Value '{"port":61714,"host":"127.0.0.1","updatedAt":1789648103557}' -Encoding ASCII -NoNewline
        Assert-True '读到 api-port 的随机端口' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:61714')
        Assert-True '来源标为 api-port' ((Get-ApiBase -PortFile $ap).Source -eq 'api-port')

        Set-Content -LiteralPath $ap -Value '{"port":51000,"updatedAt":1}' -Encoding ASCII -NoNewline
        Assert-True 'host 缺失时默认 127.0.0.1' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:51000')

        Set-Content -LiteralPath $ap -Value '{"port":51234,"host":"localhost","updatedAt":1}' -Encoding ASCII -NoNewline
        Assert-True 'host 存在时按 host 拼' ((Get-ApiBase -PortFile $ap).Base -eq 'http://localhost:51234')

        Set-Content -LiteralPath $ap -Value '{ this is not json' -Encoding ASCII -NoNewline
        Assert-True 'api-port 是坏 JSON → 退回 8787' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:8787')

        Set-Content -LiteralPath $ap -Value '{"port":0}' -Encoding ASCII -NoNewline
        Assert-True 'port=0 视为无效 → 退回 8787' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:8787')

        Set-Content -LiteralPath $ap -Value '{"port":70000}' -Encoding ASCII -NoNewline
        Assert-True 'port 越界 → 退回 8787' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:8787')

        Set-Content -LiteralPath $ap -Value '' -Encoding ASCII -NoNewline
        Assert-True 'api-port 为空文件 → 退回 8787' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:8787')

        Assert-True '-ApiBase 覆盖优先' ((Get-ApiBase -Override 'http://127.0.0.1:9999/' -PortFile $ap).Base -eq 'http://127.0.0.1:9999')
        Assert-True '-ApiBase 覆盖时 Source=override' ((Get-ApiBase -Override 'http://127.0.0.1:9999' -PortFile $ap).Source -eq 'override')

        Set-Content -LiteralPath $ap -Value '{"port":61714,"host":"127.0.0.1"}' -Encoding ASCII -NoNewline
        Assert-True '端口变了会读到新端口（证明没有缓存）' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:61714')
        Set-Content -LiteralPath $ap -Value '{"port":62000,"host":"127.0.0.1"}' -Encoding ASCII -NoNewline
        Assert-True '再次调用读到更新后的端口' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:62000')

        Set-Content -LiteralPath $ap -Value '{"port":51000,"host":"0.0.0.0"}' -Encoding ASCII -NoNewline
        Assert-True 'host=0.0.0.0 换成回环地址（和 macOS 一致）' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:51000')
        Set-Content -LiteralPath $ap -Value '{"port":51000,"host":"::"}' -Encoding ASCII -NoNewline
        Assert-True 'host=:: 换成回环地址' ((Get-ApiBase -PortFile $ap).Base -eq 'http://127.0.0.1:51000')

        # api 文件（直接写 URL 的旧约定）优先于 api-port
        $auf = Join-Path $tmp 'api'
        Set-Content -LiteralPath $ap  -Value '{"port":51000,"host":"127.0.0.1"}' -Encoding ASCII -NoNewline
        Set-Content -LiteralPath $auf -Value "http://127.0.0.1:61001`n" -Encoding ASCII -NoNewline
        Assert-True 'api 文件优先于 api-port' ((Get-ApiBase -UrlFile $auf -PortFile $ap).Base -eq 'http://127.0.0.1:61001')
        Assert-True 'api 文件命中时 Source=api-file' ((Get-ApiBase -UrlFile $auf -PortFile $ap).Source -eq 'api-file')
        Assert-True '-ApiBase 优先于 api 文件' ((Get-ApiBase -Override 'http://127.0.0.1:9999' -UrlFile $auf -PortFile $ap).Base -eq 'http://127.0.0.1:9999')

        Set-Content -LiteralPath $auf -Value 'not-a-url' -Encoding ASCII -NoNewline
        Assert-True 'api 文件内容不是 URL 时被忽略，继续用 api-port' ((Get-ApiBase -UrlFile $auf -PortFile $ap).Base -eq 'http://127.0.0.1:51000')
        Set-Content -LiteralPath $auf -Value '' -Encoding ASCII -NoNewline
        Assert-True 'api 文件为空时被忽略' ((Get-ApiBase -UrlFile $auf -PortFile $ap).Base -eq 'http://127.0.0.1:51000')
        Remove-Item -LiteralPath $auf -Force -ErrorAction SilentlyContinue
        Assert-True 'api 文件不存在时用 api-port' ((Get-ApiBase -UrlFile $auf -PortFile $ap).Base -eq 'http://127.0.0.1:51000')

        # ---------------------------------------------------------------
        Write-Host ' -- Get-DriverToken'
        $tf = Join-Path $tmp 'driver-token'
        Assert-True '令牌文件不存在 → $null' ($null -eq (Get-DriverToken -Path (Join-Path $tmp 'nope')))
        $hex64 = ('a1b2c3d4' * 8)
        Set-Content -LiteralPath $tf -Value "$hex64`r`n" -Encoding ASCII -NoNewline
        Assert-True '读出 64 位十六进制令牌并去掉换行' ((Get-DriverToken -Path $tf) -eq $hex64)
        Set-Content -LiteralPath $tf -Value '   ' -Encoding ASCII -NoNewline
        Assert-True '全空白令牌视为没有令牌' ($null -eq (Get-DriverToken -Path $tf))

        # ---------------------------------------------------------------
        Write-Host ' -- Write-Log 前缀（driver.log 与 App 共用，必须能区分）'
        $lf = Join-Path $tmp 'driver.log'
        $script:LogFile = $lf
        Write-Log 'prefix-probe' 'INFO'
        $script:LogFile = ''
        $firstLine = (Get-Content -LiteralPath $lf -TotalCount 1)
        Assert-True '日志行以 [sustech-print] 开头' ($firstLine.StartsWith('[sustech-print] ')) "got=$firstLine"
        Assert-True '日志行带级别标记 [INFO]' ($firstLine -match '\[sustech-print\] \[INFO\] ') "got=$firstLine"

        # ---------------------------------------------------------------
        Write-Host ' -- Get-PercentEncodedFileName'
        $enc = Get-PercentEncodedFileName '云打印-20250101-120000.pdf'
        Assert-True '中文被百分号编码' ($enc -match '%E4%BA%91') "got=$enc"
        Assert-True '编码结果不含裸空格' (-not $enc.Contains(' ')) "got=$enc"
        Assert-True '解码可往返' (([System.Uri]::UnescapeDataString($enc)) -eq '云打印-20250101-120000.pdf')

        # ---------------------------------------------------------------
        Write-Host ' -- Get-SpoolFileState'
        $okPath = Join-Path $tmp 'ok.pdf'
        $body   = '%PDF-1.7' + ("`n" * 20) + 'stream...' + ("`n" * 5) + '%%EOF' + "`n"
        [System.IO.File]::WriteAllText($okPath, $body, [System.Text.Encoding]::ASCII)
        $st = Get-SpoolFileState -Path $okPath
        Assert-True '存在' ($st.Exists)
        Assert-True '大小正确' ($st.Length -eq $body.Length)
        Assert-True '头部 %PDF- 识别' ($st.HeaderOk)
        Assert-True '尾部 %%EOF 识别（带结尾换行）' ($st.HasEof)

        $noEof = Join-Path $tmp 'noeof.pdf'
        [System.IO.File]::WriteAllText($noEof, '%PDF-1.7' + ("`n" * 5000), [System.Text.Encoding]::ASCII)
        $st2 = Get-SpoolFileState -Path $noEof
        Assert-True '半截文件：HeaderOk 为真' ($st2.HeaderOk)
        Assert-True '半截文件：HasEof 为假' (-not $st2.HasEof)

        $psPath = Join-Path $tmp 'ps.ps'
        [System.IO.File]::WriteAllText($psPath, '%!PS-Adobe-3.0' + ("`n" * 50) + '%%EOF', [System.Text.Encoding]::ASCII)
        $st3 = Get-SpoolFileState -Path $psPath
        Assert-True 'PostScript 文件：HeaderOk 为假（能与 PDF 区分）' (-not $st3.HeaderOk)
        Assert-True 'PostScript 文件：HasEof 为真' ($st3.HasEof)

        $tiny = Join-Path $tmp 'tiny.pdf'
        [System.IO.File]::WriteAllText($tiny, 'ab', [System.Text.Encoding]::ASCII)
        Assert-True '过小的文件不算就绪' (-not (Get-SpoolFileState -Path $tiny).HasEof)
        Assert-True '不存在的文件：Exists 为假' (-not (Get-SpoolFileState -Path (Join-Path $tmp 'nope.pdf')).Exists)

        # ---------------------------------------------------------------
        Write-Host ' -- Test-SpoolFileReady（纯判定逻辑）'
        $ready = Get-SpoolFileState -Path $okPath
        $v = Test-SpoolFileReady -State $ready -PreviousLength $ready.Length -StableCount 0 -RequiredStable 2
        Assert-True '第 1 次观察：稳定计数 1，未就绪' ((-not $v.Ready) -and ($v.StableCount -eq 1))
        $v = Test-SpoolFileReady -State $ready -PreviousLength $ready.Length -StableCount 1 -RequiredStable 2
        Assert-True '第 2 次观察：稳定计数 2，就绪' ($v.Ready -and ($v.StableCount -eq 2))
        $v = Test-SpoolFileReady -State $ready -PreviousLength ($ready.Length + 100) -StableCount 5 -RequiredStable 2
        Assert-True '大小变化会清零稳定计数' ((-not $v.Ready) -and ($v.StableCount -eq 0))

        $notReady = Get-SpoolFileState -Path $noEof
        $v = Test-SpoolFileReady -State $notReady -PreviousLength $notReady.Length -StableCount 9 -RequiredStable 2
        Assert-True '大小已稳定但没有 %%EOF → 不就绪' (-not $v.Ready)

        $v = Test-SpoolFileReady -State @{ Exists = $true; Length = 0; HasEof = $false; HeaderOk = $false; Tail = '' } `
                                 -PreviousLength 0 -StableCount 5 -RequiredStable 2
        Assert-True '空文件不就绪' (-not $v.Ready)

        $v = Test-SpoolFileReady -State @{ Exists = $true; Length = -1; HasEof = $false; HeaderOk = $false; Tail = '' } `
                                 -PreviousLength -1 -StableCount 5 -RequiredStable 2
        Assert-True '读不到（被独占）时重置稳定计数' ((-not $v.Ready) -and ($v.StableCount -eq 0))

        # ---------------------------------------------------------------
        Write-Host ' -- Wait-SpoolFileReady（真实写入过程，子进程边写边追）'
        $grow   = Join-Path $tmp 'growing.pdf'
        $writer = Join-Path $tmp 'writer.ps1'
        Set-Content -LiteralPath $writer -Encoding UTF8 -Value @"
`$p = '$grow'
`$fs = [System.IO.File]::Open(`$p, 'Create', 'Write', 'ReadWrite')
`$sw = New-Object System.IO.StreamWriter(`$fs)
`$sw.Write('%PDF-1.7')
`$sw.Flush()
Start-Sleep -Milliseconds 1200
for (`$i = 0; `$i -lt 5; `$i++) {
    `$sw.Write(('x' * 20000))
    `$sw.Flush()
    Start-Sleep -Milliseconds 400
}
`$sw.Write("``n%%EOF``n")
`$sw.Flush()
`$sw.Dispose()
"@
        $proc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $writer `
            -PassThru -WindowStyle Hidden

        $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
        $okReady = Wait-SpoolFileReady -Path $grow -RequiredStable 2 -DelayMs 200 -TimeoutMs 60000
        $sw2.Stop()
        $proc.WaitForExit()

        Assert-True '边写边长的文件最终判定为就绪' $okReady
        # 写手耗时约 3.2s；若判定过早会在 1.2s 内就返回。
        Assert-True '没有过早判定（等到了写手结束）' ($sw2.ElapsedMilliseconds -ge 2000) "elapsed=$($sw2.ElapsedMilliseconds)ms"
        $finalState = Get-SpoolFileState -Path $grow
        Assert-True '最终文件带 %%EOF' ($finalState.HasEof)
        Assert-True '最终文件大小与写手产出相符' ($finalState.Length -gt 100000) "len=$($finalState.Length)"

        $empty = Join-Path $tmp 'empty.pdf'
        [System.IO.File]::WriteAllBytes($empty, (New-Object byte[] 0))
        Assert-True '空文件等不到就绪，按超时返回 $false' `
            (-not (Wait-SpoolFileReady -Path $empty -RequiredStable 2 -DelayMs 100 -TimeoutMs 1500))

        # ---------------------------------------------------------------
        Write-Host ' -- Move-SpoolFileAside'
        $src    = Join-Path $tmp 'claim.pdf'
        [System.IO.File]::WriteAllText($src, 'x', [System.Text.Encoding]::ASCII)
        $tgtDir = Join-Path $tmp 'processing'
        $moved  = Move-SpoolFileAside -Source $src -TargetDir $tgtDir -FileName 'a.pdf'
        Assert-True '移动成功并返回新路径' ($null -ne $moved -and (Test-Path -LiteralPath $moved))
        Assert-True '源文件已被挪走' (-not (Test-Path -LiteralPath $src))

        $src2 = Join-Path $tmp 'claim2.pdf'
        [System.IO.File]::WriteAllText($src2, 'y', [System.Text.Encoding]::ASCII)
        $moved2 = Move-SpoolFileAside -Source $src2 -TargetDir $tgtDir -FileName 'a.pdf'
        Assert-True '同名文件不会互相覆盖' ($moved2 -ne $moved -and (Test-Path -LiteralPath $moved) -and (Test-Path -LiteralPath $moved2))

        # ---------------------------------------------------------------
        Write-Host ' -- ConvertTo-DriverResponse（结果分类）'
        Assert-True 'not-logged-in 是正常结果，不当作崩溃' `
            ((ConvertTo-DriverResponse -Status 200 -Body '{"ok":false,"reason":"not-logged-in","retryable":false,"message":"本地客户端尚未登录，请先打开「南科大云打印」登录"}').Outcome -eq 'not-logged-in')
        Assert-True 'ok:true → ok' `
            ((ConvertTo-DriverResponse -Status 200 -Body '{"ok":true,"reason":"ok","taskId":"t"}').Outcome -eq 'ok')
        Assert-True 'retryable:true → retryable' `
            ((ConvertTo-DriverResponse -Status 200 -Body '{"ok":false,"reason":"network","retryable":true,"message":"上传失败"}').Outcome -eq 'retryable')
        Assert-True 'retryable:false → failed' `
            ((ConvertTo-DriverResponse -Status 200 -Body '{"ok":false,"reason":"too-large","retryable":false,"message":"文件过大"}').Outcome -eq 'failed')
        Assert-True '401 → unauthorized' `
            ((ConvertTo-DriverResponse -Status 401 -Body '缺少或错误的驱动令牌').Outcome -eq 'unauthorized')
        Assert-True 'HTTP 500 → retryable' `
            ((ConvertTo-DriverResponse -Status 500 -Body 'boom').Outcome -eq 'retryable')
        Assert-True '非 JSON 的 200 → ok' `
            ((ConvertTo-DriverResponse -Status 200 -Body 'hello').Outcome -eq 'ok')
        Assert-True 'HTTP 400 → failed' `
            ((ConvertTo-DriverResponse -Status 400 -Body '请求体为空').Outcome -eq 'failed')
    }
    finally {
        $script:LogFile = $LogFile
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host ''
    if ($script:SelfTestFail -eq 0) {
        Write-Host "== 自检通过：$($script:SelfTestPass) 项全部通过" -ForegroundColor Green
    }
    else {
        Write-Host "== 自检失败：$($script:SelfTestPass) 项通过 / $($script:SelfTestFail) 项失败" -ForegroundColor Red
    }
    Write-Host ''

    if ($script:SelfTestFail -gt 0) { exit 1 }
    exit 0
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

if ($SelfTest) { Invoke-SelfTest }

Ensure-Directory $SpoolDir
Invoke-WatchLoop
exit 0
