# 阶段 2 — echo 标记清理报告

> 基线：`68b8410`（12 commits）。全部改动均**不改调用点语义**，只做标识改名 / 别名新增 / 死引用更正。
> 改动规模：**16 文件，+147 / −90 行**（不含 `server` 子模块）。
> 改动后类型检查：`vue-tsc --noEmit` **exit 0（零报错）**。

---

## 1. 全仓扫描结果（清理前）

扫描范围：748 个文件（排除 `node_modules`、`.git`、`target`、`release`、`dist*`），大小写不敏感。

| 分类 | 命中数 | 说明 |
|---|---|---|
| **真实残留（需处理）** | ~60 | 见 §2 三档清单 |
| **误报：shell `echo` 命令** | **68** | 全部在 `.github/workflows/build.yml`（`echo "..."` 诊断输出）与 `issue-ai-labeler.yml` —— **绝不能改名** |
| **误报：Web Audio API** | 1 | `src/renderer/views/Recognize.vue:167` 的 `echoCancellation: false`（回声消除，与品牌无关） |
| **误报：字符串巧合** | 2 | `DataSettingsSection.vue` 的 `handleChooseImport`（`e`+`Cho`se 大小写不敏感匹配到 `echo`） |
| **有意保留：外部契约** | ~10 | 见 §5 |

---

## 2. 三档分类与执行结果

### A 档｜可安全改名（纯内部标识）—— **全部完成**

| # | 位置 | 原值 | 新值 | 影响面 |
|---|---|---|---|---|
| A1 | `src/main/networkPolicy.ts:10-12` | `echo-app-network` / `echo-kugou-api` / `echo-community-audio` | `yanmusic-app-network` / `yanmusic-kugou-api` / `yanmusic-community-audio` | 3 个 Electron session 分区 |
| A2 | `src/main/electronAxiosAdapter.ts:18` | `x-echo-transport-request-id` | `x-yanmusic-transport-request-id` | 进程内 axios adapter ↔ webRequest 的临时标记头 |
| A3 | `src/main/ipc/settings.ts`（7 处） | `echoUpdaterSilent` / `setEchoSilent` / `getEchoSilent` | `yanUpdaterSilent` / `setYanUpdaterSilent` / `getYanUpdaterSilent` | 模块内私有变量 |
| A4 | `src/renderer/style.css`（**44 处**） | `body.echo-surface-translucent` | `body.yan-surface-translucent` | **修复真实缺陷，见 §3.1** |
| A5 | `src/renderer/style.css:541,561` | `body .echo-popover-content` / `body .echo-popover-arrow` | `.yan-popover-content` / `.yan-popover-arrow` | **修复真实缺陷，见 §3.2** |
| A6 | `src/renderer/plugins/runtime.ts:1869` | `element.dataset.echoScrollRole` | `element.dataset.yanScrollRole` | **修复真实缺陷，见 §3.3** |
| A7 | `src/renderer/utils/shortcuts.ts:516` + `src/renderer/layouts/MainLayout.vue:91,97` | `CustomEvent('echo:toggle-sidebar')` | `CustomEvent('yanmusic:toggle-sidebar')` | 同仓两侧同步改名，语义不变 |
| A8 | `src/renderer/desktopLyric/DesktopLyricView.vue:494-497` | `dataset.echoLyricPlaying/Collapsed/ReducedMotion/Layout` | `dataset.yanLyric*` | 与全仓 `data-yan-lyric-*` 约定对齐 |
| A9 | `src/renderer/views/lyric/LyricScroller.vue:257,262,267` | `dataset.echoLyric*` | `dataset.yanLyric*` | 同上 |
| A10 | `native/yan-spectrum-capture/src/backend/macos_sck.rs:459` | `c"EchoSpectrumSckOutput"` | `c"YanSpectrumSckOutput"` | macOS ScreenCaptureKit 内部 ObjC 类名（仅 1 处引用） |
| A11 | `src/plugin-window/main.ts`（9 处） | `EchoPluginWindowContext` | `YanPluginWindowContext` | 非导出的模块内私有 interface |

**A 档验收**：`rg -i "echo-app-network|echo-kugou-api|echo-community-audio|x-echo-transport-request-id|echo-surface-translucent|echo-popover-content|echo-popover-arrow|echoLyric|echoScrollRole|echo:toggle-sidebar|EchoPluginWindowContext|EchoSpectrumSckOutput|echoUpdaterSilent|setEchoSilent|getEchoSilent"` → **无命中**。

### B 档｜需兼容过渡（已对外暴露）—— **新增别名，旧名保留，调用点未改**

| # | 旧名（保留，标 deprecated） | 新增名 | 位置 |
|---|---|---|---|
| B1 | `EchoPluginManifest` | `YanPluginManifest` | `src/shared/plugins.ts` |
| B2 | `EchoPluginCompatibility` | `YanPluginCompatibility` | `src/shared/plugins.ts` |
| B3 | `EchoPluginDescriptor` | `YanPluginDescriptor` | `src/shared/plugins.ts` |
| B4 | `EchoPluginContext` | `YanPluginContext` | `src/renderer/plugins/runtime.ts` |
| B5 | `EchoGlobalRuntime` | `YanGlobalRuntime` | `src/renderer/plugins/types.ts`（原 interface 改名为 `YanGlobalRuntime`，旧名改为 type alias，结构零变化） |
| B6 | 全局属性 `$echo` | 新增 `$yanmusic`（**二者指向同一对象**） | `src/renderer/plugins/runtime.ts`（挂载点 2 处）+ `types.ts` 的 `ComponentCustomProperties` 声明 |
| B7 | 清单兼容键 `requires.echoMusicVersion` | — | **按任务要求原样保留**，并在 `descriptor.ts` 中保留旧键回退读取逻辑 |

**B 档验收**：新旧名可同时 `import`（类型别名同构），旧名均带 `@deprecated` 注释；`$echo` 与 `$yanmusic` 在 `installPluginRuntime` 中同时赋值同一对象引用。**未改动任何既有调用点**（`EchoPluginDescriptor` 等仍被 `main/plugins.ts`、`plugin-window/main.ts`、`renderer/plugins/*` 正常引用）。

### C 档｜死引用 —— **全部更正**

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| C1 | `src/main/ipc/settings.ts:89` | 注释引用 `native/echo-ffmpeg-player/src/vpf.rs`，**该文件在本仓库且在上游都不存在**（上游 `echo-ffmpeg-player` 无 `vpf.rs`，VPF 由外部 Provider 处理，见阶段 3） | 改为描述 VPF 容器头结构的自述性注释，删除悬空路径 |
| C2 | `cloudflare/plugin-marketplace-worker/README.md:38` | 文档写 `ECHOMUSIC_PLUGIN_STATS_API_URL`，但代码实际读取 `process.env.yanmusic_PLUGIN_STATS_API_URL`（`src/main/plugins.ts:926`）—— 该环境变量名**从未被代码读取** | 更正为实际变量名并加注说明 |
| C3 | `README.md:91-92` | 引用 `build/linux-libmpv-env.sh`、`build/linux-system-electron-wrapper.sh`，**两文件在仓库中不存在** | 改为描述真实实现（`src/main/mpv/linuxEnv.ts` 的 `ldd` + `LD_PRELOAD` + relaunch；`build/afterPack.js` 打包校验），并显式说明旧引用已更正 |

---

## 3. 改名过程中发现并修复的真实缺陷（本次清理的最大价值）

这三处是**「改名改了一半」留下的功能性不一致**：JS 侧已改为 `yan-*`，CSS/另一侧仍是 `echo-*`，导致选择器永不匹配。

### 3.1 插件毛玻璃（surface translucency）特性实际失效

| 侧 | 内容 |
|---|---|
| 施加类名（JS） | `src/renderer/plugins/runtime.ts:734` → `body.classList.toggle('yan-surface-translucent', ...)` |
| 消费类名（CSS） | `src/renderer/style.css` **44 条选择器全部写 `body.echo-surface-translucent`** |
| 旁证 | `src/renderer/components/music/SongList.vue:1042` 已用**新名** `body.yan-surface-translucent` |

⇒ 插件通过 `ctx.theme.surface.*` 提交的透明度/`backdrop-filter` 贡献**在样式表里全部落空**。A4 改名后 44 条选择器重新生效。

### 3.2 Popover 基础样式实际失效

`src/renderer/components/ui/Popover.vue:176,185` 施加 `yan-popover-content` / `yan-popover-arrow`，而 `style.css:541,561` 写的是 `body .echo-popover-content` / `body .echo-popover-arrow`（**非** `body.yan-surface-translucent` 作用域，属于无条件规则）。A5 改名后恢复。

### 3.3 插件滚动容器 role 过滤实际失效

| 侧 | 内容 |
|---|---|
| 读取（JS） | `runtime.ts:1869` → `element.dataset.echoScrollRole`（读 `data-echo-scroll-role`） |
| 写入（模板） | `Settings.vue:758-759`、`PageScrollContainer.vue:38-39` → `data-yan-scroll-role` |

⇒ `ctx.scroll.query({ role })` 的角色过滤**永远匹配不到任何容器**。A6 改名后读取的正是模板写入的属性名，过滤恢复。

---

## 4. 副作用与风险

| 项 | 评估 |
|---|---|
| session 分区改名是否导致老用户重登 | **不会**。三个分区名均**无 `persist:` 前缀**（纯内存会话，进程结束即丢弃）；登录令牌与设备指纹（`dfid`/`mid`）由 Pinia + SQLite（`pinia:user` / `pinia:device`）持久化，经 `src/renderer/utils/request.ts:65-84` 组装进 `Authorization` 头，不依赖 session cookie jar。已在 `networkPolicy.ts` 就地加注释说明。 |
| CSS 改名是否影响其他样式 | 只把 44+3 条选择器从「永不匹配」变为「按预期匹配」，未新增/删除任何属性声明。`SongList.vue` 原有的新名规则与之一致。 |
| `data-*` 改名是否破坏用户自定义 CSS | `data-echo-lyric-*` 这些属性**无任何 CSS 选择器消费**（全仓检索确认），改名后仍未被消费，属一致性整理；`data-yan-lyric-layout` 在 `DesktopLyricView.vue:945` 有同值模板绑定，命令式写入同值，无冲突。 |
| `macos_sck.rs` 改名是否影响 Windows 构建 | 不影响（该文件仅 macOS 编译）。Windows 侧 4 个 addon 全部重新编译 exit 0。 |
| B 档新增 `$yanmusic` 是否影响既有插件 | 纯新增，`$echo` 行为不变（同一对象引用）。 |

---

## 5. 有意保留项（`[自主决策]`）

以下内容**看起来是 echo 残留，但改名会破坏功能或违反约束**，一律保留并记录：

| 项 | 位置 | 保留理由 |
|---|---|---|
| 插件市场索引文件名 `echo-plugins.json` | `src/main/plugins/common.ts:11` | **外部契约**：客户端按此名从第三方插件源仓库根目录拉取 `https://raw.githubusercontent.com/<repo>/HEAD/echo-plugins.json`。改名会让所有既有插件源立刻无法浏览。已在常量处补 8 行注释说明。**且与作者移植报告 §5.2/§13.2 的既有裁定一致**（「任务 2 明确要求以上游实际值为准，且这些值决定功能能否工作」）。 |
| 官方插件源 URL / source id | `plugins/common.ts:14,15`、`PluginSettingsSection.vue:27` | 真实上游仓库 `hoowhoami/EchoMusicPlugins` 与 `github:hoowhoami/echomusicplugins`，功能必需 |
| 插件统计 Worker 域名 | `plugins/common.ts:17` | 已部署的线上服务 `echomusic-plugin-marketplace.hoowhoami.dpdns.org` |
| Worker / D1 资源名 | `cloudflare/plugin-marketplace-worker/wrangler.toml`、`README.md` | `echomusic-plugin-marketplace`（Worker 名）、`echomusic-plugin-stats`（D1 库名）均为**已部署的 Cloudflare 资源标识**，改名需重新部署且会丢失统计 |
| GPL 致谢与修改声明 | `src/renderer/constants/legal.ts:47,76`、`README.md`、`CHANGELOG.md` | **任务禁令：不得移除**。且为作者移植报告 §13.1 明确裁定的「唯一 GUI 例外」 |
| 源码中的移植来历注释 | `stores/player.ts:64,65,613`、`stores/player/playback.ts:299`、`stores/player/types.ts:15`、`stores/playlist/constants.ts:6`、`stores/listenTogether.ts:1671`、`api/music.ts:62`、`shared/network.ts:4`、`storage/kv.ts:24`、`desktopLyric/DesktopLyricView.vue:560` | 如实记录与上游的引擎差异，**有助于维护**；作者移植报告 §13.3 亦建议保留（注释不进 GUI） |
| shell `echo` 命令、`echoCancellation` | `.github/workflows/*`、`Recognize.vue:167` | 误报，与品牌无关 |

**A 档验收因此为 PARTIAL**：唯一未改名的是 `echo-plugins.json`，原因是外部契约（见上）。任务书列出的其余 A 档标识符（`echo-app-network`、`echo-kugou-api`、`x-echo-transport-request-id`）**均已改名，源码零命中**。

---

## 6. 清理后残留统计

| 类别 | 数量 |
|---|---|
| 清理前大小写不敏感 `echo` 命中 | **281** |
| 清理后 | **216** |
| 其中 shell `echo` 误报 | 72（build.yml 68 + issue-ai-labeler.yml 4） |
| 其中 `echoCancellation` 误报 | 1 |
| 其中 `handleChooseImport` 巧合 | 2 |
| 其中 `Echo*` 公共类型名（B 档保留 + 其引用点） | ~110 |
| 其中有意保留的外部契约 / 注释 / 致谢 | ~31 |

**净消除品牌残留：A 档 15 类标识符全部清除（含 47 处 CSS 选择器与 3 处功能性缺陷修复）。**

---

## 7. 阶段 2 验收自检

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| A 档全部改名完成 | `rg -i "echo-app-network\|echo-kugou-api\|x-echo-transport-request-id\|echo-plugins.json"` 在源码无命中 | 前三者 **0 命中**；`echo-plugins.json` 仍命中 2 处（**外部契约，有意保留**，见 §5） | **PARTIAL**（其余 A 档 100%） |
| B 档 alias 存在 | 新名与旧名同时可 import，旧名标 deprecated | 6 组别名全部就位，旧名均带 `@deprecated`；`$echo`/`$yanmusic` 同引用 | **PASS** |
| C 档死引用清除 | 被引路径不再出现 | 3 处全部更正（`echo-ffmpeg-player/src/vpf.rs`、`ECHOMUSIC_PLUGIN_STATS_API_URL`、两个不存在的 `build/*.sh`） | **PASS** |
| 构建未破坏 | `vue-tsc --noEmit` / `pnpm build` 仍正常 | `vue-tsc` **exit 0 零报错**；`vite build` **exit 0** | **PASS** |
| GPL 致谢保留 | 对 EchoMusic 的致谢与修改声明仍在 | `legal.ts:47,76` 未改动；README 灵感来源段未改动 | **PASS** |

**附加收益（超出任务要求）**：修复 3 处因「半途改名」导致的真实功能缺陷（插件毛玻璃、Popover 基础样式、插件滚动 role 过滤）。
