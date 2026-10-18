/**
 * JOOX 音源 · 渲染进程 API 封装（v2.0.0）。
 *
 * 与 `api/netease.ts` 同一形态：走既有 `request` 通道，映射全在主进程。
 */

import request from '@/utils/request';

export interface JooxSong {
  id: string;
  songId: string;
  title: string;
  name: string;
  artist: string;
  artists: { id: string; name: string }[];
  albumName?: string;
  album?: string;
  coverUrl: string;
  cover: string;
  /** 秒 */
  duration: number;
  source: 'joox';
  /** 搜索阶段拿到的 mid —— 取链的唯一依据 */
  jooxMid: string;
  hash: '';
  mixSongId: '';
}

export interface JooxSearchResult {
  songs: JooxSong[];
  total: number;
  hasMore: boolean;
}

export type JooxPlayResult =
  | { ok: true; url: string; qualityKey: string; isPreview: boolean }
  | { ok: false; reason: 'not-found' | 'unavailable' | 'network'; message: string };

export function searchJoox(keywords: string, limit = 30) {
  return request.get('/joox/search', {
    params: { keywords, limit },
  }) as Promise<JooxSearchResult>;
}

/** 取播放地址：用 `mid` 精确查询（接口支持 `msg` 或 `mid`，后者不受结果顺序影响）。 */
export function getJooxPlayUrl(mid: string, quality?: string) {
  return request.get('/joox/play-url', {
    params: { mid, quality },
  }) as Promise<JooxPlayResult>;
}
