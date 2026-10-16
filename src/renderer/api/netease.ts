/**
 * 网易云音源 · 渲染进程 API 封装（v2.0.0）。
 *
 * 走的是**与酷狗完全相同**的 `request` 通道（`utils/request.ts:295`）——
 * 也就是说网易云不需要任何新的传输机制，只是在既有 IPC 上多了一组路由。
 *
 * ## 刻意保持"瘦"
 *
 * 字段归一化（毫秒→秒、封面取尺寸、artist 拼接）**全在主进程**
 * （`src/main/netease/api.ts`）。这里只做类型声明与透传。
 *
 * 原因：首屏体积预算的容忍带只剩约 22 KB
 * （见 `docs/agent/v2.0.0/24-netease-source-plan-2026-10-15.md` §7）。
 * **不要把映射逻辑搬到这里。**
 */

import request from '@/utils/request';

/** 主进程映射好的歌曲对象（形状兼容 `@/models/song` 的 `Song` 子集）。 */
export interface NeteaseSong {
  id: string;
  songId: string;
  title: string;
  name: string;
  artist: string;
  artists: { id: string; name: string }[];
  albumName?: string;
  album?: string;
  albumId?: string;
  coverUrl: string;
  cover: string;
  /** 秒 */
  duration: number;
  source: 'netease';
  fee?: number;
  hash: '';
  mixSongId: '';
}

export interface NeteaseSearchResult {
  songs: NeteaseSong[];
  total: number;
  hasMore: boolean;
}

export interface NeteaseAudioUrl {
  url: string;
  /** 绝对过期时间（毫秒时间戳）；主进程已把上游的「剩余秒数」换算好。 */
  expireAt?: number;
  /** 服务端**实际**返回的码率（可能低于请求值 —— 匿名会被降级，属正常）。 */
  br?: number;
  /** 服务端实际返回的档位名，如 `exhigh`。 */
  level?: string;
  type?: string;
  fee?: number;
}

/** 取链失败时的正常业务返回（**不是** HTTP 错误）。 */
export interface NeteaseAudioUrlEmpty {
  url: null;
  reason: string;
  triedBitrates: number[];
}

export interface NeteaseLyric {
  lyric: string;
  translation: string;
}

export function searchNetease(keywords: string, limit = 30, offset = 0) {
  return request.get('/netease/search', {
    params: { keywords, limit, offset },
  }) as Promise<NeteaseSearchResult>;
}

/** 取播放链。`quality` 是项目音质值，主进程据此推导 br 候选并逐档降级。 */
export function getNeteaseSongUrl(id: string | number, quality?: string) {
  return request.get('/netease/song/url', {
    params: { id, quality },
  }) as Promise<NeteaseAudioUrl | NeteaseAudioUrlEmpty>;
}

export function getNeteaseLyric(id: string | number) {
  return request.get('/netease/lyric', { params: { id } }) as Promise<NeteaseLyric>;
}

export function getNeteaseSongDetail(ids: (string | number)[]) {
  return request.get('/netease/song/detail', {
    params: { ids: ids.join(',') },
  }) as Promise<{ songs: NeteaseSong[] }>;
}
