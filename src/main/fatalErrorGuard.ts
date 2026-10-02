import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from './logger';

/**
 * 主进程未捕获异常兜底（S-1，v1.3.0）。
 *
 * **为什么要它**：此前全 `src/` 没有任何 `uncaughtException` / `unhandledRejection`
 * 处理 —— 主进程一旦出现未捕获异常，Electron 会直接终止进程：用户看到的是「应用
 * 凭空消失」，而日志是**异步**写入的（见 `logger.ts`：`transports.file.sync = false`，
 * 为的是不让日志爆发阻塞主线程），崩溃瞬间还排在队列里没刷盘的内容会一起丢掉，
 * 排查时几乎拿不到任何线索。
 *
 * **设计取舍（重要：不要把「该崩的地方」变成「静默继续」）**：
 *
 * 1. `uncaughtException` 视为**致命**：同步写一份崩溃摘要 → 尽量落一条日志 →
 *    同步弹框告知 → 以**非 0** 退出码退出。**刻意不吞掉异常继续运行** —— 主进程
 *    状态此时已不可信，继续跑只会制造更难定位的次生故障（典型：状态半更新、
 *    native 句柄泄漏、后续操作静默写坏数据）。
 * 2. `unhandledRejection` **不退出**：Node 默认会把它升级为崩溃，但 Electron 应用里
 *    大量「忘记 await 的无害 Promise」会让应用随机闪退，代价远大于收益。这里只记
 *    `error` 级日志并计数。**残余风险是可能掩盖真实失败** —— 因此日志带
 *    `[UNHANDLED-REJECTION]` 前缀便于检索，且首次出现时会写一份摘要（保留现场）。
 * 3. **递归保护**：本模块的 handler 自身再抛错时不再走本逻辑，直接退出，避免
 *    handler ↔ 异常 的死循环。
 * 4. 摘要文件用**同步** `writeFileSync` 写小文件（几百字节），保证「崩溃现场一定
 *    落盘」，这是本模块敢依赖它的前提；与之相对，日志走异步通道。
 * 5. 弹框用**同步**的 `dialog.showErrorBox`（Electron 少数在 `ready` 之前也可用的
 *    API），内容里给出摘要文件路径，用户可直接把它交给维护者。
 */

/** 崩溃摘要文件名（落在 `app.getPath('userData')` 下） */
const FATAL_SUMMARY_FILENAME = 'last-fatal-error.txt';

/** 递归保护开关：一旦本模块的 handler 已在进行中，后续异常直接退出 */
let handlingFatal = false;

/** 未处理 rejection 累计次数（进程生命周期内） */
let rejectionCount = 0;

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/**
 * 同步写崩溃摘要。返回写入路径；失败返回 `null`（不抛错 —— 它本身就在异常路径上）。
 * 用同步写是刻意的：异步写入在「即将退出」的场景里不可靠。
 */
const writeFatalSummary = (kind: string, error: unknown): string | null => {
  const file = path.join(app.getPath('userData'), FATAL_SUMMARY_FILENAME);
  try {
    const text = [
      '# YanMusic 主进程异常摘要',
      '',
      `时间:       ${new Date().toISOString()}`,
      `类型:       ${kind}`,
      `版本:       ${app.getVersion()}`,
      `平台:       ${process.platform} ${process.arch}`,
      `Electron:   ${process.versions.electron} / Node ${process.versions.node}`,
      `rejection:  累计 ${rejectionCount} 次未处理 Promise 拒绝`,
      '',
      '--- 原始错误 ---',
      formatError(error),
      '',
    ].join('\n');
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch (writeError) {
    try {
      log.error('[Fatal] 崩溃摘要写入失败:', writeError);
    } catch {
      // logger 在极早期崩溃时可能还不可用 —— 到这里已无更好的手段
    }
    return null;
  }
};

/**
 * 安装主进程兜底 handler。**必须在主进程模块求值的最早期调用一次**
 * （`app.ts` 中紧跟 `initLogger()` 之后），越早覆盖越广。
 */
export const installFatalErrorGuard = (): void => {
  process.on('uncaughtException', (error) => {
    if (handlingFatal) {
      // handler 自身出错：不再尝试报告，直接退出，避免死循环
      app.exit(1);
      return;
    }
    handlingFatal = true;

    try {
      log.error('[Fatal][uncaughtException]', error);
    } catch {
      // 忽略：下面还有同步摘要这一条兜底
    }

    const summaryPath = writeFatalSummary('uncaughtException', error);

    try {
      dialog.showErrorBox(
        'YanMusic 遇到未处理的错误',
        [
          '应用将立即关闭。',
          '',
          '诊断信息已写入：',
          summaryPath ?? '（摘要写入失败）',
          '',
          '把该文件附在问题反馈里即可。错误摘要：',
          formatError(error).slice(0, 1500),
        ].join('\n'),
      );
    } catch {
      // 弹框失败（极早期的崩溃 / 无桌面会话）不应再引发二次异常
    }

    app.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    rejectionCount += 1;
    try {
      log.error('[Fatal][UNHANDLED-REJECTION]', reason);
    } catch {
      // 同上
    }
    // 只在首次出现时写摘要：避免高频 rejection 反复同步写盘，
    // 同时保留「第一次现场」（往往信息最全）。
    if (rejectionCount === 1) {
      writeFatalSummary('unhandledRejection(首次)', reason);
    }
  });
};
