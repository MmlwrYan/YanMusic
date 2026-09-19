> ⚠️ 本软件完全免费且开源，请勿通过任何付费渠道下载。
>
> 🤡 如果你是付费获取的，说明你被骗了。

## [1.1.2]

> 本次为**播放设置生效性修复**版本：此前「播放器设置」分区里的音频/缓存调优项实际从未下发到播放引擎，EQ 在多段提升时会削顶。本版把这两类问题一并修掉，并补上可复现的自动化测试。

### 修复

- **音频/缓存设置此前完全不生效（键错配）**：主进程 `MpvController` 以「裸 KV 键」读取（`storage.get('audioCacheSecs')` 等），而渲染层实际把设置持久化在 `pinia:setting` 这一个整对象里，读取恒为 `null` → 「网络缓存时长上限 / 前向缓存上限 / 后向缓存上限 / 音频输出缓冲」四项始终使用默认值，用户在设置页的改动从不生效。现改为与网络设置同一范式（经 `getPersistedRendererSettings()` 读取）。
- **8 个「mpv 调优」设置项此前没有任何消费方**：`demuxerReadaheadSecs` / `cache` / `cachePause` / `cachePauseWaitSecs` / `audioSamplerate` / `audioChannels` / `audioFormat` / `gaplessAudio` 在设置页可调，但代码中零引用、从未下发给引擎。现已在播放引擎启动时下发到对应的 mpv 原生选项。
- **EQ 削顶**：多段同时提升时，相邻频带的频响会叠加并超过 0 dB，在滤镜链内部削顶（应用日志中反复出现 `filter: Channel N clipping M times. Please reduce gain.`，出自 FFmpeg `af_biquads.c` 的削顶检测）。新增基于**级联频响峰值**的前级补偿：按 FFmpeg `equalizer`（peaking，Q=1）公式重建各段频响，在对数网格（4096 点，10 Hz→Nyquist，并显式包含各频带中心）上取最大提升量，反相作为 `volume=<x>dB` 前级衰减。
- `demuxer-readahead-secs` 此前被赋值为「网络缓存时长」而非其自身设置项，两个语义不同的 mpv 选项被同一个值驱动；现已按各自设置项下发。

### 新增

- `yan-mpv-player` 的 `initialize` 配置新增 8 个字段；原生侧对所有枚举型取值做**白名单归一化**，非法值一律回落到默认值，不会把任意字符串注入 mpv 选项解析器。
- 新增 `src/shared/native-audio-options.ts`（纯逻辑：默认值与归一化）、`src/main/mpv/audioOptions.ts`（读取持久化设置）、`src/main/mpv/eqHeadroom.ts`（EQ 前级补偿计算）。
- 新增 `tests/`（`node --test`，19 个用例）与 `pnpm test` 脚本：
  - **数学验证**：EQ 级联补偿量在对数网格与 20 万点高精度参考网格上的偏差 < 0.1 dB；闭式幅度响应与脉冲响应 DFT 一致（相对误差 < 1e-3）；补偿后级联峰值不超过 0 dB。
  - **回归测试**：断言「从 `pinia:setting` 形状的持久化对象中能读到用户设置」（即本次修复的键错配）、默认值与接线前硬编码值逐项一致、越界夹取与非法值回落。
  - **真实引擎回读验证**：把选项下发给 libmpv 后读回 mpv 属性核对（9 个选项），并验证默认值与接线前的硬编码行为一致。缺少原生模块或 libmpv 时该组用例自动跳过。

### 变更

- 为**保持既有行为不变**，4 个设置项的默认值与接线前的实际硬编码值对齐：`demuxerReadaheadSecs` 1→30、`cache` `auto`→`yes`、`cachePauseWaitSecs` 1→5、`audioChannels` `auto-safe`→`stereo`。**未改过设置的用户，听感与缓冲行为与 1.1.1 完全一致**；改过设置的用户，其设置现在会真正生效。
- 这些选项在**播放引擎启动时**一次性下发（与上游 EchoMusic 的 `start()` 语义相同），修改后需重启应用生效。
- `tsconfig.json` 打开 `allowImportingTsExtensions` 并把 `tests/**/*.ts` 纳入类型检查（`node --test` 直接运行 `.ts` 依赖该扩展名导入）。

### 说明

- 验证结果：`pnpm test` **19/19 通过**；`vue-tsc --noEmit` exit 0；`vite build` exit 0；`yan-mpv-player` 重新编译 exit 0。
- 实测确认 mpv 会把 `audio-format` 的 `auto` 规范化为 `no`（二者同义：不强制输出格式），与接线前「未设置」等价。

## [1.1.1]

> 本次为「独立化 + 体检 + 调研」版本：清理上游品牌残留标识符、修复清理过程中暴露的三处真实缺陷、校准文档与实现的一致性，并产出音频引擎调研报告。**未改动播放内核与业务逻辑。**

### 变更

- **内部标识符品牌化清理**：3 个 Electron session 分区（`echo-app-network` / `echo-kugou-api` / `echo-community-audio`）、传输标记头（`x-echo-transport-request-id`）、自定义事件（`echo:toggle-sidebar`）、DOM `data-*` 属性（`data-echo-lyric-*` / `data-echo-scroll-role`）、内部类型与变量（`EchoPluginWindowContext` / `echoUpdaterSilent` 等）统一为 `yanmusic-*` / `yan-*` 前缀。
- **插件 API 新增 `Yan*` 别名，旧名全部保留**：新增 `YanPluginManifest` / `YanPluginDescriptor` / `YanPluginCompatibility` / `YanPluginContext` / `YanGlobalRuntime` 类型别名与全局属性 `$yanmusic`；旧名 `Echo*` 与 `$echo` 保留为 `@deprecated` 别名（二者同构/同引用），**既有插件、插件开发文档与调用点零改动**；插件清单兼容键 `requires.echoMusicVersion` 继续保留。
- 文档与实现对齐：Electron 版本（43.1.1）、持久化方案（自研 SQLite 持久化插件，非 `pinia-plugin-persistedstate`）、EQ 段数（以代码为准为 **10 段**）、原生模块清单（补入 `yan-spectrum-capture`，实际共 4 个 addon）。

### 修复

- **插件「毛玻璃」surface 透明度特性实际失效**：JS 侧施加的类名是 `yan-surface-translucent`，而 `src/renderer/style.css` 中 44 条选择器仍写 `body.echo-surface-translucent`，导致插件通过 `ctx.theme.surface.*` 提交的透明度与 `backdrop-filter` 全部落空。
- **Popover 基础样式失效**：`Popover.vue` 施加 `yan-popover-content` / `yan-popover-arrow`，样式表仍写 `.echo-popover-content` / `.echo-popover-arrow`。
- **插件滚动容器 role 过滤失效**：`runtime.ts` 读取 `data-echo-scroll-role`，而模板写入的是 `data-yan-scroll-role`，使 `ctx.scroll.query({ role })` 永远匹配不到容器。
- 桌面歌词与页面歌词的 `data-echo-lyric-*` 属性与全仓 `data-yan-lyric-*` 约定不一致，已对齐。
- 更正三处死引用：`native/echo-ffmpeg-player/src/vpf.rs`（该文件在本仓库与上游均不存在，VPF 由外部 DSP Provider 处理）、`ECHOMUSIC_PLUGIN_STATS_API_URL`（代码实际读取 `process.env.yanmusic_PLUGIN_STATS_API_URL`）、README 中两个并不存在的 Linux wrapper 脚本（`build/linux-libmpv-env.sh` / `build/linux-system-electron-wrapper.sh`）。

### 文档

- 新增 `docs/agent/`：基线复核（`00-baseline.md`）、环境搭建与构建体检（`01-build.md`）、echo 标记清理（`02-echo-cleanup.md`）、自研音频引擎调研（`03-engine-research.md`）与运行日志。
- 音频引擎调研结论：**推荐维持 libmpv 引擎，仅移植上游特定设计**（首选 EQ 级联前级补偿，可消除当前 lavfi `equalizer` 的实测削顶告警）；完全自研替换的代价约 3–5 人月，且 VPF 音效需要外部 DSP Provider（上游引擎内并无 `vpf.rs`）。详见 `docs/agent/03-engine-research.md`。

### 说明

- 本次改动后 `vue-tsc --noEmit` 退出码 0（零报错），`vite build` 退出码 0，4 个 Rust 原生模块全部编译成功。
- 按既有裁定继续保留：插件市场索引文件名 `echo-plugins.json`、上游插件源仓库地址与统计 Worker 域名、Cloudflare 已部署资源名，以及应用内 GPL 致谢与修改声明（`src/renderer/constants/legal.ts`）。

## [1.1.0] - 2026-09-13

> 版本号策略：YanMusic 使用独立版本号，不与上游项目版本号对齐。

### 新增

- 一起听：分享解析闭环、侧边栏入口与房间状态同步
- 已购音乐、云盘上传、截图导入、黑名单管理等缺失功能补齐
- 插件体系：插件市场（浏览/下载/安装/更新）、插件源管理、插件分享解析
- 插件宿主能力：窗口拖拽/缩放、网络请求、音频元数据读取等 guest 侧 API
- 设置项备份与恢复界面
- 骨架屏、对话框栈、日期选择器、进度繁忙浮层等界面组件

### 变更

- 开源协议由 MIT 调整为 GNU General Public License v3.0（GPL-3.0），并在安装包内随附 LICENSE 与 LICENSES/LGPL-2.1.txt
- 应用图标全套重建（Windows/macOS/Linux 含托盘图标），文案标识统一为 YanMusic
- 插件市场外部引用对齐上游实际取值，保证插件市场可正常浏览与下载
- 免责声明「致谢」段补充上游参考版本（EchoMusic 2.3.1-beta.24）、原始版权归属与修改差异说明
- 仓库交付树整理：根目录只保留交付/源码必需文件；开发过程文档（移植报告、进度记录、历史变更记录等）移出交付树，仅本地留存，不入库、不入 Release、不打进安装包

### 修复

- CI 产物命名与实际产物不一致导致的构建产物上传失败
- `server` 子模块未纳入版本索引导致的内置 API 模块缺失
- macOS x64（Intel）构建失败：原「在 arm64 runner 上现场安装 x86_64 Homebrew」的方案已被上游政策封死（Homebrew 官方安装器拒绝在 Apple Silicon 上安装 x86_64 版本），且失败被 `|| true` 静默吞掉。现改为在原生 Intel runner（`macos-15-intel`）上构建 x64 产物，保留 Rosetta 2 预检、去除静默吞错、对 Homebrew/mpv 异常输出完整诊断后显式失败
- 免责声明「致谢」段中对已移出交付树的过程文档的悬空引用，改为指向仓库内的 CHANGELOG.md 与发行说明
- macOS 自动更新元数据（latest-mac.yml）由 arm64 任务产出、仅覆盖 arm64（x64 任务不产出该文件，避免同名覆盖；dmg 本身不受影响，属已知限制）