import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'path';
import log from './logger';
import { observeIpcCall } from './ipc/permissions';
import { setTaskbarCover } from './taskbarThumbnail';

/**
 * P-4a（v1.3.0）：本模块的 8 个通道原先用**裸 `ipcMain.handle`** 注册，因此
 * **绕开 `ipcRegistry` 的观测层**（IMP-01 的 `observeIpcCall`），调用不可见。
 *
 * 这里补一次**显式观测**而不改动注册机制 —— 这样 `registerFallbackIpc()` 里
 * 的 `ipcMain.listenerCount` 判定与 `destroyMediaControls()` 的清理语义都**保持原样**
 *（本版只做「并入规则表 + 接入观测」，**不开 `IPC_PERMISSION_STRICT`**）。
 *
 * 用 `function` 声明而非 `const`：本函数在下方多个注册点被引用，
 * 而 `registerFallbackIpc()` 定义在其后，函数声明提升可避免初始化顺序问题。
 */
function handleObserved(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    observeIpcCall({
      channel,
      url: event.senderFrame?.url,
      webContentsId: event.sender?.id,
    });
    return handler(event, ...args);
  });
}

// native addon 类型（与自动生成的 index.d.ts 对齐）
interface NativeMediaControls {
  initialize(appName: string): void;
  shutdown(): void;
  updateMetadata(payload: {
    title: string;
    artist: string;
    album: string;
    coverData?: number[];
    coverUrl?: string;
    durationMs?: number;
  }): Promise<void>;
  updatePlayState(payload: { status: string }): void;
  updateTimeline(payload: { currentTimeMs: number; totalTimeMs: number }): void;
  registerEventHandler(
    callback: (err: Error | null, event: { type: string; positionMs?: number }) => void,
  ): void;
}

let nativeModule: NativeMediaControls | null = null;
// 封面下载中止控制器
let coverAbortController: AbortController | null = null;
let metadataUpdateSeq = 0;

/** 加载 native addon */
function loadNativeModule(): NativeMediaControls | null {
  try {
    // 打包后在 extraResources 中
    const resourcePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'yan-media-controls.node')
      : path.join(__dirname, '../../native/yan-media-controls/yan-media-controls.node');

    log.info('[MediaControls] Loading native addon:', resourcePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(resourcePath) as NativeMediaControls;
  } catch (err) {
    log.warn('[MediaControls] Primary path load failed:', err);
    // 开发环境可能未编译，尝试直接加载
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../../native/yan-media-controls') as NativeMediaControls;
    } catch (err2) {
      log.error(
        '[MediaControls] All load attempts failed. ' +
          'MPRIS/SMTC will be unavailable. ' +
          'This usually means the native addon was not compiled for this platform/arch. ' +
          'Primary error:',
        err,
        'Fallback error:',
        err2,
      );
      return null;
    }
  }
}

/** 下载图片为 Buffer */
async function downloadCoverImage(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (!url) return null;

  try {
    log.debug('[MediaControls] Starting cover download', { url });

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = setTimeout(() => controller.abort(), 5000);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'image/jpeg,image/png,image/webp,*/*;q=0.8',
          Referer: 'https://www.kugou.com/',
        },
      });

      if (!response.ok) {
        log.warn('[MediaControls] Cover download failed', { status: response.status, url });
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      log.debug('[MediaControls] Cover download completed', { size: buffer.length, url });
      return buffer;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    }
  } catch (err) {
    log.warn('[MediaControls] Cover download exception:', err);
    return null;
  }
}

/** 初始化原生媒体控制服务 */
export function initMediaControls(getMainWindow: () => BrowserWindow | null): void {
  nativeModule = loadNativeModule();
  if (!nativeModule) {
    log.warn('[MediaControls] Native addon unavailable, using fallback');
    registerFallbackIpc();
    return;
  }

  try {
    nativeModule.initialize('YanMusic');
    log.info('[MediaControls] Native addon initialized');
  } catch (err) {
    log.error('[MediaControls] Native addon init failed:', err);
    nativeModule = null;
    registerFallbackIpc();
    return;
  }

  // 注册系统媒体事件回调 → 转发到渲染进程
  nativeModule.registerEventHandler((err, event) => {
    if (err) {
      log.warn('[MediaControls] Event callback error:', err);
      return;
    }
    log.debug('[MediaControls] System media event:', event);
    getMainWindow()?.webContents.send('media-control:event', event);
  });

  // IPC: 更新元数据
  handleObserved(
    'media-control:update-metadata',
    async (
      _e,
      payload: {
        title: string;
        artist: string;
        album: string;
        coverUrl?: string;
        durationMs?: number;
      },
    ) => {
      const controls = nativeModule;
      if (!controls) return;
      const requestSeq = ++metadataUpdateSeq;

      log.debug('[MediaControls] Metadata update received', {
        title: payload.title,
        artist: payload.artist,
        hasCoverUrl: !!payload.coverUrl,
        durationMs: payload.durationMs,
      });

      // 取消上一次封面下载
      if (coverAbortController) {
        coverAbortController.abort();
      }
      const coverController = new AbortController();
      coverAbortController = coverController;

      let coverData: Buffer | null = null;
      if (payload.coverUrl) {
        log.debug('[MediaControls] Starting cover download', { url: payload.coverUrl });
        coverData = await downloadCoverImage(payload.coverUrl, coverController.signal);
        log.debug('[MediaControls] Cover download result', {
          success: !!coverData,
          size: coverData?.length ?? 0,
          url: payload.coverUrl,
        });
      }

      if (requestSeq !== metadataUpdateSeq) {
        log.debug('[MediaControls] Ignored stale metadata update', {
          title: payload.title,
          url: payload.coverUrl,
        });
        return;
      }
      if (coverAbortController === coverController) {
        coverAbortController = null;
      }

      // 任务栏 DWM 缩略图需要及时响应系统请求，不能被 SMTC 的异步元数据更新挡住。
      setTaskbarCover(coverData);

      try {
        // native addon 期望 coverData 为 number[]（NAPI-RS 的 Vec<u8> 映射）
        // 异步：封面解码/重编码在工作线程执行，不阻塞主进程
        await controls.updateMetadata({
          title: payload.title,
          artist: payload.artist,
          album: payload.album,
          coverData: coverData ? Array.from(coverData) : undefined,
          coverUrl: payload.coverUrl,
          durationMs: payload.durationMs,
        });
      } catch (err) {
        log.warn('[MediaControls] updateMetadata failed:', err);
      }
    },
  );

  // IPC: 更新播放状态
  handleObserved('media-control:update-state', (_e, payload: { status: string }) => {
    try {
      nativeModule?.updatePlayState(payload);
    } catch (err) {
      log.warn('[MediaControls] updatePlayState failed:', err);
    }
  });

  // IPC: 更新播放进度
  handleObserved(
    'media-control:update-timeline',
    (_e, payload: { currentTimeMs: number; totalTimeMs: number }) => {
      try {
        nativeModule?.updateTimeline(payload);
      } catch (err) {
        log.warn('[MediaControls] updateTimeline failed:', err);
      }
    },
  );

  // IPC: 查询 native addon 是否可用
  handleObserved('media-control:available', () => {
    return nativeModule !== null;
  });
}

/** native addon 不可用时注册空的 IPC handler，防止渲染进程报错 */
function registerFallbackIpc(): void {
  if (!ipcMain.listenerCount('media-control:update-metadata')) {
    handleObserved('media-control:update-metadata', () => {});
  }
  if (!ipcMain.listenerCount('media-control:update-state')) {
    handleObserved('media-control:update-state', () => {});
  }
  if (!ipcMain.listenerCount('media-control:update-timeline')) {
    handleObserved('media-control:update-timeline', () => {});
  }
  if (!ipcMain.listenerCount('media-control:available')) {
    handleObserved('media-control:available', () => false);
  }
}

/** 销毁媒体控制服务 */
export function destroyMediaControls(): void {
  if (coverAbortController) {
    coverAbortController.abort();
    coverAbortController = null;
  }
  try {
    nativeModule?.shutdown();
  } catch {
    // 忽略
  }
  nativeModule = null;
}
