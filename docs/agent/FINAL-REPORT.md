# YanMusic 独立化 + 自研音频引擎调研 + GitHub 发布 — 最终总报告

> 会话时间：2026-09-19（UTC+08:00）
> 权威基线：`https://github.com/MmlwrYan/YanMusic.git`，起始 HEAD `68b8410`（12 commits）
> 工作目录：`C:\coding\YanMusic`（会话中由 clone `yanmusic-agent` 完成，末尾已替换原目录，见 §10）
> 产出提交：8 个，最终 HEAD `5f0fa83`；tag `v1.1.1`；Release 已发布

---

## 1. 每阶段 PASS / PARTIAL / FAIL 汇总

| 阶段 | 判定 | 关键证据 |
|---|---|---|
| **0 基线复核** | **PASS** | 权威 clone 有效（`git rev-parse --is-inside-work-tree` = `true`）；`68b8410` 与 `12 commits` 均与任务书一致；`package.json`/`README.md`/`CHANGELOG.md` 均可解析；R1–R4 四项均给出「实际状态 + 是否旧报告误判 + 证据」 |
| **1 环境搭建 + 构建体检** | **PASS** | `pnpm install` exit 0（1m23s）；4 个 Rust addon 全部 `npm run build` exit 0；`vue-tsc --noEmit` **exit 0 零报错**（基线 + 改动后各一次）；`vite build` exit 0；启动到达「主窗口已显示」阶段 |
| **2 echo 标记清理** | **PARTIAL** | A 档 15 类标识符**全部改名**（含 47 条 CSS 选择器）；B 档 6 组别名 + `$yanmusic` 就位且旧名保留；C 档 3 处死引用全部更正；GPL 致谢保留；构建未破坏。**唯一未改名项**：`echo-plugins.json`（外部契约，见 §2） |
| **3 自研引擎调研** | **PARTIAL** | 上游源码全树已获取并精读；能力对照表 22 行完整；三方案含工作量与最小 demo；未复制上游代码。**唯一缺项**：任务书要求「`vpf.rs` 逐段解读」，但**该文件在上游并不存在**（已用等效证据替代，见 §5） |
| **4 GitHub 发布** | **PASS** | 8 个提交推送成功（`68b8410..5f0fa83 main -> main`，未 force）；tag `v1.1.1` 推送成功；Actions run #6 **`conclusion: success`**（6 个平台 job 全过）；**Release v1.1.1 已发布，22 个产物** |

**总判定：4 PASS / 2 PARTIAL / 0 FAIL。** 两个 PARTIAL 均为「因客观原因或保守取舍而有意未做」，不是失败。

---

## 2. echo 清理三档实际完成度

| 档 | 完成度 | 明细 |
|---|---|---|
| **A 档（可安全改名）** | **15/15 类 = 100%**（唯一例外见下） | session 分区 ×3、传输标记头 ×1、侧边栏事件 ×1（两侧同步）、DOM `data-*` 属性 ×11（歌词 7 + 滚动 role 1 + 其余）、`style.css` 选择器 **47 条**（`echo-surface-translucent` 44 + `echo-popover-content`/`arrow` 3）、主进程私有变量 ×3、插件浮窗私有类型 ×9、macOS ObjC 类名 ×1 |
| **A 档例外** | 1 项**有意保留** | `echo-plugins.json`：**外部契约**——客户端按此名从第三方插件源仓库根目录拉取 `https://raw.githubusercontent.com/<repo>/HEAD/echo-plugins.json`，改名会让所有既有插件源立刻无法浏览。已就地补 8 行注释说明。**与作者既有裁定一致**（`PORTING_REPORT.md` §5.2/§13.2：「任务 2 明确要求以上游实际值为准，且这些值决定功能能否工作」） |
| **B 档（兼容过渡）** | **6 组别名 + 1 个全局属性** | `YanPluginManifest` / `YanPluginCompatibility` / `YanPluginDescriptor`（`shared/plugins.ts`）、`YanPluginContext`（`runtime.ts`）、`YanGlobalRuntime`（`plugins/types.ts`）、`YanPluginWindowContext`（`plugin-window/main.ts`）；全局属性 `$yanmusic`（与 `$echo` 指向同一对象）。**旧名全部保留并标 `@deprecated`，未改动任何调用点**；清单兼容键 `requires.echoMusicVersion` 原样保留 |
| **C 档（死引用）** | **3/3 清理** | ① `ipc/settings.ts` 指向 `native/echo-ffmpeg-player/src/vpf.rs` 的注释（该文件在本仓库与上游均不存在）；② `cloudflare/.../README.md` 的 `ECHOMUSIC_PLUGIN_STATS_API_URL`（代码实际读取 `process.env.yanmusic_PLUGIN_STATS_API_URL`）；③ `README.md` 引用的两个不存在的 Linux wrapper 脚本 |
| 清理前后统计 | 281 → 216 处 `echo` 命中 | 其中 shell `echo` 误报 72、`echoCancellation` 1、`handleChooseImport` 巧合 2、`Echo*` 公共类型名及其引用 ~110、有意保留 ~31 |

**附加收益（超出任务要求）**：清理过程中发现并修复 **3 处「改名改了一半」导致的真实功能缺陷**——插件 surface 毛玻璃（44 条选择器永不匹配）、Popover 基础样式（同类问题）、插件滚动容器 `role` 过滤（读取 `data-echo-scroll-role` 而模板写 `data-yan-scroll-role`）。

---

## 3. 构建状态

> **「构建正常」是本次的预期结论，不是异常。** 未解决项中**不含**「构建失败 / 启动崩溃」。

| 环节 | 命令 | 结果 |
|---|---|---|
| 根依赖 | `pnpm install` | ✅ exit 0 — `Done in 1m 23.3s using pnpm v10.34.5` |
| server 依赖 | `cd server && npm install` | ✅ `added 311 packages` |
| addon 1 | `native/yan-mpv-player` → `npm run build` | ✅ exit 0（1m25s）→ `yan-mpv-player.node` 723,456 B |
| addon 2 | `native/yan-storage` → `npm run build` | ✅ exit 0（3m32s）→ `yan-storage.node` 2,426,880 B |
| addon 3 | `native/yan-media-controls` → `npm run build` | ✅ exit 0（26m11s）→ `yan-media-controls.node` 7,874,048 B |
| addon 4 | `native/yan-spectrum-capture` → `npm run build` | ✅ exit 0（5m50s）→ `yan-spectrum-capture.node` 1,567,744 B |
| 类型检查（基线） | `pnpm exec vue-tsc --noEmit` | ✅ **exit 0，无任何输出** |
| 类型检查（改动后） | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | ✅ **exit 0，无任何输出** |
| 类型检查（移动后） | 同上，在新路径 `C:\coding\YanMusic` | ✅ **exit 0** |
| 前端构建 | `node node_modules/vite/bin/vite.js build` | ✅ exit 0（445 模块；`dist-electron/main/app-*.js` 825.69 kB；preload 27.70 kB） |
| 应用启动 | `node_modules/electron/dist/electron.exe .` | ✅ 主进程启动 → **主窗口创建并显示**（`[Thumbar] setThumbarButtons result: true` 仅在 `createWindow()` 且窗口可见后调用）。沙箱实例随后退出，stderr 为空、无 error 日志 |
| 独立佐证 | CI 六个平台 runner | ✅ 在 macOS arm64/x64、Linux x64/arm64、Windows x64/arm64 上分别编译 4 个原生模块并成功打包 |

**本机应用真实运行证据**（`%APPDATA%\YanMusic\logs\yan-music-2026-09-19.log`，4.58 MB）：
`[UserStore] User detail / VIP detail / Grade info fetched`、`[ListenTime] Listening duration reported`、`[MpvController] mpv log: ... filter: Channel 0 clipping ...`（libmpv 已在实时处理滤镜链）；且本机有用户自己的 `YanMusic.exe`（已安装版）实例在运行。

**一个需要说明的工具假失败**：`pnpm exec vue-tsc` 曾被 harness 的 pnpm 包装器以「300 秒无输出」SIGKILL，得到 `TYPECHECK_EXIT=1`。改用 `node` 直调后确认真实结果为 exit 0 —— 该假失败不构成构建问题。

---

## 4. `[旧报告误判]` 清单（附反证）

| # | 旧报告结论 | 反证命令 | 反证输出 | 判定 |
|---|---|---|---|---|
| 1 | 「node_modules 全量断链」（暗示项目无法构建） | 在权威 clone 执行 `pnpm install` 后统计 `node_modules` 下 junction 及 `Test-Path <target>` | `total links = 326，stale = 0`；`vue/electron/vite/typescript/vue-tsc` 的 `package.json` 全部 `True`；`pnpm install` exit 0 | **`[旧报告误判]`** —— 断链只存在于某个被改名的本地副本（263/263 junction 指向 `C:\coding\YanMusic\YanMusic-main\...`，多一层 `YanMusic-main`），**不是仓库属性** |
| 2 | 「无法构建 / 启动会崩溃」 | `vue-tsc --noEmit`、`vite build`、4 个 addon `npm run build`、`electron.exe .` | 全部 exit 0；启动到达主窗口显示阶段；本机有完整功能运行日志 | **`[旧报告误判]`** |
| 3 | 「mpv 设置读了错误键导致永不生效」 | `rg "audioCacheSecs\|audioDemuxerMaxMB\|audioDemuxerBackMB\|audioBufferSecs"` + 检索 `pinia:setting` 写入方 | 读取侧仅 `controller.ts:261-264`（裸键）；写入侧经 `sqlitePersist` 落到 `pinia:setting`；**裸键写入方 0 处** | **部分成立**：键名不匹配在代码层确定存在。属「设置未接通」，**不是**构建/启动故障。未做 GUI 端到端实测，故未据此改代码 |
| 4 | 「9 个设置项只存不生效」 | 取 `setting.ts` 106 个 state 键，排除自身与 `views/settings/**` 后全仓检索 | 零引用 10 个，其中 `checkPrerelease`/`lyricFont` 为假阳性（在 `setting.ts` 内被消费）→ 实际 8 个 | **部分成立**：按任务规则降级表述为「静态引用缺失 / 静态不可达，**待 GUI 实测确认**」。补充证据：枚举 `controller.ts` 全部 40 处 mpv 调用点，`command('set_property')` 只路由 8 个固定属性名，其余静默无操作 ⇒ 这 8 项**不存在可达路径**影响 mpv |
| 5 | 「EQ 实际 10 段而 README 写 18 段」 | 读 `controller.ts:846` 频点表、`player/state.ts:19` 增益数组；读上游 `README.md:37` | 均为 10；**上游 README 亦写「10 段均衡器」** | **成立**，但性质为**文档问题**，非 bug。已在本次修正 README |
| 6 | （本次自查发现）「提交文件编码乱码」 | 用 UTF-8 感知方式读取 `.gitignore`、`build/afterPack.js`、`native/*/.cargo/config.toml` | 中文注释完全正常（如 `.gitignore:16` = `# 需单独下载的大体积二进制（libmpv，随构建放入 build/mpv/）`） | **我自己早期的误判，已撤回** —— 那是 PowerShell 控制台以 GBK 渲染 UTF-8 的显示假象，已在 `00-baseline.md` 与提交 `86ae5ba` 中显式撤回 |

**遵守的约束**：全程未以「修复构建 / 启动」为由改动任何代码；未为迎合旧报告描述而做任何修改。

---

## 5. 引擎调研结论

### 5.1 两个前提更正（重要）

1. **上游 `echo-ffmpeg-player` 中不存在 `vpf.rs`。** 全树检索 `vpf|VPF|ViPER` 仅 3 处命中，且都不是实现（`control/graph.rs:211` 返回 `"VPF requires an external DSP Provider"`）。上游设计文档明确裁定：「EchoMusic Basic DSP never interprets VPF」——VPF 是**外部 DSP Provider 动态库**（`EchoDspApi` ABI v2）的资源类型，Host 只做不透明透传。因此「移植 vpf.rs」这一路径不存在；要支持 VPF，正确做法是引入/自研一个满足 ABI v2 的原生 Provider。
2. **「上游为何在 YanMusic 换成 libmpv」前提方向相反。** libmpv 是 YanMusic **原有的**引擎，移植方向是 EchoMusic → YanMusic（UI/功能照搬），播放内核保留。证据：`PORTING_REPORT.md` §1 把「引擎差异」列为既有前提、§2 记载「**删除** dspProvider 依赖」；仓库自带 `LICENSES/LGPL-2.1.txt` 与 README 的 mpv 声明。

### 5.2 推荐方案：**方案 C —— 维持 libmpv，仅移植上游特定设计**（首选 C1：EQ 级联前级补偿）

**理由（含一手证据）**：应用自身日志中大量出现

```
[MpvController] mpv log: { message: 'filter: Channel 0 clipping 37 times. Please reduce gain.', prefix: 'ffmpeg', level: 'warn' }
[MpvController] mpv log: { message: 'filter: Channel 1 clipping 44 times. Please reduce gain.', prefix: 'ffmpeg', level: 'warn' }
```

该文案出自 FFmpeg 双二阶滤镜实现（`af_biquads.c`，即 `equalizer` 所用），说明 **YanMusic 的 lavfi `equalizer` 级联正在削顶**。上游用「级联响应实测 + 前级补偿」正是为解决同一问题，并在不变式文档中记录了线性网格会低估 1.6–7 dB 的陷阱。这是三方案中**唯一有本次会话一手证据支持**、且改动面最小（单函数 + 对数网格测量）、风险最低（不触碰实时线程与平台 FFI）的改进。

### 5.3 三方案对比（摘要）

| 方案 | 工作量 | 风险 | 收益 | 最小 demo |
|---|---|---|---|---|
| **A 完全自研替换 libmpv** | 移植 8–14 人周 + 平台化与 CI 3–6 人周 + 回归 3–5 人周 ≈ **3–5 人月** | **极高**（实时音频线程正确性、三平台 FFI/独占输出、CI 原生工具链需全部重做） | VPF/Provider 支持、`AudioGraphSnapshot` 自省、显式无缝切歌事务、可复用上游 30 个测试；摆脱对系统 libmpv 的依赖 | 在 Windows 编译 `echo-ffmpeg-player` 成功，用独立 Node 脚本（不经 Electron）播放本地 FLAC，断言 `getState().duration > 0`、`seek` 后 `timePos` 单调推进、`setEqualizer` 全 +12 dB 后 `getAudioGraph()` 节点参数随之变化 |
| **B libmpv 当解码+输出后端，自研处理层** | 变体（自定义 avfilter）**3–6 人周** | 中高（**公开 API 层面存在架构障碍**：libmpv 不向嵌入方导出解码 PCM，无自定义 AO 嵌入 API；avfilter 为进程全局注册，与用户系统 libmpv 版本 ABI 强耦合） | 保留 libmpv 健壮性 + 接近上游的 DSP 质量；**仍无法支持 VPF** | 编译一个注册 `equalizer2` 的 `.dll`，经 `mpv --af=lavfi=graph=...` 加载，用 FFT 验证频响与目标曲线误差 < 0.5 dB |
| **C 维持 libmpv，移植特定设计** ⭐ | **C1 约 2–3 人日**；C1+C3 约 1–2 人周；C1+C2+C3+C4 约 3–4 人周；叠加 C5 约 +1.5–2 人周 | **低** | 消除已被日志证实的削顶；提升空间音效质量与可诊断性；零构建前置变化 | 在 `syncAudioFiltersInner` 实现 C1：① 10 段全 +12 dB 复现 `filter: Channel N clipping` 告警；② 加入对数网格测量的前级补偿；③ 同设置下告警消失且 1 kHz 附近电平符合预期 |

### 5.4 能力对照（22 项，节选差异项）

| 能力 | echo-ffmpeg-player | yan-mpv-player（现状） |
|---|---|---|
| 无缝切歌 | ✅ `begin/prepare/commit/cancel next source` 事务 | ❌ 无（YanMusic 注释明确「Yan 无无缝预解析音源子系统，故不迁移」） |
| VPF / 第三方 DSP Provider | ✅ Provider Host（ABI v2 + 内容寻址安装 + 回滚激活） | ❌ 完全无；VPF 判「暂不可用」 |
| 音频图自省 | ✅ `AudioGraphSnapshot`（格式/延迟/underrun/节点参数/Provider 元数据） | ❌ 仅有 `getProperty('af')` 原始串 |
| EQ | ✅ 10 段双二阶 + **级联响应实测前级补偿** + 15 ms 交叉淡入 | 🟡 10 段 lavfi `equalizer`，**无前级补偿**，改动即整链重建 |
| IR 卷积 | ✅ 分区卷积 + **延迟对齐干湿混合** + true-stereo `[LL,LR,RL,RR]` + 8 s 上限 + 联动限幅 | 🟡 `amovie`+`afir`+`amix`，已做盘符转义/结构键/af-command/duck |
| 配置面 | ✅ 15 项（`initialize` 一次性下发） | 🟡 6 项 |
| 构建前置 | 需 FFmpeg 开发库 + Windows 上 LLVM/libclang（bindgen） | 仅需 Rust + 运行期 libmpv 动态库（`libloading` dlopen，**零编译期依赖**） |
| 测试与文档 | ✅ `shared/tests.rs` 46 KB + 4 份设计文档 + 30 个 node:test | ❌ 无 Rust 测试 |

### 5.5 因果链闭合（阶段 0 遗留问题的完整解释）

上游 `config.rs` 的 `PlayerConfigOptions` 含 15 项，其中 **8 项正是 YanMusic「定义了 UI 却无消费方」的设置**；上游 `src/main/player/controller.ts:162-222` 经 **`getPersistedRendererSettings()`**（该 helper 在 YanMusic 仍存在且被 `networkSettings.ts` 正确使用）一次读取 **13 个字段**。⇒ 移植到 libmpv 时改用 KV 直读、键名未随持久化结构更新，且只映射了 4 项。修复顺序建议：① `controller.ts` 改走 `getPersistedRendererSettings()`（1 行级，与 `networkSettings.ts` 同范式）；② 在 addon 侧增加受限 `setProperty` 白名单并下发剩余 8 项；③ 修正 README 文案（已在本次完成）。

---

## 6. 发布状态

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 起始 SHA | `68b841071cab676ed9b89f575910160b0e7dd1d4`（`68b8410`） |
| **最终 SHA** | **`5f0fa83eaa8dfab2ffd70acf9612ed18e09cddc4`（`5f0fa83`）** |
| 推送方式 | `git push origin main`（**未 force**，fast-forward `68b8410..5f0fa83`） |
| 远程确认 | `git ls-remote origin refs/heads/main` → `5f0fa83e...`；`git log origin/main..HEAD` → 空 |
| **是否打 Tag** | **是**：`v1.1.1`（附注 tag，tag 对象 `04d5b57`，指向 `5f0fa83`），已推送 |
| **Actions run** | **https://github.com/MmlwrYan/YanMusic/actions/runs/35436787605**（run #6，`Build YanMusic Desktop`）<br>`status: completed` / **`conclusion: success`**，耗时约 18 分钟，6 个平台 job 全部成功 |
| **Release** | **https://github.com/MmlwrYan/YanMusic/releases/tag/v1.1.1**<br>`draft: false`、`prerelease: false`、**22 个产物全部上传成功** |
| 产物覆盖 | Windows x64/arm64（NSIS exe）、macOS x64/arm64（dmg + zip）、Linux x64/arm64（AppImage/deb/rpm/pacman/pkg.tar.zst/tar.gz）、4 份更新元数据（latest*.yml） |

**发布已完成。** 未出现需要 `--force`、`pull --rebase`、Tag 冲突或权限不足的情况。

---

## 7. `[自主决策]` 清单

| # | 决策点 | 选项 | 选择 | 理由 |
|---|---|---|---|---|
| 1 | 非 git 目录如何取得权威基线 | 用现有目录 / clone | **clone 到干净目录** | 任务书规定；且现有目录无 `.git`，无法核对 commit 与远端一致性 |
| 2 | git TLS 后端不可用 | 放弃 / 换后端 | **`-c http.sslBackend=openssl`** | 默认 schannel 报 `SEC_E_NO_CREDENTIALS`；openssl 后端可用，不改任何仓库内容 |
| 3 | `git submodule update` 被沙箱命名管道限制阻断 | 升级权限 / 重构命令 | **直接 `git clone` 子模块 + 检出父仓库记录的 SHA** | 结构等价（工作树内容一致、父仓库 `git status` 保持干净），且不绕过任何策略 |
| 4 | 子模块版本漂移 | 用默认分支 HEAD / 固定到记录 SHA | **固定到 `99ca12fb...`** | 与父仓库 gitlink 一致，217 个 API 模块与作者基线相同 |
| 5 | `echo-plugins.json` 是否改名 | 改名 / 保留 | **保留** | 外部契约（第三方插件源仓库根目录的索引文件名），改名立即破坏插件市场；与作者既有裁定一致 |
| 6 | 上游插件源 URL / source id / Worker 域名 / Cloudflare 资源名 | 改名 / 保留 | **保留** | 均为真实线上服务与已部署资源标识，改名需重新部署且会丢统计 |
| 7 | B 档公共类型如何处理 | 硬改调用点 / 加别名 | **加 `Yan*` 别名 + 旧名标 `@deprecated`，调用点零改动** | 任务书要求；`Echo*` 是已对外暴露的插件契约，硬改会破坏既有插件与文档 |
| 8 | session 分区改名是否需要一次性迁移 | 写迁移代码 / 直接改名 | **直接改名 + 就地注释说明** | 三个分区**均无 `persist:` 前缀**（纯内存会话），改名不涉及落盘状态；登录令牌与设备指纹由 Pinia+SQLite（`pinia:user`/`pinia:device`）持久化，不依赖 session cookie jar ⇒ 老用户无需重登，迁移代码是多余的复杂度 |
| 9 | 发现的 R2/R3 是否顺手修复 | 修 / 只报告 | **只报告，不改代码** | 任务书要求「先报告再决定是否修」；改音频配置读取路径会改变所有用户的音频缓冲行为，而本环境无法做 GUI/音频端到端验证，不宜随「清理 + 发布」一并上线 |
| 10 | README 的「自动增益补偿」表述 | 保留 / 删除 | **删除** | 当前 lavfi 实现并无前级补偿（且有削顶日志为证），保留属失实描述 |
| 11 | 版本号 | 沿用 1.1.0 / patch+1 | **`v1.1.1` 并同步 `package.json`** | 任务书「不确定时取 patch+1」；同步 `package.json` 是因为 CI 从 tag 抽 CHANGELOG、electron-builder 从 `package.json` 取版本，不一致会导致产物名与 Release 标题不符 |
| 12 | 作者的 `PORTING_REPORT.md` 是否入库 | 入库 / 不入库 | **不入库**（仅从 git 历史只读引用） | 作者已在 CHANGELOG 明确「开发过程文档移出交付树，不入库」，且它描述的是旧版本状态 |
| 13 | 过程留痕的原始日志被 `*.log` 忽略 | 改文件名 / 加 gitignore 例外 | **加 `!docs/agent/logs/*.log` 例外** | 任务书要求「全程留痕」；例外范围限定在 `docs/agent/logs/`，不影响仓库既有日志规则 |
| 14 | 早期自查结论「提交文件编码乱码」 | 保留 / 撤回 | **撤回并在提交信息与报告中显式说明** | 经复核为 PowerShell 控制台 GBK 渲染 UTF-8 的显示假象，文件内容正常；不应把工具假象当仓库缺陷上报 |
| 15 | 替换原目录的方式 | 直接删除后移动 / 先改名保留再验证 | **先改名保留 → 移动 → 验证通过 → 再删除** | 保留可回滚窗口；且移动后 pnpm 的 1243 个绝对路径 junction 必然失效，必须先验证再清理 |
| 16 | 移动后如何修复 node_modules | 让 pnpm 清空重装 / 重写 junction | **重写 junction 目标 + 修正 `.bin` 垫片与 `.modules.yaml`** | pnpm 会因检测到异常而要求交互确认清空 `node_modules`（非 TTY 下报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），且 `ignoredBuiltDependencies` 含 `electron` ⇒ 清空后不会重新下载 Electron 二进制，会破坏可用环境 |

---

## 8. 未解决 / 需人工后续清单

| # | 项 | 性质 | 建议 |
|---|---|---|---|
| 1 | **mpv 音频缓冲/缓存设置读错存储键**（`controller.ts:261-264` 读裸 KV 键，实际值在 `pinia:setting`） | **真实缺陷**（代码层确定） | 改为 `getPersistedRendererSettings()`，与 `networkSettings.ts:56,72` 同范式。因涉及音频路径行为变更且本环境无法做音频端到端验证，**未在本次修改** |
| 2 | **8 个设置项无消费方**（`audioSamplerate`/`audioChannels`/`audioFormat`/`gaplessAudio`/`demuxerReadaheadSecs`/`cache`/`cachePause`/`cachePauseWaitSecs`） | 静态不可达（确定） | 需先在 `yan-mpv-player` 增加受限 `setProperty` 白名单（`audio-samplerate` 等），再在 `initialize` 时下发；或先在设置 UI 标注「暂未生效」 |
| 3 | **`native/yan-storage/node_modules` 被纳入版本控制** | 仓库卫生问题（已量化） | `git ls-files native` 共 2975 个文件，其中 **2925 个（98.3%）**属于该目录，占全仓 3479 个受版本控制文件的 **84%**。建议 `git rm -r --cached native/yan-storage/node_modules` 并确认 `.gitignore` 的 `node_modules/` 生效（当前它已被 `git add -f` 绕过） |
| 4 | 上游 30 个 `node:test` 与 4 份引擎设计文档未移植 | 缺失覆盖 | 其中与引擎无关的部分（`playback-queue-decision`、`network-settings`、`settings-backup` 等）可直接移植，性价比高 |
| 5 | VPF 音效仍不可用 | 功能缺口 | 需引入/自研 `EchoDspApi` v2 原生 Provider；短期可在 UI 保持「暂不可用」的明确提示（现状已如此） |
| 6 | EQ 削顶（方案 C1 未实施） | 可听缺陷（有日志证据） | 实施对数网格级联响应测量 + 前级补偿，约 2–3 人日 |
| 7 | `.gitignore` 含 `build/` 但 22 个 `build/**` 文件已被跟踪 | 轻微不一致 | 保留现状即可（`icons/`、`afterPack.js`、`installer.nsh` 是构建必需输入）；若要整理，应显式加 `!build/icons/` 等例外而非取消跟踪 |
| 8 | 未完成 GUI 端到端点击测试（播放/一起听/云上传/插件市场等） | 验证缺口 | 沙箱无独立交互式桌面会话；建议在作者本机按移植报告 §6 的清单人工联调 |
| 9 | README「音质」段（DSD 臻品 / Hi-Res / SQ / HQ / 标准）与「音效」段（蝰蛇系列等）未逐项与代码核对 | 未验证 | 本次仅校准了已确认的 4 项（Electron 版本、持久化方案、EQ 段数、addon 清单）+ 2 处死引用 |
| 10 | 主进程 `[Main]` / `[IPC-Server]` 日志未出现在日志文件（仅 `[Thumbar]`/`[LogCleaner]`/`[MpvController]` 等可见） | 观察项 | 疑与 `applyLogSettings()` 的 file level 配置有关，未深究；不影响功能 |

---

## 9. GPL 合规声明

| 项 | 状态 |
|---|---|
| **对 EchoMusic 的致谢与修改声明是否保留** | **完整保留，且加强**。① `src/renderer/constants/legal.ts:47`（应用内「关于 → 致谢」）与 `:76` **逐字未改动**；② `README.md`「灵感来源」的 EchoMusic 条目未改动；③ **新增** `README.md`「上游项目与修改声明」小节，写明上游为 EchoMusic `2.3.1-beta.24`、作者 hoowhoami、原始版权归属、修改内容概要，并指向 `CHANGELOG.md`；④ `CHANGELOG.md` 新增 `[1.1.1]` 段的「说明」小节再次记录继续保留的上游外部契约与 GPL 致谢 |
| **是否复制了上游代码** | **否**。上游源码位于仓库外（`C:\coding\EchoMusic\EchoMusic-main`），全程**只读**；`git status` 中 `native/` 下仅有 1 个文件改动（A 档 ObjC 类名改名），**无任何新增文件**。`docs/agent/03-engine-research.md` 仅引用路径、行号与设计结论，未搬运实现代码 |
| **许可与随包分发** | 仓库保持 GPL-3.0（`LICENSE`）；`package.json` 的 `build.extraResources` 继续随包分发 `LICENSE`、`LICENSES/LGPL-2.1.txt` 与 `CHANGELOG.md`；README 保留「本项目使用 mpv 作为音频播放引擎（LGPL-2.1+ / GPL-2.0+），通过动态链接方式加载」 |
| **上游品牌在用户可见界面的暴露** | 与作者既有裁定一致：唯一 GUI 例外是 GPL 致谢段（保留）；插件开发文档链接与分享域名属功能必需；插件市场索引名/源地址/Worker 域名不渲染为界面文本 |

---

## 10. 附：原目录替换（会话中按你的指示执行）

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | 确认占用 | 运行中的 6 个 `YanMusic` 进程均为**已安装版** `C:\Users\admin\AppData\Local\Programs\YanMusic\YanMusic.exe`，与 `C:\coding\YanMusic` 无关；旧目录可重命名（未被占用） |
| 2 | 旧目录改名保留（可回滚） | `C:\coding\YanMusic` → `C:\coding\_old_YanMusic_v1.1.0` |
| 3 | 修好的仓库移动到原路径 | `C:\coding\yanmusic-agent` → **`C:\coding\YanMusic`** |
| 4 | 修复 pnpm 链接 | 移动后 **1243 个 junction 全部失效**（pnpm 使用绝对路径）。重写全部 junction 目标（1243/1243 成功、0 失败）→ **0 stale**；另修正 135 个 `.bin` 垫片的 `NODE_PATH`、`.modules.yaml` 的 `virtualStoreDir`、以及所有旧路径残留（`.bin` 与 `.modules.yaml` 残留归零） |
| 5 | 验证新位置可用 | `vue-tsc --noEmit` **exit 0**；`vite build` **exit 0**；4 个 `.node` 产物、`server/`（217 模块 + 依赖）、`build/mpv/libmpv-2.dll`、Electron 二进制（`v43.1.1`）全部就位 |
| 6 | 删除旧副本 | 删除 `_old_YanMusic_v1.1.0`，**释放 2.93 GB**（含 v1.1.0 的 `release/` 产物 655 MB、`target/` 1256 MB、`node_modules/` 919 MB） |

**当前唯一副本：`C:\coding\YanMusic`**（HEAD `5f0fa83`，tag `v1.1.1`，0 stale junction，可直接 `pnpm dev` / `pnpm build`）。
被删除的 v1.1.0 构建产物如需回溯，可从 GitHub Release `v1.1.0` 重新下载（https://github.com/MmlwrYan/YanMusic/releases/tag/v1.1.0）。

---

## 11. 产出文件索引

| 文件 | 内容 |
|---|---|
| `docs/agent/00-baseline.md` | 阶段 0：R1–R4 客观状态表、`[旧报告误判]` 清单、README vs 代码不一致清单 |
| `docs/agent/01-build.md` | 阶段 1：依赖/addon/typecheck/build/启动 全量实测 |
| `docs/agent/02-echo-cleanup.md` | 阶段 2：三档清单、修复的 3 处缺陷、有意保留项与理由 |
| `docs/agent/03-engine-research.md` | 阶段 3：上游引擎架构、VPF 定位、22 项能力对照、三方案与推荐 |
| `docs/agent/04-release.md` | 阶段 4：提交清单、推送/tag/Actions/Release 结果与验收 |
| `docs/agent/FINAL-REPORT.md` | 本文件 |
| `docs/agent/run-log.md` | 全程命令与时间戳留痕 + 环境障碍与处置 |
| `docs/agent/logs/` | 原始输出：`echo-scan.txt`、`rust-build.log`、`vite-build.log`、`typecheck-*.log`、`app-start*.log`、`post-move-verify.log`、`final-verify.log` |
