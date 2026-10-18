/**
 * 酷我 / JOOX 的取链实现（v2.0.0）。
 *
 * 由 `stores/player/resolver.ts` 按 `track.source` 分流进来。
 * **这是第三方音源在播放链上唯一的接缝**，酷狗路径一行未动。
 *
 * ## 为什么两个源共用一个文件
 *
 * 两者的差异全在**主进程**（重查策略、音质候选顺序），到了渲染层只剩
 * 「调接口 → 判结果 → 回写 URL」三件事，逐字相同的代码写两遍只会
 * 让下一次改动漏掉一个。故共用 `resolveThirdPartySource`，用 `kind` 区分。
 *
 * ## 链接有效期
 *
 * 两个源的直链都带签名（酷我是路径里的签发时间戳，JOOX 是 `vkey`），
 * 但**都没有可靠的过期字段**：
 * - 酷我签名的 TTL 实测在 1 小时到 16 天之间，无规律；
 * - JOOX 的 `vkey` 逐次签发，未观测到明确 TTL。
 *
 * 所以这里用**保守的本地 TTL**（30 分钟）：超过就重新取链，
 * 而不是赌签名还有效。代价是长时间单曲循环会多一次请求，
 * 收益是「不会在播到一半时因签名过期而断流」。
 */

import type { Song } from '@/models/song';
import logger from '@/utils/logger';
import { getKuwoPlayUrl } from '@/api/kuwo';
import { getJooxPlayUrl } from '@/api/joox';
import type { AudioQualityValue } from '../../types';
import type { ResolvedAudioSource } from './types';

/** 保守的链接复用窗口。见文件头「链接有效期」。 */
export const THIRD_PARTY_URL_TTL_MS = 30 * 60 * 1000;

export type ThirdPartyKind = 'kuwo' | 'joox';

export interface ResolveThirdPartyOptions {
  quality: AudioQualityValue;
  forceReload: boolean;
  kind: ThirdPartyKind;
}

/** 链接是否还能复用（只判本地 TTL，不探测远端 —— 探测留给真正播放时）。 */
export const isThirdPartyUrlFresh = (
  url: string,
  fetchedAt: number | undefined,
  now = Date.now(),
): boolean => {
  if (!url) return false;
  if (typeof fetchedAt !== 'number') return false;
  return now - fetchedAt < THIRD_PARTY_URL_TTL_MS;
};

const fail = (kind: ThirdPartyKind, reason: string, detail?: unknown): ResolvedAudioSource => {
  logger.warn('PlayerResolver', `${kind} 无可播链接`, detail ?? reason);
  return { url: '', quality: null, effect: 'none', loudness: null, sourceKind: kind };
};

/** `Song.songId` 是 `string | number | undefined`（各音源来源不一），取链前统一成字符串。 */
const asString = (value: string | number | undefined): string =>
  value === undefined || value === null ? '' : String(value);

/**
 * 取链并归一化成 `ResolvedAudioSource`。
 *
 * ⚠️ **失败返回空 url 而不是抛错**：这两个源的失败是「这首不能放」
 * （无版权/签名过期/需要会员），属于正常业务结果，
 * 抛错会被上层记成「播放器故障」，用户看到的是崩溃式的错误提示。
 */
export const resolveThirdPartySource = async (
  track: Song,
  options: ResolveThirdPartyOptions,
): Promise<ResolvedAudioSource> => {
  const { kind } = options;

  // ① 复用：本地 TTL 内且没要求强制刷新
  if (!options.forceReload && isThirdPartyUrlFresh(track.audioUrl, track.sourceUrlFetchedAt)) {
    return {
      url: track.audioUrl,
      urls: [track.audioUrl],
      quality: track.sourceQualityLabel ?? options.quality,
      effect: 'none',
      loudness: null,
      sourceKind: kind,
      expireAt: (track.sourceUrlFetchedAt ?? 0) + THIRD_PARTY_URL_TTL_MS,
    };
  }

  // ② 取链
  if (kind === 'kuwo') {
    const result = await getKuwoPlayUrl({
      title: track.title,
      artist: track.artist,
      rid: track.kuwoRid ?? asString(track.songId),
      quality: options.quality,
    });

    if (!result.ok) {
      return fail(kind, result.reason, { title: track.title, artist: track.artist });
    }

    return commit(track, {
      kind,
      url: result.url,
      qualityLabel: kuwoLabel(result.format),
      detail: { format: result.format, bitrate: result.bitrate, br: result.br },
    });
  }

  const mid = track.jooxMid ?? asString(track.songId);
  const result = await getJooxPlayUrl(mid, options.quality);
  if (!result.ok) {
    return fail(kind, result.reason, { mid });
  }
  if (result.isPreview) {
    // 只有 30 秒片段时**如实标注**，不假装成完整曲目。
    logger.warn('PlayerResolver', 'JOOX 仅返回试听片段', { mid: track.jooxMid });
  }

  return commit(track, {
    kind,
    url: result.url,
    qualityLabel: jooxLabel(result.qualityKey),
    detail: { qualityKey: result.qualityKey, isPreview: result.isPreview },
  });
};

/** 酷我 `format` → 项目音质枚举（标低不标高）。 */
const kuwoLabel = (format: string | undefined): AudioQualityValue => {
  const f = String(format ?? '').toLowerCase();
  if (f === 'flac' || f === 'wav' || f === 'ape' || f === 'alac' || f === 'aiff') return 'flac';
  return '320';
};

/** JOOX 档位键名 → 项目音质枚举。Atmos 不按无损算（它是对象音频）。 */
const jooxLabel = (key: string): AudioQualityValue => {
  if (key === '母带无损' || key === 'Hi-Res无损' || key === '无损FLAC') return 'flac';
  if (key.includes('320')) return '320';
  return '128';
};

/** 回写 track 并构造结果（两条分支共用，避免回写逻辑漏一处）。 */
const commit = (
  track: Song,
  payload: {
    kind: ThirdPartyKind;
    url: string;
    qualityLabel: AudioQualityValue;
    detail: unknown;
  },
): ResolvedAudioSource => {
  track.audioUrl = payload.url;
  track.sourceUrlFetchedAt = Date.now();
  track.sourceQualityLabel = payload.qualityLabel;

  logger.debug('PlayerResolver', `${payload.kind} 取链成功`, {
    title: track.title,
    quality: payload.qualityLabel,
    ...(typeof payload.detail === 'object' && payload.detail ? payload.detail : {}),
  });

  return {
    url: payload.url,
    urls: [payload.url],
    quality: payload.qualityLabel,
    effect: 'none',
    loudness: null,
    sourceKind: payload.kind,
    expireAt: Date.now() + THIRD_PARTY_URL_TTL_MS,
  };
};
