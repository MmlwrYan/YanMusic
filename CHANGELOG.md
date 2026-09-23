> ⚠️ 本软件完全免费且开源，请勿通过任何付费渠道下载。
>
> 🤡 如果你是付费获取的，说明你被骗了。

## [1.2.0]

> 本次为**安全审计复核 + 原生层健壮性修复 + 新功能**版本：按「先复现、再修复」的纪律对上一轮审计的 P0/P1 结论逐条复核，**其中一条 P0 结论经复现后被判定不成立并已更正**；修复了两个可复现的原生层/构建链缺陷；把单元测试接入 CI；并交付**新功能「听歌档案」的完整版**（本地时间轴 / 年度回顾 / 时段与情绪聚类 / 导出分享）。

### 新功能

- **听歌档案（本地听歌时间轴）**：把每次播放记成本地事件，按日/周/时段聚合，提供年度回顾与图片/文本导出。全部数据只存本机（KV 键 `pinia:musicJournal`），**不上传、不依赖登录**。完整版按 5 个子批次交付：
  - **子批次 1（事件采集与近似基线）**：新增 `src/shared/musicJournal.ts`（纯逻辑）与 `src/renderer/stores/musicJournal.ts`（Pinia store，`persist: true` 复用既有 `sqlitePersist`），在播放器「本地历史记录一次」的同一时机采集事件（`src/renderer/stores/player/playback.ts`）。由于 `yan-storage` 的 `play_history` 是**一曲一行**（`native/yan-storage/src/lib.rs:1366-1376` 的 `ON CONFLICT(song_key) DO UPDATE`），升级前的播放无法还原逐次时刻，故以「每曲一条、时间取最后一次播放、次数记 `baselinePlayCount`」的**近似基线**补齐，并以 `synthetic: true` 显式标记——**不把一个总次数摊开成多个伪造时间点**。
  - **子批次 2（聚合引擎）**：`buildDailyTimeline` / `buildWeeklySummary` / `clusterByTimeOfDay` / `buildYearReview`，全部接受显式 `timeZoneOffsetMinutes`（UTC 以东分钟数），保证跨时区可复现；榜单并列时按**码位序**而非 `localeCompare`（后者依赖运行环境 locale，会让结果不可复现）。
  - **子批次 3（情绪标签）**：`MOOD_PRESETS` / `normalizeMoodText` / `applyEventMood` / `summarizeMoods`。**不做情绪自动推断**——项目内不存在任何音频情绪分析能力，情绪维度只接受用户手动标注；时段维度由子批次 2 提供。
  - **子批次 4（视图与视图模型）**：新增 `src/renderer/views/MusicJournal.vue` 与路由 `/main/journal`、侧边栏入口；视图只渲染 `buildJournalView()` 的产物，聚合逻辑全部在被单测覆盖的纯逻辑层；图表用 CSS 自绘，**未引入任何图表库**。
  - **子批次 5（导出/分享）**：`buildJournalShareText()` 生成纯文本摘要；图片导出复用既有 `share:capture-rect-to-clipboard`、文本复用既有 `share:copy`，**未新增任何 IPC 通道**（已由测试守卫断言）。

### 修复

- **原生层字符串含内部 NUL 时整个进程崩溃**：`native/yan-mpv-player/src/player.rs` 的 `set_property_string()` 等方法使用 `CString::new(..).unwrap()`，当传入的字符串含 `\0` 时 `CString::new` 返回 `Err`，`unwrap` 触发 panic。实测（`node scripts/repro-native-nul-panic.cjs`）该 panic **逃逸 napi 边界**，进程以 `0xC0000409` 退出，JS 侧收不到任何异常——即渲染层或媒体元数据里出现一个 `\0` 就能让主进程直接崩溃。现改为统一的 `to_cstring()` 辅助函数：非法输入返回可上报的错误而非 panic（13 处 `unwrap` 全部替换）。
- **打包产物缺少关键资源时构建仍然「成功」**：`build/afterPack.js` 原先对「缺原生模块 / 缺 libmpv / 缺 server 模块」只打印 `WARN`，函数不抛错，于是会产出「能安装但无法播放」的包且构建状态为绿。现改为收集全部关键缺失项后显式抛错中止构建；图标等非关键项仍只告警。

### 新增

- `tests/plugin-package-extraction.test.ts`：插件安装包解压的 zip-slip 回归守卫（8 个逃逸型 entry 名必须被拒绝、正常包必须可解压、应用侧不得关闭 entry 名校验）。
- `tests/music-journal.test.ts`、`tests/music-journal-aggregate.test.ts`、`tests/music-journal-mood.test.ts`、`tests/music-journal-view.test.ts`、`tests/music-journal-share.test.ts`：听歌档案的 33 个纯逻辑用例（含「导出未新增 IPC 通道」的静态守卫）。
- `scripts/repro-native-nul-panic.cjs`、`scripts/repro-zip-slip.cjs`、`scripts/verify-afterpack-guard.cjs`：三个可复现的取证/验证脚本。
- CI 新增 `Run unit tests` 步骤（`pnpm test`），位置在原生模块与 libmpv 就位之后、打包之前——只有在此处运行，`tests/native-engine-options.test.ts` 的「选项真实到达 libmpv」端到端断言才会真正执行而非自动跳过。

### 变更

- **新增对外项（听歌档案）**：新增 KV 持久化键 `pinia:musicJournal`（复用既有 `storage:kv` 通道与 `sqlitePersist` 机制）；新增路由 `/main/journal`（name `journal`）与侧边栏「听歌档案」入口。**未新增 IPC 通道、未新增存储表、未改动任何既有键名或文件格式、未引入任何新依赖**。
- **审计结论更正（重要）**：上一轮审计把「插件包解压存在 zip-slip 路径穿越」列为 P0。经复现，该结论**不成立**：所用 `node-stream-zip@1.16.0` 在读取中央目录时默认调用 `ZipEntry.validateName()`（`node_stream_zip.js:900-904`），其正则 `/\\|^\w+:|^\/|(^|\/)\.\.(\/|$)/` 会拒绝反斜杠、盘符前缀、绝对路径与 `..` 段；应用未设置 `skipEntryNameValidation`，防护处于生效状态。8 个逃逸变体实测全部被 `Malicious entry` 拒绝，仅 `....//` 与 `%2e%2e/` 被接受，而它们是**普通文件名**（不构成逃逸）。本版不修改解压逻辑，改为把这一「已核实为安全」的性质固化为回归测试。
- **构建行为变更**：`afterPack` 现在会在关键资源缺失时让构建失败。此前「缺资源也能出包」的构建结果将不再出现——这是本次修复的目的，但会改变 CI 的失败面。
- **错误语义变更**：向播放引擎下发含 `\0` 的字符串，行为由「进程崩溃」变为「抛出可捕获的 JS 错误」。合法输入的行为完全不变（已由 `tests/native-engine-options.test.ts` 的真实引擎回读用例覆盖）。

### 说明

- 验证结果：`pnpm test` **66/66 通过**（原 30 个用例无回归 + zip-slip 守卫 3 例 + 听歌档案 33 例）；`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0（`dist/` 产出 243 个文件，含 `MusicJournal` 独立懒加载 chunk）；`cargo check --manifest-path native/yan-mpv-player/Cargo.toml --release` 退出码 0，addon 已重编译。
- **听歌档案的数据可用性说明（重要，不夸大）**：逐次播放事件**从本版起才开始精确采集**。升级前的播放只能以「近似基线」呈现（每曲一条、时间取最后一次播放、次数按历史累计），因此**首次打开档案时的时间轴分布是近似的**，随时间推移会逐步被精确事件取代。含近似数据的日子在视图中以虚线柱与文字说明标识。
- `scripts/verify-afterpack-guard.cjs` 采用对照实验取证：HEAD 版本的 `afterPack` 在缺少全部关键资源时**不抛错**（复现原缺陷），修复后同一场景抛错并列出 6 项缺失、资源齐备时不误报。
- **本次未修复的审计项（已知问题，计划在后续版本处理）**：
  - **IPC 通道无白名单且不校验发送方**：`src/preload/index.ts:283-296` 向渲染层暴露通用 `ipcRenderer.send/invoke/on/off`，`src/main/ipc/registry.ts:26,79` 不校验 `event.senderFrame`。未修复原因：收紧该出口需要先确定 4 类窗口（主窗口 / 桌面歌词 / mini 播放器 / 插件窗口）各自的合法通道集合，并迁移渲染层 22 处裸 `ipcRenderer` 调用点；其中插件窗口的合法通道集涉及**尚未审计**的插件宿主模块，按纪律不得盲改。临时缓解：无。计划修复版本：1.1.4。
  - **插件包完整性校验为可选**：`src/main/plugins.ts:1819` 仅在市场索引提供 `checksum` 时才校验。未修复原因：把 `checksum` 改为必填会使当前未提供该字段的插件源**无法安装任何插件**，属生态级行为变更，且本环境无网络无法核实真实索引是否已提供该字段，需人工决策。临时缓解：无。计划修复版本：待定。
  - **`webSecurity: false` / `allowRunningInsecureContent: true` / Windows `no-sandbox`**（`src/main/window.ts:400,401`、`src/main/index.ts:22`）：关闭原因与业务耦合（注释自述「禁用 CORS 限制」），收敛属产品级取舍，需人工决策。临时缓解：无。
  - **仓库 lint 基线为红**：`pnpm exec eslint . --ext .vue,.js,.ts,.jsx,.tsx` 在 `HEAD` 上即有 **214 errors / 5 warnings**（集中在 `tests/native-engine-options.test.ts` 134 项、`tests/eq-headroom.test.ts` 9 项等），本版**未引入新的 lint 错误**（改动前后总数均为 214/5，新增文件 0 错误），但因此**未把 lint 接入 CI**。计划修复版本：1.1.4。
  - 其余审计项（`IMP-07` 巨型文件拆分、`IMP-09` 构建可复现性、`IMP-10` 代码签名、`IMP-11` 凭据加密落盘、`IMP-12` 导航拦截等）本轮未处理。
  - **跨平台 CI 预验证未执行**：本环境无法访问 GitHub（`git ls-remote` 报 SSL 证书校验失败）且无发布凭据，Phase 4（三平台 `workflow_dispatch` 预验证）与 tag 触发发布均未执行，需人工在有网络的环境完成。
  - **IPC 通道无白名单且不校验发送方**：`src/preload/index.ts:283-296` 向渲染层暴露通用 `ipcRenderer.send/invoke/on/off`，`src/main/ipc/registry.ts:26,79` 不校验 `event.senderFrame`。未修复原因：收紧该出口需要先确定 4 类窗口（主窗口 / 桌面歌词 / mini 播放器 / 插件窗口）各自的合法通道集合，并迁移渲染层 22 处裸 `ipcRenderer` 调用点；其中插件窗口的合法通道集涉及**尚未审计**的插件宿主模块，按纪律不得盲改。临时缓解：无。计划修复版本：1.1.4。
  - **插件包完整性校验为可选**：`src/main/plugins.ts:1819` 仅在市场索引提供 `checksum` 时才校验。未修复原因：把 `checksum` 改为必填会使当前未提供该字段的插件源**无法安装任何插件**，属生态级行为变更，且本环境无网络无法核实真实索引是否已提供该字段，需人工决策。临时缓解：无。计划修复版本：待定。
  - **`webSecurity: false` / `allowRunningInsecureContent: true` / Windows `no-sandbox`**（`src/main/window.ts:400,401`、`src/main/index.ts:22`）：关闭原因与业务耦合（注释自述「禁用 CORS 限制」），收敛属产品级取舍，需人工决策。临时缓解：无。
  - **仓库 lint 基线为红**：`pnpm exec eslint . --ext .vue,.js,.ts,.jsx,.tsx` 在 `HEAD` 上即有 **214 errors / 5 warnings**（集中在 `tests/native-engine-options.test.ts` 134 项、`tests/eq-headroom.test.ts` 9 项等），本版**未引入新的 lint 错误**（改动前后总数均为 214/5，新增文件 0 错误），但因此**未把 lint 接入 CI**。计划修复版本：1.1.4。
  - 其余审计项（`IMP-07` 巨型文件拆分、`IMP-09` 构建可复现性、`IMP-10` 代码签名、`IMP-11` 凭据加密落盘、`IMP-12` 导航拦截等）本轮未处理。

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
- 新增 `tests/`（`node --test`，30 个用例）与 `pnpm test` 脚本：
  - **数学验证**：EQ 级联补偿量在对数网格与 20 万点高精度参考网格上的偏差 < 0.1 dB；闭式幅度响应与脉冲响应 DFT 一致（相对误差 < 1e-3）；补偿后级联峰值不超过 0 dB。
  - **回归测试**：断言「从 `pinia:setting` 形状的持久化对象中能读到用户设置」（即本次修复的键错配）、默认值与接线前硬编码值逐项一致、越界夹取与非法值回落。
  - **真实引擎回读验证**：把选项下发给 libmpv 后读回 mpv 属性核对（12 个选项），并验证默认值与接线前的硬编码行为一致。缺少原生模块或 libmpv 时该组用例自动跳过。
- 新增 `scripts/verify-r2-audio-options.cjs`（真实 `yan-storage.node` 读 `pinia:setting` → 归一化 → 真实 libmpv 回读 → 逐项 PASS/MISMATCH 判定）与 `scripts/verify-legacy-migration.cjs`（隔离 userData 的迁移端到端验证，支持 legacy / custom / fresh 三档）。

### 变更

- 为**保持既有行为不变**，对四个字段做了一次性存量设置对齐：`demuxerReadaheadSecs` 1→30、`cache` `auto`→`yes`、`cachePauseWaitSecs` 1→5、`audioChannels` `auto-safe`→`stereo`（这四个值就是接线前代码硬编码到 mpv 的值）。
  为什么需要迁移而不只是改默认值：渲染层会把整个 store 状态（含默认值）一起持久化，因此**存量用户的设置库里保存的就是这四个旧默认值**；只改默认值对他们无效，接线生效后他们的缓冲时长、缓存模式与输出声道会静默变化。迁移只改动「仍等于旧默认值」的字段，用户显式改过的值一律不动（已由单元测试覆盖）。
  **结论：未改过这四项的用户，升级后听感与缓冲行为与 1.1.1 完全一致；改过的用户，其设置现在会真正生效。**
- 这些选项在**播放引擎启动时**一次性下发（与上游 EchoMusic 的 `start()` 语义相同），修改后需重启应用生效。
- 上述存量设置对齐**在主进程、播放引擎 `initialize()` 之前完成并落盘**（`src/main/mpv/audioOptions.ts` 的 `readNativeAudioOptions()`）。原因：`app.ts` 是 `await Promise.all([initApiServer(), initMpvPlayer()])` → `await createWindow()`，引擎在窗口存在之前就已初始化完毕，只靠渲染层迁移会让升级后的**第一次**启动仍用旧默认值。渲染层的 `ensureNativeAudioOptionDefaults()` 保留为幂等的安全网。
- **`audio-format` 的 `auto` 不再作为字面量下发给 mpv**：`auto` 不是 mpv `--audio-format` 的合法取值（`options/m_option.c` 的 `parse_afmt()` 只接受 `af_fmt_to_str()` 产出的具体采样格式名，其余返回 `M_OPT_INVALID`），而 `print_afmt()` 把「未设置」的内部值 `0` 打印成 `no`。原先写入被 `set_option`（忽略返回值）静默吞掉；现在 `auto` 由「不下发该选项」表达，语义与 mpv 默认完全一致，用户可感知行为不变。
- `tsconfig.json` 打开 `allowImportingTsExtensions` 并把 `tests/**/*.ts` 纳入类型检查（`node --test` 直接运行 `.ts` 依赖该扩展名导入）。

### 说明

- 验证结果：`node --test tests/*.test.ts` **30/30 通过**（tests 30 / pass 30 / fail 0 / skipped 0）；`vue-tsc --noEmit` exit 0 且无输出；`vite build` exit 0；4 个原生 addon 全部重新编译 exit 0。
- 端到端实测（读取应用真实设置库 → 归一化 → 下发给 libmpv → 回读 mpv 属性）：**12 项逐项一致，0 项 MISMATCH**。其中 `audio-format` 的期望值按下面的语义修正：`auto` 时 mpv 回读为 `no`，这是 `option-info/audio-format` 自报的 `default-value`，即「该选项未设置」的默认值，而不是 `auto` 的别名（详见 `docs/agent/05-fix-1.1.2.md` §3）。
- 存量设置迁移端到端验证（隔离 userData）：预置旧默认值 → 启动应用 → 迁移落盘，`nativeAudioOptionsMigrationDone` 为 `true`，四项对齐到 `30 / yes / 5 / stereo`；用户显式改过的值保持不变；迁移后的引擎配置与新装用户**逐项相同**。
- **R2（4 项音频缓冲/缓存读取路径）已按范式修复，待人工验证**：验证命令见 `docs/agent/05-fix-1.1.2.md` §1.3。

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