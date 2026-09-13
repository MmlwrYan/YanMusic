import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'path';
import log from './logger';
import { getMainAppSettings } from './storage/settings';

/**
 * Windows 任务栏 iconic 缩略图。
 *
 * 有封面时把任务栏悬停预览替换为歌曲封面，无封面时回退为窗口实时画面。
 * 通过 DWM iconic representation 实现：开启后系统会发来缩略图请求消息，
 * 这里用 `hookWindowMessage` 接收并调用原生模块写入封面位图。
 * 开关由设置「外观-任务栏封面预览」控制（默认关闭）。
 */

// DWM 缩略图请求消息
const WM_DWMSENDICONICTHUMBNAIL = 0x0323;
const WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326;

// 缩略图请求未携带尺寸时的回退上限
const DEFAULT_THUMBNAIL_MAX = 200;
// Aero Peek 大预览的尺寸上限
const LIVE_PREVIEW_MAX = 600;

interface NativeTaskbar {
  taskbarEnableIconic(hwnd: string): void;
  taskbarDisableIconic(hwnd: string): void;
  taskbarInvalidate(hwnd: string): void;
  taskbarSetThumbnail(hwnd: string, image: Buffer, maxWidth: number, maxHeight: number): void;
  taskbarSetLivePreview(hwnd: string, image: Buffer, maxWidth: number, maxHeight: number): void;
}

let nativeModule: NativeTaskbar | null = null;
let targetWindow: BrowserWindow | null = null;
let hwndStr: string | null = null;
let coverBuffer: Buffer | null = null;
let iconicEnabled = false;
let hooked = false;
// 任务栏封面预览开关：关闭时走 DWM 默认实时窗口画面，不启用 iconic 封面
let coverPreviewEnabled = false;

/** 加载 native addon（与 mediaControls 共用同一个 .node，require 缓存保证单例） */
function loadNativeModule(): NativeTaskbar | null {
  try {
    const resourcePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'yan-media-controls.node')
      : path.join(__dirname, '../../native/yan-media-controls/yan-media-controls.node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(resourcePath) as NativeTaskbar;
  } catch (err) {
    log.warn('[TaskbarThumbnail] Primary path load failed:', err);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../../native/yan-media-controls') as NativeTaskbar;
    } catch (err2) {
      log.error('[TaskbarThumbnail] Native addon load failed:', err, err2);
      return null;
    }
  }
}

/** 从窗口原生句柄 Buffer 解析 HWND 指针的无符号十进制字符串 */
function resolveHwnd(win: BrowserWindow): string | null {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return String(buf.readUInt32LE(0));
    return null;
  } catch (err) {
    log.warn('[TaskbarThumbnail] Failed to read native window handle:', err);
    return null;
  }
}

/** 开关由「任务栏封面预览」控制：开且已有封面时显示封面，否则回退到 DWM 实时窗口画面 */
function applyState(): void {
  if (!nativeModule || !hwndStr) return;
  const shouldShowCover = coverPreviewEnabled && !!coverBuffer;
  try {
    if (shouldShowCover) {
      if (!iconicEnabled) {
        nativeModule.taskbarEnableIconic(hwndStr);
        iconicEnabled = true;
      }
      // 触发系统重新索取缩略图，换上当前封面
      nativeModule.taskbarInvalidate(hwndStr);
    } else if (iconicEnabled) {
      nativeModule.taskbarDisableIconic(hwndStr);
      iconicEnabled = false;
      nativeModule.taskbarInvalidate(hwndStr);
    }
  } catch (err) {
    log.warn('[TaskbarThumbnail] applyState failed:', err);
  }
}

function disableIconicFallback(reason: string, err?: unknown): void {
  if (!nativeModule || !hwndStr || !iconicEnabled) return;
  try {
    nativeModule.taskbarDisableIconic(hwndStr);
    iconicEnabled = false;
    nativeModule.taskbarInvalidate(hwndStr);
    log.warn(`[TaskbarThumbnail] Disabled iconic thumbnail fallback: ${reason}`, err);
  } catch (disableErr) {
    log.warn('[TaskbarThumbnail] disable iconic fallback failed:', disableErr);
  }
}

/** 处理悬停缩略图请求：从 lParam 解析最大尺寸并写入封面 */
function onThumbnailRequest(lParam: Buffer): void {
  if (!nativeModule || !hwndStr) return;
  // 开关关闭或暂无封面时保留 DWM 已有的实时窗口画面，不写封面位图
  if (!coverPreviewEnabled || !coverBuffer) {
    disableIconicFallback(
      coverPreviewEnabled ? 'thumbnail requested without cover' : 'cover preview disabled',
    );
    return;
  }
  let maxWidth = DEFAULT_THUMBNAIL_MAX;
  let maxHeight = DEFAULT_THUMBNAIL_MAX;
  try {
    // lParam 低 32 位：HIWORD = 最大宽度，LOWORD = 最大高度
    const packed = lParam.length >= 4 ? lParam.readUInt32LE(0) : 0;
    const w = (packed >>> 16) & 0xffff;
    const h = packed & 0xffff;
    if (w > 0) maxWidth = w;
    if (h > 0) maxHeight = h;
  } catch {
    // 解析失败则使用默认尺寸
  }
  try {
    nativeModule.taskbarSetThumbnail(hwndStr, coverBuffer, maxWidth, maxHeight);
  } catch (err) {
    log.warn('[TaskbarThumbnail] setThumbnail failed:', err);
    disableIconicFallback('setThumbnail failed', err);
  }
}

/** 处理 Aero Peek 大预览请求：写入封面 */
function onLivePreviewRequest(): void {
  if (!nativeModule || !hwndStr) return;
  // 开关关闭或暂无封面时保留 DWM 已有的实时窗口画面，不写封面位图
  if (!coverPreviewEnabled || !coverBuffer) {
    disableIconicFallback(
      coverPreviewEnabled ? 'live preview requested without cover' : 'cover preview disabled',
    );
    return;
  }
  try {
    nativeModule.taskbarSetLivePreview(hwndStr, coverBuffer, LIVE_PREVIEW_MAX, LIVE_PREVIEW_MAX);
  } catch (err) {
    log.warn('[TaskbarThumbnail] setLivePreview failed:', err);
    disableIconicFallback('setLivePreview failed', err);
  }
}

/** 初始化任务栏缩略图（仅 Windows）。需在窗口创建后调用。 */
export function setupTaskbarThumbnail(win: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  if (win.isDestroyed()) return;

  // 先按已持久化的主进程设置初始化开关，再加载原生模块：
  // 即使原生模块不可用（无缩略图能力），标题逻辑仍能读到正确的开关值
  coverPreviewEnabled = Boolean(getMainAppSettings().taskbarCoverPreview);

  if (!nativeModule) {
    nativeModule = loadNativeModule();
  }
  if (!nativeModule) {
    log.warn('[TaskbarThumbnail] Native addon unavailable, taskbar cover preview disabled');
    return;
  }

  targetWindow = win;
  hwndStr = resolveHwnd(win);
  if (!hwndStr) {
    log.warn('[TaskbarThumbnail] Unable to resolve HWND, skip setup');
    return;
  }

  if (!hooked) {
    win.hookWindowMessage(WM_DWMSENDICONICTHUMBNAIL, (_wParam, lParam) => {
      onThumbnailRequest(lParam);
    });
    win.hookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP, () => {
      onLivePreviewRequest();
    });
    hooked = true;
  }

  // 句柄可能因窗口重建变化，重新应用一次当前状态
  iconicEnabled = false;
  applyState();
  log.info('[TaskbarThumbnail] Initialized');
}

/** 更新当前封面（原始图片字节）。传 null 表示无封面。 */
export function setTaskbarCover(cover: Buffer | null): void {
  if (process.platform !== 'win32') return;
  coverBuffer = cover && cover.length > 0 ? cover : null;
  applyState();
}

/** 任务栏封面预览当前是否开启 */
export function isCoverPreviewEnabled(): boolean {
  return coverPreviewEnabled;
}

/** 设置任务栏封面预览开关（关闭时回退到 DWM 实时窗口画面） */
export function setCoverPreviewEnabled(enabled: boolean): void {
  coverPreviewEnabled = enabled;
  applyState();
}

/** 销毁：关闭 iconic 表示并解除消息钩子。 */
export function destroyTaskbarThumbnail(): void {
  if (process.platform !== 'win32') return;
  try {
    if (nativeModule && hwndStr && iconicEnabled) {
      nativeModule.taskbarDisableIconic(hwndStr);
      nativeModule.taskbarInvalidate(hwndStr);
    }
    if (hooked && targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.unhookWindowMessage(WM_DWMSENDICONICTHUMBNAIL);
      targetWindow.unhookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP);
    }
  } catch (err) {
    log.warn('[TaskbarThumbnail] destroy failed:', err);
  }
  iconicEnabled = false;
  hooked = false;
  coverBuffer = null;
  hwndStr = null;
  targetWindow = null;
}
