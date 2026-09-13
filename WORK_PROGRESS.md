# YanMusic 补齐工作进度计划

## 任务概览
将 EchoMusic 中 YanMusic 缺失的功能补齐，同时保留 YanMusic 特有的 VIP 领取/升级功能。

---

## 阶段一：版本更新检查地址修改（优先级：高）

### 1.1 修改 settings.ts 中的 GitHub 仓库地址
**文件**: `src/main/ipc/settings.ts`
**当前地址**: `hoowhoami/yanmusic`
**目标地址**: `MmlwrYan/YanMusic`

需要修改的位置：
- Line 717: GitHub API URL
- Line 737: Feed URL (prerelease)
- Line 740: SetFeedURL (prerelease fallback)
- Line 768: SetFeedURL (API error fallback)
- Line 778: SetFeedURL (network error fallback)
- Line 787: SetFeedURL (catch fallback)
- Line 799: Feed URL (release)
- Line 808: SetFeedURL (no proxy)

### 1.2 修改 package.json 中的 publish 配置
**文件**: `package.json`
**当前**:
```json
"publish": [{
  "provider": "github",
  "owner": "hoowhoami",
  "repo": "yanmusic"
}]
```
**目标**:
```json
"publish": [{
  "provider": "github",
  "owner": "MmlwrYan",
  "repo": "YanMusic"
}]
```

---

## 阶段二：补齐缺失的设置组件（优先级：高）

### 2.1 InterfaceSettingsSection.vue
从 EchoMusic 复制并适配：
- 复制源: `EchoMusic-main/src/renderer/views/settings/components/InterfaceSettingsSection.vue`
- 目标: `YanMusic-main/src/renderer/views/settings/components/InterfaceSettingsSection.vue`
- 需要适配: 移除 EchoMusic 特有功能（一起听、云端上传等），保留界面设置相关部分

### 2.2 PlayerSettingsSection.vue
从 EchoMusic 复制并适配：
- 复制源: `EchoMusic-main/src/renderer/views/settings/components/PlayerSettingsSection.vue`
- 目标: `YanMusic-main/src/renderer/views/settings/components/PlayerSettingsSection.vue`
- 需要适配: 调整播放器设置选项以匹配 mpv 引擎

### 2.3 SpatialAudioSettingsSection.vue
从 EchoMusic 复制并适配：
- 复制源: `EchoMusic-main/src/renderer/views/settings/components/SpatialAudioSettingsSection.vue`
- 目标: `YanMusic-main/src/renderer/views/settings/components/SpatialAudioSettingsSection.vue`
- 需要适配: 简化空间音频设置（移除 EchoMusic 特有的 DSP 选项）

### 2.4 WindowSettingsSection.vue
从 EchoMusic 复制并适配：
- 复制源: `EchoMusic-main/src/renderer/views/settings/components/WindowSettingsSection.vue`
- 目标: `YanMusic-main/src/renderer/views/settings/components/WindowSettingsSection.vue`
- 需要适配: 调整窗口设置以支持 YanMusic 的窗口管理

---

## 阶段三：补齐缺失的 Store 和 API（优先级：中）

### 3.1 LoginDevices Store
- 复制源: `EchoMusic-main/src/renderer/stores/loginDevices.ts`
- 目标: `YanMusic-main/src/renderer/stores/loginDevices.ts`
- 需要适配: 调整登录设备管理逻辑

### 3.2 ContentBlacklist Store
- 复制源: `EchoMusic-main/src/renderer/stores/contentBlacklist.ts`
- 目标: `YanMusic-main/src/renderer/stores/contentBlacklist.ts`
- 需要适配: 调整内容黑名单逻辑

### 3.3 CloudUpload Store
- 复制源: `EchoMusic-main/src/renderer/stores/cloudUpload.ts`
- 目标: `YanMusic-main/src/renderer/stores/cloudUpload.ts`
- 需要适配: 简化云端上传功能

### 3.4 ImportTask Store
- 复制源: `EchoMusic-main/src/renderer/stores/importTask.ts`
- 目标: `YanMusic-main/src/renderer/stores/importTask.ts`
- 需要适配: 调整导入任务管理

### 3.5 ListenTogether Store
- 复制源: `EchoMusic-main/src/renderer/stores/listenTogether.ts`
- 目标: `YanMusic-main/src/renderer/stores/listenTogether.ts`
- 需要适配: 简化一起听功能（或暂时跳过，因为需要服务端支持）

### 3.6 ListenReport Store
- 复制源: `EchoMusic-main/src/renderer/stores/listenReport.ts`
- 目标: `YanMusic-main/src/renderer/stores/listenReport.ts`
- 需要适配: 调整听歌报告功能

### 3.7 Player Stores
- 复制源: `EchoMusic-main/src/renderer/stores/player/`
- 目标: `YanMusic-main/src/renderer/stores/player/`
- 包含:
  - `listeningTime.ts` - 听歌时间统计
  - `progressStatus.ts` - 播放进度状态
  - `queueAdvancePolicy.ts` - 播放队列策略
  - `spatialAudioSupport.ts` - 空间音频支持
  - `stateMachine.ts` - 播放器状态机

---

## 阶段四：补齐缺失的 Views 和 Components（优先级：中）

### 4.1 Purchased View
- 复制源: `EchoMusic-main/src/renderer/views/Purchased.vue`
- 目标: `YanMusic-main/src/renderer/views/Purchased.vue`
- 需要适配: 调整已购歌曲显示

### 4.2 ListenTogether View
- 复制源: `EchoMusic-main/src/renderer/views/listenTogether/`
- 目标: `YanMusic-main/src/renderer/views/listenTogether/`
- 需要适配: 简化一起听功能

### 4.3 Search Skeleton Component
- 复制源: `EchoMusic-main/src/renderer/views/search/components/SearchResultsSkeleton.vue`
- 目标: `YanMusic-main/src/renderer/views/search/components/SearchResultsSkeleton.vue`
- 需要适配: 调整骨架屏样式

### 4.4 UI Components
- 复制源: `EchoMusic-main/src/renderer/components/ui/DatePicker.vue`
- 目标: `YanMusic-main/src/renderer/components/ui/DatePicker.vue`
- 复制源: `EchoMusic-main/src/renderer/components/ui/Skeleton.vue`
- 目标: `YanMusic-main/src/renderer/components/ui/Skeleton.vue`
- 复制源: `EchoMusic-main/src/renderer/components/music/CloudUploadDialog.vue`
- 目标: `YanMusic-main/src/renderer/components/music/CloudUploadDialog.vue`
- 复制源: `EchoMusic-main/src/renderer/components/profile/ContentBlacklistDialog.vue`
- 目标: `YanMusic-main/src/renderer/components/profile/ContentBlacklistDialog.vue`

### 4.5 Player Components
- 复制源: `EchoMusic-main/src/renderer/components/player/ProgressBusyOverlay.vue`
- 目标: `YanMusic-main/src/renderer/components/player/ProgressBusyOverlay.vue`
- 复制源: `EchoMusic-main/src/renderer/components/player/EffectPlaza.vue`
- 目标: `YanMusic-main/src/renderer/components/player/EffectPlaza.vue`
- 复制源: `EchoMusic-main/src/renderer/components/player/OnlineAudioEffectCard.vue`
- 目标: `YanMusic-main/src/renderer/components/player/OnlineAudioEffectCard.vue`

---

## 阶段五：补齐缺失的工具函数和服务（优先级：中）

### 5.1 Utils
- 复制源: `EchoMusic-main/src/renderer/utils/sessionId.ts`
- 目标: `YanMusic-main/src/renderer/utils/sessionId.ts`
- 复制源: `EchoMusic-main/src/renderer/utils/songMatching.ts`
- 目标: `YanMusic-main/src/renderer/utils/songMatching.ts`
- 复制源: `EchoMusic-main/src/renderer/utils/themedCover.ts`
- 目标: `YanMusic-main/src/renderer/utils/themedCover.ts`
- 复制源: `EchoMusic-main/src/renderer/utils/routeViewCache.ts`
- 目标: `YanMusic-main/src/renderer/utils/routeViewCache.ts`
- 复制源: `EchoMusic-main/src/renderer/utils/nativeImportPlaylist.ts`
- 目标: `YanMusic-main/src/renderer/utils/nativeImportPlaylist.ts`
- 复制源: `EchoMusic-main/src/renderer/utils/lyricFilter.ts`
- 目标: `YanMusic-main/src/renderer/utils/lyricFilter.ts`
- 复制源: `EchoMusic-main/src/renderer/utils/inputBehaviorGuard.ts`
- 目标: `YanMusic-main/src/renderer/utils/inputBehaviorGuard.ts`

### 5.2 Composables
- 复制源: `EchoMusic-main/src/renderer/composables/useDeferredSeek.ts`
- 目标: `YanMusic-main/src/renderer/composables/useDeferredSeek.ts`
- 复制源: `EchoMusic-main/src/renderer/composables/useWindowResize.ts`
- 目标: `YanMusic-main/src/renderer/composables/useWindowResize.ts`
- 复制源: `EchoMusic-main/src/renderer/composables/useLyricTimeline.ts`
- 目标: `YanMusic-main/src/renderer/composables/useLyricTimeline.ts`
- 复制源: `EchoMusic-main/src/renderer/composables/useStableLyricIndex.ts`
- 目标: `YanMusic-main/src/renderer/composables/useStableLyricIndex.ts`
- 复制源: `EchoMusic-main/src/renderer/composables/useAudioEffectPlaza.ts`
- 目标: `YanMusic-main/src/renderer/composables/useAudioEffectPlaza.ts`

### 5.3 Services
- 复制源: `EchoMusic-main/src/renderer/services/contentBlacklistIntegration.ts`
- 目标: `YanMusic-main/src/renderer/services/contentBlacklistIntegration.ts`
- 复制源: `EchoMusic-main/src/renderer/services/cloudAudioIndex.ts`
- 目标: `YanMusic-main/src/renderer/services/cloudAudioIndex.ts`

---

## 阶段六：补齐共享层代码（优先级：高）

### 6.1 复制 EchoMusic 的 shared 目录
- 复制源: `EchoMusic-main/src/shared/`
- 目标: `YanMusic-main/src/shared/`
- 需要覆盖的文件:
  - `audio.ts` - 音频配置
  - `audio-spectrum.ts` - 音频频谱
  - `desktop-lyric.ts` - 桌面歌词
  - `external.ts` - 外部协议
  - `font.ts` - 字体
  - `lyrics.ts` - 歌词
  - `mini-player.ts` - 迷你播放器
  - `network.ts` - 网络
  - `now-playing.ts` - 正在播放
  - `object.ts` - 对象工具
  - `playback.ts` - 播放
  - `plugins.ts` - 插件
  - `recognize.ts` - 识别
  - `share.ts` - 分享
  - `shortcuts.ts` - 快捷键
  - `storage.ts` - 存储
  - `tray.ts` - 托盘

### 6.2 复制 main 层代码
- 复制源: `EchoMusic-main/src/main/diagnostics/`
- 目标: `YanMusic-main/src/main/diagnostics/`
- 复制源: `EchoMusic-main/src/main/media/`
- 目标: `YanMusic-main/src/main/media/`
- 复制源: `EchoMusic-main/src/main/player/`
- 目标: `YanMusic-main/src/main/player/`
- 复制源: `EchoMusic-main/src/main/window/`
- 目标: `YanMusic-main/src/main/window/`

### 6.3 复制 renderer 层代码
- 复制源: `EchoMusic-main/src/renderer/components/profile/`
- 目标: `YanMusic-main/src/renderer/components/profile/`
- 复制源: `EchoMusic-main/src/renderer/plugins/runtime/`
- 目标: `YanMusic-main/src/renderer/plugins/runtime/`
- 复制源: `EchoMusic-main/src/renderer/services/`
- 目标: `YanMusic-main/src/renderer/services/`
- 复制源: `EchoMusic-main/src/renderer/tasks/`
- 目标: `YanMusic-main/src/renderer/tasks/`

---

## 阶段七：配置文件和资源（优先级：低）

### 7.1 添加测试文件
- 复制源: `EchoMusic-main/tests/`
- 目标: `YanMusic-main/tests/`
- 需要选择性地复制关键测试文件

### 7.2 添加文档
- 复制源: `EchoMusic-main/docs/`
- 目标: `YanMusic-main/docs/`
- 包含架构文档

### 7.3 添加构建资源
- 复制源: `EchoMusic-main/build/`
- 目标: `YanMusic-main/build/`
- 包含图标等资源

### 7.4 许可证文件
- 复制源: `EchoMusic-main/LICENSES/`
- 目标: `YanMusic-main/LICENSES/`
- 复制源: `EchoMusic-main/THIRD_PARTY_NOTICES.md`
- 目标: `YanMusic-main/THIRD_PARTY_NOTICES.md`

---

## 阶段八：验证和测试（优先级：最高）

### 8.1 编译验证
- 运行 TypeScript 类型检查
- 运行 Vite 构建
- 验证无编译错误

### 8.2 功能验证
- 验证 VIP 领取功能正常
- 验证 VIP 升级功能正常
- 验证版本更新检查指向新仓库
- 验证新增的设置页面正常显示
- 验证新增的组件正常工作

### 8.3 回归测试
- 确保原有功能未被破坏
- 确保 mpv 播放器功能正常
- 确保登录/注册功能正常
- 确保音乐播放功能正常

---

## 执行状态

### ✅ 阶段一：版本更新检查地址修改（已完成）
- [x] `package.json` - publish 配置已更新
- [x] `src/main/ipc/settings.ts` - 所有 GitHub 地址已更新

### ✅ 阶段二：补齐缺失的设置组件（已完成）
- [x] InterfaceSettingsSection.vue - 界面设置
- [x] PlayerSettingsSection.vue - 播放器设置
- [x] SpatialAudioSettingsSection.vue - 空间音频设置
- [x] WindowSettingsSection.vue - 窗口设置

### ✅ 阶段三：补齐缺失的 Store 和 API（已完成）
- [x] loginDevices.ts - 登录设备管理
- [x] shared/audio.ts - 音频共享类型扩展
- [x] shared/playback-queue-decision.ts - 播放队列决策逻辑
- [x] stores/player/progressStatus.ts - 播放进度状态
- [x] stores/player/queueAdvancePolicy.ts - 播放队列策略

### ✅ 阶段四：补齐缺失的 Views 和 Components（已完成）
- [x] InterfaceSettingsSection.vue - 界面设置
- [x] PlayerSettingsSection.vue - 播放器设置
- [x] SpatialAudioSettingsSection.vue - 空间音频设置
- [x] WindowSettingsSection.vue - 窗口设置

### ⏳ 阶段五：补齐缺失的工具函数和服务
### ⏳ 阶段六：补齐共享层代码
### ⏳ 阶段七：配置文件和资源
### ⏳ 阶段八：验证和测试

### ⏳ 阶段五：补齐缺失的工具函数和服务
### ⏳ 阶段六：补齐共享层代码
### ⏳ 阶段七：配置文件和资源
### ⏳ 阶段八：验证和测试

---

## 执行策略

### 分阶段执行
每个阶段完成后暂停，等待用户确认再继续下一阶段。

### 变更控制
每次修改只涉及一个文件或少量相关文件，确保变更可控。

### 备份策略
在执行任何修改前，先确认当前代码库的状态（是否已经提交）。

### 验证策略
每个阶段完成后进行验证，确保没有引入新的问题。

---

## 风险点

1. **VIP 功能保护**: 必须确保 `Profile.vue` 中的 VIP 领取/升级逻辑不受影响
2. **mpv 兼容性**: 添加的新功能必须与 mpv 播放器兼容
3. **依赖管理**: 新添加的代码可能需要新的依赖，需要更新 `package.json`
4. **类型安全**: 确保所有新增代码通过 TypeScript 类型检查

---

## 开始执行

**第一阶段：版本更新检查地址修改**