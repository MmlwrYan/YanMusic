# Icon References

这个目录用于存放未直接参与当前运行时加载或打包配置引用的图标参考素材，方便后续继续迭代应用图标与托盘图标设计。

## 当前文件说明

- `icon.svg`：通用应用图标矢量参考稿（1024×1024，白底圆角 + 「Yan」+「MUSIC」）
- `icon_macos.svg`：macOS 应用图标矢量参考稿（图标主体占中间 824×824，四周透明安全边距）
- `icon_macos.png`：macOS 应用图标位图源稿，带透明安全边距；`icon.icns` 由它同源的矢量稿生成
- `mac_tray_icon_template.svg`：macOS 托盘模板图矢量稿（黑色圆角方块 + 镂空「Yan」）
- `mac_tray_icon_template.png`：对应的 1024×1024 位图参考稿
- `win_tray_icon_dark.ico`：Windows 深色背景用托盘 ICO（白色圆角方块 + 镂空「Yan」，16/20/24/32/40/48/64）
- `win_tray_icon_light.ico`：Windows 浅色背景用托盘 ICO（黑色圆角方块 + 镂空「Yan」，同上尺寸）

## 当前项目实际使用的主要图标

- `build/icons/icon.png`
- `build/icons/icon_macos.png`
- `build/icons/icon.ico`
- `build/icons/icon.icns`
- `build/icons/IconTemplate.png`
- `build/icons/IconTemplate@2x.png`
- `build/icons/linux_256x256.png`
- `build/icons/linux_tray_icon.png`
- `build/icons/win_tray_icon.ico`

请不要将本目录中的文件误认为当前运行时生效资源；它们主要用于设计参考与后续调整。

## 重新生成方式

1. 读取 `build/tools/gen-icons.mjs` 导出的 `ICON_SPEC`（`node build/tools/gen-icons.mjs --spec`）得到
   `references/*.svg` 与 `buildTraySvg()` 变体对应的全部位图清单；
2. 用 Chromium（Electron 离屏窗口或 Edge/Chrome `--headless --screenshot`）把每张 SVG 按 `ICON_SPEC.jobs`
   的精确像素尺寸栅格化为 `<design>-<size>.png`；
3. `node build/tools/gen-icons.mjs --png-dir <栅格化目录>` 组装出 ICO/ICNS 与最终文件名。
