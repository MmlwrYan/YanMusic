import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import log, { isDiagnosticModeActive } from '../logger';
import { observeIpcCall } from './permissions';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any;
type IpcListener = (event: IpcMainEvent, ...args: any[]) => void;

interface IpcHandlerOptions {
  /** 预期内的拒绝（如插件主动取消的网络请求）不写生产错误日志。 */
  isExpectedError?: (error: unknown) => boolean;
}

// IPC 同步占用计时阈值：handler/listener 占用主线程同步执行超过此值即告警，
// 用于定位是哪个通道在阻塞主进程（如切歌时的地址解析、媒体控制等）。
const IPC_SYNC_WARN_MS = 50;

/**
 * P-3（v1.3.0）：**可选的**发送方守卫。
 *
 * 依赖倒置 —— registry 只认识下面这个函数签名，**不认识**「插件身份」这个概念：
 * 具体策略（哪些通道要校验、如何反查发送方）由插件域用 `setIpcSenderGuard()` 安装，
 * 见 `main/plugins/senderIdentity.ts` 的 `createPluginSenderGuard()`。
 *
 * 这样做的理由：若不倒置，则需在 49 个 `plugins:` 注册点上各包一层
 *（改错面大且无法用单测覆盖）；倒置后「改错面」收敛为 1 处安装 + 1 处调用。
 */
export interface IpcSenderGuardParams {
  channel: string;
  webContentsId: number | undefined;
  args: unknown[];
}

export type IpcSenderGuard = (
  params: IpcSenderGuardParams,
) => { ok: true } | { ok: false; error: string };

let ipcSenderGuard: IpcSenderGuard | null = null;

/** 安装/清除发送方守卫（传 `null` 清除）。 */
export const setIpcSenderGuard = (guard: IpcSenderGuard | null): void => {
  ipcSenderGuard = guard;
};

class IpcRegistry {
  private handlers = new Map<string, IpcHandler>();
  private listeners = new Map<string, IpcListener[]>();

  registerHandler(channel: string, handler: IpcHandler, options?: IpcHandlerOptions): void {
    if (this.handlers.has(channel)) {
      console.warn(`[IPC] Handler for channel "${channel}" already registered, replacing`);
      ipcMain.removeHandler(channel);
    }
    this.handlers.set(channel, handler);
    ipcMain.handle(channel, async (event, ...args) => {
      // IMP-01 观测（只记录不拒绝）：判定「该窗口是否应有权调用该通道」并采样写日志。
      // 默认永不拒绝；只有显式设置 IPC_PERMISSION_STRICT 时才会抛错（本轮不得开启）。
      const observation = observeIpcCall({
        channel,
        url: event.senderFrame?.url,
        webContentsId: event.sender?.id,
      });
      if (observation.rejected) {
        throw new Error(
          `[IPC] channel "${channel}" is not permitted for page ${observation.page} (strict mode)`,
        );
      }
      // P-3：发送方身份守卫（插件域安装时才有）。契约违规**可抛回调用方**。
      if (ipcSenderGuard) {
        const gate = ipcSenderGuard({ channel, webContentsId: event.sender?.id, args });
        if (!gate.ok) throw new Error(gate.error);
      }
      // 计时仅在诊断模式开启时进行（平时一次布尔判断，近乎零开销）。
      // 测的是 handler 同步执行（返回前/首个 await 让出前）占用主线程的时长；
      // 异步等待（网络/工作线程）不计入，因为那不阻塞主线程。
      const profiling = isDiagnosticModeActive();
      const start = profiling ? performance.now() : 0;
      try {
        const result = handler(event, ...args);
        if (profiling) {
          const syncMs = performance.now() - start;
          if (syncMs >= IPC_SYNC_WARN_MS) {
            log.warn(`[IPCProfiler] handler "${channel}" 同步占用主线程 ~${Math.round(syncMs)}ms`);
          }
        }
        return await result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (options?.isExpectedError?.(error)) {
          if (isDiagnosticModeActive()) {
            log.debug('[IPC] Handler rejected', { channel, error: errorMessage });
          }
        } else {
          log.error('[IPC] Handler failed', {
            channel,
            error: errorMessage,
            stack: error instanceof Error ? error.stack : '',
          });
        }
        throw error;
      }
    });
  }

  registerListener(channel: string, listener: IpcListener): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, []);
    }
    // 包裹计时：listener 是同步执行的，整段都占用主线程。仅诊断模式开启时计时。
    const wrapped: IpcListener = (event, ...args) => {
      // IMP-01 观测（只记录不拒绝），与 handler 路径一致
      const observation = observeIpcCall({
        channel,
        url: event.senderFrame?.url,
        webContentsId: event.sender?.id,
      });
      if (observation.rejected) {
        // 严格模式（默认关闭）：listener 路径无法向调用方抛错，只记录并丢弃本次调用
        log.error('[IPC] listener blocked by strict permission mode', { channel });
        return;
      }
      // P-3：发送方身份守卫。listener 路径同样**无法抛回**，故记录并丢弃本次调用
      //（与上面的严格模式分支保持同一处理语义）。
      if (ipcSenderGuard) {
        const gate = ipcSenderGuard({ channel, webContentsId: event.sender?.id, args });
        if (!gate.ok) {
          log.error('[IPC] listener blocked by sender identity guard', {
            channel,
            error: gate.error,
          });
          return;
        }
      }
      const profiling = isDiagnosticModeActive();
      const start = profiling ? performance.now() : 0;
      try {
        listener(event, ...args);
      } finally {
        if (profiling) {
          const syncMs = performance.now() - start;
          if (syncMs >= IPC_SYNC_WARN_MS) {
            log.warn(`[IPCProfiler] listener "${channel}" 同步占用主线程 ~${Math.round(syncMs)}ms`);
          }
        }
      }
    };
    this.listeners.get(channel)!.push(wrapped);
    ipcMain.on(channel, wrapped);
  }

  unregisterAll(): void {
    // Remove all handlers
    for (const channel of this.handlers.keys()) {
      ipcMain.removeHandler(channel);
    }
    this.handlers.clear();

    // Remove all listeners
    for (const [channel, listeners] of this.listeners.entries()) {
      for (const listener of listeners) {
        ipcMain.removeListener(channel, listener);
      }
    }
    this.listeners.clear();
  }

  getRegisteredChannels(): string[] {
    return [...this.handlers.keys(), ...this.listeners.keys()];
  }
}

export const ipcRegistry = new IpcRegistry();
