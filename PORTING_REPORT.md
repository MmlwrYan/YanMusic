# YanMusic 向 EchoMusic 2.3.1 移植 — 总报告

生成时间：2026-09-13（通宵连续作业）
目标库：`C:\coding\YanMusic\YanMusic-main`（YanMusic 2.2.8 fork）
参考库：`C:\coding\EchoMusic\EchoMusic-main`（EchoMusic 2.3.1-beta.24）

---

## 0. 三条任务线结论

| 任务 | 结论 | 证据位置 |
|---|---|---|
| 任务 1：补齐缺失内容（A/B/C 分类后全部照搬） | 已完成主体（见 §2 各阶段），剩余缺口见 §6 | §2 |
| 任务 2：保护「领取 VIP」/「升级 VIP」 | 已达成，相关函数/文件字节级未变 | §4 |
| 任务 3：更新检查仓库改为 `MmlwrYan/YanMusic` | 已达成，运行期已实证 | §3.3 |

硬约束遵守：GUI 不暴露来源（无 EchoMusic 品牌、无第三方服务名、无来源标注）。**唯一例外**见 §5.1（GPL 致谢文本，法律要求保留）。

### 0.1 本轮（第二轮）五项任务完成情况

| # | 任务 | 状态 | 证据位置 |
|---|---|---|---|
| 1 | LICENSE → GPL-3.0 | ✅ **已完成**（`LICENSE` 换为 GPL-3.0 原文 674 行、`package.json` 加 `"license": "GPL-3.0"`、README 徽章与协议段同步） | §5.1 |
| 2 | 插件市场外部引用改为**上游实际值** | ✅ 已完成（索引名 / 仓库源 URL / 源 ID / 统计 Worker 域名四项与上游逐字节一致；旧值残留 0；`TODO(source)` 注释已删；新值连通性实测 200） | §5.2、§5.3 |
| 3 | 非 Windows installer | ✅ **路径已确定**：macOS + Linux 均走 CI（本机 Windows 不构建、不搭 WSL）；CI 配置已核实、`icon.icns` 缺口已补齐 → **待推送触发** | §8、§10 |
| 4 | 应用图标改为上游同风格 + 文字 YanMusic | ✅ 已完成（矢量源 + 全套位图，ICO 7 尺寸 / ICNS 10 块；文字像素级判定 `Yan=0.00%` vs `Echo=19.24%`；打包后 exe 与安装包均命中新 ICO 字节；无 Echo 字样残留） | §9 |
| 5 | 运行期联调（一起听等） | ⏸ **由你自行执行**（本轮未做任何点击测试） | §6 |
| 6 | 插件市场 UA 身份验证 | ✅ 已完成：Worker 源码与线上实测**均无 UA 白名单/过滤** → **保留 `YanMusic-Plugin-Marketplace`** | §5.4 |

> 说明：任务 3 的「平台清单不确定」与任务 4 的「无法生成图标」是本轮预先约定的允许停顿点；任务 4 已解除（图标已生成），任务 3 仍待你确认。

---

## 1. 环境与基线

- Electron 43.1.1 + Vue 3.5.38 + TypeScript 5.9.3 + Vite 8.0.14 + Pinia 3.0.4 + Reka UI 2.9.10 + Tailwind v4
- pnpm 10.34.5；node v24.9.0；vue-tsc 3.3.3；electron-builder 26.8.1；rustc/cargo 1.98.1
- 引擎差异：Yan = libmpv（Rust NAPI `native/yan-mpv-player`，10 段 EQ 走 mpv `af`）；Echo = ffmpeg + dspProvider
- 基线 `pnpm exec vue-tsc --noEmit` = exit 0（零报错），最终状态同样 exit 0

## 2. 分阶段交付与验收

### 阶段 0 / 基线修复（提交 `0a69b6b`、`c705a90`、`30a7378`）
- 重建 `src/main/ipc/settings.ts`（原文件 60 处 U+FFFD 损坏）、移植更新/网络/持久化/store 若干模块
- 基线修复 9 个文件（设置常量、setting store 的空间音效实体模型与任务栏字段、preload/electron.d.ts 的 audioEffects API、播放/空间音效设置分区等）
- `.gitignore` 由 UTF-16 重写为 UTF-8（原文件规则全部失效）
- 验收：vue-tsc exit 0；设置常量与 store 字段经 grep 证据核对

### 阶段 A1 UI 组件（提交 `5107f33`）
- 新增 6 个与上游字节级一致的组件：`ui/Skeleton.vue`、`ui/dialogStack.ts`、`ui/DatePicker.vue`(464)、`player/ProgressBusyOverlay.vue`、`music/SongListSkeletonRows.vue`、`music/DetailPageSkeleton.vue`、`views/search/components/SearchResultsSkeleton.vue`
- `DatePicker` 仅改 CSS 前缀 `echo-date-picker`→`yan-date-picker`；新增依赖 `@internationalized/date@3.12.0`
- 验收：vue-tsc exit 0 + `--listFiles`(799 项) + 探针报错证明检查覆盖

### 阶段 A2 工具与组合式函数（提交 `dc552a5`）
- 10 个文件 SHA256 与上游字节级一致：`utils/{sessionId,themedCover,songMatching,lyricFilter,inputBehaviorGuard,routeViewCache}.ts`、`composables/{useWindowResize,useStableLyricIndex,useLyricTimeline,usePlaybackProgressStatus}.ts`
- `shared/playback.ts` +18 行纯类型
- 验收：vue-tsc exit 0 + 探针证明

### 阶段 A3 进度/等级/统计（提交 `a14a7fd`）
- `models/gradeInfo.ts`、`stores/listenReport.ts`（字节级一致）、`stores/player/listeningTime.ts`（2 行映射适配，Yan 无 stateMachine）
- `api/user.ts` +28/-3：新增 `reportListenTime`、`getUserGradeInfo`
- 验收：VIP 红线函数 SHA256 前后一致（claimDayVip `de2e9331…`、upgradeDayVip `0e635ffa…`、getVipMonthRecord `5cfc9e4f…`），行号未变；服务端契约 `server/module/user_grade_info.js` 已核对

### 阶段 A4 任务中心（已落地，报告完整）
- 新增 7 文件：`shared/tasks.ts`(63)、`plugins/taskPanel.ts`(334)、`tasks/{taskBridge,taskBridges,taskControl,updateTaskBridge}.ts`、`stores/importTask.ts`(216)
- 适配仅 id/品牌：`echo:main|update|import` → `yan:*`，文案「更新 EchoMusic」→「更新 YanMusic」
- 接线：`layouts/TitleBar.vue` +175（任务中心入口/红点/面板）、`App.vue` +6（setupTaskBridges/dispose）
- 依赖补齐 +13 行：`icons.ts` +2、`stores/update.ts` +9（cancelDownload）、`preload/index.ts` +1、`electron.d.ts` +1（主进程 `settings.ts:1349` 早已注册 `update:cancel-download`）

### 阶段 B1 任务栏进度与封面预览（已落地，报告完整）
- 新增 `src/main/taskbarProgress.ts`(271)；改 `taskbarThumbnail.ts`(+31/-6)、`nowPlaying.ts`(+51)、`storage/settings.ts`(+6)、`mpv/index.ts`(+5)、`app.ts`(+9)
- 修复两个「死通道」（此前渲染层 send 无主进程 listener）
- 事件适配：订阅 Yan 真实事件 `time-update`/`duration-change`/`state-change`/`mpv:file-loaded`/`playback-end`；无 `seeked`/`playback-restart`，由 mpv `time-pos` 属性观察器等价覆盖；额外加固 `confirmPlayingByAdvance()` 处理 eof 自动续播
- 验收：通道 listener 已注册（grep 证据）；**运行期实证 `[TaskbarProgress] initialized { enabled: true }`**

### 阶段 B 音效市场（已落地，报告完整）
- `api/audioEffect.ts`(293，字节级一致)、`components/player/OnlineAudioEffectCard.vue`、`views/EffectPlaza/{EffectPlaza,EffectPlazaPage}.vue`、`composables/useAudioEffectPlaza.ts`(305)、`utils/{audioEffectSupport,audioEffectIcons}.ts`
- 复用既有 `audio:*` 四通道与 `SpatialAudioEffectEntry`；**无第三方地址**（全部相对端点走自有服务端）
- 引擎适配：删除 dspProvider 依赖；VPF/组合音效判为不可用（libmpv 滤镜链仅消费 IR），不静默降级

### 阶段 A5 主进程/shared（已落地，报告完整）
- diagnostics 整链路：`shared/diagnostics.ts`(46)、`main/diagnostics/memory.ts`(39)、`main/ipc/diagnostics.ts`、`utils/rendererMemoryDiagnostics.ts`(187)、preload 段、类型
- settingsBackup（应用设置+桌面歌词设置的导出/预览/导入，gzip+sha256+10 分钟 token+二次读盘防篡改）、`shared/objectSafety.ts`、`shared/portableNetworkSettings.ts`
- window 增强：win32「仅用户拖拽才落盘」门控、尺寸/位置分开记脏、非 win32 按内容区记忆、`query-session-end`/`session-end` 兜底落盘、before-quit flush、内存埋点、`spellcheck:false`

### 阶段 C1 黑名单 + 一起听（黑名单完整；一起听进行中）
- 黑名单：`api/blacklist.ts`(345)、`stores/contentBlacklist.ts`(364)、`services/contentBlacklistIntegration.ts`(105) 与上游 SHA256 完全一致；`components/profile/ContentBlacklistDialog.vue`(570) 2 处适配（Yan 的 Dialog 无 `flushBody`、CustomTabBar 无 `tabIds`/`panelIds`）
- 服务端已就位（`server/module/blacklist.js` → `/blacklist`、`blacklist_list.js` → `/blacklist/list`），**无需新增 IPC/路由** —— 路由由 `src/main/server.ts:65` 文件名规则推导
- 一起听：`api/listenTogether.ts`(357)、`models/listenTogether.ts`(150)、`utils/listenTogether.ts`(953)、`views/listenTogether/listenTogether.css`(3034) 字节级一致

### 阶段 C2 已购 / 云上传 / 截图导入（已落地，报告完整）
- 已购：`api/purchased.ts`(19，字节级一致)、`views/Purchased.vue`(608)
- 云上传：`api/cloud.ts`(127)、`stores/cloudUpload.ts`(279)、`components/music/CloudUploadDialog.vue`(1170)、`views/Cloud.vue` +159/-2
- 截图导入：`api/importPlaylist.ts`(89，字节级一致)、`composables/useScreenshotImport.ts`(128)、`components/music/ScreenshotImportDialog.vue`(850)
- 服务端接口全部就位（`user_purchased_*`、`user_cloud*`、`import_playlist.js` 含 `submit_img`），**无需新增部署**

## 3. 队长（本人）负责的整合接线

### 3.1 设置页与入口
- 注册缺失的 `player`（播放器设置，order 360）与 `spatialAudio`（音效管理，order 350）分区 —— 此前 Yan 有 6+ 个 mpv 调优字段（`cache`/`cachePause`/`cachePauseWaitSecs`/`demuxerReadaheadSecs`/`audioDemuxerMaxMB`/`audioDemuxerBackMB`/`audioSamplerate`/`audioChannels`/`audioFormat`/`gaplessAudio`）**无任何 UI**
- `AppearanceSettingsSection` 补「任务栏封面预览」「任务栏播放进度条」两个开关（B1 已打通通道，此前无 UI）
- `ShortcutSettingsSection` 补「屏蔽浏览器默认按键行为」开关 + `stores/setting.ts` 新增 `suppressDefaultKeyBehaviors: true`
- `DataSettingsSection` 补「黑名单管理」入口并挂载 `ContentBlacklistDialog`
- 路由：新增 `/main/effect-plaza`（音效广场，含 `SpatialAudioSettingsSection` 内「去音效广场」按钮）、`/main/purchased`（已购音乐）
- `main.ts` 接线：`startRendererMemoryDiagnostics()`、`installInputBehaviorGuard({ isEnabled: () => useSettingStore().suppressDefaultKeyBehaviors })`、`registerContentBlacklistIntegration()`（pinia 激活后）

### 3.1b 第二轮整合（收尾期新增）
- **一起听全链路闭环**：`stores/listenTogether.ts`(2655 行，与上游仅 1 处差异 —— Yan 的 `seek` 为同步 void，改用 `Promise.resolve(seekCommand).then(...)` 保持 `Promise.race` 结构)、`views/listenTogether/index.vue`(**与上游 SHA256 完全一致**)、`api/music.ts` 补 `getAudioMetadata`；路由 `/main/together`（route name 必须是 `listen-together`）；`views/ShareResolve.vue` **已与上游逐字节一致**（补上房间邀请链接落地：`readRoomState`/`resolveListenTogether`/`isMissingListenTogetherRoom` 分派，校验 `room_state===1` 与 `room.id && !room.closed` 后 `router.replace` 到房间页）；`shared/share.ts` 补 `'listen-together'`（type 联合 / `SHARE_TYPE_LABELS` / `isShareResourceType` 守卫三处同步，否则守卫运行期会误判）；`layouts/MainLayout.vue` 的 `excludeFromCache` 加入 `'listen-together'`（分享链接会给路由附加 roomId/roomType，按 fullPath 缓存会保留两个实例、各开一个 Teleport Dialog 造成双层遮挡卡死）；侧边栏「一起听」入口（order 36）
- **播放内核最小适配（一起听所需，全部为「不改变现状」的可选增量）**：`stores/player/types.ts` 加 `PlaybackSourceKind`/`sourceKind?`；`playTrack` 加 4 个可选 `preResolved*` 选项（不传时路径与改动前等价）；`deferredPreResolvedFallback` 一次性回退（含**串歌护栏**：`deferred.trackId !== trackId` 即拒绝，避免上一首遗留任务污染当前曲目）；`state.ts` 加 `currentTimeUpdatedAt`/`autoNextSuppressed` 与 setter（默认即"未启用"）；`playbackDisplayState` 由 `isLoading/lastError/isPlaying` 派生；`playlist/constants.ts` 导出 `LISTEN_TOGETHER_QUEUE_ID='queue:listen-together'`
- **插件能力 6 项**（照搬上游实现方式）：原生网络 API（`plugins:net:request|cancel` + `unrestrictedNetwork` 能力门禁，`network.ts` 253 行逐字节复制；registry 新增 `isExpectedError` 选项）、插件浮窗拖拽/缩放 8 通道（`pluginWindowInteraction.ts` 331 行，与上游 `windowDrag.ts` 一致）、`plugins:fs:read-audio-metadata`（自研零依赖解析器：ID3v1/v2.2-2.4、MPEG/Xing、FLAC、Ogg Vorbis/Opus、MP4/M4A、WAV、AIFF，未知容器降级为 `metadataParsed:false`+`metadataError`，语义同上游）、`expectedPluginId` 透传与 id 一致性校验、`PLUGIN_AUDIO_EXTENSIONS` 17→19（补 `.caf`/`.wave`）、版本门槛旧键回退（缺 `yanmusicVersion` 时兼容读 `echoMusicVersion`）
- **渲染层收尾**：设置备份 UI（「备份设置 / 导入设置」+ 导入确认弹窗；preload `settingsBackup.*` 本已就绪）、插件市场骨架屏（44 行与上游逐字节相同）、`views/DataSettingsSection.vue` 黑名单入口
- **插件访客侧封装（已完成）**：`ctx.windows.drag/resize`（含 `bind` 与 `onCancelInteraction`）、`ctx.net.request`（`unrestrictedNetwork` 能力门禁，统一文案「插件未声明不受限网络能力」）、`ctx.fs.readAudioMetadata` 与「原生网络」能力标签；网络工厂抽为独立模块 `src/renderer/plugins/network.ts`（与上游模块结构一致，避免浮窗入口把主渲染进程运行时拖进 bundle），拖拽生命周期与处理器工厂落在新增 `src/renderer/plugins/pluginWindowInteraction.ts`。**浮窗独立入口 `src/plugin-window/main.ts` 同步补齐**（+158/−0 纯新增）：`window.drag.*`、`window.resize.*`、`window.onCancelInteraction`、`fs.readAudioMetadata`、`net`，补齐后浮窗内的插件即可真正使用拖拽/缩放与原生网络

### 3.2b 第二轮验证（运行期，非仅类型检查）
- 音频标签解析器：2 套断言套件（合成 ID3v2.2/2.3/2.4、ID3v1、FLAC、WAV、M4A、AIFF、Ogg Vorbis、Opus、>64 KB Ogg 尾部窗口、未知容器、文件名回退）→ **FAILED=0**；期间发现并修复真实缺陷：MPEG 流场景从未读取文件尾 ID3v1
- 拖拽/缩放控制器：27 项断言（会话校验、光标差分移动、非授权 sender 拒绝、end/cancel 回滚、generation 重放拒绝、movable/resizable 门禁、dispose）→ **FAILED=0**
- 原生网络：本地 HTTP 服务 39 项断言（JSON/text/arrayBuffer、重定向、500 不当异常、AbortController 取消、超时、体积上限、base64/字符串/ArrayBuffer 请求体、12 项参数校验、错误类型）→ **FAILED=0**
- 以上脚本均在仓库外临时目录运行、无残留；`electron`/代理策略用测试桩替换（网络模块被测副本仅代理 import 行不同）

### 3.2 播放与数据链路
- `stores/player.ts`（+11 行，纯新增）：`createListeningTimeManager(state)`；5s 节拍内 `tick()`（与 `HISTORY_CHECK_MS` 同拍）；`fileLoaded` → `resetPosition()`；`ended` → `flush()`；导出 `flushListeningTime`/`resetListeningTimePosition`
- `stores/user.ts`（+57 行，纯新增，0 删除）：移植 `fetchGradeInfo` + `GRADE_DETAIL_KEYS` 白名单；`logout()` 内 `useListenReportStore().reset()`（防跨账号串号）；等级信息随用户信息流程拉取（上游由个人页触发，个人页属红线文件故改为跟随用户信息流程）
- `stores/playlist/types.ts` 与 `shared/storage.ts`：队列类型联合补 `'listen-together'`、`'purchased'`（与上游同名同序，服务一起听与已购）

### 3.3 任务 3 验证（更新检查仓库）
更新检查已指向 `MmlwrYan/YanMusic`，运行期日志实证：
```
[error] Error: Cannot find latest.yml in the latest release artifacts
  (https://github.com/MmlwrYan/YanMusic/releases/download/v2.2.8/latest.yml): HttpError: 404
```
该仓库尚无 release，404 属预期；仓库地址本身已切换（`package.json`、`main/ipc/settings.ts`、`stores/setting.ts`、`README.md`）。

## 4. 红线核对（任务 2）

| 红线对象 | 结论 | 证据 |
|---|---|---|
| `views/Profile.vue` handleClaimTvip/handleUpgradeSvip | 文件从未被本次作业修改 | `git status` 中该文件无改动 |
| `stores/user.ts` 的 VIP 相关成员 | 未触及 | `git diff --numstat` = `57 0`（纯新增、零删除）；`autoReceiveVipIfNeeded` 函数体 SHA256 前后一致（`24B93DD1…`）；diff 中仅出现 import 上下文行 |
| `api/user.ts` claimDayVip/upgradeDayVip/getVipMonthRecord | 未触及 | A3 阶段 SHA256 前后一致（见 §2 A3） |
| `views/settings/components/ExperimentalSettingsSection.vue` | 未修改 | 无改动（其上游依赖 `suspendRendererMemoryDiagnosticsForRelaunch` 因此未接线，见 §6） |

**收尾期最终核查（整轮移植结束后重跑）**：
- `git log -- src/renderer/views/Profile.vue` → 唯一提交为 `77a95b1`（fork 基线快照，移植开始前）；`git diff 0a69b6b HEAD -- src/renderer/views/Profile.vue` → **空输出 = 与移植基线逐字节一致**；两个处理函数与按钮绑定完好（`handleClaimTvip` L168、`handleUpgradeSvip` L185、按钮 L352/L422）；无未提交改动
- `git diff --numstat 0a69b6b HEAD -- src/renderer/stores/user.ts` → **57 0**（纯新增、零删除；`autoReceiveVipIfNeeded` 函数体 SHA256 前后一致）
- `ExperimentalSettingsSection.vue` 的 `git diff --numstat` → 空（未改）
- **GUI 来源标识全树核查**：渲染层仅 `constants/legal.ts:47/76` 命中（GPL-3.0 致谢，法律要求必须保留）；`desktopLyric/DesktopLyricView.vue:560` 有一处**代码注释**提到上游项目名（Yan 既有注释，非 GUI 可见，非本次引入）；其余 0 命中
- **第三方地址核查**：`plugins/common.ts:13`、`share.ts:2`、`PluginSettingsSection.vue:27` 均为原值且其上方已有 `TODO(source)` 注释；插件新增代码中 `git diff` 不含任何 URL 行

「领取 VIP」/「升级 VIP」的 GUI 按钮与自动领取逻辑完整保留，未被上游的删减版本覆盖。

## 5. 保持原值 / 已绕过项清单

### 5.1 法律要求保留（**来源约束的唯一例外**）
- `src/renderer/constants/legal.ts:47`：GPL-3.0 致谢文本，明确提到上游项目与作者。**必须保留**（上游为 GPL-3.0，修改再分发需保留致谢）。
- ✅ **合规处理已完成（2026-09-13 最终轮）**：
  - 原状：仓库 `LICENSE` 为 **MIT**，但代码含 **GPL-3.0** 部分（上游为 GPL-3.0，本次移植含其代码）
  - **已执行**：`LICENSE` 替换为 **GPL-3.0 完整原文**（1,060 B → **35,149 B / 674 行**，SHA256 `3972DC9744F6499F0F9B2DBF76696F2AE7AD8AF9B23DDE66D6AF86C9DFB36986`，与上游 GPL-3.0 原文**逐字节一致**）
  - **已执行**：`package.json` 新增 `"license": "GPL-3.0"`
  - **已执行**：`README.md` L17 徽章 `License-MIT-orange` → `License-GPL--3.0-blue`；L267「基于 MIT License 协议发布」→「基于 GPL-3.0 License 协议发布」
  - 说明：`native/*/package-lock.json` 中的 `"license": "MIT"` 是第三方依赖自身的许可证声明，**不属于本项目声明，未改动**；`LICENSE` 之下的 mpv（LGPL-2.1+/GPL-2.0+，动态链接加载）说明保持不变，GPL-3.0 与之兼容
  - 备注：SPDX 官方推荐写法为 `GPL-3.0-only`；按你的明确指示使用 `"GPL-3.0"`

### 5.2 插件市场外部引用（**已改为上游实际使用的值**；TODO 注释已移除）

决策依据：用户指示「以 EchoMusic 源码实际使用的值为准，不沿用 YanMusic 旧值」。以下四处的值现与上游 **逐字节一致**。

| 项 | 改前值（Yan 旧值） | 改后值（上游实际值） | 上游依据（EchoMusic-main） |
|---|---|---|---|
| 索引文件名 | `yan-plugins.json` | **`echo-plugins.json`** | `src/main/plugins/common.ts:14` |
| 插件仓库源 URL | `https://github.com/hoowhoami/yanmusicPlugins` | **`https://github.com/hoowhoami/EchoMusicPlugins`** | `src/main/plugins/common.ts:16-17` |
| 插件仓库源 ID | `github:hoowhoami/yanmusicplugins` | **`github:hoowhoami/echomusicplugins`** | `src/main/plugins/common.ts:18` |
| 统计 Worker 域名 | `https://yanmusic-plugin-marketplace.hoowhoami.dpdns.org` | **`https://echomusic-plugin-marketplace.hoowhoami.dpdns.org`** | `src/main/plugins/common.ts:19-20` |

同步更新的引用点（Yan 侧）：
- `src/main/plugins/common.ts:11-16`（四项常量本体，`// TODO(source)` 注释已删除）
- `src/renderer/views/settings/components/PluginSettingsSection.vue:24-28`（插件开发文档链接 → 上游仓库；TODO 注释已删除）
- `src/renderer/views/plugins/PluginSourceDialog.vue:36`（GUI 文案中的索引文件名 → `echo-plugins.json`）
- `README.md:215`（插件开发文档链接 → 上游仓库）
- `cloudflare/plugin-marketplace-worker/wrangler.toml:1,7`（Worker 名 / D1 库名 → `echomusic-plugin-marketplace` / `echomusic-plugin-stats`）
- `cloudflare/plugin-marketplace-worker/README.md:1,3,19,25,38,47`（Worker 说明与部署命令、验证请求体的 sourceId）

仍然**保持原值**（不属于「插件市场外部引用」，且上游同样指向原实现）：
| 文件:行 | 原值 | 说明 |
|---|---|---|
| `src/shared/share.ts:3` | `https://hoowhoami.github.io/yanmusic/share/` | 分享落地页（上游用 `.../echomusic/share/`；其可用性取决于该 GitHub Pages 站点是否部署，未在本次范围内变更，TODO 注释保留） |
| `src/main/plugins/common.ts`（User-Agent ×4，见 `src/main/plugins.ts:991/1064/1457/1791`） | `YanMusic-Plugin-Marketplace` | 应用自身标识串（非地址）；上游为 `EchoMusic-Plugin-Marketplace`。**决策：保留 Yan 品牌**（更符合本应用身份；GitHub 与 Worker 均不校验该值，改为上游值不会带来功能收益） |
| `cloudflare/plugin-marketplace-worker/wrangler.toml:8` / `README.md` | `replace-with-your-d1-database-id`、`your-worker.example.com` | 部署占位符，上游同为占位符 |

⚠️ 部署注意：`wrangler.toml` 的 Worker 名与 D1 库名现与上游相同。若同一 Cloudflare 账号下已部署上游 Worker，直接 `wrangler deploy` 会覆盖同名资源；如需并存请改用自有名称（本次按用户指示统一为上游值，此项仅作提示）。

### 5.3 插件市场可用性（改值前 → 改值后，均为实测）
- 主线代码**无需移植**（`usePluginMarketplace.ts`、市场卡片、Worker、主进程市场函数均已等价或 SHA256 相同）
- **改值前（Yan 旧值，实测）**：默认插件源仓库 `hoowhoami/yanmusicPlugins` = **404**；索引名 `yan-plugins.json` = **404**；统计 Worker 域名 **DNS ENOTFOUND** → **开箱可用性为 0**
- **改值后（上游实际值，2026-09-13 实测）**：

| 端点 | 结果 |
|---|---|
| `api.github.com/repos/hoowhoami/EchoMusicPlugins` | **200**（6,089 字节） |
| `raw.githubusercontent.com/.../HEAD/echo-plugins.json` | **200**（13,860 字节；上游审计含 36 个插件） |
| `echomusic-plugin-marketplace.hoowhoami.dpdns.org/health` | **200** |
| （对照）`api.github.com/repos/hoowhoami/yanmusicPlugins` | **404**（证明改值必要） |

→ 插件市场的默认源、索引文件名与统计上报端点**均已可用**；安装/更新/统计的**运行期**行为仍需你在客户端实测（本轮只做只读连通性验证）。
- 统计上报失败时仅 `log.warn`、不阻断安装（与上游一致）

### 5.4 其它绕过/裁剪项（有据裁剪，非跳过）
| 项 | 处理 | 原因 |
|---|---|---|
| 插件备份/恢复整块（`createPluginBackup`/`inspectPluginBackup`/`restorePluginBackup`、`plugins:backups:*`） | 未移植 | 硬依赖 Yan 不存在的原生 `pluginSqliteBackup` 与 6 个插件存储导出函数；上游该功能无渲染层引用 |
| 本地音乐（`shared/local-music.ts`、`main/localMusic.ts`、`main/media/*`） | 未移植 | 上游渲染层引用数为 0；需新增 `music-metadata` 依赖；Yan 已在 `plugins.ts` 内联等价扫描 |
| ~~`src/main/windowDrag.ts`（浮窗拖拽控制器）~~ | **第二轮已移植** | 落地为 `src/main/pluginWindowInteraction.ts`(331 行，与上游 `windowDrag.ts` 一致) + 8 条 IPC + preload 暴露 + 访客侧 `ctx.window.*`；有意偏差：未搬上游 `win.on('close', flushPersistBounds)`，因 Yan 无 `boundsDirty`/`windowBoundsPersistence`，硬搬会回退 Yan 现有的 Windows DPI 越界处理 |
| `webPreferences.enableWebSQL: false` | 未采纳 | 与插件 SQLite 存储迁移语义耦合，无法确证无副作用 |
| 云上传的文件选择 | 改为渲染进程 `<input type=file>` | 上游走 3 条主进程 IPC（依赖 Yan 不存在的 `shared/cloud.ts`/`main/media/*`）；功能可用但无内嵌标签解析（改为文件名推断） |
| 云盘删除 | 仅 hash 回退路径 | Yan `mapCloudSong` 缺 `cloudFileId`/`cloudAddedAt`/`cloudAudioSource` |
| 「以后不再提醒」开关 | 会话级替代 | Yan setting store 缺 `cloudUploadBackgroundConfirmDismissed`/`importBackgroundConfirmDismissed` |
| 截图导入 UI | 独立弹窗（未合并进 ImportPlaylistDialog） | Yan 的导入对话框是另一次重写（4 步结构），合并属大改造 |
| 上游 store 的 `stateMachine`（playbackIntent/enginePlayback/nativeTrackSeq） | 未照搬 | 绑定 Echo 的 `PlayerState` 形状；照搬需重写 Yan 播放核心（回归风险高）。其消费者已用等价方式满足（listeningTime 2 行映射、`PlaybackProgressBusyReason` 类型） |
| `interface`/`window` 设置分区注册 | 未注册 | Yan 的「外观与界面」已内联渲染这些开关，注册会造成重复开关（其任务栏部分已单独补齐） |
| `NetworkSettingsSection` 分区 | 未移植 | 需 Yan setting store 新增 `proxyMode`/`proxyPacScript`/`proxyRules`/`proxyUsername`/`proxyBypassRules`/`playerNetworkTimeoutSecs`/`applyNetworkSettings`；Yan 已在「播放体验」内提供酷狗 API 代理/mpv HTTP 代理/超时设置 |
| `suspendRendererMemoryDiagnosticsForRelaunch` | 未接线 | 上游唯一调用点在 `ExperimentalSettingsSection.vue`（红线文件） |

## 6. 遗留问题（按优先级）

1. ~~**一起听（房间）**：store 与页面正在按「播放内核最小适配」移植~~ → **已完成**（见 §3.1b）：store 2655 行、页面与上游逐字节一致、内核对齐、路由 `/main/together`、分享落地闭环、侧边栏入口均就绪。
2. ~~**插件能力缺口（上游有、Yan 无）**：插件原生网络 API、插件浮窗拖拽/缩放、`plugins:fs:read-audio-metadata`、`expectedPluginId` 透传、`PLUGIN_AUDIO_EXTENSIONS`、旧键回退、市场骨架屏~~ → **已完成**（见 §3.1b 第 3 条）；访客侧封装（`ctx.window.*`/`ctx.net.request`/`ctx.fs.readAudioMetadata` 与「原生网络」标签）在收尾期并行移植。
3. **插件市场开箱可用性**（见 §5.3）：需你提供自有插件源/Worker 域名，或确认直接指向上游可用地址。
4. ~~**settingsBackup 无 UI**~~ → **已补**「备份设置 / 导入设置」+ 导入确认弹窗；仍继承上游行为：导入后 Pinia store 不自动重载，UI 提示「重启应用后生效」（Yan 无应用重启 API，未臆造调用）；上游的插件存储提供方链路（`plugins` 范围备份）未移植，Yan 主进程实现固定 `settings:true, plugins:false`。
5. **许可证**：MIT 声明 + 含 GPL-3.0 代码（见 §5.1）。
6. **未做运行时验证的部分**：一起听（未联调）、云上传真实上传/删除、截图导入服务端联调、插件市场（上游默认源不可用）、非 Windows 平台窗口尺寸语义、任务栏进度条颜色与 Explorer 重启重放、设置备份对话框。
7. **上游文档与测试未移植**：`docs/{plugin-system,dsp-provider-architecture,dsp-provider-settings,audio-engine-invariants}.md` 与 `tests/`（30 个 node:test 文件）—— 大部分内容描述 Echo 的 ffmpeg/dspProvider 引擎，与 Yan 的 libmpv 架构不对应。

## 7. 交付产物（最终干净构建，全部 exit 0）

目录：`C:\coding\YanMusic\YanMusic-main\release\`（最终构建时间 2026-09-13 12:37，已含新图标）

| 产物 | 大小 | 说明 |
|---|---|---|
| `win-unpacked\`（1686 个文件） | — | Windows 免安装版，主程序 `win-unpacked\YanMusic.exe` 215 MB |
| `YanMusic-2.2.8-Windows-Setup-x64.exe` | **140.2 MB** | NSIS 安装包（`oneClick:false`、可选安装目录；体积由 139.85→140.2 MB 系新图标资源所致） |
| `YanMusic-2.2.8-Windows-Setup-x64.exe.blockmap` | 0.15 MB | 增量更新块映射 |
| `latest.yml` | — | 更新清单（electron-updater 用） |

打包内校验（afterPack，全部 ok）：`native/yan-media-controls.node` 7.50 MB、`yan-mpv-player.node` 0.69 MB、`yan-storage.node` 2.31 MB、`yan-spectrum-capture.node` 1.50 MB、`mpv/`(2 项，含 libmpv-2.dll)、`server/`(module=217 / util=9)、`icons/`(**11 项**，新增 `icon.icns` 与 `tray_icon_source.png`)。

构建命令链：`pnpm exec vue-tsc --noEmit` → **exit 0 / 0 报错**；`node node_modules/vite/bin/vite.js build` → exit 0（dist 241 文件 + dist-electron 6 文件 + `dist/plugin-window.html` 浮窗入口已构建）；`node node_modules/electron-builder/out/cli/cli.js` → **exit 0**。

**产物内容核查（构建后扫描，全部命中）**：
- 主进程 bundle（`dist-electron/main/app-*.js`）：`plugins:net:request|cancel`、`plugins:window:{start-drag,drag-move,end-drag,cancel-drag,start-resize,resize,end-resize,cancel-resize,cancel-interaction}`、`plugins:fs:read-audio-metadata`、`update:cancel-download`、`update-taskbar-cover-preview`、`update-taskbar-progress`、`settings-backup:{export,inspect,import}` —— **全部 OK**
- preload bundle：`startDrag`/`dragMove`/`endDrag`/`startResize`/`readAudioMetadata`/`net`/`settingsBackup`/`cancelDownload` —— **全部 OK**
- 渲染层 bundle：`listen-together`(35) / `effect-plaza`(7) / `purchased`(32) 路由字符串 —— **全部 OK**

**启动验证**（`release\win-unpacked\YanMusic.exe`，35 秒观察）：4 个进程存活、RSS 547 MB、无崩溃。运行日志关键行：
```
[IPC-Server] Initialized, 215 modules registered (lazy-load)
[Main] libmpv player engine started successfully
[TaskbarProgress] initialized { enabled: true }
[Loading] API status {"state":"ready"}
[UserStore] User detail fetched / VIP detail fetched
[UserStore] Grade info fetched
[FavoritesLoader] load completed {"total":41,"pages":1}
```
唯一错误为更新检查 404：`https://github.com/MmlwrYan/YanMusic/releases/download/v2.2.8/latest.yml`（该仓库尚无 release，属预期；同时实证任务 3 已生效）。

提交记录：`0a69b6b`(阶段 0) → `c705a90`(基线修复) → `30a7378`(.gitignore) → `5107f33`(A1) → `dc552a5`(A2) → `a14a7fd`(A3) → `906d934`(A4/A5/B/B-market/C1/C2 + 整合) → `93f4df4`(一起听内核/路由) → `7a8715a`(渲染层收尾) → `6dcc5ab`(插件能力 6 项) → `8d69f2d`(插件访客侧 + 浮窗入口 ctx)。提交后 `src/` 工作区干净（`git status --short -- src` = 0）。

#### 7.x 图标替换后的重新构建与生效验证（2026-09-13 12:37）

- `vue-tsc --noEmit` exit=0（0 error）；`vite build` exit=0（dist 241 文件）；`electron-builder` exit=0
- **打包内图标与源目录一致性**：`release\win-unpacked\resources\icons\` 10 个文件与 `build\icons\` **SHA256 全部 IDENTICAL**（`icon.ico` 4E3E59AD560BFE37、`icon.icns` 0AACA20BFA89219B、`icon.png` 236F0724ABD9A458、`icon_macos.png` AC333BD3EFC02BAF、`IconTemplate.png` 9568ABDB559DAD13、`IconTemplate@2x.png` 2A357BDACB3EE94E、`linux_256x256.png` DB07F59AED5FF01A、`linux_tray_icon.png` AF23AF6442FE1A30、`win_tray_icon.ico` 96AF672758A25365、`tray_icon_source.png` F589E6B474D70200）
- **exe 与安装包均已嵌入新图标**（在文件字节中命中新 `icon.ico` 数据）：`win-unpacked\YanMusic.exe`（225,470,464 B）@offset **224270428**；`YanMusic-2.2.8-Windows-Setup-x64.exe`（147,008,389 B）@offset **36924**
- **运行时图标解析正常**：窗口/任务栏图标取自打包后的 `resources\icons\icon.ico`（`src/main/appIcons.ts:369/527/618`），托盘取自 `win_tray_icon.ico`（`appIcons.ts:349`），两者都在打包资源内且哈希一致
- 重新构建后启动：4 进程、无崩溃、日志中**无图标相关错误或告警**

> 注：`build/`（afterPack.js、installer.nsh、icons、mpv、tools）与 `native/*/*.node`、`server/`、`release/`、`dist*/` 均按仓库 `.gitignore` 不纳入版本控制，但它们**在磁盘上齐全**，是构建的必要输入。（本轮的图标与工具已用 `git add -f` 强制纳入版本控制。）

## 8. 非 Windows 平台 installer：可行性结论（需你确认平台清单）

### 8.1 本机（Windows）能否交叉构建：**不能**（macOS 完全不可，Linux 不具备条件）

| 目标 | 结论 | 具体缺什么 |
|---|---|---|
| **macOS（.dmg / .zip）** | **技术上不可行** | electron-builder 的 `--mac` 目标**只能在 macOS 上构建**（dmg 制作依赖 macOS 的 `hdiutil`，签名/公证依赖 codesign；跨平台构建 mac 目标被 electron-builder 明确禁止）。此外本机也没有 macOS 版原生插件（4 个 `.node` 均为 win32-x64 构建产物）与 macOS 版 libmpv（`build/mpv/` 只有 `libmpv-2.dll`） |
| **Linux（.AppImage / .deb）** | **本机不具备条件** | 需要 Linux 工具链：本机无 `docker`、无 `fpm`/`dpkg-deb`/`appimagetool`，cargo 只安装了 `x86_64-pc-windows-msvc` 目标（原生模块需交叉编译出 linux-x64/arm64 的 `.node`），且没有 Linux 版 libmpv（`build/mpv/` 仅有 Windows DLL）。存在 `wsl.exe`，理论上可在 WSL 内装工具链后构建，但需在 WSL 内重建 4 个 Rust 原生模块 + 获取 Linux libmpv + 安装 node/pnpm，属**新环境搭建工作**，且无法在本次会话内可靠完成 |

### 8.2 但项目**已有 CI 覆盖全平台 installer**（推荐路径）

`.github/workflows/build.yml`（806 行）已配置矩阵构建，推送 `v*` Tag 时自动产出：

| 平台 | electron-builder 参数 | 产物 |
|---|---|---|
| macOS arm64 | `--mac --arm64` | `release/yanmusic-*.dmg` |
| macOS x64 | `--mac --x64` | `release/yanmusic-*.dmg` |
| Linux x64 | `--linux --x64` | `release/yanmusic-*.AppImage` / `*.deb` |
| Linux arm64 | `--linux --arm64` | `release/yanmusic-*.AppImage` / `*.deb` |
| Windows x64 / arm64 | `--win --x64` / `--win --arm64` | NSIS 安装包 |

CI 内已完成各平台的原生依赖准备：macOS 侧 `brew install mpv` + 递归复制 dylib + 修正 rpath + 签名为 Mach-O；Linux 侧 `apt-get install` 运行时依赖；并分别在对应 runner 上构建 4 个 Rust 原生模块（`native/yan-*`）。

`package.json` 的平台配置**已存在且完整**（无需改动）：
- `mac`: `icon: icons/icon.icns`、`category: public.app-category.music`、`target: [zip, dmg]`
- `linux`: `icon: build/icons/linux_256x256.png`、`target: [AppImage, deb, pacman, rpm, tar.gz]`
- `deb.depends`: `libasound2`、`libmpv2 | libmpv1`

### 8.3 唯一阻塞 CI macOS 构建的缺口（本次已解决）

`package.json` 的 `mac.icon` 指向 `build/icons/icon.icns`，但该文件**此前不存在**（仓库只有 `icon.ico`/`icon.png`/`icon_macos.png` 等）。→ 已在任务 4 中生成 `build/icons/icon.icns`（多尺寸 PNG 型 ICNS），CI 的 macOS 构建因此具备可用图标。

### 8.4 需要你确认（本任务的允许停顿点）

1. **目标平台清单**：仅 macOS、仅 Linux，还是两者都要？（CI 当前两者都产出 installer；若只要其一，可在 workflow 矩阵中裁剪）
2. 是否接受**以 CI 产物作为交付**（本机 Windows 无法产出 macOS/Linux installer）？
3. 若必须在本机产出 Linux installer：是否授权我搭建 WSL 工具链（需装 Linux libmpv、Linux Rust 目标、node/pnpm，耗时较长且可能与 CI 产物有差异）？

## 9. 应用图标：改为上游同风格 + 文字换为 YanMusic

### 9.1 上游图标调查结果（只读）
- 矢量源：`EchoMusic-main/build/icons/references/icon.svg`（1024×1024，**纯 SVG，含文字**）—— 白底圆角（`rx=180`）、两道 10% 透明蓝色装饰波纹（`#4A9EFF`）、首行深色文字（`#1A1A1A`，`font-size 180`、`weight 800`、`letter-spacing 6`、`y=475`）、第二行蓝色文字（`#4A9EFF`、`font-size 200`、`weight 900`、`letter-spacing 10`、`y=683`）、底部装饰横线（`x=412 y=750 w=200 h=8 rx=4`，50% 透明蓝）
- 上游同目录另有 `icon_macos.svg`、`mac_tray_icon_template.svg`、`win_tray_icon_dark/light.ico`、`tray_glyph_preview.png` 及 `README.md`（说明 references 仅作参考、运行时实际使用 `build/icons/` 下的位图）
- 上游 `build/icons/` 清单：`icon.ico`、`icon.icns`、`icon.png`、`icon_macos.png`、`IconTemplate.png`、`IconTemplate@2x.png`、`linux_256x256.png`、`linux_tray_icon.png`、`win_tray_icon.ico`

### 9.2 生成方式（无设计工具，全代码生成）
- 把上游 `icon.svg`/`icon_macos.svg`/`mac_tray_icon_template.svg` 复制到 Yan 并**仅将首行文字「Echo」→「Yan」**（第二行 `MUSIC` 保留，整体读作 YanMusic）
- **栅格化**：本机 `node_modules/electron` 只有壳（无 `dist/electron.exe`），从 electron 缓存解压后实测 `app.whenReady()` 不 resolve（两次尝试失败）→ 改用**同引擎 Edge 153 headless**（`msedge --headless=new --default-background-color=00000000 --window-size=N,N --screenshot=`）逐尺寸栅格化，**45/45 任务全部成功**，未安装任何 npm 包
- **组装**：扩展既有零依赖工具 `build/tools/gen-icons.mjs`（新增 ICNS 编码器、`ICON_SPEC` 规格表、`--png-dir` 组装模式），由 `references/*.svg` + `buildTraySvg()` 作为单一事实来源，可复现
- 临时脚本均在 `%TEMP%\yan-icons\`，仓库内无残留

### 9.3 产出与替换清单（覆盖 Yan `build/icons/`）
| 文件 | 字节 | 尺寸/内容 |
|---|---|---|
| `icon.ico` | 21,663 | 7 项：16/24/32/48/64/128/256 |
| `icon.icns` | 139,679 | 10 块：icp4:16 icp5:32 ic11:32 ic12:64 ic07:128 ic13:256 ic08:256 ic14:512 ic09:512 ic10:1024 |
| `icon.png` | 59,107 | 1024×1024 |
| `icon_macos.png` | 52,336 | 1024×1024（透明安全边距，主体 824×824） |
| `IconTemplate.png` / `IconTemplate@2x.png` | 312 / 729 | 16×16 / 32×32（纯黑+alpha，镂空 Yan） |
| `linux_256x256.png` | 11,171 | 256×256 |
| `linux_tray_icon.png` | 1,926 | 64×64（`#0071E3` 圆角方块 + 白 Yan） |
| `win_tray_icon.ico` | 2,063 | 16/24/32 |
| `tray_icon_source.png` | 1,398 | 64×64（补齐上游同名文件） |
| `references/*` | — | `icon.svg`、`icon_macos.svg`、`mac_tray_icon_template.svg`、`icon_macos.png`、`mac_tray_icon_template.png`、`win_tray_icon_dark.ico`（同步新风格）、`win_tray_icon_light.ico`（新增）、`README.md` |
| `build/tools/gen-icons.mjs` | 10,631 | 扩展为可复现工具 |

**`icon.icns` 是本轮的关键补齐**：`package.json` 的 `mac.icon` 一直指向 `icons/icon.icns` 但该文件此前不存在，CI 的 macOS 构建因此缺少图标（见 §8.3）。

### 9.4 验证证据
- **ICO/ICNS 结构**：`icon.ico` 7 项尺寸逐一解析通过；`icon.icns` 头长度字段 = 文件长度 = 139,679，10 个块**全部完整 inflate 解码成功**，`ic10` 字节 == `icon.png`，ICO 256px 条目字节 == `linux_256x256.png`
- **文字判定（像素级）**：同一版式仅替换首行文字的候选渲染与产物文字带逐像素比对 —— `Yan=0.00`（最佳）｜`Yen=3.82`｜`Yao=4.05`｜`Yon=10.95`｜**`Echo=31.14`**｜`Yam=38.07`；差异像素占比 Yan **0.00%** vs Echo **19.24%**；托盘镂空稿同样 Yan=0.00 / Echo=21.52
- **版式与上游一致性**：底部横线 **0.000%**、MUSIC 文字带 **0.000%**、波纹区 **0.000%** 差异；MUSIC 蓝字 bbox 两侧完全相同 `(163,529)-(858,685)`；`icon_macos` 白底主体一致 `(100,100)-(923,923)`；四角 alpha=0；`IconTemplate@2x` 镂空 bbox `(4,7)-(27,21)` 与上游完全相同
- **我（队长）的独立判读**：本机无视觉 provider（`read_image` 模型不支持图像输入、`modlens` 未配置 provider），故我另写零依赖 PNG 解码脚本打印点阵并**逐字辨认**：首行（阈值 130 抓 `#1A1A1A`）=「Y」，双斜笔汇聚竖干 +「a」碗形加竖笔 +「n」双竖笔顶拱 → **`Yan`**；第二行（阈值 190 抓 `#4A9EFF`）= M/U/S/I/C → **`MUSIC`**
- **无来源残留**：对 `build/icons/**` 与 `build/tools/gen-icons.mjs` 做文件名 + ASCII + UTF-16LE 三种扫描，**未发现任何 `Echo`/`EchoMusic` 字样**
- **构建后生效验证**（见 §7）：打包内 `resources/icons/` 10 个文件与源目录 **SHA256 全部一致**；新 ICO 字节在 `win-unpacked/YanMusic.exe`（@offset 224270428）与 NSIS 安装包（@offset 36924）中**均命中**；afterPack 由 `icons/ (9 entries)` → **`icons/ (11 entries)`**

### 9.5 与上游风格的差异（如实列出）
1. `icon.png` / `icon_macos.png` 为 **1024×1024**，上游同名母版是 3200×3200（版式/配色/几何一致，差异见 §9.4 的 0.000% 证据）；如需 3200 母版可用同工具重生成
2. `win_tray_icon.ico` 含 16/24/32，上游同名文件含 8 项（16/20/24/32/40/48/64/256）；`references/win_tray_icon_dark.ico` 已含 7 项
3. `icon.icns` 仅写 PNG 型块（10 块），未复刻上游的 `ic04`/`ic05` 原始位图块与 TOC 块（现代 macOS 不需要）
4. 首行文字带按需求不同（Echo → Yan），其余逐像素一致
5. 未产出上游的 `references/tray_glyph_preview.png`（纯预览图，非运行时资源）

---

## 10. 插件市场 UA 身份验证（任务 A）

### 10.1 目的
确认统计 Worker 是否按 `User-Agent` 做白名单/过滤（若过滤，则 Yan 的 UA `YanMusic-Plugin-Marketplace` 可能导致统计不计入或功能降级）。

### 10.2 源码证据：**Worker 不存在任何 UA 判断**
`cloudflare/plugin-marketplace-worker/worker.js`（296 行）全文核查结论：
- `user-agent` 字符串**仅出现 1 次**：L17 `'access-control-allow-headers': 'content-type,user-agent'` —— 这是 CORS 预检的**允许头声明**，不是校验
- `fetch()`（L270-295）仅按 `method + url.pathname` 分派：`OPTIONS` → CORS 空响应；`POST /v1/plugins/stats`；`POST /v1/plugins/events`；`GET /health`；其余 404
- **无** `request.headers.get('user-agent')`、**无**白名单数组、**无** Origin 校验、**无** 401/403 分支；`corsHeaders()` 为 `access-control-allow-origin: '*'`（对所有来源开放）
- 对照上游：EchoMusic 的同名 `worker.js` 在这一点上完全一致（同为 10.6 KB，同样只有 L17 一处 `user-agent`）

### 10.3 线上实测（2026-09-13，只读端点）
请求体（写入临时文件以避免 Shell 引号被吞）：`{"plugins":[{"sourceId":"github:hoowhoami/echomusicplugins","pluginId":"test"}]}`

| UA | `POST /v1/plugins/stats` | `GET /health` |
|---|---|---|
| `YanMusic-Plugin-Marketplace` | **200** `{"ok":true,"plugins":[{"sourceId":"github:hoowhoami/echomusicplugins","pluginId":"test","stats":{"installCount":0,"updateCount":0,"failureCount":0,"score":0,...}}]}` | **200** `{"ok":true}` |
| `EchoMusic-Plugin-Marketplace` | **200**，响应体与上行**逐字节相同** | **200** `{"ok":true}` |
| `curl/8.0` | **200**，响应体与上行**逐字节相同** | **200** `{"ok":true}` |

CORS 预检实测：`OPTIONS /v1/plugins/stats`（`Access-Control-Request-Headers: content-type,user-agent`）→ **HTTP 200**，`Access-Control-Allow-Origin: *`、`access-control-allow-headers: content-type,user-agent`、`access-control-allow-methods: GET,POST,OPTIONS`。

### 10.4 结论与处理
- **不存在 UA 白名单/过滤** → 按你的「第四步」执行：**保留原值**，**不伪造 UA 身份**
- 保留位置：`src/main/plugins.ts:991 / 1064 / 1457 / 1791`（4 处 `'User-Agent': 'YanMusic-Plugin-Marketplace'`）
- 风险再评估：Worker 对来源**完全开放**（`Allow-Origin: *`、无校验），因此伪造为上游 UA 不会解锁任何被限制的能力，反而会抹掉本应用身份 → 保留原值是正确工程决策
- 若将来统计不计入：问题只可能出在 Worker 侧（当前无任何校验），应改 Worker，而不是改客户端 UA

---

## 11. 跨平台 installer 交付路径：CI（最终结论）

### 11.1 结论
- **macOS + Linux installer 全部由 GitHub Actions CI 产出**；本机 Windows **不构建**、**不搭 WSL**（你的决定）
- Windows installer 由本机构建（见 §7 产物表）

### 11.2 CI 文件与触发方式
| 项 | 值 |
|---|---|
| 文件 | `.github/workflows/build.yml`（807 行） |
| 触发 | `on: push: tags: ['v*']` **＋** `workflow_dispatch`（手动运行）→ **普通分支推送不会触发** |
| 发布 | `release` job 仅在 `refs/tags/*` 时运行，产物作为 Release 资产上传 |
| 并发 | `concurrency: release-${github.ref}`、`cancel-in-progress: true` |

### 11.3 覆盖矩阵（6 个 job，全部会产出 installer）
| job | runner | electron-builder | 产物（glob 取证后） |
|---|---|---|---|
| macOS arm64 | `macos-14` | 默认（zip+dmg） | `YanMusic-*.zip`、`YanMusic-*.dmg`、`latest-mac.yml` |
| macOS x64 | `macos-14` | `--mac --x64` | `YanMusic-*.zip`、`YanMusic-*.dmg` |
| Linux x64 | `ubuntu-22.04` | 默认 | `YanMusic-*.AppImage`、`.deb`、`.pacman`、`.pkg.tar.zst`、`.rpm`、`.tar.gz`、`latest-linux.yml` |
| Linux arm64 | `ubuntu-22.04-arm` | `--linux --arm64` | 同上（`latest-linux-arm64.yml`） |
| Windows x64 | `windows-latest` | `--win --x64` | `YanMusic-*-Windows-Setup-x64.exe`、`latest.yml` |
| Windows arm64 | `windows-11-arm` | `--win --arm64` | `YanMusic-*-Windows-Setup-arm64.exe` |

CI 内的平台原生依赖准备工作（均已存在）：macOS `brew install mpv` + 递归复制 dylib + 修正 rpath + Mach-O 签名校验；Linux `apt-get` 运行时依赖；各 runner 上分别构建 4 个 Rust 原生模块；按平台下载/准备 libmpv。

### 11.4 本轮补齐的 CI 缺口（3 类，全部已改）
1. **产物通配符大小写不匹配（32 处）** —— Fork 改名 `yanmusic` → `YanMusic` 后 CI 未同步：matrix 的 `artifact_glob` 全为 `release/yanmusic-*.dmg` 等小写，而 `artifactName = ${productName}-...` 实际产出 `YanMusic-...`；配合 `if-no-files-found: error` → **Upload 步骤在 Linux/Windows runner 上必然失败**（macOS runner 文件系统大小写不敏感，可能侥幸匹配但不可依赖）。已全部改为 `YanMusic-*`（`artifact_name`、`Build YanMusic Desktop`、通知文案同步）。本机实证产物名：`YanMusic-2.2.8-Windows-Setup-x64.exe`。**替换后残留小写 0 处；BOM 与 LF 保留；YAML 结构自检通过（无 tab、`on:` 段完好）**
2. **`server/` 子模块 gitlink 缺失** —— `.gitmodules` 声明 `server` → `https://github.com/MakcRe/KuGouMusicApi.git`，但索引中**从未记录该 gitlink**（`git ls-tree HEAD server` 为空、`server/.git` 不存在）→ CI 的 `submodules: recursive` 取不到任何内容 → `working-directory: server` 的「Install server runtime dependencies」步骤失败，且打包会缺内置 API 模块（`afterPack` 会打印 `WARN 缺少 resources/server —— 内置 KuGou API 模块不可用`）。**已执行**：`git update-index --add --cacheinfo 160000,99ca12fb9d464e9cf1e893a4f967a6024885336b,server` —— 该 SHA 为上游 `main` HEAD，其 `package.json` 版本 **1.6.2** 与本地 `server/` 副本**一致**（本地 218 个 module + 10 个 util）
3. **未跟踪的构建输入** —— `server/module`、`server/util`（及 `server/node_modules`，被 gitignore）本地存在但未入库；现由子模块机制 + CI 的 npm install 步骤获取，**不需要**把第三方源码提交进本仓库

### 11.5 已知限制（如实报告，未擅自修改）
- **macOS 自动更新元数据冲突**：arm64 与 x64 两个 job 都产出 `latest-mac.yml`，`release` job 用 `merge-multiple: true` 合并时同名文件相互覆盖 → 最终只有其中一个架构的元数据。**dmg 本身不受影响**。建议（未执行）：mac 双架构合并为单 job `--mac --arm64 --x64`，或在 release 阶段合并两份元数据
- 远端仓库当前的 `build.yml` 与本轮修改前**字节数完全相同（29,021 B）**、同样含 server 步骤与小写通配符，且远端 `contents/server` = **404** → **远端 CI 同样存在上述缺口**，只有推送本轮的修复后才会具备可用性
- 以上 CI 修复**无法在本机验证**（需要真实 runner）；推送后应由 Actions 实际运行结果确认

### 11.6 推送前置条件（**未推送 —— 触发硬停条件**）
| 检查项 | 实测结果 |
|---|---|
| `git remote -v` | **空 —— 本地仓库未配置任何 remote** |
| 本地分支 | `master`（远端默认分支为 `main`） |
| 本地 origin 引用 / tag | 无 / 无 |
| 远端仓库 | `MmlwrYan/YanMusic` 存在、`public`、默认分支 `main`、`94b3f1af…`、仅 `main` 一个分支、已有 Tag `v2.2.8`（`64a23f86…`） |
| 与远端历史关系 | **无共同祖先**（本地为移植期新建快照历史，根提交 `77a95b1`；远端 `94b3f1af` 不在本地对象库中）→ `git push origin master:main` 会因非快进被拒；`--force` 将**覆盖远端现有 17 MB 内容及其提交历史** |
| 凭据 | 本地 `credential.helper = manager`（Git Credential Manager）已配置，推送时可能要求 GitHub 登录 |

**按你的硬停条件「remote 未配置或指向错误 → 停下报告，不要自行推送」，本轮未执行任何推送动作**。待你确认的命令：

```bash
# 方案 1（推荐，非破坏性：不触碰远端 main 历史）
git remote add origin https://github.com/MmlwrYan/YanMusic.git
git push -u origin master:refs/heads/porting/echomusic-2.3.1

# 方案 2（覆盖远端 main 历史，需 --force，会丢弃远端原有提交链）
git remote add origin https://github.com/MmlwrYan/YanMusic.git
git push --force origin master:main

# 触发 CI（二选一）
#  A. 网页：Actions → 「Build YanMusic Desktop」→ Run workflow → 选择分支（workflow_dispatch，无 Release 副作用）
#  B. 新 Tag：git tag v2.2.9 && git push origin v2.2.9   （远端已存在 v2.2.8，勿复用）
```

### 11.7 产物下载位置
- Actions 页：`https://github.com/MmlwrYan/YanMusic/actions/workflows/build.yml`
- **方式 A（推荐）**：`Run workflow` 手动运行 → 该次 run 页面底部 **Artifacts** 区下载 `YanMusic-macOS-arm64`、`YanMusic-macOS-x64`、`YanMusic-Linux-x64`、`YanMusic-Linux-arm64`、`YanMusic-Windows-x64`、`YanMusic-Windows-arm64`（保留 7 天）
- **方式 B**：推送 `v*` Tag → 额外执行 release job，全部产物上传至 `https://github.com/MmlwrYan/YanMusic/releases`
- macOS 下载 `*.dmg`；Linux 下载 `*.AppImage`（免安装）或 `*.deb`（Debian/Ubuntu）

---

## 12. 最终交付物清单
| # | 交付物 | 路径 / 位置 | 状态 |
|---|---|---|---|
| 1 | Windows 免安装版 | `release\win-unpacked\`（含新图标；`YanMusic.exe`） | ✅ 已就绪 |
| 2 | Windows installer | `release\YanMusic-2.2.8-Windows-Setup-x64.exe` | ✅ 已就绪 |
| 3 | macOS installer（dmg） | CI 产物（§11.7） | ⏳ 待推送触发 |
| 4 | Linux installer（AppImage/deb） | CI 产物（§11.7） | ⏳ 待推送触发 |
| 5 | GitHub 仓库更新 | `MmlwrYan/YanMusic` | ⏳ **待你授权推送**（§11.6，remote 未配置） |
| 6 | LICENSE → GPL-3.0 | `LICENSE`、`package.json`、`README.md`、`LICENSES/` | ✅ 已完成 |
| 7 | 报告 | `PORTING_REPORT.md` | ✅ 已更新 |

---

## 13. GUI 品牌暴露最终审计（含 1 处已知例外 + 2 处待你定项）

审计方式：对**打包后的渲染产物**（`dist/**/*.js`）用正则（非 `SimpleMatch`）搜索 `EchoMusic`、`hoowhoami`、`echomusic`、`EchoMusicPlugins`，再回溯到源码行。

> ⚠️ 更正说明：本轮早前一次审计使用了 `Select-String -SimpleMatch` 并把 `|` 当字面量，得出「dist 无命中」的**假阴性**结论；本节的结论来自更正后的正则审计。

### 13.1 唯一「用户可见的品牌文本」= GPL 致谢段（已知例外，此前你已裁定保留）
| 位置 | 内容 | 触发场景 |
|---|---|---|
| `src/renderer/constants/legal.ts:47` | 「本软件基于 GitHub 上著名项目 **EchoMusic** 开发（作者：**hoowhoami**），在此向 **hoowhoami** 及所有参与 **EchoMusic** 开发的开发者致以诚挚敬意。…」 | 设置 → 关于/法律条款弹窗「致谢」段 |
| `src/renderer/constants/legal.ts:76` | 「**EchoMusic** 项目基于 GNU General Public License v3.0（GPL-3.0）协议开源…」 | 同一弹窗 |

- 这两处是移植初期你明确裁定的**唯一 GUI 例外**（理由：GPL 致谢）
- **与「最终验收标准 1」的冲突（需你裁定）**：你的验收标准写「界面上不出现 EchoMusic / hoowhoami / echomusic 字样」，而这两处**确实出现在 GUI**。二者只能取其一：
  - **方案 A（现状，推荐）**：保留致谢。GPL-3.0 对修改版要求「保留版权声明 + 随附许可证文本 + 声明修改」；本机已是：源码版权头保留、`resources/LICENSE`（GPL-3.0 全文）与 `resources/LICENSES/LGPL-2.1.txt` 随包分发、致谢段声明了修改。**取消它不会带来额外合规保障，反而削弱溯源与善意声明**。
  - **方案 B（隐藏）**：把 L47/L76 改为中立表述，例如 L47 → `'本软件为 GPL-3.0 开源项目的修改版本，原始版权与许可条款见随附 LICENSE 文件。'`、L76 → `'本项目遵循 GNU General Public License v3.0（GPL-3.0）开源发布。'`。功能零影响，仅 UX 文案；合规依据变为「许可证文本随包 + 源码版权头保留」。**若你选 B，我按此改并重跑 vue-tsc + 重新打包**。

### 13.2 功能必需、但会露出上游标识的 3 处（非「文本」，属链接/常量）
| 位置 | 内容 | 用户可见性 | 建议 |
|---|---|---|---|
| `PluginSettingsSection.vue:27` | 点击「插件开发文档」打开 `https://github.com/hoowhoami/EchoMusicPlugins` | 按钮本身只显示中文标题；跳转后浏览器地址栏/页面标题会显示上游仓库名 | **保留**（指向插件开发文档必须用该地址；如你以后自建文档站再替换） |
| `src/shared/share.ts:3` | 分享落地页 `https://hoowhoami.github.io/yanmusic/share/` | **分享链接里直接带 `hoowhoami` 域名**，接收方可见 | 建议在自有 Pages 部署后替换（当前上游同款地址，保留 + TODO，见 §5.2） |
| `src/main/plugins/common.ts`（市场常量，打进 `app-*.js`） | `echo-plugins.json`、`EchoMusicPlugins`、`github:hoowhoami/echomusicplugins` | 不渲染为界面文本；仅在开发工具/文件内可见 | **保留**（任务 2 明确要求以上游实际值为准，且这些值决定功能能否工作） |

`PluginSourceDialog.vue:36`（提示语）中出现了「`echo-plugins.json`」这一**索引文件名**：不含验收标准所列的三个字样之一（`EchoMusic`/`hoowhoami`/`echomusic`），故判定为合规；如需彻底隐藏，可改为「…会读取仓库内的插件索引文件并同步插件清单。」（一行改动，功能零影响）。

### 13.3 源码注释中的上游引用（不需处理）
`DesktopLyricView.vue:560`、`stores/player/playback.ts:299`、`stores/listenTogether.ts:1671`、`stores/player.ts:64` 等注释提到引擎差异与上游实现来历。**注释不进 GUI**，且如实记录移植来历有利于维护，建议保留。

