# 南科大云打印 · 桌面客户端

把学校「联创云打印」的网页端换成桌面客户端 + 真正的系统打印驱动：
在 Word / 浏览器 / 任何能打印的程序里选 **南科大云打印**，作业落成 PDF 后自动进云打印队列。

> 只能在**校园网或学校 VPN** 下使用 —— 打印系统只对校内 IP 开放。

> 非官方客户端，与学校及打印系统厂商无关。

## 下载

安装包在 [Releases](https://github.com/Shirakawa-Kotone/sustech-print/releases/latest)：
macOS（Apple 芯片）用 `.pkg`，Windows 10 / 11 用 `Setup.exe`。

两个包都**没有代码签名**，所以第一次打开会被系统拦一下 —— 不是文件坏了，是系统不认识发布者：

- **macOS**：系统设置 → 隐私与安全性 → 找到被拦下的那一条 → **仍要打开**，再输一次密码。
  新版 macOS 已经取消了「右键 → 打开」这个绕过方式。
- **Windows**：「Windows 已保护你的电脑」→ **更多信息** → **仍要运行**。

介意的可以对着 release 页面上的 SHA256 核对一下。

下面都是开发相关的内容。

## 架构

| 层 | 代码 | 职责 |
| --- | --- | --- |
| 前端 | `web/src` | Vue 3 + Vite + Naive UI；构建产物 `web/dist` 由本地服务托管 |
| 本地服务 | `server.mjs` · `lib/` | 静态资源、上游 API 代理、CAS 登录、会话持久化、驱动接口 |
| 桌面壳 | `desktop/main.mjs` | Electron：窗口 / 托盘 / 凭据 IPC / spool 监听。**按需存在**，关窗口空闲一会儿就整个退出 |
| 无头进程 | `desktop/worker.mjs` | 由系统唤醒：起服务 → 上传 spool 里的 PDF → 退出。**纯 node，没有 Chromium** |
| 驱动 | `driver/macos` · `driver/windows` | 虚拟打印机：作业落盘成 PDF；顺带把"唤醒无头进程"的钩子装进系统 |

数据流：`任意程序 → 虚拟打印机 → spool 目录（PDF）→ 本地服务 → pms.sustech.edu.cn`

本地服务监听**随机端口**并把真实端口写进 `api-port`，驱动从那里读 —— 不要写死 8787。

### 内存：空闲时是 0

这个客户端以前是"开机自启 + 托盘常驻"，实测常驻 **587 MB**（主进程 210 + 渲染 217 +
GPU 108 + 工具 52）。现在改成**按需启动**：

| 状态 | 进程 | 内存 |
| --- | --- | --- |
| 空闲 | 无 | **0** |
| 用户打开界面 | Electron | ~590 MB（关窗口即释放渲染进程，再空闲 5 分钟整个退出） |
| 打印时 | `worker.mjs` | ~55 MB，跑几秒到几十秒，上传完就退 |

唤醒是系统级的、不需要常驻任何进程：

- **macOS**：LaunchAgent 用 `WatchPaths` 盯着 `/var/spool/sustech-print/incoming`，
  目录一有动静 `launchd` 就把无头进程拉起来 —— 毫秒级，零常驻。由 App 每次启动自愈式写入。
- **Windows**：计划任务 `SUSTechPrint-Wake`，触发器是**打印事件日志**
  `PrintService/Operational` 的事件 307（作业一完成就触发，实测 2 秒内起进程）+ 每分钟兜底一条。
  动作先 `if exist out.pdf` 挡一道，平时连进程都不起。

  **必须用 S4U 登录方式**（"不管用户是否登录都运行"）：动作是 `cmd.exe`，而
  Interactive（"只在用户登录时运行"）会把任务跑在用户的交互会话里，于是每次打印
  都会在屏幕上**闪一下黑框**（实测：任务运行期间确实新建了 conhost）。S4U 把进程放进
  session 0，那里没有桌面，窗口无从谈起。安装脚本默认 S4U，注册失败才退回 Interactive。

两边都是 `ELECTRON_RUN_AS_NODE=1 <App 可执行文件> desktop/worker.mjs --wake`
—— 直接拿 Electron 那个二进制当纯 node 用，所以不用额外分发 Node 运行时。
**因此 `worker.mjs` 里绝对不能 `import "electron"`**，凭据一律走 `lib/secret.mjs`。

开机自启已经取消（本来就是为了常驻），升级时会自动清掉旧版本留下的登录项。

### 装完必须打开一次客户端

安装包的最后一个动作就是把客户端拉起来（Windows 走 NSIS 的 `runAfterFinish`，
macOS 走 pkg postinstall 里的 `launchctl asuser ... open -g`），让用户完成登录。

这不是体验问题：登录态是服务端会话 cookie，没有 `expires`；而打印时被唤醒的
无头进程**读不到旧格式（safeStorage）的凭据**，要靠 App 启动时把它迁到钥匙串/DPAPI。
所以"装完从没打开过"就等于"打印了什么都不会发生"。登录一次之后，之后每次
会话过期都由无头进程自己用迁移过来的凭据重登。

## 开发

```bash
npm install                 # 只有 electron / electron-builder 两个开发依赖
npm --prefix web install    # 前端依赖
npm run web:build           # 构建前端
npm start                   # 只跑本地服务 → http://127.0.0.1:8787
```

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地服务 + 改代码自动重启 |
| `npm run web:dev` | 前端热更新（Vite；另开一个终端跑 `npm start` 提供 API） |
| `npm run app` | 构建前端并启动 Electron 壳 |
| `npm run check` | Node 语法检查 |
| `npm run dist:mac` 等 | 见下 |

## 打包

```bash
npm run dist:mac        # dmg（arm64 + x64）
npm run dist:mac-pkg    # pkg：多一个 root 安装脚本，装完即带 CUPS 驱动
npm run dist:win        # NSIS 安装包（perMachine，需要管理员权限）
```

产物在 `dist-app/`。国内网络先设镜像，否则 electron / NSIS 的二进制下不动：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm config set registry https://registry.npmmirror.com
```

Windows 包只能在 Windows 上出（NSIS + PowerShell 驱动脚本）。跨机同步源码时记得带上 `web/dist`，
或者把 `web/` 源码一起带过去自己构建。

## 测试

```bash
npm run check                                                       # Node 语法检查
sh driver/macos/test/run-tests.sh                                   # macOS 驱动 120 项
powershell -File driver/windows/watch-spool.ps1 -SelfTest            # Windows 端口监视 62 项
powershell -File driver/windows/install-wake.ps1 -Action install -SelfTest   # 计划任务定义校验
```

这些套件都**不需要 root、不改动系统** —— 真会动系统的那部分只在沙箱前缀里跑，
并且有"沙箱外的东西没变"的断言兜底（见 `docs/pitfalls.md` 第 11 条）。

## 目录

```
server.mjs                HTTP 服务：静态资源 + API 代理 + CAS 登录 + 驱动接口
lib/pms.mjs               云打印客户端：Cookie 罐、CAS 登录、上游接口封装
lib/paths.mjs             所有落盘路径的唯一出处（App / 驱动 / backend 三方共用）
lib/store.mjs             会话与驱动令牌持久化
lib/secret.mjs            凭据存储（钥匙串 / DPAPI），GUI 与无头进程共用
desktop/main.mjs          Electron 主进程：窗口、托盘、IPC、空闲退出、装唤醒钩子
desktop/worker.mjs        无头进程：被系统唤醒后上传 spool 并退出（纯 node）
desktop/spool-watcher.mjs spool 目录监听 → 自动上传
desktop/credentials.mjs   Electron 侧凭据封装 + 老格式迁移
web/src                   前端源码（views / components / api.ts）
driver/macos              CUPS backend + PPD + install / uninstall + 测试
driver/windows            PowerShell：建端口和队列、spool 监视、按需唤醒、安装 / 卸载
build/                    打包资源：图标、installer.nsh、pkg postinstall
tools/                    开发工具：上游接口探测、图标渲染、UI 探针、mock 上游
public/                   旧版无框架前端（web/dist 不存在时的兜底）
```

## 必须一起改的东西

- **队列名 `SUSTech_Printer`**：`lib/paths.mjs` · `web/src/const.ts` · `driver/macos/install.sh`
  · `driver/windows/install-printer.ps1` 必须逐字一致，测试里有断言。不能用空格 ——
  CUPS 拒绝空白字符，报错却写成"只能包含可打印字符"，很容易查错方向。
- **落盘路径只在 `lib/paths.mjs` 定义**：用户私有目录（macOS `~/Library/Application Support/SUSTechPrint`，
  Windows `%LOCALAPPDATA%\SUSTechPrint`）+ 机器级 spool（Windows `%ProgramData%\SUSTechPrint\spool`，
  macOS `/var/spool/sustech-print/incoming`）。别在业务代码里另拼一套。
- **不要用 `process.cwd()`** 定位任何东西：打包后 cwd 是 `/` 或安装目录（`docs/pitfalls.md` 第 12 条）。
- **驱动令牌**：`CONFIG_DIR/driver-token`，只给本机 `POST /api/driver/print` 用。

## 凭据

登录走学校 CAS（`cas.sustech.edu.cn`）。落盘两种：

- **会话 Cookie** → `CONFIG_DIR/session.json`（0600），没过期就不用重新登录；
- **记住密码**（可选）→ 走 `lib/secret.mjs`：macOS 写系统钥匙串，Windows 写 DPAPI
  （`CONFIG_DIR/credentials.dpapi`）。纯浏览器里跑时退化成"主密码 + PBKDF2-SHA256（250k 次）+ AES-GCM"
  存在 `localStorage`，主密码本身不保存，忘了只能重新输入账号密码。

明文密码不落盘（实测验证过）。

**为什么不用 Electron 的 `safeStorage`**：打印时被唤醒的那个无头进程不跑 Electron，
拿不到它，却必须能自动重登（云打印的登录态是服务端会话 cookie，没有 expires，空闲一会儿
就没了）。两边统一走 `lib/secret.mjs`。老版本存在 `credentials.bin` 里的密码会在首次运行时
自动迁移过来，用户不用重新登录。

**macOS 上的取舍**：`security` 建钥匙串条目时，ACL 默认信任的是"创建它的程序"，
也就是 `/usr/bin/security` 这个通用命令行工具而不是本程序 —— 于是任何以当前用户身份
运行的进程都能静默读到它，比 `safeStorage`（ACL 绑定到本 App，别人读要弹框）弱。
之所以接受：Node 不能直接调 `Security.framework`，自己编原生模块又违背零依赖的约定。
Windows 那边没有降级 —— DPAPI 本来就只有"当前用户可解"这一个边界。
另外 `security add-generic-password` 没有 stdin/文件形式，保存的一瞬间密码会出现在 argv 里。
详见 `lib/secret.mjs` 顶部的注释。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址；桌面版传 `0` 让系统随机挑 |
| `PMS_ORIGIN` | `https://pms.sustech.edu.cn` | 上游地址 |
| `PMS_TIMEOUT_MS` | — | 上游请求超时 |
| `SUBSIDY_PER_YEAR` / `SUBSIDY_RESET_MONTH` / `SUBSIDY_RESET_DAY` | `100` / `9` / `1` | 补贴额度与学年起点 |
| `SUSTECH_CONFIG_DIR` / `SUSTECH_SPOOL_DIR` | 见上 | 覆盖落盘目录（测试、便携部署用） |
| `SUSTECH_PRINTER_NAME` | `SUSTech_Printer` | 队列名 |
| `DEBUG_UPLOAD` | — | 设为 `1` 打印上传流程日志 |
| `SUSTECH_IDLE_EXIT_MS` | `300000` | 关窗口后空闲多久整个退出；`0` = 永不自动退出（测试时设小一点，如 `8000`） |
| `SUSTECH_WORKER_QUIET_MS` | `3000` | 无头进程连续多久没有新作业就退出 |
| `SUSTECH_WORKER_MAX_MS` | `180000` | 无头进程硬上限 |

## 更多

- `docs/pitfalls.md` —— 实测踩坑，改代码前扫一眼
- `driver/macos/REPORT.md` · `driver/windows/REPORT.md` —— 驱动在真机上的实测报告

上游接口清单和补贴算法没有入库（属于学校系统的内部细节，不宜公开），需要时看
`lib/pms.mjs`。

## 许可

MIT，见 `LICENSE`。这是**非官方**客户端，与学校及打印系统厂商无关；
使用本程序产生的任何后果由使用者自行承担。
