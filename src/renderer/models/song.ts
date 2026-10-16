export interface SongRelateGood {
  hash?: string;
  quality?: string;
  level?: number;
}

export interface SongArtist {
  id?: string | number;
  name: string;
}

export interface Song {
  id: string;
  songId?: string | number;
  title: string;
  name?: string;
  artist: string;
  language?: string;
  albumName?: string;
  artists?: SongArtist[];
  singers?: SongArtist[];
  album?: string;
  albumId?: string | number;
  duration: number;
  coverUrl: string;
  cover?: string;
  audioUrl: string;
  hash: string;
  // 一起听（房间歌单）用于翻页与同步定位的原始版权 hash
  originalHash?: string;
  mvHash?: string;
  albumAudioId?: string | number;
  originalAlbumAudioId?: string | number;
  // 一起听授权：0=不可播，1=完整播放，2=仅片段
  listenTogetherCanPlay?: number;
  // 一起听计费类型：1=免费，2/3=VIP，4/5/6=单曲或专辑付费
  listenTogetherGenting?: number;
  mixSongId: string | number;
  fileId?: string | number;
  source?: string;
  /**
   * 网易云播放链的绝对过期时间（毫秒时间戳）；仅 `source === 'netease'` 时有意义。
   *
   * v2.0.0：网易云取链响应带 `expi`（**剩余秒数**，典型 ~1200s），
   * 主进程已换算成绝对时间。`neteaseSource.ts` 复用链接前会用它判过期
   * —— 过期后拉流会直接失败，且不会抛错，所以必须显式判断。
   */
  neteaseExpireAt?: number;
  lyric?: string;
  lyricSnippet?: string;
  privilege?: number;
  payType?: number;
  oldCpy?: number;
  relateGoods?: SongRelateGood[];
  isOriginal?: boolean;
  recDesc?: string;
  similarDesc?: string;
  playCount?: number;
  lastPlayedAt?: number;
  historyKey?: string;
}
