# 踩过的坑

改代码前建议先看一遍。每条都是实测踩出来的，附了判断依据和通用教训。

1. **进度通道（WebSocket）已经下线，不要再依赖它。**
   早先的结论是"必须先挂上 `wss://pms.sustech.edu.cn/ws?token=<taskId>`，否则上传虽然
   返回 `code: 0`，**打印队列里却不会出现这份文件**"，并且握手必须带会话 Cookie
   （不带 Cookie 时会"连上但收不到消息"）。**这在当时是对的**，也是早期最难查的坑。

   **2026-09 复测：这条通道已经没有了。** 握手直接失败（约 0.5s），线上 web 客户端的
   JS 里也再搜不到 `taskId` / `WebSocket` —— 它现在只是 `POST` 完看一下 `oReq.status`。
   所以现在**不要**把它当必要条件：握手失败就立刻跳过等待，否则成功路径会白等
   `waitForFinal` 的 30s 超时。改为轮询 `GET /api/client/PrintJob/Get`
   确认作业真的进了队列（这个接口仍然可用）。代码里还留着这段逻辑，
   万一把通道恢复回来就不用改。

2. **上传接口改过名：`CloudPrint/UploadFile` → `CloudPrint/Upload`。**
   旧路径现在稳定返回
   `404 {"Message":"No HTTP resource was found that matches the request URI ..."}`，
   新路径对 `GET` 返回 `405`（说明路由存在，只是不接受 GET）。
   两处调用（浏览器透传 `/api/upload` 和驱动用的 `submitDocument`）现在共用
   `server.mjs` 里的一个 `UPLOAD_PATH` 常量，免得再出现"只改了一处"的半死状态。
   复核方法：`node tools/probe-upstream-capabilities.mjs`（GET 一下：405=存在，404=没了）。

3. **`Report/DetailPageEx` 的 `dwRowCount` 无效**，服务端固定每页 5 条，必须翻页。

4. **打印点状态是中文和英文混着的**（`系统空闲` / `System Idle`），判断空闲要同时匹配。

5. **`szPaperDetail` 是 JSON 字符串**，需要 `JSON.parse` 才能拿到纸型。

6. 原版帮助页的「下载打印驱动」按钮指向的 exe 是 **404**，驱动得另找学校要。

7. **`404` 有两种，必须区分 —— 混起来就会无限重试一个永远不会成功的请求。**
   响应体是 ASP.NET 的路由错误（`No HTTP resource was found that matches the request URI ...`）
   ⇒ **路由不存在，上游改名了**，重试永远不会成功，应该直接报"接口已变更，需要更新程序"。
   其余情况才是服务端节点/应用池的临时抖动，可以重试。
   注意它和「会话失效」也不一样：会话失效返回的是 `{"code":4,"message":"无效会话，未登录"}`。

   客户端已经处理：**真的临时故障（非路由错误的 404 / 5xx / 网络中断）会自动重试 3 次**
   （1.5s、4s 退避），队列里会显示「重试 1/3」。真失败了还有「重试失败项」按钮。

   顺带确认：**文件大小不是问题**，47 MB 的文件实测 6 秒传完（约 8 MB/s），能正常入库。

8. **记录接口改过名，而且响应体也变了 —— 这个坑最阴，因为它不报错，只是"数据变 0"。**
   2026-09 前后上游把 `Report/DetailPageEx` 改名成 `Report/DetailPage`。
   旧路径返回的 404 和第 2、7 条是同一种病，但**它不是临时故障，重试永远不会成功**。
   后果是：使用记录拉不到 → 本学年已用算成 ¥0 → 总览显示"剩余 ¥100"，
   而系统字段 `dwSubsidy` 明明返回 ¥78.90，界面上就会出现「不一致」。

   同一个接口的响应体也换了三处，都做了兼容：

   | 字段 | 旧 | 新 |
   |---|---|---|
   | 日期 | 无 | `dwDate` = `YYYYMMDD` |
   | 时间 | `dwTime` = Unix 秒 | `dwTime` = `HHMMSS` |
   | 类型 | `dwType` = `1/2/3` | `dwType` = 位掩码，取低 16 位（`131073 → 1`） |
   | 文档名 | `szDocName` | **不再返回**（所以新部署下历史页没有「文件」列，改成显示「单价」） |

   还有一条更隐蔽的：**`dwType` 请求参数已经失效了**。原来代码按类型发三次请求再合并，
   现在三次都返回同一批记录，补贴会被算成 **3 倍**（实测 ¥21.10 被算成 ¥42.20）。
   正确做法是**只拉一次全部、用 `dwSID` 去重**，类型筛选放到前端做。

   查哪个接口是运行时探测的（两个都试，谁 `code=0` 用谁），所以学校哪天改回去也不会坏。

9. **`lpadmin` 拒绝队列名里的空白字符，但报错信息是误导的。**
   `lpadmin -p "SUSTech Printer"` 会失败，并告诉你
   `打印机名称只能包含可打印字符。` —— 这句话会让人以为字符集有问题，
   **真正的原因是空白字符**。实测（macOS 26）：

   | 队列名 | 结果 |
   |---|---|
   | `SUSTech Printer` | ✗ ASCII 空格被拒 |
   | `SUSTech<TAB>Printer` | ✗ TAB 被拒 |
   | `SUSTech<LF>Printer` | ✗ LF 被拒 |
   | `南科大云打印` | ✓ 中文没问题 |
   | `SUSTech_Printer` | ✓ |

   所以队列名统一用 `SUSTech_Printer`（macOS 与 Windows 同名，避免"文档/界面/系统"
   出现三份名字 —— 这个项目已经因为名字不同步踩过两次）。
   `install.sh` 里加了预检，**在碰 `lpadmin` 之前**就拦下来：因为 `lpadmin`
   处理非法 device-uri 的方式是"先把队列删掉再报错"，用户已经因此丢过一次队列。

10. **CUPS 给 backend 的 `umask` 是 `0077`。**
    于是 backend（以 root 运行）第一次创建 `/var/spool/sustech-print/driver.log`
    会得到 `root:0600` —— 而安装脚本最后恰恰让用户"出问题看 driver.log"，
    用户只会看到 `Permission denied`。现在 `install.sh` 预建这个日志（0644），
    backend 里也做了兜底 `chmod`；测试用例刻意用 `umask 077` 复现这个条件。

    另外注意**有两个同名的 driver.log**，别搞混：
    backend 的在 `/var/spool/sustech-print/driver.log`，
    App 的在 `~/Library/Application Support/SUSTechPrint/driver.log`。

11. **"沙箱测试"必须自己保证不改动系统 —— 否则它会靠巧合通过，直到某天把真东西删了。**
    `run-tests.sh` 开头写着"不需要 root、不需要 sudo、不改动系统"。但 `uninstall.sh`
    的沙箱用例只覆盖了 `BACKEND_DIR` / `PPD_DIR` / `SPOOL_ROOT` 三个前缀，**没覆盖 `QUEUE`**，
    而当时的 `QUEUE` 默认值恰好是一个本机不存在的中文队列名：`lpstat -p` 判定"不存在"，
    于是走了"跳过"分支，测试一路绿灯 —— 这句"不改动系统"其实是**巧合**成立的。

    后来把 `QUEUE` 默认值改成真正装在机器上的 `SUSTech_Printer`，沙箱卸载立刻
    把**用户的真实打印队列删掉了**，而测试依然全绿。

    修法（两处都做了）：
    - `uninstall.sh` 增加 `SUSTECH_SKIP_QUEUE=1`（与 `install.sh` 对称），沙箱用例显式带上；
    - 沙箱用例再额外传一个纯沙箱队列名（`ZZSustechSandboxQueue`）做双保险；
    - 新增断言 E9：**对"真实队列的存在性"做前后比对**，任何越界立刻失败。

    这条的通用教训：凡是声称"只在沙箱里跑"的测试，都要有一个断言直接验证
    "沙箱外的东西没变"，而不是相信前缀覆盖得够全。

12. **打包后的 App 不能用 `process.cwd()` 定位自己的数据目录。**
    `lib/store.mjs` 里原本是 `join(process.cwd(), ".data")`：`node server.mjs`
    开发时 cwd 是仓库根，一切正常；**打包后就炸**——macOS 的 Finder / LaunchServices
    启动进程时 cwd 是 `/`，于是路径算成 `/.data`，登录成功那一刻写会话时抛

    ```
    ENOENT: no such file or directory, mkdir '/.data'
    ```

    （根目录在 Catalina 之后是只读的，所以连 `EPERM` 都轮不到。）Windows 上同理会
    落到 `C:\Program Files\sustech-print\.data`，普通用户同样写不进去。

    两处修法：
    - 路径改成 `CONFIG_DIR`（`lib/paths.mjs`），从此和 `driver-token` / `api-port`
      一样待在用户私有目录里；
    - 顺带把 `persistSession()` 改成吞异常只记警告——会话只是"下次不用重登"的便利，
      登录本身已经成功了，不该因为写盘失败给用户甩一个文件系统报错。

    通用教训：**打包产物里任何"相对当前目录"的路径都是定时炸弹**，一律改成
    `import.meta.url` 派生或平台数据目录；`process.cwd()` 只允许出现在开发工具里。
    另外前端 `api.ts` 现在对 5xx 统一显示"客户端出了点问题，重启应用后再试一次"，
    原始报错只进控制台——本机服务把 `ENOENT ... mkdir '/.data'` 直接端给用户看，
    除了让人困惑没有任何用处。

13. **`security find-generic-password -w` 对非 ASCII 的值不原样输出，而是吐十六进制。**

    实测：存 `p@ss word 中文!`，读回来是

    ```
    7040737320776f726420e4b8ade6968721
    ```

    纯 ASCII 的值（`abc123`、`a b c`）则原样返回 —— 所以这个坑只在"密码里有中文"
    时才炸，表现为"明明保存成功，却再也读不出来"，`JSON.parse` 直接抛异常、被上层
    的 `catch` 吞成"没保存过"，用户每次都得重登。存进钥匙串前先 base64 一层就没有
    歧义了（见 `lib/secret.mjs` 的 `macEncode` / `macLoad`）。

    另外一个反直觉点：`security add-generic-password -w` **没有** stdin / 文件形式。
    写 `-w -A` 会把字面量 `-A` 当成密码存进去，`-w` 后面不给值则变成等用户敲。

14. **`safeStorage` 只在跑着 Chromium 的 Electron 主进程里可用。**

    按需唤醒的那个无头进程是用 `ELECTRON_RUN_AS_NODE=1` 把同一个可执行文件
    当纯 node 跑起来的（实测 node v24.21.0，RSS 54 MB，没有 Chromium 进程）。
    这种模式下 `require("electron")` 只得到一个路径字符串，`app` / `safeStorage`
    全都没有 —— 于是在 `worker.mjs` 里 `import { app } from "electron"` 会在
    **模块解析阶段**就报

    ```
    SyntaxError: The requested module 'electron' does not provide an export named 'app'
    ```

    凭据因此改走 `lib/secret.mjs`（钥匙串 / DPAPI），GUI 和无头进程共用一份。

15. **`ELECTRON_RUN_AS_NODE` 下可以直接执行 asar 里的脚本。**

    不用 `asarUnpack`，也不用把 `server.mjs` / `lib/` 复制一份到 `extraResources`：

    ```
    ELECTRON_RUN_AS_NODE=1 <App>.app/Contents/MacOS/<App> \
        <App>.app/Contents/Resources/app.asar/desktop/worker.mjs --wake
    ```

    Electron 的 `fs` 补丁在 node 模式下同样生效，asar 路径能正常读、ESM 能正常解析。

16. **`launchd` 的 `WatchPaths` 指向不存在的路径时不会触发，也不会报错。**

    所以 macOS 的按需唤醒只在共享 spool 目录（`/var/spool/sustech-print/incoming`）
    存在时才装；驱动被卸载之后，客户端下次启动会把这个 agent 反向收掉。
    另外 `launchctl bootstrap` 对**已经加载**的 agent 会返回 `5: Input/output error`，
    想幂等地重装必须先 `bootout` 再 `bootstrap`。

17. **中文路径不要写进 `.cmd` 文件，要放进计划任务的 XML。**

    `cmd.exe` 按 OEM 代码页解码批处理文件，而计划任务的 XML 是 UTF-16 ——
    把 `C:\Program Files\sustech-print\南科大云打印.exe` 写进 `.cmd` 里，
    在非中文区域设置或代码页不匹配时就是一个找不到的程序。所以 Windows 的唤醒
    没有生成 `wake.cmd`，而是把整条命令塞进任务定义的 `<Arguments>`：

    ```
    cmd.exe /c if exist "<spool>\out.pdf" (set "ELECTRON_RUN_AS_NODE=1" & "<App>.exe" "<worker>" --wake)
    ```

    `cmd` 会等 worker 结束，所以也不存在"任务动作一结束，子进程被 Task Scheduler
    连带干掉"的问题。`if exist` 那道判断让绝大多数分钟级触发连进程都不用起
    （实测没有作业时 worker 60 ms 退出，且刻意不写日志文件）。

18. **计划任务里跑 `cmd.exe` 会闪黑框 —— 除非用 S4U。**

    任务动作是

    ```
    cmd.exe /c if exist "<spool>\out.pdf" (set "ELECTRON_RUN_AS_NODE=1" & "<App>.exe" "<worker>" --wake)
    ```

    而 `cmd.exe` 是控制台程序。用 `InteractiveToken`（任务计划程序里的"只在用户
    登录时运行"）注册时，任务跑在用户的交互会话里，于是**每次打印、以及每分钟的
    兜底触发都会在屏幕上闪一下黑框**。实测确认：任务运行期间确实新起了一个
    `conhost.exe`。

    改成 `S4U`（"不管用户是否登录都运行"）后进程落在 session 0，没有桌面，
    窗口也就无从谈起 —— 实测 worker 的 `SessionId = 0` 而当前交互会话是 1。
    代价是 S4U 下弹不出气泡通知，但无头进程本来就没界面，失败写 `driver.log` 够了。

    顺带一提：`<Hidden>true</Hidden>` 只管"在任务计划程序界面里隐藏这个任务"，
    跟窗口一点关系都没有。

19. **`server.close()` 的回调要等所有连接结束，能把"用完就退"的进程钉死。**

    无头进程的收尾原来是：

    ```js
    watcher.stop();
    await stopServer();   // -> server.close(cb)
    ```

    上游上传慢起来要几十秒（实测一次 52 秒），这时 `server.close()` 的回调
    **永远不来**。后果：worker 过了自己的 `MAX_MS` 还是不走，计划任务一直显示
    "正在运行"，文件名也永远留在 `processing/` 里 —— 看起来像卡死，其实是
    卡在一个"优雅关闭"上。

    修法是两件事一起做：超时收尾时 `server.closeAllConnections()` 直接掐断，
    另外无条件加一个 2 秒兜底 `setTimeout`，保证 `stopServer()` 一定返回。
