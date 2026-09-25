# 发布流程 SOP（Release Process）

> 本文是维护者发布新版本时必须逐步执行的清单。每一步都给出**可复制执行的命令**与**验收标准**，
> 目的是让发布过程可复现、可自证，并避免历史上出现过的两类事故：
> ①**未全绿就打 tag**；②**Release 标题需要事后手工修正**。

## 0. 前置条件

- [ ] 工作区干净：`git status --porcelain` 无输出
- [ ] 本地 `HEAD` 与 `origin/main` 一致：`git rev-parse HEAD` == `git rev-parse origin/main`
- [ ] `gh` 已认证且 token 含 `repo` + `workflow` scope：`gh auth status`

```powershell
git status --porcelain
git rev-parse HEAD; git rev-parse origin/main
gh auth status
```

## 1. 版本号与 CHANGELOG

- [ ] `package.json` 的 `version` 改为目标版本（应用版本的**唯一来源**，全仓 `app.getVersion()` 均由此派生）
- [ ] `CHANGELOG.md` 新增 `## [X.Y.Z]` 段，标题格式必须与历史一致（CI 用 `index($0,"[X.Y.Z]")` 抽取发布说明）
- [ ] **补丁版本不得包含 `### 新功能` 段**
- [ ] 待发布的段落顺序：`修复` → `新增` → `变更` → `说明`
- [ ] `说明` 段必须写明：验证结果、跳过项及其理由与前置条件、已知问题

## 2. 本地全量验证（五项，任一失败即停止）

```powershell
pnpm test                                      # 全部用例通过，fail 0
pnpm exec vue-tsc --noEmit                     # exit 0
pnpm exec vite build                           # exit 0
cargo check --workspace --release              # 退出码 0（注意：PowerShell 会把 cargo 的 stderr 进度当错误，用 $LASTEXITCODE 判定）
pnpm exec eslint . --ext .vue,.js,.ts,.jsx,.tsx  # 与上一版持平或更好
```

> `pnpm lint` 带 `--fix`，会改写工作区文件，**不要**用它做验证。

## 3. 本地模拟 Release Notes 抽取

CI 从 CHANGELOG 抽取正文（见 `.github/workflows/build.yml` 的 `Extract changelog for current version`）。
抽取逻辑为：取首个 `## [` 之前的内容作 header（去掉标题行与空行），再取 `[版本]` 段的正文。发布前应先确认抽取结果非空且不越界到上一个版本。

## 4. 推送 main 并干跑 CI

```powershell
git push origin main
gh workflow run build.yml            # 在 main 上干跑：release job 受 tag 守卫保护，不会建 Release
```

- [ ] 三平台（macOS / Windows / Linux，共 6 条腿）全部 success
- [ ] **若本次改动涉及 Windows 腿的偶发失败**：连续触发 ≥3 次全绿才可打 tag
- [ ] 注意 `concurrency: cancel-in-progress: true`：**同一 ref 的新 dispatch 会取消正在跑的旧 run**，必须等前一次结束后再触发

## 5. 打标注 tag

```powershell
git tag -a vX.Y.Z -m "YanMusic vX.Y.Z Release"
git push origin vX.Y.Z
git rev-parse "vX.Y.Z^{commit}"       # 必须等于本地 HEAD
git ls-remote --tags origin | Select-String vX.Y.Z
```

- [ ] tag 为 **annotated**（`-a`），信息格式 `YanMusic vX.Y.Z Release`（与历史一致）
- [ ] tag 指向的 commit 与 `HEAD` 相同

> **禁止删除已推送的 tag。** tag 一旦推送即不可移动；若该版本构建失败，按第 7 节处理。

## 6. 等待 Release 并**手工修正标题**

推送 tag 会触发完整构建 → `Publish Release Assets` → 自动创建 Release。

```powershell
gh run list --workflow=build.yml --limit 1
gh run view <RUN_ID> --json status,conclusion
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,url
```

**必做：修正 Release 标题。** `.github/workflows/build.yml` 的发布步骤（`softprops/action-gh-release`）未设置 `name:`，
GitHub 会默认以 **tag 名**（如 `vX.Y.Z`）作为 Release 标题，而本项目的约定是 `YanMusic vX.Y.Z Release`：

```powershell
gh release edit vX.Y.Z --title "YanMusic vX.Y.Z Release"
gh release view vX.Y.Z --json name,tagName --jq '.name'
```

> 为什么不直接改工作流：`release` job 受 `if: startsWith(github.ref, 'refs/tags/')` 守卫，
> **无法用 `workflow_dispatch` 干跑验证**；在主仓创建测试 tag 会触发一次真实的全平台构建并生成 Release。
> 因此该改动需要先有可验证的路径（fork 演练或经授权的测试 tag）才能安全落地。

## 7. 发布后自检

- [ ] Release 正文与 `CHANGELOG.md` 的 `## [X.Y.Z]` 段一致（去空白后逐字对比）
- [ ] 产物覆盖三平台：macOS `dmg`/`zip`、Windows `Setup x64/arm64`、Linux `AppImage`/`deb`/`rpm` 等，且文件名含正确版本号
- [ ] Release 非 draft、非 prerelease
- [ ] `git status` 干净，`HEAD` == `origin/main` == `vX.Y.Z^{commit}`
- [ ] `v*` 历史 tag 均未被移动（`git ls-remote --tags origin`）

## 8. 发布失败补救（tag 已推送但构建失败）

1. **不得删除已推送 tag。**
2. 将 Release 转为 draft 并在正文顶部标注「发布失败，等待修复」：
   ```powershell
   gh release edit vX.Y.Z --draft --notes "> ⚠️ 发布失败，等待修复。详见 <run URL>"
   ```
3. 输出《发布失败报告》：失败阶段 / 平台 / 报错 / 建议路径。
4. 后续路径（需人工决策）：修复后发布下一个版本；或在**显式授权**后重发 tag。
