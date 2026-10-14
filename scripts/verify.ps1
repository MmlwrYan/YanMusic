<#
.SYNOPSIS
    YanMusic 发布前五项全量验证（docs/release-process.md §2 的固化脚本）。

.DESCRIPTION
    为什么要这个脚本：本机 pnpm / npx / npm 的 `.ps1` 垫片会被 PowerShell 执行策略拦截，
    而**它们的退出码仍然是 0** —— 只检查 `$LASTEXITCODE` 或只看输出尾部，
    会把「压根没执行」误判成「验证通过」。因此这里一律**直调 JS 入口**，
    并在每一步**显式断言退出码**，任何一步非 0 即整脚本非 0。

    本机无头环境下 `cargo` 可能离线，用 -SkipNative 跳过原生检查
    （但**本版若触碰 native/ 则必须跑**，或在能联网的机器上跑）。

    编码要求：本文件含中文，**必须以 UTF-8 with BOM 保存**。
    Windows PowerShell 5.1 在没有 BOM 时按 ANSI/GBK 解读 .ps1，
    中文注释会被解成乱码并导致**语法解析失败**（v1.2.9 首版即栽在此）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
    powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipNative
#>
[CmdletBinding()]
param(
    [switch]$SkipNative,
    [switch]$SkipBuild
)

# 刻意用 Continue 而不是 Stop：本脚本靠**显式断言 $LASTEXITCODE** 判断成败，
# 而 native 命令（node / cargo）会往 stderr 写正常日志（警告、进度），
# 在 Stop 下会被包装成 terminating error 而中断脚本 —— 那是误报，不是失败。
$ErrorActionPreference = 'Continue'

# 本文件位于 <repo>/scripts/verify.ps1，故仓库根 = $PSScriptRoot 的父目录。
# （v1.2.9 首版误写成连剥两层 → 根目录变成 <repo>/.. ，tests/ 找不到而立即退出。）
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Write-Host "[FAIL] 仓库根判定错误：$root 下没有 package.json" -ForegroundColor Red
    exit 1
}

$script:failed = 0

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @()
    )

    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ($code -ne 0) {
        Write-Host "[FAIL] $Name (exit=$code)" -ForegroundColor Red
        $script:failed += 1
        return $false
    }
    Write-Host "[OK]   $Name" -ForegroundColor Green
    return $true
}

$startedAt = Get-Date

# 1) 单元测试（显式展开文件列表：PowerShell 不做 glob 展开，直接传 tests/*.test.ts 会被当成字面量）
$testFiles = @(Get-ChildItem -Path (Join-Path $root 'tests') -Filter '*.test.ts' | ForEach-Object { $_.FullName })
if ($testFiles.Count -eq 0) {
    Write-Host '[FAIL] tests/ 下没有找到 *.test.ts' -ForegroundColor Red
    exit 1
}
Invoke-Step -Name '单元测试 node --test' -Exe 'node' -Arguments (@('--test') + $testFiles) | Out-Null

# 2) 类型检查
Invoke-Step -Name '类型检查 vue-tsc --noEmit' -Exe 'node' -Arguments @('node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit') | Out-Null

# 3) 构建（渲染层 + 主进程 + preload）
if (-not $SkipBuild) {
    Invoke-Step -Name '构建 vite build' -Exe 'node' -Arguments @('node_modules/vite/bin/vite.js', 'build') | Out-Null
}
else {
    Write-Host '==> 已跳过 vite build（-SkipBuild）' -ForegroundColor Yellow
}

# 3.5) 首屏体积守卫（S-5）。**必须在 build 之后**：它读 dist/index.html，无产物即失败。
# 单测里的同名用例在 CI 里必然 skip（CI 的 unit tests 早于 build），真正把关在这里。
if (-not $SkipBuild) {
    Invoke-Step -Name '首屏体积守卫 check-bundle-size' -Exe 'node' -Arguments @('scripts/check-bundle-size.mjs') | Out-Null
}
else {
    Write-Host '==> 已跳过首屏体积守卫（-SkipBuild，未重新构建产物）' -ForegroundColor Yellow
}

# 4) Lint（自 v1.2.3 起不带 --fix，须 0 error / 0 warning）
Invoke-Step -Name 'Lint eslint .' -Exe 'node' -Arguments @('node_modules/eslint/bin/eslint.js', '.') | Out-Null

# 5) 原生层（本版触碰 native/ 时不可跳过）
if (-not $SkipNative) {
    Invoke-Step -Name '原生检查 cargo check --workspace --release' -Exe 'cargo' -Arguments @('check', '--workspace', '--release') | Out-Null
}
else {
    Write-Host '==> 已跳过 cargo check（-SkipNative）' -ForegroundColor Yellow
}

# 5.5) 原生产物新鲜度（V4-01，v1.4.0）
# 防的形态：`.node` 在 .gitignore 里而 cargo 长期跑不通 → 出现过「产物 09-25、
# 源码 09-27」，于是 -SkipNative 报的「全绿」是在**旧二进制**上取得的。
# **必须放在 cargo check 之后**（先确认能编译，再确认产物是最新的）。
# 注意：本步骤**不受 -SkipNative 影响** —— 它检查的是「手上这份产物新不新」，
# 与「这次要不要重新编译」是两件事；跳过它等于放弃「假绿」这一整类判断。
Invoke-Step -Name '原生产物新鲜度 check-native-freshness' -Exe 'node' -Arguments @('scripts/check-native-freshness.mjs') | Out-Null

# 6) 本机运行时环境（V4-21，v1.4.0）—— 只报告，不阻塞
# 三处阻塞（Electron 二进制 / ELECTRON_RUN_AS_NODE / cargo 镜像）各自独立，
# 且长期被误记为「环境不可用」。这里做一次自检并把结论打出来，
# 但**不因其失败而让整轮验证失败** —— 环境缺件不等于代码有问题。
if (Test-Path (Join-Path $root 'scripts/setup-local-runtime.ps1')) {
    Write-Host '==> 本机运行时环境自检（仅报告，不计入成败）' -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts/setup-local-runtime.ps1') 2>&1 |
        ForEach-Object { Write-Host $_ }
}
else {
    Write-Host '==> 未找到 scripts/setup-local-runtime.ps1，跳过环境自检' -ForegroundColor Yellow
}

$elapsed = (Get-Date) - $startedAt
Write-Host "总耗时: $($elapsed.ToString('mm\:ss'))" -ForegroundColor DarkGray

if ($script:failed -gt 0) {
    Write-Host "验证失败：$script:failed 项未通过" -ForegroundColor Red
    exit 1
}

Write-Host '全部验证通过' -ForegroundColor Green
exit 0
