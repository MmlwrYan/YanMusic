export type PlayMode = 'sequential' | 'list' | 'random' | 'single';

export const DEFAULT_PLAYER_VOLUME = 0.5;

/** 播放进度条忙碌原因：定位中 / 缓冲中 / 无 */
export type PlaybackProgressBusyReason = 'seek' | 'buffering' | null;

export type PlaybackClockReason =
  'tick' | 'seek' | 'load' | 'play' | 'pause' | 'gapless' | 'recover';

/** 引擎侧播放时钟快照（歌词时间轴插值使用，可选来源） */
export interface PlaybackClockSnapshot {
  trackId: string | null;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  isPlaying: boolean;
  generation: number;
  seekTimestamp?: number;
  sampledAt?: number;
  reason?: PlaybackClockReason;
}
