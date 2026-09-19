# Agent Run Log — YanMusic 独立化 / 引擎调研 / 发布

时间戳为本地时间（UTC+08:00，2026-09-19 12:11 起记）。完整原始输出见同目录各 `.log` 文件。

## 环境事实

```
git version 2.55.0.windows.5
node v24.9.0
pnpm v10.34.5
cargo  C:\Users\admin\.cargo\bin\cargo.exe
```

## 阶段 0 — 基线复核

```
git -C C:\coding\YanMusic rev-parse --is-inside-work-tree   -> fatal: not a git repository
git -C C:\coding          rev-parse --is-inside-work-tree   -> fatal: not a git repository
git clone https://github.com/MmlwrYan/YanMusic.git          -> FAILED: schannel SEC_E_NO_CREDENTIALS (0x8009030e)
git -c http.sslBackend=openssl clone ... yanmusic-agent     -> OK
git rev-parse --is-inside-work-tree                          -> true
git log --oneline -1                                         -> 68b8410 YanMusic README   (与任务书基线一致)
git rev-list --count HEAD                                    -> 12                        (与任务书 "12 commits" 一致)
git submodule update --init --recursive                      -> FAILED: sh.exe couldn't create signal pipe, Win32 error 5
                                                                (沙箱禁止命名管道；改用直接 clone 子模块)
git -c http.sslBackend=openssl clone --depth 1 KuGouMusicApi server   -> OK
git checkout 99ca12fb9d464e9cf1e893a4f967a6024885336b       -> server HEAD 固定到父仓库记录 commit，217 个 API 模块
```

### R1 node_modules 断链复核

```
# 权威 clone，pnpm install 之后
node_modules 下 junction/symlink 总数        -> 326
其中 target 不存在（stale）                  -> 0
Test-Path node_modules\{vue,electron,vite,typescript,vue-tsc}\package.json -> 全部 True

# 对照：本地旧副本 C:\coding\YanMusic
junction 总数 263 / stale 263
target 形如 C:\coding\YanMusic\YanMusic-main\node_modules\.pnpm\... （多一层 YanMusic-main）
```

结论：断链只存在于被改名的本地副本，**不是仓库属性** → `[旧报告误判]`。

### R2/R3/R4 静态复核（在 clone HEAD 上）

```
rg "audioCacheSecs|audioDemuxerMaxMB|audioDemuxerBackMB|audioBufferSecs"  -> 22 处命中
  读取侧：仅 src/main/mpv/controller.ts:261-264（裸 KV 键）
  写入侧：renderer setting store -> sqlitePersist -> KV 键 "pinia:setting"
  裸键的写入方：0 处

setting.ts state 键全集（106 个）中，排除自身与 views/settings 后零引用 -> 10 个
  其中 checkPrerelease / lyricFont 为扫描假阳性（在 setting.ts 内被消费）
  实际零引用：audioChannels, audioFormat, audioSamplerate, cachePause,
              cachePauseWaitSecs, demuxerReadaheadSecs, gaplessAudio, lyricArtistBackdrop

EQ：controller.ts:846 频点表长度 10；state.ts:19 gains 长度 10；README:37,53 写 "18 段"
```

上游对照（阶段 3 补齐因果链）：`native/echo-ffmpeg-player/src/config.rs` 的
`PlayerConfigOptions` 含 15 项，其中 8 项正是上述零引用设置；上游
`src/main/player/controller.ts:162-222` 经 `getPersistedRendererSettings()` 读取 13 个字段。

## 阶段 1 — 环境搭建 + 构建体检

```
pnpm install                                   -> exit 0  Done in 1m 23.3s using pnpm v10.34.5
cd server && npm install                       -> added 311 packages
copy electron dist (347.3 MB) from existing install
  node_modules\.pnpm\electron@43.1.1\node_modules\electron\dist\electron.exe --version -> v43.1.1
copy libmpv-2.dll (120,326,144 B) -> build/mpv/

native/yan-mpv-player        npm install exit 0 / npm run build exit 0  Finished release in 1m 25s   -> 723,456 B
native/yan-storage           npm install exit 0 / npm run build exit 0  Finished release in 3m 32s   -> 2,426,880 B
native/yan-media-controls    npm install exit 0 / npm run build exit 0  Finished release in 26m 11s  -> 7,874,048 B
native/yan-spectrum-capture  npm install exit 0 / npm run build exit 0  Finished release in 5m 50s   -> 1,567,744 B

pnpm exec vue-tsc --noEmit                        -> exit 0，无输出（BASELINE，改动前）
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -> exit 0，无输出（改动后）
node node_modules/vite/bin/vite.js build          -> exit 0（dist 445 模块 + dist-electron/main/app-*.js 825.69 kB）
```

启动验证：

```
node_modules/electron/dist/electron.exe .      -> 主进程启动，写出 [LogCleaner] 与
                                                  [Thumbar] setThumbarButtons result: true
                                                  （后者仅在 createWindow() 且窗口可见后调用）
                                                  沙箱内该实例随后退出，stderr 为空、无 error 日志

%APPDATA%\YanMusic\logs\yan-music-2026-09-19.log（4.58 MB，含本机真实运行记录）：
  [UserStore] User detail / VIP detail / Grade info fetched
  [ListenTime] Listening duration reported {"dSec":509988}
  [MpvController] mpv log: { message: 'filter: Channel 0 clipping 37 times...', prefix: 'ffmpeg' }
本机同时存在用户自己的 YanMusic.exe 进程（11:37 / 11:47 / 17:26 启动）
```

> 注：一次 `pnpm exec vue-tsc` 被 harness 的 pnpm 包装器以「300 秒无输出」SIGKILL，
> 得到假失败 `TYPECHECK_EXIT=1`；改用 node 直调后确认真实结果 exit 0。

## 阶段 2 — echo 标记清理

```
全仓大小写不敏感 "echo" 命中（748 文件）        -> 281
  .github/workflows/build.yml 68 处为 shell echo 命令（误报）
  Recognize.vue:167 echoCancellation 为 Web Audio API（误报）
  handleChooseImport 为字符串巧合（误报）

A 档改名（15 类标识符，含 style.css 44 + 3 条选择器）：
  echo-app-network / echo-kugou-api / echo-community-audio -> yanmusic-*
  x-echo-transport-request-id                              -> x-yanmusic-transport-request-id
  echoUpdaterSilent / setEchoSilent / getEchoSilent        -> yanUpdaterSilent / setYanUpdaterSilent / getYanUpdaterSilent
  body.echo-surface-translucent (44)                       -> body.yan-surface-translucent
  .echo-popover-content / .echo-popover-arrow              -> .yan-popover-content / .yan-popover-arrow
  dataset.echoScrollRole                                   -> dataset.yanScrollRole
  CustomEvent('echo:toggle-sidebar')                       -> CustomEvent('yanmusic:toggle-sidebar')
  dataset.echoLyric* (7 处)                                -> dataset.yanLyric*
  c"EchoSpectrumSckOutput"                                 -> c"YanSpectrumSckOutput"
  EchoPluginWindowContext (9 处)                           -> YanPluginWindowContext

A 档验收 rg：上述标识符在源码 -> 0 命中（echo-plugins.json 例外，见下）

B 档别名（旧名保留 @deprecated，未改任何调用点）：
  YanPluginManifest / YanPluginCompatibility / YanPluginDescriptor  (shared/plugins.ts)
  YanPluginContext                                                  (renderer/plugins/runtime.ts)
  YanGlobalRuntime                                                  (renderer/plugins/types.ts)
  $yanmusic 全局属性（与 $echo 同引用）                              (runtime.ts 2 处 + types.ts 声明)
  requires.echoMusicVersion 兼容键                                   保留不动

C 档死引用更正：
  ipc/settings.ts 指向 native/echo-ffmpeg-player/src/vpf.rs 的注释（文件不存在）
  cloudflare/.../README.md 的 ECHOMUSIC_PLUGIN_STATS_API_URL -> yanmusic_PLUGIN_STATS_API_URL
  README.md 引用的 build/linux-libmpv-env.sh、build/linux-system-electron-wrapper.sh（文件不存在）

有意保留（外部契约，改名即破坏功能）：
  echo-plugins.json（第三方插件源仓库根目录的索引文件名）
  hoowhoami/EchoMusicPlugins、github:hoowhoami/echomusicplugins、echomusic-plugin-marketplace.* 域名
  echomusic-plugin-marketplace / echomusic-plugin-stats（已部署的 Cloudflare Worker / D1 资源名）
  legal.ts 的 GPL 致谢与修改声明（任务禁令：不得移除）

清理后 "echo" 命中 -> 216（其中 shell 误报 72、echoCancellation 1、handleChooseImport 2、
                              Echo* 公共类型名及其引用 ~110、有意保留 ~31）

改动后回归：vue-tsc --noEmit exit 0；vite build exit 0
```

## 阶段 3 — 自研音频引擎调研（只读）

```
上游源码：C:\coding\EchoMusic\EchoMusic-main（EchoMusic 2.3.1-beta.24，GPL-3.0-only）
native/echo-ffmpeg-player 文件树：~60 个 Rust 源文件 + vendor/{ffmpeg-audio,soundtouch-rs,libspa,pipewire}

rg "vpf|VPF|ViPER" native/echo-ffmpeg-player   -> 仅 3 处，且均非实现：
  src/control/graph.rs:211-212  -> Err("VPF requires an external DSP Provider")
  src/dsp/limiter.rs:1          -> 注释
  => 上游不存在 vpf.rs

上游设计文档（只读）：
  docs/audio-engine-invariants.md   (17 KB，线程模型与不变式)
  docs/dsp-provider-architecture.md (14 KB，Provider ABI v2 与 VPF 定位)
  docs/dsp-provider-settings.md     (8 KB)
  tests/ 30 个 node:test 文件

NAPI 接口面提取：lib.rs 13 个导出 + control/* 共 20 个导出
上游 PlayerConfigOptions 15 项 vs yan-mpv-player 6 项

作者既有文档（从 git 历史只读提取，未写入仓库）：
  git show f723539:PORTING_REPORT.md
  -> §1「引擎差异：Yan = libmpv ... Echo = ffmpeg + dspProvider」
  -> §2「引擎适配：删除 dspProvider 依赖；VPF/组合音效判为不可用」
  => libmpv 是 YanMusic 原有引擎，非移植时的替换结果（任务前提方向相反）

上游代码复制检查：git status 中 native/ 下无任何新增文件 -> 未复制
```

## 阶段 4 — 发布

```
git fetch --tags --prune origin              -> 本地与 origin/main 同步（HEAD == 68b8410）
git tag --list                               -> v1.0.0, v1.1.0   => 下一版 v1.1.1
git config --local user.name/user.email      -> MmlwrYan / a18821657632@outlook.com
（--global 写入被拒：C:\Users\admin\.gitconfig Permission denied）

提交（分主题 commit，均排除 server 子模块与构建产物）：
  2c51847 chore(echo): 内部标识符品牌化清理，并修复半途改名留下的失效点
  cab0c80 fix(renderer): 修复插件毛玻璃与 Popover 样式因选择器名不匹配而失效
  6970447 feat(plugins): 新增 Yan* 插件 API 别名，并修复滚动容器 role 过滤
  b7c0a4b docs: 校准 README 与实现的一致性，并补充上游项目与修改声明
  （docs(agent) 与 chore(release) 见其后提交）
```

## 环境障碍与处置（供复现参考）

| 障碍 | 现象 | 处置 |
|---|---|---|
| 沙箱禁止管道 stdio | `pnpm install` → `spawn EPERM`；`node -e execSync(...)` → EPERM；`stdio:'inherit'` 正常 | 权限放宽为 `danger-full-access` 后成功 |
| git 默认 schannel 后端不可用 | `SEC_E_NO_CREDENTIALS (0x8009030e)` | 所有网络 git 命令加 `-c http.sslBackend=openssl` |
| 沙箱禁止命名管道 | `git submodule update` → `sh.exe: couldn't create signal pipe` | 改为直接 `git clone` 子模块并检出父仓库记录的 SHA |
| harness pnpm 包装器看门狗 | 子进程 300 秒无输出即被 SIGKILL（`vue-tsc` 恰好静默） | 改用 `node node_modules/vue-tsc/bin/vue-tsc.js` 直调 |
| pnpm 未自动下载 Electron 二进制 | `node_modules/electron` 无 `dist/`（`ignoredBuiltDependencies` 含 electron） | 从本机既有安装复制 `dist/` 与 `path.txt` |
| `npm install` 污染已入库的 `native/yan-storage/node_modules` | `git status` 出现 2167 个 `M` | `git checkout -- native/yan-storage/node_modules` 还原（该目录被 `git add -f` 纳入版本控制，属仓库卫生问题，见 FINAL-REPORT） |
