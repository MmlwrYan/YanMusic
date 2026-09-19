# 阶段 4 — GitHub 发布报告

> 结果：**发布成功**。8 个提交已推送至 `main`，`v1.1.1` tag 已推送并触发全平台构建，**GitHub Release v1.1.1 已发布，含 22 个产物**。

---

## 1. 推送前核对

```
git fetch --tags --prune origin        -> 本地与 origin/main 同步（HEAD == 68b8410）
git log --oneline origin/main..HEAD    -> 空（无待推送历史分叉）
git tag --list                         -> v1.0.0（轻量）、v1.1.0（附注，message "YanMusic v1.1.0"）
git ls-remote --heads origin           -> refs/heads/main = 68b841071cab676ed9b89f575910160b0e7dd1d4
```

**版本号决策 `[自主决策]`**：现有 tag 为 `v1.0.0`、`v1.1.0`，`package.json` 为 `1.1.0`。按任务书「不确定时取 patch+1」→ 采用 **`v1.1.1`**。
同时把 `package.json` 版本同步为 `1.1.1`：CI 用 `${GITHUB_REF_NAME#v}` 从 tag 抽取 CHANGELOG 段落，而 electron-builder 用 `package.json` 的 version 命名产物；两者不一致会导致产物名与 Release 标题不符。

**推送凭据**：`credential.helper = manager`（Git Credential Manager 已存有该仓库凭据），无 `GH_TOKEN`/`GITHUB_TOKEN` 环境变量。先以 `git push --dry-run` 探测，返回 `68b8410..86ae5ba main -> main` → 确认为 fast-forward 且凭据可用，**全程未使用 force**。

---

## 2. 提交清单（8 个分主题提交）

| # | SHA | 类型 | 主题 |
|---|---|---|---|
| 1 | `2c51847` | chore(echo) | 内部标识符品牌化清理，并修复半途改名留下的失效点 |
| 2 | `cab0c80` | fix(renderer) | 修复插件毛玻璃与 Popover 样式因选择器名不匹配而失效 |
| 3 | `6970447` | feat(plugins) | 新增 Yan* 插件 API 别名，并修复滚动容器 role 过滤 |
| 4 | `b7c0a4b` | docs | 校准 README 与实现的一致性，并补充上游项目与修改声明 |
| 5 | `bf5173b` | docs(agent) | 新增基线复核、构建体检、echo 清理与音频引擎调研报告 |
| 6 | `4b5e507` | chore(release) | 版本号 1.1.1 与 CHANGELOG |
| 7 | `86ae5ba` | docs(agent) | 补入原始日志留痕，并撤回一处编码误判 |
| 8 | `5f0fa83` | docs(agent) | 记录推送前的最终校验输出 |

改动统计（`git diff --stat origin/main..HEAD`）：**31 files changed, +1965 / −96**。

**未纳入提交的内容（有意排除）**：
- `server` 子模块：`git status` 显示 ` M server` 仅因其内部有 `npm install` 产生的未跟踪 `node_modules`；子模块指针 SHA 与父仓库记录值 `99ca12fb...` **一致**，未被提交。
- 构建产物：`dist/`、`dist-electron/`、`release/`、`target/`、`native/*/*.node`、`build/mpv/libmpv-2.dll` 均按 `.gitignore` 排除。
- 作者已移出交付树的过程文档 `PORTING_REPORT.md`：**未入库**（与作者既有裁定一致，仅从 git 历史只读引用，提取命令见 `run-log.md`）。

---

## 3. 推送结果

```
git -c http.sslBackend=openssl push origin main
  -> To https://github.com/MmlwrYan/YanMusic.git
     68b8410..5f0fa83  main -> main          exit 0

git tag -a v1.1.1 -m "YanMusic v1.1.1"
git -c http.sslBackend=openssl push origin v1.1.1
  -> * [new tag]  v1.1.1 -> v1.1.1             exit 0

git ls-remote origin refs/heads/main
  -> 5f0fa83eaa8dfab2ffd70acf9612ed18e09cddc4  (与本地 HEAD 一致)
git log --oneline origin/main..HEAD
  -> 空（全部已推送）
git ls-remote --tags origin | grep v1.1.1
  -> 04d5b574... refs/tags/v1.1.1        (附注 tag 对象)
     5f0fa83e... refs/tags/v1.1.1^{}     (指向的提交 = HEAD)
```

**未使用 `--force`，未改写任何历史，未删除远程分支。**

---

## 4. GitHub Actions 结果

触发条件核对（`.github/workflows/build.yml:3-7`）：`on: push: tags: ['v*']` + `workflow_dispatch`
⇒ **推送到 `main` 不触发构建**，仅 tag 触发；本次由 tag `v1.1.1` 触发。

| 项 | 值 |
|---|---|
| Workflow | `Build YanMusic Desktop`（run #6） |
| Run URL | https://github.com/MmlwrYan/YanMusic/actions/runs/35436787605 |
| 触发 | `event: push`，`head_branch: v1.1.1`，`head_sha: 5f0fa83e...`（= 本地 HEAD） |
| **结论** | **`status: completed` / `conclusion: success`** |
| 耗时 | 2026-09-19T10:13:02Z → 10:31:01Z（约 **18 分钟**） |
| 矩阵 job | 6 个，全部成功：`Windows-x64`(windows-latest)、`Windows-arm64`(windows-11-arm)、`Linux-x64`(ubuntu-22.04)、`Linux-arm64`(ubuntu-22.04-arm)、`macOS-x64`(macos-15-intel)、`macOS-arm64`(macos-14) |

各 job 的关键步骤均通过（抽查 Windows-arm64 与 Linux-x64 的 step 状态）：`Checkout code` → `Setup pnpm` → `Setup Node.js` → `Install Linux build dependencies` → `Install root dependencies` → `Setup Rust toolchain` → **4 个原生模块构建** → `Install server runtime dependencies` → `Download libmpv library` → `Build desktop app` → `Verify bundled Windows executable` / `Verify bundled macOS mpv signatures` → `Upload build artifacts`。

> 这同时是「4 个 Rust addon 在三个平台均可编译」的独立佐证：CI 在 macOS（arm64 + x64）、Linux（x64 + arm64）、Windows（x64 + arm64）六个 runner 上分别编译了 `yan-media-controls` / `yan-mpv-player` / `yan-storage` / `yan-spectrum-capture`。

---

## 5. Release 产物

| 项 | 值 |
|---|---|
| Release URL | **https://github.com/MmlwrYan/YanMusic/releases/tag/v1.1.1** |
| 发布者 | `github-actions[bot]` |
| 状态 | `draft: false`、`prerelease: false` |
| 发布时间 | 2026-09-19T10:30:47Z |
| **产物数量** | **22 个** |

产物清单（按名称排序）：

| 平台 | 产物 |
|---|---|
| Windows | `YanMusic-1.1.1-Windows-Setup-x64.exe` (149.2 MB)、`YanMusic-1.1.1-Windows-Setup-arm64.exe` (142.7 MB) |
| macOS | `YanMusic-1.1.1-macOS-x64.dmg` (168.7 MB)、`YanMusic-1.1.1-macOS-arm64.dmg` (163.6 MB)、`YanMusic-1.1.1-mac-x64.zip` (163.7 MB)、`YanMusic-1.1.1-mac-arm64.zip` (158.7 MB) |
| Linux x64 | `linux-x86_64.AppImage` (147.5 MB)、`linux-amd64.deb` (112.7 MB)、`linux-x86_64.rpm` (98.1 MB)、`linux-x64.pacman` / `linux-x64.pkg.tar.zst` (101.4 MB)、`linux-x64.tar.gz` (139.2 MB) |
| Linux arm64 | `linux-arm64.AppImage` (146.9 MB)、`linux-arm64.deb` (105.8 MB)、`linux-aarch64.rpm` (92.0 MB)、`linux-aarch64.pacman` / `linux-aarch64.pkg.tar.zst` (94.8 MB)、`linux-arm64.tar.gz` (138.4 MB) |
| 更新元数据 | `latest.yml`、`latest-linux.yml`、`latest-linux-arm64.yml`、`latest-mac.yml` |

Release 正文由 CI 的 `Extract changelog for current version` 步骤从 `CHANGELOG.md` 的 `## [1.1.1]` 段落抽取（该段落本次已新增，避免回退为「详见 CHANGELOG.md」）。

---

## 6. 阶段 4 验收自检

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| commit 已推送 | `git log origin/<branch>..HEAD` 为空 | 空 | **PASS** |
| 远程可见最新 commit | `git ls-remote origin` 含最新 SHA | `5f0fa83eaa8dfab2ffd70acf9612ed18e09cddc4  refs/heads/main` | **PASS** |
| CHANGELOG 已更新 | 含本次变更条目 | 新增 `## [1.1.1]` 段（变更/修复/文档/说明四节） | **PASS** |
| README 与代码一致项已校准 | 4 项均有对应修改 | Electron 43.1.1、自研 SQLite 持久化、EQ 10 段、补 `yan-spectrum-capture`；另修掉 README 两处死引用并新增「上游项目与修改声明」 | **PASS** |
| GPL 致谢与修改声明保留 | 源码 / README 仍在 | `legal.ts:47,76` 未改动；README「灵感来源」的 EchoMusic 条目未改动，并**新增**「上游项目与修改声明」小节 | **PASS** |
| Actions 触发（若打 Tag） | GitHub Actions 页面有对应 run | run #6 已触发并 **success** | **PASS** |
| Release 产物 | — | 22 个产物全部 `state: uploaded` | **PASS** |

**发布状态：已完成。** 无未解决的发布阻塞项。
