/**
 * 酷我音源的**纯函数**集合（v2.0.0）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `src/main/netease/map.ts` 同一理由：`api.ts` 会 `import { networkFetch }`，
 * 而后者最终依赖 Electron 的 `session`，在 `node --test` 下无法实例化。
 * 把纯逻辑抽出来后，这些函数就能被**真实数据**驱动验证，
 * 而不是在测试里手写一个「我以为的」样本 —— 后者的典型后果是
 * 「测试全绿但线上全错」。
 *
 * 本文件的函数都是对**实测样本**的解析（直链形态、码率档位、rid 形态），
 * 具体样本见 `docs/reports-for-other-apps/JJ-Music-逆向分析报告.md` §4.2/§4.5。
 */

/**
 * `MUSIC_228908` → `228908`；不是该形态就原样返回。
 *
 * 只用于**比对**（校验定位到的是同一首歌），不用于请求 ——
 * 该接口不支持按 rid 查询（实测 `id`/`rid`/`songid` 均返回
 * `{"code":-1,"message":"请至少输入歌名"}`）。
 */
export const normalizeKuwoRid = (rid: string | undefined): string => {
  const value = String(rid ?? '').trim();
  return value.replace(/^MUSIC_/i, '');
};

/**
 * 从直链里取格式、码率与签发时间。
 *
 * ## 直链形态（实测）
 *
 * ```
 * http://kw-er.kuwo.cn/<32位hash>/<8位hex>/resource/<id>/trackmedia/F000000bYDlc2XxKLs.flac
 *      ?bitrate$2000&format$flac&source$kwplayer_ar_5.1.0.0_B_jiakong_vh.apk
 *      &type$convert_url_with_sign&user$0&loginUid$
 * ```
 *
 * 两个要点：
 * 1. 查询串用 `$` 作分隔符（**不是** `=`），不能按标准 query 直接取；
 * 2. 路径第二段是**十六进制的签发时间戳**（实测 `6abf8890` = 2026-10-02）。
 */
export const parseKuwoUrlMeta = (
  url: string,
): { format?: string; bitrate?: number; signedAt?: Date } => {
  if (!url) return {};

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }

  const params = new URLSearchParams(parsed.search.replace(/\$/g, '='));
  const format = params.get('format') ?? undefined;
  const bitrateRaw = Number.parseInt(params.get('bitrate') ?? '', 10);
  const bitrate = Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? bitrateRaw : undefined;

  // ⚠️ `signedAt` **只用于日志诊断，不得用于判过期**：
  // 签发时间与 TTL 的关系不稳定（实测 1 小时可用、16 天必挂，中间无规律），
  // 唯一可信的判据是对直链做 Range 探测的实际状态码。
  const segments = parsed.pathname.split('/').filter(Boolean);
  const hex = segments[1] ?? '';
  const signedAt = /^[0-9a-f]{8}$/i.test(hex)
    ? new Date(Number.parseInt(hex, 16) * 1000)
    : undefined;

  return { format, bitrate, signedAt };
};

/**
 * 把直链统一升级为 https。
 *
 * 接口下发的都是 `http://`。原客户端靠浏览器自动升级侥幸可用，
 * 一旦该主机收紧策略，整条线路立即全灭。
 * 这里显式升级，并且**探测的就是最终要播的地址** ——
 * 避免「探 https、播 http」这种探测与事实脱节的假绿。
 */
export const upgradeKuwoUrl = (url: string): string => {
  if (!url) return '';
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
};

/**
 * 用响应里的 `format` 推导音质标签，**不按后缀猜**。
 *
 * 原客户端对所有非无损后缀一律标 320K，于是 192K 的 OGG 也显示「320K」。
 * 本函数返回项目枚举内的值，**宁可标低不标高**：
 * 标低的后果只是「显示得保守」，标高的后果是用户以为听的是 320K。
 */
export const inferKuwoQualityLabel = (format: string | undefined): 'flac' | '320' => {
  const f = String(format ?? '').toLowerCase();
  if (f === 'flac' || f === 'wav' || f === 'ape' || f === 'alac' || f === 'aiff') return 'flac';
  return '320';
};
