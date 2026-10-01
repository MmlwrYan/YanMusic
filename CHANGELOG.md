## [1.2.9]

> 本次为**技术债清算版**，**不包含新功能**。选债原则只有三条：局部可验证、不改对外行为、不可逆动作必须先确认；范围与顺序见 `docs/agent/v1.2.9/13-debt-clear-plan-2026-10-01.md`（本地留痕，不入库）。安全面的最大收益是**补上 v1.2.4 凭据加密工作的遗漏面**（`pinia:device` 与存量迁移）。

### 修复

- **二级 · 设备指纹明文落盘（M-4 / W-3）**。`ENCRYPTED_KV_KEYS`（`src/main/storage/kv.ts:23-26`）自 v1.2.4 起只有 `pinia:user`，同一次改动漏掉了 `pinia:device` —— `dfid` / `mid` / `uuid` / `guid` / `mac` 以明文存于 `YanMusic.sqlite`，本机任意进程可读。现已加入白名单。

  - 回退：从 `ENCRYPTED_KV_KEYS` 中删掉 `'pinia:device'` 一行。

- **二级 · 只加白名单对存量用户无效，补上「读时惰性迁移」（W-3 第二步）**。这是本版最容易被漏掉的一点：

  - 读路径 `decryptJsonIfNeeded` 遇到**非信封**会走 `return valueJson` **直通**分支；写路径只在**再次写入**时才加密。而 `pinia:device` 恰好几乎不再被写 → **升级用户的 `pinia:device` 会永久留在明文状态**；
  - 修复：新增纯函数 `needsEncryptionMigration(key, raw)`，并在 `KvStorage.get()` 里判定命中时调用 `migratePlaintextToEnvelope()` 就地重写为信封；
  - 三条设计取舍：① **幂等**（迁移后已是信封，下次不再触发）；② **失败不影响读取**（`safeStorage` 不可用时只记日志，明文值照常返回，不把「迁移失败」升级成「读不到数据」）；③ **通用** —— 做在 `get()` 而非针对某一个键，将来任何新增的 `ENCRYPTED_KV_KEYS` 都自动获得同样的迁移能力；
  - 回退：删掉 `get()` 中那一行迁移调用即可恢复原行为（不建议）。

- **三级 · 统计鉴权常量的单一来源（W-6）**。`src/shared/pluginStatsAuth.ts` 的头注释自称「由主进程侧客户端与测试共同引用」，但**主进程零引用**：`src/main/plugins.ts:1070-1073` 内联重写了 `'X-YanMusic-Key'` 与 `process.env.yanmusic_PLUGIN_STATS_API_KEY` 两个字面量。这是**跨语言契约**（主进程 TS / Worker 纯 JS / 测试 TS 三方），改一侧不会让另一侧报错。现改为 `import { PLUGIN_STATS_KEY_ENV, PLUGIN_STATS_KEY_HEADER }`。

  - 说明：常量值为小写 `'x-yanmusic-key'`（HTTP 头名大小写不敏感，Worker 侧 `readStatsKeyFromHeaders` 按小写比较），行为不变。

- **三级 · 插件运行时状态的死分支（W-2）**。`renderer/plugins/runtime.ts:2787` 原为 `activePlugins.has(id) ? 'active' : descriptor.enabled ? 'idle' : 'idle'` —— 两个分支取到同一个值。当前 `status` 类型只有 `'idle' | 'loading' | 'active' | 'error'`（无 `'disabled'`），故等价化简为 `? 'active' : 'idle'`，**行为不变**，只消除误导。

- **三级 · 外链补 `rel="noopener noreferrer"`（W-4）**。`utils/sanitize.ts` 的 `ALLOWED_ATTR` 放行了 `target`，但未挂 DOMPurify 钩子补 `rel` —— `target="_blank"` 会让新页面拿到 `window.opener` 句柄。现已加 `afterSanitizeAttributes` 钩子（带「只注册一次」保护）。**属纵深防御**：渲染层已有 `setWindowOpenHandler`（仅放行 `https:` 且一律 `deny`）兜底，本改动不改变现有行为。

- **三级 · 注释与事实不符（W-11，3 处）**：

  1. `renderer/plugins/network.ts:63-65` 与 `:127`：注释称 `fetch`「受同源与禁用请求头规则约束」，但本项目四类窗口均为 `webSecurity: false`，同源策略已关闭 —— 该说法与事实不符，已订正（**行为未改**，是否给 `fetch` 补能力门禁属对外行为变更，另列为待定项）；
  2. `.github/workflows/build.yml:157-158`：注释称「`server` 的 `package-lock.json` 常与 `package.json` 不同步」，而该文件**根本不存在**（子模块只有 `pnpm-lock.yaml`，且 npm 不读它）—— 已订正为准确描述「构建不可复现」这一真实问题；
  3. `build.yml` 中 `softprops/action-gh-release` 的 `# v2` 未给具体版本 —— 已标注「SHA 为准」。

- **三级 · Worker 限流表与错误回显（W-7）**：`cloudflare/plugin-marketplace-worker` 的限流表是 per-isolate 内存 Map 且**只增不减**，现加兜底上限（达到上限先清过期桶，清完仍满则放行但不入表）；顶层 `catch` 原样回显 `error.message`，现改为统一文案 `internal error`，真实错误只进 Workers 日志。

- **三级 · CI secret 插值（W-9）**：`build.yml` 中 `${{ secrets.GITHUB_TOKEN }}` 原被直接插值进 `run:` 命令正文，现改由 `env: MPV_RELEASES_TOKEN` 传入。现全仓 11 处 secret 引用**全部位于 `env:` 块**，`run:` 正文零插值。

### 新增

- **零引用模块扫描脚本 `scripts/scan-dead-modules.mjs`**。以 5 个入口（`renderer/main.ts`、`main/index.ts`、`desktop-lyric/main.ts`、`plugin-window/main.ts`、`preload/index.ts`）做 import 图 BFS，解析 `import/export from`、`import()`、`require()` 与 Vue SFC 的 `<style src=>`，别名 `@/` → `src/renderer/`，并把 `import.meta.glob` 覆盖的两处目录单列为 **B 类（插件 API 面，不可删）**。输出分 A/B/T 三类，支持 `--json`，也可作为模块被测试直接调用。
  - 扫描器本身在本次开发中修掉两个漏边 bug（CRLF 下 `;\r\nimport` 前缀只消耗一个字符；`import './style.css'` 无 `from` 时被带 `from` 的惰性分支吞掉），两者都会把**活文件误判为死代码**。
- **配套类型声明 `scripts/scan-dead-modules.d.mts`**（**必须保留，勿当冗余文件删掉**）。`tsconfig.json` 的 `include` 覆盖 `tests/**/*.ts`，而 `tests/source-level-guards.test.ts` 直接 `import` 该 `.mjs`；在 `moduleResolution: bundler` 且未开 `allowJs` 的配置下会触发 `TS7016`「找不到声明文件」+ 3 处 `TS7006`（返回值退化为 any）。CI 构建步骤是 `vue-tsc --noEmit && vite build`（`&&` 短路）→ 类型检查非 0 会让 **`vite build` 压根不执行**，症状却表现为「`dist-electron/main/index.js` 不在 asar 里」的**打包失败**，排查时极易被误导到产物/打包配置上。**v1.2.9 首轮干跑六条腿全红即因此**（详见「说明」段）。
- **发布前验证脚本 `scripts/verify.ps1`**。本机 `pnpm` / `npx` / `npm` 的 `.ps1` 垫片会被 PowerShell 执行策略拦截**且退出码为 0** —— 只检查 `$LASTEXITCODE` 会把「压根没执行」误判成「通过」。该脚本一律**直调 JS 入口**并逐步显式断言退出码，任一失败即整体非 0（支持 `-SkipNative` / `-SkipBuild`）。
  - ⚠️ **本机的鉴别力验证未完成**：当前会话无法取得 PowerShell 的回显输出（返回值不可见），因此**没有**实证「故意断一步 → 脚本退出非 0」。**首次使用时请自行验证一次**（把任一步改成必然失败的命令，确认脚本非 0 退出且不继续往下跑）。在此之前，请勿把它当作已验证通过的防线。
- **守卫用例 9 条**：`tests/kv-sensitive-keys.test.ts`（5 例：加密白名单、与 `sensitiveKv` 的运行时敏感键**两处不得漂移**、迁移纯函数的边界、迁移必须挂在 `get()` 上且失败不影响读取、迁移必须复用 `encodeForWrite`）；`tests/source-level-guards.test.ts`（4 例：统计常量不得内联、`sanitizeHtml` 必须**调用** `ensureNoopenerHook()`、不得出现同值三元、A 类零引用模块不得超出「刻意保留」白名单）。
  - **鉴别力验证（已做，喂回修复前代码必须变红）**：W-3 摘掉 `pinia:device` / 去掉迁移调用 → 3 条变红；W-6 改回字面量 → 变红；W-4 短路钩子调用 → 变红（**第一版只断言字符串存在，短路后仍绿，已加强为断言「被调用」**）；W-2 改回死分支 → 变红；W-1 新增一个未被引用的样例文件 → 变红。撤销后恢复全绿。

### 变更

- **删除零引用模块 12 个 / 967 行**（按「应用入口不可达 + 未被 `import.meta.glob` 覆盖 + 未被 tests 引用」三条件判定，删除前逐项做过「文件名 / 相对路径 / 别名」三串全仓复核）：

  `renderer/components/ui/dialogStack.ts`(109)、`renderer/composables/usePlaybackProgressStatus.ts`(23)、`renderer/composables/useStableLyricIndex.ts`(48)、`renderer/composables/useWindowDrag.ts`(43)、`renderer/models/gradeInfo.ts`(33)、`renderer/stores/player/progressStatus.ts`(53)、`renderer/stores/player/queueAdvancePolicy.ts`(27，`shared/playback-queue-decision.ts` 的重复实现，两者**成对删除**)、`renderer/utils/lyricFilter.ts`(59)、`renderer/utils/routeViewCache.ts`(32)、`renderer/views/search/components/SearchResultsSkeleton.vue`(156)、`shared/playback-queue-decision.ts`(247)、`shared/player-audio-graph.ts`(137)；并删掉 `renderer/stores/playlist/constants.ts` 中指向 `queueAdvancePolicy` 的失效备忘注释。

  - **刻意保留 9 项**（已写进守卫白名单，每条附理由）：`main/cache.ts`、`composables/useLyricTimeline.ts`、`stores/loginDevices.ts`、`views/settings/components/InterfaceSettingsSection.vue`、`views/settings/components/WindowSettingsSection.vue` —— 这 5 项**疑似被重构遗漏的活功能**，删除不可逆且本机无法确认，**待核定**；`renderer/plugins/types.ts`（环境类型增强，删后类型检查不一定报错但会静默丢失插件全局类型）；`shims-vue.d.ts` / `renderer/types.d.ts` / `renderer/stores/persist.d.ts`（构建契约，删除会让 `vue-tsc` 找不到声明）。
  - **B 类 5 件一律未动**（`components/ui/DatePicker.vue`、`components/music/DetailPageSkeleton.vue`、`components/music/SongListSkeletonRows.vue`、`components/ui/Textarea.vue`、`components/player/ProgressBusyOverlay.vue`）—— 它们经 `import.meta.glob` 进入插件 API 面，删除会改变对外暴露面。

### 说明

- **主题**：技术债清算。无新功能、无架构改动、无依赖升级。
- **验证结果**（本地，全部真实执行）：
  - `node --test tests/*.test.ts` → **197 例 / 192 通过 / 0 失败 / 5 跳过**（基线 188 例，本版**净增 9 例**，用例数未减少）；5 个跳过为沙箱内 `spawnSync` 返回 `EBUSY` 的环境产物（v1.2.4 起即有，CI 中正常执行）；
  - `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` → **退出码 0**（删除 12 个模块后仍全绿，说明删除未碰到隐式引用）；
  - ⚠️ **发布过程中的一次实际事故（已修复，如实记录）**：首轮 CI 干跑**六条腿全红**。根因是新增的 `tests/source-level-guards.test.ts` 直接 `import` `scripts/scan-dead-modules.mjs`，触发 `TS7016` + 3 处 `TS7006`；而 CI 构建步骤为 `vue-tsc --noEmit && vite build`，**`&&` 短路使 `vite build` 未执行** → `dist-electron/main/index.js` 不存在 → `electron-builder` 在 `sanityCheckPackage` 报「entry file is corrupted」。macOS/Windows/Linux 五条已完成的腿报错逐字一致。**本机漏检原因**：最后一次 `vue-tsc` 跑在新增这两个测试文件**之前**，之后只补跑了 `node --test`（运行时）与 `eslint`（语法/风格），两者都不做类型检查。已补 `scripts/scan-dead-modules.d.mts` 并重跑 `vue-tsc` 验证通过；流程教训：**新增测试文件后必须重跑类型检查，不能只跑测试**。
  - `node node_modules/vite/bin/vite.js build` → **退出码 0**；**主进程产物为单文件**（`dist-electron/main/` 仅 `index.js`，864,890 B）—— 未复发 v1.2.4 的多 chunk 启动崩溃事故；产物中已确认含本次新增的迁移逻辑（字符串常量命中）；
  - `node node_modules/eslint/bin/eslint.js .` → **退出码 0**（0 error / 0 warning；新增文件的格式问题已用显式的 `--fix` 修正，未改写其它文件）。
- **未做的验证**：无 GUI 会话，改动均未做运行时观感/端到端复核；其中 W-4（外链 rel）与 W-2（状态字段）均为**行为等价**改动，风险面在静态可判定的范围内。
- **本版未纳入的项及原因**（均非「忘了」，是有书面结论）：
  - **N 批次（原生层 W-18 / W-5 / W-13 / L-3）整批推迟**：需联网重建 4 个 addon，本机 `cargo` 走代理返回 502、`--offline` 又缺缓存，**无法验证** → 按「先复现再修复」与「不做只改源码的假完成」的纪律，不在本版改 `.rs`；
  - **M-1（能力门禁绑定 `event.sender`）与 M-2（开 `IPC_PERMISSION_STRICT`）**：属同一件事的两半，改动会让插件调用在身份反查失败时被拒，**有使插件大面积不可用的风险**，需先确认插件窗口 → `pluginId` 映射是否齐备 → **待核定**；strict 必须与 H-1（插件独立执行上下文）同批开，本版只做了「不动行为」的部分；
  - **W-17（插件 `ctx.net.fetch` 补能力门禁）**：属插件 API 的对外行为变更（或直接下线该 API），**待核定**；本版只订正了与事实不符的注释；
  - **W-19（mini 播放器 `sync.ts:146` 的 `updatedAt` 让去重永远失效）**：已查明 payload 本身含 `currentTime`，播放中每次必变；去重只在「状态完全不变」时才有意义，而触发源是状态驱动 → 冗余量可能有限，**建议先量一次真实推送频率再决定**，本版不动；
  - **W-8（`build` 作业 `contents: write` → `read`）**：需先确认 `upload-artifact` 是否真的不需要 `write`，改错会在打 tag 之后才失败 → **待核定**；
  - **W-10（`server` 依赖改用 `pnpm install --frozen-lockfile --prod`）**：需联网验证（且需确认 pnpm 在 workspace 子目录是否拒绝执行），本机做不到 → **待核定**；本版只订正了注释；
  - **B-2（首屏体积阈值守卫）**：已实测 CI 中 `Run unit tests`（`build.yml:511`）**早于** `Build desktop app`（`:531`）→ 体积守卫在 CI 里读不到产物，需先定「无产物时如何处理」（跳过 = 假绿，硬失败 = 阻塞）→ **待核定**；
  - **H-1（插件隔离）、M-3（`webSecurity`）、M-5、L-9/L-10、L-14、巨型文件拆分、插件运行时懒加载**：按既有结论维持「明确不做」，重启条件见规划文档 §5。
- **仍推后续版本**：上述全部「待核定」项，以及 `docs`/规划文档里已记的原生层与性能项。

## [1.2.8]

> 本次为**缺陷修复版**，**不包含新功能**。修复两个用户实测发现的独立缺陷：**更新无法安装**、**mini 播放器切歌后界面不同步**。

### 修复

- **点击「立即安装」无任何反应（既不退出应用，也不拉起安装程序）** —— IPC 契约不匹配。

  **根因**：`preload/index.ts` 用**单向** `ipcRenderer.send` 发送该通道：

  ```ts
  install: (silent) => ipcRenderer.send('update:install', { silent: !!silent })
  ```

  但主进程 `ipc/settings.ts` 用 **`ipcRegistry.registerHandler`** 注册（其实现是 `ipcMain.handle`）。
  **`ipcMain.handle` 只响应 `ipcRenderer.invoke`** —— `send` 打上去会被 Electron **静默丢弃**：
  既没有 handler 日志、也没有任何异常，表现为点击后毫无反应。

  用户日志提供了决定性证据：更新**下载确实成功**
  （`New version 1.2.7 has been downloaded to …yanmusic-updater\pending\…`），
  但点击安装后 **`[Updater] Starting update install` 从未出现**（该日志位于 handler 第一行之后），
  连 handler 开头的「尚未下载完成」错误日志也没有，证明 `update:install` **根本没有抵达主进程**。

  **对照组印证**：同一模块的 `update:download` / `update:cancel-download` 用的是
  `registerListener`（`ipcMain.on`）配 `send`，**匹配且工作正常**（下载成功即为证据）；
  `update:get-state` 用 `registerHandler` 配 `invoke`，也匹配。
  **`update:install` 是唯一的例外**，故此前一直未被察觉。

  **修复**：改为 `ipcRegistry.registerListener('update:install', …)`。
  listener 路径无法向调用方返回结果，故沿用更新模块既有的 `update-download-status`
  广播通道回传状态（渲染层消费的是该状态，而不是 `install()` 的返回值 —— 见 `stores/update.ts`）。

  - 回退：改回 `registerHandler`（会重新变成「点击无反应」）。

- **mini 播放器切歌后界面不同步（播放正常，但封面/歌名不更新、进度条卡住不动）** —— 共用根组件缺少窗口守卫。

  **根因**：`App.vue` 是**主窗口与 mini 窗口共用的根组件**（两者加载同一份 `dist/index.html`），
  而 `initMiniPlayerSync()` 的职责是把**主窗口**的播放状态推给主进程（主进程再广播给 mini 窗口），
  它是**数据生产者**。此前该调用**没有窗口类型守卫**，于是 mini 窗口也跑了它：

  - mini 窗口**没有播放引擎**，它的 `playerStore` 只有被动接收的一份状态，
    在切歌等时序下可能仍是**上一首**的 trackId；
  - 它照样调用 `syncSnapshot({ playback })`，用**残缺状态覆盖主进程快照**；
  - 主进程 `miniPlayer.ts` 的守卫
    （`if (win && !win.isDestroyed() && event.sender === win.webContents) return;`）
    正是为拦截这种情况，但**一旦窗口尚未创建或已销毁（`getMiniPlayerWindow()` 为 null），守卫即失效**。

  症状与用户描述完全一致：**播放不受影响，而 mini 窗口的封面/歌名停在上一首、进度条卡在中后段不动**；
  经实测确认，mini 窗口内展开歌词面板等**本地**交互仍正常（因为那些不依赖被覆盖的 playback 快照）。

  **修复**：`App.vue` 的 `initMiniPlayerSync()` 加 `isMiniPlayerRoute` 守卫。
  这与本文件其余位置**一致** —— `:304` `:310` `:316` `:322` `:328` `:336` `:342` `:348` `:357` `:372`
  均已有该守卫，**只有 `initMiniPlayerSync` 这一处遗漏**。
  mini 窗口只需**消费** `miniPlayer:onSnapshot`（由 `MiniPlayerView.vue` 自行订阅），不需要生产快照。

  - 回退：移除 `if (!isMiniPlayerRoute.value)` 包裹。

### 说明

- **主题**：两个独立缺陷修复，无新功能、无接口变更、无新增依赖。
- **验证结果**（本地，全部真实执行）：
  - `node --test tests/*.test.ts` → **188 例 / 188 通过 / 0 失败**；
  - `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` → **退出码 0**；
  - `node node_modules/vite/bin/vite.js build` → **退出码 0**；
  - `node node_modules/eslint/bin/eslint.js .` → **退出码 0**（0 error / 0 warning）；
  - **主进程产物为单文件**（`dist-electron/main/` 仅 `index.js`）—— 确认未复发 v1.2.4 的多 chunk 启动崩溃事故。
- **未做的验证（本机无法自证）**：
  1. **「立即安装」端到端** —— 需要真实的「已下载待安装」状态，本机无法构造（当前已是最新版本）；
  2. **mini 播放器切歌同步** —— 需要连续切歌并肉眼观察，本机无显示器会话。
  以上两项均为**代码层确证**（IPC 注册方式与发送方式的匹配关系、共用根组件缺少守卫，都是可静态判定的事实），
  但**端到端行为需在真实安装场景下确认**。
- **顺带发现（未在本版修复，记为技术债）**：`renderer/miniPlayer/sync.ts` 的 `buildPlaybackPayload()`
  每次都生成 `updatedAt: Date.now()`，而调用方用 `JSON.stringify({ playback })` 做去重 ——
  **该去重因此永远不生效**，会造成冗余 IPC 推送。本版不修（与本次两个缺陷无因果关系，且修复需谨慎评估
  推送频率变化的影响），留待后续版本。
- **仍推后续版本**：`W-3`（`pinia:device` 存量明文迁移）、`W-18`（`register_event_handler` 补 `take()+join()`，
  需联网重建原生 addon）、`M-1`（能力门禁绑定发送方）、`H-1`（插件独立执行上下文）；
  以及 v1.2.6 / v1.2.7「说明」段列出的各项人工交互验证。

## [1.2.7]

> 本次为 **v1.2.6 的紧接补丁**，**不包含新功能**。修复 v1.2.6 中「歌词换句滑动动效消失」的回归问题 —— 该问题由 v1.2.6 修复「换句闪回」时引入。

### 修复

- **歌词换句的滑动动效被误伤（v1.2.6 的回归）**。

  **背景**：v1.2.6 修复了「换句时先到下一句、又闪回、再到下一句」的问题 —— 根因是自动跟随使用浏览器原生 `behavior: 'smooth'`，其动画时长与换句间隔同量级，且**无法取消/重定向**，于是与带 `+100ms` 提前量的滚动目标互相打断。当时的修法是**改为瞬时定位**（`scrollToLine(index, false, …)`）。

  **回归**：瞬时定位虽然消除了闪回，但也**去掉了可见的滑动过程** —— 换句时滚动位置直接跳过去，观感「动效变短」。

  **修复**：改为**自绘 rAF 动画**（`views/lyric/composables/useLyricScroll.ts`）：

  ```ts
  const AUTO_SCROLL_DURATION_MS = 200;
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  // 每次新滚动先 clearSmoothScroll() 取消上一个；起点取 container.scrollTop
  ```

  - **保留约 200ms 的滑动过程**（`easeOutCubic` 缓出），动效回归；
  - **不复发闪回**：这是关键 —— 自绘动画**可取消**，新滚动会取消旧动画并把起点取为当前位置，因此**不存在两个滚动目标竞争**；而原生 `behavior:'smooth'` 做不到这一点；
  - **边界处理**：列表已无溢出空间（目标位于顶部/底部）时自动退回瞬时定位，避免「滚不动却等 200ms」；
  - 顺带修正一处语义：原条件 `previous !== -1` 让「切歌重置」走瞬时定位，但**切歌时 `previous` 同样是 `-1`**，该条件并不能真正区分场景；现在统一平滑。

  - 回退：将 `scrollToLine(index, true, …)` 改回 `false`，或把 `AUTO_SCROLL_DURATION_MS` 调为 `0`。

### 说明

- **主题**：纯动效回归修复，无行为/接口变化，无新增依赖。
- **验证结果**（本地，全部真实执行）：
  - `node --test tests/*.test.ts` → **188 例 / 188 通过 / 0 失败**；
  - `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` → **退出码 0**；
  - `node node_modules/vite/bin/vite.js build` → **退出码 0**；
  - `node node_modules/eslint/bin/eslint.js .` → **退出码 0**（0 error / 0 warning）。
- **未做的验证**：**滚动动画的最终观感仍需在真实界面确认** —— 本机为无头自动化环境，无法进行人工观感复核。该改动为**自包含的动画实现**（无外部状态耦合），逻辑上可静态确认「可取消 → 不会竞争」。
- **v1.2.6 遗留项（未变，仍推后续版本）**：`W-3`（`pinia:device` 存量明文迁移）、`W-18`（`register_event_handler` 补 `take()+join()`，需联网重建原生 addon）、`M-1`（能力门禁绑定发送方）、`H-1`（插件独立执行上下文）；以及 v1.2.6「说明」段列出的 4 项人工交互验证。

## [1.2.6]

> 本次为**体验优化 + 安全收口**版本，**不包含新功能**。主题是「**让用户感觉到更快、更顺、更省电**」，因此本版只做**用户可感知**的改动；原先列入的若干项（队列深拷贝、频谱降频、持久化序列化、同步 IO、`deep` watch）因**用户无可感收益**而推迟到 v1.2.7。

### 修复

- **一级 · 凭据读取收口（H-2）**。`storage:kv:*` 的 handler 原本是**裸透传**（`_event` 被丢弃、无任何身份校验），而 `KvStorage.get()` 会**透明解密** —— 因此**任意窗口（含插件窗口）**都能通过通用 IPC 通道读走已解密的登录票据（`pinia:user` 的 `info.token`），也能**覆写 / 删除**它（令牌替换 / 强制登出）。本次按键级收口：

  - 新增 `src/main/ipc/sensitiveKv.ts`（**纯函数策略模块**，无 Electron 依赖，可单测）：
    - 敏感键：`pinia:user`、`pinia:device`；
    - 允许的发送方：`main` / `mini-player` / `desktop-lyric`（**三者都安装了 `sqlitePersist`，确实需要读写这些键**）；
    - **`plugin-window` 被拒绝**（它不安装 pinia/sqlitePersist，本就不该访问）。
  - **只信 `registerWindowKind` 登记表**：未登记 → 拒绝（fail-closed）。刻意**不**回退到 URL 推断 —— mini 播放器与主窗口加载**同一份 `dist/index.html`**（`miniPlayer.ts:232`），URL 不可区分。
  - **收口范围含写入面**：`kv:get` / `kv:set` / `kv:delete` 三者同规则；`storage:reset-all` 另限**仅主窗口**——它经 `playbackQueues.ts:82` 调原生的 `resetAll()`，而后者**同时 `DELETE FROM app_kv`**（即清掉凭据）以及播放历史 / 队列 / 歌曲。
  - **不敏感的键一律放行**，保持既有行为（否则会打断所有窗口的 `sqlitePersist`）。
  - 回退：删除 `storage.ts` 中三处 `evaluateSensitiveKvAccess` 判定与 `reset-all` 的窗口判定即可（不推荐）。

- **歌词漂移与换句闪回（两个独立缺陷，均已修复）**

  - **桌面歌词「固定慢一点」** —— `desktopLyric/DesktopLyricView.vue` 的锚点同步把**两个不同时钟相减**：

    ```ts
    const ipcDelay = performance.now() - (state.updatedAt || performance.now());
    //                 ↑ 相对时钟（页面加载后毫秒，约 122）   ↑ 绝对时钟（Unix epoch 毫秒，约 1.79e12）
    ```

    `state.updatedAt` 的来源链全程是 `Date.now()`（`MiniPlayerView.vue` 赋 `Date.now()` →
    `main/nowPlaying.ts` 原样透传 → 桌面歌词快照），因此两者相差约 **−1.79e12 ms**，
    使 `ipcDelay > 0 && ipcDelay < 1000` **恒为假**，**补偿分支自引入以来从未执行过一次**。
    主进程 `time-update` 的 200ms 节流滞后因此完全没有被抵消。
    **修复**：改用同源时钟 `Date.now() - state.updatedAt`。（实测：修复前 `ipcDelay = −1.791e+12`，正确写法应为 0–200ms 量级。）

  - **换句时「先到下一句、又闪回、再到下一句」** —— `views/lyric/composables/useLyricScroll.ts` 的自动跟随
    使用了 `behavior: 'smooth'`（原条件为 `previous !== -1`）。平滑滚动的动画时长与换句间隔同量级，于是：
    索引已在下一句、动画还在从上一句滑过去（视觉滞后）；期间带 `+100ms` 提前量的
    `scrollIndex` 又把滚动目标推向下一句，**两个滚动目标互相打断**。
    **修复**：自动跟随换句改为**瞬时定位**（`scrollToLine(index, false, …)`），
    歌词位置与音频同帧对齐；`smooth` 仅保留给「用户滚轮结束后恢复自动跟随」一处。

  - 回退：两处均为独立小改动 —— 将 `Date.now()` 改回 `performance.now()`、
    将 `scrollToLine` 第二参改回 `previous !== -1` 即恢复原行为（不推荐）。
  - 说明：以上为**代码层确证**（含时钟量级实证）。**运行时滚动观感仍需人工会话复核**，
    见下方「说明」段的未验证项。

### 新增

- **敏感键访问守卫用例**（`tests/sensitive-kv-access.test.ts`，7 例）：锁定「插件窗口被拒」「三类必要窗口放行」「不敏感键放行」「未登记 fail-closed」「注销后回到拒绝」等行为。已做**鉴别力验证**：临时短路允许集合判断后，**2 个核心用例如期变红**，撤销后恢复全绿。

### 变更

- **评论列表启用 `content-visibility`**。`CommentList.vue` 的 `.comment-item-wrap` 新增 `content-visibility: auto` + `contain-intrinsic-size: 160px`，视口外评论项跳过 layout / paint，**200 条以上评论滚动更流畅**。
  - 为什么不用虚拟化：项目自带的 `useVirtualList` 是**固定行高**设计（`useVirtualList.ts:41-47`，总高 = `itemCount × itemSize`），而评论是可变高度（内容折叠 + 楼层回复展开），强行套用会导致**滚动位置错乱**。
  - 回退：删掉这两行 CSS 即完全恢复（**无 JS、无 DOM 结构改动**）。
- **图片按需加载**。补全 13 处 `<img>` 中的 10 处：长列表用 `loading="lazy" decoding="async"`（评论头像 ×2、历史封面、插件卡片 ×3、分享页、榜单 logo），**首屏主视觉 3 处用 `loading="eager"`**（歌词页背景 `LyricPage:264`、人像模式 `PortraitMode:309/321`）——首屏图**不可**用 lazy，否则首帧延迟出现。
  - `ui/Image.vue` 新增 `loading` / `decoding` 两个 prop（默认 `lazy` / `async`）；首屏用法需**显式传 `eager`**。
  - 说明：封面主路径 `ui/Cover.vue:104` **原本就已有** `loading="lazy" decoding="async"`，本版未改动它。
- **后台节流**。`backgroundThrottling` 由 `false` 改为 `true`：**主窗口**（`window.ts`）、**mini 播放器**（`miniPlayer.ts`）、**插件窗口**（`pluginWindows.ts`）→ 最小化后渲染层不再全速运行，降低后台 CPU 与耗电。
  - **桌面歌词窗口保持 `false`**（`desktopLyric/window.ts`）——节流会导致歌词与播放不同步。

### 说明

- **v1.2.6 主题**：体验优化 + 安全收口。本版只做**用户可感知**的改动。
- **验证结果**（本地，全部真实执行）：
  - `node --test tests/*.test.ts` → **188 例 / 188 通过 / 0 失败**（v1.2.5 基线为 181，本版净增 7 例）；
  - `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` → **退出码 0**；
  - `node node_modules/vite/bin/vite.js build` → **退出码 0**（渲染层 + 主进程 + preload）；
  - `node node_modules/eslint/bin/eslint.js .` → **退出码 0**（0 error / 0 warning）。
  - 注：本机 `pnpm` / `npx` 的 `.ps1` 垫片被执行策略拦截，**且退出码为 0**，故一律直调 JS 入口执行，避免「未执行」被误判为「通过」。
- **未做的验证（需要人工交互会话，本机为无头自动化环境）**：
  1. 评论 ≥200 条时滚动 30 秒的 DevTools Performance 前/后对比；
  2. 图片懒加载的 Network 面板复核（「初始只加载可视区图片」）；
  3. `backgroundThrottling` 最小化后的任务管理器 CPU 对比；
  4. **歌词修复的运行时观感复核**：桌面歌词是否不再「固定慢一点」、换句是否不再「闪回」。
     两处修复均为**代码层确证**（时钟混用已用真实数值实证：`ipcDelay = −1.791e+12`，
     正确同源写法应为 0–200ms 量级；`smooth` 滚动与 `+100ms` 提前量的目标冲突为静态可读的代码事实），
     但**滚动动画的最终观感仍需在真实界面确认**。
  **以上四项均只完成了代码改动与自动化验证（类型 / 单测 / 构建 / lint），未做运行时实测。**
- **本版未纳入的项及原因**：
  - **插件运行时懒加载（原 P1-3）**：实施中发现原方案方向有误。`runtime.ts` 的 `ctx.windows` 由**主窗口 / 桌面歌词**的 runtime 装配（`runtime.ts:2518`），而**插件窗口有自己独立的 `buildContext`**（`plugin-window/main.ts:629` / `:690`）。因此「由插件窗口注入工厂」会让主窗口侧直接失败，**已完整回退**。可行的切边需要先确认「主窗口的 `ctx.windows.drag/resize.bind` 是否真的被使用」——属**独立设计问题**，不在本版强行处理。
  - **W-3**（`pinia:device` 存量明文迁移）、**W-18**（`register_event_handler` 补 `take()+join()`）、**M-1**（能力门禁绑定发送方）、**H-1**（插件独立执行上下文）→ **推 v1.2.7**。
    - 重启条件：`W-18` 需**联网重建原生 addon**（本机 cargo 离线无法解析 workspace）；`H-1` 为架构级改动，需单独设计。
- **已知问题**：本版**未处理** `webSecurity: false`（M-3）与插件 `ctx.net.fetch` 绕过能力门禁的问题，二者仍按原计划留待后续版本。

## [1.2.5]

> **紧急修复**：v1.2.4 的安装包安装后主进程启动即崩（弹窗 `A JavaScript error occurred in the main process / TypeError: Be is not a function`），应用完全无法打开。本次定位到根因并修复，**无任何新功能**。

### 修复

- **一级 · v1.2.4 主进程启动即崩（`TypeError: Be is not a function`）**。根因是三层叠加，缺一不可：
  1. `logger.ts` 与 `storage` 之间存在**循环依赖**：`logger → storage/settings → storage/kv → logger`；
  2. `logger.ts` 在**模块顶层**就求值持久化设置——`let currentLogSettings = normalizeLogSettings(getPersistedLogSettings())`；
  3. v1.2.4 把 `vite-plugin-electron` 从 0.29 升到 1.1.2。该版本在 Vite 8（rolldown 引擎）分支下**不再把 `codeSplitting` 转译成 `inlineDynamicImports`**（源码见 `dist/utils.cjs`：`if (viteVersion < 8) { ...转换... } else { ...直接赋值，不做转换... }`），于是主进程被切成 `index` / `settings` / `app` 三个 chunk。rolldown 把每个模块体包成惰性初始化 thunk，切分后 thunk 的求值顺序与源码顺序不再一致——`logger` 的 thunk 先于 `storage/settings` 求值，那次顶层调用拿到 `undefined`，抛出 `TypeError: <minified> is not a function`。

   修复分两层：
  - **源码层（治本）**：`logger.ts` 改为**惰性求值**——缓存初值置 `null`，首次读取时才调用 `getPersistedLogSettings()`（`currentLogSettingsCache ??= normalizeLogSettings(getPersistedLogSettings())`）。循环依赖不再影响求值顺序。
  - **构建层（纵深防御）**：`vite.config.mts` 为主进程显式设 `codeSplitting: false`（Vite 8 用 `rolldownOptions.output`，同时在 `rollupOptions.output` 保留 `inlineDynamicImports` 以兼容未来版本切换），恢复单文件产物——产物由 **3 个 chunk 变回 1 个**（811 KB `app-*.js` + 43 KB `settings-*.js` → 863 KB 单 `index.js`）。

- **二级 · 顺带修复：主进程 `external` 配置在 Vite 8 下被静默丢弃**。排查过程中发现 `vite-plugin-electron` 1.x 在 Vite ≥8 分支会 `delete build.rollupOptions` 并改用 `rolldownOptions`，导致项目写在 `rollupOptions.external` 的列表**整体失效** —— `electron-audio-loopback` 被误打进 bundle（它依赖原生模块，不应内联）。改到 `rolldownOptions.external` 后恢复正常外部化。（`../../native/yan-storage` 与 `yan-mpv-player` 的「未外部化」是**误报**：源码本就用 `require(运行时计算的 .node 绝对路径)`，不依赖 bundler 的 external，v1.2.3 起即如此。）

### 新增

- **主进程冒烟测试（CI 六腿全跑）**。v1.2.4 之所以能把一个「装完打不开」的包发出去，直接原因是当时的 CI **只校验产物存在**（`Verify bundled Windows executable`、`Verify bundled macOS mpv signatures`），**从未真的启动过主进程**。本次补上 `scripts/smoke-main-bundle.cjs`：
  1. **结构断言**：主进程必须是单文件，出现额外 chunk 即失败 —— 这是启动崩溃的构建侧特征；
  2. **真的加载一次产物**：用 stub 替换 `electron` 后 `require` 主进程 bundle，判定失败的依据是「错误是否源自主进程产物且发生在**模块顶层求值阶段**」（而非错误类型 —— stub 不完整导致的报错是异步发生的，不该误伤）。

  已做**鉴别力验证**：人工把产物改回 v1.2.4 的失败形态，脚本以 `exit 1` 拦下，栈指向 `index.js:11:20312` —— 与事故现场的 `11:20264` 几乎同一位置。

### 说明

- **定位过程**：先按报错文案怀疑压缩混淆，用 sourcemap 把崩溃点反查回源码——`settings-*.js:18683 → src/main/logger.ts:19`，调用的是 `storage/settings.ts:170` 定义的 `getPersistedLogSettings`，**调用点在定义点之前**。再用非压缩构建在本机复现出真实符号名（`Ot is not a function`），确认与混淆无关，是真实的源码/构建缺陷。
- **验证**：新增 `tests/main-bundle-no-splitting.test.ts`（5 例），对源码层与构建层各设闸门并校验产物形态；该测试已做**反向验证**——喂回修复前代码时 A、B 两项**如预期失败**，证明守卫非空壳。主进程产物用 stub 过的 Electron 加载，模块顶层**完整通过**（修复前正是在此步抛出）。
- **验证结果**：`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0；主进程产物为**单文件**；`node --test` **181 例 / 176 通过 / 0 失败 / 5 跳过**。
- **CI 验证**：run `36323143311`（ref `v1.2.5`）**六腿全绿**，且六腿均执行了新增的「Smoke test main process bundle」步骤并输出「冒烟测试通过」——即新防线已在真实 CI 上生效，不再是只在本机跑得通的守卫。Release 标题自动生成为 `YanMusic v1.2.5 Release`，22 个产物齐全。
- **影响范围**：仅 v1.2.4 一个版本受影响。v1.2.3 及更早使用 `vite-plugin-electron` 0.29，产物是单文件，无此问题。**v1.2.4 的安装包建议作废，直接安装 v1.2.5。**

## [1.2.4]

> 本次为**安全修复 + 依赖升级**的补丁版本，**不含任何新功能**。依据 v1.2.3 全量审阅报告（`docs/agent/v1.2.3/06-full-review-2026-09-26.md`，随 v1.2.4 起为本地开发留痕、不入库）的结论，逐条修掉全部一级/二级问题与可即刻处理的三级问题：修掉 3 个一级（CI 注入、插件越权读文件、登录凭据明文落盘）、4 个二级（IPC 窗口身份歧义、SQL 黑名单绕过、SQLite 目录边界、统计端点无鉴权），并升级 5 个依赖。审阅报告本身也做了一处**重要的自我订正**。

### 修复

- **一级 · CI 脚本注入（H-1）**：`issue-ai-labeler.yml` 把 AI 返回的结论直接 `echo "response=$RESULT" >> $GITHUB_OUTPUT`。当 `$RESULT` 含换行时可在 output 文件里**伪造新键**（CWE-93 / 74），下游 `if: contains(..., 'INVALID')` 的判定因此可被操纵。现改为「先把结论归一化成 `INVALID`/`VALID`/`UNKNOWN` 严格枚举，再用 heredoc 定界符写出」——换行只会成为单条值的内容，无法再伪造键。
  > **订正说明**：v1.2.3 报告把 H-1 判为「`env:` + 双引号内展开可闭合引号执行任意命令」，本次修复前做了**真实 bash 重放**证伪——bash 不会对变量**值**做二次命令替换解析，`$VAR` 展开的结果永远只是数据。原判断是重放时把载荷直接写进脚本源码、与目标场景不等价造成的方法论错误。真正被修的是 output 伪造面，不是命令注入面。
- **一级 · 插件越权读取本地文件（H-2 / M-2）**：`getPluginFileUrl` 与 `listPluginImageFiles` **一处能力门禁都没有**（连 `pluginId` 参数都不需要），可读任意路径文件。现给两者补上 `pluginId` 形参，入口即调 `hasPluginLocalFilesAccess`，并改用 `realpathSync` 解析后判 `isFile()`（防符号链接跳转）。`pluginId` 由**运行时闭包注入**而非插件自报，插件无法伪造成别的插件。
- **一级 · 登录凭据明文落盘（H-3）**：用户凭据以明文存于 `pinia:user`。现改用 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密后再落盘；非敏感键不加密，避免无谓的性能与可读性损失。
- **二级 · IPC 无法最小授权（M-1）**：四个窗口共用同一份 preload，主进程无法区分调用来自哪个窗口。现以 `webContents.id` 建立「窗口 → 允许通道」登记表，并在窗口销毁时注销，消除了「无法区分」这一障碍（为后续最小授权铺路，本版仍是**只观测不阻断**）。
- **二级 · SQL 黑名单可被绕过（M-6）**：原正则黑名单漏过 `VACUUM/**/INTO 'x'`（块注释当空白）与 `VACUUM--\nINTO x`（行注释），已在真实 SQLite 3.53.1 上确认可任意路径写。现改用**词法归一化**（逐字符剥离注释与字符串字面量 → 压平空白 → 独立词匹配）替代文本黑名单，`VACUUM/**/INTO` 与 `VACUUM  INTO` 一律拦下，而 `SELECT 'VACUUM INTO x'` 里的同名词不误报。
- **二级 · SQLite 目录边界（M-5）**：原生层不校验库文件路径。现于 JS 边界加目录断言（拒绝越界路径与含 `..` 的库名），原生源码处补注释说明彻底方案（`sqlite3_set_authorizer` 白名单）留待后续。
- **三级 · 统计端点无鉴权（M-7 → 升格）**：`cloudflare/plugin-marketplace-worker` 的 `/v1/plugins/events` 无任何鉴权、CORS 为 `*`，任何人可任意增减插件的安装/更新/失败计数——而 `computeScore = installs*3 + todayInstalls*5 - failures*2` 直接决定排行榜排序，即**排行榜可被任意刷高刷低**。现加最小鉴权（`X-YanMusic-Key`，常量时间比较、缺失即 fail-closed）与固定窗口限流（60 次/分钟，按 `cf-connecting-ip`），并在鉴权通过前不读请求体。
- **三级 · 其他**：`index.html` 引用了不存在的 `/vite.svg`（现补 `public/favicon.svg` 并更正引用）；Rust 死代码告警（`player.rs` 中两个被取代的废弃方法，删除后 `cargo check` **零警告**）；README 中 5 处 Electron 版本号与 `package.json` 不一致（`43.1.1` → `43.7.3`）。

### 变更

- **依赖升级**：`pinia` 3.0.4 → **4.0.3**；`vite-plugin-electron` 0.29.0 → **1.1.2**、`vite-plugin-electron-renderer` 0.14.7 → **1.0.0**（其 breaking change `notBundle` → `bundleDeps` 与本项目无关，项目只用最简 API）；Rust 侧 `cpal` 0.15 → **0.18.2**（适配统一 `Error`/`ErrorKind`、`StreamConfig` 按值传递、`SampleRate` 变 u32、`DeviceTrait::name()` 移除等破坏性改动）、`mpris-server` 0.9 → **0.10**（显式启用 tokio feature）。
- **发布流程**：`build.yml` 为 Release 步骤补上 `name`，Release 标题自动成为「YanMusic &lt;tag&gt; Release」，不再需要发布后手工改名；`docs/release-process.md` 同步。
- **仓库卫生**：`docs/agent/` 移出版本控制（转为本地开发留痕），并忽略 `.workbuddy/`。
- **行为变更说明：无。** 除安全修复外不改动任何功能逻辑；M-1 的判定本版仍只记录不拒绝，M-3（`webSecurity: false`）经评估会破坏跨域音乐请求，维持原状。

### 说明

- **验证结果**：`node --test` **176 例 / 171 通过 / 0 失败 / 5 跳过**（5 个为沙箱内 `spawnSync` 返回 `EBUSY` 的环境产物，CI 中会正常执行，已用直接执行方式另测通过）；`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0；`cargo check --workspace` 退出码 0（四个 native crate 全通过、零警告）。
- **新增 3 个测试文件 / +20 个用例**：`plugin-stats-auth.test.ts`（8 例，密钥比较与限流）、`plugin-worker-auth-contract.test.ts`（5 例，**双向验证**：喂修复前的 worker.js 时 3/5 失败）、`plugin-sql-injection.test.ts` / `plugin-sqlite-path-boundary.test.ts` / `security-regressions.test.ts` / `ci-supply-chain.test.ts` 等守卫同步扩充。
- **守卫有效性**：新增守卫均做过「喂修复前代码 → 必须报错」的反向验证。只会在正确代码上通过的守卫是空壳——这些不是。

## [1.2.3]

> 本次为**工程债清理 + 观测机制落地 + 依赖升级**的补丁版本，**不含任何新功能**：把 lint 接入 CI（基线由 101 errors 清到 **0 error / 0 warning**）；新增两项**只观测、不阻断**的机制（CSP Report-Only、IPC 通道白名单报告式检查），为 v1.3.0 的强制化提供真实数据；升级 5 个 GitHub Actions 到主版本并修掉一处会让发布路径断裂的连带问题。

### 修复

- **`lint` 从未接入 CI，且脚本自带 `--fix` 会在 CI 上改写工作区**：`package.json` 的 `lint` 此前是 `eslint . --ext .vue,.js,.ts,.jsx,.tsx --fix`，没有任何 CI 步骤执行它。现移除 `--fix` 并在 `build.yml` 的 `Run unit tests` 之后新增 `Run lint` 步骤（`pnpm lint`），一旦有 error/warning 即失败。本地需要自动修复时显式执行 `pnpm exec eslint . --ext .vue,.js,.ts,.jsx,.tsx --fix`。已实测 `pnpm lint` 退出码 0 且**运行前后工作区改动数不变**（证明不再改文件）。
- **`eslint.config.js` 的两处覆盖缺口**：① `@typescript-eslint/no-require-imports` 的豁免 glob 写的是 `build/**/*.js` / `scripts/**/*.js`，而仓库脚本实际是 **`.cjs`** —— 11 条误报（`.cjs` 里 `require` 是唯一可用的加载方式）；② `ignores` 未覆盖 `target/`，导致 eslint 遍历整个 Rust 构建目录（实测 **3470 文件 / 728 目录 / 1.28 GB**），单次 lint 由 ~55s 拖到 ~71s，且当 cargo 并发写 `target/` 时会以 `ENOENT ... scandir` 直接中断。修正后 11 条误报与 3 条「冗余 disable 注释」警告一并消失。
- **11 处未使用声明**（按 lint 逐条核对，非批量替换）：`build/tools/gen-icons.mjs` 的 `copyFileSync`、`qishui.ts`/`spotify.ts` 的 `ProviderContext`、`settingsBackup.ts` 的 `join`、`preload/index.ts` 的 `PluginNetworkRequestBody`、`loginDevices.ts` 的 `useUserStore`、`AppearanceSettingsSection.vue` 的 `FontIcon`、`SearchHeader.vue` 未使用的 `props` 绑定、`PlayerQueueDrawer.vue` 的死代码 `isSongPlayable`（连带其唯一使用者 `isPlayableSong` 导入）。其中 `rendererMemoryDiagnostics.ts` 的两处是**用解构 + rest 剔除属性**的惯用写法（`_naturalPixels` 的存在本身就是目的，删掉会让该字段残留在对外返回值里），因此改为在配置中采用 typescript-eslint 官方推荐的下划线约定（`argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern: '^_'` + `ignoreRestSiblings: true`），**不动代码**。

### 新增

- **N-02 CSP Report-Only 观测**（`src/shared/cspReportOnly.ts`、`src/main/cspObservation.ts`、`src/renderer/utils/cspViolationReporter.ts`）：给应用自身的 `index.html` / `desktop-lyric.html` 下发 `Content-Security-Policy-Report-Only`，浏览器只报告不阻断；渲染层监听 `securitypolicyviolation`，去重后经**既有** logger 落盘。**未新增 IPC 通道、未开任何本地监听端口**（不用 `report-uri`），零行为变更。
- **IMP-01 IPC 通道白名单「报告式」检查**（`src/main/ipc/permissions.ts` + `registry.ts` 两条路径）：64 个通道建立「通道 → 允许窗口」规则表，判定结果以 JSON lines 写入 `<logs>/ipc-permission-violations.log`（首次必写，重复每 200 次写一条带累计次数的汇总）。**默认永不拒绝调用**；仅当显式设置环境变量 `IPC_PERMISSION_STRICT` 时才拒绝（默认关闭，为 v1.3.0 预留）。
- `tests/csp-report-only.test.ts`（9 例）、`tests/ipc-permission-observation.test.ts`（9 例）：把两项观测机制的红线与实测结论固化为守卫（见「说明」）。用例总数 **113 → 131**。

### 变更

- **GitHub Actions 升级到主版本**（合并 Dependabot PR #1/#2/#3/#5/#6）：`actions/checkout` 4.4.0→7.0.1、`actions/upload-artifact` 4.6.2→7.0.1、`pnpm/action-setup` 4.3.0→6.1.0、`actions/setup-node` 4.4.0→7.0.0、`actions/github-script` 7.1.0→9.0.0。升级后**所有 `uses:` 仍固定到 40 位 commit SHA 并保留版本注释**（由 `tests/ci-supply-chain.test.ts` 持续校验）。
- **★ 连带修复：`actions/download-artifact` 4 → v8.0.1**。Dependabot 从未为该 action 提过 PR，于是合并 `upload-artifact@v7` 后出现跨大版本不兼容：二者共用 artifact 客户端库，`upload-artifact@7.0.1` 依赖 `@actions/artifact ^6.2.0`，而 `download-artifact@4.3.0` 仍是 `^2.3.2`。`release` 作业正是用 download-artifact 拉取全部产物来生成 Release，**若不修会在打 tag 之后才失败**（干跑时 release 作业被 tag 守卫跳过，测不到）。`download-artifact@8.0.1` 依赖 `^6.2.1`，与 v7 同线；已核对 inputs 仍含我们使用的 `path` 与 `merge-multiple`。
- **清理 prettier 报告的 43 处格式偏差（仅格式，无逻辑改动；27 `.ts` / 10 `.vue` / 2 `.cjs` / 2 `.json` / 1 `.js` / 1 `.mjs`）**：来源是 prettier 3.8.3→3.9.8 的两处风格改动（多行联合类型不再用行首竖线；实参按 printWidth 重新折行）。为确认没夹带逻辑改动，用语义 AST 摘要逐文件比对：「纯空白 7 个 + 语义 AST 完全相同 36 个 + 语义不同 0 个」，并先用变异样本（改一个字面量）验证过这套比对确实能检出差异；10 个 `.vue` 另用 Vue 编译器比对 `<template>` 产出的渲染代码，**10/10 逐字相同**。格式化前后 `dist` 文件数均为 252。
- **行为变更说明：无。** 本版全部改动均为「配置/文档/测试/依赖升级/只观测不阻断」；`lint` 脚本去掉 `--fix` 与新增 CI 步骤只影响开发与 CI，不影响应用运行。

### 说明

- 验证结果：`pnpm test` **131/131 通过**（0 失败 0 跳过）；`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0（`dist` 252 文件）；`cargo check --workspace --release` 退出码 0；`eslint` 由基线 **101 errors** 降至 **0 error / 0 warning**（归因见「修复」逐条说明）。
- **观测数据样例（v1.3.0 的设计输入）**：
  - **CSP Report-Only**：在真实 Electron 中加载**真实的 `dist/index.html`**（`webSecurity: false`，与应用一致）并采用应用同一份策略源码，实测 **真实页面 0 条违规**；阳性对照（JS 注入内联 `<style>` 与 `setAttribute('style')`）立刻产生 **2 条**违规（`style-src-elem|inline`、`style-src-attr|inline`），证明观测链路确实生效、且「0」不是失效。
    **重要结论：N-02 当初担心的「154 处 `:style=` 绑定 + 24 处 `setProperty` 会导致强制 CSP 白屏」经实测不成立** —— 这些写法走 **CSSOM**，而 CSP 的 `style-src` 不覆盖 CSSOM。真实页面的内联 `<style>` 标签数为 0、`style=` 属性仅 1 个。
  - **IPC 白名单**：用真实 `registry` + 真实页面 + 真实 IPC 调用逐页采集（**12 次真实调用全部成功执行**，日志中 `rejected: false`、`note: "call was still executed"`）：

    | 发送方页面 | 通道 | 判定 | 实际调用 |
    |---|---|---|---|
    | `desktop-lyric.html` | `app:get-info`（scope=main） | ★不允许（仅记录） | ok |
    | `desktop-lyric.html` | `plugins:data:get`（main,plugin-window） | ★不允许（仅记录） | ok |
    | `desktop-lyric.html` | `mpv:play` / `storage:kv:get` | 允许 | ok |
    | `plugin-window.html` | `app:get-info` / `mpv:play` | ★不允许（仅记录） | ok |
    | `plugin-window.html` | `plugins:data:get` / `storage:kv:get` | 允许 | ok |
    | `index.html`（主窗口与 mini 播放器同一份产物） | 全部 | **ambiguous=true → 一律放行** | ok |

    落盘样例（`<logs>/ipc-permission-violations.log`，JSON lines）：

        {"at":"...","kind":"violation","channel":"app:get-info","page":"desktop-lyric.html","kinds":["desktop-lyric"],
         "scope":["main"],"ambiguous":false,"webContentsId":1,"occurrences":1,"strictMode":false,"rejected":false,
         "note":"whitelist observation only; call was still executed","key":"app:get-info|desktop-lyric.html"}

    **最重要的观测结论**：`index.html` 对任何通道都是 `ambiguous: true` —— mini 播放器加载的就是 `dist/index.html`（`miniPlayer.ts:231`），与主窗口同 bundle，仅凭发送方 URL 无法区分，因此这部分调用一律放行。这是此前审计指出的结构性障碍的**量化证据**：在现有窗口/产物结构下，白名单对「主窗口 vs mini 播放器」这一维度无能为力。
- **本版暂未处理的事项（附原因与重启条件）**：
  - **`IMP-11` 凭据加密**：现状为 `src/main/storage/kv.ts:17-19` 以 `JSON.stringify` 明文写入 SQLite；既有先例是 `src/main/networkSettings.ts:46-52` 的代理密码（`safeStorage` 不可用时**抛错拒绝保存**，而不是退化为明文）。三个方向里，退化为明文、静默丢弃 token 都不可接受，剩下的「提示用户并拒绝保存」不是补丁版本装得下的改动：它要新增 IPC 通道与渲染层提示 UI，要新增一个配置键记住用户选择，而且「拒绝保存 token」本身会改变现有行为——Linux 上无 keyring 的用户将失去登录持久化；加密后凭据值的**存储格式**也会变，旧版本读不了。**重启条件**：作为独立改动立项，并先定下「Linux 无 keyring 时给用户看什么」的交互。届时可复用本版测到的环境事实：Windows 上 `safeStorage.isEncryptionAvailable() === true` 且加解密往返正常（实测密文为 Chromium `v10` 前缀）。
  - **`cpal` 0.15.3→0.18.2（#8）、`mpris-server` 0.9.0→0.10.0（#4）**：均为 **0.x 跨 minor**（semver 允许破坏性变更），且落在**原生音频采集 / Linux 系统媒体控制**链路上（`cpal` 的 lock 依赖图变动较大）。本机做不了**运行时**验证（无音频采集设备、无 D-Bus/MPRIS），仅 `cargo check` 与 CI 编译不足以排除行为回归，所以不盲升。**重启条件**：有能做「系统音频捕获 + MPRIS」真机冒烟的环境。
  - **`pinia` 3.0.4→4.0.3（#15）**：主版本，且本项目用自研 `sqlitePersist` 插件钩住 `pinia.use(...)`，持久化是全部 store 的底座；主版本可能改动插件 API / state 水合 / `$subscribe` 语义，影响面覆盖所有 store，而完整功能验证需要逐视图 GUI 交互（本机不具备）。**重启条件**：单独立项，先读破坏性变更清单，并配持久化兼容性用例。
  - **`vite-plugin-electron` 0.29.1→1.1.2（#13）、`vite-plugin-electron-renderer` 0.14.7→1.0.0（#14）**：主版本（0.x→1.x），二者驱动 `vite.config.mts:3-4,54` 的 Electron 构建/开发集成。`vite build` 可验证，但 **dev 模式**（`VITE_DEV_SERVER_URL` 路径）不在 CI 覆盖内、本机也验不了，盲升有破坏开发工作流的风险。**重启条件**：单独立项，并在能验证 dev 模式的环境下进行。
  - **`destroy()` 的 `0xC0000005`**：**本机无法复现**。本机 CPU 为 Intel Core i5-3230M（**Ivy Bridge 第 3 代**），**不支持 AVX2**（AVX2 自 Haswell 第 4 代起）。此前的判断是「CI runner 的现代 CPU 会走到本机走不到的 SIMD 路径」，故无 AVX2+ 真机即无法复现。**已排除「上游 napi 缺 unload-safety 修复」这一解释**：查锁定的 `napi 3.12.7` 源码，`bindgen_runtime/module_register.rs:1049` 的 `retain_current_module_for_unload_safety()` 已在六个构造点被调用（`error.rs:110`、`threadsafe_function.rs:64`、`tokio_runtime.rs:571/950/1039`、`js_values/deferred.rs:586`），而我们两个 addon 走的正是 `ThreadsafeFunction` 与 `tokio_rt` 两条路径，即「镜像被卸载时其中仍有原生代码存活」这一类崩溃在 3.12.7 上已有防护——**所以不要把「升级 napi」当成修复手段**。**剩余嫌疑点**：`native/yan-mpv-player/src/lib.rs:125-161` 的 `destroy_locked()` 先清 `EVENT_CALLBACK`、后 `join()` 事件线程，而事件线程自己持有一份 `ThreadsafeFunction` 克隆，其 drop 发生在事件线程上、晚于 `terminate_destroy()`。**重启条件**：支持 AVX2/AVX-512 的 Windows 真机，用探针循环复现并抓崩溃转储（WER LocalDumps / procdump）。
- **本版仍然存在的已知问题**：`addon.destroy()` 在 Windows CI 上触发 `0xC0000005`（自 v1.2.0 起，v1.2.2 已改为「带诊断跳过」而不再阻塞构建）；`index.html` 引用了不存在的 `/vite.svg`（Vite 模板遗留）。

## [1.2.2]

> 本次为**测试链路健壮性修复 + 依赖例行更新 + 发布流程文档化**的补丁版本，**不含任何新功能**：把「真实引擎实测」的断言全部移入子进程执行，消除了「原生崩溃导致整个测试文件失败且零输出」这一曾使 v1.2.1 标签构建失败的失败模式；合并 4 个 Dependabot 例行更新（2 个 Rust patch + 2 个 npm 分组，全部 patch/minor）；新增发布流程 SOP 并固定「Release 标题需手工修正」这一步。

### 修复

- **原生引擎崩溃会让整个测试文件失败且丢失全部输出**（`tests/native-engine-options.test.ts`，v1.2.1 标签构建失败的根因）：该文件原先把断言写在测试进程内，只用一个「子进程探测」决定是否跳过。**探测与断言是两次独立执行、两个不同进程**，各自独立掷骰子——探测侥幸通过并不能保证随后同进程内的断言安全。Windows CI 上实测到 addon 的 `destroy()` 以 `0xC0000005`（`STATUS_ACCESS_VIOLATION`）终止进程：探测这一次通过、断言随后崩溃，于是整个文件被判失败，且 705ms 的缓冲输出全部丢失（表现为「文件级失败、零个用例、零行输出」）。现改为**引擎调用与断言全部只在子进程中进行**，逐用例回传结构化结果（`TEST <i> done|error <json>`，打点用 `fs.writeSync` 同步写，崩溃时不丢）；`finish()` 在**断言跑完的那一刻**立刻回传，`destroy` 作为其后独立的清理步骤——因为崩溃点正是 `destroy`。父进程对已回传结果的用例**逐条真实断言**（数值/字符串比较口径与原断言完全一致），无结果的用例带完整诊断（退出码 + 十六进制 + 崩溃点步骤）跳过；JS 层 setup 抛错仍判该用例**失败**（与原语义一致）。判定规则被刻意收紧为：**JS 可见的失败一律判失败，只有原生崩溃才跳过**——子进程注册 `uncaughtException` 处理器并把尚未回传的用例标记为 error，因此「addon 文件存在但无法加载（架构不符 / 损坏 / 依赖缺失）」这类真实故障**不会**被静默降级为跳过；原生访问违例不触发该处理器，故崩溃仍正确地走跳过路径。

### 新增

- `docs/release-process.md`：发布流程 SOP（可复制执行的命令 + 每步验收标准），固化三条本项目实际踩过的做法：①本地五项全量验证 → ②三平台 CI 全绿才打 tag（涉及 Windows 腿时连续 ≥3 次）→ ③打 tag 后**必做** `gh release edit vX.Y.Z --title "YanMusic vX.Y.Z Release"`。同时记录三个坑：`pnpm lint` 带 `--fix` 不可用于验证；PowerShell 会把 cargo 的 stderr 进度当错误（退出码须看 `$LASTEXITCODE`）；`concurrency: cancel-in-progress` 会让同 ref 的新 dispatch 取消正在跑的 run。README「编译发布」段加入指向该文档的链接。
- `tests/native-engine-options.test.ts` 新增「结构自检」用例：本文件不得在测试进程内加载原生 addon（用拼接串做针 + 剥离块注释，避免用例自身文案命中自己）。用例总数 112 → **113**。

### 变更

- **依赖例行更新（Dependabot，全部为 patch/minor）**：
  - `chore(deps): bump napi 3.12.0 -> 3.12.7`（PR #7，Rust，仅 lock；连带把 `napi-build` 解析到 2.5.0、`napi-sys` 到 3.3.2）
  - `chore(deps): bump napi-derive 3.6.2 -> 3.6.8`（PR #9，Rust，仅 lock）
  - `chore(deps): bump the npm-production group with 10 updates`（PR #12：`vue` 3.5.38→3.5.43、`axios` 1.18→1.20、`reka-ui` 2.9.10→2.10.4、`dompurify` 3.4.11→3.4.15、`marked` 18.0.5→18.0.13、`semver` 7.8.4→7.8.5、`@iconify/vue` 5.0.1→5.0.2、`@internationalized/date` 3.12.0→3.12.4、`@vue/runtime-core` 3.5.41→3.5.43、`yzs-keep-alive-v3` 0.1.2→0.1.4）
  - `chore(deps-dev): bump the npm-development group with 16 updates`（PR #11：`electron` 43.1.1→43.7.3、`electron-builder` 26.8.1→26.15.3、`vite` 8.0.14→8.3.0、`eslint` 10.4.1→10.11.0、`prettier` 3.8.3→3.9.8、`vue-tsc` 3.3.3→3.3.11、`tailwindcss` 4.3.0→4.3.3、`@typescript-eslint/*` 8.60→8.70 等）
  - **PR #10（`napi-build` 2.4.0→2.4.4）已关闭，未合并**：合并 #7 时 Dependabot 重建 lock 已把 `napi-build` 解析到 **2.5.0**（提交 `a3f18fe`），该 PR 的目标版本更低，落地只会把依赖**降级**，属已被取代。
- **`eslint` 计数基线变化（80 → 101 errors，0 warnings）——由工具升级导致，非代码回归**：逐文件核对证实，v1.2.1 基线已报错的 16 个文件**计数逐一相同**；新增的约 21 条分散在**本版未改动**的既有文件上，且 101 条中 79 条为 `prettier/prettier`，其文案为 prettier 3.9.x 改变的**联合类型折行偏好**（如要求把 `| 'idle'` 与 `| 'ready'` 并到一行），其余 22 条为 `@typescript-eslint` 的 `no-unused-vars`（11）与 `no-require-imports`（11）。消除它们需要**全仓重排格式**，不在本补丁版本范围内；本版改动的文件均为 0 错误。
- **`vite build` 产物数量变化（243 → 252 个文件）**：由 `vite` 8.0.14→8.3.0 与 `electron` 43.1.1→43.7.3 引起的 chunk 划分变化。产物完整性已校验：3 个 html 的 110 个本地引用中仅 1 处缺失，且为**历史遗留**的 Vite 模板 `/vite.svg`（v1.1.2 时代即存在，仓库无 `public/` 目录，与本版无关）；`MusicJournal` / `Settings` / `pluginWindow` / `main` 等关键 chunk 均正常产出。

### 说明

- 验证结果：`pnpm test` **113/113 通过**（0 失败 0 跳过，且引擎用例**真实执行而非跳过**）；`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0；`cargo check --workspace --release` 退出码 0；`eslint` 101 errors / 0 warnings（归因见「变更」；本版改动文件 0 错误）。
- **已知问题（重要，不夸大）：addon 的 `destroy()` 在 Windows CI 上触发 `0xC0000005`，本版未修复。** 该缺陷**早于本版**：v1.2.0 标签构建（2026-09-24 12:31）与同日 12:15 干跑的 Windows x64/arm64 腿均在同一位置崩溃并跳过；macOS-arm64 与本地 Windows 均正常。**本机无法复现**——5 种方法约 109 次执行 0 失败（原样探测脚本串行 30 次、改用 CI 同款 libmpv 后 20 次、4 并发 40 次、完整套件循环 15 次，以及定向调用序列与文件单独运行），并已排除 libmpv 版本差异（下载 CI 同款 `mpv-dev-x86_64-20260924-git-2a4eb8067c`，自报 `v0.41.0-1072-g2a4eb8067`，仍不崩）、addon 陈旧（本地 `.node` 晚于最新 Rust 源码且该 crate 自 09/22 无改动）、`@napi-rs/cli` 版本差异（crate 内有 `package-lock.json`，与本地同为 3.6.2）。**剩余主因判断为 CPU 微架构差异**：本机为 Intel i5-3230M（Ivy Bridge，仅 AVX1、无 AVX2/FMA），runner 为支持 AVX2/AVX-512 的现代 CPU，而 libmpv 有运行时 CPU 特性检测，本机不会执行 runner 上走到的 SIMD 路径。按「先复现再修复」的原则**未做盲修**（未改动任何 Rust 代码）。本版消除的是「该崩溃导致构建失败」这一**失败模式**，并把崩溃转为可诊断的跳过：Windows 腿仍有真实覆盖（用例 1 的 9 条断言在崩溃前已回传并逐条断言），用例 2-5 在 Windows CI 上将持续跳过。**后续排查路径**：在具备现代 CPU 的 Windows 机器上用探针循环复现并抓崩溃转储（WER LocalDumps / procdump），或比对不同 mpv-winbuild 资产以判定是否为特定构建的回归。**计划修复版本：待定。**
- **暂未升级的依赖（6 项，附原因与重启条件）**：
  - `actions/checkout` 4.4.0→7.0.1（#1）、`actions/upload-artifact` 4.6.2→7.0.1（#2）、`pnpm/action-setup` 4.3.0→6.1.0（#3）、`actions/setup-node` 4.4.0→7.0.0（#5）、`actions/github-script` 7.1.0→9.0.0（#6）：均为**主版本**跨越多代，可能改变输入语义，会直接影响 6 条构建腿与发布作业。**重启条件**：单独处理，并借助可干跑或 fork 演练的方式验证——`build.yml` 的 `release` job 受 tag 守卫保护、无法 `workflow_dispatch` 验证，尤其需要谨慎。
  - `mpris-server` 0.9.0→0.10.0（#4）、`cpal` 0.15.3→0.18.2（#8）：均为 **0.x 跨 minor**（semver 允许破坏性变更），且落在**原生音频采集 / 系统媒体控制**链路上（`cpal` 的 lock 依赖图变动较大）。本机无法做**运行时**验证（无音频采集设备、无 D-Bus/MPRIS 环境），仅 `cargo check` 与 CI 编译不足以排除行为回归。**重启条件**：具备可做「系统音频捕获 + MPRIS」真机冒烟验证的环境。
  - `vite-plugin-electron` 0.29.1→1.1.2（#13）、`vite-plugin-electron-renderer` 0.14.7→1.0.0（#14）、`pinia` 3.0.4→4.0.3（#15）：均为**主版本**（0.x→1.x 与 3→4），前者影响 Electron 构建管线、后者可能有 store API 破坏性变更。**重启条件**：单独立项评估破坏性变更清单。
- 已知的既有小瑕疵（非本版引入、未修）：`index.html` 引用了不存在的 `/vite.svg`（Vite 模板遗留，仓库无 `public/` 目录）；`native/yan-mpv-player/src/player.rs` 存在 1 条既有的 `dead_code` 警告。

## [1.2.1]

> 本次为**主题可用性修复 + 无障碍补齐 + 供应链加固 + 审计收敛**的补丁版本，**不含任何新功能**：修复 1.2.0 新交付的「听歌档案」在浅色主题下不可读的问题，并把同一类缺陷在全渲染层扫干净（共 5 个未定义 CSS 令牌 / 18 处引用 / 7 个文件）；为 2 处装饰性背景图补上缺失的替代文本声明；把 3 个 workflow 中 14 处第三方 Action 引用固定到 commit SHA；更正 README 的 Node 版本要求并补记「听歌档案」。顺便做了一次全仓审计：新增 8 项发现（4 项已修——其中 `N-03` 为部分修复、2 项经复现判定**不成立**并给出反证、2 项暂不处理），1.2.0 遗留的 9 项逐条复核后维持原判（理由见「说明」）。

### 修复

- **听歌档案在浅色主题下不可读**（1.2.0 新功能的可用性回归）：`src/renderer/views/MusicJournal.vue` 引用全仓从未定义的 `--text-primary` 与 `--accent`，`var()` 回退到为深色背景写死的 `#e8e8ea`，在浅色主题（`--surface-main-base: #f5f5f7`）上正文对比度仅 **1.12:1**（WCAG AA 正文要求 4.5:1），标题与正文几乎不可见；面板底色、边框、图表柱身另用 `rgb(255 255 255 / n%)` 等硬编码半透明色，在浅色底上呈整页白雾。现全部改用 `src/renderer/style.css` 既有令牌（`--text-main` / `--bg-card` / `--bg-info-card` / `--border-subtle` / `--control-*` / `--color-primary*` / `--row-selected-bg`），**未新增主题变量、未改模板与脚本逻辑**；「近似基线」的虚线斜纹标识（`color-mix(in srgb, var(--color-primary) 45%, transparent)`）按原样保留，仍与精确数据可区分。
- **渲染层 5 个未定义 CSS 令牌 / 18 处引用 / 7 个文件**（审计新发现 `N-01`，与第 1 条同类）：修好听歌档案后做全仓扫描，发现同类问题仍在别处存在。其中 **8 处为「无回退」引用**——`var()` 无法解析会让**整条声明失效**，颜色与边框完全不生效：`--border-main`（3 处，复选框边框整条失效）、`--color-red-500`（3 处，插件管理页错误色整条失效）、`--primary`（2 处，歌曲卡片高亮色整条失效），分别改为 `--control-checkbox-border`、`--state-danger`、`--color-primary`（前者在 `:root` 与 `.dark` 均有定义，两主题自适应）；另 10 处为回退到硬编码 `#ef4444` 的 `--color-danger`（9 处）与 `--color-error`（1 处），恒定颜色脱离主题令牌体系，统一改为 `--state-danger`。改动仅 18 行字面替换（`git diff --numstat` 逐项核对为 18 增 / 18 删），无格式化改动、无逻辑改动。
- **两个装饰性背景图缺少替代文本声明**（审计新发现 `N-03` 的 `<img>` 部分）：全渲染层共 13 个 `<img>` 标签，其中 `views/lyric/LyricPage.vue:264` 与 `views/lyric/PortraitMode.vue:309` 未声明 `alt`。二者都是封面模糊背景层（**纯装饰**），缺少 `alt` 时部分读屏器会退化为朗读 `src` 路径；按 WCAG 2.1 1.1.1 对装饰性图片的要求，显式声明 `alt=""` 而非补写文案。改动为 2 行属性新增，无视觉与行为影响。

### 新增

- `tests/music-journal-theme.test.ts`（5 例）：听歌档案主题回归守卫——令牌定义守卫（引用的令牌必须在 `style.css` 中存在）、**明暗双主题 WCAG AA 对比度断言**（按令牌实际取值计算正文与次级文字对比度）、硬编码颜色守卫、近似基线标识保留守卫。
- `tests/theme-token-consistency.test.ts`（4 例）：把上一条从「单页修复」升级为**全仓守卫**——渲染层不得引用未定义 CSS 令牌（正确区分「运行时注入（如 `applyAccentToRoot` 写入的 `--color-primary`）/ 库约定（`--reka-*`）/ 设计性覆盖点」三类合法例外）、**「无回退」的未定义引用必须为零**、危险色必须统一走 `--state-danger`、主题令牌体系自检。
- `tests/ci-supply-chain.test.ts`（3 例）：CI 供应链守卫——所有 `uses:` 必须固定到 40 位十六进制 commit SHA、必须带可读版本注释、本地 `./` 复合 Action 豁免。
- `tests/image-alt.test.ts`（3 例）：图片替代文本守卫——**每个 `<img>` 必须显式声明 `alt` / `:alt`**（装饰性图片写 `alt=""`，有意义的图片写文案，但不得两者都不给）、装饰性模糊背景层必须用空串、语料非空自检（防止正则失效导致守卫空转）。正则按**跨行标签**解析（`/<img\b[^>]*>/gs`），避免漏掉属性分行书写的写法。

### 变更

- **CI 第三方 Action 引用方式变更（`IMP-17`，1.2.0 遗留项）**：`build.yml` / `issue-ai-labeler.yml` / `issue-closer.yml` 共 **14 处** `uses:` 由 tag/branch 引用改为 commit SHA，并保留 `# vX` 版本注释。**影响**：Dependabot 的 `github-actions` 更新将改为提交 SHA 升级（注释同步），这是本次加固的预期行为；已核验 `# vX` 注释格式可被 `tests/ci-supply-chain.test.ts` 持续校验。
- **README 前置要求更正**：`Node.js 18+` → `20.19+ 或 22.12+`。原表述与依赖实际要求矛盾——`vite@8.0.14` 的 `engines` 为 `^20.19.0 || >=22.12.0`，按原文用 Node 18 执行 `pnpm dev` / `pnpm build` 会直接失败；同时标注 `pnpm test` 需 22.18+（依赖 Node 原生 TS 剥离），CI 打包用 20、测试用 24。
- **README 核心特性补记「听歌档案」**：该功能已在 1.2.0 上线（`src/renderer/router/index.ts:76-79`，路由 `/main/journal`）但未记入特性列表，现按实际能力补记（时间轴 / 周汇总 / 7-14-30-90 天窗口 / 情绪标注）。属文档一致性补正，**非新功能**。

### 说明

- 验证结果：`pnpm test` **112/112 通过**（1.2.0 为 97/97，本版新增 15 例且原有用例无回归）；`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0（`dist/` 产出 243 个文件，仍含 `MusicJournal` 独立懒加载 chunk）；`cargo check --workspace --release` 退出码 0（仅 1 条既有 `dead_code` 警告）；`eslint` 全量 **80 errors / 0 warnings**——与基线逐位持平（7 个「有改动且可 lint」的文件在基线与本版下单文件错误数完全相同，本版新增的 4 个测试文件 0 错误）。
- **审计发现中经复现判定「不成立」的 2 项（不修改代码）**：
  - `N-04`「macOS 系统音频捕获 `try_into().unwrap()` 存在 panic 风险」：`native/yan-spectrum-capture/src/backend/macos_sck.rs:802/816/830/845` 的 4 处 `try_into().unwrap()` **各自紧跟在显式长度检查之后**（`:799/813/827/842`），切片长度可证为 `N`，`unwrap` 不可达。**判定不成立**。
  - `N-05`「主进程 `fetch(` 调用缺少超时，可能永久挂起」：3 处调用**均已带中止机制**——`src/main/mediaControls.ts:79-80` 与 `src/main/plugins.ts:1124-1134` 均传入 `signal: controller.signal` 并在 `finally` 中 `clearTimeout`（后者还把 `AbortError` 映射为超时错误信息），`src/main/networkPolicy.ts:161` 为透传包装，超时由调用方的 `init` 决定。**判定不成立**。
- **暂不处理的审计发现（2 项完全搁置，另 1 项部分搁置；附原因与重启条件）**：
  - `N-02` **`index.html` / `desktop-lyric.html` 缺少 CSP**（仅 `plugin-window.html` 有）：**原因**：二者均以 `webSecurity: false` 运行，且渲染层存在大量内联样式与运行时注入（主题色 `<style>`、`style-src 'unsafe-inline'` 需求），本机无 GUI 无法验证收紧后是否造成回归，盲改有「白屏」风险且无法验证。**重启条件**：可在本地 GUI 环境逐窗口验证 CSP 收紧（先 `Content-Security-Policy-Report-Only` 观测）。
  - `N-03` **无障碍属性缺失**（**`<img>` 部分已在本版修复**，见「修复」）：全渲染层 13 个 `<img>` 中缺 `alt` 的 2 处已补 `alt=""` 并加了守卫；**仍搁置的是 `aria-*` / `role` 的批量补齐**——`src/renderer` 下 144 个 `.vue` 文件中仅 33 个使用了 `aria-*` / `role`。**原因**：与 `alt` 不同，`aria-*` / `role` 的正确性与具体组件的可访问性语义强绑定（列表/表格/对话框/树形控件的角色、焦点管理与键盘交互需成体系设计），本机无法用屏幕阅读器验证，批量添加属性属于无法验证的高风险盲改。**重启条件**：引入可自动化的 a11y 检查（如 axe）纳入 CI 守卫，再按组件逐类补齐。
  - `N-07` **巨型文件拆分**（`src/` 下 **38** 个源文件超过 800 行，其中 5 个超过 2000 行，最大 `src/main/plugins.ts` 3362 行）：同 1.2.0 的 `IMP-07` 判断，属重构而非修复，不适合放进补丁版本。**重启条件**：单独立项并配套回归测试。
- **1.2.0 遗留 9 项的复核结论**：`IMP-01`（4 类窗口共用同一 preload，且 mini 播放器与主窗口加载同一份 bundle，白名单收口会误伤）、`IMP-03`（当时无法核实插件索引 `checksum` 覆盖率）、`IMP-05`（`webSecurity` 关闭属产品级取舍）、`IMP-07`、`IMP-09`（`server` 子模块无 `package-lock.json`，mpv 资产需联网核实 SHA-256）、`IMP-10`（代码签名证书为外部采购条件）、`IMP-11`（无 keyring 时的降级交互需产品决策）、`IMP-16` 的 husky/lint-staged 部分（需新增依赖）——**逐条复核后维持原判**，理由不变。本版落地的只有 `IMP-17`（见「变更」）。
## [1.2.0]

> 本次为**安全审计复核 + 原生层健壮性修复 + 新功能**版本：按「先复现、再修复」的原则对此前审计的 P0/P1 结论逐条复核，**其中一条 P0 结论经复现后被判定不成立并已更正**；修复了 4 个可复现的原生层 / 构建链 / 安全策略缺陷；把单元测试接入 CI；并交付**新功能「听歌档案」的完整版**（本地时间轴 / 年度回顾 / 时段与情绪聚类 / 导出分享）。同时对上一版未处理的审计项做了「能修就修」的收敛，实际修复 6 项、搁置 8 项（理由见「说明」）。

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
- **插件可在生产环境关闭 TLS 证书校验**（`IMP-13`）：`src/shared/plugins.ts:376-381` 的 `PluginNetworkTlsOptions.rejectUnauthorized` 由插件直接声明，`src/main/plugins/network.ts` 据此创建 `HttpsAgent`，即打包版本中插件可让应用对目标站点不做证书校验（中间人可篡改响应）。现新增 `checkPluginTlsPolicy()` / `isPluginTlsRelaxationAllowed()`：仅**未打包的开发模式**允许放宽，生产环境抛 `PluginNetworkRequestError`；未声明、显式 `true`、仅改 SNI 一律放行（既有行为不变），且只把严格等于 `false` 视为放宽。
- **顶层导航完全没有拦截**（`IMP-12`）：`src/main` 全目录此前无 `will-navigate`，在 `webSecurity: false` 前提下渲染层一旦被导航（注入链接、脚本改 `location`）就会加载任意页面，而该页面仍持有 preload 的全部能力。现新增 `src/shared/navigationPolicy.ts`（fail-closed 纯策略）并在 `src/main/app.ts` 既有的 `web-contents-created` 钩子内注册 `will-navigate`，覆盖主窗口 / 桌面歌词 / mini 播放器 / 插件窗口全部 webContents；仅放行 `file:` / `about:` / dev server 同源。
- **`.gitignore` 整目录忽略 `build/`**（`IMP-15`）：`.gitignore:5` 的 `build/` 会忽略 `afterPack.js`、`installer.nsh`、`icons/`、`tools/` 等构建必需资产，它们此前仅靠历史上 `-f` 强制添加才得以跟踪，新增的构建脚本会被静默漏提交。现改为 `build/mpv/`（只排除随构建放入的大体积 libmpv 运行时目录）。

### 新增

- `tests/plugin-package-extraction.test.ts`：插件安装包解压的 zip-slip 回归守卫（8 个逃逸型 entry 名必须被拒绝、正常包必须可解压、应用侧不得关闭 entry 名校验）。
- `tests/music-journal.test.ts`、`tests/music-journal-aggregate.test.ts`、`tests/music-journal-mood.test.ts`、`tests/music-journal-view.test.ts`、`tests/music-journal-share.test.ts`：听歌档案的 33 个纯逻辑用例（含「导出未新增 IPC 通道」的静态守卫）。
- `scripts/repro-native-nul-panic.cjs`、`scripts/repro-zip-slip.cjs`、`scripts/verify-afterpack-guard.cjs`：三个可复现的取证/验证脚本。
- CI 新增 `Run unit tests` 步骤（`pnpm test`），位置在原生模块与 libmpv 就位之后、打包之前——只有在此处运行，`tests/native-engine-options.test.ts` 的「选项真实到达 libmpv」端到端断言才会真正执行而非自动跳过。
- `src/shared/archiveEntry.ts`：第一方 entry 名安全校验（与 `node-stream-zip` 同规则，额外拒绝含 NUL 的名称），并在 `src/main/plugins.ts` 解压前做兜底——依赖被降级 / 替换 / 误开跳过名校验时仍有防护。
- `.github/dependabot.yml`：Dependabot 覆盖 npm / cargo / github-actions 三生态（`IMP-16`）。未添加 `server/` 条目（该目录是 git submodule，Dependabot 不支持）。
- `tests/plugin-tls-policy.test.ts`（5 例）、`tests/share-web-endpoint.test.ts`（7 例）、`tests/navigation-policy.test.ts`（6 例）、`tests/ipc-channel-contract.test.ts`（5 例）、`tests/plugin-archive-entry.test.ts`（8 例）：本版新增的 31 个纯逻辑 / 契约用例，其中 IPC 通道契约测试覆盖通道命名约定、handler 无重复注册、关键通道存在、preload 调用的通道在主进程均有注册（无断链）、外部注册清单不腐烂。

### 变更

- **新增对外项（听歌档案）**：新增 KV 持久化键 `pinia:musicJournal`（复用既有 `storage:kv` 通道与 `sqlitePersist` 机制）；新增路由 `/main/journal`（name `journal`）与侧边栏「听歌档案」入口。**未新增 IPC 通道、未新增存储表、未改动任何既有键名或文件格式、未引入任何新依赖**。
- **审计结论更正（重要）**：此前审计把「插件包解压存在 zip-slip 路径穿越」列为 P0。经复现，该结论**不成立**：所用 `node-stream-zip@1.16.0` 在读取中央目录时默认调用 `ZipEntry.validateName()`（`node_stream_zip.js:900-904`），其正则 `/\\|^\w+:|^\/|(^|\/)\.\.(\/|$)/` 会拒绝反斜杠、盘符前缀、绝对路径与 `..` 段；应用未设置 `skipEntryNameValidation`，防护处于生效状态。8 个逃逸变体实测全部被 `Malicious entry` 拒绝，仅 `....//` 与 `%2e%2e/` 被接受，而它们是**普通文件名**（不构成逃逸）。本版不修改解压逻辑，改为把这一「已核实为安全」的性质固化为回归测试。
- **构建行为变更**：`afterPack` 现在会在关键资源缺失时让构建失败。此前「缺资源也能出包」的构建结果将不再出现——这是本次修复的目的，但会改变 CI 的失败面。
- **错误语义变更**：向播放引擎下发含 `\0` 的字符串，行为由「进程崩溃」变为「抛出可捕获的 JS 错误」。合法输入的行为完全不变（已由 `tests/native-engine-options.test.ts` 的真实引擎回读用例覆盖）。
- **分享落地页域名切换（行为变更，`IMP-14`）**：`SHARE_WEB_BASE_URL` 由上游 Pages（`hoowhoami.github.io/yanmusic/share/`）改为自有 Pages（`mmlwryan.github.io/YanMusic/share/`）；新增 `LEGACY_SHARE_WEB_BASE_URLS`，**旧域名仍可解析**，已分发出去的旧分享链接不会失效。**使用前提：GitHub Pages 需配置为从 `docs/` 目录发布**（仓库内已有 `docs/share/index.html` 与 `docs/.nojekyll`）；若该地址不可用，新生成的分享链接将无法打开。
- **插件 TLS 行为变更（`IMP-13`）**：插件声明 `tls.rejectUnauthorized: false` 在**打包版本**中会被拒绝并抛出错误；未打包的开发模式下仍可用于调试。
- **顶层导航行为变更（`IMP-12`）**：应用各窗口的顶层导航被限制为 `file:` / `about:` / dev server 同源，其余一律阻止并记录日志。`webContents.loadURL()` / `loadFile()` 不触发该事件，窗口创建期加载与 SPA 路由切换不受影响。

### 说明

- 验证结果：`pnpm test` **97/97 通过**（原 30 个用例无回归 + zip-slip 守卫 3 例 + 听歌档案 33 例 + 本版新增 31 例）；`vue-tsc --noEmit` 退出码 0；`vite build` 退出码 0（`dist/` 产出 243 个文件，含 `MusicJournal` 独立懒加载 chunk）；`cargo check --manifest-path native/yan-mpv-player/Cargo.toml --release` 退出码 0，addon 已重编译；`eslint` 全量 **214 errors / 5 warnings**（与 `HEAD` 基线逐位相同，本版新增文件 0 错误）。
- **听歌档案的数据可用性说明（重要，不夸大）**：逐次播放事件**从本版起才开始精确采集**。升级前的播放只能以「近似基线」呈现（每曲一条、时间取最后一次播放、次数按历史累计），因此**首次打开档案时的时间轴分布是近似的**，随时间推移会逐步被精确事件取代。含近似数据的日子在视图中以虚线柱与文字说明标识。
- `scripts/verify-afterpack-guard.cjs` 采用对照实验取证：HEAD 版本的 `afterPack` 在缺少全部关键资源时**不抛错**（复现原缺陷），修复后同一场景抛错并列出 6 项缺失、资源齐备时不误报。
- **暂未处理的审计项（已知问题，附原因与重启条件）**：
  - **`IMP-01` IPC 通道无白名单且不校验发送方**：`src/preload/index.ts:283-296` 向渲染层暴露通用 `ipcRenderer.send/invoke/on/off`，`src/main/ipc/registry.ts:26,79` 不校验 `event.senderFrame`。**原因**：只读审计发现两个结构性障碍——① 4 类窗口共用**同一个 preload**（`window.ts:360`、`desktopLyric/window.ts:142`、`pluginWindows.ts:230`、`miniPlayer.ts:473`），typed helper 面对所有窗口完全相同；② **mini 播放器加载的是 `dist/index.html`（`miniPlayer.ts:231`），与主窗口（`window.ts:362`）是同一份 bundle**，二者在「可用通道集合」上不可区分。因此「窗口 × 通道」矩阵中存在大量无法判定的等价格，按白名单收口会误伤现有调用。**重启条件**：把 mini 播放器拆成独立入口（或按 `webContents.id` + 路由显式声明允许集），并迁移渲染层 22 处裸 `ipcRenderer` 调用点。
  - **`IMP-03` 插件包完整性校验为可选**：`src/main/plugins.ts` 仅在市场索引提供 `checksum` 时才校验。**原因**：本机无法访问索引（`web_fetch` 报 hostname 解析到非公网 IP），无法核实真实索引是否已提供该字段；若强制必填而索引未提供，会导致该插件源**所有插件无法安装**。**重启条件**：联网核实 `echo-plugins.json` 的 `checksum` 覆盖率（或推动插件源补齐该字段）。
  - **`IMP-05` `webSecurity: false` / `allowRunningInsecureContent: true` / Windows `no-sandbox`**：`src/main/window.ts:400-401`、`src/main/index.ts:22`。**原因**：属产品级取舍——`window.ts:400` 注释自述为「禁用 CORS 限制」，关闭它还影响封面图/媒体资源的跨域加载路径，收敛需先明确哪些请求可改走主进程 `api:request`，属产品决策而非缺陷修复。**重启条件**：维护者确认 `webSecurity` 关闭的真实业务依赖清单。
  - **`IMP-07` 巨型文件拆分**（`src/main/plugins.ts` 3027 行、`runtime.ts` 2665 行、`listenTogether.ts` 2541 行等）：**原因**：属重构而非修复，改动面大且无行为收益，不适合放进补丁版本。**重启条件**：单独立项并配套回归测试。
  - **`IMP-09` 构建可复现性**：mpv 二进制从第三方最新 release 下载且无校验；`server` 依赖用 `npm install --legacy-peer-deps`。**原因**：① `server/package-lock.json` **不存在**（该子模块只有 `pnpm-lock.yaml`），`npm ci` 会直接失败，而上游 lockfile 同步需在子模块仓库修复；② mpv 固定到具体 release tag + SHA-256 需联网核实，伪造会导致 Windows 构建腿失败。**重启条件**：联网核实 mpv release tag 与资产 SHA-256；在 `server` 子模块补齐 `package-lock.json`。
  - **`IMP-10` 代码签名 / 公证**：`build.yml:500` 显式 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`。**原因**：需要 Windows 代码签名证书与 Apple 开发者账号（外部采购条件）。**重启条件**：具备证书与公证凭据。
  - **`IMP-11` 用户凭据加密落盘**：`src/main/storage/kv.ts:19` 明文 JSON 写入 SQLite；`safeStorage` 目前仅用于代理密码（`src/main/networkSettings.ts:46-52`）。**原因**：合规的降级路径要求「提示用户 + 拒绝保存 token」，而「提示」需要新增 IPC 通道与设置页 UI（补丁版本不宜新增通道）；若改为静默丢弃 token，会导致无 keyring 的 Linux 用户重启后静默掉登录，属未确认的 UX 退化。**重启条件**：确定 Linux 无 keyring 时的用户可见降级交互（需产品决策 + 允许新增通道）。
  - **`IMP-16` 的 husky / lint-staged 部分**：**原因**：`husky` 与 `lint-staged` 均需新增 devDependency，且本机当时无网络无法安装。已交付的部分是 `.github/dependabot.yml`（纯配置，无依赖）。**重启条件**：允许新增这两个 devDependency 并联网安装。
  - **`IMP-17` CI 第三方 Action 未固定 commit SHA**：`build.yml` 共 10 处 `uses:` 全部为 tag/branch 引用（含 `dtolnay/rust-toolchain@stable`）。**原因**：固定 SHA 需要各 Action 对应 tag 的真实 commit SHA，本机当时无法访问 GitHub（`git ls-remote https://github.com/actions/checkout` 报 SSL 证书校验失败，exit 128）且无本地缓存；**伪造 SHA 会导致 CI 无法解析 action、6 个构建腿全部失败**。**重启条件**：联网查询各 Action 对应 tag 的 commit SHA。
  - **仓库 lint 基线为红**：`HEAD` 上即有 **214 errors / 5 warnings**（集中在 `tests/native-engine-options.test.ts` 134 项等）。本版未引入新的 lint 错误（总数逐位持平，新增文件 0 错误），但因此**未把 lint 接入 CI**。**重启条件**：先做一次独立的仓库级格式化。**已在 1.2.3 完成**——lint 已接入 CI，基线 0 error / 0 warning。
  - **跨平台 CI 预验证未执行**：当时无法访问 GitHub（`git ls-remote` 报 SSL 证书校验失败）且无 `gh` CLI 与发布凭据，三平台 `workflow_dispatch` 预验证与 tag 触发发布均未执行。**后续版本已由真实 runner 验证**。**注意**：本地仅能验证 Windows，Linux / macOS 必须由真实 runner 验证。

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
- 继续保留：插件市场索引文件名 `echo-plugins.json`、上游插件源仓库地址与统计 Worker 域名、Cloudflare 已部署资源名，以及应用内 GPL 致谢与修改声明（`src/renderer/constants/legal.ts`）。

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