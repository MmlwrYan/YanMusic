/**
 * S-6（v1.3.0）：从日志文本中解析**主进程事件循环卡顿**摘要。
 *
 * ## 为什么要解析日志，而不是给 `eventLoopMonitor` 加统计接口
 *
 * 卡顿探测器只在**诊断模式**下运行（见 `app.ts` 的 `setDiagnosticStateListener`：
 * 只有在诊断模式期间才 `startEventLoopMonitor()`），这是刻意设计 ——
 * 平时不留常驻定时器。给它加一份**常驻统计状态**会与该设计相悖。
 *
 * 而日志里本来就有完整记录（`eventLoopMonitor.ts` 写的
 * `[EventLoopMonitor] 主进程事件循环卡顿 ~123ms（阈值 100ms）`）。
 * 解析它零副作用、不改动那个模块，也让「诊断包」与「用户看到的日志」口径一致。
 *
 * ## 单独成模块的原因
 *
 * `bundle.ts` 依赖 electron（`app.getPath`），无法在 `node --test` 下加载；
 * 而本解析逻辑是纯函数，抽出来后可以**直接驱动真行为**（含格式漂移的边界用例）。
 */

export interface EventLoopStallSummary {
  /** 累计出现的卡顿次数 */
  count: number;
  /** 最大卡顿毫秒数（无记录时为 0） */
  maxLagMs: number;
  /** 最近若干次卡顿的毫秒数（便于看趋势；旧→新） */
  recentLagsMs: number[];
}

/** 保留多少次最近样本（够看趋势，又不至于把诊断包撑大）。 */
const RECENT_SAMPLE_LIMIT = 10;

/**
 * 解析形如 `[EventLoopMonitor] 主进程事件循环卡顿 ~123ms` 的记录。
 *
 * 刻意**宽松匹配** `~<数字>ms`（不要求完整句子）：日志前缀/后缀措辞可能随版本调整，
 * 但「EventLoopMonitor + 卡顿 + ~Nms」这个信息骨架是稳定的；
 * 过严的正则会在改文案时静默失效（诊断包少了一项而无人察觉）。
 */
export const parseEventLoopStalls = (logText: string): EventLoopStallSummary => {
  const lags: number[] = [];
  if (typeof logText !== 'string' || logText.length === 0) {
    return { count: 0, maxLagMs: 0, recentLagsMs: [] };
  }

  for (const match of logText.matchAll(
    /\[EventLoopMonitor\][^\n]*?卡顿\s*~(\d+(?:\.\d+)?)\s*ms/g,
  )) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) lags.push(value);
  }

  return {
    count: lags.length,
    maxLagMs: lags.length > 0 ? Math.max(...lags) : 0,
    recentLagsMs: lags.slice(-RECENT_SAMPLE_LIMIT),
  };
};

/** 把多份日志的解析结果合并（诊断包会收录多个日志文件）。 */
export const mergeEventLoopStallSummaries = (
  parts: EventLoopStallSummary[],
): EventLoopStallSummary =>
  parts.reduce<EventLoopStallSummary>(
    (acc, part) => ({
      count: acc.count + part.count,
      maxLagMs: Math.max(acc.maxLagMs, part.maxLagMs),
      recentLagsMs: [...acc.recentLagsMs, ...part.recentLagsMs].slice(-RECENT_SAMPLE_LIMIT),
    }),
    { count: 0, maxLagMs: 0, recentLagsMs: [] },
  );
