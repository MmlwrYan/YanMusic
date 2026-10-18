import type { AudioEffectValue, AudioQualityValue } from '../../types';
import type { TrackLoudness } from '@/utils/player';

export type ClimaxMark = { start: number; end: number };

export type PlaybackNotice = {
  code: string;
  title: string;
  reason: string;
  detail: string;
  trackId: string | null;
};

/**
 * 音源来源类型。对齐 Echo（一起听房间授权音源会带 sourceKind: 'catalog'）。
 * Yan 暂无 currentResolvedSourceKind / 插件音源子系统，故此处仅作为可选标注，
 * 不参与任何播放决策，既有代码不传该字段时行为完全不变。
 */
export type PlaybackSourceKind =
  'catalog' | 'cloud' | 'plugin' | 'netease' | 'kuwo' | 'joox' | 'soda';

export type ResolvedAudioSource = {
  url: string;
  urls?: string[];
  quality: AudioQualityValue | null;
  effect: AudioEffectValue;
  loudness: TrackLoudness | null;
  sourceKind?: PlaybackSourceKind;
  /**
   * 该 URL 的绝对过期时间（毫秒时间戳）；`undefined` = 上游未告知。
   *
   * v2.0.0 引入：网易云的播放链带 `expi`（**剩余秒数**，典型 ~1200s）。
   * 过期后不会抛错，而是**拉流直接失败**，所以必须能判过期。
   * 本项目此前没有任何 TTL 逻辑（只有 `forceReload`），这是第一处。
   */
  expireAt?: number;
};
