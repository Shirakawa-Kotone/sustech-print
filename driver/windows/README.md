# 南科大云打印 —— Windows 虚拟打印机

这套脚本在本机注册一个名为 **`SUSTech_Printer`** 的打印队列。它的端口不是打印机，而是
**一个普通文件路径**：

```
C:\ProgramData\SUSTechPrint\spool\out.pdf
```

用户在 Word、浏览器、PDF 阅读器里选择「SUSTech_Printer」并打印，Windows 自带的
**Microsoft Print To PDF** 驱动就会把这一次打印渲染成一份完整的 PDF，直接写到上面这个文件。
桌面 App（Electron）监听这个文件，把它 POST 给本机的 `POST /api/driver/print`，
再由 App 带着已登录的会话上传到学校云打印队列。

```
应用 → 打印 →「SUSTech_Printer」
        │
        ▼
Microsoft Print To PDF 驱动
        │
        ▼
C:\ProgramData\SUSTechPrint\spool\out.pdf     ← 每一次作业都被整份重写
        │
        ▼  桌面 App 监听（或 watch-spool.ps1 兜底）
读 %LOCALAPPDATA%\SUSTechPrint\api-port 拿到真实端口
        │
        ▼
POST http://127.0.0.1:<port>/api/driver/print
        │
        ▼
学校云打印队列
```

## 本地 API 的地址是怎么找到的（重要）

桌面 App **不监听固定端口**：它每次启动都在 `127.0.0.1` 上绑一个**随机空闲端口**，
然后把真实端口写进这个文件：

```
%LOCALAPPDATA%\SUSTechPrint\api-port
{"port":61714,"host":"127.0.0.1","updatedAt":1789648103557}
```

所以：

* 任何硬编码 `127.0.0.1:8787` 的调用方都会在正常情况下**连不上真正的 App**；
* **每次提交前都要重新读一遍 `api-port`**，绝不能启动时读一次就缓存 ——
  App 每次重启端口都会变；
* 只有**读不到 `api-port` 时**才退回 `http://127.0.0.1:8787`，
  那是给「手动 `PORT=8787 node server.mjs` 跑开发服务器」准备的兜底。

完整覆盖顺序（和 macOS 的 `driver/macos/sustech-print` 保持一致）：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `-ApiBase` 参数 | 显式指定，只用于测试/调试 |
| 2 | `<ConfigDir>\api` | 直接写一行 URL 的**旧约定** |
| 3 | `<ConfigDir>\api-port` | App 用随机端口时写的 JSON（正常情况走这条） |
| 4 | `http://127.0.0.1:8787` | 开发兜底 |

另外：`api-port` 里的 `host` 如果是 `0.0.0.0` / `::` / `[::]`，那不是可连接的地址，
会被换成 `127.0.0.1`（同样与 macOS 一致）。

`watch-spool.ps1` 已经按这个规则实现，并且有专门的单元测试与端到端测试
（换端口后请求确实发到了新端口）。`install-printer.ps1` / `uninstall-printer.ps1`
不访问 API，所以不受影响。

请求鉴权：每个请求都要带 `x-driver-token: <token>`，令牌来自
`%LOCALAPPDATA%\SUSTechPrint\driver-token`（一行，64 个十六进制字符）。
令牌缺失或错误时服务端返回 **HTTP 401**。如果这个文件不存在，说明桌面 App
**从未在这台机器上启动过** —— 它是唯一会创建该文件的程序，脚本会明确地这么提示。

---

## 文件

| 文件 | 作用 | 需要管理员 |
| --- | --- | --- |
| `install-printer.ps1` | 安装：注册端口 + 队列 | 是 |
| `uninstall-printer.ps1` | 卸载：删除端口 + 队列（可选删落盘目录） | 是 |
| `watch-spool.ps1` | **可选兜底**：不装桌面 App 时，自己监听文件并上传 | 否 |

---

## 安装

以**管理员身份**打开 PowerShell，然后：

```powershell
powershell -ExecutionPolicy Bypass -File install-printer.ps1
```

装完顺便打印一张测试页确认端口真的能落盘：

```powershell
powershell -ExecutionPolicy Bypass -File install-printer.ps1 -TestPage
```

想把它设成系统默认打印机（**默认不设**，因为设成默认后本机所有打印都会落到这个队列）：

```powershell
powershell -ExecutionPolicy Bypass -File install-printer.ps1 -SetDefault
```

### 参数

| 参数 | 说明 |
| --- | --- |
| `-PrinterName <名字>` | 队列名，默认 `SUSTech_Printer`。必须与 App 的 `lib/paths.mjs` 里 `PRINTER_NAME` 一致。 |
| `-SpoolDir <目录>` | 落盘目录，默认 `C:\ProgramData\SUSTechPrint\spool`。 |
| `-SetDefault` | 设为系统默认打印机。**默认关**。 |
| `-Force` | 强制删除并重建队列和端口（见下面的「注意」）。 |
| `-PurgeSpool` | 安装时删掉已存在的 `out.pdf`（清掉残留作业）。 |
| `-RequirePdf` | 找不到「Microsoft Print To PDF」时直接报错，不用 PostScript 兜底驱动。 |
| `-TestPage` | 安装后打印一张测试页。 |

队列名里没有空格：macOS 侧 CUPS/lpadmin **拒绝**带空白的队列名（会误报「打印机名称只能包含
可打印字符」），所以两个平台统一用同一个名字 `SUSTech_Printer`。

脚本**幂等**：反复执行不会报错，也不会产生重复的队列或端口。

### 驱动选择

安装时会**先探测再动手**，并在屏幕上明确报告用了哪个驱动：

1. 首选 **Microsoft Print To PDF** —— 直接产出 PDF，这是我们要的。
2. 找不到它时，回退到 Windows 自带的 **MS Publisher Color Printer**（inbox PostScript 驱动）。
   脚本会**大声警告**：这个驱动产出的是 PostScript（`%!PS-Adobe`），不是 PDF，
   桌面 App 和 `watch-spool.ps1` 都按 PDF 解析，所以打印结果很可能传不上去。
   想要这种情况直接失败就加 `-RequirePdf`。

装「Microsoft Print to PDF」的办法：**设置 → 应用 → 可选功能 → 添加功能 → Microsoft Print to PDF**。

---

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall-printer.ps1
```

默认会删掉队列、端口，以及落盘目录。想留下还没上传的作业：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall-printer.ps1 -KeepSpool
```

`%LOCALAPPDATA%\SUSTechPrint` 下的 `driver-token`、`driver.log` 属于桌面 App，卸载脚本**不会删**。

卸载脚本有两个硬性防护：

* 它只会操作 `SUSTech_Printer` 和 `...\spool\out.pdf` 这两个精确名字；
* 如果 `-PrinterName` 被传成联创驱动遗留的 `????????`，脚本**直接拒绝执行**。

---

## 为什么不需要驱动签名 / 不需要 Ghostscript

联创（vendor）的方案是自己写了一个端口监视器 `unilocalmon.dll`（外加一个 16 MB 的
Ghostscript 用来生成 PDF）。端口监视器属于打印驱动组件，必须有有效的数字签名，
还要跟着 Windows 版本升级重新适配 —— 维护成本很高。

本方案绕开了这一切：Windows 的 **Microsoft Print To PDF** 驱动本身就能把任意打印作业
渲染成 PDF，而它的端口名可以**直接写一个文件路径**。于是：

| 需要的东西 | 本方案 |
| --- | --- |
| 自定义端口监视器 DLL | ❌ 不需要 |
| C++ 代码 | ❌ 不需要 |
| 驱动签名 / 证书 | ❌ 不需要 |
| Ghostscript | ❌ 不需要 |
| 内核态组件 | ❌ 不需要 |

全部改由**用户态**完成：一个 PowerShell 脚本注册队列 + 一个监听文件的进程。出问题也好排查 ——
直接看那个 PDF 就行。

---

## 可选兜底：`watch-spool.ps1`

**正常情况下不需要它。** 桌面 App 自己会监听 `out.pdf` 并上传。
只有在「不想装桌面 App」或「App 的监听坏了」时才用它：

```powershell
powershell -ExecutionPolicy Bypass -File watch-spool.ps1
```

只处理一轮就退出（方便挂到任务计划程序）：

```powershell
powershell -ExecutionPolicy Bypass -File watch-spool.ps1 -Once
```

### 它怎么判断「文件写完了」

两个条件**同时**满足才算写完，避免把半个文件传上去：

1. 文件大小连续 `-StablePolls` 次（默认 2 次）轮询都没有变化；
2. 文件末尾是 PDF 的结束标记 `%%EOF`。

确认写完后，它先把文件**挪出** `spool` 根目录（这样新的作业可以安全地重写 `out.pdf`），
再 POST 到本地 API，最后按结果归档：

| 结果 | 归档到 | 说明 |
| --- | --- | --- |
| 上传成功 | `spool\done\` | |
| 客户端未登录 | `spool\pending\` | **这是预期内的正常结果，不是崩溃**；登录后自动重试 |
| 网络不通 / 服务端 5xx / 可重试失败 | `spool\pending\` | 每隔 `-RetrySeconds` 秒重试一次 |
| 驱动令牌无效（401） | `spool\pending\` | App 还没写令牌文件时也会走这里 |
| 未登录以外的永久失败（如文件过大） | `spool\failed\` | 不再重试 |

关键参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-SpoolDir` | `%ProgramData%\SUSTechPrint\spool` | 落盘目录 |
| `-ConfigDir` | `%LOCALAPPDATA%\SUSTechPrint` | 配置目录（`api-port` / `driver-token` / `driver.log` 都在这下面） |
| `-ApiBase` | 空（自动发现） | 空 = 每次提交前读 `api-port`；给了值就强制用这个地址（测试/调试用） |
| `-ApiUrlFile` | `<ConfigDir>\api` | 直接写 URL 的旧约定文件（存在则优先于 `api-port`） |
| `-ApiPortFile` | `<ConfigDir>\api-port` | App 写的端口文件 |
| `-TokenFile` | `<ConfigDir>\driver-token` | 令牌文件（一行 64 个十六进制字符） |
| `-PollMs` | `1000` | 轮询间隔 |
| `-StablePolls` | `2` | 需要连续几次大小不变 |
| `-RetrySeconds` | `30` | 可重试失败的冷却时间 |
| `-Once` | 关 | 只跑一轮 |
| `-SkipExisting` | 关 | 启动时跳过已存在的 `out.pdf`（被新作业重写后仍会处理） |
| `-RecoverProcessing` | 关 | 启动时把上次被强杀留在 `processing\` 里的作业挪回 spool 重试（默认关，避免和 App 抢） |
| `-LogFile` | `<ConfigDir>\driver.log` | 日志（超过 2 MB 自动轮转） |
| `-SelfTest` | 关 | 只跑内置单元自检，不进入监听循环 |

> `driver.log` 是**桌面 App 和驱动脚本共用**的。App 写的是
> `2026-09-17T12:28:23.557Z [info] …` 这种格式；`watch-spool.ps1` 写进去的每一行
> 都以 **`[sustech-print]`** 开头（`[sustech-print] [INFO] 2026-09-17T12:28:23.557Z …`），
> 两边一眼就能区分。

跑一遍自检确认逻辑没坏：

```powershell
powershell -ExecutionPolicy Bypass -File watch-spool.ps1 -SelfTest
```

> ⚠️ **不要和桌面 App 同时运行。** 两边都会监听同一个文件，同一份作业可能被上传两次。

---

## 排查

### 队列在不在、状态如何

```powershell
Get-Printer -Name SUSTech_Printer
Get-PrinterPort -Name 'C:\ProgramData\SUSTechPrint\spool\out.pdf'
Get-PrintJob -PrinterName SUSTech_Printer          # 有没有卡住的作业
Get-Service Spooler                            # 假脱机服务是否在跑
```

### App 到底在哪个端口

```powershell
Get-Content '%LOCALAPPDATA%\SUSTechPrint\api-port'      # {"port":61714,"host":"127.0.0.1",...}
Get-Content '%LOCALAPPDATA%\SUSTechPrint\driver-token'  # 一行 64 个十六进制字符
```

手动探一次（把 `<port>` 换成 `api-port` 里的值，`<token>` 换成令牌）：

```powershell
$t = Get-Content '%LOCALAPPDATA%\SUSTechPrint\driver-token' -Raw
$p = (Get-Content '%LOCALAPPDATA%\SUSTechPrint\api-port' -Raw | ConvertFrom-Json).port
Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/driver/status" -Headers @{ 'x-driver-token' = $t.Trim() }
```

* 连不上 → App 没在运行，或者 `api-port` 是旧的（App 崩过没清理）。
* 返回 401 → 令牌不对：`driver-token` 与 App 当前持有的不一致。
* 返回 `{"ok":true,"loggedIn":false,...}` → App 在跑，但**没登录**；
  这时上传会稳定返回 `{"ok":false,"reason":"not-logged-in"}`，这是**预期内的正常结果**，
  不是崩溃，登录后会自动补传。

### 看被截获的文件

```powershell
Get-Item      'C:\ProgramData\SUSTechPrint\spool\out.pdf' | Select-Object Length, LastWriteTime
Get-Content   'C:\ProgramData\SUSTechPrint\spool\out.pdf' -TotalCount 1     # 应该看到 %PDF-1.x
Get-Content   'C:\ProgramData\SUSTechPrint\spool\out.pdf' -Tail 1           # 应该看到 %%EOF
```

一份**完整**的 PDF 应当是：以 `%PDF-1.` 开头，以 `%%EOF` 结尾，而且 `%PDF-` 只出现一次。
如果开头是 `%!PS-Adobe`，说明装的是 PostScript 兜底驱动（见上面的「驱动选择」）。

### 打印了但文件没出现 / 没变化

1. `Get-PrintJob -PrinterName SUSTech_Printer` —— 作业是不是卡在 `Error` / `Printing`？
   卡住的作业可以 `Remove-PrintJob`，实在不行重启假脱机服务：
   `Restart-Service Spooler`。
2. 确认队列的端口确实是那个文件路径：`(Get-Printer -Name SUSTech_Printer).PortName`。
3. 确认 `C:\ProgramData\SUSTechPrint\spool` 存在且可写。
4. 看一眼 `%LOCALAPPDATA%\SUSTechPrint\driver.log`。

### spool 文件是旧的 / 残留的

`out.pdf` 不会自己清理。如果上一次打印没有被 App 取走（App 当时没开），它会一直留在那里，
下一次安装脚本还会提示它。

* 看时间戳：`Get-Item ... | Select-Object LastWriteTime`。时间很旧基本就是残留。
* 想清掉：重装时加 `-PurgeSpool`，或者手动删掉：
  `Remove-Item 'C:\ProgramData\SUSTechPrint\spool\out.pdf'`
* 注意 `-SkipExisting` 只影响 `watch-spool.ps1`，不影响打印。

### spool 目录整个不见了

删除**文件端口**（`Remove-PrinterPort`）时，假脱机服务可能会**异步**清理端口指向的目录，
把还没被取走的 `out.pdf`、甚至整个 `spool` 目录一起删掉。
（这个现象在测试中观察到过一次：删除并重建端口之后约 40 秒，目录消失了；
后来用同样的步骤做 75 秒轮询没有复现，所以它是**间歇性**的。）

因此 `install-printer.ps1` 的策略是**能复用就复用**：队列和端口已存在且配置一致时，
只重新应用设置，**不做任何删除**。只有在加 `-Force`、或者已有队列的驱动/端口与目标不一致时，
才会删除重建，并且会在删除前明确警告。**重建之前请确认没有待处理的作业。**

---

## 局限（重要，请如实告诉用户）

1. **`out.pdf` 是「一份文件、每个作业整份重写」。**
   每次打印都会把上一次的内容截断覆盖掉。所以它**不是队列，只是最后一个作业的快照**。

2. **桌面 App 必须开着，才能把作业「排干」。**
   App 关着的时候打印，文件照样会落到 `out.pdf`，但没人把它传上去。
   如果在 App 关着、而且**也没有任何监听者**的情况下连着打印了好几份，
   **最后只剩下最后一份**，前面的都已经被覆盖、找不回来了。

   如果 `watch-spool.ps1` 在跑（哪怕 App 还没启动、令牌文件还不存在），
   它会把每一份捕获到的作业**先挪到 `spool\pending\`**，所以那种情况下不会丢 ——
   只是要等 App 启动并写入令牌后才会自动补传。

3. **并发打印会互相覆盖。** 假脱机服务是按队列串行处理的，所以同一时刻只有一个作业在写
   这个文件；但「写完一份」到「监听者把它取走」之间，如果又来了新作业，新作业会直接覆盖它。

   这是「用文件当端口」这一简化方案换来的代价。要彻底解决就得写自定义端口监视器
   —— 也就是联创方案在做的事，代价是驱动签名和长期维护。

4. **拿不到原文档名。** 端口只写裸字节，文档标题留在假脱机服务里，脚本读不到。
   兜底脚本按时间戳命名（`云打印-20250101-120000.pdf`）。
   桌面 App 走同样的接口、受同样的限制，所以它对 `out.pdf` 也换成同样的时间戳命名，
   而不是把每个作业都叫 `out.pdf`。

5. **PostScript 兜底驱动产出的不是 PDF。** 见上面的「驱动选择」。

6. **打印对话框里的选项（颜色 / 单双面 / 份数）传不出来。**
   「文件端口」只拿到落盘的字节，`Microsoft Print To PDF` 的 DEVMODE（里面才有
   颜色、双面、份数）留在假脱机服务里，读不到 —— 所以从 Word/浏览器打印的作业
   一律按 **黑白 · 单面 · 1 份** 提交，和上游官方网页客户端的默认一致。

   **想在 Windows 上彩打，用桌面 App 的「上传」页面**：那里有 黑白/彩色、
   单双面、份数、纸型 可选，并且是直接提交给云端的。
   （macOS 没有这个限制：CUPS backend 能从 options 串里读到选项，
   见 `driver/macos/README.md` 的「打印选项」。）

---

## 安全说明

本地 API 只监听在 `127.0.0.1` 上（端口随机，写在 `api-port` 里），但同机器上任何进程
都能访问这个回环端口，所以接口要求请求头里带 `x-driver-token`；令牌由桌面 App 生成、
写在 `%LOCALAPPDATA%\SUSTechPrint\driver-token`。这个令牌只用来证明「请求来自本机被授权的
驱动脚本」，**不是**学校账号的凭据 —— 真正的登录会话始终留在 App 进程里。

`api-port` / `driver-token` 由 App 以仅当前用户可读的权限（0600 等价）写入。
