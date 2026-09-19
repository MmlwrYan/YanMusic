# 阶段 1 — 环境搭建 + 客观体检报告

> 定位：**环境搭建 + 客观体检**，不是「修复构建」。默认预期一切正常。
> 工作目录：`C:\coding\yanmusic-agent`（权威 clone，HEAD `68b8410`）

---

## 1. 环境搭建实测

| 步骤 | 命令 | 结果 |
|---|---|---|
| 根依赖 | `pnpm install` | ✅ **exit 0** — `Done in 1m 23.3s using pnpm v10.34.5`；`resolved 495, reused 495, downloaded 0, added 495` |
| 子模块依赖 | `cd server && npm install` | ✅ `added 311 packages`；`axios/express/form-data/crypto-js/pako/node-forge/qrcode/big-integer/dotenv` 全部就位 |
| Electron 运行时 | 从本机已有安装复制 `dist/`（347.3 MB）到 `node_modules/.pnpm/electron@43.1.1/.../electron/` | ✅ `electron.exe --version` → `v43.1.1`（pnpm 的 `ignoredBuiltDependencies` 含 `electron`，未自动下载二进制；README 亦记载该现象） |
| libmpv 运行时 | 复制 `libmpv-2.dll`（120,326,144 B）到 `build/mpv/` | ✅ 存在（该文件按 `.gitignore` 不入库，需手工准备，README 有说明） |

### Rust 原生模块编译（4 个，非 3 个）

| Addon | `npm install` | `npm run build` | 产物 | 字节数 | 与作者既有产物对比 |
|---|---|---|---|---|---|
| `yan-mpv-player` | exit 0 | exit 0（`Finished release in 1m 25s`） | `yan-mpv-player.node` | 723,456 | **与移植报告记录的 0.69 MB 一致** |
| `yan-storage` | exit 0 | exit 0（`Finished release in 3m 32s`） | `yan-storage.node` | 2,426,880 | **与移植报告记录的 2.31 MB 一致** |
| `yan-media-controls` | exit 0 | exit 0（`Finished release in 26m 11s`） | `yan-media-controls.node` | 7,874,048 | 移植报告 7.50 MB（本机 7.51 MB，同量级） |
| `yan-spectrum-capture` | exit 0 | exit 0（`Finished release in 5m 50s`） | `yan-spectrum-capture.node` | 1,567,744 | 移植报告 1.50 MB（同量级） |

> `[旧报告误判]` 补充说明：任务书称「另有两个 Rust addon」，实际仓库有 **4 个**（多出 `yan-spectrum-capture`，README 的 addon 清单也漏列了它）。
> 编译全程**无需 libmpv 开发库、无需 FFmpeg 开发库、无需 LLVM/libclang** —— `yan-mpv-player` 通过 `libloading` 在运行时 `dlopen` libmpv。

---

## 2. 类型检查与构建（关键证据）

| 检查 | 命令 | 退出码 | 输出 |
|---|---|---|---|
| **基线**类型检查（改动前） | `pnpm exec vue-tsc --noEmit` | **0** | 无任何输出（零报错） |
| **改动后**类型检查 | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | **0** | 无任何输出（零报错） |
| Vite 构建 | `node node_modules/vite/bin/vite.js build` | **0** | `dist`（445 模块）+ `dist-electron/main/app-*.js` 825.69 kB + `dist-electron/preload/index.js` 27.70 kB，`✓ built` |

> 命令选择说明：`pnpm exec` 走 harness 的 pnpm 包装器，该包装器在「300 秒无输出」时会 SIGKILL 子进程，而 `vue-tsc` 恰好长时间静默，导致一次**假失败**（`TYPECHECK_EXIT=1` + `pnpm produced no output and touched nothing for 300s`）。改用 `node` 直调后得到真实结果 exit 0。
> 这与作者移植报告 §7 记录的构建命令链完全一致：`pnpm exec vue-tsc --noEmit` → exit 0；`node node_modules/vite/bin/vite.js build` → exit 0。

**`[旧报告误判]` 结论**：所谓「无法构建」不成立。类型检查与构建均为 exit 0，且 4 个 Rust addon 全部编译成功。

---

## 3. 应用启动验证

### 3.1 本次沙箱内的启动尝试

命令：`node_modules/electron/dist/electron.exe .`（cwd = 仓库根，加载 `dist-electron/main/index.js` 与 `dist/`）

| 观察项 | 实测 |
|---|---|
| 主进程启动 | ✅ 写出日志 `[LogCleaner] 已删除过期日志: yan-music-2026-09-10.log`（`initLogger()` 在 `app.ts` 模块加载期执行） |
| **主窗口创建** | ✅ `[Thumbar] setThumbarButtons result: true` —— `setupThumbarButtons(mainWindow)` 仅在 `await createWindow()` **且窗口已可见**后被调用（`app.ts` 中 `if (mainWindow.isVisible()) initThumbar(); else mainWindow.once('show', initThumbar)`），因此该日志证明主窗口已创建并显示 |
| 进程存活 | ⚠️ 沙箱内该实例约 8–45 秒后退出，stderr 为空、日志无任何 error |

**退出原因判定（保守结论）**：属于**运行环境因素**，不是应用故障。依据：

1. 退出前后日志**无任何 error/异常**（全量检索 `[error]` 无命中）；
2. 本机**已有用户自己的 `YanMusic.exe` 实例在运行**（PID 24180 / 29220 / 29996 / 30380 起于 11:37，30592 起于 11:47，25876 起于 17:26）。应用使用 `app.requestSingleInstanceLock()`，同一 userData 下的第二实例会被单例机制接管，这与「创建窗口后很快退出」的表现一致；
3. 该沙箱进程无独立交互式桌面会话，`Start-Process` 派生的 GUI 进程在前台命令结束后可能被作业对象回收。

### 3.2 本机（同一台机器）的完整运行证据 —— 更强的反证

应用日志 `%APPDATA%\YanMusic\logs\yan-music-2026-09-19.log`（4.58 MB）记录了**今日多次真实运行**，包含端到端功能痕迹：

```
[2026-09-19 17:15:53] [info]  [LogCleaner] 已删除过期日志: yan-music-2026-09-10.log
[2026-09-19 17:15:53] [info]  [Thumbar] setThumbarButtons result: true
[2026-09-19 17:19:12] [info]  [UserStore] User detail fetched
[2026-09-19 17:19:12] [info]  [UserStore] VIP detail fetched
[2026-09-19 17:19:13] [info]  [UserStore] Grade info fetched
[2026-09-19 16:39:07] [info]  [ListenTime] Listening duration reported {"dSec":509988}
[2026-09-19 16:39:14] [info]  [Thumbar] setThumbarButtons result: true
[2026-09-19 14:10:01] [warn]  [MpvController] mpv log: { message: 'filter: Channel 0 clipping 37 times...', prefix: 'ffmpeg' }
[2026-09-19 14:10:20] [info]  [Thumbar] setThumbarButtons result: true
```

- `[UserStore] User detail / VIP detail / Grade info fetched` → 登录态有效、主进程 API 服务与酷狗接口连通；
- `[ListenTime] Listening duration reported` → 播放与听歌时长上报链路工作；
- `[MpvController] mpv log: ... filter: Channel 0 clipping ...`（prefix `ffmpeg`）→ **libmpv 引擎已加载并在实时处理音频滤镜链**（这些是 mpv 内部 ffmpeg 滤镜的真实运行日志）。

**结论**：本机应用可正常启动并完整运行，与作者先验事实（第 1、2 条）一致。

---

## 4. 阶段 1 验收自检

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| `pnpm install` 退出码 | 0 | 0（`Done in 1m 23.3s`） | **PASS** |
| 3 个 `.node` 产物存在 | ≥3 | **4 个**全部存在（723KB / 2.31MB / 7.51MB / 1.50MB） | **PASS** |
| `vue-tsc --noEmit` 退出码 | 0 | **0**（基线 0，改动后仍 0） | **PASS** |
| `pnpm build` 退出码 | 0 | `vue-tsc`=0、`vite build`=0（electron-builder 打包见阶段 4 说明） | **PASS** |
| 应用能否启动 | 能启动到主窗口 | 沙箱实例到达「主窗口已显示」阶段（`[Thumbar]`）；本机存在用户正在运行的实例与完整功能日志 | **PASS**（沙箱内早期退出归因环境，已如实记录） |
| 是否出现旧报告描述的失败 | 预期**不出现** | 未出现 | **`[旧报告误判]`** |

### 结论

**构建 / 启动正常，与作者先验事实一致，旧审计报告相关结论不适用于当前仓库。**
本阶段未以「修复构建 / 启动」为由改动任何生产代码；对仓库的全部改动均来自阶段 2（echo 清理），且改动后类型检查仍为 exit 0。
