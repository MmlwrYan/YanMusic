/**
 * JOOX 音源的**纯函数**集合（v2.0.0）。
 *
 * 与 `kuwo/parsers.ts`、`netease/map.ts` 同一理由：`api.ts` 依赖
 * Electron 的 `session`（经 `networkFetch`），不能进 `node --test`；
 * 而「音质候选顺序」「时长解析」恰恰是最该被测试钉住的部分 ——
 * 它们直接决定「选到哪一档」和「进度条对不对」。
 */

/**
 * 全部 12 档，**按真实音质从高到低**排列。
 *
 * ## 这不是随手排的优先级
 *
 * 原客户端把 `Atmos全景声` 放在第一位，于是只要该曲有 Atmos 版本就永远
 * 轮不到母带/无损 FLAC（实测「晴天」「擱淺」都命中 `Q0M0` = Atmos）。
 * 而 Atmos 是**对象音频**，与「无损 PCM」不是一回事：普通 `<audio>` 对它的
 * 还原情况未经确认，不该作为默认最优解。
 *
 * 因此顺序改为：母带 → Hi-Res → 无损 FLAC → Atmos → 有损各档。
 */
export const JOOX_QUALITY_KEYS = [
  '母带无损',
  'Hi-Res无损',
  '无损FLAC',
  'Atmos全景声',
  'OGG 320',
  'MP3 320',
  'AAC 192',
  'OGG 192',
  'MP3 128',
  'AAC 96',
  'AAC 48',
  '30s 18',
] as const;

export type JooxQualityKey = (typeof JOOX_QUALITY_KEYS)[number];

/** 真正的无损档（Atmos **不在**此列）。 */
export const JOOX_LOSSLESS_KEYS: readonly string[] = ['母带无损', 'Hi-Res无损', '无损FLAC'];

/** 试听短片段档。 */
export const JOOX_PREVIEW_KEY = '30s 18';

/**
 * 按项目音质偏好挑选候选序列（由高到低，调用方逐个探测）。
 *
 * 与 `neteaseBitrateCandidates` 语义一致：用户要 320 时不必去试母带
 * （那会多两次探测、多等一秒）。最后一档永远包含试听片段 ——
 * 有片段总比「什么都没有」好，且结果里会标 `isPreview`。
 */
export const jooxCandidateKeys = (quality: string | undefined): readonly JooxQualityKey[] => {
  switch (quality) {
    case 'super':
    case 'high':
      return JOOX_QUALITY_KEYS;
    case 'flac':
      return [
        '母带无损',
        'Hi-Res无损',
        '无损FLAC',
        'Atmos全景声',
        'OGG 320',
        'MP3 320',
        'AAC 192',
        'OGG 192',
        '30s 18',
      ];
    case '320':
      return ['OGG 320', 'MP3 320', 'AAC 192', 'OGG 192', 'MP3 128', 'AAC 96', '30s 18'];
    default:
      // '128' / 未知：只要中等可用档，不浪费探测
      return ['MP3 128', 'AAC 96', 'OGG 192', '30s 18'];
  }
};

/**
 * 档位键名 → 项目音质枚举。
 *
 * ⚠️ 不能按 URL 后缀判断：`.flac` 同时覆盖母带/无损/Hi-Res/**Atmos**
 * 四种语义完全不同的东西，靠后缀会把 Atmos 标成「无损」。
 */
export const qualityLabelOfJooxKey = (key: string): 'flac' | '320' | '128' => {
  if (JOOX_LOSSLESS_KEYS.includes(key)) return 'flac';
  if (key.includes('320')) return '320';
  return '128';
};

/**
 * `04:29` → 269 秒。
 *
 * 上游给 `mm:ss` 或 `hh:mm:ss`。解析不出来返回 **0 而不是 NaN** ——
 * NaN 会让进度条与总时长直接坏掉，而 0 只表示「时长未知」。
 */
export const parseJooxDuration = (raw: string | undefined): number => {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  const parts = text.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};
