import type { BrowserWindow } from 'electron';
import { getMainWindow } from './window';
import log from './logger';
import { getMainAppSettings } from './storage/settings';
import type { MpvController } from './mpv/controller';

/**
 * Windows 任务栏播放进度条。
 *
 * 播放时在主窗口的任务栏按钮上显示进度条，暂停时变为暂停态，
 * 时长未知时显示不定进度条，无曲目或播放结束时移除进度条。仅 Windows 生效。
 * 开关由设置「外观-任务栏播放进度条」控制（默认开启）。
 *
 * 事件来源为 YanMusic 的 libmpv 控制器（`src/main/mpv/controller.ts`），
 * 可用事件为：time-update / duration-change / state-change / playback-end /
 * mpv:file-loaded / error / stall 等；没有独立的 seek 完成事件。
 */

// 节流：mpv 的 time-pos 属性观察器高频上报，避免无意义的重复 native 调用
const THROTTLE_MS = 200;
// ratio 变化小于该阈值且 mode 未变时，视为无明显变化，可跳过应用
const RATIO_EPSILON = 0.001;
// Windows 上进度值为 0 的暂停条可能被渲染为无状态，暂停时强制保底一段可见进度
const PAUSED_MIN_VALUE = 0.01;
// 判定「位置在正常推进」的单次最大增量（秒）：超过它视为 seek 跳变而非播放推进
const PLAYBACK_ADVANCE_MAX_SECONDS = 5;

type ProgressMode = 'normal' | 'paused' | 'indeterminate' | 'none';

let enabled = true;
let time = 0;
let duration = 0;
let isPlaying = false;
let hasTrack = false;
let lastApplyAt = 0;
let lastRatio = -1;
let lastMode: ProgressMode = 'none';
// 新文件加载后播放态待确认（收不到 state-change 时用位置推进反推，详见 confirmPlayingByAdvance）
let awaitingPlayingConfirm = false;
let lastObservedTime: number | null = null;

const clampRatio = (value: number): number => Math.min(1, Math.max(0, value));

const resolveMode = (): ProgressMode => {
  if (!hasTrack) return 'none';
  if (duration <= 0) return 'indeterminate';
  return isPlaying ? 'normal' : 'paused';
};

const resolveRatio = (): number => {
  if (duration <= 0) return 0;
  return clampRatio(time / duration);
};

const getTaskbarWindow = (): BrowserWindow | null => {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  return win;
};

/** 移除任务栏进度条并记账，避免下次重复调用 native */
const removeProgressBar = (): void => {
  const win = getTaskbarWindow();
  if (win) {
    try {
      win.setProgressBar(-1);
    } catch (err) {
      log.warn('[TaskbarProgress] Failed to remove progress bar:', err);
    }
  }
  lastMode = 'none';
  lastRatio = -1;
  lastApplyAt = Date.now();
};

const applyToTaskbar = (): void => {
  if (process.platform !== 'win32') return;
  const win = getTaskbarWindow();
  if (!win) return;

  // 开关关闭时移除进度条
  if (!enabled) {
    if (lastMode !== 'none') removeProgressBar();
    return;
  }

  const mode = resolveMode();

  // 无曲目或播放结束：移除进度条
  if (mode === 'none') {
    if (lastMode !== 'none') removeProgressBar();
    return;
  }

  const now = Date.now();
  const ratio = mode === 'indeterminate' ? 1 : resolveRatio();
  // 暂停态保底可见进度，避免 Windows 将 0 值暂停条渲染为空状态
  const value =
    mode === 'paused' ? Math.max(PAUSED_MIN_VALUE, ratio) : mode === 'indeterminate' ? 1 : ratio;
  const modeChanged = mode !== lastMode;
  const ratioChanged = Math.abs(value - lastRatio) >= RATIO_EPSILON;

  // mode 或 ratio 有明显变化时立即应用；否则按节流窗口跳过
  if (!modeChanged && !ratioChanged && now - lastApplyAt < THROTTLE_MS) return;

  try {
    win.setProgressBar(value, { mode });
    lastMode = mode;
    lastRatio = value;
    lastApplyAt = now;
  } catch (err) {
    log.warn('[TaskbarProgress] Failed to set progress bar:', err);
  }
};

const resetState = (): void => {
  time = 0;
  duration = 0;
  isPlaying = false;
  hasTrack = false;
  awaitingPlayingConfirm = false;
  lastObservedTime = null;
  applyToTaskbar();
};

/**
 * 新文件加载完成：从控制器实时状态同步一次。
 *
 * 位置固定从 0 起步，避免沿用上一首残留的 time-pos 让进度条先跳一下；
 * 时长取控制器快照（YanMusic 的 `state-change` 只有 paused/playing，不含 duration）。
 * 播放态额外置「待确认」，理由见 `confirmPlayingByAdvance`。
 */
const syncFromController = (controller: MpvController): void => {
  time = 0;
  duration = 0;
  isPlaying = false;
  try {
    const state = controller.currentState;
    duration = Number(state.duration) > 0 ? Number(state.duration) : 0;
    isPlaying = Boolean(state.playing);
  } catch (err) {
    log.warn('[TaskbarProgress] Failed to read player state on file loaded:', err);
  }
  // 能收到 file-loaded 就说明已有曲目加载成功
  hasTrack = true;
  awaitingPlayingConfirm = true;
  lastObservedTime = null;
  applyToTaskbar();
};

/**
 * 用「位置确实在推进」确认播放态。
 *
 * libmpv 在自然播放结束时会把暂停镜像置为 paused，若下一首自动续播，mpv 的 pause
 * 属性本身并未变化 → 不会再发 state-change，此时镜像里的 playing 是过期值。
 * 因此新文件加载后若迟迟收不到 state-change，就用连续两次「小幅递增」的 time-update
 * 判定为真的在播放：seek 造成的单次跳变（位置大幅变化）不会误判。
 * 返回是否刚刚确认进入播放态。
 */
const confirmPlayingByAdvance = (timeSeconds: number): boolean => {
  const previous = lastObservedTime;
  lastObservedTime = timeSeconds;
  if (!awaitingPlayingConfirm || previous === null) return false;
  const delta = timeSeconds - previous;
  if (delta <= 0 || delta > PLAYBACK_ADVANCE_MAX_SECONDS) return false;
  awaitingPlayingConfirm = false;
  return true;
};

/**
 * 初始化并订阅播放进度事件（仅 Windows）。应随播放器启动调用。
 */
export const setupTaskbarProgress = (controller: MpvController): void => {
  if (process.platform !== 'win32') return;
  enabled = Boolean(getMainAppSettings().taskbarProgress);
  log.info('[TaskbarProgress] initialized', { enabled });

  // 播放位置：mpv 的 time-pos 属性观察器在播放推进与 seek 后都会立即上报，
  // 因此 seek 后的刷新也由它覆盖（YanMusic 没有独立的 seeked / playback-restart 事件）。
  controller.on('time-update', (timeSeconds: number) => {
    if (typeof timeSeconds !== 'number') return;
    const confirmed = confirmPlayingByAdvance(timeSeconds);
    if (confirmed && !isPlaying) {
      isPlaying = true;
      hasTrack = true;
    }
    time = timeSeconds;
    applyToTaskbar();
  });

  // 时长变化（新文件加载、直播流拿到时长）即说明已有曲目，可据此显示进度条
  controller.on('duration-change', (nextDuration: number) => {
    if (typeof nextDuration === 'number') {
      duration = nextDuration;
      if (nextDuration > 0) hasTrack = true;
      applyToTaskbar();
    }
  });

  // 注意：state-change 的 payload 只有 paused / playing（来自 mpv 的 pause 属性观察器），
  // 不携带 duration，也不随播放推进更新。若用它覆盖 time，暂停时进度条会回到
  // 歌曲开头或上次 seek 位置。time 只由 time-update 维护实时位置。
  controller.on('state-change', (payload: { paused?: boolean; playing?: boolean }) => {
    // 显式播放态已知，不再需要靠位置推进反推
    awaitingPlayingConfirm = false;
    lastObservedTime = null;
    // 暂停/播放切换必须立即体现为颜色变化
    const nextIsPlaying = Boolean(payload?.playing);
    if (nextIsPlaying !== isPlaying) {
      isPlaying = nextIsPlaying;
      if (nextIsPlaying) {
        hasTrack = true;
      }
    }
    applyToTaskbar();
  });

  controller.on('mpv:file-loaded', () => {
    syncFromController(controller);
  });

  controller.on('playback-end', () => {
    resetState();
  });
};

/**
 * 设置任务栏进度条开关。关闭时立即移除进度条，开启时按当前播放状态重放。
 */
export const setTaskbarProgressEnabled = (next: boolean): void => {
  if (process.platform !== 'win32') return;
  if (enabled === Boolean(next)) return;
  enabled = Boolean(next);
  applyToTaskbar();
};

/**
 * Explorer 重启（任务栏重建）后刷新一次当前进度，与 thumbar / 缩略图重建保持一致。
 */
export const refreshTaskbarProgress = (): void => {
  if (process.platform !== 'win32') return;
  // 任务栏重建会重置窗口状态，强制重新应用一次当前进度
  lastApplyAt = 0;
  lastMode = 'none';
  lastRatio = -1;
  applyToTaskbar();
};

/**
 * 销毁：移除任务栏进度条。随播放器销毁调用。
 */
export const destroyTaskbarProgress = (): void => {
  if (process.platform !== 'win32') return;
  const win = getTaskbarWindow();
  if (win) {
    try {
      win.setProgressBar(-1);
    } catch (err) {
      log.warn('[TaskbarProgress] Failed to remove progress bar on destroy:', err);
    }
  }
  time = 0;
  duration = 0;
  isPlaying = false;
  hasTrack = false;
  awaitingPlayingConfirm = false;
  lastObservedTime = null;
  lastApplyAt = 0;
  lastRatio = -1;
  lastMode = 'none';
};
