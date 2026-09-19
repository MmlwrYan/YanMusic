# 阶段 3 — 自研音频引擎调研报告（只读）

> 本阶段**不写任何生产代码**，不复制上游源码。
> 上游来源：`C:\coding\EchoMusic\EchoMusic-main`（EchoMusic `2.3.1-beta.24`，`package.json` 的 `license: GPL-3.0-only`），只读引用。
> 交叉证据：作者既有文档 `PORTING_REPORT.md`（从 git 历史 `f723539:PORTING_REPORT.md` 只读提取，**不写入仓库**，仅存放于 `docs/agent/logs/`）。

---

## 0. 必须先更正的两个前提

### 0.1 `echo-ffmpeg-player` 中**不存在** `vpf.rs`

对上游 `native/echo-ffmpeg-player` 全树检索 `vpf|VPF|ViPER`，**只有 3 处命中**，且都不是实现：

| 位置 | 内容 |
|---|---|
| `src/control/graph.rs:211-212` | `"vpf" => Err(napi::Error::from_reason("VPF requires an external DSP Provider"))` |
| `src/dsp/limiter.rs:1` | 注释：`// Match the Provider/ViPER path: preserve the effect's level...` |

上游设计文档 `docs/dsp-provider-architecture.md:46-48` 明确裁定：

> **"Provider-specific behavior belongs to a provider. EchoMusic Basic DSP never interprets VPF. An external provider may opt into VPF by declaring the resource kind in its manifest; the Host passes the resource through without understanding its binary format."**

⇒ VPF **不是** `echo-ffmpeg-player` 内的模块，而是**外部 DSP Provider 动态库**的资源类型。因此：
- 阶段 2 中 `src/main/ipc/settings.ts:89` 那条指向 `native/echo-ffmpeg-player/src/vpf.rs` 的注释是**死引用**（该文件在本仓库与上游都不存在），已更正；
- **「移植 vpf.rs」这个路径不存在**。若要支持 VPF，正确做法是**引入/自研一个满足 EchoDspApi v2 的原生 Provider**（见 §3）。

### 0.2 「上游为何在 YanMusic 换成 libmpv」—— 前提方向相反

libmpv **不是**移植时的替换结果，而是 **YanMusic 自己原有的引擎**。证据：

| 证据 | 内容 |
|---|---|
| `PORTING_REPORT.md` §1「环境与基线」 | 「**引擎差异**：Yan = libmpv（Rust NAPI `native/yan-mpv-player`，10 段 EQ 走 mpv `af`）；Echo = ffmpeg + dspProvider」——把引擎差异作为**既有前提**列出，而非本次改动项 |
| `PORTING_REPORT.md` §2 阶段 B | 「引擎适配：**删除 dspProvider 依赖**；VPF/组合音效判为不可用（libmpv 滤镜链仅消费 IR），不静默降级」——是**删除**上游的 provider 依赖，不是引入 libmpv |
| `PORTING_REPORT.md` 标题 | 「YanMusic **向** EchoMusic 2.3.1 移植」——方向是 EchoMusic → YanMusic（UI/功能照搬），YanMusic 保留自有播放内核 |
| 仓库自有资产 | `LICENSES/LGPL-2.1.txt`（mpv 许可）、README「本项目使用 mpv 作为音频播放引擎（LGPL-2.1+ / GPL-2.0+），通过动态链接方式加载」 |
| `PORTING_REPORT.md` §6.7 | 「上游文档与测试未移植：`docs/{plugin-system,dsp-provider-architecture,dsp-provider-settings,audio-engine-invariants}.md` 与 `tests/`（30 个 node:test 文件）——大部分内容描述 Echo 的 ffmpeg/dspProvider 引擎，**与 Yan 的 libmpv 架构不对应**」 |

因此本报告把问题重述为：**在 libmpv 引擎已稳定工作的前提下，是否/如何引入 `echo-ffmpeg-player` 的能力**。§3 给出三方案。

---

## 1. `echo-ffmpeg-player` 整体架构

### 1.1 文件树（`native/echo-ffmpeg-player`，约 60 个 Rust 源文件）

```
Cargo.toml (rust-version 1.87)  build.rs  package.json (napi-rs)
src/
  lib.rs              96,879 B   NAPI 入口 + PlayerRuntime + 播放核心状态机 + 无缝切歌
  audio_graph.rs      57,727 B   滤镜图构建/快照/AudioGraphPlan 补丁
  shared.rs           48,550 B   共享状态（含 shared/{clock,gapless,realtime_ring,session,stats,types,ao_state,decoded_queue,tests}.rs）
  decoder.rs          47,494 B   FFmpeg 解封装/解码工作线程、seek、预解码、音轨枚举
  config.rs           30,814 B   PlayerConfigOptions → PlayerConfig（15 个配置项 + 策略枚举）
  tempo.rs            21,768 B   倍速（soundtouch WSOLA）
  dispatcher.rs       21,638 B   事件分发（TSFN，可丢弃/必达两级重试）
  filter.rs           12,480 B   player-filter 线程 + 崩溃捕获
  spectrum.rs         11,558 B   实时频谱（rustfft）
  events.rs           10,477 B   事件/错误码类型
  exclusive.rs         1,589 B   独占输出守卫
  control/            dsp, fade, graph, output, output_lifecycle, provider, seek, spectrum
  device/             mod, selection, watcher, platform_{windows,macos,linux}
  dsp/                basic(EQ/卷积/限幅), limiter, provider(外部 ABI), mod
  output/             mod, cpal_shared, wasapi, alsa_exclusive, coreaudio_exclusive
  stream/             file, http, url, mod
  shared/             见上
vendor/
  ffmpeg-audio/       自维护的 FFmpeg 绑定（含 packet_cache 5 万行、http 5.7 万行、swr、demuxer、engine）
  soundtouch-rs/      WSOLA 变速
  libspa/ pipewire/   Linux PipeWire 支持（[patch.crates-io] 覆盖）
```

### 1.2 线程模型（来自 `docs/audio-engine-invariants.md`，上游自述）

```
decode thread -> decoded_queue -> filter thread -> RealtimeAudioRing -> output callback
                                       |                                     |
                                  DSP / tempo                        pending fields
                                                                             |
                                                                     signal thread -> JS events
```

关键不变式（上游明确记录，均为「踩过坑后写下」）：
- **实时回调内绝不阻塞/分配/发送到无界通道**：所有锁用 `try_lock`；控制信号走 pending 字段，容量为 1 的 `SyncSender` 只当唤醒令牌；scratch 缓冲在流启动时预留，超预算时**输出静音而非扩容**。
- **`RealtimeAudioRing::clear()` 不写消费端索引**，只发布 `clear_before` 水位（SPSC 语义）。
- **DSP 入口做一次 `sanitize_samples`**：单个非有限样本会永久污染卷积器 `input_spectra` 或 WSOLA 重叠缓冲。
- **EQ 前级补偿必须在**对数网格上测量级联响应（512 点，10 Hz→Nyquist + DC/Nyquist + 各频带中心）；线性网格会把 31 Hz 峰低估约 1.6 dB（192 kHz 下约 7 dB），「恰好削在最听得见的地方」。
- **限幅器把衰减铺满 256 帧 lookahead 窗**（`1 - 1e-6^(1/LOOKAHEAD)`），否则每个瞬态都有咔哒声。
- **seek 复用 DSP 状态**（`can_reset_state` 快路径）避免重建长 IR 卷积器造成可闻断音；Provider 故意不参与快路径。
- **事件投递分级**：`time-update`/`log`/`ao-state-change`/stats 可丢；`state-change`/`playback-end`/`error`/`seek`/`file-loaded`/`audio-graph-change` 必达，两级重试预算（生产者侧 1 s、TSFN 侧 2 s）。
- **平台输出**：CoreAudio IOProc context 宁可泄漏不可 use-after-free；每个 `extern "C"` 回调包 `catch_unwind`（跨 FFI panic = 进程 abort）；WASAPI 独占周期**原样使用驱动上报的 `defaultPeriod`**（擅自夹取会被 `AUDCLNT_E_INVALID_DEVICE_PERIOD` 拒绝）；`AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED` 的重试流程是 MSDN 规定动作。
- **vendored packet cache**：跨范围 seek 一律退回真实 demuxer seek；`read_cancelled` 与 `read_failed` 是不同状态；worker 出错后 park 而非重试；teardown 先中断再 join；tokio runtime 用 `shutdown_timeout` 收尾。

### 1.3 NAPI 接口面（完整）

**`lib.rs`：**
| 导出 | 签名要点 |
|---|---|
| `initialize(config?)` | 先 `shutdown_runtime(false)` → 重置事件 ID → 启动事件分发 → 建 `PlayerRuntime` + `DeviceWatcher` → 置 `RUNTIME_READY` → 启动 core dispatcher |
| `destroy()` | `shutdown_runtime(true)`（取消 fade、失效 seek/open 请求、停 dispatcher、停会话、清回调） |
| `registerEventHandler(cb)` | 启动 dispatcher 并设置 TSFN 回调 |
| `loadFile(url, seq?)` / `loadMkvTrack(url, trackId, seq?)` / `switchSource(...)` | `AsyncTask` |
| `beginNextSourcePreparation()` / `prepareNextSource(...)` / `commitPreparedNextSource(...)` / `cancelNextSourcePreparation(id)` / `clearPreparedNextSource()` | **无缝切歌（gapless prepare/commit 事务）** |
| `getTrackList(url?)` / `play()` / `pause()` / `stop()` / `setVolume(v)` / `getState()` / `setLoopFile(bool)` | |

**`control/*`：**
| 模块 | 导出 |
|---|---|
| `dsp` | `setSpeed`、`setEqualizer(gains)`、`setAudioEffect(payload: JSON)`、`setNormalizationGain(db)` |
| `fade` | `fade`、`cancelFade`、`pauseWithFade`、`playWithFade` |
| `graph` | `getAudioGraph()`（返回 `AudioGraphSnapshot`）、`setAudioGraphParameter`、`setAudioGraphPlan(patch)` |
| `output` | `getAudioDevices`、`setAudioOutput(device, exclusive)`、`setHttpProxy`、`setHttpProxies`、`setNetworkTimeout`、`setPauseOnDeviceDisconnect`、`setStallTimeout` |
| `provider` | `inspectDspProvider(path)` |
| `seek` | `seek(time)` |
| `spectrum` | `configureSpectrum`、`getSpectrumStatus`、`getSpectrumSnapshot` |

**`AudioGraphSnapshot` 是上游相对 libmpv 最大的架构差异**：它把「处理格式 / 输出格式 / 设备输出（backend、buffer 模式与秒数、underruns）/ 节点列表（kind、通道需求、flush 模式、延迟、运行时可编辑参数及其单位/范围）/ Provider 元数据」全部结构化暴露给渲染层，使 UI 不必猜测引擎行为。

**配置面（`PlayerConfigOptions`，15 项）**：`audioBufferSecs`、`audioSamplerate`、`audioChannels`、`audioFormat`、`gaplessAudio`、`demuxerReadaheadSecs`、`cache`、`cacheSecs`、`cachePause`、`cachePauseWaitSecs`、`demuxerMaxBytes`、`demuxerMaxBackBytes`、`networkTimeoutSecs`、`playbackStallTimeoutSecs`、`httpProxy`。

> ⚠️ **这 15 项中的 8 项，恰好就是 YanMusic 当前「定义了 UI 却无人消费」的那 8 个设置项**（`audioSamplerate`/`audioChannels`/`audioFormat`/`gaplessAudio`/`demuxerReadaheadSecs`/`cache`/`cachePause`/`cachePauseWaitSecs`）。这构成阶段 0 中 R3 的**完整因果解释**：这些设置项是从上游设置 schema 继承下来的，上游引擎会消费它们，而 YanMusic 换用 libmpv 后只映射了其中 4 项（且映射时读错了存储键，见阶段 0 §2），其余 8 项再无消费方。详见 §5。

---

## 2. VPF 的定位：格式 vs 滤镜图

| 维度 | 结论 |
|---|---|
| VPF 是什么 | ViPER4Windows 的**私有预设/资源容器**（`src/main/ipc/settings.ts` 侧校验：魔数 `ViPER4WindowsX` + 4 个 section 长度 `[0x170,0x2e4,0x2e8,0x31c]`），**不是滤镜图，也不是音频格式** |
| 谁解析它 | **外部 Provider 动态库**。上游 `DspChain`/`AudioFilterGraph` 不解析 VPF 二进制 |
| 传递方式 | 以**不透明资源**经 `EchoDspConfig.resource_json`（UTF-8 JSON 数组）交给 Provider；Host 只校验 manifest 是否声明了该资源 kind/扩展名 |
| 选择矩阵（上游文档） | `Builtin Basic + 通用 IRS → Builtin DSP`；`Provider + 非 VPF 资源 → 该 Provider`；`VPF + Provider → 该 Provider`；**`VPF 无 Provider → 明确报不支持`** |
| 与 libmpv 滤镜链的差异 | libmpv 只能消费**能表达为 lavfi 图**的东西（YanMusic 用 `amovie`+`afir` 做 IR 卷积、`amix` 做干湿混合）。VPF 需要**进程内 DSP 插件**，lavfi 无法承载；这就是 YanMusic `audioEffectSupport.ts` 判定「VPF 资源在 libmpv 侧无消费路径」的根因 |

**Provider ABI（v2，C ABI，不透明）**：`echo_dsp_get_api()` 返回 `EchoDspApi`，含 `create/process/drain/reset/configure/get_state_json/destroy`。约束：`process` 原地处理、不得分配/阻塞/panic/抛异常/改变帧数；`configure` 只在实时控制路径调用；`get_state_json` 返回借用字符串。Provider 以 **SHA-256 内容寻址**安装为不可变版本，支持回滚式激活。

---

## 3. 能力对照表：`echo-ffmpeg-player` vs `yan-mpv-player`（当前）

图例：✅ 由引擎直接提供；🟡 由引擎间接提供（需自行构造 lavfi/属性）；❌ 无对应能力。

| 能力 | echo-ffmpeg-player | yan-mpv-player（现状） | 若替换需重实现 |
|---|---|---|---|
| **解封装/解码** | ✅ 自维护 `vendor/ffmpeg-audio`（demuxer、packet cache、http、swr） | ✅ libmpv 内置（外部 `libmpv-2.dll` / `libmpv.so` / dylib） | 需整套 FFmpeg 绑定 + 自建 HTTP 流 + packet cache；**需 FFmpeg 开发库 + LLVM/libclang** |
| **音频输出（共享）** | ✅ `cpal_shared.rs`（57 KB，Windows/macOS/Linux 统一 cpal） | ✅ mpv ao | 需 cpal 集成 + 实时环 + 时钟 |
| **独占输出** | ✅ `wasapi.rs`（28 KB）、`coreaudio_exclusive.rs`（21 KB）、`alsa_exclusive.rs`（18 KB） | 🟡 mpv `audio-exclusive` 属性（YanMusic 已接线，`ipc/player.ts:146-165`） | 需三平台独占实现（WASAPI/CoreAudio/ALSA 直通） |
| **输出设备枚举/热插拔** | ✅ `device/selection.rs` + `device/watcher.rs` + 三平台 `platform_*.rs`（合计 ~12 万字节，含 CoreAudio 属性监听、WASAPI `IMMNotificationClient`、PulseAudio host 切换） | 🟡 mpv `audio-device-list` + `audio-device-list-changed` 事件（YanMusic 已接线） | 需三平台设备枚举 + 变更通知 |
| **EQ** | ✅ 10 段双二阶（31/62/125/250/500/1k/2k/4k/8k/16k，Q=1.414）+ **级联响应实测前级补偿（对数网格 512 点）** + 15 ms 交叉淡入 | 🟡 10 段 lavfi `equalizer`（60/170/310/600/1k/3k/6k/12k/14k/16k），**无前级补偿**，改动即整链重建 | 需自研 biquad 级联 + 响应测量（**这是最高性价比的移植项，见 §4 方案 C**） |
| **IR 卷积（空间音效）** | ✅ 分区卷积（早 256 帧 / 晚 1024 帧 FFT）、**延迟对齐的干湿混合**、单声道→立体声展开、4 通道 true-stereo `[LL,LR,RL,RR]`、8 秒上限、立体声联动峰值限幅、EOF 尾音 drain、无缝边界重置 | 🟡 `amovie`+`afir(wet=3)`+`amix(weights='1 mix')`，已做 Windows 盘符转义、结构键优化、af-command 运行时改权重、重建时 duck | 需自研分区卷积 + 延迟对齐 + 限幅 |
| **响度归一（LUFS）** | ✅ `normalization_gain_linear()` | ✅ 走 mpv `volume-gain` 属性（失败回退 af `volume=XdB`） | 需增益应用点 |
| **倍速/变调** | ✅ `tempo.rs` + `vendor/soundtouch-rs`（WSOLA） | ✅ mpv `speed` | 需 WSOLA 实现 |
| **实时频谱** | ✅ `spectrum.rs`（rustfft，可配 fftSize/binCount/smoothing/频段/scale） | ✅ **独立 addon** `yan-spectrum-capture`（系统音频捕获 + FFT）；mpv 侧不导出 PCM | 已有等价能力（架构不同：Yan 从系统回环捕获，Echo 从解码链内取样） |
| **时间同步/时钟** | ✅ `shared/clock.rs` + `realtime_ring` + `ao_state`（buffering 状态机） | ✅ mpv 内部时钟 + `time-pos` 观察器（YanMusic 主进程节流到 ~5 fps，渲染层再节流 250 ms） | 需自建时钟与缓冲状态机 |
| **seek** | ✅ `control/seek.rs`（事务化 seek plan、`prepare_seamless_seek`、缓存 seek 限当前范围） | ✅ mpv `seek` | 需 seek 事务与缓存一致性 |
| **无缝切歌** | ✅ `begin/prepare/commit/cancel/clear next source`（显式事务） | ❌ **无**。YanMusic 注释明确：「Yan 无无缝预解析音源子系统，故不迁移」（`stores/player.ts:613`） | 需 prepare/commit 事务 |
| **淡入淡出** | ✅ `control/fade.rs`（`FadeJob`、`fade/cancelFade/pauseWithFade/playWithFade`） | ✅ Rust 侧后台线程 fade + `fade-complete` 事件；主进程另有「淡出→暂停→恢复音量」复合命令 | 已有等价能力 |
| **卡死恢复** | ✅ `setStallTimeout` + 输出 underrun 统计 + `output_lifecycle` 恢复路径 | ✅ **主进程看门狗**（`MpvController.startStallWatchdog`，8 s 阈值、仅「已推进过一次」后布防、一次只通知一次）+ 渲染层候选地址重取与断点恢复 | 已有等价能力（实现位置不同：Yan 在主进程，不受 Chromium 后台节流影响） |
| **HTTP 代理/超时** | ✅ `setHttpProxy` / `setHttpProxies` / `setNetworkTimeout` | ✅ 同名能力（`setHttpProxy`/`setNetworkTimeout`），代理 URL 来自 Electron `resolveProxy` | 已有等价能力 |
| **音轨枚举/MKV 选轨** | ✅ `getTrackList` + `audio_stream_ordinal_from_track_id` | ✅ `getTrackList` + `loadMkvTrack`（YanMusic 额外引入 `mpv-mkv://track=N&url=...` 伪协议，见 `utils/player.ts:161-168`） | 已有等价能力 |
| **VPF / 第三方 DSP Provider** | ✅ Provider Host（ABI v2 + 注册表 + 内容寻址安装 + 回滚激活） | ❌ **完全无**；VPF 被判「暂不可用」 | 需 Provider Host + ABI 加载器 |
| **音频图自省（UI 可见）** | ✅ `AudioGraphSnapshot`（格式/延迟/underrun/节点参数/Provider 元数据） | ❌ 无（只有 `getProperty('af')` 取滤镜串） | 需图快照 |
| **事件投递分级** | ✅ 可丢弃 telemetry vs 必达 state + 两级重试预算 + 丢弃计数 | 🟡 有节流，无丢弃计数/分级保证 | 需事件策略层 |
| **配置面** | ✅ 15 项（`initialize` 时一次性下发） | 🟡 6 项（`cacheSecs`/`demuxerMaxMb`/`demuxerBackMb`/`audioBufferSecs`/`networkTimeoutSecs`/`httpProxy`） | 需属性映射层 |
| **测试与文档** | ✅ `shared/tests.rs` 46 KB + `docs/audio-engine-invariants.md` 17 KB + 4 份设计文档 + 30 个 node:test | ❌ 无 Rust 测试；仓库无 `tests/` | — |
| **构建前置条件** | 需 **FFmpeg 开发库** + Windows 上 **LLVM/libclang**（bindgen）；`rust-version 1.87` | 仅需 Rust + 运行期 `libmpv` 动态库（`libloading` dlopen，**零编译期依赖**） | — |

---

## 4. 方案对比（≥3 方案）

### 方案 A — 完全自研替换 libmpv（引入/适配 `echo-ffmpeg-player`）

| 维度 | 评估 |
|---|---|
| 做法 | 把上游 `echo-ffmpeg-player`（含 vendored `ffmpeg-audio`/`soundtouch-rs`/`libspa`/`pipewire`）移植为 `native/yan-ffmpeg-player`，重写主进程 `MpvController` → 新控制器、`ipc/player.ts`、`preload`、渲染层 `PlayerEngine` |
| 工作量 | **移植 8–14 人周**（约 60 个源文件 + 4 个 vendored crate，需逐项对照重写，不是复制）+ **平台化与 CI 3–6 人周**（三平台 FFmpeg 开发库、Windows libclang、Linux PipeWire/ALSA、macOS CoreAudio 授权）+ **回归 3–5 人周**。**合计约 3–5 人月** |
| 风险 | **极高**。① 实时音频线程正确性（上游 17 KB 不变式文档即为此而写）；② 三平台 FFI/独占输出；③ CI 原生工具链（当前 CI 已为 libmpv 做了 macOS rpath 签名、Linux 依赖、Windows DLL 准备，需全部重做）；④ 现由 libmpv 免费提供的能力（`af` 运行时命令、`force-media-title`、日志事件用于 IR 失败检测、`mpv-mkv://`）需全部重实现 |
| 收益 | ① VPF/第三方 Provider 支持；② `AudioGraphSnapshot` 自省；③ 显式无缝切歌事务；④ 可复用上游 30 个测试与 4 份设计文档；⑤ 摆脱对用户系统 libmpv 的依赖（当前 Linux 需系统 libmpv，README 记载了 `libffmpeg.so` 符号冲突问题） |
| 最小 demo | **在 Windows 上编译 `echo-ffmpeg-player` 成功，并用一个独立 Node 脚本（不经 Electron）播放一个本地 FLAC**：断言 `getState().duration > 0`、`seek` 后 `timePos` 单调推进、`setEqualizer` 全 +12 dB 后 `getAudioGraph()` 的节点参数随之变化。**不含任何 Electron/UI 集成** |

### 方案 B — libmpv 当解码 + 输出后端，自研音频处理层叠其上

| 维度 | 评估 |
|---|---|
| 做法 | 保留 libmpv 的解封装/解码/输出/时钟，仅把 DSP 换成自研层 |
| **架构障碍（必须如实指出）** | libmpv 对嵌入方**不导出解码后 PCM**：没有公开的「自定义 AO」嵌入 API，也没有把 PCM 交回宿主进程的通道。因此「libmpv 解码 → 自研 DSP → libmpv 输出」**在当前公开 API 下无法直接实现**。唯一可行变体是：把自研 DSP 编译成**进程内注册的自定义 avfilter**（C/C++，链接 FFmpeg 的 avfilter），再经 `af=lavfi=graph=...` 使用 |
| 工作量 | 变体（自定义 avfilter）：**3–6 人周**（EQ 级联 + 前级补偿 + 分区卷积 + 限幅 + 与 libmpv 的 avfilter 版本耦合）；**仍无法支持 VPF**（VPF 需要完整 Provider 语义，非单个滤镜） |
| 风险 | 中高。avfilter 是**进程全局注册**，与 libmpv 内置 FFmpeg 版本必须 ABI 兼容；用户系统 libmpv 版本多样（README 记载 Linux 上打包库与系统库并存），版本错配会直接崩 |
| 收益 | 保留 libmpv 的健壮性；可拿到接近上游的 DSP 质量与图自省 |
| 最小 demo | 编译一个注册 `equalizer2` 的 `.dll`，在 `mpv --af=lavfi=graph=...` 下加载，用 `--af=lavfi=[...]` 输出一段音频并用 FFT 验证频响与目标曲线误差 < 0.5 dB |

### 方案 C — 维持 libmpv，仅移植 `echo-ffmpeg-player` 的特定模块思路 ⭐ **推荐**

| 维度 | 评估 |
|---|---|
| 做法 | 不改引擎，只把上游**已证明有效且低耦合**的设计移植进现有 lavfi 链与主进程逻辑 |
| 子项与优先级 | **C1（最高性价比）EQ 前级补偿**：按上游做法在对数网格（512 点，10 Hz→Nyquist，并显式包含各频带中心）测量 `equalizer` 级联响应，取最大值反相作为前级增益，避免叠加提升削顶。<br>**C2 IR 卷积质量**：延迟对齐的干湿混合（消除中间强度下的梳状滤波）、true-stereo `[LL,LR,RL,RR]` 路由、8 秒上限与内容指纹去重。<br>**C3 音频图自省**：把当前 `af` 串结构化为可读快照（节点/参数/延迟）暴露给设置页与诊断，替代只能 `getProperty('af')` 取原始串。<br>**C4 事件投递分级**：为 `mpv:time-update` 等 telemetry 增加丢弃计数，为 `state-change`/`playback-end` 增加必达保证与重试预算。<br>**C5 配置面补齐**：让已存在 UI 的 8 个调优项真正下发（需在 Rust addon 侧新增受限 `setProperty` 白名单，见 §5）。 |
| 工作量 | **C1 约 2–3 人日**；C1+C3 约 **1–2 人周**；C1+C2+C3+C4 约 **3–4 人周**；叠加 C5（Rust + 主进程 + 设置页）约 **+1.5–2 人周** |
| 风险 | **低**。全部在现有 `syncAudioFiltersInner` 与 lavfi 图内完成，不触碰线程模型、输出后端、平台 FFI；不改变对 libmpv 的依赖 |
| 收益 | 直接消除当前**可听且已被日志证实的削顶**（见 §4.1）；提升空间音效质量与可诊断性；零构建前置变化 |
| 最小 demo | 在 `MpvController.syncAudioFiltersInner` 中实现 C1：① 先在 10 段全 +12 dB 下复现日志 `filter: Channel N clipping ...`；② 加入对数网格测量的前级补偿；③ 同样的 +12 dB 设置下该告警消失，且 1 kHz 附近实测电平与预期一致 |

### 4.1 方案 C1 的直接证据：当前 EQ 正在削顶

应用自身日志（`%APPDATA%\YanMusic\logs\yan-music-2026-09-19.log`，4.58 MB）中大量出现：

```
[2026-09-19 14:10:01] [warn]  [MpvController] mpv log: {
  message: 'filter: Channel 0 clipping 37 times. Please reduce gain.',
  prefix: 'ffmpeg',
  level: 'warn'
}
[2026-09-19 14:10:01] [warn]  [MpvController] mpv log: {
  message: 'filter: Channel 1 clipping 44 times. Please reduce gain.',
  prefix: 'ffmpeg',
  level: 'warn'
}
```

该文案出自 FFmpeg 双二阶滤镜实现（`af_biquads.c`，即 `equalizer` 所用），说明 **YanMusic 的 lavfi `equalizer` 级联正在产生削顶**。上游用「级联响应实测 + 前级补偿」正是为解决同一问题，并在不变式文档中记录了线性网格会低估 ~1.6–7 dB 的陷阱。这是三方案中**唯一有本次会话一手证据支持**的改进点。

---

## 5. 阶段 0 遗留问题的完整因果链（本阶段的副产品）

阶段 0 的 R2/R3 在本阶段得到**闭合解释**：

| 现象 | 上游对应实现 | 根因 |
|---|---|---|
| `controller.ts:261-264` 从**裸 KV 键** `audioCacheSecs` 等读取，而渲染层持久化在 `pinia:setting` | 上游 `src/main/player/controller.ts:162-222` 的 `getPersistedNativeAudioConfig()` 调用 **`getPersistedRendererSettings()`**（同一 helper 在 YanMusic 仍存在且被 `networkSettings.ts` 正确使用），一次读取 **13 个字段** | 移植到 libmpv 时改用 KV 直读，**键名未随渲染层持久化结构更新** |
| 8 个设置项（`audioSamplerate`/`audioChannels`/`audioFormat`/`gaplessAudio`/`demuxerReadaheadSecs`/`cache`/`cachePause`/`cachePauseWaitSecs`）定义了 UI 但无消费方 | 这 8 项正是上游 `PlayerConfigOptions` 的字段，上游经 `initialize(config)` 一次性下发 | libmpv 只映射了其中 4 项（且键错），其余 8 项**失去消费方**；作者移植报告 §2 阶段 B 也记载这些字段当时「无任何 UI」，后续补了 UI 但未补引擎接线 |
| 额外发现：`command('set_property', prop, value)` 只路由 8 个固定属性名，其余静默无操作 | — | 意味着即便想让这 8 项生效，也**必须先给 Rust addon 增加属性白名单**（`mpv_set_property`），当前 addon 未暴露通用属性写入口 |

**建议的修复顺序（未在本次执行，见「未解决项」）**：① 把 `controller.ts` 的 4 项改为经 `getPersistedRendererSettings()` 读取（1 行级改动，与 `networkSettings.ts` 同范式）；② 在 `yan-mpv-player` 增加受限 `setProperty(name, value)` 白名单（`audio-samplerate`/`audio-channels`/`audio-format`/`gapless-audio`/`demuxer-readahead-secs`/`cache`/`cache-pause`/`cache-pause-wait`）并在 `initialize` 时下发；③ 同步修正 README 的 EQ 段数文案。

---

## 6. 阶段 3 验收自检

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| 上游源码已获取 | 能列出 `echo-ffmpeg-player` 文件树 | ✅ 完整树（~60 个 Rust 文件 + 4 个 vendored crate）已列出，见 §1.1 | **PASS** |
| `vpf.rs` 有逐段解读 | 报告含其职责、关键函数、与 libmpv 对比 | ⚠️ **该文件在上游不存在**。已给出等效解读：VPF 由外部 Provider 经 `EchoDspConfig.resource_json` 处理，附 `graph.rs:211`、`dsp/provider.rs` ABI 结构、上游设计文档裁定原文 | **PARTIAL**（对象不存在，已用等效证据替代） |
| 能力对照表完整 | 覆盖解码/输出/EQ/IR/同步/看门狗/淡入淡出 | ✅ §3 覆盖 22 行能力项，含全部要求项 | **PASS** |
| ≥3 方案含工作量与最小 demo | 每方案给出人日/人周 + demo 定义 | ✅ A/B/C 三方案，均含工作量、风险、收益、最小 demo；另给出推荐项的一手证据 | **PASS** |
| 未复制上游代码进 YanMusic | `git status` 无上游源码新增 | ✅ `git status` 中 `native/` 下仅有 1 个文件改动（`yan-spectrum-capture/src/backend/macos_sck.rs` 的 A 档类名改名），**无任何新增文件**；上游源码始终位于 `C:\coding\EchoMusic\EchoMusic-main`（仓库外） | **PASS** |

### 推荐结论

**推荐方案 C，并从 C1（EQ 前级补偿）起步**：它是唯一有本次会话一手证据（应用自身日志的 clipping 告警）支持、且改动面最小（单函数 + 对数网格测量）、风险最低（不触碰实时线程与平台 FFI）的改进。
方案 A 仅在明确需要 **VPF/第三方 DSP Provider 生态**时才值得投入（3–5 人月）；方案 B 存在**公开 API 层面的架构障碍**（libmpv 不向嵌入方导出解码 PCM），不建议作为主路径。
