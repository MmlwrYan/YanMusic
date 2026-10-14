<#
.SYNOPSIS
    YanMusic 本机运行时环境自检与修复（V4-21，v1.4.0）。

.DESCRIPTION
    为什么需要这个脚本：本机跑不起应用的三处阻塞**各自独立**，而它们长期被
    误记为「环境不可用」，代价已经付过至少两次（见
    `C:\coding\YanMusic\docs\agent\future-roadmap-2026-10-09.md` §10.1）：

      ① Electron 二进制缺失  —— 只是没执行安装步骤（pnpm 的
         `ignoredBuiltDependencies` 含 electron，不会自动下载）；
      ② `ELECTRON_RUN_AS_NODE=1` 被注入到会话环境 —— Electron 会退化成
         **纯 Node**，`require('electron')` 返回路径字符串，启动即
         `TypeError: Cannot read properties of undefined (reading 'setAppUserModelId')`；
      ③ cargo 源镜像不可达 —— 历史记录写成「代理 502」，**与真实根因不符**。

    本脚本**默认只检测并报告**，加 `-Fix` 才动手。
    `-Fix` 只做两件可逆的事：下载 Electron 二进制、清除污染变量。
    **绝不自动修改 ~/.cargo/config.toml**（全局配置），只给出确切建议。

    编码要求：本文件含中文，**必须以 UTF-8 with BOM 保存**。
    Windows PowerShell 5.1 在没有 BOM 时按 ANSI/GBK 解读 .ps1，
    中文会被解成乱码并导致**语法解析失败**。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local-runtime.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local-runtime.ps1 -Fix
#>
[CmdletBinding()]
param(
    [switch]$Fix,
    [string]$ElectronMirror = 'https://npmmirror.com/mirrors/electron'
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Write-Host "[FAIL] 仓库根判定错误：$root 下没有 package.json" -ForegroundColor Red
    exit 1
}
Set-Location $root

$script:problems = 0
$script:fixed = 0

function Write-Head($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "   [OK]   $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "   [需处理] $text" -ForegroundColor Yellow; $script:problems++ }
function Write-Info($text) { Write-Host "   $text" -ForegroundColor DarkGray }

# ───────────────────────── ① Electron 二进制 ─────────────────────────

Write-Head '① Electron 二进制'

$electronPkg = Join-Path $root 'node_modules\electron'
$electronDist = Join-Path $electronPkg 'dist'
$electronExe = Join-Path $electronDist 'electron.exe'

$electronVersion = ''
$pkgJson = Join-Path $electronPkg 'package.json'
if (Test-Path $pkgJson) {
    try { $electronVersion = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } catch { }
}

if ((Test-Path $electronExe) -and (Test-Path (Join-Path $electronPkg 'path.txt'))) {
    Write-Ok "已就位（v$electronVersion）"
} else {
    Write-Bad "Electron 二进制缺失"
    Write-Info "实测可用的镜像：$ElectronMirror（github.com 在本机不可达，别用官方源）"
    if (-not $electronVersion) {
        Write-Info "无法从 node_modules/electron/package.json 读到版本号 —— 请先跑依赖安装"
    } elseif ($Fix) {
        $zipName = "electron-v$electronVersion-win32-x64.zip"
        $url = "$ElectronMirror/$electronVersion/$zipName"
        $tmpZip = Join-Path $root ".workbuddy\tmp\$zipName"
        New-Item -ItemType Directory -Path (Split-Path $tmpZip) -Force | Out-Null

        Write-Info "下载 $url"
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $tmpZip -TimeoutSec 1800 -UseBasicParsing

            # 校验：与官方 SHASUMS256.txt 比对（镜像可能滞后或损坏）
            $expected = $null
            try {
                $sums = (Invoke-WebRequest -Uri "$ElectronMirror/$electronVersion/SHASUMS256.txt" -TimeoutSec 120 -UseBasicParsing).Content
                $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1)
                if ($line) { $expected = ($line -split '\s+')[0].Trim().ToLower() }
            } catch { Write-Info "（未能取到 SHASUMS256.txt，跳过校验）" }

            if ($expected) {
                $actual = (Get-FileHash $tmpZip -Algorithm SHA256).Hash.ToLower()
                if ($actual -ne $expected) {
                    Write-Host "   [FAIL] SHA256 不匹配：" -ForegroundColor Red
                    Write-Host "          期望 $expected" -ForegroundColor Red
                    Write-Host "          实际 $actual" -ForegroundColor Red
                    exit 1
                }
                Write-Ok "SHA256 校验通过（$actual）"
            }

            Add-Type -AssemblyName System.IO.Compression.FileSystem
            New-Item -ItemType Directory -Path $electronDist -Force | Out-Null
            $archive = [System.IO.Compression.ZipFile]::OpenRead($tmpZip)
            [System.IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, [System.IO.Path]::GetFullPath($electronDist))
            $archive.Dispose()

            # path.txt 必须无换行：electron 的 index.js 直接读它拼路径
            Set-Content -Path (Join-Path $electronPkg 'path.txt') -Value 'electron.exe' -NoNewline -Encoding ascii
            $script:fixed++

            if (Test-Path $electronExe) {
                Write-Ok "已解压并校验：$electronExe"
            } else {
                Write-Host "   [FAIL] 解压后仍找不到 electron.exe" -ForegroundColor Red
                exit 1
            }
        } catch {
            Write-Host "   [FAIL] 下载/解压失败：$($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
}

# ───────────────────── ② ELECTRON_RUN_AS_NODE 污染 ─────────────────────

Write-Head '② ELECTRON_RUN_AS_NODE 污染'

$runAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE')
if ($runAsNode) {
    Write-Bad "当前进程环境中 ELECTRON_RUN_AS_NODE='$runAsNode'"
    Write-Info '危害：Electron 退化为纯 Node，require("electron") 返回路径字符串，'
    Write-Info '      启动即 TypeError: Cannot read properties of undefined (reading setAppUserModelId)。'
    if ($Fix) {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        $script:fixed++
        Write-Ok '已从**当前进程**清除（父 shell 里可能仍有 —— 启动应用时请再清一次）'
    }
} else {
    Write-Ok '当前进程环境干净'
}

# 用户/机器级是否被持久化（那是更难查的形态）
foreach ($scope in @('User', 'Machine')) {
    $persisted = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $scope)
    if ($persisted) {
        Write-Bad "$scope 级环境变量被持久化为 '$persisted' —— 每个新 shell 都会中招"
        Write-Info "清除： [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', \$null, '$scope')"
    }
}

# ───────────────────────── ③ cargo 源镜像 ─────────────────────────

Write-Head '③ cargo 源镜像'

$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$cargoConfig = Join-Path $cargoHome 'config.toml'
if (-not (Test-Path $cargoConfig)) {
    $cargoConfig = Join-Path $cargoHome 'config'
}

if (-not (Test-Path $cargoConfig)) {
    Write-Ok '未找到 cargo 全局配置 —— 走 crates-io 直连，无需处理'
} else {
    $text = Get-Content $cargoConfig -Raw
    $alias = ''
    $registry = ''
    # ⚠️ .NET 正则**不支持** `(?ms)` 这种行内组合标志 —— 它会**静默不匹配**，
    # 于是脚本落到「未设置 replace-with」分支，把「镜像坏了」误报成「走直连」。
    # 这个 bug 是本次用「注入一个不可达镜像」的反向验证才抓出来的。
    # 正确写法：`(?s)` 单行模式 + `[\s\S]`（两者都实测过）。
    if ($text -match '(?s)\[source\.crates-io\]([\s\S]*?)(?=\r?\n\[|$)') {
        $block = $Matches[1]
        if ($block -match 'replace-with\s*=\s*"([^"]+)"') { $alias = $Matches[1] }
    }
    if ($alias) {
        $aliasEsc = [regex]::Escape($alias)
        if ($text -match "(?s)\[source\.$aliasEsc\]([\s\S]*?)(?=\r?\n\[|$)") {
            $b2 = $Matches[1]
            if ($b2 -match 'registry\s*=\s*"([^"]+)"') { $registry = $Matches[1] }
        }
    }

    if (-not $alias) {
        Write-Ok "未设置 replace-with（$cargoConfig）—— 走直连"
    } else {
        Write-Info "配置：$cargoConfig"
        Write-Info "镜像：$alias → $registry"
        if (-not $registry) {
            Write-Bad 'replace-with 指向的 [source.*] 里没有 registry 字段'
        } else {
            $probe = ($registry -replace '^sparse\+', '').TrimEnd('/')
            $probeUrl = "$probe/config.json"
            try {
                $ProgressPreference = 'SilentlyContinue'
                $resp = Invoke-WebRequest -Uri $probeUrl -Method Head -TimeoutSec 12 -UseBasicParsing
                Write-Ok "镜像可达（HTTP $($resp.StatusCode)）"
            } catch {
                Write-Bad "镜像**不可达**：$probeUrl"
                Write-Host ''
                Write-Host '   这不是「代理 502」，也不是代码问题 —— 是镜像本身不可达。' -ForegroundColor Yellow
                Write-Host '   历史记录把它写成「代理 502」，导致 N 组技术债被反复推迟。' -ForegroundColor DarkGray
                Write-Host ''
                Write-Host '   可用解法（择一，改前先备份该文件）：'
                Write-Host '     ① 换可达镜像（实测 USTC 可用）：'
                Write-Host '          [source.ustc]'
                Write-Host '          registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"'
                Write-Host '        并把 replace-with 改为 "ustc"'
                Write-Host '     ② 删掉 replace-with，直连 sparse+https://index.crates.io/'
                Write-Host '     ③ 试试 cargo check --offline（本地缓存足够时无需联网）'
                Write-Host ''
                Write-Host '   本脚本**不会**自动改它 —— 那是全局配置，须由人决定。' -ForegroundColor DarkGray
            }
        }
    }
}

# ───────────────────────── ④ 其它运行时依赖 ─────────────────────────

Write-Head '④ 其它运行时依赖'

$libmpv = Join-Path $root 'build\mpv\libmpv-2.dll'
if (Test-Path $libmpv) {
    $size = (Get-Item $libmpv).Length
    Write-Ok "libmpv 就位（$size B）"
} else {
    Write-Bad 'build/mpv/libmpv-2.dll 缺失 —— 应用能启动但无法播放音频'
}

foreach ($dir in @('yan-mpv-player', 'yan-storage', 'yan-media-controls', 'yan-spectrum-capture')) {
    $node = Join-Path $root "native\$dir\$dir.node"
    if (Test-Path $node) {
        Write-Ok "$dir.node 就位"
    } else {
        Write-Bad "$dir.node 缺失 —— 需编译原生模块（见 README「编译 Rust 原生模块」）"
    }
}

$distMain = Join-Path $root 'dist-electron\main\index.js'
if (Test-Path $distMain) {
    Write-Ok "构建产物就位（$((Get-Item $distMain).Length) B）"
} else {
    Write-Bad 'dist-electron/main/index.js 缺失 —— 先跑构建（node node_modules/vite/bin/vite.js build）'
}

# ───────────────────────── 汇总 ─────────────────────────

Write-Head '汇总'
if ($script:problems -eq 0) {
    Write-Host '   ✅ 本机运行时环境检查全部通过' -ForegroundColor Green
    Write-Host '      启动方式（注意先清污染变量）：' -ForegroundColor DarkGray
    Write-Host '        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue' -ForegroundColor DarkGray
    Write-Host '        Start-Process node_modules\electron\dist\electron.exe -ArgumentList "."' -ForegroundColor DarkGray
    exit 0
}

if ($Fix) {
    Write-Host "   仍有 $script:problems 项在报告后未自动处理（本次已修复 $script:fixed 项）" -ForegroundColor Yellow
    Write-Host '   上述「需处理」项中，凡涉及全局配置或需要人决策的，本脚本刻意不动。' -ForegroundColor DarkGray
    exit 1
}

Write-Host "   发现 $script:problems 项待处理。加 -Fix 可自动处理其中可逆的部分" -ForegroundColor Yellow
Write-Host '   （Electron 二进制下载 + 清除当前进程的 ELECTRON_RUN_AS_NODE；' -ForegroundColor DarkGray
Write-Host '     绝不自动修改 ~/.cargo/config.toml）。' -ForegroundColor DarkGray
exit 1
