/**
 * 网易云音源的取链实现（v2.0.0）。
 *
 * 由 `stores/player/resolver.ts` 的 `resolveAudioUrl` 按 `track.source === 'netease'`
 * 分流进来。**这是网易云在播放链上唯一的接缝**，酷狗路径一行未动。
 *
 * ## 链接过期（本文件存在的主要理由）
 *
 * 网易云播放链带 `expi`（**剩余秒数**，典型 ~1200s）。过期后的表现是
 * **拉流失败**而不是取链报错 —— 也就是说如果不判过期，
 * 用户看到的是「播到一半突然断了」，而日志里什么都没有。
 *
 * 本项目此前没有任何 TTL 逻辑（只有 `forceReload`），所以这里做两件事：
 * 1. 复用前校验 `expireAt`（留 60s 安全边距）；
 * 2. 过期/缺失即重新取链。
 */

import type { Song } from '@/models/song';
import logger from '@/utils/logger';
import { getNeteaseSongUrl, type NeteaseAudioUrl, type NeteaseAudioUrlEmpty } from '@/api/netease';
import type { AudioQualityValue } from '../../types';
import type { ResolvedAudioSource } from './types';

/** 复用链接时预留的安全边距：剩余不足这个值就重新取链。 */
const EXPIRE_SAFETY_MARGIN_MS = 60_000;

export interface ResolveNeteaseOptions {
  quality: AudioQualityValue;
  forceReload: boolean;
  /** 由调用方提供，避免本模块依赖 settingStore。 */
  resolveQualityLabel: (track: Pick<Song, 'relateGoods'>) => AudioQualityValue;
}

const isNonEmptyUrl = (
  payload: NeteaseAudioUrl | NeteaseAudioUrlEmpty | null,
): payload is NeteaseAudioUrl => Boolean(payload && typeof payload.url === 'string' && payload.url);

/** 链接是否仍可用（上游没给 `expireAt` 时保守认为可用）。 */
export const isNeteaseUrlFresh = (
  url: string,
  expireAt: number | undefined,
  now = Date.now(),
): boolean => {
  if (!url) return false;
  if (typeof expireAt !== 'number') return true;
  return expireAt - now > EXPIRE_SAFETY_MARGIN_MS;
};

export const resolveNeteaseAudioSource = async (
  track: Song,
  options: ResolveNeteaseOptions,
): Promise<ResolvedAudioSource> => {
  const id = track.songId ?? track.id;

  // ① 复用：仅在链接**未过期**且调用方没要求强制刷新时。
  if (
    !options.forceReload &&
    track.audioUrl &&
    isNeteaseUrlFresh(track.audioUrl, track.neteaseExpireAt)
  ) {
    return {
      url: track.audioUrl,
      urls: [track.audioUrl],
      quality: options.resolveQualityLabel(track),
      effect: 'none',
      loudness: null,
      sourceKind: 'netease',
      expireAt: track.neteaseExpireAt,
    };
  }

  // ② 取链（主进程按 br 从高到低降级，返回服务端实际给出的那一档）
  let payload: NeteaseAudioUrl | NeteaseAudioUrlEmpty | null = null;
  try {
    payload = await getNeteaseSongUrl(id, options.quality);
  } catch (error) {
    logger.warn('PlayerResolver', '网易云取链请求失败', error);
  }

  if (!isNonEmptyUrl(payload)) {
    // 正常业务结果（无版权/需付费/匿名档位拿不到），不是异常路径。
    logger.warn('PlayerResolver', '网易云无可播链接', {
      id: String(id),
      quality: options.quality,
      reason:
        payload && 'reason' in payload && payload.reason ? payload.reason : '网络失败或响应异常',
    });
    return { url: '', quality: null, effect: 'none', loudness: null, sourceKind: 'netease' };
  }

  // ③ 回写：把过期时间留在 track 上，供下一次复用判断。
  track.audioUrl = payload.url;
  track.neteaseExpireAt = payload.expireAt;

  return {
    url: payload.url,
    urls: [payload.url],
    // ⚠️ 用**请求**的档位，而不是服务端实际返回的档位。
    // 本项目 `AudioQualityValue` 是离散枚举（'128'|'320'|'flac'|'high'|'super'），
    // 而网易云回的是它自己的名字（`exhigh`/`higher`/`standard`），
    // 直接塞进去会污染 UI 的质量标签。实际档位只用于日志诊断。
    // （实测：匿名请求 br=999000 会被服务端降级到 320003/exhigh，属正常行为。）
    quality: options.quality,
    effect: 'none',
    loudness: null,
    sourceKind: 'netease',
    expireAt: payload.expireAt,
  };
};
