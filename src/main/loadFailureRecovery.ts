import { dialog, type BrowserWindow } from 'electron';
import log from './logger';
import { isRecoverableLoadFailure } from '../shared/loadFailurePolicy';

/**
 * 界面加载失败的兜底恢复（S-2，v1.3.0）。
 *
 * **为什么要它**：全 `src/main` 此前 **0 处** `did-fail-load` 处理 —— 一旦某个窗口
 * 的 HTML/JS 加载失败（产物缺失、磁盘错误、临时文件损坏、dev server 未启动），
 * 用户看到的就是一个**纯白窗口，没有提示、没有重试、没有错误码**，只能强杀应用。
 * 这类故障恰好是 v1.2.4「装包打不开」事故的用户侧表现，本模块补上第二层兜底。
 *
 * **行为分两类**：
 * - 主窗口 / 插件窗口（`promptUser: true`）：弹框给出错误码与地址，可「重试」或
 *   「关闭窗口」。这是用户唯一能自救的入口。
 * - 辅助窗口（mini 播放器 / 桌面歌词，`promptUser: false`）：不弹框（它们常常没有
 *   焦点，弹框会变成看不见的模态），改为**自动重载一次**并记日志；仍失败就放弃，
 *   由调用方决定是否销毁。
 *
 * **防抖与降噪**（避免把兜底做成新的骚扰源）：
 * - 只处理**主框架**失败（`isMainFrame`），子 iframe 失败不打扰用户；
 * - 忽略 `ERR_ABORTED`（-3）：导航被新的导航请求打断属正常现象，不是故障；
 * - 同一窗口**同一轮加载只提示一次**；用户主动点「重试」后重新放行（他显然还想试）；
 *   辅助窗口只自动重载一次，避免失败 → 重载 → 再失败 的死循环。
 *
 * 判定逻辑（`isRecoverableLoadFailure`）放在 `shared/loadFailurePolicy.ts`：本模块
 * import 了 electron 无法在 node 下加载，而那段判定必须能真单测。
 */

export interface LoadFailureRecoveryOptions {
  /** 日志与提示里显示给用户的窗口名，如「主界面」 */
  label: string;
  /** true = 弹框让用户选；false = 只自动重载一次并记日志（辅助窗口用） */
  promptUser: boolean;
  /** 用户/系统决定放弃时的收尾动作，默认 `win.close()` */
  onGiveUp?: () => void;
}

const showRecoveryDialog = async (
  win: BrowserWindow,
  options: LoadFailureRecoveryOptions,
  info: { errorCode: number; errorDescription: string; validatedURL: string },
): Promise<boolean> => {
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: '界面加载失败',
      message: `${options.label}加载失败（错误码 ${info.errorCode}）`,
      detail: [
        info.errorDescription,
        info.validatedURL ? `地址：${info.validatedURL}` : '',
        '',
        '可以点「重试」重新加载。若反复失败，请把日志目录里的日志文件附在问题反馈里。',
      ]
        .filter(Boolean)
        .join('\n'),
      buttons: ['重试', '关闭窗口'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (win.isDestroyed()) return false;
    if (response === 0) return true;
    if (options.onGiveUp) options.onGiveUp();
    else win.close();
    return false;
  } catch (error) {
    log.warn(`[LoadFailure][${options.label}] 恢复对话框失败:`, error);
    return false;
  }
};

/**
 * 给一个窗口挂上加载失败恢复。**应在创建窗口后、调用 `loadURL` / `loadFile` 之前调用**，
 * 否则会漏掉第一次加载的失败事件。
 */
export const attachLoadFailureRecovery = (
  win: BrowserWindow,
  options: LoadFailureRecoveryOptions,
): void => {
  /** 本轮加载是否已提示过（用户点「重试」后重置） */
  let promptShown = false;
  /** 辅助窗口是否已自动重载过（不重置，避免失败循环） */
  let autoReloaded = false;

  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isRecoverableLoadFailure(isMainFrame, errorCode)) return;

      log.error(`[LoadFailure][${options.label}] 界面加载失败`, {
        errorCode,
        errorDescription,
        validatedURL,
      });

      if (win.isDestroyed()) return;

      if (!options.promptUser) {
        if (autoReloaded) {
          // 自动重载后仍失败：交回上层收尾（辅助窗口通常直接销毁，免得留一个白窗口）
          log.warn(`[LoadFailure][${options.label}] 自动重载后仍失败，交由上层收尾`);
          if (options.onGiveUp) options.onGiveUp();
          return;
        }
        autoReloaded = true;
        const timer = setTimeout(() => {
          if (!win.isDestroyed()) {
            log.info(`[LoadFailure][${options.label}] 自动重载一次`);
            win.reload();
          }
        }, 1000);
        if (typeof timer.unref === 'function') timer.unref();
        return;
      }

      if (promptShown) return;
      promptShown = true;
      void showRecoveryDialog(win, options, { errorCode, errorDescription, validatedURL }).then(
        (retry) => {
          if (!retry) return;
          promptShown = false;
          if (!win.isDestroyed()) win.reload();
        },
      );
    },
  );

  // 加载成功即解除本轮的提示抑制，让下次真失败仍能提示
  win.webContents.on('did-finish-load', () => {
    promptShown = false;
  });
};
