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

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
    powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipNative
#>
[CmdletBinding()]
param(
    [switch]$SkipNative,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$script:failed = 0

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @()
    )

    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Exe @Arguments
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

# 4) Lint（自 v1.2.3 起不带 --fix，须 0 error / 0 warning）
Invoke-Step -Name 'Lint eslint .' -Exe 'node' -Arguments @('node_modules/eslint/bin/eslint.js', '.') | Out-Null

# 5) 原生层（本版触碰 native/ 时不可跳过）
if (-not $SkipNative) {
    Invoke-Step -Name '原生检查 cargo check --workspace --release' -Exe 'cargo' -Arguments @('check', '--workspace', '--release') | Out-Null
}
else {
    Write-Host '==> 已跳过 cargo check（-SkipNative）' -ForegroundColor Yellow
}

$elapsed = (Get-Date) - $startedAt
Write-Host "总耗时: $($elapsed.ToString('mm\:ss'))" -ForegroundColor DarkGray

if ($script:failed -gt 0) {
    Write-Host "验证失败：$script:failed 项未通过" -ForegroundColor Red
    exit 1
}

Write-Host '全部验证通过' -ForegroundColor Green
exit 0
