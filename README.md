# 南科大云打印 · 桌面客户端

把学校「联创云打印」的网页端换成桌面客户端 + 真正的系统打印驱动：
在 Word / 浏览器 / 任何能打印的程序里选 **南科大云打印**，作业落成 PDF 后自动进云打印队列。

> 只能在**校园网或学校 VPN** 下使用 —— 打印系统只对校内 IP 开放。

## 架构

| 层 | 代码 | 职责 |
| --- | --- | --- |
| 前端 | `web/src` | Vue 3 + Vite + Naive UI；构建产物 `web/dist` 由本地服务托管 |
| 本地服务 | `server.mjs` · `lib/` | 静态资源、上游 API 代理、CAS 登录、会话持久化、驱动接口 |
| 桌面壳 | `desktop/` | Electron：窗口 / 托盘 / 开机自启、safeStorage 凭据、spool 监听 |
| 驱动 | `driver/macos` · `driver/windows` | 虚拟打印机：作业落盘成 PDF，再交给本地服务上传 |

数据流：`任意程序 → 虚拟打印机 → spool 目录（PDF）→ 本地服务 → pms.sustech.edu.cn`

本地服务在桌面版里监听**随机端口**并把真实端口写进 `api-port`，驱动从那里读 —— 不要写死 8787。

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
npm run check                                               # Node 语法检查
sh driver/macos/test/run-tests.sh                           # macOS 驱动 119 项
powershell -File driver/windows/watch-spool.ps1 -SelfTest    # Windows 端口监视 62 项
```

两个套件都**不需要 root、不改动系统** —— 真会动系统的那部分只在沙箱前缀里跑，
并且有"沙箱外的东西没变"的断言兜底（见 `docs/pitfalls.md` 第 11 条）。

## 目录

```
server.mjs                HTTP 服务：静态资源 + API 代理 + CAS 登录 + 驱动接口
lib/pms.mjs               云打印客户端：Cookie 罐、CAS 登录、上游接口封装
lib/paths.mjs             所有落盘路径的唯一出处（App / 驱动 / backend 三方共用）
lib/store.mjs             会话与驱动令牌持久化
desktop/main.mjs          Electron 主进程：窗口、托盘、开机自启、IPC
desktop/spool-watcher.mjs spool 目录监听 → 自动上传
desktop/credentials.mjs   safeStorage 加密凭据
web/src                   前端源码（views / components / api.ts）
driver/macos              CUPS backend + PPD + install / uninstall + 测试
driver/windows            PowerShell：建端口和队列、spool 监视、安装 / 卸载
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
- **记住密码**（可选）→ Electron `safeStorage`（macOS 钥匙串 / Windows DPAPI）加密后写
  `CONFIG_DIR/credentials.bin`。纯浏览器里跑时退化成"主密码 + PBKDF2-SHA256（250k 次）+ AES-GCM"
  存在 `localStorage`，主密码本身不保存，忘了只能重新输入账号密码。

明文密码不落盘（实测验证过）。

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

## 更多

- `docs/pitfalls.md` —— 12 条实测踩坑，改代码前扫一眼
- `driver/macos/REPORT.md` · `driver/windows/REPORT.md` —— 驱动在真机上的实测报告

上游接口清单和补贴算法没有入库（属于学校系统的内部细节，不宜公开），需要时看
`lib/pms.mjs`。

## 许可

MIT，见 `LICENSE`。这是**非官方**客户端，与学校及打印系统厂商无关；
使用本程序产生的任何后果由使用者自行承担。
