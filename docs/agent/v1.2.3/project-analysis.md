# YanMusic 项目全面分析报告

> 分析对象：`C:/coding/YanMusic`（v1.2.3，HEAD `a6abb16`）
> 分析范围：源码树、原生模块、服务端、构建链、CI、文档体系
> 本文件位于 `docs/agent/v1.2.3/`（按版本分层归档）。原始存放位置为 `dev-notes/project-analysis.md`（该目录已于 2026-09-27 合并入 `docs/agent/`）。

---

## 一、项目定位

**YanMusic 是一个基于酷狗（Kugou）公开 API 的第三方桌面音乐播放器**，GPL-3.0，Electron + Vue 3 + Rust 混合架构。

| 项 | 值 |
|---|---|
| 版本 | 1.2.3 |
| 授权 | GPL-3.0 |
| upstream | [EchoMusic](https://github.com/hoowhoami/EchoMusic) `2.3.1-beta.24`（二次开发，非 fork 同步） |
| 平台 | macOS（dmg/zip，含 x64 与 arm64）、Windows（NSIS x64/arm64）、Linux（AppImage/deb/pacman/rpm/tar.gz） |
| 应用 ID | `com.mmlwryan.yanmusic` |
| 自定义协议 | `yanmusic://`（分享深链） |

**关键事实：本项目并不解析网易云/QQ 等音源用于播放。** 全部曲库数据与音频流均来自酷狗协议；网易云、QQ、酷我、汽水、Spotify、Apple Music 只在「**外部歌单导入**」这一条链路上出现（`src/main/external/providers/`，8 个解析器），解析结果再导入酷狗曲库。这是理解整个数据流的前提。

---

## 二、技术栈与版本

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron 43.7.3（README 仍写 43.1.1，实际以 package.json 为准） |
| 前端 | Vue 3.5.43 + TypeScript 5.9.3 + Vite 8.3.0 |
| 状态 | Pinia 3.0.4 + **自研** `sqlitePersist` 插件（非 `pinia-plugin-persistedstate`） |
| UI | Reka UI 2.10.5（薄封装）+ Tailwind CSS 4.3 + 自绘组件 |
| 路由 | Vue Router 4（`createWebHashHistory`） |
| 播放内核 | **libmpv**（运行时 `libloading` 动态加载，非编译期链接） |
| 原生扩展 | napi-rs v3（4 个 Rust cdylib crate） |
| 后端服务 | `server/` = [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) git submodule，**进程内**调用（非 spawn 子进程） |
| 云端 | Cloudflare Worker + D1（插件市场热度统计） |
| 包管理 | pnpm 9（CI 固定 Node 20 打包 / Node 24 测试） |

---

## 三、四进程/多入口架构总览

```
┌─────────────────────────── Electron 主进程 (dist-electron/main) ───────────────────────────┐
│  index.ts   → ready 前开关：Linux mpv 环境修复 / setAppUserModelId / audio loopback /       │
│               no-sandbox / 硬件加速 / DPI                                                    │
│  app.ts     → 单例锁 → 协议注册 → IPC 注册 → whenReady →                                    │
│               Promise.all([initApiServer(), initMpvPlayer()]) → initMediaControls →          │
│               createWindow() → 托盘/任务栏                                                   │
│                                                                                             │
│  ├─ ipc/        17 个域，64 个通道（registry 统一包装 + 权限观测）                            │
│  ├─ mpv/        MpvController：命令串行化 / 看门狗 / 滤镜结构键 / duck 淡入淡出               │
│  ├─ plugins.ts  3362 行：清单解析、市场源、安装卸载、安全模式                                │
│  ├─ external/   8 个外部歌单解析器                                                          │
│  └─ storage/    yan-storage 原生模块封装                                                     │
└───────────────┬───────────────────────────────────────────┬─────────────────────────────────┘
                │ contextBridge (src/preload/index.ts, 1150 行)
                │ 统一 API 面 + 通用 ipcRenderer 透传
    ┌───────────┴────────┐   ┌──────────────────┐   ┌──────────────────┐
    │  index.html        │   │ desktop-lyric.html│   │ plugin-window.html│
    │  主窗口 + mini 路由 │   │ 桌面歌词（独立窗） │   │ 插件浮窗          │
    │  同一 bundle        │   │ persist:desktop-  │   │ persist:plugin-   │
    │                    │   │ lyric 分区         │   │ window-<id>-<n>   │
    └─────────┬──────────┘   └──────────┬───────┘   └──────────┬───────┘
              │ 状态源（Pinia）          │ sync.ts 单向镜像      │ YanPluginWindowContext
              ▼                          ▼                        ▼
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ Rust 原生模块（resources/native/*.node，asarUnpack）                      │
    │  yan-mpv-player     libmpv 播放 / EQ / IR 卷积 / 淡入淡出 / 看门狗        │
    │  yan-storage        SQLite（KV / 队列 / 歌曲 / 历史 / 插件库）            │
    │  yan-media-controls SMTC / MPNowPlayingInfoCenter / MPRIS + Windows 缩略图│
    │  yan-spectrum-capture WASAPI loopback / ALSA-PulseAudio / ScreenCaptureKit│
    └─────────────────────────────────────────────────────────────────────────┘
              │ IPC api:request
              ▼
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ server/（KuGouMusicApi，进程内 require，扫描 module/*.js 懒加载路由）      │
    │ 渲染层 → request.ts 注入 Authorization/设备指纹 → api:request →           │
    │ handleApiRequest → 酷狗上游                                        │
    └─────────────────────────────────────────────────────────────────────────┘
```

### 三条必须记住的架构约束

1. **引擎早于窗口**：`initMpvPlayer()` 与 `initApiServer()` 在 `createWindow()` **之前**完成。因此渲染层的设置（音频缓冲/缓存/声道）必须由主进程自己读、自己迁移，否则「升级后第一次启动」必然读到旧默认值。这正是 v1.1.2 修掉的一整类缺陷（`src/main/mpv/audioOptions.ts`）。
2. **四个窗口共用同一 preload，且 mini 播放器与主窗口加载同一份 `index.html`**（`miniPlayer.ts:231` vs `window.ts:362`）。后果：仅凭 `senderFrame.url` **无法区分主窗口与 mini 播放器**。这是 IPC 白名单只能"只观测不拒绝"的结构性原因，`permissions.ts` 把它们标成 `ambiguous: true → 一律放行`。
3. **`webSecurity: false` + `sandbox: false` + `allowRunningInsecureContent: true`** 是全窗口基线（Windows 另加 `no-sandbox`）。这是产品级取舍（跨域封面/媒体加载），安全边界因此从"渲染层隔离"转移到**主进程侧**：`will-navigate` fail-closed 拦截（`src/shared/navigationPolicy.ts`）、CSP Report-Only 观测、IPC 权限观测。

---

## 四、代码规模与热点

- `src/` 共 **434** 个文件（283 `.ts` / 145 `.vue` / 6 `.css`），约 **12.4 万行**。
- 渲染层：19 个主视图（另有 `details/` 5 个详情页）+ 69 个组件（其中 `components/ui/` 是 Reka UI 的封装层，35 个）。
- 主进程 82 个文件。

**巨型文件（已知技术债，CHANGELOG 中记为 `N-07`/`IMP-07`，明确"单独立项再拆"）：**

| 行数 | 文件 |
|---|---|
| 3362 | `src/main/plugins.ts` |
| 2902 | `src/renderer/plugins/runtime.ts` |
| 2655 | `src/renderer/stores/listenTogether.ts`（≈110KB） |
| 2093 | `src/renderer/layouts/Sidebar.vue` |
| 2046 | `src/renderer/views/details/SongDetail.vue` |
| 1769 | `src/renderer/miniPlayer/MiniPlayerView.vue` |
| 1680 | `src/renderer/desktopLyric/DesktopLyricView.vue` |
| 1495 | `src/main/ipc/settings.ts` |
| 1150 | `src/preload/index.ts`（单文件承载全部 API 面） |

---

## 五、原生层（Rust，4 个 crate）

统一约定：`crate-type = ["cdylib"]`、`napi 3`（features `napi9`）、`napi-build 2`、`@napi-rs/cli ^3.5.1`、`napi build --release --no-const-enum`；产物 `<name>.node` 落在 crate 根目录，由 electron-builder `extraResources` 拷到 `resources/native/`。

### 1. yan-mpv-player
- `mpv_ffi.rs`：`libloading` 动态加载约 18 个 libmpv 符号。
  - **Linux 刻意不用 `RTLD_DEEPBIND`**（与 Electron PartitionAlloc + 新 glibc 冲突会崩）。
  - 库路径定位在 JS 侧 `src/main/mpv/path.ts`：优先 `resources/mpv` → `build/mpv` → 系统；**Linux 优先系统库**以避开 Electron 裁剪版 libffmpeg 的符号冲突，冲突由 `linuxEnv.ts` 用 `ldd` 解析 + `LD_PRELOAD` + `app.relaunch()` 兜底。
- `player.rs`：`MpvPlayerConfig` 的默认值**同时是渲染层设置基准**（cache 30s、readahead 30s、demuxer 10/48/12 MiB、gapless=weak…）。
- `event_loop.rs`：独立线程 `mpv_wait_event(0.5s)` 轮询 → `ThreadsafeFunction<PlayerEvent>`（NonBlocking）。
- **工程化细节（这是本项目相对上游的主要增值）**：
  - seek 后 **80ms 静音**防爆音（`seek_mute_seq` 防旧恢复任务抢跑）；
  - 淡入淡出在独立线程按 16ms 步进 + **ease-out-quad** 缓动，`fade_seq`(AtomicU64) 支持取消/抢占；
  - `op_lock` 串行化句柄访问、`shutdown`(AtomicBool) 全线程退出标志、`PENDING_LOADS` 解决 `loadfile` 与 `file-loaded` 匹配。
- EQ / 空间音效 / 音量均衡的**滤镜链在 JS 侧拼接**（`MpvController.syncAudioFilters`），Rust 提供 `af_command` 做**运行时改参不重建卷积器**；响度走 `volume-gain` 属性，不支持时回退 af volume。

### 2. yan-storage
- `rusqlite 0.32 (bundled)` —— 内置 SQLite，零系统依赖。单文件 `lib.rs` ≈1500 行。
- PRAGMA：WAL / foreign_keys=ON / synchronous=NORMAL / temp_store=MEMORY / busy_timeout=5000。
- **表结构**：`app_kv`、`playback_queues`、`songs`、`queue_items`、`play_history`，另有插件库一族 `plugin_sqlite_*`。
- **`play_history` 是「一曲一行」**：PK=`song_key`，`ON CONFLICT(song_key) DO UPDATE` + `play_count`。这个设计直接决定了「听歌档案」的**近似基线**方案——升级前的逐次时刻无法还原，只能"每曲一条、时间取最后一次、次数记 `baselinePlayCount`"并标 `synthetic: true`（拒绝把总次数摊成伪造时间点）。属于**存储模型反向约束产品功能**的典型案例。

### 3. yan-media-controls
- Windows：WinRT `MediaPlayer` + `SystemMediaTransportControls`；封面非 JPEG 时用 `image` crate 重编码；另有 `taskbar.rs` 导出 DWM 缩略图/Aero Peek（`taskbar_*` 5 个函数）。
- macOS：`MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`（objc2）。
- Linux：独立线程 tokio runtime 跑 `mpris-server`（D-Bus `org.mpris.MediaPlayer2`）。
- `update_metadata` 走 `AsyncTask` 工作线程——封面重编码几十 ms，不能占主线程。

### 4. yan-spectrum-capture
- Windows：`cpal` 默认输出设备 mix format 做 **WASAPI loopback**；
- Linux：先试 cpal 找 `monitor|loopback|stereo mix`，失败回落 `parec/pacat` 抓 PulseAudio/PipeWire monitor；
- macOS：**ScreenCaptureKit**（手动 objc2 runtime 取类）+ CoreMedia `CMSampleBuffer` 解析 lpcm。
- DSP：`SampleRing` 环形缓冲 + Hann 窗 + `rustfft`，支持 Linear/Log/Mel 分频，输出 0–255 的 128 bins（可配 30–60fps），另出 128 点波形。

---

## 六、server/ 子模块的接入方式（值得单独记住）

`server/` 是 `KuGouMusicApi` 的 git submodule（**当前未初始化内容可见于 `server/` 目录，但它是独立仓库**）。

**它不是被 spawn 的 HTTP 服务**，而是**进程内复刻**（`src/main/server.ts`）：
1. `resolveServerPath()`：dev=`process.cwd()/server`，打包=`process.resourcesPath/server`；
2. 把 `server/node_modules` unshift 进 `module.paths`（保证 asar 打包后 `crypto-js` 仍可解析）；
3. `scanModules()` 建 route→path 映射，**懒加载**（命中才 `require`），把 Express 路由逻辑复刻为纯函数；
4. 渲染层 → `api:request` → `handleApiRequest`。

**打包时只带 `server/module`（仅 `.js`）、`server/util`（`.js`+`.json`）、`server/node_modules`（全量）**，不带 `server.js`/express 顶层服务。渲染层 request 走 `electronAxiosAdapter.ts`（axios → Chromium session），dev 模式已无需 HTTP proxy。

---

## 七、渲染层要点

- **入口对应关系**（易误解，需订正）：
  - `desktop-lyric.html` → `src/desktop-lyric/main.ts`（**不在** `src/renderer/desktopLyric/`，后者只放 UI 组件与 sync）；
  - `plugin-window.html` → `src/plugin-window/main.ts`；
  - **mini 播放器不是独立产物**，是主窗口路由 `#/mini-player`，与主窗口共享同一 Pinia 实例。
- **自研持久化 `stores/sqlitePersist.ts`**：以 Pinia 插件形态钩住 `pinia.use()`，键 `pinia:<storeId>`，读写走 `storage.kv` → `yan-storage`；支持 `persist: true / {pick, omit}`；`$subscribe` 120ms 防抖 + 深比较去重；**显式跳过 `playlist` store**（队列体积大，改走主进程结构化 IPC `storage.getPlaybackQueue/...`）；`detached: true` 避免订阅随短命组件 scope 卸载而静默失效。
- **播放链路护栏**（并发与竞态是这层的核心复杂度）：`awaitingTrackLoad`、`stallRecovering`、`recentSeekIgnoreEnd`、`playbackRequestSeq`、`autoNextSuppressed`。前端不发音频，只做状态编排 + IPC。
- **歌词**：`stores/lyric.ts` 单点解析 KRC/YRC/LRC 三种格式（行内逐字 `/ <startOffset,duration,0>字/`），翻译/音译按行索引挂载；逐字动画用 **RAF + 直接操作 DOM**（`backgroundPositionX`）绕过 Vue 响应式，含本地单调时钟外推、120ms lookahead、300ms 漂移容差、1500ms 回退抑制。
- **主题系统**：`style.css` 三层令牌（`--surface-*-base/opacity` → `color-mix()` → `--bg-*`；再经 `@theme` 映射 Tailwind 语义色）；深浅色 `@custom-variant dark`；主题色（accent）与深浅色**解耦**，支持封面取色/预设/自定义与 `accent-global` vs `accent-scoped` 两种作用域。
- **插件宿主**：`plugins/runtime.ts` 提供 `ctx.*`（player / audio / playlist / lyrics / lyricEffects / theme / windows / storage / net / sqlite / fs / webServer / ui / commands / events / dom…），全部经 `addDisposable` 注册并在停用时统一回收；`capabilities` 清单门控（如 `kugouApi`、`sqlite`、`unrestrictedNetwork`、`webServer`、`kugouVerification`）。
- **`src/shared/player-audio-graph.ts` 全仓零引用** —— 是为 DSP/音效 provider 预留的共享契约，代表一条**尚未接线的未来主线**。

---

## 八、安全与观测现状（v1.2.x 的主旋律）

已落地：
- `will-navigate` **fail-closed** 顶层导航拦截（4 类窗口全覆盖，仅放行 `file:` / `about:` / dev server 同源）；
- 插件 TLS：打包环境**拒绝** `rejectUnauthorized: false`，仅未打包 dev 可用；
- 插件 zip 解压：把「`node-stream-zip` 已默认校验 entry 名」这一**已核实为安全**的性质固化为回归测试（此前审计的 zip-slip P0 经复现判定**不成立**）；
- 原生层含 `\0` 字符串：由「进程崩溃 `0xC0000409`」改为可捕获 JS 错误（统一 `to_cstring()`）；
- `afterPack` 关键资源缺失**改为抛错中止构建**（此前只 WARN，会产出"能装不能播"的绿包）；
- 供应链：14 处 `uses:` 固定到 40 位 commit SHA，由 `tests/ci-supply-chain.test.ts` 持续校验。

只观测不阻断（为 v1.3.0 强制化收集数据）：
- **CSP Report-Only**（`src/shared/cspReportOnly.ts` + 主/渲染观测）：实测真实页面 **0 违规**，阳性对照立刻产生 2 条 → 观测链路有效。**重要结论：此前担心的「154 处 `:style=` + 24 处 `setProperty` 会导致强制 CSP 白屏」经实测不成立**（走 CSSOM，CSP `style-src` 不覆盖 CSSOM）。
- **IPC 通道白名单**（`src/main/ipc/permissions.ts`）：64 通道规则表，落盘 `<logs>/ipc-permission-violations.log`，默认永不拒绝（`IPC_PERMISSION_STRICT` 才拒绝）。观测结论即上文第二节的结构性障碍。

**明确搁置的高价值项**（各有"重启条件"，不是遗忘）：
| 项 | 原因 |
|---|---|
| `IMP-11` 凭据加密 | `kv.ts:19` 明文 JSON；`safeStorage` 只在代理密码用；合规降级需新增 IPC + 设置页 UI + 产品决策 |
| `IMP-01` IPC 白名单强制化 | 需先把 mini 播放器拆成独立入口，并迁移渲染层 22 处裸 `ipcRenderer` 调用 |
| `IMP-03` 插件包 checksum | 无法联网核实索引覆盖率，强制必填会让整个插件源装不上 |
| `IMP-05` `webSecurity:false` | 产品级取舍，收敛需先确认跨域加载的真实依赖清单 |
| `IMP-10` 代码签名/公证 | 外部采购条件 |
| `pinia 3→4` / `vite-plugin-electron 0.x→1.x` / `cpal 0.15→0.18` / `mpris-server 0.9→0.10` | 主版本或 0.x 跨 minor，且落在无真机验证条件的链路上 |
| `destroy()` 的 `0xC0000005` | 本机 CPU（i5-3230M，Ivy Bridge，无 AVX2）无法复现；已排除「升 napi 能修」这条解释（napi 3.12.7 已有 unload-safety 防护）；剩余嫌疑点定位到 `lib.rs:125-161` 的销毁顺序 |

---

## 九、构建、CI 与发布

**构建资产**
- `build/afterPack.js`：校验/兜底 4 个 `.node` + `resources/mpv` 的 libmpv + `resources/server/module/*.js`，缺失即抛错；
- `build/installer.nsh`：NSIS 装前 `taskkill` 清残留、重建快捷方式并附 `--no-sandbox --no-stdio-init`；
- `build/tools/gen-icons.mjs`：零依赖图标打包器（手写 PNG/ICO/ICNS 编码）；
- `build/mpv/`：libmpv 运行时（Windows 已内置 ~120MB `libmpv-2.dll`；macOS/Linux 由 CI 下载）。缺 libmpv 时应用仍能启动，只是 `MpvController.available = false`。

**CI（`.github/workflows/`）**
- `build.yml`：6 条腿（macos-14 arm64 / macos-15-intel x64 / ubuntu-22.04 x64+arm64 / windows x64+arm64），`fail-fast: false`，timeout 90min。步骤顺序值得注意：pnpm+Node20 → Linux 构建依赖 → 4 个 addon 依次 `napi build` → server 依赖 → **`pnpm test`**（必须在 addon 与 libmpv 就位之后，否则真实引擎断言会静默跳过）→ **`pnpm lint`** → electron-builder → 产物校验 → upload-artifact@v7；`release` job 仅 tag 触发，download-artifact@**v8**（与 v7 同线的连带修复）、从 CHANGELOG 按 `## [X.Y.Z]` 抽取正文。
- `issue-ai-labeler.yml` / `issue-closer.yml`：Gemini 判合规 + 每日自动关闭 `invalid`。
- `concurrency: cancel-in-progress: true` 的坑：同一 ref 的新 dispatch 会取消正在跑的 run。

**发布 SOP（`docs/release-process.md`）三条纪律**：本地五项全量验证 → 三平台 CI 全绿才打 tag（涉及 Windows 腿时连续 ≥3 次）→ 打 tag 后**手工** `gh release edit` 修正标题（因为 `release` job 受 tag 守卫、无法干跑验证）。

---

## 十、文档与治理体系（本项目最鲜明的特征）

这不是一个"随手写的玩具项目"。它的**工程治理强度显著高于同体量个人项目**：

- **CHANGELOG.md 是核心资产**：每个版本段落结构固定（修复 → 新增 → 变更 → 说明），且**逐条给出证据**——命令、退出码、用例数、前后对比（如"用例总数 113 → 131"、"lint 101 errors → 0 error/0 warning"、"语义 AST 摘要比对：纯空白 7 + 完全相同 36 + 语义不同 0"）。
- **审计发现的处理范式固定**：`N-xx` / `IMP-xx` 编号 + 「原因 + **重启条件**」。判定不成立的要**给出反证**（如 N-04 的 4 处 `unwrap` 紧跟显式长度检查、N-05 的 3 处 `fetch` 均已带 signal）。
- **测试即守卫**（20 个文件，131 例）：不只测功能，还把**审计结论、安全性质、文档一致性**固化为断言——主题令牌一致性、图片 `alt`、CSP 红线、IPC 通道契约、CI 供应链 SHA、插件解压逃逸。
- `docs/agent/`：基线复核 / 构建体检 / echo 品牌清理 / 音频引擎调研（结论：**维持 libmpv，仅移植上游 EQ 级联前级补偿**，自研替换约 3–5 人月）/ 运行日志。
- `dev-notes/`（gitignore）：`history.md` 等项目过程留痕，明确不入交付树。

---

## 十一、风险与建议（按优先级）

| 优先级 | 事项 | 说明 |
|---|---|---|
| 高 | **巨型文件拆分** | `plugins.ts` 3362 行、`runtime.ts` 2902 行、`listenTogether.ts` 2655 行。当前**无任何回归测试覆盖这几处主流程**，是"改一处怕三处"的根源。建议先给这 3 个文件补契约测试，再拆。 |
| 高 | **凭据明文落盘（IMP-11）** | 唯一一条"当前版本仍在以明文存放用户 token"的安全项。需要一次产品决策（Linux 无 keyring 时给用户看什么），建议单独立项。 |
| 中 | **IPC 白名单强制化前置条件** | 「mini 播放器与主窗口同 bundle」不解决，白名单永远只能观测。建议把 mini 拆成独立 HTML 入口——这同时也是性能收益（mini 不需要加载全部主 bundle）。 |
| 中 | **`player-audio-graph.ts` 未接线** | 已有完整 DSP provider 契约却零引用。若近期不推进音效插件，建议在文件头标注"未接线"以免误读。 |
| 中 | **README 存在轻微失真** | Electron 版本写 43.1.1（实际 43.7.3）；`server/` 是 submodule 而非普通目录，README 未点明 `git submodule update --init --recursive` 后仍需 `cd server && npm install` 的原因（其 `package-lock.json` 不存在，只能用 `npm install --legacy-peer-deps`）。 |
| 低 | **依赖升级积压** | 6 项被有意搁置，其中 `pinia 3→4` 风险最高（持久化是全部 store 的底座）。建议在有任何 GUI 验证条件时优先处理。 |
| 低 | **`index.html` 引用不存在的 `/vite.svg`** | Vite 模板遗留，仓库无 `public/`。一行即可清掉。 |

---

## 十二、一句话总结

YanMusic 是一个**以 libmpv 为唯一播放内核、以酷狗协议为唯一音源、以 Rust 原生模块补齐系统集成**的 Electron 桌面应用；其真正的护城河不在功能列表，而在**被 CHANGELOG 逐条留痕的工程纪律**——每个决策都写了证据、每个未修项都写了重启条件、每一条安全结论都配了守卫测试。当前的技术债集中在三个巨型文件（无测试覆盖）与一条明文凭据路径上。
