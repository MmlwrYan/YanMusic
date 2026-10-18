/**
 * 酷我音源 · 渲染进程 API 封装（v2.0.0）。
 *
 * 与 `api/netease.ts` 同一形态：走既有的 `request` 通道（主进程 IPC），
 * 不引入新的传输机制。字段归一化全在主进程（`src/main/kuwo/api.ts`），
 * 这里只做类型与透传 —— 首屏体积的容忍带很窄，不要在这里做映射。
 */

import request from '@/utils/request';

/** 主进程映射好的曲目（形状兼容 `@/models/song` 的 `Song` 子集）。 */
export interface KuwoSong {
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
  source: 'kuwo';
  /** 接口原始 rid（形如 `MUSIC_228908`），取链时用于校验身份 */
  kuwoRid: string;
  hash: '';
  mixSongId: '';
}

export interface KuwoSearchResult {
  songs: KuwoSong[];
  total: number;
  hasMore: boolean;
}

export type KuwoPlayResult =
  | { ok: true; url: string; format: string; bitrate?: number; br: number }
  | { ok: false; reason: 'not-found' | 'unavailable' | 'network'; message: string };

export function searchKuwo(keywords: string, limit = 30, page = 1) {
  return request.get('/kuwo/search', {
    params: { keywords, limit, page },
  }) as Promise<KuwoSearchResult>;
}

/**
 * 取播放地址。
 *
 * ⚠️ 必传 `title` / `artist`（而不是 id）：酷我接口不支持按 rid 查，
 * 只能拿「歌名 歌手」重查。`rid` 仅用于校验定位到的是不是同一首歌。
 */
export function getKuwoPlayUrl(song: {
  title: string;
  artist: string;
  rid?: string;
  quality?: string;
}) {
  return request.get('/kuwo/play-url', {
    params: {
      title: song.title,
      artist: song.artist,
      rid: song.rid,
      quality: song.quality,
    },
  }) as Promise<KuwoPlayResult>;
}
