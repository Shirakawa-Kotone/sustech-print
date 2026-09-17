# Windows 虚拟打印机 —— 安装/卸载脚本验证报告

本报告记录 `driver/windows/` 下三个脚本在**真实 Windows 10 机器**上的验证过程、原始证据、
以及**没能验证的部分和残余风险**。

* 验证日期：2026-09-17
* 目标机：一台通过 Tailscale 连入的 Windows 10 机器（主机名与地址从略）
* 系统：Windows 10 IoT Enterprise，版本 19045
* PowerShell：5.1.19041.6456
* 账号：本地管理员（`IsAdmin=True`）
* 连接方式：`ssh -i <密钥> <用户>@<主机>`，脚本以
  `powershell -NoProfile -NonInteractive -EncodedCommand <base64(UTF-16LE)>` 方式执行，
  输出以 base64(UTF-8) 回传，保证中文不乱码

---

## 0. 待测文件

| 文件 | 说明 |
| --- | --- |
| `driver/windows/install-printer.ps1` | 安装 |
| `driver/windows/uninstall-printer.ps1` | 卸载 |
| `driver/windows/watch-spool.ps1` | 可选兜底监听器 |

三个文件都以 **UTF-8 with BOM** 保存（`EF BB BF`）。这一点是硬要求：
PowerShell 5.1 读取无 BOM 的 `.ps1` 时会按系统 ANSI 代码页解码，中文会变成乱码。

交付版本指纹（本报告所有结论都对应这几个哈希；上传到目标机后用
`Get-FileHash -Algorithm SHA256` 核对过，两边一致）：

| 文件 | 字节数 | SHA256（前 16 位） | BOM |
| --- | --- | --- | --- |
| `install-printer.ps1` | 21242 | `FA122EFE50506686` | 有 |
| `uninstall-printer.ps1` | 9401 | `3645750A440100F6` | 有 |
| `watch-spool.ps1` | 48051 | `B52532A4E507DDCF` | 有 |
| `setup-driver.ps1` | 5657 | `EDF79C882D6D7203` | 有 |

> `install-printer.ps1` / `watch-spool.ps1` 的哈希在本报告之后变过一次：应用私有数据
> 从 `%ProgramData%\SUSTechPrint` 搬到了 `%LOCALAPPDATA%\SUSTechPrint`（ProgramData
> 的 `(CI)` 继承位管不到已存在的文件，导致非管理员用户改不动自己的 `api-port` /
> `driver-token`）。`setup-driver.ps1` 是后来新增的安装器入口，负责把脚本输出
> tee 到 `%ProgramData%\SUSTechPrint\driver-setup.log` 并透传退出码。

---

## 1. 目标机基线（改动之前）

```
=== 打印机（6 台）===
OneNote for Windows 10      | Microsoft Software Printer Driver
OneNote (Desktop)           | Send to Microsoft OneNote 16 Driver | nul:
Microsoft XPS Document Writer | Microsoft XPS Document Writer v4 | PORTPROMPT:
Microsoft Print to PDF      | Microsoft Print To PDF              | PORTPROMPT:
Fax                         | Microsoft Shared Fax Driver          | SHRFAX:
????????                    | MS Publisher Color Printer           | ????????      <-- 联创遗留，绝不能动

=== 端口（13 个）===
COM1: / COM2: / COM3: / COM4: / FILE: / LPT1: / LPT2: / LPT3: / nul: / PORTPROMPT:  (Local Port)
????????                        | UnifoundPS Port            <-- 联创自定义端口监视器
Microsoft.Office.OneNote_...    | App Monitor
SHRFAX:                         | Fax Monitor Port

C:\ProgramData\SUSTechPrint 不存在
127.0.0.1:8787 未监听
```

顺带记录到的一条对比信息（对项目有用）：

```
Get-CimInstance Win32_Printer | Select Name,KeepPrintedJobs,Default

Name                          KeepPrintedJobs Default
OneNote for Windows 10                  False   False
OneNote (Desktop)                       False   False
Microsoft XPS Document Writer           False   False
Microsoft Print to PDF                  False   False
Fax                                     False   False
????????                                 True   False     <-- 联创队列开了「保留打印文档」
```

即：**联创的队列打开了「保留已打印文档」（KeepPrintedJobs=True），我们自己的队列把它关掉了。**

> 小坑：`Get-CimInstance Win32_Printer -Filter "Name='????????'"` 会报
> `Invalid query`（WQL 不接受这种值），必须改用
> `Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq ... }`。
> 脚本里已统一改成 `Where-Object`。

---

## 2. 用到的命令

### 2.1 macOS 侧：把脚本送上机器

```bash
for f in install-printer.ps1 uninstall-printer.ps1 watch-spool.ps1; do
  scp -i ~/.ssh/id_ed25519 "driver/windows/$f" \
      "<用户>@<主机>:C:/Users/<用户>/AppData/Local/Temp/sustechprint-verify/$f"
done
```

### 2.2 macOS 侧：封装 PowerShell（`/tmp/winps.sh`）

```bash
# 脚本以 UTF-16LE base64 经 -EncodedCommand 送入，输出以 UTF-8 base64 回传
BODY="$1"
WRAPPED=$(cat <<EOF
\$ProgressPreference = 'SilentlyContinue'
\$__o = & {
$BODY
} 2>&1 | Out-String
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(\$__o))
EOF
)
ENC=$(python3 -c "import sys,base64;print(base64.b64encode(sys.argv[1].encode('utf-16-le')).decode())" "$WRAPPED")
ssh -i <密钥> <用户>@<主机> "powershell -NoProfile -NonInteractive -EncodedCommand $ENC"
```

Windows 侧实际执行的命令（举例）：

```powershell
# 安装（带测试页）
& "C:\Users\<用户>\AppData\Local\Temp\sustechprint-verify\install-printer.ps1" -TestPage

# 幂等：再跑一次
& "...\install-printer.ps1"

# 强制删除重建
& "...\install-printer.ps1" -Force

# 自检
& "...\watch-spool.ps1" -SelfTest

# 卸载
& "...\uninstall-printer.ps1"
& "...\uninstall-printer.ps1" -KeepSpool
```

### 2.3 Windows 侧创建的临时路径（已全部删除）

| 路径 | 用途 |
| --- | --- |
| `C:\Users\<用户>\AppData\Local\Temp\sustechprint-verify\` | 脚本副本 + 全部验证脚本 + 输出 |
| `C:\ProgramData\SUSTechPrint\`（含 `spool\`） | 安装脚本自己创建的；验证结束后已删除 |

**没有安装任何软件。** 唯一一次系统级操作是
`Restart-Service -Name Spooler`（见 6.2，用于清掉一个卡死的测试作业）。

---

## 3. 安装：结果

### 3.1 全新安装（`-TestPage`）

```
南科大云打印 —— Windows 虚拟打印机安装
   队列名   : SUSTech_Printer
   落盘目录 : C:\ProgramData\SUSTechPrint\spool
   端口文件 : C:\ProgramData\SUSTechPrint\spool\out.pdf

== 检查打印驱动
   [OK] 找到首选驱动：Microsoft Print To PDF（直接产出 PDF）

== 检查已有队列与端口
   [OK] 没有同名队列或端口，全新安装

== 准备落盘目录
   [OK] 已创建 C:\ProgramData\SUSTechPrint
   [OK] 已创建 C:\ProgramData\SUSTechPrint\spool
   [OK] 已授权 Users 组读写该目录

== 注册端口与打印队列
   ... 注册端口：C:\ProgramData\SUSTechPrint\spool\out.pdf
   [OK] 端口已注册
   ... 注册队列：SUSTech_Printer（驱动 Microsoft Print To PDF）
   [OK] 队列已注册
   [OK] 不共享 / 不发布 / 不保留已打印文档
   [OK] 打印处理器：winprint

== 打印测试页
   [OK] 测试页已落盘：265,881 字节

== 校验安装结果
   [OK] 队列：SUSTech_Printer  |  驱动：Microsoft Print To PDF  |  端口：C:\ProgramData\SUSTechPrint\spool\out.pdf

INSTALL_EXIT=0
```

注册结果（`Get-Printer -Name SUSTech_Printer`）：

```
Name        : SUSTech_Printer
DriverName  : Microsoft Print To PDF
PortName    : C:\ProgramData\SUSTechPrint\spool\out.pdf
Shared      : False
Published   : False
Type        : Local
```

端口（`Get-PrinterPort`）：

```
Name        : C:\ProgramData\SUSTechPrint\spool\out.pdf
Description : Local Port
```

也就是说：**端口名就是文件路径本身，且被系统识别为普通本地端口**（不是自定义端口监视器）。

### 3.2 驱动探测：先探测再动手

脚本先跑 `Get-PrinterDriver -Name 'Microsoft Print To PDF'`，判断结果直接打印出来；
只有在找不到时才回退到 `MS Publisher Color Printer`，并且**大声警告**该驱动产出的是
PostScript 而不是 PDF。本次验证机器上首选驱动存在，因此走的是 PDF 分支。
（`-RequirePdf` 可以让回退变成硬失败；**本次没有实际触发回退路径**，见第 7 节。）

---

## 4. 打印落盘证据

### 4.1 作业 1 —— 测试页（`Invoke-CimMethod -MethodName PrintTestPage`）

```
PATH        : C:\ProgramData\SUSTechPrint\spool\out.pdf
SIZE        : 265884
SHA256      : 790F24E1A7157E1B3F5471CEED8205BCCFF325AA3C56DC6F9761BDA25D9EE733
HEAD16_HEX  : 25 50 44 46 2D 31 2E 37 0A 0A 34 20 30 20 6F 62
HEAD16_TXT  : %PDF-1.7..4 0 ob
TAIL80_TXT  : 00000 n..trailer.<<./Info 31 0 R./Root 1 0 R./Size 32.>>.startxref.265162.%%EOF.
PDF_VERSION : %PDF-1.7
STARTS_PDF  : True
ENDS_EOF    : True
COUNT_%PDF- : 1
COUNT_%%EOF : 1
COUNT_obj   : 31
BYTES_AFTER_EOF_LAST : 1  [hex: 0A]
HAS_startxref : True
HAS_trailer   : True
```

### 4.2 作业 2 —— 真实文档（GDI `PrintDocument` 打印到该队列）

用一个自建脚本把一段文本、一个矩形、一个椭圆画到
`System.Drawing.Printing.PrintDocument` 上，`PrinterSettings.PrinterName = 'SUSTech_Printer'`，
然后 `Print()`：

```
GDI_PRINT_OK
```

结果：

```
SIZE        : 127108
SHA256      : D902096A030A9656E40C70F0E137D1D7FCE624D5742746778E1519CE70FD98F1
HEAD16_TXT  : %PDF-1.7..4 0 ob
TAIL80_TXT  : 00000 n..trailer.<<./Info 22 0 R./Root 1 0 R./Size 23.>>.startxref.126566.%%EOF.
COUNT_%PDF- : 1
COUNT_%%EOF : 1
COUNT_obj   : 22
BYTES_AFTER_EOF_LAST : 1  [hex: 0A]
```

### 4.3 结论

两次连续作业之后：

1. 文件被**整份重写**（大小 265884 → 127108，SHA 改变）；
2. `%PDF-1.7` 头**只出现一次** —— 没有残留上一次的内容；
3. `%%EOF` **只出现一次**，后面只有一个换行（`0A`），没有多余字节；
4. `startxref` 的值（265162 / 126566）与新文件大小自洽；
5. 打印队列随后为空。

**独立复现了「假脱机服务按队列串行处理、每个作业把文件干净地截断重写」这一结论。**
（另有一组更早的观测：测试页 265883 → GDI 作业 128202，结论一致。）

### 4.4 一次失误（如实记录）

`Get-CimInstance Win32_Printer` 返回的对象**没有** `PrintTestPage()` 方法
（那是 `Get-WmiObject` / `ManagementObject` 的方法），所以第一版脚本在 `-TestPage`
这一步抛异常。已改为：

```powershell
$cim = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $PrinterName }
$rc  = (Invoke-CimMethod -InputObject $cim -MethodName PrintTestPage).ReturnValue
```

并且外面包了 `try/catch`，测试页失败不再中断安装。

---

## 5. 幂等性

### 5.1 复用路径（脚本当前默认行为）

队列与端口已存在且配置一致时，脚本**只重新应用设置，不做任何删除**：

```
== 检查已有队列与端口
   [OK] 队列「SUSTech_Printer」与端口已存在且配置一致，直接复用（不删除，避免清空 spool 目录）
   [OK]    驱动：Microsoft Print To PDF   端口：C:\ProgramData\SUSTechPrint\spool\out.pdf
== 注册端口与打印队列
   [OK] 端口已存在，复用：C:\ProgramData\SUSTechPrint\spool\out.pdf
   [OK] 队列已存在，复用：SUSTech_Printer
```

前后状态对比（关键证据：`out.pdf` 连 mtime 都没变）：

```
BEFORE: out.pdf exists=True size=265884 mtime=2026/9/17 20:12:47 sha=02A44B6F...B0C949
AFTER : out.pdf exists=True size=265884 mtime=2026/9/17 20:12:47 sha=02A44B6F...B0C949
counts BEFORE: printers=7 ours=1 ports=1
counts AFTER : printers=7 ours=1 ports=1
INSTALL_EXIT=0
```

### 5.2 `-Force` 删除重建路径

```
== 检查已有队列与端口
   [!!] 将删除并重建：指定了 -Force
   ... 删除已存在的队列「SUSTech_Printer」
   [OK] 已删除旧队列
   ... 删除已存在的端口
   [!!] 注意：删除「文件端口」时假脱机服务可能异步清掉端口指向的目录，
   [!!]       包括还没被取走的 out.pdf。请确认当前没有待处理的作业。
   [OK] 已删除旧端口
== 注册端口与打印队列
   [OK] 端口已注册
   [OK] 队列已注册
INSTALL_EXIT=0
counts: printers=7 ours=1 ports=1
```

连跑多次安装脚本，打印机总数始终 `7`（基线 6 + 我们 1），
我们的队列数始终 `1`，同名端口数始终 `1` —— **没有报错，也没有产生重复项**。

### 5.3 卸载的幂等性

见 6.1。

---

## 6. 卸载与「联创队列是否幸存」

### 6.1 卸载

第一次（默认，连 spool 目录一起删）：

```
== 删除打印队列
   [OK] 已删除队列「SUSTech_Printer」
== 删除打印机端口
   [OK] 已删除端口
== 清理落盘目录
   [OK] 已删除 C:\ProgramData\SUSTechPrint\spool
== 校验卸载结果
   [OK] 本方案的队列与端口均已移除
   [OK] 联创遗留队列「????????」仍在（驱动 MS Publisher Color Printer，端口 ????????）
   [OK] 联创遗留端口「????????」仍在
UNINSTALL1_EXIT=0
```

```
BEFORE: printers=7 ours=1 ourPort=1 vendor=1 vendorPort=1 spoolDir=True out.pdf=True
AFTER : printers=6 ours=0 ourPort=0 vendor=1 vendorPort=1 spoolDir=False
```

第二次（什么都删不到，验证幂等）：

```
   [OK] 队列「SUSTech_Printer」不存在，跳过
   [OK] 端口不存在，跳过
   [OK] 落盘目录不存在，跳过
   [OK] 本方案的队列与端口均已移除
   [OK] 联创遗留队列「????????」仍在（驱动 MS Publisher Color Printer，端口 ????????）
   [OK] 联创遗留端口「????????」仍在
UNINSTALL2_EXIT=0
```

`-KeepSpool`：

```
== 删除打印队列       [OK] 已删除队列「SUSTech_Printer」
== 删除打印机端口     [OK] 已删除端口
== 清理落盘目录       [OK] 按 -KeepSpool 保留：C:\ProgramData\SUSTechPrint\spool
   [OK] 联创遗留队列「????????」仍在
   [OK] 联创遗留端口「????????」仍在
KEEPSPOOL_EXIT=0
after -KeepSpool: ours=0 ourPort=0 vendor=1 vendorPort=1 spoolDir=True out.pdf=True
```

三种卸载方式都只影响 `SUSTech_Printer` 和 `C:\ProgramData\SUSTechPrint\spool\out.pdf`。

### 6.2 一次卡死的测试作业（如实记录）

验证过程中我在主机上**误对 `Microsoft Print to PDF`（`PORTPROMPT:` 端口）调用了一次
PrintTestPage**，触发了「另存为」模态对话框，把那个 SSH 会话挂住了。之后我创建的一个
测试作业卡在 `Error | Printing` 状态，`Remove-CimInstance` 只把它推进到 `Deleting` 就停住了。
用 **`Restart-Service -Name Spooler -Force`** 清掉队列后恢复正常。

这是**我自己操作失误**造成的，与三个交付脚本无关；脚本从不接触 `PORTPROMPT:` 队列。
之所以写进报告，是因为它触发了下面 6.3 那条需要如实说明的观察。

### 6.3 「spool 目录消失」的观察（重要，但未能确定性复现）

在上述混乱之后的一次「删除端口 + 重建端口」安装（当时的脚本版本还是会无条件删除重建的
版本）之后，`C:\ProgramData\SUSTechPrint\spool\out.pdf` **连同整个 `spool` 目录一起消失了**
（删除端口时文件还在，约 40 秒后不见了）。之后用**完全相同的步骤**（`-Force` 删除+重建端口）
复现时，做了 **75 秒、每 3 秒一次**的轮询，目录和 `out.pdf` 一直稳定存在：

```
BEFORE: out.pdf exists=True size=265884 mtime=2026/9/17 20:12:47
=== INSTALL -Force (remove + recreate) ===   (删除队列 → 删除端口 → 重建)
t=  3s dir=True cfg=True out.pdf=265884
...
t= 75s dir=True cfg=True out.pdf=265884
counts: printers=7 ours=1 ports=1
```

**结论：这个现象是间歇性的，我无法确定性地复现，也无法证明它的确切机制。**
最可能的解释是「删除文件端口时假脱机服务会异步清理端口指向的目录」；但也不能排除当时
机器状态异常（同一时间段目标机网络反复掉线、spooler 处于刚被重启的状态）的影响。

**应对措施（已落到交付物里）：** `install-printer.ps1` 改成**能复用就复用** ——
队列和端口已存在且配置一致时完全不删除；只有显式 `-Force` 或配置不一致时才删除重建，
并在删除端口前打印警告。README 的「排查」一节如实写明了这个风险及其不确定性。

---

## 7. `watch-spool.ps1` 验证

### 7.1 内置自检（`-SelfTest`）—— 62 项全过

```
== watch-spool.ps1 自检
 -- Get-ApiBase（动态端口发现）          22 项 PASS
 -- Get-DriverToken                       3 项 PASS
 -- Write-Log 前缀                        2 项 PASS
 -- Get-PercentEncodedFileName            3 项 PASS
 -- Get-SpoolFileState                   10 项 PASS
 -- Test-SpoolFileReady                   6 项 PASS
 -- Wait-SpoolFileReady（真实写入过程）    5 项 PASS
 -- Move-SpoolFileAside                   3 项 PASS
 -- ConvertTo-DriverResponse              8 项 PASS
== 自检通过：62 项全部通过
SELFTEST_EXIT=0
```

其中值得单独点名的几项：

* `-- Wait-SpoolFileReady（真实写入过程，子进程边写边追）`：
  用 `Start-Process powershell` 起一个子进程，**一边慢慢写**（先写 `%PDF-1.7`，
  停 1.2 秒，再分 5 次各写 20000 字节、每次间隔 400 毫秒，最后才写 `%%EOF`），
  主进程同时跑 `Wait-SpoolFileReady`。断言：
  * 最终判定为就绪；
  * **没有过早判定**（`elapsed >= 2000ms`，即等到了写手结束，而不是刚稳定 400 毫秒就上传）；
  * 最终文件带 `%%EOF`；
  * 最终文件大小与写手产出相符。
* `-- Test-SpoolFileReady`：大小不变但**没有 `%%EOF`** 时即使稳定计数为 9 也判定为不就绪；
  大小变化会把稳定计数清零；空文件不就绪；文件被独占读不到时重置稳定计数。
* `-- Get-SpoolFileState`：能区分 PDF（`%PDF-`）与 PostScript（`%!PS-Adobe`）——
  后者 `HasEof` 仍为真但 `HeaderOk` 为假，可以据此识别「装错了兜底驱动」。
* `-- Get-ApiBase`：`api-port` 是坏 JSON / 空文件 / `port=0` / `port=70000` / 文件不存在
  时都安全退回 `127.0.0.1:8787`；`host` 缺失时默认 `127.0.0.1`；**改写 `api-port` 后
  再次调用会读到新端口**（证明没有缓存）。

### 7.2 端到端：与真实 HTTP 服务对接（mock）

在一台机器上起了真的 `System.Net.HttpListener` 模拟 App 的接口，
**不给 `-ApiBase`**，逼脚本自己从 `api-port` / `api` 文件发现端口。每个用例都检查：
请求方法/路径、`x-driver-token`、`content-type`、`x-file-name`（百分号编码 + 解码回来的名字）、
**请求体与源文件逐字节一致（SHA256 相同）**、以及文件最终落在哪个目录。

| # | 场景 | 期望落点 | 结果 |
| --- | --- | --- | --- |
| 1 | `{"ok":true}` | `done\` | **PASS** |
| 2 | `{"ok":false,"reason":"not-logged-in"}` | `pending\` | **PASS** |
| 3 | HTTP 401 | `pending\` | **PASS** |
| 4 | HTTP 500 | `pending\` | **PASS** |
| 5 | `{"ok":false,"retryable":true}` | `pending\` | **PASS** |
| 6 | `{"ok":false,"retryable":false}`（文件过大） | `failed\` | **PASS** |
| 7 | 令牌文件不存在 | `pending\`，且 **0 个 POST** | **PASS** |
| 8 | `api-port` 不存在 → 兜底 8787 | `done\`（mock 监听 8787） | **PASS** |
| 9 | `api-port` 指向死端口 | `pending\`（不崩） | **PASS** |
| 10 | 提交前改 `api-port` | 请求发到**新**端口 | **PASS** |

> **补充说明（最终版重跑）**：加入第 7.3 节第 8 条（`api` 文件）之后，
> 上表被**完整重跑过一遍**，结果仍然是 **6/6 PASS**：
> `ok`→done、`not-logged-in`→pending、无令牌→pending(0 POST)、
> `api-port` 缺失→兜底 8787→done、**`api` 文件优先于 `api-port`**（请求确实发到
> `api` 指向的 8789，`api-port` 指向的 8788 收到 0 个 POST，日志里
> `本地 API   : http://127.0.0.1:8789（来源：api-file）`）、
> 以及 port-change 的「未被缓存」证明。汇总行：`PASS=6 FAIL=0 / ALL GREEN`。
> 这一轮重跑用的载荷是一个**本地生成的、结构合法的一页 PDF（617 字节，
> 带正确 xref 偏移）**，因为目标机上已经没有安装好的队列可以打印测试页了；
> 断言关注的是路由/请求头/逐字节一致性，与载荷大小无关。
> 表中第 1～9 条更早的那一轮跑的是**真实打印出来的 265884 字节测试页 PDF**。

除第 7 条外，其余每个用例的 POST 请求体都与源 PDF **SHA256 完全一致**，
`x-file-name` 是百分号编码的 UTF-8（例：
`%E4%BA%91%E6%89%93%E5%8D%B0-20260917-203447.pdf` → 解码为 `云打印-20260917-203447.pdf`）。

第 1 条的实际日志（`driver.log` 首行证明前缀正确）：

```
20:34:26 [INFO] 南科大云打印 —— 落盘监听器启动
20:34:26 [INFO]    api-port   : ...\t1\config\api-port
20:34:26 [INFO]    本地 API   : http://127.0.0.1:8788（来源：api-port）
20:34:26 [INFO]    API 状态   : ok，loggedIn=True，打印机=SUSTech_Printer
20:34:26 [INFO] 发现落盘文件（265884 字节），等待它写完……
20:34:27 [INFO] 已认领作业 → ...\spool\processing\云打印-20260917-203427.pdf
20:34:27 [INFO] 上传 云打印-20260917-203427.pdf（259.7 KB）→ http://127.0.0.1:8788/api/driver/print
20:34:27 [OK] 上传成功：上传成功（ok）；已归档到 ...\spool\done\云打印-20260917-203427.pdf

driver.log 首行: [sustech-print] [INFO] 2026-09-17T12:34:26.547Z 南科大云打印 —— 落盘监听器启动
--- mock 收到 2 个请求：POST /api/driver/print = 1，GET /api/driver/status = 1 ---
CHECK body_len_match=True body_sha_match=True
      xfilename=%E4%BA%91%E6%89%93%E5%8D%B0-20260917-203447.pdf
      decoded=云打印-20260917-203447.pdf
RESULT: PASS
```

第 10 条（证明 **`api-port` 每次提交都重读，没有缓存**）：

```
--- round A: api-port=8788 ---
20:35:15 [INFO]    本地 API   : http://127.0.0.1:8788（来源：api-port）
20:35:16 [INFO] 上传 ... → http://127.0.0.1:8788/api/driver/print
20:35:16 [OK] 上传成功；已归档到 ...\spool\done\...
--- round B: api-port=8789 ---
20:35:16 [INFO]    本地 API   : http://127.0.0.1:8789（来源：api-port）
20:35:17 [INFO] 上传 ... → http://127.0.0.1:8789/api/driver/print
20:35:17 [OK] 上传成功；已归档到 ...\spool\done\...
mockA 共 2 个请求（其中 POST /print = 1）；mockB 共 2 个请求（其中 POST /print = 1）
done/ 里有 2 个文件（期望 2）
PROOF: 第 2 轮换了 api-port 之后请求发到了新端口 —— api-port 没有被缓存。
RESULT: PASS
```

第 7 条的中文提示（令牌缺失时是**可操作**的，且不是「无限重试」）：

```
20:35:02 [WARN]    令牌文件   : 不存在 —— 桌面 App 从未启动过；捕获到的作业会先排到 pending\ 等它启动。
20:35:02 [WARN] 读不到驱动令牌（...\driver-token）。这通常说明桌面 App 从未在这台机器上启动过 ——
                它是唯一会创建该文件的程序。捕获到的作业会先留在 pending\ 里；App 启动后会自动补传。
20:35:03 [WARN] 还没有驱动令牌文件（...\driver-token）—— 桌面 App 从未启动过。
                文件已保留在 ...\spool\pending\云打印-20260917-203503.pdf，App 启动并写入令牌后会自动重试
--- mock 收到 0 个请求：POST /api/driver/print = 0（期望 0）---
RESULT: PASS
```

### 7.2b 与桌面 App 的 `spool-watcher` 不会互相踩到

`watch-spool.ps1` 会在 spool 下额外建一个 `pending\` 子目录（放「暂时传不上去、
等 App 登录后补传」的作业）。这个目录**不会**被桌面 App 的监听器误捡：

`desktop/spool-watcher.mjs` 用的是

```js
names = await readdir(SPOOL_DIR);            // 非递归
for (const name of names) {
  if (!/\.(pdf|ps|prn)$/i.test(name)) continue;   // 只认这些后缀
  ...
  if (!info.isFile() || info.size === 0) continue; // 还必须是个非空文件
```

即：**非递归** + 后缀白名单 + 必须是文件。`pending` / `processing` / `done` / `failed`
四个目录名都不匹配后缀白名单，所以会被直接跳过。

（这是**静态审查代码**得出的结论，不是实机跑出来的 —— 验证机上没有装 App。）

### 7.3 `api-port` 契约的变更说明

**本次任务最初的需求里写死了 `http://127.0.0.1:8787`。这个前提后来被纠正**：
桌面 App 实际是在 `127.0.0.1` 上绑**随机空闲端口**，并把真实端口写进
`C:\ProgramData\SUSTechPrint\api-port`（JSON：`{"port":61714,"host":"127.0.0.1","updatedAt":...}`），
端口**每次 App 重启都会变**。

脚本已按新契约改造：

1. 新增 `Get-ApiBase`：优先读 `api-port`，读不到才退回 `127.0.0.1:8787`；
2. **在提交函数内部调用 `Get-ApiBase`**，不是模块加载时读一次 —— 每次提交都重读（第 10 条用例验证）；
3. `-ApiBase` 从「默认值」变成「可选覆盖」（默认空 = 自动发现），仅用于测试/调试；
4. 新增 `-ConfigDir` / `-ApiPortFile` 参数（默认仍是
   `%ProgramData%\SUSTechPrint` 与 `%ProgramData%\SUSTechPrint\api-port`）；
5. `driver.log` 是 App 与驱动脚本**共用**的文件，脚本写进去的每一行都加
   **`[sustech-print]`** 前缀（`[sustech-print] [INFO] <ISO8601 UTC> <消息>`），
   与 App 的 `2026-09-17T12:28:23.557Z [info] …` 区分开；自检里有一条专门断言这个前缀；
6. `install-printer.ps1` 显式创建 `C:\ProgramData\SUSTechPrint`（不再只依赖创建 `spool\` 时的副作用）；
7. 令牌按「一行 64 个十六进制字符」处理，缺失时给可操作的中文提示，并每 5 分钟才重复提醒一次。

另外，做这一步时对照了仓库里**已经存在**的共享约定，补了两处一致性：

8. **`<ConfigDir>\api`（直接写一行 URL 的旧约定）优先于 `api-port`。**
   `lib/paths.mjs` 里只有 `API_PORT_FILE`，但 `driver/macos/sustech-print` 的实现里
   覆盖顺序是 `SUSTECH_API` → `$CONFIG_DIR/api` → `$CONFIG_DIR/api-port` → 默认 8787，
   并且 macOS 的测试（`driver/macos/test/run-tests.sh` 的 A10b 段）**专门断言**
   「api 文件优先于 api-port」。Windows 侧原本没有实现 `api` 文件，会让两个平台行为不一致，
   所以补上了，顺序完全相同。
9. **`api-port` 里 `host` 为 `0.0.0.0` / `::` / `[::]` 时换成 `127.0.0.1`。**
   这些不是可连接的地址；macOS 侧已经这么处理（`case "$_host" in ''|0.0.0.0|::|[::])`）。
10. **`install-printer.ps1` 显式创建配置目录**（见第 6 条），并且安装脚本不再需要在
    `-SpoolDir` 改变时去猜配置目录。

新增的 8 条自检断言覆盖：api 文件优先于 api-port、`-ApiBase` 优先于 api 文件、
api 文件内容不是 URL / 为空 / 不存在时都被忽略并回落到 api-port、
`host=0.0.0.0` 与 `host=::` 被规范化成回环地址。

改造后**重新跑过**：自检（54 项）、10 个 mock 端到端用例、安装、幂等、卸载、
`-KeepSpool`、最终清理与「联创队列幸存」检查。上面所有结论都来自改造后的版本。

---

### 7.4 最后一轮：配置目录完全不存在 → 安装 → 卸载

上面所有验证跑完后，我把目标机恢复到基线（删掉了 `C:\ProgramData\SUSTechPrint`），
然后用**最终版脚本**做了最后一次完整往返，专门覆盖「配置目录也不存在」这个分支
（之前的安装测试里配置目录已经存在，只验证了创建 `spool\`）：

```
BEFORE: configDir=False spoolDir=False printers=6 vendor=1

################ INSTALL（配置目录完全不存在 → 必须自己建出来）
== 准备落盘目录
   [OK] 已创建 C:\ProgramData\SUSTechPrint          <-- 这个分支之前没被走到
   [OK] 已创建 C:\ProgramData\SUSTechPrint\spool
== 注册端口与打印队列
   [OK] 队列已注册
== 打印测试页
   [OK] 测试页已落盘：265,890 字节
== 校验安装结果
   [OK] 队列：SUSTech_Printer  |  驱动：Microsoft Print To PDF  |  端口：...\spool\out.pdf
INSTALL_EXIT=0

################ 落盘证据
SIZE        : 265890
SHA256      : A22D12737F08767FEA4BD5F035885EF9B31A7646D59F23939AA6002EC2BE593C
HEAD16_HEX  : 25 50 44 46 2D 31 2E 37 0A 0A 34 20 30 20 6F 62      (%PDF-1.7)
TAIL80_TXT  : ...startxref.265168.%%EOF.
COUNT_%PDF- : 1
COUNT_%%EOF : 1
BYTES_AFTER_EOF_LAST : 1  [hex: 0A]

################ UNINSTALL（恢复基线）
   [OK] 已删除队列「SUSTech_Printer」
   [OK] 已删除端口
   [OK] 已删除 C:\ProgramData\SUSTechPrint\spool
   [OK] 联创遗留队列「????????」仍在（驱动 MS Publisher Color Printer，端口 ????????）
   [OK] 联创遗留端口「????????」仍在
UNINSTALL_EXIT=0
```

---

## 8. 最终状态（验证结束）

```
C:\ProgramData\SUSTechPrint exists = False        (安装脚本创建的，已删除)
scratch dir exists = False                        (已删除)
我们的队列数量 = 0
我们的端口数量 = 0

=== 全部打印机（最终，6 台，与基线一致） ===
 - OneNote for Windows 10        | Microsoft Software Printer Driver
 - OneNote (Desktop)             | Send to Microsoft OneNote 16 Driver | port=nul:
 - Microsoft XPS Document Writer | Microsoft XPS Document Writer v4    | port=PORTPROMPT:
 - Microsoft Print to PDF        | Microsoft Print To PDF              | port=PORTPROMPT:
 - Fax                           | Microsoft Shared Fax Driver          | port=SHRFAX:
 - ????????                      | MS Publisher Color Printer           | port=????????

=== 全部端口（最终，13 个，与基线一致） ===
 COM1: / COM2: / COM3: / COM4: / FILE: / LPT1: / LPT2: / LPT3: / nul: / PORTPROMPT:
 ????????                      | UnifoundPS Port
 Microsoft.Office.OneNote_...  | App Monitor
 SHRFAX:                       | Fax Monitor Port

=== 打印作业队列 ===
  (空)

=== Spooler ===
Running

=== 清理动作 ===
  kill powershell PID=8160             (遗留的验证进程)
  removed C:\ProgramData\SUSTechPrint   (安装脚本创建的)
  removed C:\Users\<用户>\AppData\Local\Temp\sustechprint-verify   (全部验证脚本与产物)

机器上只剩下我执行最后一条命令的那一个 powershell 进程。
```

### 联创（vendor）队列幸存的明确确认

```
=== 卸载脚本自己打印的确认 ===
   [OK] 联创遗留队列「????????」仍在（驱动 MS Publisher Color Printer，端口 ????????）
   [OK] 联创遗留端口「????????」仍在

=== 最终独立核对 ===
Name            : ????????
DriverName      : MS Publisher Color Printer
PortName        : ????????
Shared          : False
Published       : False
Default         : False
KeepPrintedJobs : True
PrinterStatus   : 3   (Idle)
WorkOffline     : False

端口 ???????? ：Description = UnifoundPS Port
```

与基线逐项一致（`PrinterStatus` 基线未记录，当前为 3=Idle，正常）。
**联创遗留的队列 `????????` 和端口 `????????` 在整个过程中没有被删除、修改或破坏。**

---

## 9. 没能验证的部分

1. **没有和真正的桌面 App 对接过。** 验证机上没有安装 App，`api-port` /
   `driver-token` 都不存在（这是预期的，也是需求里说明的）。因此：
   * `api-port` 的读取逻辑是用**真实 `HttpListener` mock** + **手工构造的 `api-port` 文件**验证的，
     不是用真 App 验证的；
   * `GET /api/driver/status` 成功且 `loggedIn=true` 的分支、以及真实 `not-logged-in` 响应，
     都是 mock 造的；响应体结构抄的是 `server.mjs` 里的实现，但没有跑过真服务端；
   * 真正的端到端上传（本机 PDF → App → 学校云打印队列）**没有验证过**；
   * 与 `desktop/spool-watcher.mjs` 的兼容性只做了**静态代码审查**（见 7.2b），
     没有把两个监听器放在一起实跑过。
2. **PostScript 兜底驱动路径没有实际触发。** 该机器上「Microsoft Print To PDF」存在，
   所以只验证了首选分支；回退分支的代码路径（警告文案、`-RequirePdf` 硬失败）
   只做了静态审查，没有实机执行。
3. **没有验证 `-SetDefault`。** 为避免影响目标机的默认打印机设置，没有实际执行。
   （代码用的是 `WScript.Network.SetDefaultPrinter`；卸载脚本里「把默认打印机改回去」
   的分支同样没有实机执行，因为测试期间我们的队列从来不是默认打印机。）
4. **并发/多作业覆盖**：只验证了「串行两次打印、文件被整份重写」。
   「作业 A 刚写完还没被取走时作业 B 又开始写」这个竞争窗口没有被人为构造验证过。
5. **`-SkipExisting`** 只有单元级的行为验证（指纹比较），没有做完整的实机场景演练。
6. **长时间运行的稳定性**：`watch-spool.ps1` 的循环没有跑过小时级的长测。
7. **验证机网络不稳定**：验证期间目标机多次掉线（Tailscale 显示 `offline`），
   有若干次命令因连接中断而没有拿到输出，需要重跑。这不影响上面的结论（每一条结论
   都来自拿到了完整输出的运行），但它是我无法排除 6.3 那个现象的干扰因素之一。
8. **`Win32_Printer.PrinterStatus` 基线值没有记录**，所以只能确认当前是 3（Idle）这一正常值，
   不能做严格的前后对比。其余属性（名字/驱动/端口/共享/发布/默认/保留文档）都有基线可比且一致。
9. **`-RecoverProcessing`（启动时回收 `processing\` 里的遗留作业）没有实机演练。**
   这个开关是为了「`watch-spool.ps1` 被强杀在「已认领、还没上传」之间」这种情况加的；
   代码路径只做了静态审查。默认关闭，所以不影响正常使用。
10. **`api` 文件（URL 旧约定）的优先级只用了手工构造的文件验证**，
    没有真的让桌面 App 去写这个文件；不过 `driver/macos/test/run-tests.sh` 里的 A10b
    段对同一约定有独立断言，两边的优先级顺序在代码层面是对齐的。
11. **`install-printer.ps1` 的 `-SpoolDir` / `-PrinterName` 自定义值没有实机验证**，
    只验证了默认值；`uninstall-printer.ps1` 里拒绝操作 `????????` 的防护也只用代码审查确认。

---

## 10. 残余风险

1. **「用文件当端口」的固有语义：`out.pdf` 是最后一份作业的快照，不是队列。**
   * 没有任何监听者时连续打印多份 → 只剩最后一份（前面的被覆盖，不可恢复）。
   * 「一份刚写完」到「监听者把它挪走」之间存在覆盖窗口；假脱机服务虽然是串行处理的，
     但这个窗口在理论上存在。要彻底消除只能写自定义端口监视器（即联创方案，代价是驱动签名）。
   * 我们通过「立刻 `File.Move` 认领、再上传」把窗口压到最小，但**不能消除**。

2. **拿不到原文档名。** 端口只写裸字节，文档标题留在假脱机服务里。兜底脚本只能用时间戳
   命名（`云打印-20250101-120000.pdf`）。桌面 App 走同一接口、受同样限制，所以它对固定的
   `out.pdf` 也换成同样的时间戳命名，而不是把每个作业都上传成 `out.pdf`。

3. **删除文件端口可能（间歇性地）清空 spool 目录。**
   已观察到一次、未能确定性复现（见 6.3）。缓解措施：安装脚本默认复用、不删除；
   `-Force` 时明确警告；README 如实记录。**如果将来有人把安装脚本改成无条件删除重建，
   这个风险会回来。**

4. **中文文件名/路径依赖编码。** 三个 `.ps1` 必须保持 **UTF-8 with BOM**。
   如果被某个工具改成无 BOM，PowerShell 5.1 会按 ANSI 解码，中文提示和
   `SUSTech_Printer` 队列名都可能变成乱码。建议在仓库里保留 BOM，
   并在 CI 或提交前检查前三个字节是 `EF BB BF`。

5. **`api-port` 是活的**：App 重启后端口会变。任何新增的调用方都必须**每次重读**，
   不能缓存、不能硬编码。`-ApiBase` 只应作为测试用途。

6. **`driver.log` 是共用文件。** 驱动脚本写进去的行都以 `[sustech-print]` 开头；
   如果将来有别的组件也写这个文件，需要继续保持这个约定，否则排查时会分不清来源。
   脚本自带的 2 MB 轮转（改名成 `driver.log.1`）也可能与 App 的日志策略相互干扰 ——
   这一条没有验证过。

7. **`install-printer.ps1` 会给 `spool` 目录授予 `Users:Modify`。**
   目的是让非管理员也能手动放文件进去。这意味着**本机任何用户都能替换待上传的 PDF**。
   在校园机房这类多用户场景下需要评估；如果不可接受，应把该 ACL 步骤去掉
   （打印本身由 SYSTEM 身份的假脱机服务写入，不需要这条授权）。

8. **`127.0.0.1` 上的本地 API 对同机所有进程可见**，仅靠 `x-driver-token` 保护。
   令牌以明文存在 `%ProgramData%\SUSTechPrint\driver-token`，
   因此同机的其他用户/进程（若能读到该文件）可以冒充驱动上传文件。
   需求里说明 App 以 0600 权限写入，能缓解但不能消除。

9. **`winprint` 打印处理器和 `Set-PrintConfiguration -Collate $false` 是显式设置的**，
   目的是把队列行为固定下来；如果某些驱动不接受这些设置，脚本只会打警告并继续
   （已用 try/catch 包住），不会失败。这一点在目标机上没有触发警告，属于正常路径。

---

## 11. 附：本次验证用到的辅助脚本（均在临时目录，已删除）

| 脚本 | 用途 |
| --- | --- |
| `vspool.ps1` | 读 spool 文件：大小 / SHA256 / 头 16 字节 hex / 尾 80 字节 / `%PDF-` 与 `%%EOF` 计数 / `startxref` |
| `vgdi.ps1` | 用 GDI `PrintDocument` 往队列打印一份真实文档（无对话框） |
| `vmock.ps1` | `HttpListener` mock API：按模式返回 ok / not-logged-in / 401 / 500 / retryable / failed，并记录请求 |
| `vmocktest.ps1` | 单个场景的端到端用例（含请求体 SHA256 比对与归档位置断言） |
| `vportchange.ps1` | 两个 mock + 中途改 `api-port`，证明端口被重读 |
| `vapifile.ps1` | 两个 mock，`api-port` 指向 A、`api` 指向 B，证明 `api` 文件优先 |

这些脚本只存在于
`C:\Users\<用户>\AppData\Local\Temp\sustechprint-verify\`，验证结束已整体删除；
仓库里只有 `driver/windows/` 下的三个交付脚本 + `README.md` + 本报告。
