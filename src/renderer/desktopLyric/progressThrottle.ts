/**
 * 领先沿（leading-edge）时间节流器。
 *
 * ## 为什么不能用 `setTimeout` 防抖
 *
 * 桌面歌词的进度快照由**主窗口渲染层**推送（`desktopLyric/sync.ts`）。原先它用
 * `setTimeout(80ms)` 做防抖，而主窗口是 `backgroundThrottling: true`
 *（`main/window.ts`，v1.2.6 为省电刻意开启）。窗口被遮挡/最小化时，Chromium 会
 * **节流渲染层的定时器**：普通后台节流 ≥1s，隐藏超过 5 分钟后进入「密集节流」，
 * 可低至 **1 次/分钟**。
 *
 * 后果：桌面歌词收到的进度快照间隔可达数十秒，而它自身的过期阈值只有 1.8s，
 * 于是**硬钉在最后一次同步的位置不再推进** —— 用户所见即「换句时一卡、随后卡在
 * 前面某句中间偏后，音乐却正常播放」。
 *
 * ## 关键：被节流的是**定时器**，不是数据来源
 *
 * `mpv:time-update` 由**主进程**以 200ms 节流推送（主进程的定时器不受渲染层节流
 * 影响），到达渲染层后由 `watch` 处理 —— 而 Vue 的 watcher 是**微任务**，同样不受
 * 定时器节流影响。因此只要去掉定时器、改为**按调用时刻判断**的领先沿节流，
 * 窗口隐藏时也能保持原本的推送节奏。
 *
 * ## 刻意不做尾部补偿
 *
 * 数据源本身在持续推送（200ms 一次），任何一次到达只要距上次超过间隔就会立即发送，
 * 所以尾部补偿对本场景没有价值；而它**需要定时器** —— 那正是要摆脱的东西。
 * 若数据源真的停了（例如播放暂停），下一次状态变化会带来新的事件，
 * 届时 `reset()` 或首次 `shouldRun()` 会立刻放行。
 */
export type LeadingEdgeThrottle = {
  /** 是否应当立即执行；返回 `true` 时记录本次时间。 */
  shouldRun: () => boolean;
  /** 清除时间记录（下一次调用必定放行）。 */
  reset: () => void;
};

/**
 * 创建一个领先沿节流器。
 *
 * 纯时间判断，**不注册任何定时器** —— 这是本模块存在的全部理由，
 * 故调用方不应再额外加 `setTimeout`。
 *
 * @param intervalMs 最小间隔（毫秒）。非有限值或 ≤0 时视为「不节流」（永远放行）。
 * @param now 取当前时刻的函数，默认 `Date.now`。注入以便单测。
 */
export const createLeadingEdgeThrottle = (
  intervalMs: number,
  now: () => number = Date.now,
): LeadingEdgeThrottle => {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  let lastRunAt: number | null = null;

  return {
    shouldRun: () => {
      const current = now();
      if (interval > 0 && lastRunAt !== null && current - lastRunAt < interval) {
        return false;
      }
      lastRunAt = current;
      return true;
    },
    reset: () => {
      lastRunAt = null;
    },
  };
};
