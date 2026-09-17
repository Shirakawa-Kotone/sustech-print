# 南科大云打印 —— macOS 打印驱动

把"打印"变成"上传到南科大云打印"，替代官方 Windows 客户端（官方只有 Windows 版）。

## 工作原理

```
任意 App ──打印──▶ CUPS 队列「SUSTech_Printer」
                      │
                      │ CUPS 的 PDF 直通滤镜（不转换，不需要 Ghostscript）
                      ▼
          /usr/libexec/cups/backend/sustech-print
                      │  从 stdin 读 PDF，原子写入共享 spool
                      ▼
        /var/spool/sustech-print/incoming/<时间>-<作业号>-<标题>.pdf
                      │
                      │ 桌面 App 监听这个目录
                      ▼
              「南科大云打印」桌面 App（负责登录、上传）
                      │
                      ▼
              pms.sustech.edu.cn 云端打印队列
```

**backend 只负责落盘，不联网、不读令牌、不关心 App 有没有在跑。**
作业写进 spool 后，App 一起来就会自动取走上传 —— 所以"打印时 App 没开"
不会失败，只是稍晚一点提交。

> **为什么不让 backend 自己上传？** 我们第一版就是那么做的，实测被两个
> macOS/CUPS 的硬事实打回：
> 1. **CUPS 给 backend 的 `HOME` 不是用户家目录**，而是 `/var/spool/cups/tmp`。
>    任何靠 `~/Library/Application Support/...` 找令牌/端口的做法都必然失败
>    （线上报错：`未找到驱动令牌 /private/var/spool/cups/tmp/Library/...`）。
> 2. **backend 不在用户的 GUI 会话里**，`open -a "南科大云打印"` 拉不起 App
>    （这正是原厂 Windows 客户端要折腾 `winsta0\default` + `explorer.exe` 的原因）。
>
> 落盘方案把这两个问题一起消掉了：不依赖 HOME、不依赖 GUI 会话、不依赖网络。

## 文件说明

| 文件 | 作用 |
|---|---|
| `sustech-print` | CUPS backend（POSIX `sh`，无第三方依赖）。装到 `/usr/libexec/cups/backend/` |
| `sustech-print.ppd` | 极简 PPD。声明"本设备直接吃 `application/pdf`"，让 CUPS 走直通滤镜 |
| `install.sh` | 安装：装 backend + PPD、建 spool 目录、建队列。`sudo` 运行，幂等 |
| `uninstall.sh` | 卸载：删队列 + backend + PPD，**默认保留 spool 里的文件**。`sudo` 运行 |
| `test/` | 不需要 root 的测试套件（见文末） |
| `REPORT.md` | 工程报告：设计推导、实测证据、没验证的部分 |

## 安装

前置条件：

- macOS（在 macOS 26.6.2 上实测）
- 已安装「南科大云打印」桌面 App（它负责登录与上传）
- 不需要 Homebrew，不需要 Ghostscript，不需要联网安装任何东西

```sh
cd driver/macos
sudo ./install.sh
```

安装脚本会：

1. 预检 PPD 是否合法、队列名是否含空白字符、device-uri 的 scheme 是否纯 ASCII
2. 装 backend 到 `/usr/libexec/cups/backend/sustech-print`（`root:wheel`，`0700`），
   并清理旧版遗留的中文 backend 别名
3. 装 PPD 到 `/Library/Printers/PPDs/Contents/Resources/`
4. **建 spool 目录**（属主给调用 `sudo` 的那个用户，`0750`）：
   - `/var/spool/sustech-print/` —— 放 `driver.log`（预建成 `0644`，用户读得到）
   - `/var/spool/sustech-print/incoming/` —— **App 监听这里**
5. 建/更新 CUPS 队列「SUSTech_Printer」并启用

先看看会做什么（不需要 root、不改任何文件）：

```sh
./install.sh --dry-run
```

### 卸载

```sh
sudo ./uninstall.sh                 # 保留 spool 里的文件（默认）
sudo ./uninstall.sh --purge-spool   # 连 spool 一起删
```

**默认保留 spool**，因为里面可能还有没被 App 提交的作业。卸载时会告诉你
目录在哪、还有几个文件没被取走。确认不需要了再手动
`sudo rm -rf /var/spool/sustech-print`。

## 打印

装完在"系统设置 → 打印机与扫描仪"里能看到 **SUSTech_Printer**。

```sh
lp -d SUSTech_Printer 论文.pdf
lp -d SUSTech_Printer -n 2 -o sides=two-sided-long-edge 论文.pdf
```

打印后：文件先出现在 `/var/spool/sustech-print/incoming/`，
App 取走后（通常一两秒）就消失了，随后能在云端队列里看到。

> ⚠️ 打印时 App 不用开着，但**只有 App 运行了作业才会被提交**。
> 如果文件一直躺在 incoming 里，把 App 打开即可。

### 打印选项

backend 只负责落盘，**不解析打印选项**（份数/双面/颜色由 App 在上传时决定，
或由你在云端界面设置）。CUPS 传下来的 `copies` / `options` 会原样记进日志，
方便排查。

## 日志与排错

**驱动日志**（backend 每次落盘都会追加，不含任何敏感信息）：

```
/var/spool/sustech-print/driver.log
```

一行长这样：

```
2026-09-17T13:14:00Z [sustech-print] [INFO] job=205 user=<用户> 结果 exit=0 bytes=911 format=pdf copies=1 options='copies=1' title='我的测试文档' file='1789650840280-205-我的测试文档.pdf' 已落盘
```

**CUPS 侧日志**（backend 的 stderr 也会进这里）：

```sh
tail -f /var/log/cups/error_log
```

**队列状态**：

```sh
lpstat -p SUSTech_Printer -l
lpq -P SUSTech_Printer
```

### 退出码

| 退出码 | 含义 | 用户看到什么 |
|---|---|---|
| 0 | 已写入 spool | 作业从 CUPS 队列消失，文件出现在 incoming |
| 1 | 失败 | 作业失败。**不会 hold 住队列**，日志里写明了原因 |

> 第一版用过退出码 2，结果 CUPS 把作业 "Job held for authentication" 一直卡在
> 队列里。现在确定性失败一律 1，原因看日志。

### 常见问题

**Q：打印后 `lpq` 里作业立刻消失，但文件不在 incoming 里**
说明 backend 失败了。看 `/var/spool/sustech-print/driver.log` 和
`/var/log/cups/error_log` 最后几行。

**Q：日志里写 `spool 目录不存在` / `spool 目录不可写`**
重新跑一次 `sudo ./install.sh`（它会用正确属主/权限重建目录）。

**Q：文件一直在 incoming 里不动**
App 没运行，或 App 还没改成监听这个新目录。把 App 打开；
若仍不动，确认 App 侧监听的是 `/var/spool/sustech-print/incoming`。

**Q：日志里写 `本作业是 PostScript，而本机没有 PS→PDF 转换器`**
见下面"已知限制"。

**Q：中文标题的文件名看起来正常吗？**
正常。文件名形如 `1789650840280-205-我的测试文档.pdf`：
`<epoch 毫秒>-<CUPS 作业号>-<清理过的标题>.pdf`。
标题里的 `/ \ : * ? " < > |` 会被替换成 `_`，控制字符被去掉，
标题最长 60 个字符。

## 已知限制

### 1. 需要 PostScript 的旧应用可能无法打印

本驱动只接受 **PDF**（CUPS 队列也是按"只吃 PDF"配的）。绝大多数 macOS 应用
在打印对话框里给出的就是 PDF，所以正常情况不受影响。少数跨平台应用会送
PostScript，这时：

- 如果本机碰巧装了 PS→PDF 转换器（`gs`/`ps2pdf`/`pstopdf`/`mutool` 任一），
  驱动会调它转成 PDF 再落盘；
- 如果本机什么都没有（**macOS 默认就是这样，实测 26.6.2 上这些全部不存在**），
  驱动会**明确失败（退出码 1）并且不产出任何文件** —— 我们不会把 PostScript
  改个 `.pdf` 后缀丢进 spool 让 App 上传一个坏文件。

绕法：在应用里先「存储为 PDF / Save as PDF」，再打印那个 PDF。

### 2. 作业不会被自动清理

backend 只管写，不管删。文件由 App 取走（App 会把它移到
`processing` / `done` / `failed`）。如果 App 长期不运行，incoming 会堆积 ——
可以放心手动删（先确认 App 没在跑）。

### 3. 多用户共用一台 Mac

spool 目录属主是**运行 `sudo ./install.sh` 的那个用户**，目录 `0750`。
如果这台机器有多个用户都打印，只有那个用户能读走文件。
（按实际使用场景，这里假定"一人一台 Mac"。）

## 为什么不用 raw 队列 / 为什么不需要 Ghostscript

简短版（详细证据见 `REPORT.md`）：

- macOS 26 的 `lpadmin` 已经**不支持 raw 队列**：
  `lpadmin -m raw` 直接返回「macOS不再支持原始队列。」
- 所以改用一份极简 PPD，用
  `*cupsFilter2: "application/pdf application/vnd.cups-pdf 0 -"`
  声明"设备直接吃 PDF"，CUPS 就会用 `-`（直通）滤镜，PDF 原样到达 backend。
- 实测：`cupsfilter -p sustech-print.ppd -i application/pdf ...` 的输出与输入
  PDF **逐字节相同**。
- 反过来，如果用系统自带的 "Generic PostScript Printer" PPD，PDF 会先被
  `cgpdftops` 转成 PostScript，而 macOS 上**没有**任何 PS→PDF 转换器，
  作业就废了。所以队列**不能**建在 PostScript PPD 上。

## 测试

不需要 root、不需要 sudo、不改动系统：

```sh
cd driver/macos/test
sh run-tests.sh          # 全套（当前 118 项全通过）
sh run-tests.sh --fast   # 跳过较慢的用例
```

覆盖内容：落盘正确性（`cmp` 逐字节）、文件名唯一性与中文安全、原子性
（用失败的 `mv` 和 SIGTERM 中断两种方式验证 App 永远看不到半个文件）、
PS/垃圾输入明确失败、**`HOME=/var/spool/cups/tmp` 回归用例**、
源码里不再出现 `$HOME`/`curl`/令牌/api-port、PPD 滤镜链、以及
`install.sh`/`uninstall.sh` 在沙箱 prefix 里的真实执行（含默认保留 spool
与 `--purge-spool` 的区别）。

### 安装脚本的环境变量覆盖（测试 / 便携部署用）

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SUSTECH_BACKEND_DIR` | `/usr/libexec/cups/backend` | backend 安装目录 |
| `SUSTECH_PPD_DIR` | `/Library/Printers/PPDs/Contents/Resources` | PPD 安装目录 |
| `SUSTECH_SPOOL_ROOT` | `/var/spool/sustech-print` | spool 根目录（含 `incoming/`） |
| `SUSTECH_QUEUE` | `SUSTech_Printer` | 队列名（用户在打印对话框里看到的名字） |
| `SUSTECH_QUEUE_INFO` | `南科大云打印` | 队列描述（`lpadmin -D`）。**macOS 会把 `printer-info` 当打印机名显示**，所以这里不要写括号注释 |
| `SUSTECH_QUEUE_LOCATION` | `SUSTech Cloud Print` | 队列位置（`lpadmin -L`） |
| `SUSTECH_BACKEND_ALIAS` | `南科大云打印` | 旧版遗留的中文 backend 别名（仅用于清理，不再创建） |
| `SUSTECH_DEVICE_URI` | `sustech-print:/sustech` | 设备 URI（scheme 必须纯 ASCII） |
| `SUSTECH_SPOOL_OWNER` / `SUSTECH_SPOOL_GROUP` | `$SUDO_USER` / `staff` | spool 属主 |
| `SUSTECH_ALLOW_NONROOT` | `0` | 允许非 root 装到自定义 prefix（系统路径仍被拒绝） |
| `SUSTECH_SKIP_QUEUE` | `0` | 跳过需要 root 的 `lpadmin` 建队列步骤 |
| `SUSTECH_INSTALL_OWNER` / `SUSTECH_INSTALL_GROUP` | `root` / `wheel` | 安装属主 |

驱动本身认这几个（主要给测试用）：`SUSTECH_SPOOL_DIR`（直接指定 incoming）、
`SUSTECH_DRIVER_LOG`（直接指定日志文件）。
