/**
 * 播放游标推算（桌面歌词的进度来源）。
 *
 * 桌面歌词的进度不是一个连续上报的流：它只在收到快照时拿到一个**锚点**
 * （`baseMs` = 当时的播放位置，`anchorTick` = 收到锚点时的 `performance.now()`），
 * 中间位置靠每帧**外推**得到（`baseMs + 经过的墙钟时间 × 播放倍速`）。
 *
 * ## 旧实现为什么会让歌词卡住
 *
 * 旧逻辑是：
 *
 * ```text
 * if (isPlaying && 锚点足够新) 外推
 * else                         playSeekMsRaw = baseMs   // 钉死
 * ```
 *
 * 其中「锚点足够新」= 距上次快照 ≤ 1800ms。但主窗口被最小化/遮挡时，推送快照的
 * `setTimeout` 会被 Chromium 节流（见 `progressThrottle.ts` 的说明），快照间隔
 * 轻易超过 1800ms —— 于是**钉死分支被持续命中**，画面停在最后一次同步的位置
 *（表现为「卡在前面某句中间偏后」），而音频由主进程继续播放，毫不知情。
 *
 * 位置本身其实完全可推：播放中就是**墙钟时间 × 倍速**，这是单调、无需上报的量。
 * 因此只要处于播放状态就应当继续外推，用「外推上限」而不是「锚点新鲜度」来兜底。
 *
 * ## 兜底为什么是「上限」而不是「新鲜度」
 *
 * 外推的风险是锚点永久失联时**无限跑飞**（例如 `isPlaying` 本身已过期而无人纠正）。
 * 用固定上限约束「最多比最后一个锚点往前推多久」即可：
 * - 上限取得足够大（默认 90s），覆盖最极端的后台节流（密集节流约 1 次/分钟）；
 * - 又足够小，避免状态彻底失联时跑到歌曲末尾。
 *
 * 随后任何一次真实快照到达，`syncAnchor` 的漂移判定都会把游标重新对齐
 *（漂移 > 300ms 即重设锚点），这套自纠正在外推下依然成立。
 */

/**
 * 外推上限（毫秒）。超过它就不再前进，避免锚点永久失联时无限跑飞。
 *
 * 取 90s：Chromium 隐藏窗口的「密集节流」环境下定时器可低至 1 次/分钟，
 * 90s 足以跨过这种间隔而不冻结；同时远小于常见歌曲时长，不会把画面带到歌末。
 */
export const PLAYBACK_EXTRAPOLATION_LIMIT_MS = 90_000;

export type PlaybackCursorInput = {
  /** 是否正在播放（来自快照）。 */
  isPlaying: boolean;
  /** 锚点位置（毫秒）。 */
  baseMs: number;
  /** 记录锚点时的 `performance.now()`。 */
  anchorTick: number;
  /** 当前 `performance.now()`。 */
  nowTick: number;
  /** 播放倍速；非法值按 1 处理。 */
  playbackRate?: number;
  /** 歌曲总时长（毫秒）；≤0 表示未知，此时不做时长钳制。 */
  durationMs?: number;
  /** 覆盖默认外推上限（单测用）。 */
  extrapolationLimitMs?: number;
};

/**
 * 推算当前播放位置（毫秒）。
 *
 * - 未播放：返回锚点位置（暂停/拖动后锚点即为真实位置，不应外推）；
 * - 播放中：锚点位置 + min(经过时间, 上限) × 倍速，并受总时长钳制。
 */
export const resolvePlaybackCursorMs = ({
  isPlaying,
  baseMs,
  anchorTick,
  nowTick,
  playbackRate = 1,
  durationMs = 0,
  extrapolationLimitMs = PLAYBACK_EXTRAPOLATION_LIMIT_MS,
}: PlaybackCursorInput): number => {
  const base = Number.isFinite(baseMs) ? baseMs : 0;
  if (!isPlaying) return base;

  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  // 锚点取自未来时钟（时钟回拨、跨组件 tick 基准不同）时不外推，避免负向倒退。
  const elapsed = Math.max(0, nowTick - anchorTick);
  const limit =
    Number.isFinite(extrapolationLimitMs) && extrapolationLimitMs > 0
      ? extrapolationLimitMs
      : PLAYBACK_EXTRAPOLATION_LIMIT_MS;
  const extrapolated = base + Math.min(elapsed, limit) * rate;

  if (Number.isFinite(durationMs) && durationMs > 0) {
    return Math.min(extrapolated, durationMs);
  }
  return extrapolated;
};
