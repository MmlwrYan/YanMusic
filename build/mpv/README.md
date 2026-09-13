# build/mpv —— 播放引擎运行时目录

`src/main/mpv/path.ts` 会在此目录（打包后为 `resources/mpv`）递归查找 libmpv 动态库：

- Windows: `libmpv-2.dll` / `mpv-2.dll`
- macOS: `libmpv.dylib` / `libmpv.2.dylib`
- Linux: `libmpv.so` / `libmpv.so.2` / `libmpv.so.1`

## 当前状态（构建期说明）

本机网络对 `github.com` 的 release 下载不稳定（时通时断，实测 ~10–25 KB/s），
libmpv 运行时通过以下来源尽力获取，成功后会解压到本目录：

- `https://sourceforge.net/projects/mpv-player-windows/files/libmpv/mpv-dev-x86_64-*.7z`
- `https://ghproxy.net/https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/...`

若本目录仅有本说明文件，则构建产物中**不含 libmpv**：应用仍可正常启动
（`MpvController.available === false`，播放页会显示引擎不可用的重试提示），
但**无法播放音频**。补齐方式：将 libmpv 动态库放到本目录后重新打包即可，
无需改动任何代码。

TODO(bypass): 网络受限导致 libmpv 未随包 —— 见构建报告「已绕过项清单」。
