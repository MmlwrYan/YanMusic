# YanMusic 项目全览与开发历程

> 本文档为 YanMusic 的项目档案：完整介绍项目定位、全部特性与功能、技术架构与特色、以及从上游二次开发到独立版本的开发历程。
> 信息来源：README.md、CHANGELOG.md、package.json、docs/agent/ 及仓库实际代码结构。

\---

## 一、项目简介

**YanMusic** 是一个专为桌面端打造的简约、精致、功能强大的**第三方音乐播放器**，基于公开 API 接口开发，仅供个人学习与技术研究使用。

* **仓库**：https://github.com/MmlwrYan/YanMusic
* **当前版本**：1.1.2
* **开源协议**：GPL-3.0（2026-09 由 MIT 调整为 GPL-3.0）
* **作者**：Yan（a18821657632@outlook.com）
* **平台**：macOS / Windows / Linux 全平台支持
* **灵感来源**：KuGouMusicApi（酷狗 NodeJS API）、SPlayer（简约播放器）、MoeKoeMusic（酷狗第三方客户端）、EchoMusic。

核心设计原则：

* **极致美学**：适配桌面端布局，深浅色模式 + 主题色自定义，兼顾信息密度与沉浸体验。
* **数据安全**：官方服务器直连，数据不经过第三方服务器。
* **持续免费开源**：完全免费，禁止任何付费渠道分发。

\---

## 二、完整特性与功能清单

### 2.1 内容与发现

* **音乐推荐**：歌曲、歌单、歌手、专辑、排行榜全维度推荐。
* **多维搜索**：歌曲、歌手、专辑、歌单、歌词、MV 全方位搜索。
* **外部歌单导入**：网易云、QQ 音乐、酷我、酷狗、汽水、Spotify、Apple Music 及纯文本歌单导入。
* **私人 FM**：智能个性化电台推荐。
* **一起听**：分享解析闭环、侧边栏入口与房间状态同步。
* **歌曲详情**：歌曲档案与播放详情查看。
* **歌曲评论**：评论浏览与楼层跳转。
* **已购音乐、云盘上传、截图导入、黑名单管理**等完整账号功能。

### 2.2 播放能力

* 播放队列管理、播放模式切换、音量调节、进度拖动、倍速播放、淡入淡出切歌。
* **音乐云盘**：本地音频与跨平台文件导入，同步至云端。
* **听歌识曲**：麦克风与系统音频捕获，识别正在播放的歌曲。
* **分享**：歌曲、歌单、专辑、歌手、插件一键分享（含自定义 `yanmusic://` 协议）。

### 2.3 歌词体系

* LRC / YRC 逐字歌词解析。
* 歌词选择、歌词翻译、正则过滤、滚动同步。
* 全屏歌词、写真模式、桌面歌词。
* 插件可通过 `ctx.lyricEffects.register()` 扩展页面歌词/桌面歌词动效。

### 2.4 音质与音效（核心特色）

**音质档位**：DSD 臻品、Hi-Res、SQ (flac)、HQ (320)、标准 (128)。

**音效模式**：人声、伴奏、钢琴、骨笛、尤克里里、唢呐、DJ、蝰蛇母带、蝰蛇全景声、蝰蛇超清。

**高级音频处理**：

* **10 段参数化 EQ**：60 / 170 / 310 / 600 / 1k / 3k / 6k / 12k / 14k / 16k Hz，支持流行、摇滚、古典、电子等预设；多段提升时自动做级联频响峰值前级补偿，消除削顶。
* **空间音效**：FFT-based 卷积混响、IR 预处理与归一化、Dry/Wet 混合控制；内置音乐厅、教堂、录音室、剧院等混响空间。
* **音量均衡**：基于 LUFS 响度标准化。
* **统一滤镜链管理**：智能协调 EQ、混响、音量均衡，避免冲突。
* **实时频谱分析**：从播放引擎直接提取音频数据，FFT 实时频谱帧供插件 `ctx.audio.spectrum` 使用，低延迟高精度。
* **音频设备**：输出设备切换、独占模式输出。

### 2.5 系统级集成

* **系统媒体控制**：macOS MPNowPlayingInfoCenter、Windows SMTC、Linux MPRIS 原生集成，支持媒体按键与进度同步。
* 窗口控制、系统托盘、托盘快捷控制、全局快捷键、开机自启动、启动最小化、mini 模式。
* **自动更新**：内置更新检测与下载，支持静默更新。

### 2.6 插件系统（核心特色）

* 在线插件源浏览/下载/安装/更新，本地插件加载，插件分享解析。
* 扩展点：自定义页面、侧边栏入口、设置项、播放器按钮、歌曲右键菜单、播放事件监听、音源解析、歌词解析、音频频谱、插件浮窗。
* **本地 Web 服务**：插件声明 `capabilities.webServer` 后可监听 127.0.0.1 提供 HTTP 服务（如供 Wallpaper Engine 使用），停用/卸载/安全模式/退出自动释放端口。
* **酷狗验证联动**：`capabilities.kugouVerification` + `ctx.kugouVerification.request()` 复用主程序安全验证弹窗。
* 插件 API 提供 `Yan\*` 类型别名与全局 `$yanmusic`；旧 `Echo\*` / `$echo` 名保留为 `@deprecated` 兼容别名，既有插件零改动。

### 2.7 其他

* 设置、播放历史、收藏、播放状态的本地持久化（自研 SQLite 持久化插件 + `yan-storage` 原生模块）。
* 设置项备份与恢复。
* 骨架屏、对话框栈、日期选择器、进度繁忙浮层等界面组件。
* 完善的 GitHub Actions CI，多平台自动构建与 Release 发布。

\---

## 三、技术架构

|层|技术|
|-|-|
|桌面壳|Electron 43.1.1|
|前端|Vue 3.5 + TypeScript 5.9|
|构建|Vite 8 + electron-builder 26.8|
|状态管理|Pinia + 自研 SQLite 持久化插件（`src/renderer/stores/sqlitePersist.ts`）|
|UI|Reka UI + Tailwind CSS v4.3|
|路由|Vue Router|
|后端服务|Node.js（内置本地服务 `server/`，进程内调用）|
|音频引擎|libmpv（Rust NAPI addon 进程内嵌入，零延迟函数调用）|
|原生扩展|napi-rs (Rust)|
|包管理|pnpm（monorepo 结构）|

### 四个 Rust 原生模块（native/）

1. **yan-mpv-player** — libmpv 播放引擎封装：淡入淡出、EQ、音量均衡、空间音效（IR 卷积）、播放卡死看门狗。
2. **yan-media-controls** — 系统媒体控制（macOS/Windows/Linux 原生 API）。
3. **yan-storage** — SQLite 本地持久化（设置、播放队列、状态快照）。
4. **yan-spectrum-capture** — 系统音频捕获与实时频谱（Windows WASAPI loopback / Linux ALSA monitor / macOS ScreenCaptureKit）。

### 跨平台工程细节

* **Linux libmpv/FFmpeg 符号冲突处理**：`src/main/mpv/linuxEnv.ts` 在启动最早期检测系统 libmpv，用 `ldd` 解析其 `libav\*` 依赖并以 `LD\_PRELOAD` + `app.relaunch()` 拉起进程（环境变量防无限重启，兼容 AppImage）。
* **打包校验**：`build/afterPack.js` 在 electron-builder afterPack 阶段校验原生模块与 libmpv 动态库就位。
* **macOS x64 构建**：在原生 Intel runner（`macos-15-intel`）上构建，附 Rosetta 2 预检与完整诊断。
* **产物**：macOS dmg/zip、Windows NSIS exe（x64/arm64）、Linux deb/rpm/AppImage/pacman/tar.gz。

\---

## 四、开发历程

### 阶段 0：起源

### v1.1.0（2026-09-13）—— 独立首发版

> 确立独立版本号策略：YanMusic 使用独立版本号，不与上游对齐。

**新增**：

* 一起听：分享解析闭环、侧边栏入口、房间状态同步。
* 已购音乐、云盘上传、截图导入、黑名单管理等功能补齐。
* 插件体系：插件市场（浏览/下载/安装/更新）、插件源管理、插件分享解析。
* 插件宿主能力：窗口拖拽/缩放、网络请求、音频元数据读取等 guest 侧 API。
* 设置备份与恢复界面；骨架屏、对话框栈、日期选择器、进度繁忙浮层等组件。

**变更**：

* 开源协议由 MIT 调整为 **GPL-3.0**，安装包随附 LICENSE 与 LGPL-2.1.txt。
* 应用图标全套重建（三平台含托盘），文案标识统一为 YanMusic。
* 插件市场外部引用对齐上游，保证市场可正常浏览下载。
* 免责声明补充上游参考版本与修改差异说明。
* 仓库交付树整理：开发过程文档移出交付树，不入库、不打进安装包。

**修复**：

* CI 产物命名与实际产物不一致导致上传失败。
* `server` 子模块未纳入版本索引导致内置 API 模块缺失。
* macOS x64 构建失败：放弃被 Homebrew 官方封死的"arm64 runner 装 x86\_64 Homebrew"方案，改在原生 Intel runner 构建，并去除静默吞错（`|| true`）。
* 免责声明中对已移出文档的悬空引用改为指向 CHANGELOG 与发行说明。
* macOS 更新元数据 latest-mac.yml 仅由 arm64 任务产出，避免同名覆盖。

### v1.1.1 —— 「独立化 + 体检 + 调研」版

> 修复清理中暴露的三处真实缺陷，校准文档一致性，产出音频引擎调研报告。\*\*未改动播放内核与业务逻辑。\*\*

**变更**：

* 内部标识符品牌化清理：Electron session 分区、传输标记头、自定义事件、DOM `data-\*` 属性、内部类型变量统一为 `yanmusic-\*` / `yan-\*` 前缀。
* 插件 API 新增 `Yan\*` 别名（`YanPluginManifest` / `YanPluginContext` / `$yanmusic` 等），旧 `Echo\*` / `$echo` 保留为 `@deprecated` 同构别名，既有插件零改动。
* 文档校准：Electron 版本、持久化方案（自研 SQLite 插件而非 pinia-plugin-persistedstate）、EQ 实为 10 段、补入第 4 个原生模块 `yan-spectrum-capture`。

**修复**（品牌清理暴露的真 bug）：

* 插件毛玻璃 surface 透明度失效：JS 写入 `yan-surface-translucent`，样式表仍是 `body.echo-surface-translucent`（44 条选择器）。
* Popover 基础样式失效：同样的类名错配（`yan-popover-content` vs `.echo-popover-content`）。
* 插件滚动容器 role 过滤失效：`runtime.ts` 读 `data-echo-scroll-role` 而模板写 `data-yan-scroll-role`。
* 桌面歌词 `data-echo-lyric-\*` 与全仓 `data-yan-lyric-\*` 约定对齐；更正三处文档死引用。

**文档与调研**：

* 新增 `docs/agent/`：基线复核、构建体检、echo 标记清理、自研音频引擎调研。
* 引擎调研结论：**维持 libmpv，仅移植上游特定设计**（首选 EQ 级联前级补偿）；完全自研替换约需 3–5 人月，且 VPF 音效依赖外部 DSP Provider。

### v1.1.2 —— 播放设置生效性修复版

> 此前「播放器设置」分区的音频/缓存调优项\*\*实际从未下发到播放引擎\*\*，EQ 多段提升时会削顶。本版一并修复并补上自动化测试。

**修复**：

* **键错配**：主进程以裸 KV 键读取（`storage.get('audioCacheSecs')`），而渲染层持久化在 `pinia:setting` 整对象里，读取恒为 null → 网络缓存时长、前向/后向缓存上限、音频输出缓冲四项改动从不生效。现统一经 `getPersistedRendererSettings()` 读取。
* **8 个 mpv 调优项零消费方**：`demuxerReadaheadSecs` / `cache` / `cachePause` / `cachePauseWaitSecs` / `audioSamplerate` / `audioChannels` / `audioFormat` / `gaplessAudio` 在设置页可调但代码零引用，现已在引擎启动时下发到 mpv 原生选项（枚举值白名单归一化，非法值回落默认）。
* **EQ 削顶**：多段提升时相邻频带频响叠加超过 0 dB，在滤镜链内部削顶（FFmpeg `af\_biquads.c` 削顶告警）。新增基于级联频响峰值的前级补偿：按 FFmpeg `equalizer`（peaking，Q=1）公式重建各段频响，在 4096 点对数网格上取最大提升量反相作为 `volume` 前级衰减。
* `demuxer-readahead-secs` 此前被错误赋值为网络缓存时长，两个语义不同的选项被同一个值驱动，已分开下发。

**新增**：

* `src/shared/native-audio-options.ts`（默认值与归一化纯逻辑）、`src/main/mpv/audioOptions.ts`、`src/main/mpv/eqHeadroom.ts`。
* `tests/` 自动化测试（`node --test`，30 个用例）与 `pnpm test`：

  * 数学验证：补偿量在 20 万点参考网格上偏差 < 0.1 dB；补偿后级联峰值不超过 0 dB。
  * 回归测试：键错配修复、默认值一致性、越界夹取与非法值回落。
  * 真实引擎回读：12 个选项下发 libmpv 后读回核对（缺原生模块时自动跳过）。
* 验证脚本 `scripts/verify-r2-audio-options.cjs`、`scripts/verify-legacy-migration.cjs`。

**存量迁移**：为保持既有行为，对仍等于旧默认值的四个字段一次性对齐（`1→30`、`auto→yes`、`1→5`、`auto-safe→stereo`，即接线前硬编码值）；用户显式改过的值不动。迁移在主进程、引擎 `initialize()` 之前完成落盘，避免升级后第一次启动仍用旧值。`audio-format: auto` 不再作为字面量下发（mpv 无此取值），语义不变。

**验证结果**：测试 30/30 通过；`vue-tsc --noEmit` 零报错；`vite build` 成功；4 个原生 addon 全部编译通过；端到端 12 项回读 0 MISMATCH。

\---

## 五、项目现状小结

* **品质基线**：TypeScript 严格类型检查零报错、30 项自动化测试、4 个 Rust 原生模块全平台编译、多平台 CI 自动发布。
* **核心差异化**：libmpv 原生引擎 + 专业级音频处理（10 段 EQ / 卷积混响 / LUFS 均衡 / 实时频谱）+ 可扩展插件系统 + 三平台系统级媒体集成。
* **演进方向**：维持 libmpv 引擎并移植上游精选设计（EQ 前级补偿已落地），持续补齐功能与打磨体验。

> 免责：本项目基于公开 API 接口开发，仅供个人学习与技术研究，不存储、不传播任何音频文件；音乐版权归原平台及版权方所有，请支持正版音乐。

