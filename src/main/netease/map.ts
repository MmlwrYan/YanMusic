/**
 * 网易云对象 → YanMusic `Song` 形状的**纯映射**（v2.0.0）。
 *
 * ## 为什么单独一个文件（而不是留在 `api.ts` 里）
 *
 * 两个理由，都不是洁癖：
 *
 * 1. **可被真实数据驱动测试**。`api.ts` 会 `import { callNetease }`，
 *    后者最终依赖 Electron 的 `session`，在 `node --test` 下无法实例化。
 *    把纯函数抽出来后，本文件零依赖，可以用**真实上游响应**
 *    （见 `.workbuddy/tmp/probe-mapper.mjs` 的做法）直接喂进来验证，
 *    而不是在测试里手写一个「我以为的」样本 —— 后者的典型后果是
 *    「测试全绿但线上全错」。
 * 2. **首屏纪律**：映射在**主进程**做，渲染进程只收现成对象。
 *    见 `docs/agent/v2.0.0/24-netease-source-plan-2026-10-15.md` §7。
 */

interface RawArtist {
  id?: number | string;
  name?: string;
}

interface RawAlbum {
  id?: number | string;
  name?: string;
  /**
   * 封面 URL —— **实测只有 `/api/song/detail` 会给**。
   *
   * `/api/search/get` 只给 `picId`（数字），且该 id **无法直接拼成 URL**
   * （CDN 路径含一段 hash，实测裸拼 p1–p4 四个 host 全 404）。
   * 所以封面必须靠 `song/detail` 补，见 `api.ts` 的 `enrichCovers`。
   */
  picUrl?: string;
  /** 少数端点用 `picture`；一并认。 */
  picture?: string;
  /** 仅搜索端点提供，无 URL 价值，留作诊断。 */
  picId?: number | string;
}

export interface RawNeteaseSong {
  id?: number | string;
  name?: string;
  ar?: RawArtist[];
  artists?: RawArtist[];
  al?: RawAlbum;
  album?: RawAlbum;
  /** 毫秒 */
  dt?: number;
  /** 有些端点给的是 duration（毫秒） */
  duration?: number;
  fee?: number;
}

/**
 * 与 `src/renderer/models/song.ts` 的 `Song` 兼容的子集。
 *
 * 只填**必须由网易云决定**的字段；`hash`/`audioUrl` 等由渲染进程侧补空，
 * `source` 固定 `'netease'` 作为分流依据。
 */
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

/** 网易云封面支持 `?param=WxH` 裁剪；直接用原图会在列表里拉大图。 */
const coverWithSize = (url: string | undefined, size = 300): string =>
  url ? `${url}?param=${size}y${size}` : '';

const normalizeArtists = (raw: RawNeteaseSong): RawArtist[] => {
  if (Array.isArray(raw.ar) && raw.ar.length) return raw.ar;
  if (Array.isArray(raw.artists) && raw.artists.length) return raw.artists;
  return [];
};

const pickAlbum = (raw: RawNeteaseSong): RawAlbum | undefined => raw.al ?? raw.album ?? undefined;

/** 网易云 → `NeteaseSong`。`null` 表示这条记录不可用（缺 id 或缺名）。 */
export const mapNeteaseSong = (raw: unknown): NeteaseSong | null => {
  if (!raw || typeof raw !== 'object') return null;
  const song = raw as RawNeteaseSong;

  const id = song.id === undefined || song.id === null ? '' : String(song.id);
  const title = typeof song.name === 'string' ? song.name.trim() : '';
  if (!id || !title) return null;

  const artists = normalizeArtists(song);
  const artist = artists
    .map((a) => (a && typeof a.name === 'string' ? a.name : ''))
    .filter(Boolean)
    .join(' / ');

  const album = pickAlbum(song);
  // `picUrl` 是主字段（`/api/song/detail` 提供）；`picture` 作兼容兜底。
  // ⚠️ `/api/search/get` **两个都没有**，只有 `picId`（拼不出 URL）——
  // 所以搜索后必须补一次批量 detail，见 `api.ts` 的 `enrichCovers`。
  const cover = coverWithSize(album?.picUrl ?? album?.picture);

  // ⚠️ 单位：网易云给**毫秒**，而 `Song.duration` 是**秒**。
  // 写错不会报错，只会让进度条与歌词时间轴整体偏移。
  const rawDuration =
    typeof song.dt === 'number' && song.dt > 0
      ? song.dt
      : typeof song.duration === 'number' && song.duration > 0
        ? song.duration
        : 0;

  return {
    id,
    songId: id,
    title,
    name: title,
    artist,
    artists: artists
      .filter((a) => a && a.name)
      .map((a) => ({ id: a.id === undefined ? '' : String(a.id), name: String(a.name) })),
    albumName: album?.name,
    album: album?.name,
    albumId: album?.id === undefined ? undefined : String(album.id),
    coverUrl: cover,
    cover,
    duration: Math.round(rawDuration / 1000),
    source: 'netease',
    fee: typeof song.fee === 'number' ? song.fee : undefined,
    hash: '',
    mixSongId: '',
  };
};

/** 把一组原始歌曲映射为可用列表（丢弃不可用项）。 */
export const mapNeteaseSongs = (list: unknown): NeteaseSong[] =>
  (Array.isArray(list) ? list : []).map(mapNeteaseSong).filter((s): s is NeteaseSong => s !== null);
