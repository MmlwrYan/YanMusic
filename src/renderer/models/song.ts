import type { AudioQualityValue } from '@/types';

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
  /**
   * 酷我曲目的原始 rid（形如 `MUSIC_228908`）；仅 `source === 'kuwo'` 时有意义。
   *
   * v2.0.0：酷我接口**不支持按 rid 取链**，只能拿「歌名 歌手」重查，
   * 因此 `rid` 的唯一用途是**校验**「重查定位到的确实是这首歌」——
   * 上游结果顺序变化时，这是防「点了 A 播了 B」的唯一手段。
   */
  kuwoRid?: string;
  /**
   * JOOX 曲目的 `songmid`；仅 `source === 'joox'` 时有意义。
   *
   * v2.0.0：JOOX 接口支持 `mid=` 精确查询，所以取链**只依赖它**，
   * 不再像原客户端那样用「关键词 + 序号」。
   */
  jooxMid?: string;
  /** 第三方音源取链的本地时间戳（毫秒）；用于判断链接能否复用。 */
  sourceUrlFetchedAt?: number;
  /** 第三方音源实际下发的档位标签（可能与请求档位不同）。 */
  sourceQualityLabel?: AudioQualityValue;
  /**
   * 网易云的 `fee` 字段；仅 `source === 'netease'` 时有意义。
   *
   * v2.0.0：网易云**不返回**酷狗的 `privilege`/`payType`，它用 `fee` 表达权益。
   * `isVipSong`/`isPaidSong`（`utils/song.ts`）据此补了网易云分支，
   * 让「不可播」时能给出「需要购买/VIP」而不是笼统的「无法获取音源」。
   *
   * ⚠️ **只用于提示标签，不用于判定可播性**：实测 `fee === 8` 的歌照样给完整
   * URL（可播），拿 `fee` 卡可播性会误杀一大批。
   */
  fee?: number;
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
