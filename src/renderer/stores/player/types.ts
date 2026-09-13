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
export type PlaybackSourceKind = 'catalog' | 'cloud' | 'plugin';

export type ResolvedAudioSource = {
  url: string;
  urls?: string[];
  quality: AudioQualityValue | null;
  effect: AudioEffectValue;
  loudness: TrackLoudness | null;
  sourceKind?: PlaybackSourceKind;
};
