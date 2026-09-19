# 阶段 0 — 基线复核报告

> 生成时间：2026-09-19
> 权威基线：`C:\coding\yanmusic-agent`（`git clone https://github.com/MmlwrYan/YanMusic.git`）
> HEAD：`68b8410` "YanMusic README"，`git rev-list --count HEAD` = **12**（与任务书所述一致）
> 子模块 `server`：已固定到父仓库记录 commit `99ca12fb9d464e9cf1e893a4f967a6024885336b`（KuGouMusicApi v1.6.2，217 个 API 模块）

---

## 0. 基线获取过程（含环境障碍与处置）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 原始工作目录 | `git -C C:\coding\YanMusic rev-parse --is-inside-work-tree` | `fatal: not a git repository` → **不是 git 仓库**，按任务规则 clone 权威基线 |
| clone（默认 schannel） | `git clone https://github.com/MmlwrYan/YanMusic.git` | ❌ `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` |
| clone（openssl 后端） | `git -c http.sslBackend=openssl clone ...` | ✅ 成功 |
| 子模块 | `git submodule update --init --recursive` | ❌ `sh.exe: fatal error - couldn't create signal pipe, Win32 error 5`（沙箱命名管道限制） |
| 子模块替代路径 | `git -c http.sslBackend=openssl clone --depth 1 <KuGouMusicApi> server` + `git checkout 99ca12f` | ✅ 成功，`git status` 干净 |

> `[自主决策]` 子模块：`git submodule` 因沙箱禁止命名管道而不可用，改为「直接 clone 子模块仓库 + 检出父仓库记录的 SHA」。选择理由是**结构等价**（工作树内容与 `git submodule update` 一致，且父仓库 `git status` 保持干净），而非绕过任何策略。

环境事实（供复现参考）：
- 沙箱 `workspace-write` 模式下**禁止管道 stdio**：`node -e "execSync(...)"` → `EPERM`；`stdio:'inherit'` → 正常。`pnpm install` 因此首次失败（`spawn EPERM`），权限放宽为 `danger-full-access` 后成功（`Done in 1m 23.3s using pnpm v10.34.5`）。
- Node `v24.9.0`、pnpm `v10.34.5`、git `2.55.0.windows.5`、cargo 位于 `C:\Users\admin\.cargo\bin\cargo.exe`。

---

## 1. R1 —「node_modules 全量断链」复核

### 结论：**`[旧报告误判]` 成立（该结论不是仓库属性，而是某个本地副本的产物）**

| 检查对象 | 命令 | 实测结果 |
|---|---|---|
| 仓库是否提交 node_modules | `.gitignore` 含 `node_modules/`；`git ls-files \| wc` 中无依赖目录 | **仓库不提交依赖**（3466 个受版本控制文件） |
| 权威 clone 安装后链接完整性 | 统计 `node_modules` 下 junction/symlink，并逐个 `Test-Path <target>` | **total links = 326，stale = 0** |
| 关键包可解析性 | `Test-Path node_modules\<pkg>\package.json` | `vue` ✅ `electron` ✅ `vite` ✅ `typescript` ✅ `vue-tsc` ✅ |
| 安装命令退出 | `pnpm install` | ✅ `Done in 1m 23.3s` |
| server 依赖 | `cd server; npm install` | ✅ `added 311 packages`；`axios/express/form-data/crypto-js/pako/node-forge/qrcode/big-integer/dotenv` 全部存在 |

**反证**：旧报告描述的现象只出现在 `C:\coding\YanMusic` 这一份工作副本中（263/263 junction 指向 `C:\coding\YanMusic\YanMusic-main\node_modules\.pnpm\...` —— 该路径多出一层 `YanMusic-main`，说明 **`pnpm install` 在目录还叫 `YanMusic-main` 时执行、之后目录被改名**，绝对路径 junction 因此全部悬空）。这是**副本的目录改名事故**，不是仓库或代码的问题，按任务规则**不得据此改动任何代码**。

---

## 2. R2 —「mpv 设置读了错误键导致永不生效」复核

### 结论：**键名不匹配在 HEAD 上确实存在（代码层确定性）**；GUI 端到端实测未完成，故标注为「高置信静态结论 + 存储层实测复核」

**读取侧**（`src/main/mpv/controller.ts:257-274`，与 HEAD 完全一致）：

```ts
const { getKvStorage } = await import('../storage/kv');
const storage = getKvStorage();
const cacheSecs = (await storage.get('audioCacheSecs')) ?? 30;
const demuxerMaxMb = (await storage.get('audioDemuxerMaxMB')) ?? 48;
const demuxerBackMb = (await storage.get('audioDemuxerBackMB')) ?? 12;
const audioBufferSecs = (await storage.get('audioBufferSecs')) ?? 0.5;
this.addon.initialize(this.libmpvPath, { cacheSecs, demuxerMaxMb, demuxerBackMb, audioBufferSecs, ... });
```

**写入侧**（渲染层设置持久化）：`src/renderer/stores/sqlitePersist.ts:89`

```ts
const storageKey = `pinia:${store.$id}`;   // setting store → "pinia:setting"
```

**全仓检索**（`audioCacheSecs|audioDemuxerMaxMB|audioDemuxerBackMB|audioBufferSecs`，共 22 处命中）：
- 读取：仅 `controller.ts:261-264`（裸键）
- 定义/UI 写入：`stores/setting.ts:173-176`、`views/settings/components/PlayerSettingsSection.vue`、`PlaybackSettingsSection.vue`（均写 pinia state，最终落到 `pinia:setting`）
- **没有任何代码写入裸键** `audioCacheSecs` / `audioDemuxerMaxMB` / `audioDemuxerBackMB` / `audioBufferSecs`

**同目录下的正确范式**（说明这是遗漏而非设计）：`src/main/networkSettings.ts:56,72` 使用 `getPersistedRendererSettings()` 读取 `pinia:setting` 整对象。

**实测复核**：见 `docs/agent/01-build.md` §「R2 存储层实测」——使用**真实编译产物 `yan-storage.node`** 写入 `pinia:setting` 后再按 `controller.ts` 的读法读取，验证读取结果为 `null`。

---

## 3. R3 —「9 个设置项只存不生效」复核

### 结论：**静态引用缺失确认（10 个键，其中 2 个为扫描假阳性）**；性质为「静态不可达」，GUI 实测未做 → 标注 `[待实测确认]`

扫描方法：取 `stores/setting.ts` 中 `^\s{4}(key):` 形式的 state 键全集（**106 个**），排除 `setting.ts` 自身与 `views/settings/**` 后全仓 `Select-String`。

零引用键（10 个）及判定：

| 键 | 判定 |
|---|---|
| `checkPrerelease` | **假阳性** — 在 `setting.ts` 的 `checkForUpdates()` 内被消费（已接线） |
| `lyricFont` | **假阳性** — 在 `setting.ts` 的 `buildLyricFontFamily()` 内被消费（已接线） |
| `audioSamplerate` | 静态零引用 |
| `audioChannels` | 静态零引用 |
| `audioFormat` | 静态零引用 |
| `gaplessAudio` | 静态零引用 |
| `demuxerReadaheadSecs` | 静态零引用 |
| `cachePause` | 静态零引用 |
| `cachePauseWaitSecs` | 静态零引用 |
| `lyricArtistBackdrop` | 静态零引用（`PortraitMode.vue` 走 `useLyricPortrait.ts` 自带逻辑，不读该开关） |

**加强证据（静态不可达证明）**：枚举 `src/main/mpv/controller.ts` 中所有作用于 mpv 的调用点（40 处 `addon.*` / `getAddonOrThrow().*`），可得唯一能影响 mpv 配置的通道为：
1. `initialize(...)` — 只接收 `cacheSecs / demuxerMaxMb / demuxerBackMb / audioBufferSecs / networkTimeoutSecs / httpProxy`
2. `setNetworkTimeout` / `setHttpProxy`（来自 `networkSettings`）
3. 播放控制类：`loadFile / play / pause / stop / seek / setVolume / setSpeed / setAudioDevice / setAudioFilter(Async) / setVolumeGain / setEq→af / setImpulseResponse→af / setLoopFile / setExclusive / setMediaTitle / afCommand / fade 系列`
4. 通用逃生口 `command('set_property', prop, value)` — **只路由 8 个固定属性名**（`force-media-title` / `audio-exclusive` / `audio-device` / `pause` / `volume` / `speed` / `aid` / `af`），其余属性名**静默不做任何事**（`controller.ts:525-559`）

⇒ 上述 8 个调优项**不存在任何可达路径**能影响 mpv。这是确定性静态结论，不是「可能没接」。
**按任务规则**：仍不将其表述为「用户可感知的功能失效」，标注为「静态引用缺失 / 静态不可达，**待 GUI 实测确认**」；本环境未完成 GUI 端到端实测。

---

## 4. R4 —「EQ 段数」复核

### 结论：**以代码为准为 10 段；README 写 18 段 → 文档与实现不一致（低优先级），不是 bug**

| 证据 | 位置 | 内容 |
|---|---|---|
| 频点表（长度 10） | `src/main/mpv/controller.ts:846` | `[60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]` |
| 增益数组（长度 10） | `src/renderer/stores/player/state.ts:19` | `[0,0,0,0,0,0,0,0,0,0]` |
| 重置逻辑（10 个 0） | `src/renderer/components/player/EffectPopover.vue:85` | `player.setEq([0,0,0,0,0,0,0,0,0,0])` |
| 主进程默认（长度 10） | `src/main/mpv/controller.ts:144` | `Array(10).fill(0)` |
| README 声明 | `README.md:37,53` | 「**18 段**参数化 EQ」 |

10 个频点 ↔ 10 个增益自洽（实现内部一致）。附带观察（非本次任务范围）：`setEq()` 不校验数组长度，若将来传入 >10 个增益，`freqs[i]` 会变成 `undefined`，生成非法滤镜串 `equalizer=f=undefined:...`。

---

## 5. README / 文档 vs 代码 不一致清单

| # | 项 | README 声明 | 代码/仓库实际 | 性质 |
|---|---|---|---|---|
| D1 | Electron 版本 | 徽章 `43.1.1`（L12）**但技术栈文字写 `Electron 42.3`**（L59） | `package.json` devDependency `electron: 43.1.1` | 文档自相矛盾 |
| D2 | 持久化方案 | `Pinia + pinia-plugin-persistedstate`（L62） | 实际为自研插件 `src/renderer/stores/sqlitePersist.ts`（`pinia.use(sqlitePersistPlugin)`）；`pinia-plugin-persistedstate` **不在依赖中** | 文档失实 |
| D3 | EQ 段数 | 18 段（L37、L53） | 10 段（见 §4） | 文档失实 |
| D4 | Linux wrapper 脚本 | L91-92 引用 `build/linux-libmpv-env.sh`、`build/linux-system-electron-wrapper.sh` | **两文件在仓库中均不存在**（`build/` 仅 `icons/`、`mpv/README.md`、`tools/gen-icons.mjs`、`afterPack.js`、`installer.nsh`） | 死引用 |
| D5 | 原生 addon 清单 | L70-72 只列 3 个（`yan-mpv-player` / `yan-media-controls` / `yan-storage`） | 实际 **4 个**，漏 `yan-spectrum-capture`（WASAPI/ALSA/ScreenCaptureKit 频谱捕获） | 文档不全 |
| D6 | ~~提交文件编码乱码~~ | — | **经复核为误判，已撤回**：早期观察到的「乱码」（`.gitignore`、`build/afterPack.js`、`native/*/.cargo/config.toml` 的中文注释）实为 **PowerShell 控制台以 GBK 渲染 UTF-8 文本**造成的显示假象。用 UTF-8 感知方式读取后，这些文件的中文注释**完全正常**（例：`.gitignore:16` = `# 需单独下载的大体积二进制（libmpv，随构建放入 build/mpv/）`；`build/afterPack.js:4` = `职责：保证原生模块（napi .node）与 libmpv 运行时在打包产物中可用，`）。**不是仓库缺陷。** | **误判（已撤回）** |
| D7 | 插件公共类型命名 | — | 仍为 `EchoPluginManifest` / `EchoPluginDescriptor` / `EchoPluginContext` 等（阶段 2 B 档处理） | 阶段 2 范围 |

> 说明：D4 的 `build/` 目录**部分受版本控制**（22 个文件被 track，尽管 `.gitignore` 含 `build/`），因此 `icons/`、`afterPack.js`、`installer.nsh` 在仓库内可用；缺失的只有 README 声称的两个 Linux wrapper 脚本。

---

## 6. `[旧报告误判]` 清单（本阶段汇总）

| 旧报告结论 | 本次实测 | 判定 |
|---|---|---|
| 「node_modules 全量断链」→ 暗示项目无法构建 | 权威 clone 中 326 链接 **0 失效**；`pnpm install` 成功 | **`[旧报告误判]`**（描述的是某个被改名的本地副本，非仓库） |
| 「无法构建 / 启动会崩溃」 | 见 `01-build.md`（构建链路实测） | 见阶段 1 |
| 「mpv 设置永不生效」 | 键名不匹配**在代码层确实存在** | **部分成立**（详见 §2；性质为「设置未接通」而非「构建/启动故障」） |
| 「9 个设置项只存不生效」 | 静态零引用确认，其中 2 个为假阳性；8 个静态不可达 | **部分成立**，但按规则降级表述为「静态引用缺失 / 待实测确认」（详见 §3） |
| 「EQ 实际 10 段而 README 写 18 段」 | 完全属实 | **成立**，但性质为**文档问题**，非 bug（详见 §4） |

**严格遵守的约束**：本阶段未以「修复构建 / 启动」为由改动任何生产代码。仓库工作树在阶段 0 结束时仅新增 `docs/agent/**`。

---

## 7. 阶段 0 验收自检

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| 当前目录/克隆是有效 git 仓库 | `git rev-parse --is-inside-work-tree` = `true` | `true`（`C:\coding\yanmusic-agent`） | **PASS** |
| 能读到 package.json / README / CHANGELOG | 三文件存在且可解析 | 均存在；`package.json` JSON 解析成功（v1.1.0） | **PASS** |
| R1–R4 均有客观结论 | 每项含「实际状态 + 是否旧报告误判 + 证据」 | §1–§4 全部给出，附命令与输出 | **PASS** |
